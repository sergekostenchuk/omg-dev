import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
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
import { preparedFeatures, refinedLayers } from './product-fixture.js';
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
  (engine: ProductEngine, graph: Graph, workspace: string) => void, prepareGraph?: (graph: Graph) => void, current: boolean | 'reject-mixed' | 'missing-source' | 'wrong-source' = false) {
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
  const graph = current && current !== 'reject-mixed' ? currentExternalInputGraph(mode) : externalInputGraph(mode), artifact = mode === 'control' ? 'p-data' : 'p-external';
  prepareGraph?.(graph);
  if (current) prepareOmFixtureStages(engine, 'p', graph);
  else preparedFeatures(engine, 'p', graph);
  const source = engine.discovery.evidence.document('p', current === 'missing-source' ? 'unrelated' : artifact,
    current === 'wrong-source' ? JSON.stringify('not a number') : '2', 'application/json', 0);
  const command = { executable: process.execPath, args: [agent, journal, mode] };
  engine.environments.configure('p', { workspace, implementer: { actor: 'worker', model: 'protocol-fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'protocol-fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['check.mjs', 'all'] }, timeoutMs: 10_000,
    ...(current ? { requestCapacityChars: 100_000 } : {}) }, 0);
  configure?.(engine, graph, workspace);
  if (current) {
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
  }
  else {
    refinedLayers(engine, 'p');
    const feasibility = engine.refinement.assess('p', 0);
    const stage = engine.refinement.publish('p', reference(feasibility), 0); engine.pipeline.accept('p', 'om-g2', stage.revision);
  }
  const plan = engine.compiler.compile('p');
  const compilation = engine.compiler.publish('p', reference(plan), 0); engine.pipeline.accept('p', 'compilation', compilation.revision);
  return { get store() { return store; }, get engine() { return engine; }, directory, workspace, initial, graph, artifact, source, plan,
    calls: (): ExternalAgentCall[] => { try { return readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    reopen: () => { store.close(); store = new Store(join(directory, 'state.sqlite')); engine = new ProductEngine(store); return engine; },
    options: { retry: false, maxContextChars: 100_000, maxCorrections: 0 } };
}

/** Current consumers use M8; the default above remains the serialized v3 historical producer. */
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
  for (const marker of [undefined, null, 'external-inputs/unknown']) {
    const variant = externalPlanVariant(f.store, f.plan, value => {
      if (marker === undefined) delete value.derivation;
      else Object.assign(value, { derivation: marker });
    });
    f.reopen();
    assert.throws(() => f.engine.compiler.read(variant.id), addressedPlan('plan_derivation_invalid', variant.id));
    const altered = { ...variant, id: f.plan.id, revision: f.plan.revision };
    replaceSaved(f.store, altered); f.reopen();
    assert.throws(() => f.engine.compiler.compile('p'), addressedPlan('plan_derivation_invalid', f.plan.id));
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

const V3_HISTORY_BASE = 'e1e87e9596d1be7fb390564782e5aa60f5431e0b';
const V3_HISTORY_LOADER = String.raw`import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
let root,ts,manifest,base;
export async function initialize(data){root=data.root;manifest=data.manifest;base=data.base;ts=(await import(data.typescript)).default;}
export async function load(url,context,next){
 const prefix=new URL('dist/',root).href;
 if(url.startsWith(prefix)&&/\.js$/.test(url)){
  const relative=url.slice(prefix.length).replace(/\.js$/,'.ts');
  if(relative.startsWith('src/')||relative.startsWith('test/')){
   const source=execFileSync('git',['show',base+':'+relative],{cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
   appendFileSync(manifest,relative+'\n');
   return {format:'module',shortCircuit:true,source:ts.transpileModule(source,
    {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};
  }
 }
 return next(url,context);
}`;

interface V3HistoricalExecution {
  directory: string; workspace: string; database: string; journal: string;
  plan: Revision<MachinePlan>; records: Revision<any>[]; calls: unknown[];
  runs: Revision<TaskRun>[]; receipts: Revision<ArtifactReceipt>[];
  options: { retry: boolean; maxContextChars: number; maxCorrections: number };
  source: Revision<any> | null;
  failure: { code: string; message: string } | null;
}

function v3HistoricalExecution(t: TestContext, scenario: 'defective-external' | 'defective-external-control' | 'defective-external-control-unexecuted' | 'defective-external-unexecuted'
  | 'unexecuted' | 'pending' | 'completed'): V3HistoricalExecution {
  const directory = mkdtempSync(join(tmpdir(), 'omg-v3-whole-git-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const loader = join(directory, 'loader.mjs'), producer = join(directory, 'producer.mjs'), manifest = join(directory, 'loaded-src.txt');
  writeFileSync(loader, V3_HISTORY_LOADER);
  // The current fixture supplies data and the controlled agent only. Every src module,
  // including ProductEngine, Compiler, Executor and their transitive readers, is base Git.
  writeFileSync(producer, `import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const repository=process.argv[2],scenario=process.argv[3],src=path=>pathToFileURL(join(repository,'dist/src',path)).href,
 helpers=path=>pathToFileURL(join(repository,'dist/test',path)).href;
const {Store}=await import(src('storage/store.js'));
const {ProductEngine}=await import(src('product/engine.js'));
const {Executor}=await import(src('execution/runner.js'));
const {executionInputs}=await import(src('execution/inputs.js'));
const {reference}=await import(src('pipeline/contracts.js'));
const {git}=await import(src('runtime/environment.js'));
const {requireGraph}=await import(src('graph/validate.js'));
const {preparedFeatures,refinedLayers}=await import(helpers('product-fixture.js'));
const {enrichedGraph}=await import(helpers('enriched-graph-fixture.js'));
const {exampleGraph}=await import(helpers('graph-fixture.js'));
const {executionFixture}=await import(helpers('execution-fixture.js'));
const EXTERNAL_AGENT=${JSON.stringify(EXTERNAL_AGENT)};
${externalInputGraph.toString()}
${externalInputFixture.toString()}
const cleanup=[],context={after:fn=>cleanup.push(fn)};
let fixture;
try {
 fixture=scenario.startsWith('defective-external')?externalInputFixture(context,scenario.startsWith('defective-external-control')?'control':'inside'):executionFixture(context);
 const f=fixture;let failure=null,runs;
 assert.equal(f.plan.value.derivation,undefined);
 assert.match(f.plan.id,/^plan:p:[a-f0-9]{64}$/);
 if(scenario==='unexecuted'||scenario.endsWith('-unexecuted')) {
  runs=[];
  if(scenario==='defective-external-control-unexecuted') {
   const consumer=f.plan.value.tasks.find(task=>task.node==='p-consume-work');
   try {executionInputs(f.store,f.plan,consumer,{path:f.workspace,head:f.plan.value.base.head});assert.fail('The old control reader must still fail without running a task');}
   catch(error){assert.equal(error.code,'execution_input_missing');failure={code:error.code,message:error.message};}
  }
 }
 else if(scenario==='pending') {
  const executor=new Executor(f.store,f.engine.compiler,f.engine.environments,()=>{throw new Error('historical afterGitPublish crash');});
  await assert.rejects(executor.run('p',reference(f.plan),f.options),/historical afterGitPublish crash/);
  runs=f.store.list('task-run');
  assert.equal(runs.length,1);assert.equal(runs[0].value.state,'commit_pending');
  assert.equal(git(f.store.get('execution-root:p').value.path,['rev-parse','HEAD']),runs[0].value.commit);
 } else {
  runs=await f.engine.executor.run('p',reference(f.plan),f.options);
  if(scenario==='completed') assert.deepEqual(runs.map(run=>run.value.state),['committed','committed']);
  else {
   assert.deepEqual(runs.map(run=>run.value.state),scenario==='defective-external-control'?['needs_plan']:['committed','needs_plan']);
   const consumer=f.plan.value.tasks.find(task=>task.node==='p-consume-work');
   if(scenario==='defective-external-control') {
    assert.deepEqual(consumer.inputs[0].source,reference(f.source));assert.equal(consumer.inputs[0].producerTask,null);
    assert.equal(consumer.inputs[0].connector,'p-external-prerequisite');
    assert.equal(f.plan.value.graphSnapshot.connectors.some(connector=>connector.id===consumer.inputs[0].connector),false);
    assert.ok(f.plan.value.guards.some(ref=>ref.id===f.source.id));
   } else {
    assert.equal(consumer.inputs[0].source,null);assert.ok(consumer.inputs[0].producerTask);
    assert.equal(f.plan.value.guards.some(ref=>ref.id===f.source.id),false);
   }
   try {executionInputs(f.store,f.plan,consumer,f.store.get('execution-root:p').value);assert.fail('Old external execution must fail');}
   catch(error){assert.equal(error.code,scenario==='defective-external-control'?'execution_input_missing':'execution_input_foreign');failure={code:error.code,message:error.message};}
  }
 }
 const result={directory:f.directory,workspace:f.workspace,database:f.store.path,journal:join(f.directory,'calls.jsonl'),
  plan:f.plan,records:f.store.list().flatMap(row=>f.store.history(row.id)),calls:f.calls(),runs,receipts:f.store.list('artifact'),options:f.options,
  source:scenario.startsWith('defective-external')?f.source:null,failure};
 f.store.close();process.stdout.write(JSON.stringify(result));
} catch(error){for(const fn of cleanup)try{fn();}catch{}throw error;}
`);
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const bootstrap = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},
{data:{root:${JSON.stringify(pathToFileURL(repository).href)},typescript:${JSON.stringify(typescript)},manifest:${JSON.stringify(manifest)},base:${JSON.stringify(V3_HISTORY_BASE)}}});`;
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const raw = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, scenario],
    { cwd: repository, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 40_000_000 });
  const old = JSON.parse(raw) as V3HistoricalExecution;
  t.after(() => rmSync(old.directory, { recursive: true, force: true }));
  const loaded = new Set(readFileSync(manifest, 'utf8').trim().split('\n'));
  for (const path of ['src/product/engine.ts', 'src/compiler/compiler.ts', 'src/compiler/derive.ts', 'src/compiler/inputs.ts',
    'src/execution/runner.ts', 'src/execution/inputs.ts', 'src/execution/task-obligations.ts', 'src/ownership/writer-index.ts'])
    assert.ok(loaded.has(path), `The historical process must load ${path} from the same Git producer`);
  return old;
}

function v3SavedRowsUnchanged(store: Store, records: Revision<any>[]): void {
  for (const row of records) assert.deepEqual(store.get(row.id, row.revision), row,
    `Saved ${row.id}@${row.revision} must preserve its original bytes, hash and timestamps`);
}

function v3DurableExecutionHeads(store: Store): Revision<any>[] {
  return store.list().filter(row => ['plan', 'task-run', 'artifact', 'writer-index', 'execution-root', 'execution-result', 'stage'].includes(row.kind));
}

test('whole historical Git producer keeps its defective external plan sealed and does not retrofit a Source', async t => {
  const old = v3HistoricalExecution(t, 'defective-external');
  let store = new Store(old.database);
  try {
    let engine = new ProductEngine(store);
    assert.deepEqual(engine.compiler.read(old.plan.id), old.plan);
    const consumer = old.plan.value.tasks.find(task => task.node === 'p-consume-work')!;
    assert.ok(consumer.inputs[0]!.producerTask);
    assert.equal(consumer.inputs[0]!.source, null);
    assert.equal(old.plan.value.guards.some(ref => ref.id === old.source!.id), false);
    const root = store.get<ExecutionRoot>('execution-root:p')!.value;
    assert.throws(() => executionInputs(store, old.plan, consumer, root), old.failure!);
    const retried = await engine.executor.run('p', reference(old.plan), { ...old.options, retry: true });
    assert.deepEqual(retried.map(run => run.value.state), ['committed', 'needs_plan']);
    assert.deepEqual(retried.find(run => run.value.taskId === consumer.id)!.value.inputs, []);
    assert.deepEqual(JSON.parse(`[${readFileSync(old.journal, 'utf8').trim().split('\n').join(',')}]`), old.calls,
      'A retry cannot dispatch the consumer with a Source absent from its sealed plan');
    assert.deepEqual(store.list('plan'), [old.plan]);
    assert.deepEqual(store.get(old.source!.id), old.source);
    v3SavedRowsUnchanged(store, old.records);
    store.close(); store = new Store(old.database); engine = new ProductEngine(store);
    assert.deepEqual(engine.compiler.read(old.plan.id), old.plan);
    v3SavedRowsUnchanged(store, old.records);
  } finally { store.close(); }
});

test('whole historical Git producer preserves afterGitPublish recovery and exact completed repetitions', async t => {
  for (const scenario of ['pending', 'completed'] as const) await t.test(scenario, async t => {
    const old = v3HistoricalExecution(t, scenario);
    let store = new Store(old.database);
    try {
      let engine = new ProductEngine(store);
      assert.deepEqual(engine.compiler.read(old.plan.id), old.plan);
      if (scenario === 'pending') {
        const pending = old.runs[0]!;
        const recovered = await engine.executor.recover('p');
        assert.equal(recovered.length, 1);
        assert.deepEqual(recovered[0]!.value, { ...pending.value, state: 'committed', child: null, updatedAt: recovered[0]!.value.updatedAt });
        assert.equal(recovered[0]!.revision, pending.revision + 1);
        assert.deepEqual(store.get(pending.id, pending.revision), pending);
        assert.deepEqual(JSON.parse(`[${readFileSync(old.journal, 'utf8').trim().split('\n').join(',')}]`), old.calls,
          'Published commit recovery does not rerun the old implementation, checks or review');
      }
      const completed = await engine.executor.run('p', reference(old.plan), old.options);
      assert.deepEqual(completed.map(run => run.value.state), ['committed', 'committed']);
      if (scenario === 'completed') {
        assert.deepEqual(completed, old.runs);
        assert.deepEqual(store.list('artifact'), old.receipts);
      }
      for (const run of completed) assert.deepEqual(run.value.plan, reference(old.plan));
      for (const receipt of store.list<ArtifactReceipt>('artifact')) assert.deepEqual(receipt.value.plan, reference(old.plan));
      assert.deepEqual(store.list('plan'), [old.plan]);
      v3SavedRowsUnchanged(store, old.records);
      const saved = v3DurableExecutionHeads(store), calls = readFileSync(old.journal, 'utf8');
      store.close(); store = new Store(old.database); engine = new ProductEngine(store);
      assert.deepEqual(engine.compiler.read(old.plan.id), old.plan);
      assert.deepEqual(await engine.executor.recover('p'), []);
      assert.deepEqual(await engine.executor.run('p', reference(old.plan), old.options), completed);
      assert.deepEqual(v3DurableExecutionHeads(store), saved);
      assert.equal(readFileSync(old.journal, 'utf8'), calls);
      v3SavedRowsUnchanged(store, old.records);
    } finally { store.close(); }
  });
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


test('a historical external requires input with an already sealed Source upgrades its execution era and commits', async t => {
  const failed = v3HistoricalExecution(t, 'defective-external-control');
  const failedStore = new Store(failed.database);
  try {
    assert.equal(failed.failure!.code, 'execution_input_missing');
    assert.deepEqual(failed.runs.map(run => run.value.state), ['needs_plan']);
    const consumer = failed.plan.value.tasks[0]!;
    assert.throws(() => executionInputs(failedStore, failed.plan, consumer, failedStore.get<ExecutionRoot>('execution-root:p')!.value), failed.failure!);
    assert.throws(() => new ProductEngine(failedStore).compiler.compile('p'), { code: 'om_not_ready' },
      'A failed execution still requires renewed current admission; the new derivation cannot bypass it');
    v3SavedRowsUnchanged(failedStore, failed.records);
  } finally { failedStore.close(); }
  const old = v3HistoricalExecution(t, 'defective-external-control-unexecuted');
  const store = new Store(old.database);
  try {
    const engine = new ProductEngine(store);
    assert.deepEqual(engine.compiler.read(old.plan.id), old.plan);
    assert.equal(old.failure!.code, 'execution_input_missing');
    assert.deepEqual(old.runs, []);
    const plan = engine.compiler.compile('p');
    assert.notEqual(plan.id, old.plan.id, 'Source already present in an old plan does not repair the old execution formula');
    assert.equal(plan.value.derivation, 'external-inputs/v1');
    const { derivation: _derivation, hash: _newHash, ...newBody } = plan.value;
    const { hash: _oldHash, ...oldBody } = old.plan.value;
    assert.deepEqual(newBody, oldBody, 'All old task and basis bytes may match while the execution era must still change');
    const compilation = engine.compiler.publish('p', reference(plan), store.get('stage:p:compilation')!.revision);
    engine.pipeline.accept('p', 'compilation', compilation.revision);
    const runs = await engine.executor.run('p', reference(plan), old.options);
    assert.deepEqual(runs.map(run => run.value.state), ['committed'], canonical(runs.map(run => run.value.error)));
    assert.deepEqual(runs[0]!.value.inputs, [reference(old.source!)]);
    assert.deepEqual(store.get(old.source!.id), old.source);
    assert.deepEqual(store.get(old.plan.id), old.plan);
    v3SavedRowsUnchanged(store, old.records);
  } finally { store.close(); }
});

test('a fresh historical external supplier inside the plan compiles a new Source-bound era', async t => {
  const old = v3HistoricalExecution(t, 'defective-external-unexecuted');
  const store = new Store(old.database);
  try {
    const engine = new ProductEngine(store);
    assert.deepEqual(engine.compiler.read(old.plan.id), old.plan);
    assert.deepEqual(store.list('task-run'), []);
    const oldConsumer = old.plan.value.tasks.find(task => task.node === 'p-consume-work')!;
    assert.ok(oldConsumer.inputs[0]!.producerTask); assert.equal(oldConsumer.inputs[0]!.source, null);
    const plan = engine.compiler.compile('p'), consumer = plan.value.tasks.find(task => task.node === oldConsumer.node)!;
    assert.notEqual(plan.id, old.plan.id); assert.equal(plan.value.derivation, 'external-inputs/v1');
    const unchanged = (value: MachinePlan) => value.tasks.map(task => ({ node: task.node, id: task.id, signature: task.signature,
      produces: task.produces, ownership: task.ownership })).sort((left, right) => left.node.localeCompare(right.node));
    assert.deepEqual(unchanged(plan.value), unchanged(old.plan.value), 'Changing the input derivation preserves task identities, signatures, outputs and ownership');
    assert.deepEqual(consumer.inputs, [{ connector: 'p-external-flow', artifact: 'p-external', producerTask: null, receipt: null, source: reference(old.source!) }]);
    assert.ok(plan.value.guards.some(ref => canonical(ref) === canonical(reference(old.source!))));
    const compilation = engine.compiler.publish('p', reference(plan), store.get('stage:p:compilation')!.revision);
    engine.pipeline.accept('p', 'compilation', compilation.revision);
    const runs = await engine.executor.run('p', reference(plan), old.options);
    assert.deepEqual(runs.map(run => run.value.state), ['committed', 'committed'], canonical(runs.map(run => run.value.error)));
    assert.deepEqual(engine.compiler.read(old.plan.id), old.plan);
    v3SavedRowsUnchanged(store, old.records);
  } finally { store.close(); }
});

test('a genuine unexecuted legacy v2 without external task inputs repeats after restart without writes', t => {
  const old = v3HistoricalExecution(t, 'unexecuted');
  let store = new Store(old.database);
  try {
    assert.equal(old.plan.value.version, 2); assert.equal(old.plan.value.derivation, undefined);
    assert.deepEqual(store.list('task-run'), []);
    assert.ok(old.plan.value.tasks.every(task => task.inputs.every(input => !old.plan.value.graphSnapshot.artifacts.find(artifact => artifact.id === input.artifact)!.external)));
    for (let repeat = 0; repeat < 2; repeat++) {
      store.close(); store = new Store(old.database);
      const engine = new ProductEngine(store), before = canonical(store.list().flatMap(row => store.history(row.id)));
      assert.deepEqual(engine.compiler.compile('p'), old.plan);
      assert.deepEqual(engine.compiler.compile('p', [{ id: 'unavailable-extra-guard', revision: 1, hash: '0'.repeat(64) }]), old.plan,
        'An already completed repeat preserves the former extraGuards behavior');
      assert.deepEqual(engine.compiler.read(old.plan.id), old.plan);
      assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), before);
      assert.deepEqual(store.get('current-plan:p')!.value, reference(old.plan));
    }
    v3SavedRowsUnchanged(store, old.records);
    const corrupted = structuredClone(old.plan.value) as unknown as Record<string, unknown>;
    delete corrupted['tasks'];
    const { hash: _oldHash, ...corruptBody } = corrupted; corrupted['hash'] = hashJson(corruptBody);
    replaceSaved(store, { ...old.plan, value: corrupted, hash: hashJson(corrupted) });
    store.close(); store = new Store(old.database);
    const before = canonical(store.list().flatMap(row => store.history(row.id)));
    assert.throws(() => new ProductEngine(store).compiler.compile('p'), addressedPlan('plan_corrupt', old.plan.id));
    assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), before);
  } finally { store.close(); }
});

test('without an exact legacy v2 record nonexternal compilation creates only the new era', t => {
  const f = executionFixture(t, "normal", { route: "om" });
  const { derivation: _derivation, hash: _hash, ...body } = f.plan.value;
  assert.ok(f.plan.value.tasks.every(task => task.inputs.every(input => !f.plan.value.graphSnapshot.artifacts.find(artifact => artifact.id === input.artifact)!.external)));
  assert.equal(f.plan.value.derivation, 'external-inputs/v1');
  assert.equal(f.store.get(`plan:p:${hashJson(body)}`), null);
  assert.deepEqual(f.store.list('plan'), [f.plan]);
  assert.deepEqual(f.store.get('current-plan:p')!.value, reference(f.plan));
});

test('new exact plan wins over an existing legacy v2 and a corrupt new record never falls back', t => {
  const old = v3HistoricalExecution(t, 'unexecuted');
  let store = new Store(old.database);
  try {
    const plan = externalPlanVariant(store, old.plan, value => { value.derivation = 'external-inputs/v1'; });
    store.close(); store = new Store(old.database);
    let engine = new ProductEngine(store), before = canonical(store.list().flatMap(row => store.history(row.id)));
    assert.deepEqual(engine.compiler.read(plan.id), plan);
    assert.deepEqual(engine.compiler.compile('p'), plan);
    assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), before);
    assert.deepEqual(store.get('current-plan:p')!.value, reference(old.plan), 'A completed repeat writes no pointer');
    const value = structuredClone(plan.value); delete value.derivation;
    replaceSaved(store, { ...plan, value, hash: hashJson(value) });
    store.close(); store = new Store(old.database); engine = new ProductEngine(store);
    before = canonical(store.list().flatMap(row => store.history(row.id)));
    assert.throws(() => engine.compiler.compile('p'), addressedPlan('plan_derivation_invalid', plan.id));
    assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), before);
    assert.deepEqual(store.get(old.plan.id), old.plan);
    v3SavedRowsUnchanged(store, old.records);
  } finally { store.close(); }
});

test('legacy no-write compilation keeps its original admission guards when a second Store changes a dependency', t => {
  const old = v3HistoricalExecution(t, 'unexecuted');
  const store = new Store(old.database), second = new Store(old.database);
  try {
    const engine = new ProductEngine(store), source = store.get<Source>('source:p:brief')!;
    assert.ok(old.plan.value.guards.some(ref => canonical(ref) === canonical(reference(source))));
    const get = store.get.bind(store), plans = store.list('plan'), pointer = store.get('current-plan:p');
    let raced = false;
    store.get = ((id: string, revision?: number) => {
      const found = get(id, revision);
      if (!raced && id === old.plan.id && revision === undefined) {
        raced = true;
        new ProductEngine(second).discovery.evidence.document('p', 'brief', 'A changed dependency after original admission checks', 'text/plain', source.revision);
      }
      return found;
    }) as typeof store.get;
    try { assert.throws(() => engine.compiler.compile('p'), { code: 'plan_stale' }); }
    finally { store.get = get; }
    assert.ok(raced); assert.deepEqual(store.list('plan'), plans); assert.deepEqual(store.get('current-plan:p'), pointer);
    assert.equal(store.get<Source>(source.id)!.revision, source.revision + 1);
    v3SavedRowsUnchanged(store, old.records);
  } finally { second.close(); store.close(); }
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
