import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { produceAtomicSeed, type AtomicSeedResources } from './om-atomic-seed.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Write } from '../src/storage/store.js';
import { writeOmInput } from '../src/om/input.js';
import { writeHorizon } from '../src/om/horizon.js';
import { WORKS_FRAME_CONTRACT, fillObligations, prepareFrame, readFrame, type ConnectionFrame, type FrameRequest, type FrameScope } from '../src/om/frame-obligations.js';
import { prepareFrameProposals, readFrameProposals, type LayerProposal, type ProposalRequest } from '../src/om/frame-proposals.js';
import { prepareCandidate, writeCandidate } from '../src/om/frame-candidate.js';
import { prepareSettleCandidate, settleCandidate, readAcceptedFrame, readRejectedCandidate, readWorkRejectionAt, prepareRejectProposals, rejectProposals, readRejectedProposals, type SettleCandidateRequest, type RejectedLayerProposal } from '../src/om/frame-accept.js';
import type { OmResult } from '../src/om/refusal.js';
import { writeGuarded } from '../src/om/refs.js';
import { gardenGraph, createOmFixture, refusedWith, sameButReferences, storedAccepted, thrownWith } from './om-fixture.js';
import { prepareRebaseFrame, rebaseFrame } from '../src/om/frame-accept.js';
import { buildRebasedLayer, readLayerAcceptance, readAcceptedFrameLayer, type LayerBasis, type OmRebasedFrame } from '../src/om/layer-basis.js';
import { prepareGaps, writeGaps, readGaps, type GapRequest } from '../src/om/gaps.js';
import { preparedFeatures } from './product-fixture.js';
import { writeAddressing, inputDecisionWrite, type InputDecisionProposal } from '../src/om/addressing.js';
import { gapLineKey, gapLinesId, writeGapLines, type GapLinesRecord } from '../src/om/gap-lines.js';
import { writeOmObligations } from '../src/om/obligations.js';
import { writeNeighbors } from '../src/om/neighbors.js';
import { prepareWorksAcceptance, writeWorksAcceptance, writeAtomicGate, type WorksAcceptanceRequest } from '../src/om/atomic-gate.js';
import { readResultIdentity } from '../src/om/result-identity.js';
import { beginAttempt, completeAttempt, openSeries, readSeries, seriesId, type AttemptGoal } from '../src/om/series.js';

async function rebaseFixture(t: TestContext, change: 'port' | 'outcome' = 'port') {
  const f = await createOmFixture(t, 'standard', 'garden', { mode: 'executed' }), store = f.store;
  const input = ok(writeOmInput(store, { project: 'garden', expected: store.get('om-input:garden')!.revision,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> }));
  const choice = { choiceVersion: 'rebase-test', features: [{ outcome: 'garden-result' }], excluded: [] };
  const horizon = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(f.graphRevision),
    refinement: reference(f.layers[2]), choice, available: {} }));
  const operations: FrameRequest = { project: 'garden', level: 2, graph: reference(f.graphRevision),
    horizon: reference(horizon.gate), layer: reference(f.layers[2]), frame: reference(store.get('om-frame:garden:2')!), upper: null };
  const from: FrameRequest = { ...operations, level: 3, layer: reference(f.layers[3]), frame: reference(store.get('om-frame:garden:3')!),
    upper: { horizon: reference(horizon.gate), frame: operations.frame }, workZoneContract: 'accepted-l2-v1' };
  const original = ok(readFrame(store, from));
  const oldFrame = store.get<ConnectionFrame>(from.frame!.id, from.frame!.revision)!.value;
  const before = ok(readFrame(store, operations)), connector = structuredClone(f.graph.connectors.find(item => item.id === 'garden-prep-flow')!);
  const binding = connector.bindings.find(item => item.level === 2)!, node = structuredClone(f.graph.nodes.find(item => item.id === binding.producer.node)!);
  const oldPort = binding.producer.port, newPort = change === 'port' ? `${oldPort}-renamed` : oldPort;
  node.ports.find(port => port.id === oldPort)!.id = newPort; binding.producer.port = newPort;
  if (change === 'outcome') node.outcome = 'garden-data';
  const rows = before.result.fills.filter(fill => fill.node === node.id);
  const proposal: LayerProposal = { base: { graph: operations.graph, frame: operations.frame }, level: 2, source: 'decision', status: 'proposed',
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

test('C5 explicitly rebases accepted works, carries surviving fills and retires old ones without accepting new work', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const f = await rebaseFixture(t), before = snapshot(f.store);
  const prepared = ok(prepareRebaseFrame(f.store, f.request));
  assert.deepEqual(snapshot(f.store), before);
  assert.deepEqual(prepared.writes.map(write => write.kind).sort(), ['connection-frame', 'graph-layer']);
  const branch = await f.store.snapshot(join(f.f.root, 'before-rebase'));
  const moved = ok(rebaseFrame(f.store, f.request));
  assert.equal(moved.state, 'rebased'); assert.ok(moved.carried > 0); assert.ok(moved.retired > 0);
  assert.equal(moved.carried + moved.retired, f.oldFrame.fills.length);
  assert.deepEqual(moved.frame.value.rebasedFrom, f.from.frame);
  assert.deepEqual(moved.frame.value.rebase, { from: f.from, to: { ...f.to, workZoneContract: 'accepted-l2-v1' } });
  assert.equal(moved.frame.value.rebase.from.workZoneContract, 'accepted-l2-v1');
  assert.ok(!Object.hasOwn(f.to, 'workZoneContract'));
  assert.deepEqual(reference(f.store.get('graph:garden')!), f.to.graph);
  const current = { ...f.to, layer: reference(moved.layer), frame: reference(moved.frame), workZoneContract: 'accepted-l2-v1' as const };
  for (const read of [readFrame, prepareFrame]) {
    const result = ok(read(f.store, current));
    assert.ok(result.result.open.length > 0);
    assert.ok(result.result.open.every(obligation => !moved.frame.value.fills.some(fill => fill.obligation === obligation.id)));
    assert.equal(result.result.fills.filter(fill => fill.source === 'accepted').length,
      moved.frame.value.fills.filter(fill => fill.source === 'accepted').length);
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
  assert.deepEqual(ok(readGaps(f.store, { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) })), gaps);

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
    for (const read of [readFrameProposals, prepareFrameProposals]) refusedWith(read(forgedStore, forged), 'frame_basis_unproven');
    for (const action of [prepareGaps, writeGaps]) refusedWith(action(forgedStore, { ...gapRequest, works: forged }), 'frame_basis_unproven');
    assert.deepEqual(snapshot(forgedStore), changed);
  } finally { forgedStore.close(); }
  const markerPath = join(f.f.root, 'missing-rebase-marker.sqlite'); copyFileSync(branch.path, markerPath);
  const markerStore = new Store(markerPath);
  try {
    markerStore.writeMany([{ id: moved.frame.id, kind: moved.frame.kind, expected: f.from.frame!.revision, value: moved.frame.value },
      { id: moved.layer.id, kind: moved.layer.kind, expected: f.from.layer!.revision,
        value: { ...moved.layer.value, acceptance: { producer: 'om' } } }]);
    const before = snapshot(markerStore);
    for (const action of [prepareRebaseFrame, rebaseFrame]) refusedWith(action(markerStore, f.request), 'frame_acceptance_invalid');
    assert.deepEqual(snapshot(markerStore), before);
  } finally { markerStore.close(); }
  const graphHead = f.store.get<Graph>('graph:garden')!;
  f.store.write({ id: graphHead.id, kind: graphHead.kind, expected: graphHead.revision, value: graphHead.value });
  f.f.reopen();
  const after = snapshot(f.f.store), repeated = ok(rebaseFrame(f.f.store, f.request));
  assert.equal(repeated.state, 'unchanged'); assert.deepEqual(repeated.frame, moved.frame);
  assert.deepEqual(snapshot(f.f.store), after);
});

