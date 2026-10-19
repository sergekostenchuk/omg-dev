// GUARD1 (№6781 п.1, №6784) and GUARD1b (№6915): the preload scripts/guard1.cjs keeps old engine code out of
// `npm run check:backend`; the known counters of the current dist still register.
// Every scenario runs in a separate driver process under the guard, so the result is the same whether this file
// itself runs under check:backend (its own process guarded too: a stop may then come at its own spawn) or under
// plain `node --test`. A stop must name the original test file and happen before the old code runs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = join(ROOT, "scripts", "guard1.cjs");
const TEST = "test/guard1.test.ts";
const OLD = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: ROOT, encoding: "utf8" }).trim();
const engineGitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: ROOT, encoding: "utf8" }).trim();
const EXCL_BASE = pathToFileURL(join(ROOT, "scripts", "excl1-register.mjs")).href;
const EXCL_HOOK = new URL("./excl1-resolve.mjs", EXCL_BASE).href;

interface Outcome { status: number | null; out: string }
function guarded(args: string[], env: Record<string, string> = {}): Outcome {
  try {
    const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(GUARD)}`, OMG_GUARD1_TEST: TEST, ...env } });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  } catch (error) {
    // This file's own process is guarded under check:backend: the stop then comes at its spawn.
    if ((error as { code?: unknown }).code === "GUARD1_OLD_CODE") return { status: -1, out: String((error as Error).message) };
    throw error;
  }
}
const script = (body: string) => ["--input-type=module", "-e", body];
function stopped(outcome: Outcome, what: string): void {
  assert.notEqual(outcome.status, 0, outcome.out);
  assert.match(outcome.out, /GUARD1: old engine code is not run under check:backend/, outcome.out);
  assert.ok(outcome.out.includes(`(test file: ${TEST})`), `The stop names the original test file: ${outcome.out}`);
  assert.ok(outcome.out.includes(what), `${what} in: ${outcome.out}`);
}
function allowed(outcome: Outcome, marker: string): void {
  assert.equal(outcome.status, 0, outcome.out);
  assert.ok(outcome.out.includes(marker), outcome.out);
  assert.doesNotMatch(outcome.out, /GUARD1:/);
}
function workspace(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-guard1-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=G", "-c", "user.email=g@example.invalid", "commit", "-qm", "base"]])
    execFileSync("git", args, { cwd: project });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
  const marker = join(root, "loader-ran");
  const loader = join(root, "old-loader.mjs");
  // A historical loader serves an old revision from Git; GUARD1b lets only a counter of the current dist through.
  writeFileSync(loader, `import { writeFileSync } from 'node:fs'; import { execFileSync } from 'node:child_process';
writeFileSync(${JSON.stringify(marker)}, 'ran');
export async function load(url, context, next) { return url.endsWith('.old') ? { format: 'module', source: execFileSync('git', ['show', 'HEAD~1:' + url]), shortCircuit: true } : next(url, context); }`);
  const counter = join(root, "counter-loader.mjs"), counted = join(root, "counter-ran");
  writeFileSync(counter, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(counted)}, 'ran');
let root; export function initialize(data) { root = data?.root; }
export async function load(url, context, next) { const loaded = await next(url, context); return loaded; }`);
  return { root, project, commit, marker, loader, counter, counted };
}

