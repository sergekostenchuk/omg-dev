import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { projectGraph } from '../src/graph/project.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Write } from '../src/storage/store.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import { writeCandidate, type CandidateReadRequest, type CandidateRequest } from '../src/om/frame-candidate.js';
import type { LayerProposal, ProposalRequest } from '../src/om/frame-proposals.js';
import { writeGapLines } from '../src/om/gap-lines.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeOmInput } from '../src/om/input.js';
import { writeOmObligations } from '../src/om/obligations.js';
import { writeGuarded } from '../src/om/refs.js';
import { writeWorksFrame } from '../src/om/works-frame.js';
import { preparedField } from './preparation-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { canonical, hashJson } from '../src/canonical.js';
import { deriveTasks } from '../src/compiler/derive.js';
import { nodeSignature } from '../src/compiler/model.js';
import { Owners } from '../src/ownership/owners.js';
import { prepareDeliveries, readDeliveries } from '../src/om/deliveries.js';
import { EngineError } from '../src/errors.js';
import { LEVEL, type Graph, type Node } from '../src/graph/model.js';
import { RefinementRelations } from '../src/graph/relations.js';
import { fillObligations, prepareFrame, readFrame, readFrameFlow, frameObligations, flowKey, workAnchorId, type FrameRead, type FrameRequest, type FrameLevel, type FrameObligation, type FrameFlowSource } from '../src/om/frame-obligations.js';
import { buildPackets, neighborsOf, prepareNeighbors, readNeighbors, writeNeighbors, type NeighborCollection, type NeighborReadRequest, type NeighborSources } from '../src/om/neighbors.js';
import type { OmResult, Sealed } from '../src/om/refusal.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';
import { createOmFixture } from './om-fixture.js';

const producer = 'garden-produce-work', consumer = 'garden-consume-work';
const producerOp = 'garden-produce-operation', consumerOp = 'garden-consume-operation';
const producerBlock = 'garden-produce-block', consumerBlock = 'garden-consume-block';
const connectorId = 'garden-flow';
const clone = structuredClone;
const node = (graph: Graph, id: string): Node => graph.nodes.find(item => item.id === id)!;
const binding = (graph: Graph, level: FrameLevel | 1) => graph.connectors[0]!.bindings.find(item => item.level === level)!;
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function denied(result: OmResult<unknown>, code: string): void {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected a typed neighbor refusal');
  assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target);
  assert.ok(result.refusal.at.field || result.refusal.at.ref);
}
function sources(graph: Graph): NeighborSources {
  const relations = new RefinementRelations(graph);
  function frame(level: FrameLevel): NeighborSources['frames']['works'] {
    const upperNodes = graph.nodes.filter(item => LEVEL[item.kind] === level - 1).map(item => item.id);
    const obligations = clone(ok(frameObligations(graph, { nodes: upperNodes, excluded: [], hash: hashJson(upperNodes) }, level))) as FrameObligation[];
    const fills: NonNullable<NeighborSources['frames']['works']['fills']> = [];
    for (const obligation of obligations) {
      if (obligation.kind !== 'connection-end') {
        for (const lower of graph.nodes.filter(item => LEVEL[item.kind] === level && item.outcome === obligation.artifact
          && relations.refines(item.id, obligation.upper.node))) {
          fills.push({ obligation: obligation.id, node: lower.id, source: 'accepted' });
        }
        continue;
      }
      const connector = graph.connectors.find(item => item.id === obligation.connector)!;
      const seen = new Set<string>();
      for (const flow of connector.bindings.filter(item => item.level === level)) {
        const ends = obligation.role === 'producer' ? [flow.producer] : flow.consumers;
        for (const end of ends) {
          if (!relations.refines(end.node, obligation.upper.node) || end.port !== obligation.upper.port) continue;
          const key = canonical([end.node, end.port]);
          if (seen.has(key)) continue;
          seen.add(key);
          fills.push({ obligation: obligation.id, node: end.node, port: end.port, source: 'accepted',
            ...(level === 3 && end.codeRef ? { codeRef: clone(end.codeRef) } : {}) });
        }
      }
    }
    return { obligations, fills };
  }
  return { identity: [], receipts: {}, frames: { operations: frame(2), works: frame(3) } };
}
function fixture() {
  const graph = enrichedGraph(exampleGraph(), 'garden');
  return { graph, options: sources(graph) };
}
function severalAddresses() {
  const { graph } = fixture();
  const extraOp = 'garden-second-operation', extraBlock = 'garden-second-block';
  graph.nodes.push({ ...clone(node(graph, consumerBlock)), id: extraBlock },
    { ...clone(node(graph, consumerOp)), id: extraOp, parent: extraBlock });
  graph.edges!.push(
    { id: 'work-realizes-second-operation', relation: 'realizes', source: consumer, target: extraOp, condition: 'Serves both operations' },
    { id: 'operation-realizes-second-block', relation: 'realizes', source: consumerOp, target: extraBlock, condition: 'Serves both blocks' },
    { id: 'second-operation-realizes-first-block', relation: 'realizes', source: extraOp, target: consumerBlock, condition: 'Serves both blocks' },
  );
  binding(graph, 2).consumers.push({ node: extraOp, port: 'in' });
  binding(graph, 1).consumers.push({ node: extraBlock, port: 'in' });
  return { graph, options: sources(graph), extraOp, extraBlock };
}

function localOperationGraph() {
  const { graph } = fixture();
  graph.connectors[0]!.bindings = graph.connectors[0]!.bindings.filter(flow => flow.level === 3);
  node(graph, consumer).parent = producerOp;
  return graph;
}

test('neighbors derive both directions with exact contracts, code addresses, return routes and compiler input coverage', () => {
  const { graph, options } = fixture();
  const packets = ok(buildPackets(graph, options));
  assert.deepEqual(packets.map(packet => packet.work), [...graph.horizon].sort());
  assert.equal(new Set(packets.map(packet => packet.work)).size, graph.horizon.length);
  const reads = ok(neighborsOf(graph, consumer, options));
  const writes = ok(neighborsOf(graph, producer, options));
  assert.equal(reads.neighbors.length, 1);
  assert.equal(writes.neighbors.length, 1);
  const own = node(graph, consumer), other = node(graph, producer);
  const part = (id: string) => { const value = node(graph, id); return { id, title: value.title, outcome: value.outcome }; };
  assert.deepEqual(reads.neighbors[0], {
    connector: connectorId, artifact: 'garden-data', contract: { id: 'garden-contract', hash: hashJson({ type: 'string' }), external: false },
    direction: 'reads', port: 'in', codeRef: own.code[0],
    neighbor: { work: part(producer), operation: part(producerOp), block: part(producerBlock), port: 'out', codeRef: other.code[0] },
    returnsTo: producerBlock, delivery: 'in-plan',
  });
  assert.equal(writes.neighbors[0]!.direction, 'writes');
  assert.equal(writes.neighbors[0]!.neighbor.work.id, consumer);
  assert.equal(writes.hash, hashJson(writes.neighbors));
  assert.equal(reads.hash, hashJson(reads.neighbors));
  const compiled = deriveTasks('garden', hashJson(graph), graph, () => { throw new Error('An in-plan input must not resolve a receipt'); });
  for (const task of compiled.tasks) for (const input of task.inputs) {
    const packet = packets.find(item => item.work === task.node)!;
    assert.ok(packet.neighbors.some(item => 'connector' in item && item.connector === input.connector
      && item.artifact === input.artifact && item.direction === 'reads'));
  }
});

test('neighbor flow addresses follow realizes at both levels despite different structural placement', () => {
  const { graph } = fixture();
  node(graph, producer).parent = consumerOp;
  node(graph, producerOp).parent = consumerBlock;
  graph.edges!.push(
    { id: 'work-realizes-producer', source: producer, target: producerOp, relation: 'realizes', condition: 'Implements the producer' },
    { id: 'operation-realizes-producer', source: producerOp, target: producerBlock, relation: 'realizes', condition: 'Implements the producer block' },
  );
  const row = ok(neighborsOf(graph, consumer, sources(graph))).neighbors[0]!;
  assert.equal(row.neighbor.operation.id, producerOp);
  assert.equal(row.neighbor.block.id, producerBlock);
  assert.notEqual(row.neighbor.operation.id, node(graph, producer).parent);
  assert.notEqual(row.neighbor.block.id, node(graph, producerOp).parent);
});

