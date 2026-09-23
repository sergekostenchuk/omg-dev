import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store } from '../src/storage/store.js';
import { writeOmInput } from '../src/om/input.js';
import { writeHorizon } from '../src/om/horizon.js';
import { fillObligations, prepareFrame, readFrame, type ConnectionFrame, type FrameRequest, type FrameScope } from '../src/om/frame-obligations.js';
import { prepareFrameProposals, readFrameProposals, type LayerProposal, type ProposalRequest } from '../src/om/frame-proposals.js';
import { prepareCandidate, writeCandidate } from '../src/om/frame-candidate.js';
import { prepareSettleCandidate, settleCandidate, readAcceptedFrame, prepareRejectProposals, rejectProposals, readRejectedProposals, type SettleCandidateRequest, type RejectedLayerProposal } from '../src/om/frame-accept.js';
import type { OmResult } from '../src/om/refusal.js';
import { writeGuarded } from '../src/om/refs.js';
import { gardenGraph, createOmFixture } from './om-fixture.js';
import { prepareRebaseFrame, rebaseFrame } from '../src/om/frame-accept.js';
import { buildRebasedLayer, readLayerAcceptance, type LayerBasis, type OmRebasedFrame } from '../src/om/layer-basis.js';
import { prepareGaps, writeGaps, readGaps, type GapRequest } from '../src/om/gaps.js';
import { preparedFeatures } from './product-fixture.js';

async function rebaseFixture(t: TestContext, change: 'port' | 'outcome' = 'port') {
  const f = await createOmFixture(t), store = f.store;
  const input = ok(writeOmInput(store, { project: 'garden', expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> }));
  const choice = { choiceVersion: 'rebase-test', features: [{ outcome: 'garden-result' }], excluded: [] };
  const horizon = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(f.graphRevision),
    refinement: reference(store.get('phase:garden:L2')!), choice, available: {} }));
  const operations: FrameRequest = { project: 'garden', level: 2, graph: reference(f.graphRevision),
    horizon: reference(horizon.gate), layer: reference(f.layers[2]), frame: null, upper: null };
  const from: FrameRequest = { ...operations, level: 3, layer: reference(f.layers[3]),
    upper: { horizon: reference(horizon.gate), frame: null } };
  const original = ok(readFrame(store, from));
  const oldFrame: ConnectionFrame = { project: 'garden', level: 3, candidateHash: hashJson(f.graph),
    layerHash: hashJson(projectGraph(f.graph, 3)), fills: structuredClone(original.result.fills) as ConnectionFrame['fills'] };
  from.frame = reference(store.write({ id: 'om-frame:garden:3', kind: 'connection-frame', expected: 0, value: oldFrame }));
  const before = ok(readFrame(store, operations)), connector = structuredClone(f.graph.connectors.find(item => item.id === 'garden-prep-flow')!);
  const binding = connector.bindings.find(item => item.level === 2)!, node = structuredClone(f.graph.nodes.find(item => item.id === binding.producer.node)!);
  const oldPort = binding.producer.port, newPort = change === 'port' ? `${oldPort}-renamed` : oldPort;
  node.ports.find(port => port.id === oldPort)!.id = newPort; binding.producer.port = newPort;
  if (change === 'outcome') node.outcome = 'garden-data';
  const rows = before.result.fills.filter(fill => fill.node === node.id);
  const proposal: LayerProposal = { base: { graph: operations.graph, frame: null }, level: 2, source: 'decision', status: 'proposed',
    nodes: [node], localConnectors: [connector], artifacts: [], contracts: [], joins: [], tests: [], edges: [], journeys: [],
    packets: [], transfers: [], anchors: [], removes: [node.id], redefines: [connector.id],
    fills: rows.map(fill => ({ obligation: fill.obligation, node: node.id,
      ...(fill.port === undefined ? {} : { port: fill.port === oldPort ? newPort : fill.port }) })),
    replaces: rows.map(fill => ({ obligation: fill.obligation, base: { node: node.id, graph: operations.graph },
      with: { node: node.id, port: fill.port === oldPort ? newPort : fill.port ?? null },
      basis: change === 'port' ? 'Rename the accepted operation port' : 'Change the accepted operation outcome' })) };
  const offered = reference(store.write({ id: 'om-proposal:garden:rebase-operation', kind: 'layer-proposal', expected: 0, value: proposal }));
  const written = ok(writeCandidate(store, { frame: operations, proposals: [offered] }));
  assert.equal(written.state, 'candidate'); if (written.state !== 'candidate') throw new Error('No candidate');
  const candidate = reference(written.record), accepted = ok(settleCandidate(store, { project: 'garden', level: 2, candidate,
    outcome: { gate: 'G3', candidate, graphHash: written.record.value.graphHash, passed: true, codes: [] } }));
  const next = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(accepted.graph!),
    refinement: reference(accepted.layer!), choice: { ...choice, choiceVersion: 'rebase-test-next' }, available: {} }));
  const to: FrameRequest = { project: 'garden', level: 3, graph: reference(accepted.graph!), horizon: reference(next.gate),
    layer: null, frame: null, upper: { horizon: reference(next.gate), frame: reference(accepted.frame!) } };
  return { f, store, from, to, original, oldFrame, accepted, input: reference(input), request: { from, to } };
}