test("GUARD1 the EXCL hook is the only loader: its exact URL from its exact base runs, and the same hook from another base, a same-named copy or any other register stops before the loader runs", t => {
  const w = workspace(t);
  allowed(guarded(["--import", join(ROOT, "scripts", "excl1-register.mjs"), "-e", "console.log('excl ran')"]), "excl ran");
  const bootstrap = (specifier: string, base: string | null) => `data:text/javascript,${encodeURIComponent(
    `import { register } from 'node:module'; register(${JSON.stringify(specifier)}${base === null ? "" : `, ${JSON.stringify(base)}`});`)}`;
  const other = guarded(["--import", bootstrap(pathToFileURL(w.loader).href, null), "-e", "console.log('main ran')"]);
  stopped(other, `module.register(${pathToFileURL(w.loader).href}`);
  assert.equal(existsSync(w.marker), false, "The loader never ran");
  assert.doesNotMatch(other.out, /main ran/);
  stopped(guarded(["--import", bootstrap(EXCL_HOOK, pathToFileURL(join(w.root, "elsewhere.mjs")).href), "-e", "1"]), "module.register(");
  copyFileSync(join(ROOT, "scripts", "excl1-resolve.mjs"), join(w.root, "excl1-resolve.mjs"));
  stopped(guarded(["--import", bootstrap("./excl1-resolve.mjs", pathToFileURL(join(w.root, "excl1-register.mjs")).href), "-e", "1"]),
    "module.register(");
  const named = guarded(script(`import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(w.loader).href)}); console.log('named ran')`));
  stopped(named, "module.register(");
  assert.equal(existsSync(w.marker), false);
});

test("GUARD1b a counter of the current dist registers — its data names this dist or no root — and the same loader with another root, an era in its data, a short circuit or Git in its source stops before it runs", t => {
  const w = workspace(t);
  const dist = pathToFileURL(join(ROOT, "dist") + "/").href, counter = pathToFileURL(w.counter).href;
  const register = (loader: string, data: string) => guarded(script(`import { register } from 'node:module';
register(${JSON.stringify(loader)}, ${data}); await import(${JSON.stringify(pathToFileURL(join(ROOT, "dist", "src", "canonical.js")).href)}); console.log('counted ran')`));
  allowed(register(counter, `{ data: { root: ${JSON.stringify(dist)}, repository: ${JSON.stringify(ROOT)} } }`), "counted ran");
  assert.equal(existsSync(w.counted), true, "The counter ran");
  rmSync(w.counted);
  allowed(register(counter, `import.meta.url`), "counted ran");
  rmSync(w.counted);
  stopped(register(counter, `{ data: { root: ${JSON.stringify(pathToFileURL(ROOT).href)} } }`), "module.register(");
  stopped(register(counter, `{ data: { root: ${JSON.stringify(dist)}, commit: ${JSON.stringify(OLD)} } }`), "module.register(");
  const shortCircuit = join(w.root, "short-loader.mjs");
  writeFileSync(shortCircuit, readFileSync(w.counter, "utf8").replace("return loaded;", "return { ...loaded, shortCircuit: true };"));
  stopped(register(pathToFileURL(shortCircuit).href, `{ data: { root: ${JSON.stringify(dist)} } }`), "module.register(");
  stopped(register(pathToFileURL(w.loader).href, `{ data: { root: ${JSON.stringify(dist)} } }`), "module.register(");
  assert.equal(existsSync(w.counted), false, "No refused counter ran");
  assert.equal(existsSync(w.marker), false, "The historical loader never ran");
});

test("GUARD1 registerHooks may observe loading but never substitute an engine module; a --loader stops at the spawn and at the start, before the loader runs", t => {
  const w = workspace(t);
  const canonical = pathToFileURL(join(ROOT, "dist", "src", "canonical.js")).href;
  allowed(guarded(script(`import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) { return next(url, context); } });
await import(${JSON.stringify(canonical)}); console.log('observed')`)), "observed");
  stopped(guarded(script(`import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) { return url === ${JSON.stringify(canonical)}
  ? { format: 'module', source: 'export const old = 1;', shortCircuit: true } : next(url, context); } });
await import(${JSON.stringify(canonical)}); console.log('substituted')`)), "registerHooks substitutes the engine module");
  stopped(guarded(script(`import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) { const loaded = next(url, context);
  return url === ${JSON.stringify(canonical)} ? { ...loaded, source: String(loaded.source) + '\\nexport const rewritten = 1;' } : loaded; } });
await import(${JSON.stringify(canonical)}); console.log('rewritten')`)), "registerHooks substitutes the engine module");
  stopped(guarded(script(`import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) { const loaded = next(url, context);
  if (url === ${JSON.stringify(canonical)}) loaded.source = 'export const edited = 1;'; return loaded; } });
await import(${JSON.stringify(canonical)}); console.log('edited in place')`)), "registerHooks substitutes the engine module");
  stopped(guarded(script(`import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--experimental-loader', ${JSON.stringify(pathToFileURL(w.loader).href)}, '-e', '1']);
console.log('spawned', result.status)`)), "a node child with a loader");
  stopped(guarded(["-e", "console.log('main ran')"], { NODE_OPTIONS: `--require ${JSON.stringify(GUARD)} --experimental-loader ${pathToFileURL(w.loader).href}` }),
    "loader");
  assert.equal(existsSync(w.marker), false, "No loader ran");
});

