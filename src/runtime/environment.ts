import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkTransactionGuards, storeObserved, Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { provenStore } from "../storage/store-view.js";
import { requireCondition, EngineError } from "../errors.js";
import { digest, hashJson } from "../canonical.js";
import type { Command, Graph } from "../graph/model.js";
import { safeRelativePath } from "../graph/topology.js";
import { reference, isRef, type Ref, type Finding } from "../pipeline/contracts.js";

export const UNIVERSAL_ROLE_COMMAND = "role-command/universal-v1" as const;
export const MODE_ROLE_COMMANDS = "role-command/modes-v1" as const;
export type RoleCommandContract = typeof UNIVERSAL_ROLE_COMMAND | typeof MODE_ROLE_COMMANDS;
export type RoleMode = "research" | "implement" | "review" | "chat";
export type EnvironmentRole = "implementer" | "reviewer";
export interface RoleModeCommands { implement?: Command; review?: Command; chat?: Command }
export interface RoleBinding {
  actor: string; model: string; effort: string; command: Command; speed?: "fast" | "inherited";
  /** Absent only on genuine historical records. New configure writes an explicit contract. */
  commandContract?: RoleCommandContract;
  /** Research always uses `command`; the declared mode contract never falls back for these cells. */
  modeCommands?: RoleModeCommands;
}
/** Stage-wide web research allowance. The operator sets it for the launch; nothing in it is a sufficiency criterion. */
export interface WebResearchLimits { httpAttempts: number; pages: number; receivedChars: number; responseBytes: number }
export interface WebMaterialLimits { materialChars: 2_000_000; responseBytes: number }
/** The gateway endpoint (a tunnel the launch provides) and its saved budget era. */
export type WebResearchSettings =
  | { enabled: boolean; gatewayUrl: string; timeoutMs: number; limits: WebResearchLimits; budgetContract?: never }
  | { enabled: boolean; gatewayUrl: string; timeoutMs: number; limits: WebMaterialLimits; budgetContract: 'web-budget/v2' };
