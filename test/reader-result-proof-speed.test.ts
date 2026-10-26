import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashJson } from '../src/canonical.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, storeReads, type Revision } from '../src/storage/store.js';
import { pendingOverlay, storeView } from '../src/storage/store-view.js';
import { historicalProof, historicalTrace, withHistoricalReads } from '../src/history/proofs.js';
import { ProductEngine } from '../src/product/engine.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { readBundle, readReaderResultAt, readerResultCurrent, type ReaderResult } from '../src/discovery/reader.js';
import type { ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import type { Question } from '../src/discovery/discovery.js';

/**
 * OMG-READER-RESULT-SPEED. A saved reader result is read again and again — by the next bundle, by the prior index, by the
 * pilot and working context, by synthesis and recovery. On the genuine Store the exact (project, Ref) result is one historical
 * proof: derived once from its producer's exact saved inputs, kept while everything it read is current (the head of its
 * intent included), handed out as a copy of its own. Through any other source (a trace, an overlay, an opaque view), for any
 * other form of the Ref and for a project that cannot key a proof it is derived in place, as it always was.
 * The world is the real one: a fake reader process answers real bundles, and the four producers — paid, combined, reused and
 * outside, with borrowed origins — are the ones the common lifecycle writes.
 */

const PROJECT = 'p';
const PURPOSE = 'Read the original including exceptions';
const history = (store: Store) => store.list().flatMap(row => store.history(row.id));

type Outcome = { proven: unknown } | { code: string; message: string } | { other: string };
const outcome = (read: () => unknown): Outcome => {
  try { return { proven: read() }; }
  catch (error) { return error instanceof EngineError ? { code: error.code, message: error.message } : { other: String(error) }; }
};
const refusalCode = (value: Outcome): string => {
  assert.ok('code' in value, `expected a typed refusal, got ${JSON.stringify(value).slice(0, 240)}`);
  return value.code;
};

function fixture(t: TestContext, maxRequestChars = 30000) {
  const root = mkdtempSync(join(tmpdir(), 'omg-reader-proof-')), path = join(root, 'db.sqlite'), store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: PROJECT, title: 'Reader proof fixture' });
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
const selections=c.sources.map((s,i)=>({sourceIndex:i,firstLine:s.lines[0][0],lastLine:s.lines.at(-1)[0]}));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{selections,unresolved:[]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const env = engine.environments.configure(PROJECT, { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, PROJECT, { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command, maxCalls: 200,
    maxReportedTokens: 100000, maxRequestChars, maxContinuationChars: 30000, maxReadChars: 20000, maxReplyChars: 500, maxExtractedChars: 1200 }, 0);
  const question = () => {
    const draft = engine.discovery.create(PROJECT, 'discovery', 'R0', 'compilation', [{ field: 'result', kind: 'design', prompt: 'Use the exact original',
      risk: 'Missing evidence', schema: { type: 'object' } }]);
    return store.get<Question>(draft.value.questions[0]!)!;
  };
  const read = (q: Revision<Question>, file: string, range?: { start: number; end: number }) =>
    readBundle(store, env.value, pilot, reference(q), PURPOSE, [{ path: file, media: 'text/plain', ...(range ? { range } : {}) }]);
  return { root, path, store, engine, env, pilot, question, read };
}
type Named = 'paid' | 'reused' | 'paid with an origin' | 'partial' | 'combined' | 'outside';

/** Every producer, from the real lifecycle: a paid read, a read of the same bytes by another question (reused), a partial read that a
 * later full read borrows (a paid result with an origin and covered ranges), a split bundle (combined, with combined children),
 * and a read whose window lies outside the source (outside, no payment). */
async function build(t: TestContext) {
  const f = fixture(t);
  writeFileSync(join(f.root, 'a.txt'), 'First line\nException line\n');
  writeFileSync(join(f.root, 'p.txt'), 'if (!allowed) throw Error("denied");\nfunction guarded() { return "value"; }\n');
  writeFileSync(join(f.root, 'big.txt'), '0123456789'.repeat(6000));
  const paid = await f.read(f.question(), 'a.txt');
  const reused = await f.read(f.question(), 'a.txt');
  const partial = await f.read(f.question(), 'p.txt', { start: 0, end: 50 });
  const borrowing = await f.read(f.question(), 'p.txt');
  const combined = await f.read(f.question(), 'big.txt');
  const outside = await f.read(f.question(), 'a.txt', { start: 200, end: 300 });
  assert.deepEqual([paid, reused, partial, borrowing, combined, outside].map(row => row.value.producer), ['paid', 'reused', 'paid', 'paid', 'combined', 'outside']);
  assert.ok(reused.value.reusedFrom?.some(ref => ref.id === paid.id), 'the reused result names its origin');
  assert.ok(borrowing.value.reusedFrom?.some(ref => ref.id === partial.id), 'the later full read borrows the earlier partial one');
  assert.ok(combined.value.parts!.length === 2 && combined.value.parts!.some(ref => f.store.get<ReaderResult>(ref.id, ref.revision)!.value.producer === 'combined'),
    'the split bundle is combined, with a combined child');
  const results: Record<Named, Revision<ReaderResult>> = { paid, reused, 'paid with an origin': borrowing, partial, combined, outside };
  return { ...f, results };
}
type World = Awaited<ReturnType<typeof build>>;

/** One world serves the tests in file order: the first that needs it builds it, inside its own time, and names the time. */
const cleanups: (() => void)[] = [];
after(() => { for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch { /* the file is ending */ } } });
let shared: Promise<World> | undefined;
const sharedWorld = (t: TestContext): Promise<World> => (shared ??= (async () => {
  const started = Date.now();
  const world = await build({ after: (cleanup: () => void) => { cleanups.push(cleanup); } } as unknown as TestContext);
  t.diagnostic(`reader world built in ${Date.now() - started} ms, inside the first test that needed it`);
  return world;
})());

