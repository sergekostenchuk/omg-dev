import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { canonical, hashJson } from '../src/canonical.js';
import { loadTaskContextSources, taskContext, type ContextText, type PlanTaskContextSources } from '../src/compiler/context.js';
import { nodeSignature, type MachinePlan } from '../src/compiler/model.js';
import { requireCompatibleReceipt } from '../src/compiler/inputs.js';
import { EngineError } from '../src/errors.js';
import { writeFeasibility, type FeasibilityRequest } from '../src/om/feasibility.js';
import { writeHandoff } from '../src/om/handoff.js';
import { neighborsOf, type NeighborSources } from '../src/om/neighbors.js';
import type { OmResult, Sealed } from '../src/om/refusal.js';
import { reference } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Environments, type Environment } from '../src/runtime/environment.js';
import { Store, type Revision } from '../src/storage/store.js';

const capacity = 200_000;
const clone = structuredClone;
const base = '6eb61d9ee45007ce4c90314162661c0329ad9ac8';
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}; ${canonical(result.refusal.at)}`);
  return result.value;
}
function code(expected: string) { return (error: unknown) => error instanceof EngineError && error.code === expected; }
interface Fixture {
  readonly store: Store; root: string; workspace: string; database: string; project: string;
  feasibility: FeasibilityRequest; restart(): void;
}
type Mode = 'external' | 'shared' | 'flows';
const fixtures = new Map<Mode, Promise<{ acceptedWorksFixture(t: TestContext): Fixture }>>();
function loadFixture(mode: Mode) {
  if (!fixtures.has(mode)) fixtures.set(mode, (async () => {
    const url = new URL('./om-feasibility.test.js', import.meta.url), code = readFileSync(url, 'utf8');
    const end = code.indexOf('const heads ='); assert.ok(end > 0);
    let source = code.slice(0, end);
    function once(needle: string, value: string) {
      assert.equal(source.split(needle).length - 1, 1, `A declared upstream fixture seam: ${needle}`);
      source = source.replace(needle, value);
    }
    if (mode === 'shared') {
      once("desired.artifacts.find(artifact => artifact.id === 'garden-data').external = true;", `
      desired.artifacts.find(artifact => artifact.id === 'garden-data').external = false;
      for (const node of desired.nodes.filter(node => node.kind === 'work'))
        for (const code of node.code) if (code.access === 'write') code.path = 'shared.txt';
      for (const connector of desired.connectors) for (const binding of connector.bindings)
        if (binding.level === 3) for (const end of [binding.producer, ...binding.consumers])
          end.codeRef = clone(desired.nodes.find(node => node.id === end.node).code[0]);
      for (const proof of desired.tests) if (proof.contract) proof.contract.entrypoint.path = 'shared.txt';
      desired.transfers = [{ id: 'garden-shared-transfer', path: 'shared.txt',
        from: 'garden-produce-work', to: 'garden-consume-work', condition: 'producer_committed' }];`);
      once('gaps: gapRead, results: [], sources: [reference(source)]', 'gaps: gapRead, results: [], sources: []');
      once("assert.deepEqual(candidate.record.value.graph.horizon, ['garden-consume-work']);",
        "assert.deepEqual([...candidate.record.value.graph.horizon].sort(), ['garden-consume-work', 'garden-produce-work']);");
    }
    if (mode === 'flows') once('const desired = enrichedGraph(exampleGraph(), project);', `
      const desired = enrichedGraph(exampleGraph(), project);
      for (const kind of ['block', 'operation', 'work']) {
        desired.nodes.find(n => n.id === 'garden-produce-' + kind).ports.push({ id: 'out-alt', direction: 'out', contract: 'garden-contract' });
        desired.nodes.find(n => n.id === 'garden-consume-' + kind).ports.push({ id: 'in-alt', direction: 'in', contract: 'garden-contract' });
      }
      for (const connector of desired.connectors) for (const binding of [...connector.bindings]) {
        const extra = clone(binding); extra.producer.port = 'out-alt';
        for (const consumer of extra.consumers) consumer.port = 'in-alt'; connector.bindings.push(extra);
      }`);
    source = source.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
      (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`);
    assert.ok(!/\btest\(/.test(source));
    return import(`data:text/javascript;base64,${Buffer.from(`${source}\nexport { acceptedWorksFixture };`).toString('base64')}`);
  })());
  return fixtures.get(mode)!;
}

