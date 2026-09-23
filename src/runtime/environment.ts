import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Store, type Revision } from "../storage/store.js";
import { requireCondition, EngineError } from "../errors.js";
import { digest } from "../canonical.js";
import type { Command, Graph } from "../graph/model.js";
import { safeRelativePath } from "../graph/topology.js";
import { reference, type Ref, type Finding } from "../pipeline/contracts.js";

export interface RoleBinding { actor: string; model: string; effort: string; command: Command; speed?: "fast" | "inherited" }
export interface Environment {
  projectId: string; workspace: string; implementer: RoleBinding; reviewer: RoleBinding;
  fullCheck: Command; timeoutMs: number;
  requestCapacityChars?: number;
}
export function isRequestCapacityChars(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export interface RepositoryState { root: string; head: string; tree: string; files: { path: string; hash: string | null }[] }
export interface ExecutionRoot { projectId: string; sourceRoot: string; workspace: Ref; path: string; branch: string; base: string; head: string; state: "creating" | "ready" }
export function git(cwd: string, args: string[], input?: string): string {
  return gitBytes(cwd, args, input === undefined ? undefined : Buffer.from(input)).toString("utf8").trim();
}
export function gitBytes(cwd: string, args: string[], input?: Uint8Array): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env, input, timeout: 15_000, maxBuffer: 8_000_000 });
  if (result.error || result.status !== 0) throw new EngineError("git_failed", "Git command failed", { action: args[0], stderr: result.stderr?.toString("utf8"), error: result.error?.message });
  return result.stdout;
}
export function executablePath(command: Command, cwd: string): string {
  requireCondition(command && typeof command.executable === "string" && command.executable.length > 0
    && Array.isArray(command.args) && command.args.every(arg => typeof arg === "string"), "command_unavailable", "Executable and argument array are required");
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
export function inspectRepository(environment: Environment, graph: Graph): { state: RepositoryState | null; findings: Finding[] } {
  const findings: Finding[] = [];
  try {
    const root = realpathSync(environment.workspace);
    requireCondition(realpathSync(git(root, ["rev-parse", "--show-toplevel"])) === root, "repository_root", "Select the Git repository root");
    const head = git(root, ["rev-parse", "HEAD"]); const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
    if (git(root, ["status", "--porcelain", "--untracked-files=all"])) findings.push({ code: "repository_dirty", target: root, message: "Repository has uncommitted changes" });
    for (const [role, binding] of [["implementer", environment.implementer], ["reviewer", environment.reviewer]] as const) {
      try { executablePath(binding.command, root); } catch { findings.push({ code: "executor_unavailable", target: role, message: "Selected executor is unavailable" }); }
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
export class Environments {
  constructor(private readonly store: Store) {}
  configure(projectId: string, value: Omit<Environment, "projectId">, expected: number): Revision<Environment> {
    requireCondition(value && typeof value.workspace === "string" && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 100 && value.timeoutMs <= 3_600_000,
      "environment_invalid", "Workspace and a bounded timeout are required");
    // Absence belongs to the previous era; never materialize a default in saved environments.
    if (Object.hasOwn(value, "requestCapacityChars") && !isRequestCapacityChars(value.requestCapacityChars))
      throw new EngineError("environment_invalid", "Request capacity must be a positive safe integer measured in characters",
        { target: `environment:${projectId}`, field: "requestCapacityChars" });
    const workspace = realpathSync(value.workspace);
    const root = this.store.get<ExecutionRoot>(`execution-root:${projectId}`);
    requireCondition(!root || root.value.sourceRoot === workspace, "workspace_in_use", "Create a new project to use another repository after execution has begun");
    for (const role of [value.implementer, value.reviewer]) requireCondition(role && typeof role.actor === "string" && role.actor.trim()
      && typeof role.model === "string" && role.model.trim() && ["low", "medium", "high", "xhigh", "max", "ultra"].includes(role.effort)
      && (role.speed === undefined || ["inherited", "fast"].includes(role.speed)),
    "role_invalid", "Each role needs an identity, model and supported effort");
    executablePath(value.implementer.command, workspace); executablePath(value.reviewer.command, workspace); executablePath(value.fullCheck, workspace);
    requireCondition(value.implementer.actor !== value.reviewer.actor, "reviewer_not_independent", "Implementer and reviewer must differ");
    const selected = this.store.get<{ path: string }>(`workspace:${projectId}`);
    const writes: { id: string; kind: string; expected: number; value: unknown }[] = [
      { id: `environment:${projectId}`, kind: "environment", expected, value: { ...value, workspace, projectId } },
    ];
    if (!selected || selected.value.path !== workspace) writes.push({ id: `workspace:${projectId}`, kind: "workspace", expected: selected?.revision ?? 0, value: { path: workspace } });
    return this.store.writeMany<Environment>(writes)[0]!;
  }
  get(projectId: string): Revision<Environment> {
    const environment = this.store.get<Environment>(`environment:${projectId}`);
    requireCondition(environment && environment.kind === "environment", "environment_missing", "Choose a workspace and executor roles first"); return environment;
  }
  effective(projectId: string): { environment: Revision<Environment>; root: string; guards: Ref[] } {
    const environment = this.get(projectId); const execution = this.store.get<ExecutionRoot>(`execution-root:${projectId}`);
    if (!execution) return { environment, root: environment.value.workspace, guards: [] };
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
    return { environment, root: current.path, guards: [reference(execution)] };
  }
}
