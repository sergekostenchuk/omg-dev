import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, digest, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { Store, type Revision, type Write, type TransactionGuard } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, uniqueRefs, type Ref } from '../src/pipeline/contracts.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { configureReaderPilot, type ReaderPilotSettings } from '../src/discovery/reader-pilot.js';
import type { Source } from '../src/evidence/evidence.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { carriedObligations, type ObligationPolicy, type CarriedObligation, type RuntimeCheck } from '../src/graph/obligation-policy.js';
import { configureResearchScope } from '../src/graph/research-scope.js';
import { findObligationConfirmation, frozenObligationConfirmation, readinessObligations } from '../src/graph/obligation-readiness.js';
import { runtimeSupport } from '../src/graph/runtime-evidence.js';
import { bindTaskObligations, taskBindingId } from '../src/graph/task-obligations.js';
import { taskStartProofs, taskResultProofs, requireCurrentTaskStart, requireTaskObligationProofs } from '../src/execution/task-obligations.js';
import type { TaskRun } from '../src/execution/model.js';
import { receiptId, type CompiledTask, type MachinePlan } from '../src/compiler/model.js';
import { runtimeContext, type RuntimeObservationResult } from '../src/runtime/runtime-observation.js';
import { Environments, git, uniqueTransactionGuards, transactionGuardsCurrent, type ExecutionRoot } from '../src/runtime/environment.js';
import { ensureWorktree } from '../src/execution/worktree.js';
import { runtimeSource, type RuntimeObservation } from '../src/runtime/runtime-observation-model.js';
import { writeOmInput } from '../src/om/input.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeGapLines } from '../src/om/gap-lines.js';
import { OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND, normalizeOwnerGapAssignment,
  writeOmObligations, readOmObligationLedger, type OwnerGapAssignment, type ObligationRequest, type OmObligationHandoff, type OmObligationRecord } from '../src/om/obligations.js';
import type { OmResult } from '../src/om/refusal.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { answerTechnicalFixture } from './technical-research-fixture.js';
import { answerLayerFixture, deriveLayerFixture } from './layer-design-fixture.js';
import { executionFixture } from './execution-fixture.js';