const adapter = String.raw`import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const [journal] = process.argv.slice(1), raw = readFileSync(0, 'utf8'), request = JSON.parse(raw);
appendFileSync(journal, raw + '\n');
const response = { protocol: request.protocol, requestId: request.requestId };
if (request.mode === 'implement') {
  const context = request.subject.context;
  for (const code of context.scope.code.filter(code => code.access === 'write')) {
    mkdirSync(dirname(code.path), { recursive: true }); writeFileSync(code.path, 'Native G3 result for ' + context.binding.task + '\n');
  }
  response.text = 'Implemented the declared work'; response.artifacts = context.produces.map(id => ({ id }));
} else if (request.mode === 'review') response.review = { verdict: 'pass', kind: 'none', findings: [] };
else throw new Error('Unexpected physical mode');
process.stdout.write(JSON.stringify(response));`;

async function fixture(t: TestContext, mode: Mode = 'external', overflow?: 'implement' | 'review') {
  const producer = await loadFixture(mode), configure = Environments.prototype.configure;
  let configured = 0, journal = '';
  Environments.prototype.configure = function(project, value, expected) {
    configured++; journal = join(dirname(value.workspace), 'g3-requests.ndjson');
    const command = { executable: process.execPath, args: ['--input-type=module', '-e', adapter, journal] };
    return configure.call(this, project, { ...value,
      implementer: { ...value.implementer, command, model: overflow === 'implement' ? 'm'.repeat(capacity) : 'fixture' },
      reviewer: { ...value.reviewer, command, model: overflow === 'review' ? 'm'.repeat(capacity) : 'fixture' } }, expected);
  };
  let f: Fixture;
  try { f = producer.acceptedWorksFixture(t); } finally { Environments.prototype.configure = configure; }
  assert.equal(configured, 1);
  let engine = new ProductEngine(f.store);
  const m8 = ok(writeFeasibility(f.store, f.feasibility));
  ok(writeHandoff(f.store, { project: f.project, feasibility: reference(m8), expected: 0 }));
  const plan = engine.compiler.compile(f.project), stage = engine.compiler.publish(f.project, reference(plan), 0);
  engine.pipeline.accept(f.project, 'compilation', stage.revision);
  const environment = f.store.get<Environment>(plan.value.environment.id, plan.value.environment.revision)!;
  const restart = () => { f.restart(); engine = new ProductEngine(f.store); };
  return { ...f, get store() { return f.store; }, get engine() { return engine; }, restart, plan, m8, environment,
    calls: (): { mode: string; subject: { context: Record<string, unknown>; parent: string; inputs?: unknown[]; ownership?: unknown[] } }[] =>
      existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    run: (maxContextChars = capacity, retry = false, maxCorrections = 2) =>
      engine.executor.run(f.project, reference(plan), { maxContextChars, retry, maxCorrections }) };
}

function sources(store: Store, plan: Revision<MachinePlan>): Sealed<PlanTaskContextSources> {
  const result = loadTaskContextSources(store, plan); assert.ok(result); return result;
}

