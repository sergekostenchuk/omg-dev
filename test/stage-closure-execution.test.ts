import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, observeStore, storeReads, type Revision } from '../src/storage/store.js';
import { EngineError } from '../src/errors.js';
import { reference, STAGES, type GateContext, type StageArtifact, type StageValidators, type ExternalCheckContext, type Ref } from '../src/pipeline/contracts.js';
import { REFINEMENT_EXTERNAL_CHECKS } from '../src/graph/refinement.js';
import { EXECUTION_EXTERNAL_CHECKS, resultGate, writeSealedExecutionStage } from '../src/execution/result.js';
import { Pipeline } from '../src/pipeline/pipeline.js';
import { git } from '../src/runtime/environment.js';
import type { ExecutionResult } from '../src/execution/model.js';
import { writeFeasibility, type FeasibilityRequest } from '../src/om/feasibility.js';
import { ProductEngine } from '../src/product/engine.js';
import { prepareFrame, type FrameRequest } from '../src/om/frame-obligations.js';
import { writeHorizon } from '../src/om/horizon.js';
import type { LayerProposal } from '../src/om/frame-proposals.js';
import type { OmAcceptedFrame } from '../src/om/layer-basis.js';
import { acceptNativeWorks } from './om-fixture.js';
import { executionFixture as baseExecutionFixture } from './execution-fixture.js';
const executionFixture = (t: TestContext) => baseExecutionFixture(t, 'normal', { route: 'om' });

const context = (store: Store, projectId = 'p'): ExternalCheckContext => ({ store, projectId, stage: 'om-g2' });
const repository = (store: Store, basis: Ref, project = 'p') => REFINEMENT_EXTERNAL_CHECKS.repository!({ kind: 'repository', basis }, context(store, project));
const environment = (store: Store, basis: Ref, project = 'p') => REFINEMENT_EXTERNAL_CHECKS.environment!({ kind: 'environment', basis }, context(store, project));
const ancestry = (store: Store, basis: Ref, project = 'p') => EXECUTION_EXTERNAL_CHECKS['git-ancestry']!({ kind: 'git-ancestry', basis }, context(store, project));
function measured(action: () => void) { const before = storeReads(); action(); return storeReads() - before; }
/** A plan after the run: the same frame's gate names the tree its works were checked against, so the next plan needs a
 * second works generation accepted on the execution root the first generation's commits advanced (AT1). */