export interface Environment {
  projectId: string; workspace: string; implementer: RoleBinding; reviewer: RoleBinding;
  fullCheck: Command; timeoutMs: number;
  requestCapacityChars?: number;
  webResearch?: WebResearchSettings;
}
export function isRequestCapacityChars(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
const positive = (value: unknown, max: number) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
export function requireWebResearchSettings(project: string, value: unknown): asserts value is WebResearchSettings {
  const fail = (field: string, message: string): never => {
    throw new EngineError("environment_invalid", message, { target: `environment:${project}`, field: `webResearch.${field}` });
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("", "Web research settings must be an object");
  const settings = value as Record<string, any>;
  const extra = Object.keys(settings).find(key => !["enabled", "gatewayUrl", "timeoutMs", "limits", "budgetContract"].includes(key));
  if (extra) fail(extra, "Web research settings carry only enabled, gatewayUrl, timeoutMs and limits");
  if (typeof settings.enabled !== "boolean") fail("enabled", "Web research must be explicitly enabled or disabled");
  let gateway: URL | null = null;
  try { gateway = typeof settings.gatewayUrl === "string" ? new URL(settings.gatewayUrl) : null; } catch { gateway = null; }
  if (!gateway || !["http:", "https:"].includes(gateway.protocol) || gateway.username || gateway.password
    || gateway.search || gateway.hash || settings.gatewayUrl.length > 2048)
    fail("gatewayUrl", "The gateway is an http(s) endpoint without credentials, query or fragment");
  if (!(typeof settings.timeoutMs === "number" && Number.isSafeInteger(settings.timeoutMs)
    && settings.timeoutMs >= 1_000 && settings.timeoutMs <= 600_000)) fail("timeoutMs", "The gateway timeout is 1000..600000 ms");
  const limits = settings.limits;
  if (settings.budgetContract === 'web-budget/v2') {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)
      || Object.keys(limits).sort().join() !== 'materialChars,responseBytes')
      fail('limits', 'The material budget names materialChars and responseBytes');
    if (limits.materialChars !== 2_000_000) fail('limits.materialChars', 'The new stage material ceiling is exactly 2000000 UTF-16 units');
    if (!positive(limits.responseBytes, 64_000_000)) fail('limits.responseBytes', 'responseBytes is a positive technical byte cap');
    return;
  }
  if (Object.hasOwn(settings, 'budgetContract')) fail('budgetContract', 'Unknown saved web budget era');
  if (!limits || typeof limits !== "object" || Array.isArray(limits)
    || Object.keys(limits).sort().join() !== "httpAttempts,pages,receivedChars,responseBytes") fail("limits", "Limits name httpAttempts, pages, receivedChars and responseBytes");
  if (!positive(limits.httpAttempts, 100_000)) fail("limits.httpAttempts", "httpAttempts is a positive bounded integer");
  if (!positive(limits.pages, 100_000)) fail("limits.pages", "pages is a positive bounded integer");
  if (!positive(limits.receivedChars, 1_000_000_000)) fail("limits.receivedChars", "receivedChars is a positive bounded integer");
  if (!positive(limits.responseBytes, 64_000_000)) fail("limits.responseBytes", "responseBytes is a positive integer up to 64000000");
}
export function uniqueTransactionGuards(values: readonly TransactionGuard[]): TransactionGuard[] {
  const checked = checkTransactionGuards(values);
  const key = (guard: TransactionGuard) => JSON.stringify('absent' in guard
    ? [guard.id, 'absent'] : [guard.id, 'ref', guard.revision, guard.hash]);
  // Preserve uniqueRefs ordering for positive guards while retaining both variants of an address.
  const order = (guard: TransactionGuard) => 'absent' in guard ? `${guard.id}:absent` : `${guard.id}:${guard.revision}:${guard.hash}`;
  return [...new Map(checked.map(guard => [key(guard), guard])).entries()]
    .sort(([leftKey, left], [rightKey, right]) => order(left).localeCompare(order(right)) || leftKey.localeCompare(rightKey))
    .map(([, guard]) => guard);
}
export function transactionGuardsCurrent(store: Store, guards: readonly TransactionGuard[]): boolean {
  requireCondition(store !== null && typeof store === "object" && typeof store.get === "function",
    "invalid_guard", "Current guard validation needs a readable Store");
  const checked = uniqueTransactionGuards(guards);
  // G1 (№6174 п.3): on a proved Store with no capture actively observing, heads are compared in one
  // snapshot without decoding bodies; every other store or view, and every read a proof is capturing,
  // keeps the per-guard observable get so the recorded journal stays the same.
  const source = provenStore(store);
  if (source !== null && !storeObserved(source)) return source.headsMatch(checked).ok;
  return checked.every(guard => {
    const current = store.get(guard.id);
    return 'absent' in guard ? current === null : current !== null && current.revision === guard.revision && current.hash === guard.hash;
  });
}
export interface RepositoryState { root: string; head: string; tree: string; files: { path: string; hash: string | null }[] }
export interface ExecutionRoot { projectId: string; sourceRoot: string; workspace: Ref; path: string; branch: string; base: string; head: string; state: "creating" | "ready" }
export function git(cwd: string, args: string[], input?: string): string {
  return gitBytes(cwd, args, input === undefined ? undefined : Buffer.from(input)).toString("utf8").trim();
}
let gitEntries = 0;
/** Entries into gitBytes (git goes through it) in this process, whatever their outcome (S1.3, №2217): a historical proof
 * whose action ran git depends on more than its Store and is never kept beyond its operation. */
export function gitCalls(): number { return gitEntries; }
const fullOid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const objectPath = (value: string) => value.length > 0 && !value.includes('\0') && !value.startsWith('/')
  && value.split('/').every(part => part !== '.' && part !== '..');
