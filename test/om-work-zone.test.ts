import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import type { Graph } from "../src/graph/model.js";
import { RefinementRelations } from "../src/graph/relations.js";
import type { Horizon } from "../src/om/horizon.js";
import { sealed, type OmResult, type Sealed } from "../src/om/refusal.js";
import { workZone, readWorkZone, prepareWorkZone, type WorkZoneRequest } from "../src/om/work-zone.js";
import { gardenGraph, createOmFixture } from "./om-fixture.js";

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { projectGraph } from '../src/graph/project.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store } from '../src/storage/store.js';
import { writeOmInput } from '../src/om/input.js';
import { writeHorizon } from '../src/om/horizon.js';
import { fillObligations, prepareFrame, readFrameBasis, type FrameRequest, type FrameScope } from '../src/om/frame-obligations.js';
import type { LayerProposal } from '../src/om/frame-proposals.js';
import { writeCandidate } from '../src/om/frame-candidate.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import { writeGuarded } from '../src/om/refs.js';
import { preparedFeatures } from './product-fixture.js';
import { prepareCurrentGaps, prepareGaps, readGaps, writeGaps, type GapReadRequest, type GapRequest } from '../src/om/gaps.js';
import { readGapLines } from '../src/om/gap-lines.js';

type ZoneHorizon = Pick<Horizon, "nodes" | "execution">;
const producer = "garden-produce-block", consumer = "garden-consume-block", later = "garden-later-block";
const produceOp = "garden-produce-operation", consumeOp = "garden-consume-operation", prepOp = "garden-prep-operation";
const laterOp = "garden-later-operation";
const basis = { "garden-data": { id: "artifact-receipt:garden:garden-data", revision: 1, hash: hashJson("garden-data") } };
const needed = (nodes: string[] = [producer, consumer]): ZoneHorizon => ({ nodes,
  execution: Object.fromEntries(nodes.map(id => [id, { state: "needed" as const }])) });
function zone(result: OmResult<Sealed<string[]>>): readonly string[] {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.value));
  return result.value;
}
function refusal(result: OmResult<Sealed<string[]>>, code: string, target: string, field: string,
  route: "readiness" | "producer"): void {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error("Expected an addressed refusal");
  assert.equal(result.refusal.code, code);
  assert.deepEqual(result.refusal.at, { unit: "F7.1", target, field });
  assert.equal(result.refusal.route, route);
  assert.ok(result.refusal.message.length > 0);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.refusal));
  assert.ok(Object.isFrozen(result.refusal.at));
}
function invalid(field: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "work_zone_request_invalid");
    assert.deepEqual(error.details, { unit: "F7.1", target: "work-zone", field });
    return true;
  };
}

test("work zone contains only needed operations and excludes explicit representatives and available blocks", () => {
  const graph = gardenGraph();
  assert.deepEqual(zone(workZone(graph, needed(), [])), [consumeOp, prepOp, produceOp]);
  const ready = needed(); ready.execution[producer] = { state: "available", basis };
  assert.deepEqual(zone(workZone(graph, ready, [])), [consumeOp]);
  assert.deepEqual(zone(workZone(graph, needed(), [prepOp])), [consumeOp, produceOp]);
  assert.deepEqual(zone(workZone(graph, needed(), [prepOp, consumeOp, produceOp])), []);
  assert.deepEqual(zone(workZone(graph, needed([]), [])), []);
  assert.deepEqual(zone(workZone(graph, { nodes: [producer], execution: { [producer]: { state: "available", basis } } }, [])), []);
  assert.deepEqual(zone(workZone(graph, needed([later]), [])), [laterOp],
    "An ordinary operation is not an identity merely because its child is an identity work");
});

test("work zone follows direct and transitive realizes roles even when the operation is contained outside the horizon", () => {
  const graph = gardenGraph();
  graph.nodes.find(node => node.id === produceOp)!.parent = later;
  graph.edges!.push(
    { id: "produce-realizes-needed-block", source: produceOp, target: producer, relation: "realizes", condition: "Implements the producer role" },
    { id: "later-realizes-consumer-operation", source: laterOp, target: consumeOp, relation: "realizes", condition: "Implements the consumer role" },
    { id: "prep-realizes-consumer-operation", source: prepOp, target: consumeOp, relation: "realizes", condition: "Also implements the consumer role" },
  );
  assert.deepEqual(zone(workZone(graph, needed(), [])), [consumeOp, laterOp, prepOp, produceOp]);
  assert.deepEqual(zone(workZone(graph, needed(), [laterOp])), [consumeOp, prepOp, produceOp]);
  const ready = needed(); ready.execution[producer] = { state: "available", basis };
  assert.deepEqual(zone(workZone(graph, ready, [])), [consumeOp, laterOp, prepOp],
    "An operation refining both an available and a needed block still belongs to the needed block's zone");
});

