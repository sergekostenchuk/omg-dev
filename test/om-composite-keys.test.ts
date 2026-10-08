import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, compareKeys, compositeKey, hashJson } from '../src/canonical.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { LEVEL } from '../src/graph/model.js';
import { acceptedLevelOf } from '../src/om/obligations.js';
import { QUEUE_POLICY_VERSION, computeBlockWeights, type QueuePolicy } from '../src/om/queue.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import type { AcceptedFrameRequest } from '../src/om/frame-accept.js';
import type { FrameRequest } from '../src/om/frame-obligations.js';
import { writeHorizon } from '../src/om/horizon.js';
import type { OmResult } from '../src/om/refusal.js';
import {
  ACHIEVED_ORDER, applySeriesActivation, completeAttempt, openSeries, readAppliedSeriesTransition, readCurrentSeriesPointer, readSeries, readSeriesAt,
  seriesEraId, type AppliedSeriesTransition, type CompleteAttemptRequest, type RepairSeries, type SeriesActivationRequest, type SeriesEra,
} from '../src/om/series.js';
import {
  SOURCE_ORDER, UNIT_REFUSAL_KIND, classifyRefusal, readJournalAt, recordRefusal, unitRefusalNamespace, type ClassifyRefusalRequest,
  type RefusalJournal,
} from '../src/om/refusal-journal.js';
import { gardenGraph } from './om-fixture.js';

// Q3 (№2549): a composite key of a canonical order is the canonical tuple of its parts, ordered by code units; the
// maximum of a possibly empty set is an explicit refusal, never -Infinity cast to a level.

test('Q3 compositeKey is unambiguous where a separator-joined key is not, and keeps a fixed arity', () => {
  // Two different tuples that a space or NUL join cannot tell apart.
  assert.equal(['a b', 'c'].join(' '), ['a', 'b c'].join(' '));
  assert.notEqual(compositeKey(['a b', 'c']), compositeKey(['a', 'b c']));
  assert.equal(['a\0b', 'c'].join('\0'), ['a', 'b\0c'].join('\0'));
  assert.notEqual(compositeKey(['a\0b', 'c']), compositeKey(['a', 'b\0c']));
  // Numbers stay numbers and strings stay strings: the revision 1 is not the id "1".
  assert.notEqual(compositeKey(['x', 1]), compositeKey(['x', '1']));
  // An absent part is null in its place; a shorter tuple would sort elsewhere.
  assert.equal(compositeKey(['role', 'id', 1, 'h', null]), '["role","id",1,"h",null]');
  assert.ok(compareKeys(compositeKey(['r', 'id', 1, 'h', null]), compositeKey(['r', 'id', 1, 'h', { kind: 'frame' }])) < 0);
  assert.ok(compareKeys(compositeKey(['r', 'id', 1, 'h']), compositeKey(['r', 'id', 1, 'h', { kind: 'frame' }])) > 0,
    'Without the fixed arity a shorter tuple would sort after a longer one: the reason each caller fixes it');
  // The key is the canonical encoding itself; canonical and hashJson are unchanged.
  assert.equal(compositeKey(['b', { z: 1, a: [2, 'x'] }]), canonical(['b', { a: [2, 'x'], z: 1 }]));
  assert.equal(canonical({ z: 1, a: [2, 'x', null, true] }), '{"a":[2,"x",null,true],"z":1}');
  assert.equal(hashJson({ z: 1, a: [2, 'x'] }), hashJson({ a: [2, 'x'], z: 1 }));
});

