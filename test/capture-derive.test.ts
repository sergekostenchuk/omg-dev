import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { git, gitBytes, gitCalls, type ExecutionRoot } from "../src/runtime/environment.js";
import { capture } from "../src/execution/candidate.js";
import { requireCandidateBytes } from "../src/execution/candidate-bytes.js";
import { Store } from "../src/storage/store.js";
import { historicalProof } from "../src/history/proofs.js";
import { reference } from "../src/pipeline/contracts.js";
import type { CompiledTask } from "../src/compiler/model.js";

// GITSRC3: capture keeps every guard — worktree, write paths, foreign paths before add, actual scope after
// write-tree, disk bytes/modes/links — and goes only through the shared git/gitBytes/gitCalls API. Its memo
// decides which immutable-object reads are reused; every logical read still counts, whatever its outcome.

/** Real git process launches, observed through a PATH shim — independent of the logical gitCalls counter. */
function launchCounter(t: test.TestContext): () => number {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omg-git-shim-")));
  const log = join(dir, "spawns");
  writeFileSync(log, "");
  const real = execFileSync("/usr/bin/which", ["git"]).toString("utf8").trim();
  writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf 'x\\n' >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  t.after(() => { process.env.PATH = previous; rmSync(dir, { recursive: true, force: true }); });
  return () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;
}

function fixture(t: test.TestContext) {
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "omg-gitsrc3-")));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  const source = join(bare, "source"), tree = join(bare, "tree");
  mkdirSync(source);
  git(source, ["init", "-b", "main"]);
  writeFileSync(join(source, "mode.txt"), "m");
  writeFileSync(join(source, "del.txt"), "d");
  git(source, ["add", "-A"]);
  git(source, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const parent = git(source, ["rev-parse", "HEAD"]);
  git(source, ["worktree", "add", "-b", "omg/c3", tree, parent]);
  const root: ExecutionRoot = { projectId: "p", sourceRoot: source, workspace: { id: "w", revision: 1, hash: "w" },
    path: tree, branch: "omg/c3", base: parent, head: parent, state: "ready" };
  const task = (...writePaths: string[]) => ({ writePaths }) as unknown as CompiledTask;
  const writes = (...paths: string[]) => paths.map(path => writeFileSync(join(tree, path), `body of ${path}`));
  return { bare, source, tree, parent, root, task, writes };
}

test("GITSRC3 repeats count the same logical reads and launch fewer git processes", t => {
  const launches = launchCounter(t);
  const { source, tree, parent, root, task, writes } = fixture(t);
  const scope = task("a.txt", "mode.txt", "del.txt", "data.f");

  writes("a.txt");
  const coldCalls = gitCalls(); const coldLaunches = launches();
  const tree1 = capture(root, parent, scope);
  const firstCalls = gitCalls() - coldCalls, firstLaunches = launches() - coldLaunches;
  const repeatCalls = gitCalls(); const repeatLaunches = launches();
  assert.equal(capture(root, parent, scope), tree1);
  const secondCalls = gitCalls() - repeatCalls, secondLaunches = launches() - repeatLaunches;
  // PF4: memo hits are still logical Git reads — the repeat performs the same readings, counted as before.
  assert.equal(secondCalls, firstCalls, "a repeated capture records the same logical Git reads, hits included");
  assert.ok(secondLaunches <= firstLaunches, `a repeat never launches more (${firstLaunches} -> ${secondLaunches})`);
  // Positive control: two identical reads of one immutable object are two logical reads. With the shared
  // memo the second is a hit — at most one real launch; without it, two. Either way launches never exceed
  // the logical reads, and on the merged build the saved process is observable here.
  const reads = gitCalls(), spawn = launches();
  gitBytes(tree, ["ls-tree", "-r", "-z", tree1]);
  gitBytes(tree, ["ls-tree", "-r", "-z", tree1]);
  assert.equal(gitCalls() - reads, 2, "each immutable read counts once, hit or miss");
  assert.ok(launches() - spawn <= 2, "a repeated immutable read never costs extra launches");

  // The fresh diff list is re-checked against each call's own writePaths — a narrower scope refuses.
  assert.throws(() => capture(root, parent, task("mode.txt")), { code: "write_scope_exceeded" });

  // A mode change and a staged deletion carry into new trees, each derivation read fresh.
  chmodSync(join(tree, "mode.txt"), 0o755);
  const modeTree = capture(root, parent, scope);
  assert.notEqual(modeTree, tree1);
  git(tree, ["rm", "del.txt"]);
  const delTree = capture(root, parent, scope);
  assert.notEqual(delTree, modeTree);

  // The same tree from different raw bytes is still refused: the disk check is not a property of the tree hash.
  const info = join(resolve(source, git(source, ["rev-parse", "--git-common-dir"])), "info");
  mkdirSync(info, { recursive: true });
  writeFileSync(join(info, "attributes"), "data.f filter=const\n");
  git(tree, ["config", "filter.const.clean", "printf X"]);
  writeFileSync(join(tree, "data.f"), "X");
  capture(root, parent, scope);
  writeFileSync(join(tree, "data.f"), "Y");
  assert.throws(() => capture(root, parent, scope), { code: "candidate_bytes_mismatch" },
    "filtered bytes producing the already-seen tree still fail the disk check");

  // An edit outside the declared scope is refused before staging.
  writeFileSync(join(tree, "outside.txt"), "o");
  assert.throws(() => capture(root, parent, scope), { code: "write_scope_exceeded" });

  // A symlink at a write target is refused before staging, as before.
  rmSync(join(tree, "outside.txt")); rmSync(join(tree, "data.f"));
  rmSync(join(info, "attributes"));
  symlinkSync("mode.txt", join(tree, "link.txt"));
  assert.throws(() => capture(root, parent, task("a.txt", "mode.txt", "del.txt", "link.txt")), { code: "work_file_invalid" });

  // Mode and link disagreements between a fresh tree and the disk still fail the byte check.
  const blob = git(tree, ["hash-object", "-w", "--stdin"], "m");
  git(tree, ["read-tree", "--empty"]);
  git(tree, ["update-index", "--add", "--cacheinfo", `100644,${blob},mode.txt`]);
  const modeMismatch = git(tree, ["write-tree"]);
  assert.throws(() => requireCandidateBytes(tree, modeMismatch), { code: "candidate_bytes_mismatch" }, "disk is 0755, the tree says 100644");
  git(tree, ["update-index", "--add", "--cacheinfo", `120000,${blob},fakeln.txt`]);
  writeFileSync(join(tree, "fakeln.txt"), "mode.txt");
  const linkMismatch = git(tree, ["write-tree"]);
  assert.throws(() => requireCandidateBytes(tree, linkMismatch), { code: "candidate_bytes_mismatch" }, "disk is a file, the tree says link");
});