test('C5 rebase preserves the explicit works contract and every carried or retired code address after restart', async t => {
  const f = await rebaseFixture(t, 'port'), before = snapshot(f.store);
  const prepared = ok(prepareRebaseFrame(f.store, f.request));
  assert.deepEqual(snapshot(f.store), before);
  const moved = ok(rebaseFrame(f.store, f.request));
  assert.equal(moved.frame.value.worksContract, WORKS_FRAME_CONTRACT);
  assert.ok(moved.carried > 0 && moved.retired > 0);
  const key = (fill: ConnectionFrame['fills'][number]) => canonical([fill.obligation, fill.node, fill.port ?? null]);
  const prior = new Map(f.oldFrame.fills.map(fill => [key(fill), fill]));
  for (const fill of [...moved.frame.value.fills, ...moved.frame.value.retired]) {
    assert.deepEqual(fill.codeRef, prior.get(key(fill))!.codeRef);
    if (fill.port !== undefined && fill.source === 'accepted') assert.ok(fill.codeRef);
    if (fill.source === 'identity') assert.ok(!Object.hasOwn(fill, 'codeRef'));
  }
  assert.equal(moved.carried + moved.retired, f.oldFrame.fills.length);
  assert.deepEqual(prepared.result.frame, moved.frame);
  const request = { project: 'garden', level: 3 as const, graph: f.to.graph, layer: reference(moved.layer) };
  const historical = ok(readLayerAcceptance(f.store, request)), bytes = canonical(moved.frame);
  for (const ref of [f.to.graph, f.to.horizon]) {
    const head = f.store.get(ref.id)!; f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
  }
  f.f.reopen();
  assert.deepEqual(ok(readLayerAcceptance(f.f.store, request)), historical);
  const replay = ok(rebaseFrame(f.f.store, f.request));
  assert.equal(replay.state, 'unchanged'); assert.equal(canonical(replay.frame), bytes);
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
      const head = isolated.get(guard.id);
      if ('absent' in guard) {
        assert.equal(head, null);
        isolated.write({ id: guard.id, kind: 'race', expected: 0, value: {} });
      } else {
        assert.ok(head);
        isolated.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
      }
      const changed = snapshot(isolated);
      refusedWith(writeGuarded(isolated, { unit: 'rebase-neighbor', target: 'rebase', guards: prepared.guards, writes: [...prepared.writes,
        { id: 'neighbor:rebase', kind: 'neighbor', expected: 0, value: {} }] }), 'input_stale');
      assert.deepEqual(snapshot(isolated), changed);
    } finally { isolated.close(); }
  }
  const source = f.store.get<Graph>('graph:garden')!, edited = structuredClone(source.value);
  edited.nodes.find(node => node.kind === 'work')!.title = 'changed outside acceptance';
  const altered = f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: edited });
  const before = snapshot(f.store), request = { ...f.request, to: { ...f.to, graph: reference(altered) } };
  for (const action of [prepareRebaseFrame, rebaseFrame]) refusedWith(action(f.store, request), 'layer_basis_unproven');
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
  const current: FrameRequest = { ...f.to, layer: reference(moved.layer), frame: reference(moved.frame), workZoneContract: 'accepted-l2-v1' };
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
  const gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
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
const snapshot = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function fixture(t: TestContext, keepOutsideIdentities = false) {
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
  const mapped = ok(fillObligations(read.upper as Graph, read.scope as FrameScope,
    storedAccepted(graph, read.upper as Graph, read.scope as FrameScope, 'garden', 2), read.upperRef, 2));
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: null }, level: 2, source: 'decision', status: 'proposed',
    nodes: projected.nodes.filter(node => node.kind === 'operation'), fills: mapped.fills.map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length > 0),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    removes: [], replaces: [], redefines: [] };
  if (keepOutsideIdentities) {
    proposal.nodes = proposal.nodes.filter(node => read.scope.nodes.includes(node.parent!));
    const included = new Set(proposal.nodes.map(node => node.id));
    proposal.fills = proposal.fills.filter(fill => included.has(fill.node));
    proposal.localConnectors = proposal.localConnectors.filter(connector => !read.upper.connectors.some(upper => upper.id === connector.id));
  }
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
      const row = isolated.get(guard.id);
      if ('absent' in guard) {
        assert.equal(row, null);
        isolated.write({ id: guard.id, kind: 'race', expected: 0, value: {} });
      } else {
        assert.ok(row);
        isolated.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
      }
      const afterChange = snapshot(isolated);
      refusedWith(writeGuarded(isolated, { unit: 'neighbor', target: 'accept', writes: [...prepared.writes,
        { id: 'neighbor:accept', kind: 'neighbor', expected: 0, value: {} }], guards: prepared.guards }), 'input_stale');
      assert.deepEqual(snapshot(isolated), afterChange);
      assert.equal(isolated.get('neighbor:accept'), null);
    } finally { isolated.close(); }
  }
  const other = fixture(t), absent = ok(prepareSettleCandidate(other.store, other.request));
  other.store.write({ id: 'om-frame:garden:2', kind: 'connection-frame', expected: 0, value: { occupied: true } });
  const before = snapshot(other.store);
  assert.equal(refusedWith(writeGuarded(other.store, { unit: 'neighbor', target: 'accept', writes: absent.writes, guards: absent.guards }),
    'input_stale').at.target, 'om-frame:garden:2');
  assert.deepEqual(snapshot(other.store), before);
});

test('C5 rejects stale proposal heads and a second candidate of the same base without writing', t => {
  const f = fixture(t);
  const secondProposal = f.store.write({ id: 'om-proposal:garden:second', kind: 'layer-proposal', expected: 0, value: f.proposal });
  const second = ok(writeCandidate(f.store, { frame: f.frame, proposals: [reference(secondProposal)] }));
  assert.equal(second.state, 'candidate'); if (second.state !== 'candidate') return;
  ok(settleCandidate(f.store, f.request));
  const before = snapshot(f.store), ref = reference(second.record);
  refusedWith(settleCandidate(f.store, { ...f.request, candidate: ref, outcome: { ...f.request.outcome, candidate: ref } }), 'input_stale');
  assert.deepEqual(snapshot(f.store), before);
  const stale = fixture(t), row = stale.store.get(stale.proposalRef.id)!;
  stale.store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
  const staleBefore = snapshot(stale.store);
  refusedWith(settleCandidate(stale.store, stale.request), 'input_stale');
  assert.deepEqual(snapshot(stale.store), staleBefore);
});