test('Q3 compareKeys is the code-unit order, never the locale order', () => {
  assert.equal(compareKeys('B', 'a'), -1, 'Upper-case letters come first by code unit');
  assert.equal(compareKeys('a', 'a'), 0);
  assert.equal(compareKeys('a!', 'a'), 1);
  const keys = ['b', 'B', 'a-b', 'ab', 'a'];
  assert.deepEqual([...keys].sort(compareKeys), ['B', 'a', 'a-b', 'ab', 'b']);
  // The order a separator join gave and the order of the canonical tuple can differ on legal parts — the reason the
  // saved orders keep their era (№2549-3): a NUL join puts "a" first, the tuple puts "a!" first.
  const joined = [['a', 'x'], ['a!', 'x']].sort((left, right) => compareKeys(left.join('\0'), right.join('\0')));
  const tupled = [['a', 'x'], ['a!', 'x']].sort((left, right) => compareKeys(compositeKey(left), compositeKey(right)));
  assert.deepEqual(joined.map(item => item[0]), ['a', 'a!']);
  assert.deepEqual(tupled.map(item => item[0]), ['a!', 'a']);
});

function upper(): Graph {
  const { level: _level, ...graph } = projectGraph(gardenGraph(), 1);
  return graph as Graph;
}
function policy(graph: Graph): QueuePolicy {
  const layer: Ref = { id: 'graph-layer:garden:1', revision: 1, hash: hashJson(graph) };
  const journey = graph.journeys!.find(item => item.terminal === 'success' && item.outcome === 'garden-result')!;
  return { version: QUEUE_POLICY_VERSION, machinePath: { layer, journeyId: journey.id, actorId: journey.actor, outcomeId: journey.outcome } };
}

test('Q3 the queue maximum: an empty horizon is refused before the maximum, and the maximum of a nonempty one is unchanged', () => {
  const graph = upper(), blocks = graph.nodes.filter(node => node.kind === 'block').map(node => node.id);
  const empty = computeBlockWeights(graph, [], policy(graph));
  if (empty.ok) assert.fail('An empty horizon has no maximum');
  assert.deepEqual([empty.refusal.code, empty.refusal.at.unit, empty.refusal.at.target, empty.refusal.at.field, empty.refusal.route],
    ['queue_source_invalid', 'M3', 'horizon', 'nodes', 'producer']);
  const full = computeBlockWeights(graph, blocks, policy(graph));
  if (!full.ok) assert.fail(full.refusal.code);
  assert.equal(full.value.maxD, Math.max(...full.value.order.map(row => row.D)));
  assert.equal(full.value.maxD, 2, 'The garden producer has two dependents across the whole upper layer');
});

test('Q3 D7 accepted level: the intersection with the exact graph is checked before any maximum, and only matched nodes count', () => {
  // The same function context() in obligations.ts calls; the guard of an invariant at its boundary (№2557), not a claim
  // that a public producer reaches it.
  const graph = gardenGraph(), graphRef: Ref = { id: 'graph:garden', revision: 3, hash: hashJson(graph) };
  const refusal = (nodes: ReadonlySet<string>) => {
    const result = acceptedLevelOf(graph, nodes, graphRef);
    if (result.ok) assert.fail('An empty intersection has no level');
    return [result.refusal.code, result.refusal.message, result.refusal.at.unit, result.refusal.at.target, result.refusal.at.field, result.refusal.route];
  };
  const expected = ['obligation_context_mismatch', 'The accepted frames must name nodes of the exact graph', 'D7', 'graph:garden', 'frames', 'producer'];
  assert.deepEqual(refusal(new Set()), expected, 'Empty accepted nodes');
  assert.deepEqual(refusal(new Set(['foreign-block', 'foreign-work'])), expected, 'Accepted nodes that name no node of the graph');
  const block = graph.nodes.find(node => node.kind === 'block')!, work = graph.nodes.find(node => node.kind === 'work')!;
  const level = (nodes: ReadonlySet<string>) => { const result = acceptedLevelOf(graph, nodes, graphRef); if (!result.ok) assert.fail(result.refusal.code); return result.value; };
  assert.equal(level(new Set([block.id, 'foreign-work'])), LEVEL.block, 'A foreign id adds no level');
  assert.equal(level(new Set([block.id, work.id, 'foreign-block'])), LEVEL.work, 'The maximum of the matched nodes');
  assert.equal(level(new Set(graph.nodes.map(node => node.id))), Math.max(...graph.nodes.map(node => LEVEL[node.kind])));
});