const clone = structuredClone;
const selector = (obligation: CarriedObligation) => taskBindingId(obligation);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function typed(error: unknown): boolean { assert.ok(error instanceof EngineError); return true; }
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'The declared local fixture must reach its recorded execution boundary');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Use the native B1 -> D1 -> D2 -> H2 -> D7 producer, never a caller-built ledger. */
function fixture(t: TestContext, options: { count?: number; multipleConsumers?: boolean; sameCheck?: boolean; declared?: boolean; mode?: 'normal' | 'wait' | 'timeout' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-om-runtime-'))), database = join(root, 'state.sqlite'), project = 'garden';
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const desired = gardenGraph(), multiple = options.multipleConsumers ?? false, count = options.count ?? 1;
  const consumer = multiple ? 'garden-later-operation' : 'garden-produce-block';
  if (multiple) {
    desired.nodes.find(node => node.id === consumer)!.parent = 'garden-produce-block';
    desired.edges!.push({ id: 'late-consumer-realizes-later', relation: 'realizes', source: consumer,
      target: 'garden-later-block', condition: 'One operation serves two retained consumers' });
  }
  writeFileSync(join(root, 'README.md'), 'Controlled OM declaration fixture.\n');
  const { level: _level, ...projection } = projectGraph(desired, 1);
  preparedFeatures(engine, project, projection as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = Array.from({ length: count }, (_, index) => ({
      id: `late-${index}`, question: `Observe local runtime condition ${index}`, consumer,
      blocksCurrentStage: false, resolution: 'Observe the actual environment at the declared task moment',
    }));
    return value;
  });
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'worker', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 3000 }, 0);
  if (multiple) {
    const r0 = engine.refinement.begin(project, 'R0');
    engine.refinement.finishResearch(project, 'R0', reference(r0), 0); engine.refinement.sealLayer(project, 1, 0);
    const r1 = engine.refinement.begin(project, 'R1'); answerTechnicalFixture(engine, project, r1);
    engine.refinement.finishResearch(project, 'R1', reference(store.get(r1.id)!), 0);
    const design = engine.refinement.prepareLayer(project, 2), answered = answerLayerFixture(engine, project, design, 2, desired);
    engine.refinement.buildLayer(project, 2, reference(answered), store.get(`graph:${project}`)!.revision, 'worker');
    engine.refinement.sealLayer(project, 2, 0);
  }
  let input = ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const graph = store.get<Graph>(`graph:${project}`)!, upper = store.get(`graph-layer:${project}:2`)!;
  input = ok(writeAddressing(store, { project, input: reference(input), graph: reference(graph),
    decisions: Array.from({ length: count }, (_, index) => ({ pending: inputDecisionWrite({ project, input: reference(input), graph: reference(graph),
      layers: multiple ? [reference(upper)] : [], decision: { target: `discovery:late-${index}`, field: 'address',
        value: { consumer, kind: 'environment-confirmation' } } }) as Write })) }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph),
    refinement: multiple ? reference(store.get(`phase:${project}:L2`)!) : null, available: {},
    choice: { choiceVersion: 'runtime-first-pass', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate),
      layer: multiple ? reference(upper) : null, frame: null, upper: null } },
    works: multiple ? { proposals: [], frame: { project, level: 3, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: { horizon: reference(horizon.gate), frame: null } } } : { state: 'upper-not-accepted', layer: reference(upper) } };
  const gaps = ok(writeGaps(store, sources)), gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const marker = join(root, 'invocations.log'), condition = join(root, 'condition.txt'); writeFileSync(condition, 'ready');
  const script = engine.discovery.evidence.document(project, 'runtime-module',
    `import{readFileSync,appendFileSync,existsSync}from'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));
const [marker,condition,mode]=process.argv.slice(2);appendFileSync(marker,'executed\\n');
if(mode==='wait')await new Promise(resolve=>{const timer=setInterval(()=>{if(existsSync(marker+'.release')){clearInterval(timer);resolve();}},10);});
if(mode==='timeout')await new Promise(resolve=>setTimeout(resolve,2000));
console.log(JSON.stringify({protocol:input.protocol,obligation:input.obligation,condition:readFileSync(condition,'utf8')}));
process.exitCode=readFileSync(condition,'utf8')==='ready'&&!existsSync(marker+'.fail')?0:7;`, 'text/plain', 0);
  const request: ObligationRequest = { project, gaps: gapRead, lines: reference(lines), assignments: gaps.records
    .filter(row => row.value.gap.kind === 'environment-confirmation').map(row => {
      const value = clone(normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project,
        context: { gaps: gapRead, lines: reference(lines) }, gap: reference(row), assignments: row.value.gap.consumers.map(responsibleConsumer => {
          const returnCondition = options.sameCheck ? 'The local fixture must be ready for this retained gap'
            : `The local fixture must be ready for ${responsibleConsumer} at ${row.value.gap.target}`;
          const check: RuntimeCheck = { script: reference(script), dependencies: [], subjects: [condition], executables: [process.execPath],
            args: [marker, condition, options.mode ?? 'normal'], timeoutMs: options.mode === 'timeout' ? 100 : 3000,
            purpose: 'Observe a controlled local fixture; no provider capability claim', satisfies: returnCondition };
          return { responsibleNode: responsibleConsumer, responsibleConsumer, reason: 'An explicit late runtime prerequisite', returnCondition,
            wake: null, ...(options.declared === false ? {} : { runtimeCheck: check }) };
        }) })) as OwnerGapAssignment;
      return { pending: { id: `om-owner-gap-assignment:${project}:${hashJson(value)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value } };
    }) };
  const ledger = ok(writeOmObligations(store, request));
  const obligations = clone(ledger.handoff.obligations) as CarriedObligation[];
  const observe = (obligation = obligations[0]!, key = selector(obligation)) => engine.execute({ type: 'observe-runtime', project,
    scope: reference(ledger.record), obligation: selector(obligation), key }) as Promise<RuntimeObservationResult>;
  const reopen = () => { store.close(); store = new Store(database); engine = new ProductEngine(store); };
  return { root, database, project, desired, environment, graph, input, gaps, lines, script, request, ledger, obligations, marker, condition,
    get store() { return store; }, get engine() { return engine; }, observe, reopen };
}

function taskFixture(f: ReturnType<typeof fixture>) {
  const graph = clone(f.desired), node = graph.nodes.find(node => node.id === 'garden-produce-work')!;
  graph.researchObligations = f.obligations.map(obligation => ({ id: taskBindingId(obligation), scope: obligation.scope,
    obligation: obligation.obligation, consumers: [{ node: node.id, tests: [] }] }));
  const bindings = bindTaskObligations(f.store, f.project, graph, clone(f.ledger.handoff) as OmObligationHandoff);
  assert.deepEqual(bindings.findings, []);
  const savedGraph = f.store.write({ id: 'compiled-graph:garden:runtime-fixture', kind: 'graph', expected: 0, value: graph });
  const task: CompiledTask = { id: 'task:runtime-fixture', node: node.id, title: 'Runtime-bound fixture work', outcome: node.outcome,
    signature: hashJson(node), boundary: node.boundary, writePaths: [], readPaths: [], tests: [], dependencies: [], inputs: [], produces: [], obligations: [],
    researchObligations: bindings.byNode.get(node.id)! };
  const feasibility = f.store.write({ id: 'feasibility:garden:runtime-fixture', kind: 'feasibility', expected: 0,
    value: { projectId: f.project, inputs: clone(f.ledger.inputs) } });
  const plan = f.store.write<MachinePlan>({ id: 'plan:garden:runtime-fixture', kind: 'plan', expected: 0,
    value: { projectId: f.project, graph: reference(savedGraph), graphSnapshot: graph, feasibility: reference(feasibility), tasks: [task] } });
  const run: TaskRun = { projectId: f.project, plan: reference(plan), taskId: task.id, attempt: 1, state: 'implementing',
    parent: 'parent-fixture', tree: 'candidate-fixture', commit: null, implementation: null, artifacts: [], checks: [], review: null,
    reviewSubject: null, error: null, child: null, inputs: [], usage: [], createdAt: 1, updatedAt: 1 };
  return { task, run };
}

function raceCompletedObservation(f: ReturnType<typeof fixture>, snapshotKind: 'source' | 'runtime-observation') {
  const original = f.store.list.bind(f.store), counter = `project-dispatch:${hashJson(f.project)}`;
  const before = reference(f.store.get(counter)!); let raced = false;
  const request = { type: 'observe-runtime', project: f.project, scope: reference(f.ledger.record),
    obligation: selector(f.obligations[0]!), key: `concurrent-failure-after-${snapshotKind}` };
  writeFileSync(f.marker + '.fail', 'The next genuine observation must report failure');
  const child = `import{Store}from${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import{ProductEngine}from${JSON.stringify(new URL('../src/product/engine.js', import.meta.url).href)};
const store=new Store(${JSON.stringify(f.database)});
try{const result=await new ProductEngine(store).execute(${JSON.stringify(request)});
process.stdout.write(JSON.stringify({status:result.observation.value.status,exitCode:result.observation.value.result?.exitCode}));}finally{store.close();}`;
  f.store.list = <T = Json>(kind?: string): Revision<T>[] => {
    const snapshot = original<T>(kind);
    if (!raced && kind === snapshotKind) {
      raced = true;
      const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child],
        { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })) as { status: string; exitCode: number };
      assert.deepEqual(result, { status: 'observed', exitCode: 7 });
    }
    return snapshot;
  };
  return { before, get raced() { return raced; }, restore() { f.store.list = original; } };
}

function missingDependency(f: ReturnType<typeof fixture>, dependency: 'reader-pilot' | 'execution-root') {
  const id = `${dependency}:${f.project}`;
  let head = '';
  if (dependency === 'execution-root') {
    writeFileSync(join(f.root, '.gitignore'), 'state.sqlite*\nworktrees/\ninvocations.log*\n');
    git(f.root, ['init', '-q']); git(f.root, ['config', 'user.name', 'Runtime fixture']);
    git(f.root, ['config', 'user.email', 'runtime@fixture.invalid']);
    git(f.root, ['add', 'README.md', '.gitignore', 'condition.txt']); git(f.root, ['commit', '-qm', 'Declared runtime workspace']);
    head = git(f.root, ['rev-parse', 'HEAD']);
  }
  return { id, create(active = true) {
    const second = new Store(f.database), engine = new ProductEngine(second);
    try {
      if (dependency === 'reader-pilot') {
        const command = { executable: process.execPath, args: ['--version'] };
        configureReaderPilot(second, engine.environments, f.project, { experimental: true, active, stopAfter: 'L2',
          reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
          maxRequestChars: 300000, maxReadChars: 60000, maxReplyChars: 100000, maxCalls: 100,
          maxReportedTokens: 20000000, callTimeoutMs: 1000 }, 0);
      } else ensureWorktree(second, engine.environments, { projectId: f.project,
        base: { root: f.root, head, tree: git(f.root, ['rev-parse', 'HEAD^{tree}']), files: [] } } as unknown as MachinePlan);
      assert.ok(second.get(id));
    } finally { second.close(); }
  } };
}

test('D8 negative guards survive all three task-admission windows for native pilot and execution-root creators', async t => {
  for (const dependency of ['reader-pilot', 'execution-root'] as const) for (const window of ['scan', 'pinned', 'prepared'] as const) {
    const f = fixture(t), creator = missingDependency(f, dependency), { task, run } = taskFixture(f);
    const observed = await f.observe(), admitted = taskStartProofs(f.store, run, task);
    run.obligationStartProofs = admitted.proofs;
    const savedProof = admitted.proofs[0]!.confirmation;
    const storedBytes = canonical([observed.observation, observed.source, f.store.get(run.plan.id)]);
    assert.ok(admitted.guards.some(guard => same(guard, { id: creator.id, absent: true })));
    let raced = false;
    const original = f.store.list.bind(f.store);
    if (window !== 'prepared') f.store.list = <T = Json>(kind?: string): Revision<T>[] => {
      const records = original<T>(kind);
      if (!raced && kind === 'runtime-observation') { raced = true; creator.create(); }
      return records;
    };
    const writes = [{ id: 'absence-admission', kind: 'test-admission', expected: 0, value: admitted.proofs },
      { id: 'absence-companion', kind: 'test-admission', expected: 0, value: { accepted: true } }];
    try {
      if (window === 'pinned') assert.throws(() => requireCurrentTaskStart(f.store, run, task), { code: 'task_obligation_start_stale' });
      else if (window === 'prepared') {
        creator.create(); raced = true;
        assert.throws(() => f.store.writeMany(writes, admitted.guards), { code: 'input_stale' });
      } else {
        let prepared: ReturnType<typeof taskStartProofs> | undefined;
        try { prepared = taskStartProofs(f.store, run, task); }
        catch (error) { assert.ok(error instanceof EngineError); assert.equal(error.code, 'task_obligation_start_required'); }
        if (prepared) assert.throws(() => f.store.writeMany(writes, prepared.guards), { code: 'input_stale' });
      }
    } finally { f.store.list = original; }
    assert.equal(raced, true, `${dependency}/${window}`);
    for (const write of writes) { assert.equal(f.store.get(write.id), null); assert.deepEqual(f.store.history(write.id), []); }
    assert.equal(findObligationConfirmation(f.store, f.project, f.obligations[0]!), null);
    assert.equal(frozenObligationConfirmation(f.store, f.project, f.obligations[0]!, savedProof), true);
    f.reopen(); assert.deepEqual(await f.observe(), observed);
    assert.equal(frozenObligationConfirmation(f.store, f.project, f.obligations[0]!, savedProof), true);
    assert.equal(canonical([f.store.get(observed.observation.id), f.store.get(observed.source!.id), f.store.get(run.plan.id)]), storedBytes);
    assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n');
  }
});

test('D8 observation admission and completion atomically guard both absent runtime dependencies', async t => {
  for (const dependency of ['reader-pilot', 'execution-root'] as const) for (const window of ['admission', 'completion'] as const) {
    const f = fixture(t), creator = missingDependency(f, dependency), write = f.store.writeMany.bind(f.store);
    let raced = false;
    f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
      if (!raced && writes.some(item => item.kind === 'runtime-observation'
        && (window === 'admission' ? item.expected === 0 : (item.value as RuntimeObservation).status === 'observed'))) {
        raced = true; assert.ok(guards.some(guard => same(guard, { id: creator.id, absent: true })));
        creator.create();
      }
      return write(writes, guards);
    }) as typeof f.store.writeMany;
    if (window === 'admission') {
      await assert.rejects(f.observe(), { code: 'input_stale' });
      assert.deepEqual(f.store.list('runtime-observation'), []); assert.deepEqual(f.store.list('project-dispatch'), []);
      assert.equal(existsSync(f.marker), false);
    } else {
      const result = await f.observe();
      assert.equal(result.observation.value.status, 'stale'); assert.ok(result.observation.value.result); assert.equal(result.source, null);
      assert.deepEqual(f.store.list<Source>('source').filter(item => item.value.provenance?.kind === 'runtime-observation'), []);
      f.reopen(); assert.deepEqual(await f.observe(), result); assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n');
    }
    assert.equal(raced, true, `${dependency}/${window}`);
  }
});

test('D8 common transaction guards preserve contradictions and validate absence in current predicates', t => {
  const f = fixture(t), ref = reference(f.environment), absent = { id: 'reader-pilot:garden', absent: true as const };
  assert.deepEqual(uniqueTransactionGuards([ref, reference(f.graph), ref]), uniqueRefs([ref, reference(f.graph), ref]));
  assert.deepEqual(uniqueTransactionGuards([absent, absent]), [absent]);
  assert.equal(transactionGuardsCurrent(f.store, [ref, absent]), true);
  for (const store of [undefined, null, {}, { get: false }]) {
    assert.throws(() => transactionGuardsCurrent(store as never, []), { code: 'invalid_guard' });
    assert.throws(() => transactionGuardsCurrent(store as never, [ref]), { code: 'invalid_guard' });
  }
  const conflict = [{ id: ref.id, absent: true as const }, ref];
  for (const values of [conflict, [...conflict].reverse()]) {
    assert.equal(uniqueTransactionGuards(values).length, 2);
    assert.equal(transactionGuardsCurrent(f.store, values), false);
    assert.throws(() => f.store.writeMany([], uniqueTransactionGuards(values)), { code: 'input_stale' });
  }
  const get = f.store.get.bind(f.store);
  f.store.get = () => { throw new Error('Malformed guards must be rejected before any read'); };
  try {
    for (const values of [null, {}, new Array(1), [undefined], [{ id: ref.id, absent: true, revision: undefined }],
      [{ ...ref, absent: false }], [{ ...ref, hash: 'wrong' }]]) {
      assert.throws(() => uniqueTransactionGuards(values as never), { code: 'invalid_guard' });
      assert.throws(() => transactionGuardsCurrent(f.store, values as never), { code: 'invalid_guard' });
    }
  } finally { f.store.get = get; }
});

test('D8 completion retains original absence when an inactive pilot appears during the check', async t => {
  const f = fixture(t, { mode: 'wait' }), creator = missingDependency(f, 'reader-pilot'), before = runtimeContext(f.store, f.project);
  const pending = f.observe();
  await until(() => Boolean(f.store.list<RuntimeObservation>('runtime-observation')[0]?.value.child));
  try {
    creator.create(false);
    assert.deepEqual(runtimeContext(f.store, f.project).binding, before.binding);
  } finally { writeFileSync(f.marker + '.release', 'release'); }
  const result = await pending;
  assert.equal(result.observation.value.status, 'stale'); assert.ok(result.observation.value.result);
  assert.equal(result.source, null); assert.match(result.observation.value.error!, /input_stale/);
  f.reopen(); assert.deepEqual(await f.observe(), result); assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n');
});

test('D8 public OM observation executes the declared module once, retains its exact authority and survives restart', async t => {
  const f = fixture(t), obligation = f.obligations[0]!, before = f.store.list('model-call').length;
  assert.equal(findObligationConfirmation(f.store, f.project, obligation), null);
  const result = await f.observe(); assert.equal(result.observation.value.status, 'observed'); assert.ok(result.source);
  assert.equal(result.observation.value.result!.exitCode, 0);
  assert.deepEqual(result.observation.value.scope, reference(f.ledger.record));
  assert.equal(result.observation.value.requestedFor, selector(obligation));
  assert.deepEqual(result.source.value.provenance, { kind: 'runtime-observation', record: reference(result.observation) });
  assert.equal(digest(result.source.value.content), result.source.value.sha256);
  assert.ok(runtimeSupport(f.store, f.project, obligation, reference(result.source)));
  const proof = findObligationConfirmation(f.store, f.project, obligation); assert.ok(proof);
  for (const ref of [reference(f.ledger.producer), reference(f.ledger.record), reference(f.script), reference(result.observation), reference(result.source)])
    assert.ok(proof.guards.some(guard => same(guard, ref)), `The consumer must guard ${ref.id}`);
  assert.deepEqual(readinessObligations(f.store, f.project, clone(f.ledger.inputs) as Ref[]).findings, []);
  f.reopen(); assert.deepEqual(await f.observe(), result);
  assert.deepEqual(findObligationConfirmation(f.store, f.project, obligation)!.proof, proof.proof);
  assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n'); assert.equal(f.store.list('model-call').length, before);
});

test('D8 task admission consumes real OM confirmation and freezes it across later environment changes', async t => {
  const f = fixture(t), { task, run } = taskFixture(f), obligation = f.obligations[0]!;
  assert.throws(() => taskStartProofs(f.store, run, task), { code: 'task_obligation_start_required' });
  await f.observe(); run.obligationStartProofs = taskStartProofs(f.store, run, task).proofs;
  run.obligationResultProofs = taskResultProofs(f.store, run, task).proofs;
  requireCurrentTaskStart(f.store, run, task); requireTaskObligationProofs(f.store, run, task);
  assert.equal(run.obligationStartProofs.length, 1); assert.deepEqual(run.obligationResultProofs, []);
  const proof = run.obligationStartProofs[0]!.confirmation;
  writeFileSync(f.condition, 'changed after task admission');
  assert.equal(findObligationConfirmation(f.store, f.project, obligation), null);
  assert.throws(() => requireCurrentTaskStart(f.store, run, task), { code: 'task_obligation_start_stale' });
  assert.equal(frozenObligationConfirmation(f.store, f.project, obligation, proof), true);
  requireTaskObligationProofs(f.store, run, task); f.reopen(); requireTaskObligationProofs(f.store, run, task);
  for (const mutate of [(value: TaskRun) => { value.obligationStartProofs = []; },
    (value: TaskRun) => { value.obligationStartProofs![0]!.subject = 'another-attempt'; },
    (value: TaskRun) => { value.obligationStartProofs![0]!.confirmation.source.hash = '0'.repeat(64); }]) {
    const changed = clone(run); mutate(changed); assert.throws(() => requireTaskObligationProofs(f.store, changed, task), typed);
  }
});

test('D8 distinct obligations and consumer assignments cannot borrow another observation or contrary result', async t => {
  for (const options of [{ count: 2 }, { multipleConsumers: true }, { multipleConsumers: true, sameCheck: true }]) {
    const f = fixture(t, options), [first, second] = f.obligations; assert.ok(first && second);
    assert.notEqual(selector(first), selector(second));
    await assert.rejects(f.engine.execute({ type: 'observe-runtime', project: f.project, scope: reference(f.ledger.record),
      obligation: first.obligation, key: 'bare-gap' }) as Promise<unknown>, { code: 'runtime_check_not_declared' });
    const observed = await f.observe(first); assert.ok(observed.source);
    assert.ok(findObligationConfirmation(f.store, f.project, first));
    assert.equal(findObligationConfirmation(f.store, f.project, second), null);
    assert.equal(runtimeSupport(f.store, f.project, second, reference(observed.source)), null);
    await f.observe(second);
    assert.ok(findObligationConfirmation(f.store, f.project, first)); assert.ok(findObligationConfirmation(f.store, f.project, second));
    const firstProof = findObligationConfirmation(f.store, f.project, first)!.proof;
    assert.equal(findObligationConfirmation(f.store, f.project, second, firstProof), null);
    assert.equal(frozenObligationConfirmation(f.store, f.project, second, firstProof), false);
    f.reopen();
    assert.ok(findObligationConfirmation(f.store, f.project, first)); assert.ok(findObligationConfirmation(f.store, f.project, second));
    writeFileSync(f.marker + '.fail', 'A controlled contrary runtime result');
    const failed = await f.observe(first, 'first-now-fails'); assert.equal(failed.observation.value.result!.exitCode, 7);
    assert.equal(findObligationConfirmation(f.store, f.project, first), null);
    assert.ok(findObligationConfirmation(f.store, f.project, second), 'Contrary evidence belongs only to its exact consumer assignment');
    assert.equal(readFileSync(f.marker, 'utf8'), 'executed\nexecuted\nexecuted\n');
  }
});

test('D8 complete task proof sets reject a lost, duplicated or substituted assignment confirmation', async t => {
  const f = fixture(t, { count: 2 }), { task, run } = taskFixture(f);
  for (const obligation of f.obligations) await f.observe(obligation);
  run.obligationStartProofs = taskStartProofs(f.store, run, task).proofs;
  run.obligationResultProofs = taskResultProofs(f.store, run, task).proofs;
  assert.equal(run.obligationStartProofs.length, 2); requireTaskObligationProofs(f.store, run, task);
  for (const mutate of [(value: TaskRun) => { value.obligationStartProofs!.pop(); },
    (value: TaskRun) => { value.obligationStartProofs![1] = clone(value.obligationStartProofs![0]!); },
    (value: TaskRun) => { value.obligationStartProofs![1]!.confirmation = clone(value.obligationStartProofs![0]!.confirmation); }]) {
    const changed = clone(run); mutate(changed);
    assert.throws(() => requireTaskObligationProofs(f.store, changed, task), typed);
  }
  f.reopen(); requireTaskObligationProofs(f.store, run, task);
});

test('D8 missing, foreign and forged declarations fail before any runtime dispatch', async t => {
  const f = fixture(t, { declared: false });
  await assert.rejects(f.observe(), { code: 'runtime_check_not_declared' });
  const command = { type: 'observe-runtime', project: f.project, scope: reference(f.ledger.record), obligation: selector(f.obligations[0]!), key: 'missing' };
  for (const field of ['scope', 'obligation', 'key']) {
    const changed = { ...command } as Record<string, unknown>; delete changed[field];
    assert.throws(() => f.engine.execute(changed), { code: 'command_invalid' });
  }
  for (const scope of [{ ...command.scope, hash: '0'.repeat(64) }, { ...command.scope, id: command.scope.id.replace(':garden:', ':other:') },
    { id: 'om-obligations:garden:missing', revision: 1, hash: '0'.repeat(64) }])
    await assert.rejects(f.engine.execute({ ...command, scope }) as Promise<unknown>, { code: 'runtime_check_not_declared' });
  assert.equal(f.store.list('runtime-observation').length, 0);
  assert.equal(f.store.list('project-dispatch').length, 0);
});

test('D8 a self-consistent ledger and producer forgery cannot authorize an undeclared check', async t => {
  const f = fixture(t), value = clone(f.ledger.record.value) as OmObligationRecord;
  value.assignments[0]!.runtimeCheck!.args = ['forged-command-argument'];
  const ledger = f.store.write({ id: `om-obligations:${f.project}:${hashJson(value)}`, kind: f.ledger.record.kind, expected: 0, value });
  const producerValue = { ...clone(f.ledger.producer.value), ledger: reference(ledger) };
  f.store.write({ id: `om-obligation-basis:${f.project}:${hashJson(producerValue)}`, kind: f.ledger.producer.kind, expected: 0, value: producerValue });
  const obligation = { ...clone(f.obligations[0]!), scope: reference(ledger) };
  await assert.rejects(f.engine.execute({ type: 'observe-runtime', project: f.project, scope: reference(ledger),
    obligation: selector(obligation), key: 'forged-declaration' }) as Promise<unknown>, { code: 'runtime_check_not_declared' });
  assert.equal(f.store.list('runtime-observation').length, 0);
});

test('D8 copied or self-consistently edited runtime sources do not prove an execution', async t => {
  const f = fixture(t), obligation = f.obligations[0]!, observed = await f.observe(); assert.ok(observed.source);
  const copied = f.engine.discovery.evidence.document(f.project, 'copied-observation', observed.source.value.content, 'application/json', 0);
  assert.equal(runtimeSupport(f.store, f.project, obligation, reference(copied)), null);
  const content = JSON.stringify({ ...JSON.parse(observed.source.value.content), result: { exitCode: 0, stdout: 'invented', stderr: '', signal: null } });
  const changed = f.store.write<Source>({ id: observed.source.id, kind: 'source', expected: observed.source.revision,
    value: { ...observed.source.value, content, sha256: digest(content) } });
  assert.equal(runtimeSupport(f.store, f.project, obligation, reference(changed)), null);
  assert.equal(findObligationConfirmation(f.store, f.project, obligation), null);
  await assert.rejects(f.observe(), { code: 'runtime_observation_source_changed' });
  assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n');
});

test('D8 changing check, executable, subjects, environment or status cannot masquerade as genuine support', async t => {
  const f = fixture(t), obligation = f.obligations[0]!, observed = await f.observe(); assert.ok(observed.source);
  const variants: Array<(value: RuntimeObservation) => void> = [
    value => { value.check = { ...value.check, purpose: 'Another check' }; },
    value => { value.executable.path = join(f.root, 'absent-runtime'); },
    value => { value.executable.identity.ino++; },
    value => { value.subjects = []; },
    value => { value.subjects[0]!.identity.size++; },
    value => { value.runtimeBinding = { forged: true }; },
    value => { value.status = 'running'; },
    value => { value.result!.signal = 'SIGTERM'; },
    value => { value.scope.hash = '0'.repeat(64); },
  ];
  for (const mutate of variants) {
    const value = clone(observed.observation.value); mutate(value);
    const record = f.store.write<RuntimeObservation>({ id: observed.observation.id, kind: 'runtime-observation', expected: f.store.get(observed.observation.id)!.revision, value });
    const rendered = runtimeSource(record), source = f.store.write<Source>({ id: rendered.id, kind: 'source', expected: 0, value: rendered.value });
    assert.equal(runtimeSupport(f.store, f.project, obligation, reference(source)), null);
  }
  const { scope: _scope, wake: _wake, ...legacyAssignment } = clone(obligation);
  legacyAssignment.obligation = selector(obligation);
  const legacy = f.store.write({ id: `research-scope:${f.project}:R2`, kind: 'research-scope', expected: 0,
    value: { projectId: f.project, obligations: [{ gap: { id: selector(obligation) } }],
      policy: { version: 1, sourceScope: reference(f.ledger.record), assignments: [legacyAssignment] } } });
  const record = f.store.write<RuntimeObservation>({ id: observed.observation.id, kind: 'runtime-observation',
    expected: f.store.get(observed.observation.id)!.revision, value: { ...observed.observation.value, scope: reference(legacy) } });
  const rendered = runtimeSource(record), source = f.store.write<Source>({ id: rendered.id, kind: 'source', expected: 0, value: rendered.value });
  assert.equal(runtimeSupport(f.store, f.project, obligation, reference(source)), null,
    'An imitation legacy authorization with the same check and selector cannot authorize an OM obligation');
  assert.equal(findObligationConfirmation(f.store, f.project, obligation), null);
});

test('D8 the owner return condition, consumer and moment remain part of the exact confirmation contract', async t => {
  const f = fixture(t), obligation = f.obligations[0]!, observed = await f.observe(); assert.ok(observed.source);
  const proof = findObligationConfirmation(f.store, f.project, obligation)!.proof;
  for (const mutate of [(value: CarriedObligation) => { value.returnCondition = 'A different condition'; },
    (value: CarriedObligation) => { value.runtimeCheck!.satisfies = 'A different condition'; },
    (value: CarriedObligation) => { delete value.runtimeCheck!.satisfies; },
    (value: CarriedObligation) => { value.responsibleConsumer = 'garden-consume-block'; },
    (value: CarriedObligation) => { value.moment = 'R3'; },
    (value: CarriedObligation) => { value.moment = 'task-result'; }]) {
    const changed = clone(obligation); mutate(changed);
    assert.equal(findObligationConfirmation(f.store, f.project, changed), null);
    assert.equal(frozenObligationConfirmation(f.store, f.project, changed, proof), false);
  }
  const { task, run } = taskFixture(f);
  task.researchObligations![0]!.requirement.moment = 'task-result';
  assert.throws(() => taskResultProofs(f.store, run, task), { code: 'task_obligation_result_required' },
    'A start declaration cannot be relabeled into a result declaration');
});

test('D8 actual checker, subject and environment changes invalidate current support while preserving frozen admission', async t => {
  for (const change of ['checker', 'subject', 'environment'] as const) {
    const f = fixture(t), obligation = f.obligations[0]!, observed = await f.observe(); assert.ok(observed.source);
    const proof = findObligationConfirmation(f.store, f.project, obligation)!.proof;
    if (change === 'checker') {
      const content = f.script.value.content + '\n// revised checker\n';
      f.store.write({ id: f.script.id, kind: f.script.kind, expected: f.script.revision, value: { ...f.script.value, content, sha256: digest(content) } });
    } else if (change === 'subject') writeFileSync(f.condition, 'same-path replacement');
    else {
      const { projectId: _projectId, ...settings } = f.environment.value;
      f.engine.environments.configure(f.project, { ...settings, implementer: { ...settings.implementer, model: 'another-runtime' } }, f.environment.revision);
    }
    assert.equal(runtimeSupport(f.store, f.project, obligation, reference(observed.source)), null, change);
    assert.equal(findObligationConfirmation(f.store, f.project, obligation), null, change);
    assert.equal(frozenObligationConfirmation(f.store, f.project, obligation, proof), true, change);
    f.reopen(); assert.equal(frozenObligationConfirmation(f.store, f.project, obligation, proof), true, change);
    assert.deepEqual(await f.observe(), observed, 'An exact historical replay must not dispatch again');
    assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n');
  }
});

test('D8 later failed and interrupted attempts cannot resurrect an earlier successful confirmation', async t => {
  const f = fixture(t), obligation = f.obligations[0]!; await f.observe();
  writeFileSync(f.condition, 'failed');
  const failed = await f.observe(obligation, 'failed-attempt');
  assert.equal(failed.observation.value.status, 'observed'); assert.equal(failed.observation.value.result!.exitCode, 7);
  assert.ok(failed.source); assert.equal(findObligationConfirmation(f.store, f.project, obligation), null);
  writeFileSync(f.condition, 'ready');
  const good = await f.observe(obligation, 'new-success'); assert.ok(findObligationConfirmation(f.store, f.project, obligation));
  const pending = f.store.write<RuntimeObservation>({ id: 'runtime-observation:interrupted-om-fixture', kind: 'runtime-observation', expected: 0,
    value: { ...good.observation.value, key: 'interrupted', startedAt: good.observation.value.startedAt + 1, status: 'running', result: null,
      owner: { pid: 2147483647, started: 'ended-fixture-owner' }, child: null } });
  assert.equal(findObligationConfirmation(f.store, f.project, obligation), null);
  const recovered = f.engine.execute({ type: 'recover-runtime-observation', project: f.project, observation: reference(pending) }) as Revision<RuntimeObservation>;
  assert.equal(recovered.value.status, 'failed'); assert.equal(findObligationConfirmation(f.store, f.project, obligation), null);
  assert.equal(readFileSync(f.marker, 'utf8'), 'executed\nexecuted\nexecuted\n');
});

test('D8 observation timeout is durable and replay after restart never repeats the external action', async t => {
  const f = fixture(t, { mode: 'timeout' }), failed = await f.observe();
  assert.equal(failed.observation.value.status, 'failed'); assert.match(failed.observation.value.error!, /process_timeout/);
  const before = existsSync(f.marker) ? readFileSync(f.marker, 'utf8') : '';
  assert.ok(failed.observation.value.invocation);
  assert.equal(failed.source, null); f.reopen(); assert.deepEqual(await f.observe(), failed);
  assert.equal(findObligationConfirmation(f.store, f.project, f.obligations[0]!), null);
  assert.equal(existsSync(f.marker) ? readFileSync(f.marker, 'utf8') : '', before);
  assert.equal(f.store.get<{ serial: number }>(`project-dispatch:${hashJson(f.project)}`)!.value.serial, 1);
});

test('D8 losing the real observer after every persisted boundary recovers without another external action', async t => {
  for (const boundary of ['admitted', 'snapshot', 'child', 'observed']) {
    const f = fixture(t), request = { type: 'observe-runtime', project: f.project, scope: reference(f.ledger.record),
      obligation: selector(f.obligations[0]!), key: 'crash-boundary' };
    const script = `import{Store}from${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import{ProductEngine}from${JSON.stringify(new URL('../src/product/engine.js', import.meta.url).href)};
const store=new Store(${JSON.stringify(f.database)}),write=store.writeMany.bind(store),boundary=${JSON.stringify(boundary)};
store.writeMany=(writes,guards=[])=>{const saved=write(writes,guards),record=saved.find(item=>item.kind==='runtime-observation');
if(record){const value=record.value;const selected=boundary==='admitted'?value.status==='running'&&value.snapshot===null:
boundary==='snapshot'?value.status==='running'&&value.snapshot!==null&&value.child===null:
boundary==='child'?value.status==='running'&&value.child!==null:value.status==='observed';if(selected)process.exit(77);}return saved;};
await new ProductEngine(store).execute(${JSON.stringify(request)});throw Error('The observer missed its persisted boundary');`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 77, `${boundary}: ${child.stderr}`);
    f.reopen(); const persisted = f.store.list<RuntimeObservation>('runtime-observation')[0]!;
    assert.ok(persisted); if (persisted.value.snapshot) t.after(() => rmSync(persisted.value.snapshot!, { recursive: true, force: true }));
    const before = existsSync(f.marker) ? readFileSync(f.marker, 'utf8') : '';
    const recovered = f.engine.execute({ type: 'recover-runtime-observation', project: f.project, observation: reference(persisted) }) as Revision<RuntimeObservation>;
    if (boundary === 'observed') {
      assert.deepEqual(recovered, persisted); assert.equal(recovered.value.result!.exitCode, 0);
      assert.ok(f.store.list<Source>('source').find(source => source.value.provenance?.record.id === recovered.id));
    } else { assert.equal(recovered.value.status, 'failed'); assert.equal(recovered.value.child, null); }
    const replay = await f.engine.execute(request) as RuntimeObservationResult;
    assert.deepEqual(replay.observation, recovered);
    assert.equal(existsSync(f.marker) ? readFileSync(f.marker, 'utf8') : '', before);
    assert.equal(f.store.get<{ serial: number }>(`project-dispatch:${hashJson(f.project)}`)!.value.serial, 1);
    const retry = await f.observe(f.obligations[0]!, 'explicit-new-key'); assert.equal(retry.observation.value.status, 'observed');
    assert.equal(readFileSync(f.marker, 'utf8'), before + 'executed\n');
    assert.equal(f.store.get<{ serial: number }>(`project-dispatch:${hashJson(f.project)}`)!.value.serial, 2);
  }
});

test('D8 changing every consumer guard through a second Store prevents partial acceptance and leaves frozen history readable', async t => {
  const f = fixture(t), obligation = f.obligations[0]!; await f.observe();
  const admitted = findObligationConfirmation(f.store, f.project, obligation); assert.ok(admitted);
  const snapshot = await f.store.snapshot(join(f.root, 'guard-snapshot'));
  for (const [index, guard] of admitted.guards.entries()) {
    const branchPath = join(f.root, `guard-${index}.sqlite`);
    copyFileSync(snapshot.path, branchPath);
    const first = new Store(branchPath), second = new Store(branchPath);
    try {
      const before = first.list().length, head = second.get(guard.id)!;
      second.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
      assert.throws(() => first.writeMany([{ id: 'admission:a', kind: 'test-admission', expected: 0, value: admitted.proof },
        { id: 'admission:b', kind: 'test-admission', expected: 0, value: admitted.proof }], admitted.guards), { code: 'input_stale' });
      assert.equal(first.list().length, before); assert.equal(first.get('admission:a'), null); assert.equal(first.get('admission:b'), null);
      assert.equal(frozenObligationConfirmation(first, f.project, obligation, admitted.proof), true, `Historical admission survives ${guard.id}`);
    } finally { first.close(); second.close(); }
  }
});

test('D8 declaration, checker and environment races reject the complete observation admission transaction', async t => {
  for (const target of ['producer', 'ledger', 'checker', 'environment'] as const) {
    const f = fixture(t), original = f.store.writeMany.bind(f.store), second = new Store(f.database); let changed = false;
    const id = { producer: f.ledger.producer.id, ledger: f.ledger.record.id, checker: f.script.id, environment: f.environment.id }[target];
    f.store.writeMany = ((writes: Write[], guards: Ref[] = []) => {
      if (!changed && writes.some(write => write.kind === 'runtime-observation' && write.expected === 0)) {
        changed = true; assert.ok(guards.some(guard => guard.id === id), `Observation admission must guard ${target}`);
        const head = second.get(id)!; second.write({ id, kind: head.kind, expected: head.revision, value: head.value });
      }
      return original(writes, guards);
    }) as typeof f.store.writeMany;
    try {
      await assert.rejects(f.observe(), typed); assert.equal(changed, true);
      assert.equal(f.store.list('runtime-observation').length, 0); assert.equal(f.store.list('project-dispatch').length, 0);
      assert.equal(ok(readOmObligationLedger(f.store, { project: f.project, ledger: reference(f.ledger.record) })).handoff.obligations.length, 1);
    } finally { second.close(); }
  }
});

test('D8 a genuine failed observation after either list snapshot cannot commit stale task admission', async t => {
  for (const snapshotKind of ['source', 'runtime-observation'] as const) {
    const f = fixture(t), { task, run } = taskFixture(f), initial = await f.observe();
    assert.equal(initial.observation.value.result!.exitCode, 0);
    const race = raceCompletedObservation(f, snapshotKind);
    let admission: ReturnType<typeof taskStartProofs> | undefined;
    try {
      try { admission = taskStartProofs(f.store, run, task); }
      catch (error) { assert.ok(error instanceof EngineError); assert.equal(error.code, 'task_obligation_start_required'); }
    } finally { race.restore(); }
    assert.equal(race.raced, true);
    assert.equal(f.store.get(race.before.id)!.revision, race.before.revision + 1);
    if (admission) {
      const accepted = admission;
      assert.deepEqual(accepted.guards.find(guard => guard.id === race.before.id), race.before);
      assert.throws(() => f.store.writeMany([
        { id: 'raced-task-admission', kind: 'test-admission', expected: 0, value: accepted.proofs },
        { id: 'raced-task-companion', kind: 'test-admission', expected: 0, value: { admitted: true } },
      ], accepted.guards), { code: 'input_stale' });
    }
    assert.equal(f.store.get('raced-task-admission'), null); assert.equal(f.store.get('raced-task-companion'), null);
    assert.equal(findObligationConfirmation(f.store, f.project, f.obligations[0]!), null);
    assert.equal(readFileSync(f.marker, 'utf8'), 'executed\nexecuted\n');
  }
});

test('D8 a genuine failed observation during pinned task-start validation pauses before dispatch', async t => {
  const f = fixture(t), { task, run } = taskFixture(f); await f.observe();
  run.obligationStartProofs = taskStartProofs(f.store, run, task).proofs;
  const race = raceCompletedObservation(f, 'runtime-observation');
  try { assert.throws(() => requireCurrentTaskStart(f.store, run, task), { code: 'task_obligation_start_stale' }); }
  finally { race.restore(); }
  assert.equal(race.raced, true);
  assert.equal(f.store.get(race.before.id)!.revision, race.before.revision + 1);
  assert.equal(findObligationConfirmation(f.store, f.project, f.obligations[0]!, run.obligationStartProofs[0]!.confirmation), null);
  assert.equal(readFileSync(f.marker, 'utf8'), 'executed\nexecuted\n');
});

test('D8 an environment change inside the final observation scan invalidates pinned task-start admission', async t => {
  const f = fixture(t), { task, run } = taskFixture(f); await f.observe();
  run.obligationStartProofs = taskStartProofs(f.store, run, task).proofs;
  const original = f.store.list.bind(f.store), second = new Store(f.database), engine = new ProductEngine(second);
  const { projectId: _projectId, ...settings } = f.environment.value; let raced = false;
  f.store.list = <T = Json>(kind?: string): Revision<T>[] => {
    const snapshot = original<T>(kind);
    if (!raced && kind === 'runtime-observation') {
      raced = true;
      engine.environments.configure(f.project, { ...settings, implementer: { ...settings.implementer, model: 'concurrent-runtime' } }, f.environment.revision);
    }
    return snapshot;
  };
  try { assert.throws(() => requireCurrentTaskStart(f.store, run, task), { code: 'task_obligation_start_stale' }); }
  finally { f.store.list = original; second.close(); }
  assert.equal(raced, true);
  assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n');
  assert.equal(f.store.get<{ serial: number }>(`project-dispatch:${hashJson(f.project)}`)!.value.serial, 1);
});

test('D8 a concurrent pilot change cannot bind an earlier configuration to the new head guard', async t => {
  for (const change of ['timeout', 'active', 'created'] as const) for (const consumer of ['context', 'confirmation'] as const) {
    const f = fixture(t), command = { executable: process.execPath, args: ['--version'] };
    const settings: ReaderPilotSettings = { experimental: true, active: true, stopAfter: 'L2',
      reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
      maxRequestChars: 300000, maxReadChars: 60000, maxReplyChars: 100000, maxCalls: 100, maxReportedTokens: 20000000, callTimeoutMs: 1000 };
    const initial = change === 'created' ? null : configureReaderPilot(f.store, f.engine.environments, f.project, settings, 0);
    const observed = await f.observe(); assert.equal(observed.observation.value.result!.exitCode, 0);
    const original = f.store.get.bind(f.store), second = new Store(f.database), engine = new ProductEngine(second);
    const pilotId = `reader-pilot:${f.project}`, next = { ...settings, ...(change === 'timeout' ? { callTimeoutMs: 2000 } : {}),
      ...(change === 'active' ? { active: false } : {}) }; let raced = false;
    f.store.get = <T = Json>(id: string, revision?: number): Revision<T> | null => {
      const snapshot = original<T>(id, revision);
      if (!raced && id === pilotId && revision === undefined) {
        raced = true; configureReaderPilot(second, engine.environments, f.project, next, initial?.revision ?? 0);
      }
      return snapshot;
    };
    try {
      if (consumer === 'context') assert.throws(() => runtimeContext(f.store, f.project), { code: 'runtime_observation_stale' });
      else assert.equal(findObligationConfirmation(f.store, f.project, f.obligations[0]!), null);
    } finally { f.store.get = original; second.close(); }
    assert.equal(raced, true, `${consumer}/${change}`);
    assert.deepEqual(f.store.get(pilotId)!.value, { ...next, projectId: f.project });
    assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n');
  }
});

test('D8 declaration changes during a running check retain output without publishing a current source', async t => {
  const f = fixture(t, { mode: 'wait' }), pending = f.observe();
  await until(() => Boolean(f.store.list<RuntimeObservation>('runtime-observation')[0]?.value.child));
  const second = new Store(f.database);
  try {
    const head = second.get(f.ledger.producer.id)!; second.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
  } finally { second.close(); writeFileSync(f.marker + '.release', 'release'); }
  const result = await pending;
  assert.equal(result.observation.value.status, 'stale'); assert.equal(result.source, null); assert.ok(result.observation.value.result);
  assert.equal(findObligationConfirmation(f.store, f.project, f.obligations[0]!), null);
  assert.deepEqual(ok(readOmObligationLedger(f.store, { project: f.project, ledger: reference(f.ledger.record) })).handoff, f.ledger.handoff);
  f.reopen(); assert.deepEqual(await f.observe(), result); assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n');
});

test('D8 a changed producer or ledger head refuses new observation admission without invalidating historical authority', async t => {
  for (const target of ['producer', 'record'] as const) {
    const f = fixture(t), observed = await f.observe(), obligation = f.obligations[0]!;
    const proof = findObligationConfirmation(f.store, f.project, obligation)!.proof;
    const head = f.ledger[target]; f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
    await assert.rejects(f.observe(obligation, 'new-after-head-move'), { code: 'runtime_observation_scope_stale' });
    assert.equal(findObligationConfirmation(f.store, f.project, obligation), null);
    f.reopen(); assert.deepEqual(await f.observe(), observed);
    assert.equal(frozenObligationConfirmation(f.store, f.project, obligation, proof), true);
    assert.deepEqual(ok(readOmObligationLedger(f.store, { project: f.project, ledger: reference(f.ledger.record) })).handoff, f.ledger.handoff);
    assert.equal(readFileSync(f.marker, 'utf8'), 'executed\n');
  }
});

test('D8 preserves exact observations and confirmation bytes produced by the complete ee3fd4c legacy engine', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-runtime-legacy-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url)), repositoryUrl = pathToFileURL(repository).href;
  const loader = join(root, 'legacy-loader.mjs'), producer = join(root, 'legacy-producer.mjs');
  writeFileSync(loader, LEGACY_LOADER); writeFileSync(producer, LEGACY_PRODUCER);
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const bootstrap = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},
{data:{root:${JSON.stringify(repositoryUrl)},typescript:${JSON.stringify(typescript)}}});`;
  const output = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, root],
    { cwd: repository, encoding: 'utf8', timeout: 30_000, maxBuffer: 10_000_000 });
  const legacy = JSON.parse(output) as { database: string; project: string; marker: string; request: unknown; obligation: CarriedObligation;
    observed: RuntimeObservationResult; confirmation: NonNullable<ReturnType<typeof findObligationConfirmation>>;
    support: NonNullable<ReturnType<typeof runtimeSupport>>; historyBytes: string };
  assert.ok(legacy.observed.source);
  for (let restart = 0; restart < 2; restart++) {
    const store = new Store(legacy.database);
    try {
      const support = runtimeSupport(store, legacy.project, legacy.obligation, reference(legacy.observed.source));
      const confirmation = findObligationConfirmation(store, legacy.project, legacy.obligation);
      assert.ok(support && confirmation);
      const { admissionGuards: supportAdmission, ...oldSupport } = support;
      const { admissionGuards: confirmationAdmission, ...oldConfirmation } = confirmation;
      const expected = [{ id: 'execution-root:legacy', absent: true }, { id: 'reader-pilot:legacy', absent: true }];
      assert.deepEqual(oldSupport, legacy.support); assert.deepEqual(oldConfirmation, legacy.confirmation);
      assert.deepEqual(supportAdmission, expected); assert.deepEqual(confirmationAdmission, expected);
      assert.equal(frozenObligationConfirmation(store, legacy.project, legacy.obligation, legacy.confirmation.proof), true);
      assert.deepEqual(await new ProductEngine(store).execute(legacy.request), legacy.observed);
      assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), legacy.historyBytes);
      assert.equal(readFileSync(legacy.marker, 'utf8'), 'executed\n');
    } finally { store.close(); }
  }
});