test('C5 explicitly rebases accepted works, carries surviving fills and retires old ones without accepting new work', async t => {
  const f = await rebaseFixture(t), before = snapshot(f.store);
  const prepared = ok(prepareRebaseFrame(f.store, f.request));
  assert.deepEqual(snapshot(f.store), before);
  assert.deepEqual(prepared.writes.map(write => write.kind).sort(), ['connection-frame', 'graph-layer']);
  const branch = await f.store.snapshot(join(f.f.root, 'before-rebase'));
  const moved = ok(rebaseFrame(f.store, f.request));
  assert.equal(moved.state, 'rebased'); assert.ok(moved.carried > 0); assert.ok(moved.retired > 0);
  assert.equal(moved.carried + moved.retired, f.oldFrame.fills.length);
  assert.deepEqual(moved.frame.value.rebasedFrom, f.from.frame);
  assert.deepEqual(moved.frame.value.rebase, f.request);
  assert.deepEqual(reference(f.store.get('graph:garden')!), f.to.graph);
  const current = { ...f.to, layer: reference(moved.layer), frame: reference(moved.frame) };
  for (const read of [readFrame, prepareFrame]) {
    const result = ok(read(f.store, current));
    assert.ok(result.result.open.length > 0);
    assert.ok(result.result.open.every(obligation => !moved.frame.value.fills.some(fill => fill.obligation === obligation.id)));
    assert.equal(result.result.fills.filter(fill => fill.source === 'accepted').length, moved.carried);
  }
  assert.equal(ok(readLayerAcceptance(f.store, { project: 'garden', level: 3, graph: f.to.graph, layer: reference(moved.layer) })).producer, 'om');
  const works = { frame: current, proposals: [] };
  const proposals = ok(prepareFrameProposals(f.store, works));
  assert.ok(proposals.gaps.length > 0);
  assert.deepEqual(ok(readFrameProposals(f.store, works)).gaps, proposals.gaps);
  const gapRequest: GapRequest = { project: 'garden', input: f.input, graph: f.to.graph, horizon: f.to.horizon,
    operations: { frame: { project: 'garden', level: 2, graph: f.to.graph, horizon: f.to.horizon,
      layer: reference(f.accepted.layer!), frame: reference(f.accepted.frame!), upper: null }, proposals: [] }, works };
  const preparedGaps = ok(prepareGaps(f.store, gapRequest)), gaps = ok(writeGaps(f.store, gapRequest));
  assert.ok(preparedGaps.guards.some(ref => canonical(ref) === canonical(reference(moved.frame))));
  for (const gap of proposals.gaps) assert.ok(gaps.collection.gaps.some(item => item.target === gap.target && item.field === 'fill'));
  assert.equal(gaps.gate.passed, true);
  assert.deepEqual(ok(readGaps(f.store, { sources: gapRequest, records: gaps.records.map(reference) })), gaps);

  const forgedPath = join(f.f.root, 'forged-rebase.sqlite'); copyFileSync(branch.path, forgedPath);
  const forgedStore = new Store(forgedPath);
  try {
    const frame = structuredClone(moved.frame.value) as OmRebasedFrame;
    frame.fills.shift();
    const frameRef = { ...reference(moved.frame), hash: hashJson(frame) };
    const layer = buildRebasedLayer({ frame, reference: frameRef, graph: f.accepted.graph!.value as Graph,
      upper: f.accepted.layer! as Parameters<typeof buildRebasedLayer>[0]['upper'], previous: forgedStore.get<LayerBasis>(f.from.layer!.id)! });
    const written = forgedStore.writeMany([{ id: moved.frame.id, kind: 'connection-frame', expected: f.from.frame!.revision, value: frame },
      { id: moved.layer.id, kind: 'graph-layer', expected: f.from.layer!.revision, value: layer }]);
    const forged = { frame: { ...current, frame: frameRef, layer: reference(written[1]!) }, proposals: [] };
    const changed = snapshot(forgedStore);
    for (const read of [readFrameProposals, prepareFrameProposals]) refusal(read(forgedStore, forged), 'frame_basis_unproven');
    for (const action of [prepareGaps, writeGaps]) refusal(action(forgedStore, { ...gapRequest, works: forged }), 'frame_basis_unproven');
    assert.deepEqual(snapshot(forgedStore), changed);
  } finally { forgedStore.close(); }
  const markerPath = join(f.f.root, 'missing-rebase-marker.sqlite'); copyFileSync(branch.path, markerPath);
  const markerStore = new Store(markerPath);
  try {
    markerStore.writeMany([{ id: moved.frame.id, kind: moved.frame.kind, expected: f.from.frame!.revision, value: moved.frame.value },
      { id: moved.layer.id, kind: moved.layer.kind, expected: f.from.layer!.revision,
        value: { ...moved.layer.value, acceptance: { producer: 'om' } } }]);
    const before = snapshot(markerStore);
    for (const action of [prepareRebaseFrame, rebaseFrame]) refusal(action(markerStore, f.request), 'frame_acceptance_invalid');
    assert.deepEqual(snapshot(markerStore), before);
  } finally { markerStore.close(); }
  f.f.reopen();
  const after = snapshot(f.f.store), repeated = ok(rebaseFrame(f.f.store, f.request));
  assert.equal(repeated.state, 'unchanged'); assert.deepEqual(repeated.frame, moved.frame);
  assert.deepEqual(snapshot(f.f.store), after);
});

