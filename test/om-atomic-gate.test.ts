import { addressFixtureFields, produceAtomicSeed, type AtomicSeedResources } from './om-atomic-seed.js';
import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { types } from 'node:util';
import { join } from 'node:path';
import { canonical, digest, hashJson, type Json } from '../src/canonical.js';
import { loadTaskSpecification, preplanTaskContext } from '../src/compiler/context.js';
import { BASIS_TASK_CONTEXT_CONTRACT, TASK_CONTEXT_CONTRACT } from '../src/compiler/model.js';
import { resolveArtifact, resolveExternalSource } from '../src/compiler/inputs.js';
import { Evidence, type Source } from '../src/evidence/evidence.js';
import { git, type RepositoryState } from '../src/runtime/environment.js';
import { deriveTasks } from '../src/compiler/derive.js';
import { EngineError } from '../src/errors.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { bindTaskObligations, taskBindingId, taskObligationHandoff } from '../src/graph/task-obligations.js';
import type { CarriedObligation } from '../src/graph/obligation-policy.js';
import { obligationHandoff } from '../src/graph/obligation-handoff.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Revision, type Write } from '../src/storage/store.js';
import { checkAtomicWorks, prepareWorksAcceptance, prepareWorksSources, writeWorksAcceptance, readAtomicGate, prepareAtomicGate, writeAtomicGate, readWorksAcceptance, transactionForTests, type AtomicGateRecord, type AtomicGateRequest, type PreparedWorksAcceptance } from '../src/om/atomic-gate.js';
import { readAcceptedFrame, settleCandidate } from '../src/om/frame-accept.js';
import { writeCandidate, readCandidate, type FrameCandidateRecord } from '../src/om/frame-candidate.js';
import { prepareFrame, type FrameRequest, type FrameRead } from '../src/om/frame-obligations.js';
import type { LayerProposal, ProposalRequest } from '../src/om/frame-proposals.js';
import { writeGaps, readGaps, type Gap, type GapRequest, type GapReadRequest } from '../src/om/gaps.js';
import { gapLineKey, prepareGapLines, writeGapLines, readGapLines, type GapLinesRecord, type GapLinesRequest } from '../src/om/gap-lines.js';
import { writeHorizon } from '../src/om/horizon.js';
import { historicalProof, historicalTrace, withHistoricalReads, writeOmInput } from '../src/om/input.js';
import { readPartAssembly, readModelCycle } from '../src/om/model-call.js';
import { readNeighbors, writeNeighbors, type NeighborCollection } from '../src/om/neighbors.js';
import { writeOmObligations, readOmObligations, type OmObligationHandoff } from '../src/om/obligations.js';
import { storeView } from '../src/storage/store-view.js';
import type { OmResult, Sealed } from '../src/om/refusal.js';
import { writeGuarded } from '../src/om/refs.js';
import { beginAttempt, openSeries, readSeries, readSeriesAt, readStopHistory } from '../src/om/series.js';
import { prepareWorksFrame, writeWorksFrame } from '../src/om/works-frame.js';
import { confirmResults } from '../src/om/achievements.js';
import { readResultIdentity } from '../src/om/result-identity.js';
import { closeAttempt, prepareCloseAttempt, readStopContext, openAttempt } from '../src/om/repeat-gate.js';
import { writeRoutes } from '../src/om/routes.js';
import { checkStanding, stopReport } from '../src/om/stop-report.js';
import { readAcceptedAnswer } from '../src/om/accepted-answer.js';
import { managedBlock } from './om-managed-block.js';
import { gardenGraph, explicitMapping, markedWorks } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';

const clone = structuredClone;
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
const heads = (store: Store) => store.list().map(reference);
const seedResources: AtomicSeedResources = [];
after(() => { for (const seed of seedResources) { seed.store.close(); rmSync(seed.root, { recursive: true, force: true }); } });
function denied(result: OmResult<unknown>, code: string | readonly string[]): void {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected an addressed refusal');
  assert.ok((typeof code === 'string' ? [code] : code).includes(result.refusal.code), `${result.refusal.code}: ${result.refusal.message}`);
  assert.ok(result.refusal.at.target); assert.ok(result.refusal.at.field || result.refusal.at.ref);
}

function gateWrite(prepared: Sealed<PreparedWorksAcceptance>): Write & { value: AtomicGateRecord } {
  const write = prepared.writes.find(item => item.id === prepared.record.value.gate.id);
  assert.ok(write); return clone(write) as Write & { value: AtomicGateRecord };
}
/** Save sources without the acceptance, leaving the candidate's original graph and proposal heads current. */
function sourceWrites(prepared: Sealed<PreparedWorksAcceptance>): Write[] {
  const omitted = new Set([prepared.record.id, prepared.record.value.gate.id,
    ...(prepared.acceptance ? [prepared.acceptance.graph.id, prepared.acceptance.layer.id, prepared.acceptance.frame.id] : [])]);
  return clone(prepared.writes.filter(write => !omitted.has(write.id) && write.kind !== 'layer-proposal')) as Write[];
}

function measuredContexts(store: Store, gate: AtomicGateRecord) {
  const request = gate.request, candidate = ok(readCandidate(store, { project: request.project, candidate: request.candidate }));
  const graph = clone(candidate.value.graph) as Graph;
  const handoff = ok(readOmObligations(store, { project: request.project, producer: candidate.value.works!.producer }));
  const bindings = bindTaskObligations(store, request.project, graph, handoff.handoff as OmObligationHandoff);
  assert.deepEqual(bindings.findings, []);
  const neighbors = ok(readNeighbors(store, { project: request.project, neighbors: request.neighbors }));
  const environment = store.get<{ fullCheck: { executable: string; args: string[] } }>(request.environment.id, request.environment.revision)!;
  const tasks = deriveTasks(request.project, candidate.value.graphHash, graph,
    () => { throw new Error('This native fixture has no out-of-plan input'); },
    { version: 2, owner: () => null, researchObligations: bindings.byNode }).tasks;
  return tasks.map(task => ({ task, context: preplanTaskContext({ project: request.project, graph, task,
    fullCheck: environment.value.fullCheck, basis: { candidate: request.candidate, environment: request.environment },
    neighbors: neighbors as Revision<NeighborCollection>, ...(request.taskContextContract ? {
      taskContextContract: request.taskContextContract, specification: loadTaskSpecification(store, request.project,
        request.gaps.sources.input, graph, task, undefined, request.taskContextContract) } : {}) }, 1_000_000) }));
}


let atomicSeed: ReturnType<typeof produceAtomicSeed> | undefined;
let foreignSeed: ReturnType<typeof produceAtomicSeed> | undefined;
async function atomicFixture(t: TestContext, foreign = false) {
  const seed = await (foreign ? foreignSeed ??= produceAtomicSeed(seedResources, true) : atomicSeed ??= produceAtomicSeed(seedResources));
  const root = mkdtempSync(join(tmpdir(), 'omg-f5-atomic-')), database = join(root, 'state.sqlite');
  copyFileSync(seed.database, database);
  copyFileSync(seed.trace, join(root, 'trace.jsonl')); copyFileSync(seed.scenario, join(root, 'scenario.json'));
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => {
    store.close(); rmSync(root, { recursive: true, force: true });
    assert.equal(readFileSync(seed.trace, 'utf8'), seed.traceBytes, 'Acceptance and technical repeats never dispatch another model call');
  });
  return { root, database, seedRoot: seed.root, ...clone(seed.data),
    get store() { return store; }, get engine() { return engine; },
    restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); },
    sent() { return existsSync(seed.trace) ? readFileSync(seed.trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; } };
}

test('G5 single artifact and bounded writes are independent of native graph validity and preserve input', () => {
  const graph = gardenGraph('cross'), baseline = clone(graph), empty = { gaps: [], refusals: [] };
  assert.deepEqual(ok(checkAtomicWorks(graph, empty)), []);
  const multiple = clone(graph), work = multiple.nodes.find(node => node.id === 'garden-produce-work')!;
  const artifact = clone(multiple.artifacts.find(item => item.id === work.outcome)!);
  artifact.id = 'second-independent-output'; multiple.artifacts.push(artifact);
  const connector = clone(multiple.connectors.find(item => item.id === 'garden-flow')!);
  connector.id = 'second-output-flow'; connector.artifact = artifact.id;
  connector.bindings = connector.bindings.filter(binding => binding.anchor === null); multiple.connectors.push(connector);
  for (const proof of multiple.tests) if (work.tests.includes(proof.id)) proof.covers.push(connector.id);
  assert.ok(ok(checkAtomicWorks(multiple, empty)).some(finding => finding.code === 'work_artifact_not_single' && finding.target === work.id));
  const unbounded = clone(graph), unboundedWork = unbounded.nodes.find(node => node.id === work.id)!;
  unboundedWork.code = unboundedWork.code.map(code => ({ ...code, access: 'read' as const }));
  for (const connection of unbounded.connectors) for (const binding of connection.bindings)
    for (const end of [binding.producer, ...binding.consumers])
      if (end.node === work.id && end.codeRef) end.codeRef.access = 'read';
  assert.ok(ok(checkAtomicWorks(unbounded, empty)).some(finding => finding.code === 'work_write_scope_unbounded' && finding.target === work.id));
  assert.deepEqual(graph, baseline);
});

test('G5 permits multiple connections of one artifact and has no artificial count limit on exact write paths', () => {
  const graph = gardenGraph('cross'), work = graph.nodes.find(item => item.id === 'garden-produce-work')!;
  const connection = clone(graph.connectors.find(item => item.id === 'garden-flow')!);
  connection.id = 'same-artifact-second-connection'; graph.connectors.push(connection);
  for (const proof of graph.tests) if (work.tests.includes(proof.id)) {
    proof.covers.push(connection.id);
    proof.contract!.counterfactuals.push({ ...clone(proof.contract!.counterfactuals[0]!), connector: connection.id });
  }
  for (let index = 0; index < 64; index++) work.code.push({ path: `src/exact-${index}.ts`, access: 'write', status: 'planned' });
  assert.deepEqual(ok(checkAtomicWorks(graph, { gaps: [], refusals: [] })), []);
  for (const path of ['src/', 'src/**', 'src/?.ts', '../escape.ts']) {
    const changed = clone(graph), target = changed.nodes.find(item => item.id === work.id)!;
    target.code.push({ path, access: 'write', status: 'planned' });
    assert.ok(ok(checkAtomicWorks(changed, { gaps: [], refusals: [] })).some(finding => finding.code === 'code_path_invalid'
      && finding.target === work.id && finding.message === path), path);
  }
});

test('G5 blocking gap follows the work operation and block, while late proof and deferred gaps do not block', () => {
  const graph = gardenGraph('cross');
  const gap: Gap = { id: 'gap', target: 'question', field: 'answer', code: 'predecessor_question', kind: 'owner-decision',
    routes: ['owner'], moment: 'om-pass', consumers: [], origins: ['question'], evidence: [], blocking: true };
  for (const consumer of ['garden-produce-work', 'garden-produce-operation', 'garden-produce-block']) {
    const findings = ok(checkAtomicWorks(graph, { gaps: [{ ...gap, consumers: [consumer] }], refusals: [] }));
    assert.ok(findings.some(finding => finding.code === 'work_blocking_gap_open' && finding.target === 'garden-produce-work'));
  }
  assert.deepEqual(ok(checkAtomicWorks(graph, { gaps: [{ ...gap, consumers: ['garden-produce-block'], moment: 'task-result', blocking: false }], refusals: [] })), []);
  assert.deepEqual(ok(checkAtomicWorks(graph, { gaps: [{ ...gap, consumers: ['garden-produce-block'], deferral: {
    reason: 'outside_horizon', until: 'horizon-entry', blocks: ['garden-produce-block'] } }], refusals: [] })), []);
});