const LEGACY_LOADER = String.raw`import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let root,ts;
export async function initialize(data){root=data.root;ts=(await import(data.typescript)).default;}
export async function load(url,context,next){
 const prefix=new URL('dist/src/',root).href;
 if(url.startsWith(prefix)&&/\.js$/.test(url)){
  const relative='src/'+url.slice(prefix.length).replace(/\.js$/,'.ts');
  const source=execFileSync('git',['show','ee3fd4cb0941cc47e1b783e06015bd3a8d59fd8b:'+relative],
   {cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
  return {format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};
 }
 return next(url,context);
}

`;

const LEGACY_PRODUCER = String.raw`import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository,root]=process.argv.slice(2),url=path=>pathToFileURL(join(repository,'dist/src',path)).href;
const {Store}=await import(url('storage/store.js'));
const {ProductEngine}=await import(url('product/engine.js'));
const {reference}=await import(url('pipeline/contracts.js'));
const {canonical}=await import(url('canonical.js'));
const {configureResearchScope}=await import(url('graph/research-scope.js'));
const {carriedObligations}=await import(url('graph/obligation-policy.js'));
const {findObligationConfirmation,frozenObligationConfirmation}=await import(url('graph/obligation-readiness.js'));
const {runtimeSupport}=await import(url('graph/runtime-evidence.js'));
const database=join(root,'legacy.sqlite'),store=new Store(database),engine=new ProductEngine(store),project='legacy';
engine.execute({type:'create-project',project,title:'Legacy D8 producer'});
const graph={nodes:[{id:'n',code:[]}],horizon:[],connectors:[],tests:[],anchors:[]};
store.write({id:'graph:'+project,kind:'graph',expected:0,value:graph});
const layer=store.write({id:'graph-layer:'+project+':2',kind:'graph-layer',expected:0,value:{projection:graph}});
const gap={id:'legacy-gap',target:'n',field:'code',consumer:'compilation',requiredFor:'next',question:'Confirm the declared legacy condition'};
const r1=store.write({id:'legacy-r1',kind:'discovery-draft',expected:0,value:{projectId:project,fields:{technical:{gaps:[gap]}}}});
const phase=store.write({id:'phase:'+project+':R1',kind:'phase',expected:0,value:{draft:reference(r1)}});
const original=configureResearchScope(store,{projectId:project,layer:reference(layer),r1:reference(phase),
 outcome:'Observe the actual legacy check',nodes:['n'],boundaries:[],expansions:[],changedPaths:[],uiRequired:false,
 obligations:[{gap,state:'active',reason:'Declared check',wake:null}]},0);
const marker=join(root,'legacy-invocations');
const code=engine.discovery.evidence.document(project,'legacy-module',
 "import{appendFileSync,readFileSync}from'node:fs';readFileSync(0,'utf8');appendFileSync(process.argv[2],'executed\\n');console.log('legacy-success');",'text/plain',0);
const condition='The legacy local module has completed successfully';
const check={script:reference(code),dependencies:[],subjects:[],executables:[],args:[marker],timeoutMs:3000,purpose:'A declared local check',satisfies:condition};
const scope=configureResearchScope(store,{...original.value,policy:{version:1,sourceScope:reference(original),assignments:[{
 obligation:gap.id,original:{record:reference(original),pointer:'/obligations/0/gap'},kind:'environment-confirmation',moment:'task-start',
 responsibleNode:'n',responsibleConsumer:'compilation',neededForR2:false,reason:'Required at task start',returnCondition:condition,runtimeCheck:check}]}},1);
const command={executable:process.execPath,args:['--version']};
const environment=engine.environments.configure(project,{workspace:root,implementer:{actor:'worker',model:'fixture',effort:'high',command},
 reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:3000},0);
const request={type:'observe-runtime',project,scope:reference(scope),obligation:gap.id,key:'legacy-one'};
const observed=await engine.execute(request),obligation=carriedObligations(scope)[0];
const confirmation=findObligationConfirmation(store,project,obligation),support=runtimeSupport(store,project,obligation,reference(observed.source));
if(!confirmation||!support||!frozenObligationConfirmation(store,project,obligation,confirmation.proof))throw Error('Legacy producer did not establish confirmation');
const history=store.list().flatMap(record=>store.history(record.id));
process.stdout.write(JSON.stringify({root,database,project,marker,request,environment,scope,obligation,observed,confirmation,support,history,historyBytes:canonical(history)}));
store.close();

`;