test('C5 rebase refuses graph edits outside acceptance and guards its entire transaction', async t => {
  const f = await rebaseFixture(t), prepared = ok(prepareRebaseFrame(f.store, f.request));
  for (const ref of [f.to.graph, f.to.horizon, f.from.layer!, f.from.frame!, reference(f.accepted.layer!), reference(f.accepted.frame!),
    reference(f.store.get('source:garden:brief')!)])
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)), `Missing rebase guard ${ref.id}`);
  const saved = await f.store.snapshot(join(f.f.root, 'rebase-guards'));
  for (const [index, guard] of prepared.guards.entries()) {
    const file = join(f.f.root, `rebase-race-${index}.sqlite`); copyFileSync(saved.path, file);
    const isolated = new Store(file);
    try {
      const head = isolated.get(guard.id)!;
      isolated.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
      const changed = snapshot(isolated);
      refusal(writeGuarded(isolated, { unit: 'rebase-neighbor', target: 'rebase', guards: prepared.guards, writes: [...prepared.writes,
        { id: 'neighbor:rebase', kind: 'neighbor', expected: 0, value: {} }] }), 'input_stale');
      assert.deepEqual(snapshot(isolated), changed);
    } finally { isolated.close(); }
  }
  const source = f.store.get<Graph>('graph:garden')!, edited = structuredClone(source.value);
  edited.nodes.find(node => node.kind === 'work')!.title = 'changed outside acceptance';
  const altered = f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: edited });
  const before = snapshot(f.store), request = { ...f.request, to: { ...f.to, graph: reference(altered) } };
  for (const action of [prepareRebaseFrame, rebaseFrame]) assert.equal(action(f.store, request).ok, false);
  assert.deepEqual(snapshot(f.store), before);
});

test('C5 retires a work fill when an accepted operation outcome changes under the same obligation id', async t => {
  const f = await rebaseFixture(t, 'outcome');
  const historical = ok(readFrame(f.store, f.from));
  const oldObligation = f.original.result.obligations.find(item => item.kind === 'operation-outcome'
    && item.upper.node === 'garden-prep-operation')!;
  assert.equal(oldObligation.artifact, 'garden-prep');
  const oldFill = f.oldFrame.fills.find(fill => fill.obligation === oldObligation.id)!;
  assert.ok(oldFill);
  assert.equal(f.accepted.graph!.value.nodes.find(node => node.id === oldObligation.upper.node)!.outcome, 'garden-data');
  assert.deepEqual(f.accepted.graph!.value.nodes.filter(node => node.kind === 'work'), f.f.graph.nodes.filter(node => node.kind === 'work'));
  assert.deepEqual(f.accepted.graph!.value.connectors, f.f.graph.connectors);
  const before = snapshot(f.store), prepared = ok(prepareRebaseFrame(f.store, f.request));
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(prepared.result.retired, 1);
  assert.equal(prepared.result.carried, f.oldFrame.fills.length - 1);
  assert.deepEqual(prepared.result.frame.value.retired, [oldFill]);
  assert.ok(prepared.result.frame.value.fills.every(fill => fill.obligation !== oldObligation.id));
  const moved = ok(rebaseFrame(f.store, f.request));
  assert.deepEqual(moved, prepared.result);
  const current: FrameRequest = { ...f.to, layer: reference(moved.layer), frame: reference(moved.frame) };
  for (const read of [readFrame, prepareFrame]) {
    const result = ok(read(f.store, current)).result;
    const changed = result.obligations.find(item => item.id === oldObligation.id)!;
    assert.deepEqual(changed, { ...oldObligation, artifact: 'garden-data' });
    assert.deepEqual(result.open, [changed]);
    assert.ok(result.fills.every(fill => fill.obligation !== oldObligation.id));
    assert.equal(result.fills.length, moved.carried);
  }
  const works = { frame: current, proposals: [] };
  const proposalGaps = ok(prepareFrameProposals(f.store, works)).gaps;
  assert.equal(proposalGaps.length, 1);
  assert.equal(proposalGaps[0]!.target, oldObligation.id);
  assert.deepEqual(ok(readFrameProposals(f.store, works)).gaps, proposalGaps);
  const gapRequest: GapRequest = { project: 'garden', input: f.input, graph: f.to.graph, horizon: f.to.horizon,
    operations: { frame: { project: 'garden', level: 2, graph: f.to.graph, horizon: f.to.horizon,
      layer: reference(f.accepted.layer!), frame: reference(f.accepted.frame!), upper: null }, proposals: [] }, works };
  const gapPreparation = ok(prepareGaps(f.store, gapRequest)), gaps = ok(writeGaps(f.store, gapRequest));
  assert.deepEqual(gaps.collection, gapPreparation.collection);
  assert.ok(gaps.collection.gaps.some(gap => gap.target === oldObligation.id && gap.field === 'fill'));
  assert.equal(gaps.gate.passed, true);
  const gapRead = { sources: gapRequest, records: gaps.records.map(reference) };
  assert.deepEqual(ok(readGaps(f.store, gapRead)), gaps);
  const after = snapshot(f.store), repeated = ok(rebaseFrame(f.store, f.request));
  assert.equal(repeated.state, 'unchanged');
  assert.deepEqual(repeated.frame, moved.frame);
  assert.deepEqual(snapshot(f.store), after);
  f.f.reopen();
  const reopened = f.f.store, saved = snapshot(reopened);
  assert.deepEqual(ok(readFrame(reopened, f.from)), historical);
  assert.deepEqual(ok(readFrame(reopened, current)).result.open.map(item => item.id), [oldObligation.id]);
  assert.deepEqual(ok(readFrameProposals(reopened, works)).gaps, proposalGaps);
  assert.deepEqual(ok(readGaps(reopened, gapRead)), gaps);
  const replay = ok(rebaseFrame(reopened, f.request));
  assert.equal(replay.state, 'unchanged');
  assert.deepEqual(replay.frame, moved.frame);
  assert.deepEqual(snapshot(reopened), saved);
});