test('C5 does not trust foreign gate identities, future levels, claimed failure or missing mandatory input', t => {
  const f = fixture(t), before = snapshot(f.store);
  for (const outcome of [{ ...f.request.outcome, gate: 'G5' as const },
    { ...f.request.outcome, graphHash: '0'.repeat(64) },
    { ...f.request.outcome, candidate: { ...f.request.candidate, hash: '0'.repeat(64) } },
    { ...f.request.outcome, passed: false, codes: ['graph_invalid'] }])
    refusedWith(settleCandidate(f.store, { ...f.request, outcome }), 'gate_outcome_mismatch');
  refusedWith(settleCandidate(f.store, { ...f.request, level: 3, outcome: { ...f.request.outcome, gate: 'G5' } }), 'candidate_level_unsupported');
  for (const field of ['candidate', 'outcome', 'project', 'level']) {
    const request = structuredClone(f.request) as unknown as Record<string, unknown>; delete request[field];
    assert.throws(() => prepareSettleCandidate(f.store, request as unknown as SettleCandidateRequest),
      (error: unknown) => error instanceof EngineError && error.code === 'frame_accept_request_invalid');
  }
  assert.deepEqual(snapshot(f.store), before);
});

test('C5 requires a well-formed G5 basis without widening G3 or trusting a level label', t => {
  const f = fixture(t), before = snapshot(f.store), basis = { id: 'om-atomic-gate:garden:unproven', revision: 1, hash: 'a'.repeat(64) };
  for (const action of [prepareSettleCandidate, settleCandidate]) {
    refusedWith(action(f.store, { ...f.request, outcome: { ...f.request.outcome, basis } }), 'gate_outcome_mismatch');
    refusedWith(action(f.store, { ...f.request, level: 3, outcome: { ...f.request.outcome, gate: 'G5', basis } }), 'gate_outcome_mismatch');
    for (const bad of [null, {}, { ...basis, revision: 0 }, { ...basis, hash: 'wrong' }])
      assert.throws(() => action(f.store, { ...f.request, outcome: { ...f.request.outcome, basis: bad } } as SettleCandidateRequest),
        (error: unknown) => error instanceof EngineError && error.code === 'frame_accept_request_invalid');
  }
  assert.deepEqual(snapshot(f.store), before);
});

test('the historical G5 rejection reader requires its complete failed outcome before reading sources', t => {
  const f = fixture(t), before = snapshot(f.store), basis = { id: 'om-atomic-gate:garden:unproven', revision: 1, hash: 'a'.repeat(64) };
  const request: SettleCandidateRequest = { ...f.request, level: 3,
    outcome: { ...f.request.outcome, gate: 'G5', passed: false, codes: ['work_packet_over_capacity'], basis } };
  const malformed = (error: unknown) => error instanceof EngineError && error.code === 'frame_accept_request_invalid';
  for (const bad of [undefined, null, [], 0, 'request']) {
    assert.throws(() => readRejectedCandidate(f.store, bad as unknown as SettleCandidateRequest), malformed);
    assert.throws(() => readRejectedCandidate(bad as unknown as Store, request), malformed);
  }
  for (const field of ['project', 'level', 'candidate', 'outcome'] as const) {
    const missing = structuredClone(request) as Partial<SettleCandidateRequest>; delete missing[field];
    assert.throws(() => readRejectedCandidate(f.store, missing as SettleCandidateRequest), malformed);
  }
  for (const field of ['gate', 'candidate', 'graphHash', 'passed', 'codes'] as const) {
    const missing = structuredClone(request);
    delete (missing.outcome as Partial<SettleCandidateRequest['outcome']>)[field];
    assert.throws(() => readRejectedCandidate(f.store, missing as SettleCandidateRequest), malformed);
  }
  const get = f.store.get.bind(f.store);
  try {
    f.store.get = (() => { throw new Error('Invalid outcome reached storage'); }) as Store['get'];
    for (const altered of [f.request, { ...request, level: 2 as const },
      { ...request, outcome: { ...request.outcome, gate: 'G3' as const } },
      { ...request, outcome: { ...request.outcome, passed: true, codes: [] } },
      { ...request, outcome: { gate: 'G5' as const, candidate: request.candidate, graphHash: request.outcome.graphHash,
        passed: false, codes: request.outcome.codes } }])
      refusedWith(readRejectedCandidate(f.store, altered), 'gate_outcome_mismatch');
  } finally { f.store.get = get; }
  assert.deepEqual(snapshot(f.store), before);
});

