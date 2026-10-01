import { spawn, spawnSync } from "node:child_process";
import { EngineError } from "../errors.js";
import type { Command } from "../graph/model.js";
import { executablePath } from "./environment.js";
import {
  classifyStopErrno, killGroup, probeGroupAbsence, probeProcessIdentity, processStopRefusal,
  type ProcessStopHooks, type ProcessStopReport
} from "./process-identity.js";
import { StringDecoder } from "node:string_decoder";
import { performance } from "node:perf_hooks";

// D8.5.1 (№2433): a transient EPERM/EACCES of the group sweep — a member of the group caught in its
// exit/reparent window answers EPERM for a few milliseconds — is not a denial until the same PGID is
// re-probed with signal 0: only ESRCH proves the addressed group is gone (row 14 of №1500).
const GROUP_PROBE_BUDGET = 6, GROUP_PROBE_INTERVAL_MS = 20, GROUP_PROBE_DEADLINE_MS = 100;

/** Re-probe the group after a refused sweep: first probe at once, the rest about 20 ms apart, never
 * past the common 100 ms deadline, never a second signal. Returns 'ESRCH' (absence proven), null
 * (the group still answers), or the probe's own errno — an observation error is never an absence. */
async function probeGroupUntilAbsent(pid: number, probe: (pid: number) => string | null | void): Promise<string | null> {
  const startedAt = performance.now();
  let last: string | null = null;
  for (let attempt = 0; attempt < GROUP_PROBE_BUDGET; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, GROUP_PROBE_INTERVAL_MS));
    if (performance.now() - startedAt >= GROUP_PROBE_DEADLINE_MS) break;
    try { last = probe(pid) ?? null; } catch (error) { return (error as NodeJS.ErrnoException)?.code ?? "unknown"; }
    if (last === "ESRCH") return last;
  }
  return last;
}

// The strict identity observation and the stop classifier live in
// process-identity.ts so lightweight consumers (supervisor) avoid this
// module's environment → store chain; they are re-exported for the runners.
export {
  probeProcessIdentity, stopOwnedGroup, classifyStopErrno, processStopRefusal
} from "./process-identity.js";
export type {
  ProcessIdentityProbe, ProcessStopHooks, ProcessStopOutcome, ProcessStopReport
} from "./process-identity.js";

export interface ProcessResult {
  exitCode: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null;
}

