import { spawn, spawnSync } from "node:child_process";
import { EngineError } from "../errors.js";
import type { Command } from "../graph/model.js";
import { executablePath } from "./environment.js";
import {
  classifyStopErrno, killGroup, probeProcessIdentity, processStopRefusal,
  type ProcessStopHooks, type ProcessStopReport
} from "./process-identity.js";
import { StringDecoder } from "node:string_decoder";

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
    const outDecoder = new StringDecoder("utf8"), errDecoder = new StringDecoder("utf8");
    const finish = (error: EngineError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      reject(error);
    };
    // One stop attempt per run: a late timer/abort/close callback must not
    // send a second signal or rewrite the original failure.
    const terminate = (stage: "stop" | "group-sweep") => {
      if (stop) return stop;
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
      if (stage === "group-sweep" && (ownGroup || process.platform === "win32"))
        // The sweep's subject is the group, not the leader: an absent leader
        // cannot prove that the group lost its surviving members.
        return stop = { ...base, outcome: errno === "ESRCH" ? "absent" : errno === "EPERM" || errno === "EACCES" ? "denied" : "failed", observedStarted: null, errno };
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
          { exitCode: null, signal: null, stdout, stderr, complete: false }));
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
    child.once("close", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      stdout += outDecoder.end(); stderr += errDecoder.end();
      if (failure) reject(failure);
      else if (stop && ["denied", "failed", "unconfirmed", "identity-unavailable"].includes(stop.outcome))
        // The leader's exit does not prove the group is gone; the actual
        // physical result travels inside the refusal, not as a success.
        reject(processStopRefusal(stop, "The process exited but its owned-group cleanup is refused or unproven",
          null, { exitCode, signal: exitSignal, stdout, stderr, complete: true }));
      else resolve({ exitCode, signal: exitSignal, stdout, stderr });
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
