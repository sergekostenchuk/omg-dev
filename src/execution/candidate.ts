import { lstatSync, realpathSync } from "node:fs";
import { dirname, relative } from "node:path";
import { git, gitBytes, workspacePath, type ExecutionRoot } from "../runtime/environment.js";
import type { CompiledTask } from "../compiler/model.js";
import { requireCondition } from "../errors.js";
import { requireWorktree } from "./worktree.js";
import { requireCandidateBytes } from "./candidate-bytes.js";

export function requireWritePaths(root: string, paths: string[]): void {
  const base = realpathSync(root);
  for (const path of paths) {
    let target = workspacePath(base, path);
    const file = lstatSync(target, { throwIfNoEntry: false });
    requireCondition(!file || (file.isFile() && file.nlink === 1), "work_file_invalid", "A write target must be a regular file without hard links");
    while (relative(base, target)) {
      requireCondition(!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink(), "work_path_alias", "Execution paths cannot traverse symlinks");
      const parent = dirname(target);
      requireCondition(parent !== target, "path_escape", "The write target has no common repository ancestor");
      target = parent;
    }
  }
}
export function capture(root: ExecutionRoot, parent: string, task: CompiledTask): string {
  requireWorktree(root, parent); requireWritePaths(root.path, task.writePaths);
  const changes = [...gitBytes(root.path, ["diff", "--name-only", "-z", parent]).toString("utf8").split("\0"),
    ...gitBytes(root.path, ["ls-files", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0")].filter(Boolean);
  requireCondition(changes.every(path => task.writePaths.includes(path)), "write_scope_exceeded", "The candidate changed files outside its map boundary");
  // A declared deletion may already be staged and absent from both index and disk.
  // Stage the owned tree, then bind the scope of the actual resulting tree as well.
  git(root.path, ["add", "--all", "--", "."]);
  const tree = git(root.path, ["write-tree"]);
  const actual = gitBytes(root.path, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", parent, tree])
    .toString("utf8").split("\0").filter(Boolean);
  requireCondition(actual.every(path => task.writePaths.includes(path)), "write_scope_exceeded", "The captured tree contains a change outside the task's scope");
  requireCandidateBytes(root.path, tree);
  // The actual diff is also the empty check: it is empty exactly when the captured tree is the parent's.
  requireCondition(actual.length > 0, "candidate_empty", "The task produced no code change");
  return tree;
}
