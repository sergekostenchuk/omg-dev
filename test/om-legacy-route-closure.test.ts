import { runIntegrityCheck, integrityGate } from "../src/om/integrity.js";
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, hashJson } from '../src/canonical.js';
import type { MachinePlan } from '../src/compiler/model.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { EngineError } from '../src/errors.js';
import type { TaskRun } from '../src/execution/model.js';
import { Executor } from '../src/execution/runner.js';
import { L3_ASSEMBLY } from '../src/graph/layer-assembly.js';
import { layerDesignOf } from '../src/graph/layer-design.js';
import { writeFeasibility, type FeasibilityRequest } from '../src/om/feasibility.js';
import { writeOmInput } from '../src/om/input.js';
import { reference, type Ref, type StageArtifact } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { continuePreparation } from '../src/product/preparation-run.js';
import { git } from '../src/runtime/environment.js';
import { checkStoreIntegrity } from '../src/storage/fsck.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../src/storage/store.js';
import { executionFixture } from './execution-fixture.js';
import { preparedFeatures, refinedLayers } from './product-fixture.js';

type NativePoint = 'feasibility' | 'om-draft' | 'om-accepted' | 'plan' | 'compilation-draft' | 'complete';
const absentB1: TransactionGuard = { id: 'om-input:p', absent: true };
const history = (store: Store) => canonical(store.list().flatMap(record => store.history(record.id)));

function firstInput(store: Store) {
  const result = writeOmInput(store, { project: 'p', expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:p:${stage}`)!)])) as Record<UpstreamStage, Ref> });
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message} ${canonical(result.refusal.at)}`);
  assert.equal(result.value.revision, 1);
  return result.value;
}

function nativeFixture(t: TestContext, point: NativePoint = 'complete') {
  const directory = mkdtempSync(join(tmpdir(), 'omg-g13-native-')), workspace = join(directory, 'repo');
  mkdirSync(workspace);
  git(workspace, ['init', '-b', 'main']);
  writeFileSync(join(workspace, 'README.md'), 'A deterministic native route fixture.\n');
  git(workspace, ['add', 'README.md']);
  git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial']);
  let store = new Store(join(directory, 'state.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  preparedFeatures(engine, 'p');
  const command = { executable: process.execPath, args: ['--version'] };
  engine.environments.configure('p', { workspace,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 1000 }, 0);
  refinedLayers(engine, 'p');
  const feasibility = engine.refinement.assess('p', 0);
  const points: NativePoint[] = ['feasibility', 'om-draft', 'om-accepted', 'plan', 'compilation-draft', 'complete'];
  const position = points.indexOf(point);
  if (position >= 1) engine.refinement.publish('p', reference(feasibility), 0);
  if (position >= 2) engine.pipeline.accept('p', 'om-g2', store.get('stage:p:om-g2')!.revision);
  if (position >= 3) engine.compiler.compile('p');
  if (position >= 4) engine.compiler.publish('p', reference(store.list<MachinePlan>('plan')[0]!), 0);
  if (position >= 5) engine.pipeline.accept('p', 'compilation', store.get('stage:p:compilation')!.revision);
  return { directory, workspace, feasibility, get store() { return store; }, get engine() { return engine; },
    reopen() { store.close(); store = new Store(join(directory, 'state.sqlite')); engine = new ProductEngine(store); } };
}
type NativeFixture = ReturnType<typeof nativeFixture>;
const planOf = (f: NativeFixture) => f.store.list<MachinePlan>('plan')[0]!;

function addressed(error: unknown): boolean {
  assert.ok(error instanceof EngineError, 'OM-era production has an EngineError refusal');
  assert.ok(['legacy_route_closed', 'input_stale'].includes(error.code));
  assert.ok(error.details && typeof error.details === 'object');
  assert.equal((error.details as { target?: unknown }).target, 'om-input:p');
  return true;
}

interface WriteRoute { name: string; point: NativePoint; target: string; invoke(f: NativeFixture, guards: TransactionGuard[]): unknown }
const writeRoutes: WriteRoute[] = [
  { name: 'native feasibility publication', point: 'feasibility', target: 'stage:p:om-g2',
    invoke: (f, guards) => f.engine.refinement.publish('p', reference(f.feasibility), 0, guards) },
  { name: 'native compilation', point: 'om-accepted', target: 'current-plan:p',
    invoke: (f, guards) => f.engine.compiler.compile('p', guards) },
  { name: 'machine-plan publication', point: 'plan', target: 'stage:p:compilation',
    invoke: (f, guards) => f.engine.compiler.publish('p', reference(planOf(f)), 0, guards) },
  { name: 'OM-G2 draft acceptance', point: 'om-draft', target: 'stage:p:om-g2',
    invoke: (f, guards) => f.engine.pipeline.accept('p', 'om-g2', f.store.get('stage:p:om-g2')!.revision, guards) },
  { name: 'compilation draft acceptance', point: 'compilation-draft', target: 'stage:p:compilation',
    invoke: (f, guards) => f.engine.pipeline.accept('p', 'compilation', f.store.get('stage:p:compilation')!.revision, guards) },
];

for (const route of writeRoutes) {
  test(`G1.3 ${route.name} carries B1 absence into its actual transaction`, t => {
    const f = nativeFixture(t, route.point), other = new Store(f.store.path), writeMany = f.store.writeMany.bind(f.store);
    let inserted = false, afterB1: string | null = null;
    f.store.writeMany = (<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] => {
      if (!inserted && writes.some(write => write.id === route.target)) {
        inserted = true;
        assert.ok(guards.some(guard => guard.id === 'om-input:p' && 'absent' in guard && guard.absent));
        firstInput(other);
        afterB1 = history(other);
      }
      return writeMany<T>(writes, guards);
    }) as Store['writeMany'];
    try {
      assert.throws(() => route.invoke(f, [absentB1]), { code: 'input_stale' });
      assert.ok(inserted, 'B1 must appear after preparation and before the protected write');
      assert.equal(history(f.store), afterB1, 'The losing operation leaves no partial plan, pointer, draft or acceptance');
    } finally { f.store.writeMany = writeMany; other.close(); }
    f.reopen();
    assert.equal(history(f.store), afterB1);
  });
}

test('G1.3 extra write guards do not prohibit exact completed compile and accepted-stage repetitions', t => {
  const f = nativeFixture(t), plan = planOf(f);
  const om = f.store.get<StageArtifact>('stage:p:om-g2')!, compilation = f.store.get<StageArtifact>('stage:p:compilation')!;
  firstInput(f.store);
  const before = history(f.store);
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.deepEqual(f.engine.compiler.compile('p', [absentB1]), plan);
    assert.deepEqual(f.engine.pipeline.accept('p', 'om-g2', om.revision, [absentB1]), om);
    assert.deepEqual(f.engine.pipeline.accept('p', 'compilation', compilation.revision, [absentB1]), compilation);
    assert.equal(history(f.store), before);
    if (repeat === 0) f.reopen();
  }
});

const commands: Array<{ name: string; point: NativePoint; target: string; invoke(f: NativeFixture): unknown }> = [
  { name: 'draft-om', point: 'feasibility', target: 'stage:p:om-g2', invoke: f => f.engine.execute({ type: 'draft-om', project: 'p', feasibility: reference(f.feasibility), expected: 0 }) },
  { name: 'compile new plan', point: 'om-accepted', target: 'current-plan:p', invoke: f => f.engine.execute({ type: 'compile', project: 'p' }) },
  { name: 'compile existing unpublished plan', point: 'plan', target: 'stage:p:compilation', invoke: f => f.engine.execute({ type: 'compile', project: 'p' }) },
  { name: 'draft-plan', point: 'plan', target: 'stage:p:compilation', invoke: f => f.engine.execute({ type: 'draft-plan', project: 'p', plan: reference(planOf(f)), expected: 0 }) },
  { name: 'accept-stage om-g2', point: 'om-draft', target: 'stage:p:om-g2', invoke: f => f.engine.execute({ type: 'accept-stage', project: 'p', stage: 'om-g2', expected: f.store.get('stage:p:om-g2')!.revision }) },
  { name: 'accept-stage compilation', point: 'compilation-draft', target: 'stage:p:compilation', invoke: f => f.engine.execute({ type: 'accept-stage', project: 'p', stage: 'compilation', expected: f.store.get('stage:p:compilation')!.revision }) },
];

for (const command of commands) {
  test(`G1.3 mixed project refuses ${command.name} without any new legacy result`, t => {
    const f = nativeFixture(t, command.point);
    firstInput(f.store);
    const before = history(f.store);
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.throws(() => command.invoke(f), addressed);
      assert.equal(history(f.store), before);
      if (repeat === 0) f.reopen();
    }
  });

  test(`G1.3 ${command.name} closes the era-selection-to-write window`, t => {
    const f = nativeFixture(t, command.point), other = new Store(f.store.path), writeMany = f.store.writeMany.bind(f.store);
    let inserted = false, afterB1: string | null = null;
    f.store.writeMany = (<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] => {
      if (!inserted && writes.some(write => write.id === command.target)) {
        inserted = true; firstInput(other); afterB1 = history(other);
      }
      return writeMany<T>(writes, guards);
    }) as Store['writeMany'];
    try {
      assert.throws(() => command.invoke(f), addressed);
      assert.ok(inserted, 'The competitor creates the first real B1 after the public command selected its legacy route');
      assert.equal(history(f.store), afterB1);
    } finally { f.store.writeMany = writeMany; other.close(); }
  });
}