function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function refusal(result: OmResult<unknown>, code: string) {
  if (result.ok) assert.fail(`Expected ${code}, received success`);
  assert.equal(result.refusal.code, code); assert.ok(result.refusal.at.target);
  return result.refusal;
}
const snapshot = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-frame-accept-')), database = join(root, 'state.sqlite');
  const store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = gardenGraph('cross'), { level: _level, ...upper } = projectGraph(graph, 1);
  preparedFeatures(new ProductEngine(store), 'garden', upper as Graph);
  const input = ok(writeOmInput(store, { project: 'garden', expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const horizon = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(store.get('graph:garden')!),
    refinement: null, choice: { choiceVersion: 'accept-test', features: [{ outcome: 'garden-result' }], excluded: [] }, available: {} }));
  const frame: FrameRequest = { project: 'garden', level: 2, graph: reference(store.get('graph:garden')!),
    horizon: reference(horizon.gate), layer: null, frame: null, upper: null };
  const read = ok(prepareFrame(store, frame)), projected = projectGraph(graph, 2);
  const mapped = ok(fillObligations(read.upper as Graph, read.scope as FrameScope, { graph, reference: { ...frame.graph, hash: hashJson(graph) }, frame: null }, read.upperRef, 2));
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: null }, level: 2, source: 'decision', status: 'proposed',
    nodes: projected.nodes.filter(node => node.kind === 'operation'), fills: mapped.fills.map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length > 0),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    removes: [], replaces: [], redefines: [] };
  const proposalRef = reference(store.write({ id: 'om-proposal:garden:accept-test', kind: 'layer-proposal', expected: 0, value: proposal }));
  const written = ok(writeCandidate(store, { frame, proposals: [proposalRef] }));
  assert.equal(written.state, 'candidate'); if (written.state !== 'candidate') throw new Error('No candidate');
  const candidate = reference(written.record);
  const request: SettleCandidateRequest = { project: 'garden', level: 2, candidate,
    outcome: { gate: 'G3', candidate, graphHash: written.record.value.graphHash, passed: true, codes: [] } };
  return { root, store, database, frame, graph, proposal, proposalRef, candidate: written.record, request };
}

test('C5 atomically accepts the exact candidate graph, layer, complete frame and proposal statuses', t => {
  const f = fixture(t), before = snapshot(f.store);
  const prepared = ok(prepareSettleCandidate(f.store, f.request));
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(prepared.expected?.frame, 0);
  assert.deepEqual(prepared.writes.map(write => write.kind).sort(), ['connection-frame', 'graph', 'graph-layer', 'layer-proposal']);
  const accepted = ok(settleCandidate(f.store, f.request));
  assert.equal(accepted.state, 'accepted');
  assert.deepEqual(accepted.graph!.value, f.candidate.value.graph);
  assert.equal(accepted.frame!.value.candidateHash, f.candidate.value.graphHash);
  assert.equal(accepted.frame!.value.layerHash, hashJson(projectGraph(accepted.graph!.value as Graph, 2)));
  assert.equal(accepted.frame!.value.fills.length, f.candidate.value.fills.length);
  assert.ok(accepted.frame!.value.fills.every(fill => ['accepted', 'identity'].includes(fill.source)));
  assert.deepEqual(accepted.frame!.value.acceptance.candidate, reference(f.candidate));
  assert.deepEqual(accepted.proposals.map(proposal => proposal.value.status), ['accepted']);
  assert.deepEqual(f.store.get(f.proposalRef.id, f.proposalRef.revision)!.value, f.proposal);
  assert.equal(f.store.history(f.proposalRef.id).length, 2);
  assert.deepEqual(ok(readAcceptedFrame(f.store, { project: 'garden', level: 2, graph: reference(accepted.graph!),
    layer: reference(accepted.layer!), frame: reference(accepted.frame!) })), accepted);
  const changed = snapshot(f.store).filter(row => !before.some(old => canonical(old.head) === canonical(row.head)));
  assert.equal(changed.length, prepared.writes.length);
});

