import { fileURLToPath } from "node:url";
import type { Command } from "../graph/model.js";
import { executablePath } from "../runtime/environment.js";
import { runProcess, stopOwnedGroup, probeProcessIdentity, processStopRefusal, type ProcessStopHooks } from "../runtime/process.js";
import { processStart } from "./lock.js";
import { EngineError, requireCondition } from "../errors.js";

export type ProcessObserver = (child: { pid: number; started: string } | null) => void;
export async function executeProcess(command: Command, root: string, input: string, timeout: number, observer: ProcessObserver, signal?: AbortSignal, stopHooks?: ProcessStopHooks) {
  requireCondition(process.platform !== "win32", "platform_unsupported", "Managed execution currently requires POSIX process groups");
  let stopRefused = false;
  try {
    return await runProcess({ executable: process.execPath, args: [fileURLToPath(new URL("./supervisor.js", import.meta.url))] }, root,
      JSON.stringify({ parent: process.pid, executable: executablePath(command, root), args: command.args, input }), timeout, signal, true,
      pid => { const started = processStart(pid); requireCondition(started, "process_identity_unavailable", "Cannot identify the execution child"); observer({ pid, started }); },
      stopHooks);
  } catch (error) {
    // A refused stop keeps the last committed identity for a later stopOrphan;
    // the success-path cleanup must not erase it.
    stopRefused = error instanceof EngineError && error.code.startsWith("process_stop_");
    throw error;
  } finally { if (!stopRefused) observer(null); }
}
export async function stopOrphan(child: { pid: number; started: string } | null, stopHooks?: ProcessStopHooks): Promise<void> {
  if (!child) return;
  let report = stopOwnedGroup(child, stopHooks);
  const identify = stopHooks?.identify ?? probeProcessIdentity;
  // 'stop-requested' means the group signal was accepted but exit is unproven;
  // only the recorded identity is polled, never a bare pid or another group.
  for (let attempt = 0; report.outcome === "stop-requested" && attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    const post = identify(child.pid);
    if (post.state !== "present" || post.started !== child.started)
      report = { ...report, stage: "post-check", errno: post.state === "unavailable" ? post.errno : report.errno,
        observedStarted: post.state === "present" ? post.started : report.observedStarted,
        outcome: post.state === "absent" ? "stopped" : post.state === "unavailable" ? "unconfirmed" : "identity-changed" };
  }
  if (["absent", "stopped", "identity-changed"].includes(report.outcome)) return;
  if (report.outcome === "stop-requested")
    throw new EngineError("executor_still_running", "The previous process has not stopped; recovery is deferred", report);
  throw processStopRefusal(report, "The recorded executor process could not be provably stopped");
}
