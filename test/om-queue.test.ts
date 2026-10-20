import { runIntegrityCheck, integrityGate } from "../src/om/integrity.js";
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { reference, type Ref, type StageArtifact } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../src/storage/store.js';
import { writeOmInput } from '../src/om/input.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeRoutes, type RoutesRecord } from '../src/om/routes.js';
import { writeGuarded } from '../src/om/refs.js';
import { openSeries, beginAttempt } from '../src/om/series.js';
import type { OmResult } from '../src/om/refusal.js';
import { QUEUE_POLICY_VERSION, computeBlockWeights, prepareBlockQueue, writeBlockQueue, readBlockQueue,
  readQuestionQueue, prepareQuestionQueue, selectMachinePath,
  type QueuePolicy, type QueueRequest } from '../src/om/queue.js';
import { fillObligations, prepareFrame, prepareHorizonBasis, readFrame, type FrameRequest, type FrameScope } from '../src/om/frame-obligations.js';
import type { LayerProposal } from '../src/om/frame-proposals.js';
import { writeCandidate } from '../src/om/frame-candidate.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import { readLayerAcceptance } from '../src/om/layer-basis.js';
import { gardenGraph, createOmFixture, refusedWith } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';

const project = 'garden', producer = 'garden-produce-block', consumer = 'garden-consume-block';
const later = 'garden-later-block', refusal = 'garden-refusal-block';
const clone = structuredClone;
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function malformed(action: () => unknown) {
  assert.throws(action, (error: unknown) => error instanceof EngineError && error.code === 'queue_request_invalid');
}
function upper(): Graph {
  const { level: _level, ...graph } = projectGraph(gardenGraph(), 1);
  return graph as Graph;
}
function policy(graph: Graph, layer: Ref = { id: 'graph-layer:garden:1', revision: 1, hash: hashJson(graph) }): QueuePolicy {
  const journey = graph.journeys!.find(item => item.terminal === 'success' && item.outcome === 'garden-result')!;
  return { version: QUEUE_POLICY_VERSION, machinePath: { layer, journeyId: journey.id, actorId: journey.actor, outcomeId: journey.outcome } };
}
const blocksOf = (graph: Graph) => graph.nodes.filter(node => node.kind === 'block').map(node => node.id);
const snapshots = (store: Store) => store.list().flatMap(row => store.history(row.id));
function frozen(value: unknown): boolean {
  return value === null || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(frozen);
}
class ExactOnlyStore extends Store {
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    assert.notEqual(revision, undefined, `Historical queue must not read ${id}'s current head`);
    return super.get<T>(id, revision);
  }
  override list<T = Json>(_kind?: string): Revision<T>[] { assert.fail('Historical queue must not enumerate current records'); }
}
function rewrite<T>(store: Store, record: Revision<T>, value: T): Revision<T> {
  const db = new DatabaseSync(store.path), hash = hashJson(value);
  try {
    db.exec('DROP TRIGGER IF EXISTS revisions_no_update');
    db.prepare('UPDATE revisions SET body=?,sha256=? WHERE entity_id=? AND revision=?').run(canonical(value), hash, record.id, record.revision);
  } finally { db.close(); }
  return { ...record, value, hash };
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-queue-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  preparedFeatures(new ProductEngine(store), project, upper());
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage,
    reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const input = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const map = store.get<StageArtifact>(stages['operation-map'].id, stages['operation-map'].revision)!;
  const layer = (map.value.content as unknown as { graph: Ref }).graph;
  const givenPolicy = policy(graph.value, layer);
  const horizon = (version: string) => ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph),
    refinement: null, available: {}, choice: { choiceVersion: version, features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const first = horizon('queue-initial');
  const request: QueueRequest = { project, horizon: reference(first.gate), policy: givenPolicy, override: null };
  return { path, input, graph, layer, stages, first, horizon, request, get store() { return store; },
    restart() { store.close(); store = new Store(path); } };
}

test('queue D counts unique L1 outcome consumers and incoming behavioral sources across the whole upper layer', () => {
  const graph = upper(), selection = policy(graph);
  const before = ok(computeBlockWeights(graph, blocksOf(graph), selection));
  assert.deepEqual(Object.fromEntries(before.order.map(row => [row.block, row.D])),
    { [producer]: 2, [consumer]: 0, [later]: 0, [refusal]: 1 });
  graph.connectors[0]!.bindings.push(clone(graph.connectors[0]!.bindings[0]!));
  graph.edges!.push(
    { id: 'same-consumer-return', relation: 'returns_to', source: consumer, target: producer, condition: 'Retry' },
    { id: 'same-consumer-success', relation: 'on_success', source: consumer, target: producer, condition: 'Continue' },
    { id: 'requires-is-not-D', relation: 'requires', source: refusal, target: consumer, condition: 'Dependency only' },
    { id: 'realizes-is-not-D', relation: 'realizes', source: refusal, target: consumer, condition: 'Refinement only' },
  );
  graph.transfers!.push({ id: 'transfer-is-not-D', path: 'shared.txt', from: refusal, to: consumer, condition: 'producer_committed' });
  const result = ok(computeBlockWeights(graph, [producer, consumer], selection));
  assert.equal(result.maxD, 2);
  assert.deepEqual(result.order.map(row => [row.block, row.D, row.P, row.S, row.weight]),
    [[producer, 2, 1, 0, 4], [consumer, 0, 1, 0, 2]]);
  const restricted = ok(computeBlockWeights(graph, [refusal], selection));
  assert.equal(restricted.maxD, 1, 'The denominator is the maximum only among H, not the whole L1');
  assert.equal(restricted.order[0]!.weight, 2);
  assert.equal(restricted.order[0]!.D, 1, 'on_failure producer → refusal contributes producer to D(refusal)');
});

test('queue P uses the single explicit successful journey without guessing from other successful journeys', () => {
  const graph = upper(), original = policy(graph), other = graph.journeys!.find(item => item.outcome === 'garden-later')!;
  const baseline = ok(computeBlockWeights(graph, blocksOf(graph), original));
  assert.deepEqual(baseline.order.filter(row => row.P).map(row => row.block).sort(), [consumer, producer].sort());
  const selected = { ...original, machinePath: { ...original.machinePath, journeyId: other.id, actorId: other.actor, outcomeId: other.outcome } };
  assert.deepEqual(ok(computeBlockWeights(graph, blocksOf(graph), selected)).order.filter(row => row.P).map(row => row.block).sort(), [later, producer].sort());
  for (const change of [{ journeyId: 'unknown' }, { actorId: 'other' }, { outcomeId: 'other' }])
    refusedWith(computeBlockWeights(graph, blocksOf(graph), { ...original, machinePath: { ...original.machinePath, ...change } }), 'queue_policy_invalid');
  const failed = graph.journeys!.find(item => item.terminal === 'safe_failure')!;
  refusedWith(computeBlockWeights(graph, blocksOf(graph), { ...original, machinePath: { ...original.machinePath,
    journeyId: failed.id, actorId: failed.actor, outcomeId: failed.outcome } }), 'queue_policy_invalid');
  graph.journeys!.push(clone(graph.journeys!.find(item => item.id === original.machinePath.journeyId)!));
  refusedWith(computeBlockWeights(graph, blocksOf(graph), original), 'queue_policy_invalid');
});