test('G3 both consumers reuse V2 and F4 for each native task and preserve historical neighbors across their own writer progress', async t => {
  const f = await fixture(t, 'shared'), before = canonical(f.plan), m8 = canonical(f.m8);
  assert.equal(f.plan.value.tasks.length, 2);
  const original = sources(f.store, f.plan), fullCheck = f.environment.value.fullCheck;
  const contexts = new Map(f.plan.value.tasks.map(task => [task.id, f.engine.compiler.context(f.project, reference(f.plan), task.id, capacity)]));
  for (const task of f.plan.value.tasks) {
    const payload = JSON.parse(contexts.get(task.id)!.text);
    assert.deepEqual(payload.neighbors, ok(neighborsOf(f.plan.value.graphSnapshot, task.node, original.neighbors as NeighborSources)));
    assert.deepEqual(payload.scope.readPaths, task.readPaths); assert.deepEqual(payload.scope.writePaths, task.writePaths);
    assert.deepEqual(payload.deliveryOwnership, original.deliveryOwnership);
    assert.equal(task.signature, nodeSignature(f.plan.value.graphSnapshot, f.plan.value.graphSnapshot.nodes.find(node => node.id === task.node)!));
  }
  const runs = await f.run(); assert.deepEqual(runs.map(run => run.value.state), ['committed', 'committed']);
  const calls = f.calls(); assert.equal(calls.length, 4);
  for (const call of calls) {
    const binding = call.subject.context['binding'] as { task: string };
    assert.deepEqual(call.subject.context, JSON.parse(contexts.get(binding.task)!.text));
  }
  const second = calls.filter(call => call.mode === 'implement')[1]!;
  assert.notEqual(second.subject.parent, f.plan.value.base.head);
  assert.ok(second.subject.inputs!.length); assert.ok(second.subject.ownership!.length);
  f.restart();
  assert.equal(canonical(f.engine.compiler.read(f.plan.id)), before);
  assert.equal(canonical(f.store.get(f.m8.id, f.m8.revision)), m8);
  const historical = sources(f.store, f.plan);
  for (const task of f.plan.value.tasks) {
    assert.deepEqual(taskContext(f.plan, fullCheck, task.id, capacity, original), contexts.get(task.id));
    assert.deepEqual(taskContext(f.plan, fullCheck, task.id, capacity, historical), contexts.get(task.id));
    // Current admission still applies the existing ownership rule; pure history does not re-admit the plan.
    assert.throws(() => f.engine.compiler.context(f.project, reference(f.plan), task.id, capacity), code('ownership_transfer_required'));
  }
  // Completed execution and recovery do not acquire new capacity-dependent admission.
  assert.deepEqual((await f.run(1, true)).map(reference), runs.map(reference));
  await f.engine.executor.recover(f.project); assert.equal(f.calls().length, 4);
});

test('G3 distinct flows of one artifact remain distinct neighbors at both consumers', async t => {
  const f = await fixture(t, 'flows'), task = f.plan.value.tasks[0]!;
  const context = JSON.parse(f.engine.compiler.context(f.project, reference(f.plan), task.id, capacity).text);
  const rows = context.neighbors.neighbors.filter((row: { connector?: string }) => row.connector === 'garden-flow');
  assert.equal(rows.length, 2); assert.equal(new Set(rows.map((row: { port: string }) => row.port)).size, 2);
  const runs = await f.run(); assert.equal(runs[0]!.value.state, 'committed');
  for (const call of f.calls()) assert.deepEqual(call.subject.context['neighbors'], context.neighbors);
});

for (const role of ['implement', 'review'] as const) test(`G3 context fits but the complete ${role} envelope exceeds V1 without that physical send or correction`, async t => {
  const f = await fixture(t, 'external', role), task = f.plan.value.tasks[0]!;
  const output = f.engine.compiler.context(f.project, reference(f.plan), task.id, capacity);
  assert.ok(output.chars < capacity); assert.ok(f.environment.value[role === 'implement' ? 'implementer' : 'reviewer'].model.length >= capacity);
  const runs = await f.run(); assert.equal(runs.length, 1);
  const run = runs[0]!; assert.equal(run.value.state, 'interrupted'); assert.equal(run.value.attempt, 1);
  assert.match(run.value.error!, /context_budget_exceeded/); assert.ok(run.value.error!.includes(task.id));
  assert.match(run.value.error!, /requiredChars/); assert.match(run.value.error!, /maxChars/);
  assert.equal(run.value.commit, null);
  const modes = role === 'implement' ? [] : ['implement'];
  assert.deepEqual(f.calls().map(call => call.mode), modes); assert.deepEqual(run.value.usage.map(item => item.mode), modes);
  const refs = runs.map(reference); f.restart();
  assert.deepEqual((await f.run()).map(reference), refs); assert.deepEqual(f.calls().map(call => call.mode), modes);
});