test('G5 public collection validation distinguishes absent deferral from malformed gaps and refusals', () => {
  const graph = gardenGraph('cross');
  const gap: Gap = { id: 'gap', target: 'question', field: 'answer', code: 'predecessor_question', kind: 'owner-decision',
    routes: ['owner'], moment: 'om-pass', consumers: ['garden-produce-block'], origins: ['question'], evidence: [], blocking: true };
  assert.equal(Object.hasOwn(gap, 'deferral'), false);
  assert.ok(ok(checkAtomicWorks(graph, { gaps: [gap], refusals: [] })).some(finding => finding.code === 'work_blocking_gap_open'));
  const missingConsumers = clone(gap) as unknown as Record<string, unknown>; delete missingConsumers['consumers'];
  const missingBlocking = clone(gap) as unknown as Record<string, unknown>; delete missingBlocking['blocking'];
  const values: unknown[] = [undefined, null, [], {}, { gaps: [] }, { refusals: [] }, { gaps: null, refusals: [] },
    { gaps: [], refusals: null }, { gaps: [null], refusals: [] }, { gaps: [missingConsumers], refusals: [] },
    { gaps: [missingBlocking], refusals: [] }];
  for (const consumers of [null, undefined, {}, [''], [false]]) values.push({ gaps: [{ ...gap, consumers }], refusals: [] });
  for (const blocking of [null, undefined, 'true', 1]) values.push({ gaps: [{ ...gap, blocking }], refusals: [] });
  for (const deferral of [undefined, null, false, {}, { reason: 'outside_horizon', until: 'horizon-entry' },
    { reason: 'other', until: 'horizon-entry', blocks: [] }, { reason: 'outside_horizon', until: 'later', blocks: [] },
    { reason: 'outside_horizon', until: 'horizon-entry', blocks: [null] }]) values.push({ gaps: [{ ...gap, deferral }], refusals: [] });
  for (const refusal of [null, {}, { code: 'x', message: 'missing address' }, { code: 'x', message: 'missing target', at: {} },
    { code: '', message: 'empty code', at: { target: 'work' } }]) values.push({ gaps: [], refusals: [refusal] });
  for (const value of values) assert.throws(() => checkAtomicWorks(graph, value as Parameters<typeof checkAtomicWorks>[1]),
    (error: unknown) => error instanceof EngineError && error.code === 'atomic_gate_request_invalid'
      && canonical(error.details) === canonical({ unit: 'G5', target: 'works', field: 'gaps' }));
});

test('F5 fixture produces real local E4 cycles and preserves both D7 consumer bindings after restart', async t => {
  const f = await atomicFixture(t);
  assert.equal(f.sent().length, f.results.length);
  assert.equal(f.results.length, f.cycles.length);
  assert.equal(f.transfers.length, 2);
  assert.deepEqual(f.transfers.map(item => item.id).sort(),
    f.ledger.handoff.obligations.map(item => taskBindingId(item as CarriedObligation)).sort());
  const saved = f.results.map(result => ok(readPartAssembly(f.store, { project: f.project, record: result.record })));
  const before = heads(f.store), sent = f.sent().length;
  const prepared = ok(prepareWorksAcceptance(f.store, f.request));
  assert.equal(prepared.state, 'accepted', JSON.stringify({ seed: f.seedRoot, findings: gateWrite(prepared).value.result.findings })); assert.ok(prepared.acceptance);
  assert.deepEqual(heads(f.store), before, 'The complete V2 preparation leaves no partial acceptance');
  f.restart();
  for (const cycle of f.cycles) assert.equal(ok(readModelCycle(f.store, { project: f.project, record: cycle })).record.value.terminal, 'assembled');
  f.results.forEach((result, index) => assert.deepEqual(ok(readPartAssembly(f.store, { project: f.project, record: result.record })), saved[index]));
  assert.deepEqual(heads(f.store), before); assert.equal(f.sent().length, sent);
});

test('F5 accepts real E2.1 and E4 work results with two distinct consumers, rebased D7 and exact restart history', async t => {
  const f = await atomicFixture(t), before = heads(f.store), sent = f.sent().length;
  const prepared = ok(prepareWorksAcceptance(f.store, f.request));
  assert.equal(prepared.state, 'accepted', JSON.stringify({ seed: f.seedRoot, findings: gateWrite(prepared).value.result.findings }));
  assert.deepEqual(heads(f.store), before, 'Preparation must leave all heads untouched');
  assert.ok(prepared.writes.length); assert.ok(prepared.guards.length);
  const batches: string[][] = [], writeMany = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => { batches.push(writes.map(write => write.kind)); return writeMany(writes, guards); }) as Store['writeMany'];
  const accepted = ok(writeWorksAcceptance(f.store, f.request)); f.store.writeMany = writeMany;
  assert.equal(accepted.state, 'accepted', JSON.stringify({ seed: f.seedRoot, findings: gateWrite(accepted).value.result.findings })); assert.ok(accepted.acceptance);
  assert.equal(batches.length, 1, 'Candidate, G5, rederived D7 and C5 acceptance share one transaction');
  const event = { ...accepted.acceptance, level: 3 as const };
  const historical = ok(readAcceptedFrame(f.store, event));
  assert.equal(historical.state, 'accepted'); assert.ok(historical.graph && historical.layer && historical.frame);
  assert.equal(historical.frame.value.acceptance.gate.name, 'G5');
  const candidate = ok(readCandidate(f.store, { project: f.project, candidate: historical.frame.value.acceptance.candidate }));
  assert.ok(candidate.value.works);
  const handoff = ok(readOmObligations(f.store, { project: f.project, producer: candidate.value.works.producer }));
  assert.equal(handoff.handoff.obligations.length, 2); assert.notDeepEqual(reference(handoff.record), reference(f.ledger.record));
  assert.deepEqual(obligationHandoff(f.store, f.project, [...historical.layer.value.inputs]), handoff.handoff);
  assert.deepEqual(taskObligationHandoff(f.store, f.project, [...historical.layer.value.inputs]), handoff.handoff);
  assert.deepEqual(handoff.handoff.obligations.map(item => item.responsibleConsumer).sort(),
    f.ledger.handoff.obligations.map(item => item.responsibleConsumer).sort());
  assert.deepEqual(handoff.handoff.obligations.map(item => [item.kind, item.moment, item.responsibleNode, item.responsibleConsumer,
    item.returnCondition, item.wake]).map(canonical).sort(), f.ledger.handoff.obligations.map(item => [item.kind, item.moment,
      item.responsibleNode, item.responsibleConsumer, item.returnCondition, item.wake]).map(canonical).sort());
  assert.equal(candidate.value.works.bindings.length, 2);
  assert.deepEqual(candidate.value.works.bindings.map(item => item.id).sort(), handoff.handoff.obligations.map(item => taskBindingId(item as CarriedObligation)).sort());
  assert.ok(candidate.value.works.bindings.every(binding => !f.transfers.some(original => original.id === binding.id)));
  assert.deepEqual(candidate.value.works.bindings.map(binding => binding.consumers).map(canonical).sort(), f.transfers.map(binding => binding.consumers).map(canonical).sort());
  const gate = historical.frame.value.acceptance.gate;
  assert.equal(gate.name, 'G5'); if (gate.name !== 'G5') return;
  assert.equal(ok(readAtomicGate(f.store, { project: f.project, record: gate.basis })).value.result.passed, true);
  const passed = ok(readAtomicGate(f.store, { project: f.project, record: gate.basis }));
  assert.ok(f.gaps.records.some(record => record.value.gap.code === 'obligation_open' && record.value.gap.blocking
    && record.value.gap.evidence.some(evidence => evidence.origin === 'works')));
  const resolved = ok(readGaps(f.store, passed.value.request.gaps as GapReadRequest));
  assert.ok(!resolved.collection.gaps.some(gap => gap.code === 'obligation_open' && gap.blocking
    && gap.evidence.some(evidence => evidence.origin === 'works')), 'The final candidate resolves its original L3 obligations');
  const contexts = measuredContexts(f.store, passed.value as AtomicGateRecord);
  assert.equal(passed.value.request.taskContextContract, BASIS_TASK_CONTEXT_CONTRACT);
  assert.equal(contexts.length, candidate.value.graph.horizon.length);
  assert.ok(contexts.some(item => item.task.researchObligations!.length === 2));
  for (const item of contexts) {
    const payload = JSON.parse(item.context.text);
    assert.equal(payload.version, 'omg-task-context/preplan-v3');
    assert.equal(payload.selectedSpecification.contract, 'selected-specification/v2');
    assert.deepEqual(payload.criteria.researchObligations, item.task.researchObligations);
    assert.ok(payload.binding.candidate); assert.ok(payload.binding.environment); assert.ok(payload.binding.neighbors);
  }
  assert.equal(f.sent().length, sent); assert.equal(f.store.list('accepted-answer').length, 0);
  const { projectId: _project, ...configuration } = f.environment.value;
  f.engine.environments.configure(f.project, { ...configuration, requestCapacityChars: 1 }, f.environment.revision);
  const snapshot = heads(f.store); f.restart();
  assert.deepEqual(ok(readAcceptedFrame(f.store, event)), historical);
  assert.deepEqual(obligationHandoff(f.store, f.project, [...historical.layer.value.inputs]), handoff.handoff);
  assert.deepEqual(taskObligationHandoff(f.store, f.project, [...historical.layer.value.inputs]), handoff.handoff);
  assert.deepEqual(ok(readAtomicGate(f.store, { project: f.project, record: gate.basis })), passed,
    'Historical G5 retains its exact original environment after a current limit change');
  for (const cycle of f.cycles) ok(readModelCycle(f.store, { project: f.project, record: cycle }));
  const repeat = ok(writeWorksAcceptance(f.store, f.request)); assert.equal(repeat.state, 'unchanged');
  assert.deepEqual(repeat.acceptance, accepted.acceptance); assert.deepEqual(heads(f.store), snapshot); assert.equal(f.sent().length, sent);
});

test('G5 a D7 of another request among the sources is refused: all final proposals belong to one original handoff', async t => {
  const f = await atomicFixture(t, true), before = heads(f.store);
  assert.ok(f.foreign);
  const produce = f.request.results.find(result => {
    const works = ok(readPartAssembly(f.store, { project: f.project, record: result.record })).record.value.works!;
    return works.bindings.some(binding => binding.consumers.some(consumer => consumer.node.includes('garden-produce')));
  }) ?? f.request.results[0]!;
  const foreign = ok(readPartAssembly(f.store, { project: f.project, record: f.foreign.record })).record.value.works!;
  const request = ok(readOmObligations(f.store, { project: f.project, producer: foreign.producer })).record.value.request;
  assert.notEqual(canonical(request as unknown as Json), canonical(f.ledger.record.value.request as unknown as Json), 'Another request');
  const mixed = { ...f.request, results: f.request.results.map(result => result === produce ? f.foreign! : result) };
  denied(prepareWorksAcceptance(f.store, mixed), 'atomic_gate_bindings_unproven');
  denied(prepareWorksSources(f.store, { project: f.project, results: mixed.results }), 'atomic_gate_bindings_unproven');
  assert.deepEqual(heads(f.store), before, 'Nothing is written');
});