test('G1.3 direct product commands retain exact completed compile and stage acceptances in a mixed project', t => {
  const f = nativeFixture(t), plan = planOf(f), om = f.store.get('stage:p:om-g2')!, compilation = f.store.get('stage:p:compilation')!;
  firstInput(f.store);
  const before = history(f.store);
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.deepEqual(f.engine.execute({ type: 'compile', project: 'p' }), plan);
    assert.deepEqual(f.engine.execute({ type: 'accept-stage', project: 'p', stage: 'om-g2', expected: om.revision }), om);
    assert.deepEqual(f.engine.execute({ type: 'accept-stage', project: 'p', stage: 'compilation', expected: compilation.revision }), compilation);
    assert.deepEqual(f.engine.compiler.read(plan.id), plan);
    assert.deepEqual(f.engine.refinement.feasibilityGate('p', reference(f.feasibility), true).findings, []);
    assert.equal(history(f.store), before);
    if (repeat === 0) f.reopen();
  }
});

test('G1.3 the compound compile command guards its final acceptance after its draft has already been written', t => {
  const f = nativeFixture(t, 'om-accepted'), other = new Store(f.store.path), writeMany = f.store.writeMany.bind(f.store);
  let stageWrites = 0, afterB1: string | null = null, draft: Revision<StageArtifact> | null = null;
  f.store.writeMany = (<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] => {
    if (writes.some(write => write.id === 'stage:p:compilation') && ++stageWrites === 2) {
      draft = f.store.get<StageArtifact>('stage:p:compilation');
      assert.equal(draft?.value.status, 'draft');
      firstInput(other); afterB1 = history(other);
    }
    return writeMany<T>(writes, guards);
  }) as Store['writeMany'];
  try {
    assert.throws(() => f.engine.execute({ type: 'compile', project: 'p' }), addressed);
    assert.equal(stageWrites, 2, 'The conflict must occur during acceptance, after plan creation and draft publication');
    assert.ok(draft);
    assert.deepEqual(f.store.get('stage:p:compilation'), draft);
    assert.equal(history(f.store), afterB1, 'The pre-B1 draft remains saved but no accepted revision is added');
  } finally { f.store.writeMany = writeMany; other.close(); }
});

