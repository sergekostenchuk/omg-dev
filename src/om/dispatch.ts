import { EngineError } from "../errors.js";
import { reference, uniqueRefs, type Ref } from "../pipeline/contracts.js";
import { readEnvironmentAt } from "../runtime/environment.js";
import { Store, type Revision } from "../storage/store.js";
import { isStdioProtocol, STDIO_PROTOCOLS, type StdioProtocol } from "../adapters/stdio-providers.js";
import type { DispatchContract } from "./call-record.js";
import { readCapacity } from "./capacity.js";
import { delivered, isPlainObject, refused, type OmResult, type RefusalAddress, type Sealed } from "./refusal.js";
import { readRecord, writeGuarded } from "./refs.js";

/**
 * The subject refusals this unit creates itself. What readEnvironmentAt, readCapacity, readRecord and writeGuarded pass
 * through is theirs, and so is record_missing, the Ref-group code the reader gives for an adapter not yet configured.
 */
export const DISPATCH_CODES = Object.freeze(["dispatch_request_invalid", "environment_missing", "dispatch_adapter_invalid"] as const);

export const DISPATCH_PROTOCOLS = STDIO_PROTOCOLS;

export interface DispatchReadRequest { project: string }
export interface DispatchRequest { project: string; protocol: StdioProtocol }
/** The pair E1/E4/E5/A6 and H1 take as `dispatch`, and the heads a consumer keeps guarding while it relies on them. */
export interface OmDispatch { dispatch: DispatchContract; references: Ref[]; guards: Ref[] }

interface Basis { environment: Ref; adapter: Ref | null; protocol: StdioProtocol | null }

const UNIT = "E4.1";
const ADAPTER_KIND = "dispatch-adapter";
// The command's own project pattern: it also keeps adapter:<project>:<name> inside the project's namespace and
// inside the store's 200-character id limit.
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
// What readEnvironmentAt declares for a saved record that cannot serve. Any other failure is not this unit's to name.
const ENVIRONMENT_DEFECTS = new Set(["environment_invalid", "role_invalid", "reviewer_not_independent", "command_unavailable"]);

/** The single selection record: adapter:<project>:active (LG23: original-era per-protocol address removed). */
const activeId = (project: string): string => `adapter:${project}:active`;

function invalid(field: string, message: string): never {
  throw new EngineError("dispatch_request_invalid", message, { unit: UNIT, target: "dispatch", field });
}

function requireRequest(store: unknown, request: unknown, withProtocol: boolean): void {
  if (!(store instanceof Store)) invalid("store", "Dispatch settings live in a store");
  if (!isPlainObject(request)) invalid("request", "Dispatch settings are asked for by a request object");
  const named = request as Record<string, unknown>;
  const keys = withProtocol ? ["project", "protocol"] : ["project"];
  if (Object.keys(named).sort().join(",") !== keys.join(","))
    invalid("request", `A dispatch request names exactly ${keys.join(" and ")}`);
  if (typeof named["project"] !== "string" || !PROJECT.test(named["project"]))
    invalid("project", "A dispatch request names a project ID of the command's own pattern");
  if (withProtocol && !isStdioProtocol(named["protocol"]))
    invalid("protocol", `Only a known stdio protocol is supported: ${STDIO_PROTOCOLS.join(", ")}`);
}

/** A saved record serves only when it is exactly this project's adapter for a known protocol. */
function adapterFault(project: string, body: unknown): string | null {
  if (!isPlainObject(body)) return "value";
  const value = body as Record<string, unknown>;
  if (value["projectId"] !== project) return "projectId";
  if (!isStdioProtocol(value["protocol"])) return "protocol";
  return Object.keys(value).length === 2 ? null : "value";
}

function addressOf(details: unknown, target: string, ref: Ref): RefusalAddress {
  const named = isPlainObject(details) ? details as Record<string, unknown> : {};
  const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
  return { unit: text(named["unit"]) ?? UNIT, target: text(named["target"]) ?? target,
    field: text(named["field"]) ?? "environment", ref };
}