/** Closed forms only. In particular: no HEAD, abbreviated OID, revision walk, diff, filters or arbitrary options. */
function immutableGitRead(args: readonly string[]): boolean {
  if (args[0] === 'rev-parse' && args.length === 2 && args[1]!.endsWith('^{tree}')) return fullOid(args[1]!.slice(0, -7));
  if (args[0] === 'cat-file' && args.length === 3 && args[1] === 'blob') return fullOid(args[2]!);
  if (args[0] === 'show' && args.length === 2) {
    const colon = args[1]!.indexOf(':');
    return colon > 0 && fullOid(args[1]!.slice(0, colon)) && objectPath(args[1]!.slice(colon + 1));
  }
  if (args[0] === 'ls-tree') return args.length === 4 && args[1] === '-r' && args[2] === '-z' && fullOid(args[3]!)
    || args.length === 5 && args[1] === '-z' && fullOid(args[2]!) && args[3] === '--' && objectPath(args[4]!);
  return false;
}
const gitMemo = new Map<string, { bytes: Buffer; size: number }>();
const GIT_MEMO_BYTES = 8 * 1024 * 1024, GIT_MEMO_ENTRIES = 1024;
let gitMemoBytes = 0;
function clearGitMemo(): void { gitMemo.clear(); gitMemoBytes = 0; }
function rememberGit(key: string, bytes: Buffer): void {
  const size = bytes.length + Buffer.byteLength(key) + 256;
  if (size > GIT_MEMO_BYTES) return;
  while (gitMemoBytes + size > GIT_MEMO_BYTES || gitMemo.size >= GIT_MEMO_ENTRIES) {
    const first = gitMemo.keys().next().value!;
    gitMemoBytes -= gitMemo.get(first)!.size; gitMemo.delete(first);
  }
  gitMemo.set(key, { bytes: Buffer.from(bytes), size }); gitMemoBytes += size;
}
function runGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv, input?: Uint8Array): Buffer {
  const result = spawnSync("git", ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env, input, timeout: 15_000, maxBuffer: 8_000_000 });
  if (result.error || result.status !== 0) throw new EngineError("git_failed", "Git command failed", { action: args[0], stderr: result.stderr?.toString("utf8"), error: result.error?.message });
  return result.stdout;
}
function gitFileStamp(path: string): string {
  const s = statSync(path, { bigint: true, throwIfNoEntry: false });
  return s ? [realpathSync(path), s.dev, s.ino, s.mode, s.size, s.birthtimeNs, s.mtimeNs, s.ctimeNs].join(':') : 'absent';
}
function gitDirectoryIdentity(path: string): string {
  const s = statSync(path, { bigint: true });
  if (!s.isDirectory()) throw new Error('Git directory expected');
  return [s.dev, s.ino, s.mode, s.birthtimeNs].join(':');
}
function smallGitFile(path: string, limit = 65_536): string {
  const s = statSync(path, { throwIfNoEntry: false });
  if (!s) return '';
  if (!s.isFile() || s.size > limit) throw new Error('Git metadata is outside the memo boundary');
  return readFileSync(path, 'utf8');
}
let gitConfigPaths: { identity: string; paths: string[] } | undefined;
/** A fresh filesystem observation, not a repository-path cache. Unknown layouts/configuration bypass the memo.
 * Object names are immutable; directory generations also invalidate after normal loose-object deletion, repack/GC.
 * Config includes, alternates, reftable, replacements, shallow/grafts and partial clones use Git every time. */
