import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { canonical, canonicalSorted, hashJson } from '../src/canonical.js';
import { checkedPlanDerivation, planDerivation, type ArtifactReceipt, type MachinePlan, type TaskInput, receiptId } from '../src/compiler/model.js';
import { resolveArtifact, resolvePlanExternalSource, resolveExternalSource } from '../src/compiler/inputs.js';
import { sourceIsCurrent, type Source } from '../src/evidence/evidence.js';
import { executionInputs } from '../src/execution/inputs.js';
import { ensureWorktree } from '../src/execution/worktree.js';
import { subjectHash } from '../src/execution/commit.js';
import { readWriter } from '../src/ownership/owners.js';
import { readWriterIndex, type WriterIndex } from '../src/ownership/writer-index.js';
import { EngineError } from '../src/errors.js';
import type { TaskRun } from '../src/execution/model.js';
import type { Graph } from '../src/graph/model.js';
import { writeFeasibility, readFeasibility, type FeasibilityRequest } from '../src/om/feasibility.js';
import { writeHandoff } from '../src/om/handoff.js';
import { checkAtomicWorks, prepareCandidateSources, writeAtomicGate } from '../src/om/atomic-gate.js';
import { resolveSnapshot } from '../src/om/impact.js';
import { inputDecisionWrite, writeAddressing, type InputDecisionProposal } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { prepareFrame, representativeId, type FrameRead, type FrameRequest } from '../src/om/frame-obligations.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import type { LayerProposal, ProposalRequest } from '../src/om/frame-proposals.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeGapLines } from '../src/om/gap-lines.js';
import { writeOmObligations } from '../src/om/obligations.js';
import { writeWorksFrame } from '../src/om/works-frame.js';
import { writeNeighbors } from '../src/om/neighbors.js';
import type { OmResult } from '../src/om/refusal.js';
import { projectGraph } from '../src/graph/project.js';
import { requireGraph } from '../src/graph/validate.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { git, Environments, type ExecutionRoot } from '../src/runtime/environment.js';
import { Store, type Revision, type Write } from '../src/storage/store.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';
import { executionFixture, refreshExecutionPlan } from './execution-fixture.js';
import { prepareNativeLayers, prepareOmFixtureStages, explicitMapping, markedWorks } from './om-fixture.js';

export type ExternalInputMode = 'inside' | 'outside' | 'mixed' | 'control';
export interface ExternalAgentCall {
  mode: string;
  subject: {
    context: { binding: { task: string }; inputs: TaskInput[] };
    inputs?: { connector: string; artifact: string; ref: Ref; kind: string; value: Source | ArtifactReceipt }[];
  };
}

