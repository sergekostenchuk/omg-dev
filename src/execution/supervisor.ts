import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

// The command receives no input until its supervisor has been recorded in SQLite.
// All descendants stay in this process group; a dead owner cannot leave a writer running.
const request = JSON.parse(readFileSync(0, "utf8")) as { parent: number; executable: string; args: string[]; input: string };
const stop = () => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } };
if (process.ppid !== request.parent) stop();
const timer = setInterval(() => { if (process.ppid !== request.parent) stop(); }, 100);
const child = spawn(request.executable, request.args, { cwd: process.cwd(), env: process.env, detached: false, shell: false, stdio: ["pipe", "inherit", "inherit"] });
child.stdin.on("error", () => {}); child.stdin.end(request.input);
child.on("error", () => { clearInterval(timer); process.exit(1); });
child.on("exit", code => { clearInterval(timer); process.exit(code ?? 1); });