test('F5 declared work goal closes accepted L3 gaps and confirms progress through D2 and A3 after restart', async t => {
  const f = await atomicFixture(t), beforeSend = f.sent().length, declared = f.openGoal;
  const address = { project: f.project, block: declared.block, line: 1 };
  const open = ok(readSeries(f.store, address)), earlier = open.value.attempts.find(attempt => attempt.ordinal === declared.ordinal)!;
  assert.deepEqual(reference(open), declared.series); assert.deepEqual(earlier.goal, declared.goal); assert.equal(earlier.outcome, null);
  const accepted = ok(writeWorksAcceptance(f.store, f.request));
  assert.equal(accepted.state, 'accepted', JSON.stringify({ seed: f.seedRoot, findings: gateWrite(accepted).value.result.findings }));
  assert.ok(accepted.acceptance); const acceptance = accepted.acceptance;
  const previous = f.store.get<GapLinesRecord>(f.lines.id)!;
  const sources = clone(f.gapRead.sources) as GapRequest;
  assert.ok(!('state' in sources.works)); if ('state' in sources.works) throw new Error('A real works frame is required');
  sources.graph = acceptance.graph; sources.operations.frame.graph = acceptance.graph;
  sources.works = { frame: { ...sources.works.frame, graph: acceptance.graph, layer: acceptance.layer, frame: acceptance.frame }, proposals: [] };
  const current = ok(writeGaps(f.store, sources)), gaps: GapReadRequest = { sources: clone(current.sources) as GapRequest, records: current.records.map(reference) };
  const targets = f.gaps.records.filter(record => record.value.gap.code === 'obligation_open'
    && record.value.gap.evidence.some(evidence => evidence.origin === 'works')
    && declared.goal.questions.includes(gapLineKey(f.project, record.value.gap.target, record.value.gap.field))).map(record => record.value.gap);
  assert.ok(targets.length > 1, 'The declared node goal contains its complete outcome and connection obligations');
  assert.equal(targets.length, declared.goal.questions.length);
  assert.ok(targets.every(target => !current.collection.gaps.some(gap => gap.id === target.id)));
  const link = { series: declared.series, attempt: declared.ordinal };
  const request: GapLinesRequest = { project: f.project, previous: reference(previous), pass: previous.value.request.pass + 1, gaps,
    closures: targets.map(target => ({ id: target.id, reason: 'filled', basis: acceptance.frame, acceptance, attempt: link })) };
  const snapshot = heads(f.store);
  const unbound = ok(prepareGapLines(f.store, { ...request, closures: request.closures.map(closure => ({ ...closure, attempt: null })) }));
  assert.ok(unbound.record.lines.filter(line => targets.some(target => target.id === line.id)).every(line => line.status === 'closed'));
  assert.deepEqual(heads(f.store), snapshot, 'Direct closure without achievement attribution is also a pure legal preparation');
  const wrongAddress = { project: f.project, block: 'garden-refusal-block', line: 1 };
  ok(openSeries(f.store, { ...wrongAddress, slice: 'foreign-work-goal', predecessor: null, basis: null }));
  const foreign = ok(beginAttempt(f.store, { ...wrongAddress, attempt: 1, goal: declared.goal }));
  const foreignObligation = f.gaps.records.find(record => record.value.gap.code === 'obligation_open'
    && record.value.gap.evidence.some(evidence => evidence.origin === 'works')
    && !declared.goal.questions.includes(gapLineKey(f.project, record.value.gap.target, record.value.gap.field)))!.value.gap;
  assert.ok(!current.collection.gaps.some(gap => gap.id === foreignObligation.id));
  const beforeRefusal = heads(f.store);
  for (const closures of [
    request.closures.map(closure => ({ ...closure, attempt: { series: reference(foreign), attempt: 1 } })),
    [{ ...request.closures[0]!, id: foreignObligation.id }],
  ]) for (const operation of [prepareGapLines, writeGapLines]) {
    denied(operation(f.store, { ...request, closures }), 'closure_unconfirmed');
    assert.deepEqual(heads(f.store), beforeRefusal, 'A foreign block or unannounced obligation cannot write part of a closure');
  }
  const prepared = ok(prepareGapLines(f.store, request));
  for (const ref of [declared.series, acceptance.graph, acceptance.layer, acceptance.frame])
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)), ref.id);
  const saved = ok(writeGapLines(f.store, request));
  for (const target of targets) assert.equal(saved.value.lines.find(line => line.id === target.id)!.status, 'closed');
  const resultRequest = { project: f.project, block: declared.block, target: declared.series.id, goal: declared.goal,
    accepting: [reference(saved)], cancelling: [] };
  const confirmed = ok(confirmResults(f.store, resultRequest));
  const identities = targets.map(target => ok(readResultIdentity(f.store, { acceptance, obligation: target.target })));
  assert.deepEqual(confirmed.achieved.map(item => item.key).sort(), [...new Set(identities.map(identity => identity.key))].sort());
  assert.ok(confirmed.achieved.length > 0); assert.deepEqual(confirmed.cancelled, []);
  assert.ok(confirmed.achieved.every(item => canonical(item.basis) === canonical(reference(saved))));
  denied(confirmResults(f.store, { ...resultRequest, block: wrongAddress.block }), 'achievement_unconfirmed');
  denied(confirmResults(f.store, { ...resultRequest, goal: { ...declared.goal, questions: [gapLineKey(f.project, foreignObligation.target, foreignObligation.field)] } }),
    'achievement_unconfirmed');
  const completion = { ...address, attempt: declared.ordinal,
    outcome: { reason: 'result' as const, accepting: [reference(saved)], cancelling: [], refusals: [] } };
  const beforeCompletion = heads(f.store), progress = ok(prepareCloseAttempt(f.store, completion));
  assert.equal(progress.value.verdict, 'progress'); assert.deepEqual(heads(f.store), beforeCompletion);
  const closed = ok(closeAttempt(f.store, completion));
  assert.equal(closed.verdict, 'progress'); assert.equal(closed.withoutProgress, 0);
  const completed = ok(readSeries(f.store, address));
  assert.equal(completed.value.attempts.find(attempt => attempt.ordinal === declared.ordinal)!.verdict, 'progress');
  assert.deepEqual(completed.value.attempts.find(attempt => attempt.ordinal === declared.ordinal)!.outcome!.achieved.map(canonical).sort(),
    confirmed.achieved.map(canonical).sort());
  assert.equal(completed.value.withoutProgress, 0);
  const completedSnapshot = heads(f.store); f.restart();
  assert.deepEqual(ok(readGapLines(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(ok(writeGapLines(f.store, request)), saved);
  assert.deepEqual(ok(confirmResults(f.store, resultRequest)), confirmed);
  assert.deepEqual(ok(closeAttempt(f.store, completion)), closed);
  assert.deepEqual(ok(readSeries(f.store, address)), completed);
  assert.deepEqual(ok(readSeriesAt(f.store, f.project, reference(open))), open);
  assert.deepEqual(ok(readSeriesAt(f.store, f.project, reference(completed))), completed);
  for (const [index, target] of targets.entries()) assert.deepEqual(ok(readResultIdentity(f.store, { acceptance, obligation: target.target })), identities[index]);
  assert.deepEqual(heads(f.store), completedSnapshot); assert.equal(f.sent().length, beforeSend);
  // LG08 (codex-omg2 №10244 (в)): a repeat of this exact goal cannot be declared in this fixture state — the accepted
  // frame resolved every consume obligation and D2 closed its lines, so the current M6 holds no consume batch for it.
  const fresh = ok(writeRoutes(f.store, { project: f.project, gaps,
    tasks: [], catalog: { paths: [], records: [] }, previous: reference(f.routes) }));
  const boundary = heads(f.store);
  // LG08 (codex-omg2 №10415 P3): batch availability is measured the way completionPlanSources selects — every item
  // carries this block among item.consumers and the batch serves the declared goal's questions; node.parent is no key.
  assert.ok(!fresh.value.batches.some(batch => batch.items.every(item => item.consumers.includes(declared.block))
    && batch.items.some(item => declared.goal.questions.includes(gapLineKey(f.project, item.target, item.field)))));
  denied(openAttempt(f.store, { ...address, attempt: declared.ordinal + 1, goal: declared.goal,
    completion: { routes: reference(fresh), batches: [] } }), 'completion_request_invalid');
  assert.deepEqual(heads(f.store), boundary); assert.equal(f.sent().length, beforeSend);
});

test('F5 a stopped series keeps the accepted result of its earlier progress in every read', async t => {
  // LG08 (codex-omg2 №10244 (в)): the stop history stands on the managed block — one supported cycle, then three paid
  // insufficient ends of the same goal key; each next attempt asks for what the current M6 still owes.
  const root = mkdtempSync(join(tmpdir(), 'omg-atomic-stop-'));
  const path = join(root, 'managed.sqlite');
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const m = managedBlock(store, { root, path }, 'alpha'), address = m.address(), key = 'gap:cart:price';
  ok(openSeries(store, { ...address, slice: 'managed-stop', predecessor: null, basis: null }));
  m.open(1, key);
  await m.pay(1, 'supported');
  const firstClaim = m.claim(1);
  const first = m.close(1, firstClaim);
  assert.equal(first.verdict, 'progress'); assert.equal(first.withoutProgress, 0);
  for (const offset of [1, 2, 3]) {
    const repeated = await m.cycle(key, 'insufficient');
    assert.equal(repeated.verdict, 'none'); assert.equal(repeated.withoutProgress, offset);
    assert.equal(repeated.stop === null, offset < 3);
  }
  const stopped = ok(readSeries(store, address)), context = ok(readStopContext(store, address));
  const history = ok(readStopHistory(store, address)), report = ok(stopReport(store, address));
  assert.equal(stopped.value.stop!.attempt, 4);
  assert.equal(history.standing, 4); assert.equal(history.stops.length, 1);
  assert.deepEqual(history.stops[0]!.attempts, [2, 3, 4]);
  assert.deepEqual(history.stops[0]!.goals, [key]);
  const accepted = firstClaim.accepting.map(ref => ok(readAcceptedAnswer(store, { project: m.project, record: ref })).key);
  assert.deepEqual([...context.context.accepted].sort(), [...new Set(accepted)].sort());
  assert.deepEqual(report.context, context.context); assert.equal(report.audience, 'reviewer'); assert.equal(report.rung, 1);
  assert.equal(report.finding.facts.accepted, accepted.length);
  assert.ok(report.guards.some(ref => canonical(ref) === canonical(reference(stopped))));
  assert.deepEqual(ok(checkStanding(store, report)), report);
  const latest = heads(store), cold = new Store(path);
  const sends = () => readFileSync(join(root, 'managed-trace-alpha.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  try {
    assert.deepEqual(ok(readSeries(cold, address)), stopped);
    assert.deepEqual(ok(readStopContext(cold, address)), context);
    assert.deepEqual(ok(readStopHistory(cold, address)), history);
    assert.deepEqual(ok(stopReport(cold, address)), report); assert.deepEqual(ok(checkStanding(cold, report)), report);
    const sent = sends(), late = m.on(cold).close(1, firstClaim);
    assert.equal(late.verdict, 'progress'); assert.deepEqual(late.stop, stopped.value.stop);
    assert.deepEqual(ok(readSeries(cold, address)), stopped, 'A late technical repeat cannot overwrite the later stopped series');
    assert.deepEqual(heads(cold), latest); assert.equal(sends(), sent);
  } finally { cold.close(); }
});

test('F5 G5 capacity measures the complete current task context at the exact boundary and rejects without changing accepted bases', async t => {
  const f = await atomicFixture(t), before = heads(f.store), sent = f.sent().length;
  const initial = ok(prepareWorksAcceptance(f.store, f.request)), pendingGate = gateWrite(initial);
  assert.equal(initial.state, 'accepted', JSON.stringify({ seed: f.seedRoot, findings: gateWrite(initial).value.result.findings })); assert.deepEqual(heads(f.store), before);
  f.restart(); const inspectionPath = join(f.root, 'capacity-inspection.sqlite'); copyFileSync(f.database, inspectionPath);
  const inspection = new Store(inspectionPath);
  let required: number;
  try {
    inspection.writeMany(sourceWrites(initial), [...initial.guards]);
    const contexts = measuredContexts(inspection, pendingGate.value);
    required = Math.max(...contexts.map(item => item.context.chars));
    assert.ok(contexts.every(item => canonical(JSON.parse(item.context.text).neighbors).length < item.context.chars));
  } finally { inspection.close(); }
  const { projectId: _project, ...configuration } = f.environment.value;
  const exactEnvironment = f.engine.environments.configure(f.project, { ...configuration, requestCapacityChars: required }, f.environment.revision);
  const exactRequest = { ...f.request, environment: reference(exactEnvironment) };
  const exact = ok(prepareWorksAcceptance(f.store, exactRequest));
  assert.equal(exact.state, 'accepted', JSON.stringify({ seed: f.seedRoot, findings: gateWrite(exact).value.result.findings })); assert.equal(gateWrite(exact).value.result.passed, true);
  const smallEnvironment = f.engine.environments.configure(f.project, { ...configuration, requestCapacityChars: required - 1 }, exactEnvironment.revision);
  const request = { ...f.request, environment: reference(smallEnvironment) }, beforeRefusal = heads(f.store);
  const preview = ok(prepareWorksAcceptance(f.store, request));
  assert.equal(preview.state, 'rejected', JSON.stringify({ seed: f.seedRoot, findings: gateWrite(preview).value.result.findings })); assert.equal(preview.acceptance, null);
  const outcome = gateWrite(preview).value.result;
  assert.equal(outcome.passed, false); assert.ok(outcome.codes.includes('work_packet_over_capacity'));
  assert.ok(outcome.findings.some(finding => finding.code === 'work_packet_over_capacity' && finding.target.startsWith('garden-')));
  assert.deepEqual(heads(f.store), beforeRefusal, 'Refused preparation also writes nothing');
  const acceptedBases = ['graph:garden', 'graph-layer:garden:2', 'graph-layer:garden:3', 'om-frame:garden:2', 'om-frame:garden:3']
    .map(id => ({ id, value: f.store.get(id) }));
  const rejected = ok(writeWorksAcceptance(f.store, request));
  assert.equal(rejected.state, 'rejected', JSON.stringify({ seed: f.seedRoot, findings: gateWrite(rejected).value.result.findings })); assert.equal(rejected.acceptance, null);
  for (const item of acceptedBases) assert.deepEqual(f.store.get(item.id), item.value, item.id);
  // G6.2 (№3869 п.1, №3885): only the proposals that define a work over capacity are rejected — every other stays proposed,
  // and each diagnostic row names exactly its one holder.
  const over = new Set(outcome.findings.filter(finding => finding.code === 'work_packet_over_capacity').map(finding => finding.target));
  const holds = (ref: Ref) => f.store.get<LayerProposal>(ref.id, ref.revision)!.value.nodes.some(node => over.has(node.id));
  assert.ok(f.proposals.some(holds), 'A proposal defines a work over capacity');
  for (const ref of f.proposals) assert.equal(f.store.get<LayerProposal>(ref.id)!.value.status, holds(ref) ? 'rejected' : 'proposed', ref.id);
  const diagnostic = f.store.list<{ gate: string; refusals: { origin: { sources: { role: string }[] } }[] }>('om-unit-refusal').find(row => row.value.gate === 'G5')!;
  assert.ok(diagnostic.value.refusals.every(row => row.origin.sources.filter(source => source.role === 'proposal').length === 1));
  const stored = ok(readWorksAcceptance(f.store, { project: f.project, record: reference(rejected.record) }));
  const snapshot = heads(f.store); f.restart();
  assert.deepEqual(ok(readWorksAcceptance(f.store, { project: f.project, record: reference(rejected.record) })), stored);
  const repeat = ok(writeWorksAcceptance(f.store, request));
  assert.equal(repeat.state, 'unchanged'); assert.equal(repeat.acceptance, null);
  assert.deepEqual(heads(f.store), snapshot); assert.equal(f.sent().length, sent);
});

test('F5 every returned head guard and expected-zero prerequisite protects the one acceptance transaction', async t => {
  const f = await atomicFixture(t), prepared = ok(prepareWorksAcceptance(f.store, f.request)), sent = f.sent().length;
  assert.equal(prepared.state, 'accepted', JSON.stringify({ seed: f.seedRoot, findings: gateWrite(prepared).value.result.findings }));
  assert.ok(prepared.guards.some(guard => guard.id === f.environment.id));
  assert.ok(prepared.guards.some(guard => guard.id === f.input.id));
  assert.ok(prepared.guards.some(guard => guard.id === f.layer2.id));
  assert.ok(prepared.guards.some(guard => guard.id === f.lines.id));
  assert.deepEqual(prepared.guards.filter(guard => guard.id === 'om-frame:garden:3'),
    [{ id: 'om-frame:garden:3', absent: true }]);
  f.restart();
  for (const [index, guard] of prepared.guards.entries()) {
    const database = join(f.root, `guard-${index}.sqlite`); copyFileSync(f.database, database);
    const main = new Store(database), other = new Store(database);
    try {
      if ('absent' in guard) {
        assert.equal(other.get(guard.id), null, guard.id);
        const pending = prepared.writes.find(write => write.id === guard.id);
        if (pending) assert.equal(pending.expected, 0);
        other.write(pending ?? { id: guard.id, kind: 'fixture', expected: 0, value: {} });
      } else {
        const old = other.get(guard.id)!; assert.ok(old, guard.id);
        other.write({ id: old.id, kind: old.kind, expected: old.revision, value: old.value });
      }
      const afterRace = heads(main), concurrent = other.get(guard.id);
      const refused = writeGuarded(main, { unit: 'G5', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards });
      assert.equal(refused.ok, false);
      if (refused.ok) assert.fail('A changed transaction guard must refuse the entire acceptance');
      assert.equal(refused.refusal.code, 'input_stale');
      assert.equal(refused.refusal.at.target, guard.id);
      assert.equal(refused.refusal.route, 'producer');
      assert.deepEqual(heads(main), afterRace, guard.id);
      assert.deepEqual(main.get(guard.id), concurrent, 'The refusal retains the concurrent record');
      assert.equal(main.get(prepared.record.id), null);
    } finally { other.close(); main.close(); }
  }
  const pending = prepared.writes.find(write => write.kind === 'writer-index' && write.expected === 0);
  assert.ok(pending, 'The first-writer index also uses the same acceptance CAS');
  assert.equal(prepared.guards.some(guard => guard.id === pending.id && 'absent' in guard), false,
    'This expected-zero conflict is separate from the complete returned absence guards');
  const database = join(f.root, 'index-race.sqlite'); copyFileSync(f.database, database);
  const main = new Store(database), other = new Store(database);
  try {
    other.write(pending); const afterRace = heads(main);
    denied(writeGuarded(main, { unit: 'G5', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }), 'revision_conflict');
    assert.deepEqual(heads(main), afterRace); assert.equal(main.get('om-frame:garden:3'), null);
  } finally { other.close(); main.close(); }
  assert.equal(f.sent().length, sent);
});

test('F5 rejects counterfeit G5 outcomes, altered neighbor contents and loss of the second checked consumer', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const f = await atomicFixture(t), prepared = ok(prepareWorksAcceptance(f.store, f.request)), preparedGate = gateWrite(prepared);
  f.store.writeMany(sourceWrites(prepared), [...prepared.guards]);
  const request = preparedGate.value.request, candidate = ok(readCandidate(f.store, { project: f.project, candidate: request.candidate }));
  assert.equal(candidate.value.works!.bindings.length, 2);
  const lost = clone(candidate.value.request) as FrameCandidateRecord['request']; lost.works!.bindings.pop();
  const before = heads(f.store);
  denied(prepareWorksFrame(f.store, lost), 'works_obligations_invalid');
  assert.deepEqual(heads(f.store), before);
  denied(prepareAtomicGate(f.store, { ...request, results: [] }), 'atomic_gate_bindings_unproven');
  denied(prepareAtomicGate(f.store, { ...request, results: request.results.slice(1) }), 'atomic_gate_bindings_unproven');
  const valid = ok(prepareAtomicGate(f.store, request)); assert.equal(valid.record.value.result.passed, true, JSON.stringify(valid.record.value.result.findings));
  assert.deepEqual(ok(prepareAtomicGate(f.store, { ...request, results: [...request.results].reverse(), sources: [...request.sources].reverse() })).record,
    valid.record, 'Unordered complete result and Source sets retain the same exact G5 identity');
  assert.deepEqual(heads(f.store), before); f.restart();
  for (const [name, change] of [
    ['false-success-shape', (value: AtomicGateRecord) => { value.result.graphHash = '0'.repeat(64); }],
    ['invented-finding', (value: AtomicGateRecord) => { value.result.findings = [{ code: 'invented', target: 'garden-produce-work', message: 'fabricated evidence' }]; }],
    ['foreign-contract', (value: AtomicGateRecord) => { (value as unknown as Record<string, unknown>)['contract'] = 'om-atomic-gate/unknown'; }],
  ] as const) {
    const database = join(f.root, `${name}.sqlite`); copyFileSync(f.database, database); const store = new Store(database);
    try {
      const value = clone(preparedGate.value); change(value);
      const forged = store.write({ ...preparedGate, value });
      const snapshot = heads(store);
      denied(readAtomicGate(store, { project: f.project, record: reference(forged) }), 'atomic_gate_record_forged');
      denied(settleCandidate(store, { project: f.project, level: 3, candidate: request.candidate,
        outcome: { ...preparedGate.value.result, basis: reference(forged) } }), 'atomic_gate_record_forged');
      assert.deepEqual(heads(store), snapshot); assert.equal(store.get('om-frame:garden:3'), null);
    } finally { store.close(); }
  }
  for (const mode of ['duplicate', 'missing', 'contents'] as const) {
    const database = join(f.root, `neighbors-${mode}.sqlite`); copyFileSync(f.database, database); const store = new Store(database);
    try {
      const current = store.get<NeighborCollection>(request.neighbors.id)!, value = clone(current.value);
      if (mode === 'duplicate') value.packets.push(clone(value.packets[0]!));
      if (mode === 'missing') value.packets.pop();
      if (mode === 'contents') {
        const packet = value.packets.find(packet => packet.neighbors.length)!;
        packet.neighbors[0]!.neighbor.work.title += ' forged'; packet.hash = hashJson(packet.neighbors);
      }
      const forged = store.write({ id: current.id, kind: current.kind, expected: current.revision, value });
      const snapshot = heads(store);
      denied(prepareAtomicGate(store, { ...request, neighbors: reference(forged) }), 'neighbor_record_forged');
      assert.deepEqual(heads(store), snapshot); assert.equal(store.get('om-frame:garden:3'), null);
    } finally { store.close(); }
  }
  const saved = ok(writeAtomicGate(f.store, request)), snapshot = heads(f.store);
  assert.deepEqual(ok(writeAtomicGate(f.store, request)), saved); assert.deepEqual(heads(f.store), snapshot);
  f.restart(); assert.deepEqual(ok(readAtomicGate(f.store, { project: f.project, record: reference(saved) })), saved);
  const storageFailure = new Error('Exact source read failed'), get = f.store.get.bind(f.store);
  f.store.get = (() => { throw storageFailure; }) as Store['get'];
  try {
    for (const operation of [() => prepareAtomicGate(f.store, request), () => writeAtomicGate(f.store, request),
      () => readAtomicGate(f.store, { project: f.project, record: reference(saved) }),
      () => prepareWorksAcceptance(f.store, f.request), () => writeWorksAcceptance(f.store, f.request),
      () => readWorksAcceptance(f.store, { project: f.project, record: reference(prepared.record) })])
      assert.throws(operation, error => error === storageFailure);
  } finally { f.store.get = get; }
  assert.deepEqual(heads(f.store), snapshot, 'A failed source read is not a negative gate verdict or partial write');
});

test('F5 required fields: a missing snapshot, a missing binding and a foreign taskContextContract are typed refusals on both public doors', async t => {
  const f = await atomicFixture(t), prepared = ok(prepareWorksAcceptance(f.store, f.request)), preparedGate = gateWrite(prepared);
  f.store.writeMany(sourceWrites(prepared), [...prepared.guards]);
  const request = preparedGate.value.request, before = heads(f.store);
  const noSnapshot = clone(request) as Partial<AtomicGateRequest>; delete noSnapshot.snapshot;
  const noBinding = clone(f.request) as Partial<typeof f.request>; delete noBinding.binding;
  const invalidRequest = (error: unknown) =>
    error instanceof EngineError && error.code === 'atomic_gate_request_invalid';
  assert.throws(() => prepareAtomicGate(f.store, noSnapshot as AtomicGateRequest), invalidRequest);
  assert.throws(() => writeAtomicGate(f.store, noSnapshot as AtomicGateRequest), invalidRequest);
  assert.throws(() => prepareAtomicGate(f.store, { ...request, taskContextContract: TASK_CONTEXT_CONTRACT }), invalidRequest);
  assert.throws(() => writeAtomicGate(f.store, { ...request, taskContextContract: TASK_CONTEXT_CONTRACT }), invalidRequest);
  assert.throws(() => prepareWorksAcceptance(f.store, noBinding as typeof f.request), invalidRequest);
  assert.throws(() => writeWorksAcceptance(f.store, noBinding as typeof f.request), invalidRequest);
  assert.deepEqual(heads(f.store), before, 'A missing or foreign required field writes nothing');
});

test('F5 public gate and acceptance boundaries reject absent inputs before reading the Store', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-f5-invalid-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const sourceFailure = new Error('Storage must not be reached for malformed requests');
  store.get = (() => { throw sourceFailure; }) as Store['get'];
  for (const request of [undefined, null, [], {}, { project: 'garden', results: [], environment: null }]) {
    for (const operation of [prepareAtomicGate, writeAtomicGate, prepareWorksAcceptance, writeWorksAcceptance, readAtomicGate, readWorksAcceptance])
      assert.throws(() => (operation as (store: Store, request: unknown) => unknown)(store, request), (error: unknown) =>
        error instanceof EngineError && error.code === 'atomic_gate_request_invalid'
        && (error.details as { unit?: string }).unit === 'G5');
  }
  const exact = { id: 'exact:record', revision: 1, hash: hashJson('exact') };
  for (const sources of [undefined, null, {}, [null], [exact, exact]]) {
    const requests = [
      { project: 'garden', candidate: exact, neighbors: exact, environment: exact, gaps: {}, results: [], sources },
      { project: 'garden', environment: exact, results: [{ kind: 'assembly', record: exact }], sources },
    ];
    for (const [index, request] of requests.entries()) for (const operation of index === 0
      ? [prepareAtomicGate, writeAtomicGate] : [prepareWorksAcceptance, writeWorksAcceptance])
      assert.throws(() => (operation as (store: Store, request: unknown) => unknown)(store, request), engineFailure('atomic_gate_request_invalid'));
  }
  const missingSources = { project: 'garden', environment: exact, results: [{ kind: 'assembly', record: exact }] };
  for (const operation of [prepareWorksAcceptance, writeWorksAcceptance])
    assert.throws(() => operation(store, missingSources as unknown as Parameters<typeof prepareWorksAcceptance>[1]), engineFailure('atomic_gate_request_invalid'));

});

