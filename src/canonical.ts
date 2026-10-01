import { createHash } from "node:crypto";
import { EngineError } from "./errors.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonical(value: unknown): string {
  const seen = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || seen.has(item)) {
      throw new EngineError("invalid_json", "Only finite, acyclic JSON values can be stored");
    }
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new EngineError("invalid_json", "Sparse arrays are forbidden");
      result = `[${item.map(encode).join(",")}]`;
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
        throw new EngineError("invalid_json", "Only plain objects can be stored");
      }
      result = `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    seen.delete(item);
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

export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const hashJson = (value: unknown): string => digest(canonical(value));