export function runProcess(command: Command, cwd: string, input: string, timeoutMs: number, signal?: AbortSignal, detached = true,
  onSpawn?: (pid: number) => void | Promise<void>, stopHooks?: ProcessStopHooks): Promise<ProcessResult> {
  if (signal?.aborted) return Promise.reject(new EngineError("process_cancelled", "Execution was cancelled before launch"));
  const executable = executablePath(command, cwd);
  const env = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  return new Promise((resolve, reject) => {
    const ownGroup = detached && process.platform !== "win32";
    const child = spawn(executable, command.args, { cwd, env, shell: false, detached: ownGroup, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0, settled = false; let failure: EngineError | null = null;
    let stop: ProcessStopReport | null = null;
    // A pending signal-0 re-probe of the refused group sweep (D8.5.1). Set synchronously before the
    // first async pause, so close/timeout/abort never send a second signal nor settle early.
    let sweepProbe: Promise<void> | null = null;
    // The physical bytes are completed by the close event itself, never by the sweep probe's end:
    // a stop refusal after close must carry the already-complete result (№2475).
    let closedPhysical: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; complete: boolean } | null = null;
    const outDecoder = new StringDecoder("utf8"), errDecoder = new StringDecoder("utf8");
    const finish = (error: EngineError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      reject(error);
    };
    // One stop attempt per run: a late timer/abort/close callback must not
    // send a second signal or rewrite the original failure.
    const terminate = (stage: "stop" | "group-sweep"): ProcessStopReport | null => {
      if (stop || sweepProbe) return stop;
      const pid = child.pid ?? null;
      const base = { stage, target: ownGroup || process.platform === "win32" ? "group" as const : "child" as const, pid, expectedStarted: null };
      if (pid === null) return stop = { ...base, outcome: "not-started", observedStarted: null, errno: null };
      // child.kill returns a boolean, not an errno: false is not ESRCH and is
      // not proof of anything — it is reported as signalReturned:false.
      let errno: string | null = null, signalReturned: boolean | null = null;
      try {
        if (!stopHooks?.signal && process.platform !== "win32" && !ownGroup) signalReturned = child.kill("SIGKILL");
        else errno = (stopHooks?.signal ?? ((target: number): string | null => {
          if (process.platform === "win32") {
            const killed = spawnSync("taskkill", ["/PID", String(target), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
            return killed.error ? (killed.error as NodeJS.ErrnoException).code ?? "unknown" : killed.status === 0 ? null : `taskkill_status_${killed.status ?? "null"}`;
          }
          return killGroup(target);
        }))(pid) ?? null;
      } catch (error) { errno = (error as NodeJS.ErrnoException)?.code ?? "unknown"; }
      if (errno === null && signalReturned !== false)
        return stop = { ...base, outcome: "stop-requested", observedStarted: null, errno: null };
      if (stage === "group-sweep" && (ownGroup || process.platform === "win32")) {
        // D8.5.1: a POSIX own-group EPERM/EACCES is not a denial yet — the leader's exit does not
        // prove the group, and a member in its exit/reparent window answers EPERM transiently.
        // Prove absence by the same verified PGID (never 0/−1); the original errno is preserved
        // and the probe's result travels separately in groupProbe.
        if (ownGroup && process.platform !== "win32" && (errno === "EPERM" || errno === "EACCES") && pid > 0) {
          const report: ProcessStopReport = { ...base, outcome: "denied", observedStarted: null, errno };
          const probe = stopHooks?.probeGroup ?? probeGroupAbsence;
          sweepProbe = probeGroupUntilAbsent(pid, probe).then(result => {
            stop = result === "ESRCH" ? { ...report, outcome: "absent", groupProbe: "ESRCH" }
              : { ...report, groupProbe: result };
            if (failure) refuse(failure);
          });
          return null;
        }
        // The sweep's subject is the group, not the leader: an absent leader
        // cannot prove that the group lost its surviving members.
        return stop = { ...base, outcome: errno === "ESRCH" ? "absent" : errno === "EPERM" || errno === "EACCES" ? "denied" : "failed", observedStarted: null, errno };
      }
      const post = (stopHooks?.identify ?? probeProcessIdentity)(pid);
      if (signalReturned === false)
        return stop = { ...base, outcome: post.state === "absent" ? "absent" : "unconfirmed",
          observedStarted: post.state === "present" ? post.started : null, errno: null, signalReturned: false };
      return stop = { ...base, outcome: classifyStopErrno(errno, post, null), observedStarted: post.state === "present" ? post.started : null, errno };
    };
    const refuse = (origin: EngineError) => {
      if (stop && ["denied", "failed", "unconfirmed", "identity-unavailable"].includes(stop.outcome))
        finish(processStopRefusal(stop, "The stop signal was refused or its result is unproven; the original reason is preserved in details",
          { code: origin.code, message: origin.message },
          closedPhysical ?? { exitCode: null, signal: null, stdout, stderr, complete: false }));
    };
    const abort = () => { failure ??= new EngineError("process_cancelled", "Execution was cancelled"); terminate("stop"); refuse(failure); };
    const timer = setTimeout(() => { failure ??= new EngineError("process_timeout", "Execution exceeded its configured timeout"); terminate("stop"); refuse(failure); }, timeoutMs);
    const collect = (buffer: Buffer, stream: "stdout" | "stderr") => {
      size += buffer.length;
      if (size > 4_000_000) { failure ??= new EngineError("process_output_limit", "Execution output exceeded the size limit"); terminate("stop"); refuse(failure); return; }
      if (stream === "stdout") stdout += outDecoder.write(buffer); else stderr += errDecoder.write(buffer);
    };
    child.stdout.on("data", buffer => collect(buffer, "stdout")); child.stderr.on("data", buffer => collect(buffer, "stderr"));
    child.stdin.on("error", () => { /* a process may intentionally not read stdin */ });
    child.once("error", error => { failure ??= new EngineError("process_failed", "Could not start the selected process", error.message); });
    child.once("exit", () => terminate("group-sweep"));
    const settleClose = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      const closed = closedPhysical!;
      if (failure) reject(failure);
      else if (stop && ["denied", "failed", "unconfirmed", "identity-unavailable"].includes(stop.outcome))
        // The leader's exit does not prove the group is gone; the actual
        // physical result travels inside the refusal, not as a success.
        reject(processStopRefusal(stop, "The process exited but its owned-group cleanup is refused or unproven",
          null, closed));
      else resolve({ exitCode: closed.exitCode, signal: closed.signal, stdout: closed.stdout, stderr: closed.stderr });
    };
    child.once("close", (exitCode, exitSignal) => {
      // Complete the physical capture at close itself, even while a sweep probe is still running.
      stdout += outDecoder.end(); stderr += errDecoder.end();
      closedPhysical = { exitCode, signal: exitSignal, stdout, stderr, complete: true };
      if (settled) return;
      // A sweep still being re-probed settles nothing yet; the probe's end runs the same close logic.
      if (stop === null && sweepProbe) { void sweepProbe.then(() => settleClose()); return; }
      settleClose();
    });
    signal?.addEventListener("abort", abort, { once: true });
    // The supplier may be running, but has not received the request yet. The
    // durable authorization callback must succeed before crossing that boundary.
    void (async () => {
      try {
        if (signal?.aborted) { abort(); return; }
        if (!child.pid) return;
        await onSpawn?.(child.pid);
        if (failure || signal?.aborted || settled) return;
        child.stdin.end(input);
      } catch (error) {
        failure ??= error instanceof EngineError ? error : new EngineError("process_record_failed", "Process ownership could not be recorded"); terminate("stop"); refuse(failure);
      }
    })();
  });
}