test("GUARD1 extraction of the engine's own src/test from Git stops by every spawn form; the current HEAD, a project's Git data and treeFile stay readable", t => {
  const w = workspace(t);
  const run = (call: string) => guarded(script(`import * as cp from 'node:child_process';
const ROOT = ${JSON.stringify(ROOT)}, OLD = ${JSON.stringify(OLD)};
${call}
console.log('extraction ran')`));
  stopped(run(`cp.execFileSync('git', ['show', OLD + ':src/storage/store.ts'], { cwd: ROOT });`), `git show ${OLD}:src/`);
  stopped(run(`cp.execFileSync('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', 'cat-file', '-p', OLD + ':test/storage.test.ts'], { cwd: ROOT });`),
    `git cat-file ${OLD}:test/`);
  stopped(run(`cp.execFileSync('git', ['-C', ROOT, 'show', OLD + ':src/storage/store.ts'], { cwd: ${JSON.stringify(w.root)} });`), "git show");
  stopped(run(`cp.spawnSync('git', ['show', OLD + ':src/storage/store.ts'], { cwd: ROOT });`), "git show");
  stopped(run(`cp.spawn('git', ['show', OLD + ':src/storage/store.ts'], { cwd: ROOT });`), "git show");
  stopped(run(`cp.execSync('git show ' + OLD + ':src/storage/store.ts', { cwd: ROOT });`), "git show");
  stopped(run(`cp.exec('cd . && git show ' + OLD + ':src/storage/store.ts', { cwd: ROOT }, () => {});`), "git show");
  stopped(run(`cp.execFile('git', ['show', OLD + ':test/storage.test.ts'], { cwd: ROOT }, () => {});`), "git show");
  stopped(run(`cp.execFileSync('git', ['archive', '--format=tar', OLD, 'src', 'package.json'], { cwd: ROOT, maxBuffer: 1e9 });`), "git archive");
  stopped(run(`cp.execFileSync('git', ['show', 'HEAD:src/canonical.ts', OLD + ':src/canonical.ts'], { cwd: ROOT });`), `git show ${OLD}:src/`);
  stopped(run(`cp.execFileSync('git', ['show', OLD + ':src/storage/store.ts'], { cwd: ${JSON.stringify(w.root)}, env: { ...process.env, GIT_DIR: ${JSON.stringify(engineGitDir)} } });`),
    "git show");
  stopped(run(`cp.execFileSync('git', ['archive', '--remote=' + ROOT, '--format=tar', OLD, 'src'], { cwd: ${JSON.stringify(w.project)} });`), "git archive");
  stopped(run(`cp.execFileSync('git', ['cat-file', '--batch'], { cwd: ROOT, input: OLD + ':src/storage/store.ts\\n' });`), "git cat-file");
  const clone = join(w.root, "clone");
  execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", ROOT, clone]);
  stopped(run(`cp.execFileSync('git', ['show', OLD + ':src/storage/store.ts'], { cwd: ${JSON.stringify(clone)} });`), "git show");
  rmSync(join(clone, ".git", "objects", "info", "alternates"));
  stopped(run(`cp.execFileSync('git', ['archive', '--format=tar', OLD, 'src'], { cwd: ${JSON.stringify(clone)} });`), "git archive");
  allowed(run(`cp.execFileSync('git', ['show', 'HEAD:src/storage/store.ts'], { cwd: ROOT, maxBuffer: 1e8 });`), "extraction ran");
  // util.promisify keeps Node's {stdout, stderr} result and is guarded the same.
  allowed(run(`const { promisify } = await import('node:util');
const { stdout } = await promisify(cp.execFile)('git', ['show', 'HEAD:src/canonical.ts'], { cwd: ROOT, maxBuffer: 1e8 });
const shell = await promisify(cp.exec)('git show HEAD:src/canonical.ts', { cwd: ROOT, maxBuffer: 1e8 });
if (typeof stdout !== 'string' || typeof shell.stdout !== 'string') throw new Error('promisify lost its result');`), "extraction ran");
  stopped(run(`const { promisify } = await import('node:util');
await promisify(cp.execFile)('git', ['show', OLD + ':src/storage/store.ts'], { cwd: ROOT });`), "git show");
  stopped(run(`const { promisify } = await import('node:util');
await promisify(cp.exec)('git show ' + OLD + ':src/storage/store.ts', { cwd: ROOT });`), "git show");
  allowed(run(`cp.execFileSync('git', ['show', ${JSON.stringify(w.commit)} + ':src/a.ts'], { cwd: ${JSON.stringify(w.project)} });
cp.execFileSync('git', ['archive', '--format=tar', ${JSON.stringify(w.commit)}, 'src'], { cwd: ${JSON.stringify(w.project)} });`), "extraction ran");
  allowed(guarded(script(`const { treeFile } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "dist", "src", "runtime", "git-files.js")).href)});
console.log('treeFile', String(treeFile(${JSON.stringify(w.project)}, ${JSON.stringify(w.commit)}, 'src/a.ts')).trim())`)), "treeFile export const a = 1;");
});