function externalCandidate(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-f5-external-')), database = join(root, 'state.sqlite'), project = 'garden';
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const desired = enrichedGraph(exampleGraph(), project);
  desired.artifacts.find(artifact => artifact.id === 'garden-data')!.external = true;
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph, field => preparedField(project, field));
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
    if (level === 3) markedWorks(graph);
    const projected = projectGraph(graph, level), mapped = explicitMapping(graph, frame.upper, frame.scope, level);
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
  input = addressFixtureFields(store, project, reference(input), graph, [layer]);
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph, refinement: layer,
    available: {}, choice: { choiceVersion: 'external-works', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const basis = ok(prepareFrame(store, { project, level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
    upper: { horizon: reference(horizon.gate), frame: upperFrame } }));
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
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'external-producer', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'external-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command,
    timeoutMs: 5000, requestCapacityChars: 200_000 }, 0);
  const path = join(root, 'input.txt'); writeFileSync(path, 'A captured external input');
  const source = new Evidence(store).file(project, 'garden-data', root, 'input.txt', 'text/plain', 0);
  const request: AtomicGateRequest = { project, candidate: reference(candidate.record), neighbors: reference(neighbors),
    environment: reference(environment), gaps: gapRead, results: [], sources: [reference(source)], snapshot: null };
  assert.deepEqual(candidate.record.value.graph.horizon, ['garden-consume-work']);
  assert.equal(store.get('execution-root:garden'), null);
  return { root, database, project, path, source, candidate, request,
    get store() { return store; }, restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); } };
}