// Protocol fixtures still run through actual OS processes, product checks, review and Git commits.
// The consumer implementation uses the Source delivered in its execution envelope.
const EXTERNAL_AGENT = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [journal, mode] = process.argv.slice(2), request = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(journal, JSON.stringify({mode:request.mode, subject:request.subject})+'\n');
const response = {protocol:request.protocol, requestId:request.requestId}, context = request.subject.context;
if (request.mode === 'implement') {
  const file = context.scope.code.find(item => item.access === 'write').path;
  if (file === 'produce.mjs') writeFileSync(file, 'export const produce=n=>{if(!Number.isFinite(n))throw new Error("input_missing");return n+1};\n');
  else {
    const sources = request.subject.inputs.filter(input => input.kind === 'source');
    if (sources.length !== 1) throw new Error('An exact external Source is required');
    const amount = JSON.parse(sources[0].value.content);
    if (!Number.isFinite(amount)) throw new Error('The source must supply a number');
    writeFileSync(file, mode === 'mixed'
      ? 'import {produce} from "./produce.mjs";export const consume=n=>produce(n)+'+amount+';\n'
      : 'export const consume=n=>{if(!Number.isFinite(n))throw new Error("input_missing");return n+'+amount+'};\n');
  }
  response.text = 'Implemented the numeric transformation using its actual inputs';
  response.artifacts = context.produces.map(id => ({id}));
} else response.review = {verdict:'pass', kind:'none', findings:[]};
process.stdout.write(JSON.stringify(response));
`;

export function externalInputGraph(mode: ExternalInputMode): Graph {
  const source = exampleGraph('p');
  for (const node of source.nodes) for (const ref of node.code) ref.path = ref.path.replace('.txt', '.mjs');
  const graph = enrichedGraph(source, 'p');
  graph.contracts[0]!.schema = { type: 'number' };
  const flow = graph.connectors[0]!;
  if (mode === 'control') {
    graph.artifacts.find(artifact => artifact.id === 'p-data')!.external = true;
    graph.edges!.push({ id: 'p-external-prerequisite', relation: 'requires', source: 'p-consume-work', target: 'p-produce-work',
      condition: 'Use the verified external prerequisite before consuming the input' });
    graph.edges!.push({ id: 'p-ready-to-consume', relation: 'on_success', source: 'p-produce-block', target: 'p-consume-block',
      condition: 'The verified prerequisite allows the consumer journey to continue' });
    graph.nodes.find(node => node.id === 'p-consume-work')!.ports = [];
  } else {
    graph.artifacts.push({ ...structuredClone(graph.artifacts[0]!), id: 'p-external', external: true,
      purpose: 'Supply a verified numeric amount independently of the supplier implementation' });
    graph.connectors.push({ ...structuredClone(flow), id: 'p-external-flow', artifact: 'p-external' });
    if (mode !== 'mixed') {
      graph.artifacts.find(artifact => artifact.id === 'p-data')!.terminal = true;
      graph.journeys!.push({ id: 'p-supplier-result', actor: graph.actors![0]!.id, variant: 'supplier_result', entry: 'p-produce-block',
        path: ['p-produce-block'], outcome: 'p-data', terminal: 'success' });
    }
  }
  if (mode !== 'mixed') graph.connectors = graph.connectors.filter(connector => connector !== flow);
  if (mode === 'outside' || mode === 'control') graph.horizon = ['p-consume-work'];
  for (const item of graph.tests) {
    const action = item.node.includes('produce') ? 'produce' : 'consume';
    item.covers = action === 'produce' ? graph.connectors.map(connector => connector.id) : [];
    item.command = { executable: process.execPath, args: ['check.mjs', action] };
    item.contract!.counterfactuals = item.covers.map(connector => ({ connector, mutation: 'remove', expectedFailure: 'input_missing',
      command: { executable: process.execPath, args: ['check.mjs', `${action}-mutation`, connector] } }));
  }
  return requireGraph(graph);
}

/** The external supplier stays outside B1; mixed has a separate internal producer. */
function currentExternalInputGraph(mode: ExternalInputMode): Graph {
  const graph = externalInputGraph(mode);
  if (mode === 'control') {
    for (const node of graph.nodes) if (node.id.startsWith('p-consume-')) node.ports = [];
  }
  if (mode === 'mixed') {
    for (const kind of ['block', 'operation', 'work'] as const) {
      const original = graph.nodes.find(node => node.id === `p-produce-${kind}`)!;
      graph.nodes.push({ ...structuredClone(original), id: `p-external-${kind}`,
        parent: kind === 'block' ? 'p-product' : `p-external-${kind === 'operation' ? 'block' : 'operation'}`,
        outcome: 'p-external', tests: [], code: [] });
    }
    const connector = graph.connectors.find(item => item.id === 'p-external-flow')!;
    connector.returnsTo = 'p-external-block';
    for (const binding of connector.bindings) {
      binding.producer = { node: `p-external-${(['block', 'operation', 'work'] as const)[binding.level - 1]}`, port: 'out' };
    }
    const proof = graph.tests.find(item => item.node === 'p-produce-work')!;
    proof.covers = ['p-flow'];
    proof.contract!.counterfactuals = proof.contract!.counterfactuals.filter(item => item.connector === 'p-flow');
  }
  return requireGraph(graph);
}
function externalOk<T>(result: OmResult<T>): T {
  if (!result.ok) throw new EngineError(result.refusal.code, result.refusal.message, result.refusal.at);
  return result.value;
}

/** Real N2, D1/D2/D7, C5 and G5, with exactly the Sources derived for this candidate. */
function prepareExternalWorks(engine: ProductEngine, desired: Graph, reject = false) {
  const store = engine.store, project = 'p';
  prepareNativeLayers(engine, project, desired, 'n2');
  const graph = reference(store.get('graph:p')!), layer = reference(store.get('graph-layer:p:2')!),
    upper = reference(store.get('om-frame:p:2')!), input = reference(store.get('om-input:p')!);
  const decisions: InputDecisionProposal['decision'][] = [
    { target: 'p-B1', field: 'nodes', value: ['p-produce-block', 'p-consume-block'] },
    { target: 'p-B1', field: 'state', value: { writer: 'p-produce-block', authority: 'p-consume-block', rollback: 'p-consume-block' } },
    { target: 'p-R1#1', field: 'checkKind', value: 'test' },
  ];
  const addressed = externalOk(writeAddressing(store, { project, input, graph,
    decisions: decisions.map(decision => ({ pending: inputDecisionWrite({ project, input, graph, layers: [],
      decision: structuredClone(decision) }) as Write })) }));
  const horizon = externalOk(writeHorizon(store, { project, input: reference(addressed), graph, refinement: layer,
    available: {}, choice: { choiceVersion: 'external-input-works', features: [{ outcome: 'p-result' }], excluded: [] } }));
  const frame: FrameRequest = { project, level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
    upper: { horizon: reference(horizon.gate), frame: upper } };
  const basis = structuredClone(externalOk(prepareFrame(store, frame))) as unknown as FrameRead;
  const proposed = structuredClone(desired);
  for (const field of ['nodes', 'artifacts', 'contracts', 'anchors', 'joins', 'tests', 'edges', 'journeys', 'packets', 'transfers'] as const) {
    const inherited = basis.upper[field] ?? [], ids = new Set(inherited.map(item => item.id));
    Object.assign(proposed, { [field]: [...structuredClone(inherited), ...(proposed[field] ?? []).filter(item => !ids.has(item.id))] });
  }
  proposed.connectors = basis.upper.connectors.map(connector => ({ ...structuredClone(connector),
    bindings: [...structuredClone(connector.bindings), ...(desired.connectors.find(item => item.id === connector.id)?.bindings ?? [])
      .filter(binding => binding.level === 3)] }));
  const prerequisite = proposed.edges?.find(edge => edge.id === 'p-external-prerequisite');
  if (prerequisite) prerequisite.target = representativeId('p-produce-operation', 3);
  const projected = projectGraph(proposed, 3), nodes = projected.nodes.filter(node => node.kind === 'work' && basis.scope.nodes.includes(node.parent!)),
    selected = new Set(nodes.map(node => node.id));
  markedWorks(proposed);
  const fills = explicitMapping(proposed, basis.upper, basis.scope, 3);
  const proposal: LayerProposal = { base: { graph, frame: null }, level: 3, worksContract: 'works-frame/v1', source: 'decision', status: 'proposed', nodes,
    fills: fills.fills.filter(fill => selected.has(fill.node)).map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port, codeRef: structuredClone(nodes.find(node => node.id === fill.node)!.code[0]!) }) })),
    localConnectors: [], artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
    tests: projected.tests.filter(proof => selected.has(proof.node)), edges: proposed.edges ?? [], journeys: projected.journeys ?? [],
    packets: projected.packets ?? [], transfers: projected.transfers ?? [], anchors: [], removes: [], replaces: [], redefines: [] };
  const record = store.write({ id: 'om-proposal:p:external-works', kind: 'layer-proposal', expected: 0, value: proposal });
  const works: ProposalRequest = { frame, proposals: [reference(record)] };
  const gaps = externalOk(writeGaps(store, { project, input: reference(addressed), graph, horizon: reference(horizon.gate),
    operations: { frame: { project, level: 2, graph, layer, frame: upper, horizon: reference(horizon.gate), upper: null }, proposals: [] }, works }));
  const gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: canonicalSorted(gaps.records.map(reference)) };
  const lines = externalOk(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const obligations = externalOk(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [] }));
  assert.deepEqual(obligations.handoff.obligations, []);
  const candidate = externalOk(writeWorksFrame(store, { ...works, works: { contract: 'works-frame/v1',
    producer: reference(obligations.producer), ledger: reference(obligations.record), bindings: [] } }));
  assert.equal(candidate.state, 'candidate');
  if (candidate.state !== 'candidate') throw new Error('Expected an external-input works candidate');
  const candidateRef = reference(candidate.record), neighbors = externalOk(writeNeighbors(store, { project, candidate: candidateRef }));
  const sources = externalOk(prepareCandidateSources(store, { project, candidate: candidateRef, neighbors: reference(neighbors) }));
  const gate = externalOk(writeAtomicGate(store, { project, candidate: candidateRef, neighbors: reference(neighbors),
    environment: reference(engine.environments.get(project)), gaps: gapRead, results: [], sources: [...sources.sources],
    snapshot: resolveSnapshot(engine.environments.get(project).value.workspace) }));
  assert.equal(gate.value.result.passed, !reject, canonical(gate.value.result.findings));
  const accepted = externalOk(settleCandidate(store, { project, level: 3, candidate: candidateRef,
    outcome: { ...gate.value.result, codes: [...gate.value.result.codes], basis: reference(gate) } }));
  if (reject) { assert.equal(accepted.state, 'rejected'); return { gate, accepted }; }
  assert.equal(accepted.state, 'accepted'); assert.ok(accepted.graph && accepted.layer && accepted.frame);
  const feasibility = externalOk(writeFeasibility(store, { project, graph: reference(accepted.graph), layer: reference(accepted.layer),
    frame: reference(accepted.frame), environment: reference(engine.environments.get(project)), expected: 0 }));
  assert.equal(feasibility.value.ready, true);
  externalOk(writeHandoff(store, { project, feasibility: reference(feasibility), expected: 0 }));
  return { gate, accepted };
}

export function externalInputFixture(t: TestContext, mode: ExternalInputMode = 'inside', configure?:
  (engine: ProductEngine, graph: Graph, workspace: string) => void, prepareGraph?: (graph: Graph) => void,
  current: boolean | 'reject-mixed' | 'missing-source' | 'wrong-source' = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'omg-external-input-'))), workspace = join(directory, 'repo');
  mkdirSync(workspace);
  const journal = join(directory, 'calls.jsonl'), agent = join(directory, 'agent.mjs');
  writeFileSync(agent, EXTERNAL_AGENT);
  writeFileSync(join(workspace, 'README.md'), 'A numeric transformation with exact external evidence\n');
  writeFileSync(join(workspace, 'check.mjs'), `
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
const mode=process.argv[2];
if(mode==='produce'||mode==='all'&&existsSync('produce.mjs')) { const {produce}=await import('./produce.mjs'); assert.equal(produce(1),2); }
if(mode==='consume'||mode==='all'&&existsSync('consume.mjs')) { const {consume}=await import('./consume.mjs'); assert.equal(consume(1),${mode === 'mixed' ? 4 : 3}); }
if(mode==='produce-mutation') { const {produce}=await import('./produce.mjs'); assert.throws(()=>produce(undefined),/input_missing/); }
if(mode==='consume-mutation') { const {consume}=await import('./consume.mjs'); assert.throws(()=>consume(undefined),/input_missing/); }
`);
  git(workspace, ['init', '-b', 'main']); git(workspace, ['add', 'README.md', 'check.mjs']);
  git(workspace, ['-c', 'user.name=OMG Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'external input fixture']);
  const initial = git(workspace, ['rev-parse', 'HEAD']);
  let store = new Store(join(directory, 'state.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const graph = current !== 'reject-mixed' ? currentExternalInputGraph(mode) : externalInputGraph(mode), artifact = mode === 'control' ? 'p-data' : 'p-external';
  prepareGraph?.(graph);
  prepareOmFixtureStages(engine, 'p', graph);
  const source = engine.discovery.evidence.document('p', current === 'missing-source' ? 'unrelated' : artifact,
    current === 'wrong-source' ? JSON.stringify('not a number') : '2', 'application/json', 0);
  const command = { executable: process.execPath, args: [agent, journal, mode] };
  engine.environments.configure('p', { workspace, implementer: { actor: 'worker', model: 'protocol-fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'protocol-fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['check.mjs', 'all'] }, timeoutMs: 10_000,
    requestCapacityChars: 100_000 }, 0);
  configure?.(engine, graph, workspace);
  try {
    const result = prepareExternalWorks(engine, graph, current === 'reject-mixed');
    // G5 derives the rejected in-horizon supplier as internal; its collector lawfully asks for no Source.
    assert.deepEqual(result.gate.value.request.sources, current === 'reject-mixed' ? [] : [reference(source)]);
    if (current === 'reject-mixed') throw new EngineError('external_fixture_rejected', 'G5 rejected the original two-artifact work',
      { findings: result.gate.value.result.findings, state: result.accepted.state });
  }
  catch (error) {
    if (error instanceof EngineError) t.diagnostic(JSON.stringify({ code: error.code, message: error.message, at: error.details }));
    throw error;
  }
  const plan = engine.compiler.compile('p');
  const compilation = engine.compiler.publish('p', reference(plan), 0); engine.pipeline.accept('p', 'compilation', compilation.revision);
  return { get store() { return store; }, get engine() { return engine; }, directory, workspace, initial, graph, artifact, source, plan,
    calls: (): ExternalAgentCall[] => { try { return readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    reopen: () => { store.close(); store = new Store(join(directory, 'state.sqlite')); engine = new ProductEngine(store); return engine; },
    options: { retry: false, maxContextChars: 100_000, maxCorrections: 0 } };
}

/** Current consumers use M8; every call names its exact current variant. */
function currentExternalInputFixture(t: TestContext, mode: ExternalInputMode = 'inside',
  configure?: (engine: ProductEngine, graph: Graph, workspace: string) => void, prepareGraph?: (graph: Graph) => void) {
  return externalInputFixture(t, mode, configure, prepareGraph, true);
}

/** A deliberately resealed body lets negative tests reach the semantic reader rather than fail its checksum first. */
export function externalPlanVariant(store: Store, original: Revision<MachinePlan>, mutate: (plan: MachinePlan) => void): Revision<MachinePlan> {
  const value = structuredClone(original.value); mutate(value);
  const { hash: _hash, ...body } = value; value.hash = hashJson(body);
  const id = `plan:${value.projectId}:external-inputs-v1:${value.hash}`;
  return store.write<MachinePlan>({ id, kind: 'plan', expected: store.get(id)?.revision ?? 0, value });
}

for (const mode of ['inside', 'outside'] as const) test(`an external supplier ${mode} the plan reaches committed with its exact Source`, async t => {
  const f = currentExternalInputFixture(t, mode), sourceRef = reference(f.source);
  const consumer = f.plan.value.tasks.find(task => task.node === 'p-consume-work')!;
  assert.equal(f.plan.value.derivation, 'external-inputs/v1');
  assert.match(f.plan.id, /^plan:p:external-inputs-v1:/);
  assert.deepEqual(consumer.inputs, [{ connector: 'p-external-flow', artifact: f.artifact, producerTask: null, receipt: null, source: sourceRef }]);
  assert.deepEqual(f.plan.value.guards.filter(ref => ref.id === f.source.id), [sourceRef]);
  assert.deepEqual(consumer.dependencies, []);
  assert.equal(f.plan.value.tasks.some(task => task.node === 'p-produce-work'), false, 'B1 selects the consumer; an external flow does not add its supplier');
  assert.equal(f.plan.value.tasks.length, 1);
  assert.deepEqual(f.engine.compiler.compile('p'), f.plan);
  assert.deepEqual(f.engine.compiler.read(f.plan.id), f.plan);
  const runs = await f.engine.executor.run('p', reference(f.plan), f.options);
  assert.deepEqual(runs.map(run => run.value.state), ['committed'], JSON.stringify(runs.map(run => run.value.error)));
  const run = runs.find(run => run.value.taskId === consumer.id)!;
  assert.deepEqual(run.value.inputs, [sourceRef]);
  const envelope = f.calls().find(call => call.mode === 'implement' && call.subject.context.binding.task === consumer.id)!.subject;
  assert.deepEqual(envelope.context.inputs, consumer.inputs);
  assert.deepEqual(envelope.inputs, [{ connector: 'p-external-flow', artifact: f.artifact, ref: sourceRef, kind: 'source', value: f.source.value }]);
  assert.deepEqual(f.engine.compiler.read(f.plan.id), f.plan, 'The supplier receipt cannot replace the consumer Source during historical reading');
  assert.equal(f.calls().filter(call => call.mode === 'implement').length, 1);
  assert.ok(f.calls().every(call => call.subject.context.binding.task === consumer.id));
  f.reopen();
  const durable = () => f.store.list().filter(row => ['plan', 'task-run', 'artifact', 'writer-index', 'execution-root'].includes(row.kind)).flatMap(row => f.store.history(row.id));
  const before = canonical(durable()), calls = f.calls();
  assert.deepEqual(await f.engine.executor.run('p', reference(f.plan), f.options), runs);
  assert.equal(canonical(durable()), before);
  assert.deepEqual(f.calls(), calls);
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), f.initial);
});

test('separate external supplier and internal producer preserve both exact consumer inputs', async t => {
  const f = currentExternalInputFixture(t, 'mixed');
  assert.equal(f.plan.value.tasks.length, 2);
  assert.equal(f.plan.value.tasks.some(task => task.node === 'p-external-work'), false);
  const producer = f.plan.value.tasks.find(task => task.node === 'p-produce-work')!;
  const consumer = f.plan.value.tasks.find(task => task.node === 'p-consume-work')!;
  assert.deepEqual(consumer.dependencies, [producer.id]);
  assert.deepEqual(consumer.inputs.find(input => input.artifact === 'p-data'),
    { connector: 'p-flow', artifact: 'p-data', producerTask: producer.id, receipt: null, source: null });
  assert.deepEqual(consumer.inputs.find(input => input.artifact === f.artifact),
    { connector: 'p-external-flow', artifact: f.artifact, producerTask: null, receipt: null, source: reference(f.source) });
  const runs = await f.engine.executor.run('p', reference(f.plan), f.options);
  assert.deepEqual(runs.map(run => run.value.state), ['committed', 'committed'], JSON.stringify(runs.map(run => run.value.error)));
  assert.equal(f.calls().filter(call => call.mode === 'implement').length, 2);
  f.reopen();
  assert.deepEqual(f.engine.compiler.read(f.plan.id), f.plan);
  const calls = f.calls();
  assert.deepEqual(await f.engine.executor.run('p', reference(f.plan), f.options), runs);
  assert.deepEqual(f.calls(), calls);
  const receipt = f.store.get<ArtifactReceipt>(receiptId('p', 'p-data'))!;
  const consumerRun = runs.find(run => run.value.taskId === consumer.id)!;
  assert.deepEqual(new Set(consumerRun.value.inputs.map(canonical)), new Set([reference(f.source), reference(receipt)].map(canonical)));
  const root = f.store.get<ExecutionRoot>('execution-root:p')!.value;
  const originalRun = runs.find(run => run.value.taskId === producer.id)!;
  const foreignPlan = externalPlanVariant(f.store, f.plan, plan => { plan.base.tree = 'f'.repeat(40); });
  const foreignRun = f.store.write<TaskRun>({ id: 'task-run:foreign-plan', kind: 'task-run', expected: 0,
    value: { ...originalRun.value, plan: reference(foreignPlan) } });
  const replaced = f.store.write<ArtifactReceipt>({ id: receipt.id, kind: receipt.kind, expected: receipt.revision,
    value: { ...receipt.value, plan: reference(foreignPlan), run: reference(foreignRun) } });
  assert.throws(() => executionInputs(f.store, f.plan, consumer, root), { code: 'execution_input_foreign' });
  const wrongTask = f.store.write<TaskRun>({ id: 'task-run:foreign-task', kind: 'task-run', expected: 0,
    value: { ...originalRun.value, taskId: consumer.id } });
  f.store.write({ id: receipt.id, kind: receipt.kind, expected: replaced.revision, value: { ...receipt.value, run: reference(wrongTask) } });
  assert.throws(() => executionInputs(f.store, f.plan, consumer, root), { code: 'implementation_proof_foreign' });
});

test('an external control predecessor outside the plan resolves without an L3 connector', async t => {
  const f = currentExternalInputFixture(t, 'control'), consumer = f.plan.value.tasks[0]!;
  assert.deepEqual(consumer.inputs, [{ connector: 'p-external-prerequisite', artifact: 'p-data', producerTask: null, receipt: null, source: reference(f.source) }]);
  assert.equal(f.plan.value.graphSnapshot.connectors.some(connector => connector.id === 'p-external-prerequisite'), false);
  assert.equal(f.plan.value.tasks.length, 1);
  const representative = representativeId('p-produce-operation', 3);
  assert.ok(f.plan.value.graphSnapshot.nodes.some(node => node.id === representative && !f.plan.value.graphSnapshot.horizon.includes(node.id)));
  assert.ok(f.plan.value.graphSnapshot.edges!.some(edge => edge.id === 'p-external-prerequisite'
    && edge.relation === 'requires' && edge.source === consumer.node && edge.target === representative));
  const runs = await f.engine.executor.run('p', reference(f.plan), f.options);
  assert.deepEqual(runs.map(run => run.value.state), ['committed'], JSON.stringify(runs.map(run => run.value.error)));
  assert.deepEqual(runs[0]!.value.inputs, [reference(f.source)]);
  assert.equal(f.calls().filter(call => call.mode === 'implement').length, 1);
  assert.ok(f.calls().every(call => call.subject.context.binding.task === consumer.id));
  f.reopen();
  assert.deepEqual(f.engine.compiler.read(f.plan.id), f.plan);
  const calls = f.calls();
  assert.deepEqual(await f.engine.executor.run('p', reference(f.plan), f.options), runs);
  assert.deepEqual(f.calls(), calls);
});

test('G5 rejects the original one-supplier mixed candidate with exact Sources and no accepted L3', t => {
  let engine!: ProductEngine, before!: unknown;
  assert.throws(() => externalInputFixture(t, 'mixed', value => { engine = value; before = engine.store.get('graph-layer:p:3'); }, undefined, 'reject-mixed'), error => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, 'external_fixture_rejected');
    const details = error.details as { findings: { code: string; target: string }[]; state: string };
    assert.equal(details.state, 'rejected');
    assert.ok(details.findings.some(finding => finding.code === 'work_artifact_not_single' && finding.target === 'p-produce-work'));
    return true;
  });
  assert.deepEqual(engine.store.get('graph-layer:p:3'), before);
  assert.equal(engine.store.get('om-frame:p:3'), null);
  assert.deepEqual(engine.store.list('plan'), []); assert.deepEqual(engine.store.list('task-run'), []);
  assert.equal(engine.store.get('execution-root:p'), null);
  const source = engine.store.get<Source>('source:p:p-external')!;
  assert.deepEqual(resolveExternalSource(engine.store, 'p', externalInputGraph('mixed'), 'p-external', reference(source), true),
    { source: reference(source), receipt: null }, 'The Source is valid; the refusal concerns the two-artifact work');
});
for (const variant of ['missing-source', 'wrong-source'] as const)
  test(`G5 addresses a genuinely ${variant} before accepting external works`, t => {
    let engine!: ProductEngine, before!: unknown;
    assert.throws(() => externalInputFixture(t, 'outside', value => { engine = value; before = engine.store.get('graph-layer:p:3'); }, undefined, variant), error => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.code, variant === 'missing-source' ? 'atomic_gate_basis_unproven' : 'artifact_contract_mismatch');
      assert.deepEqual(error.details, { unit: 'G5', target: 'p-external', field: 'sources' }); return true;
    });
    assert.deepEqual(engine.store.get('graph-layer:p:3'), before);
    assert.deepEqual(engine.store.list('plan'), []); assert.deepEqual(engine.store.list('task-run'), []);
  });

test('historical Source selection refuses two different exact revisions instead of selecting the first', t => {
  const f = currentExternalInputFixture(t), original = reference(f.source);
  const next = f.engine.discovery.evidence.document('p', f.artifact, '3', 'application/json', f.source.revision);
  assert.deepEqual(f.engine.compiler.read(f.plan.id), f.plan, 'A historical read still resolves the source actually sealed by the plan');
  const conflicted = externalPlanVariant(f.store, f.plan, plan => {
    const consumer = plan.tasks.find(task => task.node === 'p-consume-work')!;
    consumer.inputs.push({ ...consumer.inputs[0]!, source: reference(next) });
    plan.guards.push(reference(next));
  });
  assert.throws(() => resolvePlanExternalSource(f.store, conflicted, f.artifact), { code: 'plan_input_invalid' });
  assert.throws(() => f.engine.compiler.read(conflicted.id), { code: 'plan_input_invalid' });
  const guardConflict = externalPlanVariant(f.store, f.plan, plan => { plan.guards.push(reference(next)); });
  assert.throws(() => f.engine.compiler.read(guardConflict.id), { code: 'plan_input_invalid' });
  const sameGuard = externalPlanVariant(f.store, f.plan, plan => { plan.guards.push(original); });
  assert.deepEqual(resolvePlanExternalSource(f.store, sameGuard, f.artifact), { receipt: null, source: original });
});


function replaceSaved<T>(store: Store, record: Revision<T>): void {
  const db = new DatabaseSync(store.path);
  try {
    // Corruption regression on this disposable database; production immutability remains enabled afterwards.
    db.exec('BEGIN IMMEDIATE');
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='revisions_no_update'").get()!['sql'];
    db.exec('DROP TRIGGER revisions_no_update');
    const changed = db.prepare('UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?')
      .run(canonical(record.value), hashJson(record.value), record.id, record.revision);
    assert.equal(changed.changes, 1);
    db.exec(String(trigger)); db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}
const addressedPlan = (code: string, id: string) => (error: unknown) => {
  assert.ok(error instanceof EngineError); assert.equal(error.code, code);
  assert.equal((error.details as { target: string }).target, id); return true;
};

test('plan derivation uses the namespace position, including a legacy project named external-inputs-v1', t => {
  const f = currentExternalInputFixture(t);
  const legacy = { ...f.plan, id: `plan:external-inputs-v1:${f.plan.value.hash}` };
  assert.equal(planDerivation(legacy.id), 'legacy');
  assert.equal(checkedPlanDerivation(legacy), 'legacy', 'Extra marker content cannot change the old namespace');
  assert.equal(planDerivation('plan:p:external-inputs-v1:broken'), 'external-inputs/v1');
  assert.throws(() => checkedPlanDerivation({ ...f.plan, id: 'plan:p:external-inputs-v1:broken' }),
    addressedPlan('plan_derivation_invalid', 'plan:p:external-inputs-v1:broken'));
  for (const field of ['derivation', 'version', 'projectId', 'hash'] as const) {
    const value = structuredClone(f.plan.value) as unknown as Record<string, unknown>;
    delete value[field];
    const missing = { ...f.plan, value, hash: hashJson(value) } as unknown as Revision<MachinePlan>;
    assert.throws(() => checkedPlanDerivation(missing), addressedPlan('plan_derivation_invalid', missing.id));
  }
});

test('new marker is mandatory for historical read and a no-write compile result after reopening', t => {
  const f = currentExternalInputFixture(t);
  const snapshot = () => canonical(f.store.list().flatMap(row => f.store.history(row.id)));
  for (const marker of [undefined, null, 'external-inputs/unknown']) {
    const variant = externalPlanVariant(f.store, f.plan, value => {
      if (marker === undefined) delete value.derivation;
      else Object.assign(value, { derivation: marker });
    });
    f.reopen();
    const beforeRead = snapshot();
    assert.throws(() => f.engine.compiler.read(variant.id), addressedPlan('plan_derivation_invalid', variant.id));
    assert.equal(snapshot(), beforeRead, 'the refused read writes nothing');
    const altered = { ...variant, id: f.plan.id, revision: f.plan.revision };
    replaceSaved(f.store, altered); f.reopen();
    const beforeCompile = snapshot();
    assert.throws(() => f.engine.compiler.compile('p'), addressedPlan('plan_derivation_invalid', f.plan.id));
    assert.equal(snapshot(), beforeCompile, 'the refused compile writes nothing');
    replaceSaved(f.store, f.plan);
  }
});

test('each external input requires its exact triple and Source guard after reopening', t => {
  const f = currentExternalInputFixture(t);
  const changes: [string, (plan: MachinePlan) => void][] = [
    ['source absent', plan => { delete (plan.tasks.find(task => task.node === 'p-consume-work')!.inputs[0] as unknown as Record<string, unknown>)['source']; }],
    ['source null', plan => { plan.tasks.find(task => task.node === 'p-consume-work')!.inputs[0]!.source = null; }],
    ['producer task', plan => { plan.tasks.find(task => task.node === 'p-consume-work')!.inputs[0]!.producerTask = plan.tasks[0]!.id; }],
    ['receipt', plan => { plan.tasks.find(task => task.node === 'p-consume-work')!.inputs[0]!.receipt = reference(f.source); }],
    ['foreign source', plan => { plan.tasks.find(task => task.node === 'p-consume-work')!.inputs[0]!.source = { ...reference(f.source), id: 'source:foreign:p-external' }; }],
    ['guard absent', plan => { plan.guards = plan.guards.filter(ref => ref.id !== f.source.id); }],
    ['guard wrong hash', plan => { plan.guards = plan.guards.map(ref => ref.id === f.source.id ? { ...ref, hash: hashJson('wrong') } : ref); }],
  ];
  for (const [name, change] of changes) {
    const variant = externalPlanVariant(f.store, f.plan, change); f.reopen();
    assert.throws(() => resolvePlanExternalSource(f.store, variant, f.artifact), addressedPlan('plan_input_invalid', variant.id), name);
    assert.throws(() => f.engine.compiler.read(variant.id), name.startsWith('guard ')
      ? { code: 'plan_basis_incomplete' } : addressedPlan('plan_input_invalid', variant.id), name);
  }
  for (const source of [{ ...reference(f.source), revision: 100 }, { ...reference(f.source), hash: hashJson('wrong source') }]) {
    const variant = externalPlanVariant(f.store, f.plan, plan => {
      plan.tasks.find(task => task.node === 'p-consume-work')!.inputs[0]!.source = source;
      plan.guards = plan.guards.map(ref => ref.id === f.source.id ? source : ref);
    });
    f.reopen();
    assert.throws(() => resolvePlanExternalSource(f.store, variant, f.artifact), { code: 'external_input_missing' });
    assert.throws(() => f.engine.compiler.read(variant.id), { code: 'plan_basis_incomplete' });
  }
});

test('an owned Source file changed by the first task remains the sealed input of the next task', async t => {
  const f = currentExternalInputFixture(t, 'mixed', (_engine, _graph, workspace) => {
    writeFileSync(join(workspace, 'produce.mjs'), '2');
    git(workspace, ['add', 'produce.mjs']);
    git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial numeric source']);
  });
  const root = ensureWorktree(f.store, f.engine.environments, f.plan.value);
  const source = f.engine.discovery.evidence.file('p', f.artifact, root.value.path, 'produce.mjs', 'application/json', f.source.revision);
  const plan = refreshExecutionPlan(f.engine);
  const compilation = f.engine.compiler.publish('p', reference(plan), f.store.get('stage:p:compilation')!.revision);
  f.engine.pipeline.accept('p', 'compilation', compilation.revision);
  assert.ok(sourceIsCurrent(source.value));
  const runs = await f.engine.executor.run('p', reference(plan), f.options);
  assert.deepEqual(runs.map(run => run.value.state), ['committed', 'committed'], canonical(runs.map(run => run.value.error)));
  assert.equal(sourceIsCurrent(source.value), false, 'The first accepted task really changed the source file');
  const consumer = plan.value.tasks.find(task => task.node === 'p-consume-work')!;
  assert.ok(runs.find(run => run.value.taskId === consumer.id)!.value.inputs.some(ref => canonical(ref) === canonical(reference(source))));
  f.reopen();
  assert.deepEqual(f.engine.compiler.read(plan.id), plan);
  const before = canonical(f.store.list().flatMap(row => f.store.history(row.id)));
  const repeat = await f.engine.executor.run('p', reference(plan), f.options);
  assert.deepEqual(repeat, runs);
  assert.equal(canonical(f.store.list().filter(row => row.kind === 'task-run').flatMap(row => f.store.history(row.id))),
    canonical((JSON.parse(before) as Revision[]).filter(row => row.kind === 'task-run')));
});

for (const point of ['compile', 'compile-repeat', 'implementing', 'commit_pending'] as const)
  test(`a second Store changes Source at ${point} without accepting a stale result`, async t => {
    const f = currentExternalInputFixture(t, 'outside');
    const second = new Store(f.store.path); t.after(() => second.close());
    if (point === 'compile') {
      f.engine.discovery.evidence.document('p', f.artifact, '2', 'application/json', f.source.revision);
      const feasibility = externalOk(writeFeasibility(f.store, { project: 'p', graph: reference(f.store.get('graph:p')!),
        layer: reference(f.store.get('graph-layer:p:3')!), frame: reference(f.store.get('om-frame:p:3')!),
        environment: reference(f.engine.environments.get('p')), expected: f.store.get('om-feasibility:p')!.revision }));
      assert.equal(feasibility.value.ready, true);
      externalOk(writeHandoff(f.store, { project: 'p', feasibility: reference(feasibility), expected: f.store.get('stage:p:om-g2')!.revision }));
    }
    const source = f.store.get<Source>(f.source.id)!, plans = f.store.list('plan'), pointer = f.store.get('current-plan:p');
    const write = f.store.writeMany.bind(f.store), get = f.store.get.bind(f.store);
    let raced = false;
    const change = () => {
      raced = true;
      new ProductEngine(second).discovery.evidence.document('p', f.artifact, '3', 'application/json', source.revision);
    };
    if (point === 'compile-repeat') {
      f.store.get = ((id: string, revision?: number) => {
        const value = get(id, revision);
        if (!raced && id === f.plan.id && revision === undefined) change();
        return value;
      }) as typeof f.store.get;
    } else f.store.writeMany = ((writes, guards) => {
      if (!raced && writes.some(item => point === 'compile' ? item.kind === 'plan'
        : item.kind === 'task-run' && (item.value as TaskRun).state === point)) {
        assert.ok(guards?.some(ref => canonical(ref) === canonical(reference(source))), 'The initial Source reaches the transaction');
        change();
      }
      return write(writes, guards);
    }) as typeof f.store.writeMany;
    try {
      if (point === 'compile' || point === 'compile-repeat') assert.throws(() => f.engine.compiler.compile('p'),
        { code: point === 'compile-repeat' ? 'plan_stale' : 'input_stale' });
      else if (point === 'implementing') await assert.rejects(f.engine.executor.run('p', reference(f.plan), f.options), { code: 'input_stale' });
      else {
        const runs = await f.engine.executor.run('p', reference(f.plan), f.options);
        assert.equal(runs.length, 1); assert.notEqual(runs[0]!.value.state, 'committed');
        assert.ok(runs[0]!.value.error);
      }
    } finally { f.store.writeMany = write; f.store.get = get; }
    assert.ok(raced); assert.deepEqual(f.store.list('plan'), plans); assert.deepEqual(f.store.get('current-plan:p'), pointer);
    assert.equal(f.store.list<TaskRun>('task-run').some(run => f.store.history<TaskRun>(run.id)
      .some(row => row.value.state === 'commit_pending' || row.value.state === 'committed')), false);
    assert.equal(f.calls().filter(call => call.mode === 'implement').length, point === 'commit_pending' ? 1 : 0);
    assert.equal(f.store.get<Source>(source.id)!.value.content, '3');
  });

test('committed M8 writers and internal receipts reject a lost new-era marker without carried obligations', async t => {
  const f = currentExternalInputFixture(t, 'mixed');
  const runs = await f.engine.executor.run('p', reference(f.plan), f.options);
  const task = f.plan.value.tasks.find(task => task.node === 'p-produce-work')!;
  assert.deepEqual(task.researchObligations, []);
  const run = runs.find(run => run.value.taskId === task.id)!;
  assert.equal(run.value.state, 'committed');
  const root = f.store.get<ExecutionRoot>('execution-root:p')!.value;
  const receipt = f.store.get<ArtifactReceipt>(receiptId('p', 'p-data'))!;
  assert.ok(readWriter(f.store, 'p', { root: root.path, head: run.value.commit! }, reference(run), task.writePaths[0]!));
  for (const marker of [undefined, 'external-inputs/unknown']) {
    const plan = externalPlanVariant(f.store, f.plan, value => {
      if (marker === undefined) delete value.derivation; else Object.assign(value, { derivation: marker });
    });
    const value = { ...run.value, plan: reference(plan), reviewSubject: subjectHash(reference(plan), task.id, run.value.parent, run.value.tree!) };
    const damaged = { ...run, value, hash: hashJson(value) }; replaceSaved(f.store, damaged);
    const receiptValue = { ...receipt.value, plan: reference(plan), run: reference(damaged) };
    replaceSaved(f.store, { ...receipt, value: receiptValue, hash: hashJson(receiptValue) }); f.reopen();
    assert.throws(() => readWriter(f.store, 'p', { root: root.path, head: run.value.commit! }, reference(damaged), task.writePaths[0]!),
      addressedPlan('plan_derivation_invalid', plan.id));
    assert.throws(() => resolveArtifact(f.store, 'p', f.plan.value.graphSnapshot, { ...f.plan.value.base, root: root.path, head: run.value.commit! },
      task.node, 'p-data'), addressedPlan('plan_derivation_invalid', plan.id));
  }
});


interface ExternalM8Fixture {
  readonly store: Store; project: string; feasibility: FeasibilityRequest; restart(): void;
}
async function externalM8Fixture(t: TestContext): Promise<ExternalM8Fixture> {
  // G5 permits only one output artifact per work and forbids external work outcomes in its horizon.
  // Its lawful external input therefore has its supplier outside the selected work horizon.
  const url = new URL('./om-feasibility.test.js', import.meta.url), source = readFileSync(url, 'utf8');
  const boundary = source.indexOf('const heads ='); assert.ok(boundary > 0);
  let prefix = source.slice(0, boundary);
  prefix = prefix.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
    (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`);
  assert.ok(!/\btest\(/.test(prefix));
  const module = await import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport { acceptedWorksFixture };`).toString('base64')}`) as {
    acceptedWorksFixture(t: TestContext): ExternalM8Fixture };
  const configure = Environments.prototype.configure;
  const script = `import{readFileSync,writeFileSync}from'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),response={protocol:request.protocol,requestId:request.requestId};
if(request.mode==='implement') {
 for(const code of request.subject.context.scope.code.filter(item=>item.access==='write'))writeFileSync(code.path,'Accepted native M8 implementation\\n');
 response.text='Implemented the exact scope';response.artifacts=request.subject.context.produces.map(id=>({id}));
}else response.review={verdict:'pass',kind:'none',findings:[]};process.stdout.write(JSON.stringify(response));`;
  const command = { executable: process.execPath, args: ['--input-type=module', '-e', script] };
  Environments.prototype.configure = function(project, value, expected) {
    return configure.call(this, project, { ...value,
      implementer: { ...value.implementer, command }, reviewer: { ...value.reviewer, command } }, expected);
  };
  try { return module.acceptedWorksFixture(t); } finally { Environments.prototype.configure = configure; }
}