test('G3 M8 refuses a command capacity different from exact V1 before a new task attempt', async t => {
  const f = await fixture(t);
  for (const amount of [capacity - 1, capacity + 1]) {
    await assert.rejects(f.run(amount), (error: unknown) => error instanceof EngineError && error.code === 'capacity_mismatch'
      && canonical(error.details) === canonical({ unit: 'G3', target: f.environment.id, field: 'maxContextChars', expected: capacity, actual: amount }));
    assert.deepEqual(f.calls(), []); assert.deepEqual(f.store.list('task-run'), []);
  }
});

test('G3 a changed exact frame head preserves pure neighbor assembly but still closes public stale-plan issuance', async t => {
  const f = await fixture(t), task = f.plan.value.tasks[0]!, initial = sources(f.store, f.plan);
  const before = taskContext(f.plan, f.environment.value.fullCheck, task.id, capacity, initial);
  const other = new Store(f.database);
  try {
    const frame = other.get(f.m8.value.producer.frame.id)!;
    other.write({ id: frame.id, kind: frame.kind, expected: frame.revision, value: frame.value });
  } finally { other.close(); }
  f.restart();
  assert.deepEqual(taskContext(f.plan, f.environment.value.fullCheck, task.id, capacity, initial), before);
  assert.deepEqual(taskContext(f.plan, f.environment.value.fullCheck, task.id, capacity, sources(f.store, f.plan)), before);
  assert.throws(() => f.engine.compiler.context(f.project, reference(f.plan), task.id, capacity), code('plan_stale'));
});

for (const consumer of ['compiler', 'executor'] as const) test(`G3 ${consumer} keeps its original admission through historical neighbor loading`, async t => {
  const f = await fixture(t), task = f.plan.value.tasks[0]!, originalGet = f.store.get.bind(f.store);
  let changed = false;
  f.store.get = ((id: string, revision?: number) => {
    const found = originalGet(id, revision);
    // The common loader reads the exact plan after this consumer has captured admission.
    if (!changed && id === f.plan.id && revision === f.plan.revision) {
      changed = true;
      const second = new Store(f.database);
      try {
        const environment = second.get<Environment>(f.environment.id)!;
        new Environments(second).configure(f.project, environment.value, environment.revision);
      } finally { second.close(); }
    }
    return found;
  }) as Store['get'];
  try {
    if (consumer === 'compiler') assert.throws(() => f.engine.compiler.context(f.project, reference(f.plan), task.id, capacity), code('plan_stale'));
    else await assert.rejects(f.run(), code('input_stale'));
    assert.equal(changed, true); assert.deepEqual(f.calls(), []); assert.deepEqual(f.store.list('task-run'), []);
  } finally { f.store.get = originalGet; }
});

