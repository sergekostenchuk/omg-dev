import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test, { type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { Evidence } from '../src/evidence/evidence.js';
import { Environments, git, inspectRepository } from '../src/runtime/environment.js';
import { ensureWorktree } from '../src/execution/worktree.js';
import type { MachinePlan } from '../src/compiler/model.js';
import { EngineError } from '../src/errors.js';
import type { Feasibility } from '../src/graph/refinement.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { isRef, reference, type Ref, type GateResult, type StageArtifact, type StageProjection } from '../src/pipeline/contracts.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { observeRuntime, runtimeContext, runtimeObligationId } from '../src/runtime/runtime-observation.js';
import type { CarriedObligation } from '../src/graph/obligation-policy.js';
import { readReadinessObligations, type ReadinessObligations } from '../src/graph/obligation-readiness.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Write, type Revision } from '../src/storage/store.js';
import { inputDecisionWrite, writeAddressing, type InputDecisionProposal } from '../src/om/addressing.js';
import { writeAtomicGate, writeWorksAcceptance, type AtomicGateRequest } from '../src/om/atomic-gate.js';
import { settleCandidate, readAcceptedFrame } from '../src/om/frame-accept.js';
import { writeCandidate } from '../src/om/frame-candidate.js';
import { fillObligations, prepareFrame, type FrameRequest, type FrameRead } from '../src/om/frame-obligations.js';
import type { LayerProposal, ProposalRequest } from '../src/om/frame-proposals.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { gapLineKey, gapLineExpectedResult, writeGapLines } from '../src/om/gap-lines.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeOmInput } from '../src/om/input.js';
import { writeNeighbors } from '../src/om/neighbors.js';
import { OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND, normalizeOwnerGapAssignment,
  writeOmObligations, readOmObligations } from '../src/om/obligations.js';
import { runModelCycle, readPartAssembly } from '../src/om/model-call.js';
import { writeQuestionPacket, type PartProposalBody } from '../src/om/question-packet.js';
import { writeRoutes } from '../src/om/routes.js';
import { openSeries, beginAttempt } from '../src/om/series.js';
import { writeWorksFrame, readWorksFrame } from '../src/om/works-frame.js';
import type { OmResult } from '../src/om/refusal.js';
import { prepareFeasibility, writeFeasibility, readFeasibility, gateFeasibility, type OmFeasibility } from '../src/om/feasibility.js';
import { writeGuarded, readRecord, type GuardedWrite } from '../src/om/refs.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';
const clone = structuredClone;
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message} ${canonical(result.refusal.at)}`);
  return result.value;
}

function addressFixtureFields(store: Store, project: string, input: Ref, graph: Ref, layers: Ref[], extra: InputDecisionProposal['decision'][] = []) {
  const decisions: InputDecisionProposal['decision'][] = [
    { target: `${project}-B1`, field: 'nodes', value: [`${project}-produce-block`, `${project}-consume-block`] },
    { target: `${project}-B1`, field: 'state', value: { writer: `${project}-produce-block`, authority: `${project}-consume-block`, rollback: `${project}-consume-block` } },
    { target: `${project}-R1#1`, field: 'checkKind', value: 'test' }, ...extra,
  ];
  return ok(writeAddressing(store, { project, input, graph,
    decisions: decisions.map(decision => ({ pending: inputDecisionWrite({ project, input, graph, layers: decision.field === 'address' ? layers : [], decision }) as Write })) }));
}


