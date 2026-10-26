import { createHash } from "node:crypto";
import { EngineError } from "./errors.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const invalid = (): EngineError => new EngineError("invalid_json", "Only finite, acyclic JSON values can be stored");
/** `JSON.stringify(key)` plus the colon, for the few key names every record repeats. Bounded — a short key, a fixed number
 * of entries — so no stored data can grow it. */
const quotedKeys = new Map<string, string>();
const QUOTED_KEY_LIMIT = 8192, QUOTED_KEY_LENGTH = 64;
function quoted(key: string): string {
  let text = quotedKeys.get(key);
  if (text === undefined) {
    text = `${JSON.stringify(key)}:`;
    if (key.length <= QUOTED_KEY_LENGTH && quotedKeys.size < QUOTED_KEY_LIMIT) quotedKeys.set(key, text);
  }
  return text;
}
/** The order of `Array.prototype.sort()` on strings (UTF-16 code units), in place: a short insertion sort for the few keys
 * of an ordinary record, the built-in sort beyond that. */
function sortKeys(keys: string[]): void {
  const count = keys.length;
  if (count > 12) { keys.sort(); return; }
  for (let i = 1; i < count; i++) {
    const key = keys[i]!;
    let j = i - 1;
    while (j >= 0 && keys[j]! > key) { keys[j + 1] = keys[j]!; j--; }
    keys[j + 1] = key;
  }
}

/** The canonical text of a JSON value: object keys in code-unit order, no whitespace. Only finite numbers, strings, booleans,
 * null, dense arrays and plain acyclic objects are values; anything else is `invalid_json`. The text is what every address
 * and hash in the system is made of, so it is byte-for-byte the one this function always produced — and it reads a value in
 * the same order, so a Proxy, a getter or a changing field is met exactly as before. */
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return "null";
    const kind = typeof item;
    if (kind === "string") return JSON.stringify(item);
    if (kind === "boolean") return item ? "true" : "false";
    if (kind === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (kind !== "object" || seen.has(item as object)) throw invalid();
    seen.add(item as object);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new EngineError("invalid_json", "Sparse arrays are forbidden");
      result = `[${item.map(encode).join(",")}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new EngineError("invalid_json", "Only plain objects can be stored");
      const keys = Object.keys(item as object);
      sortKeys(keys);
      result = "{";
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!;
        if (index) result += ",";
        result += quoted(key) + encode((item as Record<string, unknown>)[key]);
      }
      result += "}";
    }
    seen.delete(item as object);
    return result;
  }
  return encode(value);
}

/**
 * The key of a composite canonical order: the canonical encoding of the tuple of its parts. Unlike parts joined by a
 * separator it is unambiguous whatever the parts hold. Each caller fixes the arity — an absent part is null, never a
 * shorter tuple — so a missing part cannot change where a key sorts.
 */
export const compositeKey = (parts: readonly unknown[]): string => canonical(parts);
/** Code-unit order of keys: what is written must not depend on the machine's locale. */
export const compareKeys = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Stable sort by the canonical key of each element, exactly as the `[...values].sort(cmp)` it replaces: the spread
 * densifies holes into real undefined elements, and sort never calls its comparator on undefined — it moves last
 * without a key. With fewer than two comparable values no key is computed at all, just as no comparison ran. Equal
 * keys keep input order, duplicates and element references pass through, the input array is never mutated. */
export const canonicalSorted = <T>(values: readonly T[]): T[] => {
  const copy = [...values];
  const defined = copy.filter(value => value !== undefined);
  const sorted = defined.length < 2 ? defined
    : defined.map(value => [canonical(value), value] as const)
      .sort((a, b) => compareKeys(a[0], b[0]))
      .map(pair => pair[1]);
  return [...sorted, ...copy.filter(value => value === undefined)];
};

export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const hashJson = (value: unknown): string => digest(canonical(value));

/** The one SHA-256 hex form. Stored hashes are digest() output — lowercase only, so a corrupted form is a malformed
 * input, never a stale one (Q5). HASH_PATTERN is the schema string; HASH_RE is an immutable facade: the RegExp it
 * delegates to never leaves this module, so no caller can widen the shared rule through compile or lastIndex
 * (№2709 — a frozen RegExp still compiles; a frozen plain object has no internal matcher to reach). */
export const HASH_PATTERN = "^[a-f0-9]{64}$";
const hashRule = new RegExp(HASH_PATTERN);
export const HASH_RE: Readonly<{ test(value: string): boolean }> = Object.freeze({ test: value => hashRule.test(value) });