// Task-start/task-result are declared by the existing research-scope contract.
// This fixture does not manufacture OM task-result authority.
function d83ScopedExecutionFixture(t: test.TestContext) {
  let condition = '';
  const f = executionFixture(t, 'normal', engine => {
    const store = engine.store;
    condition = join(dirname(store.path), 'd83-condition.txt'); writeFileSync(condition, 'ready');
    const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0); engine.refinement.sealLayer('p', 1, 0);
    const gaps = ['start', 'result', 'implementation'].map(id => ({ id, target: 'p-produce-block', consumer: 'compilation', field: 'tests',
      requiredFor: 'next' as const, question: `Check the actual ${id} of the producer task at its declared moment` }));
    const r1 = engine.refinement.begin('p', 'R1'); answerTechnicalFixture(engine, 'p', r1, (field, report) => field === 'runtime' ? { ...report, gaps } : report);
    const phase = engine.refinement.finishResearch('p', 'R1', reference(store.get(r1.id)!), 0);
    deriveLayerFixture(engine, 'p', 2); engine.refinement.sealLayer('p', 2, 0);
    const original = configureResearchScope(store, { projectId: 'p', r1: reference(phase), layer: reference(store.get('graph-layer:p:2')!),
      outcome: 'Produce and consume numeric results with exact late obligations', nodes: ['p-produce-block'], boundaries: [], expansions: [], changedPaths: [], uiRequired: false,
      obligations: gaps.map(gap => ({ gap, state: 'active', reason: 'Approved local fixture', wake: null })) }, 0);
    const script = engine.discovery.evidence.document('p', 'd83-task-check',
      "import{readFileSync}from'node:fs';process.exitCode=readFileSync(process.argv.at(-1),'utf8')==='ready'?0:7;", 'text/plain', 0);
    const policy: ObligationPolicy = { version: 1, sourceScope: reference(original), assignments: gaps.map((gap, index) => ({
      obligation: gap.id, original: { record: reference(original), pointer: `/obligations/${index}/gap` },
      kind: gap.id === 'implementation' ? 'post-implementation-proof' : 'environment-confirmation',
      moment: gap.id === 'start' ? 'task-start' : 'task-result', responsibleNode: gap.target, responsibleConsumer: gap.consumer,
      neededForR2: false, reason: 'The future runtime and implementation do not decide the R2 design', returnCondition: `Verify actual ${gap.id} for this producer task`,
      ...(gap.id === 'implementation' ? {} : { runtimeCheck: { script: reference(script), dependencies: [], subjects: [condition], executables: [], args: [condition], timeoutMs: 3000,
        purpose: 'A controlled local execution fixture', satisfies: `Verify actual ${gap.id} for this producer task` } }) })) };
    const scope = configureResearchScope(store, { ...original.value, policy }, 1);
    const r2 = engine.refinement.begin('p', 'R2'); answerTechnicalFixture(engine, 'p', r2);
    engine.refinement.finishResearch('p', 'R2', reference(store.get(r2.id)!), 0);
    const graph = store.get<Graph>('graph:p')!;
    engine.graphs.save('p', { ...graph.value, researchObligations: carriedObligations(scope).map(item => ({ id: taskBindingId(item), scope: item.scope,
      obligation: item.obligation, consumers: [{ node: 'p-produce-work', tests: item.kind === 'post-implementation-proof' ? ['p-produce-work-test'] : [] }] })) }, graph.revision, 'fixture');
    deriveLayerFixture(engine, 'p', 3); engine.refinement.sealLayer('p', 3, 0);
  });
  const observe = (obligation: string, key = obligation) => f.engine.execute({ type: 'observe-runtime', project: 'p',
    scope: reference(f.store.get('research-scope:p:R2')!), obligation, key }) as Promise<RuntimeObservationResult>;
  const run = (retry = false) => f.engine.executor.run('p', reference(f.plan), { ...f.options, retry, maxCorrections: 3 });
  const prepare = async () => {
    await assert.rejects(run(), { code: 'task_obligation_start_required' });
    const observation = await observe('start'); assert.equal(observation.observation.value.status, 'observed');
    assert.equal(f.store.get<ExecutionRoot>('execution-root:p')!.value.state, 'ready');
    assert.equal(f.store.get('reader-pilot:p'), null);
    return observation;
  };
  return { ...f, condition, observe, run, prepare };
}

