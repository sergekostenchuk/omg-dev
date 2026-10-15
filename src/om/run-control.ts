import { randomUUID } from "node:crypto";
import type { Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { processStart, processStopRefusal, probeProcessIdentity, stopOwnedGroup, writeProcessStopWitness } from "../runtime/process-identity.js";
import { Store, type Revision, type TransactionGuard, type Write } from "../storage/store.js";
import { storeView } from "../storage/store-view.js";
import { delivered, isPlainObject, isText, refused, type OmResult, type Refusal, type Sealed } from "./refusal.js";

/**
 * H1.3 — the control of a pass (№1910 п.2–8, №1991).
 *
 * The control lives apart from the pass's subject state, in one record per physical store and project. It holds the
 * admission generation, a durable request to stop, and the one executor that owns the pass. Every new step of the pass
 * and every new record of its work carries the exact control revision it was admitted under (or its absence) in its
 * final transaction; the write boundary tells a lost control from an ordinary race, so a stop is never taken for
 * a changed basis. What was already admitted and paid is not guarded by today's control: its receipt, usage, witness
 * and the producer's own application of its result pass by their exact links.
 */
export const RUN_CONTROL_KIND = "om-run-control";
export const RUN_CONTROL_CONTRACT = "om-run-control/v1";
export const RUN_CONTROL_CODES = Object.freeze(["run_control_request_invalid", "run_control_record_invalid", "run_stopped",
  "run_control_changed", "run_busy", "run_stop_unfinished", "run_stop_stale", "run_not_stopped"] as const);
export type RunControlCode = typeof RUN_CONTROL_CODES[number];
const UNIT = "H1.3";
export const runControlId = (project: string): string => `${RUN_CONTROL_KIND}:${project}`;

/** The process that owns an execution: a checked identity, never a bare pid (№1910 п.2). */
export interface RunOwner { readonly pid: number; readonly started: string }
/** The one executor of a pass: its unique token, its owner and the generation it was admitted in. */
export interface RunExecutor { readonly token: string; readonly owner: RunOwner; readonly generation: number }
/** A durable request to stop: its identity and the executor it was asked of, if any. */
export interface RunStop { readonly token: string; readonly execution: RunExecutor | null }
export interface RunControlRecord {
  readonly contract: typeof RUN_CONTROL_CONTRACT;
  readonly project: string;
  /** The admission generation: only an explicit resume of a proved-finished stop begins the next one. */
  readonly generation: number;
  readonly stop: RunStop | null;
  readonly execution: RunExecutor | null;
  /** The stop this generation lifted; null in the first generation. */
  readonly resumed: string | null;
}
/** What an executor or a caller was admitted under: the exact control revision, or its absence. */
export interface RunControlHold { readonly project: string; readonly control: Ref | null }

/**
 * A lost control, found at the write boundary: the pass was stopped, or its control moved on. It is not an EngineError,
 * so no producer takes it for its own refusal and no compile branch turns it into a wait; the public entries of the pass
 * and of E4/E5/A6 return it as their typed control outcome.
 */
export class RunControlLost extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const object = (value: unknown): value is Record<string, any> => isPlainObject(value);
const sameRef = (left: Ref, right: Ref): boolean => left.id === right.id && left.revision === right.revision && left.hash === right.hash;
function invalid(field: string, message: string): never {
  throw new EngineError("run_control_request_invalid", message, { unit: UNIT, target: "control", field });
}
function requireProject(store: unknown, project: unknown): asserts project is string {
  requireCondition(store instanceof Store, "run_control_request_invalid", "The control of a pass is read through a store");
  if (!isText(project)) invalid("project", "The control of a pass names its project");
}
function checkOwner(value: unknown): value is RunOwner {
  return object(value) && Object.keys(value).length === 2 && Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && isText(value.started);
}
function checkExecutor(value: unknown): value is RunExecutor {
  return object(value) && Object.keys(value).length === 3 && isText(value.token) && checkOwner(value.owner)
    && Number.isSafeInteger(value.generation) && (value.generation as number) > 0;
}
function checkRecord(value: unknown, project: string): value is RunControlRecord {
  if (!object(value) || value.contract !== RUN_CONTROL_CONTRACT || value.project !== project) return false;
  const keys = ["contract", "project", "generation", "stop", "execution", "resumed"];
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return false;
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) return false;
  if (value.execution !== null && (!checkExecutor(value.execution) || value.execution.generation !== value.generation)) return false;
  if (value.stop !== null && !(object(value.stop) && Object.keys(value.stop).length === 2 && isText(value.stop.token)
    && (value.stop.execution === null || checkExecutor(value.stop.execution)))) return false;
  return value.resumed === null ? value.generation === 1 : isText(value.resumed) && value.generation > 1;
}
function controlRefusal(code: RunControlCode, message: string, target: string, field: string, ref?: Ref): Refusal {
  const result = refused(code, message, { unit: UNIT, target, field, ...(ref ? { ref } : {}) }, "owner");
  if (result.ok) throw new Error("Unreachable");
  return result.refusal;
}
function lost(code: RunControlCode, message: string, target: string, field: string, ref?: Ref): never {
  throw new RunControlLost(controlRefusal(code, message, target, field, ref));
}