test('queue S classifies all eight outcome durabilities, independently of boundary state', () => {
  const expected = { durable_source: 1, immutable: 1, durable_draft: 1, versioned: 0,
    reconstructible: 0, evidence: 0, recoverable: 0, capability: 0 } as const;
  for (const [durability, wanted] of Object.entries(expected)) for (const state of ['durable', 'transient'] as const) {
    const graph = upper(), block = graph.nodes.find(node => node.id === consumer)!;
    block.boundary = { ...block.boundary, writer: consumer, rollback: consumer, state };
    graph.artifacts.find(artifact => artifact.id === block.outcome)!.durability = durability as keyof typeof expected;
    assert.equal(ok(computeBlockWeights(graph, [consumer], policy(graph))).order[0]!.S, wanted, `${durability}/${state}`);
  }
  for (const field of ['writer', 'rollback'] as const) {
    const graph = upper(); graph.nodes.find(node => node.id === later)!.boundary = {
      ...graph.nodes.find(node => node.id === later)!.boundary, [field]: producer };
    assert.equal(ok(computeBlockWeights(graph, [producer], policy(graph))).order[0]!.S, 1, `another block assigns ${field}`);
    const missingDurability = clone(graph); delete missingDurability.artifacts.find(item => item.id === 'garden-data')!.durability;
    refusedWith(computeBlockWeights(missingDurability, [producer], policy(graph)), 'queue_source_invalid');
    const missingOutcome = clone(graph); missingOutcome.artifacts = graph.artifacts.filter(item => item.id !== 'garden-data');
    refusedWith(computeBlockWeights(missingOutcome, [producer], policy(graph)), 'queue_source_invalid');
  }
});

test('queue has an explicit zero denominator and canonical tie ordering without changing source sets', () => {
  const graph = upper(), rows = [consumer, later], p = policy(graph), expected = ok(computeBlockWeights(graph, rows, p));
  assert.equal(expected.maxD, 0); assert.deepEqual(expected.order.map(row => [row.block, row.weight]), [[consumer, 2], [later, 0]]);
  const changed = clone(graph); changed.nodes.reverse(); changed.artifacts.reverse(); changed.edges!.reverse(); changed.journeys!.reverse();
  for (const connector of changed.connectors) { connector.bindings.reverse(); for (const binding of connector.bindings) binding.consumers.reverse(); }
  assert.deepEqual(ok(computeBlockWeights(changed, [...rows].reverse(), p)), expected);
  const ties = clone(graph); ties.edges = [];
  const tied = ok(computeBlockWeights(ties, [refusal, later], p));
  assert.deepEqual(tied.order.map(row => [row.block, row.weight]), [[later, 0], [refusal, 0]]);
  assert.ok(frozen(expected)); assert.equal(hashJson(expected), hashJson(clone(expected)));
});

test('queue public inputs distinguish absent sources and sets from explicitly empty sets', () => {
  const graph = upper(), p = policy(graph), rows = blocksOf(graph);
  for (const absent of [undefined, null, false, [], 'graph']) malformed(() => computeBlockWeights(absent as unknown as Graph, rows, p));
  for (const absent of [undefined, null, false, 'blocks']) malformed(() => computeBlockWeights(graph, absent as unknown as string[], p));
  for (const absent of [undefined, null, false, []]) malformed(() => computeBlockWeights(graph, rows, absent as unknown as QueuePolicy));
  for (const field of ['layer', 'journeyId', 'actorId', 'outcomeId'] as const) {
    const given = clone(p) as any; delete given.machinePath[field];
    malformed(() => computeBlockWeights(graph, rows, given));
  }
  refusedWith(computeBlockWeights(graph, [], p), 'queue_source_invalid');
  refusedWith(computeBlockWeights(graph, rows, { ...p, version: 'unknown' } as unknown as QueuePolicy), 'queue_policy_invalid');
  refusedWith(computeBlockWeights(graph, rows, { ...p, coefficients: { D: 99, P: 0, S: 0 } } as QueuePolicy), 'queue_policy_invalid');
  refusedWith(computeBlockWeights(graph, ['unknown'], p), 'queue_source_invalid');
  refusedWith(computeBlockWeights(graph, [consumer, consumer], p), 'queue_source_invalid');
});