function gitMemoContext(cwd: string, env: NodeJS.ProcessEnv): string | null {
  try {
    // git-var separates global paths with LF, without quoting. Unknown HOME and CR/LF in either
    // path source cannot prove which files Git will read; let Git handle these legal environments.
    if (!env.HOME || /[\r\n]/.test(env.HOME) || /[\r\n]/.test(env.XDG_CONFIG_HOME ?? '')) return null;
    const root = realpathSync(cwd), dot = resolve(root, '.git');
    const dotStat = lstatSync(dot, { throwIfNoEntry: false });
    if (!dotStat || dotStat.isSymbolicLink()) return null; // Bare repositories and subdirectories take the ordinary path.
    const gitFile = dotStat.isFile() ? smallGitFile(dot, 4096) : '';
    if (gitFile && !/^gitdir: [^\r\n]+\r?\n?$/.test(gitFile)) return null;
    const dir = realpathSync(gitFile ? resolve(root, gitFile.slice(8).trimEnd()) : dot);
    const commonFile = smallGitFile(resolve(dir, 'commondir'), 4096);
    const common = realpathSync(commonFile ? resolve(dir, commonFile.trimEnd()) : dir);
    const head = smallGitFile(resolve(dir, 'HEAD'), 4096).trimEnd();
    if (!fullOid(head) && !/^ref: refs\/[^\r\n]+$/.test(head)) return null;
    if ([resolve(common, 'shallow'), resolve(common, 'info/grafts'), resolve(common, 'objects/info/alternates'),
      resolve(common, 'objects/info/http-alternates'), resolve(common, 'refs/replace')].some(path => existsSync(path))) return null;
    const packed = smallGitFile(resolve(common, 'packed-refs'), 1_048_576);
    if (/(?:^|\n)[^\n]* refs\/replace\//.test(packed)) return null;
    const executable = executablePath({ executable: 'git', args: [] }, root);
    const identity = digest(JSON.stringify([env, gitFileStamp(executable)]));
    if (gitConfigPaths?.identity !== identity) {
      const system = runGit(root, ['var', 'GIT_CONFIG_SYSTEM'], env).toString('utf8');
      const global = runGit(root, ['var', 'GIT_CONFIG_GLOBAL'], env).toString('utf8');
      // The system variable is ONE path. Remove only the output terminator, preserving pathname
      // whitespace; extra CR/LF is ambiguous even when every fragment looks absolute.
      if (!system.endsWith('\n') || /[\r\n]/.test(system.slice(0, -1))
        || !global.endsWith('\n') || global.includes('\r')) return null;
      const globals = global.slice(0, -1).split('\n');
      const paths = [system.slice(0, -1), ...globals];
      if (globals.length > 2 || paths.some(path => !isAbsolute(path))) return null;
      gitConfigPaths = { identity, paths };
    }
    const configs = [...gitConfigPaths.paths, resolve(common, 'config'), resolve(dir, 'config.worktree')]
      .map(path => [path, gitFileStamp(path), smallGitFile(path)]);
    if (configs.some(([, , text]) => /include|partialclone|refstorage|alternate/i.test(text!))) return null;
    const objects = resolve(common, 'objects'), entries = readdirSync(objects).sort();
    if (entries.length > 260) return null;
    const objectStamps: string[] = [gitFileStamp(objects)];
    for (const entry of entries) {
      if (!/^(?:[a-f0-9]{2}|info|pack)$/.test(entry)) return null;
      objectStamps.push(entry, gitFileStamp(resolve(objects, entry)));
      if (entry === 'pack') {
        const packs = readdirSync(resolve(objects, entry)).sort();
        if (packs.length > 512) return null;
        for (const pack of packs) objectStamps.push(pack, gitFileStamp(resolve(objects, entry, pack)));
      }
    }
    return JSON.stringify([root, common, digest(JSON.stringify([identity, gitFile, commonFile, head,
      gitDirectoryIdentity(dir), gitDirectoryIdentity(common), gitDirectoryIdentity(resolve(common, 'refs')), configs, objectStamps]))]);
  } catch { return null; } // Metadata/read errors never substitute for the command's original result or refusal.
}
export function gitBytes(cwd: string, args: string[], input?: Uint8Array): Buffer {
  gitEntries++; // PF4: even a successful memo hit is a Git-dependent read, before lookup.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const eligible = input === undefined && immutableGitRead(args) && JSON.stringify(args).length <= 4096;
  // Unknown commands/options may write. These read-only verbs leave existing immutable entries available.
  if (!['rev-parse', 'status', 'ls-tree', 'ls-files', 'show', 'cat-file', 'diff', 'diff-tree', 'rev-list', 'merge-base',
    'for-each-ref', 'check-ignore', 'var'].includes(args[0]!)) clearGitMemo();
  const context = eligible ? gitMemoContext(cwd, env) : null;
  const key = context === null ? null : JSON.stringify([context, args]);
  const saved = key === null ? undefined : gitMemo.get(key);
  if (saved && key) { gitMemo.delete(key); gitMemo.set(key, saved); return Buffer.from(saved.bytes); }
  const bytes = runGit(cwd, args, env, input);
  if (key && gitMemoContext(cwd, env) === context) rememberGit(key, bytes);
  return bytes;
}
function requireCommand(command: Command): void {
  requireCondition(command && typeof command.executable === "string" && command.executable.length > 0
    && Array.isArray(command.args) && command.args.every(arg => typeof arg === "string"), "command_unavailable", "Executable and argument array are required");
}
function requireRoleBinding(roleName: EnvironmentRole, role: RoleBinding): void {
  requireCondition(role && typeof role.actor === "string" && role.actor.trim()
    && typeof role.model === "string" && role.model.trim() && ["low", "medium", "high", "xhigh", "max", "ultra"].includes(role.effort)
    && (role.speed === undefined || ["inherited", "fast"].includes(role.speed)),
  "role_invalid", `The ${roleName} role needs an identity, model and supported effort`);
  requireCommand(role.command);
  const contract = role.commandContract;
  requireCondition(contract === undefined || contract === UNIVERSAL_ROLE_COMMAND || contract === MODE_ROLE_COMMANDS,
    "role_invalid", `The ${roleName} command contract must be universal or mode-specific`);
  if (contract === undefined || contract === UNIVERSAL_ROLE_COMMAND) {
    requireCondition(role.modeCommands === undefined, "role_invalid", "A universal role cannot carry mode-specific commands",
    );
    return;
  }
  requireCondition(role.modeCommands !== null && typeof role.modeCommands === "object" && !Array.isArray(role.modeCommands),
    "role_invalid", `The ${roleName} mode-specific role declares its command cells`);
  const allowed = roleName === "implementer" ? ["implement", "chat"] : ["review"];
  const names = Object.keys(role.modeCommands!);
  requireCondition(names.every(name => allowed.includes(name)), "role_invalid", "A role carries only commands for its own modes",
  );
  for (const name of names) requireCommand(role.modeCommands![name as keyof RoleModeCommands]!);
}
/** One pure choice for every invocation and M8 check. The caller supplies the internal product role and purpose. */
export function resolveRoleMode(roleName: EnvironmentRole | "reader", role: RoleBinding, mode: RoleMode): RoleBinding {
  const allowed = roleName === "implementer" ? ["research", "implement", "chat"]
    : roleName === "reviewer" ? ["research", "review"] : ["research"];
  const command = allowed.includes(mode) && mode !== "research" && role.commandContract === MODE_ROLE_COMMANDS
    ? role.modeCommands?.[mode as keyof RoleModeCommands] : allowed.includes(mode) ? role.command : undefined;
  if (!command) throw new EngineError("role_mode_missing", `The ${roleName} role has no ${mode} command`, { role: roleName, mode });
  requireCommand(command);
  return command === role.command ? role : { ...role, command };
}
function configuredRole(role: RoleBinding): RoleBinding {
  return role.commandContract === undefined ? { ...role, commandContract: UNIVERSAL_ROLE_COMMAND } : role;
}
function configuredCommands(role: RoleBinding): Command[] {
  return [role.command, ...Object.values(role.modeCommands ?? {})];
}
export function executablePath(command: Command, cwd: string): string {
  requireCommand(command);
  const candidates = isAbsolute(command.executable) || /[\\/]/.test(command.executable)
    ? [resolve(cwd, command.executable)] : (process.env['PATH'] ?? "").split(delimiter).map(path => resolve(cwd, path || '.', command.executable));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return realpathSync(candidate); } catch { /* try next PATH entry */ }
  }
  throw new EngineError("command_unavailable", `Executable is not available: ${command.executable}`);
}
export function workspacePath(root: string, path: string): string {
  requireCondition(safeRelativePath(path), "path_invalid", "Work paths must be explicit relative paths");
  const base = realpathSync(root); const target = resolve(base, path);
  let ancestor = target;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) { const next = dirname(ancestor); requireCondition(next !== ancestor, "path_invalid", "Path has no existing ancestor"); ancestor = next; }
  const resolved = realpathSync(ancestor); const within = relative(base, resolved);
  requireCondition(within !== ".." && !within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(within), "path_escape", "Work path escapes the selected repository");
  requireCondition(!path.split("/").includes(".git"), "path_invalid", "Git metadata cannot be a work target");
  requireCondition(!within.split(/[\\/]/).some(part => part.toLowerCase() === ".git"),
    "path_invalid", "A work path cannot resolve into Git metadata");
  return target;
}
/**
 * ENV1: the exact Git root of a workspace and its resolvable HEAD and tree, read now — a local observation of the moment,
 * never a lasting proof and not the M8 inspection (no write scope, files, tests or executors). Dirty is shown, not refused.
 */