test('C5 preserves addressed source failures and execution exceptions on both acceptance paths', { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, t => {
  const f = fixture(t), before = snapshot(f.store);
  for (const candidate of [{ ...f.request.candidate, revision: f.request.candidate.revision + 100 },
    { ...f.request.candidate, hash: '0'.repeat(64) }]) for (const action of [prepareSettleCandidate, settleCandidate])
    refusedWith(action(f.store, { ...f.request, candidate, outcome: { ...f.request.outcome, candidate } }), 'candidate_missing');
  const foreign = { ...f.request.candidate, id: f.request.candidate.id.replace(':garden:', ':other:') };
  for (const action of [prepareSettleCandidate, settleCandidate])
    refusedWith(action(f.store, { ...f.request, candidate: foreign, outcome: { ...f.request.outcome, candidate: foreign } }), 'record_foreign');
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
    refusedWith(action(f.store, { ...f.request, candidate, outcome: { ...f.request.outcome, candidate } }), 'candidate_graph_mismatch');
  assert.deepEqual(snapshot(f.store), after);
});

test('C5 historical acceptance needs its own exact event and every public reader validates missing arguments', t => {
  const f = fixture(t), accepted = ok(settleCandidate(f.store, f.request));
  const duplicate = f.store.write({ id: accepted.graph!.id, kind: 'graph', expected: accepted.graph!.revision, value: accepted.graph!.value });
  const request = { project: 'garden', level: 2 as const, graph: reference(duplicate), layer: reference(accepted.layer!), frame: reference(accepted.frame!) };
  refusedWith(readAcceptedFrame(f.store, request), 'frame_acceptance_invalid');
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
  for (const action of [prepareSettleCandidate, settleCandidate]) refusedWith(action(malformed.store, malformed.request), 'frame_acceptance_invalid');
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
  refusedWith(readRejectedProposals(f.store, { ...saved, proposals: saved.proposals.slice(1) }), 'proposal_rejection_invalid');
  const forkPath = join(f.root, 'forged-rejection.sqlite'); copyFileSync(savedSources.path, forkPath);
  const forgedStore = new Store(forkPath);
  try {
    const forgedRows = rejected.proposals.map(row => {
      const value = structuredClone(row.value) as RejectedLayerProposal;
      value.verdict.refusal = { ...value.verdict.refusal, at: { ...value.verdict.refusal.at, target: 'claimed-solo-cause' } };
      return forgedStore.write({ id: row.id, kind: row.kind, expected: 1, value });
    });
    assert.ok(forgedRows.every(row => row.revision === 2));
    refusedWith(readRejectedProposals(forgedStore, { ...saved, proposals: forgedRows.map(reference) }), 'proposal_rejection_invalid');
    refusedWith(prepareRejectProposals(forgedStore, request), 'proposal_rejection_invalid');
  } finally { forgedStore.close(); }
  const missingPath = join(f.root, 'missing-rejection-source.sqlite'); copyFileSync(savedSources.path, missingPath);
  const missingStore = new Store(missingPath);
  try {
    for (const row of rejected.proposals) {
      const value = structuredClone(row.value) as unknown as { verdict: Record<string, unknown> };
      delete value.verdict['request'];
      missingStore.write({ id: row.id, kind: row.kind, expected: 1, value });
    }
    refusedWith(prepareRejectProposals(missingStore, request), 'proposal_rejection_invalid');
  } finally { missingStore.close(); }
  assert.deepEqual(ok(readRejectedProposals(f.store, saved)), rejected);
});

test('C5 cannot reject successful assemblies, gaps, foreign sources, nonproposed revisions or unsupported levels', t => {
  const f = fixture(t), before = snapshot(f.store);
  for (const request of [{ frame: f.frame, proposals: [f.proposalRef] }, { frame: f.frame, proposals: [] }]) {
    refusedWith(prepareRejectProposals(f.store, request), 'proposal_rejection_unproven');
    refusedWith(rejectProposals(f.store, request), 'proposal_rejection_unproven');
  }
  for (const [ref, code] of [[{ ...f.proposalRef, id: f.proposalRef.id.replace(':garden:', ':foreign:') }, 'record_foreign'],
    [{ ...f.proposalRef, hash: '0'.repeat(64) }, 'record_forged']] as const)
    refusedWith(rejectProposals(f.store, { frame: f.frame, proposals: [ref] }), code);
  refusedWith(rejectProposals(f.store, { frame: { ...f.frame, level: 3, workZoneContract: 'accepted-l2-v1', upper: { horizon: f.frame.horizon, frame: f.frame.horizon } },
    proposals: [f.proposalRef] }), 'candidate_level_unsupported');
  refusedWith(rejectProposals(f.store, { frame: f.frame, proposals: [f.proposalRef, f.proposalRef] }), 'proposal_rejection_invalid');
  for (const value of [undefined, null, [], {}, { proposals: [] }, { frame: f.frame }])
    assert.throws(() => prepareRejectProposals(f.store, value as unknown as ProposalRequest),
      (error: unknown) => error instanceof EngineError && error.code === 'frame_accept_request_invalid');
  assert.deepEqual(snapshot(f.store), before);
  const accepted = ok(settleCandidate(f.store, f.request)), acceptedBefore = snapshot(f.store);
  refusedWith(rejectProposals(f.store, { frame: f.frame, proposals: accepted.proposals.map(reference) }), 'proposal_not_proposed');
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
      const row = store.get(guard.id);
      if ('absent' in guard) {
        assert.equal(row, null);
        store.write({ id: guard.id, kind: 'race', expected: 0, value: {} });
      } else {
        assert.ok(row);
        store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
      }
      const before = snapshot(store);
      refusedWith(writeGuarded(store, { unit: 'rejection-neighbor', target: 'reject', guards: prepared.guards,
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


test('G5 result identity traverses a proved rebase to native L3 fills without treating rebase as acceptance', async t => {
  const f = await createOmFixture(t, 'standard', 'garden', { mode: 'executed' }), project = 'garden', store = f.store, engine = new ProductEngine(store);
  const initial = ok(writeOmInput(store, { project, expected: store.get('om-input:garden')!.revision,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> }));
  const decisions: InputDecisionProposal['decision'][] = [
    { target: 'garden-B1', field: 'nodes', value: ['garden-produce-block', 'garden-consume-block'] },
    { target: 'garden-B1', field: 'state', value: { writer: 'garden-produce-block', authority: 'garden-consume-block', rollback: 'garden-consume-block' } },
    { target: 'garden-R1#1', field: 'checkKind', value: 'test' },
  ];
  const input = ok(writeAddressing(store, { project, input: reference(initial), graph: reference(f.graphRevision),
    decisions: decisions.map(decision => ({ pending: inputDecisionWrite({ project, input: reference(initial),
      graph: reference(f.graphRevision), layers: [], decision }) })) }));
  const choice = { choiceVersion: 'identity-native', features: [{ outcome: 'garden-result' }], excluded: [] };
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(f.graphRevision),
    refinement: reference(f.layers[2]), choice, available: {} }));
  const operations: FrameRequest = { project, level: 2, graph: reference(f.graphRevision), horizon: reference(horizon.gate),
    layer: reference(f.layers[2]), frame: reference(store.get('om-frame:garden:2')!), upper: null };
  const nativeRequest: FrameRequest = { ...operations, level: 3, layer: reference(f.layers[3]), frame: reference(store.get('om-frame:garden:3')!),
    upper: { horizon: reference(horizon.gate), frame: operations.frame }, workZoneContract: 'accepted-l2-v1' };
  const nativeFrame = store.get<ConnectionFrame>(nativeRequest.frame!.id, nativeRequest.frame!.revision)!;
  assert.equal(nativeFrame.value.worksContract, WORKS_FRAME_CONTRACT);
  const from = { ...nativeRequest, frame: reference(nativeFrame) };
  ok(readFrame(store, from));
  const upperCandidate = ok(writeCandidate(store, { frame: operations, proposals: [] }));
  assert.equal(upperCandidate.state, 'candidate'); if (upperCandidate.state !== 'candidate') throw new Error('Missing native upper candidate');
  const upperRef = reference(upperCandidate.record), upper = ok(settleCandidate(store, { project, level: 2, candidate: upperRef,
    outcome: { gate: 'G3', candidate: upperRef, graphHash: upperCandidate.record.value.graphHash, passed: true, codes: [] } }));
  const next = ok(writeHorizon(store, { project, input: reference(input), graph: reference(upper.graph!), refinement: reference(upper.layer!),
    choice: { ...choice, choiceVersion: 'identity-rebased' }, available: {} }));
  const to: FrameRequest = { project, level: 3, graph: reference(upper.graph!), horizon: reference(next.gate), layer: null,
    frame: null, upper: { horizon: reference(next.gate), frame: reference(upper.frame!) }, workZoneContract: 'accepted-l2-v1' };
  const rebased = ok(rebaseFrame(store, { from, to }));
  assert.ok(rebased.carried > 0); assert.equal(rebased.retired, 0);
  assert.equal(rebased.frame.value.worksContract, WORKS_FRAME_CONTRACT);
  const prepared = ok(prepareFrame(store, { ...to, layer: reference(rebased.layer), frame: reference(rebased.frame) }));
  const works: ProposalRequest = { frame: structuredClone(prepared.request) as FrameRequest, proposals: [] };
  const obligation = prepared.result.obligations.find(item => item.kind === 'connection-end' && item.role === 'producer'
    && item.connector === 'garden-flow' && prepared.result.fills.some(fill => fill.obligation === item.id && fill.source === 'accepted'))!;
  assert.ok(obligation);
  const rebaseAcceptance = { project, level: 3 as const, graph: to.graph, layer: reference(rebased.layer), frame: reference(rebased.frame) };
  const beforeRebaseRead = snapshot(store);
  const rebaseResult = readResultIdentity(store, { acceptance: rebaseAcceptance, obligation: obligation.id });
  refusedWith(rebaseResult, 'frame_acceptance_invalid'); // A rebase preserves history but accepts no new result
  assert.deepEqual(snapshot(store), beforeRebaseRead);
  const gaps = ok(writeGaps(store, { project, input: reference(input), graph: to.graph, horizon: to.horizon,
    operations: { frame: { ...operations, graph: to.graph, horizon: to.horizon, layer: reference(upper.layer!), frame: reference(upper.frame!) }, proposals: [] }, works }));
  const gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const previousLines = store.get<GapLinesRecord>(gapLinesId(project))!;
  const lines = ok(writeGapLines(store, { project, previous: reference(previousLines),
    pass: previousLines.value.request.pass + 1, gaps: gapRead, closures: [] }));
  const handoff = ok(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [] }));
  assert.deepEqual(handoff.handoff.obligations, []);
  if ('state' in gapRead.sources.works) throw new Error('The rebased native layer must supply the works frame');
  const candidate = ok(writeCandidate(store, { ...gapRead.sources.works, works: { contract: WORKS_FRAME_CONTRACT,
    producer: reference(handoff.producer), ledger: reference(handoff.record), bindings: [] } }));
  assert.equal(candidate.state, 'candidate'); if (candidate.state !== 'candidate') throw new Error('Missing works candidate');
  const candidateRef = reference(candidate.record), neighbors = ok(writeNeighbors(store, { project, candidate: candidateRef }));
  const environment = engine.environments.get(project), { projectId: _projectId, ...configuration } = environment.value;
  const capacity = engine.environments.configure(project, { ...configuration, requestCapacityChars: 200_000 }, environment.revision);
  const gate = ok(writeAtomicGate(store, { project, candidate: candidateRef, neighbors: reference(neighbors),
    environment: reference(capacity), gaps: gapRead, results: [], sources: [], snapshot: null }));
  assert.equal(gate.value.result.passed, true, canonical(gate.value.result.findings));
  const accepted = ok(settleCandidate(store, { project, level: 3, candidate: candidateRef,
    outcome: { ...gate.value.result, codes: [...gate.value.result.codes], basis: reference(gate) } }));
  assert.equal(accepted.state, 'accepted'); assert.ok(accepted.graph && accepted.layer && accepted.frame);
  const acceptance = { project, level: 3 as const, graph: reference(accepted.graph),
    layer: reference(accepted.layer), frame: reference(accepted.frame) };
  const request = { acceptance, obligation: obligation.id }, identity = ok(readResultIdentity(store, request));
  assert.match(identity.key, /^om-result:[a-f0-9]{64}$/);
  assert.ok(identity.fills.length > 0 && identity.fills.every(fill => fill.codeRef !== undefined));
  const previousRefs = [from.graph, from.layer!, from.frame, reference(rebased.layer), reference(rebased.frame)];
  for (const ref of previousRefs) assert.ok(identity.references.some(found => canonical(found) === canonical(ref)), ref.id);
  const identityBytes = canonical(identity), frameBytes = canonical(nativeFrame), rebaseBytes = canonical(rebased.frame);
  for (const ref of [acceptance.graph, acceptance.layer, acceptance.frame, reference(capacity)]) {
    const head = store.get(ref.id)!;
    store.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
  }
  f.reopen();
  const beforeHistory = snapshot(f.store);
  sameButReferences(ok(readResultIdentity(f.store, request)), identityBytes);
  assert.equal(canonical(f.store.get(nativeFrame.id, nativeFrame.revision)), frameBytes);
  assert.equal(canonical(f.store.get(rebased.frame.id, rebased.frame.revision)), rebaseBytes);
  refusedWith(readResultIdentity(f.store, { acceptance: rebaseAcceptance, obligation: obligation.id }), 'frame_acceptance_invalid');
  assert.deepEqual(snapshot(f.store), beforeHistory);
});

function declaredAcceptance(f: ReturnType<typeof fixture>, block = 'garden-produce-block') {
  const frame = ok(readFrame(f.store, f.frame));
  const obligations = frame.result.obligations.filter(item => item.upper.node === block
    && f.candidate.value.fills.some(fill => fill.obligation === item.id && fill.source !== 'identity')).map(item => item.id).sort();
  assert.ok(obligations.length > 1);
  const address = { project: 'garden', block, line: 1 };
  const goal: AttemptGoal = { key: `accept:${block}`, result: 'accepted-gap-fill',
    questions: obligations.map(id => gapLineKey('garden', id, 'fill')) };
  ok(openSeries(f.store, { ...address, slice: `accept:${block}`, predecessor: null, basis: null }));
  const series = ok(beginAttempt(f.store, { ...address, attempt: 1, goal }));
  return { address, goal, binding: { series: reference(series), ordinal: 1, obligations } };
}

test('C5.1 binds genuine N2 goals, retains the exact nonzero draft output and replays after restart without reassignment', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
  const f = fixture(t), declared = declaredAcceptance(f), request = { ...f.request, binding: declared.binding };
  assert.equal(f.frame.layer, null);
  const draft = f.store.get('graph-layer:garden:2')!;
  assert.ok(draft.revision > 0);
  const prepared = ok(prepareSettleCandidate(f.store, request));
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(declared.binding.series)));
  const accepted = ok(settleCandidate(f.store, request));
  assert.ok(accepted.frame && accepted.layer && accepted.graph);
  assert.equal(accepted.frame.value.acceptance.contract, 'om-frame-acceptance/v1');
  assert.deepEqual(accepted.frame.value.acceptance.binding, declared.binding);
  assert.deepEqual(accepted.frame.value.acceptance.layer, { id: draft.id, revision: draft.revision + 1 });
  assert.ok(accepted.frame.value.fills.some(fill => !declared.binding.obligations.includes(fill.obligation)));
  const exact = { project: 'garden', level: 2 as const, frame: reference(accepted.frame) };
  const read = ok(readAcceptedFrameLayer(f.store, exact));
  assert.deepEqual(read.graph, accepted.graph); assert.deepEqual(read.layer, accepted.layer); assert.deepEqual(read.frame, accepted.frame);
  const duplicate = f.store.write({ id: accepted.layer.id, kind: accepted.layer.kind, expected: accepted.layer.revision, value: accepted.layer.value });
  refusedWith(readAcceptedFrame(f.store, { ...exact, graph: reference(accepted.graph!), layer: reference(duplicate) }), 'layer_basis_unproven');
  const ended = ok(completeAttempt(f.store, { ...declared.address, attempt: 1,
    outcome: { reason: 'result', achieved: [], cancelled: [], refusals: [] } }));
  ok(openSeries(f.store, { ...declared.address, line: 2, slice: 'after-accepted-result', predecessor: reference(ended),
    basis: { ground: 'inputs-changed', text: 'The next source slice follows the accepted result' } }));
  const second = ok(beginAttempt(f.store, { ...declared.address, line: 2, attempt: 2, goal: declared.goal }));
  const reopened = new Store(f.database);
  try {
    const before = snapshot(reopened);
    assert.deepEqual(ok(readAcceptedFrameLayer(reopened, exact)), read);
    const replay = ok(settleCandidate(reopened, request));
    assert.equal(replay.state, 'unchanged'); assert.deepEqual(replay.frame, accepted.frame);
    for (const binding of [null, { ...declared.binding, series: reference(second), ordinal: 2 },
      { ...declared.binding, obligations: declared.binding.obligations.slice(0, 1) }])
      for (const action of [prepareSettleCandidate, settleCandidate]) refusedWith(action(reopened, { ...request, binding }), 'frame_acceptance_invalid');
    assert.deepEqual(snapshot(reopened), before);
  } finally { reopened.close(); }
});