// The second SQLite connection writes through the real configuration API.
// active:false keeps runtimeBinding.pilot null: binding comparison cannot mask
// a missing negative guard by independently rejecting an active reader change.
function d83CreateInactivePilot(store: Store) {
  const before = runtimeContext(store, 'p').binding;
  const second = new Store(store.path);
  try {
    const command = { executable: process.execPath, args: ['--version'] };
    const pilot = configureReaderPilot(second, new Environments(second), 'p', {
      experimental: true, active: false, stopAfter: 'L2',
      reader: { actor: 'd83-reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
      maxRequestChars: 300000, maxReadChars: 60000, maxReplyChars: 100000, maxCalls: 100, maxReportedTokens: 20000000,
    }, 0);
    assert.equal(pilot.value.active, false);
    assert.deepEqual(runtimeContext(store, 'p').binding, before, 'An inactive pilot must preserve the whole runtime binding');
    return pilot;
  } finally { second.close(); }
}

function d83AssertPilotAbsence(guards: TransactionGuard[]) {
  assert.deepEqual(guards.filter(guard => 'absent' in guard), [{ id: 'reader-pilot:p', absent: true }]);
  assert.ok(guards.some(guard => guard.id === 'execution-root:p' && !('absent' in guard)), 'The real executor already has a positive root guard');
}

function d83Companions(key: string): Write[] {
  return ['one', 'two'].map(suffix => ({ id: `d83-neighbor:${key}:${suffix}`, kind: 'd83-neighbor', expected: 0, value: { key, suffix } }));
}

function d83AssertCompanionsAbsent(store: Store, writes: Write[]) {
  for (const write of writes) assert.equal(store.get(write.id), null, `The failed exact transaction must not save ${write.id}`);
}

test('D8.3 actual runner preserves pilot absence until task-start admission commits', async t => {
  const f = d83ScopedExecutionFixture(t); await f.prepare();
  const root = f.store.get<ExecutionRoot>('execution-root:p')!;
  const original = f.store.writeMany.bind(f.store), companions = d83Companions('start'); let intercepted = false;
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    if (!intercepted && writes.some(write => write.kind === 'task-run' && (write.value as TaskRun).obligationStartProofs?.length)) {
      intercepted = true; d83AssertPilotAbsence(guards); d83CreateInactivePilot(f.store);
      return original([...writes, ...companions], guards);
    }
    return original(writes, guards);
  }) as Store['writeMany'];
  try { await assert.rejects(f.run(), { code: 'input_stale' }); }
  finally { f.store.writeMany = original; }
  assert.equal(intercepted, true); d83AssertCompanionsAbsent(f.store, companions);
  assert.deepEqual(f.store.list('task-run'), []); assert.deepEqual(f.calls(), []);
  assert.deepEqual(f.store.get(root.id), root); assert.equal(git(root.value.path, ['rev-parse', 'HEAD']), f.initial);
  assert.equal(f.store.get(receiptId('p', 'p-data')), null);
});