for (const defect of ['plan', 'compile-stage', 'accept-stage'] as const) {
  test(`G1.3 the ${defect} route preserves the core typed refusal for a null saved value`, t => {
    const f = nativeFixture(t), plan = planOf(f), expected = f.store.get('stage:p:compilation')!.revision;
    const id = defect === 'plan' ? plan.id : defect === 'compile-stage' ? 'stage:p:om-g2' : 'stage:p:compilation';
    const get = f.store.get.bind(f.store), before = history(f.store);
    f.store.get = (<T>(key: string, revision?: number): Revision<T> | null => {
      const record = get<T>(key, revision);
      return key === id && record ? { ...record, value: null as T } : record;
    }) as Store['get'];
    try {
      assert.throws(() => f.engine.execute(defect === 'plan'
        ? { type: 'draft-plan', project: 'p', plan: reference(plan), expected }
        : defect === 'compile-stage' ? { type: 'compile', project: 'p' }
          : { type: 'accept-stage', project: 'p', stage: 'compilation', expected }),
      (error: unknown) => {
        assert.ok(error instanceof EngineError);
        assert.equal(error.code, defect === 'plan' ? 'plan_invalid' : 'artifact_invalid');
        return true;
      });
      assert.equal(history(f.store), before);
    } finally { f.store.get = get; }
  });
}

test('G1.3 preparation refuses new production before saving a run, research or a graph change', async t => {
  const f = nativeFixture(t, 'om-accepted');
  firstInput(f.store);
  const before = history(f.store);
  let calls = 0;
  f.engine.refinementResearch.run = async () => { calls++; throw new Error('Unexpected research after B1'); };
  await assert.rejects(f.engine.execute({ type: 'continue-preparation', project: 'p', maxCalls: 1 }) as Promise<unknown>, addressed);
  await assert.rejects(continuePreparation(f.engine, 'p', 1), addressed);
  assert.equal(calls, 0);
  assert.equal(history(f.store), before);
});

test('G1.3 preparation admission guards the first run write against a concurrently created B1', async t => {
  const f = nativeFixture(t, 'om-accepted'), other = new Store(f.store.path), writeMany = f.store.writeMany.bind(f.store);
  let inserted = false, afterB1: string | null = null;
  f.store.writeMany = (<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] => {
    if (!inserted && writes.some(write => write.id === 'preparation-run:p')) {
      inserted = true;
      assert.equal(f.store.get('preparation-run:p'), null);
      assert.ok(guards.some(guard => guard.id === 'om-input:p' && 'absent' in guard && guard.absent));
      firstInput(other); afterB1 = history(other);
    }
    return writeMany<T>(writes, guards);
  }) as Store['writeMany'];
  try {
    await assert.rejects(f.engine.execute({ type: 'continue-preparation', project: 'p', maxCalls: 1 }) as Promise<unknown>, { code: 'input_stale' });
    assert.ok(inserted, 'The first B1 appears only after admission chose the legacy route');
    assert.equal(history(f.store), afterB1);
    assert.equal(f.store.get('preparation-run:p'), null);
    assert.equal(f.store.get('stage:p:compilation'), null);
    assert.equal(f.store.get('current-plan:p'), null);
    assert.equal(f.store.list('plan').length, 0);
  } finally { f.store.writeMany = writeMany; other.close(); }
  f.reopen();
  assert.equal(history(f.store), afterB1);
});

interface PreparationWindow {
  name: string;
  point: NativePoint;
  staleRepository?: true;
  matches(write: Write): boolean;
}
const preparationWindows: PreparationWindow[] = [
  { name: 'R3 assessment', point: 'feasibility', staleRepository: true, matches: write => write.id === 'feasibility:p' },
  { name: 'OM-G2 publication', point: 'feasibility', matches: write => write.id === 'stage:p:om-g2' && (write.value as StageArtifact).status === 'draft' },
  { name: 'OM-G2 acceptance', point: 'feasibility', matches: write => write.id === 'stage:p:om-g2' && (write.value as StageArtifact).status === 'accepted' },
  { name: 'machine-plan creation', point: 'om-accepted', matches: write => write.kind === 'plan' },
  { name: 'compilation publication', point: 'plan', matches: write => write.id === 'stage:p:compilation' && (write.value as StageArtifact).status === 'draft' },
  { name: 'compilation acceptance', point: 'plan', matches: write => write.id === 'stage:p:compilation' && (write.value as StageArtifact).status === 'accepted' },
  { name: 'completed preparation', point: 'complete', matches: write => write.id === 'preparation-run:p' && (write.value as { status: string }).status === 'accepted' },
];

for (const boundary of preparationWindows) {
  test(`G1.4 preparation excludes the first B1 through ${boundary.name}`, async t => {
    const f = nativeFixture(t, boundary.point), other = new Store(f.store.path), writeMany = f.store.writeMany.bind(f.store);
    if (boundary.staleRepository)
      git(f.workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'New R3 repository basis']);
    let attempted = false, calls = 0;
    f.engine.refinementResearch.run = async () => { calls++; throw new Error('The existing R2 and L3 phases must be reused'); };
    f.store.writeMany = (<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] => {
      if (!attempted && writes.some(boundary.matches)) {
        attempted = true;
        assert.equal(f.store.get<{ status: string }>('preparation-run:p')!.value.status, 'running');
        const before = history(other);
        const result = writeOmInput(other, { project: 'p', expected: 0,
          stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(other.get(`stage:p:${stage}`)!)])) as Record<UpstreamStage, Ref> });
        assert.equal(result.ok, false);
        if (!result.ok) { assert.equal(result.refusal.code, 'legacy_operation_active'); assert.equal(result.refusal.at.target, 'legacy-operation:p'); }
        assert.equal(history(other), before, 'A busy first B1 writes nothing');
      }
      return writeMany<T>(writes, guards);
    }) as Store['writeMany'];
    try {
      const result = await continuePreparation(f.engine, 'p', 1);
      assert.ok(attempted, `Preparation must reach ${boundary.name} after its initial run was saved`);
      assert.equal(result.value.status, 'accepted', result.value.error ?? 'Preparation must finish');
      assert.equal(calls, 0);
      assert.equal(f.store.get('om-input:p'), null);
      assert.equal(f.store.get<{ state: string }>('legacy-operation:p')!.value.state, 'released');
    } finally { f.store.writeMany = writeMany; other.close(); }
    f.reopen();
    firstInput(f.store);
  });
}