test("work zone cannot borrow unaccepted work-layer ancestry or control relations to enter a block", () => {
  const graph = gardenGraph();
  graph.edges!.push(
    { id: "later-via-lower-work", source: laterOp, target: "garden-produce-work", relation: "realizes", condition: "Lower-layer bridge" },
    { id: "later-requires-producer", source: laterOp, target: producer, relation: "requires", condition: "Dependency is not refinement" },
  );
  assert.equal(new RefinementRelations(graph).refines(laterOp, producer), true,
    "The full graph really contains the lower-layer bridge used by this counterexample");
  assert.deepEqual(zone(workZone(graph, needed([producer]), [])), [prepOp, produceOp]);
});

test("work zone is sorted, invariant under input order and does not mutate or freeze caller inputs", () => {
  const graph = gardenGraph(), horizon = needed(), identities = [prepOp];
  const before = structuredClone({ graph, horizon, identities });
  const result = zone(workZone(graph, horizon, identities));
  assert.deepEqual(result, [consumeOp, produceOp]);
  assert.deepEqual({ graph, horizon, identities }, before);
  assert.equal(Object.isFrozen(graph), false);
  assert.equal(Object.isFrozen(graph.nodes), false);
  assert.equal(Object.isFrozen(horizon), false);
  assert.equal(Object.isFrozen(identities), false);
  assert.throws(() => (result as string[]).push("intruder"), TypeError);

  const permuted = structuredClone(graph);
  permuted.nodes.reverse(); permuted.edges!.reverse(); permuted.connectors.reverse();
  const reordered = { nodes: [...horizon.nodes].reverse(), execution: Object.fromEntries(Object.entries(horizon.execution).reverse()) };
  assert.deepEqual(zone(workZone(permuted, reordered, [...identities].reverse())), result);
  assert.deepEqual(zone(workZone(sealed(graph) as Graph, sealed(horizon) as ZoneHorizon, sealed(identities))), result);
  graph.nodes.find(node => node.id === produceOp)!.id = "changed-after-call";
  horizon.nodes.length = 0; identities.push(consumeOp);
  assert.deepEqual(result, [consumeOp, produceOp]);
});

test("missing and malformed arguments become addressed EngineErrors instead of accidental runtime exceptions", () => {
  const graph = gardenGraph(), horizon = needed();
  for (const value of [undefined, null, 4, "graph", [], {}]) {
    assert.throws(() => workZone(value as unknown as Graph, horizon, []), invalid("graph"));
    assert.throws(() => workZone(graph, value as unknown as ZoneHorizon, []), invalid("horizon.nodes"));
  }
  for (const value of [undefined, null, 4, "identity", {}, [null], [""], ["  "], new Array<string>(1)])
    assert.throws(() => workZone(graph, horizon, value as unknown as string[]), invalid("identityOps"));
  for (const nodes of [undefined, null, {}, "node", [null], [4], [""], ["  "], new Array<string>(1)])
    assert.throws(() => workZone(graph, { nodes, execution: {} } as unknown as ZoneHorizon, []), invalid("horizon.nodes"));
  const missingNodes = { execution: horizon.execution };
  assert.throws(() => workZone(graph, missingNodes as ZoneHorizon, []), invalid("horizon.nodes"));
  for (const field of ["nodes", "connectors", "edges", "contracts", "artifacts", "tests", "version"] as const) {
    const incomplete: Partial<Graph> = structuredClone(graph); delete incomplete[field];
    assert.throws(() => workZone(incomplete as Graph, horizon, []), invalid("graph"));
  }
  const missingKind = structuredClone(graph) as unknown as { nodes: Record<string, unknown>[] };
  delete missingKind.nodes[0]!['kind'];
  assert.throws(() => workZone(missingKind as unknown as Graph, horizon, []), invalid("graph"));
});