// ---- The era of the saved orders (№2549-3/4, №2556): records of fec6932 — legal pairs a/a! — keep their order for reading
// and exact repeat; new series, applications and journals carry the new order and use it.
const BASE = 'fec693225ac3a0e92e1a8fd88bc26abe06554386';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
/** A test file as a module of its fixtures: its imports and declarations, without one call of test(). */
function fixturesOf(source: string, names: readonly string[], fileName: string): string {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const kept = file.statements.filter(statement => ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement)
    || ts.isVariableStatement(statement) || ts.isClassDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
    || ts.isInterfaceDeclaration(statement) || ts.isEnumDeclaration(statement));
  return `${kept.map(statement => source.slice(statement.getFullStart(), statement.getEnd())).join('\n')}\nexport { ${names.join(', ')} };\n`;
}
const BASE_LOADER = String.raw`import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let root, base, ts, fixtures;
export async function initialize(data) { root = data.root; base = data.base; ts = (await import(data.typescript)).default; fixtures = new Function('ts', 'return ' + data.fixtures)(ts); }
export async function load(url, context, next) {
  const prefix = new URL('dist/', root).href;
  if (url.startsWith(prefix) && /\.js$/.test(url)) {
    // Every product module and fixture of the producer comes from its own commit, never from the current source.
    const relative = url.slice(prefix.length).replace(/\.js$/, '.ts');
    let source = execFileSync('git', ['show', base + ':' + relative], { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 20000000 });
    if (relative === 'test/om-series-current.test.ts')
      source = fixtures(source, ['fixture', 'transition', 'workGoal', 'project', 'block', 'independent', 'opaqueSlice'], relative);
    return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return next(url, context);
}
`;
const PRODUCER = String.raw`import assert from 'node:assert/strict';
const C = JSON.parse(process.argv[2]), from = relative => import(new URL('dist/' + relative, C.root).href);
const { fixture, transition, workGoal, project, block, independent } = await from('test/om-series-current.test.js');
const { Store } = await from('src/storage/store.js');
const { reference } = await from('src/pipeline/contracts.js');
const series = await from('src/om/series.js'), journal = await from('src/om/refusal-journal.js');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const cleanup = [], f = fixture({ after: fn => cleanup.push(fn) });
// A managed line whose closed attempt achieved the legal pair a!/a, its activation, and the root registered after it.
const opened = f.series(), basis = reference(f.graph);
ok(series.beginAttempt(f.store, { project, block, line: 1, attempt: 1, goal: workGoal }));
const closeRequest = { project, block, line: 1, attempt: 1, outcome: { reason: 'result', achieved: [{ key: 'a!', basis }, { key: 'a', basis }], cancelled: [], refusals: [] } };
const closed = ok(series.completeAttempt(f.store, closeRequest));
const first = transition(f, 'q3-base', { features: [{ outcome: 'garden-result' }, { outcome: 'garden-later' }] });
const activated = ok(series.applySeriesActivation(f.store, first.request));
const registered = f.series(independent);
// A journal whose row holds the legal roles a!/a, with and without a context, and a classification of it.
const frame = { project, level: 2, horizon: reference(first.horizon.gate), graph: basis, layer: null, frame: null, upper: null };
const sources = [{ role: 'a!', ref: basis }, { role: 'a', ref: basis, context: { kind: 'frame', request: frame } }, { role: 'a', ref: basis }];
const [unit] = f.store.writeMany([{ id: journal.unitRefusalNamespace(project) + 'q3-era', kind: journal.UNIT_REFUSAL_KIND, expected: 0,
  value: { gate: 'G1', refusals: [{ code: 'q3_probe', goal: 'goal', remedy: 'fix', origin: { name: 'probe', stage: 'stage', subject: 'subject', sources } }] } }]);
const recorded = ok(journal.recordRefusal(f.store, { project, source: reference(unit) }));
const row = recorded.value.rows.find(item => item.source.id === unit.id).id;
const classifyRequest = { project, row, class: 'q3-class', addressee: 'owner:q3', basis: [{ role: 'a!', ref: basis }, { role: 'a', ref: basis }] };
const classified = ok(journal.classifyRefusal(f.store, classifyRequest));
// A standalone line of another project with the same pair.
const standalone = new Store(C.standalone), [evidence] = standalone.writeMany([{ id: 'evidence:p', kind: 'evidence', expected: 0, value: { result: true } }]);
const own = { project: 'p', block: 'b', line: 1 };
ok(series.openSeries(standalone, { ...own, slice: 'legacy', predecessor: null, basis: null }));
ok(series.beginAttempt(standalone, { ...own, attempt: 1, goal: { key: 'goal', questions: ['Question'], result: 'Result' } }));
const standaloneRequest = { ...own, attempt: 1, outcome: { reason: 'result', achieved: [{ key: 'a!', basis: reference(evidence) }, { key: 'a', basis: reference(evidence) }], cancelled: [], refusals: [] } };
const standaloneClosed = ok(series.completeAttempt(standalone, standaloneRequest));
standalone.close();
const out = { root: f.root, database: f.path, input: f.input, graph: basis, horizon: reference(first.horizon.gate), pair: first.request,
  opened, closeRequest, closed, activated: activated.record, pointer: activated.pointer, registered, unit, recorded, row, classifyRequest, classified,
  standaloneRequest, standaloneClosed };
f.store.close();
process.stdout.write(JSON.stringify(out) + '\n');
`;
interface Produced {
  root: string; database: string; input: Revision; graph: Ref; horizon: Ref; pair: SeriesActivationRequest;
  opened: Revision<RepairSeries>; closeRequest: CompleteAttemptRequest; closed: Revision<RepairSeries>; activated: Revision<AppliedSeriesTransition>;
  pointer: Revision; registered: Revision<RepairSeries>; unit: Revision; recorded: Revision<RefusalJournal>; row: string;
  classifyRequest: ClassifyRefusalRequest; classified: Revision<RefusalJournal>; standaloneRequest: CompleteAttemptRequest; standaloneClosed: Revision<RepairSeries>;
}
function produce(t: TestContext): Produced {
  const directory = mkdtempSync(join(tmpdir(), 'omg-q3-era-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const loader = join(directory, 'loader.mjs'), producer = join(directory, 'producer.mjs');
  writeFileSync(loader, BASE_LOADER); writeFileSync(producer, PRODUCER);
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href, root = pathToFileURL(ROOT).href;
  const boot = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},{data:${JSON.stringify(
    { root, base: BASE, typescript, fixtures: fixturesOf.toString() })}});`;
  const environment = { ...process.env }; delete environment['NODE_TEST_CONTEXT'];
  const output = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(boot)}`, producer,
    JSON.stringify({ root, standalone: join(directory, 'standalone.sqlite') })], { cwd: ROOT, env: environment, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const produced = JSON.parse(output.trim().split('\n').at(-1)!) as Produced & { standalone?: string };
  t.after(() => rmSync(produced.root, { recursive: true, force: true }));
  return { ...produced, standalone: join(directory, 'standalone.sqlite') } as Produced & { standalone: string };
}
/** The fixtures of the current om-series-current.test, assembled the same way, for the steps the new code takes. */
async function currentFixtures(): Promise<{
  acceptMappedFrame(f: { store: Store }, frame: FrameRequest): AcceptedFrameRequest;
  changedPair(f: { store: Store; input: Revision }, acceptance: AcceptedFrameRequest, choiceVersion: string): SeriesActivationRequest;
  appliedPair(f: { store: Store }, horizon: Ref, choiceVersion: string): SeriesActivationRequest;
}> {
  const url = new URL('./om-series-current.test.js', import.meta.url), file = fileURLToPath(url);
  const source = fixturesOf(readFileSync(file, 'utf8'), ['acceptMappedFrame', 'changedPair', 'appliedPair'], file)
    .replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`)
    // A data: module has no file of its own: paths the fixtures resolve against the test file stay that file's.
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as Awaited<ReturnType<typeof currentFixtures>>;
}
const keys = (series: Revision<RepairSeries> | RepairSeries, index = 0, inherited = false) => {
  const value = 'value' in series ? series.value : series;
  return (inherited ? value.inherited : value.attempts)[index]!.outcome!.achieved.map(item => item.key);
};
const history = (store: Store) => canonical(store.list().flatMap(row => store.history(row.id)));
const okq = <T>(result: OmResult<T>): T => { if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message} ${canonical(result.refusal.at)}`); return result.value; };