function nextPlan(f: ReturnType<typeof executionFixture>) {
  const store = f.store, graph = structuredClone(f.plan.value.graphSnapshot);
  const successors = ["produce", "consume"].map(name => {
    const node = graph.nodes.find(node => node.id === `p-${name}-work`)!;
    node.title = name === "produce" ? "Second producer pass" : "Second consumer pass";
    node.code = node.code.map(ref => ({ ...ref, status: "existing" as const }));
    const check = graph.tests.find(test => test.node === node.id)!;
    check.contract!.entrypoint.status = "existing";
    check.covers = [...new Set([...check.covers, "p-flow"])];
    check.contract!.counterfactuals.push({ connector: "p-flow", mutation: "substitute", expectedFailure: name === "produce" ? "output_overflow" : "result_overflow",
      command: { executable: process.execPath, args: ["check.mjs", `overflow-${name}`] } });
    return node;
  });
  const acceptedGraph = reference(store.get("graph:p")!), layer2 = reference(store.get("graph-layer:p:2")!);
  const frame2 = reference(store.get("om-frame:p:2")!), frame3 = store.get<OmAcceptedFrame>("om-frame:p:3")!;
  const horizon = writeHorizon(store, { project: "p", input: reference(store.get("om-input:p")!), graph: acceptedGraph,
    refinement: layer2, available: {}, choice: { choiceVersion: "second-generation", features: [{ outcome: "p-result" }], excluded: [] } });
  assert.ok(horizon.ok, horizon.ok ? "" : horizon.refusal.message);
  const request: FrameRequest = { project: "p", level: 3, graph: acceptedGraph, horizon: reference(horizon.value.gate),
    layer: reference(store.get("graph-layer:p:3")!), frame: reference(frame3), upper: { frame: frame2, horizon: reference(horizon.value.gate) } };
  const prepared = prepareFrame(store, request);
  assert.ok(prepared.ok, prepared.ok ? "" : prepared.refusal.message);
  const oldIds = new Set(["p-produce-work", "p-consume-work"]);
  const replacements = prepared.value.result.fills.filter(fill => oldIds.has(fill.node));
  const successor = (old: string) => successors.find(node => node.parent === graph.nodes.find(node => node.id === old)!.parent)!;
  const proposal: LayerProposal = { base: { graph: request.graph, frame: request.frame }, level: 3, worksContract: "works-frame/v1",
    source: "decision", status: "proposed", nodes: successors,
    fills: replacements.map(fill => ({ obligation: fill.obligation, node: successor(fill.node).id,
      ...(fill.port === undefined ? {} : { port: fill.port, codeRef: successor(fill.node).code[0]! }) })),
    replaces: replacements.map(fill => ({ obligation: fill.obligation, base: { node: fill.node, graph: request.graph },
      with: { node: successor(fill.node).id, port: fill.port ?? null }, basis: "A second pass over the committed first generation" })),
    tests: graph.tests.filter(test => successors.some(node => node.id === test.node)),
    transfers: graph.transfers!.filter(transfer => successors.some(node => node.id === transfer.to)),
    edges: graph.edges!.filter(edge => successors.some(node => node.id === edge.source)),
    localConnectors: [], artifacts: [], contracts: [], joins: [], journeys: [], packets: [], anchors: [],
    removes: successors.map(node => node.id), redefines: graph.tests.filter(test => successors.some(node => node.id === test.node)).map(test => test.id) };
  const proposed = store.write({ id: "om-proposal:p:second-generation", kind: "layer-proposal", expected: 0, value: proposal });
  acceptNativeWorks(f.engine, "p", { frame: { project: "p", level: 2, graph: acceptedGraph, horizon: request.horizon,
    layer: layer2, frame: frame2, upper: null }, proposals: [] }, { frame: request, proposals: [reference(proposed)] });
  return f.engine.compiler.compile("p");
}

test('G2b the real accepted compilation prefix is closed, cold and independent of unrelated history', t => {
  const f = executionFixture(t);
  const accepted = f.store.get<StageArtifact>('stage:p:compilation')!;
  assert.ok(accepted.value.closure, 'The real producer and registry must be connected, not a synthetic validator');
  let validations = 0, oldBodies = 0;
  const get = Store.prototype.get;
  const tracked: typeof get = function<T>(this: Store, id: string, revision?: number): Revision<T> | null {
    const record = get.call(this, id, revision) as Revision<T> | null;
    if (record && ['question', 'fact', 'decision', 'research-answer', 'research-assessment'].includes(record.kind)) oldBodies++;
    return record;
  };
  t.mock.method(Store.prototype, 'get', tracked);
  const check = () => {
    f.reopen();
    const validate = f.engine.checks.validateStage.bind(f.engine.checks);
    t.mock.method(f.engine.checks, 'validateStage', (...args: Parameters<typeof validate>) => { validations++; return validate(...args); });
    oldBodies = 0;
    const reads = measured(() => assert.equal(f.engine.pipeline.inspect('p', 'compilation').state, 'accepted'));
    assert.equal(validations, 0, 'Every declared external handler must execute without falling back to a validator');
    assert.equal(oldBodies, 0, 'The saved questions, answers and assessments are not decoded');
    return reads;
  };
  const initial = check();
  t.diagnostic(`cold compilation reads=${initial}`);
  assert.ok(initial <= 30, `A single closed compilation has at most 30 Store reads, got ${initial}`);
  for (let revision = 0; revision < 10; revision++) for (let project = 0; project < 10; project++)
    f.engine.discovery.evidence.document(`other-${project}`, 'brief', `revision ${revision}`, 'text/plain', revision);
  assert.equal(check(), initial, 'Ten times unrelated history adds no reads to the accepted prefix');
});