const engineFailure = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;

const transactionConflict = (error: unknown) => (error as { refusal?: { code?: string } }).refusal?.code === 'atomic_gate_transaction_conflict';

test('S1.1 the preview transaction over a plain Store is its own frozen source view: pending rows by head, exact next revision, list and history; old exact revisions and the lower Store untouched; the same add is idempotent, two versions conflict, a moved head refuses before publishing', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-s11-tx-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const existing = store.write({ id: 'kept', kind: 'fixture', expected: 0, value: { v: 1 } });
  store.write({ id: 'other', kind: 'another', expected: 0, value: { v: 'o' } });
  const tx = transactionForTests(store);
  assert.equal(types.isProxy(tx.view), false); assert.ok(tx.view instanceof Store); assert.ok(Object.isFrozen(tx.view)); assert.notEqual(tx.view, store);
  assert.equal(tx.view.path, store.path);
  assert.deepEqual(tx.view.get('kept'), existing); assert.equal(tx.view.get('new'), null); assert.equal(tx.view.get('new', 1), null);
  assert.deepEqual(tx.view.list().map(row => row.id), ['kept', 'other']); assert.deepEqual(tx.view.history('new'), []);
  // An existing record and its next pending revision; the old exact revision stays readable.
  const next: Write = { id: 'kept', kind: 'fixture', expected: 1, value: { v: 2 } };
  tx.add({ writes: [next], guards: [reference(existing)] });
  const pendingKept = { id: 'kept', kind: 'fixture', revision: 2, hash: hashJson(next.value), value: next.value };
  assert.deepEqual(tx.view.get('kept'), pendingKept); assert.deepEqual(tx.view.get('kept', 2), pendingKept);
  assert.deepEqual(tx.view.get('kept', 1), existing, 'Old exact revisions stay'); assert.equal(tx.view.get('kept', 3), null);
  assert.deepEqual(tx.view.history('kept'), [existing, pendingKept]);
  // Absence becomes a pending row at its exact Ref.
  const fresh: Write = { id: 'new', kind: 'fixture', expected: 0, value: { v: 'n' } };
  tx.add({ writes: [fresh], guards: [] });
  const pendingNew = { id: 'new', kind: 'fixture', revision: 1, hash: hashJson(fresh.value), value: fresh.value };
  assert.deepEqual(tx.view.get('new'), pendingNew); assert.deepEqual(tx.view.get('new', 1), pendingNew); assert.equal(tx.view.get('new', 2), null);
  assert.deepEqual(tx.view.history('new'), [pendingNew]);
  assert.deepEqual(tx.view.list().map(row => [row.id, row.revision]), [['kept', 2], ['new', 1], ['other', 1]]);
  assert.deepEqual(tx.view.list('fixture').map(row => row.id), ['kept', 'new']); assert.deepEqual(tx.view.list('another').map(row => row.id), ['other']);
  // The lower Store is untouched.
  assert.deepEqual(store.get('kept'), existing); assert.equal(store.get('new'), null); assert.deepEqual(store.list().map(row => row.id), ['kept', 'other']);
  assert.deepEqual(store.history('kept'), [existing]);
  // The same add changes nothing; a second version of one id is the former conflict.
  const size = tx.writes.size; tx.add({ writes: [fresh, next], guards: [] }); assert.equal(tx.writes.size, size); assert.deepEqual(tx.view.get('new'), pendingNew);
  assert.throws(() => tx.add({ writes: [{ ...fresh, value: { v: 'changed' } }], guards: [] }), transactionConflict);
  assert.deepEqual(tx.view.get('new'), pendingNew);
  // №1942-3: a head that moved beneath the acceptance refuses before its pending revision is published — nothing is shadowed.
  const rival = new Store(store.path);
  const raced = rival.write({ id: 'raced', kind: 'fixture', expected: 0, value: { v: 'other-process' } });
  const movedKept = rival.write({ id: 'kept', kind: 'fixture', expected: 1, value: { v: 'moved' } });
  rival.close();
  assert.throws(() => tx.add({ writes: [{ id: 'raced', kind: 'fixture', expected: 0, value: { v: 'prepared-before-race' } }], guards: [] }), transactionConflict);
  assert.equal(tx.writes.has('raced'), false); assert.deepEqual(tx.view.get('raced'), raced); assert.deepEqual(tx.view.get('raced', 1), raced);
  const late = transactionForTests(store);
  assert.throws(() => late.add({ writes: [next], guards: [] }), transactionConflict, 'A stale expected revision is refused as well');
  assert.deepEqual(late.view.get('kept'), movedKept); assert.equal(late.writes.size, 0);
});

test('S1.1 a positive exact read cached under the preview is never shadowed; two transactions share no answers; over a traced Store the preview stays opaque and the lower collector sees every reading', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-s11-tx-race-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const rival = new Store(store.path), current = rival.write({ id: 'row', kind: 'fixture', expected: 0, value: 'other-process' }); rival.close();
  const tx = transactionForTests(store), key = { reader: 'S1.1.exact', project: 'p', ref: reference(current) };
  // The race of №1942-3: the proof read the rival's revision 1 under the preview; the prepared write expected:0 for the same
  // id is refused when published — the direct read and the hot proof keep agreeing on the one real body.
  withHistoricalReads(() => {
    let bodies = 0;
    const read = () => historicalProof(tx.view, key, view => { bodies++; return view.get('row', 1); }, () => assert.fail('The exact read is not cyclic'));
    assert.deepEqual(read(), current); assert.deepEqual(read(), current); assert.equal(bodies, 1);
    assert.throws(() => tx.add({ writes: [{ id: 'row', kind: 'fixture', expected: 0, value: 'prepared-before-race' }], guards: [] }), transactionConflict);
    assert.deepEqual(tx.view.get('row', 1), read()); assert.deepEqual(tx.view.get('row'), current); assert.equal(bodies, 1);
  });
  // Two transactions with the same proof key share no answers: each preview is its own region.
  const one = transactionForTests(store), two = transactionForTests(store), keyNew = { reader: 'S1.1.pending', project: 'p', ref: reference(current) };
  one.add({ writes: [{ id: 'new', kind: 'fixture', expected: 0, value: 'one' }], guards: [] });
  withHistoricalReads(() => {
    let bodies = 0;
    const readOn = (view: Store) => historicalProof(view, keyNew, seen => { bodies++; return seen.get('new'); }, () => assert.fail('not cyclic'));
    assert.equal(readOn(one.view)?.value, 'one'); assert.equal(readOn(two.view), null); assert.equal(bodies, 2);
    assert.equal(readOn(one.view)?.value, 'one'); assert.equal(readOn(two.view), null); assert.equal(bodies, 2, 'Each region keeps its own proof');
  });
  // A growing pending set moves the head and list/history of the preview: the proof that read the head is derived again.
  withHistoricalReads(() => {
    let bodies = 0; const grown = transactionForTests(store);
    const read = () => historicalProof(grown.view, keyNew, view => { bodies++; return { head: view.get('new'), rows: view.list('fixture').length, history: view.history('new').length }; }, () => assert.fail('not cyclic'));
    assert.deepEqual(read(), { head: null, rows: 1, history: 0 }); read(); assert.equal(bodies, 1);
    grown.add({ writes: [{ id: 'new', kind: 'fixture', expected: 0, value: 'grown' }], guards: [] });
    assert.deepEqual(read().rows, 2); assert.equal(bodies, 2); read(); assert.equal(bodies, 2);
  });
  // Over a traced Store the preview keeps its opaque branch: two bodies, and the lower collector sees both readings.
  withHistoricalReads(() => {
    let observed = 0, bodies = 0;
    const lower = historicalTrace(store, () => observed++), opaque = transactionForTests(lower);
    assert.equal(types.isProxy(opaque.view), true);
    const read = () => historicalProof(opaque.view, key, view => { bodies++; return view.get('row', 1); }, () => assert.fail('not cyclic'));
    assert.deepEqual(read(), current); assert.deepEqual(read(), current);
    assert.deepEqual([bodies, observed], [2, 2]);
  });
});