test('G1.3 completed preparation repeats its accepted plan after B1 and restart', async t => {
  const f = nativeFixture(t);
  const completed = await continuePreparation(f.engine, 'p', 1);
  assert.equal(completed.value.status, 'accepted');
  firstInput(f.store); f.reopen();
  const before = history(f.store);
  const repeated = await f.engine.execute({ type: 'continue-preparation', project: 'p', maxCalls: 1 }) as typeof completed;
  assert.equal(repeated.value.status, 'accepted');
  assert.deepEqual(repeated.value.plan, completed.value.plan);
  assert.equal(history(f.store), before, 'A completed OM-era repeat cannot restart legacy production');
});

test('G1.3 repair refuses a new legacy repair before research, graph mutation or candidate parking', async t => {
  const f = executionFixture(t, 'plan-defect');
  const failed = (await f.engine.executor.run('p', reference(f.plan), f.options))[0]!;
  assert.equal(failed.value.state, 'needs_plan');
  firstInput(f.store);
  const before = history(f.store), calls = f.calls().length;
  await assert.rejects(f.engine.execute({ type: 'repair-plan', project: 'p', run: reference(failed), maxTurns: 1 }) as Promise<unknown>, addressed);
  await assert.rejects(f.engine.repairs.prepare('p', reference(failed)), addressed);
  assert.equal(f.calls().length, calls);
  assert.equal(history(f.store), before);
  assert.equal(f.store.list('plan-repair').length, 0);
  assert.equal(f.store.list('parked-candidate').length, 0);
});

test('G1.3 a reissued repair remains a completed repeat after B1 and restart', async t => {
  const f = executionFixture(t, 'repair');
  const failed = (await f.engine.executor.run('p', reference(f.plan), f.options))[1]!;
  assert.equal(failed.value.state, 'needs_plan');
  const graph = structuredClone(f.plan.value.graphSnapshot); graph.horizon = ['p-consume-work'];
  const check = graph.tests.find(proof => proof.node === 'p-consume-work')!;
  check.covers.push('p-flow');
  check.contract!.counterfactuals.push({ connector: 'p-flow', mutation: 'remove', expectedFailure: 'input_missing',
    command: { executable: process.execPath, args: ['check.mjs', 'consume-mutation'] } });
  writeFileSync(join(f.directory, 'calls.jsonl.repair.json'), JSON.stringify({ design: layerDesignOf(graph, 3, L3_ASSEMBLY) }));
  const completed = await f.engine.repairs.run('p', reference(failed), 20);
  assert.equal(completed.value.phase, 'reissued', completed.value.error ?? 'The native repair must finish before B1');
  firstInput(f.store); f.reopen();
  const revisions = f.store.history(completed.id), graphHistory = f.store.history('graph:p'), plans = f.store.list('plan'), calls = f.calls().length;
  const invalidSources: Array<{ name: string; replace(record: Revision<TaskRun>): Revision<TaskRun> | null }> = [
    { name: 'missing exact failed run', replace: () => null },
    { name: 'wrong source kind', replace: record => ({ ...record, kind: 'source' }) },
    { name: 'foreign source project', replace: record => {
      const value = { ...record.value, projectId: 'foreign' };
      return { ...record, value, hash: hashJson(value) };
    } },
    { name: 'inconsistent source plan', replace: record => {
      const value = { ...record.value, plan: { ...record.value.plan, hash: '0'.repeat(64) } };
      return { ...record, value, hash: hashJson(value) };
    } },
  ];
  for (const source of invalidSources) {
    const get = f.store.get.bind(f.store), before = history(f.store);
    f.store.get = (<T>(key: string, revision?: number): Revision<T> | null => {
      const record = get<T>(key, revision);
      return key === failed.id && revision === failed.revision && record
        ? source.replace(record as unknown as Revision<TaskRun>) as unknown as Revision<T> | null : record;
    }) as Store['get'];
    try {
      await assert.rejects(f.engine.repairs.prepare('p', reference(failed)), { code: 'legacy_route_closed' }, source.name);
      await assert.rejects(f.engine.execute({ type: 'repair-plan', project: 'p', run: reference(failed), maxTurns: 1 }) as Promise<unknown>,
        { code: 'legacy_route_closed' }, source.name);
      assert.equal(history(f.store), before, `${source.name} cannot create repair or lock revisions`);
      assert.equal(f.calls().length, calls);
    } finally { f.store.get = get; }
  }
  f.reopen();
  assert.deepEqual(await f.engine.repairs.prepare('p', reference(failed)), completed);
  assert.deepEqual(await f.engine.execute({ type: 'repair-plan', project: 'p', run: reference(failed), maxTurns: 1 }), completed);
  assert.deepEqual(f.store.history(completed.id), revisions);
  assert.deepEqual(f.store.history('graph:p'), graphHistory);
  assert.deepEqual(f.store.list('plan'), plans);
  assert.equal(f.calls().length, calls);
});