test('M8 external Source stays exact through compilation and the independent writer boundary', async t => {
  const f = await externalM8Fixture(t), saved = writeFeasibility(f.store, f.feasibility);
  assert.ok(saved.ok, canonical(saved)); if (!saved.ok) return;
  const m8 = saved.value, before = canonical(m8), deliveryBefore = canonical(m8.value.producer.deliveries);
  const source = f.store.get<Source>('source:garden:garden-data')!;
  assert.deepEqual(m8.value.producer.deliveries.resolved.find(item => item.artifact === 'garden-data')!.source, reference(source));
  const handoff = writeHandoff(f.store, { project: f.project, feasibility: reference(m8), expected: 0 });
  assert.ok(handoff.ok, canonical(handoff));
  let engine = new ProductEngine(f.store);
  const plan = engine.compiler.compile(f.project), task = plan.value.tasks[0]!;
  assert.equal(plan.value.tasks.length, 1);
  assert.equal(task.node, 'garden-consume-work');
  assert.ok(plan.value.guards.some(ref => canonical(ref) === canonical(reference(source))));
  const consumer = plan.value.tasks.find(task => task.node === 'garden-consume-work')!;
  assert.deepEqual(consumer.inputs.find(input => input.artifact === 'garden-data')!.source, reference(source));
  const wrongSource = externalPlanVariant(f.store, plan, value => {
    value.tasks[0]!.inputs[0]!.source = { ...reference(source), revision: source.revision + 100 };
  });
  assert.throws(() => engine.compiler.read(wrongSource.id), addressedPlan('plan_input_invalid', wrongSource.id),
    'The plan input is checked directly before an older M8 delivery could substitute its Source');
  const compilation = engine.compiler.publish(f.project, reference(plan), 0);
  engine.pipeline.accept(f.project, 'compilation', compilation.revision);
  const indexRef = m8.value.producer.deliveries.ownership!.indexes[task.writePaths[0]!]!;
  const oldIndex = readWriterIndex(f.store, f.project, task.writePaths[0]!, indexRef, null);
  const runs = await engine.executor.run(f.project, reference(plan), { retry: false, maxContextChars: 200_000, maxCorrections: 0 });
  assert.deepEqual(runs.map(run => run.value.state), ['committed'], canonical(runs.map(run => run.value.error)));
  f.restart(); engine = new ProductEngine(f.store);
  assert.deepEqual(engine.compiler.read(plan.id), plan);
  const historical = readFeasibility(f.store, { project: f.project, record: reference(m8) }); assert.ok(historical.ok, canonical(historical));
  if (historical.ok) assert.equal(canonical(historical.value), before);
  assert.equal(canonical((f.store.get(m8.id)!.value as unknown as typeof m8.value).producer.deliveries), deliveryBefore);
  assert.deepEqual(readWriterIndex(f.store, f.project, task.writePaths[0]!, indexRef, null), oldIndex);
  const run = runs.find(run => run.value.taskId === task.id)!;
  const pending = f.store.get<TaskRun>(run.id, run.revision - 1)!;
  const next = f.store.get<WriterIndex>(indexRef.id, indexRef.revision + 1)!;
  assert.equal(next.value.contract, 'writer-index/om-m8-v1');
  for (const marker of [undefined, 'external-inputs/unknown']) {
    const alteredPlan = externalPlanVariant(f.store, plan, value => {
      if (marker === undefined) delete value.derivation; else Object.assign(value, { derivation: marker });
    });
    const reviewSubject = subjectHash(reference(alteredPlan), task.id, run.value.parent, run.value.tree!);
    const runValue = { ...run.value, plan: reference(alteredPlan), reviewSubject };
    const alteredRun = { ...run, value: runValue, hash: hashJson(runValue) };
    replaceSaved(f.store, alteredRun);
    const pendingValue = { ...pending.value, plan: reference(alteredPlan), reviewSubject };
    replaceSaved(f.store, { ...pending, value: pendingValue, hash: hashJson(pendingValue) });
    const indexValue: WriterIndex = { ...next.value, origin: { kind: 'commit', run: reference(alteredRun) },
      writers: next.value.writers.map(ref => canonical(ref) === canonical(reference(run)) ? reference(alteredRun) : ref) };
    replaceSaved(f.store, { ...next, value: indexValue, hash: hashJson(indexValue) });
    f.restart();
    assert.throws(() => readWriterIndex(f.store, f.project, task.writePaths[0]!, indexRef, null),
      addressedPlan('plan_derivation_invalid', alteredPlan.id));
  }
});



