import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitCalls, type ExecutionRoot } from "../src/runtime/environment.js";
import { requireWorktree } from "../src/execution/worktree.js";

// GITSRC1: requireWorktree proves the managed worktree with one joined rev-parse per cwd; the separate
// reads stay on the error path only, so every historical refusal keeps its code.
test("GITSRC1 requireWorktree proves a linked worktree in two git calls and keeps the refusal classes", t => {
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "omg-gitsrc1-")));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  const source = join(bare, "source"), tree = join(bare, "tree");
  mkdirSync(source);
  git(source, ["init", "-b", "main"]);
  writeFileSync(join(source, "file.txt"), "x");
  git(source, ["add", "file.txt"]);
  git(source, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const head = git(source, ["rev-parse", "HEAD"]);
  git(source, ["worktree", "add", "-b", "omg/g1", tree, head]);
  const root: ExecutionRoot = { projectId: "p", sourceRoot: source, workspace: { id: "w", revision: 1, hash: "w" },
    path: tree, branch: "omg/g1", base: head, head, state: "ready" };

  // Linked worktree: two launches — the joined read at root.path and common-dir at sourceRoot.
  const before = gitCalls();
  requireWorktree(root, head);
  assert.equal(gitCalls() - before, 2, "joined rev-parse at the worktree plus common-dir at the source");

  // A foreign repository at the managed path does not share the common dir.
  const foreign = join(bare, "foreign");
  mkdirSync(foreign);
  git(foreign, ["init", "-b", "omg/g1"]);
  writeFileSync(join(foreign, "file.txt"), "x");
  git(foreign, ["add", "file.txt"]);
  git(foreign, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  assert.throws(() => requireWorktree({ ...root, path: foreign }, git(foreign, ["rev-parse", "HEAD"])), { code: "worktree_changed" },
    "same branch name and own HEAD in a foreign repository is not the managed worktree");

  // Another branch at the same HEAD inside the shared repository is not the managed branch.
  git(tree, ["checkout", "-b", "omg/other"]);
  assert.throws(() => requireWorktree({ ...root, branch: "omg/g1" }, head), { code: "worktree_changed" });
  git(tree, ["checkout", "omg/g1"]);

  // Detached HEAD keeps the historical git_failed of symbolic-ref, not worktree_changed.
  git(tree, ["checkout", "--detach", head]);
  assert.throws(() => requireWorktree(root, head), { code: "git_failed" });
  git(tree, ["checkout", "omg/g1"]);

  // A moved HEAD at the same branch is the changed worktree.
  writeFileSync(join(tree, "file.txt"), "y");
  git(tree, ["add", "file.txt"]);
  git(tree, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "moved"]);
  assert.throws(() => requireWorktree(root, head), { code: "worktree_changed" });
  requireWorktree(root, git(tree, ["rev-parse", "HEAD"]));

  // The worktree removed from its path keeps the historical git_failed of the common-dir read.
  rmSync(tree, { recursive: true, force: true });
  assert.throws(() => requireWorktree(root, git(source, ["rev-parse", "omg/g1"])), { code: "git_failed" });
});

// GITSRC1-01: a legal LF inside a real path makes the joined answer ambiguous (an added line) — it must be
// routed to the separate reads, which never split a path on LF, instead of failing normalization.
test("GITSRC1-01 real paths containing a newline are accepted through the separate reads", t => {
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "omg-gitsrc1-lf-")));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  const repo = (directory: string, branch: string) => {
    mkdirSync(directory);
    git(directory, ["init", "-b", "main"]);
    writeFileSync(join(directory, "file.txt"), "x");
    git(directory, ["add", "file.txt"]);
    git(directory, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
    const head = git(directory, ["rev-parse", "HEAD"]), tree = join(bare, `tree-${branch}`);
    git(directory, ["worktree", "add", "-b", `omg/${branch}`, tree, head]);
    return { head, tree };
  };

  // LF inside sourceRoot: the joined common-dir line carries it, so the answer is ambiguous.
  const inSource = repo(join(bare, "source\nsecond-line"), "lfs");
  const sourceRoot = join(bare, "source\nsecond-line");
  requireWorktree({ projectId: "p", sourceRoot, workspace: { id: "w", revision: 1, hash: "w" },
    path: inSource.tree, branch: "omg/lfs", base: inSource.head, head: inSource.head, state: "ready" }, inSource.head);

  // LF inside root.path: the joined toplevel line carries it — same ambiguity class.
  const plain = repo(join(bare, "source2"), "lft");
  const lfTree = join(bare, "tree\nsecond-line");
  git(join(bare, "source2"), ["worktree", "add", "-b", "omg/lft2", lfTree, plain.head]);
  requireWorktree({ projectId: "p", sourceRoot: join(bare, "source2"), workspace: { id: "w", revision: 1, hash: "w" },
    path: lfTree, branch: "omg/lft2", base: plain.head, head: plain.head, state: "ready" }, plain.head);
});