test('G1.4 a real repair excludes the first B1 through final plan reissue', async t => {
  const f = executionFixture(t, 'repair');
  const failed = (await f.engine.executor.run('p', reference(f.plan), f.options))[1]!;
  assert.equal(failed.value.state, 'needs_plan');
  const graph = structuredClone(f.plan.value.graphSnapshot); graph.horizon = ['p-consume-work'];
  const check = graph.tests.find(proof => proof.node === 'p-consume-work')!;
  check.covers.push('p-flow');
  check.contract!.counterfactuals.push({ connector: 'p-flow', mutation: 'remove', expectedFailure: 'input_missing',
    command: { executable: process.execPath, args: ['check.mjs', 'consume-mutation'] } });
  writeFileSync(join(f.directory, 'calls.jsonl.repair.json'), JSON.stringify({ design: layerDesignOf(graph, 3, L3_ASSEMBLY) }));
  const other = new Store(f.store.path), writeMany = f.store.writeMany.bind(f.store);
  let attempted = false, callsAtB1 = 0;
  f.store.writeMany = (<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] => {
    if (!attempted && writes.some(write => write.kind === 'plan-reissue')) {
      attempted = true;
      assert.equal(f.store.get<StageArtifact>('stage:p:compilation')!.value.status, 'accepted');
      const before = history(other);
      const result = writeOmInput(other, { project: 'p', expected: 0,
        stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(other.get(`stage:p:${stage}`)!)])) as Record<UpstreamStage, Ref> });
      assert.equal(result.ok, false);
      if (!result.ok) { assert.equal(result.refusal.code, 'legacy_operation_active'); assert.equal(result.refusal.at.target, 'legacy-operation:p'); }
      assert.equal(history(other), before);
      callsAtB1 = f.calls().length;
    }
    return writeMany<T>(writes, guards);
  }) as Store['writeMany'];
  try {
    const result = await f.engine.repairs.run('p', reference(failed), 20);
    assert.ok(attempted, 'The real repair must finish research and compilation before B1 is attempted');
    assert.equal(result.value.phase, 'reissued', result.value.error ?? 'Repair must finish');
    assert.ok(result.value.plan);
    assert.equal(f.store.list('plan-reissue').length, 1);
    assert.equal(f.calls().length, callsAtB1);
    assert.equal(f.store.get('om-input:p'), null);
    assert.equal(f.store.get<{ state: string }>('legacy-operation:p')!.value.state, 'released');
  } finally { f.store.writeMany = writeMany; other.close(); }
  f.reopen(); firstInput(f.store);
});

test('G1.3 an already accepted native plan executes and cold-resumes across B1 without repeated work', async t => {
  const f = executionFixture(t);
  firstInput(f.store);
  let interrupted = false;
  const executor = new Executor(f.store, f.engine.compiler, f.engine.environments, () => {
    if (!interrupted) { interrupted = true; throw new Error('G1.3 crash after exact Git publication'); }
  });
  await assert.rejects(executor.run('p', reference(f.plan), f.options), /G1.3 crash/);
  const pending = f.store.list<TaskRun>('task-run')[0]!;
  assert.equal(pending.value.state, 'commit_pending');
  assert.equal(f.calls().length, 2);
  f.reopen();
  const resumed = await f.engine.execute({ type: 'execute-plan', project: 'p', plan: reference(f.plan), ...f.options }) as Revision<TaskRun>[];
  assert.deepEqual(resumed.map(run => run.value.state), ['committed', 'committed']);
  assert.equal(resumed[0]!.value.commit, pending.value.commit);
  assert.equal(f.calls().length, 4);
  f.reopen();
  const writers = f.store.list('writer-index'), taskRuns = f.store.list('task-run');
  const repeated = await f.engine.execute({ type: 'execute-plan', project: 'p', plan: reference(f.plan), ...f.options }) as Revision<TaskRun>[];
  assert.deepEqual(repeated, resumed);
  assert.equal(f.calls().length, 4);
  assert.deepEqual(f.store.list('writer-index'), writers);
  assert.deepEqual(f.store.list('task-run'), taskRuns);
});