for (const entry of ['ordinary', 'awaiting-obligation'] as const) {
  test(`D8.3 ${entry} commitIntent loses an absent pilot without regenerating its checked candidate`, async t => {
    const f = d83ScopedExecutionFixture(t); await f.prepare();
    const waiting = entry === 'awaiting-obligation' ? (await f.run())[0]! : null;
    if (waiting) { assert.equal(waiting.value.state, 'awaiting_obligation'); assert.equal(f.calls().length, 2); }
    await f.observe('result');
    const root = f.store.get<ExecutionRoot>('execution-root:p')!;
    const original = f.store.writeMany.bind(f.store), companions = d83Companions(`intent-${entry}`);
    let intercepted = false, checkedCandidate: TaskRun | null = null;
    f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
      const intent = writes.find(write => write.kind === 'task-run' && (write.value as TaskRun).state === 'commit_pending');
      if (!intercepted && intent) {
        intercepted = true; checkedCandidate = structuredClone(intent.value as TaskRun);
        d83AssertPilotAbsence(guards); d83CreateInactivePilot(f.store);
        return original([...writes, ...companions], guards);
      }
      return original(writes, guards);
    }) as Store['writeMany'];
    let result: Awaited<ReturnType<typeof f.run>>;
    try { result = await f.run(entry === 'awaiting-obligation'); }
    finally { f.store.writeMany = original; }
    assert.equal(intercepted, true); assert.ok(checkedCandidate); d83AssertCompanionsAbsent(f.store, companions);
    const paused = result[0]!;
    assert.equal(paused.value.state, 'awaiting_obligation'); assert.match(paused.value.error!, /task_obligation_result_required/);
    assert.equal(paused.value.attempt, 1); assert.equal(paused.value.commit, null); assert.equal(f.calls().length, 2);
    // The callback assignment is synchronous but is not tracked by TypeScript control flow.
    const candidate = checkedCandidate as TaskRun;
    assert.equal(paused.value.tree, candidate.tree); assert.deepEqual(paused.value.checks, candidate.checks);
    assert.deepEqual(paused.value.review, candidate.review); assert.equal(paused.value.reviewSubject, candidate.reviewSubject);
    if (waiting) assert.deepEqual(paused.value.checks, waiting.value.checks);
    assert.deepEqual(f.store.get(root.id), root); assert.equal(git(root.value.path, ['rev-parse', 'HEAD']), f.initial);
    assert.equal(f.store.get(receiptId('p', 'p-data')), null);
  });
}