test('G3 missing exact M8 and frame evidence is an addressed refusal after restart rather than an empty neighbor packet', async t => {
  const f = await fixture(t), task = f.plan.value.tasks[0]!, original = sources(f.store, f.plan);
  assert.throws(() => taskContext(f.plan, f.environment.value.fullCheck, task.id, capacity), code('context_source_invalid'));
  const targets = [f.m8, f.store.get(f.m8.value.producer.frame.id, f.m8.value.producer.frame.revision)!,
    f.store.get(f.m8.value.producer.candidate.id, f.m8.value.producer.candidate.revision)!];
  for (const [index, target] of targets.entries()) {
    const snapshot = await f.store.snapshot(join(f.root, `missing-seed-${index}`)), database = join(f.root, `missing-${index}.sqlite`);
    copyFileSync(snapshot.path, database);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(database); db.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER revisions_no_delete;');
    db.prepare('DELETE FROM revisions WHERE entity_id = ? AND revision = ?').run(target.id, target.revision); db.close();
    const store = new Store(database);
    try {
      assert.throws(() => loadTaskContextSources(store, f.plan), (error: unknown) => error instanceof EngineError
        && typeof error.code === 'string' && error.details !== null && canonical(error.details).includes(target.id));
    } finally { store.close(); }
  }
  const foreign = clone(original) as PlanTaskContextSources; foreign.plan = { ...foreign.plan, hash: hashJson('another plan') };
  assert.throws(() => taskContext(f.plan, f.environment.value.fullCheck, task.id, capacity, foreign), code('context_source_invalid'));
  assert.throws(() => { (original.neighbors.frames.works.obligations as unknown[]).length = 0; }, TypeError);
});

test('G3 exact hashes and a ready flag cannot replace the project namespace or the M8 producer proof', async t => {
  const f = await fixture(t);
  for (const variant of ['foreign-project', 'missing-marker', 'missing-producer']) {
    const value = clone(f.m8.value) as unknown as Record<string, unknown>;
    assert.equal(value['ready'], true);
    if (variant === 'missing-marker') delete (value['producer'] as Record<string, unknown>)['contract'];
    if (variant === 'missing-producer') delete value['producer'];
    const id = variant === 'foreign-project' ? 'om-feasibility:another-project' : f.m8.id;
    const changed = f.store.write({ id, kind: f.m8.kind, expected: f.store.get(id)?.revision ?? 0, value });
    const { hash: _hash, ...body } = clone(f.plan.value);
    body.feasibility = reference(changed);
    const planValue = { ...body, hash: hashJson(body) };
    const plan = f.store.write<MachinePlan>({ id: `plan:${f.project}:${planValue.hash}`, kind: 'plan', expected: 0, value: planValue });
    assert.throws(() => loadTaskContextSources(f.store, plan), (error: unknown) => error instanceof EngineError
      && error.details !== null && canonical(error.details).includes(f.m8.id), variant);
  }
});

function oldProducer(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'omg-g3-history-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../../', import.meta.url)), rootUrl = pathToFileURL(root).href;
  const loader = join(directory, 'base-loader.mjs'), typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  writeFileSync(loader, `import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';import ts from ${JSON.stringify(typescript)};
let root;export function initialize(data){root=data.root;}
export async function load(url,context,next){const prefix=new URL('dist/',root).href;
if(url.startsWith(prefix)&&/\\.js$/.test(url)){const path=url.slice(prefix.length).replace(/\\.js$/,'.ts');
const source=execFileSync('git',['show',${JSON.stringify(base)}+':'+path],{cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
return{format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};}return next(url,context);}`);
  const boot = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},{data:{root:${JSON.stringify(rootUrl)}}});`;
  const script = `import{executionFixture}from${JSON.stringify(new URL('dist/test/execution-fixture.js', rootUrl).href)};
import{reference}from${JSON.stringify(new URL('dist/src/pipeline/contracts.js', rootUrl).href)};
const f=executionFixture({after:()=>{}}), environment=f.store.get(f.plan.value.environment.id,f.plan.value.environment.revision);
const contexts=f.plan.value.tasks.map(task=>f.engine.compiler.context('p',reference(f.plan),task.id,100000));
const runs=await f.engine.executor.run('p',reference(f.plan),f.options);
if(!runs.every(run=>run.value.state==='committed'))throw new Error('The historical producer must genuinely commit');
const rows=f.store.list().flatMap(head=>f.store.history(head.id));
const result={directory:f.directory,database:f.directory+'/state.sqlite',plan:f.plan,environment,contexts,rows,receipts:f.store.list('artifact')};
f.store.close();process.stdout.write(JSON.stringify(result));`;
  const result = JSON.parse(execFileSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(boot)}`, '--input-type=module', '--eval', script],
    { cwd: root, encoding: 'utf8', maxBuffer: 30_000_000 })) as {
      directory: string; database: string; plan: Revision<MachinePlan>; environment: Revision<Environment>;
      contexts: ContextText[]; rows: Revision[]; receipts: Revision<import('../src/compiler/model.js').ArtifactReceipt>[];
    };
  t.after(() => rmSync(result.directory, { recursive: true, force: true }));
  return result;
}