interface M8CommandFixture {
  readonly store: Store;
  readonly project: string;
  readonly feasibility: FeasibilityRequest;
  restart(): void;
}
let m8Fixtures: Promise<{ acceptedWorksFixture(t: TestContext): M8CommandFixture }> | undefined;
function m8CommandFixture(t: TestContext): Promise<M8CommandFixture> {
  m8Fixtures ??= (async () => {
    const url = new URL('./om-feasibility.test.js', import.meta.url), source = readFileSync(url, 'utf8');
    const boundary = source.indexOf('const heads =');
    assert.ok(boundary > 0, 'The real M8 fixture precedes its test registrations');
    const prefix = source.slice(0, boundary).replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
      (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`);
    assert.ok(!/\btest\(/.test(prefix));
    return import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport { acceptedWorksFixture };`).toString('base64')}`);
  })();
  return m8Fixtures.then(fixtures => fixtures.acceptedWorksFixture(t));
}

test('G1.3 actual M8 product commands publish, accept, compile and repeat without a legacy absence guard', async t => {
  const f = await m8CommandFixture(t), { project } = f;
  const saved = writeFeasibility(f.store, f.feasibility);
  if (!saved.ok) assert.fail(`${saved.refusal.code}: ${saved.refusal.message}`);
  assert.equal(saved.value.id, `om-feasibility:${project}`);
  assert.ok(f.store.get(`om-input:${project}`, 1));
  let engine = new ProductEngine(f.store), guardedWrites = 0;
  const writeMany = f.store.writeMany.bind(f.store);
  f.store.writeMany = (<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] => {
    if (writes.some(write => write.kind === 'plan' || write.id === `stage:${project}:om-g2` || write.id === `stage:${project}:compilation`)) {
      guardedWrites++;
      assert.ok(!guards.some(guard => guard.id === `om-input:${project}` && 'absent' in guard), 'The M8 producer must not inherit the closed native producer route');
    }
    return writeMany<T>(writes, guards);
  }) as Store['writeMany'];
  let plan: Revision<MachinePlan>;
  let accepted: Revision<StageArtifact>;
  try {
    const om = engine.execute({ type: 'draft-om', project, feasibility: reference(saved.value), expected: 0 }) as Revision<StageArtifact>;
    engine.execute({ type: 'accept-stage', project, stage: 'om-g2', expected: om.revision });
    plan = engine.execute({ type: 'compile', project }) as Revision<MachinePlan>;
    assert.deepEqual(plan.value.feasibility, reference(saved.value));
    const compilation = f.store.get<StageArtifact>(`stage:${project}:compilation`)!;
    assert.equal(compilation.value.status, 'accepted');
    const draft = engine.execute({ type: 'draft-plan', project, plan: reference(plan), expected: compilation.revision }) as Revision<StageArtifact>;
    accepted = engine.execute({ type: 'accept-stage', project, stage: 'compilation', expected: draft.revision }) as Revision<StageArtifact>;
    assert.equal(accepted.value.status, 'accepted');
    assert.equal(f.store.get(`feasibility:${project}`), null);
    assert.ok(guardedWrites >= 7, 'All public M8-producing transitions reach their real guarded transactions');
  } finally { f.store.writeMany = writeMany; }
  f.restart(); engine = new ProductEngine(f.store);
  const before = history(f.store);
  assert.deepEqual(engine.compiler.read(plan.id), plan);
  assert.deepEqual(engine.execute({ type: 'compile', project }), plan);
  assert.deepEqual(engine.execute({ type: 'accept-stage', project, stage: 'compilation', expected: accepted.revision }), accepted);
  assert.equal(history(f.store), before);
});

const NATIVE_HISTORY_LOADER = String.raw`import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let root,ts;
export async function initialize(data){root=data.root;ts=(await import(data.typescript)).default;}
export async function load(url,context,next){
 const prefix=new URL('dist/',root).href;
 if(url.startsWith(prefix)&&/\.js$/.test(url)){
  const relative=url.slice(prefix.length).replace(/\.js$/,'.ts');
  if(relative.startsWith('src/')||relative.startsWith('test/')){
   const source=execFileSync('git',['show','daa81a530cae8ddcbdaa9098471cf62d2e92a179:'+relative],
    {cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
   return {format:'module',shortCircuit:true,source:ts.transpileModule(source,
    {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};
  }
 }
 return next(url,context);
}`;

test('G1.3 complete daa81a530cae history and new plan era preserve native semantics and exact dependent references', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'omg-g13-base-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const loader = join(directory, 'loader.mjs'), script = join(directory, 'producer.mjs');
  writeFileSync(loader, NATIVE_HISTORY_LOADER);
  writeFileSync(script, `import{copyFileSync,mkdirSync,writeFileSync}from'node:fs';
import{join}from'node:path';import{pathToFileURL}from'node:url';
const repository=process.argv[2],directory=process.argv[3];
const src=path=>pathToFileURL(join(repository,'dist/src',path)).href;
const{Store}=await import(src('storage/store.js'));
const{ProductEngine}=await import(src('product/engine.js'));
const{canonical}=await import(src('canonical.js'));
const{reference}=await import(src('pipeline/contracts.js'));
const{git}=await import(src('runtime/environment.js'));
const{preparedFeatures,refinedLayers}=await import(pathToFileURL(join(repository,'dist/test/product-fixture.js')).href);
const workspace=join(directory,'repo'),original=join(directory,'original.sqlite'),database=join(directory,'comparison.sqlite');
mkdirSync(workspace);git(workspace,['init','-b','main']);
writeFileSync(join(workspace,'README.md'),'A complete native producer compatibility fixture.\\n');
git(workspace,['add','README.md']);
git(workspace,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','initial']);
let store=new Store(original),engine=new ProductEngine(store);
try{
 preparedFeatures(engine,'p');
 const command={executable:process.execPath,args:['--version']};
 engine.environments.configure('p',{workspace,
  implementer:{actor:'author',model:'fixture',effort:'high',command},
  reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:1000},0);
 refinedLayers(engine,'p');const feasibility=engine.refinement.assess('p',0);
 const before=canonical(store.list().flatMap(record=>store.history(record.id)));
 store.close();copyFileSync(original,database);store=new Store(original);engine=new ProductEngine(store);
 const omDraft=engine.refinement.publish('p',reference(feasibility),0);
 const omAccepted=engine.pipeline.accept('p','om-g2',omDraft.revision);
 const plan=engine.compiler.compile('p');
 const planRepeated=engine.compiler.compile('p');
 const compilationDraft=engine.compiler.publish('p',reference(plan),0);
 const compilationAccepted=engine.pipeline.accept('p','compilation',compilationDraft.revision);
 const omRepeated=engine.pipeline.accept('p','om-g2',omAccepted.revision);
 const compilationRepeated=engine.pipeline.accept('p','compilation',compilationAccepted.revision);
 const productRepeated=engine.execute({type:'compile',project:'p'});
 const results={omDraft,omAccepted,plan,planRepeated,compilationDraft,compilationAccepted,omRepeated,compilationRepeated,productRepeated};
 const after=canonical(store.list().flatMap(record=>store.history(record.id)));
 process.stdout.write(JSON.stringify({database,before,results,after}));
}finally{store.close();}
`);
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const bootstrap = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},
{data:{root:${JSON.stringify(pathToFileURL(repository).href)},typescript:${JSON.stringify(typescript)}}});`;
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const raw = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, script, repository, directory],
    { cwd: repository, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 40_000_000 });
  const old = JSON.parse(raw) as { database: string; before: string; results: Record<string, unknown>; after: string };
  let store = new Store(old.database);
  try {
    let engine = new ProductEngine(store);
    assert.equal(store.get('om-input:p'), null);
    assert.equal(history(store), old.before, 'Both producers start from the same saved identities, revisions, environment and repository');
    const feasibility = store.get('feasibility:p')!;
    const omDraft = engine.refinement.publish('p', reference(feasibility), 0);
    const omAccepted = engine.pipeline.accept('p', 'om-g2', omDraft.revision);
    const plan = engine.compiler.compile('p');
    const planRepeated = engine.compiler.compile('p');
    const compilationDraft = engine.compiler.publish('p', reference(plan), 0);
    const compilationAccepted = engine.pipeline.accept('p', 'compilation', compilationDraft.revision);
    const omRepeated = engine.pipeline.accept('p', 'om-g2', omAccepted.revision);
    const compilationRepeated = engine.pipeline.accept('p', 'compilation', compilationAccepted.revision);
    const productRepeated = engine.execute({ type: 'compile', project: 'p' });
    // V3 changes new production's envelope; every other plan field stays equal to the Git producer.
    const oldPlan = old.results['plan'] as Revision<MachinePlan>;
    const { hash: oldHash, ...oldBody } = oldPlan.value;
    const newBody = { ...oldBody, derivation: 'external-inputs/v1' as const };
    const newValue = { ...newBody, hash: hashJson(newBody) };
    const expectedPlan = { ...oldPlan, id: `plan:p:external-inputs-v1:${newValue.hash}`, value: newValue, hash: hashJson(newValue) };
    assert.notEqual(expectedPlan.id, oldPlan.id);
    const expectedHistory = (JSON.parse(old.after) as Revision<any>[]).map(row => {
      if (row.id === oldPlan.id) return expectedPlan;
      if (row.id === 'current-plan:p') {
        assert.deepEqual(row.value, reference(oldPlan));
        const value = reference(expectedPlan); return { ...row, value, hash: hashJson(value) };
      }
      if (row.id === 'stage:p:compilation') {
        assert.deepEqual(row.value.content, { plan: reference(oldPlan) });
        const value = { ...row.value, content: { plan: reference(expectedPlan) },
          proofs: row.value.proofs.map((ref: Ref) => canonical(ref) === canonical(reference(oldPlan)) ? reference(expectedPlan) : ref) };
        return { ...row, value, hash: hashJson(value) };
      }
      return row;
    }).sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
    assert.deepEqual({ omDraft, omAccepted, plan, planRepeated, compilationDraft, compilationAccepted, omRepeated, compilationRepeated, productRepeated },
      { ...old.results, plan: expectedPlan, planRepeated: expectedPlan, productRepeated: expectedPlan,
        compilationDraft: expectedHistory.find(row => row.id === compilationDraft.id && row.revision === compilationDraft.revision),
        compilationAccepted: expectedHistory.find(row => row.id === compilationAccepted.id && row.revision === compilationAccepted.revision),
        compilationRepeated: expectedHistory.find(row => row.id === compilationRepeated.id && row.revision === compilationRepeated.revision) });
    const exactHistory = () => canonical(store.list().flatMap(row => store.history(row.id))
      .sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision));
    assert.equal(exactHistory(), canonical(expectedHistory), 'Only the plan envelope and its declared dependent references change');
    store.close(); store = new Store(old.database); engine = new ProductEngine(store);
    assert.deepEqual(engine.compiler.read(plan.id), expectedPlan);
    assert.equal(engine.pipeline.inspect('p', 'compilation').state, 'accepted');
    assert.equal(exactHistory(), canonical(expectedHistory));
    assert.equal(store.get('om-input:p'), null);
  } finally { store.close(); }
});

// ---- S1.5 (№2363): the search for saved OM provenance of a project without its first B1 ----

/** Two bare projects in one Store: the era question is asked of 'p', 'q' is the foreign neighbour. */
function provenanceFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'omg-s15-provenance-')), database = join(directory, 'state.sqlite');
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const project of ['p', 'q']) engine.execute({ type: 'create-project', project, title: project });
  return { database, get store() { return store; }, get engine() { return engine; },
    reopen() { store.close(); store = new Store(database); engine = new ProductEngine(store); } };
}
/** G7: the same provenance predicate now refuses at the fsck/start boundary. */
function refusesProvenance(engine: ProductEngine, project = 'p') {
  assert.equal(engine.legacyRoute(project).om, false);
  const result = runIntegrityCheck(engine.store, { project }); assert.ok(result.ok);
  assert.ok(result.value.value.findings.some(f => f.code === 'record_missing' && f.id === `om-input:${project}` && f.revision === 1));
  assert.equal(integrityGate(engine.store, project)?.ok, false);
}
const stillLegacy = (engine: ProductEngine, project = 'p') => {
  assert.deepEqual(engine.legacyRoute(project), { om: false, guards: [{ id: `om-input:${project}`, absent: true }] });
  const report = runIntegrityCheck(engine.store, { project }); assert.ok(report.ok);
  assert.ok(!report.value.value.findings.some(f => f.code === 'record_missing' && f.id === `om-input:${project}`));
};

