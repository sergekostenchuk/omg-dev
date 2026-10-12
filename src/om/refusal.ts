import { EngineError, requireCondition } from "../errors.js";
import type { Ref } from "../pipeline/contracts.js";

// A typed signature is a promise, not a guarantee at the module boundary: every exported function of the block
// checks the shape of what it was handed before touching a field, so an absent argument is a typed refusal (T4).
export const isText = (value: unknown): boolean => typeof value === "string" && value.length > 0;
export const isPlainObject = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value);

// T8: a refusal says what failed, at which address, and to whom it goes back. It switches nothing by itself,
// so it carries no payload a consumer could mistake for permission to retry, to open a call or to change readiness.
export const REFUSAL_ROUTES = Object.freeze(["producer", "gap", "owner", "readiness"] as const);
export type RefusalRoute = typeof REFUSAL_ROUTES[number];

export interface RefusalAddress {
  readonly unit: string;
  readonly target: string;
  // Optional parts accept an explicit undefined so a caller can pass a computed value; refused() drops it.
  readonly field?: string | undefined;
  readonly ref?: Ref | undefined;
}

export interface Refusal<Code extends string = string> {
  readonly code: Code;
  readonly message: string;
  readonly at: RefusalAddress;
  readonly route: RefusalRoute;
}

export type OmResult<T, Code extends string = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: Refusal<Code> };

// Q2 (№2452, №2460): a module creates refusals only from its own literal catalogue, and a refusal of another unit enters
// it only through a declared transfer. Both are facts for tsc: an unknown literal, another module's code or a plain
// string does not compile where a local code or a transferred code is expected. tsc proves no provenance of data and no
// completeness of runtime branches; the link between a transfer and its real source is read in code and in review.
/** The negative half of a result, as a declared source hands it over. */
export type Failed<Code extends string = string> = { readonly ok: false; readonly refusal: Refusal<Code> };
/**
 * The mark of a transferred code: a fact of the type alone — the saved JSON gains no field, the refusal is the same
 * object. Every source the code passed through is a key of the mark, so a refusal carried across two modules keeps both,
 * and a code copied into a plain string loses the mark: `{ ...refusal, code: text }` is no transferred refusal.
 */
declare const TRANSFERRED: unique symbol;
export type SourceCode<Source extends string, Code extends string = string> =
  Code & { readonly [TRANSFERRED]: { readonly [Key in Source]: true } };
/** The codes of several declared sources, one mark each (a distributive union, never one mark that needs every key). */
export type SourceCodes<Sources extends string> = Sources extends string ? SourceCode<Sources> : never;
/** A result of a declared source as the receiving module sees it: delivered values pass unchanged, refusals carry the mark. */
export type Transferred<Source extends string, R> = R extends Failed<infer Code> ? Failed<SourceCode<Source, Code>> : R;

// T11: what a unit hands out shares no mutable object with its source or with a policy table.
export type Sealed<T> =
  T extends (...args: never[]) => unknown ? never
  // A string stays itself, a marked code (SourceCode) included: a mark is no field of a value, and a string has none to seal.
  : T extends string ? T
  : T extends readonly (infer Item)[] ? readonly Sealed<Item>[]
  : T extends object ? { readonly [Key in keyof T]: Sealed<T[Key]> }
  : T;

export function sealed<T>(value: T): Sealed<T> {
  return seal(value, new Set<object>()) as Sealed<T>;
}
/**
 * NR1 (№3600): a copy seal made — deeply frozen, checked once, never changing — is handed on as it is when it is delivered
 * again, never checked and copied again. PF6 (№4262): it is known by a private brand stamped on it before it is frozen, not
 * by a weak table of every copy: a WeakSet of each nested copy of each result took 6.1 million keys in one step of the live
 * pass, and its ephemeron rehash held the main thread for minutes. A private field is no property — keys, JSON, hashes,
 * spreads, clones and Reflect.ownKeys never see it — and only seal stamps it: another frozen object is no sealed copy.
 */
class SealedBase { constructor(copy: object) { return copy; } }
class SealedCopy extends SealedBase {
  #sealed = true;
  static stamp<T extends object>(copy: T): T { return new SealedCopy(copy) as unknown as T; }
  static has(value: object): boolean { return #sealed in value; }
}

// The accepted shapes are canonical()'s: a unit may only deliver finite, acyclic JSON.
function seal(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || seen.has(value)) {
    throw new EngineError("unsealable_value", "Only finite, acyclic JSON values can be delivered to a consumer");
  }
  if (SealedCopy.has(value)) return value;
  seen.add(value);
  let copy: unknown;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new EngineError("unsealable_value", "Sparse arrays cannot be delivered");
    copy = Object.freeze(SealedCopy.stamp(value.map(item => seal(item, seen))));
  } else {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new EngineError("unsealable_value", "Only plain objects can be delivered");
    }
    const target: Record<string, unknown> = {};
    // Own fields are defined, not assigned: assigning "__proto__" would call the prototype setter instead, dropping
    // the field and letting its value become the prototype of the copy — different content, and a different hash.
    for (const key of Object.keys(value)) {
      Object.defineProperty(target, key, {
        value: seal((value as Record<string, unknown>)[key], seen),
        enumerable: true, writable: true, configurable: true,
      });
    }
    copy = Object.freeze(SealedCopy.stamp(target));
  }
  seen.delete(value);
  return copy;
}

