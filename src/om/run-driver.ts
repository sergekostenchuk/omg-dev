import { EngineError, requireCondition } from "../errors.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { readDispatch } from "./dispatch.js";
import { recoverOmModelCall } from "./model-call.js";
import { delivered, isPlainObject, isText, refused, type OmResult, type Refusal, type Sealed } from "./refusal.js";
import { acquireRunExecution, readRunControl, releaseRunExecution, resumeStoppedRun, runOwnerState, stopRun, unfinishedRunCalls,
  RunControlGate, RunControlLost, type RunControlRecord, type RunControlStatus, type RunExecution } from "./run-control.js";
import { advanceRun, readRun, startRun, unableReopens, type RunRecord, type RunRequest } from "./run.js";
import { writeRunBases } from "./run-bases.js";
import { integrityGate } from "./integrity.js";

/**
 * H1.3 — the driver of a pass (№1910 п.1): the one production entry that starts and continues the OM pass of a project.
 *
 * It takes a project and the launch intent of H1.1, reads the dispatch through the common E4.1 reader, holds the one
 * execution of the pass and moves it by startRun/advanceRun until the pass is complete, unable, stopped, or stands on a
 * wait that advancing does not change. It builds no bases, chooses no queue and no rung and makes no product itself:
 * all of that stays where H1/H1.1/H1.2 put it. A repeated unchanged wait is returned, never looped on and never paid.
 */
const UNIT = "H1.3";