test('G2b projection reuses only the exact accepted draft, graph and plan, leaving new candidates their own gate', t => {
  const f = executionFixture(t);
  assert.ok(f.store.get<StageArtifact>('stage:p:compilation')!.value.closure);
  f.reopen();
  const drafts = f.engine.pipeline.project('p').filter(stage => stage.state === 'accepted')
    .flatMap(stage => { const ref = (stage.artifact!.value.content as { draft?: Ref }).draft; return ref ? [ref.id] : []; });
  const gated: string[] = [];
  const discoveryGate = f.engine.discovery.gate.bind(f.engine.discovery);
  t.mock.method(f.engine.discovery, 'gate', (...args: Parameters<typeof discoveryGate>) => { gated.push(args[1].id); return discoveryGate(...args); });
  const graphGate = t.mock.method(f.engine.graphs, 'gate');
  const planGate = t.mock.method(f.engine.compiler, 'gate');
  const feasibilityGate = t.mock.method(f.engine.refinement, 'feasibilityGate');
  f.engine.projection('p');
  assert.deepEqual(gated.filter(id => drafts.includes(id)), [], 'Closed upstream drafts need no second validation');
  assert.equal(graphGate.mock.callCount(), 0);
  assert.equal(planGate.mock.callCount(), 0);
  assert.equal(feasibilityGate.mock.callCount(), 0);
  const candidate = f.engine.discovery.create('p', 'concept', 'R0', 'concept', [
    { field: 'candidate', kind: 'decision', prompt: 'Choose a candidate', risk: 'Unaccepted candidate', schema: { type: 'string' } },
  ]);
  f.engine.projection('p');
  assert.ok(gated.includes(candidate.id), 'An unaccepted draft is not covered by another accepted draft');
  const prior = f.store.get('stage:p:compilation')!;
  f.engine.compiler.publish('p', reference(f.plan), prior.revision);
  planGate.mock.resetCalls();
  f.engine.projection('p');
  assert.ok(planGate.mock.callCount() > 0, 'An unaccepted current compilation retains its own plan gate');
  const graph = f.store.get<import('../src/graph/model.js').Graph>('graph:p')!;
  const changed = structuredClone(graph.value); changed.nodes.find(node => node.kind === 'work')!.title += ' updated';
  f.engine.graphs.save('p', changed, graph.revision, 'owner');
  graphGate.mock.resetCalls();
  f.engine.projection('p');
  assert.ok(graphGate.mock.callCount() > 0, 'A different graph Ref retains its own complete gate');
});

test('G2b sealed execution reads only its committed result externals after restart', async t => {
  const f = executionFixture(t);
  await f.engine.executor.run('p', reference(f.plan), f.options);
  assert.ok(f.store.get<StageArtifact>('stage:p:execution')!.value.closure);
  f.reopen();
  const validate = t.mock.method(f.engine.checks, 'validateStage');
  const reads = measured(() => assert.equal(f.engine.pipeline.inspect('p', 'execution').state, 'accepted'));
  assert.equal(validate.mock.callCount(), 0, 'Historical compilation repository checks must not force a validator after execution commits');
  assert.ok(reads <= 8, `A sealed two-run result needs at most 8 Store reads, got ${reads}`);
});

test('G2b exact repository/environment handlers have a fixed cold read budget and never replay feasibility', t => {
  const f = executionFixture(t), basis = f.plan.value.feasibility;
  f.reopen();
  t.mock.method(f.engine.refinement, 'feasibilityGate', () => { throw new Error('A closed external check must not replay R3'); });
  const check = () => { assert.equal(repository(f.store, basis), null); assert.equal(environment(f.store, basis), null); };
  assert.equal(measured(check), 5, 'repository=3 exact records; environment=2; no question/assessment reads');
  // More unrelated history must not cause scans or additional bodies to be decoded.
  for (let revision = 0; revision < 10; revision++) for (let project = 0; project < 10; project++)
    f.engine.discovery.evidence.document(`other-${project}`, 'brief', `revision ${revision}`, 'text/plain', revision);
  f.reopen();
  assert.equal(measured(check), 5);
  const path = join(f.workspace, 'untracked-basis.txt');
  writeFileSync(path, 'A dirty repository produces a refused new M8');
  const next = writeFeasibility(f.store, { project: 'p', graph: reference(f.store.get('graph:p')!),
    layer: reference(f.store.get('graph-layer:p:3')!), frame: reference(f.store.get('om-frame:p:3')!),
    environment: reference(f.engine.environments.get('p')), expected: basis.revision });
  assert.ok(next.ok); assert.equal(next.value.value.ready, false);
  unlinkSync(path);
  assert.equal(repository(f.store, basis), null, 'An external handler reads its exact saved basis, never the later head');
  assert.equal(f.store.headsMatch([basis]).ok, false, 'The separate head comparison rejects the moved record');
});