/** A Store over a copy of the world's database: with the proof cache emptied (no kept proof, in memory or saved), or as it is. */
function copyOf(f: { path: string }, t: TestContext, emptied = true): Store {
  const root = mkdtempSync(join(tmpdir(), 'omg-reader-proof-copy-')), path = join(root, 'state.sqlite');
  const source = new DatabaseSync(f.path, { readOnly: true });
  try { source.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`); } finally { source.close(); }
  if (emptied) {
    const db = new DatabaseSync(path);
    try { db.exec('DELETE FROM proof_links; DELETE FROM proof_cache; DELETE FROM proof_nodes'); } finally { db.close(); }
  }
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}
/** How often the records `ids` are read, by get and by history, while the action runs. */
function countReads(ids: ReadonlySet<string>, action: () => unknown): number {
  const { get, history: all } = Store.prototype;
  let reads = 0;
  Store.prototype.get = function (this: Store, id: string, revision?: number) { if (ids.has(id)) reads++; return get.call(this, id, revision); } as typeof Store.prototype.get;
  Store.prototype.history = function (this: Store, id: string) { if (ids.has(id)) reads++; return all.call(this, id); } as typeof Store.prototype.history;
  try { action(); } finally { Store.prototype.get = get; Store.prototype.history = all; }
  return reads;
}
const physical = (action: () => unknown): number => { const before = storeReads(); action(); return storeReads() - before; };

/** The records one result is proved from: itself, its question, pilot and sources, the intent and call of a paid one, and — one
 * level or many — its parts and origins. */
function chain(f: { store: Store }, found: Revision<ReaderResult>): Set<string> {
  const ids = new Set<string>([found.id, found.value.question.id, found.value.pilot.id, ...found.value.sources.map(ref => ref.id)]);
  if (found.value.intent) {
    const intent = f.store.get<ResearchConsumerIntent>(found.value.intent.id)!;
    ids.add(intent.id);
    if (intent.value.call) ids.add(intent.value.call.id);
  }
  for (const ref of [...(found.value.parts ?? []), ...(found.value.reusedFrom ?? [])])
    for (const id of chain(f, f.store.get<ReaderResult>(ref.id, ref.revision)!)) ids.add(id);
  return ids;
}
/** A saved reader-result row that is not any producer's: the value is patched (undefined removes a field), the id follows the value. */
function forge(store: Store, found: Revision<ReaderResult>, patch: Record<string, unknown>): Ref {
  const value: Record<string, unknown> = { ...found.value, ...patch };
  for (const [key, item] of Object.entries(value)) if (item === undefined) delete value[key];
  return reference(store.write<ReaderResult>({ id: `reader-result:v2:${hashJson(value as never)}`, kind: 'reader-result', expected: 0, value: value as unknown as ReaderResult }));
}
const inPlace = (store: Store, project: string, ref: unknown) => outcome(() => readReaderResultAt(historicalTrace(store), project, ref as Ref));
const genuine = (store: Store, project: string, ref: unknown) => outcome(() => readReaderResultAt(store, project, ref as Ref));

test('reader result proof speed: a result of every producer is proved once — the repeat reads none of its records, and it equals the in-place derivation', async t => {
  const f = await sharedWorld(t);
  for (const [label, found] of Object.entries(f.results)) {
    const ref = reference(found), ids = chain(f, found);
    // The in-place derivation (a transparent trace is not the genuine Store) on a Store without any kept proof: every call derives again.
    const cold0 = copyOf(f, t), reference0 = readReaderResultAt(historicalTrace(cold0), PROJECT, ref);
    assert.deepEqual(reference0, found, `${label}: the in-place derivation is the saved result`);
    const perCall = physical(() => readReaderResultAt(historicalTrace(cold0), PROJECT, ref));
    const evidence = countReads(ids, () => readReaderResultAt(historicalTrace(cold0), PROJECT, ref));
    assert.ok(perCall >= 4 && evidence > 0, `${label}: the in-place derivation reads its records on every call (${perCall} reads, ${evidence} records)`);
    // The genuine Store: the first read derives, the repeats read none of those records — in or out of one operation.
    const cold = copyOf(f, t);
    let first!: Revision<ReaderResult>;
    const firstReads = physical(() => { first = readReaderResultAt(cold, PROJECT, ref); });
    assert.deepEqual(first, found, `${label}: equal to the saved result`);
    assert.ok(firstReads >= perCall / 2, `${label}: the first read derives (${firstReads} reads)`);
    const repeats = countReads(ids, () => {
      readReaderResultAt(cold, PROJECT, ref);
      withHistoricalReads(() => { readReaderResultAt(cold, PROJECT, ref); readReaderResultAt(cold, PROJECT, ref); });
    });
    assert.equal(repeats, 0, `${label}: three repeats read no record of the chain`);
    const repeatReads = physical(() => { for (let i = 0; i < 5; i++) assert.deepEqual(readReaderResultAt(cold, PROJECT, ref), found); });
    assert.ok(repeatReads <= Math.max(2, Math.ceil(perCall / 10)), `${label}: five repeats cost ${repeatReads} reads against ${perCall} for each in-place call`);
    // The proof lives in the Store: the world's own Store, which derived it already, repeats it for nothing too.
    readReaderResultAt(f.store, PROJECT, ref);
    assert.equal(countReads(ids, () => readReaderResultAt(f.store, PROJECT, ref)), 0, `${label}: the world's own Store`);
    // Every caller receives a copy of its own, inside one operation as well, and nothing a caller does reaches the kept proof.
    const mine = readReaderResultAt(cold, PROJECT, ref);
    mine.value.unresolved.push('changed by a caller'); mine.value.observations.splice(0); delete (mine.value as { parts?: unknown }).parts; mine.hash = 'x';
    assert.deepEqual(readReaderResultAt(cold, PROJECT, ref), found, `${label}: a caller cannot change what is kept`);
    withHistoricalReads(() => {
      const a = readReaderResultAt(cold, PROJECT, ref), b = readReaderResultAt(cold, PROJECT, ref);
      assert.notEqual(a, b); assert.notEqual(a.value, b.value);
      a.value.unresolved.push('changed inside the operation');
      assert.deepEqual(b, found, `${label}: the second entry of one operation has its own copy`);
    });
    assert.deepEqual(readReaderResultAt(cold, PROJECT, ref), found);
    t.diagnostic(`${label}: in place ${perCall} reads per call, first ${firstReads}, five repeats ${repeatReads}`);
  }
});