/** One record per class of the provenance table (and of its negatives), written without a first B1 of 'p'. */
const PROVENANCE_ROWS: { name: string; row: { id: string; kind: string; value: unknown }; refused: boolean; refusedQ?: boolean }[] = [
  { name: 'a fixed B1 address', row: { id: 'om-feasibility:p', kind: 'om-feasibility', value: {} }, refused: true },
  { name: 'a B1 producer address', row: { id: 'om-horizon:p:h1', kind: 'om-horizon', value: { any: 'body' } }, refused: true },
  { name: 'an OM frame address', row: { id: 'om-frame:p:2', kind: 'om-frame', value: {} }, refused: true },
  { name: 'a part proposal address', row: { id: 'om-proposal:p:part:x', kind: 'om-proposal', value: {} }, refused: true },
  { name: 'the mechanism series address', row: { id: 'repair-series:p:mechanism:1', kind: 'repair-series', value: {} }, refused: true },
  { name: 'a declared reference path (graph-layer acceptance.frame)', row: { id: 'graph-layer:p:1', kind: 'graph-layer',
    value: { acceptance: { frame: { id: 'om-frame:p:2', revision: 1, hash: 'f' } } } }, refused: true },
  { name: 'a declared source path (om-unit-refusal origin.sources ref)', row: { id: 'om-unit-refusal:p:u1', kind: 'om-unit-refusal',
    value: { refusals: [{ origin: { sources: [{ ref: { id: 'om-input:p', revision: 1, hash: 'i' } }] } }] } }, refused: true },
  { name: 'a declared owner path (the M5 mechanism)', row: { id: 'om-owner-decision:p:d1', kind: 'om-owner-decision',
    value: { owner: { kind: 'mechanism', mechanism: 'M5:addressing' } } }, refused: true },
  { name: 'an OM model call with a B1 draft', row: { id: 'model-call:p:om:c1', kind: 'model-call', value: { draftId: 'om-input:p' } }, refused: true },
  { name: 'a research model call with the same body', row: { id: 'model-call:p:research:c2', kind: 'model-call', value: { draftId: 'om-input:p' } }, refused: false },
  { name: 'the om-g2 stage bound to the OM feasibility', row: { id: 'stage:p:om-g2', kind: 'stage',
    value: { content: { feasibility: { id: 'om-feasibility:p', revision: 1, hash: 'f' } } } }, refused: true },
  { name: 'an upstream stage drafted from a B1 producer', row: { id: 'stage:p:discovery', kind: 'stage',
    value: { content: { draft: { id: 'om-horizon:p:x', revision: 1, hash: 'h' } } } }, refused: true },
  { name: 'the OM writer index, owned through its body', row: { id: 'writer-index:any-address', kind: 'writer-index',
    value: { project: 'p', contract: 'writer-index/om-m8-v1' } }, refused: true },
  { name: "another project's OM writer index", row: { id: 'writer-index:other', kind: 'writer-index',
    value: { project: 'q', contract: 'writer-index/om-m8-v1' } }, refused: false, refusedQ: true },
  { name: 'a managed repair series by its contract', row: { id: 'repair-series:p:1:garden-block', kind: 'repair-series', value: { contract: 'om-repair-series/v2' } }, refused: true },
  { name: 'a legacy repair series', row: { id: 'repair-series:p:1:other-block', kind: 'repair-series', value: { attempts: [] } }, refused: false },
  { name: 'a transition-managed membership', row: { id: 'om-series-membership:p', kind: 'om-series-membership', value: { mode: 'transition-managed' } }, refused: true },
  { name: 'a legacy membership', row: { id: 'om-series-membership:p', kind: 'om-series-membership', value: { mode: 'legacy' } }, refused: false },
  { name: 'a runtime observation owned through its body', row: { id: 'runtime-observation:host:1', kind: 'runtime-observation',
    value: { projectId: 'p', scope: { id: 'om-input:p', revision: 1, hash: 'i' } } }, refused: true },
  { name: "another project's runtime observation with the same scope", row: { id: 'runtime-observation:host:2', kind: 'runtime-observation',
    value: { projectId: 'q', scope: { id: 'om-input:p', revision: 1, hash: 'i' } } }, refused: false },
  { name: "another project's producer address", row: { id: 'om-horizon:q:h1', kind: 'om-horizon', value: {} }, refused: false, refusedQ: true },
  { name: 'an incomplete body: a runtime observation without its project', row: { id: 'runtime-observation:host:3', kind: 'runtime-observation',
    value: { scope: { id: 'om-input:p', revision: 1, hash: 'i' } } }, refused: false },
  { name: 'an incomplete body: a series that is no object', row: { id: 'repair-series:p:1:text-block', kind: 'repair-series', value: 'text' }, refused: false },
  { name: 'a namespace outside the table, whatever its body says', row: { id: 'research-context:p:x', kind: 'research-context',
    value: { inputs: [{ id: 'om-input:p', revision: 1, hash: 'i' }], draft: { id: 'om-horizon:p:x' } } }, refused: false },
  { name: 'a foreign namespace carrying a table kind', row: { id: 'custom:p:1', kind: 'repair-series', value: { contract: 'om-repair-series/v2' } }, refused: false },
];

