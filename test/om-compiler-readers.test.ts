import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { gateFeasibility, neighborsOf, readAcceptedFrame, readAtomicGate, readDeliveries, readFeasibility, readFrame, readNeighbors,
  readWorksFrame, readTaskContextBasis, readTaskSpecification, registerCompilerOmReaders, type CompilerOmReaders, type ObligationHandoffForm } from '../src/compiler/om-readers.js';
import type { ObligationHandoff } from '../src/graph/obligation-handoff.js';
import type { readFeasibility as omReadFeasibility } from '../src/om/feasibility.js';
import type { Ref } from '../src/pipeline/contracts.js';
import type { Store } from '../src/storage/store.js';

// R3+R4 (№2484, №2489). This process never loads src/om/compiler-readers.js or the product engine: the slot must stay
// empty here so the empty-slot and registration probes run against the slot itself. Everything that needs the real OM
// readers runs in a cold child process, whose module order is exactly what its script imports.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = pathToFileURL(join(ROOT, 'dist/src/')).href, TST = pathToFileURL(join(ROOT, 'dist/test/')).href;
/** The base implementation the slot replaces: om/module before R3+R4 (R6 merged). */
const BASE = 'ee2bf80bf3bf291cfb65f6c50d9707e913b4c4b0';
const NAMES = ['readFeasibility', 'gateFeasibility', 'neighborsOf', 'readNeighbors', 'readAtomicGate', 'readAcceptedFrame',
  'readFrame', 'readDeliveries', 'readWorksFrame', 'readTaskContextBasis', 'readTaskSpecification'] as const;
type Name = typeof NAMES[number];
const wrappers = { readFeasibility, gateFeasibility, neighborsOf, readNeighbors, readAtomicGate, readAcceptedFrame, readFrame,
  readDeliveries, readWorksFrame, readTaskContextBasis, readTaskSpecification } as unknown as Record<Name, (...args: unknown[]) => unknown>;

const ref = (id: string): Ref => ({ id, revision: 1, hash: 'a'.repeat(64) });
let touched = 0;
/** Any property access, call or enumeration on a probe counts: an empty slot must not read its arguments at all. */
const probe = (): object => new Proxy({}, { get() { touched++; return undefined; }, has() { touched++; return false; },
  ownKeys() { touched++; return []; }, getOwnPropertyDescriptor() { touched++; return undefined; } });
function calls(): [Name, unknown[], Record<string, unknown>][] {
  const project = 'garden', store = probe(), record = ref('om-feasibility:garden:m8'), candidate = ref('om-candidate:garden:c');
  const frame = ref('om-frame:garden:3'), ownership = { contract: 'delivery-ownership/v1', root: null, indexes: {} };
  const frameRequest = { project, level: 3, horizon: ref('om-horizon:garden'), graph: ref('graph:garden'), layer: ref('graph-layer:garden:3'),
    frame, upper: null };
  return [
    ['readFeasibility', [store, { project, record }], { project, record }],
    ['gateFeasibility', [store, { project, record }], { project, record }],
    ['neighborsOf', [probe(), 'garden-consume-work', probe()], { work: 'garden-consume-work' }],
    ['readNeighbors', [store, { project, neighbors: ref('om-neighbors:garden:n') }], { project, neighbors: ref('om-neighbors:garden:n') }],
    ['readAtomicGate', [store, { project, record: ref('om-atomic-gate:garden:g') }], { project, record: ref('om-atomic-gate:garden:g') }],
    ['readAcceptedFrame', [store, { project, level: 3, graph: ref('graph:garden'), layer: ref('graph-layer:garden:3'), frame }],
      { project, level: 3, frame }],
    ['readFrame', [store, frameRequest], { project, level: 3, frame }],
    ['readDeliveries', [store, { project, candidate, ownership }], { project, candidate }],
    ['readWorksFrame', [store, { project, candidate }], { project, candidate }],
    ['readTaskContextBasis', [store, { project, record }], { project, record }],
    ['readTaskSpecification', [store, { project, input: ref('om-input:garden'), requirements: ['R1'], nodes: ['garden-work', 'garden-block'] }],
      { project, input: ref('om-input:garden') }],
  ];
}
function refusal(run: () => unknown): EngineError {
  try { run(); } catch (error) { if (error instanceof EngineError) return error; throw error; }
  assert.fail('Expected an EngineError');
}

test('R3+R4 empty slot: each reader is the addressed om_compiler_reader_unavailable, touches no argument and returns no stand-in', () => {
  touched = 0;
  for (const [name, args, address] of calls()) {
    let result: unknown = 'not returned';
    const error = refusal(() => { result = wrappers[name](...args); });
    assert.equal(error.code, 'om_compiler_reader_unavailable', name);
    assert.deepEqual(error.details, { unit: 'compiler', target: name, ...address }, name);
    assert.equal(result, 'not returned', `${name} returns neither null nor a successful stand-in`);
  }
  assert.equal(touched, 0, 'An empty slot reads no Store, request, graph or sources');
});