test('G2b unchanged Store heads do not hide dirty/untracked files, a moved git HEAD or unavailable executors', t => {
  const f = executionFixture(t), basis = f.plan.value.feasibility;
  const change = (path: string, text: string) => writeFileSync(join(f.workspace, path), text);
  const original = readFileSync(join(f.workspace, 'README.md'), 'utf8');
  change('README.md', 'dirty'); assert.equal(repository(f.store, basis)?.code, 'repository_dirty');
  change('README.md', original);
  change('new.txt', 'untracked'); assert.equal(repository(f.store, basis)?.code, 'repository_dirty');
  unlinkSync(join(f.workspace, 'new.txt'));
  git(f.workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'later']);
  assert.equal(repository(f.store, basis)?.code, 'feasibility_stale');
  assert.equal(f.store.headsMatch([basis]).ok, true);
  git(f.workspace, ['reset', '--hard', f.initial]);
});

test('G2b a missing executable invalidates the saved repository without any Store change', t => {
  let executable = '';
  const f = baseExecutionFixture(t, 'normal', { route: 'om', beforeRoute(engine) {
    const old = engine.environments.get('p');
    executable = join(old.value.workspace, '..', 'local-check');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n'); chmodSync(executable, 0o755);
    engine.environments.configure('p', { ...old.value, fullCheck: { executable, args: [] } }, old.revision);
  } });
  assert.equal(repository(f.store, f.plan.value.feasibility), null);
  chmodSync(executable, 0o644);
  assert.equal(repository(f.store, f.plan.value.feasibility)?.code, 'check_unavailable');
});

test('G2b missing, mismatched and foreign exact bases are addressed refusals', t => {
  const f = executionFixture(t), basis = f.plan.value.feasibility;
  for (const ref of [{ ...basis, revision: basis.revision + 100 }, { ...basis, hash: '0'.repeat(64) }, reference(f.plan)]) {
    assert.equal(repository(f.store, ref)?.code, 'feasibility_not_ready');
    assert.equal(environment(f.store, ref)?.code, 'feasibility_not_ready');
  }
  assert.equal(repository(f.store, basis, 'foreign')?.code, 'feasibility_not_ready');
  assert.equal(ancestry(f.store, reference(f.plan), 'foreign')?.code, 'execution_result_foreign');
  assert.equal(ancestry(f.store, { ...reference(f.plan), revision: 200 })?.code, 'execution_result_foreign');
  const missing = (hidden: string) => new Proxy(f.store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) => id === hidden ? null : target.get(id, revision);
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.equal(repository(missing(f.plan.value.environment.id), basis)?.code, 'environment_missing');
  assert.equal(environment(missing(f.plan.value.environment.id), basis)?.code, 'environment_missing');
  assert.equal(repository(missing(f.plan.value.graph.id), basis)?.code, 'feasibility_not_ready');
});

