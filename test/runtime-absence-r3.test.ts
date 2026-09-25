import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical } from '../src/canonical.js';
import type { GateResult, StageArtifact, StageProjection } from '../src/pipeline/contracts.js';
import type { Phase } from '../src/graph/refinement.js';
import { Pipeline } from '../src/pipeline/pipeline.js';
import { EngineError } from '../src/errors.js';
import { UPSTREAM_STAGES } from '../src/discovery/requirements.js';
import { readOmAdmissionGuards, writeOmInput, prepareOmInput, type InputRequest } from '../src/om/input.js';
import { writeHorizon, prepareHorizon, type HorizonRequest } from '../src/om/horizon.js';
import { prepareLayerAcceptance, prepareFrame, type FrameRequest } from '../src/om/frame-obligations.js';
import type { OmResult } from '../src/om/refusal.js';
import type { FixtureLayer } from './om-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Revision, type Write, type TransactionGuard } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { Environments, git, uniqueTransactionGuards, transactionGuardsCurrent } from '../src/runtime/environment.js';
import { reference, isRef } from '../src/pipeline/contracts.js';
import { preparedFeatures } from './product-fixture.js';
import { answerTechnicalFixture } from './technical-research-fixture.js';
import { deriveLayerFixture } from './layer-design-fixture.js';
import { configureResearchScope } from '../src/graph/research-scope.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import type { ObligationPolicy, RuntimeCheck } from '../src/graph/obligation-policy.js';
import { runtimeContext, type RuntimeObservationResult } from '../src/runtime/runtime-observation.js';
import { Refinement, type Feasibility } from '../src/graph/refinement.js';
import { obligationHandoff } from '../src/graph/obligation-handoff.js';
import { taskBindingId } from '../src/graph/task-obligations.js';
import type { Graph } from '../src/graph/model.js';
import type { MachinePlan } from '../src/compiler/model.js';
import { ensureWorktree } from '../src/execution/worktree.js';