test('D8.3 actual recovery preserves the absent pilot through its refreshed-proof transaction', async t => {
  const f = d83ScopedExecutionFixture(t); await f.prepare(); await f.observe('result');
  const original = f.store.writeMany.bind(f.store); let interrupted = false;
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    const result = original(writes, guards);
    if (!interrupted && writes.some(write => write.kind === 'task-run' && (write.value as TaskRun).state === 'commit_pending')) {
      interrupted = true; writeFileSync(f.condition, 'changed before publication');
    }
    return result;
  }) as Store['writeMany'];
  try { await assert.rejects(f.run(), { code: 'task_obligation_result_required' }); }
  finally { f.store.writeMany = original; }
  assert.equal(interrupted, true);
  const pending = f.store.list<TaskRun>('task-run')[0]!, root = f.store.get<ExecutionRoot>('execution-root:p')!;
  assert.equal(pending.value.state, 'commit_pending'); assert.equal(git(root.value.path, ['rev-parse', 'HEAD']), f.initial);
  assert.equal(f.calls().length, 2);
  writeFileSync(f.condition, 'ready'); await f.observe('result', 'd83-restored-result');
  const companions = d83Companions('recovery'); let intercepted = false;
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    if (!intercepted && writes.some(write => write.id === pending.id && (write.value as TaskRun).state === 'commit_pending')) {
      intercepted = true; d83AssertPilotAbsence(guards); d83CreateInactivePilot(f.store);
      return original([...writes, ...companions], guards);
    }
    return original(writes, guards);
  }) as Store['writeMany'];
  try { await assert.rejects(f.engine.executor.recover('p'), { code: 'input_stale' }); }
  finally { f.store.writeMany = original; }
  assert.equal(intercepted, true); d83AssertCompanionsAbsent(f.store, companions);
  assert.deepEqual(f.store.get(pending.id), pending); assert.deepEqual(f.store.get(root.id), root);
  assert.equal(git(root.value.path, ['rev-parse', 'HEAD']), f.initial); assert.equal(f.calls().length, 2);
  assert.equal(f.store.get(receiptId('p', 'p-data')), null);
});