test('C5 repeats and delayed rejection cannot alter an accepted result after later events or reopening', t => {
  const f = fixture(t), accepted = ok(settleCandidate(f.store, f.request));
  for (const row of [accepted.graph!, accepted.layer!, accepted.frame!, ...accepted.proposals])
    f.store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
  const reopened = new Store(f.database);
  try {
    const before = snapshot(reopened);
    const repeat = ok(settleCandidate(reopened, f.request));
    assert.equal(repeat.state, 'unchanged'); assert.deepEqual(repeat.frame, accepted.frame);
    const delayed = ok(settleCandidate(reopened, { ...f.request, outcome: { ...f.request.outcome, passed: false, codes: ['graph_invalid'] } }));
    assert.equal(delayed.state, 'obsolete'); assert.deepEqual(delayed.frame, accepted.frame);
    assert.deepEqual(snapshot(reopened), before);
  } finally { reopened.close(); }
});

test('C5 guards every prepared input and frame absence in a common neighbor transaction without partial writes', async t => {
  const f = fixture(t), prepared = ok(prepareSettleCandidate(f.store, f.request));
  const source = ok(prepareCandidate(f.store, { frame: f.frame, proposals: [f.proposalRef] }));
  assert.ok(source.guards.length > 0);
  for (const ref of [...source.guards, reference(f.candidate), reference(f.store.get('source:garden:brief')!)])
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)), `Missing acceptance guard ${ref.id}`);
  const saved = await f.store.snapshot(join(f.root, 'accept-guards'));
  for (const [index, guard] of prepared.guards.entries()) {
    const file = join(f.root, `guard-${index}.sqlite`); copyFileSync(saved.path, file);
    const isolated = new Store(file);
    try {
      const row = isolated.get(guard.id)!;
      isolated.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
      const afterChange = snapshot(isolated);
      refusal(writeGuarded(isolated, { unit: 'neighbor', target: 'accept', writes: [...prepared.writes,
        { id: 'neighbor:accept', kind: 'neighbor', expected: 0, value: {} }], guards: prepared.guards }), 'input_stale');
      assert.deepEqual(snapshot(isolated), afterChange);
      assert.equal(isolated.get('neighbor:accept'), null);
    } finally { isolated.close(); }
  }
  const other = fixture(t), absent = ok(prepareSettleCandidate(other.store, other.request));
  other.store.write({ id: 'om-frame:garden:2', kind: 'connection-frame', expected: 0, value: { occupied: true } });
  const before = snapshot(other.store);
  refusal(writeGuarded(other.store, { unit: 'neighbor', target: 'accept', writes: absent.writes, guards: absent.guards }), 'revision_conflict');
  assert.deepEqual(snapshot(other.store), before);
});

test('C5 rejects stale proposal heads and a second candidate of the same base without writing', t => {
  const f = fixture(t);
  const secondProposal = f.store.write({ id: 'om-proposal:garden:second', kind: 'layer-proposal', expected: 0, value: f.proposal });
  const second = ok(writeCandidate(f.store, { frame: f.frame, proposals: [reference(secondProposal)] }));
  assert.equal(second.state, 'candidate'); if (second.state !== 'candidate') return;
  ok(settleCandidate(f.store, f.request));
  const before = snapshot(f.store), ref = reference(second.record);
  refusal(settleCandidate(f.store, { ...f.request, candidate: ref, outcome: { ...f.request.outcome, candidate: ref } }), 'input_stale');
  assert.deepEqual(snapshot(f.store), before);
  const stale = fixture(t), row = stale.store.get(stale.proposalRef.id)!;
  stale.store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
  const staleBefore = snapshot(stale.store);
  refusal(settleCandidate(stale.store, stale.request), 'input_stale');
  assert.deepEqual(snapshot(stale.store), staleBefore);
});

test('C5 does not trust foreign gate identities, future levels, claimed failure or missing mandatory input', t => {
  const f = fixture(t), before = snapshot(f.store);
  for (const outcome of [{ ...f.request.outcome, gate: 'G5' as const },
    { ...f.request.outcome, graphHash: '0'.repeat(64) },
    { ...f.request.outcome, candidate: { ...f.request.candidate, hash: '0'.repeat(64) } },
    { ...f.request.outcome, passed: false, codes: ['graph_invalid'] }])
    refusal(settleCandidate(f.store, { ...f.request, outcome }), 'gate_outcome_mismatch');
  refusal(settleCandidate(f.store, { ...f.request, level: 3, outcome: { ...f.request.outcome, gate: 'G5' } }), 'candidate_level_unsupported');
  for (const field of ['candidate', 'outcome', 'project', 'level']) {
    const request = structuredClone(f.request) as unknown as Record<string, unknown>; delete request[field];
    assert.throws(() => prepareSettleCandidate(f.store, request as unknown as SettleCandidateRequest),
      (error: unknown) => error instanceof EngineError && error.code === 'frame_accept_request_invalid');
  }
  assert.deepEqual(snapshot(f.store), before);
});