test('reader result proof speed: a forged, foreign or incomplete result refuses exactly as the in-place derivation does, and a refusal proves nothing for the next read', async t => {
  const f = await sharedWorld(t);
  const copy = copyOf(f, t), { paid, reused, combined, outside } = f.results, borrowing = f.results['paid with an origin'];
  const parts = combined.value.parts!, other = reference(f.results.partial);
  const cases: [string, Ref][] = [
    ['no contract', forge(copy, paid, { contract: undefined })], ['an unknown contract', forge(copy, paid, { contract: 'reader-result/v1' })],
    ['no producer', forge(copy, paid, { producer: undefined })], ['an unknown producer', forge(copy, paid, { producer: 'oracle' })],
    ['another project', forge(copy, paid, { projectId: 'foreign' })], ['no question', forge(copy, paid, { question: null })],
    ['a question that is no reference', forge(copy, paid, { question: 'not-a-ref' })], ['a pilot in the place of the question', forge(copy, paid, { question: paid.value.pilot })],
    ['no pilot', forge(copy, paid, { pilot: null })], ['no sources', forge(copy, paid, { sources: [] })], ['sources without coverage', forge(copy, paid, { coverage: [] })],
    ['no observations list', forge(copy, paid, { observations: null })], ['an altered observation', forge(copy, paid, { observations: paid.value.observations.map(item => ({ ...item, value: `${item.value}!` })) })],
    ['an altered conclusion', forge(copy, paid, { unresolved: ['forged conclusion'] })],
    ['an altered window', forge(copy, paid, { coverage: paid.value.coverage.map(item => ({ ...item, visibleRange: { ...item.visibleRange, end: item.visibleRange.end - 1 } })) })],
    ['a paid result without its intent', forge(copy, paid, { intent: undefined })], ['a paid result of another intent', forge(copy, paid, { intent: borrowing.value.intent })],
    ['a paid result with parts', forge(copy, paid, { parts: parts })], ['a paid result borrowing a stranger', forge(copy, paid, { reusedFrom: [other] })],
    ['a combined result with one part twice', forge(copy, combined, { parts: [parts[0], parts[0]] })], ['a combined result with one part', forge(copy, combined, { parts: [parts[0]] })],
    ['a combined result with its parts reversed', forge(copy, combined, { parts: [parts[1], parts[0]] })], ['a combined result with an altered conclusion', forge(copy, combined, { unresolved: ['forged'] })],
    ['a combined result that borrows', forge(copy, combined, { reusedFrom: [other] })], ['a combined result with a foreign part', forge(copy, combined, { parts: [parts[0], other] })],
    ['a reused result with a stranger as origin', forge(copy, reused, { reusedFrom: [other] })], ['a reused result with its origin twice', forge(copy, reused, { reusedFrom: [reused.value.reusedFrom![0], reused.value.reusedFrom![0]] })],
    ['a reused result without an origin', forge(copy, reused, { reusedFrom: [] })], ['a reused result with an altered observation', forge(copy, reused, { observations: reused.value.observations.map(item => ({ ...item, value: 'forged' })) })],
    ['an outside result with an intent', forge(copy, outside, { intent: paid.value.intent })], ['an outside result without its request', forge(copy, outside, { request: undefined })],
    ['an outside result with inputs that are no list', forge(copy, outside, { request: { ...outside.value.request, inputs: null } })],
    ['an outside result with another child path', forge(copy, outside, { request: { ...outside.value.request, child: [1] } })],
    ['an outside result with a foreign consumer', forge(copy, outside, { request: { ...outside.value.request, consumer: { run: paid.value.question, turn: paid.value.pilot } } })],
    ['an outside result with an observation', forge(copy, outside, { observations: paid.value.observations })], ['an outside result with a forged notice', forge(copy, outside, { unresolved: ['forged'] })],
    ['a row whose id is not its content address', reference(copy.write<ReaderResult>({ id: 'reader-result:v2:not-its-address', kind: 'reader-result', expected: 0, value: paid.value }))],
  ];
  const before = history(copy);
  for (const [label, ref] of cases) {
    const direct = inPlace(copy, PROJECT, ref), kept = genuine(copy, PROJECT, ref);
    assert.deepEqual(kept, direct, `${label}: the genuine Store refuses as the in-place derivation does`);
    assert.equal(refusalCode(kept), 'reader_result_invalid', label);
    assert.ok('message' in kept && kept.message.includes(`[${ref.id}]`), `${label}: the refusal names the Ref it was asked for`);
    // Hot: a refusal is never kept, and the next read of the same input refuses again, the same way.
    assert.deepEqual(genuine(copy, PROJECT, ref), kept, `${label}: repeated`);
    assert.deepEqual(withHistoricalReads(() => [genuine(copy, PROJECT, ref), genuine(copy, PROJECT, ref)]), [kept, kept], `${label}: repeated inside one operation`);
  }
  assert.deepEqual(history(copy).slice(0, before.length), before, 'reading writes nothing');
  assert.equal(history(copy).length, before.length, 'reading writes nothing');
  // A refusal proves nothing for the results around it: every genuine result is still proved, and equal to what it was.
  for (const [label, found] of Object.entries(f.results)) assert.deepEqual(readReaderResultAt(copy, PROJECT, reference(found)), found, label);
});