test('C5.1 rejects undeclared, foreign, identity and forged N2 bindings before any acceptance writes', t => {
  const f = fixture(t), declared = declaredAcceptance(f), frame = ok(readFrame(f.store, f.frame));
  const foreign = declaredAcceptance(f, 'garden-consume-block');
  const undeclared = declared.binding.obligations[1]!;
  const shortAddress = { project: 'garden', block: declared.address.block, line: 1 };
  const short = fixture(t);
  ok(openSeries(short.store, { ...shortAddress, slice: 'short-goal', predecessor: null, basis: null }));
  const narrow = ok(beginAttempt(short.store, { ...shortAddress, attempt: 1,
    goal: { ...declared.goal, questions: [gapLineKey('garden', declared.binding.obligations[0]!, 'fill')] } }));
  const identityFixture = fixture(t, true);
  const identity = identityFixture.candidate.value.fills.find(fill => fill.source === 'identity');
  assert.ok(identity);
  // A malformed obligation list is not a request: it is thrown. Every other undeclared, foreign or forged binding is
  // answered with a returned refusal; neither channel stands in for the other.
  const malformed = [
    { ...declared.binding, obligations: [] },
    { ...declared.binding, obligations: [declared.binding.obligations[0]!, declared.binding.obligations[0]!] },
  ];
  const invalid = [
    { ...declared.binding, obligations: ['missing-obligation'] },
    { ...declared.binding, series: foreign.binding.series },
    { ...declared.binding, ordinal: 2 },
    { ...declared.binding, series: { ...declared.binding.series, hash: '0'.repeat(64) } },
    { ...declared.binding, obligations: [frame.result.obligations.find(item => item.upper.node === foreign.address.block)!.id] },
  ];
  const before = snapshot(f.store);
  for (const binding of malformed) for (const action of [prepareSettleCandidate, settleCandidate])
    thrownWith(() => action(f.store, { ...f.request, binding }), 'frame_accept_request_invalid');
  for (const binding of invalid) for (const action of [prepareSettleCandidate, settleCandidate])
    refusedWith(action(f.store, { ...f.request, binding }), 'layer_basis_unproven');
  assert.deepEqual(snapshot(f.store), before);
  const shortBefore = snapshot(short.store);
  for (const action of [prepareSettleCandidate, settleCandidate]) refusedWith(action(short.store,
    { ...short.request, binding: { series: reference(narrow), ordinal: 1, obligations: [undeclared] } }), 'layer_basis_unproven');
  assert.deepEqual(snapshot(short.store), shortBefore);
  const identityObligation = ok(readFrame(identityFixture.store, identityFixture.frame)).result.obligations.find(item => item.id === identity.obligation)!;
  for (const scenario of [
    { name: 'foreign-owner', block: foreign.address.block, obligations: declared.binding.obligations, goal: declared.goal },
    { name: 'wrong-result', block: declared.address.block, obligations: declared.binding.obligations,
      goal: { ...declared.goal, result: 'different-result' } },
    { name: 'declared-identity', block: identityObligation.upper.node, obligations: [identity.obligation],
      goal: { key: 'declared-identity', result: 'accepted-gap-fill', questions: [gapLineKey('garden', identity.obligation, 'fill')] } },
  ]) {
    const isolated = scenario.name === 'declared-identity' ? identityFixture : fixture(t);
    const address = { project: 'garden', block: scenario.block, line: 1 };
    ok(openSeries(isolated.store, { ...address, slice: scenario.name, predecessor: null, basis: null }));
    const attempt = ok(beginAttempt(isolated.store, { ...address, attempt: 1, goal: scenario.goal }));
    const before = snapshot(isolated.store);
    for (const action of [prepareSettleCandidate, settleCandidate]) refusedWith(action(isolated.store,
      { ...isolated.request, binding: { series: reference(attempt), ordinal: 1, obligations: scenario.obligations } }), 'layer_basis_unproven');
    assert.deepEqual(snapshot(isolated.store), before);
  }
});