test('C5 preserves addressed source failures and execution exceptions on both acceptance paths', t => {
  const f = fixture(t), before = snapshot(f.store);
  for (const candidate of [{ ...f.request.candidate, revision: f.request.candidate.revision + 100 },
    { ...f.request.candidate, hash: '0'.repeat(64) }]) for (const action of [prepareSettleCandidate, settleCandidate])
    refusal(action(f.store, { ...f.request, candidate, outcome: { ...f.request.outcome, candidate } }), 'candidate_missing');
  const foreign = { ...f.request.candidate, id: f.request.candidate.id.replace(':garden:', ':other:') };
  for (const action of [prepareSettleCandidate, settleCandidate])
    refusal(action(f.store, { ...f.request, candidate: foreign, outcome: { ...f.request.outcome, candidate: foreign } }), 'record_foreign');
  const original = f.store.get.bind(f.store);
  for (const fault of [new TypeError('graph unavailable'), new EngineError('record_corrupt', 'graph corrupt')]) {
    try {
      f.store.get = ((id: string, revision?: number) => { if (id === f.frame.graph.id) throw fault; return original(id, revision); }) as Store['get'];
      for (const action of [prepareSettleCandidate, settleCandidate]) assert.throws(() => action(f.store, f.request), error => error === fault);
    } finally { f.store.get = original; }
  }
  assert.deepEqual(snapshot(f.store), before);
  const changed = f.store.write({ id: f.candidate.id, kind: f.candidate.kind, expected: 1, value: f.candidate.value });
  const candidate = reference(changed), after = snapshot(f.store);
  for (const action of [prepareSettleCandidate, settleCandidate])
    refusal(action(f.store, { ...f.request, candidate, outcome: { ...f.request.outcome, candidate } }), 'candidate_graph_mismatch');
  assert.deepEqual(snapshot(f.store), after);
});

test('C5 historical acceptance needs its own exact event and every public reader validates missing arguments', t => {
  const f = fixture(t), accepted = ok(settleCandidate(f.store, f.request));
  const duplicate = f.store.write({ id: accepted.graph!.id, kind: 'graph', expected: accepted.graph!.revision, value: accepted.graph!.value });
  const request = { project: 'garden', level: 2 as const, graph: reference(duplicate), layer: reference(accepted.layer!), frame: reference(accepted.frame!) };
  refusal(readAcceptedFrame(f.store, request), 'frame_acceptance_invalid');
  const before = snapshot(f.store);
  for (const absent of [undefined, null, [], {}, { project: 'garden' }]) {
    const malformed = (error: unknown) => error instanceof EngineError && error.code === 'frame_accept_request_invalid';
    assert.throws(() => readAcceptedFrame(f.store, absent as unknown as typeof request), malformed);
    assert.throws(() => readRejectedProposals(f.store, absent as unknown as Parameters<typeof readRejectedProposals>[1]), malformed);
    assert.throws(() => prepareRebaseFrame(f.store, absent as unknown as Parameters<typeof prepareRebaseFrame>[1]), malformed);
    assert.throws(() => rebaseFrame(f.store, absent as unknown as Parameters<typeof rebaseFrame>[1]), malformed);
  }
  assert.deepEqual(snapshot(f.store), before);
  const malformed = fixture(t);
  malformed.store.write({ id: 'om-frame:garden:2', kind: 'connection-frame', expected: 0,
    value: { acceptance: { candidate: malformed.request.candidate } } });
  const badSource = snapshot(malformed.store);
  for (const action of [prepareSettleCandidate, settleCandidate]) refusal(action(malformed.store, malformed.request), 'frame_acceptance_invalid');
  assert.deepEqual(snapshot(malformed.store), badSource);
});

function rejectionPair(f: ReturnType<typeof fixture>, suffix: string): ProposalRequest {
  const proposals = ['a', 'b'].map(id => reference(f.store.write({ id: `om-proposal:garden:reject-${suffix}-${id}`,
    kind: 'layer-proposal', expected: 0, value: f.proposal })));
  return { frame: f.frame, proposals };
}