test("every horizon block requires an explicit valid execution entry and available receipt references", () => {
  const graph = gardenGraph();
  for (const execution of [undefined, null, [], "needed", {}, { [consumer]: { state: "needed" } }]) {
    const horizon = { nodes: [producer, consumer], execution } as unknown as ZoneHorizon;
    refusal(workZone(graph, horizon, []), "horizon_execution_missing", producer, "execution", "readiness");
  }
  const inherited = Object.create({ [producer]: { state: "needed" } }) as ZoneHorizon['execution'];
  refusal(workZone(graph, { nodes: [producer], execution: inherited }, []), "horizon_execution_missing", producer, "execution", "readiness");
  for (const entry of [undefined, null, [], "needed", {}, Object.create({ state: "needed" }),
    Object.assign(Object.create({ basis }), { state: "available" }), { state: "unknown" }, { state: "available" },
    { state: "available", basis: null }, { state: "available", basis: [] },
    { state: "available", basis: { "garden-data": { id: "receipt", revision: 0, hash: "invalid" } } }]) {
    const horizon = { nodes: [consumer, producer], execution: { [consumer]: { state: "needed" }, [producer]: entry } } as unknown as ZoneHorizon;
    refusal(workZone(graph, horizon, []), "horizon_execution_missing", producer, "execution", "readiness");
  }
  refusal(workZone(graph, { nodes: [] } as unknown as ZoneHorizon, []), "horizon_execution_missing", "horizon", "execution", "readiness");
});

test("unknown and wrong-kind horizon and identity addresses cannot masquerade as valid selection basis", () => {
  const graph = gardenGraph();
  for (const id of ["unknown-block", "garden-product", produceOp, "garden-produce-work"])
    refusal(workZone(graph, needed([id]), []), "work_zone_basis_unproven", id, "horizon.nodes", "producer");
  for (const id of ["unknown-operation", "garden-product", producer, "garden-produce-work"])
    refusal(workZone(graph, needed(), [id]), "work_zone_basis_unproven", id, "identityOps", "producer");
});

test("prototype-named block IDs use their own execution entries rather than inherited object properties", () => {
  const graph = gardenGraph();
  graph.nodes.push({ ...structuredClone(graph.nodes.find(node => node.id === producer)!), id: "constructor" },
    { ...structuredClone(graph.nodes.find(node => node.id === produceOp)!), id: "constructor-operation", parent: "constructor" });
  assert.deepEqual(zone(workZone(graph, needed(["constructor"]), [])), ["constructor-operation"]);
  refusal(workZone(graph, { nodes: ["constructor"], execution: {} }, []), "horizon_execution_missing", "constructor", "execution", "readiness");
});