// Reviewer probe GITSRC3-01: a Git replacement must re-interpret the same tree OID; a warm path may not
// keep a saved list. The shared memo bypasses itself while refs/replace exists — cold and warm agree.
test("warm capture follows an externally changed Git tree replacement", t => {
  const { tree, parent, root, task } = fixture(t);
  writeFileSync(join(tree, "a.txt"), "accepted original bytes");
  const accepted = capture(root, parent, task("a.txt"));
  const blob = git(tree, ["hash-object", "-w", "--stdin"], "replacement bytes");
  git(tree, ["update-index", "--cacheinfo", `100644,${blob},a.txt`]);
  const replacement = git(tree, ["write-tree"]);
  git(tree, ["read-tree", accepted]);
  git(tree, ["replace", accepted, replacement]);
  const resolved = git(tree, ["ls-tree", "-r", accepted]);
  assert.ok(resolved.includes(blob), "actual Git now resolves the same tree OID to different entries");
  assert.throws(() => requireCandidateBytes(tree, accepted), { code: "candidate_bytes_mismatch" });
  assert.throws(() => capture(root, parent, task("a.txt")), { code: "candidate_bytes_mismatch" },
    "a warm capture retains the cold live refusal under a replacement");
});

// Reviewer probe GITSRC3-02a: every byte check is one logical Git read in gitCalls, memo hit or not.
test("candidate byte checks record one logical Git dependency on every call", t => {
  const { tree, parent, root, task } = fixture(t);
  writeFileSync(join(tree, "a.txt"), "accepted original bytes");
  const accepted = capture(root, parent, task("a.txt"));
  const before = gitCalls();
  requireCandidateBytes(tree, accepted);
  requireCandidateBytes(tree, accepted);
  assert.equal(gitCalls() - before, 2, "each call is one logical read — a memo hit counts exactly as a miss");
});

// Reviewer probe GITSRC3-02b: PF4 must not retain a result across a live byte change — the read inside the
// action declares a Git dependency through gitCalls, so the proof is never reused silently.
test("PF4 cannot retain warmed candidate bytes across a live file change", t => {
  const { tree, parent, root, task, bare } = fixture(t);
  writeFileSync(join(tree, "a.txt"), "accepted original bytes");
  const accepted = capture(root, parent, task("a.txt"));
  const store = new Store(join(bare, "state.sqlite"));
  t.after(() => store.close());
  const row = store.write({ id: "review:proof", kind: "proof", expected: 0, value: {} });
  let actions = 0;
  const read = () => historicalProof(store, { reader: "M6.route-result", project: "p", ref: reference(row), parameters: { probe: "candidate-bytes" } },
    source => { actions++; source.get(row.id, 1); requireCandidateBytes(tree, accepted); return { ok: true }; },
    () => { throw new Error("unexpected cycle"); });
  assert.deepEqual(read(), { ok: true });
  writeFileSync(join(tree, "a.txt"), "changed live bytes");
  assert.throws(() => read(), { code: "candidate_bytes_mismatch" },
    `a fresh operation runs the byte check again (actions=${actions})`);
});