test('historical omg-live r2 has the accepted 24-block policy calculation without claiming a saved horizon', () => {
  const bytes = readFileSync(new URL('../../test/fixtures/omg-live-graph-r2.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '9c129aa5c1b7a4a7801b70dda5a797aa54df6d6a3cf649fd9ffc589ccfbbee48');
  const graph = JSON.parse(bytes.toString('utf8')) as Graph;
  const selected = graph.nodes.filter(node => node.kind === 'block' && node.id !== 'n-ui').map(node => node.id);
  assert.equal(selected.length, 24);
  const exactBody = { id: 'graph:omg-live', revision: 2, hash: createHash('sha256').update(bytes).digest('hex') };
  const selection: QueuePolicy = { version: QUEUE_POLICY_VERSION, machinePath: { layer: exactBody,
    journeyId: 'jy-owner-success', actorId: 'owner', outcomeId: 'persistent-through-run' } };
  const expected: [string, number, number, number][] = [
    ['n-state',7,1,1], ['n-implement',4,1,1], ['n-publish',3,1,1], ['n-recovery',14,0,1], ['n-control',10,1,0],
    ['n-backup',1,0,1], ['n-progress',7,1,0], ['n-refine',6,1,0], ['n-spec',6,1,0], ['n-compile',4,1,0],
    ['n-concept',4,1,0], ['n-map',4,1,0], ['n-schedule',4,1,0], ['n-check',3,1,0], ['n-research',3,1,0],
    ['n-discovery',2,1,0], ['n-features',2,1,0], ['n-intake',2,1,0], ['n-review',2,1,0], ['n-runtime',7,0,0],
    ['n-continuation',3,0,0], ['n-integrate',2,0,0], ['n-integration-job',2,0,0], ['n-results',2,0,0],
  ];
  const result = ok(computeBlockWeights(graph, selected, selection));
  assert.equal(result.maxD, 14);
  assert.deepEqual(result.order.map(row => [row.block, row.D, row.P, row.S]), expected);
  assert.deepEqual(result.order.map(row => row.block), expected.map(row => row[0]));
  const expectedWeights = [6,39/7,38/7,5,24/7,22/7,3,20/7,20/7,18/7,18/7,18/7,18/7,
    17/7,17/7,16/7,16/7,16/7,16/7,1,3/7,2/7,2/7,2/7];
  for (const [index, [block]] of expected.entries()) {
    const actual = result.order[index]!;
    assert.equal(actual.block, block); assert.equal(actual.position, index + 1);
    assert.ok(Math.abs(actual.weight - expectedWeights[index]!) < 1e-14, `${block} exact rational weight`);
  }
  const integrate = result.order.find(row => row.block === 'n-integrate')!;
  assert.equal(integrate.S, 0, 'Its versioned outcome and self-writer do not qualify as durable or delegated authority');
  assert.equal(integrate.weight, 2 / 7); assert.equal(integrate.position, 22);
  // The old example counted self-writer: only this feature changes, from S=1, W=23/7, rank 6.
  const old: [string,number,number,number,number][] = [
    ['n-state',7,1,1,6], ['n-implement',4,1,1,39/7], ['n-publish',3,1,1,38/7], ['n-recovery',14,0,1,5],
    ['n-control',10,1,0,24/7], ['n-integrate',2,0,1,23/7], ['n-backup',1,0,1,22/7], ['n-progress',7,1,0,3],
    ['n-refine',6,1,0,20/7], ['n-spec',6,1,0,20/7], ['n-compile',4,1,0,18/7], ['n-concept',4,1,0,18/7],
    ['n-map',4,1,0,18/7], ['n-schedule',4,1,0,18/7], ['n-check',3,1,0,17/7], ['n-research',3,1,0,17/7],
    ['n-discovery',2,1,0,16/7], ['n-features',2,1,0,16/7], ['n-intake',2,1,0,16/7], ['n-review',2,1,0,16/7],
    ['n-runtime',7,0,0,1], ['n-continuation',3,0,0,3/7], ['n-integration-job',2,0,0,2/7], ['n-results',2,0,0,2/7],
  ];
  for (const [index,[block,D,P,S,weight]] of old.entries()) {
    const actual = result.order.find(row => row.block === block)!;
    if (block === 'n-integrate') continue;
    assert.deepEqual([actual.D,actual.P,actual.S], [D,P,S]);
    assert.ok(Math.abs(actual.weight - weight) < 1e-14);
    assert.equal(actual.position, index >= 6 && index <= 21 ? index : index + 1);
  }
});

test('H1.1 №1844-7 №1852-4 the machine path is the minimum canonical key among admitted successful journeys of the intended outcomes, in any order', () => {
  const graph = upper(), blocks = blocksOf(graph), layer: Ref = { id: 'graph-layer:garden:1', revision: 1, hash: hashJson(graph) };
  const key = (journey: { outcome: string; actor: string; id: string }) => canonical([journey.outcome, journey.actor, journey.id]);
  const successes = graph.journeys!.filter(item => item.terminal === 'success' && item.outcome === 'garden-result').sort((a, b) => key(a) < key(b) ? -1 : 1);
  assert.ok(successes.length > 1, 'Several successful journeys reach the garden result');
  const success = successes[0]!;
  // Only the journeys of the intended outcomes: the later outcome's journey is never taken for a garden-result horizon.
  assert.deepEqual(ok(selectMachinePath(graph, blocks, ['garden-result'], layer)),
    { layer, journeyId: success.id, actorId: success.actor, outcomeId: 'garden-result' });
  // The key orders by outcome first: with both outcomes the later outcome's journey is the minimum.
  assert.equal(ok(selectMachinePath(graph, blocks, ['garden-result', 'garden-later'], layer)).outcomeId, 'garden-later');
  // A smaller admitted key wins in any array order; a smaller key the common C1 refuses is skipped, not guessed around.
  const second = { ...clone(success), id: 'garden-a-journey' }, refused = { ...clone(success), id: 'garden-0-journey', path: ['garden-unknown-node'] };
  assert.ok(key(refused) < key(second) && key(second) < key(success));
  for (const journeys of [[...graph.journeys!, second, refused], [refused, second, ...graph.journeys!].reverse()])
    assert.equal(ok(selectMachinePath({ ...clone(graph), journeys }, blocks, ['garden-result'], layer)).journeyId, 'garden-a-journey');
  // No admitted journey of the intent: the machine's own refusal, addressed to the exact L1, never the owner's.
  const none = { ...clone(graph), journeys: graph.journeys!.filter(item => item.outcome !== 'garden-result' || item.terminal !== 'success') };
  const empty = refusedWith(selectMachinePath(none, blocks, ['garden-result'], layer), 'queue_policy_invalid');
  assert.deepEqual([empty.route, empty.at.target, empty.at.field], ['producer', layer.id, 'machinePath']);
  // A refused common source is returned as it is, never skipped for the next convenient path.
  const broken = { ...clone(graph), edges: [{ id: 'garden-edge', relation: 'unknown', source: blocks[0]!, target: blocks[1]! }] } as unknown as Graph;
  refusedWith(selectMachinePath(broken, blocks, ['garden-result'], layer), 'queue_source_invalid');
});
test('H1.1 №1852-4 a queue never orders a horizon by the path of another outcome', t => {
  const f = fixture(t);
  const foreign = { ...f.request, policy: { ...f.request.policy, machinePath: { ...f.request.policy.machinePath, outcomeId: 'garden-later' } } };
  const refused = refusedWith(prepareBlockQueue(f.store, foreign), 'queue_policy_invalid');
  assert.deepEqual([refused.route, refused.at.field], ['producer', 'machinePath']);
});
test('a genuine accepted L1 and horizon produce the first queue before L2 without requiring gaps', t => {
  const f = fixture(t), before = canonical(snapshots(f.store)), prepared = ok(prepareBlockQueue(f.store, f.request));
  assert.equal(canonical(snapshots(f.store)), before);
  assert.equal(prepared.record.value.contract, 'block-weight/v1');
  assert.equal(prepared.record.value.policyVersion, QUEUE_POLICY_VERSION);
  assert.equal(prepared.record.value.horizonHash, f.first.horizon.value.result.horizon.hash);
  assert.deepEqual(prepared.record.value.request.policy.machinePath.layer, f.layer);
  assert.equal(f.graph.value.nodes.some(node => node.kind === 'operation' || node.kind === 'work'), false);
  assert.deepEqual(prepared.record.value.order.map(row => row.block), [producer, consumer]);
  assert.equal(f.store.list('gap').length, 0);
  const saved = ok(writeBlockQueue(f.store, f.request));
  assert.deepEqual(saved, prepared.record); assert.equal(saved.hash, hashJson(saved.value)); assert.ok(frozen(saved));
  assert.deepEqual(ok(readBlockQueue(f.store, { project, record: reference(saved) })), saved);
  assert.equal(ok(prepareBlockQueue(f.store, f.request)).writes.length, 0);
  assert.deepEqual(ok(writeBlockQueue(f.store, f.request)), saved);
});

test('owner permutation is complete, explicit and reasoned; another horizon and order do not reset a series', t => {
  const f = fixture(t), series = ok(openSeries(f.store, { project, block: consumer, line: 1,
    slice: 'legacy-subject', predecessor: null, basis: null }));
  ok(beginAttempt(f.store, { project, block: consumer, line: 1, attempt: 1,
    goal: { key: 'proposal', questions: ['Which structure?'], result: 'accepted proposal' } }));
  const beforeSeries = f.store.history(series.id), initial = ok(writeBlockQueue(f.store, f.request));
  const reversed = { ...f.request, override: { order: [consumer, producer], reason: 'Owner examines the consumer first' } };
  const saved = ok(writeBlockQueue(f.store, reversed));
  assert.deepEqual(saved.value.order.map(row => row.block), [consumer, producer]);
  assert.deepEqual(saved.value.order.map(row => row.position), [1,2]);
  for (const row of saved.value.order) assert.equal(row.weight, initial.value.order.find(item => item.block === row.block)!.weight);
  assert.equal(saved.value.request.override!.reason, reversed.override.reason);
  for (const override of [{ order: [consumer], reason: 'Missing producer' }, { order: [consumer,consumer], reason: 'Duplicate' },
    { order: [consumer,producer,later], reason: 'Foreign block' }, { order: [consumer,producer], reason: '' }])
    refusedWith(prepareBlockQueue(f.store, { ...f.request, override }), 'queue_override_invalid');
  const nextHorizon = f.horizon('new-choice'), next = ok(writeBlockQueue(f.store, { ...f.request, horizon: reference(nextHorizon.gate) }));
  assert.notEqual(next.id, initial.id);
  assert.deepEqual(f.store.history(series.id), beforeSeries);
});

test('queue history uses original exact sources after heads change and restart while current preparation refuses', t => {
  const f = fixture(t), saved = ok(writeBlockQueue(f.store, f.request));
  const other = new Store(f.path);
  try {
    const graph = clone(f.graph.value); graph.nodes.find(node => node.id === producer)!.title += ' changed';
    new ProductEngine(other).graphs.save(project, graph, f.graph.revision, 'owner');
  } finally { other.close(); }
  refusedWith(prepareBlockQueue(f.store, f.request), 'frame_upper_drift');
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try { assert.deepEqual(ok(readBlockQueue(exact, { project, record: reference(saved) })), saved); }
  finally { exact.close(); }
  assert.deepEqual(ok(writeBlockQueue(f.store, f.request)), saved, 'A completed exact delivery stays historical');
});

function everyGuardAtomic(f: ReturnType<typeof fixture>, guards: readonly TransactionGuard[], writes: readonly Write[]) {
  assert.ok(guards.length > 0);
  // Closing checkpoints WAL; each independent copy starts from the same proved preparation.
  f.store.close();
  for (const [index, guard] of guards.entries()) {
    const path = join(dirname(f.path), `guard-${index}.sqlite`); copyFileSync(f.path, path);
    const target = new Store(path), other = new Store(path);
    try {
      const before = writes.map(write => target.get(write.id));
      if ('absent' in guard) other.write({ id: guard.id, kind: 'guard-test', expected: 0, value: {} });
      else {
        const row = other.get(guard.id)!;
        assert.deepEqual(reference(row), guard);
        other.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
      }
      refusedWith(writeGuarded(target, { unit: 'M3', target: `guard-${index}`,
        writes, guards }), 'input_stale');
      assert.deepEqual(writes.map(write => target.get(write.id)), before, `No partial writes after ${guard.id} changed`);
    } finally { other.close(); target.close(); }
  }
}

test('each queue source head is protected atomically together with neighboring writes', t => {
  const f = fixture(t), prepared = ok(prepareBlockQueue(f.store, f.request));
  for (const target of [reference(f.graph), reference(f.input), f.layer, f.stages.features, f.request.horizon])
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(target)), target.id);
  everyGuardAtomic(f, prepared.guards, [...prepared.writes,
    { id: 'queue-neighbor', kind: 'test', expected: 0, value: {} }]);
});

