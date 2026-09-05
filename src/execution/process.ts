import { fileURLToPath } from "node:url";
import type { Command } from "../graph/model.js";
import { executablePath } from "../runtime/environment.js";
import { runProcess } from "../runtime/process.js";
import { processStart } from "./lock.js";
import { requireCondition } from "../errors.js";

export type ProcessObserver = (child: { pid: number; started: string } | null) => void;
export async function executeProcess(command: Command, root: string, input: string, timeout: number, observer: ProcessObserver, signal?: AbortSignal) {
  requireCondition(process.platform !== "win32", "platform_unsupported", "Managed execution currently requires POSIX process groups");
  try {
    return await runProcess({ executable: process.execPath, args: [fileURLToPath(new URL("./supervisor.js", import.meta.url))] }, root,
      JSON.stringify({ parent: process.pid, executable: executablePath(command, root), args: command.args, input }), timeout, signal, true,
      pid => { const started = processStart(pid); requireCondition(started, "process_identity_unavailable", "Cannot identify the execution child"); observer({ pid, started }); });
  } finally { observer(null); }
}
export async function stopOrphan(child: { pid: number; started: string } | null): Promise<void> {
  if (!child || processStart(child.pid) !== child.started) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (processStart(child.pid) !== child.started) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  requireCondition(false, "executor_still_running", "The previous process has not stopped; recovery is deferred");
}