function acceptedOperationsFixture(t: TestContext, codeStatus: 'planned' | 'existing' = 'planned', runtimeCount = 0) {
  const root = mkdtempSync(join(tmpdir(), 'omg-g1-accepted-')), database = join(root, 'state.sqlite'), project = 'garden';
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'README.md'), 'A deterministic local M8 fixture.\n');
  git(workspace, ['init', '-q']);
  git(workspace, ['-c', 'user.name=OMG Test', '-c', 'user.email=test@example.invalid', 'add', 'README.md']);
  git(workspace, ['-c', 'user.name=OMG Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture baseline']);
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const desired = enrichedGraph(exampleGraph(), project);
  const work = desired.nodes.find(node => node.id === 'garden-consume-work')!;
  for (const code of work.code) code.status = codeStatus;
  for (const connector of desired.connectors) for (const binding of connector.bindings)
    for (const endpoint of [binding.producer, ...binding.consumers])
      if (endpoint.node === work.id && endpoint.codeRef) endpoint.codeRef.status = codeStatus;
  for (const proof of desired.tests) if (proof.node === work.id && proof.contract) proof.contract.entrypoint.status = codeStatus;
  desired.artifacts.find(artifact => artifact.id === 'garden-data')!.external = true;
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (runtimeCount && field === 'preparation') (value as Record<string, Json>).unknowns = Array.from({ length: runtimeCount }, (_, index) => ({
      id: index ? `runtime-ready-${index}` : 'runtime-ready', question: `Is explicitly declared local runtime condition ${index} ready before planning?`,
      consumer: 'garden-consume-operation', moment: 'feasibility', blocksCurrentStage: false,
      resolution: 'Observe the declared local runtime predicate before M8' }));
    return value;
  });
  let input = ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const first = ok(writeHorizon(store, { project, input: reference(input), graph: reference(store.get(`graph:${project}`)!),
    refinement: null, available: {}, choice: { choiceVersion: 'external-upper', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  function proposal(frame: FrameRead): Ref {
    const graph = clone(desired), level = frame.request.level;
    if (level === 3) {
      for (const field of ['nodes', 'artifacts', 'contracts', 'anchors', 'joins', 'tests', 'edges', 'journeys', 'packets', 'transfers'] as const) {
        const upper = frame.upper[field] ?? [], ids = new Set(upper.map(item => item.id));
        Object.assign(graph, { [field]: [...clone(upper), ...(graph[field] ?? []).filter(item => !ids.has(item.id))] });
      }
      graph.connectors = frame.upper.connectors.map(upper => ({ ...clone(upper), bindings: [...clone(upper.bindings),
        ...desired.connectors.find(connector => connector.id === upper.id)!.bindings.filter(binding => binding.level === 3)] }));
    }
    const projected = projectGraph(graph, level), mapped = ok(fillObligations(frame.upper, frame.scope, {
      graph, reference: { ...frame.request.graph, hash: hashJson(graph) }, frame: null }, frame.upperRef, level));
    const nodes = projected.nodes.filter(node => node.kind === (level === 2 ? 'operation' : 'work')
      && (level === 2 || frame.scope.nodes.includes(node.parent!))), selected = new Set(nodes.map(node => node.id));
    const value: LayerProposal = { base: { graph: frame.request.graph, frame: null }, level,
      ...(level === 3 ? { worksContract: 'works-frame/v1' as const } : {}), source: 'decision', status: 'proposed', nodes,
      fills: mapped.fills.filter(fill => selected.has(fill.node)).map(fill => ({ obligation: fill.obligation, node: fill.node,
        ...(fill.port === undefined ? {} : { port: fill.port, ...(level === 3 ? { codeRef: clone(nodes.find(node => node.id === fill.node)!.code[0]!) } : {}) }) })),
      localConnectors: level === 3 ? [] : projected.connectors.map(connector => ({ ...connector,
        bindings: connector.bindings.filter(binding => binding.level === 2) })).filter(connector => connector.bindings.length),
      artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
      tests: projected.tests.filter(test => level === 2 || selected.has(test.node)), edges: projected.edges ?? [],
      journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
      anchors: level === 2 ? projected.anchors : [], removes: [], replaces: [], redefines: [] };
    return reference(store.write({ id: `om-proposal:garden:external-${level}`, kind: 'layer-proposal', expected: 0, value }));
  }
  const frame2: FrameRequest = { project, level: 2, graph: reference(store.get('graph:garden')!), horizon: reference(first.gate),
    layer: null, frame: null, upper: null };
  const proposal2 = proposal(clone(ok(prepareFrame(store, frame2))) as unknown as FrameRead);
  const upperCandidate = ok(writeCandidate(store, { frame: frame2, proposals: [proposal2] }));
  assert.equal(upperCandidate.state, 'candidate'); if (upperCandidate.state !== 'candidate') throw new Error('Missing native L2 candidate');
  const upperRef = reference(upperCandidate.record);
  const accepted = ok(settleCandidate(store, { project, level: 2, candidate: upperRef,
    outcome: { gate: 'G3', candidate: upperRef, graphHash: upperCandidate.record.value.graphHash, passed: true, codes: [] } }));
  const graph = reference(accepted.graph!), layer = reference(accepted.layer!), upperFrame = reference(accepted.frame!);
  input = addressFixtureFields(store, project, reference(input), graph, [layer], Array.from({ length: runtimeCount }, (_, index) => ({
    target: index ? `discovery:runtime-ready-${index}` : 'discovery:runtime-ready',
    field: 'address', value: { consumer: 'garden-consume-operation', kind: 'environment-confirmation' } })));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph, refinement: layer,
    available: {}, choice: { choiceVersion: 'external-works', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const basis = ok(prepareFrame(store, { project, level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
    upper: { horizon: reference(horizon.gate), frame: upperFrame } }));
  return { root, workspace, database, project, desired, basis, frame2, graph, layer, upperFrame, input, horizon, proposal,
    get store() { return store; }, get engine() { return engine; },
    restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); } };
}

/** Real C3/C4/C5, D1/D2/D7 and F2/F4/G5 sources; no model or adapter is called. */
function acceptedWorksFixture(t: TestContext, codeStatus: 'planned' | 'existing' = 'planned', snapshot?: 'head' | null) {
  const base = acceptedOperationsFixture(t, codeStatus);
  const { root, workspace, database, project, basis, frame2, graph, layer, upperFrame, input, horizon, proposal, store, engine } = base;
  const works: ProposalRequest = { frame: clone(basis.request) as FrameRequest, proposals: [proposal(clone(basis) as unknown as FrameRead)] };
  const gaps = ok(writeGaps(store, { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { frame: { ...frame2, graph, layer, frame: upperFrame, horizon: reference(horizon.gate) }, proposals: [] }, works }));
  const gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const handoff = ok(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [] }));
  assert.deepEqual(handoff.handoff.obligations, []);
  const candidate = ok(writeWorksFrame(store, { ...works, works: { contract: 'works-frame/v1',
    producer: reference(handoff.producer), ledger: reference(handoff.record), bindings: [] } }));
  assert.equal(candidate.state, 'candidate'); if (candidate.state !== 'candidate') throw new Error('Missing native external-input candidate');
  const neighbors = ok(writeNeighbors(store, { project, candidate: reference(candidate.record) }));
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = engine.environments.configure(project, { workspace,
    implementer: { actor: 'external-producer', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'external-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command,
    timeoutMs: 5000, requestCapacityChars: 200_000 }, 0);
  const path = join(workspace, 'input.txt'); writeFileSync(path, 'A captured external input');
  const source = new Evidence(store).file(project, 'garden-data', workspace, 'input.txt', 'text/plain', 0);
  git(workspace, ['add', 'input.txt']);
  git(workspace, ['-c', 'user.name=OMG Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'capture input']);
  const request: AtomicGateRequest = { project, candidate: reference(candidate.record), neighbors: reference(neighbors),
    environment: reference(environment), gaps: gapRead, results: [], sources: [reference(source)],
    ...(snapshot === undefined ? {} : { snapshot: snapshot === 'head' ? resolveSnapshot(workspace) : null }) };
  assert.deepEqual(candidate.record.value.graph.horizon, ['garden-consume-work']);
  assert.equal(store.get('execution-root:garden'), null);
  const gate = ok(writeAtomicGate(store, request));
  assert.equal(gate.value.result.passed, true, canonical(gate.value.result.findings));
  const settled = ok(settleCandidate(store, { project, level: 3, candidate: reference(candidate.record),
    outcome: { ...gate.value.result, codes: [...gate.value.result.codes], basis: reference(gate) } }));
  assert.equal(settled.state, 'accepted'); assert.ok(settled.graph && settled.layer && settled.frame);
  const acceptance = { project, level: 3 as const, graph: reference(settled.graph),
    layer: reference(settled.layer), frame: reference(settled.frame) };
  const acceptedFrame = { ...clone(candidate.record.value.request.frame),
    graph: acceptance.graph, layer: acceptance.layer, frame: acceptance.frame };
  return { root, workspace, database, project, path, source, candidate, request, gate, acceptance,
    acceptedFrame, handoff, horizon: reference(horizon.gate), gapRead, environment,
    feasibility: { project, graph: acceptance.graph, layer: acceptance.layer, frame: acceptance.frame,
      environment: reference(environment), expected: 0 },
    get store() { return base.store; }, restart: base.restart };
}


const heads = (store: Store) => store.list().map(reference);
function denied(result: OmResult<unknown>, code: string): void {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected an addressed refusal');
  assert.equal(result.refusal.code, code, result.refusal.message);
  assert.ok(result.refusal.at.target);
}

test('G1 prepares and writes real accepted works with complete empty D7 and planned missing paths', t => {
  const f = acceptedWorksFixture(t), before = heads(f.store);
  const graph = f.store.get<Graph>(f.acceptance.graph.id, f.acceptance.graph.revision)!;
  assert.deepEqual(graph.value.horizon, ['garden-consume-work']);
  const supplied = clone(f.feasibility), requestBytes = canonical(supplied);
  const prepared = ok(prepareFeasibility(f.store, supplied));
  assert.equal(canonical(supplied), requestBytes, 'Preparation preserves the complete caller request');
  supplied.graph.hash = hashJson('Caller mutation after preparation');
  assert.deepEqual(prepared.record.value.graph, f.acceptance.graph, 'Returned provenance shares no mutable reference with the request');
  assert.throws(() => { (prepared.record.value.producer.frame as unknown as { hash: string }).hash = hashJson('DTO mutation'); }, TypeError);
  assert.deepEqual(heads(f.store), before, 'Preparation does not write feasibility or change any source');
  assert.equal(prepared.record.id, `om-feasibility:${f.project}`);
  assert.equal(prepared.record.kind, 'feasibility');
  const value = prepared.record.value;
  assert.equal(value.contractVersion, 2); assert.equal(value.ready, true, canonical(value.findings));
  assert.deepEqual(value.findings, []); assert.deepEqual(prepared.refusals, []);
  assert.deepEqual(value.graph, f.acceptance.graph); assert.deepEqual(value.environment, reference(f.environment));
  assert.equal(value.producer.contract, 'om-m8/v2');
  assert.deepEqual(value.producer.layer, f.acceptance.layer);
  assert.deepEqual(value.producer.frame, f.acceptance.frame);
  assert.deepEqual(value.producer.horizon, f.horizon);
  assert.deepEqual(value.producer.candidate, reference(f.candidate.record));
  assert.deepEqual(value.producer.obligations, { producer: reference(f.handoff.producer), ledger: reference(f.handoff.record) });
  assert.deepEqual(value.producer.readiness, { handoff: f.handoff.handoff, confirmations: [] });
  for (const ref of [reference(f.handoff.producer), reference(f.handoff.record)]) {
    assert.ok(value.inputs.some(input => canonical(input) === canonical(ref)), `The saved input retains ${ref.id}`);
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)), `The transaction guards ${ref.id}`);
  }
  assert.ok(value.inputs.every(isRef), 'Saved inputs never contain negative admission guards');
  assert.ok(prepared.guards.some(guard => guard.id === `execution-root:${f.project}` && 'absent' in guard));
  assert.deepEqual(value.repository?.files.find(file => file.path === 'consume.txt'), { path: 'consume.txt', hash: null });
  assert.deepEqual(f.store.get(graph.id, graph.revision), graph);
  const saved = ok(writeFeasibility(f.store, f.feasibility));
  assert.deepEqual(saved, prepared.record);
  assert.equal(f.store.get(`feasibility:${f.project}`), null, 'OM M8 has its own unambiguous producer address');
  assert.deepEqual(ok(writeFeasibility(f.store, f.feasibility)), saved);
  f.restart();
  assert.deepEqual(ok(writeFeasibility(f.store, f.feasibility)), saved);
  assert.equal(f.store.history(saved.id).length, 1, 'An exact current repeat never creates another result');
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(saved) })), saved,
    'The explicit empty D7 and confirmations remain valid historical values after restart');
});