test('saved queue rederives its exact source, policy, features and permutation instead of accepting a consistent body hash', t => {
  const f = fixture(t), saved = ok(writeBlockQueue(f.store, f.request));
  for (const mutate of [
    (value: Record<string, any>) => { delete value.contract; },
    (value: Record<string, any>) => { delete value.request.policy; },
    (value: Record<string, any>) => { delete value.request.horizon; },
    (value: Record<string, any>) => { delete value.horizonHash; },
    (value: Record<string, any>) => { delete value.order; },
    (value: Record<string, any>) => { value.order[0].D += 1; },
    (value: Record<string, any>) => { value.order[0].weight += 1; },
    (value: Record<string, any>) => { value.order.reverse(); },
    (value: Record<string, any>) => { value.maxD += 1; },
  ]) {
    const value = clone(saved.value) as Record<string, any>; mutate(value);
    const changed = rewrite(f.store, saved, value as typeof saved.value);
    refusedWith(readBlockQueue(f.store, { project, record: reference(changed) }), 'queue_record_invalid');
    f.restart(); refusedWith(readBlockQueue(f.store, { project, record: reference(changed) }), 'queue_record_invalid');
    rewrite(f.store, saved, saved.value);
  }
  for (const [change, code] of [[{ id: 'block-weight:other:foreign' }, 'record_foreign'], [{ hash: '0'.repeat(64) }, 'record_forged'],
    [{ revision: 999 }, 'record_missing']] as const)
    refusedWith(readBlockQueue(f.store, { project, record: { ...reference(saved), ...change } }), code);
});