/** A delivered value is the positive half alone: it fits any result type, whatever codes that type admits. */
export function delivered<T>(value: T): { readonly ok: true; readonly value: Sealed<T> } {
  return Object.freeze({ ok: true as const, value: sealed(value) });
}

/**
 * A module's own constructor of refusals, bound to its literal catalogue: only a code of the catalogue compiles, and at
 * runtime a code outside it is as malformed as an empty one. The catalogue is the module's full set of locally created
 * codes — the subsets older tests pin (INPUT_REFUSAL_CODES, HORIZON_REFUSAL_CODES) stay separate exports.
 */
export function localRefusals<const Codes extends readonly string[]>(codes: Codes):
  <Code extends Codes[number]>(code: Code, message: string, at: RefusalAddress, route: RefusalRoute) => OmResult<never, Code> {
  requireCondition(Array.isArray(codes) && codes.length > 0 && codes.every(isText), "refusal_invalid", "A catalogue names its codes");
  const known = new Set<string>(codes);
  return (code, message, at, route) => {
    requireCondition(known.has(code), "refusal_invalid", `The refusal code ${String(code)} is outside the module's catalogue`);
    return refused(code, message, at, route);
  };
}
/** The same bound for a module's own exceptions: a separate catalogue of EngineError codes, the global class unchanged. */
export function localErrors<const Codes extends readonly string[]>(codes: Codes):
  (code: Codes[number], message: string, details?: unknown) => never {
  requireCondition(Array.isArray(codes) && codes.length > 0 && codes.every(isText), "refusal_invalid", "A catalogue names its codes");
  const known = new Set<string>(codes);
  return (code, message, details = null) => {
    requireCondition(known.has(code), "refusal_invalid", `The error code ${String(code)} is outside the module's catalogue`);
    throw new EngineError(code, message, details);
  };
}
/**
 * The one boundary where a declared source's refusal enters a module: the result itself (or its negative half), whole
 * and unchanged, now marked with the source. Never a code and a message assembled by the caller, never an unknown value —
 * the narrowing below is the only one a transfer makes, and it narrows nothing but the mark.
 */
export function transfer<Source extends string, R extends OmResult<unknown, string>>(source: Source, result: R): Transferred<Source, R> {
  requireCondition(isText(source) && isPlainObject(result) && typeof result.ok === "boolean", "refusal_invalid", "A transfer names its source and carries a whole result");
  return result as Transferred<Source, R>;
}
/** A reader of a declared source, bound once at the import boundary: every refusal it returns carries the source mark. */
export function transferring<Source extends string, Args extends unknown[], R extends OmResult<unknown, string>>(source: Source,
  reader: (...args: Args) => R): (...args: Args) => Transferred<Source, R> {
  requireCondition(isText(source) && typeof reader === "function", "refusal_invalid", "A transferring reader names its source");
  return (...args) => transfer(source, reader(...args));
}

/**
 * Q2b (№2518-3, №2522-1): a declared source's exception as the receiving module's refusal — the exception's own code and
 * message, at the address and route the module always gave them, marked with the source. The module keeps its own filter
 * of which exceptions it turns into refusals and rethrows the rest; the code is never chosen by the caller.
 */
export function transferError<Source extends string>(source: Source, error: EngineError, at: RefusalAddress, route: RefusalRoute):
  OmResult<never, SourceCode<Source>> {
  requireCondition(isText(source) && error instanceof EngineError, "refusal_invalid", "A transferred exception names its source and is an EngineError");
  return transfer(source, refused(error.code, error.message, at, route));
}

export function refused<Code extends string>(code: Code, message: string, at: RefusalAddress, route: RefusalRoute): OmResult<never, Code> {
  requireCondition(isText(code) && isText(message), "refusal_invalid", "A refusal names a non-empty code and message");
  requireCondition(isPlainObject(at) && isText(at.unit) && isText(at.target)
    && (at.field === undefined || isText(at.field)) && (at.ref === undefined || isPlainObject(at.ref)),
  "refusal_invalid", "A refusal without an address is not a refusal (T8)");
  requireCondition(REFUSAL_ROUTES.includes(route), "refusal_invalid", "A refusal names a route from the policy table (T8)");
  const address: RefusalAddress = {
    unit: at.unit, target: at.target,
    ...(at.field === undefined ? {} : { field: at.field }),
    // The reference is copied, not frozen in place: a refusal never reaches back into the caller's object.
    ...(at.ref === undefined ? {} : { ref: Object.freeze({ id: at.ref.id, revision: at.ref.revision, hash: at.ref.hash }) }),
  };
  return Object.freeze({ ok: false as const, refusal: Object.freeze({ code, message, at: Object.freeze(address), route }) });
}
