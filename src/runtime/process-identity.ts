import { spawnSync } from "node:child_process";
import { EngineError, requireCondition } from "../errors.js";
import { canonical } from "../canonical.js";
import { isRef, type Ref } from "../pipeline/contracts.js";
import type { Revision } from "../storage/store.js";
import { provenStore } from "../storage/store-view.js";

export function processStart(pid: number): string {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5000 });
  requireCondition(!result.error, "process_identity_unavailable", "Cannot determine process identity for safe recovery");
  return result.status === 0 ? result.stdout.trim() : "";
}

/** Three-valued identity observation: an empty `ps` row is not proof of
 * absence — it also follows a nonzero ps status or an observation failure.
 * Only a clean status-1 with empty stdout/stderr counts as proven absence. */
export type ProcessIdentityProbe =
  | { readonly state: "present"; readonly started: string }
  | { readonly state: "absent" }
  | { readonly state: "unavailable"; readonly errno: string };

export function probeProcessIdentity(pid: number): ProcessIdentityProbe {
  const observed = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5000 });
  if (observed.error) return { state: "unavailable", errno: (observed.error as NodeJS.ErrnoException).code ?? "ps_unavailable" };
  if (observed.status === 0) {
    const started = observed.stdout.trim();
    return started ? { state: "present", started } : { state: "unavailable", errno: "empty_identity" };
  }
  if (observed.status === 1 && observed.stdout.trim() === "" && observed.stderr.trim() === "") return { state: "absent" };
  return { state: "unavailable", errno: `ps_status_${observed.status ?? "null"}` };
}

export type ProcessStopOutcome = "not-started" | "absent" | "identity-changed" | "stop-requested"
  | "stopped" | "denied" | "identity-unavailable" | "unconfirmed" | "failed";

/** Diagnostics carried in EngineError.details: stage, target, pid, expected
 * and observed identity, original errno. Never stdin, secrets or command context. */
export interface ProcessStopReport {
  outcome: ProcessStopOutcome;
  stage: "validate" | "pre-check" | "signal" | "post-check" | "stop" | "group-sweep" | "identity-probe";
  target: "group" | "child" | "owner";
  pid: number | null;
  expectedStarted: string | null;
  observedStarted: string | null;
  errno: string | null;
  /** Present only when the refused sweep was re-probed (D8.5.1): the deciding probe's errno
   * ('ESRCH' proved the absence), null when the group still answered, or the probe's own error.
   * The sweep's original EPERM/EACCES stays in `errno` — the probe result never replaces it. */
  groupProbe?: string | null;
  /** PROC1 diagnostics of the executed re-probe: how many signal-0 probes were actually sent and
   * the elapsed wall-clock milliseconds. Present only when the refused sweep was re-probed;
   * reports written without a re-probe simply lack them. */
  attempts?: number;
  elapsedMs?: number;
  /** Present only when the sender was child.kill and it returned false. */
  signalReturned?: boolean;
}

/** Signal senders throw {code} or return an errno string; null/undefined means
 * the syscall was accepted (not that the process is gone). */
export interface ProcessStopHooks {
  identify?: (pid: number) => ProcessIdentityProbe;
  signal?: (pid: number) => string | null | void;
  /** The signal-0 probe of the same process group after a refused sweep (D8.5.1): no value means the
   * group still exists (absence not proven), 'ESRCH' proves its absence, any other errno is an
   * observation error and never an absence. */
  probeGroup?: (pid: number) => string | null | void;
}

/** Classifies one signal attempt by its errno and an independent post-check.
 * A syscall error alone never proves state: ESRCH needs the identity verdict,
 * EPERM/EACCES is denied unless absence is proven independently. */
export function classifyStopErrno(errno: string | null, post: ProcessIdentityProbe, expectedStarted: string | null): ProcessStopOutcome {
  if (post.state === "present" && expectedStarted !== null && post.started !== expectedStarted) return "identity-changed";
  if (errno === null) return post.state === "absent" ? "stopped" : post.state === "unavailable" ? "unconfirmed" : "stop-requested";
  if (errno === "ESRCH" || errno === "signal_not_delivered") return post.state === "absent" ? "absent" : "unconfirmed";
  if (errno === "EPERM" || errno === "EACCES") return post.state === "absent" ? "absent" : "denied";
  return "failed";
}