test('reader result proof speed: a refusal is a state of the Store, not of the proof — what a second Store adds later is read as it is', async t => {
  const f = await sharedWorld(t);
  // An outside result names its question: until a Store holds exactly that question the result refuses, afterwards it is proved.
  const copy = copyOf(f, t, false), second = new Store(copy.path), { outside } = f.results;
  t.after(() => second.close());
  const question = f.store.get<Question>(outside.value.question.id, outside.value.question.revision)!;
  const future: Ref = { id: 'question:p:arrives-later', revision: 1, hash: question.hash };
  const ref = forge(copy, outside, { question: future });
  const refused = genuine(copy, PROJECT, ref);
  assert.equal(refusalCode(refused), 'reader_result_invalid');
  assert.deepEqual(genuine(copy, PROJECT, ref), refused, 'refused again, hot');
  assert.deepEqual(inPlace(copy, PROJECT, ref), refused);
  second.write<Question>({ id: future.id, kind: 'question', expected: 0, value: question.value });
  assert.equal(second.get(future.id, 1)!.hash, future.hash, 'the second Store holds exactly the question the result names');
  const now = inPlace(copy, PROJECT, ref);
  assert.ok('proven' in now, 'in place, the result is proved now');
  assert.deepEqual(genuine(copy, PROJECT, ref), now, 'the genuine Store follows: the refusal was not kept');
  assert.deepEqual(genuine(copy, PROJECT, ref), now, 'and proves it once more, hot');
});

