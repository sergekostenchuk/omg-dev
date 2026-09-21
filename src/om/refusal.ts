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

export interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly at: RefusalAddress;
  readonly route: RefusalRoute;
}

export type OmResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: Refusal };

// T11: what a unit hands out shares no mutable object with its source or with a policy table.
export type Sealed<T> =
  T extends (...args: never[]) => unknown ? never
  : T extends readonly (infer Item)[] ? readonly Sealed<Item>[]
  : T extends object ? { readonly [Key in keyof T]: Sealed<T[Key]> }
  : T;

export function sealed<T>(value: T): Sealed<T> {
  return seal(value, new Set<object>()) as Sealed<T>;
}

// The accepted shapes are canonical()'s: a unit may only deliver finite, acyclic JSON.
function seal(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || seen.has(value)) {
    throw new EngineError("unsealable_value", "Only finite, acyclic JSON values can be delivered to a consumer");
  }
  seen.add(value);
  let copy: unknown;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new EngineError("unsealable_value", "Sparse arrays cannot be delivered");
    copy = Object.freeze(value.map(item => seal(item, seen)));
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
    copy = Object.freeze(target);
  }
  seen.delete(value);
  return copy;
}

export function delivered<T>(value: T): OmResult<Sealed<T>> {
  return Object.freeze({ ok: true as const, value: sealed(value) });
}

export function refused(code: string, message: string, at: RefusalAddress, route: RefusalRoute): OmResult<never> {
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