/** The physical bytes captured at a refused or unproven stop. They are
 * carried next to the refusal for the internal subject recovery path only —
 * EngineError.details is serialized into public diagnostics, so this carrier
 * is a separate non-enumerable property. The ProcessResult shape is kept. */
export interface ProcessStopPhysical {
  exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;
  /** True only when the process closed and both streams were fully captured. */
  complete: boolean;
}

/** Maps a refusing outcome to its typed error. Lawful outcomes have no error.
 * The separately captured physical result, when it exists, travels on the
 * private carrier — it is never merged into a successful result and never
 * published inside details. */
export function processStopRefusal(report: ProcessStopReport, message: string, cause: { code: string; message: string } | null = null,
  result: ProcessStopPhysical | null = null): EngineError {
  const code = report.outcome === "denied" ? "process_stop_denied"
    : report.outcome === "failed" ? "process_stop_failed"
    : report.outcome === "identity-unavailable" ? "process_identity_unavailable"
    : "process_stop_unconfirmed";
  const error = new EngineError(code, message, { ...report, cause });
  if (result) Object.defineProperty(error, "physical", { value: { ...result }, enumerable: false });
  return error;
}

/** Reads the private physical carrier of a stop refusal. Anything that does
 * not satisfy the exact physical shape returns null rather than a guess. */
export function processStopPhysical(error: unknown): ProcessStopPhysical | null {
  const physical = error instanceof EngineError ? (error as unknown as { physical?: unknown }).physical : null;
  if (!physical || typeof physical !== "object" || Array.isArray(physical)) return null;
  const fields = physical as Record<string, unknown>;
  if (typeof fields['stdout'] !== "string" || typeof fields['stderr'] !== "string" || typeof fields['complete'] !== "boolean"
    || !(fields['exitCode'] === null || (Number.isSafeInteger(fields['exitCode']) && (fields['exitCode'] as number) >= 0))
    || !(fields['signal'] === null || typeof fields['signal'] === "string")) return null;
  return physical as ProcessStopPhysical;
}

/** True when an error refuses or leaves unproven a process stop: the four
 * process_stop_* codes, plus process_identity_unavailable produced BY a stop
 * attempt (it carries the classified outcome). A bare identity failure after a
 * proven cleanup is an ordinary subject error, not a held operation. */
export function isProcessStopRefusal(error: unknown): boolean {
  if (!(error instanceof EngineError)) return false;
  if (["process_stop_denied", "process_stop_unconfirmed", "process_stop_failed"].includes(error.code)) return true;
  const details = error.details as Record<string, unknown> | null;
  return error.code === "process_identity_unavailable" && !!details && typeof details === "object" && "outcome" in details;
}

/** The process-stop/v1 witness: a record addressed by the exact subject
 * revision — the attempt — holding what is known about the unproven stop:
 * identities, the actually spawned pid when its started was never proven,
 * classified outcome, errno, original cause and the private physical data
 * with its completeness flag. It observes and retains the operation; it does
 * not prove any stop. */
export interface ProcessStopWitness {
  protocol: "process-stop/v1"; subject: Ref;
  owner: { pid: number; started: string } | null; child: { pid: number; started: string } | null;
  pid: number | null; outcome: string | null; stage: string | null; target: string | null;
  errno: string | null; cause: { code: string; message: string } | null; physical: ProcessStopPhysical | null;
  /** Durable end proof of THIS launch, appended by the evaluating reader as a
   * new revision of the same record once absence or an identity change is
   * proven. A later foreign process occupying the same pid never revives it. */
  end?: { proof: "absent" | "identity-changed"; observedStarted: string | null } | null;
}

/** Writes the witness of THIS attempt at its own address. A revision conflict
 * is not an idempotent repeat by itself: the existing record must name the
 * same exact subject revision; identical content is a no-op, a newer
 * observation of the same attempt advances the witness by CAS, and a foreign
 * subject is refused. */