test('reader result proof speed: a result that asks for itself while it is being proved is the typed refusal of a cyclic origin — and nothing is kept of the cycle', async t => {
  const f = await sharedWorld(t);
  const store = copyOf(f, t), { paid } = f.results, ref = reference(paid);
  // The proof of this very (project, Ref) is open: the request inside it meets itself, which no lawful derivation does.
  const key = { reader: 'reader.result-read/v1', project: PROJECT, ref };
  const cycle = outcome(() => historicalProof(store, key, () => readReaderResultAt(store, PROJECT, ref),
    () => { throw new Error('the outer proof is not the one that answered'); }));
  assert.equal(refusalCode(cycle), 'reader_result_invalid');
  assert.ok('message' in cycle && cycle.message.includes(`[${ref.id}]`) && cycle.message.includes('cyclic'), JSON.stringify(cycle));
  assert.deepEqual(genuine(store, PROJECT, ref), { proven: paid }, 'the result is proved afterwards, as if nothing had happened');
  assert.equal(countReads(chain(f, paid), () => genuine(store, PROJECT, ref)), 0, 'and kept');
});

test('reader result proof speed: only the plain closed Ref keys a kept proof — every other form derives in place and meets the old answer, cold and warm', async t => {
  const f = await sharedWorld(t);
  const { paid } = f.results, ref = reference(paid);
  const forms = (value: Ref): [string, unknown][] => [
    ['an array carrying the three fields', Object.assign([], value)], ['an inheritor with three foreign own keys', Object.assign(Object.create(value), { a: 1, b: 2, c: 3 })],
    ['a field that is not enumerable', Object.defineProperty({ id: value.id, revision: value.revision }, 'hash', { value: value.hash })],
    ['enumerable accessors', Object.defineProperties({}, { id: { get: () => value.id, enumerable: true }, revision: { get: () => value.revision, enumerable: true }, hash: { get: () => value.hash, enumerable: true } })],
    ['a Proxy over the Ref', new Proxy({ ...value }, {})], ['a Proxy whose get and descriptors differ', new Proxy({ ...value }, { get: (target, key) => (key === 'id' ? 'reader-result:v2:unknown' : Reflect.get(target, key)) })], ['a symbol beside the fields', Object.assign({ ...value }, { [Symbol('beside')]: 1 })],
    ['no prototype', Object.assign(Object.create(null), value)], ['a class instance', Object.assign(new (class Pointer {})(), value)],
    ['a padded Ref', { ...value, extra: 1 }], ['a Ref without hash', { id: value.id, revision: value.revision }], ['another hash', { ...value, hash: '0'.repeat(64) }],
    ['another revision', { ...value, revision: value.revision + 1 }], ['a revision of zero', { ...value, revision: 0 }], ['a fractional revision', { ...value, revision: 1.5 }],
    ['a hash that is no hash', { ...value, hash: 'not-a-hash' }], ['an empty id', { ...value, id: '' }], ['an unknown id', { ...value, id: 'reader-result:v2:unknown' }],
    ['the question, not a result', paid.value.question], ['nothing', null],
  ];
  const copy = copyOf(f, t);
  const projects: [string, unknown][] = [['another project', 'q'], ['an empty project', ''], ['a blank project', '   '], ['a project that is no string', 7], ['no project', undefined]];
  for (const warm of [false, true]) {
    if (warm) readReaderResultAt(copy, PROJECT, ref);
    for (const [label, form] of forms(ref)) {
      const direct = inPlace(copy, PROJECT, form), kept = genuine(copy, PROJECT, form);
      assert.deepEqual(kept, direct, `${label} (${warm ? 'warm' : 'cold'}): the genuine Store answers as the in-place derivation does`);
      assert.deepEqual(genuine(copy, PROJECT, form), kept, `${label} (${warm ? 'warm' : 'cold'}): repeated`);
    }
    for (const [label, project] of projects) {
      const direct = inPlace(copy, project as string, ref), kept = genuine(copy, project as string, ref);
      assert.deepEqual(kept, direct, `${label} (${warm ? 'warm' : 'cold'}): as the in-place derivation does`);
      assert.ok('code' in kept || 'other' in kept, `${label}: a result is never proved for a project it does not belong to`);
      assert.deepEqual(genuine(copy, project as string, ref), kept, `${label} (${warm ? 'warm' : 'cold'}): repeated`);
    }
  }
  // An accessor Ref is no key: the genuine Store derives from the input exactly as the in-place derivation does, getter call for getter call.
  const counted = () => {
    let reads = 0;
    const value = Object.defineProperties({}, { id: { get: () => (reads++, ref.id), enumerable: true }, revision: { get: () => (reads++, ref.revision), enumerable: true },
      hash: { get: () => (reads++, ref.hash), enumerable: true } });
    return { reads: () => reads, value };
  };
  for (const warm of [false, true]) {
    const store = copyOf(f, t);
    if (warm) readReaderResultAt(store, PROJECT, ref);
    const mine = counted(), theirs = counted();
    assert.deepEqual(genuine(store, PROJECT, mine.value), inPlace(store, PROJECT, theirs.value), `${warm ? 'warm' : 'cold'}: the same answer`);
    assert.ok(theirs.reads() > 3 && mine.reads() === theirs.reads(), `${warm ? 'warm' : 'cold'}: the getters are read ${mine.reads()} times, as often as in place (${theirs.reads()})`);
  }
  // An input that answers differently from one read to the next keys nothing: whatever it is answered, a literal A of an unknown id still
  // refuses afterwards and the real Ref B is read correctly, cold and warm, and neither is ever answered from what the unstable one left.
  for (const threshold of [0, 1, 2, 3, 4, 5, 6, 8, 12, 20]) for (const warm of [false, true]) {
    const store = copyOf(f, t), label = `${warm ? 'warm' : 'cold'}, unstable after ${threshold} reads`;
    if (warm) readReaderResultAt(store, PROJECT, ref);
    let reads = 0;
    const unstable = { get id() { return reads++ < threshold ? 'reader-result:v2:unknown' : ref.id; }, revision: ref.revision, hash: ref.hash };
    genuine(store, PROJECT, unstable);
    const literal = { ...ref, id: 'reader-result:v2:unknown' };
    assert.equal(refusalCode(genuine(store, PROJECT, literal)), 'reader_result_invalid', `${label}: the literal A still refuses`);
    assert.deepEqual(genuine(store, PROJECT, ref), { proven: paid }, `${label}: the real Ref is read correctly`);
    assert.equal(refusalCode(genuine(store, PROJECT, literal)), 'reader_result_invalid', `${label}: the literal A refuses hot`);
  }
});

