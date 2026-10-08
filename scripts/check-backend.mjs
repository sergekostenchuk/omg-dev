import { readdirSync, readFileSync, existsSync } from "node:fs";
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
// CORE1 (№3660): files of legacy routes, eras and inactive parts listed in test/LEGACY-TESTS.txt — one file per line,
// its reason after `#` — are not run here; the code and the tests stay, and `npm test` still runs everything.
const sources = readdirSync(resolve(root, "test")).filter(name => name.endsWith(".test.ts"));
const listed = resolve(root, "test/LEGACY-TESTS.txt");
const legacy = new Set(existsSync(listed) ? readFileSync(listed, "utf8").split("\n").map(line => line.replace(/#.*$/, "").trim()).filter(Boolean) : []);
const unknown = [...legacy].filter(name => !sources.includes(name));
if (unknown.length) throw new Error(`test/LEGACY-TESTS.txt names no test file: ${unknown.join(", ")}`);
if (legacy.size) process.stderr.write(`check:backend: ${legacy.size} legacy test file(s) from test/LEGACY-TESTS.txt are not run\n`);
const tests = sources.filter(name => name !== "ui.test.ts" && !legacy.has(name))
  .sort().map(name => resolve(root, "dist/test", name.replace(/\.ts$/, ".js")));
if (!tests.length || tests.some(path => !existsSync(path))) throw new Error("Backend test compilation is incomplete");
run(["--test", ...(args.length ? [`--test-reporter=${args[1]}`] : []), ...tests]);
