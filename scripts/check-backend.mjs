import { readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--reporter" || !args[1])) throw new Error("Usage: check-backend.mjs [--reporter module]");
const run = (args, diagnostic = false) => {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: diagnostic ? ["inherit", 2, 2] : "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run([resolve(root, "node_modules/typescript/bin/tsc"), "-p", resolve(root, "tsconfig.json")], true);
// The owner deferred UI work and explicitly recorded its known failing scenario.
// `npm test` still runs that suite; this command never marks it passed or disables it.
const tests = readdirSync(resolve(root, "test")).filter(name => name.endsWith(".test.ts") && name !== "ui.test.ts")
  .sort().map(name => resolve(root, "dist/test", name.replace(/\.ts$/, ".js")));
if (!tests.length || tests.some(path => !existsSync(path))) throw new Error("Backend test compilation is incomplete");
run(["--test", ...(args.length ? [`--test-reporter=${args[1]}`] : []), ...tests]);