test('accepted correspondence preserves every operation and block address of one neighbor endpoint', () => {
  const { graph, options, extraOp, extraBlock } = severalAddresses();
  const packet = ok(neighborsOf(graph, producer, options));
  assert.equal(packet.neighbors.length, 4);
  assert.deepEqual(packet.neighbors.map(row => [row.neighbor.operation.id, row.neighbor.block.id]).sort(),
    [[consumerOp, consumerBlock], [consumerOp, extraBlock], [extraOp, consumerBlock], [extraOp, extraBlock]].sort());
  assert.ok(packet.neighbors.every(row => row.neighbor.work.id === consumer));
  const missingWorks = clone(options); missingWorks.frames.works.fills = null;
  denied(neighborsOf(graph, producer, missingWorks), 'neighbor_chain_ambiguous');
  const missingOperations = clone(options); missingOperations.frames.operations.fills = null;
  denied(neighborsOf(graph, producer, missingOperations), 'neighbor_chain_ambiguous');
});

test('correspondence cannot claim an upper endpoint which the lower endpoint does not refine', () => {
  const { graph, options } = fixture();
  const rogueOp = 'garden-foreign-operation';
  graph.nodes.push({ ...clone(node(graph, consumerOp)), id: rogueOp, parent: producerBlock });
  const forged = clone(options);
  const consumerObligation = forged.frames.operations.obligations.find(item => item.kind === 'connection-end' && item.role === 'consumer')!;
  forged.frames.operations.fills!.push({ obligation: consumerObligation.id, node: rogueOp, port: 'in', source: 'accepted' });
  denied(neighborsOf(graph, producer, forged), 'neighbor_chain_broken');
  const missing = clone(options);
  missing.frames.works.fills!.find(fill => fill.port === 'in')!.obligation = 'f'.repeat(64);
  denied(neighborsOf(graph, producer, missing), 'neighbor_chain_broken');
});

test('endpoint code references retain the selected complete reference rather than the first declared path', () => {
  const { graph } = fixture();
  const exact = { path: 'src/second-output.ts', access: 'read' as const, status: 'existing' as const, symbol: 'deliver' };
  node(graph, producer).code.push(exact);
  binding(graph, 3).producer.codeRef = clone(exact);
  const options = sources(graph);
  assert.deepEqual(ok(neighborsOf(graph, consumer, options)).neighbors[0]!.neighbor.codeRef, exact);
  assert.deepEqual(ok(neighborsOf(graph, producer, options)).neighbors[0]!.codeRef, exact);
  const forged = clone(graph); binding(forged, 3).producer.codeRef!.symbol = 'differentSymbol';
  denied(neighborsOf(forged, consumer, options), 'neighbor_chain_broken');
  const absent = clone(graph); delete binding(absent, 3).producer.codeRef;
  denied(neighborsOf(absent, consumer, options), 'neighbor_chain_broken');
});

test('missing contracts and broken node chains produce addressed refusals', () => {
  const { graph, options } = fixture();
  const noContract = clone(graph); noContract.contracts = [];
  denied(neighborsOf(noContract, consumer, options), 'neighbor_contract_missing');
  const noArtifact = clone(graph); noArtifact.artifacts = noArtifact.artifacts.filter(item => item.id !== 'garden-data');
  denied(neighborsOf(noArtifact, consumer, options), 'neighbor_contract_missing');
  const broken = clone(graph); broken.nodes = broken.nodes.filter(item => item.id !== producerOp);
  denied(neighborsOf(broken, consumer, options), 'neighbor_chain_broken');
  denied(neighborsOf(graph, producerOp, options), 'neighbor_chain_broken');
});

test('outside producers retain named receipt references, external delivery and missing delivery without becoming sleeping consumers', () => {
  const { graph } = fixture(); graph.horizon = [consumer];
  const options = sources(graph);
  const receipt = { id: 'receipt:garden-data', revision: 7, hash: hashJson('exact receipt') };
  options.receipts[canonical([connectorId, producer])] = receipt;
  const row = ok(neighborsOf(graph, consumer, options)).neighbors[0]!;
  assert.equal(row.delivery, 'available'); assert.deepEqual(row.basis, receipt);
  assert.notStrictEqual(row.basis, receipt);
  assert.equal(Object.hasOwn(row, 'anchor'), false);
  assert.equal(ok(neighborsOf(graph, consumer, sources(graph))).neighbors[0]!.delivery, 'undelivered');
  const external = clone(graph); external.artifacts.find(item => item.id === 'garden-data')!.external = true;
  assert.equal(ok(neighborsOf(external, consumer, sources(external))).neighbors[0]!.delivery, 'external');
});

test('sleeping identity neighbors are explicitly represented and never promise an existing code address', () => {
  const { graph } = fixture(); graph.horizon = [producer];
  const work = node(graph, consumer); work.code = []; work.tests = [];
  delete binding(graph, 3).consumers[0]!.codeRef;
  const anchor = workAnchorId(connectorId, flowKey(binding(graph, 2)), binding(graph, 3).producer), wakeTest = node(graph, producer).tests[0]!;
  binding(graph, 3).anchor = anchor; graph.connectors[0]!.wakeTest = wakeTest;
  graph.anchors.push({ id: anchor, owner: producer, outcome: 'garden-data', test: wakeTest });
  const options = sources(graph); options.identity.push(consumer);
  for (const fill of options.frames.works.fills!) if (fill.node === consumer) fill.source = 'identity';
  const row = ok(neighborsOf(graph, producer, options)).neighbors[0]!;
  assert.equal(row.delivery, 'sleeping'); assert.equal(row.anchor, anchor); assert.equal(row.wakeTest, wakeTest);
  assert.equal(row.neighbor.work.represented, true);
  assert.equal(row.neighbor.codeRef, null);
  assert.equal(Object.hasOwn(row.neighbor.operation, 'represented'), false);
  const falseIdentity = clone(options); falseIdentity.identity = [];
  denied(neighborsOf(graph, producer, falseIdentity), 'neighbor_chain_broken');
});

test('parallel consumer ports retain multiplicity and packet hashes ignore graph and frame traversal order', () => {
  const { graph } = fixture();
  for (const id of [consumerBlock, consumerOp, consumer]) node(graph, id).ports.push({ id: 'in-alt', direction: 'in', contract: 'garden-contract' });
  for (const level of [1, 2, 3] as const) {
    const end = clone(binding(graph, level).consumers[0]!); end.port = 'in-alt'; binding(graph, level).consumers.push(end);
  }
  const options = sources(graph), original = ok(buildPackets(graph, options));
  assert.equal(original.find(packet => packet.work === producer)!.neighbors.length, 2);
  assert.deepEqual(original.find(packet => packet.work === consumer)!.neighbors.map(row => row.port).sort(), ['in', 'in-alt']);
  const reordered = clone(graph), reversed = clone(options);
  reordered.nodes.reverse(); reordered.horizon.reverse(); reordered.tests.reverse();
  reordered.connectors.reverse();
  for (const connector of reordered.connectors) { connector.bindings.reverse(); for (const flow of connector.bindings) flow.consumers.reverse(); }
  for (const frame of [reversed.frames.operations, reversed.frames.works]) { frame.obligations.reverse(); frame.fills!.reverse(); }
  assert.deepEqual(ok(buildPackets(reordered, reversed)), original);
  for (const packet of original) {
    assert.equal(packet.hash, hashJson(packet.neighbors));
    assert.deepEqual(packet.neighbors.map(hashJson), packet.neighbors.map(hashJson).sort());
  }
});

test('delivered packets are recursively sealed and never share mutable graph or correspondence values', () => {
  const { graph, options } = fixture(), graphHash = hashJson(graph), sourcesHash = hashJson(options);
  const result = buildPackets(graph, options), packets = ok(result), packet = packets.find(item => item.work === consumer)!;
  const originalHash = packet.hash;
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(packets)); assert.ok(Object.isFrozen(packet));
  assert.ok(Object.isFrozen(packet.neighbors)); assert.ok(Object.isFrozen(packet.neighbors[0]!.neighbor));
  assert.ok(Object.isFrozen(packet.neighbors[0]!.neighbor.codeRef));
  assert.notStrictEqual(packet.neighbors[0]!.neighbor.codeRef, binding(graph, 3).producer.codeRef);
  assert.throws(() => { Object.assign(packet.neighbors[0]!.neighbor.work, { title: 'forged' }); }, TypeError);
  assert.equal(hashJson(graph), graphHash); assert.equal(hashJson(options), sourcesHash);
  node(graph, producer).title = 'later source change';
  assert.equal(packet.hash, originalHash); assert.equal(hashJson(packet.neighbors), originalHash);
});