export function writeProcessStopWitness(
  store: {
    get(id: string): { kind: string; revision: number; value: unknown } | null;
    write(input: { id: string; kind: string; expected: number; value: unknown }): unknown;
  },
  subject: Ref,
  identities: { owner?: { pid: number; started: string } | null; child?: { pid: number; started: string } | null; pid?: number | null },
  error: unknown): void {
  const details = error instanceof EngineError ? (error.details ?? null) as Record<string, unknown> | null : null;
  const pid = identities.pid ?? (typeof details?.["pid"] === "number" ? details["pid"] as number : null) ?? identities.child?.pid ?? null;
  const value: ProcessStopWitness = {
    protocol: "process-stop/v1", subject,
    owner: identities.owner ?? null, child: identities.child ?? null, pid,
    outcome: typeof details?.["outcome"] === "string" ? details["outcome"] as string : null,
    stage: typeof details?.["stage"] === "string" ? details["stage"] as string : null,
    target: typeof details?.["target"] === "string" ? details["target"] as string : null,
    errno: typeof details?.["errno"] === "string" ? details["errno"] as string : null,
    cause: details?.["cause"] && typeof details["cause"] === "object" ? details["cause"] as { code: string; message: string }
      : { code: error instanceof EngineError ? error.code : "process_record_failed",
          message: error instanceof Error ? error.message : "The process stop was not proven" },
    physical: processStopPhysical(error)
  };
  const id = `process-stop:${subject.id}:${subject.revision}`;
  try { store.write({ id, kind: "process-stop", expected: 0, value }); return; }
  catch (conflict) {
    if (!(conflict instanceof EngineError && conflict.code === "revision_conflict")) throw conflict;
  }
  const existing = store.get(id);
  const existingValue = existing?.value as Partial<ProcessStopWitness> | null;
  requireCondition(existing?.kind === "process-stop" && existingValue?.protocol === "process-stop/v1"
    && isRef(existingValue.subject) && canonical(existingValue.subject) === canonical(subject),
  "process_stop_witness_foreign", "A process-stop witness belongs to its exact attempt; matching subject.id alone is not an exact repeat");
  // A proven end is sticky: a refusal rewrite of the same attempt keeps it.
  if (existingValue?.end) value.end = existingValue.end;
  // So is captured physical evidence: a diagnostic without new bytes keeps the
  // earlier capture; a partial result never supersedes a complete one; two
  // different complete results for the same attempt are a typed conflict —
  // never resolved by write order.
  const prior = existingValue?.physical ?? null;
  if (prior !== null) {
    const next = value.physical;
    if (next === null || (prior.complete && !next.complete)) value.physical = prior;
    else if (prior.complete && next.complete && canonical(prior) !== canonical(next))
      throw new EngineError("process_stop_witness_invalid",
        "A process-stop witness already holds a different complete physical result; conflicting evidence is not resolved by write order",
        { witness: id });
  }
  if (canonical(existing.value) === canonical(value)) return;
  store.write({ id, kind: "process-stop", expected: existing.revision, value });
}

/** All process-stop records under a subject's witness namespace — the
 * listing never judges form; a malformed record must surface to the
 * evaluating reader instead of silently counting as absence. */
export function processStopWitnesses(
  store: { list<T>(kind?: string): Revision<T>[] }, subjectId: string): Revision<unknown>[] {
  requireCondition(typeof subjectId === "string" && subjectId.length > 0,
    "process_stop_witness_invalid", "A witness listing needs the exact subject record");
  // PF3 (№3424 §3): a proven genuine Store enumerates the literal prefix of head identities and reads exactly those
  // versions, without decoding foreign bodies; any other source keeps its own list, errors included.
  const prefix = `process-stop:${subjectId}:`, genuine = provenStore(store);
  if (!genuine) return store.list().filter(record => record.id.startsWith(prefix));
  return genuine.identities('prefix', prefix).map(row => {
    const record = genuine.get(row.id, row.revision);
    requireCondition(record !== null, "record_corrupt", "A selected witness revision disappeared before it was read");
    return record;
  });
}

const isWitnessIdentity = (value: unknown): value is { pid: number; started: string } =>
  !!value && typeof value === "object" && !Array.isArray(value)
  && Number.isSafeInteger((value as { pid: number }).pid) && (value as { pid: number }).pid > 0
  && typeof (value as { started: string }).started === "string" && (value as { started: string }).started.length > 0;

const isProcessStopPhysicalShape = (value: unknown): value is ProcessStopPhysical =>
  !!value && typeof value === "object" && !Array.isArray(value)
  && typeof (value as ProcessStopPhysical).stdout === "string" && typeof (value as ProcessStopPhysical).stderr === "string"
  && typeof (value as ProcessStopPhysical).complete === "boolean"
  && ((value as ProcessStopPhysical).exitCode === null || (Number.isSafeInteger((value as ProcessStopPhysical).exitCode) && (value as ProcessStopPhysical).exitCode! >= 0))
  && ((value as ProcessStopPhysical).signal === null || typeof (value as ProcessStopPhysical).signal === "string");