test('S1.1 (№2008-1) the preview transaction takes the fast branch only over proved reads: a frozen shell on Store.prototype with own reading accessors over a traced Store stays opaque (two bodies, two observations), a genuine Store with an own reading override stays opaque, a write-only view of the storage helper is fast', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-s11-tx-shell-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const row = store.write({ id: 'base', kind: 'fixture', expected: 0, value: { v: 1 } });
  const shell = (target: Store): Store => {
    const view = Object.create(Store.prototype) as Record<string, unknown>;
    Object.defineProperties(view, { path: { value: target.path }, databaseId: { get: () => target.databaseId } });
    for (const name of ['get', 'list', 'history', 'write', 'writeMany'] as const)
      Object.defineProperty(view, name, { get: () => (target[name] as (...args: never[]) => unknown).bind(target) });
    return Object.freeze(view) as unknown as Store;
  };
  const key = { reader: 'S1.1.shell', project: 'p', ref: reference(row) };
  const probe = (view: Store, expectedBodies: number, observedTrace?: () => number) => withHistoricalReads(() => {
    let bodies = 0;
    const read = () => historicalProof(view, key, seen => { bodies++; return seen.get(row.id, 1); }, () => assert.fail('not cyclic'));
    assert.deepEqual(read(), row); assert.deepEqual(read(), row);
    assert.equal(bodies, expectedBodies);
    if (observedTrace) assert.equal(observedTrace(), expectedBodies, 'The lower collector sees every reading');
  });
  // The reviewer's shell: not a Proxy, Store.prototype beneath, but its own reading members reach a traced Store.
  let observed = 0;
  const lower = shell(historicalTrace(store, () => observed++));
  assert.equal(types.isProxy(lower), false); assert.equal(Object.getPrototypeOf(lower), Store.prototype);
  const opaque = transactionForTests(lower);
  assert.equal(types.isProxy(opaque.view), true, 'A shell of unknown reads keeps the opaque preview');
  probe(opaque.view, 2, () => observed);
  // A genuine Store whose instance carries an own reading override is not a genuine Store any more.
  const overridden = new Store(store.path); t.after(() => overridden.close());
  Object.defineProperty(overridden, 'get', { value: overridden.get.bind(overridden) });
  assert.equal(types.isProxy(transactionForTests(overridden).view), true, 'An own reading member forbids the fast branch');
  // The genuine Store and a write-only view of the storage helper over it: proved reads, the fast branch.
  assert.equal(types.isProxy(transactionForTests(store).view), false);
  const writeOnly = storeView(store, { write: (writes, guards) => store.writeMany(writes, guards) });
  assert.equal(types.isProxy(writeOnly), false);
  assert.equal(types.isProxy(transactionForTests(writeOnly).view), false, 'A write-only view of the helper is proved reads');
  probe(transactionForTests(store).view, 1); probe(transactionForTests(writeOnly).view, 1);
});