test('every public argument is rejected with neighbor_request_invalid before dereferencing malformed values', () => {
  const { graph, options } = fixture();
  const invalid = (action: () => unknown) => assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, 'neighbor_request_invalid');
    const details = error.details as { target: string; field: string };
    assert.ok(details.target); assert.ok(details.field); return true;
  });
  for (const value of [undefined, null, false, 0, '', [], {}]) {
    invalid(() => neighborsOf(value as Graph, consumer, options));
    invalid(() => buildPackets(value as Graph, options));
  }
  for (const value of [undefined, null, false, 0, '', [], {}]) invalid(() => neighborsOf(graph, value as string, options));
  const malformed = [undefined, null, false, [], {}, { ...options, identity: undefined }, { ...options, identity: null },
    { ...options, identity: [null] }, { ...options, receipts: undefined }, { ...options, receipts: [] },
    { ...options, receipts: { invalid: { id: 'receipt', revision: 0, hash: 'wrong' } } },
    { ...options, frames: undefined }, { ...options, frames: {} },
    { ...options, frames: { ...options.frames, works: { obligations: undefined, fills: [] } } },
    { ...options, frames: { ...options.frames, works: { obligations: [], fills: undefined } } },
    { ...options, frames: { ...options.frames, operations: { obligations: [], fills: [null] } } }];
  for (const value of malformed) {
    invalid(() => neighborsOf(graph, consumer, value as NeighborSources));
    invalid(() => buildPackets(graph, value as NeighborSources));
  }
});

