import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, canonicalSorted, compositeKey, digest, hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';

/**
 * OMG-V7-CANON-SPEED. canonical() is the text of every address and hash in the system and, in the heavy v7 tests, almost half
 * of all processor time. It was rewritten for speed and must stay byte-for-byte the function it was: the same text for every
 * value it accepts, the same refusal — class, code and message — for every value it refuses. The reference below is the
 * former implementation, verbatim; the tests compare the two on hand-built values, on the shapes the stores really hold, and
 * on a seeded flood of random values, valid and not.
 */
function reference(value: unknown): string {
  const seen = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || seen.has(item)) {
      throw new EngineError('invalid_json', 'Only finite, acyclic JSON values can be stored');
    }
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new EngineError('invalid_json', 'Sparse arrays are forbidden');
      result = `[${item.map(encode).join(',')}]`;
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
        throw new EngineError('invalid_json', 'Only plain objects can be stored');
      }
      result = `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    seen.delete(item);
    return result;
  }
  return encode(value);
}

type Outcome = { text: string } | { error: string; name: string; code: unknown; message: string };
function outcome(read: (value: unknown) => string, value: unknown): Outcome {
  try { return { text: read(value) }; }
  catch (error) {
    const e = error as { name?: string; code?: unknown; message?: string };
    return { error: error instanceof EngineError ? 'EngineError' : String(error instanceof Error ? error.constructor.name : typeof error), name: String(e.name),
      code: e.code ?? null, message: String(e.message) };
  }
}
/** The new and the former implementation answer alike: the same text, or the same refusal. */
function alike(value: unknown, note: string): Outcome {
  const expected = outcome(reference, value), actual = outcome(canonical, value);
  assert.deepEqual(actual, expected, note);
  return actual;
}

const sparse = (): unknown[] => { const array = new Array<number>(3); array[0] = 1; array[2] = 3; return array; };
const withExtra = (): unknown[] => Object.assign([1, 2], { extra: true });
/** A hole and an extra property balance the count the former check made: it passed and wrote the hole as nothing. */
const balancedHole = (): unknown[] => { const items: unknown[] = [undefined, 827]; delete items[0]; return Object.assign(items, { extra: 1 }); };
const cycle = (): Record<string, unknown> => { const a: Record<string, unknown> = { name: 'a' }; a['self'] = a; return a; };
const indirect = (): unknown[] => { const list: unknown[] = []; const holder = { list }; list.push(holder); return list; };
class Pointer { id = 'x'; }
const nullPrototype = (): Record<string, unknown> => Object.assign(Object.create(null) as Record<string, unknown>, { b: 1, a: [null] });
const accessor = (): Record<string, unknown> => Object.defineProperty({ a: 1 }, 'b', { enumerable: true, get: () => 'computed' });
const throwing = (): Record<string, unknown> => Object.defineProperty({ a: 1 }, 'b', { enumerable: true, get: () => { throw new RangeError('getter'); } });
const symbolKeyed = (): Record<string | symbol, unknown> => ({ a: 1, [Symbol('ignored')]: 2 });
const hidden = (): Record<string, unknown> => Object.defineProperty({ a: 1 }, 'h', { value: 2, enumerable: false });
const deep = (depth: number, wrap: (inner: unknown) => unknown): unknown => { let value: unknown = 'leaf'; for (let i = 0; i < depth; i++) value = wrap(value); return value; };
const shared = (): unknown => { const part = { id: 'p', n: [1, 2] }; return { first: part, second: [part, part], third: { part } }; };

const valid: [string, unknown][] = [
  ['null', null], ['true', true], ['false', false], ['empty string', ''], ['zero', 0], ['negative zero', -0], ['one', 1], ['float', 0.1 + 0.2],
  ['huge', 1e21], ['tiny', 5e-324], ['negative exponent', -1.5e-7], ['max safe', Number.MAX_SAFE_INTEGER], ['max value', Number.MAX_VALUE],
  ['quote and backslash', 'a"b\\c'], ['control characters', 'a\u0001\u001f\n\t\r\b\f'], ['line separators', 'x y z'],
  ['lone high surrogate', 'a\ud800b'], ['lone low surrogate', 'a\udc00b'], ['surrogate pair', 'a😀b'], ['accents', 'éÉ'],
  ['empty array', []], ['empty object', {}], ['nested empties', [[], {}, [[]], [{}], { a: {} }]],
  ['mixed', { b: 1, a: [1, 2, { z: null, y: 'x' }], c: 'é "\\' }],
  ['numeric-like keys', { 10: 1, 9: 2, 2: 3, a: 4, '': 5, '01': 6 }], ['code unit order', { a: 1, B: 2, Z: 3, é: 4, 'a b': 5, aa: 6, 'a\u0000': 7, '😀': 8, '￿': 9 }],
  ['keys that need escaping', { 'a"b': 1, 'c\\d': 2, 'e\nf': 3, '\u0001': 4 }], ['reserved names', { __proto__: null, constructor: 1, toString: 2, hasOwnProperty: 3 }],
  ['null prototype', nullPrototype()], ['shared children (a DAG, not a cycle)', shared()], ['array of the same object', (() => { const o = { k: 1 }; return [o, o, o]; })()],
  ['symbol key is ignored', symbolKeyed()], ['hidden property is ignored', hidden()], ['accessor is read', accessor()], ['a hole balanced by an extra property', balancedHole()],
  ['wide: 13 keys', Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${(i * 7) % 13}`, i]))],
  ['wide: 40 keys', Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${(i * 17) % 40}`, i]))],
  ['wide: 12 keys', Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${11 - i}`, i]))],
  ['array of 500', Array.from({ length: 500 }, (_, i) => ({ i, s: `s${i}` }))],
  ['depth 300 arrays', deep(300, inner => [inner])], ['depth 300 objects', deep(300, inner => ({ inner }))],
  ['a record as the stores hold it', { id: 'research-consumer-intent:v1:ab', kind: 'research-consumer-intent', revision: 3,
    hash: 'f'.repeat(64), value: { guards: [{ id: 'x', revision: 1, hash: '0'.repeat(64) }], cursor: { turn: 2, context: { history: [], readings: [] } } } }],
];
const invalid: [string, unknown][] = [
  ['undefined', undefined], ['function', () => 1], ['symbol', Symbol('s')], ['bigint', 1n], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity],
  ['undefined member', { a: undefined }], ['undefined element', [1, undefined, 3]], ['function member', { f() { return 1; } }],
  ['NaN inside', { a: [1, { b: NaN }] }], ['sparse array', sparse()], ['array with an extra property', withExtra()], ['nested sparse array', { a: [sparse()] }],
  ['Date', new Date(0)], ['Map', new Map()], ['Set', new Set()], ['RegExp', /x/], ['class instance', new Pointer()], ['boxed string', new String('x')],
  ['boxed number', new Number(1)], ['error object', new Error('x')], ['typed array', new Uint8Array(2)], ['plain object with a Date inside', { when: new Date(0) }],
  ['self cycle', cycle()], ['indirect cycle', indirect()], ['array inside a cycle', (() => { const a: unknown[] = []; a.push([a]); return a; })()],
  ['getter that throws', throwing()], ['Object.assign([], ref) shape', Object.assign([], { id: 'a', revision: 1, hash: 'b' })],
  ['inheritor', Object.assign(Object.create({ id: 'a' }) as object, { z: 1 })],
];

