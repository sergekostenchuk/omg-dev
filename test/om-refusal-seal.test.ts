import test from "node:test";
import assert from "node:assert/strict";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { delivered, sealed } from "../src/om/refusal.js";

/**
 * PF6 (№4262): a copy seal made is known by a private brand stamped before it is frozen, not by a weak table of every copy.
 * The brand changes nothing a consumer can see: the same keys, JSON, canonical form and hash; a copy delivered again is the
 * same object; another frozen object, or a copy of a copy made by anyone else, is sealed anew.
 */
const value = (): Json => ({ id: "om-gap:garden:a", revision: 2, list: [1, "two", { three: [true, null] }], nested: { deep: { deeper: [{ x: 1 }] } },
  ["__proto__"]: { own: "field" } } as unknown as Json);
const frozenDeep = <T>(item: T): T => {
  if (item !== null && typeof item === "object") { for (const key of Object.keys(item)) frozenDeep((item as Record<string, unknown>)[key]); Object.freeze(item); }
  return item;
};
const objects = (item: unknown): object[] => item !== null && typeof item === "object"
  ? [item, ...Object.keys(item).flatMap(key => objects((item as Record<string, unknown>)[key]))] : [];

test("PF6: a sealed copy is deeply frozen, and it and every nested copy are handed on as they are when delivered again", () => {
  const source = value(), copy = sealed(source);
  assert.notEqual(copy, source);
  for (const item of objects(copy)) {
    assert.ok(Object.isFrozen(item));
    assert.equal(sealed(item), item, "A nested sealed copy is delivered as it is");
  }
  assert.equal(sealed(copy), copy);
  assert.equal(delivered(copy).value, copy);
  assert.equal(sealed({ wrap: copy }).wrap, copy, "A sealed copy inside a new value is carried, not copied");
});

test("PF6: the brand is no property — keys, symbols, JSON, the canonical form, the hash and deep equality are the source's", () => {
  const source = value(), copy = sealed(source);
  for (const [from, to] of objects(source).map((item, index) => [item, objects(copy)[index]!] as const)) {
    assert.deepEqual(Reflect.ownKeys(to), Reflect.ownKeys(from));
    assert.deepEqual(Object.getOwnPropertySymbols(to), []);
  }
  assert.equal(JSON.stringify(copy), JSON.stringify(source));
  assert.equal(canonical(copy as Json), canonical(source));
  assert.equal(hashJson(copy as Json), hashJson(source));
  assert.deepEqual(copy, source);
  assert.deepEqual(structuredClone(copy), source);
  assert.equal(Object.getPrototypeOf((copy as { __proto__: unknown })), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(copy, "__proto__")?.value, { own: "field" }, "An own __proto__ field stays a field");
});

test("PF6: another frozen object, a spread, a clone or a JSON copy of a sealed copy is no sealed copy — it is copied anew", () => {
  const foreign = frozenDeep(value()), copy = sealed(value());
  const others: unknown[] = [foreign, { ...(copy as Record<string, unknown>) }, structuredClone(copy), JSON.parse(JSON.stringify(copy)),
    Object.freeze([...(copy as { list: unknown[] }).list])];
  for (const other of others) {
    const again = sealed(other);
    assert.notEqual(again, other, "Only a copy seal made is handed on as it is");
    assert.deepEqual(again, other);
    assert.equal(sealed(again), again);
  }
  // Frozen or not, a foreign object's nested values are copied too.
  const resealed = sealed(foreign) as { nested: unknown };
  assert.notEqual(resealed.nested, (foreign as { nested: unknown }).nested);
});

test("PF6: what seal refused before it refuses the same way — functions, cycles, sparse arrays, instances, non-finite numbers", () => {
  const cyclic: Record<string, unknown> = {}; cyclic["self"] = cyclic;
  const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
  for (const bad of [() => 1, cyclic, sparse, new Date(0), new Map(), Number.NaN, Number.POSITIVE_INFINITY, undefined, 1n])
    assert.throws(() => sealed({ bad }), (error: unknown) => error instanceof EngineError && error.code === "unsealable_value");
  // A value shared twice (not a cycle) is sealed — each occurrence a copy.
  const shared = { a: 1 }, twice = sealed({ left: shared, right: shared }) as { left: unknown; right: unknown };
  assert.deepEqual([twice.left, twice.right], [shared, shared]);
});