test('Q3 era: fec6932 series, application, registration and journal are read and repeated exactly by the new code, without writes', { timeout: 600_000 }, async t => {
  const produced = produce(t);
  let store = new Store(produced.database);
  t.after(() => store.close());
  const before = history(store);
  // The legal pair stays in the order fec6932 wrote it: [a, a!] for the space key, [a, a+ctx, a!] / [a, a!] for the NUL key.
  const closed = okq(readSeriesAt(store, 'garden', reference(produced.closed)));
  assert.deepEqual(closed, produced.closed); assert.deepEqual(keys(closed), ['a', 'a!']); assert.equal(Object.hasOwn(closed.value, 'achievedOrder'), false);
  const applied = okq(readAppliedSeriesTransition(store, { project: 'garden', record: reference(produced.activated) }));
  assert.deepEqual(applied, produced.activated); assert.equal(Object.hasOwn(applied.value, 'achievedOrder'), false);
  okq(readCurrentSeriesPointer(store, { project: 'garden', record: reference(produced.pointer) }));
  assert.deepEqual(okq(readSeriesAt(store, 'garden', reference(produced.registered))), produced.registered);
  const era = store.get<SeriesEra>(seriesEraId('garden', produced.registered.id), 1)!;
  assert.equal(era.value.origin.kind, 'registration'); assert.equal(Object.hasOwn(era.value.origin, 'achievedOrder'), false);
  const journal = okq(readJournalAt(store, 'garden', reference(produced.classified)));
  assert.deepEqual(journal, produced.classified); assert.equal(Object.hasOwn(journal.value, 'sourceOrder'), false);
  const row = journal.value.rows.find(item => item.id === produced.row)!;
  assert.deepEqual(row.origin.sources.map(source => [source.role, Object.hasOwn(source, 'context')]), [['a', false], ['a', true], ['a!', false]]);
  assert.deepEqual(journal.value.classifications.find(item => item.row === produced.row)!.basis.map(source => source.role), ['a', 'a!']);
  // Exact repeats of each producer add no revision.
  assert.deepEqual(okq(applySeriesActivation(store, produced.pair)).writes, []);
  okq(openSeries(store, { project: 'garden', block: produced.opened.value.block, line: 1, slice: produced.opened.value.slice, predecessor: null, basis: null }));
  okq(openSeries(store, { project: 'garden', block: produced.registered.value.block, line: 1, slice: produced.registered.value.slice, predecessor: null, basis: null }));
  okq(completeAttempt(store, produced.closeRequest));
  okq(recordRefusal(store, { project: 'garden', source: reference(produced.unit) }));
  okq(classifyRefusal(store, produced.classifyRequest));
  assert.equal(history(store), before, 'No producer rewrote or extended a record of the earlier era');
  store.close(); store = new Store(produced.database);
  assert.deepEqual(okq(readSeriesAt(store, 'garden', reference(produced.closed))), produced.closed);
  assert.deepEqual(okq(readJournalAt(store, 'garden', reference(produced.classified))), produced.classified);
  // A standalone line of fec6932 likewise.
  const standalone = new Store((produced as Produced & { standalone: string }).standalone);
  try {
    const own = okq(readSeriesAt(standalone, 'p', reference(produced.standaloneClosed)));
    assert.deepEqual(keys(own), ['a', 'a!']);
    const prior = history(standalone); okq(completeAttempt(standalone, produced.standaloneRequest)); assert.equal(history(standalone), prior);
  } finally { standalone.close(); }
});