test('C5.1 a real successor claims the predecessor revision and the series guard prevents a stale acceptance transaction', t => {
  const f = fixture(t), declared = declaredAcceptance(f);
  const prepared = ok(prepareSettleCandidate(f.store, { ...f.request, binding: declared.binding }));
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(declared.binding.series)));
  const other = new Store(f.database);
  let ended: ReturnType<typeof completeAttempt> extends OmResult<infer T> ? T : never;
  try {
    ended = ok(completeAttempt(other, { ...declared.address, attempt: 1,
      outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } }));
    const successor = ok(openSeries(other, { ...declared.address, line: 2, slice: 'changed-acceptance-input',
      predecessor: reference(ended), basis: { ground: 'inputs-changed', text: 'The source slice changed after the interrupted attempt' } }));
    assert.deepEqual(successor.value.predecessor, reference(ended));
  } finally { other.close(); }
  const claimed = f.store.get(ended.id)!;
  assert.equal(claimed.revision, ended.revision + 1); assert.equal(claimed.hash, ended.hash);
  assert.deepEqual(claimed.value, ended.value);
  const before = snapshot(f.store);
  refusedWith(writeGuarded(f.store, { unit: 'C5.1', target: f.request.candidate.id,
    writes: prepared.writes, guards: prepared.guards }), 'input_stale');
  // Isolate the successor's own same-body CAS from the earlier completion revision change.
  const successorGuards = prepared.guards.map(ref => ref.id === ended.id ? reference(ended) : ref);
  refusedWith(writeGuarded(f.store, { unit: 'C5.1', target: f.request.candidate.id,
    writes: prepared.writes, guards: successorGuards }), 'input_stale');
  assert.deepEqual(snapshot(f.store), before); assert.equal(f.store.get('om-frame:garden:2'), null);
});