function fakeKit(results: Map<Name, unknown>, seen: { name: Name; args: unknown[] }[], failure: Error, failing: object): CompilerOmReaders {
  return Object.fromEntries(NAMES.map(name => [name, (...args: unknown[]) => {
    seen.push({ name, args });
    if (args.includes(failing)) throw failure;
    return results.get(name);
  }])) as unknown as CompilerOmReaders;
}

test('R3+R4 an incomplete or non-function kit is om_compiler_reader_invalid and leaves the slot empty', () => {
  const results = new Map<Name, unknown>(), seen: { name: Name; args: unknown[] }[] = [];
  const complete = fakeKit(results, seen, new Error('unused'), {});
  const kits: [string, unknown, string][] = [['null', null, 'readers'], ['undefined', undefined, 'readers'], ['number', 42, 'readers'],
    ['empty', {}, 'readFeasibility'], ['array', [], 'readFeasibility']];
  for (const name of NAMES) {
    const missing = { ...complete } as Record<string, unknown>; delete missing[name];
    kits.push([`missing ${name}`, missing, name]);
    for (const value of ['reader', null, {}]) kits.push([`${name} = ${canonical(value)}`, { ...complete, [name]: value }, name]);
  }
  for (const [label, kit, target] of kits) {
    const error = refusal(() => registerCompilerOmReaders(kit as CompilerOmReaders));
    assert.equal(error.code, 'om_compiler_reader_invalid', label);
    assert.deepEqual(error.details, { unit: 'compiler', target }, label);
    assert.equal(refusal(() => readFeasibility(probe() as never, { project: 'p', record: ref('om-feasibility:p:x') })).code,
      'om_compiler_reader_unavailable', `${label} leaves the slot empty`);
  }
  assert.equal(seen.length, 0, 'No reader is called while checking a kit');
});

test('R3+R4 registration installs once and atomically, calls no reader, keeps its own copy and delegates the exact arguments, result and exception', () => {
  const results = new Map<Name, unknown>(NAMES.map(name => [name, { ok: true, value: { reader: name } }]));
  const seen: { name: Name; args: unknown[] }[] = [], failure = new Error('reader failure'), failing = {};
  const kit = fakeKit(results, seen, failure, failing), original = { ...kit };
  registerCompilerOmReaders(kit);
  assert.equal(seen.length, 0, 'Installing reads no Store, writes nothing and calls no reader');
  const check = () => {
    for (const [name, args] of calls()) {
      seen.length = 0;
      assert.equal(wrappers[name](...args), results.get(name), `${name} returns the original result object`);
      assert.equal(seen.length, 1); assert.equal(seen[0]!.name, name);
      assert.equal(seen[0]!.args.length, args.length);
      for (const [index, arg] of args.entries()) assert.equal(seen[0]!.args[index], arg, `${name} passes argument ${index} itself`);
    }
    assert.throws(() => readFrame(probe() as never, failing as never), (error: unknown) => error === failure,
      'The original exception propagates unchanged');
  };
  check();
  registerCompilerOmReaders(kit);
  registerCompilerOmReaders({ ...original });
  check();
  // Each member is read once: an accessor cannot pass the check with one value and install another.
  const reads = new Map<Name, number>();
  const accessor = Object.defineProperties({}, Object.fromEntries(NAMES.map(name => [name, { enumerable: true, get() {
    reads.set(name, (reads.get(name) ?? 0) + 1); return reads.get(name) === 1 ? original[name] : 'masquerade'; } }])));
  registerCompilerOmReaders(accessor as CompilerOmReaders);
  assert.deepEqual(NAMES.map(name => reads.get(name)), NAMES.map(() => 1));
  check();
  // The slot holds its own references: rewriting the registration object afterwards changes nothing.
  (kit as unknown as Record<string, unknown>)['readFrame'] = () => 'mutated';
  delete (kit as unknown as Record<string, unknown>)['readFeasibility'];
  check();
  for (const name of NAMES) {
    const other = { ...original, [name]: () => 'another reader' } as CompilerOmReaders;
    const error = refusal(() => registerCompilerOmReaders(other));
    assert.equal(error.code, 'om_compiler_reader_conflict', name);
    assert.deepEqual(error.details, { unit: 'compiler', target: name });
  }
  const incomplete = { ...original } as Record<string, unknown>; delete incomplete['readWorksFrame'];
  assert.equal(refusal(() => registerCompilerOmReaders(incomplete as unknown as CompilerOmReaders)).code, 'om_compiler_reader_invalid');
  check();
});