test('Q3 era: new code continues an old line in its own order and creates new lines, applications and journals in the new order', { timeout: 600_000 }, async t => {
  const produced = produce(t), helpers = await currentFixtures();
  let store = new Store(produced.database);
  t.after(() => store.close());
  const horizon = (choiceVersion: string) => okq(writeHorizon(store, { project: 'garden', input: reference(store.get(produced.input.id)!),
    graph: reference(store.get(produced.graph.id)!), refinement: null, available: {},
    choice: { choiceVersion, features: [{ outcome: 'garden-result' }, { outcome: 'garden-later' }], excluded: [] } }));
  // A continuing application over the old line: the line keeps its own era.
  const continuing = okq(applySeriesActivation(store, helpers.appliedPair({ store }, reference(horizon('q3-continue').gate), 'q3-continue')));
  assert.equal(continuing.record.value.decisions.find(row => row.block === produced.opened.value.block)!.outcome, 'continue');
  assert.equal(continuing.record.value.achievedOrder, ACHIEVED_ORDER, 'A new application records the order of the new lines it would create');
  const line = okq(readSeries(store, { project: 'garden', block: produced.opened.value.block, line: 1 }));
  assert.equal(Object.hasOwn(line.value, 'achievedOrder'), false); assert.deepEqual(keys(line), ['a', 'a!']);
  // new-work: the successor is of the new order; the predecessor stays exactly as it stood, proved in its own era.
  const accepted = helpers.acceptMappedFrame({ store }, { project: 'garden', level: 2, graph: produced.graph, horizon: produced.horizon,
    layer: null, frame: null, upper: null });
  const predecessor = reference(store.get(produced.opened.id)!);
  const pair = helpers.changedPair({ store, input: produced.input }, accepted, 'q3-new-work');
  const newWork = okq(applySeriesActivation(store, pair));
  assert.equal(newWork.record.value.decisions.find(row => row.block === produced.opened.value.block)!.outcome, 'new-work');
  const successor = newWork.series.find(row => row.value.block === produced.opened.value.block)!;
  assert.equal(successor.value.line, 2); assert.equal(successor.value.achievedOrder, ACHIEVED_ORDER);
  assert.deepEqual(successor.value.predecessor, predecessor);
  assert.deepEqual(keys(successor, 0, true), ['a!', 'a'], 'The inherited outcome is copied in the order of the successor');
  assert.deepEqual(okq(readSeriesAt(store, 'garden', predecessor)).value.attempts[0]!.outcome!.achieved.map(item => item.key), ['a', 'a!']);
  const repeat = history(store);
  assert.deepEqual(okq(applySeriesActivation(store, pair)).writes, [], 'The exact repeat of the new-work application writes nothing');
  assert.equal(history(store), repeat);
  store.close(); store = new Store(produced.database);
  assert.deepEqual(okq(readSeriesAt(store, 'garden', reference(successor))), successor);
  assert.deepEqual(okq(readAppliedSeriesTransition(store, { project: 'garden', record: reference(newWork.record) })), newWork.record);
  // A standalone successor opened by the new code over the fec6932 line.
  const standalone = new Store((produced as Produced & { standalone: string }).standalone);
  try {
    const next = okq(openSeries(standalone, { project: 'p', block: 'b', line: 2, slice: 'next', predecessor: reference(produced.standaloneClosed),
      basis: { ground: 'inputs-changed', text: 'The slice moved' } }));
    assert.equal(next.value.achievedOrder, ACHIEVED_ORDER); assert.deepEqual(next.value.predecessor, reference(produced.standaloneClosed));
    assert.deepEqual(keys(next, 0, true), ['a!', 'a']);
    assert.deepEqual(okq(readSeriesAt(standalone, 'p', reference(next))), next);
  } finally { standalone.close(); }
  // A journal the new code creates: the new order, marked on every revision, its classification too.
  const basis = produced.graph, sources = [{ role: 'a!', ref: basis }, { role: 'a', ref: basis, context: { kind: 'frame' as const, request:
    { project: 'q', level: 2 as const, horizon: produced.horizon, graph: basis, layer: null, frame: null, upper: null } } }, { role: 'a', ref: basis }];
  const [unit] = store.writeMany([{ id: `${unitRefusalNamespace('q')}q3-new`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: { gate: 'G1', refusals: [{ code: 'q3_probe', goal: 'goal', remedy: 'fix', origin: { name: 'probe', stage: 'stage', subject: 'subject', sources } }] } }]);
  const recorded = okq(recordRefusal(store, { project: 'q', source: reference(unit!) }));
  assert.equal(recorded.value.sourceOrder, SOURCE_ORDER);
  assert.deepEqual(recorded.value.rows[0]!.origin.sources.map(source => [source.role, Object.hasOwn(source, 'context')]), [['a!', false], ['a', false], ['a', true]]);
  const classified = okq(classifyRefusal(store, { project: 'q', row: recorded.value.rows[0]!.id, class: 'q3-class', addressee: 'owner:q3',
    basis: [{ role: 'a', ref: basis }, { role: 'a!', ref: basis }] }));
  assert.equal(classified.value.sourceOrder, SOURCE_ORDER);
  assert.deepEqual(classified.value.classifications[0]!.basis.map(source => source.role), ['a!', 'a']);
  store.close(); store = new Store(produced.database);
  assert.deepEqual(okq(readJournalAt(store, 'q', reference(classified))), classified);
});