test('canonical speed: every value the former implementation accepted gets the very same text', () => {
  for (const [note, value] of valid) {
    const result = alike(value, note);
    assert.ok('text' in result, `${note} is a value`);
  }
  assert.equal(canonical(-0), '0');
  assert.equal(canonical(symbolKeyed()), '{"a":1}');
  assert.equal(canonical(hidden()), '{"a":1}');
  assert.equal(canonical(accessor()), '{"a":1,"b":"computed"}');
});

test('canonical speed: every value the former implementation refused is refused alike — class, code and message', () => {
  for (const [note, value] of invalid) {
    const result = alike(value, note);
    assert.ok('error' in result, `${note} is refused`);
  }
  const refusals = invalid.map(([, value]) => outcome(canonical, value)).filter(result => 'error' in result);
  assert.ok(refusals.some(result => 'code' in result && result.code === 'invalid_json'), 'the refusals carry invalid_json');
  assert.ok(refusals.some(result => 'message' in result && result.message === 'Sparse arrays are forbidden'));
  assert.ok(refusals.some(result => 'message' in result && result.message === 'Only plain objects can be stored'));
  assert.ok(refusals.some(result => 'message' in result && result.message === 'Only finite, acyclic JSON values can be stored'));
  assert.ok(refusals.some(result => 'error' in result && result.error !== 'EngineError'), 'a throwing getter keeps its own error');
});