/** The current control of the project, checked as a whole; its absence is the first generation without a stop. */
function currentControl(store: Store, project: string): Revision<RunControlRecord> | null {
  const head = store.get<RunControlRecord>(runControlId(project));
  if (!head) return null;
  if (head.kind !== RUN_CONTROL_KIND || !checkRecord(head.value, project))
    lost("run_control_record_invalid", "The control of the pass lost a required field or holds a foreign one", head.id, "record", reference(head));
  return head;
}
/** Why a holder's control no longer admits it: a durable stop, or a control that moved on without one. */
function loss(head: Revision<RunControlRecord> | null, project: string): never {
  if (head?.value.stop) lost("run_stopped", "The pass is stopped; no new step or dispatch begins until an explicit resume",
    head.id, "stop", reference(head));
  lost("run_control_changed", "The control of the pass moved on since this work was admitted", runControlId(project), "control",
    head ? reference(head) : undefined);
}

/** An admission of new work: the exact control it stands on, as a hold and as the guard of its final transaction. */
export interface RunControlAdmission { readonly hold: RunControlHold; readonly guard: TransactionGuard }
/**
 * Admits new work of the project. A holder keeps the generation it was admitted in — it never takes today's head —
 * and a stop stored since refuses it; a caller without a hold is admitted under the current control unless it is
 * stopped (№1991 п.3: the context is never an optional bypass).
 */
export function admitRunControl(store: Store, project: string, hold?: RunControlHold): RunControlAdmission {
  requireProject(store, project);
  if (hold !== undefined && !(object(hold) && hold.project === project && (hold.control === null || isRef(hold.control))
    && Object.keys(hold).length === 2)) invalid("hold", "A control hold names its project and its exact control or its absence");
  const head = currentControl(store, project);
  if (hold && (hold.control ? !(head && sameRef(reference(head), hold.control)) : head !== null)) loss(head, project);
  if (head?.value.stop) loss(head, project);
  const control = head ? reference(head) : null;
  return { hold: { project, control }, guard: control ?? { id: runControlId(project), absent: true } };
}
function moved(store: Store, admission: RunControlAdmission): boolean {
  const head = store.get(admission.guard.id);
  return "absent" in admission.guard ? head !== null : !(head && sameRef(reference(head), admission.guard as Ref));
}
function guardedWrite(reader: Store, writer: Store, admission: RunControlAdmission, inputs: Write[], guards: TransactionGuard[]): Revision[] {
  try { return writer.writeMany(inputs, [...guards, admission.guard]); }
  catch (error) {
    // Only a changed control is a loss of control; any other stale input stays the producer's own race.
    if (error instanceof EngineError && error.code === "input_stale" && moved(reader, admission))
      loss(currentControl(reader, admission.hold.project), admission.hold.project);
    throw error;
  }
}