test('D8.3 inactive pilot changes current admission while frozen task proofs and exact observation replay survive', async t => {
  const f = d83ScopedExecutionFixture(t), start = await f.prepare(), result = await f.observe('result');
  const runs = await f.run(), accepted = runs[0]!, task = f.plan.value.tasks[0]!;
  assert.deepEqual(runs.map(run => run.value.state), ['committed', 'committed']); assert.equal(f.calls().length, 4);
  const beforeStart = taskStartProofs(f.store, accepted.value, task), beforeResult = taskResultProofs(f.store, accepted.value, task);
  d83AssertPilotAbsence(beforeStart.guards); d83AssertPilotAbsence(beforeResult.guards);
  const pilot = d83CreateInactivePilot(f.store);
  const afterStart = taskStartProofs(f.store, accepted.value, task), afterResult = taskResultProofs(f.store, accepted.value, task);
  assert.deepEqual(afterStart.proofs, beforeStart.proofs); assert.deepEqual(afterResult.proofs, beforeResult.proofs);
  for (const guards of [afterStart.guards, afterResult.guards]) {
    assert.deepEqual(guards.filter(guard => 'absent' in guard), []);
    assert.deepEqual(guards.filter(guard => guard.id === pilot.id), [reference(pilot)]);
  }
  requireTaskObligationProofs(f.store, accepted.value, task);
  assert.deepEqual(await f.observe('start'), start); assert.deepEqual(await f.observe('result'), result);
  assert.deepEqual(f.store.get(start.observation.id), start.observation); assert.deepEqual(f.store.get(result.observation.id), result.observation);
  assert.ok(start.source); assert.ok(result.source);
  assert.deepEqual(f.store.get(start.source.id), start.source); assert.deepEqual(f.store.get(result.source.id), result.source);
  assert.deepEqual(await f.engine.executor.recover('p'), []); assert.equal(f.calls().length, 4);
  for (const run of runs) assert.deepEqual(f.store.get(run.id), run);
  assert.deepEqual(f.store.get(f.plan.id, f.plan.revision), f.plan);
  requireTaskObligationProofs(f.store, accepted.value, task);
});


test('D8 complete ee3fd4c execution preserves MachinePlan guards and frozen start/result proofs after restart', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-runtime-execution-legacy-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url)), repositoryUrl = pathToFileURL(repository).href;
  const loader = join(root, 'legacy-loader.mjs'), producer = join(root, 'execution-producer.mjs');
  writeFileSync(loader, LEGACY_LOADER);
  writeFileSync(producer, `import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';import {dirname,join} from 'node:path';import {pathToFileURL} from 'node:url';
const repository=process.argv[2],src=path=>pathToFileURL(join(repository,'dist/src',path)).href,
 fixture=path=>pathToFileURL(join(repository,'dist/test',path)).href;
const {executionFixture}=await import(fixture('execution-fixture.js'));
const {answerTechnicalFixture}=await import(fixture('technical-research-fixture.js'));
const {deriveLayerFixture}=await import(fixture('layer-design-fixture.js'));
const {configureResearchScope}=await import(src('graph/research-scope.js'));
const {carriedObligations}=await import(src('graph/obligation-policy.js'));
const {taskBindingId}=await import(src('graph/task-obligations.js'));
const {reference}=await import(src('pipeline/contracts.js'));
const {canonical}=await import(src('canonical.js'));
const {taskStartProofs,taskResultProofs,requireTaskObligationProofs}=await import(src('execution/task-obligations.js'));
${d83ScopedExecutionFixture.toString()}
const cleanup=[],f=d83ScopedExecutionFixture({after:fn=>cleanup.push(fn)});
try {
 const start=await f.prepare(),result=await f.observe('result'),runs=await f.run(),task=f.plan.value.tasks[0];
 assert.deepEqual(runs.map(run=>run.value.state),['committed','committed']);
 for(const run of runs)requireTaskObligationProofs(f.store,run.value,f.plan.value.tasks.find(task=>task.id===run.value.taskId));
 const starts=taskStartProofs(f.store,runs[0].value,task),results=taskResultProofs(f.store,runs[0].value,task);
 const historyBytes=canonical(f.store.list().flatMap(row=>f.store.history(row.id)));
 process.stdout.write(JSON.stringify({directory:f.directory,database:f.store.path,plan:f.plan,runs,start,result,starts,results,historyBytes}));
 f.store.close();
} catch(error) {for(const fn of cleanup)fn();throw error;}
`);
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const bootstrap = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},
{data:{root:${JSON.stringify(repositoryUrl)},typescript:${JSON.stringify(typescript)}}});`;
  const output = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository],
    { cwd: repository, encoding: 'utf8', timeout: 60_000, maxBuffer: 30_000_000 });
  const legacy = JSON.parse(output) as { directory: string; database: string; plan: Revision<MachinePlan>; runs: Revision<TaskRun>[];
    start: RuntimeObservationResult; result: RuntimeObservationResult; starts: ReturnType<typeof taskStartProofs>;
    results: ReturnType<typeof taskResultProofs>; historyBytes: string };
  t.after(() => rmSync(legacy.directory, { recursive: true, force: true }));
  assert.ok(legacy.plan.value.guards.length); assert.ok(legacy.runs[0]!.value.obligationStartProofs?.length);
  assert.ok(legacy.runs[0]!.value.obligationResultProofs?.length);
  for (let restart = 0; restart < 2; restart++) {
    const store = new Store(legacy.database), engine = new ProductEngine(store);
    try {
      const run = legacy.runs[0]!, task = legacy.plan.value.tasks[0]!;
      assert.deepEqual(store.get(legacy.plan.id, legacy.plan.revision), legacy.plan);
      for (const record of legacy.runs) {
        assert.deepEqual(store.get(record.id), record);
        requireTaskObligationProofs(store, record.value, legacy.plan.value.tasks.find(task => task.id === record.value.taskId)!);
      }
      const absent = { id: 'reader-pilot:p', absent: true } as const;
      assert.deepEqual(taskStartProofs(store, run.value, task), { proofs: legacy.starts.proofs,
        guards: uniqueTransactionGuards([...legacy.starts.guards, absent]) });
      assert.deepEqual(taskResultProofs(store, run.value, task), { proofs: legacy.results.proofs,
        guards: uniqueTransactionGuards([...legacy.results.guards, absent]) });
      for (const [obligation, expected] of [['start', legacy.start], ['result', legacy.result]] as const) {
        assert.deepEqual(await engine.execute({ type: 'observe-runtime', project: 'p', scope: expected.observation.value.scope,
          obligation, key: obligation }), expected);
      }
      assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), legacy.historyBytes);
    } finally { store.close(); }
  }
});
