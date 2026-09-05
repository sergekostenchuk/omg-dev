import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, linkSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { executionFixture } from "./execution-fixture.js";
import { reference } from "../src/pipeline/contracts.js";
import { git, type ExecutionRoot } from "../src/runtime/environment.js";
import { Executor } from "../src/execution/runner.js";
import { receiptId, type ArtifactReceipt } from "../src/compiler/model.js";
import { resultGate } from "../src/execution/result.js";
import { resolveArtifact } from "../src/compiler/inputs.js";
import type { TaskRun } from "../src/execution/model.js";
import { treeFile } from "../src/runtime/git-files.js";
import { processStart } from "../src/runtime/process-identity.js";
import { requireWritePaths } from "../src/execution/candidate.js";

test("real executor processes consume compact context, run both gates and commit exact code receipts without changing the source branch", async t => {
  const f = executionFixture(t);
  const runs = await f.engine.execute({ type: "execute-plan", project: "p", plan: reference(f.plan), ...f.options }) as { value: TaskRun }[];
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"]);
  const root = f.store.get<ExecutionRoot>("execution-root:p")!;
  assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), f.initial);
  assert.equal(git(f.workspace, ["status", "--porcelain"]), "");
  assert.equal(git(root.value.path, ["rev-list", "--count", `${f.initial}..HEAD`]), "2");
  assert.match(readFileSync(join(root.value.path, "consume.mjs"), "utf8"), /produce/);
  const calls = f.calls(); assert.equal(calls.length, 4);
  for (const run of runs) for (const usage of run.value.usage) {
    const call = calls.find(item => item.hash === usage.requestHash)!;
    assert.equal(usage.requestChars, call.chars); assert.equal(usage.requestBytes, call.bytes); assert.ok(usage.responseBytes! > 0);
    assert.equal(Object.hasOwn(call.subject, "contracts"), false);
    assert.equal(call.subject.context.criteria.fullCheck.args[1], "all");
  }
  assert.ok(runs[0]!.value.checks.some(check => check.command.args.includes("mutation")));
  const receipt = f.store.get<ArtifactReceipt>(receiptId("p", "p-data"))!;
  assert.equal(receipt.value.value.files[0]!.path, "produce.mjs");
  assert.equal(typeof receipt.value.value.files[0]!.hash, "string");
  assert.equal(receipt.value.commit, runs[0]!.value.commit);
  assert.equal(f.store.get(receipt.value.run!.id, receipt.value.run!.revision)!.hash, receipt.value.run!.hash);
  assert.deepEqual(runs[1]!.value.inputs, [reference(receipt)]);
  assert.equal(f.engine.pipeline.inspect("p", "execution").state, "accepted");
  const result = f.store.list("execution-result")[0]!;
  assert.deepEqual(resultGate(f.store, "p", reference(result)).findings, []);
  f.reopen(); await f.engine.executor.run("p", reference(f.plan), f.options);
  assert.equal(f.calls().length, 4, "An accepted result must not rerun its agents or checks after reopen");
});

test("code corrections are bounded and automatic; a plan defect stops without retrying implementation", async t => {
  const f = executionFixture(t, "correct");
  const runs = await f.engine.executor.run("p", reference(f.plan), { ...f.options, maxCorrections: 1 });
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"]);
  assert.equal(runs[0]!.value.attempt, 2);
  assert.equal(f.calls().filter(call => call.mode === "implement").length, 4, "Each fixture task deliberately fails once, then corrects");
  const p = executionFixture(t, "plan-defect");
  const rejected = await p.engine.executor.run("p", reference(p.plan), { ...p.options, maxCorrections: 3 });
  assert.equal(rejected[0]!.value.state, "needs_plan"); assert.equal(p.calls().length, 2);
  await p.engine.executor.run("p", reference(p.plan), { ...p.options, retry: true, maxCorrections: 3 });
  assert.equal(p.calls().length, 2);
  assert.equal(git(p.store.get<ExecutionRoot>("execution-root:p")!.value.path, ["rev-parse", "HEAD"]), p.initial);
});

test("the Git-to-SQLite window resumes its exact commit once after cold reopen", async t => {
  const f = executionFixture(t); let crash = true;
  const executor = new Executor(f.store, f.engine.compiler, f.engine.environments, () => { if (crash) { crash = false; throw new Error("simulated owner death after Git publication"); } });
  await assert.rejects(executor.run("p", reference(f.plan), f.options), /simulated owner death/);
  const pending = f.store.list<TaskRun>("task-run")[0]!;
  assert.equal(pending.value.state, "commit_pending"); assert.equal(f.calls().length, 2);
  const branch = f.store.get<ExecutionRoot>("execution-root:p")!.value.path;
  assert.equal(git(branch, ["rev-parse", "HEAD"]), pending.value.commit);
  assert.equal(f.store.get(receiptId("p", "p-data")), null);
  f.reopen(); const runs = await f.engine.executor.run("p", reference(f.plan), f.options);
  assert.equal(runs[0]!.value.commit, pending.value.commit); assert.equal(f.calls().length, 4);
  assert.equal(git(branch, ["rev-list", "--count", `${f.initial}..HEAD`]), "2");
});