/**
 * The permission of new work of one producer run. It is taken at the first write of new work, not before: a repeat
 * or an application of what was already admitted and paid writes nothing new and needs no permission.
 */
export class RunControlGate {
  #admission: RunControlAdmission | null = null;
  constructor(readonly store: Store, readonly project: string, readonly hold?: RunControlHold) {
    requireProject(store, project);
  }
  admit(): RunControlAdmission { return this.#admission ??= admitRunControl(this.store, this.project, this.hold); }
  /** Rechecks the saved admission immediately before a physical side effect that has no store transaction of its own. */
  assertCurrent(): RunControlAdmission {
    const admission = this.admit();
    if (moved(this.store, admission)) loss(currentControl(this.store, this.project), this.project);
    return admission;
  }
  /** The hold to hand on to a nested producer: the one taken here, or the caller's. */
  get held(): RunControlHold | undefined { return this.#admission?.hold ?? this.hold; }
  /** A write-only view whose every transaction carries the admitted control. */
  view(target: Store = this.store): Store {
    return storeView(target, { write: (inputs, guards) => guardedWrite(this.store, target, this.admit(), inputs, guards) });
  }
  /**
   * Watches the admitted control during a long physical call and aborts it once the control moves on: a stop written
   * by another store or process reaches the live executor during its call, not after (№1910 п.6). The watch reads
   * one record at a bounded interval and is cleared after the call.
   */
  /**
   * DRY6-02: the exact stop that moved this admission on, if a stop did — the stopped control revision of the generation
   * the work was admitted in. Any other movement (another executor, a newer generation) names no stop.
   */
  cancelledBy(): { control: Ref; admitted: Ref | null; stop: string } | null {
    const admission = this.admit(), head = currentControl(this.store, this.project);
    if (!head?.value.stop || !moved(this.store, admission)) return null;
    const held = admission.hold.control, admitted = held ? this.store.get<RunControlRecord>(held.id, held.revision) : null;
    if (held ? !(admitted && checkRecord(admitted.value, this.project) && admitted.value.generation === head.value.generation)
      : !(head.revision === 1 && head.value.generation === 1)) return null;
    return { control: reference(head), admitted: held, stop: head.value.stop.token };
  }
  watch(controller: AbortController, intervalMs = 200): () => void {
    const admission = this.admit();
    const timer = setInterval(() => {
      // A read that fails proves no stop; the call's own guarded writes still decide.
      try { if (moved(this.store, admission)) controller.abort(RUN_CONTROL_MOVED); } catch { /* no evidence either way */ }
    }, intervalMs);
    return () => clearInterval(timer);
  }
}

/** DRY6-02: the abort reason of a call cancelled by its watch because its control moved on — never an external signal. */
export const RUN_CONTROL_MOVED = Object.freeze({ reason: "run-control-moved" as const });

/**
 * DRY6-02 (contract №4961 (b)): the proof that the common stop cancelled one dispatched call, saved with the call's terminal
 * in the same transaction — the exact stopped control of the generation the call was admitted in. The string
 * process_cancelled, an external abort signal or today's environment prove nothing.
 */
export const CALL_STOP_CANCEL_KIND = "call-stop-cancel";
export const CALL_STOP_CANCEL_CONTRACT = "call-stop-cancel/v1" as const;
export const callStopCancelId = (call: string): string => `${CALL_STOP_CANCEL_KIND}:${call}`;
export interface CallStopCancel {
  readonly contract: typeof CALL_STOP_CANCEL_CONTRACT; readonly projectId: string;
  readonly call: Ref; readonly control: Ref; readonly admitted: Ref | null; readonly stop: string;
}
export function callStopCancelWrite(projectId: string, call: Ref, link: { control: Ref; admitted: Ref | null; stop: string }): Write {
  return { id: callStopCancelId(call.id), kind: CALL_STOP_CANCEL_KIND, expected: 0,
    value: { contract: CALL_STOP_CANCEL_CONTRACT, projectId, call, control: link.control, admitted: link.admitted, stop: link.stop } };
}
/** The stop that cancelled this exact terminal of a call, or null when no link was saved with it. */
export function stopCancelledCall(store: Store, saved: Revision<object>): { stop: string; control: Revision<RunControlRecord> } | null {
  const link = store.get<CallStopCancel>(callStopCancelId(saved.id));
  if (!link) return null;
  const call = saved as Revision<Record<string, unknown>>;
  const fail = (message: string): never => {
    throw new EngineError("call_stop_cancel_invalid", `[${link.id}] ${message}`, { call: reference(call), link: reference(link) });
  };
  const value = link.value, projectId = call.value["projectId"];
  if (link.kind !== CALL_STOP_CANCEL_KIND || !object(value) || value.contract !== CALL_STOP_CANCEL_CONTRACT || value.projectId !== projectId
    || !isText(projectId) || !isRef(value.call) || !sameRef(value.call, reference(call)) || !isText(value.stop))
    fail("The link does not name this exact terminal of the call");
  if (call.value["status"] !== "failed" || call.value["error"] !== "process_cancelled" || call.value["response"] !== null)
    fail("Only a cancelled call without a response is linked to a stop");
  const control = isRef(value.control) ? store.get<RunControlRecord>(value.control.id, value.control.revision) : null;
  if (!control || control.kind !== RUN_CONTROL_KIND || !sameRef(reference(control), value.control) || !checkRecord(control.value, projectId as string)
    || control.value.stop?.token !== value.stop) fail("The link names no saved stop of this project");
  const held = value.admitted, admitted = held === null ? null : isRef(held) ? store.get<RunControlRecord>(held.id, held.revision) : undefined;
  if (admitted === undefined || (admitted === null ? !(control!.revision === 1 && control!.value.generation === 1)
    : !(sameRef(reference(admitted), held as Ref) && checkRecord(admitted.value, projectId as string)
      && admitted.value.generation === control!.value.generation)))
    fail("The stop does not belong to the generation the call was admitted in");
  return { stop: value.stop, control: control! };
}
/** The control revision whose explicit resume lifted exactly this stop, or null while it still stands. */
export function liftedStop(store: Store, project: string, stop: string): Revision<RunControlRecord> | null {
  requireProject(store, project);
  return store.history<RunControlRecord>(runControlId(project))
    .find(row => checkRecord(row.value, project) && row.value.stop === null && row.value.resumed === stop) ?? null;
}

// ---- The executor: one owner of the pass by CAS, never by a pid, a local map or a lease (№1910 п.2). ----

export type RunOwnerState = "alive" | "gone" | "unknown";
/** A proved death is a vanished process or another process at its pid; an observation failure proves nothing. */
export function runOwnerState(owner: RunOwner): RunOwnerState {
  const observed = probeProcessIdentity(owner.pid);
  if (observed.state === "unavailable") return "unknown";
  return observed.state === "absent" || observed.started !== owner.started ? "gone" : "alive";
}
function currentOwner(): RunOwner {
  const started = processStart(process.pid);
  requireCondition(isText(started), "process_identity_unavailable", "The executor identity is required before it holds a pass");
  return { pid: process.pid, started };
}
function writeControl(store: Store, project: string, head: Revision<RunControlRecord> | null, value: RunControlRecord): Revision<RunControlRecord> | null {
  try {
    return store.writeMany<RunControlRecord>([{ id: runControlId(project), kind: RUN_CONTROL_KIND, expected: head?.revision ?? 0,
      value: value as unknown as Json }])[0]!;
  } catch (error) {
    if (error instanceof EngineError && error.code === "revision_conflict") return null;
    throw error;
  }
}
const firstControl = (project: string): RunControlRecord =>
  ({ contract: RUN_CONTROL_CONTRACT, project, generation: 1, stop: null, execution: null, resumed: null });

export interface RunExecution { readonly hold: RunControlHold; readonly executor: RunExecutor }
/**
 * Takes the one execution of the pass. A stop refuses; a live or unobservable executor is busy and is never displaced;
 * only a proved-dead one is replaced, and its saved step is then continued through the common recovery of its call.
 */
export function acquireRunExecution(store: Store, request: { project: string }): OmResult<Sealed<RunExecution>> {
  requireCondition(object(request) && Object.keys(request).length === 1, "run_control_request_invalid", "An execution is taken for a project");
  const project = request.project;
  requireProject(store, project);
  try {
    for (;;) {
      const head = currentControl(store, project);
      if (head?.value.stop) loss(head, project);
      const held = head?.value.execution;
      if (held) {
        const state = runOwnerState(held.owner);
        if (state !== "gone") return { ok: false, refusal: controlRefusal("run_busy", state === "alive"
          ? "Another live executor holds this pass; it is not displaced"
          : "The executor of this pass cannot be observed; an unproved death is not a free pass", head.id, "execution", reference(head!)) };
      }
      const value = head?.value ?? firstControl(project);
      const executor: RunExecutor = { token: randomUUID(), owner: currentOwner(), generation: value.generation };
      const written = writeControl(store, project, head, { ...value, execution: executor });
      if (written) return delivered({ hold: { project, control: reference(written) }, executor }) as OmResult<Sealed<RunExecution>>;
      // Another store wrote the control first: its record decides again.
    }
  } catch (error) { if (error instanceof RunControlLost) return { ok: false, refusal: error.refusal }; throw error; }
}
/** Gives the execution up, keeping any stop; a later owner or a newer generation is never cleared by an old executor. */
export function releaseRunExecution(store: Store, execution: RunExecution): void {
  const project = execution.hold.project;
  for (;;) {
    const head = currentControl(store, project);
    if (!head || head.value.execution?.token !== execution.executor.token) return;
    if (writeControl(store, project, head, { ...head.value, execution: null })) return;
  }
}

// ---- Stop, its proof and the explicit resume (№1910 п.3, п.8). ----

/** A physical call of the project still claimed and neither received nor recovered: its end is not proved yet. */
export function unfinishedRunCalls(store: Store, project: string): Revision<Record<string, unknown>>[] {
  return store.list<Record<string, unknown>>("model-call").filter(row => object(row.value) && row.value["projectId"] === project
    && row.value["status"] === "running" && !row.value["recovery"]);
}
/**
 * A claimed call whose owner is proved dead has no live watch to cancel it (№2121-2). Once the stop is saved, its
 * recorded provider group is stopped by the common D8.5 function: one identity-checked signal to that exact group, never
 * to a changed or unobservable identity. An end that is not proved is witnessed and keeps the stop unfinished; a live or
 * unobservable owner keeps its own call, which its watch cancels; nothing is presumed dead, and a signal proves nothing.
 */
function stopLostProviders(store: Store, project: string): void {
  for (const call of unfinishedRunCalls(store, project)) {
    const owner = call.value["ownerProcess"], provider = call.value["providerProcess"];
    if (!checkOwner(owner) || !checkOwner(provider) || runOwnerState(owner) !== "gone") continue;
    const report = stopOwnedGroup(provider);
    if (["absent", "stopped", "identity-changed"].includes(report.outcome)) continue;
    writeProcessStopWitness(store, reference(call), { owner, child: provider },
      processStopRefusal(report, "The stop of the pass could not prove the end of the recorded provider group of a call whose owner is gone"));
  }
}
export interface RunControlStatus {
  readonly control: Revision<RunControlRecord> | null;
  readonly stopped: boolean;
  /** The old execution is proved to be over: no live or unobservable executor and no unfinished physical call. */
  readonly finished: boolean;
  /** Why the end is not proved: each an addressed reason. */
  readonly pending: readonly Refusal[];
}
function statusOf(store: Store, project: string): RunControlStatus {
  const head = currentControl(store, project), pending: Refusal[] = [];
  const executor = head?.value.execution;
  if (executor) {
    const state = runOwnerState(executor.owner);
    if (state !== "gone") pending.push(controlRefusal("run_stop_unfinished", state === "alive"
      ? "The executor of the stopped pass is still alive" : "The executor of the stopped pass cannot be observed; its end is not proved",
    head!.id, "execution", reference(head!)));
  }
  for (const call of unfinishedRunCalls(store, project))
    pending.push(controlRefusal("run_stop_unfinished", "A claimed physical call has no receipt or recovery yet; its end is not proved",
      call.id, "status", reference(call)));
  return { control: head, stopped: head?.value.stop != null, finished: pending.length === 0, pending };
}
/** Reads the control of a pass. Reading takes no execution and writes nothing. */
export function readRunControl(store: Store, request: { project: string }): OmResult<Sealed<RunControlStatus>> {
  requireCondition(object(request) && Object.keys(request).length === 1, "run_control_request_invalid", "The control is read by its project");
  requireProject(store, request.project);
  try { return delivered(statusOf(store, request.project)) as OmResult<Sealed<RunControlStatus>>; }
  catch (error) { if (error instanceof RunControlLost) return { ok: false, refusal: error.refusal }; throw error; }
}
/**
 * Saves the prohibition first; the live executor sees it at its next write and during a physical call through its
 * watch. A repeat of the same stop returns the saved one without a new revision. The result tells a requested stop
 * from a proved end of the old execution.
 */
export function stopRun(store: Store, request: { project: string }): OmResult<Sealed<RunControlStatus>> {
  requireCondition(object(request) && Object.keys(request).length === 1, "run_control_request_invalid", "A pass is stopped by its project");
  const project = request.project;
  requireProject(store, project);
  try {
    for (;;) {
      const head = currentControl(store, project);
      const value = head?.value ?? firstControl(project);
      // A repeated stop writes no new request; its lost providers are weighed again, as new evidence may have come.
      if (head?.value.stop || writeControl(store, project, head, { ...value, stop: { token: randomUUID(), execution: value.execution } })) {
        stopLostProviders(store, project);
        return delivered(statusOf(store, project)) as OmResult<Sealed<RunControlStatus>>;
      }
    }
  } catch (error) { if (error instanceof RunControlLost) return { ok: false, refusal: error.refusal }; throw error; }
}
/**
 * Lifts exactly the named stop, only after the old execution is proved to be over; the next generation begins and the
 * old executor stays fenced by its own. Two resumes of one stop converge; a late one never lifts a newer stop. The
 * physical calls of the old execution must be recovered first (the driver does it through the common recovery).
 */
export function resumeStoppedRun(store: Store, request: { project: string; stop: string }): OmResult<Sealed<Revision<RunControlRecord>>> {
  requireCondition(object(request) && isText(request.stop) && Object.keys(request).length === 2,
    "run_control_request_invalid", "A resume names its project and the exact stop it lifts");
  const project = request.project;
  requireProject(store, project);
  try {
    for (;;) {
      const head = currentControl(store, project);
      if (!head?.value.stop) {
        if (head?.value.resumed === request.stop) return delivered(head) as OmResult<Sealed<Revision<RunControlRecord>>>;
        return { ok: false, refusal: controlRefusal(head?.value.resumed ? "run_stop_stale" : "run_not_stopped",
          head?.value.resumed ? "This stop was not the one lifted, and no stop stands now" : "The pass is not stopped",
          runControlId(project), "stop", head ? reference(head) : undefined) };
      }
      if (head.value.stop.token !== request.stop) return { ok: false, refusal: controlRefusal("run_stop_stale",
        "Another stop stands now; a resume lifts only the stop it names", head.id, "stop", reference(head)) };
      const status = statusOf(store, project);
      if (!status.finished) return { ok: false, refusal: status.pending[0]! };
      const written = writeControl(store, project, head, { ...head.value, generation: head.value.generation + 1, stop: null,
        execution: null, resumed: request.stop });
      if (written) return delivered(written) as OmResult<Sealed<Revision<RunControlRecord>>>;
    }
  } catch (error) { if (error instanceof RunControlLost) return { ok: false, refusal: error.refusal }; throw error; }
}
export function isRunControlCode(code: string): code is RunControlCode { return (RUN_CONTROL_CODES as readonly string[]).includes(code); }