// Persisted F4: actual stage writers, operation acceptance, D1/D2/D7 and F2.
const persistedHeads = (store: Store) => store.list().map(row => ({ ref: reference(row), history: store.history(row.id).map(reference) }));
function persistedProposal(frame: FrameRead, desired: Graph): LayerProposal {
  const graph = clone(desired), level = frame.request.level;
  if (level === 3) {
    for (const part of ['nodes', 'artifacts', 'contracts', 'anchors', 'joins', 'tests', 'edges', 'journeys', 'packets', 'transfers'] as const) {
      const upper = frame.upper[part] ?? [], ids = new Set(upper.map(item => item.id));
      Object.assign(graph, { [part]: [...clone(upper), ...(graph[part] ?? []).filter(item => !ids.has(item.id))] });
    }
    graph.connectors = frame.upper.connectors.map(upper => ({ ...clone(upper), bindings: [...clone(upper.bindings),
      ...graph.connectors.find(connector => connector.id === upper.id)!.bindings.filter(binding => binding.level === 3)] }));
  }
  const projected = projectGraph(graph, level), mapped = ok(fillObligations(frame.upper, frame.scope,
    { graph, reference: { ...frame.request.graph, hash: hashJson(graph) }, frame: null }, frame.upperRef, level));
  const nodes = projected.nodes.filter(item => item.kind === (level === 2 ? 'operation' : 'work')
    && (level === 2 || frame.scope.nodes.includes(item.parent!))), selected = new Set(nodes.map(item => item.id));
  return { base: { graph: frame.request.graph, frame: frame.request.frame }, level,
    ...(level === 3 ? { worksContract: 'works-frame/v1' as const } : {}), source: 'decision', status: 'proposed', nodes,
    fills: mapped.fills.filter(fill => selected.has(fill.node)).map(fill => {
      const obligation = mapped.obligations.find(item => item.id === fill.obligation)!;
      return { obligation: fill.obligation, node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }),
        ...(level === 3 && obligation.kind === 'connection-end' ? { codeRef: clone(nodes.find(item => item.id === fill.node)!.code[0]!) } : {}) };
    }),
    localConnectors: level === 3 ? [] : projected.connectors.map(connector => ({ ...connector,
      bindings: connector.bindings.filter(binding => binding.level === 2) })).filter(connector => connector.bindings.length),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
    tests: projected.tests.filter(item => level === 2 || selected.has(item.node)), edges: projected.edges ?? [],
    journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    anchors: level === 2 ? projected.anchors : [], removes: [], replaces: [], redefines: [] };
}
function persistedCandidate(t: TestContext, desiredGraph?: Graph) {
  const directory = mkdtempSync(join(tmpdir(), 'omg-neighbors-')), database = join(directory, 'state.sqlite');
  const store = new Store(database), engine = new ProductEngine(store), desired = desiredGraph ?? enrichedGraph(exampleGraph(), 'garden');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { level: _level, ...upper } = projectGraph(desired, 1);
  preparedFeatures(engine, 'garden', upper as Graph, field => preparedField('garden', field));
  const input = ok(writeOmInput(store, { project: 'garden', expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const first = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(store.get('graph:garden')!),
    refinement: null, available: {}, choice: { choiceVersion: 'neighbors-upper', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame2: FrameRequest = { project: 'garden', level: 2, graph: reference(store.get('graph:garden')!),
    horizon: reference(first.gate), layer: null, frame: null, upper: null };
  const put = (name: string, value: LayerProposal) => reference(store.write({ id: `om-proposal:garden:${name}`,
    kind: 'layer-proposal', expected: 0, value }));
  const proposal2 = put('neighbors-upper', persistedProposal(clone(ok(prepareFrame(store, frame2))) as unknown as FrameRead, desired));
  const candidate2 = ok(writeCandidate(store, { frame: frame2, proposals: [proposal2] }));
  assert.equal(candidate2.state, 'candidate'); if (candidate2.state !== 'candidate') throw new Error('Missing native L2 candidate');
  const upperCandidate = reference(candidate2.record);
  const accepted = ok(settleCandidate(store, { project: 'garden', level: 2, candidate: upperCandidate,
    outcome: { gate: 'G3', candidate: upperCandidate, graphHash: candidate2.record.value.graphHash, passed: true, codes: [] } }));
  const graph = reference(accepted.graph!), layer = reference(accepted.layer!), upperFrame = reference(accepted.frame!);
  const horizon = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph, refinement: layer,
    available: {}, choice: { choiceVersion: 'neighbors-works', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame: FrameRequest = { project: 'garden', level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
    upper: { horizon: reference(horizon.gate), frame: upperFrame } };
  const basis = clone(ok(prepareFrame(store, frame))) as unknown as FrameRead;
  const proposal = put('neighbors-works', persistedProposal(basis, desired));
  const works: ProposalRequest = { frame: basis.request, proposals: [proposal] };
  const gaps = ok(writeGaps(store, { project: 'garden', input: reference(input), graph, horizon: frame.horizon,
    operations: { frame: { ...frame2, graph, horizon: frame.horizon, layer, frame: upperFrame }, proposals: [] }, works }));
  const gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project: 'garden', previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const obligations = ok(writeOmObligations(store, { project: 'garden', gaps: gapRead, lines: reference(lines), assignments: [] }));
  const source: CandidateRequest = { ...works, works: { contract: 'works-frame/v1',
    producer: reference(obligations.producer), ledger: reference(obligations.record), bindings: [] } };
  const candidate = ok(writeWorksFrame(store, source));
  assert.equal(candidate.state, 'candidate'); if (candidate.state !== 'candidate') throw new Error('Missing native L3 candidate');
  assert.deepEqual([...candidate.record.value.graph.horizon].sort(), [consumer, producer]);
  assert.equal(store.get('execution-root:garden'), null);
  return { directory, database, store, candidate: candidate.record, request: { project: 'garden', candidate: reference(candidate.record) }, source, graph };
}

test('saved neighbor collections share pending indexes, exact candidate sources, history and transaction guards', { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, async t => {
  const f = persistedCandidate(t), before = persistedHeads(f.store), prepared = ok(prepareNeighbors(f.store, f.request));
  assert.deepEqual(persistedHeads(f.store), before);
  assert.equal(prepared.existing, null); assert.equal(prepared.record.source.ownership.root, null);
  assert.equal(prepared.writes.filter(write => write.kind === 'om-neighbors').length, 1);
  assert.equal(prepared.writes.filter(write => write.kind === 'writer-index').length, 2);
  assert.ok(prepared.writes.every(write => write.expected === 0));
  assert.equal(prepared.reference.hash, hashJson(prepared.record));
  const initial = await f.store.snapshot(join(f.directory, 'before-neighbors'));
  let nextBranch = 0;
  function branch(snapshot: string, action: (store: Store, database: string) => void) {
    const database = join(f.directory, `neighbors-${nextBranch++}.sqlite`); copyFileSync(snapshot, database);
    const store = new Store(database); try { action(store, database); } finally { store.close(); }
  }

  await t.test('a second Store changing a guarded source rejects packets and every pending index together', () => {
    branch(initial.path, (store, database) => {
      const pending = ok(prepareNeighbors(store, f.request)), rival = new Store(database);
      try { const graph = rival.get(f.graph.id)!; rival.write({ id: graph.id, kind: graph.kind, expected: graph.revision, value: graph.value }); }
      finally { rival.close(); }
      const afterRival = persistedHeads(store);
      denied(writeGuarded(store, { unit: 'F4-test', target: pending.reference.id, writes: pending.writes, guards: pending.guards }), 'input_stale');
      assert.deepEqual(persistedHeads(store), afterRival);
      assert.equal(store.get(pending.reference.id), null); assert.deepEqual(store.list('writer-index'), []);
    });
  });
  await t.test('a competing first index defeats the entire pending packet transaction', () => {
    branch(initial.path, (store, database) => {
      const pending = ok(prepareNeighbors(store, f.request)), rival = new Store(database);
      try { rival.writeMany(pending.writes.filter(write => write.kind === 'writer-index') as Write[], [...pending.guards]); }
      finally { rival.close(); }
      const afterRival = persistedHeads(store);
      denied(writeGuarded(store, { unit: 'F4-test', target: pending.reference.id, writes: pending.writes, guards: pending.guards }), 'revision_conflict');
      assert.deepEqual(persistedHeads(store), afterRival); assert.equal(store.get(pending.reference.id), null);
    });
  });

  const saved = ok(writeNeighbors(f.store, f.request)), savedRequest = { project: 'garden', neighbors: reference(saved) };
  assert.deepEqual(reference(saved), prepared.reference); assert.deepEqual(saved.value, prepared.record);
  assert.equal(f.store.get('execution-root:garden'), null);
  for (const ref of Object.values(saved.value.source.ownership.indexes)) assert.equal(f.store.get(ref.id, ref.revision)!.hash, ref.hash);
  const heads = persistedHeads(f.store), again = ok(prepareNeighbors(f.store, f.request));
  assert.deepEqual(again.writes, []); assert.deepEqual(again.existing, saved);
  assert.ok(again.guards.some(guard => canonical(guard) === canonical(reference(saved))));
  assert.deepEqual(ok(writeNeighbors(f.store, f.request)), saved); assert.deepEqual(persistedHeads(f.store), heads);
  assert.deepEqual(ok(readNeighbors(f.store, savedRequest)), saved);
  const complete = await f.store.snapshot(join(f.directory, 'with-neighbors'));

  await t.test('the candidate and compiler snapshot use the same pure packet function', () => {
    const candidate = f.candidate.value, request = candidate.request.frame as FrameRequest;
    const works = ok(readFrame(f.store, request));
    const operations = ok(readFrame(f.store, { project: 'garden', level: 2, graph: request.graph, horizon: request.horizon,
      layer: works.upperRef, frame: request.upper!.frame, upper: null }));
    const fills = operations.accepted!.frame!.value.fills;
    const options: NeighborSources = clone({ identity: [...new Set([...candidate.fills, ...fills]
      .filter(fill => fill.source === 'identity').map(fill => fill.node))], receipts: {}, frames: {
      works: { obligations: works.result.obligations, fills: candidate.fills },
      operations: { obligations: operations.result.obligations, fills } } }) as unknown as NeighborSources;
    const graphSnapshot = clone(candidate.graph) as Graph;
    assert.deepEqual(ok(buildPackets(candidate.graph as Graph, options)), saved.value.packets);
    assert.deepEqual(ok(buildPackets(graphSnapshot, clone(options))), saved.value.packets);
    const compiled = deriveTasks('garden', hashJson(graphSnapshot), graphSnapshot, () => { throw new Error('No outside input in this native candidate'); },
      { version: 2, owner: () => null });
    for (const task of compiled.tasks) for (const input of task.inputs) assert.ok(saved.value.packets
      .find(packet => packet.work === task.node)!.neighbors.some(row => row.connector === input.connector && row.direction === 'reads' && row.artifact === input.artifact));
  });

  await t.test('new Store history survives source head movement while current preparation refuses stale admission', () => {
    branch(complete.path, (store, database) => {
      const graph = store.get(f.graph.id)!; store.write({ id: graph.id, kind: graph.kind, expected: graph.revision, value: graph.value });
      const afterHead = persistedHeads(store); store.close();
      const restarted = new Store(database);
      try {
        assert.deepEqual(ok(readNeighbors(restarted, savedRequest)), saved);
        denied(prepareNeighbors(restarted, f.request), 'input_stale');
        denied(writeNeighbors(restarted, f.request), 'input_stale');
        assert.deepEqual(persistedHeads(restarted), afterHead);
      } finally { restarted.close(); }
    });
  });

  await t.test('full body and membership are rederived even after forged hashes are recomputed', () => {
    const variants: [string, (value: NeighborCollection) => void][] = [
      ['neighbor title', value => { value.packets[0]!.neighbors[0]!.neighbor.work.title = 'forged title'; }],
      ['status imitation', value => { Object.assign(value, { status: 'accepted' }); value.packets = []; }],
      ['lost packet', value => { value.packets.pop(); }], ['empty set', value => { value.packets = []; }],
      ['duplicate packet', value => { value.packets.push(clone(value.packets[0]!)); }],
      ['order', value => { value.packets.reverse(); }],
    ];
    for (const [label, mutate] of variants) {
      const database = join(f.directory, `forgery-${nextBranch++}.sqlite`), store = new Store(database);
      try {
        for (const row of f.store.list().filter(row => row.kind !== 'om-neighbors')) for (const revision of f.store.history(row.id))
          store.write({ id: revision.id, kind: revision.kind, expected: revision.revision - 1, value: revision.value });
        const value = clone(saved.value) as NeighborCollection; mutate(value);
        for (const packet of value.packets) packet.hash = hashJson(packet.neighbors);
        const forged = store.write({ id: saved.id, kind: saved.kind, expected: 0, value });
        assert.notEqual(forged.hash, saved.hash, label);
        denied(readNeighbors(store, { project: 'garden', neighbors: reference(forged) }), 'neighbor_record_forged');
      } finally { store.close(); }
    }
  });

  await t.test('foreign addresses, missing sources, malformed contracts and forged exact references never stand for a collection', () => {
    denied(readNeighbors(f.store, { project: 'garden', neighbors: f.graph }), 'record_foreign');
    denied(readNeighbors(f.store, { ...savedRequest, neighbors: { ...savedRequest.neighbors, hash: '0'.repeat(64) } }), 'record_forged');
    denied(readNeighbors(f.store, { project: 'foreign', neighbors: reference(saved) }), 'record_foreign');
    denied(readNeighbors(f.store, { project: 'garden', neighbors: { id: `om-neighbors:garden:${hashJson('missing')}`, revision: 1, hash: hashJson('missing') } }), 'record_missing');
    branch(complete.path, store => {
      const copy = store.write({ id: `om-neighbors:garden:${hashJson('copied-under-other-id')}`, kind: saved.kind, expected: 0, value: saved.value });
      denied(readNeighbors(store, { project: 'garden', neighbors: reference(copy) }), 'neighbor_record_forged');
      const contract = store.write({ id: `om-neighbors:garden:${hashJson('wrong-contract')}`, kind: saved.kind, expected: 0,
        value: { ...saved.value, contract: 'unaccepted/v0' } });
      denied(readNeighbors(store, { project: 'garden', neighbors: reference(contract) }), 'neighbor_record_forged');
      const noBasis = clone(saved.value) as unknown as { source: { ownership?: unknown } }; delete noBasis.source.ownership;
      const missing = store.write({ id: `om-neighbors:garden:${hashJson('missing-basis')}`, kind: saved.kind, expected: 0, value: noBasis });
      denied(readNeighbors(store, { project: 'garden', neighbors: reference(missing) }), 'delivery_basis_unproven');
      const source = clone(saved.value) as NeighborCollection; source.source.candidate = { ...source.source.candidate, id: `om-candidate:other:${hashJson('foreign')}` };
      const foreign = store.write({ id: `om-neighbors:garden:${hashJson('foreign-source')}`, kind: saved.kind, expected: 0, value: source });
      denied(readNeighbors(store, { project: 'garden', neighbors: reference(foreign) }), 'record_foreign');
    });
  });

  await t.test('wrapper arguments are validated before the first storage read and read failures are not rewritten', () => {
    const sentinel = new Error('injected Store read failure');
    const blocked = new Proxy(f.store, { get(target, key) {
      if (key === 'get') return () => { throw sentinel; };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const invalid = (action: () => unknown) => assert.throws(action, (error: unknown) => error instanceof EngineError && error.code === 'neighbor_request_invalid');
    for (const operation of [prepareNeighbors, writeNeighbors]) {
      invalid(() => operation(null as unknown as Store, f.request));
      for (const request of [undefined, null, false, 0, [], {}, { ...f.request, project: '' }, { ...f.request, project: '../garden' },
        { ...f.request, candidate: undefined }, { ...f.request, candidate: null }, { ...f.request, candidate: { ...f.request.candidate, revision: 0 } }])
        invalid(() => operation(blocked, request as CandidateReadRequest));
      assert.throws(() => operation(blocked, f.request), error => error === sentinel);
    }
    invalid(() => readNeighbors(null as unknown as Store, savedRequest));
    for (const request of [undefined, null, false, 0, [], {}, { ...savedRequest, project: '' }, { ...savedRequest, project: '../garden' },
      { ...savedRequest, neighbors: undefined }, { ...savedRequest, neighbors: null }, { ...savedRequest, neighbors: { ...savedRequest.neighbors, hash: 'wrong' } }])
      invalid(() => readNeighbors(blocked, request as NeighborReadRequest));
    assert.throws(() => readNeighbors(blocked, savedRequest), error => error === sentinel);
    assert.deepEqual(persistedHeads(f.store), heads);
  });
});

test('local L3 without upper bindings uses the shared physical operation and block', () => {
  const graph = localOperationGraph(), options = sources(graph);
  const writes = ok(neighborsOf(graph, producer, options)), reads = ok(neighborsOf(graph, consumer, options));
  assert.equal(writes.neighbors.length, 1); assert.equal(reads.neighbors.length, 1);
  for (const packet of [writes, reads]) {
    const row = packet.neighbors[0]!;
    assert.equal(row.neighbor.operation.id, producerOp); assert.equal(row.neighbor.block.id, producerBlock);
    assert.equal(row.delivery, 'in-plan');
  }
  assert.equal(writes.neighbors[0]!.neighbor.work.id, consumer);
  assert.equal(reads.neighbors[0]!.neighbor.work.id, producer);
});

test('local L2 retains every proved operation address and takes its block rather than the work placement', () => {
  const { graph, extraOp } = severalAddresses();
  graph.connectors[0]!.bindings = graph.connectors[0]!.bindings.filter(flow => flow.level !== 1);
  node(graph, consumerOp).parent = producerBlock; node(graph, extraOp).parent = producerBlock;
  node(graph, consumer).parent = 'garden-refusal-operation';
  graph.edges!.push({ id: 'displaced-work-realizes-consumer', relation: 'realizes', source: consumer,
    target: consumerOp, condition: 'Preserves the accepted local operation' });
  const options = sources(graph), packet = ok(neighborsOf(graph, producer, options));
  assert.equal(packet.neighbors.length, 2);
  assert.deepEqual(packet.neighbors.map(row => [row.neighbor.operation.id, row.neighbor.block.id]).sort(),
    [[consumerOp, producerBlock], [extraOp, producerBlock]].sort());
  assert.ok(packet.neighbors.every(row => row.neighbor.operation.id !== node(graph, consumer).parent));
  const missing = clone(options); missing.frames.works.fills = [];
  denied(neighborsOf(graph, producer, missing), 'neighbor_chain_ambiguous');
});

test('locality checks every consumer and never repairs an existing unmatched or missing intermediate upper binding', () => {
  const nonlocal = localOperationGraph();
  const offside = clone(node(nonlocal, consumer)); offside.id = 'garden-offside-work'; offside.parent = consumerOp;
  offside.code = [{ path: 'offside.ts', access: 'write', status: 'planned' }]; offside.tests = [];
  nonlocal.nodes.push(offside);
  binding(nonlocal, 3).consumers.push({ node: offside.id, port: 'in', codeRef: clone(offside.code[0]!) });
  denied(neighborsOf(nonlocal, consumer, sources(nonlocal)), 'neighbor_chain_broken');

  const l2 = fixture().graph; l2.connectors[0]!.bindings = l2.connectors[0]!.bindings.filter(flow => flow.level !== 1);
  node(l2, consumerOp).parent = producerBlock;
  const foreignOperation = { ...clone(node(l2, consumerOp)), id: 'garden-outside-local-operation', parent: consumerBlock };
  l2.nodes.push(foreignOperation); binding(l2, 2).consumers.push({ node: foreignOperation.id, port: 'in' });
  denied(neighborsOf(l2, producer, sources(l2)), 'neighbor_chain_broken');

  const unmatched = fixture().graph; node(unmatched, consumer).parent = producerOp;
  denied(neighborsOf(unmatched, producer, sources(unmatched)), 'neighbor_chain_broken');
  const missingIntermediate = localOperationGraph();
  missingIntermediate.connectors[0]!.bindings.unshift(clone(binding(fixture().graph, 1)));
  denied(neighborsOf(missingIntermediate, producer, sources(missingIntermediate)), 'neighbor_chain_broken');
});

test('self data pairs disappear while every other consumer port, connector and upper address remains', () => {
  const { graph, extraOp, extraBlock } = severalAddresses();
  const producers = [producerBlock, producerOp, producer];
  for (const id of producers) node(graph, id).ports.push({ id: 'self-in', direction: 'in', contract: 'garden-contract' });
  for (const id of [consumerBlock, extraBlock, consumerOp, extraOp, consumer])
    node(graph, id).ports.push({ id: 'in-alt', direction: 'in', contract: 'garden-contract' });
  for (const level of [1, 2, 3] as const) {
    const flow = binding(graph, level);
    flow.consumers.push(...flow.consumers.map(end => ({ ...clone(end), port: 'in-alt' })));
    flow.consumers.push({ node: producers[level - 1]!, port: 'self-in',
      ...(level === 3 ? { codeRef: clone(node(graph, producer).code[0]!) } : {}) });
  }
  const second = clone(graph.connectors[0]!); second.id = 'garden-second-flow'; second.returnsTo = consumerOp;
  graph.connectors.push(second);
  const packet = ok(neighborsOf(graph, producer, sources(graph)));
  assert.equal(packet.neighbors.length, 16);
  assert.ok(packet.neighbors.every(row => row.direction === 'writes' && row.neighbor.work.id === consumer));
  for (const connector of [connectorId, second.id]) for (const port of ['in', 'in-alt']) {
    const rows = packet.neighbors.filter(row => row.connector === connector && row.neighbor.port === port);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map(row => [row.neighbor.operation.id, row.neighbor.block.id]).sort(),
      [[consumerOp, consumerBlock], [consumerOp, extraBlock], [extraOp, consumerBlock], [extraOp, extraBlock]].sort());
  }
  const reader = ok(neighborsOf(graph, consumer, sources(graph)));
  assert.equal(reader.neighbors.length, 4);
  assert.deepEqual(reader.neighbors.map(row => [row.connector, row.port]).sort(),
    [[connectorId, 'in'], [connectorId, 'in-alt'], [second.id, 'in'], [second.id, 'in-alt']].sort());
  const isolated = clone(graph);
  for (const connector of isolated.connectors) for (const flow of connector.bindings)
    flow.consumers = flow.consumers.filter(end => end.node === flow.producer.node);
  assert.deepEqual(ok(neighborsOf(isolated, producer, sources(isolated))).neighbors, []);
});

test('requires neighbors use the physical chain and the predecessor outcome with exact available basis', () => {
  const { graph } = fixture();
  node(graph, producer).parent = consumerOp;
  graph.edges!.push(
    { id: 'work-realizes-data-role', source: producer, target: producerOp, relation: 'realizes', condition: 'Implements the data producer' },
    { id: 'required-predecessor', source: consumer, target: producer, relation: 'requires', condition: 'Predecessor outcome is required' },
  );
  const options = sources(graph), receipt = { id: 'receipt:required-outcome', revision: 4, hash: hashJson('required outcome') };
  options.receipts[canonical(['required-predecessor', producer])] = receipt;
  const part = (id: string) => { const value = node(graph, id); return { id, title: value.title, outcome: value.outcome }; };
  const expected = { control: 'required-predecessor', direction: 'requires', artifact: 'garden-data',
    contract: { id: 'garden-contract', hash: hashJson({ type: 'string' }), external: false },
    neighbor: { work: part(producer), operation: part(consumerOp), block: part(consumerBlock) }, delivery: 'in-plan' };
  const active = ok(neighborsOf(graph, consumer, options)).neighbors.find(row => row.control === 'required-predecessor');
  assert.deepEqual(active, expected);
  assert.deepEqual(ok(neighborsOf(graph, consumer, sources(graph))).neighbors.find(row => row.control === 'required-predecessor'), expected);
  const data = ok(neighborsOf(graph, consumer, options)).neighbors.find(row => row.connector === connectorId)!;
  assert.equal(data.neighbor.operation.id, producerOp);
  assert.equal(Object.hasOwn(active!, 'basis'), false);
  graph.horizon = [consumer];
  assert.deepEqual(ok(neighborsOf(graph, consumer, options)).neighbors.find(row => row.control === 'required-predecessor'),
    { ...expected, delivery: 'available', basis: receipt });
  const missing = clone(options); delete missing.receipts[canonical(['required-predecessor', producer])];
  const absent = ok(neighborsOf(graph, consumer, missing)).neighbors.find(row => row.control === 'required-predecessor')!;
  assert.equal(absent.delivery, 'undelivered'); assert.equal(Object.hasOwn(absent, 'basis'), false);
  const controlOnly = clone(graph); controlOnly.connectors = [];
  const controlSources = sources(controlOnly); controlOnly.artifacts = controlOnly.artifacts.filter(artifact => artifact.id !== 'garden-data');
  denied(neighborsOf(controlOnly, consumer, controlSources), 'neighbor_contract_missing');
});

test('ownership neighbors retain exact path and condition with distinct receive and send delivery forms', () => {
  const { graph } = fixture(), transfer = { id: 'shared-writer-transfer', from: producer, to: consumer,
    path: 'src/shared-state.ts', condition: 'producer_committed' as const };
  for (const id of [producer, consumer]) node(graph, id).code.push({ path: transfer.path, access: 'write', status: 'planned' });
  graph.transfers!.push(transfer);
  const options = sources(graph), writer = { id: 'confirmed-writer:shared-state', revision: 3, hash: hashJson('accepted previous writer') };
  options.receipts[canonical([transfer.id, producer])] = writer;
  const part = (id: string) => { const value = node(graph, id); return { id, title: value.title, outcome: value.outcome }; };
  const received = { control: transfer.id, direction: 'receives', path: transfer.path, condition: transfer.condition,
    neighbor: { work: part(producer), operation: part(producerOp), block: part(producerBlock) }, delivery: 'in-plan' };
  const sent = { control: transfer.id, direction: 'sends', path: transfer.path, condition: transfer.condition,
    neighbor: { work: part(consumer), operation: part(consumerOp), block: part(consumerBlock) }, delivery: 'in-plan' };
  assert.deepEqual(ok(neighborsOf(graph, consumer, options)).neighbors.find(row => row.control === transfer.id), received);
  assert.deepEqual(ok(neighborsOf(graph, producer, options)).neighbors.find(row => row.control === transfer.id), sent);
  assert.deepEqual(ok(neighborsOf(graph, consumer, sources(graph))).neighbors.find(row => row.control === transfer.id), received);
  graph.horizon = [consumer];
  assert.deepEqual(ok(neighborsOf(graph, consumer, options)).neighbors.find(row => row.control === transfer.id),
    { ...received, delivery: 'available', basis: writer });
  const absent = clone(options); absent.receipts = {};
  assert.deepEqual(ok(neighborsOf(graph, consumer, absent)).neighbors.find(row => row.control === transfer.id),
    { ...received, delivery: 'undelivered' });
  graph.horizon = [producer];
  const anchor = workAnchorId(connectorId, flowKey(binding(graph, 2)), binding(graph, 3).producer);
  const wakeTest = node(graph, producer).tests[0]!;
  binding(graph, 3).anchor = anchor; graph.connectors[0]!.wakeTest = wakeTest;
  graph.anchors.push({ id: anchor, owner: producer, outcome: 'garden-data', test: wakeTest });
  assert.deepEqual(ok(neighborsOf(graph, producer, absent)).neighbors.find(row => row.control === transfer.id),
    { ...sent, delivery: 'sleeping' });
});

test('the data self-pair exception cannot silently erase requires or ownership dependencies', () => {
  const { graph } = fixture(); graph.connectors = [];
  graph.edges!.push({ id: 'self-required', relation: 'requires', source: producer, target: producer, condition: 'Self requirement' });
  const required = ok(neighborsOf(graph, producer, sources(graph))).neighbors;
  assert.equal(required.length, 1); assert.equal(required[0]!.control, 'self-required');
  assert.equal(required[0]!.direction, 'requires'); assert.equal(required[0]!.neighbor.work.id, producer);
  graph.edges = graph.edges!.filter(edge => edge.id !== 'self-required');
  graph.transfers!.push({ id: 'self-transfer', from: producer, to: producer, path: node(graph, producer).code[0]!.path,
    condition: 'producer_committed' });
  const transferred = ok(neighborsOf(graph, producer, sources(graph))).neighbors;
  assert.equal(transferred.length, 2); assert.ok(transferred.every(row => row.control === 'self-transfer'));
  assert.deepEqual(transferred.map(row => row.direction).sort(), ['receives', 'sends']);
});

/** Controls are proposed only for the future consumer; the producer's real committed signature stays exact. */
async function persistedAvailableControls(t: TestContext) {
  const f = await createOmFixture(t), { store } = f;
  const input = ok(writeOmInput(store, { project: 'garden', expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> }));
  const receipt = f.receipts['garden-data']!, path = node(f.graph, producer).code.find(code => code.access === 'write')!.path;
  const horizon = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(f.graphRevision),
    refinement: reference(store.get('phase:garden:L2')!), available: { [producerBlock]: { 'garden-data': reference(receipt) } },
    choice: { choiceVersion: 'neighbors-controls', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame: FrameRequest = { project: 'garden', level: 3, graph: reference(f.graphRevision), horizon: reference(horizon.gate),
    layer: reference(f.layers[3]), frame: null, upper: { horizon: reference(horizon.gate), frame: null } };
  const current = ok(prepareFrame(store, frame));
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: null }, level: 3, worksContract: 'works-frame/v1',
    source: 'decision', status: 'proposed', nodes: [], fills: [], localConnectors: [], artifacts: [], contracts: [], joins: [],
    tests: [], edges: [{ id: 'neighbors-ready-result', relation: 'requires', source: consumer, target: producer,
      condition: 'Reuse the accepted producer outcome' }], journeys: [], packets: [],
    transfers: [{ id: 'neighbors-ready-writer', from: producer, to: consumer, path, condition: 'producer_committed' }],
    anchors: [], removes: [], replaces: [], redefines: [] };
  const replacement = clone(node(f.graph, consumer)); replacement.code.push(clone(node(f.graph, producer).code[0]!));
  const outside = clone(node(f.graph, 'w-garden-later-operation'));
  outside.code = [{ path: 'future/garden-later.ts', access: 'write', status: 'planned', symbol: 'consume' }];
  for (const item of [replacement, outside]) {
    proposal.nodes.push(item); proposal.removes.push(item.id);
    for (const fill of current.result.fills.filter(fill => fill.node === item.id)) {
      proposal.fills.push({ obligation: fill.obligation, node: item.id,
        ...(fill.port === undefined ? {} : { port: fill.port, codeRef: clone(item.code[0]!) }) });
      proposal.replaces.push({ obligation: fill.obligation, base: { node: item.id, graph: frame.graph },
        with: { node: item.id, port: fill.port ?? null }, basis: 'Preserve every accepted endpoint while declaring the future consumer write scope' });
    }
  }
  const proposed = reference(store.write({ id: 'om-proposal:garden:neighbors-controls', kind: 'layer-proposal', expected: 0, value: proposal }));
  const works: ProposalRequest = { frame: current.request as FrameRequest, proposals: [proposed] };
  const gaps = ok(writeGaps(store, { project: 'garden', input: reference(input), graph: frame.graph, horizon: frame.horizon,
    operations: { frame: { ...frame, level: 2, layer: reference(f.layers[2]), upper: null }, proposals: [] }, works }));
  const gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project: 'garden', previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const obligations = ok(writeOmObligations(store, { project: 'garden', gaps: gapRead, lines: reference(lines), assignments: [] }));
  const candidate = ok(writeWorksFrame(store, { ...works, works: { contract: 'works-frame/v1',
    producer: reference(obligations.producer), ledger: reference(obligations.record), bindings: [] } }));
  assert.equal(candidate.state, 'candidate'); if (candidate.state !== 'candidate') throw new Error('Missing controls candidate');
  assert.deepEqual(candidate.record.value.graph.horizon, [consumer]);
  assert.equal(nodeSignature(candidate.record.value.graph as Graph, node(candidate.record.value.graph as Graph, producer)), receipt.value.signature);
  return { f, path, receipt, candidate: candidate.record, request: { project: 'garden', candidate: reference(candidate.record) } };
}

test('saved available requires and ownership controls use the same exact F3 assembly through races and restart', async t => {
  const c = await persistedAvailableControls(t), { f } = c;
  const before = persistedHeads(f.store), delivery = ok(prepareDeliveries(f.store, c.request));
  const prepared = ok(prepareNeighbors(f.store, c.request));
  assert.deepEqual(persistedHeads(f.store), before);
  assert.deepEqual(prepared.record.source, delivery.request);
  assert.deepEqual(delivery.findings, []);
  const writer = delivery.writers[c.path]!;
  assert.ok(writer); assert.deepEqual(writer, c.receipt.value.run);
  assert.deepEqual(delivery.receipts[canonical(['neighbors-ready-result', producer])], reference(c.receipt));
  assert.deepEqual(delivery.receipts[canonical(['neighbors-ready-writer', producer])], writer);
  const packet = prepared.record.packets.find(packet => packet.work === consumer)!;
  const requires = packet.neighbors.find(row => row.control === 'neighbors-ready-result')!;
  const receives = packet.neighbors.find(row => row.control === 'neighbors-ready-writer')!;
  assert.ok(requires && receives);
  assert.equal(requires.direction, 'requires'); assert.equal(requires.delivery, 'available');
  assert.deepEqual(requires.basis, reference(c.receipt)); assert.equal(requires.artifact, 'garden-data');
  assert.ok(receives.direction === 'receives'); assert.equal(receives.delivery, 'available');
  assert.deepEqual(receives.basis, writer); assert.equal(receives.path, c.path); assert.equal(receives.condition, 'producer_committed');
  for (const row of [requires, receives]) {
    assert.equal(row.neighbor.work.id, producer); assert.equal(row.neighbor.operation.id, producerOp); assert.equal(row.neighbor.block.id, producerBlock);
    for (const field of ['connector', 'flow', 'port', 'codeRef', 'returnsTo', 'anchor', 'wakeTest']) assert.equal(Object.hasOwn(row, field), false);
  }
  for (const field of ['artifact', 'contract']) assert.equal(Object.hasOwn(receives, field), false);
  for (const ref of [writer, reference(c.receipt), delivery.request.ownership.root!, ...Object.values(delivery.request.ownership.indexes)])
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)), `Missing exact F3 guard ${ref.id}`);
  assert.deepEqual(prepared.writes.filter(write => write.kind === 'writer-index'), delivery.writes);
  const initial = await f.store.snapshot(join(f.root, 'neighbors-control-initial'));

  await t.test('an existing writer-index moving in a second Store rejects the complete neighbor write', () => {
    const database = join(f.root, 'neighbors-control-index-race.sqlite'); copyFileSync(initial.path, database);
    const store = new Store(database), rival = new Store(database);
    try {
      const pending = ok(prepareNeighbors(store, c.request)), ref = pending.record.source.ownership.indexes[c.path]!;
      const index = rival.get(ref.id)!; rival.write({ id: index.id, kind: index.kind, expected: index.revision, value: index.value });
      const after = persistedHeads(store);
      denied(writeGuarded(store, { unit: 'F4-test', target: pending.reference.id, writes: pending.writes, guards: pending.guards }), 'input_stale');
      assert.deepEqual(persistedHeads(store), after); assert.equal(store.get(pending.reference.id), null);
    } finally { rival.close(); store.close(); }
  });

  const written = ok(writeNeighbors(f.store, c.request)), request = { project: 'garden', neighbors: reference(written) };
  assert.deepEqual(written.value, prepared.record);
  const historical = ok(readDeliveries(f.store, written.value.source));
  assert.deepEqual(historical.receipts, delivery.receipts); assert.deepEqual(historical.writers, delivery.writers);
  const savedHeads = persistedHeads(f.store);
  assert.deepEqual(ok(writeNeighbors(f.store, c.request)), written); assert.deepEqual(persistedHeads(f.store), savedHeads);
  const complete = await f.store.snapshot(join(f.root, 'neighbors-control-complete'));

  await t.test('historical controls retain the exact writer and receipt after their current heads change', () => {
    const database = join(f.root, 'neighbors-control-history.sqlite'); copyFileSync(complete.path, database);
    const store = new Store(database);
    const run = store.get(writer.id)!;
    store.write({ id: run.id, kind: run.kind, expected: run.revision, value: { ...(run.value as object), checks: [] } });
    const receiptHead = store.get(c.receipt.id)!;
    store.write({ id: receiptHead.id, kind: receiptHead.kind, expected: receiptHead.revision, value: receiptHead.value });
    store.close();
    const restarted = new Store(database), latest = Owners.prototype.latest;
    try {
      const currentOwner = new Owners(restarted, 'garden', f.repository);
      assert.throws(() => currentOwner.latest(c.path), (error: unknown) => error instanceof EngineError && error.code === 'checks_not_passed');
      Owners.prototype.latest = () => { throw new Error('Historical neighbor reading must not select the current writer'); };
      const beforeRead = persistedHeads(restarted);
      assert.deepEqual(ok(readNeighbors(restarted, request)), written);
      const restored = ok(readDeliveries(restarted, written.value.source));
      assert.deepEqual(restored.receipts, delivery.receipts); assert.deepEqual(restored.writers, delivery.writers);
      assert.deepEqual(persistedHeads(restarted), beforeRead);
      assert.equal(prepareNeighbors(restarted, c.request).ok, false);
    } finally { Owners.prototype.latest = latest; restarted.close(); }
  });
});

for (const crossed of [false, true]) test(`saved flow correspondence ${crossed ? 'keeps each realized operation and block on its own flow' : 'does not multiply a shared consumer endpoint across producer flows'}`, t => {
  const graph = enrichedGraph(exampleGraph(), 'garden'), connector = graph.connectors.find(item => item.id === connectorId)!;
  for (const flow of [...connector.bindings]) {
    const producingNode = node(graph, flow.producer.node);
    producingNode.ports.push({ ...clone(producingNode.ports.find(port => port.id === flow.producer.port)!), id: 'out-alt' });
    const alternate = clone(flow); alternate.producer.port = 'out-alt'; connector.bindings.push(alternate);
  }
  const secondOperation = 'garden-second-consume-operation', secondBlock = 'garden-second-consume-block';
  if (crossed) {
    graph.nodes.push({ ...clone(node(graph, consumerBlock)), id: secondBlock, tests: [] },
      { ...clone(node(graph, consumerOp)), id: secondOperation, parent: secondBlock, tests: [] });
    connector.bindings.find(flow => flow.level === 1 && flow.producer.port === 'out-alt')!.consumers[0]!.node = secondBlock;
    connector.bindings.find(flow => flow.level === 2 && flow.producer.port === 'out-alt')!.consumers[0]!.node = secondOperation;
    graph.edges!.push({ id: 'consumer-realizes-second', relation: 'realizes', source: consumer, target: secondOperation,
      condition: 'This work serves the second exact flow as well' });
  }
  const f = persistedCandidate(t, graph), prepared = ok(prepareNeighbors(f.store, f.request));
  const outgoing = (record: Sealed<NeighborCollection>) => record.packets.find(packet => packet.work === producer)!.neighbors;
  const incoming = (record: Sealed<NeighborCollection>) => record.packets.find(packet => packet.work === consumer)!.neighbors;
  const addresses = (rows: readonly NeighborCollection['packets'][number]['neighbors'][number][]) => rows.map(row => ({
    direction: row.direction, port: row.port, neighborPort: row.neighbor.port, work: row.neighbor.work.id,
    operation: row.neighbor.operation.id, block: row.neighbor.block.id,
  })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const expectedOutgoing = ['out', 'out-alt'].map(port => ({ direction: 'writes', port, neighborPort: 'in', work: consumer,
    operation: crossed && port === 'out-alt' ? secondOperation : consumerOp,
    block: crossed && port === 'out-alt' ? secondBlock : consumerBlock })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const expectedIncoming = ['out', 'out-alt'].map(neighborPort => ({ direction: 'reads', port: 'in', neighborPort,
    work: producer, operation: producerOp, block: producerBlock })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  function check(record: Sealed<NeighborCollection>): void {
    assert.equal(outgoing(record).length, 2); assert.deepEqual(addresses(outgoing(record)), expectedOutgoing);
    assert.equal(incoming(record).length, 2); assert.deepEqual(addresses(incoming(record)), expectedIncoming);
  }
  check(prepared.record);
  const written = ok(writeNeighbors(f.store, f.request)), request = { project: 'garden', neighbors: reference(written) };
  assert.deepEqual(written.value, prepared.record); check(written.value);
  assert.deepEqual(ok(readNeighbors(f.store, request)), written);
  f.store.close();
  const restarted = new Store(f.database);
  try {
    const restored = ok(readNeighbors(restarted, request)); assert.deepEqual(restored, written); check(restored.value);
    const beforeRepeat = persistedHeads(restarted);
    assert.deepEqual(ok(writeNeighbors(restarted, f.request)), written); assert.deepEqual(persistedHeads(restarted), beforeRepeat);
  } finally { restarted.close(); }
});

function checkedFlowSource(options: NeighborSources): FrameFlowSource {
  return { obligations: clone(options.frames.works.obligations),
    fills: options.frames.works.fills?.map(fill => ({ ...clone(fill), source: fill.source === 'identity' ? 'identity' : 'accepted' })) ?? null,
    worksContract: 'works-frame/v1' };
}

test('readFrameFlow validates public arguments and refuses foreign exact bindings and obligations', () => {
  const { graph, options } = fixture(), source = checkedFlowSource(options), lower = clone(binding(graph, 3));
  const args: Parameters<typeof readFrameFlow> = [graph, graph, source, connectorId, lower];
  const invalid = (values: unknown[]) => assert.throws(() => readFrameFlow(...values as Parameters<typeof readFrameFlow>),
    (error: unknown) => error instanceof EngineError && error.code === 'frame_request_invalid');
  for (let count = 0; count < args.length; count++) invalid(args.slice(0, count));
  for (const index of [0, 1, 2, 3, 4]) for (const value of [undefined, null, false, 0, [], {}]) {
    const values = [...args]; values[index] = value as never; invalid(values);
  }
  for (const changed of [{ ...source, obligations: undefined }, { ...source, obligations: [null] }, { ...source, fills: undefined },
    { ...source, fills: [{}] }, { ...source, worksContract: undefined }, { ...source, worksContract: 'unknown' }])
    invalid([graph, graph, changed, connectorId, lower]);
  for (const changed of [{ ...lower, level: 1 }, { ...lower, consumers: [] }, { ...lower, anchor: undefined },
    { ...lower, producer: { node: producer } }]) invalid([graph, graph, source, connectorId, changed]);

  const expected = ok(readFrameFlow(...args));
  assert.deepEqual(expected.upper, binding(graph, 2));
  denied(readFrameFlow(graph, graph, source, 'missing-connector', lower), 'frame_record_invalid');
  for (const change of [(value: typeof lower) => { value.consumers[0]!.port = 'different-port'; },
    (value: typeof lower) => { value.producer.node = 'other-producer'; },
    (value: typeof lower) => { value.consumers[0]!.codeRef = { ...value.consumers[0]!.codeRef!, symbol: 'forged-code' }; }]) {
    const changed = clone(lower); change(changed);
    denied(readFrameFlow(graph, graph, source, connectorId, changed), 'frame_record_invalid');
  }
  const connection = source.obligations.find(item => item.kind === 'connection-end' && item.role === 'consumer')!;
  for (const change of [(value: FrameFlowSource) => { value.obligations = value.obligations.filter(item => item.id !== connection.id); },
    (value: FrameFlowSource) => { value.obligations.push(clone(connection)); },
    (value: FrameFlowSource) => { value.obligations.find(item => item.id === connection.id)!.id = hashJson('forged-obligation'); },
    (value: FrameFlowSource) => { value.obligations.find(item => item.id === connection.id)!.flow = hashJson('foreign-upper-flow'); },
    (value: FrameFlowSource) => { value.obligations.find(item => item.id === connection.id)!.upper.node = producerOp; }]) {
    const changed = clone(source); change(changed);
    denied(readFrameFlow(graph, graph, changed, connectorId, lower), 'frame_record_invalid');
  }
});

test('flow-specific recorded code references stay distinct for the same consumer port in two producer flows', () => {
  const { graph } = fixture(), connector = graph.connectors.find(item => item.id === connectorId)!;
  for (const flow of [...connector.bindings]) {
    const producingNode = node(graph, flow.producer.node);
    producingNode.ports.push({ ...clone(producingNode.ports.find(port => port.id === flow.producer.port)!), id: 'out-alt' });
    const alternate = clone(flow); alternate.producer.port = 'out-alt'; connector.bindings.push(alternate);
  }
  const alternateCode = { ...clone(node(graph, consumer).code[0]!), path: 'consumer/alternate.ts', symbol: 'consumeAlternate' };
  node(graph, consumer).code.push(alternateCode);
  const alternateLower = connector.bindings.find(flow => flow.level === 3 && flow.producer.port === 'out-alt')!;
  alternateLower.consumers[0]!.codeRef = clone(alternateCode);
  const alternateUpper = connector.bindings.find(flow => flow.level === 2 && flow.producer.port === 'out-alt')!;
  const options = sources(graph), alternateKey = flowKey(alternateUpper);
  // Mapping is explicitly recorded per upper obligation; matching a consumer port globally would erase this difference.
  for (const fill of options.frames.works.fills!) {
    const obligation = options.frames.works.obligations.find(item => item.id === fill.obligation)!;
    if (fill.node === consumer && obligation.kind === 'connection-end' && obligation.flow === alternateKey) fill.codeRef = clone(alternateCode);
  }
  const source = checkedFlowSource(options), before = canonical({ graph, source });
  const expectedCode = (port: string) => port === 'out-alt' ? alternateCode : node(graph, consumer).code[0]!;
  for (const lower of connector.bindings.filter(flow => flow.level === 3)) {
    const read = ok(readFrameFlow(graph, graph, source, connectorId, lower));
    assert.equal(read.upper.producer.port, lower.producer.port);
    assert.deepEqual(read.ends.filter(end => end.role === 'consumer').map(end => end.lower.codeRef), [expectedCode(lower.producer.port)]);
  }
  const outgoing = ok(neighborsOf(graph, producer, options)).neighbors, incoming = ok(neighborsOf(graph, consumer, options)).neighbors;
  assert.equal(outgoing.length, 2); assert.equal(incoming.length, 2);
  for (const row of outgoing) {
    assert.ok(row.direction === 'writes'); assert.deepEqual(row.neighbor.codeRef, expectedCode(row.port));
  }
  for (const row of incoming) {
    assert.ok(row.direction === 'reads'); assert.deepEqual(row.codeRef, expectedCode(row.neighbor.port));
  }
  const historical = clone(options); historical.frames.operations.fills = null;
  assert.deepEqual(ok(buildPackets(graph, historical)), ok(buildPackets(graph, options)));
  assert.equal(canonical({ graph, source }), before);
});

test('readFrameFlow checks complete grouped correspondence when one producer flow occupies several physical bindings', () => {
  const { graph } = fixture(), connector = graph.connectors.find(item => item.id === connectorId)!, lower = binding(graph, 3);
  const second = clone(node(graph, consumer)); second.id = 'garden-another-consume-work';
  second.code = [{ ...clone(second.code[0]!), path: 'consumer/second.ts' }];
  const oldTest = graph.tests.find(item => item.node === consumer)!;
  const secondTest = { ...clone(oldTest), id: 'garden-another-consume-test', node: second.id };
  second.tests = [secondTest.id]; graph.nodes.push(second); graph.tests.push(secondTest); graph.horizon.push(second.id);
  connector.bindings.push({ ...clone(lower), consumers: [{ node: second.id, port: 'in', codeRef: clone(second.code[0]!) }] });
  const options = sources(graph), source = checkedFlowSource(options), physical = connector.bindings.filter(flow => flow.level === 3);
  const whole = { ...clone(physical[0]!), consumers: physical.flatMap(flow => clone(flow.consumers)) };
  const readWhole = ok(readFrameFlow(graph, graph, source, connectorId, whole));
  for (const entry of physical) assert.deepEqual(ok(readFrameFlow(graph, graph, source, connectorId, entry)), readWhole);
  assert.deepEqual(readWhole.ends.filter(end => end.role === 'consumer').map(end => end.lower.node).sort(), [consumer, second.id].sort());
  const outgoing = ok(neighborsOf(graph, producer, options)).neighbors;
  assert.equal(outgoing.length, 2); assert.deepEqual(outgoing.map(row => row.neighbor.work.id).sort(), [consumer, second.id].sort());
  const missing = clone(source); missing.fills = missing.fills!.filter(fill => fill.node !== second.id);
  denied(readFrameFlow(graph, graph, missing, connectorId, physical[0]!), 'frame_record_invalid');

  graph.horizon = graph.horizon.filter(id => id !== second.id);
  const sleeping = physical.find(flow => flow.consumers.some(end => end.node === second.id))!;
  const anchor = workAnchorId(connectorId, flowKey(binding(graph, 2)), sleeping.producer), wakeTest = node(graph, producer).tests[0]!;
  sleeping.anchor = anchor; connector.wakeTest = wakeTest;
  graph.anchors.push({ id: anchor, owner: producer, outcome: 'garden-data', test: wakeTest });
  // Awake and sleeping physical deliveries cover different subsets of the same whole upper flow.
  for (const entry of physical) assert.deepEqual(ok(readFrameFlow(graph, graph, source, connectorId, entry)), readWhole);
  const split = ok(neighborsOf(graph, producer, options)).neighbors;
  assert.equal(split.length, 2);
  const activeRow = split.find(row => row.neighbor.work.id === consumer)!, sleepingRow = split.find(row => row.neighbor.work.id === second.id)!;
  assert.equal(activeRow.delivery, 'in-plan'); assert.equal(Object.hasOwn(activeRow, 'anchor'), false);
  assert.equal(sleepingRow.delivery, 'sleeping'); assert.equal(sleepingRow.anchor, anchor); assert.equal(sleepingRow.wakeTest, wakeTest);
  assert.deepEqual(split.map(row => [row.neighbor.work.id, row.neighbor.operation.id, row.neighbor.block.id]).sort(),
    [[consumer, consumerOp, consumerBlock], [second.id, consumerOp, consumerBlock]].sort());
});