/** How a drive ended: the pass's own end, a wait advancing does not change, or a control outcome. */
export type PassEnd = "complete" | "unable" | "waiting" | "stopped" | "busy";
export interface PassOutcome {
  readonly end: PassEnd;
  readonly run: Revision<RunRecord> | null;
  readonly control: RunControlStatus;
  /** The control refusal behind `stopped` or `busy`; null for an end of the pass itself. */
  readonly refusal: Refusal | null;
}
export interface PassStartRequest { readonly project: string; readonly outcomes?: readonly string[] }
export interface PassRequest { readonly project: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const object = (value: unknown): value is Record<string, any> => isPlainObject(value);
const sameRef = (left: Ref, right: Ref): boolean => left.id === right.id && left.revision === right.revision && left.hash === right.hash;
function requireRequest(store: unknown, request: unknown, keys: readonly string[]): asserts request is PassRequest {
  requireCondition(store instanceof Store, "run_control_request_invalid", "A pass is driven through a store");
  requireCondition(object(request) && isText(request.project) && Object.keys(request).every(key => keys.includes(key)),
    "run_control_request_invalid", `A pass is driven by its project${keys.length > 1 ? " and its launch intent" : ""}`);
}
const CONTROL_ENDS: Readonly<Record<string, PassEnd>> = Object.freeze({ run_stopped: "stopped", run_control_changed: "stopped", run_busy: "busy" });

function controlOf(store: Store, project: string): RunControlStatus {
  const status = readRunControl(store, { project });
  if (!status.ok) throw new EngineError(status.refusal.code, status.refusal.message, status.refusal.at);
  return status.value as RunControlStatus;
}
function savedRun(store: Store, project: string): Revision<RunRecord> | null {
  const saved = readRun(store, { project });
  if (!saved.ok) throw new EngineError(saved.refusal.code, saved.refusal.message, saved.refusal.at);
  return saved.value as Revision<RunRecord> | null;
}
function outcome(store: Store, project: string, end: PassEnd, refusal: Refusal | null = null): PassOutcome {
  return { end, run: savedRun(store, project), control: controlOf(store, project), refusal };
}
/** A control refusal is an end of the drive; any other refusal is the answer of the entry itself. */
function ended(store: Store, project: string, refusal: Refusal): OmResult<Sealed<PassOutcome>> {
  const end = CONTROL_ENDS[refusal.code];
  return end ? delivered(outcome(store, project, end, refusal)) as OmResult<Sealed<PassOutcome>> : { ok: false, refusal };
}

async function drive(store: Store, project: string, request: RunRequest, execution: RunExecution, start: Ref): Promise<OmResult<Sealed<PassOutcome>>> {
  let seen = start;
  for (;;) {
    let advanced;
    try { advanced = await advanceRun(store, request, execution.hold); }
    catch (error) {
      // A typed failure of a physical boundary (an unproved stop of a process group, an unobservable identity) is
      // returned with its own code; the drive never takes it for an end of the pass.
      if (!(error instanceof EngineError)) throw error;
      const details = object(error.details) ? error.details : {};
      return refused(error.code, error.message, { unit: UNIT, target: isText(details.target) ? details.target : project,
        field: isText(details.field) ? details.field : "drive" }, "producer") as OmResult<Sealed<PassOutcome>>;
    }
    if (!advanced.ok) return ended(store, project, advanced.refusal);
    const record = advanced.value.record as Revision<RunRecord>, phase = record.value.state.phase;
    if (phase === "complete" || phase === "unable") return delivered(outcome(store, project, phase)) as OmResult<Sealed<PassOutcome>>;
    // №1991 п.6: no performed step and the same exact pass revision — the wait stands; a just saved step changes it.
    if (advanced.value.performed === null && sameRef(reference(record), seen))
      return delivered(outcome(store, project, "waiting")) as OmResult<Sealed<PassOutcome>>;
    seen = reference(record);
  }
}
async function held(store: Store, project: string, action: (execution: RunExecution) => Promise<OmResult<Sealed<PassOutcome>>>):
  Promise<OmResult<Sealed<PassOutcome>>> {
  const execution = acquireRunExecution(store, { project });
  if (!execution.ok) return ended(store, project, execution.refusal);
  try { return await action(execution.value as RunExecution); }
  finally { releaseRunExecution(store, execution.value as RunExecution); }
}
/** LP8.1: an unable pass is weighed with its saved dispatch; without one it stands as it is. */
function reopens(store: Store, project: string): boolean {
  const dispatch = dispatchOf(store, project);
  return dispatch.ok && unableReopens(store, dispatch.value);
}
function dispatchOf(store: Store, project: string): OmResult<RunRequest> {
  const read = readDispatch(store, { project });
  return read.ok ? { ok: true, value: { project, dispatch: read.value.dispatch } } : read;
}

/**
 * Starts the pass of the project with its launch intent, or continues the pass that already has this intent. A stopped
 * project starts nothing and records no intent (№1991 п.5); a live or unobservable executor makes this call busy.
 */
export async function startPass(store: Store, request: PassStartRequest): Promise<OmResult<Sealed<PassOutcome>>> {
  requireRequest(store, request, ["project", "outcomes"]);
  // NR1 (№3646): om-fsck runs at every start and continue; damage found stops the pass for the owner, with its addresses.
  const damaged = integrityGate(store, request.project);
  if (damaged) return damaged as OmResult<Sealed<PassOutcome>>;
  const project = request.project, control = controlOf(store, project), run = savedRun(store, project);
  if (control.stopped) return delivered({ end: "stopped", run, control, refusal: null }) as OmResult<Sealed<PassOutcome>>;
  const intent = request.outcomes === undefined ? {} : { outcomes: request.outcomes };
  const phase = run?.value.state.phase;
  // LP8.1 (№3670): an unable pass whose grounds today's rules no longer prove final is driven — its first transition
  // reopens it; one whose grounds stand is read like a completed one.
  if (phase === "complete" || phase === "unable" && !reopens(store, project)) {
    // An ended pass is read, not driven: its intent is checked as any start checks it, and no execution is taken.
    const same = startRun(store, { project, ...intent });
    if (!same.ok) return ended(store, project, same.refusal);
    return delivered({ end: phase, run, control, refusal: null }) as OmResult<Sealed<PassOutcome>>;
  }
  const dispatch = dispatchOf(store, project);
  if (!dispatch.ok) return dispatch;
  return held(store, project, async execution => {
    const started = store.get(`om-input:${project}`) ? startRun(store, { project, ...intent }, execution.hold) : coldStart(store, project, intent, execution);
    if (!started.ok) return ended(store, project, started.refusal);
    return drive(store, project, dispatch.value, execution, reference(started.value));
  });
}
/**
 * A project without any OM record: the machine producer of H1.1 writes its first B1, the pass with its launch intent and
 * the bases of that intent (the point H1.1 provides for it), under the held control.
 */
function coldStart(store: Store, project: string, intent: { outcomes?: readonly string[] }, execution: RunExecution): OmResult<Revision<RunRecord>> {
  try {
    const built = writeRunBases(new RunControlGate(store, project, execution.hold).view(), { project, ...intent });
    if (!built.ok) return built;
    const run = savedRun(store, project);
    return run ? { ok: true, value: run } : refused("record_missing", "The machine bases wrote no pass", { unit: UNIT, target: `om-run:${project}`, field: "run" }, "producer");
  } catch (error) { if (error instanceof RunControlLost) return { ok: false, refusal: error.refusal }; throw error; }
}
/** Continues the existing pass with its saved intent; it never creates a pass and never lifts a stop. */
export async function continuePass(store: Store, request: PassRequest): Promise<OmResult<Sealed<PassOutcome>>> {
  requireRequest(store, request, ["project"]);
  const damaged = integrityGate(store, request.project);
  if (damaged) return damaged as OmResult<Sealed<PassOutcome>>;
  const project = request.project, control = controlOf(store, project), run = savedRun(store, project);
  if (control.stopped) return delivered({ end: "stopped", run, control, refusal: null }) as OmResult<Sealed<PassOutcome>>;
  if (!run) return refused("record_missing", "There is no pass to continue; a continue never starts one",
    { unit: UNIT, target: `om-run:${project}`, field: "run" }, "owner") as OmResult<Sealed<PassOutcome>>;
  const phase = run.value.state.phase;
  if (phase === "complete" || phase === "unable" && !reopens(store, project)) return delivered({ end: phase, run, control, refusal: null }) as OmResult<Sealed<PassOutcome>>;
  const dispatch = dispatchOf(store, project);
  if (!dispatch.ok) return dispatch;
  return held(store, project, execution => drive(store, project, dispatch.value, execution, reference(run)));
}
/**
 * Saves the stop of the pass, stops the recorded providers of calls whose owner is proved gone (run-control), and closes
 * those calls by the common recovery once it proves owner and provider gone; the result tells a requested stop from a
 * proved end of the old execution.
 */
export function stopPass(store: Store, request: PassRequest): OmResult<Sealed<RunControlStatus>> {
  requireRequest(store, request, ["project"]);
  const stopped = stopRun(store, { project: request.project });
  if (!stopped.ok) return stopped;
  recoverLost(store, request.project);
  return readRunControl(store, { project: request.project });
}
/** The common recovery of every claimed call whose owner is proved gone; an unproved end stays pending with its reason. */
function recoverLost(store: Store, project: string): Refusal | null {
  for (const call of unfinishedRunCalls(store, project)) {
    const owner = call.value["ownerProcess"] as { pid: number; started: string } | undefined;
    if (!owner || runOwnerState(owner) !== "gone") continue;
    try { recoverOmModelCall(store, project, reference(call)); }
    catch (error) {
      if (!(error instanceof EngineError)) throw error;
      const failed = refused("run_stop_unfinished", `The end of a claimed physical call is not proved: ${error.code}`,
        { unit: UNIT, target: call.id, field: "recovery", ref: reference(call) }, "owner");
      if (!failed.ok) return failed.refusal;
    }
  }
  return null;
}
/**
 * Lifts the named stop once the old execution is proved to be over. A proved-dead executor's claimed calls are first
 * finished by the common recovery (it proves the owner and the provider gone); an unobservable or live one keeps the
 * stop with its addressed reason, and nothing is presumed dead.
 */
export function resumeStoppedPass(store: Store, request: { project: string; stop: string }): OmResult<Sealed<Revision<RunControlRecord>>> {
  requireRequest(store, request, ["project", "stop"]);
  requireCondition(isText(request.stop), "run_control_request_invalid", "A resume names the exact stop it lifts");
  const project = request.project, control = controlOf(store, project);
  const executor = control.control?.value.execution;
  if (control.stopped && control.control?.value.stop?.token === request.stop && (!executor || runOwnerState(executor.owner) === "gone")) {
    // A call of a live owner is its own; the common recovery refuses it, and the stop stays unfinished with that reason.
    for (const call of unfinishedRunCalls(store, project)) {
      const owner = call.value["ownerProcess"] as { pid: number; started: string } | undefined;
      if (owner && runOwnerState(owner) === "gone") continue;
      try { recoverOmModelCall(store, project, reference(call)); }
      catch (error) {
        if (!(error instanceof EngineError)) throw error;
        return refused("run_stop_unfinished", `The end of a claimed physical call is not proved: ${error.code}`,
          { unit: UNIT, target: call.id, field: "recovery", ref: reference(call) }, "owner") as OmResult<Sealed<Revision<RunControlRecord>>>;
      }
    }
    const lost = recoverLost(store, project);
    if (lost) return { ok: false, refusal: lost };
  }
  return resumeStoppedRun(store, { project, stop: request.stop });
}
/** The state of the pass and its control; reading takes no execution and writes nothing. */
export function readPass(store: Store, request: PassRequest): OmResult<Sealed<{ run: Revision<RunRecord> | null; control: RunControlStatus }>> {
  requireRequest(store, request, ["project"]);
  try { return delivered({ run: savedRun(store, request.project), control: controlOf(store, request.project) }) as OmResult<Sealed<{ run: Revision<RunRecord> | null; control: RunControlStatus }>>; }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return refused(error.code, error.message, { unit: UNIT, target: request.project, field: "read" }, "producer") as OmResult<Sealed<{ run: Revision<RunRecord> | null; control: RunControlStatus }>>;
  }
}
