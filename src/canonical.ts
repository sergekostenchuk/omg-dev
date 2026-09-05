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

export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const hashJson = (value: unknown): string => digest(canonical(value));