test("missing outputs, invented business values, scope escapes and insufficient context cannot produce accepted commits", async t => {
  for (const behavior of ["missing-output", "business-value", "scope"]) {
    const f = executionFixture(t, behavior);
    const result = await f.engine.executor.run("p", reference(f.plan), f.options);
    assert.notEqual(result[0]!.value.state, "committed"); assert.equal(result[0]!.value.commit, null);
    assert.equal(f.store.list("artifact").length, 0);
    assert.equal(git(f.store.get<ExecutionRoot>("execution-root:p")!.value.path, ["rev-parse", "HEAD"]), f.initial);
  }
  const f = executionFixture(t);
  const result = await f.engine.executor.run("p", reference(f.plan), { ...f.options, maxContextChars: 100 });
  assert.equal(result[0]!.value.state, "interrupted"); assert.equal(f.calls().length, 0);
  assert.match(result[0]!.value.error!, /essential context exceeds/);
});

test("committed implementation receipts cannot omit files or be rebound to a foreign accepted run", async t => {
  const f = executionFixture(t); await f.engine.executor.run("p", reference(f.plan), f.options);
  const root = f.store.get<ExecutionRoot>("execution-root:p")!.value;
  const repository = { root: root.path, head: root.head, tree: git(root.path, ["rev-parse", "HEAD^{tree}"]), files: [] };
  const read = () => resolveArtifact(f.store, "p", f.plan.value.graphSnapshot, repository, "p-produce-work", "p-data");
  assert.ok(read().receipt);
  const receipt = f.store.get<ArtifactReceipt>(receiptId("p", "p-data"))!;
  f.store.write({ id: receipt.id, kind: receipt.kind, expected: receipt.revision, value: { ...receipt.value, value: { files: [] } } });
  assert.throws(read, /exact write scope/);
  const otherRun = f.store.list<TaskRun>("task-run").find(run => run.value.taskId === f.plan.value.tasks[1]!.id)!;
  f.store.write({ id: receipt.id, kind: receipt.kind, expected: receipt.revision + 1,
    value: { ...receipt.value, run: reference(otherRun), commit: otherRun.value.commit, tree: otherRun.value.tree } });
  assert.throws(read, /accepted run/);
  const result = f.store.list<any>("execution-result")[0]!;
  const forgedRun = f.store.write({ id: otherRun.id, kind: otherRun.kind, expected: otherRun.revision, value: { ...otherRun.value, checks: [] } });
  const value = { ...result.value, runs: result.value.runs.map((ref: any) => ref.id === forgedRun.id ? reference(forgedRun) : ref) };
  const forged = f.store.write({ id: result.id, kind: result.kind, expected: result.revision, value });
  assert.ok(resultGate(f.store, "p", reference(forged)).findings.some(item => item.code === "execution_proof_invalid"));
});

test("stop interrupts the owned process and stale plans are refused before worktree creation", async t => {
  const f = executionFixture(t, "wait");
  const running = f.engine.executor.run("p", reference(f.plan), f.options);
  for (let n = 0; n < 200 && f.calls().length === 0; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls().length, 1); assert.equal(f.engine.executor.stop("p"), true);
  const result = await running; assert.equal(result[0]!.value.state, "interrupted");
  assert.equal(f.store.get<any>("execution-lock:p")!.value.active, false);
  const stale = executionFixture(t); stale.engine.discovery.evidence.document("p", "brief", "New incompatible brief", "text/plain", 1);
  await assert.rejects(stale.engine.executor.run("p", reference(stale.plan), stale.options), /Refresh changed plan inputs/);
  assert.equal(stale.store.get("execution-root:p"), null);
  assert.equal(existsSync(join(stale.directory, "worktrees")), false);
});

