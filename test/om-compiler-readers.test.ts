import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/** Runs a module script in a fresh process against the current source. */
function child(directory: string, name: string, source: string, config: Record<string, unknown>): unknown {
  const script = join(directory, `${name}.mjs`);
  writeFileSync(script, source);
  const environment = { ...process.env }; delete environment['NODE_TEST_CONTEXT'];
  const output = execFileSync(process.execPath, [script, JSON.stringify({ src: SRC, tst: TST, ...config })],
    { cwd: ROOT, env: environment, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(output.trim().split('\n').at(-1)!) as unknown;
}




interface Attempt { value?: unknown; error?: { name: string | null; code: string | null; message: string; details: unknown } }
type Outcome = Record<string, Attempt | { count: number; hash: string }>;
interface CurrentSaved {
  directory: string; build: { root: string; workspace: string; database: string; project: string; m8: { id: string; revision: number; value: unknown } };
  planned: string; current: Record<string, Outcome>;
}

/** Current legal base M8: the accepted works of om-feasibility.test produced by current code with its own live workspace. */
const BUILD_CURRENT = String.raw`
const C = JSON.parse(process.argv[2]);
const { readFileSync } = await import('node:fs');
const url = new URL('om-feasibility.test.js', C.tst);
const compiled = readFileSync(url, 'utf8'), end = compiled.indexOf('const heads =');
if (end < 0) throw new Error('The declared om-feasibility fixture seam moved');
let source = compiled.slice(0, end).replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_match, _quote, path) => 'from ' + JSON.stringify(new URL(path, url).href));
if (/\btest\(/.test(source)) throw new Error('The fixture slice must not declare a test');
const { acceptedWorksFixture } = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { acceptedWorksFixture };').toString('base64'));
const { writeFeasibility } = await import(C.src + 'om/feasibility.js');
const { writeHandoff } = await import(C.src + 'om/handoff.js');
const { reference } = await import(C.src + 'pipeline/contracts.js');
const ok = result => { if (!result.ok) throw new Error('Unexpected refusal ' + result.refusal.code); return result.value; };
const f = acceptedWorksFixture({ after() {} });
const m8 = ok(writeFeasibility(f.store, f.feasibility));
ok(writeHandoff(f.store, { project: f.project, feasibility: reference(m8), expected: 0 }));
f.store.close();
process.stdout.write(JSON.stringify({ root: f.root, workspace: f.workspace, database: f.database, project: f.project, m8 }) + '\n');
`;

const SCENARIO_CURRENT = String.raw`
const C = JSON.parse(process.argv[2]);
const { copyFileSync } = await import('node:fs');
const { Store } = await import(C.src + 'storage/store.js');
const { ProductEngine } = await import(C.src + 'product/engine.js');
const { reference } = await import(C.src + 'pipeline/contracts.js');
const { hashJson, canonical } = await import(C.src + 'canonical.js');
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
const result = { slot: 'present' }, project = C.project;
{
  const out = result.m8 = {}, database = C.directory + '/m8.sqlite'; copyFileSync(C.database, database);
  let { store, engine } = open(database);
  const plan = store.get(compiled(out, engine, project).id);
  reads(out, '', store, engine, project, plan);
  if (C.save) { store.close(); copyFileSync(database, C.save); ({ store, engine } = open(database)); }
  out.rows = rows(store); store.close();
}
process.stdout.write(JSON.stringify(result) + '\n');
`;

let currentSaved: Promise<CurrentSaved> | undefined, currentBuilt: CurrentSaved | undefined;
function currentSavedBases(): Promise<CurrentSaved> {
  currentSaved ??= (async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omg-r34-current-bases-'));
    const build = child(directory, 'build-current', BUILD_CURRENT, { repository: ROOT }) as CurrentSaved['build'];
    const planned = join(directory, 'planned.sqlite');
    const config = { directory: '', database: build.database, project: build.project, m8: build.m8 };
    const currentDirectory = mkdtempSync(join(directory, 'current-'));
    const current = child(currentDirectory, 'scenario-current', SCENARIO_CURRENT, { ...config, directory: currentDirectory, save: planned }) as CurrentSaved['current'];
    return currentBuilt = { directory, build, planned, current };
  })();
  return currentSaved;
}

after(() => {
  if (currentBuilt) for (const path of [currentBuilt.directory, currentBuilt.build.root]) rmSync(path, { recursive: true, force: true });
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
const store = new Store(C.planned);
const rows = () => canonical(store.list().flatMap(row => store.history(row.id)));
const before = rows(), plan = store.get(C.plan);
const address = { unit: 'compiler', target: 'readFeasibility', project: plan.value.projectId, record: plan.value.feasibility };
for (const [name, run] of [['sources', () => loadTaskContextSources(store, plan)], ['basis', () => requireBasis(store, plan.value)]]) {
  const result = refused(run);
  check(name + '-unavailable', canonical(result) === canonical({ code: 'om_compiler_reader_unavailable', details: address }), result);
}
const fullCheck = ({ store, plan }) => store.get(plan.value.environment.id, plan.value.environment.revision).value.fullCheck;
check('no-writes-before', rows() === before);
await import(C.src + 'product/engine.js');
const sources = refused(() => loadTaskContextSources(store, plan));
check('sources-after-assembly', canonical(sources.value) === canonical(expected.m8.sources.value), sources.code);
check('basis-after-assembly', canonical(requireBasis(store, plan.value)) === canonical(expected.m8.basis.value));
const context = taskContext(plan, fullCheck({ store, plan }), plan.value.tasks[0].id, 200000, sources.value);
check('context-after-assembly', canonical(context) === canonical(expected.m8.contexts.value[0]), context.hash);
check('no-writes-after', rows() === before);
store.close();
process.stdout.write(JSON.stringify({ checks }) + '\n');
`;

test('R3+R4 cold lower entry: before the assembly point the M8 consumers refuse with the addressed unavailable slot and write nothing while legacy keeps its outcome; after it, the same process reads exactly', { timeout: 600_000 }, async t => {
  const bases = await currentSavedBases(), directory = workDirectory(t, 'cold-lower');
  const planned = join(directory, 'planned.sqlite'), expected = join(directory, 'expected.json');
  copyFileSync(bases.planned, planned);
  writeFileSync(expected, JSON.stringify(bases.current));
  const plan = (bases.current['m8']!['compile'] as Attempt).value as { id: string };
  coldChecks(child(directory, 'cold-lower', COLD_LOWER, { planned, expected, plan: plan.id }));
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
    const bases = await currentSavedBases(), directory = workDirectory(t, entry);
    const planned = join(directory, 'planned.sqlite'), expected = join(directory, 'expected.json');
    copyFileSync(bases.planned, planned); writeFileSync(expected, JSON.stringify(bases.current));
    const plan = (bases.current['m8']!['compile'] as Attempt).value as { id: string; revision: number; hash: string;
      value: { feasibility: Ref; tasks: { id: string }[] } };
    coldChecks(child(directory, entry, ENTRY, { entry, planned, expected, project: bases.build.project,
      plan: { id: plan.id, revision: plan.revision, hash: plan.hash }, task: plan.value.tasks[0]!.id, feasibility: plan.value.feasibility }));
  });
}

test('R3+R4 cold CLI command: a real task-context request reads the saved M8 base through the installed slot', { timeout: 600_000 }, async t => {
  const bases = await currentSavedBases(), directory = workDirectory(t, 'cli');
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