test('Q3 era: an absent marker is the earlier era, a present unknown one is an addressed refusal', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-q3-marker-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const [evidence] = store.writeMany([{ id: 'evidence:p', kind: 'evidence', expected: 0, value: { result: true } }]);
  const opened = okq(openSeries(store, { project: 'p', block: 'b', line: 1, slice: 'own', predecessor: null, basis: null }));
  assert.equal(opened.value.achievedOrder, ACHIEVED_ORDER);
  const marked = store.write({ id: opened.id, kind: opened.kind, expected: opened.revision, value: { ...opened.value, achievedOrder: 'composite-key/v0' } });
  const refused = readSeriesAt(store, 'p', reference(marked));
  if (refused.ok) assert.fail('An unknown order is no order of this unit');
  assert.deepEqual([refused.refusal.code, refused.refusal.at.field], ['series_invalid', 'achievedOrder']);
  const [unit] = store.writeMany([{ id: `${unitRefusalNamespace('p')}marker`, kind: UNIT_REFUSAL_KIND, expected: 0, value: { gate: 'G1',
    refusals: [{ code: 'q3_probe', goal: 'goal', remedy: 'fix', origin: { name: 'probe', stage: 'stage', subject: 'subject', sources: [{ role: 'r', ref: reference(evidence!) }] } }] } }]);
  const recorded = okq(recordRefusal(store, { project: 'p', source: reference(unit!) }));
  const journal = store.write({ id: recorded.id, kind: recorded.kind, expected: recorded.revision, value: { ...recorded.value, sourceOrder: 'composite-key/v0' } });
  const invalid = readJournalAt(store, 'p', reference(journal));
  if (invalid.ok) assert.fail('An unknown order is no order of this unit');
  assert.deepEqual([invalid.refusal.code, invalid.refusal.at.field], ['journal_invalid', 'sourceOrder']);
});