test('G1 late exact write repeat returns its original M8 revision after a newer negative result and restart', t => {
  const f = acceptedWorksFixture(t);
  const first = ok(writeFeasibility(f.store, f.feasibility));
  assert.equal(first.revision, 1); assert.equal(first.value.ready, true);
  const firstBytes = canonical(first);
  writeFileSync(join(f.workspace, 'late-repeat-dirty.txt'), 'Physical conditions changed after the first result');
  const second = ok(writeFeasibility(f.store, { ...f.feasibility, expected: first.revision }));
  assert.equal(second.revision, 2); assert.equal(second.value.ready, false);
  assert.ok(second.value.findings.some(item => item.code === 'repository_dirty'));
  f.restart();
  const before = heads(f.store);
  const repeated = ok(writeFeasibility(f.store, f.feasibility));
  assert.deepEqual(repeated, first); assert.equal(canonical(repeated), firstBytes);
  assert.deepEqual(f.store.get(first.id), second, 'The old operation never replaces the newer head');
  assert.equal(f.store.history(first.id).length, 2);
  assert.deepEqual(heads(f.store), before, 'A late exact repeat performs no writes');
  denied(gateFeasibility(f.store, { project: f.project, record: reference(first) }), 'feasibility_stale');
  assert.deepEqual(f.store.get(first.id), second);
  rmSync(join(f.workspace, 'late-repeat-dirty.txt'));
  const third = ok(writeFeasibility(f.store, { ...f.feasibility, expected: second.revision }));
  assert.deepEqual(third.value, first.value, 'The same physical facts can recur under a later M8 head');
  denied(gateFeasibility(f.store, { project: f.project, record: reference(first) }), 'input_stale');
  assert.deepEqual(ok(writeFeasibility(f.store, f.feasibility)), first);
  assert.deepEqual(f.store.get(first.id), third);
});

test('G1 carries absent execution-root through a native second-Store creator into the shared atomic write', t => {
  const f = acceptedWorksFixture(t), prepared = ok(prepareFeasibility(f.store, f.feasibility));
  assert.equal(prepared.record.value.ready, true);
  assert.ok(prepared.record.value.repository);
  const other = new Store(f.database);
  try {
    const root = ensureWorktree(other, new Environments(other), {
      projectId: f.project, base: prepared.record.value.repository,
    } as MachinePlan);
    assert.equal(root.value.state, 'ready');
  } finally { other.close(); }
  const neighbor = { id: 'g1-neighbor:atomic', kind: 'g1-neighbor', expected: 0, value: { admitted: true } };
  const written = writeGuarded(f.store, { unit: 'M8', target: prepared.record.id,
    writes: [...prepared.writes, neighbor], guards: prepared.guards });
  denied(written, 'input_stale');
  if (!written.ok) assert.equal(written.refusal.at.target, `execution-root:${f.project}`);
  assert.equal(f.store.get(prepared.record.id), null);
  assert.equal(f.store.get(neighbor.id), null, 'A stale absence leaves no partial neighboring write');
});

test('G1 proves an existing managed root and guards the exact selected workspace without requiring its old revision', t => {
  const f = acceptedWorksFixture(t), initial = ok(prepareFeasibility(f.store, f.feasibility));
  const root = ensureWorktree(f.store, new Environments(f.store),
    { projectId: f.project, base: initial.record.value.repository } as MachinePlan);
  const originalWorkspace = f.store.get(`workspace:${f.project}`)!;
  const workspace = f.store.write({ id: originalWorkspace.id, kind: originalWorkspace.kind,
    expected: originalWorkspace.revision, value: originalWorkspace.value });
  const prepared = ok(prepareFeasibility(f.store, f.feasibility));
  assert.equal(prepared.record.value.ready, true);
  assert.equal(prepared.record.value.repository!.root, realpathSync(root.value.path));
  assert.deepEqual(prepared.record.value.producer.inspection.executionRoot, reference(root));
  assert.deepEqual(prepared.record.value.producer.inspection.workspace, reference(workspace));
  for (const ref of [reference(root), reference(workspace)])
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)));
  const saved = ok(writeFeasibility(f.store, f.feasibility));
  const next = ok(prepareFeasibility(f.store, { ...f.feasibility, expected: saved.revision }));
  const other = new Store(f.database);
  try { other.write({ id: workspace.id, kind: workspace.kind, expected: workspace.revision, value: workspace.value }); }
  finally { other.close(); }
  const neighbors = ['g1-workspace-neighbor:a', 'g1-workspace-neighbor:b'].map(id => ({ id, kind: 'neighbor', expected: 0, value: {} }));
  denied(writeGuarded(f.store, { unit: 'M8', target: saved.id, guards: next.guards, writes: neighbors }), 'input_stale');
  for (const { id } of neighbors) assert.equal(f.store.get(id), null);
  f.restart();
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('G1 public requests reject malformed Store, absent fields and inexact references before reading storage', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-g1-arguments-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const ref: Ref = { id: 'record', revision: 1, hash: hashJson('source') };
  const request = { project: 'garden', graph: ref, layer: ref, frame: ref, environment: ref, expected: 0 };
  const error = (value: unknown) => value instanceof EngineError && value.code === 'feasibility_request_invalid';
  for (const operation of [prepareFeasibility, writeFeasibility]) {
    assert.throws(() => operation(null as unknown as Store, request), error);
    for (const bad of [undefined, null, false, [], {}, { ...request, project: '' }, { ...request, expected: -1 },
      { ...request, expected: 0.5 }, ...['graph', 'layer', 'frame', 'environment'].flatMap(field => [
        { ...request, [field]: null }, { ...request, [field]: { id: ref.id, hash: ref.hash } },
      ])]) {
      let reads = 0; const get = store.get.bind(store);
      store.get = (() => { reads++; throw new Error('Malformed requests must not read Store'); }) as Store['get'];
      try { assert.throws(() => operation(store, bad as unknown as typeof request), error); assert.equal(reads, 0); }
      finally { store.get = get; }
    }
    for (const field of Object.keys(request)) {
      const omitted = { ...request } as Record<string, unknown>; delete omitted[field];
      assert.throws(() => operation(store, omitted as unknown as typeof request), error);
    }
  }
  assert.throws(() => readFeasibility(null as unknown as Store, { project: 'garden', record: ref }), error);
  for (const request of [undefined, null, {}, { project: 'garden' }, { record: ref }, { project: '', record: ref },
    { project: 'garden', record: { id: ref.id, revision: 1 } }]) {
    let reads = 0; const get = store.get.bind(store);
    store.get = (() => { reads++; throw new Error('Malformed historical requests must not read Store'); }) as Store['get'];
    try { assert.throws(() => readFeasibility(store, request as unknown as Parameters<typeof readFeasibility>[1]), error); assert.equal(reads, 0); }
    finally { store.get = get; }
  }
  assert.deepEqual(store.list(), []);
});

test('G1 own namespace never treats omitted producer, provenance or empty readiness as legacy', t => {
  const f = acceptedWorksFixture(t), saved = ok(writeFeasibility(f.store, f.feasibility));
  const changes: ((value: Record<string, unknown>) => void)[] = [
    value => { delete value['producer']; },
    ...['graph', 'environment', 'obligations'].flatMap(field => [
      (value: Record<string, unknown>) => { delete value[field]; },
      (value: Record<string, unknown>) => { value[field] = null; },
    ]),
    value => { (value['producer'] as Record<string, unknown>)['project'] = null; },
    value => { (value['producer'] as Record<string, unknown>)['readiness'] = null; },
    ...['contract', 'project', 'layer', 'frame', 'horizon', 'candidate', 'obligations', 'readiness', 'deliveries'].map(field =>
      (value: Record<string, unknown>) => { delete (value['producer'] as Record<string, unknown>)[field]; }),
    ...['ownership', 'resolved', 'inputs'].map(field => (value: Record<string, unknown>) => {
      delete ((value['producer'] as Record<string, unknown>)['deliveries'] as Record<string, unknown>)[field];
    }),
    ...['producer', 'ledger'].map(field => (value: Record<string, unknown>) => {
      delete ((value['producer'] as Record<string, unknown>)['obligations'] as Record<string, unknown>)[field];
    }),
    value => { (value['producer'] as Record<string, unknown>)['contract'] = 'om-m8/unknown'; },
    value => { ((value['producer'] as Record<string, unknown>)['readiness'] as Record<string, unknown>)['confirmations'] = undefined; },
  ];
  for (const change of changes) {
    const value = clone(saved.value) as unknown as Record<string, unknown>; change(value);
    // JSON persistence removes an undefined field; there is no synthetic null default for the new era.
    const altered = f.store.write({ id: saved.id, kind: saved.kind, expected: f.store.get(saved.id)!.revision,
      value: JSON.parse(JSON.stringify(value)) });
    denied(readFeasibility(f.store, { project: f.project, record: reference(altered) }), 'feasibility_record_invalid');
  }
});

