import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Store, type Revision } from "../storage/store.js";
import { requireCondition, EngineError } from "../errors.js";
import { digest } from "../canonical.js";
import type { Command, Graph } from "../graph/model.js";
import { safeRelativePath } from "../graph/topology.js";
import type { Finding } from "../pipeline/contracts.js";

export interface RoleBinding { actor: string; model: string; effort: string; command: Command }
export interface Environment {
  projectId: string; workspace: string; implementer: RoleBinding; reviewer: RoleBinding;
  fullCheck: Command; timeoutMs: number;
}
export interface RepositoryState { root: string; head: string; tree: string; files: { path: string; hash: string | null }[] }
export function git(cwd: string, args: string[], input?: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env, input, encoding: "utf8", timeout: 15_000, maxBuffer: 8_000_000 });
  if (result.error || result.status !== 0) throw new EngineError("git_failed", "Git command failed", { action: args[0], stderr: result.stderr, error: result.error?.message });
  return result.stdout.trim();
}
export function executablePath(command: Command, cwd: string): string {
  requireCondition(command && typeof command.executable === "string" && command.executable.length > 0
    && Array.isArray(command.args) && command.args.every(arg => typeof arg === "string"), "command_unavailable", "Executable and argument array are required");
  const candidates = isAbsolute(command.executable) || /[\\/]/.test(command.executable)
    ? [resolve(cwd, command.executable)] : (process.env['PATH'] ?? "").split(delimiter).map(path => resolve(path || cwd, command.executable));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return realpathSync(candidate); } catch { /* try next PATH entry */ }
  }
  throw new EngineError("command_unavailable", `Executable is not available: ${command.executable}`);
}
export function workspacePath(root: string, path: string): string {
  requireCondition(safeRelativePath(path), "path_invalid", "Work paths must be explicit relative paths");
  const base = realpathSync(root); const target = resolve(base, path);
  let ancestor = target;
  while (!existsSync(ancestor)) { const next = dirname(ancestor); requireCondition(next !== ancestor, "path_invalid", "Path has no existing ancestor"); ancestor = next; }
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
    const workspace = realpathSync(value.workspace);
    for (const role of [value.implementer, value.reviewer]) requireCondition(role && typeof role.actor === "string" && role.actor.trim()
      && typeof role.model === "string" && role.model.trim() && ["low", "medium", "high", "xhigh", "max", "ultra"].includes(role.effort),
    "role_invalid", "Each role needs an identity, model and supported effort");
    executablePath(value.implementer.command, workspace); executablePath(value.reviewer.command, workspace); executablePath(value.fullCheck, workspace);
    requireCondition(value.implementer.actor !== value.reviewer.actor, "reviewer_not_independent", "Implementer and reviewer must differ");
    return this.store.write<Environment>({ id: `environment:${projectId}`, kind: "environment", expected, value: { ...value, workspace, projectId } });
  }
  get(projectId: string): Revision<Environment> {
    const environment = this.store.get<Environment>(`environment:${projectId}`);
    requireCondition(environment && environment.kind === "environment", "environment_missing", "Choose a workspace and executor roles first"); return environment;
  }
}
