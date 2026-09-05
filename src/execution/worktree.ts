import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Store, type Revision } from "../storage/store.js";
import { git, Environments, type ExecutionRoot } from "../runtime/environment.js";
import type { MachinePlan } from "../compiler/model.js";
import { requireCondition } from "../errors.js";
import { reference } from "../pipeline/contracts.js";
import { digest } from "../canonical.js";

export function requireWorktree(root: ExecutionRoot, expectedHead: string): void {
  const common = (path: string) => realpathSync(resolve(path, git(path, ["rev-parse", "--git-common-dir"])));
  requireCondition(common(root.path) === common(root.sourceRoot)
    && realpathSync(git(root.path, ["rev-parse", "--show-toplevel"])) === realpathSync(root.path)
    && git(root.path, ["symbolic-ref", "HEAD"]) === `refs/heads/${root.branch}`
    && git(root.path, ["rev-parse", "HEAD"]) === expectedHead, "worktree_changed", "The managed branch, repository or parent changed");
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
  return record;
}
