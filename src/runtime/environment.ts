import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkTransactionGuards, Store, type Revision, type TransactionGuard } from "../storage/store.js";
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
/** The gateway endpoint (a tunnel the launch provides) and its limits; the model passes only a query or URL. */
export interface WebResearchSettings { enabled: boolean; gatewayUrl: string; timeoutMs: number; limits: WebResearchLimits }
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
  const extra = Object.keys(settings).find(key => !["enabled", "gatewayUrl", "timeoutMs", "limits"].includes(key));
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
  return uniqueTransactionGuards(guards).every(guard => {
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
export function gitBytes(cwd: string, args: string[], input?: Uint8Array): Buffer {
  gitEntries++;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env, input, timeout: 15_000, maxBuffer: 8_000_000 });
  if (result.error || result.status !== 0) throw new EngineError("git_failed", "Git command failed", { action: args[0], stderr: result.stderr?.toString("utf8"), error: result.error?.message });
  return result.stdout;
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
export function inspectRepository(environment: Environment, graph: Graph): { state: RepositoryState | null; findings: Finding[] } {
  const findings: Finding[] = [];
  try {
    const root = realpathSync(environment.workspace);
    requireCondition(realpathSync(git(root, ["rev-parse", "--show-toplevel"])) === root, "repository_root", "Select the Git repository root");
    const head = git(root, ["rev-parse", "HEAD"]); const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
    if (git(root, ["status", "--porcelain", "--untracked-files=all"])) findings.push({ code: "repository_dirty", target: root, message: "Repository has uncommitted changes" });
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