/** The records without which a result cannot be proved: its own, its question, pilot and source, the intent and paid call, its parts, its origins. */
function needed(f: { store: Store }, found: Revision<ReaderResult>): [string, string][] {
  const list: [string, string][] = [['the result', found.id], ['its question', found.value.question.id], ['its pilot', found.value.pilot.id], ['its source', found.value.sources[0]!.id]];
  if (found.value.intent) {
    const intent = f.store.get<ResearchConsumerIntent>(found.value.intent.id)!;
    list.push(['its intent', intent.id], ['its paid call', intent.value.call!.id]);
  }
  (found.value.parts ?? []).forEach((ref, index) => list.push([`its part ${index + 1}`, ref.id]));
  (found.value.reusedFrom ?? []).forEach((ref, index) => list.push([`its origin ${index + 1}`, ref.id]));
  return list;
}
const readOnly = () => { throw new Error('a read-only view'); };

test('reader result proof speed: a view that hides or changes a record, an overlay and a trace derive in place — a kept proof is never handed to them', async t => {
  const f = await sharedWorld(t);
  const store = copyOf(f, t);
  for (const found of Object.values(f.results)) assert.deepEqual(readReaderResultAt(store, PROJECT, reference(found)), found);
  for (const [label, found] of Object.entries(f.results)) {
    const ref = reference(found);
    for (const [what, id] of needed(f, found)) {
      // The Store that proved the result is warm; the view hides one record of its chain and must not be answered from that proof.
      const view = storeView(store, { write: readOnly, get: identifier => (identifier === id ? null : undefined) });
      const refused = outcome(() => readReaderResultAt(view, PROJECT, ref));
      assert.equal(refusalCode(refused), 'reader_result_invalid', `${label}: without ${what}`);
      assert.deepEqual(outcome(() => readReaderResultAt(view, PROJECT, ref)), refused, `${label}: without ${what}, repeated`);
      assert.deepEqual(readReaderResultAt(store, PROJECT, ref), found, `${label}: the Store that sees ${what} still proves the result`);
    }
    // A view that hides nothing is still no genuine Store: it derives on every call, whatever the Store beneath has kept.
    const transparent = storeView(store, { write: readOnly, get: () => undefined });
    const direct = physical(() => assert.deepEqual(readReaderResultAt(transparent, PROJECT, ref), found));
    const kept = physical(() => assert.deepEqual(readReaderResultAt(store, PROJECT, ref), found));
    assert.ok(direct >= 4 && direct > kept * 4, `${label}: a view reads ${direct} records, the Store that kept the proof ${kept}`);
    const again = physical(() => readReaderResultAt(transparent, PROJECT, ref));
    assert.equal(again, direct, `${label}: and derives again on the next call`);
    // A trace is transparent, not genuine: the same in-place derivation.
    assert.equal(physical(() => readReaderResultAt(historicalTrace(store), PROJECT, ref)), direct, `${label}: a trace derives in place`);
  }
  // An overlay that changes a record of the chain (here the pilot, with a hash that is not the one the result names) is no proof of anything.
  const { paid } = f.results, pilot = store.get(paid.value.pilot.id, paid.value.pilot.revision)!;
  const overlay = pendingOverlay(store, [{ ...pilot, hash: 'f'.repeat(64) }]);
  const refused = outcome(() => readReaderResultAt(overlay, PROJECT, reference(paid)));
  assert.equal(refusalCode(refused), 'reader_result_invalid');
  assert.deepEqual(readReaderResultAt(store, PROJECT, reference(paid)), paid);
});