test('C5.1 explicit era fields and exact output back-references cannot be omitted, downgraded or forged', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const f = fixture(t), prepared = ok(prepareSettleCandidate(f.store, f.request));
  assert.ok(prepared.result.frame && prepared.result.layer);
  assert.equal(prepared.result.frame.value.acceptance.binding, null);
  const base = await f.store.snapshot(join(f.root, 'c51-forgery-base'));
  const variants: [string, (acceptance: Record<string, unknown>) => void][] = [
    ['missing-binding', value => { delete value['binding']; }],
    ['missing-layer', value => { delete value['layer']; }],
    ['missing-contract', value => { delete value['contract']; }],
    ['unknown-contract', value => { value['contract'] = 'om-frame-acceptance/future'; }],
    ['foreign-layer', value => { value['layer'] = { id: 'graph-layer:foreign:2', revision: 1 }; }],
    ['wrong-output-revision', value => { value['layer'] = { id: 'graph-layer:garden:2', revision: 1 }; }],
    ['hashed-locator', value => { value['layer'] = { ...(value['layer'] as object), hash: '0'.repeat(64) }; }],
    ['locator-without-id', value => { value['layer'] = { revision: prepared.result.layer!.revision }; }],
    ['locator-without-revision', value => { value['layer'] = { id: 'graph-layer:garden:2' }; }],
    ['binding-without-series', value => { value['binding'] = { ordinal: 1, obligations: [f.candidate.value.fills[0]!.obligation] }; }],
    ['binding-without-ordinal', value => { value['binding'] = { series: f.request.candidate, obligations: [f.candidate.value.fills[0]!.obligation] }; }],
    ['binding-without-obligations', value => { value['binding'] = { series: f.request.candidate, ordinal: 1 }; }],
    ['missing-series-record', value => { value['binding'] = { series: { id: seriesId('garden', 'garden-produce-block', 1),
      revision: 1, hash: 'a'.repeat(64) }, ordinal: 1, obligations: [f.candidate.value.fills[0]!.obligation] }; }],
    ['forged-series', value => { value['binding'] = { series: f.request.candidate, ordinal: 1,
      obligations: [f.candidate.value.fills[0]!.obligation] }; }],
    ['extra-layer-field', () => {}],
    ['missing-layer-projection', () => {}],
    ['wrong-layer-backref', () => {}],
  ];
  for (const [name, alter] of variants) {
    const path = join(f.root, `c51-${name}.sqlite`); copyFileSync(base.path, path);
    let store = new Store(path);
    try {
      const writes = structuredClone(prepared.writes) as Write[], frameWrite = writes.find(write => write.kind === 'connection-frame')!;
      const body = frameWrite.value as { acceptance: Record<string, unknown> }; alter(body.acceptance);
      const frame = { id: frameWrite.id, revision: frameWrite.expected + 1, hash: hashJson(body) };
      const layerWrite = writes.find(write => write.kind === 'graph-layer')!, layer = layerWrite.value as LayerBasis;
      const swap = (ref: Ref) => ref.id === frame.id ? frame : ref;
      const sort = (refs: Ref[]) => refs.sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
      layer.acceptance!.frame = frame; layer.inputs = sort(layer.inputs.map(swap));
      for (const proof of layer.layerProofs!) proof.inputs = sort(proof.inputs.map(swap));
      if (name === 'extra-layer-field') (layer as unknown as Record<string, unknown>)['unproduced'] = true;
      if (name === 'missing-layer-projection') delete (layer as Partial<LayerBasis>).projection;
      if (name === 'wrong-layer-backref') layer.acceptance!.frame = f.request.candidate;
      store.writeMany(writes);
      store.close(); store = new Store(path);
      const before = snapshot(store), request = { project: 'garden', level: 2 as const, frame };
      refusedWith(readAcceptedFrameLayer(store, request), 'layer_basis_unproven');
      refusedWith(readLayerAcceptance(store, { ...request, graph: reference(store.get('graph:garden')!),
        layer: reference(store.get(layerWrite.id)!) }), 'layer_basis_unproven');
      assert.deepEqual(snapshot(store), before);
    } finally { store.close(); }
  }
  const accepted = ok(settleCandidate(f.store, f.request));
  assert.ok(accepted.frame && accepted.layer);
  const later = f.store.write({ id: accepted.layer.id, kind: accepted.layer.kind, expected: accepted.layer.revision,
    value: { ...accepted.layer.value, acceptance: { producer: 'om', frame: f.request.candidate } } });
  const read = ok(readAcceptedFrameLayer(f.store, { project: 'garden', level: 2, frame: reference(accepted.frame) }));
  assert.deepEqual(read.layer, accepted.layer); assert.notEqual(read.layer.revision, later.revision);
});

test('C5.1 the frame-to-layer reader rejects absent or malformed public arguments before storage reads', t => {
  const f = fixture(t), valid = { project: 'garden', level: 2 as const,
    frame: { id: 'om-frame:garden:2', revision: 1, hash: 'a'.repeat(64) } };
  const malformed: unknown[] = [undefined, null, [], 0, 'request', {}, ...Object.keys(valid).map(key => {
    const value = { ...valid } as Record<string, unknown>; delete value[key]; return value;
  }), { ...valid, level: 1 }, { ...valid, frame: null }, { ...valid, frame: { ...valid.frame, revision: 0 } },
  { ...valid, frame: { ...valid.frame, hash: 'invalid' } }];
  const original = f.store.get.bind(f.store);
  try {
    f.store.get = (() => { throw new Error('Malformed frame locator reached storage'); }) as Store['get'];
    for (const value of malformed) assert.throws(() => readAcceptedFrameLayer(f.store,
      value as Parameters<typeof readAcceptedFrameLayer>[1]), error => error instanceof EngineError && error.code === 'layer_basis_request_invalid');
    for (const value of [undefined, null, {}, []]) assert.throws(() => readAcceptedFrameLayer(value as unknown as Store, valid),
      error => error instanceof EngineError && error.code === 'layer_basis_request_invalid');
  } finally { f.store.get = original; }
});

interface CurrentF5Fixture {
  root: string; database: string; trace: string; traceBytes: string; graph: Ref;
  request: WorksAcceptanceRequest; goal: { block: string; ordinal: number; series: Ref; goal: AttemptGoal };
  obligations: string[]; foreignObligations: string[]; realizedObligations: string[];
}
async function currentF5Fixture(t: TestContext): Promise<CurrentF5Fixture> {
  const seedResources: AtomicSeedResources = [];
  t.after(() => {
    for (const resource of seedResources) {
      resource.store.close(); rmSync(resource.root, { recursive: true, force: true });
    }
  });
  const seed = await produceAtomicSeed(seedResources);
  const f = seed.data;
  const all = f.gaps.records.map(row => row.value.gap).filter(gap => gap.code === 'obligation_open'
    && gap.evidence.some(evidence => evidence.origin === 'works'));
  const owned = (gap: (typeof all)[number]) => f.openGoal.goal.questions.includes(gapLineKey('garden', gap.target, gap.field));
  const store = new Store(seed.database);
  try {
    if ('state' in f.gapRead.sources.works) throw new Error('Expected the native pending work frame');
    const works = ok(readFrame(store, f.gapRead.sources.works.frame));
    return { root: seed.root, database: seed.database, trace: seed.trace, traceBytes: seed.traceBytes, graph: f.graph,
      request: f.request, goal: f.openGoal, obligations: all.filter(owned).map(gap => gap.target).sort(),
      foreignObligations: all.filter(gap => !owned(gap)).map(gap => gap.target).sort(),
      realizedObligations: works.result.obligations.filter(item => item.upper.node === 'garden-produce-operation').map(item => item.id).sort() };
  } finally { store.close(); }
}