test("file evidence preserves literal Unicode names and explicit deletions", async t => {
  const f = executionFixture(t, "delete");
  const runs = await f.engine.executor.run("p", reference(f.plan), f.options);
  assert.equal(runs.length, 2); assert.equal(runs[1]!.value.state, "committed");
  const root = f.store.get<ExecutionRoot>("execution-root:p")!.value;
  const receipt = f.store.get<ArtifactReceipt>(receiptId("p", "p-data"))!;
  assert.deepEqual(receipt.value.value.files.find(file => file.path === "obsolete.txt"), { path: "obsolete.txt", hash: null });
  const path = "данные[1].txt";
  writeFileSync(join(root.path, path), "точное содержимое");
  git(root.path, ["add", "--", path]); git(root.path, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Unicode fixture"]);
  const head = git(root.path, ["rev-parse", "HEAD"]);
  assert.equal(treeFile(root.path, head, path)!.toString("utf8"), "точное содержимое");
  unlinkSync(join(root.path, path)); writeFileSync(join(root.path, "obsolete.txt"), "unexpected recreation");
  git(root.path, ["add", "--all"]); git(root.path, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "recreate deleted file"]);
  assert.equal(treeFile(root.path, "HEAD", path), null);
  assert.throws(() => resolveArtifact(f.store, "p", f.plan.value.graphSnapshot, { root: root.path, head: git(root.path, ["rev-parse", "HEAD"]), tree: git(root.path, ["rev-parse", "HEAD^{tree}"]), files: [] }, "p-produce-work", "p-data"), /artifact changed/);
});

test("an abruptly killed owner cannot leave its implementation writer alive, and the attempt reopens as interrupted", async t => {
  const f = executionFixture(t, "wait");
  const worker = join(f.directory, "owner.mjs");
  writeFileSync(worker, `import {Store} from ${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import {ProductEngine} from ${JSON.stringify(new URL('../src/product/engine.js', import.meta.url).href)};
const store=new Store(${JSON.stringify(f.store.path)});
await new ProductEngine(store).executor.run('p',${JSON.stringify(reference(f.plan))},${JSON.stringify(f.options)});
store.close();`);
  const child = spawn(process.execPath, [worker], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let error = ""; child.stderr.on("data", data => { error += data; });
  for (let n = 0; n < 200 && f.calls().length === 0 && child.exitCode === null; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls().length, 1, error);
  const owned = f.store.list<TaskRun>("task-run")[0]!.value.child!;
  assert.ok(owned);
  const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
  for (let n = 0; n < 100 && processStart(owned.pid) === owned.started; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.notEqual(processStart(owned.pid), owned.started, "The supervisor and writer must die with the owner");
  const resumed = await f.engine.executor.run("p", reference(f.plan), f.options);
  assert.equal(resumed[0]!.value.state, "interrupted"); assert.equal(f.calls().length, 1);
  assert.equal(existsSync(join(f.store.get<ExecutionRoot>("execution-root:p")!.value.path, "produce.mjs")), false);
});

test("write-scope traversal canonicalizes the selected root and refuses symlink and hard-link targets", t => {
  const f = executionFixture(t);
  const alias = join(f.directory, "selected-root"); symlinkSync(f.workspace, alias);
  assert.doesNotThrow(() => requireWritePaths(alias, ["future/nested.mjs"]));
  symlinkSync(join(f.workspace, "README.md"), join(f.workspace, "linked.md"));
  assert.throws(() => requireWritePaths(alias, ["linked.md"]), /regular file/);
  linkSync(join(f.workspace, "README.md"), join(f.workspace, "hard.md"));
  assert.throws(() => requireWritePaths(alias, ["hard.md"]), /hard links/);
});

test("a published intent is recoverable after its brief changes, before refusing stale future work", async t => {
  const f = executionFixture(t);
  const executor = new Executor(f.store, f.engine.compiler, f.engine.environments, () => { throw new Error("crash after publication"); });
  await assert.rejects(executor.run("p", reference(f.plan), f.options), /crash after publication/);
  const pending = f.store.list<TaskRun>("task-run")[0]!;
  f.engine.discovery.evidence.document("p", "brief", "A new direction for future work", "text/plain", 1);
  f.reopen();
  const recovered = await f.engine.execute({ type: "recover-execution", project: "p" }) as { value: TaskRun }[];
  assert.equal(recovered[0]!.value.commit, pending.value.commit); assert.equal(recovered[0]!.value.state, "committed");
  assert.equal(f.store.get<ExecutionRoot>("execution-root:p")!.value.head, pending.value.commit);
  assert.ok(f.store.get(receiptId("p", "p-data"))); assert.equal(f.calls().length, 2);
  await assert.rejects(f.engine.executor.run("p", reference(f.plan), f.options), /sealed plan input changed/);
  assert.equal(f.calls().length, 2);
});

test("Git clean filters cannot commit different code than the bytes subjected to the gates", async t => {
  const f = executionFixture(t, "filter");
  const runs = await f.engine.executor.run("p", reference(f.plan), f.options);
  assert.equal(runs[0]!.value.state, "interrupted"); assert.equal(runs[0]!.value.commit, null);
  assert.match(runs[0]!.value.error!, /checked file differs from the Git candidate/);
  assert.equal(runs[0]!.value.checks.length, 0); assert.equal(f.calls().length, 1);
  assert.equal(git(f.store.get<ExecutionRoot>("execution-root:p")!.value.path, ["rev-parse", "HEAD"]), f.initial);
  assert.equal(f.store.list("artifact").length, 0);
});