test('G3 complete base producer retains legacy plan and node hashes, context bytes, receipt compatibility and completed execution after reopen', async t => {
  const old = oldProducer(t), store = new Store(old.database);
  t.after(() => store.close());
  const engine = new ProductEngine(store), plan = engine.compiler.read(old.plan.id);
  assert.deepEqual(plan, old.plan); assert.equal(loadTaskContextSources(store, plan), null);
  assert.equal(Object.hasOwn(old.environment.value, 'requestCapacityChars'), false);
  for (const [index, task] of plan.value.tasks.entries()) {
    assert.deepEqual(taskContext(plan, old.environment.value.fullCheck, task.id, 100_000), old.contexts[index]);
    const node = plan.value.graphSnapshot.nodes.find(node => node.id === task.node)!;
    assert.equal(nodeSignature(plan.value.graphSnapshot, node), task.signature);
    for (const artifact of task.produces) {
      const receipt = old.receipts.find(receipt => receipt.value.artifact === artifact)!;
      assert.deepEqual(requireCompatibleReceipt(receipt, 'p', plan.value.graphSnapshot, task.node, artifact), receipt);
    }
  }
  const before = store.list().flatMap(head => store.history(head.id)); assert.deepEqual(before, old.rows);
  const runs = await engine.executor.run('p', reference(plan), { retry: true, maxContextChars: 1, maxCorrections: 0 });
  assert.ok(runs.every(run => run.value.state === 'committed'));
  for (const row of old.rows) assert.deepEqual(store.get(row.id, row.revision), row);
});

test('G3 new source entrypoints reject malformed and missing mandatory data before storage without swallowing storage faults', async t => {
  const f = await fixture(t), task = f.plan.value.tasks[0]!;
  const original = sources(f.store, f.plan), get = f.store.get.bind(f.store);
  f.store.get = (() => { assert.fail('Malformed input must not touch storage'); }) as typeof f.store.get;
  try {
    for (const value of [undefined, null, [], {}, { ...f.plan, value: null }]) {
      assert.throws(() => loadTaskContextSources(f.store, value as Revision<MachinePlan>), code('context_source_invalid'));
      assert.throws(() => taskContext(value as Revision<MachinePlan>, f.environment.value.fullCheck, task.id, capacity), code('context_source_invalid'));
    }
  } finally { f.store.get = get; }
  for (const field of ['neighbors', 'deliveryOwnership', 'references', 'candidate', 'graph', 'plan'] as const) {
    const missing = clone(original) as unknown as Record<string, unknown>; delete missing[field];
    assert.throws(() => taskContext(f.plan, f.environment.value.fullCheck, task.id, capacity,
      missing as unknown as PlanTaskContextSources), (error: unknown) => error instanceof EngineError && error.details !== null, field);
  }
  for (const field of ['identity', 'receipts', 'frames'] as const) {
    const missing = clone(original) as PlanTaskContextSources;
    delete (missing.neighbors as unknown as Record<string, unknown>)[field];
    assert.throws(() => taskContext(f.plan, f.environment.value.fullCheck, task.id, capacity, missing),
      (error: unknown) => error instanceof EngineError && error.details !== null, field);
  }
  const error = new Error('Named storage failure');
  f.store.get = (() => { throw error; }) as typeof f.store.get;
  try { assert.throws(() => loadTaskContextSources(f.store, f.plan), value => value === error); }
  finally { f.store.get = get; }
});