test('C5 rejects the whole verified conflicting proposal combination with reproducible historical verdicts', async t => {
  const f = fixture(t), request = rejectionPair(f, 'combination'), before = snapshot(f.store);
  const savedSources = await f.store.snapshot(join(f.root, 'rejection-source-snapshot'));
  const prepared = ok(prepareRejectProposals(f.store, request));
  assert.equal(prepared.result.state, 'rejected');
  assert.deepEqual(snapshot(f.store), before);
  assert.deepEqual(prepared.writes.map(write => write.id).sort(), request.proposals.map(ref => ref.id).sort());
  assert.ok(prepared.writes.every(write => write.kind === 'layer-proposal' && write.expected === 1));
  const rejected = ok(rejectProposals(f.store, { ...request, proposals: [...request.proposals].reverse() }));
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.proposals.length, 2);
  assert.deepEqual(rejected.verdict!.codes, ['slot_fill_conflict']);
  assert.equal(rejected.verdict!.kind, 'assembly-refusal');
  assert.deepEqual(rejected.verdict!.request, { frame: request.frame, proposals: [...request.proposals].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0) });
  for (const row of rejected.proposals) {
    assert.equal(row.revision, 2); assert.equal(row.value.status, 'rejected');
    assert.deepEqual(row.value.verdict, rejected.verdict);
    assert.equal(Object.hasOwn(row.value.verdict, 'candidateHash'), false);
    assert.equal(f.store.get<{ status: string }>(row.id, 1)!.value.status, 'proposed');
  }
  assert.deepEqual(snapshot(f.store).filter(row => !request.proposals.some(ref => ref.id === row.head.id)),
    before.filter(row => !request.proposals.some(ref => ref.id === row.head.id)));
  const after = snapshot(f.store);
  assert.equal(ok(rejectProposals(f.store, request)).state, 'unchanged');
  assert.deepEqual(snapshot(f.store), after);
  const saved = { request, proposals: rejected.proposals.map(reference) };
  assert.deepEqual(ok(readRejectedProposals(f.store, saved)), rejected);
  refusal(readRejectedProposals(f.store, { ...saved, proposals: saved.proposals.slice(1) }), 'proposal_rejection_invalid');
  const forkPath = join(f.root, 'forged-rejection.sqlite'); copyFileSync(savedSources.path, forkPath);
  const forgedStore = new Store(forkPath);
  try {
    const forgedRows = rejected.proposals.map(row => {
      const value = structuredClone(row.value) as RejectedLayerProposal;
      value.verdict.refusal = { ...value.verdict.refusal, at: { ...value.verdict.refusal.at, target: 'claimed-solo-cause' } };
      return forgedStore.write({ id: row.id, kind: row.kind, expected: 1, value });
    });
    assert.ok(forgedRows.every(row => row.revision === 2));
    refusal(readRejectedProposals(forgedStore, { ...saved, proposals: forgedRows.map(reference) }), 'proposal_rejection_invalid');
    refusal(prepareRejectProposals(forgedStore, request), 'proposal_rejection_invalid');
  } finally { forgedStore.close(); }
  const missingPath = join(f.root, 'missing-rejection-source.sqlite'); copyFileSync(savedSources.path, missingPath);
  const missingStore = new Store(missingPath);
  try {
    for (const row of rejected.proposals) {
      const value = structuredClone(row.value) as unknown as { verdict: Record<string, unknown> };
      delete value.verdict['request'];
      missingStore.write({ id: row.id, kind: row.kind, expected: 1, value });
    }
    refusal(prepareRejectProposals(missingStore, request), 'proposal_rejection_invalid');
  } finally { missingStore.close(); }
  assert.deepEqual(ok(readRejectedProposals(f.store, saved)), rejected);
});

test('C5 cannot reject successful assemblies, gaps, foreign sources, nonproposed revisions or unsupported levels', t => {
  const f = fixture(t), before = snapshot(f.store);
  for (const request of [{ frame: f.frame, proposals: [f.proposalRef] }, { frame: f.frame, proposals: [] }]) {
    refusal(prepareRejectProposals(f.store, request), 'proposal_rejection_unproven');
    refusal(rejectProposals(f.store, request), 'proposal_rejection_unproven');
  }
  for (const ref of [{ ...f.proposalRef, id: f.proposalRef.id.replace(':garden:', ':foreign:') },
    { ...f.proposalRef, hash: '0'.repeat(64) }]) {
    const result = rejectProposals(f.store, { frame: f.frame, proposals: [ref] });
    assert.equal(result.ok, false);
  }
  refusal(rejectProposals(f.store, { frame: { ...f.frame, level: 3, upper: { horizon: f.frame.horizon, frame: null } },
    proposals: [f.proposalRef] }), 'candidate_level_unsupported');
  refusal(rejectProposals(f.store, { frame: f.frame, proposals: [f.proposalRef, f.proposalRef] }), 'proposal_rejection_invalid');
  for (const value of [undefined, null, [], {}, { proposals: [] }, { frame: f.frame }])
    assert.throws(() => prepareRejectProposals(f.store, value as unknown as ProposalRequest),
      (error: unknown) => error instanceof EngineError && error.code === 'frame_accept_request_invalid');
  assert.deepEqual(snapshot(f.store), before);
  const accepted = ok(settleCandidate(f.store, f.request)), acceptedBefore = snapshot(f.store);
  refusal(rejectProposals(f.store, { frame: f.frame, proposals: accepted.proposals.map(reference) }), 'proposal_not_proposed');
  assert.deepEqual(snapshot(f.store), acceptedBefore);
});