function fixture(t: test.TestContext, { exit = 0, certifies = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-readiness-'))), workspace = join(root, 'repo'); mkdirSync(workspace);
  git(workspace, ['init', '-b', 'main']); writeFileSync(join(workspace, 'README.md'), 'Fixture baseline\n');
  git(workspace, ['add', '.']); git(workspace, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline']);
  const store = new Store(join(root, 'db.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  preparedFeatures(engine, 'p');
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = engine.environments.configure('p', { workspace, implementer: { actor: 'worker', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 3000 }, 0);
  const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0); engine.refinement.sealLayer('p', 1, 0);
  const gaps = [{ id: 'runtime-ready', target: 'p-produce-block', consumer: 'compilation', field: 'tests', requiredFor: 'next' as const, question: 'Check the exact local fixture runtime before R3' },
    { id: 'future-result', target: 'p-consume-block', consumer: 'compilation', field: 'tests', requiredFor: 'next' as const, question: 'Accept the future implementation only with its actual result' }];
  const r1 = engine.refinement.begin('p', 'R1');
  answerTechnicalFixture(engine, 'p', r1, (field, report) => field === 'runtime' ? { ...report, gaps } : report);
  const r1Phase = engine.refinement.finishResearch('p', 'R1', reference(store.get(r1.id)!), 0);
  deriveLayerFixture(engine, 'p', 2); engine.refinement.sealLayer('p', 2, 0);
  const original = configureResearchScope(store, { projectId: 'p', layer: reference(store.get('graph-layer:p:2')!), r1: reference(r1Phase),
    outcome: 'A bounded local fixture', nodes: gaps.map(gap => gap.target), boundaries: [], expansions: [], changedPaths: [], uiRequired: false,
    obligations: gaps.map(gap => ({ gap, state: 'active', reason: 'Approved fixture scope', wake: null })) }, 0);
  const condition = 'Before R3, verify the declared local fixture invocation succeeds';
  const code = engine.discovery.evidence.document('p', 'readiness-check',
    `import{readFileSync}from'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({fixture:true,obligation:input.obligation,root:input.runtime.root}));process.exitCode=${exit};`, 'text/plain', 0);
  const check: RuntimeCheck = { script: reference(code), dependencies: [], subjects: [], executables: [], args: [], timeoutMs: 3000,
    purpose: 'Check a local fixture, not the actual Codex runtime', ...(certifies ? { satisfies: condition } : {}) };
  const policy: ObligationPolicy = { version: 1, sourceScope: reference(original), assignments: gaps.map((gap, index) => ({
    obligation: gap.id, original: { record: reference(original), pointer: `/obligations/${index}/gap` },
    kind: index === 0 ? 'environment-confirmation' : 'post-implementation-proof', moment: index === 0 ? 'R3' : 'task-result',
    responsibleNode: gap.target, responsibleConsumer: gap.consumer, neededForR2: false, reason: 'The R2 design does not depend on an executed result',
    returnCondition: index === 0 ? condition : 'When accepting the generated consumer task, check the real output', ...(index === 0 ? { runtimeCheck: check } : {}) })) };
  const scope = configureResearchScope(store, { ...original.value, policy }, 1);
  const r2 = engine.refinement.begin('p', 'R2'); answerTechnicalFixture(engine, 'p', r2);
  const r2Phase = engine.refinement.finishResearch('p', 'R2', reference(store.get(r2.id)!), 0);
  // New L3 assigns the future proof to concrete work/tests. It still does not
  // require the implementation result before compiling the plan that assigns it.
  const carried = obligationHandoff(store, 'p', [reference(r2Phase)])!.obligations.find(item => item.obligation === 'future-result')!;
  const graph = store.get<Graph>('graph:p')!;
  engine.graphs.save('p', { ...graph.value, researchObligations: [{ id: taskBindingId(carried), scope: carried.scope,
    obligation: carried.obligation, consumers: [{ node: 'p-consume-work', tests: ['p-consume-work-test'] }] }] }, graph.revision, 'fixture');
  deriveLayerFixture(engine, 'p', 3); const l3 = engine.refinement.sealLayer('p', 3, 0);
  const observe = (key = 'ready') => engine.execute({ type: 'observe-runtime', project: 'p', scope: reference(scope), obligation: 'runtime-ready', key }) as Promise<RuntimeObservationResult>;
  const assess = () => engine.refinement.assess('p', store.get('feasibility:p')?.revision ?? 0);
  const gate = (record: Revision<Feasibility>) => engine.refinement.feasibilityGate('p', reference(record));
  return { root, workspace, store, engine, environment, scope, original, policy, code, check, r2Phase, l3, observe, assess, gate };
}


type Fixture = ReturnType<typeof fixture>;
type Dependency = 'reader-pilot' | 'execution-root';
function creator(f: Fixture, dependency: Dependency) {
  return () => {
    const second = new Store(f.store.path), environments = new Environments(second);
    try {
      if (dependency === 'reader-pilot') {
        const before = runtimeContext(f.store, 'p').binding, command = { executable: process.execPath, args: ['--version'] };
        configureReaderPilot(second, environments, 'p', { experimental: true, active: false, stopAfter: 'L2',
          reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
          maxRequestChars: 300000, maxReadChars: 60000, maxReplyChars: 100000, maxCalls: 100, maxReportedTokens: 20000000 }, 0);
        assert.deepEqual(runtimeContext(f.store, 'p').binding, before, 'The inactive pilot changes only the admission dependency');
      } else {
        ensureWorktree(second, environments, { projectId: 'p', base: { root: f.workspace,
          head: git(f.workspace, ['rev-parse', 'HEAD']) } } as MachinePlan);
      }
      assert.ok(second.get(`${dependency}:p`));
    } finally { second.close(); }
  };
}
async function readyFixture(t: test.TestContext, stage: 'runtime' | 'feasibility' | 'draft' | 'accepted' | 'plan' = 'plan') {
  const f = fixture(t); assert.equal((await f.observe()).observation.value.status, 'observed');
  if (stage === 'runtime') return { ...f, ready: null, draft: null, plan: null };
  const ready = f.assess(); assert.equal(ready.value.ready, true);
  assert.ok(ready.value.inputs.every(isRef));
  if (stage === 'feasibility') return { ...f, ready, draft: null, plan: null };
  const draft = f.engine.refinement.publish('p', reference(ready), 0);
  if (stage === 'draft') return { ...f, ready, draft, plan: null };
  f.engine.pipeline.accept('p', 'om-g2', draft.revision);
  if (stage === 'accepted') return { ...f, ready, draft, plan: null };
  const plan = f.engine.compiler.compile('p'); assert.ok(plan.value.guards.every(isRef));
  return { ...f, ready, draft, plan };
}

function transactionRace(f: Fixture, dependency: Dependency, matches: (write: Write) => boolean) {
  const original = f.store.writeMany.bind(f.store), create = creator(f, dependency);
  const neighbors = ['one', 'two'].map(part => ({ id: `d81-neighbor:${part}`, kind: 'd81-neighbor', expected: 0, value: { part } }));
  let raced = false; let writes: Write[] = [];
  f.store.writeMany = ((batch: Write[], guards: TransactionGuard[] = []) => {
    if (!raced && batch.some(matches)) {
      raced = true; writes = batch;
      assert.ok(guards.some(guard => guard.id === `${dependency}:p` && 'absent' in guard), 'The original absence reaches the real transaction');
      create();
      return original([...batch, ...neighbors], guards);
    }
    return original(batch, guards);
  }) as Store['writeMany'];
  return { restore: () => { f.store.writeMany = original; }, check() {
    assert.equal(raced, true);
    for (const write of [...writes, ...neighbors]) {
      assert.equal(f.store.get(write.id)?.revision ?? 0, write.expected, `No partial write of ${write.id}`);
      assert.equal(f.store.history(write.id).length, write.expected);
    }
  } };
}

function scanRace(f: Fixture, dependency: Dependency) {
  const original = f.store.list.bind(f.store), create = creator(f, dependency); let raced = false;
  f.store.list = <T>(kind?: string): Revision<T>[] => {
    const snapshot = original<T>(kind);
    if (!raced && kind === 'runtime-observation') { raced = true; create(); }
    return snapshot;
  };
  return { restore() { f.store.list = original; }, check() { assert.equal(raced, true); } };
}

test('D8.1 native absent dependency creation aborts every R3 pipeline and compiler transaction atomically', async t => {
  for (const dependency of ['reader-pilot', 'execution-root'] as const) for (const route of ['assess', 'publish-r3', 'draft', 'accept', 'compile', 'publish-plan'] as const) {
    const initial = { assess: 'runtime', 'publish-r3': 'feasibility', draft: 'feasibility', accept: 'draft', compile: 'accepted', 'publish-plan': 'plan' } as const;
    const f = await readyFixture(t, initial[route]);
    const match = (write: Write) => route === 'assess' ? write.kind === 'feasibility' : route === 'compile' ? write.kind === 'plan'
      : write.kind === 'stage' && write.id === `stage:p:${route === 'publish-plan' ? 'compilation' : 'om-g2'}`;
    const checked = route === 'draft' ? f.gate(f.ready!) : null;
    const race = transactionRace(f, dependency, match);
    try {
      assert.throws(() => {
        if (route === 'assess') return f.assess();
        if (route === 'publish-r3') return f.engine.refinement.publish('p', reference(f.ready!), 0);
        if (route === 'draft') return f.engine.pipeline.draft('p', 'om-g2', { feasibility: { ...reference(f.ready!) } }, 0,
          uniqueTransactionGuards([...checked!.guards, ...(checked!.admissionGuards ?? [])]));
        if (route === 'accept') return f.engine.pipeline.accept('p', 'om-g2', f.draft!.revision);
        if (route === 'compile') return f.engine.compiler.compile('p');
        return f.engine.compiler.publish('p', reference(f.plan!), 0);
      }, { code: 'input_stale' }, `${dependency}/${route}`);
    } finally { race.restore(); }
    race.check();
    assert.equal(f.store.list('model-call').length, 0);
    assert.equal(f.store.list('task-run').length, 0);
  }
});

test('D8.1 current R3 pipeline and compiler predicates see native creation inside the confirmation scan', async t => {
  for (const dependency of ['reader-pilot', 'execution-root'] as const) for (const route of ['assess', 'feasibility-gate', 'inspect', 'compiler-gate'] as const) {
    const f = await readyFixture(t, route === 'assess' ? 'runtime' : 'plan'), race = scanRace(f, dependency);
    try {
      if (route === 'assess') {
        if (dependency === 'execution-root') {
          assert.throws(() => f.assess(), { code: 'input_stale' });
          assert.equal(f.store.get('feasibility:p'), null);
        } else assert.equal(f.assess().value.ready, false);
      }
      else if (route === 'feasibility-gate') assert.ok(f.gate(f.ready!).findings.length);
      else if (route === 'inspect') assert.equal(f.engine.pipeline.inspect('p', 'om-g2').state, 'stale');
      else assert.ok(f.engine.compiler.gate('p', reference(f.plan!)).findings.length);
    } finally { race.restore(); }
    race.check();
  }
});

test('D8.1 an existing compilation and context read recheck the original absent guard before returning', async t => {
  for (const dependency of ['reader-pilot', 'execution-root'] as const) for (const route of ['existing', 'context', 'detail'] as const) {
    const f = await readyFixture(t), create = creator(f, dependency); let raced = false;
    const originalGet = f.store.get.bind(f.store), originalGate = f.engine.compiler.gate.bind(f.engine.compiler);
    if (route === 'existing') f.store.get = (<T>(id: string, revision?: number): Revision<T> | null => {
      const record = originalGet<T>(id, revision);
      if (!raced && id === f.plan!.id && revision === undefined) { raced = true; create(); }
      return record;
    }) as Store['get'];
    else f.engine.compiler.gate = (...args) => {
      const checked = originalGate(...args);
      if (!raced && checked.findings.length === 0) { raced = true; create(); }
      return checked;
    };
    try {
      assert.throws(() => route === 'existing' ? f.engine.compiler.compile('p') : route === 'context'
        ? f.engine.compiler.context('p', reference(f.plan!), f.plan!.value.tasks[0]!.id, 100000)
        : f.engine.compiler.detail('p', reference(f.plan!), f.plan!.value.tasks[0]!.id, 'evidence-index', { id: '', pointer: '', start: null, end: null }, 100000), { code: 'plan_stale' });
    } finally { f.store.get = originalGet; f.engine.compiler.gate = originalGate; }
    assert.equal(raced, true);
    assert.deepEqual(f.store.get(f.plan!.id), f.plan);
  }
});

test('D8.1 returned admissions remain distinct from saved feasibility stage and plan proof sets', async t => {
  const f = await readyFixture(t), stage = f.engine.pipeline.inspect('p', 'om-g2'), gate = f.engine.compiler.gate('p', reference(f.plan!));
  const expected = [{ id: 'execution-root:p', absent: true }, { id: 'reader-pilot:p', absent: true }];
  for (const checked of [f.gate(f.ready!), stage, gate]) {
    assert.deepEqual(checked.admissionGuards!.filter(guard => 'absent' in guard), expected);
    assert.equal(transactionGuardsCurrent(f.store, [...checked.guards, ...checked.admissionGuards!]), true);
    assert.ok(checked.guards.every(isRef));
  }
  assert.ok(f.ready!.value.inputs.every(isRef)); assert.ok(f.plan!.value.guards.every(isRef));
  assert.ok(stage.artifact!.value.inputs.every(isRef)); assert.ok(stage.artifact!.value.proofs.every(isRef));
  const projection = f.engine.projection('p');
  const json = JSON.parse(JSON.stringify(projection));
  assert.deepEqual(json.stages.find((item: { stage: string }) => item.stage === 'om-g2').admissionGuards.filter((guard: TransactionGuard) => 'absent' in guard), expected);
});


test('D8.1 reads unchanged feasibility milestones stages and MachinePlan produced by the complete 3d8dcfd engine after restart', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d81-history-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const loader = join(directory, 'base-loader.mjs'), producer = join(directory, 'base-producer.mjs');
  writeFileSync(loader, D81_HISTORY_LOADER);
  // Reuse the two actual fixture functions above. Importing this test module would
  // register its tests, so only their compiled function bodies enter the producer.
  writeFileSync(producer, `import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const repository=process.argv[2],src=path=>pathToFileURL(join(repository,'dist/src',path)).href,
 helpers=path=>pathToFileURL(join(repository,'dist/test',path)).href;
const {Store}=await import(src('storage/store.js'));
const {ProductEngine}=await import(src('product/engine.js'));
const {git}=await import(src('runtime/environment.js'));
const {reference,isRef}=await import(src('pipeline/contracts.js'));
const {canonical}=await import(src('canonical.js'));
const {preparedFeatures}=await import(helpers('product-fixture.js'));
const {answerTechnicalFixture}=await import(helpers('technical-research-fixture.js'));
const {deriveLayerFixture}=await import(helpers('layer-design-fixture.js'));
const {configureResearchScope}=await import(src('graph/research-scope.js'));
const {obligationHandoff}=await import(src('graph/obligation-handoff.js'));
const {taskBindingId}=await import(src('graph/task-obligations.js'));
${fixture.toString()}
${readyFixture.toString()}
const cleanup=[];
try {
 const f=await readyFixture({after:fn=>cleanup.push(fn)}),project='p';
 const published=f.engine.compiler.publish(project,reference(f.plan),0);
 f.engine.pipeline.accept(project,'compilation',published.revision);
 const phases=f.store.list('phase'),stages=f.store.list('stage');
 const checks={feasibility:f.engine.refinement.feasibilityGate(project,reference(f.ready)),
  phases:phases.map(record=>({phase:record.value.phase,gate:f.engine.refinement.gate(project,record.value.phase)})),
  om:f.engine.pipeline.inspect(project,'om-g2'),compilation:f.engine.pipeline.inspect(project,'compilation'),
  plan:f.engine.compiler.gate(project,reference(f.plan))};
 assert.equal(checks.feasibility.findings.length,0);assert.equal(checks.plan.findings.length,0);
 assert.equal(checks.om.state,'accepted');assert.equal(checks.compilation.state,'accepted');
 assert.equal(f.store.get('reader-pilot:p'),null);assert.equal(f.store.get('execution-root:p'),null);
 const historyBytes=canonical(f.store.list().flatMap(record=>f.store.history(record.id)));
 const result={root:f.root,database:f.store.path,project,ready:f.ready,plan:f.plan,phases,stages,checks,historyBytes};
 f.store.close();process.stdout.write(JSON.stringify(result));
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
    root: string; database: string; project: string; ready: Revision<Feasibility>; plan: Revision<MachinePlan>;
    phases: Revision<{ phase: Phase; inputs: import('../src/pipeline/contracts.js').Ref[] }>[];
    stages: Revision<StageArtifact>[]; historyBytes: string;
    checks: { feasibility: GateResult; phases: { phase: Phase; gate: GateResult }[];
      om: StageProjection; compilation: StageProjection; plan: GateResult };
  };
  t.after(() => rmSync(old.root, { recursive: true, force: true }));
  assert.ok(old.phases.some(record => record.value.phase === 'L3'));
  assert.ok(old.stages.some(record => record.value.stage === 'compilation' && record.value.status === 'accepted'));
  assert.ok(old.ready.value.obligations?.confirmations.length);
  assert.ok(old.plan.value.guards.length);
  const positiveAdmission = <T extends { admissionGuards?: TransactionGuard[] }>(value: T) => {
    const { admissionGuards, ...rest } = value;
    const positive = admissionGuards?.filter(isRef) ?? [];
    return { ...rest, ...(positive.length ? { admissionGuards: positive } : {}) };
  };
  const expectedAbsent = [{ id: 'execution-root:p', absent: true }, { id: 'reader-pilot:p', absent: true }];
  for (let restart = 0; restart < 2; restart++) {
    const store = new Store(old.database), engine = new ProductEngine(store);
    try {
      // Exact complete rows compare all inputs/proofs/content, order, stored values
      // and store hashes. MachinePlan also includes its independent inner hash.
      assert.deepEqual(store.get(old.ready.id, old.ready.revision), old.ready);
      for (const row of [...old.phases, ...old.stages]) assert.deepEqual(store.get(row.id, row.revision), row);
      assert.deepEqual(engine.compiler.read(old.plan.id), old.plan);
      assert.deepEqual(engine.compiler.compile(old.project), old.plan, 'The same current compilation is an exact non-writing repeat');
      const checks = { feasibility: engine.refinement.feasibilityGate(old.project, reference(old.ready)),
        phases: old.phases.map(record => ({ phase: record.value.phase, gate: engine.refinement.gate(old.project, record.value.phase) })),
        om: engine.pipeline.inspect(old.project, 'om-g2'), compilation: engine.pipeline.inspect(old.project, 'compilation'),
        plan: engine.compiler.gate(old.project, reference(old.plan)) };
      for (const key of ['feasibility', 'om', 'compilation', 'plan'] as const) {
        assert.deepEqual(positiveAdmission(checks[key]), positiveAdmission(old.checks[key]), `Positive DTO fields retain their old contract: ${key}`);
        assert.deepEqual(checks[key].admissionGuards?.filter(guard => 'absent' in guard), expectedAbsent,
          `The new absence channel is returned separately: ${key}`);
        assert.equal(transactionGuardsCurrent(store, [...checks[key].guards, ...(checks[key].admissionGuards ?? [])]), true);
      }
      assert.deepEqual(checks.phases.map(item => ({ ...item, gate: positiveAdmission(item.gate) })),
        old.checks.phases.map(item => ({ ...item, gate: positiveAdmission(item.gate) })));
      assert.ok(old.ready.value.inputs.every(isRef)); assert.ok(old.plan.value.guards.every(isRef));
      assert.ok(old.phases.every(row => row.value.inputs.every(isRef)));
      assert.ok(old.stages.every(row => row.value.inputs.every(isRef) && row.value.proofs.every(isRef)));
      assert.equal(canonical(store.list().flatMap(record => store.history(record.id))), old.historyBytes,
        'Neither historical reading nor exact compilation repeat rewrites any saved byte or creates a revision');
    } finally { store.close(); }
  }
});

const D81_HISTORY_LOADER = String.raw`import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let root,ts;
export async function initialize(data){root=data.root;ts=(await import(data.typescript)).default;}
export async function load(url,context,next){
 const prefix=new URL('dist/',root).href;
 if(url.startsWith(prefix)&&/\.js$/.test(url)){
  const relative=url.slice(prefix.length).replace(/\.js$/,'.ts');
  // Every production dependency is the actual base producer; its existing helper
  // modules are taken from that same base, with no fallback to current sources.
  if(relative.startsWith('src/')||relative.startsWith('test/')){
   const source=execFileSync('git',['show','3d8dcfd7b64404ed73b368812a39dd8062c53884:'+relative],
    {cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
   return {format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};
  }
 }
 return next(url,context);
}
`;


function omValue<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}

test('D8.1 native OM gates have no absence channel and all four bridge entrances reject unsupported or malformed channels', async t => {
  const f = fixture(t), project = 'p', graph = reference(f.store.get<Graph>('graph:p')!);
  const layers = { 2: f.store.get<FixtureLayer>('graph-layer:p:2')!, 3: f.store.get<FixtureLayer>('graph-layer:p:3')! };
  const inputRequest: InputRequest = { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.store.get(`stage:${project}:${stage}`)!)])) as InputRequest['stages'] };
  const input = omValue(writeOmInput(f.store, inputRequest));
  inputRequest.expected = input.revision;
  const horizonRequest: HorizonRequest = { project, input: reference(input), graph,
    refinement: reference(f.store.get(`phase:${project}:L2`)!),
    choice: { choiceVersion: 'd81-bridge', features: [{ outcome: `${project}-result` }], excluded: [] }, available: {} };
  const horizon = omValue(writeHorizon(f.store, horizonRequest)), horizonRef = reference(horizon.gate);
  const layerRequest = { project, graph, level: 2 as const, layer: reference(layers[2]) };
  const frameRequest: FrameRequest = { project, graph, level: 3, layer: reference(layers[3]), horizon: horizonRef,
    frame: null, upper: { horizon: horizonRef, frame: null } };
  assert.equal(f.store.get(`reader-pilot:${project}`), null);
  assert.equal(f.store.get(`execution-root:${project}`), null);
  for (const gate of [f.engine.pipeline.inspect(project, 'features'), f.engine.refinement.gate(project, 'L2'),
    f.engine.refinement.gate(project, 'R1'), f.engine.refinement.gate(project, 'R2'),
    f.engine.graphs.layerGate(project, 2), f.engine.graphs.layerGate(project, 3)]) {
    assert.equal(gate.findings.length, 0);
    assert.deepEqual((gate.admissionGuards ?? []).filter(guard => 'absent' in guard), []);
  }
  const positive = reference(f.store.write({ id: 'd81-bridge-positive', kind: 'fixture', expected: 0, value: { project } }));
  const second = reference(f.store.write({ id: 'd81-bridge-second', kind: 'fixture', expected: 0, value: { project } }));
  const absent = { id: positive.id, absent: true };
  const before = f.store.list().map(reference);
  const routes: Record<string, () => OmResult<{ readonly guards: readonly TransactionGuard[] }>> = {
    input: () => prepareOmInput(f.store, inputRequest),
    horizon: () => prepareHorizon(f.store, horizonRequest),
    layer: () => prepareLayerAcceptance(f.store, layerRequest),
    frame: () => prepareFrame(f.store, frameRequest),
  };
  for (const [route, prepare] of Object.entries(routes)) {
    const native = omValue(prepare());
    const channels = [undefined, [], [second, positive], [absent], [positive, absent], [absent, positive],
      null, {}, [null], [{ ...positive, absent: true }], [{ id: positive.id, absent: false }], new Array(1)];
    for (const channel of channels) {
      let hits = 0, gateDepth = 0;
      const change = <T extends GateResult>(checked: T): T => {
        hits++; return { ...checked, admissionGuards: channel } as T;
      };
      const nativeInspect = Pipeline.prototype.inspect, nativeGate = Refinement.prototype.gate;
      const spy = route === 'input'
        ? t.mock.method(Pipeline.prototype, 'inspect', function(this: Pipeline, ...args: Parameters<Pipeline['inspect']>) {
          const checked = nativeInspect.apply(this, args);
          return args[0] === project && args[1] === 'features' ? change(checked) : checked;
        })
        : t.mock.method(Refinement.prototype, 'gate', function(this: Refinement, ...args: Parameters<Refinement['gate']>) {
          gateDepth++;
          let checked: ReturnType<Refinement['gate']>;
          try { checked = nativeGate.apply(this, args); } finally { gateDepth--; }
          return gateDepth === 0 && args[0] === project && args[1] === (route === 'layer' ? 'R1' : 'L2') ? change(checked) : checked;
        });
      try {
        const result = prepare(); assert.ok(hits > 0, route);
        if (channel === undefined || Array.isArray(channel) && channel.length === 0) assert.deepEqual(omValue(result), native);
        else if (channel === channels[2]) {
          const value = omValue(result);
          const { guards, ...body } = value, { guards: previousGuards, ...previousBody } = native;
          assert.deepEqual(body, previousBody);
          assert.deepEqual([...guards].map(canonical).sort(), [...previousGuards, positive, second].map(canonical).sort(), route);
        } else {
          assert.equal(result.ok, false, route);
          if (!result.ok) {
            assert.equal(result.refusal.code, channel === channels[3] || channel === channels[4] || channel === channels[5]
              ? 'om_admission_guard_unsupported' : 'om_admission_guard_invalid', `${route}: channel ${channels.indexOf(channel)}`);
            if (result.refusal.code === 'om_admission_guard_unsupported') assert.equal(result.refusal.at.target, positive.id);
            assert.ok(result.refusal.at.field?.includes('admissionGuards'));
            assert.equal(result.refusal.route, 'producer');
          }
        }
      } finally { spy.mock.restore(); }
      assert.deepEqual(f.store.list().map(reference), before, 'A refused or prepared bridge must not write admission records');
    }
  }
});

test('D8.1 OM channel reader validates its public arguments and preserves input bytes', () => {
  for (const [gate, unit] of [[null, 'G1'], ['', 'G1'], ['features', null], ['features', 'unknown']])
    assert.throws(() => readOmAdmissionGuards(undefined, gate as string, unit as 'G1'),
      (error: unknown) => error instanceof EngineError && error.code === 'om_admission_guard_invalid'
        && typeof (error.details as { target: unknown }).target === 'string');
  const ref = { id: 'positive', revision: 1, hash: 'a'.repeat(64) };
  const input = Object.freeze([Object.freeze(ref)]);
  assert.deepEqual(omValue(readOmAdmissionGuards(input, 'features', 'G1')), input);
  assert.deepEqual(input, [ref]);
});

test('D8.1 pipeline transaction guards retain contradictory dependencies and reject malformed channels before writing', t => {
  const f = fixture(t), positive = reference(f.environment), absent = { id: positive.id, absent: true as const };
  const original = f.store.writeMany.bind(f.store);
  const neighbors: Write[] = ['one', 'two'].map(id => ({ id: `d81-conflict:${id}`, kind: 'fixture', expected: 0, value: {} }));
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[]) => original([...writes, ...neighbors], guards)) as Store['writeMany'];
  try {
    for (const guards of [[absent, positive], [positive, absent]]) {
      assert.throws(() => f.engine.pipeline.draft('p', 'om-g2', {}, 0, guards), { code: 'input_stale' });
      for (const id of ['stage:p:om-g2', ...neighbors.map(item => item.id)]) assert.equal(f.store.get(id), null);
    }
    for (const invalid of [null, {}, [null], [{ ...positive, absent: true }], [{ id: 'missing', absent: false }], new Array(1)]) {
      assert.throws(() => f.engine.pipeline.draft('p', 'om-g2', {}, 0, invalid as TransactionGuard[]), { code: 'invalid_guard' });
      for (const id of ['stage:p:om-g2', ...neighbors.map(item => item.id)]) assert.equal(f.store.get(id), null);
    }
  } finally { f.store.writeMany = original; }
});

// Append to test/runtime-absence-r3.test.ts; its existing imports cover this fragment.
// The local fixture stops before accepting R1; it uses the actual research producer.
function milestoneFixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d81-milestone-'))), workspace = join(root, 'repo');
  mkdirSync(workspace);
  git(workspace, ['init', '-b', 'main']);
  writeFileSync(join(workspace, 'README.md'), 'Fixture baseline\n');
  git(workspace, ['add', '.']);
  git(workspace, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline']);
  const store = new Store(join(root, 'state.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  preparedFeatures(engine, 'p');
  const command = { executable: process.execPath, args: ['--version'] };
  engine.environments.configure('p', { workspace,
    implementer: { actor: 'worker', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 3000 }, 0);
  const r0 = engine.refinement.begin('p', 'R0');
  engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
  engine.refinement.sealLayer('p', 1, 0);
  const draft = engine.refinement.begin('p', 'R1');
  answerTechnicalFixture(engine, 'p', draft);
  const answered = reference(store.get(draft.id)!);
  assert.equal(store.get('execution-root:p'), null);
  assert.equal(store.get('reader-pilot:p'), null);
  return { root, workspace, store, engine, finish: (expected: number) => engine.refinement.finishResearch('p', 'R1', answered, expected) };
}

function createMilestoneRoot(f: { store: Store; workspace: string }) {
  const second = new Store(f.store.path);
  try {
    const root = ensureWorktree(second, new Environments(second), { projectId: 'p', base: {
      root: f.workspace, head: git(f.workspace, ['rev-parse', 'HEAD']) } } as MachinePlan);
    assert.equal(root.value.state, 'ready');
  } finally { second.close(); }
}

test('D8.1 finishResearch guards its directly read absent execution root through the milestone transaction', t => {
  const f = milestoneFixture(t), original = f.store.writeMany.bind(f.store);
  const neighbors: Write[] = ['one', 'two'].map(part => ({ id: `d81-milestone-neighbor:${part}`,
    kind: 'd81-milestone-neighbor', expected: 0, value: { part } }));
  let raced = false;
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    if (!raced && writes.some(write => write.id === 'phase:p:R1')) {
      raced = true;
      const phase = writes.find(write => write.id === 'phase:p:R1')!;
      assert.ok((phase.value as { inputs: unknown[] }).inputs.every(isRef), 'Saved milestone inputs remain exact Ref values');
      assert.ok(guards.some(guard => guard.id === 'execution-root:p' && 'absent' in guard),
        'The root inspected directly by finishResearch reaches its actual write transaction');
      createMilestoneRoot(f);
      return original([...writes, ...neighbors], guards);
    }
    return original(writes, guards);
  }) as Store['writeMany'];
  try { assert.throws(() => f.finish(0), { code: 'input_stale' }); }
  finally { f.store.writeMany = original; }
  assert.equal(raced, true);
  assert.ok(f.store.get('execution-root:p'), 'The competing native creator committed its own root');
  for (const id of ['phase:p:R1', ...neighbors.map(write => write.id)]) {
    assert.equal(f.store.get(id), null);
    assert.deepEqual(f.store.history(id), []);
  }
});

test('D8.1 exact finishResearch repeat checks original root absence without rewriting milestone inputs', t => {
  const f = milestoneFixture(t), phase = f.finish(0), before = JSON.stringify(phase), history = f.store.history(phase.id);
  assert.ok(phase.value.inputs.every(isRef));
  const originalGet = f.store.get.bind(f.store), originalEffective = f.engine.environments.effective.bind(f.engine.environments);
  const originalWrite = f.store.writeMany.bind(f.store);
  let armed = false, raced = false, effectiveCalls = 0, milestoneWrites = 0;
  f.engine.environments.effective = project => {
    const value = originalEffective(project);
    effectiveCalls++;
    assert.ok(value.admissionGuards.some(guard => guard.id === 'execution-root:p' && 'absent' in guard));
    armed = true;
    return value;
  };
  f.store.get = <T>(id: string, revision?: number): Revision<T> | null => {
    const value = originalGet<T>(id, revision);
    // Before this point #inputs may read phases. Only the final milestone read
    // after finishResearch captured its effective runtime opens the race.
    if (armed && !raced && id === phase.id && revision === undefined) {
      raced = true;
      createMilestoneRoot(f);
    }
    return value;
  };
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    if (writes.some(write => write.id === phase.id)) milestoneWrites++;
    return originalWrite(writes, guards);
  }) as Store['writeMany'];
  try { assert.throws(() => f.finish(phase.revision), { code: 'input_stale' }); }
  finally {
    f.store.get = originalGet;
    f.engine.environments.effective = originalEffective;
    f.store.writeMany = originalWrite;
  }
  assert.equal(effectiveCalls, 1);
  assert.equal(raced, true);
  assert.equal(milestoneWrites, 0, 'An exact repeat checks admission without adding a phase revision');
  assert.ok(f.store.get('execution-root:p'));
  assert.equal(JSON.stringify(f.store.get(phase.id)), before);
  assert.deepEqual(f.store.history(phase.id), history);
  assert.equal(JSON.stringify(f.store.get(phase.id, phase.revision)), before);
});