function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function denied(result: OmResult<unknown>, code?: string) {
  if (result.ok) assert.fail(`Expected ${code ?? 'refusal'}`);
  if (code) assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target && (result.refusal.at.field || result.refusal.at.ref));
  return result.refusal;
}
const snapshot = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function nativeZone(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-work-zone-')), database = join(root, 'state.sqlite');
  const store = new Store(database), graph = gardenGraph('cross');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const { level: _level, ...upper } = projectGraph(graph, 1);
  preparedFeatures(new ProductEngine(store), 'garden', upper as Graph);
  const input = ok(writeOmInput(store, { project: 'garden', expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const horizon = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(store.get('graph:garden')!),
    refinement: null, choice: { choiceVersion: 'zone-first', features: [{ outcome: 'garden-result' }], excluded: [] }, available: {} }));
  const frame: FrameRequest = { project: 'garden', level: 2, graph: reference(store.get('graph:garden')!),
    horizon: reference(horizon.gate), layer: null, frame: null, upper: null };
  const read = ok(prepareFrame(store, frame)), projected = projectGraph(graph, 2);
  const mapped = ok(fillObligations(read.upper as Graph, read.scope as FrameScope,
    { graph, reference: { ...frame.graph, hash: hashJson(graph) }, frame: null }, read.upperRef, 2));
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: null }, level: 2, source: 'decision', status: 'proposed',
    nodes: projected.nodes.filter(node => node.kind === 'operation'), fills: mapped.fills.map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length > 0),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    removes: [], replaces: [], redefines: [] };
  const proposalRef = reference(store.write({ id: 'om-proposal:garden:zone', kind: 'layer-proposal', expected: 0, value: proposal }));
  const candidate = ok(writeCandidate(store, { frame, proposals: [proposalRef] }));
  assert.equal(candidate.state, 'candidate'); if (candidate.state !== 'candidate') throw new Error('No candidate');
  const candidateRef = reference(candidate.record);
  const accepted = ok(settleCandidate(store, { project: 'garden', level: 2, candidate: candidateRef,
    outcome: { gate: 'G3', candidate: candidateRef, graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  const request: WorkZoneRequest = { project: 'garden', graph: reference(accepted.graph!), layer: reference(accepted.layer!),
    horizon: reference(horizon.gate), frame: reference(accepted.frame!) };
  return { store, database, request, horizon, accepted, input };
}

test('F1 reads the first real C5 acceptance using its original horizon without requiring L3 or new refinement evidence', t => {
  const f = nativeZone(t), before = snapshot(f.store);
  assert.equal(f.horizon.horizon.value.request.refinement, null);
  const read = ok(readWorkZone(f.store, f.request)), prepared = ok(prepareWorkZone(f.store, f.request));
  assert.deepEqual(read.operations, [consumeOp, prepOp, produceOp]);
  assert.deepEqual(prepared.operations, read.operations);
  for (const ref of [f.request.graph, f.request.layer, f.request.frame!, f.request.horizon, reference(f.input)])
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)), ref.id);
  assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.request.graph) && Object.isFrozen(prepared.guards));
  assert.deepEqual(snapshot(f.store), before);
  const restarted = new Store(f.database);
  try { assert.deepEqual(ok(readWorkZone(restarted, f.request)), read); }
  finally { restarted.close(); }
});