test('G2b real compilation and committed execution declare their entire external surface; git is checked after restart', async t => {
  const f = executionFixture(t);
  assert.ok(f.engine.compiler.gate('p', reference(f.plan), false, true).closure?.external.some(check => check.kind === 'git-ancestry'));
  assert.equal(ancestry(f.store, reference(f.plan)), null);
  await f.engine.executor.run('p', reference(f.plan), f.options);
  const result = f.store.list<ExecutionResult>('execution-result')[0]!;
  assert.deepEqual(resultGate(f.store, 'p', reference(result), true).closure?.external, [{ kind: 'git-ancestry', basis: reference(result) }]);
  const stage = f.store.get<StageArtifact>('stage:p:execution')!;
  assert.deepEqual(stage.value.closure?.inherited, []);
  assert.deepEqual(stage.value.closure?.external, [{ kind: 'git-ancestry', basis: reference(result) }]);
  assert.ok(stage.value.proofs.some(ref => ref.id === 'stage:p:compilation'));
  for (const ref of [reference(result), ...result.value.runs]) assert.ok(stage.value.proofs.some(proof => proof.hash === ref.hash));
  f.reopen();
  assert.equal(measured(() => assert.equal(ancestry(f.store, reference(result)), null)), 4,
    'result + plan + two exact runs; no saved review/check proof replay');
  assert.equal(f.engine.pipeline.inspect('p', 'execution').state, 'accepted');
  // G2a connects this same registry in production; here the real producer's closure
  // is exercised directly with the real validators, without inventing any acceptance.
  let validations = 0;
  const validators = Object.fromEntries(STAGES.map(stage => [stage, (context: GateContext) => {
    validations++; return f.engine.checks.validateStage(stage, context);
  }])) as StageValidators;
  const closed = new Pipeline(f.store, validators, EXECUTION_EXTERNAL_CHECKS);
  assert.equal(measured(() => assert.equal(closed.inspect('p', 'execution').state, 'accepted')), 6,
    'stage + one heads snapshot + result + plan + two runs');
  assert.equal(validations, 0);
  assert.throws(() => writeSealedExecutionStage(f.store, 'p', reference(f.store.get('stage:p:features')!), reference(result), stage.revision),
    (error: unknown) => error instanceof EngineError && error.code === 'execution_plan_foreign');
  const commit = result.value.head;
  git(f.workspace, ['replace', commit, f.initial]);
  try { assert.equal(ancestry(f.store, reference(result))?.code, 'execution_commit_foreign'); }
  finally { git(f.workspace, ['replace', '-d', commit]); }
});

test('G2b the sealed writer keeps predecessor and own-stage CAS against a second Store', async t => {
  const f = executionFixture(t);
  await f.engine.executor.run('p', reference(f.plan), f.options);
  const result = f.store.list<ExecutionResult>('execution-result')[0]!;
  const execution = f.store.get<StageArtifact>('stage:p:execution')!;
  const compilation = f.store.get('stage:p:compilation')!;
  assert.throws(() => writeSealedExecutionStage(f.store, 'p', reference(compilation), reference(result), execution.revision - 1),
    (error: unknown) => error instanceof EngineError && error.code === 'revision_conflict');
  const replacement = nextPlan(f);
  const other = new Store(join(f.directory, 'state.sqlite'));
  let moved = false;
  const prior = observeStore({ begin() { return undefined; }, end() {}, untraced() {}, write(store) {
    if (store !== f.store || moved) return;
    moved = true;
    new ProductEngine(other).compiler.publish('p', reference(replacement), compilation.revision);
  } });
  try {
    assert.throws(() => writeSealedExecutionStage(f.store, 'p', reference(compilation), reference(result), execution.revision),
      (error: unknown) => error instanceof EngineError && error.code === 'input_stale');
    assert.equal(moved, true);
    assert.equal(f.store.get('stage:p:execution')!.revision, execution.revision);
  } finally { observeStore(prior); other.close(); }
});

test('G2b compilation keeps environment CAS when a second Store reconfigures immediately before acceptance', t => {
  const f = executionFixture(t);
  const accepted = f.store.get('stage:p:compilation')!;
  const draft = f.engine.compiler.publish('p', reference(f.plan), accepted.revision);
  const other = new Store(join(f.directory, 'state.sqlite'));
  let moved = false;
  const prior = observeStore({ begin() { return undefined; }, end() {}, untraced() {}, write(store) {
    if (store !== f.store || moved) return;
    moved = true;
    const engine = new ProductEngine(other), environment = engine.environments.get('p');
    engine.environments.configure('p', environment.value, environment.revision);
  } });
  try {
    assert.throws(() => f.engine.pipeline.accept('p', 'compilation', draft.revision),
      (error: unknown) => error instanceof EngineError && error.code === 'input_stale');
    assert.equal(moved, true);
    assert.equal(f.store.get('stage:p:compilation')!.revision, draft.revision);
  } finally { observeStore(prior); other.close(); }
});