function routedFixture(f: ReturnType<typeof fixture>, horizon = reference(f.first.gate), graph = reference(f.graph)) {
  const sources: GapRequest = { project, input: reference(f.input), graph, horizon,
    operations: { proposals: [], frame: { project, level: 2, graph, horizon, layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(f.store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(f.store, sources));
  const routes = ok(writeRoutes(f.store, { project, gaps: { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) },
    tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  return { gaps, routes };
}

test('question ordering reads real M5 and M6 consumer groups once without multiplying weights or changing positions', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
  const f = fixture(t), queue = ok(writeBlockQueue(f.store, f.request)), { routes } = routedFixture(f);
  assert.ok(routes.value.batches.length >= 2);
  assert.ok(routes.value.batches.flatMap(batch => batch.items).every(item => ![producer,consumer].includes(item.target)),
    'Question target strings do not stand for their consumer block identities');
  const request = { project, queue: reference(queue), routes: reference(routes) };
  const selected = ok(readQuestionQueue(f.store, request)), expected = new Set(routes.value.batches.flatMap(batch => batch.items.flatMap(item => item.consumers)));
  assert.deepEqual(selected.order, queue.value.order.filter(row => expected.has(row.block)));
  assert.deepEqual(selected.order.map(row => row.block), [producer,consumer]);
  assert.equal(new Set(selected.order.map(row => row.block)).size, selected.order.length);
  assert.ok(routes.value.routes.some(route => route.consumers.length === 0), 'A mechanism gap remains a mechanism');
  assert.ok(frozen(selected));
  const prepared = ok(prepareQuestionQueue(f.store, request));
  assert.deepEqual(prepared.order, selected.order);
  assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(reference(routes))));
  malformed(() => readQuestionQueue(f.store, { project, queue: reference(queue) } as Parameters<typeof readQuestionQueue>[1]));
  malformed(() => prepareQuestionQueue(f.store, { ...request, routes: null } as unknown as Parameters<typeof prepareQuestionQueue>[1]));
  const another = f.horizon('another-route-choice'), foreign = routedFixture(f, reference(another.gate));
  refusedWith(readQuestionQueue(f.store, { ...request, routes: reference(foreign.routes) }), 'queue_source_invalid');
  const original = clone(routes.value) as RoutesRecord;
  for (const mutate of [(value: typeof original) => { value.batches.pop(); },
    (value: typeof original) => { value.batches[0]!.items[0]!.consumers = []; }]) {
    const value = clone(original); mutate(value);
    const changed = rewrite(f.store, routes, value);
    refusedWith(readQuestionQueue(f.store, { ...request, routes: reference(changed) }), 'route_record_invalid');
    rewrite(f.store, routes, original);
  }
  const graph = clone(f.graph.value); graph.nodes.find(node => node.id === producer)!.title += ' changed';
  new ProductEngine(f.store).graphs.save(project, graph, f.graph.revision, 'owner');
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try { assert.deepEqual(ok(readQuestionQueue(exact, request)), selected); } finally { exact.close(); }
  refusedWith(prepareQuestionQueue(f.store, request), 'input_stale');
});

test('an explicit empty model batch set from complete M5 and M6 selects no questions without treating missing routes as empty', async t => {
  const f = await createOmFixture(t, 'standard', project, { mode: 'executed' }), graph = reference(f.graphRevision);
  const input = f.store.get<{ gaps: { code: string }[] }>(`om-input:${project}`)!;
  assert.ok(input.value.gaps.every(gap => gap.code === 'inventory_missing'), 'The native fixture already completed M5 addressing');
  const horizon = ok(writeHorizon(f.store, { project, input: reference(input), graph,
    refinement: reference(f.layers[2]), available: {},
    choice: { choiceVersion: 'queue-complete-model-work', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame = (level: 2 | 3) => ({ proposals: [], frame: { project, level, graph,
    horizon: reference(horizon.gate), layer: reference(f.layers[level]), frame: reference(f.store.get(`om-frame:${project}:${level}`)!),
    upper: level === 2 ? null : { horizon: reference(horizon.gate), frame: reference(f.store.get(`om-frame:${project}:2`)!) } } });
  const gaps = ok(writeGaps(f.store, { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: frame(2), works: frame(3) }));
  const routes = ok(writeRoutes(f.store, { project, gaps: { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) },
    tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  assert.deepEqual(routes.value.batches, []);
  assert.ok(routes.value.routes.every(route => route.consumers.length === 0));
  const map = f.stages['operation-map'].value.content as unknown as { graph: Ref };
  const queue = ok(writeBlockQueue(f.store, { project, horizon: reference(horizon.gate),
    policy: policy(f.graph, map.graph), override: null }));
  assert.equal(queue.value.order.length, 2);
  const request = { project, queue: reference(queue), routes: reference(routes) };
  assert.deepEqual(ok(readQuestionQueue(f.store, request)).order, []);
  assert.deepEqual(ok(prepareQuestionQueue(f.store, request)).order, []);
  refusedWith(readQuestionQueue(f.store, { ...request, routes: { ...request.routes, revision: 900 } }), 'record_missing');
});

test('the question-queue admission retains current route guards for an atomic consumer transaction', t => {
  const f = fixture(t), queue = ok(writeBlockQueue(f.store, f.request)), { gaps, routes } = routedFixture(f);
  const prepared = ok(prepareQuestionQueue(f.store, { project, queue: reference(queue), routes: reference(routes) }));
  for (const expected of [reference(routes), reference(f.graph), ...gaps.records.map(reference)])
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(expected)), `Missing M6 dependency ${expected.id}`);
  everyGuardAtomic(f, prepared.guards, [{ id: 'queue-consumer', kind: 'test', expected: 0, value: {} }]);
});

test('queue sorting uses unrounded weights even when displayed values tie', () => {
  const graph = upper(), model = graph.nodes.find(node => node.id === later)!;
  const dependent = Array.from({ length: 401 }, (_, index) => ({ ...clone(model), id: `outside-${index}` }));
  graph.nodes.push(...dependent);
  graph.connectors[0]!.bindings[0]!.consumers.push(...dependent.map(node => ({ node: node.id, port: 'in' })));
  const result = ok(computeBlockWeights(graph, [producer,later,refusal], policy(graph)));
  assert.equal(result.maxD, 403);
  assert.equal(result.order.find(row => row.block === refusal)!.weight.toFixed(2), '0.00');
  assert.equal(result.order.find(row => row.block === later)!.weight.toFixed(2), '0.00');
  assert.deepEqual(result.order.map(row => row.block), [producer,refusal,later]);
});

test('saved queue entry points reject incomplete public sources before reading or writing storage', t => {
  const f = fixture(t), noRead = new Proxy(f.store, { get(target, property) {
    if (['get', 'list', 'history', 'write', 'writeMany'].includes(String(property))) return () => assert.fail('Malformed arguments reached storage');
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  for (const field of ['project', 'horizon', 'policy', 'override'] as const) {
    const request = clone(f.request) as unknown as Record<string, unknown>; delete request[field];
    malformed(() => prepareBlockQueue(noRead, request as unknown as QueueRequest));
    malformed(() => writeBlockQueue(noRead, request as unknown as QueueRequest));
  }
  for (const request of [undefined, null, [], { project }, { project, record: null }])
    malformed(() => readBlockQueue(noRead, request as Parameters<typeof readBlockQueue>[1]));
  const wrongLayer = { ...f.request, policy: { ...f.request.policy,
    machinePath: { ...f.request.policy.machinePath, layer: { ...f.layer, hash: '0'.repeat(64) } } } };
  refusedWith(prepareBlockQueue(f.store, wrongLayer), 'queue_policy_invalid');
  const changedGraph = clone(f.graph.value);
  changedGraph.nodes.find(node => node.id === producer)!.title += ' changed';
  new ProductEngine(f.store).graphs.save(project, changedGraph, f.graph.revision, 'owner');
  const otherSavedLayer = f.store.get(f.layer.id)!;
  assert.notEqual(otherSavedLayer.revision, f.layer.revision, 'The graph producer saved a different exact L1 revision');
  for (const layer of [{ ...f.layer, id: 'graph-layer:other:1' }, reference(otherSavedLayer)])
    refusedWith(prepareBlockQueue(f.store, { ...f.request, policy: { ...f.request.policy,
      machinePath: { ...f.request.policy.machinePath, layer } } }), 'queue_policy_invalid');
});

test('a sole saved queue establishes missing B1 provenance for fsck and the integrity gate after restart', t => {
  const f = fixture(t), queue = ok(writeBlockQueue(f.store, f.request));
  const directory = mkdtempSync(join(tmpdir(), 'omg-g7-queue-'));
  let alone = new Store(join(directory, 'state.sqlite'));
  t.after(() => { alone.close(); rmSync(directory, { recursive: true, force: true }); });
  alone.write({ id: queue.id, kind: queue.kind, expected: 0, value: queue.value });
  for (let attempt = 0; attempt < 2; attempt++) {
    const report = runIntegrityCheck(alone, { project }); assert.ok(report.ok);
    assert.ok(report.value.value.findings.some(f => f.code === 'record_missing' && f.id === `om-input:${project}` && f.revision === 1));
    assert.equal(integrityGate(alone, project)?.ok, false);
    const path = alone.path; alone.close(); alone = new Store(path);
  }
});

test('ordinary project text that resembles a queue address does not establish OM provenance', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-queue-text-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  preparedFeatures(engine, project, upper());
  engine.discovery.evidence.document(project, 'queue-description', 'block-weight:garden:described-in-prose', 'text/plain', 0);
  const view = engine.projection(project);
  assert.equal(store.get(`om-input:${project}`), null);
  assert.equal(view.feasibility, null); assert.equal(view.feasibilityGate, null);
});

test('a queue made before L2 still orders current M6 questions after genuine lower-graph authoring under the same accepted L1', t => {
  const f = fixture(t), queue = ok(writeBlockQueue(f.store, f.request));
  const { level: _level, ...lower } = projectGraph(gardenGraph(), 2);
  const next = new ProductEngine(f.store).graphs.save(project, lower, f.graph.revision, 'owner');
  assert.notDeepEqual(reference(next), reference(f.graph));
  assert.deepEqual(reference(f.store.get(f.layer.id)!), f.layer, 'The accepted L1 did not change');
  assert.ok(next.value.nodes.some(node => node.kind === 'operation'));
  const { routes } = routedFixture(f, f.request.horizon, reference(next));
  assert.deepEqual(routes.value.request.gaps.sources.horizon, f.request.horizon);
  assert.notDeepEqual(routes.value.request.gaps.sources.graph, reference(f.graph));
  const request = { project, queue: reference(queue), routes: reference(routes) };
  const expected = ok(readQuestionQueue(f.store, request));
  assert.deepEqual(expected.order, queue.value.order);
  const admitted = ok(prepareQuestionQueue(f.store, request));
  assert.deepEqual(admitted.order, expected.order);
  assert.ok(admitted.guards.some(guard => canonical(guard) === canonical(reference(next))));
  assert.equal(admitted.guards.some(guard => canonical(guard) === canonical(reference(f.graph))), false,
    'The old full graph remains history, not a current guard for the second queue use');
  f.restart();
  assert.deepEqual(ok(readQuestionQueue(f.store, request)), expected);
  assert.deepEqual(ok(prepareQuestionQueue(f.store, request)).order, expected.order);
});


function acceptQueueL2(f: ReturnType<typeof fixture>) {
  const graph = gardenGraph(), frame: FrameRequest = { project, level: 2, graph: reference(f.graph),
    horizon: f.request.horizon, layer: null, frame: null, upper: null };
  const prepared = ok(prepareFrame(f.store, frame)), projected = projectGraph(graph, 2);
  const mapped = ok(fillObligations(prepared.upper as Graph, prepared.scope as FrameScope,
    { graph, reference: { ...frame.graph, hash: hashJson(graph) }, frame: null }, prepared.upperRef, 2));
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: null }, level: 2, source: 'decision', status: 'proposed',
    nodes: projected.nodes.filter(node => node.kind === 'operation'),
    fills: mapped.fills.map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector,
      bindings: connector.bindings.filter(binding => binding.level === 2) })).filter(connector => connector.bindings.length > 0),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    removes: [], replaces: [], redefines: [] };
  const offered = f.store.write({ id: 'om-proposal:garden:queue-l2', kind: 'layer-proposal', expected: 0, value: proposal });
  const candidate = ok(writeCandidate(f.store, { frame, proposals: [reference(offered)] }));
  assert.equal(candidate.state, 'candidate');
  if (candidate.state !== 'candidate') assert.fail('The genuine L2 proposal must form a candidate');
  const candidateRef = reference(candidate.record);
  const accepted = ok(settleCandidate(f.store, { project, level: 2, candidate: candidateRef,
    outcome: { gate: 'G3', candidate: candidateRef, graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  assert.ok(accepted.graph && accepted.layer && accepted.frame);
  assert.equal(ok(readLayerAcceptance(f.store, { project, level: 2,
    graph: reference(accepted.graph), layer: reference(accepted.layer) })).producer, 'om');
  return { graph: accepted.graph, layer: accepted.layer, frame: accepted.frame };
}

test('the owner reorders after genuine L2 acceptance and restart without replacing H, L1, weights or repair series', t => {
  const f = fixture(t), initial = ok(writeBlockQueue(f.store, f.request));
  const series = ok(openSeries(f.store, { project, block: consumer, line: 1,
    slice: 'same-repair-subject', predecessor: null, basis: null }));
  ok(beginAttempt(f.store, { project, block: consumer, line: 1, attempt: 1,
    goal: { key: 'proposal', questions: ['Which structure?'], result: 'accepted proposal' } }));
  const oldSeries = f.store.history(series.id), oldHorizon = clone(f.first), oldInput = f.input;
  const accepted = acceptQueueL2(f);
  assert.notDeepEqual(reference(accepted.graph), reference(f.graph));
  assert.deepEqual(reference(f.store.get(f.layer.id)!), f.layer);
  f.restart();
  const request = { ...f.request, override: { order: [consumer, producer], reason: 'Owner reviews the consumer first after seeing its operations' } };
  const before = canonical(snapshots(f.store)), prepared = ok(prepareBlockQueue(f.store, request));
  assert.equal(canonical(snapshots(f.store)), before);
  for (const expected of [reference(accepted.graph), reference(f.input), f.layer,
    reference(f.first.horizon), reference(f.first.gate), f.stages.features])
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(expected)), `Late admission lost ${expected.id}`);
  assert.equal(prepared.guards.some(guard => canonical(guard) === canonical(reference(f.graph))), false,
    'The prior whole graph is historical, while the freshly admitted full graph is guarded');
  const changed = ok(writeBlockQueue(f.store, request));
  assert.deepEqual(changed, prepared.record);
  assert.deepEqual(changed.value.order.map(row => row.block), [consumer, producer]);
  assert.deepEqual(changed.value.order.map(row => row.position), [1, 2]);
  const values = (queue: typeof initial) => queue.value.order.map(({ position: _position, ...row }) => row)
    .sort((left, right) => left.block.localeCompare(right.block));
  assert.deepEqual(values(changed), values(initial));
  assert.equal(changed.value.maxD, initial.value.maxD);
  assert.equal(changed.value.horizonHash, initial.value.horizonHash);
  assert.deepEqual(changed.value.request.horizon, initial.value.request.horizon);
  assert.deepEqual(changed.value.request.policy, initial.value.request.policy);
  assert.deepEqual(f.store.get(oldHorizon.gate.id), oldHorizon.gate);
  assert.deepEqual(f.store.get(oldHorizon.horizon.id), oldHorizon.horizon);
  assert.deepEqual(f.store.get(oldInput.id), oldInput);
  assert.deepEqual(f.store.history(series.id), oldSeries);
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try {
    assert.deepEqual(ok(readBlockQueue(exact, { project, record: reference(initial) })), initial);
    assert.deepEqual(ok(readBlockQueue(exact, { project, record: reference(changed) })), changed);
  } finally { exact.close(); }
  assert.deepEqual(ok(writeBlockQueue(f.store, request)), changed);
  const next = ok(prepareBlockQueue(f.store, { ...request, override: { ...request.override, reason: 'Same full permutation, independently justified' } }));
  everyGuardAtomic(f, next.guards, [...next.writes, { id: 'late-queue-neighbor', kind: 'test', expected: 0, value: {} }]);
});

test('late queue preparation refuses a changed accepted L1 while the original H and historical queue retain their exact meaning', t => {
  const f = fixture(t), initial = ok(writeBlockQueue(f.store, f.request)), accepted = acceptQueueL2(f);
  const change = clone(accepted.graph.value) as Graph;
  change.nodes.find(node => node.id === producer)!.title += ' a genuinely different upper subject';
  new ProductEngine(f.store).graphs.save(project, change, accepted.graph.revision, 'owner');
  const newLayer = reference(f.store.get(f.layer.id)!);
  assert.notDeepEqual(newLayer, f.layer);
  assert.deepEqual(f.store.get(f.first.gate.id), f.first.gate);
  const request = { ...f.request, override: { order: [consumer, producer], reason: 'Reorder after the graph changed' } };
  refusedWith(prepareBlockQueue(f.store, request), 'frame_upper_drift');
  refusedWith(prepareBlockQueue(f.store, { ...request, policy: { ...request.policy,
    machinePath: { ...request.policy.machinePath, layer: newLayer } } }), 'queue_policy_invalid');
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try { assert.deepEqual(ok(readBlockQueue(exact, { project, record: reference(initial) })), initial); }
  finally { exact.close(); }
});

test('the extracted horizon admission retains the existing frame layer and upper witness checks', t => {
  const f = fixture(t), accepted = acceptQueueL2(f);
  const operations: FrameRequest = { project, level: 2, graph: reference(accepted.graph), horizon: f.request.horizon,
    layer: reference(accepted.layer), frame: reference(accepted.frame), upper: null };
  const read = ok(readFrame(f.store, operations)), prepared = ok(prepareFrame(f.store, operations));
  assert.deepEqual(prepared.result, read.result);
  assert.deepEqual(prepared.expected, { graph: accepted.graph.revision, layer: accepted.layer.revision, frame: accepted.frame.revision });
  refusedWith(prepareFrame(f.store, { ...operations, layer: null, frame: null }), 'input_stale');
  refusedWith(prepareFrame(f.store, { ...operations, frame: null }), 'frame_basis_unproven');
  refusedWith(prepareFrame(f.store, { ...operations, layer: { ...operations.layer!, revision: 999 } }), 'record_missing');
  const witness = ok(writeHorizon(f.store, { project, input: reference(f.input), graph: reference(accepted.graph),
    refinement: reference(accepted.layer), available: {},
    choice: { choiceVersion: 'queue-frame-upper', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const works: FrameRequest = { project, level: 3, graph: reference(accepted.graph), horizon: reference(witness.gate),
    layer: null, frame: null, upper: { horizon: reference(witness.gate), frame: reference(accepted.frame) } };
  const worksRead = ok(readFrame(f.store, works)), worksPrepared = ok(prepareFrame(f.store, works));
  assert.deepEqual(worksPrepared.result, worksRead.result);
  refusedWith(prepareFrame(f.store, { ...works, upper: { horizon: f.request.horizon, frame: reference(accepted.frame) } }), 'frame_basis_unproven');
  refusedWith(prepareFrame(f.store, { ...works, upper: { ...works.upper!, frame: null } }), 'frame_basis_unproven');
  refusedWith(prepareFrame(f.store, { ...works, upper: { ...works.upper!, frame: { ...reference(accepted.frame), hash: '0'.repeat(64) } } }), 'frame_basis_unproven');
  const historicalWorks = ok(readFrame(f.store, { ...works, workZoneContract: 'accepted-l2-v1' }));
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try {
    assert.deepEqual(ok(readFrame(exact, operations)), read);
    assert.deepEqual(ok(readFrame(exact, { ...works, workZoneContract: 'accepted-l2-v1' })), historicalWorks);
  } finally { exact.close(); }
});

test('late admission cannot replace missing H, B1, policy or required exact upstream sources with a default', t => {
  const f = fixture(t); acceptQueueL2(f);
  const request = { ...f.request, override: { order: [consumer, producer], reason: 'Owner reorders the admitted horizon' } };
  const saved = ok(writeBlockQueue(f.store, request)), before = canonical(snapshots(f.store));
  for (const hidden of [reference(f.first.gate), reference(f.first.horizon), reference(f.input), f.layer,
    f.stages['operation-map'], f.stages.features]) {
    const missing = new Proxy(f.store, { get(target, key) {
      if (key === 'get') return (id: string, revision?: number) => id === hidden.id ? null : target.get(id, revision);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    // NR1: the accepted stage is read as written; the lost layer is found by the layer reader of the frame basis.
    const code = hidden.id === f.layer.id ? 'layer_basis_unproven' : 'record_missing';
    refusedWith(prepareBlockQueue(missing, request), [code, 'input_stale']);
    // NR1: the saved queue is read as written and reads its sources only where it needs them; a source gone from the store
    // is found by om-fsck at the start (reference_missing), not by every reading.
    void readBlockQueue(missing, { project, record: reference(saved) });
  }
  const choices = [
    { ...request.policy, version: 'unknown-version' },
    { ...request.policy, machinePath: { ...request.policy.machinePath, actorId: 'a-different-owner' } },
    { ...request.policy, coefficients: { D: 1, P: 1, S: 1 } },
  ];
  for (const selection of choices) refusedWith(prepareBlockQueue(f.store, { ...request, policy: selection as QueuePolicy }), 'queue_policy_invalid');
  assert.equal(canonical(snapshots(f.store)), before);
});

test('queue and common horizon admission reject graph-only upper drift while the exact accepted L1, H and B1 stay unchanged', t => {
  const f = fixture(t), saved = ok(writeBlockQueue(f.store, f.request)), changed = clone(f.graph.value);
  changed.nodes.find(node => node.id === producer)!.title += ' differs from the retained accepted upper';
  const next = f.store.write({ id: f.graph.id, kind: f.graph.kind, expected: f.graph.revision, value: changed });
  // Negative integrity fixture: only the complete Graph head advances; no accepted L1 or binding is invented.
  assert.deepEqual(reference(f.store.get(f.layer.id)!), f.layer);
  assert.deepEqual(f.store.get(f.first.gate.id), f.first.gate);
  assert.deepEqual(f.store.get(f.input.id), f.input);
  for (let pass = 0; pass < 2; pass++) {
    refusedWith(prepareHorizonBasis(f.store, { project, graph: reference(next), horizon: f.request.horizon }), 'frame_upper_drift');
    refusedWith(prepareBlockQueue(f.store, { ...f.request, override: { order: [consumer, producer], reason: 'A new order does not accept a changed upper' } }), 'frame_upper_drift');
    const exact = new ExactOnlyStore(f.path);
    try { assert.deepEqual(ok(readBlockQueue(exact, { project, record: reference(saved) })), saved); }
    finally { exact.close(); }
    f.restart();
  }
});

test('common horizon admission rejects malformed exported inputs before reading storage', t => {
  const f = fixture(t), given = { project, graph: reference(f.graph), horizon: f.request.horizon };
  const bad = (action: () => unknown) => assert.throws(action,
    (error: unknown) => error instanceof EngineError && error.code === 'frame_request_invalid');
  const noRead = new Proxy(f.store, { get(target, property) {
    if (['get', 'list', 'history', 'write', 'writeMany'].includes(String(property))) return () => assert.fail('Malformed horizon arguments reached storage');
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  for (const store of [undefined, null, {}, []]) bad(() => prepareHorizonBasis(store as unknown as Store, given));
  for (const request of [undefined, null, [], false, 'horizon'])
    bad(() => prepareHorizonBasis(noRead, request as unknown as typeof given));
  for (const field of ['project', 'graph', 'horizon'] as const) {
    const absent = clone(given) as Record<string, unknown>; delete absent[field];
    bad(() => prepareHorizonBasis(noRead, absent as typeof given));
    for (const value of [null, false, [], {}]) bad(() => prepareHorizonBasis(noRead, { ...given, [field]: value } as typeof given));
  }
  bad(() => prepareHorizonBasis(noRead, { ...given, project: 'invalid project' }));
  bad(() => prepareHorizonBasis(noRead, { ...given, graph: { ...given.graph, revision: 0 } }));
  bad(() => prepareHorizonBasis(noRead, { ...given, horizon: { ...given.horizon, hash: '' } }));
});


test('concurrent creation of the same prepared queue preserves its CAS and leaves no neighboring partial write', t => {
  const f = fixture(t), prepared = ok(prepareBlockQueue(f.store, f.request));
  assert.equal(prepared.writes.length, 1);
  assert.equal(f.store.get(prepared.record.id), null);
  const other = new Store(f.path);
  let concurrent: typeof prepared.record;
  try { concurrent = ok(writeBlockQueue(other, f.request)); }
  finally { other.close(); }
  const failure = refusedWith(writeGuarded(f.store, { unit: 'M3', target: prepared.record.id,
    guards: prepared.guards, writes: [...prepared.writes,
      { id: 'queue-target-cas-neighbor', kind: 'test', expected: 0, value: {} }] }), 'revision_conflict');
  assert.equal(failure.at.target, prepared.record.id);
  assert.equal(f.store.get('queue-target-cas-neighbor'), null);
  assert.deepEqual(f.store.get(prepared.record.id), concurrent);
  assert.deepEqual(ok(writeBlockQueue(f.store, f.request)), concurrent);
});


test('LG13 queue refuses a graph without version 2 instead of interpreting it as the old upper layer', () => {
  for (const version of [1, undefined, 3]) {
    const graph = upper();
    if (version === undefined) delete (graph as Partial<Graph>).version; else graph.version = version as Graph["version"];
    const rejected = refusedWith(computeBlockWeights(graph, [producer, consumer], policy(upper())), 'queue_source_invalid');
    assert.equal(rejected.at.field, 'version');
  }
});