type Read = (value: unknown) => string;
interface Fixture { value: unknown; log: string[] }
/** A value that changes while it is read cannot be given to both implementations: each gets a fixture of its own, made fresh, and the
 * order of everything it observed — getters, traps, nested reads — is compared along with the answer. */
function sameObservation(note: string, make: (read: Read) => Fixture): void {
  const run = (read: Read) => { const fixture = make(read); return { answer: outcome(read, fixture.value), log: fixture.log }; };
  const expected = run(reference), actual = run(canonical);
  assert.deepEqual(actual.answer, expected.answer, `${note}: the answer`);
  assert.deepEqual(actual.log, expected.log, `${note}: what was observed, in order`);
  assert.ok(expected.log.length > 0, `${note}: the fixture observed something`);
}
const spied = (log: string[], target: object, name: string, enumerable: boolean, get: () => unknown): void => {
  Object.defineProperty(target, name, { enumerable, configurable: true, get() { log.push(`get ${name}`); return get(); } });
};
/** A Proxy that logs every trap the reader uses. */
function logged<T extends object>(target: T, log: string[], extra: ProxyHandler<T> = {}): T {
  return new Proxy(target, {
    getPrototypeOf(t) { log.push('getPrototypeOf'); return Reflect.getPrototypeOf(t); },
    ownKeys(t) { log.push('ownKeys'); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, key) { log.push(`getOwnPropertyDescriptor ${String(key)}`); return Reflect.getOwnPropertyDescriptor(t, key); },
    get(t, key, receiver) { log.push(`get ${String(key)}`); return Reflect.get(t, key, receiver); },
    has(t, key) { log.push(`has ${String(key)}`); return Reflect.has(t, key); },
    ...extra,
  });
}
const observations: [string, (read: Read) => Fixture][] = [
  ['getters are read in key order, after the keys are sorted', () => {
    const log: string[] = [], object = {};
    for (const key of ['m', 'b', 'z', 'a', '10', '9']) spied(log, object, key, true, () => key);
    return { value: object, log };
  }],
  ['a getter changes the field that is read next', () => {
    const log: string[] = [], object: Record<string, unknown> = { b: 'before' };
    spied(log, object, 'a', true, () => { object['b'] = 'after'; return 1; });
    return { value: object, log };
  }],
  ['the whole subtree of a field is read before the next field is taken', () => {
    const log: string[] = [], child = {}, root: Record<string, unknown> = {};
    spied(log, child, 'inner', true, () => 'nested');
    spied(log, root, 'a', true, () => child);
    spied(log, root, 'b', true, () => 'next');
    return { value: root, log };
  }],
  ['a getter deep inside a field changes the next field of an ancestor', () => {
    const log: string[] = [], root: Record<string, unknown> = { b: 'before' }, child = {};
    spied(log, child, 'inner', true, () => { root['b'] = 'after'; return 1; });
    spied(log, root, 'a', true, () => child);
    return { value: root, log };
  }],
  ['a getter removes a listed field', () => {
    const log: string[] = [], object: Record<string, unknown> = { b: 'listed', c: 3 };
    spied(log, object, 'a', true, () => { delete object['b']; return 1; });
    return { value: object, log };
  }],
  ['a getter adds a field after the keys were taken', () => {
    const log: string[] = [], object: Record<string, unknown> = {};
    spied(log, object, 'a', true, () => { object['late'] = 'never read'; return 1; });
    return { value: object, log };
  }],
  ['a reentrant getter reads another value with the same function', read => {
    const log: string[] = [], object: Record<string, unknown> = { z: 1 };
    spied(log, object, 'a', true, () => { const inner = read({ y: [1, 2], x: { w: null } }); log.push(`inner ${inner}`); return inner.length; });
    return { value: object, log };
  }],
  ['a reentrant getter fails inside the nested read', read => {
    const log: string[] = [], object: Record<string, unknown> = {};
    spied(log, object, 'a', true, () => { try { read([undefined]); } catch (error) { log.push(`inner ${(error as Error).message}`); } return 'after'; });
    return { value: object, log };
  }],
  ['a getter that is not enumerable is never read', () => {
    const log: string[] = [], object: Record<string, unknown> = { a: 1 };
    spied(log, object, 'hidden', false, () => 'never');
    spied(log, object, 'shown', true, () => 'seen');
    return { value: object, log };
  }],
  ['a Proxy over a plain object', () => { const log: string[] = []; return { value: logged({ b: 1, a: [2, { c: null }] }, log), log }; }],
  ['a Proxy over an array', () => { const log: string[] = []; return { value: logged([1, 'two', [3]], log), log }; }],
  ['a Proxy over an object with a symbol key', () => { const log: string[] = []; return { value: logged({ a: 1, [Symbol('s')]: 2 }, log), log }; }],
  ['a Proxy whose prototype trap lies', () => { const log: string[] = []; return { value: logged({ a: 1 }, log, { getPrototypeOf() { log.push('getPrototypeOf (lies)'); return Array.prototype; } }), log }; }],
  ['a Proxy that refuses a trap', () => {
    const log: string[] = [];
    return { value: logged({ a: 1, b: 2 }, log, { get(t, key) { log.push(`get ${String(key)}`); if (key === 'b') throw new RangeError('refused'); return Reflect.get(t, key); } }), log };
  }],
  ['an array whose first element removes the second', () => {
    const log: string[] = [], array: unknown[] = [0, 'second', 'third'];
    Object.defineProperty(array, 0, { enumerable: true, configurable: true, get() { log.push('get 0'); delete array[1]; return 1; } });
    return { value: array, log };
  }],
  ['an array with a hole balanced by an extra property', () => {
    const log: string[] = [], array: unknown[] = [undefined, 827];
    delete array[0];
    spied(log, array, 'extra', true, () => 1);
    return { value: array, log: [...log, 'built'] };
  }],
  ['an array with its own map', () => {
    const log: string[] = [], array: unknown[] = [1, 2, 3];
    Object.defineProperty(array, 'map', { enumerable: false, configurable: true, value(this: unknown[], callback: (item: unknown) => string) { log.push('own map'); return Array.prototype.map.call(this, callback); } });
    return { value: array, log };
  }],
  ['an array whose map answers something else', () => {
    const log: string[] = [], array: unknown[] = [1, 2, 3];
    Object.defineProperty(array, 'map', { enumerable: false, configurable: true, value() { log.push('own map'); return ['fixed', 'text']; } });
    return { value: array, log };
  }],
  ['an array subclass that has its own map', () => {
    const log: string[] = [];
    class Counting extends Array<unknown> { override map<U>(callback: (value: unknown, index: number, array: unknown[]) => U): U[] { log.push('subclass map'); return super.map(callback); } }
    return { value: Counting.from([1, [2], { three: 3 }]), log };
  }],
  ['the same object met twice, and as an ancestor', () => {
    const log: string[] = [], shared = {}, holder: Record<string, unknown> = { first: shared, second: [shared, shared] };
    spied(log, shared, 'id', true, () => 'shared');
    return { value: holder, log };
  }],
  ['a cycle closed by a getter', () => {
    const log: string[] = [], object: Record<string, unknown> = { z: 1 };
    spied(log, object, 'a', true, () => object);
    return { value: object, log };
  }],
];

