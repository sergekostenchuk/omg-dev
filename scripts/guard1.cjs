'use strict';
// GUARD1 (№6781 п.1, №6784): `npm run check:backend` runs no old engine code. scripts/check-backend.mjs preloads this
// file through NODE_OPTIONS into the test run, so it is in every process of the test tree; a child spawned with an
// explicit environment (runProcess builds one from a fixed list without NODE_OPTIONS) gets it back here, at the spawn,
// without widening the product's list. A stop throws before the old code runs and names the original test file.
//  - loaders: module.register only for the EXCL hook — the exact URL of ./excl1-resolve.mjs and its exact base
//    scripts/excl1-register.mjs — and for the known instrumentation of the current dist (GUARD1b below);
//    registerHooks may observe loading but never substitute an engine module;
//    --loader / --experimental-loader stop both at start and at a spawn;
//  - extraction of the engine's own sources from Git — `show`/`cat-file` of `<rev>:src|test/…` for any revision but
//    the current HEAD (also in the lines of a synchronous `cat-file --batch` input), and any `archive` — in the
//    engine's repository (same common .git, also through -C, --git-dir, GIT_DIR, archive --remote) or a clone of it
//    (a remote URL or an alternate object store that is the engine's), by every spawn form. Git data of any other
//    repository (a project's treeFile, the current producer) is untouched. Not seen: a blob read by its object id —
//    the product reads the current snapshot so (om impact), and no test reads old sources that way.
const Module = require('node:module');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { promisify } = require('node:util');

const SELF = __filename;
const ROOT = path.resolve(__dirname, '..');
const EXCL_BASE = pathToFileURL(path.join(ROOT, 'scripts', 'excl1-register.mjs')).href;
const EXCL_HOOK = new URL('./excl1-resolve.mjs', EXCL_BASE).href;
const REQUIRE = `--require ${JSON.stringify(SELF)}`;
const LOADER_FLAG = /(^|\s)--(experimental-)?loader(\s|=|$)/;

// The test file: a process of `node --test` runs exactly one file (its runner names them all and sets nothing);
// any other process keeps the name it inherited.
const testFiles = process.argv.filter(arg => /[\\/]dist[\\/]test[\\/][^\\/]+\.test\.js$/.test(arg));
if (testFiles.length === 1) process.env.OMG_GUARD1_TEST = `test/${path.basename(testFiles[0]).replace(/\.js$/, '.ts')}`;
if (!(process.env.NODE_OPTIONS ?? '').includes(SELF))
  process.env.NODE_OPTIONS = `${REQUIRE} ${process.env.NODE_OPTIONS ?? ''}`.trim();

class Guard1Error extends Error {
  constructor(what) {
    super(`GUARD1: old engine code is not run under check:backend — ${what} (test file: ${process.env.OMG_GUARD1_TEST ?? 'unknown'})`);
    this.name = 'Guard1Error'; this.code = 'GUARD1_OLD_CODE';
  }
}
function stop(what) {
  const log = process.env.OMG_GUARD1_LOG;
  if (log) try { fs.appendFileSync(log, JSON.stringify({ test: process.env.OMG_GUARD1_TEST ?? null, pid: process.pid, what }) + '\n'); } catch {}
  throw new Guard1Error(what);
}

if ([...process.execArgv, process.env.NODE_OPTIONS ?? ''].some(arg => LOADER_FLAG.test(arg))) stop('a --loader/--experimental-loader process');