test('G2b a sealed result keeps its exact git basis after a new compilation; the stage still tracks its own predecessor', async t => {
  const f = executionFixture(t);
  await f.engine.executor.run('p', reference(f.plan), f.options);
  const result = f.store.list<ExecutionResult>('execution-result')[0]!;
  assert.equal(f.engine.pipeline.inspect('p', 'execution').state, 'accepted');
  const plan = nextPlan(f);
  const compilation = f.engine.compiler.publish('p', reference(plan), f.store.get('stage:p:compilation')!.revision);
  f.engine.pipeline.accept('p', 'compilation', compilation.revision);
  f.reopen();
  assert.equal(ancestry(f.store, reference(result)), null, 'The result keeps the original plan/root rather than the new compilation');
  assert.deepEqual(resultGate(f.store, 'p', reference(result)).findings, []);
  assert.equal(f.engine.pipeline.inspect('p', 'execution').state, 'stale', 'A new compilation still requires its own execution');
  assert.equal(ancestry(f.store, reference(plan)), null, 'The new plan checks its accepted writer receipts');
  assert.throws(() => writeSealedExecutionStage(f.store, 'p', reference(f.store.get('stage:p:compilation')!), reference(result),
    f.store.get('stage:p:execution')!.revision),
  (error: unknown) => error instanceof EngineError && error.code === 'execution_plan_foreign');
});

interface WorksFixture { store: Store; project: string; workspace: string; feasibility: FeasibilityRequest; restart(): void;
  condition?: string; marker?: string }
async function worksFixture(t: TestContext, runtime = false): Promise<WorksFixture> {
  const url = new URL('./om-feasibility.test.js', import.meta.url), source = readFileSync(url, 'utf8');
  const boundary = source.indexOf('const heads ='); assert.ok(boundary > 0);
  const start = source.indexOf('async function runtimeWorksFixture('), end = source.indexOf('function createInactivePilot(');
  assert.ok(start > boundary && end > start);
  const code = source.slice(0, boundary) + (runtime ? source.slice(start, end) : '');
  const prefix = code.replaceAll('import.meta.url', JSON.stringify(url.href)).replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
    (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`);
  assert.ok(!/\btest\(/.test(prefix));
  const name = runtime ? 'runtimeWorksFixture' : 'acceptedWorksFixture';
  const module = await import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport { ${name} };`).toString('base64')}`);
  return module[name](t);
}

test('G2b native M8 external inspection is exact and bounded, without rerunning the accepted frame or feasibility gate', async t => {
  const f = await worksFixture(t), result = writeFeasibility(f.store, f.feasibility);
  assert.ok(result.ok); if (!result.ok) return;
  const basis = reference(result.value), engine = new ProductEngine(f.store);
  assert.ok(engine.refinement.feasibilityGate(f.project, basis, false, true).closure?.external.some(check => check.kind === 'om-feasibility'));
  f.restart();
  assert.equal(measured(() => {
    assert.equal(repository(f.store, basis, f.project), null);
    assert.equal(environment(f.store, basis, f.project), null);
    assert.equal(REFINEMENT_EXTERNAL_CHECKS['om-feasibility']!({ kind: 'om-feasibility', ref: basis }, context(f.store, f.project)), null);
  }), 7, 'exact M8+environment+graph, exact M8+environment, exact M8+writer index; no accepted OM frame replay');
  writeFileSync(join(f.workspace, 'untracked.txt'), 'changed');
  assert.equal(repository(f.store, basis, f.project)?.code, 'repository_dirty');
});

test('G2b the live runtime subjects of an accepted M8 are checked without executing or reproving its observation', async t => {
  const f = await worksFixture(t, true), saved = writeFeasibility(f.store, f.feasibility);
  assert.ok(saved.ok); if (!saved.ok) return;
  const basis = reference(saved.value), calls = readFileSync(f.marker!, 'utf8');
  f.restart();
  const reads = measured(() => assert.equal(environment(f.store, basis, f.project), null));
  assert.ok(reads <= 20, `One runtime confirmation has a fixed external read budget of 20, observed ${reads}`);
  writeFileSync(f.condition!, 'not ready');
  assert.equal(environment(f.store, basis, f.project)?.code, 'environment_confirmation_required');
  assert.equal(readFileSync(f.marker!, 'utf8'), calls, 'Reading a closed runtime observation executes no command');
  assert.equal(f.store.headsMatch([basis]).ok, true, 'The external change has no Store revision');
});