// ---- Type contracts (№2504), checked by tsc on every build and never executed; the imports above are type-only, so this
// process still loads no OM module. The installation checks the obligation handoff's form, not only its presence, and the
// slot's form is exactly the one graph/task-obligations takes.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
const handoffFormIsTheConsumersForm: Same<ObligationHandoffForm, ObligationHandoff> = true;
declare const realReadFeasibility: typeof omReadFeasibility;
function handoffContracts(others: CompilerOmReaders): void {
  registerCompilerOmReaders({ ...others, readFeasibility: realReadFeasibility });
  const numbered = (store: Store, request: { project: string; record: Ref }) => {
    const result = realReadFeasibility(store, request);
    if (!result.ok) return result;
    const record = result.value, obligations = { ...record.value.obligations, handoff: 42 };
    return { ok: true as const, value: { ...record, value: { ...record.value, obligations } } };
  };
  // @ts-expect-error — a number is not the obligation handoff the consumers take
  registerCompilerOmReaders({ ...others, readFeasibility: numbered });
  const incomplete = (store: Store, request: { project: string; record: Ref }) => {
    const result = realReadFeasibility(store, request);
    if (!result.ok) return result;
    const record = result.value, { obligations: _carried, ...handoff } = record.value.obligations.handoff;
    return { ok: true as const, value: { ...record, value: { ...record.value, obligations: { ...record.value.obligations, handoff } } } };
  };
  // @ts-expect-error — a handoff without its carried obligations is incomplete
  registerCompilerOmReaders({ ...others, readFeasibility: incomplete });
}
void handoffContracts;