export interface RepositoryHead { root: string; head: string; tree: string; dirty: boolean }
export function repositoryHead(workspace: string): RepositoryHead {
  let root: string;
  try { root = realpathSync(workspace); }
  catch { throw new EngineError("repository_unavailable", "The workspace does not exist", { target: workspace }); }
  let top: string;
  try { top = realpathSync(git(root, ["rev-parse", "--show-toplevel"])); }
  catch { throw new EngineError("repository_unavailable", "The workspace is not a Git repository", { target: root }); }
  if (top !== root) throw new EngineError("repository_root", "Select the Git repository root, not a folder inside it", { target: root, root: top });
  let head: string, tree: string;
  try { head = git(root, ["rev-parse", "--verify", "HEAD"]); tree = git(root, ["rev-parse", "HEAD^{tree}"]); }
  catch { throw new EngineError("repository_head_missing", "The repository has no commit yet", { target: root }); }
  return { root, head, tree, dirty: git(root, ["status", "--porcelain", "--untracked-files=all"]) !== "" };
}
/** ENV1: the script a `node <file>` command runs — a path to look at when the form names one; never its content or auth. */
export function commandModulePath(command: Command, cwd: string): string | null {
  const first = command.args[0];
  return /^node(\.exe)?$/i.test(basename(command.executable)) && first !== undefined && !first.startsWith("-") && /\.[cm]?js$/.test(first)
    ? resolve(cwd, first) : null;
}
function repositoryStatus(root: string): { head: string | null; dirty: boolean } {
  const records = gitBytes(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']).toString('utf8').split('\0');
  let head: string | null | undefined, dirty = false;
  const valid = (condition: unknown) => requireCondition(condition, 'git_failed', 'Git command failed');
  valid(records.pop() === '');
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice(13);
      valid(head === undefined && (oid === '(initial)' || fullOid(oid)));
      head = oid === '(initial)' ? null : oid;
    } else if (!record.startsWith('# ')) {
      valid(/^[12u?!] /.test(record)); dirty = true;
      if (record.startsWith('2 ')) valid(++index < records.length && records[index] !== ''); // origPath is a pathname, never a header.
    }
  }
  valid(head !== undefined);
  return { head: head!, dirty };
}
export function inspectRepository(environment: Environment, graph: Graph): { state: RepositoryState | null; findings: Finding[] } {
  const findings: Finding[] = [];
  try {
    const root = realpathSync(environment.workspace);
    requireCondition(realpathSync(git(root, ["rev-parse", "--show-toplevel"])) === root, "repository_root", "Select the Git repository root");
    const status = repositoryStatus(root), head = status.head;
    requireCondition(head !== null, 'git_failed', 'Git command failed');
    const tree = git(root, ['rev-parse', `${head}^{tree}`]);
    if (status.dirty) findings.push({ code: "repository_dirty", target: root, message: "Repository has uncommitted changes" });
    for (const [role, binding, mode] of [["implementer", environment.implementer, "implement"], ["reviewer", environment.reviewer, "review"]] as const) {
      try { executablePath(resolveRoleMode(role, binding, mode).command, root); }
      catch (error) { findings.push({ code: error instanceof EngineError && error.code === "role_mode_missing" ? error.code : "executor_unavailable",
        target: `${role}:${mode}`, message: error instanceof Error ? error.message : "Selected executor is unavailable" }); }
    }
    if (environment.implementer.actor === environment.reviewer.actor) findings.push({ code: "reviewer_not_independent", target: "reviewer", message: "Implementer and reviewer identities must differ" });
    try { executablePath(environment.fullCheck, root); } catch { findings.push({ code: "check_unavailable", target: "fullCheck", message: "Full-run command is unavailable" }); }
    const files = new Map<string, string | null>();
    for (const node of graph.nodes.filter(item => graph.horizon.includes(item.id))) {
      if (!node.code.some(ref => ref.access === "write")) findings.push({ code: "write_scope_missing", target: node.id, message: "Work node needs explicit write paths" });
      for (const ref of node.code) {
        try {
          const path = workspacePath(root, ref.path);
          if (existsSync(path)) {
            requireCondition(statSync(path).isFile(), "file_required", "Code references must point to regular files");
            files.set(ref.path, digest(readFileSync(path)));
          } else { files.set(ref.path, null); if (ref.status === "existing") findings.push({ code: "source_missing", target: ref.path, message: "An existing code reference is missing" }); }
        } catch (error) { findings.push({ code: "path_invalid", target: ref.path, message: error instanceof Error ? error.message : "Invalid path" }); }
      }
      for (const id of node.tests) {
        const test = graph.tests.find(item => item.id === id);
        try { requireCondition(test, "test_missing", "Product test is missing"); executablePath(test.command, root); }
        catch { findings.push({ code: "test_unavailable", target: id, message: "Product test command is unavailable" }); }
      }
    }
    return { state: { root, head, tree, files: [...files].map(([path, hash]) => ({ path, hash })).sort((a, b) => a.path.localeCompare(b.path)) }, findings };
  } catch (error) { findings.push({ code: "repository_unavailable", target: environment.workspace, message: error instanceof Error ? error.message : "Repository unavailable" }); return { state: null, findings }; }
}
function requireEnvironmentCapacity(project: string, value: { requestCapacityChars?: unknown; webResearch?: unknown }): void {
  if (Object.hasOwn(value, "requestCapacityChars") && !isRequestCapacityChars(value.requestCapacityChars))
    throw new EngineError("environment_invalid", "Request capacity must be a positive safe integer measured in characters",
      { target: `environment:${project}`, field: "requestCapacityChars" });
  if (Object.hasOwn(value, "webResearch")) requireWebResearchSettings(project, value.webResearch);
}
/** The saved contract is pure: historical reads never recheck PATH, files or repository heads. */
function requireSavedEnvironment(project: string, value: Environment): void {
  requireCondition(value && value.projectId === project && typeof value.workspace === "string"
    && isAbsolute(value.workspace) && resolve(value.workspace) === value.workspace
    && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 100 && value.timeoutMs <= 3_600_000,
    "environment_invalid", "A saved environment has its project, normalized absolute workspace and bounded timeout");
  requireEnvironmentCapacity(project, value);
  requireRoleBinding("implementer", value.implementer);
  requireRoleBinding("reviewer", value.reviewer);
  requireCommand(value.fullCheck);
  requireCondition(value.implementer.actor !== value.reviewer.actor, "reviewer_not_independent", "Implementer and reviewer must differ");
}
export function readEnvironmentAt(store: Store, project: string, ref: Ref): Revision<Environment> {
  requireCondition(store instanceof Store && typeof project === "string" && project.length > 0 && isRef(ref),
    "environment_invalid", "Environment history needs a project and full reference");
  const record = store.get<Environment>(ref.id, ref.revision);
  requireCondition(record && record.id === `environment:${project}` && record.kind === "environment"
    && record.revision === ref.revision && record.hash === ref.hash && hashJson(record.value) === ref.hash,
    "environment_invalid", "The exact historical environment must retain its complete identity and contents");
  requireSavedEnvironment(project, record.value);
  return record;
}