/** The exact witness form: anything a writer can produce plus the durable
 * end marker. A record at a witness address that fails this shape is a
 * corrupted witness, never an absent one. */
export function isProcessStopWitness(value: unknown): value is ProcessStopWitness {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const w = value as Record<string, unknown>;
  const nullableString = (field: unknown) => field === null || typeof field === "string";
  return w["protocol"] === "process-stop/v1" && isRef(w["subject"])
    && (w["pid"] === null || (Number.isSafeInteger(w["pid"]) && (w["pid"] as number) > 0))
    && (w["owner"] === null || isWitnessIdentity(w["owner"])) && (w["child"] === null || isWitnessIdentity(w["child"]))
    && (w["child"] === null || (w["child"] as { pid: number }).pid === w["pid"])
    && nullableString(w["outcome"]) && nullableString(w["stage"]) && nullableString(w["target"]) && nullableString(w["errno"])
    && (w["cause"] === null || (!!w["cause"] && typeof w["cause"] === "object" && !Array.isArray(w["cause"])
      && typeof (w["cause"] as { code: string }).code === "string" && typeof (w["cause"] as { message: string }).message === "string"))
    && (w["physical"] === null || isProcessStopPhysicalShape(w["physical"]))
    && (w["end"] === undefined || w["end"] === null || (!!w["end"] && typeof w["end"] === "object" && !Array.isArray(w["end"])
      && ["absent", "identity-changed"].includes((w["end"] as { proof: string }).proof)
      && nullableString((w["end"] as { observedStarted: string | null }).observedStarted)));
}

/** Per-witness evaluation of the shared outcome table (D8.5 round 3):
 *  ended        — row 4 (resolved end is durable) or row 8 (proven absent /
 *                 identity-changed), or no spawned pid was ever recorded;
 *  alive        — row 5, the recorded identity still occupies the pid;
 *  unverifiable — row 6, the pid is busy but no started was captured, so the
 *                 occupant cannot be proven ours or foreign — never ended;
 *  unavailable  — row 7, the identity probe itself could not answer.
 * Rows 2 (invalid form) and 3 (foreign subject) are thrown as typed refusals,
 * never returned as "ended". */
export type ProcessStopWitnessVerdict = {
  record: Revision<unknown>; witness: ProcessStopWitness;
  state: "ended" | "alive" | "unverifiable" | "unavailable";
  resolution: "resolved" | "absent" | "identity-changed" | "no-pid" | null;
  observedStarted: string | null; errno: string | null;
};