test('the G5 contract does not admit the native multiple-artifact supplier fixture as an M8 work', () => {
  const graph = externalInputGraph('mixed');
  const gate = checkAtomicWorks(graph, { gaps: [], refusals: [] });
  assert.ok(gate.ok, canonical(gate));
  if (gate.ok) assert.ok(gate.value.some(finding => finding.code === 'work_artifact_not_single' && finding.target === 'p-produce-work'));
  const externalOutcome = externalInputGraph('control');
  externalOutcome.horizon.push('p-produce-work');
  const refused = checkAtomicWorks(externalOutcome, { gaps: [], refusals: [] });
  assert.ok(refused.ok, canonical(refused));
  if (refused.ok) assert.ok(refused.value.some(finding => finding.code === 'external_outcome'));
});



const compilationSnapshot = (store: Store) => canonical(store.list().map(head => ({ head, history: store.history(head.id) })));

/** Stop the current fixture at its first plan transaction, keeping the real M8 and the actual
 * compiler's pending value. No plan is written/deleted and no compilation algorithm is copied. */
function uncompiledNonexternalFixture(t: TestContext) {
  let engine!: ProductEngine, planned!: Write, before!: string, restore!: () => void;
  const captured = new Error('Test captured the first plan transaction before any write');
  assert.throws(() => executionFixture(t, 'normal', { route: 'om', beforeRoute(current) {
    engine = current;
    const store = engine.store, write = store.writeMany.bind(store);
    restore = () => { store.writeMany = write; };
    store.writeMany = ((writes, guards) => {
      const plan = writes.find(row => row.kind === 'plan');
      if (plan) {
        assert.equal(store.list('plan').length, 0); assert.equal(store.get('current-plan:p'), null);
        assert.deepEqual(writes.map(row => row.kind), ['plan', 'current-plan']);
        planned = structuredClone(plan); before = compilationSnapshot(store);
        throw captured;
      }
      return write(writes, guards);
    }) as typeof store.writeMany;
  } }), error => error === captured);
  restore();
  assert.equal(compilationSnapshot(engine.store), before);
  const value = planned.value as unknown as MachinePlan;
  assert.equal(value.derivation, 'external-inputs/v1');
  assert.equal(planned.id, `plan:p:external-inputs-v1:${value.hash}`);
  assert.ok(value.tasks.length > 0);
  assert.ok(value.tasks.every(task => task.inputs.every(input => !value.graphSnapshot.artifacts.find(artifact => artifact.id === input.artifact)!.external)));
  assert.equal(value.feasibility.id, 'om-feasibility:p');
  const m8 = externalOk(readFeasibility(engine.store, { project: 'p', record: value.feasibility }));
  assert.deepEqual(reference(m8), value.feasibility); assert.equal(m8.value.ready, true);
  const journal = join(dirname(engine.store.path), 'calls.jsonl');
  const calls = () => {
    try { return readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  assert.deepEqual(calls(), []);
  return { get store() { return engine.store; }, get engine() { return engine; }, planned, value, calls,
    reopen() { const store = new Store(engine.store.path); t.after(() => store.close()); engine = new ProductEngine(store); } };
}

/** Negative address impersonation only, not output from a historical producer. The compiler
 * supplies the pending current body; stripping its marker calculates the address being retired. */
function imitatePreExternalPlan(f: ReturnType<typeof uncompiledNonexternalFixture>, mismatch = false) {
  const { derivation: _derivation, hash: _hash, ...body } = f.value;
  const hash = hashJson(body), id = `plan:p:${hash}`;
  assert.equal(f.store.get(id), null); assert.equal(f.store.get(f.planned.id), null);
  return f.store.write({ id, kind: 'plan', expected: 0,
    value: { ...body, hash: mismatch ? hashJson('explicit negative imitation') : hash } });
}

for (const imitation of ['absent', 'matching-body', 'mismatched-body'] as const)
test(`current nonexternal M8 compilation first creates only the external-inputs-v1 plan despite ${imitation} old-address imitation and repeats inertly hot/cold`, t => {
  const f = uncompiledNonexternalFixture(t);
  const fake = imitation === 'absent' ? null : imitatePreExternalPlan(f, imitation === 'mismatched-body');
  assert.equal(f.store.get(f.planned.id), null); assert.equal(f.store.get('current-plan:p'), null);
  const plan = f.engine.compiler.compile('p');
  assert.equal(plan.id, f.planned.id); assert.deepEqual(plan.value, f.value);
  assert.equal(plan.value.derivation, 'external-inputs/v1');
  assert.deepEqual(f.store.get<Ref>('current-plan:p')!.value, reference(plan));
  assert.deepEqual(f.store.list('plan').map(reference).sort((a, b) => a.id.localeCompare(b.id)),
    [reference(plan), ...(fake ? [reference(fake)] : [])].sort((a, b) => a.id.localeCompare(b.id)));
  const afterCompile = compilationSnapshot(f.store), calls = f.calls();
  assert.deepEqual(calls, []);
  for (const cold of [false, true]) {
    if (cold) f.reopen();
    assert.deepEqual(f.engine.compiler.read(plan.id), plan);
    assert.equal(compilationSnapshot(f.store), afterCompile); assert.deepEqual(f.calls(), calls);
    assert.deepEqual(f.engine.compiler.compile('p'), plan);
    assert.equal(compilationSnapshot(f.store), afterCompile); assert.deepEqual(f.calls(), calls);
  }
});

for (const namespace of ['old', 'unknown'] as const) for (const marker of ['current', 'absent'] as const)
test(`LG41 saved ${namespace}-namespace imitation with ${marker} marker is refused by read/gate/publish/context/detail hot/cold without writes or sends`, t => {
  const f = uncompiledNonexternalFixture(t), plan = f.engine.compiler.compile('p');
  assert.equal(plan.id, f.planned.id); assert.deepEqual(plan.value, f.value);
  const task = plan.value.tasks[0]!;
  assert.ok(task); assert.deepEqual(f.engine.compiler.gate('p', reference(plan)).findings, []);
  const original = compilationSnapshot(f.store), calls = f.calls();
  for (const cold of [false, true]) {
    if (cold) f.reopen();
    assert.deepEqual(f.engine.compiler.read(plan.id), plan);
    assert.equal(compilationSnapshot(f.store), original); assert.deepEqual(f.calls(), calls);
    assert.deepEqual(f.engine.compiler.compile('p'), plan);
    assert.equal(compilationSnapshot(f.store), original); assert.deepEqual(f.calls(), calls);
  }

  // Explicit negative address imitation over a real current M8 plan, not a historical producer.
  const { hash: _hash, ...body } = structuredClone(plan.value);
  if (marker === 'absent') delete body.derivation;
  const hash = hashJson(body), value = { ...body, hash };
  const id = namespace === 'old' ? `plan:p:${hash}` : `plan:p:external-inputs-unknown:${hash}`;
  const imitation = f.store.write<MachinePlan>({ id, kind: 'plan', expected: 0, value });
  assert.deepEqual(f.store.get(id), imitation);
  assert.equal(imitation.hash, hashJson(value)); assert.equal(imitation.value.hash, hashJson(body));
  assert.equal(Object.hasOwn(imitation.value, 'derivation'), marker === 'current');
  const afterImitation = compilationSnapshot(f.store);
  for (const cold of [false, true]) {
    if (cold) f.reopen();
    const ref = reference(imitation);
    const doors = {
      read: () => f.engine.compiler.read(id),
      gate: () => f.engine.compiler.gate('p', ref),
      publish: () => f.engine.compiler.publish('p', ref, 0),
      context: () => f.engine.compiler.context('p', ref, task.id, 200_000),
      detail: () => f.engine.compiler.detail('p', ref, task.id, 'graph', { id: task.node, pointer: '', start: null, end: null }, 200_000),
    };
    for (const [name, door] of Object.entries(doors)) {
      assert.equal(compilationSnapshot(f.store), afterImitation);
      assert.throws(door, error => {
        assert.ok(error instanceof EngineError); assert.equal(error.code, 'plan_derivation_invalid');
        assert.deepEqual(error.details, { unit: 'compiler/model', target: id, field: 'id' }); return true;
      }, `${name}, cold=${cold}`);
      assert.equal(compilationSnapshot(f.store), afterImitation); assert.deepEqual(f.calls(), calls);
    }
    assert.deepEqual(f.engine.compiler.read(plan.id), plan);
    assert.equal(compilationSnapshot(f.store), afterImitation); assert.deepEqual(f.calls(), calls);
    assert.deepEqual(f.engine.compiler.compile('p'), plan);
    assert.equal(compilationSnapshot(f.store), afterImitation); assert.deepEqual(f.calls(), calls);
  }
});

test('old-address imitation cannot bypass the Environment guard of the first current nonexternal plan transaction', t => {
  const f = uncompiledNonexternalFixture(t), fake = imitatePreExternalPlan(f);
  const second = new Store(f.store.path); t.after(() => second.close());
  const other = new ProductEngine(second), environment = other.environments.get('p');
  assert.deepEqual(reference(environment), f.value.environment);
  const write = f.store.writeMany.bind(f.store);
  let raced = false, afterCompetitor!: string, calls!: string[];
  f.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(row => row.kind === 'plan')) {
      assert.deepEqual(writes.map(row => row.id), [f.planned.id, 'current-plan:p']);
      assert.ok(guards?.some(guard => canonical(guard) === canonical(reference(environment))), 'The real Environment guard reaches the atomic write');
      const { projectId: _projectId, ...value } = environment.value;
      const changed = other.environments.configure('p', { ...value, timeoutMs: value.timeoutMs + 1 }, environment.revision);
      assert.ok(changed.revision > environment.revision);
      raced = true; afterCompetitor = compilationSnapshot(f.store); calls = f.calls();
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  try { assert.throws(() => f.engine.compiler.compile('p'), { code: 'input_stale' }); }
  finally { f.store.writeMany = write; }
  assert.ok(raced);
  assert.equal(compilationSnapshot(f.store), afterCompetitor); assert.deepEqual(f.calls(), calls);
  assert.deepEqual(f.store.list('plan'), [fake]);
  assert.equal(f.store.get(f.planned.id), null); assert.equal(f.store.get('current-plan:p'), null);
});


test('two external connectors retain both task inputs while sharing one exact Source guard', t => {
  const f = currentExternalInputFixture(t, 'inside', undefined, graph => {
    const connector = { ...structuredClone(graph.connectors[0]!), id: 'p-external-flow-second' };
    graph.connectors.push(connector);
    const producerTest = graph.tests.find(item => item.node === 'p-produce-work')!;
    producerTest.covers.push(connector.id);
    producerTest.contract!.counterfactuals.push({ connector: connector.id, mutation: 'remove', expectedFailure: 'input_missing',
      command: { executable: process.execPath, args: ['check.mjs', 'produce-mutation', connector.id] } });
  });
  const consumer = f.plan.value.tasks.find(task => task.node === 'p-consume-work')!;
  assert.deepEqual(consumer.inputs, ['p-external-flow', 'p-external-flow-second'].map(connector => ({ connector, artifact: f.artifact,
    producerTask: null, receipt: null, source: reference(f.source) })));
  assert.deepEqual(f.plan.value.guards.filter(ref => ref.id === f.source.id), [reference(f.source)]);
  assert.deepEqual(f.engine.compiler.read(f.plan.id), f.plan);
  assert.deepEqual(f.calls(), []);
});
