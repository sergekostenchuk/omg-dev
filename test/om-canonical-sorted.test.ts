import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, canonicalSorted, compareKeys } from '../src/canonical.js';

// HASH1 (task line 6983): the six om sort sites used to compute canonical(a) and canonical(b) on every comparator
// invocation. canonicalSorted computes the key once per element — same order, stable on equal keys, input untouched.
// Acceptance is the number of key computations, never wall-clock time.

test('HASH1 empty and single-element inputs are copied without ever computing a key', () => {
  const empty: unknown[] = [];
  const emptyResult = canonicalSorted(empty);
  assert.deepEqual(emptyResult, []);
  assert.notEqual(emptyResult, empty, 'The result is a copy, never the input array');
  // A single element that canonical would refuse never reached the old comparator — and still never reaches a key.
  const fn = () => 1;
  assert.throws(() => canonical(fn), (error: unknown) => (error as { code?: string }).code === 'invalid_json',
    'fixture: a function is not JSON');
  const single = canonicalSorted([fn]);
  assert.equal(single.length, 1);
  assert.equal(single[0], fn, 'the element passes through untouched');
});

test('HASH1 undefined elements are moved last without a key, exactly like Array.sort', () => {
  // Probe 1 (№7061): undefined never reached the replaced comparator, so it never reaches canonical either.
  const x0 = { x: 0 }, x1 = { x: 1 };
  const mixed: unknown[] = [undefined, x1, x0, undefined];
  const reference = [...mixed].sort((a, b) => compareKeys(canonical(a), canonical(b)));
  assert.deepEqual(canonicalSorted(mixed), reference);
  assert.deepEqual(canonicalSorted(mixed), [x0, x1, undefined, undefined]);
});

test('HASH1 a sparse input densifies into owned undefined elements like the spread copy did', () => {
  // Probe 2 (№7061): [...values] owned every index; the result must too — a hole in the output differs by
  // both deep equality and property ownership.
  const sparse = new Array<number>(3);
  sparse[1] = 2; sparse[2] = 1;
  const out = canonicalSorted(sparse);
  assert.deepEqual(out, [1, 2, undefined]);
  assert.ok(Object.hasOwn(out, 2), 'index 2 is an own undefined element, not a hole');
});

test('HASH1 one comparable element never computes a key, however many undefined it carries', () => {
  // Probe 3 (№7061): with fewer than two defined elements the old comparator never ran — the non-JSON
  // single element must pass through where canonical would refuse it.
  const fn = () => 1;
  const out = canonicalSorted([undefined, fn, undefined]);
  assert.deepEqual(out, [fn, undefined, undefined]);
  assert.equal(out[0], fn);
});

test('HASH1 the canonical key is computed exactly once per element', () => {
  const traversals = new Array<number>(64).fill(0);
  // canonical() reads Object.getPrototypeOf once per visited object — one traversal per element means one visit.
  const items = traversals.map((_, i) => new Proxy({ v: 63 - i }, {
    getPrototypeOf(target) {
      traversals[i]!++;
      return Reflect.getPrototypeOf(target);
    },
  }));
  const plain = traversals.map((_, i) => ({ v: 63 - i }));
  const out = canonicalSorted(items);
  // The count is measured before the reference sort below touches the proxies again through the comparator.
  assert.deepEqual(traversals, new Array(64).fill(1), 'each element is canonicalized once, not per comparison');
  const reference = [...plain].sort((a, b) => compareKeys(canonical(a), canonical(b))).map(o => o.v);
  assert.deepEqual(out.map(o => o.v), reference);
});

test('HASH1 equal keys keep input order and duplicates and references are preserved', () => {
  // Key order is the property order: {a,b} and {b,a} share one canonical encoding.
  const first = { a: 1, b: 2 }, second = { b: 2, a: 1 }, other = { a: 3 };
  assert.equal(canonical(first), canonical(second), 'fixture: the two spellings share one canonical key');
  const input = [other, first, second];
  const out = canonicalSorted(input);
  // {"a":1,"b":2} < {"a":3} by code units; the equal-key pair keeps its input order.
  assert.deepEqual(out, [first, second, other]);
  assert.equal(out[0], first); assert.equal(out[1], second, 'stable on equal keys');
  const dup = { x: 5 };
  const withDup = canonicalSorted([dup, other, dup]);
  assert.equal(withDup.filter(v => v === dup).length, 2, 'a duplicate reference survives as two entries');
  assert.ok(out.every(v => input.includes(v)), 'every output element is an original reference');
});

test('HASH1 canonical string order applies to Unicode by code unit, never locale', () => {
  const input = ['ы', 'a', 'Z', '😀', 'Á', 'z'];
  const out = canonicalSorted(input);
  const reference = [...input].sort((a, b) => compareKeys(canonical(a), canonical(b)));
  assert.deepEqual(out, reference);
  // Code-unit order puts ASCII capitals before ASCII lower-case, and BMP before astral planes.
  assert.deepEqual(out, ['Z', 'a', 'z', 'Á', 'ы', '😀']);
});

test('HASH1 a deterministic mixed dataset matches the comparator reference byte for byte', () => {
  // LCG-generated deterministic set: objects, strings, numbers, arrays, nested, repeats.
  let seed = 0x2f6e2b;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const pick = (): unknown => {
    switch (next() % 5) {
      case 0: return { id: `rec-${next() % 7}`, weight: next() % 100 };
      case 1: return `item-${next() % 5}`;
      case 2: return next() % 40;
      case 3: return [next() % 3, `x${next() % 4}`];
      default: return { id: 'shared', weight: 1 }; // deliberate duplicate canonical key
    }
  };
  const input = Array.from({ length: 300 }, pick);
  const snapshot = structuredClone(input);
  const out = canonicalSorted(input);
  const reference = [...input].sort((a, b) => compareKeys(canonical(a), canonical(b)));
  assert.deepEqual(out, reference, 'same ordering the comparator produced');
  assert.deepEqual(input, snapshot, 'the input array is never mutated');
  assert.equal(out.length, input.length, 'no element is lost or duplicated');
  // Identical bytes: re-serializing the sorted set gives the same string as the reference order.
  assert.equal(canonical(out), canonical(reference));
});