// --- loaders ---
const realRegister = Module.register;
Module.register = function register(specifier, parentURL, options) {
  const base = typeof parentURL === 'string' || parentURL instanceof URL ? String(parentURL)
    : parentURL && typeof parentURL === 'object' && parentURL.parentURL !== undefined ? String(parentURL.parentURL) : undefined;
  let resolved;
  try { resolved = new URL(String(specifier), base).href; } catch { resolved = String(specifier); }
  if (resolved === EXCL_HOOK && base === EXCL_BASE) return realRegister.apply(this, arguments);
  const given = parentURL && typeof parentURL === 'object' && !(parentURL instanceof URL) ? parentURL : options;
  if (currentInstrumentation(resolved, given)) return realRegister.apply(this, arguments);
  return stop(`module.register(${resolved}${base ? `, ${base}` : ''})`);
};
// GUARD1b (№6915, codex-omg №6865): the known instrumentation of the CURRENT engine stays — a loader file the test wrote
// that counts or logs while this checkout's dist loads (om-series, om-result-identity, om-operation-cost, om-addressing).
// It carries no era and fetches no code: its data names no root but this dist and no commit/baseline/base/era, and its
// source names no child process, Git, archive or short circuit. Git extraction stays stopped in every thread, the
// loader's own included.
const DIST_URL = pathToFileURL(path.join(ROOT, 'dist') + path.sep).href;
const ERA_DATA = ['commit', 'baseline', 'base', 'era'];
const FETCHES = /child_process|\bexecFile|\bexecSync|\bspawn|\bfork\s*\(|['"`]git['"`]|\bgit\s+(show|archive|cat-file)\b|\barchive\b|shortCircuit/;
function currentInstrumentation(resolved, given) {
  if (!resolved.startsWith('file:')) return false;
  let source;
  try { source = fs.readFileSync(fileURLToPath(resolved), 'utf8'); } catch { return false; }
  if (FETCHES.test(source)) return false;
  const data = given && typeof given === 'object' ? given.data : undefined;
  if (data === undefined) return true;
  if (!data || typeof data !== 'object' || ERA_DATA.some(key => key in data)) return false;
  return !('root' in data) || String(data.root) === DIST_URL;
}
const bytesOf = source => typeof source === 'string' ? Buffer.from(source)
  : ArrayBuffer.isView(source) ? Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  : source instanceof ArrayBuffer ? Buffer.from(source) : null;
const sameSource = (left, right) => {
  if (left === right) return true;
  const a = bytesOf(left), b = bytesOf(right);
  return a !== null && b !== null && a.equals(b);
};
const engineModule = url => {
  if (typeof url !== 'string' || !url.startsWith('file:')) return false;
  const file = fileURLToPath(url.replace(/[?#].*$/, ''));
  return ['dist', 'src', 'test'].some(dir => file.startsWith(path.join(ROOT, dir) + path.sep));
};
if (typeof Module.registerHooks === 'function') {
  const realRegisterHooks = Module.registerHooks;
  Module.registerHooks = function registerHooks(hooks) {
    if (!hooks || typeof hooks.load !== 'function') return realRegisterHooks.apply(this, arguments);
    const load = hooks.load;
    // Observation passes an engine module on as nextLoad gave it; a short circuit or changed source/format substitutes it.
    return realRegisterHooks.call(this, { ...hooks, load(url, context, nextLoad) {
      let given;
      // The snapshot copies format and bytes: a hook that edits the given object in place still differs from it.
      const result = load(url, context, (nextUrl, nextContext) => {
        const loaded = nextLoad(nextUrl, nextContext);
        if (nextUrl === url && loaded) { const bytes = bytesOf(loaded.source); given = { format: loaded.format, source: bytes ? Buffer.from(bytes) : loaded.source }; }
        return loaded;
      });
      if (engineModule(url) && result && (result.shortCircuit || !given || result.format !== given.format || !sameSource(result.source, given.source)))
        stop(`registerHooks substitutes the engine module ${url}`);
      return result;
    } });
  };
}
Module.syncBuiltinESMExports();

// --- the engine's repository: the common .git of ROOT, read from files only ---
function commonDirOf(dotgit) {
  const stat = fs.statSync(dotgit);
  if (stat.isDirectory()) return { gitDir: dotgit, common: fs.realpathSync(dotgit) };
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
  if (!match) return null;
  const gitDir = path.resolve(path.dirname(dotgit), match[1]);
  const pointer = path.join(gitDir, 'commondir');
  const common = fs.existsSync(pointer) ? path.resolve(gitDir, fs.readFileSync(pointer, 'utf8').trim()) : gitDir;
  return { gitDir, common: fs.realpathSync(common) };
}
function repositoryOf(directory) {
  let current;
  try { current = fs.realpathSync(directory); } catch { return null; }
  for (;;) {
    const dotgit = path.join(current, '.git');
    if (fs.existsSync(dotgit)) { try { return commonDirOf(dotgit); } catch { return null; } }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
let engine;
function engineRepository() {
  if (engine !== undefined) return engine;
  const repository = repositoryOf(ROOT);
  let head = null;
  if (repository) try {
    const value = fs.readFileSync(path.join(repository.gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(value);
    if (!ref) head = value;
    else {
      const loose = path.join(repository.common, ref[1]);
      if (fs.existsSync(loose)) head = fs.readFileSync(loose, 'utf8').trim();
      else {
        const packed = path.join(repository.common, 'packed-refs');
        const line = fs.existsSync(packed) ? fs.readFileSync(packed, 'utf8').split('\n').find(row => row.endsWith(` ${ref[1]}`)) : undefined;
        head = line ? line.split(' ')[0] : null;
      }
    }
  } catch { head = null; }
  return engine = repository ? { common: repository.common, head } : null;
}
const current = rev => {
  const head = engineRepository()?.head;
  return rev === 'HEAD' || (head !== null && head !== undefined && /^[0-9a-f]{7,64}$/.test(rev) && head.startsWith(rev));
};

// --- git command forms ---
const SEPARATE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
function gitTarget(args, cwd) {
  let directory = cwd, gitDir = null, index = 0;
  while (index < args.length) {
    const arg = String(args[index]);
    if (arg === '-C') { directory = path.resolve(directory, String(args[index + 1] ?? '')); index += 2; continue; }
    if (arg === '--git-dir') { gitDir = path.resolve(directory, String(args[index + 1] ?? '')); index += 2; continue; }
    if (arg.startsWith('--git-dir=')) { gitDir = path.resolve(directory, arg.slice(10)); index += 1; continue; }
    if (SEPARATE.has(arg)) { index += 2; continue; }
    if (arg.startsWith('-')) { index += 1; continue; }
    break;
  }
  return { directory, gitDir, command: args[index] === undefined ? null : String(args[index]), rest: args.slice(index + 1).map(String) };
}
const SOURCE = /^([^:\s]+):(?:\.\/)?(?:src|test)\//;
const localPath = (value, base) => {
  const text = String(value);
  if (text.startsWith('file://')) try { return fileURLToPath(text); } catch { return null; }
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[^/\\]+@[^:]+:/.test(text) ? null : path.resolve(base, text);
};
function commonOfGitDir(gitDir) {
  try {
    if (!fs.statSync(gitDir).isDirectory()) return null;
    const pointer = path.join(gitDir, 'commondir');
    return fs.realpathSync(fs.existsSync(pointer) ? path.resolve(gitDir, fs.readFileSync(pointer, 'utf8').trim()) : gitDir);
  } catch { return null; }
}
// The engine's repository or one made from it: a clone keeps it as a remote URL or as an alternate object store.
function fromEngine(common) {
  const engineRepo = engineRepository();
  if (!engineRepo || !common) return false;
  if (common === engineRepo.common) return true;
  const engineObjects = path.join(engineRepo.common, 'objects');
  try {
    const alternates = fs.readFileSync(path.join(common, 'objects', 'info', 'alternates'), 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
    if (alternates.some(line => { try { return fs.realpathSync(path.resolve(common, 'objects', line)) === engineObjects; } catch { return false; } })) return true;
  } catch {}
  try {
    for (const match of fs.readFileSync(path.join(common, 'config'), 'utf8').matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)) {
      const local = localPath(match[1], common);
      if (local && (repositoryOf(local)?.common === engineRepo.common || commonOfGitDir(local) === engineRepo.common)) return true;
    }
  } catch {}
  return false;
}
// The revisions a launch names: arguments, and lines of a synchronous `cat-file --batch` input.
function extraction(args, cwd, env, input) {
  const target = gitTarget(args, cwd);
  let what = null, remote = null;
  if (target.command === 'archive') {
    what = `git archive ${target.rest.join(' ')}`;
    const at = target.rest.findIndex(arg => arg === '--remote' || arg.startsWith('--remote='));
    if (at >= 0) remote = target.rest[at] === '--remote' ? target.rest[at + 1] : target.rest[at].slice(9);
  } else if (target.command === 'show' || target.command === 'cat-file') {
    const text = typeof input === 'string' ? input
      : ArrayBuffer.isView(input) ? Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('utf8') : '';
    const lines = target.command === 'cat-file' && target.rest.some(arg => arg.startsWith('--batch')) ? text.split('\n') : [];
    const source = [...target.rest, ...lines.map(line => line.trim())].map(arg => SOURCE.exec(arg)).filter(Boolean).find(match => !current(match[1]));
    if (source) what = `git ${target.command} ${source[0]}…`;
  }
  if (!what) return null;
  if (remote !== null) {
    const local = localPath(remote, target.directory);
    return local && fromEngine(repositoryOf(local)?.common ?? commonOfGitDir(local)) ? what : null;
  }
  const gitDir = target.gitDir ?? (env && env.GIT_DIR ? path.resolve(target.directory, String(env.GIT_DIR)) : null);
  const common = gitDir ? commonOfGitDir(gitDir) : repositoryOf(target.directory)?.common ?? null;
  return fromEngine(common) ? what : null;
}
const GIT = /(^|[\\/])git(\.exe)?$/;
function shellWords(command) {
  const words = []; let word = '', quote = null, any = false;
  for (const char of String(command)) {
    if (quote) { if (char === quote) quote = null; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; any = true; continue; }
    if (/\s/.test(char)) { if (word || any) words.push(word); word = ''; any = false; continue; }
    if (';&|()'.includes(char)) { if (word || any) words.push(word); words.push(char); word = ''; any = false; continue; }
    word += char;
  }
  if (word || any) words.push(word);
  return words;
}
function checkShell(command, cwd, env, input) {
  const words = shellWords(command);
  for (let index = 0; index < words.length; index++) {
    if (!GIT.test(words[index])) continue;
    let end = index + 1;
    while (end < words.length && !';&|()'.includes(words[end])) end += 1;
    const what = extraction(words.slice(index + 1, end), cwd, env, input);
    if (what) stop(what);
  }
  if (LOADER_FLAG.test(command) && /(^|[\s\\/])node(\.exe)?(\s|$)/.test(command)) stop(`a node child with a loader: ${command}`);
}
const isNode = file => path.resolve(String(file)) === process.execPath || /(^|[\\/])node(\.exe)?$/.test(String(file));
function guardedEnv(env) {
  if (!env || typeof env !== 'object') return env;
  const next = { ...env };
  if (!(next.NODE_OPTIONS ?? '').includes(SELF)) next.NODE_OPTIONS = `${REQUIRE} ${next.NODE_OPTIONS ?? ''}`.trim();
  if (next.OMG_GUARD1_TEST === undefined && process.env.OMG_GUARD1_TEST) next.OMG_GUARD1_TEST = process.env.OMG_GUARD1_TEST;
  if (next.OMG_GUARD1_LOG === undefined && process.env.OMG_GUARD1_LOG) next.OMG_GUARD1_LOG = process.env.OMG_GUARD1_LOG;
  return next;
}
// Normalises (file, args?, options?) and checks one launch; returns the options to pass on.
function inspect(name, file, args, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const cwd = opts.cwd ? path.resolve(String(opts.cwd instanceof URL ? fileURLToPath(opts.cwd) : opts.cwd)) : process.cwd();
  const env = opts.env ?? process.env;
  if (name === 'exec' || name === 'execSync' || opts.shell) checkShell([file, ...(args ?? [])].join(' '), cwd, env, opts.input);
  else if (GIT.test(String(file))) { const what = extraction(args ?? [], cwd, env, opts.input); if (what) stop(what); }
  if ((name === 'fork' || (!opts.shell && isNode(file) && name !== 'exec' && name !== 'execSync'))
    && ((args ?? []).some(arg => LOADER_FLAG.test(String(arg))) || LOADER_FLAG.test(env.NODE_OPTIONS ?? '')
      || (name === 'fork' && (opts.execArgv ?? process.execArgv).some(arg => LOADER_FLAG.test(String(arg))))))
    stop(`a node child with a loader: ${[file, ...(args ?? [])].join(' ')}`);
  return opts.env ? { ...opts, env: guardedEnv(opts.env) } : options;
}
// Node's forms: (file, args?, options?, callback?) — the options object is found where it stands and replaced there.
function guardedFileParams(name, file, params) {
  let args = [], at = -1;
  if (Array.isArray(params[0])) { args = params[0]; if (params[1] && typeof params[1] === 'object') at = 1; }
  else if (params[0] && typeof params[0] === 'object') at = 0;
  const options = at >= 0 ? params[at] : undefined;
  const next = name === 'fork' ? inspect('fork', process.execPath, [String(file), ...args], options) : inspect(name, file, args, options);
  if (at >= 0) params[at] = next;
  return params;
}
const guardedCommandOptions = (name, command, options) =>
  typeof options === 'object' && options !== null ? inspect(name, command, [], options) : (inspect(name, command, [], undefined), options);
// util.promisify(execFile/exec) takes Node's own promise form, which calls the original and resolves {stdout, stderr};
// that form is guarded the same and keeps its result.
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
  const real = childProcess[name];
  const guarded = function guarded(file, ...params) { return real.call(this, file, ...guardedFileParams(name, file, params)); };
  if (real[promisify.custom]) guarded[promisify.custom] = function guardedPromise(file, ...params) {
    return real[promisify.custom].call(this, file, ...guardedFileParams(name, file, params));
  };
  childProcess[name] = guarded;
}
for (const name of ['exec', 'execSync']) {
  const real = childProcess[name];
  const guarded = function guarded(command, options, ...rest) { return real.call(this, command, guardedCommandOptions(name, command, options), ...rest); };
  if (real[promisify.custom]) guarded[promisify.custom] = function guardedPromise(command, options, ...rest) {
    return real[promisify.custom].call(this, command, guardedCommandOptions(name, command, options), ...rest);
  };
  childProcess[name] = guarded;
}
Module.syncBuiltinESMExports();
module.exports = { Guard1Error, stop };