test('G1 existing missing code is an addressed source gap and leaves the accepted graph untouched', t => {
  const f = acceptedWorksFixture(t, 'existing'), before = heads(f.store);
  const graph = f.store.get<Graph>(f.acceptance.graph.id, f.acceptance.graph.revision)!;
  const prepared = ok(prepareFeasibility(f.store, f.feasibility));
  assert.equal(prepared.record.value.ready, false);
  assert.ok(prepared.record.value.findings.some(finding => finding.code === 'source_missing' && finding.target === 'consume.txt'));
  assert.ok(prepared.refusals.some(refusal => refusal.code === 'source_missing' && refusal.route === 'gap'
    && refusal.at.target === 'consume.txt'));
  assert.deepEqual(heads(f.store), before);
  assert.deepEqual(f.store.get(graph.id, graph.revision), graph);
});


test('G1 empty or incomplete work horizon cannot reuse a real C5 acceptance for a changed graph', t => {
  const f = acceptedWorksFixture(t), original = f.store.get<Graph>(f.acceptance.graph.id, f.acceptance.graph.revision)!;
  const variants = [
    { ...clone(original.value), horizon: [] },
    { ...clone(original.value), nodes: clone(original.value.nodes).filter(node => node.id !== 'garden-consume-work') },
  ];
  for (const value of variants) {
    // Persist only the graph change. The actual prior accepting frame/layer must refuse this
    // empty/incomplete projection; no synthesized successful C5 event is supplied by the fixture.
    const graph = f.store.write({ id: original.id, kind: original.kind, expected: f.store.get(original.id)!.revision, value });
    const before = heads(f.store);
    denied(prepareFeasibility(f.store, { ...f.feasibility, graph: reference(graph) }), 'layer_basis_unproven');
    assert.deepEqual(heads(f.store), before);
    assert.equal(f.store.get(`om-feasibility:${f.project}`), null);
    assert.deepEqual(f.store.get(original.id, original.revision), original);
  }
});

test('G1 changed exact Source head rejects M8 and its neighbor atomically after readonly preparation', t => {
  const f = acceptedWorksFixture(t), prepared = ok(prepareFeasibility(f.store, f.feasibility));
  assert.equal(prepared.record.value.ready, true);
  assert.ok(prepared.record.value.inputs.some(ref => canonical(ref) === canonical(reference(f.source))));
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(f.source))));
  const originalGraph = f.store.get(f.acceptance.graph.id, f.acceptance.graph.revision);
  const other = new Store(f.database);
  try {
    const changed = new Evidence(other).file(f.project, 'garden-data', f.workspace, 'input.txt', 'text/plain', f.source.revision);
    assert.equal(changed.revision, f.source.revision + 1);
    assert.notDeepEqual(reference(changed), reference(f.source));
  } finally { other.close(); }
  const neighbor = { id: 'g1-neighbor:source', kind: 'g1-neighbor', expected: 0, value: { admitted: true } };
  const written = writeGuarded(f.store, { unit: 'M8', target: prepared.record.id,
    writes: [...prepared.writes, neighbor], guards: prepared.guards });
  denied(written, 'input_stale');
  if (!written.ok) assert.equal(written.refusal.at.target, f.source.id);
  assert.equal(f.store.get(prepared.record.id), null);
  assert.equal(f.store.get(neighbor.id), null);
  assert.deepEqual(f.store.get(f.acceptance.graph.id, f.acceptance.graph.revision), originalGraph);
});

/** One scoped work receives a genuine E2.1/E4 answer carrying the nonempty R3 handoff;
 * no task-start/task-result binding is invented for this earlier deadline. */