function readAdapter(store: Store, project: string, id: string, saved: Revision<unknown>): OmResult<StdioProtocol> {
  const read = readRecord<Record<string, unknown>>(store, reference(saved), { unit: UNIT, target: id, id, kind: ADAPTER_KIND });
  if (!read.ok) return read;
  const fault = adapterFault(project, read.value.value);
  if (fault) return refused("dispatch_adapter_invalid", `The saved ${id} is not this project's dispatch adapter`,
    { unit: UNIT, target: id, field: fault, ref: reference(saved) }, "producer");
  return delivered(read.value.value["protocol"] as StdioProtocol);
}

/** The current environment of the project, judged by the shared readers, and the adapter selection in force. */
function derive(store: Store, project: string): OmResult<Basis> {
  const environmentId = `environment:${project}`;
  const head = store.get(environmentId);
  // readEnvironmentAt asks for an exact Ref, so the absence of a head is named here, with its address.
  if (!head) return refused("environment_missing", "Configure the project's environment before its dispatch",
    { unit: UNIT, target: environmentId, field: "environment" }, "producer");
  const environment = reference(head);
  try { readEnvironmentAt(store, project, environment); }
  catch (error) {
    if (!(error instanceof EngineError) || !ENVIRONMENT_DEFECTS.has(error.code)) throw error;
    return refused(error.code, error.message, addressOf(error.details, environmentId, environment), "producer");
  }
  const capacity = readCapacity(store, { project, environment, current: true });
  if (!capacity.ok) return capacity;
  const active = store.get(activeId(project));
  if (!active) return { ok: true, value: { environment, adapter: null, protocol: null } };
  const read = readAdapter(store, project, activeId(project), active);
  if (!read.ok) return read;
  return { ok: true, value: { environment, adapter: reference(active), protocol: read.value } };
}

function outcome(config: Ref, adapter: Ref): OmDispatch {
  return { dispatch: { adapter, config }, references: uniqueRefs([config, adapter]), guards: uniqueRefs([config, adapter]) };
}

/** The dispatch a new piece of work takes now: the current environment head with the adapter already configured. */
export function readDispatch(store: Store, request: DispatchReadRequest): OmResult<Sealed<OmDispatch>> {
  requireRequest(store, request, false);
  const basis = derive(store, request.project);
  if (!basis.ok) return basis;
  if (!basis.value.adapter) return refused("record_missing", "The project's adapter is not configured yet",
    { unit: UNIT, target: activeId(request.project), field: "adapter" }, "producer");
  return delivered(outcome(basis.value.environment, basis.value.adapter));
}

/**
 * Writes the adapter selection of the project under the exact environment it was derived from, and returns the
 * dispatch. One selection record adapter:<project>:active is revised on each protocol switch. Repeating the same
 * configuration writes nothing.
 */
export function configureDispatch(store: Store, request: DispatchRequest): OmResult<Sealed<OmDispatch>> {
  requireRequest(store, request, true);
  const project = request.project, active = activeId(project);
  const basis = derive(store, project);
  if (!basis.ok) return basis;
  const { environment, adapter, protocol } = basis.value;
  if (adapter && protocol === request.protocol) return delivered(outcome(environment, adapter));
  const written = adapter
    // The active record selects the current protocol; switching revises it under its own exact guard.
    ? writeGuarded(store, { unit: UNIT, target: active, guards: [environment, adapter],
        writes: [{ id: active, kind: ADAPTER_KIND, expected: adapter.revision, value: { projectId: project, protocol: request.protocol } }] })
    : writeGuarded(store, { unit: UNIT, target: active, guards: [environment],
        writes: [{ id: active, kind: ADAPTER_KIND, expected: 0, value: { projectId: project, protocol: request.protocol } }] });
  if (written.ok) return delivered(outcome(environment, reference(written.value[0]!)));
  if (written.refusal.code !== "revision_conflict"
    && !(written.refusal.code === "input_stale" && written.refusal.at?.target === active)) return written;
  // Another Store changed the selection first: it serves only if it is exactly the protocol this request asked for.
  const winner = derive(store, project);
  if (!winner.ok) return winner;
  return winner.value.adapter && winner.value.protocol === request.protocol
    ? delivered(outcome(winner.value.environment, winner.value.adapter)) : written;
}