test('R3+R4 (№2504) the handoff form is checked by tsc in both directions: the real reader installs, a number or incomplete handoff does not, and the slot form equals ObligationHandoff', () => {
  // The checks themselves are the compile-time contracts above; a build without them fails before any test runs.
  assert.equal(handoffFormIsTheConsumersForm, true);
  const slot = readFileSync(join(ROOT, 'src/compiler/om-readers.ts'), 'utf8');
  assert.match(slot, /readonly obligations: \{ readonly handoff: Frozen<ObligationHandoffForm> \}/);
  assert.doesNotMatch(slot.replace(/\/\*\*[\s\S]*?\*\//g, ''), /readonly (handoff|graph|basis\??): unknown/,
    'No field the consumers take or pass on is left unknown in the slot');
});

// ---- Cold children: the real readers, installed only by the product assembly point.

interface ColdResult { checks: { name: string; pass: boolean; detail: unknown }[] }
function coldChecks(result: unknown): void {
  const ran = result as ColdResult;
  assert.ok(Array.isArray(ran.checks) && ran.checks.length > 0, `The cold script must report its checks: ${JSON.stringify(result)}`);
  for (const check of ran.checks) assert.ok(check.pass, `${check.name}: ${JSON.stringify(check.detail)}`);
}
function workDirectory(t: TestContext, name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `omg-r34-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
/** Runs a module script in a fresh process; with base, every dist module is the BASE source from Git, transpiled. */
function child(directory: string, name: string, source: string, config: Record<string, unknown>, base = false): unknown {
  const script = join(directory, `${name}.mjs`);
  writeFileSync(script, source);
  const options: string[] = [];
  if (base) {
    const loader = join(directory, 'base-loader.mjs');
    writeFileSync(loader, BASE_LOADER);
    const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
    options.push('--import', `data:text/javascript,${encodeURIComponent(`import{register}from'node:module';register(${JSON.stringify(
      pathToFileURL(loader).href)},{data:{root:${JSON.stringify(pathToFileURL(ROOT).href)},base:${JSON.stringify(BASE)},typescript:${
      JSON.stringify(typescript)}}});`)}`);
  }
  const environment = { ...process.env }; delete environment['NODE_TEST_CONTEXT'];
  const output = execFileSync(process.execPath, [...options, script, JSON.stringify({ src: SRC, tst: TST, ...config })],
    { cwd: ROOT, env: environment, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(output.trim().split('\n').at(-1)!) as unknown;
}

const BASE_LOADER = String.raw`import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let root, base, ts;
export async function initialize(data) { root = data.root; base = data.base; ts = (await import(data.typescript)).default; }
export async function load(url, context, next) {
  const prefix = new URL('dist/', root).href;
  if (url.startsWith(prefix) && /\.js$/.test(url)) {
    // Every product and fixture module comes from the base commit; there is no fallback to the current source.
    const relative = url.slice(prefix.length).replace(/\.js$/, '.ts');
    const source = execFileSync('git', ['show', base + ':' + relative], { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return next(url, context);
}
`;

/** Saved legal bases: M8 (the accepted works of om-feasibility.test, M8 written and handed off, not yet compiled) and legacy. */
const BUILD = String.raw`
const C = JSON.parse(process.argv[2]);
const { execFileSync } = await import('node:child_process');
const ts = (await import(C.typescript)).default;
const url = new URL('om-feasibility.test.js', C.tst);
// FJ1: the shared saved base belongs to the old reader's era, including its fixture declarations.
const oldFixture = execFileSync('git', ['show', C.fixtureBase + ':test/om-feasibility.test.ts'],
  { cwd: C.repository, encoding: 'utf8', maxBuffer: 10000000 });
let source = ts.transpileModule(oldFixture,
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText;
const end = source.indexOf('const heads =');
if (end < 0) throw new Error('The declared om-feasibility fixture seam moved');
source = source.slice(0, end).replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_match, _quote, path) => 'from ' + JSON.stringify(new URL(path, url).href));
if (/\btest\(/.test(source)) throw new Error('The fixture slice must not declare a test');
const { acceptedWorksFixture } = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { acceptedWorksFixture };').toString('base64'));
const { writeFeasibility } = await import(C.src + 'om/feasibility.js');
const { writeHandoff } = await import(C.src + 'om/handoff.js');
const { reference } = await import(C.src + 'pipeline/contracts.js');
const { executionFixture } = await import(C.tst + 'execution-fixture.js');
const ok = result => { if (!result.ok) throw new Error('Unexpected refusal ' + result.refusal.code); return result.value; };
const f = acceptedWorksFixture({ after() {} });
const m8 = ok(writeFeasibility(f.store, f.feasibility));
ok(writeHandoff(f.store, { project: f.project, feasibility: reference(m8), expected: 0 }));
f.store.close();
const legacy = executionFixture({ after() {} });
const legacyDatabase = legacy.store.path, legacyPlan = legacy.plan;
legacy.store.close();
process.stdout.write(JSON.stringify({ root: f.root, database: f.database, project: f.project, m8,
  legacy: { directory: legacy.directory, database: legacyDatabase, plan: legacyPlan } }) + '\n');
`;

/** The same scenario for the base and the new implementation, each on its own copies of the saved bases. */
const SCENARIO = String.raw`
const C = JSON.parse(process.argv[2]);
const { copyFileSync } = await import('node:fs');
const { DatabaseSync } = await import('node:sqlite');
const { Store } = await import(C.src + 'storage/store.js');
const { ProductEngine } = await import(C.src + 'product/engine.js');
const { reference } = await import(C.src + 'pipeline/contracts.js');
const { canonical, hashJson } = await import(C.src + 'canonical.js');
const { loadTaskContextSources } = await import(C.src + 'compiler/context.js');
const { requireBasis } = await import(C.src + 'compiler/basis.js');
const { requirePlanTaskObligations } = await import(C.src + 'execution/task-obligations.js');
const selector = { id: '', pointer: '', start: null, end: null };
function attempt(out, name, run) {
  try { const value = run(); out[name] = { value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }; }
  catch (error) { out[name] = { error: { name: error?.name ?? null, code: error?.code ?? null, message: String(error?.message ?? error),
    details: error?.details === undefined ? null : JSON.parse(JSON.stringify(error.details)) } }; }
  return out[name];
}
const rows = store => { const all = store.list().flatMap(row => store.history(row.id)); return { count: all.length, hash: hashJson(canonical(all)) }; };
function open(database) { const store = new Store(database); return { store, engine: new ProductEngine(store) }; }
function reconfigure(engine, store, project) {
  const environment = store.get('environment:' + project), { projectId: _project, ...value } = environment.value;
  return engine.environments.configure(project, { ...value, timeoutMs: value.timeoutMs + 1000 }, environment.revision);
}
function compiled(out, engine, project) {
  const plan = attempt(out, 'compile', () => engine.compiler.compile(project));
  if (!plan.value) throw new Error('The saved base must compile: ' + JSON.stringify(plan.error));
  attempt(out, 'repeat', () => engine.compiler.compile(project));
  attempt(out, 'publish', () => { const stage = engine.compiler.publish(project, reference(plan.value), 0);
    return [stage, engine.pipeline.accept(project, 'compilation', stage.revision)]; });
  return plan.value;
}
function reads(out, suffix, store, engine, project, plan) {
  attempt(out, 'feasibilityGate' + suffix, () => engine.refinement.feasibilityGate(project, plan.value.feasibility));
  attempt(out, 'planGate' + suffix, () => engine.compiler.gate(project, reference(plan)));
  attempt(out, 'basis' + suffix, () => requireBasis(store, plan.value));
  attempt(out, 'sources' + suffix, () => loadTaskContextSources(store, plan));
  attempt(out, 'contexts' + suffix, () => plan.value.tasks.map(task => engine.compiler.context(project, reference(plan), task.id, 200000)));
  attempt(out, 'detail' + suffix, () => engine.compiler.detail(project, reference(plan), plan.value.tasks[0].id, 'evidence-index', selector, 100000));
  attempt(out, 'obligations' + suffix, () => requirePlanTaskObligations(store, plan.value));
}
// The base run has no slot: its loader serves only the base commit, so this import fails there.
const result = { slot: await import(C.src + 'compiler/om-readers.js').then(() => 'present', () => 'absent') }, project = C.project;
{ // M8: compile on the saved base, read everything, then shift a head the plan depends on.
  const out = result.m8 = {}, database = C.directory + '/m8.sqlite'; copyFileSync(C.database, database);
  let { store, engine } = open(database);
  const plan = store.get(compiled(out, engine, project).id);
  reads(out, '', store, engine, project, plan);
  if (C.save) { store.close(); copyFileSync(database, C.save); ({ store, engine } = open(database)); }
  attempt(out, 'shift', () => reconfigure(engine, store, project));
  reads(out, 'AfterShift', store, engine, project, plan);
  attempt(out, 'compileAfterShift', () => engine.compiler.compile(project));
  out.rows = rows(store); store.close();
}
{ // The exact M8 basis is absent from the saved base.
  const out = result.absent = {}, database = C.directory + '/absent.sqlite'; copyFileSync(C.database, database);
  let { store, engine } = open(database);
  const plan = store.get(compiled(out, engine, project).id); store.close();
  const db = new DatabaseSync(database); db.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER IF EXISTS revisions_no_delete;');
  db.prepare('DELETE FROM revisions WHERE entity_id = ? AND revision = ?').run(C.m8.id, C.m8.revision); db.close();
  ({ store, engine } = open(database));
  reads(out, '', store, engine, project, plan);
  attempt(out, 'compileAbsent', () => engine.compiler.compile(project));
  out.rows = rows(store); store.close();
}
{ // A plan that names a substituted M8 record: a later revision without the producer marker.
  const out = result.substituted = {}, database = C.directory + '/substituted.sqlite'; copyFileSync(C.database, database);
  const { store, engine } = open(database);
  const plan = store.get(compiled(out, engine, project).id);
  const value = structuredClone(C.m8.value); delete value.producer.contract;
  const changed = store.write({ id: C.m8.id, kind: C.m8.kind, expected: store.get(C.m8.id).revision, value });
  const { hash: _hash, ...body } = structuredClone(plan.value); body.feasibility = reference(changed);
  const planValue = { ...body, hash: hashJson(body) };
  const substitute = store.write({ id: 'plan:' + project + ':' + planValue.hash, kind: 'plan', expected: 0, value: planValue });
  reads(out, '', store, engine, project, substitute);
  reads(out, 'Original', store, engine, project, plan);
  out.rows = rows(store); store.close();
}
{ // Legacy era: the saved legacy plan, then a changed dependency.
  const out = result.legacy = {}, database = C.directory + '/legacy.sqlite'; copyFileSync(C.legacy.database, database);
  const { store, engine } = open(database), plan = store.get(C.legacy.plan.id);
  attempt(out, 'compile', () => engine.compiler.compile('p'));
  reads(out, '', store, engine, 'p', plan);
  attempt(out, 'shift', () => reconfigure(engine, store, 'p'));
  reads(out, 'AfterShift', store, engine, 'p', plan);
  out.rows = rows(store); store.close();
}
process.stdout.write(JSON.stringify(result) + '\n');
`;

interface Attempt { value?: unknown; error?: { name: string | null; code: string | null; message: string; details: unknown } }
type Outcome = Record<string, Attempt | { count: number; hash: string }>;
interface Saved {
  directory: string; build: { root: string; database: string; project: string; m8: { id: string; revision: number; value: unknown };
    legacy: { directory: string; database: string; plan: { id: string; value: { tasks: { id: string }[] } } } };
  planned: string; base: Record<string, Outcome>; current: Record<string, Outcome>;
}
/** NR1 (№3600): equal outputs but `references`, which name only records of the base's checked trail (local: om-fixture registers the readers). */
function sameButReferences(actual: unknown, expected: unknown, message: string): void {
  const collect = (value: unknown, into: Set<string>): unknown => {
    if (Array.isArray(value)) return value.map(item => collect(item, into));
    if (value === null || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'references' && Array.isArray(item)) {
        for (const ref of item) into.add(JSON.stringify(Object.fromEntries(Object.entries(ref as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1))));
        continue;
      }
      result[key] = collect(item, into);
    }
    return result;
  };
  const mine = new Set<string>(), theirs = new Set<string>();
  assert.deepEqual(collect(JSON.parse(JSON.stringify(actual)), mine), collect(JSON.parse(typeof expected === 'string' ? expected : JSON.stringify(expected)), theirs), message);
  assert.deepEqual([...mine].filter(ref => !theirs.has(ref)), [], `${message}: a trusted reader names only records of the checked trail`);
}
let saved: Promise<Saved> | undefined, built: Saved | undefined;
after(() => {
  if (built) for (const path of [built.directory, built.build.root, built.build.legacy.directory]) rmSync(path, { recursive: true, force: true });
});
/** One saved base for the file; the base and the new implementation each run the scenario on their own copies. */
function savedBases(): Promise<Saved> {
  saved ??= (async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omg-r34-bases-'));
    const build = child(directory, 'build', BUILD, { repository: ROOT, fixtureBase: BASE,
      typescript: pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href }, true) as Saved['build'];
    const planned = join(directory, 'planned.sqlite');
    const config = { directory: '', database: build.database, project: build.project, m8: build.m8, legacy: build.legacy };
    const baseDirectory = mkdtempSync(join(directory, 'base-')), currentDirectory = mkdtempSync(join(directory, 'current-'));
    const base = child(baseDirectory, 'scenario', SCENARIO, { ...config, directory: baseDirectory }, true) as Saved['base'];
    const current = child(currentDirectory, 'scenario', SCENARIO, { ...config, directory: currentDirectory, save: planned }) as Saved['current'];
    return built = { directory, build, planned, base, current };
  })();
  return saved;
}
const value = (outcome: Outcome, name: string): unknown => {
  const attempt = outcome[name] as Attempt;
  assert.ok(attempt && !attempt.error, `${name}: ${JSON.stringify(attempt?.error)}`);
  return attempt.value;
};
const failure = (outcome: Outcome, name: string): NonNullable<Attempt['error']> => {
  const attempt = outcome[name] as Attempt;
  assert.ok(attempt?.error, `${name} must refuse, got ${JSON.stringify(attempt?.value)?.slice(0, 200)}`);
  return attempt.error;
};

test('R3+R4 on a saved legal base the slot reproduces the base implementation exactly: compile, refinement gate, plan gate, basis, sources, context, detail and task obligations — M8, absent and substituted basis, head shift, changed dependency and legacy', { timeout: 600_000 }, async () => {
  const { base, current } = await savedBases();
  assert.equal((base as Record<string, unknown>)['slot'], 'absent', 'The base run executes the base commit, not the current bytes');
  assert.equal((current as Record<string, unknown>)['slot'], 'present');
  for (const variant of ['m8', 'absent', 'substituted', 'legacy'])
    for (const name of new Set([...Object.keys(base[variant]!), ...Object.keys(current[variant]!)]))
      // NR1 (№3600): the trusted readers name the records they read, a subset of the trail the base named; all else is equal.
      if (current[variant]![name] === undefined || base[variant]![name] === undefined)
        assert.deepEqual(current[variant]![name], base[variant]![name], `${variant}.${name}: records/Ref, guards, references, text and hash`);
      else sameButReferences(current[variant]![name], JSON.stringify(base[variant]![name]), `${variant}.${name}: records/Ref, guards, text and hash`);
  // The scenario reached each OM read it claims to compare, rather than agreeing on an early refusal.
  const m8 = current['m8']!, plan = value(m8, 'compile') as { value: { feasibility: Ref; tasks: unknown[] } };
  assert.ok(plan.value.feasibility.id.startsWith('om-feasibility:'));
  assert.deepEqual((value(m8, 'feasibilityGate') as { findings: unknown[] }).findings, []);
  assert.deepEqual((value(m8, 'planGate') as { findings: unknown[] }).findings, []);
  assert.ok(value(m8, 'basis') && value(m8, 'sources'));
  assert.equal((value(m8, 'contexts') as unknown[]).length, plan.value.tasks.length);
  value(m8, 'detail'); value(m8, 'obligations');
  // Historical reads survive the head shift; the current gate refuses the changed dependency.
  assert.deepEqual(value(m8, 'sourcesAfterShift'), value(m8, 'sources'));
  assert.deepEqual(value(m8, 'basisAfterShift'), value(m8, 'basis'));
  assert.notDeepEqual((value(m8, 'feasibilityGateAfterShift') as { findings: unknown[] }).findings, []);
  assert.equal(failure(m8, 'contextsAfterShift').code, 'plan_stale');
  failure(m8, 'compileAfterShift');
  const absent = current['absent']!;
  for (const name of ['basis', 'sources', 'contexts', 'detail', 'obligations', 'compileAbsent']) failure(absent, name);
  assert.notDeepEqual((value(absent, 'feasibilityGate') as { findings: unknown[] }).findings, []);
  const substituted = current['substituted']!;
  for (const name of ['basis', 'sources', 'contexts', 'detail', 'obligations']) failure(substituted, name);
  assert.ok(value(substituted, 'sourcesOriginal'), 'The original plan still reads its exact historical basis');
  const legacy = current['legacy']!;
  assert.equal(value(legacy, 'sources'), null); assert.equal(value(legacy, 'basis'), null);
  value(legacy, 'contexts'); value(legacy, 'compile');
  assert.equal(failure(legacy, 'contextsAfterShift').code, 'plan_stale');
});

/** A cold lower entry: only the lower consumers and the slot, then the product assembly point in the same process. */
const COLD_LOWER = String.raw`
const C = JSON.parse(process.argv[2]);
const { readFileSync } = await import('node:fs');
const { Store } = await import(C.src + 'storage/store.js');
const { canonical } = await import(C.src + 'canonical.js');
const { loadTaskContextSources, taskContext } = await import(C.src + 'compiler/context.js');
const { requireBasis } = await import(C.src + 'compiler/basis.js');
// No lower consumer loads the registrant, not even when all of them are loaded.
await import(C.src + 'compiler/compiler.js'); await import(C.src + 'graph/refinement.js'); await import(C.src + 'execution/task-obligations.js');
const expected = JSON.parse(readFileSync(C.expected, 'utf8'));
const checks = [], check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
const refused = run => { try { return { value: run() }; } catch (error) { return { code: error.code, details: error.details }; } };
const store = new Store(C.planned), legacyStore = new Store(C.legacy);
const rows = () => canonical([store, legacyStore].map(one => one.list().flatMap(row => one.history(row.id))));
const before = rows(), plan = store.get(C.plan), legacyPlan = legacyStore.get(C.legacyPlan);
const address = { unit: 'compiler', target: 'readFeasibility', project: plan.value.projectId, record: plan.value.feasibility };
for (const [name, run] of [['sources', () => loadTaskContextSources(store, plan)], ['basis', () => requireBasis(store, plan.value)]]) {
  const result = refused(run);
  check(name + '-unavailable', canonical(result) === canonical({ code: 'om_compiler_reader_unavailable', details: address }), result);
}
const fullCheck = ({ store, plan }) => store.get(plan.value.environment.id, plan.value.environment.revision).value.fullCheck;
// Legacy branches that need no OM reader keep their outcome without the assembly point.
check('legacy-sources', loadTaskContextSources(legacyStore, legacyPlan) === null);
check('legacy-basis', requireBasis(legacyStore, legacyPlan.value) === undefined);
const legacyContext = taskContext(legacyPlan, fullCheck({ store: legacyStore, plan: legacyPlan }), legacyPlan.value.tasks[0].id, 200000);
check('legacy-context', canonical(legacyContext) === canonical(expected.legacy.contexts.value[0]), legacyContext.hash);
check('no-writes-before', rows() === before);
await import(C.src + 'product/engine.js');
const sources = refused(() => loadTaskContextSources(store, plan));
check('sources-after-assembly', canonical(sources.value) === canonical(expected.m8.sources.value), sources.code);
check('basis-after-assembly', canonical(requireBasis(store, plan.value)) === canonical(expected.m8.basis.value));
const context = taskContext(plan, fullCheck({ store, plan }), plan.value.tasks[0].id, 200000, sources.value);
check('context-after-assembly', canonical(context) === canonical(expected.m8.contexts.value[0]), context.hash);
check('no-writes-after', rows() === before);
store.close(); legacyStore.close();
process.stdout.write(JSON.stringify({ checks }) + '\n');
`;

test('R3+R4 cold lower entry: before the assembly point the M8 consumers refuse with the addressed unavailable slot and write nothing while legacy keeps its outcome; after it, the same process reads exactly', { timeout: 600_000 }, async t => {
  const bases = await savedBases(), directory = workDirectory(t, 'cold-lower');
  const planned = join(directory, 'planned.sqlite'), legacy = join(directory, 'legacy.sqlite'), expected = join(directory, 'expected.json');
  copyFileSync(bases.planned, planned); copyFileSync(bases.build.legacy.database, legacy);
  writeFileSync(expected, JSON.stringify(bases.current));
  const plan = (bases.current['m8']!['compile'] as Attempt).value as { id: string };
  coldChecks(child(directory, 'cold-lower', COLD_LOWER, { planned, legacy, expected, plan: plan.id, legacyPlan: bases.build.legacy.plan.id }));
});

/** Product entries in their own cold processes: a real task-context request reaches the OM reads through the slot. */
const ENTRY = String.raw`
const C = JSON.parse(process.argv[2]);
const { readFileSync } = await import('node:fs');
const checks = [], check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
const expected = JSON.parse(readFileSync(C.expected, 'utf8'));
let server = null;
if (C.entry === 'server-first') server = await import(C.src + 'server.js');
const { ProductEngine } = await import(C.src + 'product/engine.js');
const { Store } = await import(C.src + 'storage/store.js');
const { canonical } = await import(C.src + 'canonical.js');
const store = new Store(C.planned), engine = new ProductEngine(store);
const request = { type: 'task-context', project: C.project, plan: C.plan, task: C.task, maxChars: 200000 };
const want = canonical(expected.m8.contexts.value[0]);
if (C.entry === 'engine') {
  const context = await engine.execute(request);
  check('engine-task-context', canonical(context) === want, context?.hash);
  // The slot hands the reader the caller's Store itself: a traced Store observes the same reads as the OM reader called directly.
  const { historicalTrace, withHistoricalReads } = await import(C.src + 'history/proofs.js');
  const slot = await import(C.src + 'compiler/om-readers.js'), direct = await import(C.src + 'om/feasibility.js');
  const traced = reader => withHistoricalReads(() => { const refs = [];
    const result = reader(historicalTrace(store, ref => { refs.push(ref); }, 'distinct'), { project: C.project, record: C.feasibility });
    return { refs, result }; });
  const viaSlot = traced(slot.readFeasibility), viaReader = traced(direct.readFeasibility);
  check('observed-reads', viaSlot.refs.length > 0 && canonical(viaSlot.refs) === canonical(viaReader.refs), [viaSlot.refs.length, viaReader.refs.length]);
  check('observed-result', viaSlot.result.ok && canonical(viaSlot.result) === canonical(viaReader.result));
} else {
  const { createProductServer } = server;
  const http = createProductServer(engine);
  await new Promise(done => http.listen(0, '127.0.0.1', done));
  try {
    const response = await fetch('http://127.0.0.1:' + http.address().port + '/api/command', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-omg-token': http.accessToken }, body: JSON.stringify(request) });
    const body = await response.json();
    check('server-first-task-context', response.status === 200 && canonical(body) === want, [response.status, body?.code ?? body?.hash]);
  } finally { await new Promise(done => http.close(done)); }
}
store.close();
process.stdout.write(JSON.stringify({ checks }) + '\n');
`;

for (const entry of ['engine', 'server-first'] as const) {
  test(`R3+R4 cold ${entry} entry: a real task-context request reads the saved M8 base through the installed slot`, { timeout: 600_000 }, async t => {
    const bases = await savedBases(), directory = workDirectory(t, entry);
    const planned = join(directory, 'planned.sqlite'), expected = join(directory, 'expected.json');
    copyFileSync(bases.planned, planned); writeFileSync(expected, JSON.stringify(bases.current));
    const plan = (bases.current['m8']!['compile'] as Attempt).value as { id: string; revision: number; hash: string;
      value: { feasibility: Ref; tasks: { id: string }[] } };
    coldChecks(child(directory, entry, ENTRY, { entry, planned, expected, project: bases.build.project,
      plan: { id: plan.id, revision: plan.revision, hash: plan.hash }, task: plan.value.tasks[0]!.id, feasibility: plan.value.feasibility }));
  });
}

test('R3+R4 cold CLI command: a real task-context request reads the saved M8 base through the installed slot', { timeout: 600_000 }, async t => {
  const bases = await savedBases(), directory = workDirectory(t, 'cli');
  const planned = join(directory, 'planned.sqlite'); copyFileSync(bases.planned, planned);
  const plan = (bases.current['m8']!['compile'] as Attempt).value as { id: string; revision: number; hash: string; value: { tasks: { id: string }[] } };
  const environment = { ...process.env }; delete environment['NODE_TEST_CONTEXT'];
  const output = execFileSync(process.execPath, [join(ROOT, 'dist/src/cli.js'), 'command', planned], { cwd: directory, env: environment,
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: JSON.stringify({ type: 'task-context', project: bases.build.project,
      plan: { id: plan.id, revision: plan.revision, hash: plan.hash }, task: plan.value.tasks[0]!.id, maxChars: 200000 }) });
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)!), ((bases.current['m8']!['contexts'] as Attempt).value as unknown[])[0]);
});

test('R3+R4 the registrant is the only installer and the slot never loads it: its source names no OM, product or compiler implementation and imports nothing dynamically', () => {
  const slot = readFileSync(join(ROOT, 'src/compiler/om-readers.ts'), 'utf8');
  assert.equal(/\bimport\s*\(/.test(slot), false);
  assert.deepEqual([...slot.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]).sort(),
    ['../canonical.js', '../errors.js', '../graph/model.js', '../pipeline/contracts.js', '../storage/store.js']);
  const registrant = readFileSync(join(ROOT, 'src/om/compiler-readers.ts'), 'utf8');
  assert.equal((registrant.match(/registerCompilerOmReaders\(/g) ?? []).length, 1, 'One installation');
  for (const name of NAMES) assert.ok(registrant.includes(name), name);
});
