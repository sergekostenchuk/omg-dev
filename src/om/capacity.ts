import { EngineError } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { isRequestCapacityChars } from "../runtime/environment.js";
import { Store } from "../storage/store.js";
import { delivered, isPlainObject, refused, type OmResult, type Sealed } from "./refusal.js";
import { readRecord } from "./refs.js";

export const CAPACITY_REFUSAL_CODES = Object.freeze([
  "capacity_missing", "capacity_invalid", "capacity_source_invalid", "input_stale",
] as const);

export interface CapacityRequest { project: string; environment: Ref; current: boolean }
export interface RequestCapacity {
  maxRequestChars: number;
  environment: Ref;
  references: Ref[];
  guards: Ref[];
}

function invalid(field: string): never {
  throw new EngineError("capacity_request_invalid", "Capacity needs a project, exact environment and explicit current/history mode",
    { unit: "V1", target: "capacity", field });
}

/** The setting is a physical request capacity, in boundedContext's string-length units, never an expenditure budget. */
export function readCapacity(store: Store, request: CapacityRequest): OmResult<Sealed<RequestCapacity>> {
  if (!(store instanceof Store)) invalid("store");
  if (!isPlainObject(request)) invalid("request");
  if (typeof request.project !== "string" || !request.project.trim()) invalid("project");
  if (!isRef(request.environment)) invalid("environment");
  if (typeof request.current !== "boolean") invalid("current");
  if (Object.keys(request).some(key => !["project", "environment", "current"].includes(key))) invalid("request");
  const id = `environment:${request.project}`;
  const source = readRecord<Record<string, unknown>>(store, request.environment, { unit: "V1", target: id, id, kind: "environment" });
  if (!source.ok) return source;
  const record = source.value, value = record.value, ref = reference(record);
  if (!isPlainObject(value) || value.projectId !== request.project)
    return refused("capacity_source_invalid", "Capacity belongs to the named project's environment",
      { unit: "V1", target: id, field: "projectId", ref }, "producer");
  if (!Object.hasOwn(value, "requestCapacityChars"))
    return refused("capacity_missing", "Configure the technical request capacity before admitting a new capacity-dependent operation",
      { unit: "V1", target: id, field: "requestCapacityChars", ref }, "producer");
  if (!isRequestCapacityChars(value.requestCapacityChars))
    return refused("capacity_invalid", "Technical request capacity must be a positive safe integer measured in characters",
      { unit: "V1", target: id, field: "requestCapacityChars", ref }, "producer");
  if (request.current) {
    const head = store.get(id);
    if (!head || head.revision !== ref.revision || head.hash !== ref.hash)
      return refused("input_stale", "The capacity setting changed before this operation was prepared",
        { unit: "V1", target: id, field: "environment", ref }, "producer");
  }
  return delivered({ maxRequestChars: value.requestCapacityChars, environment: ref, references: [ref], guards: request.current ? [ref] : [] });
}