test('reader result proof speed: after a second Store moves what a result was proved from, the genuine Store follows it — no stale success, no refusal kept', async t => {
  const f = await sharedWorld(t);
  const intentOf = (store: Store, found: Revision<ReaderResult>) => store.get<ResearchConsumerIntent>(found.value.intent!.id)!;
  type Move = (second: Store, found: Revision<ReaderResult>) => void;
  const rewrite = (second: Store, found: Revision<ReaderResult>, change: (value: ResearchConsumerIntent) => ResearchConsumerIntent) => {
    const head = intentOf(second, found);
    second.write<ResearchConsumerIntent>({ id: head.id, kind: head.kind, expected: head.revision, value: change(head.value) });
  };
  /** The shapes a head of the intent can be moved to by anyone who can write: all of them lawful for the record, none of them what the producer wrote. */
  const prepared = (value: ResearchConsumerIntent): ResearchConsumerIntent => ({ ...value, state: 'prepared', call: null, request: null, archive: null, outputs: null, refusal: null });
  const refused = (value: ResearchConsumerIntent): ResearchConsumerIntent => ({ ...value, state: 'refused', outputs: null,
    refusal: { kind: 'reader-invalid', code: 'reader_response_invalid', call: value.call!, request: value.request!, response: null, archive: value.archive! } });
  const origin = (second: Store, found: Revision<ReaderResult>) => second.get<ReaderResult>(found.value.reusedFrom![0]!.id, found.value.reusedFrom![0]!.revision)!;
  const leaf = (second: Store, found: Revision<ReaderResult>): Revision<ReaderResult> =>
    found.value.producer === 'combined' ? leaf(second, second.get<ReaderResult>(found.value.parts![0]!.id, found.value.parts![0]!.revision)!) : found;
  // [what the second Store does, the result it is done for, the move, the answer in place afterwards: a refusal, an answer, or whichever the record decides]
  const moves: [string, Named, Move, 'refusal' | 'answer' | 'either'][] = [
    ['it makes the head of the intent of a paid result a prepared one again', 'paid', (second, found) => rewrite(second, found, prepared), 'refusal'],
    ['it gives the head of that intent another project', 'paid', (second, found) => rewrite(second, found, value => ({ ...value, projectId: 'foreign' })), 'refusal'],
    ['it refuses the head of that intent, after its response was consumed', 'paid', (second, found) => rewrite(second, found, refused), 'either'],
    ['it makes the head of the intent of the origin a reused result borrows from a prepared one', 'reused', (second, found) => rewrite(second, origin(second, found), prepared), 'refusal'],
    ['it makes the head of the intent of a leaf of a split bundle a prepared one', 'combined', (second, found) => rewrite(second, leaf(second, found), prepared), 'refusal'],
    ['it makes the head of the intent of the earlier result a paid one borrows from a prepared one', 'paid with an origin', (second, found) => rewrite(second, origin(second, found), prepared), 'refusal'],
    // What the derivation reads at an exact revision never changes: a newer revision of it moves no answer.
    ['it writes a newer revision of the question', 'paid', (second, found) => {
      const head = second.get<Question>(found.value.question.id)!;
      second.write<Question>({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
    }, 'answer'],
  ];
  for (const [what, label, move, expected] of moves) {
    const found = f.results[label], ref = reference(found), ids = chain(f, found);
    const first = copyOf(f, t), second = new Store(first.path);
    t.after(() => second.close());
    // The Store has proved the result; it is warm.
    assert.deepEqual(readReaderResultAt(first, PROJECT, ref), found);
    assert.equal(countReads(ids, () => readReaderResultAt(first, PROJECT, ref)), 0, `${what}: the proof is kept`);
    move(second, found);
    const direct = inPlace(first, PROJECT, ref), kept = genuine(first, PROJECT, ref);
    assert.deepEqual(kept, direct, `${what}: the warm genuine Store answers as a derivation in place does`);
    if (expected === 'refusal') assert.equal(refusalCode(direct), 'reader_result_invalid', `${what}: the move must change the answer for the test to prove anything`);
    if (expected === 'answer') assert.deepEqual(direct, { proven: found }, `${what}: the answer stays`);
    // Hot, and once more inside one operation: a refusal is not kept, an answer is the same.
    assert.deepEqual(genuine(first, PROJECT, ref), kept, `${what}: repeated`);
    assert.deepEqual(withHistoricalReads(() => [genuine(first, PROJECT, ref), genuine(first, PROJECT, ref)]), [kept, kept], `${what}: repeated inside one operation`);
  }
  // A head the proof depends on that moved is read again once: the answer is derived anew, then kept anew.
  const found = f.results.paid, ref = reference(found), ids = chain(f, found);
  const first = copyOf(f, t), second = new Store(first.path);
  t.after(() => second.close());
  readReaderResultAt(first, PROJECT, ref);
  rewrite(second, found, value => ({ ...value, guards: uniqueTransactionGuards([...value.guards, { id: 'fixture:one-more-guard', absent: true }]) }));
  assert.equal(intentOf(second, found).revision, intentOf(f.store, found).revision + 1, 'the head of the intent moved');
  const derived = countReads(ids, () => { assert.deepEqual(genuine(first, PROJECT, ref), { proven: found }); });
  assert.ok(derived > 0, 'the head of the intent moved: the proof is derived again, not served');
  assert.equal(countReads(ids, () => { genuine(first, PROJECT, ref); genuine(first, PROJECT, ref); }), 0, 'and kept again');
});

test('reader result proof speed: the bytes on disk change, the exact historical result stays — current admission is still the callers', async t => {
  const f = fixture(t);
  const file = join(f.root, 'a.txt');
  writeFileSync(file, 'First line\nException line\n');
  const paid = await f.read(f.question(), 'a.txt'), ref = reference(paid);
  assert.deepEqual(readReaderResultAt(f.store, PROJECT, ref), paid);
  assert.equal(readerResultCurrent(f.store, PROJECT, paid.value), true, 'the file is as it was read');
  const calls = f.store.list('model-call').length;
  writeFileSync(file, 'Changed on disk\n');
  // The kept proof is of the exact saved result and its exact saved Source revision: the file does not change it ...
  assert.deepEqual(readReaderResultAt(f.store, PROJECT, ref), paid);
  assert.deepEqual(readReaderResultAt(copyOf(f, t), PROJECT, ref), paid);
  // ... and it does not make the old bytes current: admission asks the file itself, and a new reading pays again.
  assert.equal(readerResultCurrent(f.store, PROJECT, paid.value), false, 'the result is no longer current');
  const next = await f.read(f.question(), 'a.txt');
  assert.equal(next.value.producer, 'paid', 'a changed file is read again, not served from a kept proof');
  assert.equal(f.store.list('model-call').length, calls + 1, 'and paid for');
  assert.notDeepEqual(next.value.sources, paid.value.sources);
  assert.equal(next.value.observations.map(item => item.value).join(''), 'Changed on disk\n');
  assert.equal(readerResultCurrent(f.store, PROJECT, next.value), true);
  assert.deepEqual(readReaderResultAt(f.store, PROJECT, ref), paid, 'the earlier result is still the exact one it was');
});