test('C5 rejection guards every current input and all participants without partial status writes', async t => {
  const f = fixture(t), request = rejectionPair(f, 'race'), prepared = ok(prepareRejectProposals(f.store, request));
  assert.ok(request.proposals.every(ref => prepared.guards.some(guard => canonical(guard) === canonical(ref))));
  assert.ok(prepared.guards.some(ref => ref.id === 'source:garden:brief'));
  const saved = await f.store.snapshot(join(f.root, 'rejection-guards'));
  for (const [index, guard] of prepared.guards.entries()) {
    const file = join(f.root, `rejection-guard-${index}.sqlite`); copyFileSync(saved.path, file);
    const store = new Store(file);
    try {
      const row = store.get(guard.id)!;
      store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
      const before = snapshot(store);
      refusal(writeGuarded(store, { unit: 'rejection-neighbor', target: 'reject', guards: prepared.guards,
        writes: [...prepared.writes, { id: 'neighbor:reject', kind: 'neighbor', expected: 0, value: {} }] }), 'input_stale');
      assert.deepEqual(snapshot(store), before);
      assert.ok(request.proposals.every(ref => store.get<{ status: string }>(ref.id)!.value.status === 'proposed'));
    } finally { store.close(); }
  }
  const original = f.store.get.bind(f.store), faults = [new TypeError('Proposal read failure'), new EngineError('record_corrupt', 'Exact proposal unavailable')];
  for (const fault of faults) try {
    f.store.get = ((id: string, revision?: number) => { if (id === request.proposals[1]!.id) throw fault; return original(id, revision); }) as Store['get'];
    assert.throws(() => prepareRejectProposals(f.store, request), error => error === fault);
    assert.throws(() => rejectProposals(f.store, request), error => error === fault);
  } finally { f.store.get = original; }
  const before = snapshot(f.store), row = f.store.get(request.proposals[0]!.id)!;
  f.store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
  assert.equal(ok(rejectProposals(f.store, request)).state, 'obsolete');
  assert.deepEqual(snapshot(f.store).filter(item => item.head.id !== row.id), before.filter(item => item.head.id !== row.id));
});

test('C5 delayed rejection never changes corrected and accepted proposals and remains historically readable after restart', t => {
  const f = fixture(t), request = rejectionPair(f, 'delayed'), rejected = ok(rejectProposals(f.store, request));
  const source = request.proposals[0]!, corrected = f.store.write({ id: source.id, kind: 'layer-proposal', expected: 2, value: f.proposal });
  const written = ok(writeCandidate(f.store, { frame: f.frame, proposals: [reference(corrected)] }));
  assert.equal(written.state, 'candidate'); if (written.state !== 'candidate') return;
  const candidate = reference(written.record), accepted = ok(settleCandidate(f.store, { project: 'garden', level: 2, candidate,
    outcome: { gate: 'G3', candidate, graphHash: written.record.value.graphHash, passed: true, codes: [] } }));
  const proof = f.store.get('source:garden:brief')!;
  f.store.write({ id: proof.id, kind: proof.kind, expected: proof.revision, value: proof.value });
  const reopened = new Store(f.database);
  try {
    const before = snapshot(reopened);
    const repeat = ok(rejectProposals(reopened, { ...request, proposals: [...request.proposals].reverse() }));
    assert.equal(repeat.state, 'unchanged');
    assert.deepEqual(repeat.proposals, rejected.proposals);
    assert.deepEqual(ok(readRejectedProposals(reopened, { request, proposals: rejected.proposals.map(reference) })), rejected);
    assert.deepEqual(snapshot(reopened), before);
    assert.deepEqual(reference(reopened.get(source.id)!), reference(accepted.proposals[0]!));
  } finally { reopened.close(); }
});

test('C5 rejection retains G3 nested findings and distinguishes forbidden N2 payloads from unsupported N3 requests', t => {
  const f = fixture(t), invalid = structuredClone(f.proposal);
  invalid.nodes.find(node => node.id === 'garden-consume-operation')!.implements = [];
  const source = reference(f.store.write({ id: 'om-proposal:garden:reject-findings', kind: 'layer-proposal', expected: 0, value: invalid }));
  const rejected = ok(rejectProposals(f.store, { frame: f.frame, proposals: [source] }));
  assert.ok(rejected.verdict!.codes.includes('graph_invalid'));
  const finding = rejected.verdict!.refusal.findings!.find(item => item.code === 'node_benefit_unbound');
  assert.ok(finding); assert.equal(finding.target, 'garden-consume-operation'); assert.ok(finding.message);
  assert.deepEqual(ok(readRejectedProposals(f.store, { request: { frame: f.frame, proposals: [source] }, proposals: rejected.proposals.map(reference) })), rejected);
  const future = structuredClone(f.proposal), connector = future.localConnectors[0]!;
  connector.bindings.push({ ...structuredClone(connector.bindings[0]!), level: 3 });
  const next = reference(f.store.write({ id: 'om-proposal:garden:reject-l3-payload', kind: 'layer-proposal', expected: 0, value: future }));
  const forbidden = ok(rejectProposals(f.store, { frame: f.frame, proposals: [next] }));
  assert.deepEqual(forbidden.verdict!.codes, ['candidate_level_unsupported']);
  assert.equal(forbidden.state, 'rejected');
});