test('F1 stored paths validate every required argument before accessing the store', t => {
  const f = nativeZone(t);
  const unread = new Proxy(f.store, { get(target, key) {
    if (key === 'get') return () => { throw new Error('Must validate before reading'); };
    const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const malformed = (error: unknown) => error instanceof EngineError && error.code === 'work_zone_request_invalid';
  for (const action of [readWorkZone, prepareWorkZone]) {
    for (const request of [undefined, null, [], {}, ...Object.keys(f.request).flatMap(key => [undefined, null, 5, []].map(value => ({ ...f.request, [key]: value })))]) {
      if (request && !Array.isArray(request) && 'frame' in request && request.frame === null && Object.keys(request).length === 5) continue;
      assert.throws(() => action(unread, request as WorkZoneRequest), malformed);
    }
    assert.throws(() => action(null as unknown as Store, f.request), malformed);
  }
});

test('F1 rejects foreign exact sources, forged hashes, omitted accepted frames and status-only acceptance', t => {
  const f = nativeZone(t), before = snapshot(f.store);
  for (const action of [readWorkZone, prepareWorkZone]) {
    for (const field of ['graph', 'layer', 'horizon', 'frame'] as const) {
      const source = f.request[field]!;
      denied(action(f.store, { ...f.request, [field]: { ...source, id: source.id.replace('garden', 'foreign') } }));
      denied(action(f.store, { ...f.request, [field]: { ...source, hash: '0'.repeat(64) } }));
      denied(action(f.store, { ...f.request, [field]: { ...source, revision: 9999 } }));
    }
    denied(action(f.store, { ...f.request, frame: null }), 'frame_basis_unproven');
  }
  assert.deepEqual(snapshot(f.store), before);
  const fake = f.store.write({ id: f.request.layer.id, kind: 'graph-layer', expected: f.request.layer.revision,
    value: { projection: projectGraph(f.accepted.graph!.value as Graph, 2), inputs: [], obligations: [], status: 'accepted' } });
  for (const action of [readWorkZone, prepareWorkZone]) denied(action(f.store, { ...f.request, layer: reference(fake) }), 'frame_basis_unproven');
});

test('F1 hands every current C2 guard to the neighboring transaction while exact history survives head changes', t => {
  const f = nativeZone(t), prepared = ok(prepareWorkZone(f.store, f.request)), original = ok(readWorkZone(f.store, f.request));
  const peer = new Store(f.database);
  try {
    for (const guard of prepared.guards) {
      const row = peer.get(guard.id)!;
      peer.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
      denied(writeGuarded(f.store, { unit: 'F2', target: 'zone-neighbor', guards: [guard],
        writes: [{ id: 'zone-neighbor', kind: 'test', expected: 0, value: { operations: prepared.operations } }] }), 'input_stale');
    }
    denied(writeGuarded(f.store, { unit: 'F2', target: 'zone-neighbor', guards: prepared.guards,
      writes: [{ id: 'zone-neighbor', kind: 'test', expected: 0, value: { operations: prepared.operations } }] }), 'input_stale');
    assert.equal(f.store.get('zone-neighbor'), null);
    denied(prepareWorkZone(f.store, f.request), 'input_stale');
    assert.deepEqual(ok(readWorkZone(f.store, f.request)), original);
  } finally { peer.close(); }
  const reopened = new Store(f.database);
  try { assert.deepEqual(ok(readWorkZone(reopened, f.request)), original); denied(prepareWorkZone(reopened, f.request), 'input_stale'); }
  finally { reopened.close(); }
});

test('F1 does not disguise storage or execution exceptions as missing readiness', t => {
  const f = nativeZone(t), before = snapshot(f.store);
  for (const error of [new TypeError('broken source'), new EngineError('record_corrupt', 'broken database')]) {
    const faulty = new Proxy(f.store, { get(target, key) {
      if (key === 'get') return () => { throw error; };
      const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    for (const action of [readWorkZone, prepareWorkZone]) assert.throws(() => action(faulty, f.request), value => value === error);
  }
  assert.deepEqual(snapshot(f.store), before);
});

test('F1 preserves the historical engine era without a frame and excludes ready blocks using real receipts even with an accepted L3', async t => {
  const f = await createOmFixture(t), store = f.store;
  const input = ok(writeOmInput(store, { project: f.project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> }));
  const horizon = ok(writeHorizon(store, { project: f.project, input: reference(input), graph: reference(f.graphRevision),
    refinement: reference(store.get('phase:garden:L2')!), choice: { choiceVersion: 'zone-ready', features: [{ outcome: 'garden-result' }], excluded: [] },
    available: { [consumer]: { 'garden-result': reference(f.receipts['garden-result']!) } } }));
  const request: WorkZoneRequest = { project: f.project, graph: reference(f.graphRevision), layer: reference(f.layers[2]),
    horizon: reference(horizon.gate), frame: null };
  const read = ok(readWorkZone(store, request)), prepared = ok(prepareWorkZone(store, request));
  assert.deepEqual(read.operations, [prepOp, produceOp]);
  assert.deepEqual(prepared.operations, read.operations);
  assert.deepEqual(ok(readFrameBasis(store, { project: f.project, level: 3, graph: request.graph, horizon: request.horizon,
    layer: null, frame: null, upper: { horizon: request.horizon, frame: null } })).scope.nodes, read.operations);
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(f.receipts['garden-result']!))));
  const layer3 = store.get('graph-layer:garden:3')!;
  store.write({ id: layer3.id, kind: layer3.kind, expected: layer3.revision, value: layer3.value });
  assert.deepEqual(ok(prepareWorkZone(store, request)).operations, read.operations, 'F1 does not admit the lower work layer');
  const receipt = store.get(f.receipts['garden-result']!.id)!;
  store.write({ id: receipt.id, kind: receipt.kind, expected: receipt.revision, value: receipt.value });
  denied(prepareWorkZone(store, request), 'input_stale');
  assert.deepEqual(ok(readWorkZone(store, request)), read);
  f.reopen();
  assert.deepEqual(ok(readWorkZone(f.store, request)), read);
  denied(prepareWorkZone(f.store, request), 'input_stale');
});

/** This function runs in another process under the exact accepted producer, not under today's validators. */
async function producePreWorkZoneHistory(database: string, lowerBridge: boolean) {
  const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
  const { hashJson } = await import('../src/canonical.js');
  const { reference } = await import('../src/pipeline/contracts.js');
  const { Store } = await import('../src/storage/store.js');
  const { ProductEngine } = await import('../src/product/engine.js');
  const { projectGraph } = await import('../src/graph/project.js');
  const { UPSTREAM_STAGES } = await import('../src/discovery/requirements.js');
  const { writeOmInput } = await import('../src/om/input.js');
  const { writeHorizon } = await import('../src/om/horizon.js');
  const { prepareFrame, readFrame, fillObligations } = await import('../src/om/frame-obligations.js');
  const { writeCandidate, gateCandidate } = await import('../src/om/frame-candidate.js');
  const { settleCandidate } = await import('../src/om/frame-accept.js');
  const { writeGaps, readGaps } = await import('../src/om/gaps.js');
  const { writeGapLines } = await import('../src/om/gap-lines.js');
  const { gardenGraph } = await import('./om-fixture.js');
  const { preparedFeatures } = await import('./product-fixture.js');
  const { preparedField } = await import('./preparation-fixture.js');
  const accepted = <T>(result: OmResult<T>): T => {
    if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
    return result.value;
  };
  const store = new Store(database);
  try {
    const graph = gardenGraph(), producer = 'garden-produce-block', later = 'garden-later-block';
    const outside = 'garden-refusal-operation';
    graph.edges!.push({ id: 'refusal-realizes-consumer', relation: 'realizes', source: outside,
      target: 'garden-consume-block', condition: 'The refusal operation also refines the consumer role' });
    const remap = (value: Json, suffix: string): Json => {
      const names: Record<string, string> = { 'garden-result': `garden-${suffix}`, 'garden-R1': `garden-R-${suffix}`,
        'garden-B1': `garden-B-${suffix}`, 'garden-concept': `garden-concept-${suffix}`, 'Deliver result': `Deliver ${suffix}` };
      if (typeof value === 'string') return names[value] ?? value;
      if (Array.isArray(value)) return value.map(item => remap(item, suffix));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, suffix)]));
      return value;
    };
    const fields = (field: string): Json => {
      const basic = preparedField('garden', field), variants = [basic, ...['later', 'data'].map(suffix => remap(basic, suffix))];
      if (['conceptSections', 'behaviorContracts', 'featurePreparation', 'features'].includes(field))
        return variants.flatMap(value => value as Json[]);
      if (field === 'preparation' || field === 'operationRequirements') {
        const value = structuredClone(basic) as Record<string, Json>;
        for (const key of field === 'preparation' ? ['outcomes'] : ['outcomes', 'conceptCoverage'])
          value[key] = variants.flatMap(item => (item as Record<string, Json>)[key] as Json[]);
        return value;
      }
      return basic;
    };
    const requirement = graph.requirements![0]!;
    graph.requirements!.push(...['later', 'data'].map(suffix => remap(requirement as unknown as Json, suffix) as unknown as typeof requirement));
    for (const node of graph.nodes) node.implements!.push('garden-R-later', 'garden-R-data');
    graph.journeys!.push({ id: 'garden-data-feature', actor: 'garden-user', variant: 'success', entry: producer,
      path: [producer], outcome: 'garden-data', terminal: 'success' });
    const { level: _level, ...projection } = projectGraph(graph, 1);
    preparedFeatures(new ProductEngine(store), 'garden', projection as Graph, fields);
    const input = accepted(writeOmInput(store, { project: 'garden', expected: 0,
      stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
    const initial = accepted(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(store.get('graph:garden')!),
      refinement: null, choice: { choiceVersion: 'history-first', features: [{ outcome: 'garden-result' }], excluded: [] }, available: {} }));
    const original: FrameRequest = { project: 'garden', level: 2, graph: reference(store.get('graph:garden')!),
      horizon: reference(initial.gate), layer: null, frame: null, upper: null };
    const prepared = accepted(prepareFrame(store, original)), design = projectGraph(graph, 2);
    const nodes = design.nodes.filter(node => node.kind === 'operation' && node.parent !== later);
    const included = new Set(nodes.map(node => node.id));
    const mapped = accepted(fillObligations(prepared.upper as Graph, prepared.scope as FrameScope,
      { graph, reference: { ...original.graph, hash: hashJson(graph) }, frame: null }, prepared.upperRef, 2));
    const proposal: LayerProposal = { base: { graph: original.graph, frame: null }, level: 2, source: 'decision', status: 'proposed',
      nodes, fills: mapped.fills.filter(fill => included.has(fill.node)).map(fill => ({ obligation: fill.obligation, node: fill.node,
        ...(fill.port === undefined ? {} : { port: fill.port }) })),
      localConnectors: design.connectors.filter(connector => !prepared.upper.connectors.some(upper => upper.id === connector.id))
        .map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) })),
      artifacts: design.artifacts, contracts: design.contracts, joins: design.joins, tests: design.tests,
      edges: design.edges ?? [], journeys: design.journeys ?? [], packets: design.packets ?? [], transfers: design.transfers ?? [],
      anchors: design.anchors, removes: [], replaces: [], redefines: [] };
    const offered = store.write({ id: 'om-proposal:garden:history-work-zone', kind: 'layer-proposal', expected: 0, value: proposal });
    const candidate = accepted(writeCandidate(store, { frame: original, proposals: [reference(offered)] }));
    assert.equal(candidate.state, 'candidate'); if (candidate.state !== 'candidate') throw new Error('Missing candidate');
    const candidateRef = reference(candidate.record), gate = accepted(gateCandidate(store, { project: 'garden', candidate: candidateRef }));
    assert.equal(gate.passed, true);
    const settled = accepted(settleCandidate(store, { project: 'garden', level: 2, candidate: candidateRef,
      outcome: { gate: 'G3', candidate: candidateRef, graphHash: gate.graphHash, passed: gate.passed, codes: [] } }));
    assert.ok(settled.graph && settled.layer && settled.frame);
    const horizon = accepted(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(settled.graph),
      refinement: reference(settled.layer), choice: { choiceVersion: 'history-lower-bridge', features: [{ outcome: 'garden-data' }], excluded: [] }, available: {} }));
    let graphRef = reference(settled.graph);
    if (lowerBridge) {
      const lower = structuredClone(settled.graph.value) as Graph;
      lower.nodes.push(structuredClone(graph.nodes.find(node => node.id === 'garden-produce-work')!));
      lower.edges!.push({ id: 'outside-via-unaccepted-work', relation: 'realizes', source: outside,
        target: 'garden-produce-work', condition: 'An unaccepted lower layer connects the outside operation' });
      assert.deepEqual(projectGraph(lower, 2), projectGraph(settled.graph.value as Graph, 2));
      graphRef = reference(store.write({ id: settled.graph.id, kind: settled.graph.kind, expected: settled.graph.revision, value: lower }));
    }
    const operations: FrameRequest = { ...original, graph: graphRef, layer: reference(settled.layer),
      frame: reference(settled.frame), horizon: reference(horizon.gate) };
    const works: FrameRequest = { ...operations, level: 3, layer: null, frame: null,
      upper: { horizon: operations.horizon, frame: reference(settled.frame) } };
    const sources: GapRequest = { project: 'garden', input: reference(input), graph: graphRef, horizon: operations.horizon,
      operations: { frame: operations, proposals: [] }, works: { frame: works, proposals: [] } };
    const oldFrame = accepted(readFrame(store, works)), gaps = accepted(writeGaps(store, sources));
    const read: GapReadRequest = { sources, records: gaps.records.map(reference) };
    accepted(readGaps(store, read));
    const lines = accepted(writeGapLines(store, { project: 'garden', previous: null, pass: 1, gaps: read, closures: [] }));
    return { read, works, zone: oldFrame.scope.nodes, collection: gaps.collection, lines: reference(lines),
      request: { project: 'garden', graph: graphRef, layer: reference(settled.layer), frame: reference(settled.frame), horizon: operations.horizon } };
  } finally { store.close(); }
}

