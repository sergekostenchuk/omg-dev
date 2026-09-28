import { readFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { classifyStopErrno, probeProcessIdentity, type ProcessStopReport } from "../runtime/process-identity.js";

// The command receives no input until its supervisor has been recorded in SQLite.
// All descendants stay in this process group; a dead owner cannot leave a writer running.
const request = JSON.parse(readFileSync(0, "utf8")) as { parent: number; executable: string; args: string[]; input: string };
// A delivered SIGKILL never returns; reaching the write means the group stop
// was refused or unproven. The target is this supervisor's own group, so the
// signal can never hit a foreign identity — only the errno is classified.
const stop = (): never => {
  let errno: string | null = null;
  try { process.kill(-process.pid, "SIGKILL"); }
  catch (error) { errno = (error as NodeJS.ErrnoException)?.code ?? "unknown"; }
  const post = probeProcessIdentity(process.pid);
  const report: ProcessStopReport = {
    outcome: classifyStopErrno(errno, post, null), stage: "group-sweep",
    target: "group", pid: process.pid, expectedStarted: null,
    observedStarted: post.state === "present" ? post.started : null, errno
  };
  try { writeSync(2, `omg-supervisor: ${JSON.stringify({ reason: "parent-lost", ...report })}\n`); } catch { /* stderr may be closed */ }
  process.exit(1);
};
if (process.ppid !== request.parent) stop();
const timer = setInterval(() => { if (process.ppid !== request.parent) stop(); }, 100);
const child = spawn(request.executable, request.args, { cwd: process.cwd(), env: process.env, detached: false, shell: false, stdio: ["pipe", "inherit", "inherit"] });
child.stdin.on("error", () => {}); child.stdin.end(request.input);
child.on("error", () => { clearInterval(timer); process.exit(1); });
child.on("exit", code => { clearInterval(timer); process.exit(code ?? 1); });