test("GUARD1 a child with an explicit environment — runProcess builds one without NODE_OPTIONS — a forked or inherited child and a worker thread are guarded the same, naming the original test file", t => {
  const w = workspace(t);
  const extract = `require('node:child_process').execFileSync('git', ['show', ${JSON.stringify(OLD)} + ':src/storage/store.ts'], { cwd: ${JSON.stringify(ROOT)} }); console.log('child extraction ran')`;
  const product = guarded(script(`const { runProcess } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "dist", "src", "runtime", "process.js")).href)});
const result = await runProcess({ executable: process.execPath, args: ['-e', ${JSON.stringify(extract)}] }, ${JSON.stringify(ROOT)}, '', 60000);
process.stdout.write(result.stdout + result.stderr); process.exitCode = result.exitCode === 0 ? 0 : 3;`));
  stopped(product, "git show");
  assert.doesNotMatch(product.out, /child extraction ran/);
  stopped(guarded(script(`import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(extract)}], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
process.stdout.write(result.stdout + result.stderr); process.exitCode = result.status === 0 ? 0 : 3;`)), "git show");
  stopped(guarded(script(`import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(extract)}], { encoding: 'utf8' });
process.stdout.write(result.stdout + result.stderr); process.exitCode = result.status === 0 ? 0 : 3;`)), "git show");
  const child = join(w.root, "child.cjs");
  writeFileSync(child, extract);
  const forked = guarded(script(`import { fork } from 'node:child_process';
fork(${JSON.stringify(child)}, [], { env: { PATH: process.env.PATH } }).on('exit', code => { process.exitCode = code === 0 ? 0 : 3; });`));
  stopped(forked, "git show");
  assert.doesNotMatch(forked.out, /child extraction ran/);
  const inWorker = `import('node:child_process').then(cp => cp.execFileSync('git', ['show', '${OLD}:src/storage/store.ts'], { cwd: ${JSON.stringify(ROOT)} }))`;
  const loaderInWorker = `import('node:module').then(module => module.register(${JSON.stringify(pathToFileURL(w.loader).href)}))`;
  for (const [code, what] of [[inWorker, "git show"], [loaderInWorker, "module.register("]] as const)
    stopped(guarded(script(`import { Worker } from 'node:worker_threads';
new Worker(${JSON.stringify(code)}, { eval: true }).on('error', error => { console.error(error.message); process.exitCode = 3; });`)), what);
  assert.equal(existsSync(w.marker), false, "No loader ran in a worker");
});