test('S1.1 the works acceptance over a plain Store proves each key of its history once per transaction: it costs less than the opaque preview over an unknown lower view of the same database and accepts the same', async t => {
  const f = await atomicFixture(t), before = heads(f.store), started = Date.now();
  const stamp = (label: string) => process.stderr.write(`# S11 ${label} at ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  class UnknownLower extends Store {}
  const lower = new UnknownLower(f.database); t.after(() => lower.close());
  const originalGet = Store.prototype.get; let reads = 0;
  Store.prototype.get = function (this: Store, id: string, revision?: number) { reads++; return originalGet.call(this, id, revision); } as typeof Store.prototype.get;
  t.after(() => { Store.prototype.get = originalGet; });
  const measure = (store: Store) => withHistoricalReads(() => { reads = 0; const prepared = ok(prepareWorksAcceptance(store, f.request)); return { prepared, reads }; });
  stamp('fixture ready');
  const fast = measure(f.store); stamp(`plain preview: ${fast.reads} reads`);
  assert.equal(fast.prepared.state, 'accepted', JSON.stringify({ seed: f.seedRoot, findings: gateWrite(fast.prepared).value.result.findings }));
  const opaque = measure(lower); stamp(`opaque preview: ${opaque.reads} reads`);
  assert.deepEqual(opaque.prepared, fast.prepared, 'The opaque preview of an unknown lower view accepts the same');
  assert.ok(fast.reads < opaque.reads, `The plain preview keeps each proof once per transaction: ${fast.reads} physical reads against ${opaque.reads} over the opaque preview`);
  t.diagnostic(`S11 plain ${fast.reads} < opaque ${opaque.reads} physical reads`);
  assert.deepEqual(heads(f.store), before, 'Neither preview writes');
});

test('F5 external Source shares the real compiler current and sealed paths, including malformed and corrupt sources', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-f5-source-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'OM local fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  const path = join(root, 'input.json'), content = JSON.stringify('A captured external input'); writeFileSync(path, content);
  git(root, ['add', 'input.json']); git(root, ['commit', '-qm', 'Capture external input']);
  const repository: RepositoryState = { root, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']),
    files: [{ path: 'input.json', hash: digest(content) }] };
  const graph = enrichedGraph(exampleGraph(), 'garden'); graph.artifacts.find(artifact => artifact.id === 'garden-data')!.external = true;
  const evidence = new Evidence(store), source = evidence.file('garden', 'garden-data', root, 'input.json', 'application/json', 0);
  const ref = reference(source), expected = { receipt: null, source: ref };
  const native = (sealed?: Ref[]) => resolveArtifact(store, 'garden', graph, repository, 'garden-produce-work', 'garden-data', sealed);
  assert.deepEqual(resolveExternalSource(store, 'garden', graph, 'garden-data', ref, true), expected);
  assert.deepEqual(resolveExternalSource(store, 'garden', graph, 'garden-data', ref, false), expected);
  assert.deepEqual(native(), expected); assert.deepEqual(native([ref]), expected);
  assert.equal(store.get('execution-root:garden'), null);
  const args: Parameters<typeof resolveExternalSource> = [store, 'garden', graph, 'garden-data', ref, true];
  for (const [position, bad] of [[0, null], [1, ''], [2, null], [2, {}], [3, 'unknown'], [4, null], [4, {}], [5, undefined], [5, 'true']] as const) {
    const malformed = [...args]; malformed[position] = bad as never;
    assert.throws(() => resolveExternalSource(...malformed as Parameters<typeof resolveExternalSource>), engineFailure('external_source_request_invalid'));
  }
  const missingContract = clone(graph); missingContract.contracts = [];
  assert.throws(() => resolveExternalSource(store, 'garden', missingContract, 'garden-data', ref, true), engineFailure('external_source_request_invalid'));
  assert.throws(() => resolveExternalSource(store, 'garden', graph, 'garden-result', ref, true), engineFailure('external_source_request_invalid'));
  for (const bad of [{ ...ref, id: 'source:other:garden-data' }, { ...ref, revision: 1000 }, { ...ref, hash: hashJson('bad') }])
    assert.throws(() => resolveExternalSource(store, 'garden', graph, 'garden-data', bad, false), engineFailure('external_input_missing'));
  assert.throws(() => native([]), engineFailure('plan_input_invalid'));
  assert.throws(() => native([{ ...ref, hash: hashJson('bad') }]), engineFailure('plan_input_invalid'));
  for (const [change, code] of [
    [(value: Source) => { value.projectId = 'other'; }, 'external_input_missing'],
    [(value: Source) => { value.sha256 = hashJson('invented digest'); }, 'external_input_missing'],
    [(value: Source) => { value.content = JSON.stringify({ wrong: 'schema' }); value.sha256 = digest(value.content); }, 'artifact_contract_mismatch'],
    [(value: Source) => { value.content = '{ malformed'; value.sha256 = digest(value.content); }, 'artifact_contract_mismatch'],
  ] as const) {
    const value = clone(source.value); change(value);
    const forged = store.write({ id: source.id, kind: 'source', expected: store.get(source.id)!.revision, value });
    assert.throws(() => resolveExternalSource(store, 'garden', graph, 'garden-data', reference(forged), false), engineFailure(code));
    assert.throws(() => native([reference(forged)]), engineFailure(code));
  }
  const impostor = new Store(join(root, 'wrong-kind.sqlite'));
  try {
    const wrongKind = impostor.write({ id: source.id, kind: 'not-source', expected: 0, value: source.value });
    assert.throws(() => resolveExternalSource(impostor, 'garden', graph, 'garden-data', reference(wrongKind), false), engineFailure('external_input_missing'));
    assert.throws(() => resolveArtifact(impostor, 'garden', graph, repository, 'garden-produce-work', 'garden-data', [reference(wrongKind)]),
      engineFailure('external_input_missing'));
  } finally { impostor.close(); }
  const restored = evidence.file('garden', 'garden-data', root, 'input.json', 'application/json', store.get(source.id)!.revision);
  assert.deepEqual(native(), { receipt: null, source: reference(restored) });
  assert.throws(() => resolveExternalSource(store, 'garden', graph, 'garden-data', ref, true), engineFailure('external_input_missing'));
  writeFileSync(path, JSON.stringify('Changed after capture'));
  assert.throws(() => native(), engineFailure('external_input_missing'));
  assert.throws(() => resolveExternalSource(store, 'garden', graph, 'garden-data', reference(restored), true), engineFailure('external_input_missing'));
  assert.deepEqual(native([ref]), expected); assert.deepEqual(resolveExternalSource(store, 'garden', graph, 'garden-data', ref, false), expected);
  rmSync(path); assert.deepEqual(native([ref]), expected);
  const empty = new Store(join(root, 'empty.sqlite'));
  try { assert.throws(() => resolveArtifact(empty, 'garden', graph, repository, 'garden-produce-work', 'garden-data'), engineFailure('external_input_missing')); }
  finally { empty.close(); }
});

test('F5 seals exact external sources without an execution root and guards current source heads while preserving history', t => {
  const f = externalCandidate(t), before = heads(f.store);
  const prepared = ok(prepareAtomicGate(f.store, f.request));
  assert.equal(prepared.record.value.result.passed, true, JSON.stringify(prepared.record.value.result.findings));
  assert.deepEqual(heads(f.store), before); assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(f.source))));
  assert.deepEqual(prepared.record.value.request.sources, [reference(f.source)]);
  for (const sources of [[], [{ ...reference(f.source), id: 'source:other:garden-data' }]])
    denied(prepareAtomicGate(f.store, { ...f.request, sources }), 'atomic_gate_basis_unproven');
  assert.throws(() => prepareAtomicGate(f.store, { ...f.request, sources: [{ ...reference(f.source), hash: hashJson('wrong') }] }),
    engineFailure('external_input_missing'));
  writeFileSync(f.path, 'Changed without advancing the Source record');
  assert.throws(() => prepareAtomicGate(f.store, f.request), engineFailure('external_input_missing'));
  writeFileSync(f.path, f.source.value.content);
  const saved = ok(writeAtomicGate(f.store, f.request));
  const other = new Store(f.database);
  try {
    const current = other.get<Source>(f.source.id)!;
    other.write({ id: current.id, kind: current.kind, expected: current.revision, value: current.value });
    const raced = heads(f.store);
    denied(writeGuarded(f.store, { unit: 'G5', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }), 'input_stale');
    assert.deepEqual(heads(f.store), raced, 'The source race cannot partially store a G5 result or its neighboring indexes');
    assert.throws(() => prepareAtomicGate(f.store, f.request), engineFailure('external_input_missing'));
  } finally { other.close(); }
  writeFileSync(f.path, 'Changed after source head movement'); f.restart();
  assert.deepEqual(ok(readAtomicGate(f.store, { project: f.project, record: reference(saved) })), saved);
  rmSync(f.path); f.restart();
  assert.deepEqual(ok(readAtomicGate(f.store, { project: f.project, record: reference(saved) })), saved);
  const historicalHeads = heads(f.store);
  assert.deepEqual(ok(writeAtomicGate(f.store, f.request)), saved, 'An exact late repeat does not perform a new current admission');
  assert.deepEqual(heads(f.store), historicalHeads);
  assert.throws(() => prepareAtomicGate(f.store, f.request), engineFailure('external_input_missing'));
  assert.equal(f.store.get('execution-root:garden'), null);
});

// ---- AT1 (№4091 п.4–6): the impact rule of G5 and the record of the impact era ----
// ---- AT1 (№4091 п.4–6): the impact rule of G5 and the record of the impact era ----
import { gateImpact, ATOMIC_GATE_IMPACT_CONTRACT } from '../src/om/atomic-gate.js';
import { snapshotFiles } from '../src/om/impact.js';
import { gatePolicies, readinessResolutions } from '../src/om/atomic-gate.js';
import { validateGraph } from '../src/graph/validate.js';
import { gateIntegrations } from '../src/om/atomic-gate.js';
test('AT1 row 4, task 1: a work that writes the CLI without deciding the test that launches it is refused by G5 at that test; deciding it passes; the record keeps the inventory and its coverage', () => {
  const files = snapshotFiles({ commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, ['src/cli.ts', 'test/product.test.ts'], new Map([
    ['src/cli.ts', 'export const main = () => 1;\n'],
    ['test/product.test.ts', 'import test from "node:test";\nconst cli = new URL("../src/cli.js", import.meta.url);\ntest("CLI command interface persists commands", () => cli);\n']]));
  const graph = enrichedGraph(exampleGraph('p'), 'p');
  const work = graph.nodes.find(node => node.id === 'p-produce-work')!;
  work.code.push({ path: 'src/cli.ts', access: 'write', status: 'existing' });
  const refused = gateImpact(files, graph, files.snapshot);
  assert.deepEqual(refused.findings.map(item => [item.code, item.target, item.field]), [['work_impact_undecided', 'p-produce-work', 'test/product.test.ts']]);
  work.impact = [{ entry: { files: ['test/product.test.ts'] }, decision: 'keep', requirement: 'p-R1' }];
  const passed = gateImpact(files, graph, files.snapshot);
  assert.deepEqual(passed.findings, []);
  assert.deepEqual(passed.record.works.find(row => row.work === 'p-produce-work')!.coverage, [{ test: 'test/product.test.ts', by: 'file' }]);
});
test('AT1 rows 12–13 a works acceptance whose packets carry no snapshot writes a gate of the impact era with a null snapshot (M8 refuses it); a repeat writes nothing new', async t => {
  const f = await atomicFixture(t);
  const prepared = ok(prepareWorksAcceptance(f.store, f.request));
  const gate = gateWrite(prepared).value;
  assert.deepEqual([gate.contract, gate.request.snapshot, gate.impact], [ATOMIC_GATE_IMPACT_CONTRACT, null, { snapshot: null, works: [] }]);
});
test('AT1 door (№4105 п.2): an applied resolution of this snapshot turns the unknown into an edge of the inventory — the test it reaches must then be decided; the record names the resolution by its question', () => {
  const files = snapshotFiles({ commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, ['src/cli.ts', 'test/loader.test.ts'], new Map([
    ['src/cli.ts', 'export const main = () => 1;\n'],
    ['test/loader.test.ts', 'import test from "node:test";\ntest("loads", async () => { await import(process.env.M!); });\n']]));
  const graph = enrichedGraph(exampleGraph('p'), 'p');
  const work = graph.nodes.find(node => node.id === 'p-produce-work')!;
  work.code.push({ path: 'src/cli.ts', access: 'write', status: 'existing' });
  const open = gateImpact(files, graph, files.snapshot);
  const at = files.text('test/loader.test.ts')!.indexOf('import(process.env.M!)');
  assert.deepEqual(open.findings.map(item => [item.code, item.target, item.field]), [['work_impact_unresolved', 'p-produce-work', `test/loader.test.ts:2#${at}-${at + 'import(process.env.M!)'.length}`]]);
  assert.deepEqual(open.record.works.find(row => row.work === 'p-produce-work')!.unknowns[0]!.candidates, ['src/cli.ts']);
  const site = open.record.works.find(row => row.work === 'p-produce-work')!.unknowns[0]!.site;
  const resolution = { question: 'readiness:transition:q', file: 'test/loader.test.ts', line: 2, site, resolves: ['src/cli.ts'] };
  const reached = gateImpact(files, graph, files.snapshot, [resolution]);
  assert.deepEqual(reached.findings.map(item => [item.code, item.field]), [['work_impact_undecided', 'test/loader.test.ts']],
    'the unknown is gone; the test it loads is now an entry of the work to decide');
  assert.deepEqual(reached.record.resolutions, [resolution]);
  work.impact = [{ entry: { files: ['test/loader.test.ts'] }, decision: 'keep', requirement: 'p-R1' }];
  assert.deepEqual(gateImpact(files, graph, files.snapshot, [resolution]).findings, []);
  delete work.impact;
  const none = gateImpact(files, graph, files.snapshot, [{ ...resolution, resolves: [] }]);
  assert.deepEqual(none.findings, [], 'an accepted empty resolution closes the unknown and adds nothing');
});
test('AT1 policy (№4117, return №4124 P2-1): a policy is decided once per result contract at its producer — a work of the same contract refers to it, a work of another contract of the same producer does not; a provider needs its own; without it G5 refuses at the contract and producer', () => {
  const graph = enrichedGraph(exampleGraph('p'), 'p');
  for (const work of graph.nodes.filter(node => node.kind === 'work')) work.boundary = { ...work.boundary, state: 'durable', writer: 'shared-store' };
  const hash = (id: string) => hashJson((graph.contracts.find(item => item.id === id)?.schema ?? null) as Json);
  const decision = (contract: string, policy = 'appearance', producer = 'shared-store') => ({ question: { id: `readiness:policy:${policy}:${contract}`, question: 'q',
    consumer: producer, kind: 'owner-decision', blocks: true, source: { id: 'om-atomic-gate:p:g', revision: 1, hash: 'h' }, moment: 'om-pass' as const,
    readiness: { contract: 'om-readiness/v1' as const, cause: 'policy' as const, policy: policy as 'appearance', producer,
      governs: { contract, hash: hash(contract) }, works: ['p-produce-work'] } }, value: 'created on first run', decision: { id: 'd', revision: 1, hash: 'h' } });
  assert.deepEqual(gatePolicies(graph, {}).findings.map(item => [item.code, item.target, item.field]), [
    ['work_policy_open', 'p-consume-work', 'appearance:shared-store:p-contract'], ['work_policy_open', 'p-produce-work', 'appearance:shared-store:p-contract']]);
  const shared = gatePolicies(graph, { decided: [decision('p-contract')] });
  assert.deepEqual(shared.findings, [], 'both works write the same contract: one decision, referred to by both');
  assert.deepEqual(shared.rows.map(row => [row.work, row.contract.id, row.question]),
    [['p-consume-work', 'p-contract', 'readiness:policy:appearance:p-contract'], ['p-produce-work', 'p-contract', 'readiness:policy:appearance:p-contract']]);
  // The consuming work's result gets a contract of its own: the same producer's decision for the other contract closes nothing.
  graph.contracts.push({ id: 'p-result-contract', schema: { type: 'object' } });
  graph.artifacts.find(artifact => artifact.id === 'p-result')!.contract = 'p-result-contract';
  assert.deepEqual(gatePolicies(graph, { decided: [decision('p-contract')] }).findings.map(item => [item.target, item.field]),
    [['p-consume-work', 'appearance:shared-store:p-result-contract']]);
  // A changed schema of the contract is another revision of it: the earlier decision does not carry over.
  const earlier = decision('p-contract');
  graph.contracts.find(item => item.id === 'p-contract')!.schema = { type: 'object', required: ['changed'] };
  assert.ok(gatePolicies(graph, { decided: [earlier] }).findings.some(item => item.target === 'p-produce-work'));
  const work = graph.nodes.find(node => node.id === 'p-produce-work')!;
  work.boundary = { ...work.boundary, state: 'transient', provider: true, authority: 'owner' };
  assert.deepEqual(gatePolicies(graph, { decided: [decision('p-contract', 'provider', 'owner')] }).findings.map(item => [item.target, item.field]),
    [['p-consume-work', 'appearance:shared-store:p-result-contract']], 'a provider work refers to its provider policy of its own contract');
});
test('AT1 door (№4105 п.2): only a resolution asked on this very tree resolves a transition here; a resolution outside its candidates is no proof', () => {
  const cause = { contract: 'om-readiness/v1' as const, cause: 'transition' as const, snapshot: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    file: 'test/loader.test.ts', line: 2, kind: 'dynamic-import', expression: 'import(x)', site: { start: 40, end: 49, hash: 'h'.repeat(64) }, candidates: ['src/cli.ts'], works: ['w'], places: ['o'] };
  const fact = (tree: string, resolves: unknown) => ({ question: { id: `readiness:transition:${tree}`, question: 'q', consumer: 'o', kind: 'repository-fact', blocks: true,
    source: { id: 'om-atomic-gate:p:g', revision: 1, hash: 'h' }, moment: 'om-pass' as const, readiness: { ...cause, snapshot: { ...cause.snapshot, tree } } },
    value: { answer: 'a', resolves } as Json, answer: { id: 'a', revision: 1, hash: 'h' }, mc1Question: { id: 'm', revision: 1, hash: 'h' } });
  const snapshot = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  assert.deepEqual(readinessResolutions({ facts: [fact('b'.repeat(40), ['src/cli.ts']), fact('c'.repeat(40), ['src/cli.ts'])] }, snapshot),
    [{ question: `readiness:transition:${'b'.repeat(40)}`, file: 'test/loader.test.ts', line: 2, site: { start: 40, end: 49, hash: 'h'.repeat(64) }, resolves: ['src/cli.ts'] }]);
  assert.throws(() => readinessResolutions({ facts: [fact('b'.repeat(40), ['src/elsewhere.ts'])] }, snapshot),
    (error: unknown) => (error as { refusal?: { code: string } }).refusal?.code === 'atomic_gate_basis_unproven');
});
test('AT1 return №4124 P2-2: a connection from existing code is proved on the exact snapshot — its file in the tree and its symbol in the file; without a repository nothing existing is proved; a predecessor\'s connection is not the snapshot\'s', () => {
  const files = snapshotFiles({ commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, ['src/cli.ts'], new Map([['src/cli.ts', 'export function main() { return commit(); }\n']]));
  const graph = enrichedGraph(exampleGraph('p'), 'p');
  const work = graph.nodes.find(node => node.id === 'p-consume-work')!;
  const unproven = (entry: string, existing: string, from: typeof files | null = files) => {
    work.integrations = [{ entry, contract: 'p-contract', basis: { existing } }];
    return gateIntegrations(graph, from).findings.map(item => [item.code, item.target, item.field]);
  };
  assert.deepEqual(unproven('src/cli.ts#main', 'src/cli.ts'), []);
  assert.deepEqual(unproven('src/cli.ts', 'src/cli.ts'), [], 'a whole file is its own connection point');
  assert.deepEqual(unproven('src/not-here.ts#commit', 'src/not-here.ts'), [['work_integration_unproven', 'p-consume-work', 'src/not-here.ts#commit']]);
  assert.deepEqual(unproven('src/cli.ts#register', 'src/cli.ts'), [['work_integration_unproven', 'p-consume-work', 'src/cli.ts#register']], 'the symbol must occur');
  assert.deepEqual(unproven('src/cli.ts#mai', 'src/cli.ts'), [['work_integration_unproven', 'p-consume-work', 'src/cli.ts#mai']], 'a symbol, not a substring');
  assert.deepEqual(unproven('src/cli.ts#main', 'src/cli.ts', null), [['work_integration_unproven', 'p-consume-work', 'src/cli.ts#main']]);
  work.integrations = [{ entry: 'src/store.ts#commit', contract: 'p-contract', basis: { predecessor: 'p-produce-work' } }];
  assert.deepEqual(gateIntegrations(graph, files).findings, [], 'a predecessor\'s connection point is proved by the graph, not the snapshot');
});
test('AT1 return №4135 P2-1: a transient work that uses a durable contract refers to its producer\'s policy of that contract — the producer may stand outside the horizon; without the decision G5 refuses, a decision of another contract decides nothing, the producer\'s own decision is linked', () => {
  const base = exampleGraph('p'), producer = base.nodes.find(node => node.id === 'p-produce-work')!;
  producer.boundary = { ...producer.boundary, state: 'durable', writer: 'shared-store' };
  const graph = enrichedGraph(base, 'p');
  graph.contracts.push({ id: 'view-contract', schema: { type: 'string' } });
  graph.artifacts.find(artifact => artifact.id === 'p-result')!.contract = 'view-contract';
  graph.horizon = ['p-consume-work'];
  assert.deepEqual(validateGraph(graph).findings, []);
  const hash = (id: string) => hashJson((graph.contracts.find(item => item.id === id)?.schema ?? null) as Json);
  const decision = (contract: string) => ({ question: { id: `policy-${contract}`, question: 'q', consumer: 'p-produce-block', kind: 'owner-decision', blocks: true,
    source: { id: 'om-atomic-gate:p:g', revision: 1, hash: 'h' }, moment: 'om-pass' as const, readiness: { contract: 'om-readiness/v1' as const, cause: 'policy' as const,
      policy: 'appearance' as const, producer: 'shared-store', governs: { contract, hash: hash(contract) }, works: ['p-produce-work'] } },
  value: 'Explicit init; absence means recover-first', decision: { id: 'd', revision: 1, hash: 'h' } });
  assert.deepEqual(gatePolicies(graph, {}).findings.map(item => [item.code, item.target, item.field]),
    [['work_policy_open', 'p-consume-work', 'appearance:shared-store:p-contract']], 'the consumer of the durable input needs its policy');
  assert.equal(gatePolicies(graph, { decided: [decision('view-contract')] }).findings.length, 1, 'a decision of another contract decides nothing');
  const linked = gatePolicies(graph, { decided: [decision('p-contract')] });
  assert.deepEqual([linked.findings, linked.rows.map(row => [row.work, row.policy, row.producer, row.contract.id, row.question])],
    [[], [['p-consume-work', 'appearance', 'shared-store', 'p-contract', 'policy-p-contract']]], 'the producer\'s decision is referred to; the consumer creates no state');
});
test('AT1 return №4135 P2-2: a connection point is a declaration in the code of the snapshot — a comment, a string, a call or another declaration is none', () => {
  const graph = enrichedGraph(exampleGraph('p'), 'p');
  graph.nodes.find(node => node.id === 'p-produce-work')!.integrations = [{ entry: 'src/a.ts#commit', contract: 'p-contract', basis: { existing: 'src/a.ts' } }];
  const view = (text: string | null) => snapshotFiles({ commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, text === null ? [] : ['src/a.ts'],
    new Map(text === null ? [] : [['src/a.ts', text]]));
  const proved = (text: string | null) => gateIntegrations(graph, view(text)).findings.length === 0;
  for (const [label, text] of [['a function', 'export function commit() { return 1; }'], ['a const', 'export const commit = () => 1;'],
    ['an export list', 'function save() {}\nexport { save as commit };'], ['a method', 'export class Store {\n  async commit(): Promise<void> { }\n}']] as const)
    assert.ok(proved(text), label);
  for (const [label, text] of [['no file', null], ['another declaration', 'export const unrelated = 1;'], ['a comment', '// commit is not implemented\nexport const unrelated = 1;'],
    ['a string', 'export const description = "commit is not implemented";'], ['a call', 'import { commit } from "./b.js";\ncommit();'],
    ['a template', 'export const note = `commit ${1}`;']] as const)
    assert.ok(!proved(text), label);
  const masked = gateImpact(view('// commit is not implemented\nexport const unrelated = 1;'), graph, { commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
  assert.deepEqual(masked.findings.map(item => [item.code, item.field]), [['work_integration_unproven', 'src/a.ts#commit']], 'G5 refuses the mention');
});
test('AT1 return №4143: G5 proves a connection point by the parser\'s declarations — a regular expression and a call before a block prove nothing, a declaration list and a binding pattern prove it', () => {
  const graph = enrichedGraph(exampleGraph('p'), 'p'), snapshot = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  graph.nodes.find(node => node.id === 'p-produce-work')!.integrations = [{ entry: 'src/a.ts#commit', contract: 'p-contract', basis: { existing: 'src/a.ts' } }];
  const codes = (text: string) => gateImpact(snapshotFiles(snapshot, ['src/a.ts'], new Map([['src/a.ts', text]])), graph, snapshot).findings.map(item => [item.code, item.field]);
  assert.deepEqual(codes('export const pattern = /function commit/;'), [['work_integration_unproven', 'src/a.ts#commit']], 'a regular expression');
  assert.deepEqual(codes('commit()\n{ const x = 1; }'), [['work_integration_unproven', 'src/a.ts#commit']], 'a call and a separate block');
  assert.deepEqual(codes('export const other = 1, commit = () => 1;'), [], 'a declaration list');
  assert.deepEqual(codes('import { open } from "./store.js";\nexport const { commit } = open();'), [], 'a binding pattern');
});
test('AT1 return №4147: a connection point the parser proves nothing about — another language, a parse diagnostic — is an addressed unknown of the work through the readiness door, never proof and never a refusal for ever; the research fact on this tree decides it', () => {
  const graph = enrichedGraph(exampleGraph('p'), 'p'), snapshot = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const work = graph.nodes.find(node => node.id === 'p-produce-work')!;
  for (const [entry, path, text] of [['src/a.py#commit', 'src/a.py', null], ['src/a.ts#commit', 'src/a.ts', 'export function commit( {']] as const) {
    work.integrations = [{ entry, contract: 'p-contract', basis: { existing: path } }];
    const files = snapshotFiles(snapshot, [path], new Map(text === null ? [] : [[path, text]]));
    const open = gateImpact(files, graph, snapshot);
    assert.deepEqual(open.findings.map(item => [item.code, item.target, item.field]), [['work_impact_unresolved', 'p-produce-work', `${entry}:0#0-0`]], entry);
    const [unknown] = open.record.works.find(row => row.work === 'p-produce-work')!.unknowns;
    assert.deepEqual([unknown!.file, unknown!.kind, unknown!.candidates], [entry, 'declaration', [entry]]);
    const answered = (resolves: string[]) => gateImpact(files, graph, snapshot, [{ question: 'readiness:transition:q', file: entry, line: 0, site: unknown!.site, resolves }]);
    assert.deepEqual(answered([entry]).findings, [], 'the fact finds it declared');
    assert.deepEqual(answered([]).findings.map(item => [item.code, item.field]), [['work_integration_unproven', entry]], 'the fact finds no declaration');
  }
  assert.equal(gateImpact(snapshotFiles(snapshot, ['src/a.ts'], new Map([['src/a.ts', 'export function commit() {}']])), graph, snapshot).record.parser, 'typescript@6.0.3');
  assert.deepEqual(gateImpact(snapshotFiles(snapshot, ['src/a.ts'], new Map([['src/a.ts', 'export function commit() {}']])), graph, snapshot).record.boundary,
    ['computed-process-targets', 'computed-file-reads', 'future-file-consumers'], 'the boundary is saved with the record');
});
test('AT1 return №4155 п.2, №4160 п.2: G5 accepts the five declared forms; a point in a form the analysis does not read is asked through the door — never a refusal without a way out — and the fact on this tree decides it', () => {
  const graph = enrichedGraph(exampleGraph('p'), 'p'), snapshot = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  graph.nodes.find(node => node.id === 'p-produce-work')!.integrations = [{ entry: 'src/a.ts#commit', contract: 'p-contract', basis: { existing: 'src/a.ts' } }];
  const files = (text: string) => snapshotFiles(snapshot, ['src/a.ts'], new Map([['src/a.ts', text]]));
  for (const text of ['interface Writer { commit(): number; } export const service = { commit() { return 1; } } satisfies Writer;',
    'export const service = ({ commit() { return 1; } } as const);', 'export default { commit() { return 1; } };',
    'export namespace A.B { export function commit() { return 1; } }', 'export const service = { ["commit"]() { return 1; } };'])
    assert.deepEqual(gateImpact(files(text), graph, snapshot).findings, [], text);
  for (const text of ['export function make() { return { commit() { return 1; } }; }', 'export * from "./b.js";']) {
    const open = gateImpact(files(text), graph, snapshot);
    assert.deepEqual(open.findings.map(item => [item.code, item.field]), [['work_impact_unresolved', 'src/a.ts#commit:0#0-0']], text);
    const [unknown] = open.record.works.find(row => row.work === 'p-produce-work')!.unknowns;
    const answered = (resolves: string[]) => gateImpact(files(text), graph, snapshot, [{ question: 'readiness:transition:q', file: 'src/a.ts#commit', line: 0, site: unknown!.site, resolves }]);
    assert.deepEqual(answered(['src/a.ts#commit']).findings, [], `${text}: the fact proves the point`);
    assert.deepEqual(answered([]).findings.map(item => item.code), ['work_integration_unproven'], `${text}: the fact refuses it`);
  }
});


for (const stageName of ['discovery', 'concept', 'specification', 'features'] as const)
test(`SP1b G5 current context refuses a native ${stageName} head change in its publication window without partial acceptance`, async t => {
  const f = await atomicFixture(t), prepared = ok(prepareWorksAcceptance(f.store, f.request));
  assert.equal(prepared.state, 'accepted');
  assert.equal(gateWrite(prepared).value.request.taskContextContract, BASIS_TASK_CONTEXT_CONTRACT);
  const other = new Store(f.database); t.after(() => other.close());
  const stage = other.get<import('../src/pipeline/contracts.js').StageArtifact>(`stage:${f.project}:${stageName}`)!;
  new ProductEngine(other).pipeline.draft(f.project, stageName, stage.value.content, stage.revision);
  const after = heads(f.store), sent = f.sent().length;
  denied(writeGuarded(f.store, { unit: 'G5', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }), 'input_stale');
  assert.deepEqual(heads(f.store), after); assert.equal(f.store.get(prepared.record.id), null);
  assert.equal(f.store.get(gateWrite(prepared).id), null); assert.equal(f.sent().length, sent);
});

test('SP1b G5 rejects the full specification where the old preplan fits, including a cold direct entry without ProductEngine', async t => {
  const f = await atomicFixture(t), prepared = ok(prepareWorksAcceptance(f.store, f.request));
  assert.equal(prepared.state, 'accepted');
  const gate = gateWrite(prepared).value;
  const coldGate = (request: typeof f.request) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { Store } from ${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
    import { prepareWorksAcceptance } from ${JSON.stringify(new URL('../src/om/atomic-gate.js', import.meta.url).href)};
    import { readTaskSpecification } from ${JSON.stringify(new URL('../src/compiler/om-readers.js', import.meta.url).href)};
    const { database, request, input } = JSON.parse(readFileSync(0, 'utf8')), store = new Store(database);
    const emptySlot = () => assert.throws(() => readTaskSpecification(store,
      { project: request.project, input, requirements: [], nodes: [] }), { code: 'om_compiler_reader_unavailable' });
    try {
      emptySlot();
      const result = prepareWorksAcceptance(store, request);
      assert.equal(result.ok, true, JSON.stringify(result));
      const prepared = result.value, gate = prepared.writes.find(write => write.id === prepared.record.value.gate.id).value;
      assert.equal(gate.request.taskContextContract, ${JSON.stringify(BASIS_TASK_CONTEXT_CONTRACT)});
      emptySlot();
      console.log(JSON.stringify({ state: prepared.state, gate }));
    } finally { store.close(); }
  `], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    input: JSON.stringify({ database: f.database, request, input: gate.request.gaps.sources.input }) }));
  assert.deepEqual(coldGate(f.request), { state: prepared.state, gate });
  const path = join(f.root, 'sp1b-capacity.sqlite'); copyFileSync(f.database, path);
  const inspection = new Store(path); let oldSize: number, newSize: number;
  try {
    inspection.writeMany(sourceWrites(prepared), [...prepared.guards]);
    const { taskContextContract: _version, ...oldRequest } = clone(gate.request);
    oldSize = Math.max(...measuredContexts(inspection, { ...clone(gate), request: oldRequest }).map(item => item.context.chars));
    const contexts = measuredContexts(inspection, gate);
    newSize = Math.max(...contexts.map(item => item.context.chars));
    const owners = new Map<string, number>();
    for (const { context, task } of contexts) {
      const body = JSON.parse(context.text);
      assert.deepEqual(body.scope.writePaths, task.writePaths);
      for (const contract of body.selectedSpecification.contracts) owners.set(contract.value.id, (owners.get(contract.value.id) ?? 0) + 1);
    }
    assert.ok([...owners.values()].some(count => count > 1), 'A shared contract reaches each matching task without expanding writePaths');
    assert.ok(newSize > oldSize);
  } finally { inspection.close(); }
  const { projectId: _project, ...configuration } = f.environment.value;
  const limited = f.engine.environments.configure(f.project, { ...configuration, requestCapacityChars: oldSize }, f.environment.revision);
  const request = { ...f.request, environment: reference(limited) }, before = heads(f.store), sent = f.sent().length;
  const refusal = ok(prepareWorksAcceptance(f.store, request));
  assert.equal(refusal.state, 'rejected'); assert.equal(refusal.acceptance, null);
  assert.ok(gateWrite(refusal).value.result.codes.includes('work_packet_over_capacity'));
  assert.deepEqual(coldGate(request), { state: refusal.state, gate: gateWrite(refusal).value });
  assert.deepEqual(heads(f.store), before); assert.equal(f.sent().length, sent);
});