test('canonical speed: a value that changes while it is read is met in the very same order — getters, traps, nested reads, arrays with their own map', () => {
  for (const [note, make] of observations) sameObservation(note, make);
});

/** A small seeded generator (mulberry32): the same flood on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ALPHABET = ['a', 'b', 'ab', 'B', 'é', '10', '9', '', ' ', '"', '\\', '\n', ' ', '😀', 'key', 'id', 'revision', 'hash', 'z', 'Z', '0', '01'];
function make(rand: () => number, depth: number, hostile: boolean): unknown {
  const pick = rand();
  if (depth <= 0 || pick < 0.3) {
    const leaf = rand();
    if (leaf < 0.3) return ALPHABET[Math.floor(rand() * ALPHABET.length)]! + (rand() < 0.5 ? '' : String(Math.floor(rand() * 1000)));
    if (leaf < 0.55) return Math.floor(rand() * 2000) - 1000;
    if (leaf < 0.7) return (rand() - 0.5) * 10 ** Math.floor(rand() * 40 - 20);
    if (leaf < 0.8) return rand() < 0.5;
    if (leaf < 0.9) return null;
    if (hostile) return [undefined, NaN, Infinity, () => 1, Symbol('x'), 1n, new Date(0)][Math.floor(rand() * 7)];
    return 'plain';
  }
  if (pick < 0.55) {
    const items = Array.from({ length: Math.floor(rand() * 5) }, () => make(rand, depth - 1, hostile));
    if (hostile && rand() < 0.1 && items.length > 1) delete items[0];
    if (hostile && rand() < 0.05) Object.assign(items, { extra: 1 });
    return items;
  }
  const object: Record<string, unknown> = {};
  const count = Math.floor(rand() * (rand() < 0.1 ? 20 : 7));
  for (let i = 0; i < count; i++) object[ALPHABET[Math.floor(rand() * ALPHABET.length)]! + (rand() < 0.5 ? '' : String(Math.floor(rand() * 30)))] = make(rand, depth - 1, hostile);
  if (hostile && rand() < 0.03) object['self'] = object;
  if (hostile && rand() < 0.03) return Object.assign(new Pointer(), object);
  return object;
}

test('canonical speed: a seeded flood of random values, valid and hostile, is answered alike', () => {
  const rand = random(20261026);
  let accepted = 0, refused = 0;
  for (let i = 0; i < 4000; i++) {
    const value = make(rand, 5, false);
    assert.ok('text' in alike(value, `valid #${i}`));
    accepted++;
  }
  for (let i = 0; i < 4000; i++) {
    const value = make(rand, 5, true);
    if ('text' in alike(value, `hostile #${i}`)) accepted++; else refused++;
  }
  assert.ok(accepted > 4000 && refused > 200, `the flood holds both kinds (${accepted} accepted, ${refused} refused)`);
});

test('canonical speed: texts and hashes are pinned — nothing that was ever stored changes its address', () => {
  assert.equal(canonical([-0, 1e21, 0.1 + 0.2, 123456789012345680000, 5e-324, -1.5e-7, true, false, null]),
    '[0,1e+21,0.30000000000000004,123456789012345680000,5e-324,-1.5e-7,true,false,null]');
  assert.equal(canonical({ '10': 1, '9': 2, a: 3, B: 4, 'é': 5, Z: 6, 'a b': 7, '': 8 }), '{"":8,"10":1,"9":2,"B":4,"Z":6,"a":3,"a b":7,"é":5}');
  assert.equal(canonical({ nested: { deeper: { deepest: [[], {}, [[]], [{}]] } } }), '{"nested":{"deeper":{"deepest":[[],{},[[]],[{}]]}}}');
  assert.equal(hashJson({ b: 1, a: [1, 2, { z: null, y: 'x' }], c: 'é "\\' }), 'd30d0f1833a5961a523effcd51fa7699c0da8e54c4e077e1e22986d09167d00f');
  assert.equal(hashJson([-0, 1e21, 0.1 + 0.2, 123456789012345680000, 5e-324, -1.5e-7, true, false, null]), '3546d2f19e6ecc6cbdaa1282b7e6800fe9f0c063f24c2c8984d119ec380b9567');
  assert.equal(hashJson({ '10': 1, '9': 2, a: 3, B: 4, 'é': 5, Z: 6, 'a b': 7, '': 8 }), '5b3d5b5d779b50452408d974b2f30c51abe75a853348cfded5ffd425e826904b');
  assert.equal(hashJson({ nested: { deeper: { deepest: [[], {}, [[]], [{}]] } } }), '508fa278a4e2b03a3e1a3fe56b4f43de8a9b81c9ecd2b28c29082b38e442fe24');
  assert.equal(hashJson('lone \ud800 surrogate and \u0001 control'), 'ed6fc43471cb7707d4f709fc8bdad3ef2fe547438c843ebd5245ee47f0ac2b9e');
  // The helpers built on canonical keep their meaning.
  assert.equal(digest(canonical({ a: 1 })), hashJson({ a: 1 }));
  assert.equal(compositeKey(['x', null, 3]), '["x",null,3]');
  assert.deepEqual(canonicalSorted([{ b: 2 }, { a: 1 }, { a: 0 }]), [{ a: 0 }, { a: 1 }, { b: 2 }]);
});

test('canonical speed: the key cache is bounded and never changes a text — many names, long names, the same names again', () => {
  // More distinct names than the cache holds, short and long, each met more than once.
  for (let round = 0; round < 2; round++) {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 20000; i++) wide[`name-${i}`] = i;
    assert.equal(canonical(wide), reference(wide), `round ${round}: 20000 distinct names`);
    for (let i = 0; i < 300; i++) {
      const long = { [`${'k'.repeat(60 + (i % 20))}${i}`]: i, short: i, [`${'ü'.repeat(70)}${i}`]: [i] };
      assert.equal(canonical(long), reference(long), `round ${round}: long names ${i}`);
    }
  }
  assert.equal(canonical({ short: 1 }), '{"short":1}', 'a name met first among thousands still reads right');
});

test('canonical speed: the sort boundary — twelve keys by insertion, thirteen and more by the built-in sort — gives one order', () => {
  const rand = random(7);
  for (const count of [0, 1, 2, 3, 11, 12, 13, 14, 25, 100]) {
    for (let round = 0; round < 40; round++) {
      const object: Record<string, number> = {};
      while (Object.keys(object).length < count) object[ALPHABET[Math.floor(rand() * ALPHABET.length)]! + String(Math.floor(rand() * 400))] = round;
      assert.equal(canonical(object), reference(object), `${count} keys, round ${round}`);
    }
  }
});

test('canonical speed: diagnostic — the time of the new and the former implementation on one corpus (never an assertion)', t => {
  const rand = random(99);
  const corpus = Array.from({ length: 3000 }, () => make(rand, 5, false));
  const time = (read: (value: unknown) => string): number => {
    let best = Infinity;
    for (let run = 0; run < 3; run++) { const start = process.hrtime.bigint(); for (const value of corpus) read(value); best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6); }
    return best;
  };
  const before = time(reference), after = time(canonical);
  t.diagnostic(`former ${before.toFixed(1)} ms, new ${after.toFixed(1)} ms on ${corpus.length} values (${(before / after).toFixed(2)}x)`);
  assert.ok(corpus.every(value => canonical(value) === reference(value)));
});