export class Environments {
  constructor(private readonly store: Store) {}
  configure(projectId: string, value: Omit<Environment, "projectId">, expected: number): Revision<Environment> {
    requireCondition(value && typeof value.workspace === "string" && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 100 && value.timeoutMs <= 3_600_000,
      "environment_invalid", "Workspace and a bounded timeout are required");
    requireEnvironmentCapacity(projectId, value);
    const workspace = realpathSync(value.workspace);
    const root = this.store.get<ExecutionRoot>(`execution-root:${projectId}`);
    requireCondition(!root || root.value.sourceRoot === workspace, "workspace_in_use", "Create a new project to use another repository after execution has begun");
    const saved: Environment = { ...value, workspace, projectId,
      implementer: configuredRole(value.implementer), reviewer: configuredRole(value.reviewer) };
    requireSavedEnvironment(projectId, saved);
    for (const command of [...configuredCommands(saved.implementer), ...configuredCommands(saved.reviewer), saved.fullCheck])
      executablePath(command, workspace);
    const selected = this.store.get<{ path: string }>(`workspace:${projectId}`);
    const writes: { id: string; kind: string; expected: number; value: unknown }[] = [
      { id: `environment:${projectId}`, kind: "environment", expected, value: saved },
    ];
    if (!selected || selected.value.path !== workspace) writes.push({ id: `workspace:${projectId}`, kind: "workspace", expected: selected?.revision ?? 0, value: { path: workspace } });
    return this.store.writeMany<Environment>(writes)[0]!;
  }
  get(projectId: string): Revision<Environment> {
    const environment = this.store.get<Environment>(`environment:${projectId}`);
    requireCondition(environment && environment.kind === "environment", "environment_missing", "Choose a workspace and executor roles first"); return environment;
  }
  effective(projectId: string): { environment: Revision<Environment>; root: string; guards: Ref[]; admissionGuards: TransactionGuard[] } {
    const environment = this.get(projectId); const execution = this.store.get<ExecutionRoot>(`execution-root:${projectId}`);
    if (!execution) return { environment, root: environment.value.workspace, guards: [], admissionGuards: [{ id: `execution-root:${projectId}`, absent: true }] };
    const workspace = this.store.get(`workspace:${projectId}`);
    requireCondition(execution.kind === "execution-root" && execution.value.projectId === projectId && execution.value.state === "ready"
      && workspace && execution.value.workspace.hash === workspace.hash && execution.value.sourceRoot === environment.value.workspace,
    "execution_root_recovery", "The managed worktree needs recovery before new planning");
    const current = execution.value;
    requireCondition(git(current.path, ["rev-parse", "HEAD"]) === current.head
      && git(current.path, ["symbolic-ref", "HEAD"]) === `refs/heads/${current.branch}`,
    "execution_root_recovery", "The managed worktree head differs from its accepted state");
    const common = (path: string) => realpathSync(resolve(path, git(path, ["rev-parse", "--git-common-dir"])));
    requireCondition(common(current.path) === common(current.sourceRoot), "execution_root_foreign", "Worktree belongs to another repository");
    return { environment, root: current.path, guards: [reference(execution)], admissionGuards: [] };
  }
}
