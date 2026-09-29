// Preload for the dry run (node --import ./trace-spawn.mjs ...): logs every child process this Node process starts —
// executable, arguments and working directory — to $TRACE_SPAWN (JSONL), before the engine modules bind their imports.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const file = process.env.TRACE_SPAWN;
if (!file) throw new Error("trace-spawn: set TRACE_SPAWN to a JSONL path");
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
  const original = childProcess[name];
  childProcess[name] = function traced(command, args, options) {
    const list = Array.isArray(args) ? args : [];
    const opts = Array.isArray(args) ? options : args;
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), via: name, command, args: list.slice(0, 12),
      cwd: opts && typeof opts === "object" ? opts.cwd ?? null : null }) + "\n");
    return original.apply(this, arguments);
  };
}
syncBuiltinESMExports();
