import { spawn, spawnSync } from "node:child_process";
import { EngineError } from "../errors.js";
import type { Command } from "../graph/model.js";
import { executablePath } from "./environment.js";
import { StringDecoder } from "node:string_decoder";

export interface ProcessResult { exitCode: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null }
export function runProcess(command: Command, cwd: string, input: string, timeoutMs: number, signal?: AbortSignal, detached = true,
  onSpawn?: (pid: number) => void): Promise<ProcessResult> {
  if (signal?.aborted) return Promise.reject(new EngineError("process_cancelled", "Execution was cancelled before launch"));
  const executable = executablePath(command, cwd);
  const env = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  return new Promise((resolve, reject) => {
    const ownGroup = detached && process.platform !== "win32";
    const child = spawn(executable, command.args, { cwd, env, shell: false, detached: ownGroup, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0; let failure: EngineError | null = null;
    const outDecoder = new StringDecoder("utf8"), errDecoder = new StringDecoder("utf8");
    const terminate = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
        else if (ownGroup) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL");
      } catch { /* already exited */ }
    };
    const abort = () => { failure = new EngineError("process_cancelled", "Execution was cancelled"); terminate(); };
    const timer = setTimeout(() => { failure = new EngineError("process_timeout", "Execution exceeded its configured timeout"); terminate(); }, timeoutMs);
    const collect = (buffer: Buffer, stream: "stdout" | "stderr") => {
      size += buffer.length;
      if (size > 4_000_000) { failure = new EngineError("process_output_limit", "Execution output exceeded the size limit"); terminate(); return; }
      if (stream === "stdout") stdout += outDecoder.write(buffer); else stderr += errDecoder.write(buffer);
    };
    child.stdout.on("data", buffer => collect(buffer, "stdout")); child.stderr.on("data", buffer => collect(buffer, "stderr"));
    child.stdin.on("error", () => { /* a process may intentionally not read stdin */ });
    child.once("error", error => { failure = new EngineError("process_failed", "Could not start the selected process", error.message); });
    child.once("exit", () => terminate());
    child.once("close", (exitCode, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      stdout += outDecoder.end(); stderr += errDecoder.end();
      if (failure) reject(failure); else resolve({ exitCode, signal: exitSignal, stdout, stderr });
    });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      else { if (child.pid) onSpawn?.(child.pid); child.stdin.end(input); }
    } catch (error) {
      failure = error instanceof EngineError ? error : new EngineError("process_record_failed", "Process ownership could not be recorded"); terminate();
    }
  });
}
