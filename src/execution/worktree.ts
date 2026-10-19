import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Store, type Revision } from "../storage/store.js";
import { git, gitBytes, Environments, type ExecutionRoot } from "../runtime/environment.js";
import type { MachinePlan } from "../compiler/model.js";
import { EngineError, requireCondition } from "../errors.js";
import { reference } from "../pipeline/contracts.js";
import { digest } from "../canonical.js";

export function requireWorktree(root: ExecutionRoot, expectedHead: string): void {
  const common = (path: string) => realpathSync(resolve(path, git(path, ["rev-parse", "--git-common-dir"])));
  // GITSRC1: one joined rev-parse per cwd (common-dir, toplevel, HEAD sha, symbolic name in argument
  // order). An ambiguous answer, a git failure or a mismatched field reruns the historical separate
  // sequence, so the old refusal classes stand.
  const separate = (): void => {
    requireCondition(common(root.path) === common(root.sourceRoot)
      && realpathSync(git(root.path, ["rev-parse", "--show-toplevel"])) === realpathSync(root.path)
      && git(root.path, ["symbolic-ref", "HEAD"]) === `refs/heads/${root.branch}`
      && git(root.path, ["rev-parse", "HEAD"]) === expectedHead, "worktree_changed", "The managed branch, repository or parent changed");
  };
  let same = false;
  try {
    const fields = git(root.path, ["rev-parse", "--git-common-dir", "--show-toplevel", "HEAD", "--symbolic-full-name", "HEAD"]).split("\n");
    // A newline inside a real path adds a line, so only an exactly-four-field answer is unambiguous.
    same = fields.length === 4
      && realpathSync(resolve(root.path, fields[0]!)) === common(root.sourceRoot)
      && realpathSync(fields[1]!) === realpathSync(root.path)
      && fields[3] === `refs/heads/${root.branch}`
      && fields[2] === expectedHead;
  } catch {
    return separate();
  }
  if (!same) return separate();
}
export function materializeWorktree(root: ExecutionRoot): void {
  mkdirSync(dirname(root.path), { recursive: true });
  if (!existsSync(join(root.path, ".git"))) {
    const branch = git(root.sourceRoot, ["for-each-ref", "--format=%(objectname)", `refs/heads/${root.branch}`]);
    requireCondition(!branch || branch === root.base, "worktree_foreign", "An existing branch differs from the creation intent");
    git(root.sourceRoot, ["worktree", "add", ...(branch ? [] : ["-b", root.branch]), root.path, branch ? root.branch : root.base]);
  }
  requireWorktree(root, root.head);
}
/**
 * EX1 C: the managed worktree reads the dependencies of its source workspace, as the workspace itself does. The link is
 * made only where Git ignores it, so it never enters a candidate; an existing entry must already be that link. Nothing is
 * installed and nothing is fetched.
 */
export function linkDependencies(root: ExecutionRoot): void {
  const source = join(root.sourceRoot, "node_modules");
  if (!existsSync(source)) return;
  const target = join(root.path, "node_modules"), real = realpathSync(source), present = lstatSync(target, { throwIfNoEntry: false });
  if (present) requireCondition(present.isSymbolicLink() && realpathSync(target) === real, "worktree_dependencies_invalid",
    "The worktree's dependencies must be the source workspace's own");
  else symlinkSync(real, target, "dir");
  // Git shows an entry it does not ignore as untracked; such a link would enter a candidate, so it is taken back at once.
  const untracked = gitBytes(root.path, ["status", "--porcelain", "-z", "--untracked-files=all"]).toString("utf8").split("\0")
    .filter(Boolean).map(line => line.slice(3));
  if (untracked.some(path => path === "node_modules" || path.startsWith("node_modules/"))) {
    if (!present) unlinkSync(target);
    throw new EngineError("worktree_dependencies_unsupported", "Dependencies are linked only where Git ignores them, so they never enter a candidate");
  }
}
export function ensureWorktree(store: Store, environments: Environments, plan: MachinePlan): Revision<ExecutionRoot> {
  const environment = environments.get(plan.projectId);
  let record = store.get<ExecutionRoot>(`execution-root:${plan.projectId}`);
  if (!record) {
    requireCondition(git(plan.base.root, ["rev-parse", "HEAD"]) === plan.base.head
      && !git(plan.base.root, ["status", "--porcelain", "--untracked-files=all"]), "repository_changed", "Repository changed after R3; refresh the map basis");
    const key = digest(`${store.databaseId}:${plan.projectId}`).slice(0, 24);
    const root: ExecutionRoot = { projectId: plan.projectId, sourceRoot: environment.value.workspace,
      workspace: reference(store.get(`workspace:${plan.projectId}`)!), path: join(dirname(store.path), "worktrees", key),
      branch: `omg/${key}`, base: plan.base.head, head: plan.base.head, state: "creating" };
    requireCondition(!existsSync(root.path), "worktree_exists", "Managed worktree path already exists without an ownership record");
    record = store.write({ id: `execution-root:${plan.projectId}`, kind: "execution-root", expected: 0, value: root });
  }
  requireCondition(record.value.sourceRoot === environment.value.workspace, "worktree_foreign", "Execution root belongs to another selected repository");
  if (record.value.state === "creating") {
    const root = record.value; materializeWorktree(root);
    record = store.write({ id: record.id, kind: record.kind, expected: record.revision, value: { ...root, state: "ready" } });
  }
  linkDependencies(record.value);
  return record;
}