function preWorkZoneHistory(t: TestContext, lowerBridge: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'omg-work-zone-era-')), database = join(root, 'state.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const loader = join(root, 'accepted-producer-loader.mjs');
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  // Compile the accepted producer directly from Git. The loader changes no checkout, source or dist file.
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from ${JSON.stringify(typescript)};
let root;
export function initialize(data) { root = data.root; }
export async function load(url, context, next) {
  const prefix = new URL('dist/', root).href;
  if (url.startsWith(prefix) && /\\.js$/.test(url)) {
    const relative = url.slice(prefix.length).replace(/\\.js$/, '.ts');
    const source = execFileSync('git', ['show', 'ff8737d336f8069059b8dcd0fef5d69c5e31fef7:' + relative],
      { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return next(url, context);
}
`);
  const repositoryUrl = pathToFileURL(repository).href;
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, { data: { root: ${JSON.stringify(repositoryUrl)} } });`;
  const producer = producePreWorkZoneHistory.toString()
    .replace(/import\((["'])\.\.\/src\/([^"']+)\1\)/g, (_match, _quote: string, name: string) =>
      `import(${JSON.stringify(new URL(`dist/src/${name}`, repositoryUrl).href)})`)
    .replace(/import\((["'])\.\/([^"']+)\1\)/g, (_match, _quote: string, name: string) =>
      `import(${JSON.stringify(new URL(`dist/test/${name}`, repositoryUrl).href)})`);
  const output = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`,
    '--input-type=module', '--eval', `process.stdout.write(JSON.stringify(await (${producer})(${JSON.stringify(database)}, ${lowerBridge})));`],
  { cwd: repository, encoding: 'utf8', maxBuffer: 10_000_000 });
  return { database, ...JSON.parse(output) as Awaited<ReturnType<typeof producePreWorkZoneHistory>> };
}

test('F1 historical D1 and D2 from the accepted old producer retain the lower bridge after restart while new preparation excludes it', t => {
  const history = preWorkZoneHistory(t, true);
  assert.deepEqual(history.zone, [prepOp, produceOp, 'garden-refusal-operation']);
  assert.equal(history.read.records.length, 16);
  assert.equal(Object.hasOwn(history.works, 'workZoneContract'), false);
  for (let restart = 0; restart < 2; restart++) {
    const store = new Store(history.database);
    try {
      const before = snapshot(store), historical = ok(readFrameBasis(store, history.works));
      assert.deepEqual(historical.scope.nodes, history.zone);
      assert.deepEqual(ok(readGaps(store, history.read)).collection, history.collection);
      ok(readGapLines(store, { project: 'garden', record: history.lines }));
      assert.deepEqual(ok(readWorkZone(store, history.request)).operations, [prepOp, produceOp]);
      const current = ok(prepareFrame(store, history.works));
      assert.equal(current.request.workZoneContract, 'accepted-l2-v1');
      assert.deepEqual(current.scope.nodes, [prepOp, produceOp]);
      const gaps = ok(prepareGaps(store, history.read.sources));
      assert.ok('frame' in gaps.sources.works);
      assert.equal(gaps.sources.works.frame.workZoneContract, 'accepted-l2-v1');
      assert.ok(gaps.collection.gaps.length < history.collection.gaps.length);
      denied(prepareCurrentGaps(store, history.read));
      assert.deepEqual(snapshot(store), before, 'Historical read and current preparation cannot rewrite the former era');
    } finally { store.close(); }
  }
});

test('F1 current D1 admission distinguishes identical collections from different eras until the new sources are explicitly saved', t => {
  const history = preWorkZoneHistory(t, false), store = new Store(history.database);
  t.after(() => store.close());
  const old = ok(readGaps(store, history.read)), before = snapshot(store);
  const prepared = ok(prepareGaps(store, history.read.sources));
  assert.deepEqual(prepared.collection, old.collection, 'The distinction is the producer contract, not a conveniently different result');
  assert.ok(prepared.writes.length > 0);
  denied(prepareCurrentGaps(store, history.read));
  assert.deepEqual(snapshot(store), before);
  const written = ok(writeGaps(store, history.read.sources));
  assert.ok('frame' in written.sources.works);
  assert.equal(written.sources.works.frame.workZoneContract, 'accepted-l2-v1');
  const current: GapReadRequest = { sources: structuredClone(written.sources) as GapRequest, records: written.records.map(reference) };
  ok(prepareCurrentGaps(store, current));
  denied(readGaps(store, { sources: current.sources, records: history.read.records }));
  denied(readGaps(store, { sources: history.read.sources, records: current.records }));
  const after = snapshot(store);
  const restarted = new Store(history.database);
  try {
    assert.deepEqual(ok(readGaps(restarted, history.read)).collection, old.collection);
    ok(readGapLines(restarted, { project: 'garden', record: history.lines }));
    denied(prepareCurrentGaps(restarted, history.read));
    ok(prepareCurrentGaps(restarted, current));
    assert.deepEqual(ok(writeGaps(restarted, current.sources)), written);
    assert.deepEqual(snapshot(restarted), after);
  } finally { restarted.close(); }
});