test('S1.5 №2363 without a first B1 the saved provenance is found in every class of the producer table and nowhere else: fixed and producer addresses, declared reference, source and owner paths, the model-call, stage, writer-index, repair-series and membership rules, bodies that claim the project — never foreign projects, incomplete bodies or namespaces outside the table; a cold reopening agrees', t => {
  for (const { name, row, refused, refusedQ } of PROVENANCE_ROWS) {
    const f = provenanceFixture(t);
    stillLegacy(f.engine); stillLegacy(f.engine, 'q');
    f.store.write({ ...row, expected: 0 } as Write);
    for (const pass of [0, 1]) {
      if (pass) f.reopen();
      if (refused) refusesProvenance(f.engine); else stillLegacy(f.engine);
      if (refusedQ) refusesProvenance(f.engine, 'q'); else stillLegacy(f.engine, 'q');
      assert.ok(true, name);
    }
  }
});

test('S1.5 №2363 provenance left only in an old revision is still found through the history: a membership that became legacy, and a writer index whose head now names another project', t => {
  const f = provenanceFixture(t);
  f.store.write({ id: 'om-series-membership:p', kind: 'om-series-membership', expected: 0, value: { mode: 'transition-managed' } });
  f.store.write({ id: 'om-series-membership:p', kind: 'om-series-membership', expected: 1, value: { mode: 'legacy' } });
  refusesProvenance(f.engine);
  f.reopen(); refusesProvenance(f.engine);
  const g = provenanceFixture(t);
  g.store.write({ id: 'writer-index:w', kind: 'writer-index', expected: 0, value: { project: 'p', contract: 'writer-index/om-m8-v1' } });
  g.store.write({ id: 'writer-index:w', kind: 'writer-index', expected: 1, value: { project: 'q', contract: 'other' } });
  refusesProvenance(g.engine); stillLegacy(g.engine, 'q');
  g.reopen(); refusesProvenance(g.engine); stillLegacy(g.engine, 'q');
});

test('S1.5 №2363 a corrupt record surfaces when it is a candidate of the search and is no longer read when its namespace lies outside the table', t => {
  const f = provenanceFixture(t);
  // A row the Store never wrote: its checksum does not match its body, so decoding it is an integrity refusal.
  const corrupt = (id: string, kind: string) => {
    const raw = new DatabaseSync(f.database);
    try {
      raw.prepare('INSERT INTO revisions(entity_id, revision, kind, body, sha256) VALUES (?, 1, ?, ?, ?)').run(id, kind, '{}', 'f'.repeat(64));
      raw.prepare('INSERT INTO heads(entity_id, revision) VALUES (?, 1)').run(id);
    } finally { raw.close(); }
  };
  corrupt('research-context:p:broken', 'research-context');
  stillLegacy(f.engine);
  f.reopen(); stillLegacy(f.engine);
  corrupt('om-horizon:p:broken', 'om-horizon');
  // NR1 (№3591/№3646): a read takes the body as written; a row the Store never wrote is found by om-fsck at its address.
  const corrupted = () => checkStoreIntegrity(f.store).findings.filter(item => item.code === 'revision_corrupt').map(item => item.id).sort();
  assert.deepEqual(corrupted(), ['om-horizon:p:broken', 'research-context:p:broken']);
  f.reopen(); assert.deepEqual(corrupted(), ['om-horizon:p:broken', 'research-context:p:broken']);
});