async function runtimeWorksFixture(t: TestContext, options: { count?: number; observedCount?: number } = {}) {
  const count = options.count ?? 1, observedCount = options.observedCount ?? count;
  const f = acceptedOperationsFixture(t, 'planned', count);
  const { store, project, root, workspace, graph, input, layer, upperFrame, frame2, horizon, basis } = f;
  const works: ProposalRequest = { frame: clone(basis.request) as FrameRequest, proposals: [] };
  const gaps = ok(writeGaps(store, { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { frame: { ...frame2, graph, layer, frame: upperFrame, horizon: reference(horizon.gate) }, proposals: [] }, works }));
  const gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const runtimeGaps = gaps.records.filter(row => row.value.gap.target.startsWith('discovery:runtime-ready') && row.value.gap.field === 'answer');
  assert.equal(runtimeGaps.length, count);
  for (const row of runtimeGaps) {
    assert.equal(row.value.gap.moment, 'feasibility'); assert.equal(row.value.gap.kind, 'environment-confirmation');
  }
  const marker = join(root, 'runtime-invocations.log'), condition = join(root, 'condition.txt');
  writeFileSync(condition, 'ready');
  const script = new Evidence(store).document(project, 'g1-runtime-module',
    `import{readFileSync,appendFileSync,existsSync}from'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));
const [marker,condition]=process.argv.slice(2);appendFileSync(marker,'executed\\n');
console.log(JSON.stringify({protocol:input.protocol,obligation:input.obligation,condition:readFileSync(condition,'utf8')}));
process.exitCode=readFileSync(condition,'utf8')==='ready'&&!existsSync(marker+'.fail')?0:7;`, 'text/plain', 0);
  const returnCondition = 'The explicitly declared local condition is ready before planning';
  const assignments = runtimeGaps.map(runtimeGap => normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project,
    context: { gaps: gapRead, lines: reference(lines) }, gap: reference(runtimeGap),
    assignments: runtimeGap.value.gap.consumers.map(responsibleConsumer => ({ responsibleNode: 'garden-consume-operation',
      responsibleConsumer, reason: 'The owner requires this local runtime prerequisite before M8', returnCondition, wake: null,
      runtimeCheck: { script: reference(script), dependencies: [], subjects: [condition], executables: [process.execPath],
        args: [marker, condition], timeoutMs: 3000, purpose: 'Observe a controlled local predicate; no provider capability claim', satisfies: returnCondition } })) }));
  const initialHandoff = ok(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: assignments.map(assignment => ({ pending: {
    id: `om-owner-gap-assignment:${project}:${hashJson(assignment)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value: assignment } })) }));
  assert.equal(initialHandoff.handoff.obligations.length, count);
  assert.equal(initialHandoff.handoff.obligations[0]!.moment, 'R3');
  const routes = ok(writeRoutes(store, { project, gaps: gapRead, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const batches = routes.value.batches.filter(batch => batch.level === 3 && batch.task === 'node-expansion');
  assert.equal(batches.length, 1); const batch = batches[0]!;
  assert.equal(batch.node, 'garden-consume-operation');
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const adapterFixture = fileURLToPath(new URL('../../test/om-adapter-fixture.mjs', import.meta.url));
  const command = { executable: process.execPath, args: [adapterFixture, '--scenario', scenario, '--trace', trace] };
  const environment = f.engine.environments.configure(project, { workspace,
    implementer: { actor: 'g1-local-producer', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'g1-local-reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: 200_000 }, 0);
  const sourcePath = join(workspace, 'input.txt'); writeFileSync(sourcePath, 'A captured external input');
  const source = new Evidence(store).file(project, 'garden-data', workspace, 'input.txt', 'text/plain', 0);
  git(workspace, ['add', 'input.txt']);
  git(workspace, ['-c', 'user.name=OMG Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'capture input']);
  const adapter = store.write({ id: `adapter:${project}:g1-runtime`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: project, protocol: 'codex-stdio' } });
  const block = 'garden-consume-block';
  assert.ok(batch.items.every(item => item.consumers.includes(block)));
  ok(openSeries(store, { project, block, line: 1, slice: 'g1-runtime-work', predecessor: null, basis: null }));
  const series = ok(beginAttempt(store, { project, block, line: 1, attempt: 1,
    goal: { key: 'g1-runtime-work', questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
      result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) } }));
  const packet = ok(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id, environment: reference(environment),
    attempt: { series: reference(series), ordinal: 1 }, previous: [],
    works: { producer: reference(initialHandoff.producer), ledger: reference(initialHandoff.record) } })).record;
  assert.equal(packet.value.state, 'ready'); assert.equal(packet.value.plan!.mode, 'whole');
  const payload = packet.value.packet as unknown as { expansion: { assigned: string[];
    obligations: { id: string; kind: string; upper: { port?: string } }[] }; works: { assigned: string[] } };
  assert.deepEqual(payload.works.assigned, [], 'R3 runtime confirmation is not a task binding');
  const work = clone(f.desired.nodes.find(node => node.id === 'garden-consume-work')!);
  const body: PartProposalBody = { nodes: [work], tests: clone(f.desired.tests.filter(proof => work.tests.includes(proof.id))),
    fills: payload.expansion.obligations.filter(item => payload.expansion.assigned.includes(item.id))
      .map(item => ({ obligation: item.id, node: work.id,
        ...(item.kind === 'connection-end' ? { port: item.upper.port!, codeRef: work.code[0]! } : {}) })),
    localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
    removes: [], replaces: [], redefines: [] };
  writeFileSync(scenario, JSON.stringify({ database: store.path, steps: [{ research: { protocol: '$answerProtocol', requestId: '$requestId',
    action: 'answer', proposal: body, bindings: [] }, usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0, reasoningOutputTokens: 1 } }] }));
  const cycle = ok(await runModelCycle(store, { project, packet: reference(packet), role: 'implementer',
    dispatch: { adapter: reference(adapter), config: reference(environment) } }));
  assert.equal(cycle.record.value.terminal, 'assembled'); assert.ok(cycle.assembly);
  const assembly = ok(readPartAssembly(store, { project, record: cycle.assembly }));
  assert.deepEqual(assembly.record.value.works!.bindings, []);
  assert.deepEqual(assembly.record.value.works!.ledger, reference(initialHandoff.record));
  const accepted = ok(writeWorksAcceptance(store, { project, results: [{ kind: 'assembly', record: cycle.assembly }],
    environment: reference(environment), sources: [reference(source)] }));
  assert.equal(accepted.state, 'accepted'); assert.ok(accepted.acceptance);
  const settled = ok(readAcceptedFrame(store, accepted.acceptance));
  assert.ok(settled.graph && settled.frame);
  assert.deepEqual(settled.graph.value.horizon, ['garden-consume-work']);
  const candidate = ok(readWorksFrame(store, { project, candidate: settled.frame.value.acceptance.candidate }));
  assert.deepEqual(candidate.value.works!.bindings, []);
  const handoff = ok(readOmObligations(store, { project, producer: candidate.value.works!.producer }));
  assert.notDeepEqual(reference(handoff.record), reference(initialHandoff.record));
  assert.equal(handoff.handoff.obligations.length, count);
  assert.equal(store.get(`reader-pilot:${project}`), null);
  const observations: Awaited<ReturnType<typeof observeRuntime>>[] = [];
  for (const [index, item] of handoff.handoff.obligations.slice(0, observedCount).entries()) {
    const obligation = item as CarriedObligation;
    assert.equal(obligation.moment, 'R3'); assert.equal(obligation.kind, 'environment-confirmation');
    const observed = await observeRuntime(store, project, { scope: reference(handoff.record),
      obligation: runtimeObligationId(obligation), key: `g1-runtime-ready-${index}` });
    assert.equal(observed.observation.value.status, 'observed'); assert.ok(observed.source);
    assert.equal(observed.observation.value.result!.exitCode, 0);
    assert.deepEqual(observed.observation.value.scope, reference(handoff.record)); observations.push(observed);
  }
  assert.equal(readFileSync(marker, 'utf8'), 'executed\n'.repeat(observedCount));
  const observed = observations[0]!;
  assert.equal(readFileSync(trace, 'utf8').trim().split('\n').length, 1, 'Only the declared local E4 fixture is dispatched');
  assert.equal(store.list('model-call').length, 1);
  assert.equal(git(workspace, ['status', '--porcelain', '--untracked-files=all']), '');
  return { ...f, get store() { return f.store; }, get engine() { return f.engine; }, handoff, observed, observations, marker, condition, trace, environment, acceptance: accepted.acceptance,
    feasibility: { project, graph: accepted.acceptance.graph, layer: accepted.acceptance.layer, frame: accepted.acceptance.frame,
      environment: reference(environment), expected: 0 } };
}

function createInactivePilot(f: { store: Store; database: string; project: string }) {
  const before = runtimeContext(f.store, f.project).binding;
  const other = new Store(f.database);
  try {
    const command = { executable: process.execPath, args: ['--version'] };
    configureReaderPilot(other, new Environments(other), f.project, { experimental: true, active: false, stopAfter: 'L2',
      reader: { actor: 'g1-reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
      maxRequestChars: 300000, maxReadChars: 60000, maxReplyChars: 100000, maxCalls: 100,
      maxReportedTokens: 20000000, callTimeoutMs: 1000 }, 0);
  } finally { other.close(); }
  assert.deepEqual(runtimeContext(f.store, f.project).binding, before,
    'An inactive pilot changes the admission dependency without changing the observed runtime binding');
}

test('G1 real R3 runtime confirmation carries absent reader-pilot into the atomic M8 transaction', async t => {
  const f = await runtimeWorksFixture(t), before = heads(f.store);
  const prepared = ok(prepareFeasibility(f.store, f.feasibility));
  assert.equal(prepared.record.value.ready, true, canonical(prepared.record.value.findings));
  assert.deepEqual(heads(f.store), before);
  assert.deepEqual(prepared.record.value.producer.readiness.handoff, f.handoff.handoff);
  assert.deepEqual(prepared.record.value.producer.readiness.confirmations, [{
    obligation: runtimeObligationId(f.handoff.handoff.obligations[0]! as CarriedObligation),
    source: reference(f.observed.source!), observation: reference(f.observed.observation),
  }]);
  assert.ok(prepared.guards.some(guard => guard.id === `reader-pilot:${f.project}` && 'absent' in guard));
  assert.ok(prepared.record.value.inputs.every(isRef));
  createInactivePilot(f);
  const neighbor = { id: 'g1-neighbor:pilot', kind: 'g1-neighbor', expected: 0, value: { admitted: true } };
  const saved = writeGuarded(f.store, { unit: 'M8', target: prepared.record.id,
    writes: [...prepared.writes, neighbor], guards: prepared.guards });
  denied(saved, 'input_stale');
  if (!saved.ok) assert.equal(saved.refusal.at.target, `reader-pilot:${f.project}`);
  assert.equal(f.store.get(prepared.record.id), null); assert.equal(f.store.get(neighbor.id), null);
  assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n');
  assert.equal(readFileSync(f.trace, 'utf8').trim().split('\n').length, 1);
});

test('G1 every positive readiness guard rejects its independent second-Store head race without partial neighboring writes', async t => {
  const f = await runtimeWorksFixture(t);
  const prepared = ok(prepareFeasibility(f.store, f.feasibility));
  assert.equal(prepared.record.value.ready, true);
  assert.equal(prepared.record.value.producer.readiness.confirmations.length, 1);
  assert.equal(prepared.writes.length, 1, 'This first M8 transaction has one result and uses the already persisted F4 indexes');
  const guards = prepared.guards.filter(isRef);
  assert.ok(guards.length > 0);
  for (const ref of [f.acceptance.graph, f.acceptance.layer, f.acceptance.frame, reference(f.environment),
    reference(f.handoff.producer), reference(f.handoff.record), reference(f.observed.source!), reference(f.observed.observation)])
    assert.ok(guards.some(guard => canonical(guard) === canonical(ref)), `The current transaction guards ${ref.id}`);

  // Snapshot only a closed SQLite database. Every case starts at the same
  // completed native preparation; it changes exactly one guarded head.
  f.store.close();
  const bytes = readFileSync(f.database);
  f.restart();
  const original = heads(f.store);
  for (const [index, guard] of guards.entries()) {
    const database = join(f.root, `positive-guard-${index}.sqlite`);
    writeFileSync(database, bytes);
    const first = new Store(database), second = new Store(database);
    try {
      const before = first.get(guard.id)!;
      assert.deepEqual(reference(before), guard);
      const changed = second.write({ id: before.id, kind: before.kind, expected: before.revision, value: before.value });
      assert.equal(changed.revision, guard.revision + 1);
      assert.equal(changed.hash, guard.hash, 'An unchanged body with a different head still invalidates the exact admission');
      const neighbors: Write[] = [0, 1].map(part => ({ id: `g1-neighbor:positive-${index}-${part}`,
        kind: 'g1-neighbor', expected: 0, value: { guarded: guard.id } }));
      const writes = [...prepared.writes, ...neighbors];
      for (const write of writes) assert.equal(first.get(write.id), null);
      const result = writeGuarded(first, { unit: 'M8', target: prepared.record.id, writes, guards: prepared.guards });
      denied(result, 'input_stale');
      if (!result.ok) assert.equal(result.refusal.at.target, guard.id);
      for (const write of writes) assert.equal(first.get(write.id), null, `${guard.id} must leave ${write.id} unwritten`);
      assert.deepEqual(first.get(guard.id), changed);
    } finally { second.close(); first.close(); }
  }
  assert.deepEqual(heads(f.store), original, 'The guard matrix never changes the source fixture');
  assert.equal(readFileSync(f.trace, 'utf8').trim().split('\n').length, 1);
});

test('G1 rejects a native reader-pilot created inside its first runtime readiness proof', async t => {
  const f = await runtimeWorksFixture(t), list = f.store.list.bind(f.store);
  let created = false;
  f.store.list = ((kind?: string) => {
    const snapshot = list(kind);
    if (!created && kind === 'runtime-observation') { created = true; createInactivePilot(f); }
    return snapshot;
  }) as Store['list'];
  try {
    const prepared = prepareFeasibility(f.store, f.feasibility);
    assert.equal(created, true, 'The native confirmation enumerated contrary runtime observations');
    if (prepared.ok) {
      assert.equal(prepared.value.record.value.ready, false);
      assert.ok(prepared.value.record.value.findings.some(finding => finding.code === 'environment_confirmation_required'));
    } else {
      assert.equal(prepared.refusal.code, 'input_stale');
      assert.equal(prepared.refusal.at.target, `reader-pilot:${f.project}`);
    }
  } finally { f.store.list = list; }
  assert.equal(f.store.get(`om-feasibility:${f.project}`), null);
  assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n');
  assert.equal(readFileSync(f.trace, 'utf8').trim().split('\n').length, 1);
});

/** The explicit historical readiness API must use only the retained revisions. */
function historicalReadinessOnly(store: Store, saved: Revision<OmFeasibility>) {
  const get = store.get.bind(store), list = store.list.bind(store);
  let exactReads = 0;
  store.get = ((id: string, revision?: number) => {
    assert.notEqual(revision, undefined, `Historical readiness must not choose the current head of ${id}`);
    exactReads++;
    return get(id, revision);
  }) as Store['get'];
  store.list = (() => assert.fail('Historical readiness must not enumerate present records')) as Store['list'];
  try {
    const result = readReadinessObligations(store, saved.value.projectId,
      [saved.value.producer.obligations.producer, saved.value.producer.obligations.ledger],
      clone(saved.value.producer.readiness) as ReadinessObligations);
    assert.ok(exactReads > 0);
    assert.deepEqual(result.value, saved.value.producer.readiness);
    assert.deepEqual(result.guards, []); assert.deepEqual(result.admissionGuards, []);
    return result;
  } finally { store.get = get; store.list = list; }
}

function changedFeasibility(store: Store, saved: Revision<OmFeasibility>, change: (value: OmFeasibility) => void) {
  const value = clone(saved.value); change(value);
  // These are newly persisted bytes with their own valid record hash. The reader
  // must verify the retained evidence and derived outcome, not only that hash.
  return store.write({ id: saved.id, kind: saved.kind, expected: store.get(saved.id)!.revision,
    value: JSON.parse(JSON.stringify(value)) as OmFeasibility });
}

test('G1 historical M8 preserves a partial negative R3 result and exact proofs without heads or enumeration', async t => {
  const f = await runtimeWorksFixture(t, { count: 2, observedCount: 1 });
  const saved = ok(writeFeasibility(f.store, f.feasibility));
  assert.equal(saved.value.ready, false);
  assert.equal(saved.value.producer.readiness.handoff.obligations.length, 2);
  assert.equal(saved.value.producer.readiness.confirmations.length, 1);
  assert.equal(saved.value.findings.filter(item => item.code === 'environment_confirmation_required').length, 1);
  const missing = f.handoff.handoff.obligations.find(item => runtimeObligationId(item as CarriedObligation)
    !== saved.value.producer.readiness.confirmations[0]!.obligation)!;
  assert.ok(saved.value.findings.some(item => item.target === missing.obligation));
  f.restart();
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(saved) })), saved);
  const restored = historicalReadinessOnly(f.store, saved as unknown as Revision<OmFeasibility>);
  assert.deepEqual(restored.findings, saved.value.findings);
  assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n');
  assert.equal(readFileSync(f.trace, 'utf8').trim().split('\n').length, 1);
});

test('G1 historical M8 preserves complete proofs and dirty inspection after later failure and environment reconfiguration', async t => {
  const f = await runtimeWorksFixture(t);
  const saved = ok(writeFeasibility(f.store, f.feasibility));
  assert.equal(saved.value.ready, true); assert.equal(saved.value.producer.readiness.confirmations.length, 1);
  assert.ok(saved.value.repository);
  const admitted = ok(gateFeasibility(f.store, { project: f.project, record: reference(saved) }));
  assert.equal(admitted.passed, true); assert.deepEqual(admitted.record, reference(saved));
  assert.ok(admitted.guards.some(guard => guard.id === `execution-root:${f.project}` && 'absent' in guard));
  const untracked = join(f.workspace, 'untracked-after-m8.txt'); writeFileSync(untracked, 'A current change outside the committed tree');
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), saved.value.repository.head);
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD^{tree}']), saved.value.repository.tree);
  denied(gateFeasibility(f.store, { project: f.project, record: reference(saved) }), 'feasibility_stale');
  const dirty = ok(writeFeasibility(f.store, { ...f.feasibility, expected: saved.revision }));
  assert.equal(dirty.value.ready, false);
  assert.equal(dirty.value.producer.readiness.confirmations.length, 1, 'Complete R3 proof is compatible with a negative physical inspection');
  assert.ok(dirty.value.producer.inspection.result.findings.some(item => item.code === 'repository_dirty'));
  assert.deepEqual(dirty.value.repository, dirty.value.producer.inspection.result.state);
  denied(gateFeasibility(f.store, { project: f.project, record: reference(dirty) }), 'feasibility_not_ready');
  rmSync(untracked);
  denied(gateFeasibility(f.store, { project: f.project, record: reference(dirty) }), 'feasibility_stale');

  // The declared subject and runtimeCheck remain unchanged. A later native
  // failure is contrary evidence; its Source records exit 7 and cannot confirm the obligation.
  writeFileSync(`${f.marker}.fail`, 'fail the same declared check');
  const failed = await observeRuntime(f.store, f.project, { scope: reference(f.handoff.record),
    obligation: runtimeObligationId(f.handoff.handoff.obligations[0]! as CarriedObligation), key: 'g1-later-runtime-failure' });
  assert.notEqual(failed.observation.value.result!.exitCode, 0);
  assert.equal(failed.observation.value.status, 'observed'); assert.ok(failed.source);
  const current = ok(prepareFeasibility(f.store, { ...f.feasibility, expected: dirty.revision }));
  assert.equal(current.record.value.ready, false);
  assert.ok(current.record.value.findings.some(item => item.code === 'environment_confirmation_required'));
  const { projectId: _project, ...configuration } = clone(f.environment.value);
  const environment = f.engine.environments.configure(f.project,
    { ...configuration, timeoutMs: configuration.timeoutMs + 1 }, f.environment.revision);
  assert.equal(environment.revision, f.environment.revision + 1);
  denied(prepareFeasibility(f.store, { ...f.feasibility, expected: dirty.revision }), 'input_stale');
  f.restart();
  for (const retained of [saved, dirty])
    assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(retained) })), retained);
  assert.deepEqual(historicalReadinessOnly(f.store, saved as unknown as Revision<OmFeasibility>).findings, []);
  assert.equal(readFileSync(f.marker, 'utf8'), 'executed\nexecuted\n');
  assert.equal(readFileSync(f.trace, 'utf8').trim().split('\n').length, 1, 'Historical reads dispatch no adapter');
});

test('G1 historical M8 rejects absent and inconsistent retained confirmation evidence regardless of ready status', async t => {
  const f = await runtimeWorksFixture(t), saved = ok(writeFeasibility(f.store, f.feasibility));
  const inputs = [saved.value.producer.obligations.producer, saved.value.producer.obligations.ledger];
  for (const change of [
    (readiness: ReadinessObligations) => { readiness.confirmations[0]!.source.hash = hashJson('different source bytes'); },
    (readiness: ReadinessObligations) => { readiness.confirmations[0]!.observation.revision += 1000; },
  ]) {
    const readiness = clone(saved.value.producer.readiness) as ReadinessObligations; change(readiness);
    assert.throws(() => readReadinessObligations(f.store, f.project, inputs, readiness),
      (error: unknown) => error instanceof EngineError && error.code === 'obligation_handoff_invalid',
      'The common historical reader verifies the exact proof independently of M8 input equality');
  }
  const otherSource = new Evidence(f.store).document('other-project', 'foreign-runtime-observation', 'Same asserted condition is not this observation', 'text/plain', 0);
  const changes: [string, (value: OmFeasibility) => void][] = [
    ['foreign source', value => { value.producer.readiness.confirmations[0]!.source = reference(otherSource); }],
    ['duplicate proof', value => { value.producer.readiness.confirmations.push(clone(value.producer.readiness.confirmations[0]!)); }],
    ['different obligation', value => { value.producer.readiness.confirmations[0]!.obligation = 'another-obligation'; }],
    ['wrong exact source hash', value => { value.producer.readiness.confirmations[0]!.source.hash = hashJson('different source bytes'); }],
    ['missing named observation', value => { value.producer.readiness.confirmations[0]!.observation.revision += 1000; }],
    ['removed proof with ready true', value => { value.producer.readiness.confirmations = []; }],
    ['missing confirmations', value => { delete (value.producer.readiness as unknown as Record<string, unknown>)['confirmations']; }],
    ['missing readiness', value => { delete (value.producer as unknown as Record<string, unknown>)['readiness']; }],
    ['negative result with invalid present proof', value => {
      value.ready = false; value.producer.readiness.confirmations[0]!.observation.hash = hashJson('different observation bytes');
    }],
  ];
  for (const [name, change] of changes) {
    const altered = changedFeasibility(f.store, saved as unknown as Revision<OmFeasibility>, value => {
      change(value);
      // Keep both public views in agreement, so proof validation is exercised.
      value.obligations = clone(value.producer.readiness);
    });
    const result = readFeasibility(f.store, { project: f.project, record: reference(altered) });
    assert.equal(result.ok, false, name); denied(result, 'feasibility_record_invalid');
  }
  f.restart();
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(saved) })), saved,
    'Later invalid records never replace the exact retained result');
});

for (const inspection of ['source_missing', 'repository_unavailable'] as const) {
  test(`G1 historical M8 retains the native ${inspection} inspection after physical recovery`, t => {
    const f = acceptedWorksFixture(t, inspection === 'source_missing' ? 'existing' : 'planned');
    const graph = f.store.get<Graph>(f.acceptance.graph.id, f.acceptance.graph.revision)!;
    const gitDirectory = join(f.workspace, '.git'), displacedGit = join(f.root, 'retained-git');
    if (inspection === 'repository_unavailable') renameSync(gitDirectory, displacedGit);
    let saved: ReturnType<typeof writeFeasibility>;
    let observed: ReturnType<typeof inspectRepository>;
    try {
      observed = inspectRepository(f.environment.value, graph.value);
      assert.ok(observed.findings.some(item => item.code === inspection));
      saved = writeFeasibility(f.store, f.feasibility);
    } finally {
      if (inspection === 'repository_unavailable') renameSync(displacedGit, gitDirectory);
    }
    const retained = ok(saved!);
    assert.equal(retained.value.ready, false);
    assert.deepEqual(retained.value.producer.inspection.result, observed!);
    assert.deepEqual(retained.value.repository, observed!.state);
    assert.deepEqual(retained.value.producer.inspection.graph, f.acceptance.graph);
    assert.deepEqual(retained.value.producer.inspection.layer, f.acceptance.layer);
    assert.deepEqual(retained.value.producer.inspection.environment, reference(f.environment));
    assert.equal(retained.value.producer.inspection.root, realpathSync(f.workspace));
    assert.equal(retained.value.producer.inspection.executionRoot, null);
    assert.equal(retained.value.producer.inspection.workspace, null);
    if (inspection === 'repository_unavailable') assert.equal(retained.value.repository, null);
    else {
      writeFileSync(join(f.workspace, 'consume.txt'), 'Now the existing code path is present');
      git(f.workspace, ['add', 'consume.txt']);
      git(f.workspace, ['-c', 'user.name=OMG Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'restore existing code']);
    }
    assert.deepEqual(inspectRepository(f.environment.value, graph.value).findings, []);
    f.restart();
    assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(retained) })), retained);
    const changes: [string, (value: OmFeasibility) => void][] = [
      ['ready disagrees with inspection', value => { value.ready = true; }],
      ['findings disagree with inspection', value => { value.findings = []; }],
      ['repository disagrees with state', value => { value.repository = value.repository === null
        ? { root: f.workspace, head: 'different-head', tree: 'different-tree', files: [] } : null; }],
      ['inspection names another graph', value => { value.producer.inspection.graph.hash = hashJson('another graph'); }],
      ...['graph', 'layer', 'environment', 'root', 'executionRoot', 'workspace', 'result'].map(field =>
        [`missing inspection ${field}`, (value: OmFeasibility) => {
          delete (value.producer.inspection as unknown as Record<string, unknown>)[field];
        }] as [string, (value: OmFeasibility) => void]),
      ...['state', 'findings'].map(field => [`missing result ${field}`, (value: OmFeasibility) => {
        delete (value.producer.inspection.result as unknown as Record<string, unknown>)[field];
      }] as [string, (value: OmFeasibility) => void]),
    ];
    for (const [name, change] of changes) {
      const altered = changedFeasibility(f.store, retained as unknown as Revision<OmFeasibility>, change);
      const result = readFeasibility(f.store, { project: f.project, record: reference(altered) });
      assert.equal(result.ok, false, name); denied(result, 'feasibility_record_invalid');
    }
  });
}

test('G1 reads unchanged feasibility stages and plan from the complete 2f2721d producer after restart and preserves positive writeGuarded results', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'omg-g1-old-producer-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const loader = join(directory, 'base-loader.mjs'), producer = join(directory, 'base-producer.mjs');
  writeFileSync(loader, G1_HISTORY_LOADER);
  writeFileSync(producer, `import assert from 'node:assert/strict';
import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const repository=process.argv[2],src=path=>pathToFileURL(join(repository,'dist/src',path)).href,
 helpers=path=>pathToFileURL(join(repository,'dist/test',path)).href;
const {executionFixture}=await import(helpers('execution-fixture.js'));
const {reference,isRef}=await import(src('pipeline/contracts.js'));
const {canonical}=await import(src('canonical.js'));
const {writeGuarded}=await import(src('om/refs.js'));
const cleanup=[];
try {
 const f=executionFixture({after:fn=>cleanup.push(fn)}),project='p';
 const ready=f.store.get('feasibility:'+project),plan=f.plan;
 assert.equal(ready.kind,'feasibility');assert.equal(ready.value.contractVersion,2);
 assert.equal(ready.value.ready,true);assert.ok(ready.value.repository);
 const phases=f.store.list('phase'),stages=f.store.list('stage');
 const checks={feasibility:f.engine.refinement.feasibilityGate(project,reference(ready)),
  om:f.engine.pipeline.inspect(project,'om-g2'),compilation:f.engine.pipeline.inspect(project,'compilation'),
  plan:f.engine.compiler.gate(project,reference(plan))};
 assert.equal(checks.feasibility.findings.length,0);assert.equal(checks.plan.findings.length,0);
 assert.equal(checks.om.state,'accepted');assert.equal(checks.compilation.state,'accepted');
 assert.ok(ready.value.inputs.every(isRef));assert.ok(plan.value.guards.every(isRef));
 assert.equal(f.calls().length,0);
 // The changed helper is exercised by the genuine old producer as well.
 const source=f.store.write({id:'g1-history:input',kind:'history-probe',expected:0,value:{claim:'source'}});
 const request={unit:'A1',target:'g1-history:answer',guards:[reference(source)],writes:[
  {id:'g1-history:answer',kind:'history-probe',expected:0,value:{source:reference(source),status:'accepted'}},
  {id:'g1-history:neighbor',kind:'history-probe',expected:0,value:{items:[]}}]};
 const result=writeGuarded(f.store,request);assert.equal(result.ok,true);
 const historyBytes=canonical(f.store.list().flatMap(row=>f.store.history(row.id)));
 const output={directory:f.directory,database:f.store.path,project,ready,plan,phases,stages,checks,historyBytes,
  guarded:{source,request,result}};
 f.store.close();process.stdout.write(JSON.stringify(output));
} catch(error) {for(const fn of cleanup)fn();throw error;}
`);
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const bootstrap = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},
{data:{root:${JSON.stringify(pathToFileURL(repository).href)},typescript:${JSON.stringify(typescript)}}});`;
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository],
    { cwd: repository, env: environment, encoding: 'utf8', timeout: 60_000, maxBuffer: 30_000_000 });
  const old = JSON.parse(output) as {
    directory: string; database: string; project: string; ready: Revision<Feasibility>; plan: Revision<MachinePlan>;
    phases: Revision[]; stages: Revision<StageArtifact>[]; historyBytes: string;
    checks: { feasibility: GateResult; om: StageProjection; compilation: StageProjection; plan: GateResult };
    guarded: { source: Revision; request: GuardedWrite; result: ReturnType<typeof writeGuarded> };
  };
  t.after(() => rmSync(old.directory, { recursive: true, force: true }));
  assert.equal(old.ready.id, 'feasibility:p', 'This is the actual legacy producer address');
  assert.ok(old.stages.some(row => row.value.stage === 'om-g2' && row.value.status === 'accepted'));
  assert.ok(old.stages.some(row => row.value.stage === 'compilation' && row.value.status === 'accepted'));
  assert.ok(old.plan.value.guards.length);
  for (let restart = 0; restart < 2; restart++) {
    const store = new Store(old.database), engine = new ProductEngine(store);
    try {
      assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), old.historyBytes);
      assert.deepEqual(store.get(old.ready.id, old.ready.revision), old.ready);
      for (const row of [...old.phases, ...old.stages]) assert.deepEqual(store.get(row.id, row.revision), row);
      assert.deepEqual(engine.compiler.read(old.plan.id), old.plan);
      assert.deepEqual(engine.compiler.compile(old.project), old.plan, 'Exact current repeat writes no new plan');
      const checks = { feasibility: engine.refinement.feasibilityGate(old.project, reference(old.ready)),
        om: engine.pipeline.inspect(old.project, 'om-g2'), compilation: engine.pipeline.inspect(old.project, 'compilation'),
        plan: engine.compiler.gate(old.project, reference(old.plan)) };
      assert.deepEqual(checks, old.checks, 'Compare the complete previous DTOs, including all guard channels');
      const priorWrites = ok(old.guarded.result);
      for (const row of priorWrites) assert.deepEqual(ok(readRecord(store, reference(row),
        { unit: 'A1', target: row.id, id: row.id, kind: row.kind })), row);
      assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), old.historyBytes,
        'Readers and exact repeats preserve every record, value, input/proof order, key and hash');
    } finally { store.close(); }
  }
  const replay = new Store(join(directory, 'positive-guards.sqlite'));
  try {
    const source = old.guarded.source;
    assert.equal(source.revision, 1);
    assert.deepEqual(replay.write({ id: source.id, kind: source.kind, expected: 0, value: source.value }), source);
    assert.deepEqual(writeGuarded(replay, old.guarded.request), old.guarded.result,
      'Identical positive-only inputs produce the exact old helper result and saved bytes');
    for (const row of ok(old.guarded.result)) assert.deepEqual(replay.get(row.id, row.revision), row);
  } finally { replay.close(); }
});