test('C5.1 current F5 acceptance preserves null and exact work bindings, series guards and restart replay', async t => {
  const f = await currentF5Fixture(t);
  assert.ok(f.obligations.length > 1 && f.foreignObligations.length > 0);
  for (const binding of [null, f.request.binding]) {
    const path = join(f.root, `binding-${binding === null}.sqlite`); copyFileSync(f.database, path);
    const bound = new Store(path);
    try {
      const request = { ...f.request, binding };
      const accepted = ok(writeWorksAcceptance(bound, request)); assert.ok(accepted.acceptance);
      const read = ok(readAcceptedFrameLayer(bound, { project: 'garden', level: 3, frame: accepted.acceptance.frame }));
      assert.equal(read.frame.value.acceptance.contract, 'om-frame-acceptance/v1');
      assert.deepEqual(read.frame.value.acceptance.binding, binding);
      const before = snapshot(bound), replay = ok(writeWorksAcceptance(bound, request));
      assert.equal(replay.state, 'unchanged'); assert.deepEqual(replay.record, accepted.record);
      assert.deepEqual(replay.acceptance, accepted.acceptance); assert.deepEqual(snapshot(bound), before);
    } finally { bound.close(); }
  }
  const realizedPath = join(f.root, 'realized-block.sqlite'); copyFileSync(f.database, realizedPath);
  const realized = new Store(realizedPath);
  try {
    const address = { project: 'garden', block: f.goal.block, line: 1 };
    assert.equal(address.block, 'garden-consume-block'); assert.ok(f.realizedObligations.length > 1);
    const graph = realized.get<Graph>(f.graph.id, f.graph.revision)!.value;
    assert.notEqual(graph.nodes.find(node => node.id === 'garden-produce-operation')!.parent, address.block);
    assert.ok(graph.edges!.some(edge => edge.relation === 'realizes' && edge.source === 'garden-produce-operation' && edge.target === address.block));
    // LG08-03: the produce-operation fills entered this attempt's original completion lawfully — every selected
    // batch item names this block among its consumers — so the realizes edge binds them to the consume series
    // whose block differs from the operation's parent.
    const running = ok(readSeries(realized, address));
    assert.deepEqual(reference(running), f.goal.series);
    assert.equal(running.value.attempts.find(item => item.ordinal === f.goal.ordinal)!.outcome, null);
    const binding = { series: f.goal.series, ordinal: f.goal.ordinal, obligations: f.realizedObligations };
    const accepted = ok(writeWorksAcceptance(realized, { ...f.request, binding })); assert.ok(accepted.acceptance);
    const read = ok(readAcceptedFrameLayer(realized, { project: 'garden', level: 3, frame: accepted.acceptance.frame }));
    assert.deepEqual(read.frame.value.acceptance.binding, binding);
  } finally { realized.close(); }
  let store = new Store(f.database);
  try {
    const binding = { series: f.goal.series, ordinal: f.goal.ordinal, obligations: f.obligations };
    const request = { ...f.request, binding };
    const series = ok(readSeries(store, { project: 'garden', block: f.goal.block, line: 1 }));
    assert.deepEqual(reference(series), binding.series);
    assert.equal(series.value.attempts.find(item => item.ordinal === binding.ordinal)!.outcome, null);
    const before = snapshot(store);
    for (const action of [prepareWorksAcceptance, writeWorksAcceptance]) refusedWith(action(store,
      { ...request, binding: { ...binding, obligations: [...binding.obligations, f.foreignObligations[0]!] } }), 'layer_basis_unproven');
    assert.deepEqual(snapshot(store), before);
    const prepared = ok(prepareWorksAcceptance(store, request));
    assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(binding.series)));
    assert.deepEqual(snapshot(store), before);
    const accepted = ok(writeWorksAcceptance(store, request));
    assert.ok(accepted.acceptance);
    const exact = { project: 'garden', level: 3 as const, frame: accepted.acceptance.frame };
    const saved = ok(readAcceptedFrameLayer(store, exact));
    assert.equal(saved.frame.value.acceptance.contract, 'om-frame-acceptance/v1');
    assert.deepEqual(saved.frame.value.acceptance.binding, binding);
    assert.deepEqual(saved.frame.value.acceptance.layer, { id: saved.layer.id, revision: saved.layer.revision });
    assert.ok(saved.frame.value.fills.some(fill => f.foreignObligations.includes(fill.obligation)));
    const identity = f.obligations.map(obligation => ok(readResultIdentity(store,
      { acceptance: accepted.acceptance!, obligation })).key);
    assert.equal(new Set(identity).size, identity.length);
    store.close(); store = new Store(f.database);
    const savedHeads = snapshot(store);
    assert.deepEqual(ok(readAcceptedFrameLayer(store, exact)), saved);
    assert.equal(ok(writeWorksAcceptance(store, request)).state, 'unchanged');
    for (const action of [prepareWorksAcceptance, writeWorksAcceptance]) refusedWith(action(store,
      { ...request, binding: { ...binding, obligations: binding.obligations.slice(0, 1) } }), 'input_stale');
    assert.deepEqual(snapshot(store), savedHeads);
    assert.equal(readFileSync(f.trace, 'utf8'), f.traceBytes);
  } finally { store.close(); }
});

// LG11: required saved fields cannot fall back to an older acceptance/replay contract.
test('LG11 C5 reads and repeat settlement reject missing acceptance contract or binding without writes', t => {
  const f = fixture(t), accepted = ok(settleCandidate(f.store, f.request));
  assert.ok(accepted.graph && accepted.layer && accepted.frame);
  const exact = { project: 'garden', level: 2 as const, graph: reference(accepted.graph),
    layer: reference(accepted.layer), frame: reference(accepted.frame) };
  for (const field of ['contract', 'binding'] as const) for (const value of ['absent', 'unknown', {}]) {
    const row = structuredClone(accepted.frame), acceptance = row.value.acceptance as unknown as Record<string, unknown>;
    if (value === 'absent') delete acceptance[field]; else acceptance[field] = value;
    const view = new Proxy(f.store, { get(target, key) {
      if (key === 'get') return (id: string, revision?: number) => id === row.id && (revision === undefined || revision === row.revision)
        ? row : target.get(id, revision);
      if (key === 'history') return (id: string) => target.history(id).map(saved => id === row.id && saved.revision === row.revision ? row : saved);
      const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    const before = snapshot(f.store);
    for (const result of [readAcceptedFrame(view, exact), prepareSettleCandidate(view, f.request), settleCandidate(view, f.request)])
      refusedWith(result, 'frame_acceptance_invalid');
    assert.deepEqual(snapshot(f.store), before);
  }
});

test('LG11 an exact work rejection refuses absent or malformed saved binding before following its references', t => {
  const f = fixture(t);
  for (const binding of ['absent', {}, 0]) {
    const value = { contract: 'om-work-rejection/v1', candidate: f.request.candidate, gate: f.request.candidate,
      ...(binding === 'absent' ? {} : { binding }) };
    const row = f.store.write({ id: `om-work-rejection:garden:missing-${String(binding)}`, kind: 'om-work-rejection', expected: 0, value });
    const result = readWorkRejectionAt(f.store, { project: 'garden', record: reference(row) });
    refusedWith(result, 'frame_acceptance_invalid');
    if (!result.ok) assert.equal(result.refusal.at.field, 'binding');
  }
});

test('LG11 repeat rebase refuses a saved transition without its current work-zone contract', async t => {
  const f = await rebaseFixture(t), moved = ok(rebaseFrame(f.store, f.request));
  for (const marker of ['absent', 'unknown', null]) {
    const row = structuredClone(moved.frame), to = row.value.rebase.to as unknown as Record<string, unknown>;
    if (marker === 'absent') delete to.workZoneContract; else to.workZoneContract = marker;
    const view = new Proxy(f.store, { get(target, key) {
      if (key === 'get') return (id: string, revision?: number) => id === row.id && revision === row.revision ? row : target.get(id, revision);
      const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    const before = snapshot(f.store);
    for (const action of [prepareRebaseFrame, rebaseFrame]) {
      const result = action(view, f.request); refusedWith(result, 'frame_acceptance_invalid');
      if (!result.ok) assert.equal(result.refusal.at.field, 'rebase.to.workZoneContract');
    }
    assert.deepEqual(snapshot(f.store), before);
  }
});