export function evaluateProcessStopWitnesses(
  store: {
    list<T>(kind?: string): Revision<T>[];
    get<T>(id: string, revision?: number): Revision<T> | null;
    write<T>(input: { id: string; kind: string; expected: number; value: unknown }): Revision<T>;
  },
  subjectId: string,
  identify: (pid: number) => ProcessIdentityProbe = probeProcessIdentity): ProcessStopWitnessVerdict[] {
  const invalid = (record: Revision<unknown>, reason: string): never => {
    throw new EngineError("process_stop_witness_invalid",
      "A process-stop witness record is present but malformed; it cannot stand in for a missing witness",
      { witness: record.id, reason });
  };
  const foreign = (record: Revision<unknown>, reason: string): never => {
    throw new EngineError("process_stop_witness_foreign",
      "A process-stop witness does not prove the exact subject revision it claims; it cannot release or pay this attempt",
      { witness: record.id, reason });
  };
  const candidates = processStopWitnesses(store, subjectId)
    .map(record => ({ record, suffix: record.id.slice(`process-stop:${subjectId}:`.length) }))
    // A deeper namespaced subject (suffix containing ':') owns its own records.
    .filter(({ suffix }) => !suffix.includes(":"))
    .sort((a, b) => a.record.id.localeCompare(b.record.id));
  const verdicts: ProcessStopWitnessVerdict[] = [];
  for (const { record, suffix } of candidates) {
    if (!/^\d+$/.test(suffix)) invalid(record, "witness address does not name an attempt revision");
    const value = record.value;
    if (record.kind !== "process-stop" || !isProcessStopWitness(value))
      invalid(record, record.kind !== "process-stop" ? "record kind is not process-stop" : "witness form is malformed");
    const witness = value as ProcessStopWitness;
    if (record.id !== `process-stop:${witness.subject.id}:${witness.subject.revision}` || witness.subject.id !== subjectId)
      foreign(record, "stored subject does not match the witness address");
    const original = store.get(witness.subject.id, witness.subject.revision);
    if (!original || original.hash !== witness.subject.hash)
      foreign(record, "stored subject hash does not name an actual subject revision");
    if (witness.end) {
      verdicts.push({ record, witness, state: "ended", resolution: "resolved", observedStarted: witness.end.observedStarted, errno: null });
      continue;
    }
    const pid = witness.pid;
    if (pid === null) { verdicts.push({ record, witness, state: "ended", resolution: "no-pid", observedStarted: null, errno: null }); continue; }
    const probe = identify(pid);
    if (probe.state === "unavailable") {
      verdicts.push({ record, witness, state: "unavailable", resolution: null, observedStarted: null, errno: probe.errno });
      continue;
    }
    if (probe.state === "present") {
      const child = witness.child;
      if (child && child.pid === pid) {
        if (probe.started === child.started) {
          verdicts.push({ record, witness, state: "alive", resolution: null, observedStarted: probe.started, errno: null });
          continue;
        }
        // A different start time at the same pid is a foreign reuse — the
        // recorded launch has ended; the resolution is persisted so the new
        // occupant can never block a later attempt again.
      } else {
        verdicts.push({ record, witness, state: "unverifiable", resolution: null, observedStarted: probe.started, errno: null });
        continue;
      }
    }
    // absent, or a proven identity change: persist the resolution of THIS
    // launch as a new revision of the same witness record.
    const end = { proof: (probe.state === "absent" ? "absent" : "identity-changed") as "absent" | "identity-changed",
      observedStarted: probe.state === "present" ? probe.started : null };
    store.write({ id: record.id, kind: "process-stop", expected: record.revision, value: { ...witness, end } });
    verdicts.push({ record, witness, state: "ended", resolution: end.proof, observedStarted: end.observedStarted, errno: null });
  }
  return verdicts;
}

/** One SIGKILL to the recorded process group. Returns the errno or null when
 * the syscall was accepted — acceptance is not proof the group is gone. */
export function killGroup(pid: number): string | null {
  try { process.kill(-pid, "SIGKILL"); return null; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code ?? "unknown"; }
}

/** One signal-0 probe of the same process group: signal 0 sends nothing, so an accepted probe
 * only says the group still exists (absence NOT proven); 'ESRCH' proves the addressed group is
 * absent; any other errno is an observation error and never an absence (D8.5.1, row 14 of №1500). */
export function probeGroupAbsence(pid: number): string | null {
  try { process.kill(-pid, 0); return null; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code ?? "unknown"; }
}

/** Stops the recorded owned process group: identity pre-check, one signal to
 * the group, one identity post-check. Never signals a changed or unverifiable
 * identity and never retargets the signal to another PID or group. */
export function stopOwnedGroup(target: { pid: number; started: string }, hooks: ProcessStopHooks = {}): ProcessStopReport {
  const identify = hooks.identify ?? probeProcessIdentity;
  const signal = hooks.signal ?? killGroup;
  const done = (outcome: ProcessStopOutcome, stage: ProcessStopReport["stage"], errno: string | null = null, observedStarted: string | null = null): ProcessStopReport =>
    ({ outcome, stage, target: "group", pid: target.pid, expectedStarted: target.started, observedStarted, errno });
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || typeof target.started !== "string" || target.started.length === 0)
    return done("identity-unavailable", "validate", "invalid_identity");
  const pre = identify(target.pid);
  if (pre.state === "unavailable") return done("identity-unavailable", "pre-check", pre.errno);
  if (pre.state === "absent") return done("absent", "pre-check");
  if (pre.started !== target.started) return done("identity-changed", "pre-check", null, pre.started);
  let errno: string | null;
  try { errno = signal(target.pid) ?? null; } catch (error) { errno = (error as NodeJS.ErrnoException)?.code ?? "unknown"; }
  const post = identify(target.pid);
  return done(classifyStopErrno(errno, post, target.started), errno === null ? "post-check" : "signal", errno,
    post.state === "present" ? post.started : null);
}