const G1_HISTORY_LOADER = String.raw`import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let root,ts;
export async function initialize(data){root=data.root;ts=(await import(data.typescript)).default;}
export async function load(url,context,next){
 const prefix=new URL('dist/',root).href;
 if(url.startsWith(prefix)&&/\.js$/.test(url)){
  const relative=url.slice(prefix.length).replace(/\.js$/,'.ts');
  // Both the producer and every imported fixture dependency come from Git.
  // There is no fallback to current source when a base module is absent.
  if(relative.startsWith('src/')||relative.startsWith('test/')){
   const source=execFileSync('git',['show','2f2721df55f14573755eeaab60f4391e931d3c53:'+relative],
    {cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
   return {format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};
  }
 }
 return next(url,context);
}
`;

// ---- AT1 (№4091 п.5, row 14): the plan is issued only on the tree the works were checked against ----
import { resolveSnapshot } from '../src/om/impact.js';
import { ATOMIC_GATE_IMPACT_CONTRACT } from '../src/om/atomic-gate.js';
test('AT1 row 14 M8 issues a plan only on the tree its works were checked against: the same tree passes; a workspace moved after G5 is stale; a gate of the impact era without its snapshot is not ready', t => {
  const f = acceptedWorksFixture(t, 'planned', 'head');
  assert.equal(f.gate.value.contract, ATOMIC_GATE_IMPACT_CONTRACT);
  assert.equal(f.gate.value.impact!.snapshot!.tree, git(f.workspace, ['rev-parse', 'HEAD^{tree}']));
  assert.ok(prepareFeasibility(f.store, f.feasibility).ok, 'the same tree');
  const g = acceptedWorksFixture(t, 'planned', 'head');
  writeFileSync(join(g.workspace, 'later.txt'), 'A later change');
  git(g.workspace, ['add', 'later.txt']); git(g.workspace, ['-c', 'user.name=OMG Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'later']);
  const before = heads(g.store);
  denied(prepareFeasibility(g.store, g.feasibility), 'feasibility_stale');
  assert.deepEqual(heads(g.store), before, 'nothing is written');
  const h = acceptedWorksFixture(t, 'planned', null);
  assert.deepEqual([h.gate.value.contract, h.gate.value.impact], [ATOMIC_GATE_IMPACT_CONTRACT, { snapshot: null, works: [] }]);
  denied(prepareFeasibility(h.store, h.feasibility), 'feasibility_not_ready');
  const old = acceptedWorksFixture(t, 'planned');
  assert.equal(old.gate.value.contract, 'om-atomic-gate/v1', 'a request of the earlier era keeps its own record and rule');
  assert.ok(prepareFeasibility(old.store, old.feasibility).ok);
});
