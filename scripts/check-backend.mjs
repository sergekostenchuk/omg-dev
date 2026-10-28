import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--reporter" || !args[1])) throw new Error("Usage: check-backend.mjs [--reporter module]");
const run = (args, diagnostic = false, env, after = () => {}) => {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: diagnostic ? ["inherit", 2, 2] : "inherit", shell: false, env: env ? { ...process.env, ...env } : process.env });
  after();
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
// EXCL (№6687 п.1, №6721): single tests listed in test/EXCL1-TESTS.txt and test/EXCL2-TESTS.txt — key =
// file + the exact registered name — are skipped here and only here, tagged 'EXCL1'/'EXCL2'. Every key
// is verified against the source by AST before the run, without importing node:test: the file must be
// in this run set and the name must resolve to exactly one supported registration — a direct
// test('<name>') bound to that file's own 'node:test' import; the same name in any other form
// (test.only/skip/todo, element calls, it/describe, a helper or local binding) is an error, and so is
// an unknown, duplicated or out-of-run key. The two lists must not share a key.
const { parseExclusionList, verifyExclusionKeys } = await import(resolve(root, "dist/test/excl1-wrap.js"));
const runFiles = new Set(tests.map(path => path.split("/").pop().replace(/\.js$/, ".ts")));
const readSource = file => sources.includes(file) ? readFileSync(resolve(root, "test", file), "utf8") : null;
const env = {}, allKeys = [];
for (const tag of ["EXCL1", "EXCL2"]) {
  const list = resolve(root, `test/${tag}-TESTS.txt`);
  if (!existsSync(list)) continue;
  const keys = parseExclusionList(readFileSync(list, "utf8"), `test/${tag}-TESTS.txt`);
  verifyExclusionKeys(keys, readSource, runFiles, `test/${tag}-TESTS.txt`);
  if (keys.length) { process.stderr.write(`check:backend: ${keys.length} listed test(s) from test/${tag}-TESTS.txt are skipped\n`); env[`OMG_${tag}`] = list; }
  allKeys.push(...keys);
}
const shared = new Set(allKeys.map(key => JSON.stringify([key.file, key.name]))).size !== allKeys.length;
if (shared) throw new Error("test/EXCL1-TESTS.txt and test/EXCL2-TESTS.txt share a key");
// GUARD1 (№6781 п.1, №6784): every process of the test run preloads scripts/guard1.cjs, so no old engine code runs
// here — no loader but the EXCL hook, no extraction of the engine's own sources from Git; a stop names the test file.
env.NODE_OPTIONS = `--require ${JSON.stringify(resolve(root, "scripts/guard1.cjs"))} ${process.env.NODE_OPTIONS ?? ""}`.trim();
// OMG-V7-SEED-SHARED: the paid worlds of the Discovery v7 tests are built once per RUN, not once per test process
// (test/discovery-v7-paid-world-cache.ts). The catalog is this run's alone: made after the build, before the tests, removed
// after them whatever their code; a test process started without the variable builds lazily, as before.
const catalog = mkdtempSync(join(tmpdir(), "omg-paid-worlds-"));
env.OMG_PAID_WORLD_CATALOG = catalog;
const paidWorlds = () => {
  const layers = new Map();
  try {
    for (const line of readFileSync(join(catalog, "stats.ndjson"), "utf8").split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line), layer = layers.get(row.layer) ?? { built: 0, reused: 0, waited: 0, builtMs: 0, waitedMs: 0 };
        layer[row.role] += 1;
        if (row.role !== "reused") layer[`${row.role}Ms`] += row.ms;
        layers.set(row.layer, layer);
      } catch { /* a line cut short by a killed process */ }
    }
  } catch { /* no test process asked for a paid world */ }
  const seconds = ms => Math.round(ms / 1000);
  const size = dir => readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? size(join(dir, entry.name)) : statSync(join(dir, entry.name)).size), 0);
  process.stderr.write(`check:backend: paid worlds of this run — ${[...layers].map(([name, layer]) =>
    `${name}: built ${layer.built} (${seconds(layer.builtMs)} s), served ${layer.reused + layer.waited} (waited ${layer.waited}, ${seconds(layer.waitedMs)} s)`).join("; ") || "none asked for"}; the catalog holds ${Math.round(size(catalog) / 1e6)} MB\n`);
};
run([...(allKeys.length ? ["--import", resolve(root, "scripts/excl1-register.mjs")] : []),
  "--test", ...(args.length ? [`--test-reporter=${args[1]}`] : []), ...tests], false, env, () => {
  try { paidWorlds(); } catch { /* the summary is information only */ }
  try { rmSync(catalog, { recursive: true, force: true }); } catch { /* a leftover temporary directory never decides the exit code */ }
});
