import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, linkSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { executionFixture as legacyExecutionFixture } from "./execution-fixture.js";
import { prepareOmFixtureStages, prepareNativeLayers, acceptNativeWorks } from "./om-fixture.js";
const executionFixture = (t: test.TestContext, behavior = "normal") => legacyExecutionFixture(t, behavior, { route: "om" });
import { reference } from "../src/pipeline/contracts.js";
import { git, type ExecutionRoot, type Environment } from "../src/runtime/environment.js";
import { Executor } from "../src/execution/runner.js";
import { receiptId, type ArtifactReceipt } from "../src/compiler/model.js";
import { resultGate } from "../src/execution/result.js";
import { resolveArtifact } from "../src/compiler/inputs.js";
import { EXECUTION_REVIEW_CONTRACT, type PlanFindingAddress, type TaskRun } from "../src/execution/model.js";
import type { CompiledTask } from "../src/compiler/model.js";
import { treeFile } from "../src/runtime/git-files.js";
import { processStart } from "../src/runtime/process-identity.js";
import { requireWritePaths } from "../src/execution/candidate.js";
import { prepareWriterIndex, readWriterIndex, writerIndexId, type WriterIndex } from "../src/ownership/writer-index.js";
import { Store } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import { finishCommit } from "../src/execution/commit.js";
import { prepareFrame, type FrameRequest } from "../src/om/frame-obligations.js";
import { writeHorizon } from "../src/om/horizon.js";
import type { OmAcceptedFrame } from "../src/om/layer-basis.js";
import type { LayerProposal } from "../src/om/frame-proposals.js";
import { writeNeighbors, readNeighbors, type NeighborCollection } from "../src/om/neighbors.js";

test("current execution fixture validates its route and runs the environment hook before OM admission", t => {
  for (const route of [null, {}, { route: "legacy" }, { route: "om", beforeRoute: true }])
    assert.throws(() => legacyExecutionFixture(t, "normal", route as never),
      (error: unknown) => error instanceof EngineError && error.code === "execution_fixture_invalid"
        && JSON.stringify(error.details) === JSON.stringify({ target: "/route" }));
  let called = 0;
  const f = legacyExecutionFixture(t, "normal", { route: "om", beforeRoute(engine) {
    called++;
    assert.equal(engine.store.get("om-input:p"), null);
    const environment = engine.environments.get("p");
    engine.environments.configure("p", { ...environment.value, timeoutMs: 12_000 }, environment.revision);
  } });
  assert.equal(called, 1);
  assert.deepEqual(f.plan.value.environment, reference(f.engine.environments.get("p")));
  assert.equal(f.engine.environments.get("p").value.timeoutMs, 12_000);
  assert.equal(f.plan.value.feasibility.id, "om-feasibility:p");
  assert.equal(f.store.get("feasibility:p"), null);
  assert.equal(f.store.list("task-run").length, 0);
});

test("real executor processes consume compact context, run both gates and commit exact code receipts without changing the source branch", async t => {
  const f = executionFixture(t);
  assert.equal(f.plan.value.feasibility.id, "om-feasibility:p");
  assert.equal(f.store.get("feasibility:p"), null);
  assert.equal(f.store.list("task-run").length, 0);
  assert.equal(f.store.get("execution-root:p"), null);
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
  for (const run of f.store.list<TaskRun>("task-run")) {
    const task = f.plan.value.tasks.find(task => task.id === run.value.taskId)!;
    for (const path of task.writePaths) {
      const index = f.store.get<WriterIndex>(writerIndexId("p", path))!;
      assert.deepEqual(readWriterIndex(f.store, "p", path, reference(index), reference(root)).value.writers, [reference(run)]);
    }
  }
  const indexes = f.store.list("writer-index");
  assert.equal(f.engine.pipeline.inspect("p", "execution").state, "accepted");
  const result = f.store.list("execution-result")[0]!;
  assert.deepEqual(resultGate(f.store, "p", reference(result)).findings, []);
  f.reopen(); await f.engine.executor.run("p", reference(f.plan), f.options);
  assert.equal(f.calls().length, 4, "An accepted result must not rerun its agents or checks after reopen");
  assert.deepEqual(f.store.list("writer-index"), indexes, "Accepted execution repeats do not append writers or index revisions");
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
  await assert.rejects(f.engine.executor.run("p", reference(f.plan), { ...f.options, maxContextChars: 100 }),
    { code: "capacity_mismatch" });
  assert.equal(f.calls().length, 0);
  assert.equal(f.store.list("task-run").length, 0);
  assert.equal(f.store.list("artifact").length, 0);
  assert.equal(f.store.get<ExecutionRoot>("execution-root:p")!.value.head, f.initial);
  assert.equal(git(f.store.get<ExecutionRoot>("execution-root:p")!.value.path, ["rev-parse", "HEAD"]), f.initial);
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
  assert.deepEqual(f.store.get<WriterIndex>(writerIndexId("p", "obsolete.txt"))!.value.writers, [reference(runs[0]!)]);
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

// FLAKY2: the owner's first call needs its whole engine module graph loaded inside the spawned child — a cold
// `import(engine.js)` alone measures ≈5.7 s here, consistent with the start not fitting the nominal 4 s (200×20 ms)
// poll under load. The wait keeps a finite monotonic deadline, fails early when the owner exits on its own and
// reports the observed state (elapsed ms, exit code/signal, calls, the saved child and stderr), so a slow start,
// an early exit and a hang are distinguished by the failure text instead of a bare counter. The deadline is a
// test-local bound, never engine timing.
const OWNER_READY_DEADLINE_MS = 30_000;
type MonotonicClock = { now(): number; sleep(ms: number): Promise<void> };
const REAL_CLOCK: MonotonicClock = { now: () => performance.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
async function awaitOwnerReady(child: { exitCode: number | null; signalCode: NodeJS.Signals | null },
  ready: () => boolean, diagnostics: () => string, deadlineMs = OWNER_READY_DEADLINE_MS,
  clock: MonotonicClock = REAL_CLOCK): Promise<void> {
  const started = clock.now();
  for (;;) {
    if (ready()) return;
    const elapsed = Math.round(clock.now() - started);
    if (child.exitCode !== null || child.signalCode !== null)
      assert.fail(`The owner exited before its first call (exitCode=${child.exitCode} signal=${child.signalCode}) after ${elapsed} ms — ${diagnostics()}`);
    if (elapsed >= deadlineMs)
      assert.fail(`No first call within ${elapsed} ms and the owner is still running — ${diagnostics()}`);
    await clock.sleep(20);
  }
}

test("the owner-readiness wait distinguishes a controlled slow start, an early exit and an expired deadline", async () => {
  // Virtual clock — the injected sleep only advances virtual now; no branch can race a real timer, and no real
  // children are spawned.
  const child = () => ({ exitCode: null as number | null, signalCode: null as NodeJS.Signals | null });
  const virtualClock = (): MonotonicClock => {
    let now = 0;
    return { now: () => now, sleep: ms => { now += ms; return Promise.resolve(); } };
  };
  { // readiness after a bounded number of polls resolves — the real scheduler cannot delay virtual time
    const clock = virtualClock(); let polls = 0;
    await awaitOwnerReady(child(), () => ++polls >= 3, () => "unreached", 1000, clock);
    assert.ok(polls >= 3, `readiness arrived after ${polls} bounded polls`);
  }
  { // an exit observed between polls is reported with its code and signal, not mistaken for a deadline
    const clock = virtualClock(); const leaver = child(); let checks = 0;
    await assert.rejects(awaitOwnerReady(leaver, () => { if (++checks === 2) leaver.exitCode = 3; return false; },
      () => "stderr=bye", 1000, clock), /exited before its first call \(exitCode=3 signal=null\).*stderr=bye/);
  }
  { // readiness that never arrives is refused by the virtual deadline with the measured duration
    const clock = virtualClock();
    await assert.rejects(awaitOwnerReady(child(), () => false, () => "calls=0 saved child=null", 1000, clock),
      /No first call within 1000 ms and the owner is still running — calls=0 saved child=null/);
  }
  { // the r1 counterexample: a timer resumed 1100 ms late — the injected sleep models it by advancing virtual now
    // past the deadline, so the deadline branch reports the measured elapsed deterministically
    let now = 0;
    const clock: MonotonicClock = { now: () => now, sleep: _ms => { now += 1100; return Promise.resolve(); } };
    await assert.rejects(awaitOwnerReady(child(), () => false, () => "late timer", 1000, clock),
      /No first call within 1100 ms and the owner is still running — late timer/);
  }
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
  child.once("error", cause => { error += `\nspawn error: ${cause.message}`; });
  // Readiness is the implementer's real first call plus the attempt's saved child — runProcess commits that record
  // before the request is sent, and the first call lands only inside the spawned owner.
  const savedChild = () => f.store.list<TaskRun>("task-run")[0]?.value.child ?? null;
  await awaitOwnerReady(child, () => f.calls().length >= 1 && savedChild() !== null,
    () => `calls=${f.calls().length} saved child=${JSON.stringify(savedChild())} stderr=${error.trim() || "(empty)"}`);
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


test("writer-index creation races roll back the real neighbors batch and its cold retry writes each revision once", t => {
  const history = (store: Store) => store.identities("list").flatMap(row => store.history(row.id));
  let captured: { store: Store; candidate: Ref; neighborId: string; index: Revision<WriterIndex>; history: unknown } | undefined;
  assert.throws(() => legacyExecutionFixture(t, "delete", { route: "om", beforeRoute(engine) {
    const store = engine.store, writeMany = store.writeMany.bind(store);
    store.writeMany = (writes, guards) => {
      const index = writes.find(write => write.kind === "writer-index" && write.expected === 0);
      if (index) {
        const neighbors = writes.find(write => write.kind === "om-neighbors");
        assert.ok(neighbors, "Bootstrap indexes and neighbors must use the real common producer batch");
        assert.equal(index.expected, 0); assert.equal(store.get(index.id), null);
        const second = new Store(store.path);
        try {
          const pending = prepareWriterIndex(second, "p", (index.value as unknown as WriterIndex).path, null);
          assert.equal(pending.writes.length, 1); assert.equal(pending.writes[0]!.expected, 0);
          second.writeMany(pending.writes, pending.guards);
          captured = { store, candidate: (neighbors.value as unknown as NeighborCollection).source.candidate,
            neighborId: neighbors.id, index: second.get<WriterIndex>(index.id)!, history: history(second) };
        } finally { second.close(); }
        store.writeMany = writeMany;
      }
      return writeMany(writes, guards);
    };
  } }), (error: unknown) => error instanceof EngineError && error.code === "om_fixture_invalid"
    && error.message.startsWith("revision_conflict:")
    && (error.details as { target?: string; field?: string }).target === captured?.index.id
    && (error.details as { field?: string }).field === "expected");
  assert.ok(captured);
  const { store, candidate, neighborId, index, history: afterRace } = captured;
  assert.deepEqual(history(store), afterRace, "All saved history equals the snapshot after the competing write");
  assert.equal(store.get(neighborId), null);
  assert.deepEqual(store.get(index.id), index);
  const reopened = new Store(store.path);
  try {
    const retry = writeNeighbors(reopened, { project: "p", candidate });
    assert.ok(retry.ok, retry.ok ? "" : retry.refusal.message);
    assert.equal(retry.value.id, neighborId); assert.equal(retry.value.revision, 1);
    assert.deepEqual(reopened.get(index.id), index, "The retry reuses the competing bootstrap index");
    const accepted = history(reopened);
    const read = readNeighbors(reopened, { project: "p", neighbors: reference(retry.value) });
    assert.ok(read.ok); assert.deepEqual(read.value, retry.value);
    assert.deepEqual(writeNeighbors(reopened, { project: "p", candidate }), retry);
    assert.deepEqual(history(reopened), accepted, "Reads and repeated production append no revisions");
  } finally { reopened.close(); }
});

test("writer-index CAS conflicts keep native acceptance atomic and recovery appends the writer once", async t => {
  for (const recovering of [false, true]) {
    await t.test(`${recovering ? "recovery" : "finishCommit"} with admitted index`, async t => {
      const f = executionFixture(t, "delete");
      const path = f.plan.value.tasks[0]!.writePaths[0]!;
      const indexId = writerIndexId("p", path);
      assert.equal(f.store.get(indexId)!.revision, 1, "The current OM admission already owns this exact empty index");
      if (recovering) {
        const executor = new Executor(f.store, f.engine.compiler, f.engine.environments, () => { throw new Error("stop before finishCommit"); });
        await assert.rejects(executor.run("p", reference(f.plan), f.options), /stop before finishCommit/);
        f.reopen();
      }
      const store = f.store;
      const writeMany = store.writeMany.bind(store);
      let raced = false;
      let before: { run: unknown; root: unknown; receipts: unknown; indexes: unknown } | null = null;
      store.writeMany = (inputs, guards) => {
        if (!raced && inputs.some(write => write.kind === "task-run" && (write.value as TaskRun).state === "committed")) {
          raced = true;
          const index = inputs.find(write => write.id === indexId);
          assert.ok(index, "A committed run must share its transaction with every path index");
          assert.equal(index.expected, 1);
          before = { run: store.list("task-run"), root: store.get("execution-root:p"), receipts: store.list("artifact"), indexes: store.list("writer-index") };
          const second = new Store(store.path);
          try {
            const run = second.list<TaskRun>("task-run")[0]!;
            const root = second.get<ExecutionRoot>("execution-root:p")!;
            const task = f.plan.value.tasks.find(task => task.id === run.value.taskId)!;
            const environment = second.get<Environment>(f.plan.value.environment.id, f.plan.value.environment.revision)!;
            finishCommit(second, root, run, f.plan.value, task, environment.value);
            before = { run: second.list("task-run"), root: second.get("execution-root:p"), receipts: second.list("artifact"), indexes: second.list("writer-index") };
          } finally { second.close(); }
        }
        return writeMany(inputs, guards);
      };
      const action = recovering
        ? () => f.engine.executor.recover("p")
        : () => f.engine.executor.run("p", reference(f.plan), f.options);
      await assert.rejects(action(), error => error instanceof EngineError && ["revision_conflict", "input_stale"].includes(error.code));
      store.writeMany = writeMany;
      assert.ok(raced); assert.ok(before);
      const snapshot = before as { run: unknown; root: unknown; receipts: unknown; indexes: unknown };
      assert.deepEqual(store.list("task-run"), snapshot.run, "Losing index CAS must leave the accepted run unwritten");
      assert.deepEqual(store.get("execution-root:p"), snapshot.root, "Losing index CAS must leave the root unchanged");
      assert.deepEqual(store.list("artifact"), snapshot.receipts, "Losing index CAS must leave every receipt unchanged");
      assert.deepEqual(store.list("writer-index"), snapshot.indexes, "The losing transaction leaves every index exactly as the winner committed it");
      const pending = store.list<TaskRun>("task-run")[0]!;
      assert.equal(pending.value.state, "committed");
      assert.equal(f.calls().length, 2);
      f.reopen();
      const recovered = await f.engine.executor.recover("p");
      assert.equal(recovered.length, 0);
      const accepted = f.store.get<TaskRun>(pending.id)!;
      assert.equal(accepted.value.state, "committed");
      for (const writePath of f.plan.value.tasks[0]!.writePaths) {
        const index = f.store.get<WriterIndex>(writerIndexId("p", writePath))!;
        assert.deepEqual(index.value.writers, [reference(accepted)]);
        assert.deepEqual(readWriterIndex(f.store, "p", writePath, reference(index), reference(f.store.get<ExecutionRoot>("execution-root:p")!)), index);
      }
      assert.equal(f.store.get<ExecutionRoot>("execution-root:p")!.value.head, accepted.value.commit);
      assert.deepEqual(f.store.get<ArtifactReceipt>(receiptId("p", "p-data"))!.value.run, reference(accepted));
      const saved = f.store.list("writer-index");
      f.reopen(); assert.deepEqual(await f.engine.executor.recover("p"), []);
      assert.deepEqual(f.store.list("writer-index"), saved); assert.equal(f.calls().length, 2);
    });
  }
});


test("writer index intervals bind each added writer to its own native acceptance root", async t => {
  const f = executionFixture(t);
  const original = await f.engine.executor.run("p", reference(f.plan), f.options);
  const path = "produce.mjs", id = writerIndexId("p", path);
  const first = f.store.get<WriterIndex>(id)!;
  const originalProducerRoot = f.store.get<ExecutionRoot>(first.value.root!.id, first.value.root!.revision)!;
  const originalConsumerRoot = f.store.get<ExecutionRoot>("execution-root:p")!;
  assert.equal(originalConsumerRoot.revision, originalProducerRoot.revision + 1);
  assert.deepEqual(first.value.origin, { kind: "commit", run: reference(original[0]!) });
  assert.deepEqual(readWriterIndex(f.store, "p", path, reference(first), reference(originalProducerRoot)), first);
  assert.deepEqual(readWriterIndex(f.store, "p", path, reference(first), reference(originalConsumerRoot)), first);

  const graph = structuredClone(f.plan.value.graphSnapshot);
  const successors = ["produce", "consume"].map(name => {
    const node = graph.nodes.find(node => node.id === `p-${name}-work`)!;
    node.title = name === "produce" ? "Upgrade producer safety" : "Upgrade consumer safety";
    node.code = node.code.map(ref => ({ ...ref, status: "existing" }));
    const check = graph.tests.find(test => test.node === node.id)!;
    check.contract!.entrypoint.status = "existing";
    check.covers = [...new Set([...check.covers, "p-flow"])];
    check.contract!.counterfactuals.push({ connector: "p-flow", mutation: "substitute", expectedFailure: name === "produce" ? "output_overflow" : "result_overflow",
      command: { executable: process.execPath, args: ["check.mjs", `overflow-${name}`] } });
    return node;
  });
  // A fresh L3 acceptance upgrades the same work definitions. Writer intervals belong to exact accepted runs,
  // so their distinct plan/run/root revisions must remain distinguishable even when the work ids are reused.
  const acceptedGraph = reference(f.store.get("graph:p")!), layer2 = reference(f.store.get("graph-layer:p:2")!);
  const frame2 = reference(f.store.get("om-frame:p:2")!), frame3 = f.store.get<OmAcceptedFrame>("om-frame:p:3")!;
  const horizon = writeHorizon(f.store, { project: "p", input: reference(f.store.get("om-input:p")!), graph: acceptedGraph,
    refinement: layer2, available: {}, choice: { choiceVersion: "upgrade", features: [{ outcome: "p-result" }], excluded: [] } });
  assert.ok(horizon.ok, horizon.ok ? "" : horizon.refusal.message);
  const request: FrameRequest = { project: "p", level: 3, graph: acceptedGraph, horizon: reference(horizon.value.gate),
    layer: reference(f.store.get("graph-layer:p:3")!), frame: reference(frame3), upper: { frame: frame2, horizon: reference(horizon.value.gate) } };
  const prepared = prepareFrame(f.store, request);
  assert.ok(prepared.ok, prepared.ok ? "" : prepared.refusal.message);
  const oldIds = new Set(["p-produce-work", "p-consume-work"]);
  const replacements = prepared.value.result.fills.filter(fill => oldIds.has(fill.node));
  const successor = (old: string) => successors.find(node => node.parent === graph.nodes.find(node => node.id === old)!.parent)!;
  const proposal: LayerProposal = { base: { graph: request.graph, frame: request.frame }, level: 3, worksContract: "works-frame/v1",
    source: "decision", status: "proposed", nodes: successors,
    fills: replacements.map(fill => ({ obligation: fill.obligation, node: successor(fill.node).id,
      ...(fill.port === undefined ? {} : { port: fill.port, codeRef: successor(fill.node).code[0]! }) })),
    replaces: replacements.map(fill => ({ obligation: fill.obligation, base: { node: fill.node, graph: request.graph },
      with: { node: successor(fill.node).id, port: fill.port ?? null }, basis: "Upgrade the implementation while retaining its accepted predecessor and writer history" })),
    tests: graph.tests.filter(test => successors.some(node => node.id === test.node)),
    transfers: graph.transfers!.filter(transfer => successors.some(node => node.id === transfer.to)),
    edges: graph.edges!.filter(edge => successors.some(node => node.id === edge.source)),
    localConnectors: [], artifacts: [], contracts: [], joins: [], journeys: [], packets: [], anchors: [],
    removes: successors.map(node => node.id), redefines: graph.tests.filter(test => successors.some(node => node.id === test.node)).map(test => test.id) };
  const proposed = f.store.write({ id: "om-proposal:p:upgrade", kind: "layer-proposal", expected: 0, value: proposal });
  acceptNativeWorks(f.engine, "p", { frame: { project: "p", level: 2, graph: acceptedGraph, horizon: request.horizon,
    layer: layer2, frame: frame2, upper: null }, proposals: [] }, { frame: request, proposals: [reference(proposed)] });
  const plan = f.engine.compiler.compile("p");
  const compilation = f.engine.compiler.publish("p", reference(plan), f.store.get("stage:p:compilation")!.revision);
  f.engine.pipeline.accept("p", "compilation", compilation.revision);
  const upgraded = await f.engine.executor.run("p", reference(plan), f.options);
  assert.deepEqual(upgraded.map(run => run.value.state), ["committed", "committed"]);
  const second = f.store.get<WriterIndex>(id)!;
  const producerRoot = f.store.get<ExecutionRoot>(second.value.root!.id, second.value.root!.revision)!;
  const consumerRoot = f.store.get<ExecutionRoot>("execution-root:p")!;
  assert.equal(second.revision, first.revision + 1);
  assert.equal(producerRoot.value.head, upgraded[0]!.value.commit);
  assert.equal(consumerRoot.value.head, upgraded[1]!.value.commit);
  assert.equal(consumerRoot.revision, producerRoot.revision + 1);
  assert.deepEqual(second.value.previous, reference(first));
  assert.deepEqual(second.value.origin, { kind: "commit", run: reference(upgraded[0]!) });
  assert.deepEqual(new Set(second.value.writers.map(ref => ref.hash)), new Set([original[0]!.hash, upgraded[0]!.hash]));
  f.reopen();
  assert.deepEqual(readWriterIndex(f.store, "p", path, reference(first), reference(originalProducerRoot)), first);
  assert.deepEqual(readWriterIndex(f.store, "p", path, reference(first), reference(originalConsumerRoot)), first);
  assert.deepEqual(readWriterIndex(f.store, "p", path, reference(second), reference(producerRoot)), second);
  assert.deepEqual(readWriterIndex(f.store, "p", path, reference(second), reference(consumerRoot)), second,
    "A commit writing another path does not expire this path's current index");
  const invalid = (error: unknown) => error instanceof EngineError && error.code === "writer_index_invalid";
  assert.throws(() => readWriterIndex(f.store, "p", path, reference(first), reference(producerRoot)), invalid);
  assert.throws(() => readWriterIndex(f.store, "p", path, reference(second), reference(originalConsumerRoot)), invalid);

  // Keep every genuine native source, but substitute the index's purported acceptance date.
  const forgedPath = join(f.directory, "redated.sqlite");
  let forged = new Store(forgedPath);
  try {
    for (const head of f.store.list()) for (const row of f.store.history(head.id)) {
      if (row.id === second.id && row.revision === second.revision) continue;
      forged.write({ id: row.id, kind: row.kind, expected: row.revision - 1, value: row.value });
    }
    const redated = forged.write<WriterIndex>({ id: second.id, kind: second.kind, expected: second.revision - 1,
      value: { ...second.value, root: reference(consumerRoot) } });
    forged.close(); forged = new Store(forgedPath);
    assert.throws(() => readWriterIndex(forged, "p", path, reference(redated), reference(consumerRoot)), invalid,
      "A real writer cannot be dated by the later root accepted for another work");
    assert.throws(() => readWriterIndex(forged, "p", path, reference(first), reference(originalConsumerRoot)), invalid,
      "A malformed immediate successor cannot silently become an open right boundary");
  } finally { forged.close(); }
});

// ---- EX1 (№3945, №3951, №3953): admitted execution — admission, durable launches, budget, stop, paid stages, build ----
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProductEngine } from "../src/product/engine.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { configureReaderPilot, prepareReaderPilot, type ReaderPilotSettings, type ExecutionAdmissionSettings } from "../src/discovery/reader-pilot.js";
import { configurePhasePolicy } from "../src/discovery/phase-policy.js";
import { EXECUTION_SEND_KIND, ExecutionSendHandle, gateRefusalPath, planDefectOf, type AddressContext, type ExecutionSend } from "../src/execution/protocol.js";
import { requireExecutionBudget, planCurrentGuards, correctionsUsed } from "../src/execution/runner.js";
import { linkDependencies } from "../src/execution/worktree.js";
import { checkCommands } from "../src/execution/commit.js";
import { hashJson } from "../src/canonical.js";
import type { StageArtifact } from "../src/pipeline/contracts.js";
import { resumeStoppedRun, runControlId, type RunControlRecord } from "../src/om/run-control.js";
import { stageId, type Ref } from "../src/pipeline/contracts.js";
import type { Revision } from "../src/storage/store.js";
import { canonical } from "../src/canonical.js";

/** The provider stub behind the real codex-stdio adapter: first in PATH, it acts by the step its behavior names. */
const PROVIDER = (directory: string, database: string) => `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
const args = process.argv.slice(2), output = args[args.indexOf('-o') + 1];
const mode = args[args.indexOf('--sandbox') + 1] === 'workspace-write' ? 'implement' : 'review';
const raw = readFileSync(0, 'utf8'), subject = JSON.parse(raw.slice(raw.indexOf('\\nSubject:\\n') + 10));
const journal = ${JSON.stringify(join(directory, "provider.jsonl"))}, behaviorFile = ${JSON.stringify(join(directory, "behavior.json"))};
const behavior = existsSync(behaviorFile) ? JSON.parse(readFileSync(behaviorFile, 'utf8')) : {};
const seen = existsSync(journal) ? readFileSync(journal, 'utf8').split('\\n').filter(Boolean).map(JSON.parse).filter(row => row.mode === mode).length : 0;
const step = behavior[mode + ':' + (seen + 1)] ?? behavior[mode] ?? 'ok';
const group = pid => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
appendFileSync(journal, JSON.stringify({ mode, step, task: subject.context.binding.task, pid: process.pid, adapter: process.ppid,
  group: group(process.pid), adapterGroup: group(process.ppid), correction: subject.correction ?? null, brief: raw.slice(0, raw.indexOf('\\nSubject:\\n')) }) + '\\n');
const usage = { input_tokens: 1000, output_tokens: 10, cached_input_tokens: 0, reasoning_output_tokens: 0 };
// EX5 №4045: a reviewer that answers exactly in the form its brief states — 'literal' passes, 'literal-code:a | b' or 'literal-plan:…' asks changes.
const form = pattern => JSON.parse(raw.slice(0, raw.indexOf('\\nSubject:\\n')).match(pattern)[1]);
const literal = step => {
  if (step === 'literal') return form(/the answer is exactly (\\{.*?\\}):/);
  const answer = form(/Otherwise it is (\\{.*\\}) with one finding/), how = step.slice(8, step.indexOf(':'));
  return { ...answer, kind: how === 'plan' ? 'plan' : answer.kind, findings: step.slice(step.indexOf(':') + 1).split(' | ') };
};
// AT3a: the addressed form an execution under admission asks for, and the steps that answer it — a plan finding with its
// address (from the request's template), a forged field of it, and an implementation that finds its contract unexecutable.
const v2 = subject.answerForm === 'execution/v2';
const failedCheck = () => { const index = (subject.checks ?? []).findIndex(c => c.result.exitCode !== 0 || c.result.signal !== null); if (index < 0) return null;
  const lines = (subject.checks[index].result.stdout + '\\n' + subject.checks[index].result.stderr).split('\\n').map(line => line.trim()).filter(Boolean);
  return { index, failure: lines[lines.length - 1] }; };
const addressOf = extra => ({ ...subject.address, requirement: subject.context.criteria.tests[0].id, norm: 'check.mjs keeps produce(1) === 2, which the contract cancels', path: null, check: null, ...extra });
const forge = { plan: a => ({ ...a, plan: { ...a.plan, hash: 'f'.repeat(64) } }), task: a => ({ ...a, task: 'task:other' }), attempt: a => ({ ...a, attempt: a.attempt + 1 }),
  tree: a => ({ ...a, tree: 'f'.repeat(40) }), requirement: a => ({ ...a, requirement: 'no-such-test' }),
  path: a => ({ ...a, norm: null, path: subject.context.scope.code.find(item => item.access === 'write').path }),
  check: a => ({ ...a, check: { index: 99, failure: 'not ok 1' } }), failure: a => ({ ...a, check: { index: failedCheck()?.index ?? 0, failure: 'no such line in the output' } }),
  green: a => ({ ...a, check: { index: 0, failure: 'x' } }) };
const asV2 = review => v2 ? { ...review, findings: review.findings.map(text => typeof text === 'string' ? { text, address: null } : text) } : review;
if (step === 'refuse') {
  // The gate's part: its own saved refusal of exactly the open send of its group, before any provider.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(${JSON.stringify(database)}, { readOnly: true });
  const rows = db.prepare("SELECT r.entity_id AS id, r.body AS body FROM heads h JOIN revisions r ON r.entity_id = h.entity_id AND r.revision = h.revision WHERE r.kind = 'execution-send'").all();
  const mine = rows.map(row => ({ id: row.id, value: JSON.parse(row.body) })).filter(row => row.value.status === 'sent' && row.value.group?.pid === group(process.pid));
  const folder = join(dirname(${JSON.stringify(database)}), 'execution-gate'); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, encodeURIComponent(mine[0].id) + '.json'), JSON.stringify({ contract: 'execution-gate-refusal/v1', send: mine[0].id, reason: 'limit' }));
  process.stderr.write('live gate refused the send: limit\\n'); process.exit(3);
}
if (step === 'wait') await new Promise(resolve => setTimeout(resolve, 60000));
if (step === 'fail-usage') { console.log(JSON.stringify({ type: 'turn.failed', usage })); process.exit(1); }
if (step === 'fail') process.exit(1);
if (mode === 'implement' && step.startsWith('unexecutable')) {
  if (step === 'unexecutable-foreign') writeFileSync('README.md', 'changed outside the write paths');
  const extra = step === 'unexecutable-path' ? { norm: null, path: 'check.mjs' } : step === 'unexecutable-check' ? { check: { index: 0, failure: 'not ok 1' } } : {};
  writeFileSync(output, JSON.stringify({ outcome: 'contract_unexecutable', findings: [{ text: 'The contract cancels an expectation outside the write paths', address: addressOf(extra) }] }));
} else if (mode === 'implement') {
  const file = subject.context.scope.code.find(item => item.access === 'write').path, wrong = step === 'wrong';
  writeFileSync(file, file === 'produce.mjs'
    ? 'export const produce=n=>{if(!Number.isFinite(n))throw new Error("input_missing");return n+' + (wrong ? 2 : 1) + '};\\n'
    : 'import {produce} from "./produce.mjs"; export const consume=n=>produce(n)*' + (wrong ? 3 : 2) + ';\\n');
  writeFileSync(output, JSON.stringify({ text: 'Implemented the bounded module', artifacts: step === 'no-artifacts' ? [] : subject.context.produces.map(id => ({ id })) }));
} else writeFileSync(output, JSON.stringify(asV2(step.startsWith('plan-addressed') ? { verdict: 'request_changes', kind: 'plan', findings: [
    ...(step.includes(':') ? step.slice(step.indexOf(':') + 1).split(' | ') : ['The contract cancels an expectation outside the write paths'])
      .map((text, at, all) => ({ text, address: at === all.length - 1 ? addressOf({ check: failedCheck() }) : null }))] }
  : step.startsWith('plan-forged:') ? { verdict: 'request_changes', kind: 'plan', findings: [{ text: 'A forged address', address: forge[step.slice(12)](addressOf({ check: failedCheck() })) }] }
  : step.startsWith('literal') ? literal(step)
  : step === 'code' ? { verdict: 'request_changes', kind: 'code', findings: ['The result is wrong'] }
  : step.startsWith('code:') ? { verdict: 'request_changes', kind: 'code', findings: step.slice(5).split(' | ') }
  : step.startsWith('plan:') ? { verdict: 'request_changes', kind: 'plan', findings: step.slice(5).split(' | ') }
  : step === 'plan' ? { verdict: 'request_changes', kind: 'plan', findings: ['The responsibility cannot deliver'] }
  : failedCheck() && step === 'ok' ? { verdict: 'request_changes', kind: 'code', findings: ['The full check fails: ' + failedCheck().failure] }
  : step === 'pass-red' || step === 'ok' ? { verdict: 'pass', kind: 'none', findings: [] } : { verdict: 'pass', kind: 'none', findings: [] })));
console.log(JSON.stringify({ type: 'turn.completed', usage }));
`;
/** The task checks: they record their order and read what the full check built (ignored by Git). */
const EX1_CHECK = (directory: string) => String.raw`
import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
const mode = process.argv[2];
appendFileSync(${JSON.stringify(join(directory, "order.log"))}, mode + '\n');
assert.ok(existsSync('build/marker'), 'The candidate is built before the task commands');
if (mode === 'produce') { const { produce } = await import('./produce.mjs'); assert.equal(produce(1), 2); }
if (mode === 'consume') { const { consume } = await import('./consume.mjs'); assert.equal(consume(1), 4); }
if (mode === 'mutation') { const { produce } = await import('./produce.mjs'); assert.throws(() => produce(undefined), /input_missing/); }
`;
/** The full check: builds the candidate (an ignored marker), then checks what exists; it can be held to be stopped. */
const EX1_FULL = (directory: string) => String.raw`
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
appendFileSync(${JSON.stringify(join(directory, "order.log"))}, 'full\n');
if (existsSync(${JSON.stringify(join(directory, "hold-full"))})) await new Promise(resolve => setTimeout(resolve, 60000));
mkdirSync('build', { recursive: true }); writeFileSync('build/marker', 'built');
const modes = ['produce', ...(existsSync('consume.mjs') ? ['consume'] : [])];
for (const mode of modes) { const result = spawnSync(process.execPath, ['check.mjs', mode], { stdio: 'inherit' }); if (result.status !== 0) process.exit(1); }
`;
/** EX2: a full check run by node --test — its failure is TAP on stdout, while stderr carries a warning (as SQLite's on the live pass). */
const EX2_TAP_FULL = (directory: string) => String.raw`
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
appendFileSync(${JSON.stringify(join(directory, "order.log"))}, 'full\n');
mkdirSync('build', { recursive: true }); writeFileSync('build/marker', 'built');
writeFileSync('build/tap.test.mjs', "import test from 'node:test'; import assert from 'node:assert/strict'; process.emitWarning('SQLite is an experimental feature', 'ExperimentalWarning');\n"
  + "test('produce returns its successor', async () => { const { produce } = await import('../produce.mjs'); assert.deepEqual({ value: produce(1) }, { value: 2 }); });\n");
const result = spawnSync(process.execPath, ['--test', 'build/tap.test.mjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`;
const EX1_BUDGET: Omit<ExecutionAdmissionSettings, "plan"> = { roleLaunches: 40, softInput: 6_000_000, roleReserve: { implement: 5000, review: 2000 }, maxCorrections: 1 };
function ex1Fixture(t: test.TestContext, options: { timeoutMs?: number; ignoreModules?: boolean; modules?: boolean; admit?: boolean; tap?: boolean; progress?: boolean;
  legacy?: boolean; budget?: Partial<Omit<ExecutionAdmissionSettings, "plan">>; implementer?: { executable: string; args: string[] } } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "omg-ex1-"))), workspace = join(directory, "repo"), bin = join(directory, "bin");
  mkdirSync(workspace); mkdirSync(bin);
  git(workspace, ["init", "-b", "main"]);
  writeFileSync(join(workspace, "README.md"), "A local numeric transformation product");
  writeFileSync(join(workspace, ".gitignore"), `${options.ignoreModules === false ? "" : "node_modules\n"}build/\n`);
  writeFileSync(join(workspace, "check.mjs"), EX1_CHECK(directory));
  if (options.modules) { mkdirSync(join(workspace, "node_modules", "dep"), { recursive: true }); writeFileSync(join(workspace, "node_modules", "dep", "index.js"), "export default 1;\n"); }
  git(workspace, ["add", "README.md", ".gitignore", "check.mjs"]);
  git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const database = join(directory, "state.sqlite");
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = exampleGraph("p");
  for (const node of base.nodes) for (const ref of node.code) ref.path = ref.path.replace(".txt", ".mjs");
  const graph = enrichedGraph(base, "p");
  graph.contracts[0]!.schema = { type: "number" };
  for (const proof of graph.tests) {
    proof.command = { executable: process.execPath, args: ["check.mjs", proof.node.includes("produce") ? "produce" : "consume"] };
    for (const mutation of proof.contract!.counterfactuals) mutation.command = { executable: process.execPath, args: ["check.mjs", "mutation"] };
  }
  if (options.legacy) preparedFeatures(engine, "p", graph);
  else prepareOmFixtureStages(engine, "p", graph);
  // `progress`: the full check prints progress on stdout while its failure stays on stderr (№3986-2).
  writeFileSync(join(directory, "full.mjs"), options.tap ? EX2_TAP_FULL(directory)
    : options.progress ? EX1_FULL(directory).replace("\nappendFileSync(", "\nconsole.log('Building candidate...');\nappendFileSync(") : EX1_FULL(directory));
  const adapter = { executable: process.execPath, args: [fileURLToPath(new URL("../src/adapters/codex-stdio.js", import.meta.url))] };
  engine.environments.configure("p", { workspace, implementer: { actor: "worker", model: "fixture", effort: "high", command: options.implementer ?? adapter },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command: adapter },
    fullCheck: { executable: process.execPath, args: [join(directory, "full.mjs")] }, timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.legacy ? {} : { requestCapacityChars: 100_000 }) }, 0);
  if (options.legacy) {
    refinedLayers(engine, "p"); const feasibility = engine.refinement.assess("p", 0);
    const stage = engine.refinement.publish("p", reference(feasibility), 0); engine.pipeline.accept("p", "om-g2", stage.revision);
  } else prepareNativeLayers(engine, "p", graph, "executed");
  const plan = engine.compiler.compile("p"); const compilation = engine.compiler.publish("p", reference(plan), 0); engine.pipeline.accept("p", "compilation", compilation.revision);
  writeFileSync(join(bin, "codex"), PROVIDER(directory, database)); chmodSync(join(bin, "codex"), 0o755);
  const path = process.env["PATH"]; process.env["PATH"] = `${bin}${delimiter}${path}`; t.after(() => { process.env["PATH"] = path; });
  const settings: ReaderPilotSettings = { experimental: true, active: true, stopAfter: "L2",
    reader: { actor: "reader", model: "fixture-reader", effort: "high", speed: "fast", command: adapter }, agentCommand: adapter,
    maxRequestChars: 100000, maxReadChars: 20000, maxReplyChars: 10000, maxCalls: 20, maxReportedTokens: 100000 };
  configureReaderPilot(store, engine.environments, "p", settings, 0);
  configurePhasePolicy(store, "p", "compilation", "ex1", 0);
  const execution = (budget: Partial<Omit<ExecutionAdmissionSettings, "plan">> = {}, planRef: Ref = reference(plan)): ExecutionAdmissionSettings =>
    ({ plan: planRef, ...EX1_BUDGET, ...options.budget, ...budget });
  const admit = (value: unknown = execution()) => engine.execute({ type: "configure-reader-pilot", project: "p",
    expected: store.get("reader-pilot:p")!.revision, settings: { ...settings, execution: value } });
  if (options.admit !== false) admit();
  const command = (extra: Partial<{ retry: boolean; maxCorrections: number }> = {}) =>
    ({ type: "execute-plan", project: "p", plan: reference(plan), retry: false, maxContextChars: 100_000, maxCorrections: 1, ...extra });
  return { directory, workspace, database, bin, plan, settings, execution, admit, command,
    get store() { return store; }, get engine() { return engine; },
    run: async (extra: Partial<{ retry: boolean; maxCorrections: number }> = {}) => await engine.execute(command(extra)) as Revision<TaskRun>[],
    behave: (value: Record<string, string>) => writeFileSync(join(directory, "behavior.json"), JSON.stringify(value)),
    provider: (): { mode: string; step: string; task: string; pid: number; adapter: number; group: number; adapterGroup: number; correction: { error: string | null; review: unknown } | null; brief: string }[] => {
      try { return readFileSync(join(directory, "provider.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    sends: () => store.list<ExecutionSend>(EXECUTION_SEND_KIND),
    order: () => { try { return readFileSync(join(directory, "order.log"), "utf8").split("\n").filter(Boolean); } catch { return []; } },
    reopen: () => { store.close(); store = new Store(database); engine = new ProductEngine(store); return engine; } };
}
/** The engine of the fixture in its own process; `crash` names the written task-run state after which it dies at once. */
async function ex1Process(f: ReturnType<typeof ex1Fixture>, extra: Record<string, unknown>, crash: string | null): Promise<number | null> {
  const script = join(f.directory, `engine-${Date.now()}.mjs`);
  writeFileSync(script, `import {Store} from ${JSON.stringify(new URL("../src/storage/store.js", import.meta.url).href)};
import {ProductEngine} from ${JSON.stringify(new URL("../src/product/engine.js", import.meta.url).href)};
const store = new Store(${JSON.stringify(f.database)}), write = store.writeMany.bind(store), crash = ${JSON.stringify(crash)};
store.writeMany = (inputs, guards) => { const written = write(inputs, guards);
  if (crash && inputs.some(item => item.kind === 'task-run' && item.value.state === crash && (crash !== 'reviewing' || item.value.review))) process.exit(9);
  return written; };
try { await new ProductEngine(store).execute(${JSON.stringify(f.command(extra as never))}); } catch (error) { process.stderr.write(String(error.code ?? error.message)); }
store.close();`);
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env } });
  const [code] = await once(child, "exit") as [number | null];
  return code;
}

test("EX1 row 1 an admitted execution launches both roles through the real adapter chain; each launch is one durable record with its measured usage and the process group the gate binds", async t => {
  const f = ex1Fixture(t);
  const runs = await f.run();
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"]);
  const sends = f.sends().map(row => row.value).sort((a, b) => a.startedAt - b.startedAt);
  assert.deepEqual(sends.map(send => [send.role, send.status, send.usage?.inputTokens, send.attempt, send.ordinal, send.correction]),
    [["implement", "answered", 1000, 1, 1, false], ["review", "answered", 1000, 1, 1, false], ["implement", "answered", 1000, 1, 1, false], ["review", "answered", 1000, 1, 1, false]]);
  assert.ok(sends.every(send => canonical(send.admission) === canonical(reference(f.store.get("reader-pilot:p")!))));
  // №3953-2: the record holds the group leader; the provider's parent (the adapter) is a member of exactly that group.
  const provider = f.provider();
  assert.equal(provider.length, 4);
  for (const [index, call] of provider.entries()) {
    assert.equal(call.adapterGroup, sends[index]!.group!.pid, "The adapter that starts the provider belongs to the recorded group");
    assert.equal(call.group, sends[index]!.group!.pid);
    assert.notEqual(call.adapter, sends[index]!.group!.pid, "The recorded process is the supervisor, not the adapter: the gate binds by group");
  }
  assert.equal(f.engine.pipeline.inspect("p", "execution").state, "accepted");
  assert.equal(f.store.get<RunControlRecord>(runControlId("p"))!.value.execution, null, "The control is given up after the execution");
});

test("EX1 row 5 a refusal the gate saved for exactly its send reaches no provider and costs nothing; the task stops, and the next launch is not counted against it", async t => {
  const f = ex1Fixture(t, { budget: { roleLaunches: 4 } });
  f.behave({ "implement:1": "refuse" });
  const runs = await f.run();
  assert.equal(runs[0]!.value.state, "interrupted");
  const refused = f.sends()[0]!;
  assert.deepEqual([refused.value.status, refused.value.usage], ["refused", null]);
  assert.ok(existsSync(gateRefusalPath(f.store, refused.id)));
  f.behave({});
  const resumed = await f.run({ retry: true });
  assert.deepEqual(resumed.map(run => run.value.state), ["committed", "committed"], "Four launches remain: the refused one is not counted");
  assert.equal(f.sends().filter(row => row.value.status === "answered").length, 4);
});

test("EX1 row 6 an exhausted budget refuses before any launch: launches at the review of a task keep its paid implementation; input before the first attempt writes nothing", async t => {
  const f = ex1Fixture(t, { budget: { roleLaunches: 3 } });
  const runs = await f.run();
  assert.equal(runs[1]!.value.state, "interrupted");
  assert.match(runs[1]!.value.error!, /^execution_budget_exhausted/);
  assert.equal(f.provider().length, 3, "The fourth launch never reached the provider");
  assert.equal(f.sends().length, 3);
  assert.ok(runs[1]!.value.implementation, "The paid implementation is kept");
  // A new revision of the admission (a decision of the owner) continues the paid stage: no new implementation.
  f.admit(f.execution({ roleLaunches: 4 }));
  const resumed = await f.run({ retry: true });
  assert.deepEqual(resumed.map(run => run.value.state), ["committed", "committed"]);
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "review", "implement", "review"]);
  const g = ex1Fixture(t, { budget: { softInput: 4000, roleReserve: { implement: 5000, review: 2000 } } });
  await assert.rejects(g.run(), { code: "execution_budget_exhausted" });
  assert.deepEqual([g.store.list("task-run").length, g.sends().length, g.provider().length], [0, 0, 0]);
});

/** The project's own stop, written by another process — never the executor's in-memory controller. */
async function ex1Stop(f: ReturnType<typeof ex1Fixture>): Promise<string> {
  const script = join(f.directory, `stop-${Date.now()}.mjs`);
  writeFileSync(script, `import {Store} from ${JSON.stringify(new URL("../src/storage/store.js", import.meta.url).href)};
import {stopRun} from ${JSON.stringify(new URL("../src/om/run-control.js", import.meta.url).href)};
const store = new Store(${JSON.stringify(f.database)}); const result = stopRun(store, { project: 'p' }); store.close();
process.stdout.write(JSON.stringify(result.ok));`);
  assert.equal(execFileSync(process.execPath, [script], { encoding: "utf8" }), "true");
  return f.store.get<RunControlRecord>(runControlId("p"))!.value.stop!.token;
}
const waitFor = async (predicate: () => boolean) => { for (let n = 0; n < 500 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 20)); };

test("EX1 row 7 a stop written by another process reaches the executor during a launch; after an explicit resume task 2 continues without plan_stale and task 1 is never paid again (№3953-1)", async t => {
  const f = ex1Fixture(t);
  f.behave({ "implement:2": "wait" });
  const running = f.run();
  await waitFor(() => f.provider().length === 3);
  const token = await ex1Stop(f);
  const runs = await running;
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "interrupted"]);
  const stopped = f.sends().find(row => row.value.role === "implement" && row.value.task === f.plan.value.tasks[1]!.id)!;
  assert.equal(stopped.value.status, "interrupted");
  await assert.rejects(f.run({ retry: true }), { code: "run_stopped" }, "A stopped execution begins nothing until an explicit resume");
  assert.equal(resumeStoppedRun(f.store, { project: "p", stop: token }).ok, true);
  f.behave({});
  const resumed = await f.run({ retry: true });
  assert.deepEqual(resumed.map(run => run.value.state), ["committed", "committed"]);
  assert.deepEqual(f.provider().map(call => [call.mode, call.task === f.plan.value.tasks[0]!.id ? 1 : 2]),
    [["implement", 1], ["review", 1], ["implement", 2], ["implement", 2], ["review", 2]], "Task 1 is launched once in all");
});

test("EX1 row 8 a stop during the checks of a paid implementation resumes at the checks: the implementation is never launched again", async t => {
  const f = ex1Fixture(t);
  writeFileSync(join(f.directory, "hold-full"), "");
  const running = f.run();
  await waitFor(() => f.order().includes("full"));
  const token = await ex1Stop(f);
  const runs = await running;
  assert.equal(runs[0]!.value.state, "interrupted");
  assert.equal(f.sends().length, 1, "No launch belongs to a check");
  rmSync(join(f.directory, "hold-full"));
  assert.equal(resumeStoppedRun(f.store, { project: "p", stop: token }).ok, true);
  const resumed = await f.run({ retry: true });
  assert.deepEqual(resumed.map(run => run.value.state), ["committed", "committed"]);
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "review", "implement", "review"]);
  assert.equal(resumed[0]!.value.attempt, 1, "The resumed stage continues the paid attempt");
});

test("EX1 row 9 a launch past its time is interrupted with its reserve counted; it is no answer", async t => {
  const f = ex1Fixture(t, { timeoutMs: 3000 });
  f.behave({ "implement:1": "wait" });
  const runs = await f.run();
  assert.equal(runs[0]!.value.state, "interrupted");
  assert.match(runs[0]!.value.error!, /timed out|timeout/i);
  assert.deepEqual(f.sends().map(row => [row.value.status, row.value.usage]), [["interrupted", null]]);
});

test("EX1 row 10 a launch left open by a lost executor is closed as lost on the next entry — counted at its reserve, never repaid as the same launch", async t => {
  const f = ex1Fixture(t, { budget: { roleLaunches: 5 } });
  f.behave({ "implement:1": "wait" });
  const script = join(f.directory, "owner.mjs");
  writeFileSync(script, `import {Store} from ${JSON.stringify(new URL("../src/storage/store.js", import.meta.url).href)};
import {ProductEngine} from ${JSON.stringify(new URL("../src/product/engine.js", import.meta.url).href)};
const store = new Store(${JSON.stringify(f.database)});
await new ProductEngine(store).execute(${JSON.stringify(f.command())});`);
  const child = spawn(process.execPath, [script], { stdio: "ignore", env: { ...process.env } });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await waitFor(() => f.provider().length === 1);
  const open = f.sends()[0]!;
  assert.equal(open.value.status, "sent");
  const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
  await waitFor(() => processStart(open.value.group!.pid) !== open.value.group!.started);
  // The dead owner's control is replaced by the next executor; its open launch is closed before anything else.
  f.behave({});
  const runs = await f.run({ retry: true });
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"]);
  assert.deepEqual([f.store.get<ExecutionSend>(open.id)!.value.status, f.store.get<ExecutionSend>(open.id)!.value.usage], ["lost", null]);
  assert.equal(f.sends().filter(row => row.value.status !== "refused" && row.value.status !== "not-started").length, 5,
    "The lost launch counts: with it the five admitted launches are exactly used");
  await assert.rejects(Promise.resolve().then(() => requireBudgetProbe(f)), { code: "execution_budget_exhausted" });
});
function requireBudgetProbe(f: ReturnType<typeof ex1Fixture>) {
  const admission = { pilot: reference(f.store.get("reader-pilot:p")!), execution: f.store.get<ReaderPilotSettings>("reader-pilot:p")!.value.execution! };
  return requireExecutionBudget(f.store, admission, f.plan, "implement");
}

test("EX1 №3953-3 an answered launch and its application are one transaction: a lost process right after either role's application resumes past it with no launch again", async t => {
  const f = ex1Fixture(t);
  assert.equal(await ex1Process(f, {}, "checking"), 9);
  const applied = f.store.list<TaskRun>("task-run")[0]!;
  assert.deepEqual([applied.value.state, Boolean(applied.value.implementation), f.sends().map(row => row.value.status)], ["checking", true, ["answered"]]);
  const runs = await f.run({ retry: true });
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"]);
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "review", "implement", "review"], "The applied implementation is not launched again");
  const g = ex1Fixture(t);
  assert.equal(await ex1Process(g, {}, "reviewing"), 9);
  const reviewed = g.store.list<TaskRun>("task-run")[0]!;
  assert.deepEqual([reviewed.value.review?.verdict, g.sends().map(row => row.value.status)], ["pass", ["answered", "answered"]]);
  const again = await g.run({ retry: true });
  assert.deepEqual(again.map(run => run.value.state), ["committed", "committed"]);
  assert.deepEqual(g.provider().map(call => call.mode), ["implement", "review", "implement", "review"], "The applied review is not launched again");
  assert.equal(again[0]!.value.commit !== null && again[0]!.value.attempt, 1);
});

test("EX1 rows 2, 3, 4 an answer of the wrong form is answered and counted; a failed adapter keeps the usage it reported, or the reserve where it reported none", async t => {
  const f = ex1Fixture(t, { budget: { maxCorrections: 0 } });
  f.behave({ "implement:1": "no-artifacts" });
  const runs = await f.run({ maxCorrections: 0 });
  assert.equal(runs[0]!.value.state, "needs_code", "Row 2: the earlier outcome of a wrong form stands");
  assert.deepEqual(f.sends().map(row => [row.value.status, row.value.usage?.inputTokens]), [["answered", 1000]]);
  const g = ex1Fixture(t);
  g.behave({ "implement:1": "fail-usage" });
  assert.equal((await g.run())[0]!.value.state, "interrupted");
  assert.deepEqual(g.sends().map(row => [row.value.status, row.value.usage?.inputTokens]), [["failed", 1000]], "Row 3");
  const h = ex1Fixture(t, { budget: { softInput: 9000, roleReserve: { implement: 5000, review: 2000 } } });
  h.behave({ "implement:1": "fail" });
  assert.equal((await h.run())[0]!.value.state, "interrupted");
  assert.deepEqual(h.sends().map(row => [row.value.status, row.value.usage]), [["failed", null]], "Row 4");
  // The unmeasured failure holds its reserve: 5000 + the next implement's reserve 5000 exceed 9000.
  await assert.rejects(h.run({ retry: true }).then(runs => { if (runs[0]!.value.error?.startsWith("execution_budget_exhausted")) throw Object.assign(new Error("refused"), { code: "execution_budget_exhausted" }); }),
    { code: "execution_budget_exhausted" });
  assert.equal(h.provider().length, 1);
});

test("EX1 a launch never started costs nothing: the open record of a launch whose process never appeared closes as not-started", async t => {
  // An executable present when the environment was configured and gone at the launch: its process never starts.
  const ghost = join(realpathSync(mkdtempSync(join(tmpdir(), "omg-ex1-ghost-"))), "agent");
  writeFileSync(ghost, "#!/bin/sh\nexit 1\n"); chmodSync(ghost, 0o755);
  t.after(() => rmSync(dirname(ghost), { recursive: true, force: true }));
  const f = ex1Fixture(t, { budget: { roleLaunches: 1, maxCorrections: 0 }, implementer: { executable: ghost, args: [] } });
  const writeMany = f.store.writeMany.bind(f.store);
  let removed = false;
  t.mock.method(f.store, "writeMany", ((writes, guards) => {
    const result = writeMany(writes, guards);
    // Remove only after the admitted send is durable: M8 checked the executable before this race.
    if (!removed && writes.some(write => write.kind === "execution-send" && write.expected === 0)) {
      removed = true; rmSync(ghost);
    }
    return result;
  }) as Store["writeMany"]);
  const runs = await f.run({ maxCorrections: 0 });
  assert.equal(removed, true);
  assert.notEqual(runs[0]!.value.state, "committed");
  assert.deepEqual(f.sends().map(row => [row.value.status, row.value.group, row.value.usage]), [["not-started", null, null]]);
  assert.doesNotThrow(() => requireBudgetProbe(f), "The one admitted launch is still available");
});

test("EX1 row 11 a lost owner after the Git publication recovers the commit with no launch", async t => {
  const f = ex1Fixture(t); let crash = true;
  const executor = new Executor(f.store, f.engine.compiler, f.engine.environments, () => { if (crash) { crash = false; throw new Error("simulated owner death after Git publication"); } });
  await assert.rejects(executor.run("p", reference(f.plan), { retry: false, maxContextChars: 100_000, maxCorrections: 1 }), /simulated owner death/);
  assert.equal(f.store.list<TaskRun>("task-run")[0]!.value.state, "commit_pending");
  const sent = f.sends().length;
  const runs = await f.run();
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"]);
  assert.equal(f.sends().length, sent + 2, "Only task 2 launches; the recovery of task 1 launches nothing");
});

test("EX1 rows 12, 13 a code finding opens one correction, durably: a correction that fails again stops, and a retry opens no other", async t => {
  const f = ex1Fixture(t);
  f.behave({ "review:1": "code" });
  const runs = await f.run();
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"], "Row 12");
  assert.deepEqual(f.sends().filter(row => row.value.role === "implement").map(row => [row.value.attempt, row.value.correction]).sort(), [[1, false], [1, false], [2, true]]);
  const g = ex1Fixture(t);
  g.behave({ review: "code" });
  const failed = await g.run();
  assert.equal(failed[0]!.value.state, "needs_code");
  assert.equal(g.provider().length, 4, "The first attempt and its one correction");
  await assert.rejects(g.run({ retry: true }), { code: "execution_corrections_exhausted" }, "Row 13");
  g.reopen();
  await assert.rejects(g.run({ retry: true }), { code: "execution_corrections_exhausted" }, "The limit survives a restart");
  assert.equal(g.provider().length, 4);
});

test("EX1 row 14 a plan finding stops the execution: a retry launches nothing", async t => {
  // AT3a (№4125): under admission a plan finding stops the task only with its address — the defect is saved with it.
  const f = ex1Fixture(t);
  f.behave({ review: "plan-addressed" });
  const [stopped] = await f.run();
  assert.equal(stopped!.value.state, "needs_plan");
  assert.equal(stopped!.value.planDefect?.findings[0]?.address?.task, taskOne(f).id);
  await f.run({ retry: true });
  assert.equal(f.provider().length, 2);
});

test("EX1 A the boundary admits execution only under the owner's admission of exactly this plan; every refusal is addressed and writes nothing", async t => {
  const f = ex1Fixture(t, { admit: false });
  await assert.rejects(f.run(), { code: "pilot_boundary_reached" });
  await assert.rejects(new Executor(f.store, f.engine.compiler, f.engine.environments).run("p", reference(f.plan), { retry: false, maxContextChars: 100_000, maxCorrections: 1 }),
    { code: "pilot_boundary_reached" }, "The direct path passes the same boundary");
  const pilot = f.store.get("reader-pilot:p")!;
  const refuse = (value: unknown, code: string) => {
    assert.throws(() => f.admit(value), { code }, JSON.stringify(value));
    assert.equal(f.store.get("reader-pilot:p")!.revision, pilot.revision);
  };
  const refuseDirect = (value: unknown) => {
    assert.throws(() => configureReaderPilot(f.store, f.engine.environments, "p", { ...f.settings, execution: value }, pilot.revision,
      plan => planCurrentGuardsProbe(f, plan)), { code: "execution_admission_invalid" }, JSON.stringify(value));
    assert.equal(f.store.get("reader-pilot:p")!.revision, pilot.revision);
  };
  // T4: every required field of the admission is refused by its own check, and by the command's form on the command path.
  for (const field of ["plan", "roleLaunches", "softInput", "roleReserve", "maxCorrections"]) {
    const { [field]: _dropped, ...rest } = f.execution() as unknown as Record<string, unknown>;
    refuseDirect(rest); refuse(rest, "command_invalid");
  }
  refuseDirect({ ...f.execution(), roleReserve: { implement: 5000 } });
  // EX3 (№4000): the limit is an integer 0..3; four, a fraction, a negative or a string is no limit.
  for (const maxCorrections of [4, 1.5, -1, "1", null]) refuseDirect({ ...f.execution(), maxCorrections });
  assert.throws(() => configureReaderPilot(f.store, f.engine.environments, "p", { ...f.settings, execution: f.execution() }, pilot.revision),
    { code: "execution_admission_invalid" }, "An admission is written only with its plan's currency proof");
  // A forged plan: another hash, another project's namespace.
  refuse(f.execution({}, { ...reference(f.plan), hash: "0".repeat(64) }), "execution_admission_invalid");
  refuse(f.execution({}, { ...reference(f.plan), id: f.plan.id.replace("plan:p:", "plan:q:") }), "execution_admission_invalid");
  // A status imitation: the compilation stage no longer holds this plan.
  const stage = f.store.get<StageArtifact>(stageId("p", "compilation"))!;
  const second = new Store(f.database);
  second.write({ id: stage.id, kind: "stage", expected: stage.revision, value: { ...stage.value, status: "draft" } as never });
  refuse(f.execution(), "execution_admission_stale");
  second.write({ id: stage.id, kind: "stage", expected: stage.revision + 1, value: stage.value as never });
  second.close();
  f.admit();
  await assert.rejects(f.run({ maxCorrections: 2 }), { code: "execution_corrections_exceeded" });
  // The admission of another plan does not admit this one.
  const policy = f.store.get("phase-policy:p")!;
  configurePhasePolicy(f.store, "p", "L3", "ex1", policy.revision);
  await assert.rejects(f.run(), { code: "pilot_boundary_reached" });
  configurePhasePolicy(f.store, "p", "compilation", "ex1", policy.revision + 1);
  const runs = await f.run();
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"]);
  // №3953-1: after its own commits the plan is read by its progress, so a new admission (a raised budget) is still written.
  assert.doesNotThrow(() => f.admit(f.execution({ roleLaunches: 41 })));
});

test("EX1 A (T7) the admission is prepared without a write and written in one guarded transaction: a change of any guarded head between them refuses it whole", t => {
  const f = ex1Fixture(t, { admit: false });
  const pilot = f.store.get("reader-pilot:p")!;
  const policy = f.store.get("phase-policy:p")!, stage = f.store.get<StageArtifact>(stageId("p", "compilation"))!;
  const changes: [string, (store: Store) => void][] = [
    ["phase-policy", store => { store.write({ id: policy.id, kind: "phase-policy", expected: store.get(policy.id)!.revision, value: policy.value as never }); }],
    ["compilation", store => { store.write({ id: stage.id, kind: "stage", expected: store.get(stage.id)!.revision, value: stage.value as never }); }],
    ["plan", store => { store.write({ id: f.plan.id, kind: "plan", expected: store.get(f.plan.id)!.revision, value: f.plan.value as never }); }],
  ];
  for (const [name, change] of changes) {
    const prepared = prepareReaderPilot(f.store, f.engine.environments, "p", { ...f.settings, execution: f.execution() }, f.store.get("reader-pilot:p")!.revision,
      plan => planCurrentGuardsProbe(f, plan));
    const second = new Store(f.database); change(second); second.close();
    assert.throws(() => f.store.writeMany([prepared.write], prepared.guards), { code: "input_stale" }, name);
    assert.equal(f.store.get("reader-pilot:p")!.revision, pilot.revision, name);
  }
});
function planCurrentGuardsProbe(f: ReturnType<typeof ex1Fixture>, plan: Ref) { return planCurrentGuards(f.store, f.engine.compiler, plan); }

test("EX1 C the managed worktree reads the workspace's ignored dependencies through one link that never enters a candidate; the full check builds the candidate before the task's own commands", async t => {
  const f = ex1Fixture(t, { modules: true });
  const runs = await f.run();
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"]);
  const root = f.store.get<ExecutionRoot>("execution-root:p")!.value;
  const link = join(root.path, "node_modules");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync(link), realpathSync(join(f.workspace, "node_modules")));
  assert.equal(git(root.path, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").some(path => path.startsWith("node_modules") || path.startsWith("build")), false);
  assert.equal(f.order()[0], "full", "The full check runs first and builds what the task commands read");
  for (const run of runs) {
    const task = f.plan.value.tasks.find(item => item.id === run.value.taskId)!;
    const environment = f.store.get<Environment>(f.plan.value.environment.id, f.plan.value.environment.revision)!.value;
    assert.deepEqual(run.value.checks.map(check => hashJson(check.command)), checkCommands(task, environment).map(command => hashJson(command)),
      "The saved checks keep the order every reader checks");
  }
  // A worktree whose Git does not ignore the link (a clean source cannot reach it otherwise): refused, and the link taken back.
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "omg-ex1-unignored-"))), source = join(bare, "source"), tree = join(bare, "tree");
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  mkdirSync(join(source, "node_modules"), { recursive: true }); mkdirSync(tree);
  git(tree, ["init", "-b", "main"]); writeFileSync(join(tree, "README.md"), "x"); git(tree, ["add", "README.md"]);
  git(tree, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  assert.throws(() => linkDependencies({ ...root, sourceRoot: source, path: tree }), { code: "worktree_dependencies_unsupported" });
  assert.equal(existsSync(join(tree, "node_modules")), false);
  const h = ex1Fixture(t, { modules: true });
  h.behave({ implement: "fail" });
  await h.run();
  const other = h.store.get<ExecutionRoot>("execution-root:p")!.value;
  rmSync(join(other.path, "node_modules")); mkdirSync(join(other.path, "node_modules"));
  await assert.rejects(h.run({ retry: true }), { code: "worktree_dependencies_invalid" });
});

/** Runs `body` with every engine module loaded from exactly `commit`, in its own process (the era check of om-run). */
function ex1AtCommit(directory: string, database: string, commit: string, name: string, body: string): unknown {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const loader = join(directory, `${name}-loader.mjs`), producer = join(directory, `${name}-producer.mjs`), served = join(directory, `${name}-served.log`);
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
  writeFileSync(served, "");
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from ${JSON.stringify(typescript)};
let root, log, prefixes;
export function initialize(data) {
  root = data.root; log = data.log;
  prefixes = [root, pathToFileURL(realpathSync(fileURLToPath(root)) + '/').href].map(base => new URL('dist/src/', base).href);
}
export async function load(url, context, next) {
  const prefix = prefixes.find(item => url.startsWith(item));
  if (prefix && /\\.js$/.test(url)) {
    const relative = 'src/' + url.slice(prefix.length).replace(/\\.js$/, '.ts');
    appendFileSync(log, relative + '\\n');
    const source = execFileSync('git', ['show', ${JSON.stringify(commit)} + ':' + relative], { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  if (url.startsWith('file:') && url.includes('/dist/src/') && !url.includes('/node_modules/'))
    throw new Error('An engine module outside the era checkout: ' + url);
  return next(url, context);
}`);
  writeFileSync(producer, `import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository, database] = process.argv.slice(2);
const src = path => pathToFileURL(join(repository, 'dist/src', path)).href;
const { Store } = await import(src('storage/store.js'));
const { ProductEngine } = await import(src('product/engine.js'));
const store = new Store(database), engine = new ProductEngine(store);
const out = value => process.stdout.write(JSON.stringify(value));
try {
${body}
} finally { store.close(); }`);
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},
    { data: { root: ${JSON.stringify(pathToFileURL(repository).href)}, log: ${JSON.stringify(served)} } });`;
  const output: unknown = JSON.parse(execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, database],
    { cwd: repository, encoding: "utf8", timeout: 180_000, maxBuffer: 10_000_000, env: { ...process.env } }));
  const loaded = readFileSync(served, "utf8").split("\n").filter(Boolean);
  assert.ok(loaded.includes("src/storage/store.ts") && loaded.includes("src/execution/runner.ts"), `The producer ran on the modules of ${commit}: ${loaded.join(", ")}`);
  return output;
}

test("EX1 a launch record is closed once, from sent; a subject without its exact task, attempt, role or ordinal is refused before any write", t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "omg-ex1-send-")));
  const store = new Store(join(directory, "state.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const plan = { id: "plan:p:x", revision: 1, hash: "a".repeat(64) };
  const subject = { project: "p", plan, task: "task:abc", attempt: 1, role: "implement" as const, ordinal: 1, correction: false, admission: null, feedback: null };
  for (const wrong of [{ attempt: 0 }, { ordinal: 0 }, { role: "chat" }, { task: "" }])
    assert.throws(() => new ExecutionSendHandle(store, { ...subject, ...wrong } as never, "x", { hash: "h", chars: 1 }), { code: "execution_send_invalid" });
  assert.throws(() => new ExecutionSendHandle(store, subject, "x", { hash: "h", chars: 0 }), { code: "execution_send_invalid" });
  assert.equal(store.list(EXECUTION_SEND_KIND).length, 0);
  const handle = new ExecutionSendHandle(store, subject, "x", { hash: "h", chars: 10 });
  handle.close("answered", null);
  assert.throws(() => handle.close("failed", null), { code: "execution_send_invalid" });
  store.writeMany([handle.take()!]);
  assert.equal(store.get<ExecutionSend>(handle.id)!.value.status, "answered");
  assert.throws(() => new ExecutionSendHandle(store, subject, "x", { hash: "h", chars: 10 }), { code: "revision_conflict" }, "The same launch is one record");
});

// ---- Return 1 (№3961) ----
test("EX1 №3961-1 a negative review is applied with its launch: a lost process right after it buys no second review — a plan finding stops with no launch, a code finding goes to its correction", async t => {
  const f = ex1Fixture(t);
  f.behave({ "review:1": "plan-addressed" });
  assert.equal(await ex1Process(f, {}, "needs_plan"), 9);
  assert.deepEqual([f.store.list<TaskRun>("task-run")[0]!.value.state, f.sends().map(row => row.value.status)], ["needs_plan", ["answered", "answered"]]);
  await f.run({ retry: true });
  assert.equal(f.provider().length, 2, "A plan finding launches nothing more");
  assert.equal(f.store.list<TaskRun>("task-run")[0]!.value.state, "needs_plan");
  const g = ex1Fixture(t);
  g.behave({ "review:1": "code" });
  assert.equal(await ex1Process(g, {}, "needs_code"), 9);
  const runs = await g.run({ retry: true });
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"]);
  assert.deepEqual(g.provider().map(call => call.mode), ["implement", "review", "implement", "review", "implement", "review"],
    "The code finding is corrected; the reviewed tree is never reviewed again");
  assert.equal(runs[0]!.value.attempt, 2);
  // Current production closes the review launch and applies its verdict in the same write.
  for (const kind of ["plan", "code"] as const) {
    const h = ex1Fixture(t, { budget: { maxCorrections: 0 } });
    h.behave({ "review:1": kind === "plan" ? "plan-addressed" : kind });
    const write = h.store.writeMany.bind(h.store); let applied = 0;
    h.store.writeMany = ((writes, guards) => {
      const negative = writes.find(item => item.kind === "task-run" && (item.value as TaskRun).review?.verdict === "request_changes");
      if (negative) {
        const run = negative.value as TaskRun;
        assert.equal(run.state, kind === "plan" ? "needs_plan" : "needs_code");
        const closures = writes.filter(item => item.kind === EXECUTION_SEND_KIND);
        assert.equal(closures.length, 1);
        const send = closures[0]!.value as ExecutionSend;
        assert.deepEqual([send.plan, send.task, send.attempt, send.role, send.status],
          [run.plan, run.taskId, run.attempt, "review", "answered"]);
        applied++;
      }
      return write(writes, guards);
    }) as Store["writeMany"];
    let stopped: Revision<TaskRun>[];
    try { stopped = await h.run({ maxCorrections: 0 }); }
    finally { h.store.writeMany = write; }
    assert.equal(applied, 1, `${kind}: the producer wrote one atomic negative outcome`);
    const saved = stopped[0]!;
    h.reopen();
    assert.deepEqual(h.store.get(saved.id), saved);
    const entered = await h.run({ maxCorrections: 0 });
    assert.deepEqual(entered[0], saved, `${kind}: cold entry preserves the applied verdict`);
    assert.equal(h.provider().length, 2, `${kind}: the saved review is not bought again`);
  }
});

test("EX1 №3961-3 the reads of a decision are addressed by its plan and task: other plans' launches add nothing to the budget or the corrections read", async t => {
  const f = ex1Fixture(t);
  await f.run();
  const admission = { pilot: reference(f.store.get("reader-pilot:p")!), execution: f.store.get<ReaderPilotSettings>("reader-pilot:p")!.value.execution! };
  const task = f.plan.value.tasks[0]!;
  const measure = () => {
    let rows = 0;
    const identities = f.store.identities.bind(f.store), get = f.store.get.bind(f.store), list = f.store.list.bind(f.store);
    f.store.identities = ((...args: Parameters<Store["identities"]>) => { const found = identities(...args); rows += found.length; return found; }) as Store["identities"];
    f.store.get = ((...args: Parameters<Store["get"]>) => { const found = get(...args); if (found) rows++; return found; }) as Store["get"];
    f.store.list = ((...args: Parameters<Store["list"]>) => { const found = list(...args); rows += found.length; return found; }) as Store["list"];
    try { requireExecutionBudget(f.store, admission, f.plan, "implement"); correctionsUsed(f.store, f.plan, task); }
    catch (error) { if (!(error instanceof EngineError)) throw error; }
    finally { f.store.identities = identities; f.store.get = get; f.store.list = list; }
    return rows;
  };
  const before = measure();
  const other = "f".repeat(64);
  for (let index = 0; index < 300; index++) f.store.write({ id: `execution-send:p:${other}:${String(index).padStart(40, "0")}:1:implement:1`, kind: EXECUTION_SEND_KIND, expected: 0,
    value: { contract: "execution-send/v1", project: "p", plan: { id: `plan:p:external-inputs-v1:${other}`, revision: 1, hash: other }, task: `task:${index}`, attempt: 1,
      role: "implement", ordinal: 1, correction: true, admission: null, feedback: null, request: { hash: "h", chars: 1 }, group: null, status: "answered", usage: null, startedAt: index, finishedAt: index } as never });
  assert.equal(measure(), before, "300 launches of another plan are not read");
  assert.ok(before > 0);
});


// ---- EX2 (№3980): the correction sees what failed ----
import { checkFeedback, FIVE_CLASSES, IMPLEMENT_CLASSES, CORRECTION_CLASSES, REVIEW_CLASSES, REVIEW_PASS, REVIEW_CHANGES, REVIEW_CHANGES_ADDRESSED, reviewClasses, IMPLEMENT_UNEXECUTABLE, riskMap, CLARIFICATION_HEAD, CLARIFICATION_REVIEW } from "../src/execution/runner.js";

test("EX2 a correction sees what failed: a TAP failure on stdout under a warning on stderr reaches it — the not ok block with its expected and actual, the summary — and its launch names that feedback", async t => {
  const f = ex1Fixture(t, { tap: true });
  f.behave({ "implement:1": "wrong" });
  const runs = await f.run();
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"]);
  const correction = f.provider().filter(call => call.mode === "implement")[1]!.correction!;
  assert.match(correction.error!, /^failed check: .*full\.mjs → exit 1 \(its full stdout and stderr are saved in this attempt's checks\[0\]\)/);
  assert.match(correction.error!, /not ok 1 - produce returns its successor/);
  assert.match(correction.error!, /value: 3/, "actual");
  assert.match(correction.error!, /value: 2/, "expected");
  assert.match(correction.error!, /# fail 1/);
  assert.match(correction.error!, /ExperimentalWarning/, "the stderr tail too");
  const send = f.sends().find(row => row.value.role === "implement" && row.value.attempt === 2)!.value;
  assert.deepEqual([send.correction, send.feedback?.check, send.feedback?.truncated, send.feedback?.chars === correction.error!.length], [true, 0, false, true]);
  assert.equal(f.sends().find(row => row.value.attempt === 1 && row.value.role === "implement")!.value.feedback, null, "a first attempt is shown nothing");
});

test("EX2 a failure without TAP gives the tails of both streams; a long one is cut within its limit and the cut is marked", async t => {
  const f = ex1Fixture(t);
  f.behave({ "implement:1": "wrong" });
  await f.run();
  const correction = f.provider().filter(call => call.mode === "implement")[1]!.correction!;
  assert.match(correction.error!, /^failed check: /);
  assert.match(correction.error!, /AssertionError/);
  const block = (n: number) => `not ok ${n} - case ${n}\n  ---\n  error: |-\n${"    + actual - expected\n".repeat(400)}  ...`;
  const stdout = [...Array.from({ length: 10 }, (_, n) => block(n + 1)), "# tests 10", "# fail 10"].join("\n");
  const long = checkFeedback({ executable: "node", args: ["--test"] }, { exitCode: 1, signal: null, stdout, stderr: "warning\n".repeat(500) }, 3, 4000);
  assert.ok(long.text.length <= 4000, `${long.text.length}`);
  assert.equal(long.truncated, true);
  assert.match(long.text, /\[cut: /);
  assert.match(long.text, /^failed check: node --test → exit 1 .*checks\[3\]/);
  assert.match(long.text, /not ok 1 - case 1/);
  const quiet = checkFeedback({ executable: "/x/tsc", args: ["-p", "."] }, { exitCode: 2, signal: null, stdout: "src/a.ts(1,1): error TS2304: Cannot find name 'x'.", stderr: "" }, 0, 4000);
  assert.deepEqual([quiet.truncated, /error TS2304/.test(quiet.text), /^failed check: tsc -p \. → exit 2/.test(quiet.text)], [false, true, true]);
});

test("EX2 №3986-1 the outcome a correction answers survives a refused launch: after the gate refused the correction, the next one is shown the original not ok, its expected and actual and the saved check", async t => {
  const f = ex1Fixture(t, { tap: true });
  f.behave({ "implement:1": "wrong", "implement:2": "refuse" });
  const runs = await f.run();
  assert.equal(runs[0]!.value.state, "interrupted");
  f.behave({});
  const resumed = await f.run({ retry: true });
  assert.deepEqual(resumed.map(run => run.value.state), ["committed", "committed"]);
  const attempts = f.provider().filter(call => call.mode === "implement" && call.task === f.plan.value.tasks[0]!.id);
  const shown = attempts.at(-1)!.correction!.error!;
  assert.match(shown, /not ok 1 - produce returns its successor/);
  assert.match(shown, /value: 3/); assert.match(shown, /value: 2/);
  assert.match(shown, /checks\[0\]/);
  const needs = f.store.history<TaskRun>(resumed[0]!.id).find(row => row.value.state === "needs_code" && row.value.attempt === 1)!;
  const sends = f.sends().filter(row => row.value.role === "implement" && row.value.task === f.plan.value.tasks[0]!.id).sort((a, b) => a.value.attempt - b.value.attempt);
  assert.deepEqual(sends.map(row => [row.value.attempt, row.value.status, row.value.feedback?.check ?? null]), [[1, "answered", null], [2, "refused", 0], [3, "answered", 0]]);
  assert.deepEqual(sends.at(-1)!.value.feedback!.basis, reference(needs), "the correction names the exact outcome it answers");
});

// ---- EX3 (№4000): a task's correction limit is an integer 0..3, the task's in all ----
const EX3_BASE = "e3f2b98eb5d232caae3a0956bc8d17bbaa136f70";
const taskOne = (f: ReturnType<typeof ex1Fixture>) => f.plan.value.tasks[0]!;
const implementsOf = (f: ReturnType<typeof ex1Fixture>) => f.provider().filter(call => call.mode === "implement" && call.task === taskOne(f).id);

test("EX3 the limit of an admission is an integer 0..3: two and three are admitted and bound the command; four, a fraction, a negative or a string is refused by the command's form and by its writer, and a stored one by its reader", async t => {
  const f = ex1Fixture(t, { admit: false });
  const pilot = () => f.store.get("reader-pilot:p")!;
  for (const maxCorrections of [4, 1.5, -1, "1"]) {
    const before = pilot().revision;
    assert.throws(() => f.admit(f.execution({ maxCorrections } as never)), { code: "command_invalid" }, String(maxCorrections));
    assert.throws(() => configureReaderPilot(f.store, f.engine.environments, "p", { ...f.settings, execution: f.execution({ maxCorrections } as never) }, before,
      plan => planCurrentGuardsProbe(f, plan)), { code: "execution_admission_invalid" }, String(maxCorrections));
    assert.equal(pilot().revision, before, "nothing is written");
  }
  f.admit(f.execution({ maxCorrections: 2 }));
  await assert.rejects(f.run({ maxCorrections: 3 }), { code: "execution_corrections_exceeded" }, "the command asks no more than the admission");
  f.admit(f.execution({ maxCorrections: 3 }));
  assert.equal(f.store.get<ReaderPilotSettings>("reader-pilot:p")!.value.execution!.maxCorrections, 3);
  await assert.rejects(f.run({ maxCorrections: 4 }), { code: "execution_corrections_exceeded" });
  // A stored pilot whose limit no writer could have written is refused by the reader that shares the writer's form.
  const stored = f.store.get<ReaderPilotSettings>("reader-pilot:p")!, second = new Store(f.database);
  for (const [index, maxCorrections] of [4, 1.5].entries()) {
    second.write({ id: stored.id, kind: "reader-pilot", expected: stored.revision + index,
      value: { ...stored.value, execution: { ...stored.value.execution!, maxCorrections } } as never });
    await assert.rejects(f.run({ maxCorrections: 3 }), { code: "reader_pilot_invalid" }, String(maxCorrections));
  }
  second.close();
  assert.deepEqual([f.sends().length, f.store.list("task-run").length], [0, 0]);
});

test("EX3 a task's three corrections: a failed check, its correction, a negative review, the next correction shown its finding — committed with two corrections used", async t => {
  const f = ex1Fixture(t, { tap: true, budget: { maxCorrections: 3 } });
  // AT3a: the failed check is read by the reviewer first (code), then the green candidate gets its negative review.
  f.behave({ "implement:1": "wrong", "review:2": "code" });
  const runs = await f.run({ maxCorrections: 3 });
  assert.deepEqual(runs.map(run => [run.value.state, run.value.attempt]), [["committed", 3], ["committed", 1]]);
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "review", "implement", "review", "implement", "review", "implement", "review"]);
  const [, sighted, reviewed] = implementsOf(f);
  assert.match(sighted!.correction!.error!, /not ok 1 - produce returns its successor/, "the first correction is shown the failed check");
  assert.deepEqual(reviewed!.correction!.review, { verdict: "request_changes", kind: "code", findings: [{ text: "The result is wrong", address: null }],
    contract: EXECUTION_REVIEW_CONTRACT }, "the next is shown the review's finding");
  assert.equal(reviewed!.correction!.error, "The result is wrong");
  const sends = f.sends().filter(row => row.value.role === "implement" && row.value.task === taskOne(f).id).sort((a, b) => a.value.attempt - b.value.attempt);
  assert.deepEqual(sends.map(row => [row.value.attempt, row.value.correction, row.value.feedback?.check ?? null]), [[1, false, null], [2, true, 0], [3, true, null]]);
  assert.equal(correctionsUsed(f.store, f.plan, taskOne(f)), 2);
});

test("EX3 the limit is the task's in all: a restart and a new admission continue the count — under three the fourth counted correction is never launched, and no later revision opens one", async t => {
  const f = ex1Fixture(t, { tap: true });
  f.behave({ implement: "wrong" });
  const first = await f.run({ maxCorrections: 1 });
  assert.deepEqual([first[0]!.value.state, implementsOf(f).length], ["needs_code", 2]);
  await assert.rejects(f.run({ retry: true, maxCorrections: 1 }), { code: "execution_corrections_exhausted" });
  f.reopen();
  f.admit(f.execution({ maxCorrections: 3 }));
  const second = await f.run({ retry: true, maxCorrections: 3 });
  assert.deepEqual([second[0]!.value.state, second[0]!.value.attempt], ["needs_code", 4]);
  assert.equal(implementsOf(f).length, 4, "two more, not three: the first counted correction is the task's");
  assert.equal(correctionsUsed(f.store, f.plan, taskOne(f)), 3);
  f.reopen();
  f.admit(f.execution({ maxCorrections: 3, roleLaunches: 41 }));
  await assert.rejects(f.run({ retry: true, maxCorrections: 3 }), { code: "execution_corrections_exhausted" });
  assert.deepEqual([implementsOf(f).length, f.sends().length], [4, 8], "the fourth correction reaches no provider and is no launch (AT3a: each failed check had its review)");
  assert.equal(f.store.get<TaskRun>(second[0]!.id)!.revision, second[0]!.revision, "the refusal writes nothing");
});

test("EX3 the shared limits stop an execution with corrections left: launches or input, refused before any launch; a new admission continues with the correction the saved check asks", async t => {
  const f = ex1Fixture(t, { tap: true, budget: { maxCorrections: 3, roleLaunches: 3 } });
  f.behave({ implement: "wrong" });
  const runs = await f.run({ maxCorrections: 3 });
  assert.equal(runs[0]!.value.state, "interrupted");
  assert.match(runs[0]!.value.error!, /^execution_budget_exhausted/);
  // AT3a: each failed check is read by the reviewer under the same budget — the third launch is that review.
  assert.deepEqual([implementsOf(f).length, f.sends().length, correctionsUsed(f.store, f.plan, taskOne(f))], [2, 3, 1], "corrections are left, yet nothing is launched");
  f.behave({});
  f.admit(f.execution({ maxCorrections: 3, roleLaunches: 8 }));
  const resumed = await f.run({ retry: true, maxCorrections: 3 });
  assert.deepEqual(resumed.map(run => run.value.state), ["committed", "committed"]);
  assert.match(implementsOf(f).at(-1)!.correction!.error!, /not ok 1 - produce returns its successor/);
  assert.equal(correctionsUsed(f.store, f.plan, taskOne(f)), 2);
  const g = ex1Fixture(t, { tap: true, budget: { maxCorrections: 3, softInput: 2500, roleReserve: { implement: 1000, review: 1000 } } });
  g.behave({ implement: "wrong" });
  const stopped = await g.run({ maxCorrections: 3 });
  assert.equal(stopped[0]!.value.state, "interrupted");
  assert.match(stopped[0]!.value.error!, /^execution_budget_exhausted: The admitted input would be exceeded/);
  assert.deepEqual([implementsOf(g).length, correctionsUsed(g.store, g.plan, taskOne(g))], [1, 0], "AT3a: the review of the failed check took the input the correction needed");
});

test("EX3 era: the base stops a task at its negative review with its one correction spent; under a new admission of three the new code continues it — the saved review is shown to the correction, never bought again, and the count goes on from the base's", async t => {
  const f = ex1Fixture(t, { legacy: true, tap: true });
  f.behave({ "implement:1": "wrong", "review:1": "code" });
  const command = JSON.stringify(f.command());
  assert.deepEqual(ex1AtCommit(f.directory, f.database, EX3_BASE, "ex3-era", `
out((await engine.execute(${command})).map(run => run.value.state));`), ["needs_code"]);
  f.reopen();
  const stopped = f.store.list<TaskRun>("task-run")[0]!;
  assert.deepEqual([stopped.value.attempt, stopped.value.review?.verdict], [2, "request_changes"]);
  await assert.rejects(f.run({ retry: true, maxCorrections: 1 }), { code: "execution_corrections_exhausted" }, "the base's admission reads as it wrote it");
  assert.equal(correctionsUsed(f.store, f.plan, taskOne(f)), 1);
  f.admit(f.execution({ maxCorrections: 3 }));
  const runs = await f.run({ retry: true, maxCorrections: 3 });
  assert.deepEqual(runs.map(run => [run.value.state, run.value.attempt]), [["committed", 3], ["committed", 1]]);
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "implement", "review", "implement", "review", "implement", "review"],
    "the saved negative review is not bought again before its correction");
  assert.deepEqual(implementsOf(f)[2]!.correction!.review, { verdict: "request_changes", kind: "code", findings: ["The result is wrong"] });
  assert.equal(correctionsUsed(f.store, f.plan, taskOne(f)), 2);
});

// ---- EX4 (№4016): the rule of paths; a task's addressed limit in all; one limit per task in every branch ----
const EX4_BASE = "39c63aad5f14730a45430c2ca016c61d8dea6307";
const addressedTo = (f: ReturnType<typeof ex1Fixture>, task: string, maxCorrections: number, general: Partial<Omit<ExecutionAdmissionSettings, "plan">> = {}) =>
  f.admit(f.execution({ ...general, taskCorrections: [{ task, maxCorrections }] }));

test("EX4 an addressed limit names one exact task of this plan, once: a task of another plan, a forged id, a duplicate, an empty list or a limit of the wrong form is refused by its writer and its command; a stored one is refused by the boundary that reads it; a command of five passes under it", async t => {
  const f = ex1Fixture(t, { admit: false });
  const pilot = () => f.store.get("reader-pilot:p")!, one = taskOne(f).id;
  const refuse = (taskCorrections: unknown, code: string, field?: string) => {
    const before = pilot().revision;
    assert.throws(() => f.admit(f.execution({ taskCorrections } as never)),
      (error: EngineError) => error.code === code && (!field || (error.details as { field?: string }).field === field), JSON.stringify(taskCorrections));
    assert.throws(() => configureReaderPilot(f.store, f.engine.environments, "p", { ...f.settings, execution: f.execution({ taskCorrections } as never) }, before,
      plan => planCurrentGuardsProbe(f, plan)), { code: "execution_admission_invalid" }, JSON.stringify(taskCorrections));
    assert.equal(pilot().revision, before, "nothing is written");
  };
  // T4 and the form: an absent limit or task, an empty list, a limit that is no count, a map in place of the list.
  for (const value of [[], [{ task: one }], [{ maxCorrections: 5 }], [{ task: one, maxCorrections: 1.5 }], [{ task: one, maxCorrections: -1 }],
    [{ task: one, maxCorrections: "5" }], [{ task: "", maxCorrections: 5 }], [{ task: one, maxCorrections: 5, extra: true }], { [one]: 5 }]) refuse(value, "command_invalid");
  // The producer: a task of another plan's namespace, a forged id, the same task twice — each addressed to its entry.
  refuse([{ task: `task:${hashJson(["q", "graph", "node"]).slice(0, 40)}`, maxCorrections: 5 }], "execution_admission_invalid", "execution.taskCorrections.0.task");
  refuse([{ task: one, maxCorrections: 5 }, { task: one.replace(/.$/, last => last === "0" ? "1" : "0"), maxCorrections: 5 }], "execution_admission_invalid", "execution.taskCorrections.1.task");
  refuse([{ task: one, maxCorrections: 5 }, { task: one, maxCorrections: 4 }], "execution_admission_invalid", "execution.taskCorrections.1.task");
  addressedTo(f, one, 5, { maxCorrections: 3 });
  assert.deepEqual(f.store.get<ReaderPilotSettings>("reader-pilot:p")!.value.execution!.taskCorrections, [{ task: one, maxCorrections: 5 }]);
  await assert.rejects(f.run({ maxCorrections: 6 }), { code: "execution_corrections_exceeded" }, "a command asks no more than the admission's greatest limit");
  // The reader takes only what its writer could write: a stored foreign task or a duplicate is refused at the boundary.
  const stored = f.store.get<ReaderPilotSettings>("reader-pilot:p")!, second = new Store(f.database);
  const forged = [[{ task: `task:${"0".repeat(40)}`, maxCorrections: 5 }], [{ task: one, maxCorrections: 5 }, { task: one, maxCorrections: 9 }]];
  for (const [index, taskCorrections] of forged.entries()) {
    second.write({ id: stored.id, kind: "reader-pilot", expected: stored.revision + index, value: { ...stored.value, execution: { ...stored.value.execution!, taskCorrections } } as never });
    await assert.rejects(f.run({ maxCorrections: 5 }), { code: "execution_admission_invalid" }, JSON.stringify(taskCorrections));
  }
  second.write({ id: stored.id, kind: "reader-pilot", expected: stored.revision + forged.length, value: stored.value as never });
  second.close();
  assert.deepEqual([f.sends().length, f.store.list("task-run").length], [0, 0]);
  const runs = await f.run({ maxCorrections: 5 });
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"], "a command of five is not refused under the addressed limit");
});

test("EX4 era: the three corrections the base used count — an addressed five gives exactly two more; a restart and a repeated admission give no sixth; the limit is absolute, and the neighbouring task keeps the ordinary three", async t => {
  const f = ex1Fixture(t, { legacy: true, budget: { maxCorrections: 3 } });
  f.behave({ implement: "wrong" });
  const command = JSON.stringify(f.command({ maxCorrections: 3 }));
  assert.deepEqual(ex1AtCommit(f.directory, f.database, EX4_BASE, "ex4-era", `
out((await engine.execute(${command})).map(run => [run.value.state, run.value.attempt]));`), [["needs_code", 4]]);
  f.reopen();
  // AT3a return №4141 P2-1: the base's saved failed check is first reviewed once (no implementation); then the limit stands.
  const [reviewed] = await f.run({ retry: true, maxCorrections: 3 });
  assert.deepEqual([reviewed!.value.state, reviewed!.value.attempt, reviewed!.value.review?.kind, implementsOf(f).length], ["needs_code", 4, "code", 4]);
  await assert.rejects(f.run({ retry: true, maxCorrections: 3 }), { code: "execution_corrections_exhausted" }, "the base's records read as it wrote them");
  await assert.rejects(f.run({ retry: true, maxCorrections: 5 }), { code: "execution_corrections_exceeded" }, "five is no limit without its address");
  assert.equal(correctionsUsed(f.store, f.plan, taskOne(f)), 3);
  const one = taskOne(f).id, two = f.plan.value.tasks[1]!;
  addressedTo(f, one, 5);
  const more = await f.run({ retry: true, maxCorrections: 5 });
  assert.deepEqual([more[0]!.value.state, more[0]!.value.attempt, implementsOf(f).length, correctionsUsed(f.store, f.plan, taskOne(f))], ["needs_code", 6, 6, 5]);
  await assert.rejects(f.run({ retry: true, maxCorrections: 5 }), { code: "execution_corrections_exhausted" });
  f.reopen();
  addressedTo(f, one, 5);
  await assert.rejects(f.run({ retry: true, maxCorrections: 5 }), { code: "execution_corrections_exhausted" }, "a repeated admission restates five, it adds nothing");
  assert.equal(implementsOf(f).length, 6, "no sixth correction reaches the provider");
  // A new decision of six is six in all: exactly one more, which here succeeds; the next task is held to the ordinary three.
  addressedTo(f, one, 6);
  f.behave({ implement: "wrong", "implement:7": "ok" });
  const last = await f.run({ retry: true, maxCorrections: 6 });
  assert.deepEqual(last.map(run => [run.value.state, run.value.attempt]), [["committed", 7], ["needs_code", 4]]);
  assert.deepEqual([correctionsUsed(f.store, f.plan, taskOne(f)), correctionsUsed(f.store, f.plan, two)], [6, 3]);
  assert.equal(f.provider().filter(call => call.mode === "implement" && call.task === two.id).length, 4, "the neighbour's own count, never the addressed one");
});

test("EX4 one limit per task in every branch — after a failed check, after a negative review, on retry: the addressed task takes its two, its neighbour under an ordinary none takes none; the correction after a review is given that saved finding and the rule of paths", async t => {
  const f = ex1Fixture(t, { budget: { maxCorrections: 0 } });
  const one = taskOne(f).id, serve = "serve: POST /api/command answers persisted=false after the store moved";
  addressedTo(f, one, 2, { maxCorrections: 0 });
  // AT3a: the failed check gets its review (code) first; the green candidate then its negative review.
  f.behave({ "implement:1": "wrong", "review:2": `code:${serve}`, "review:4": "code:The neighbour is wrong" });
  const runs = await f.run({ maxCorrections: 2 });
  assert.deepEqual(runs.map(run => [run.value.state, run.value.attempt]), [["committed", 3], ["needs_code", 1]]);
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "review", "implement", "review", "implement", "review", "implement", "review"]);
  const [first, afterCheck, afterReview] = implementsOf(f);
  // EX5: the rule of paths is the first of the five classes every implementation is given (the EX4 rule, folded in).
  assert.ok(first!.brief.includes(FIVE_CLASSES) && first!.brief.includes(IMPLEMENT_CLASSES) && !first!.brief.includes(CORRECTION_CLASSES), "every implementation is given the rule of paths");
  assert.ok(afterCheck!.brief.includes(CORRECTION_CLASSES) && afterReview!.brief.includes(CORRECTION_CLASSES), "a correction is tied to what it answers");
  assert.deepEqual(afterReview!.correction!.review, { verdict: "request_changes", kind: "code", findings: [{ text: serve, address: null }], contract: EXECUTION_REVIEW_CONTRACT });
  await assert.rejects(f.run({ retry: true, maxCorrections: 2 }), { code: "execution_corrections_exhausted" }, "the neighbour's retry");
  assert.equal(f.provider().length, 8);
  const g = ex1Fixture(t, { budget: { maxCorrections: 0 } });
  addressedTo(g, taskOne(g).id, 2, { maxCorrections: 0 });
  g.behave({ "implement:2": "wrong" });
  const failed = await g.run({ maxCorrections: 2 });
  assert.deepEqual(failed.map(run => [run.value.state, run.value.attempt]), [["committed", 1], ["needs_code", 1]], "the neighbour's failed check opens no correction");
  assert.equal(g.provider().filter(call => call.mode === "implement").length, 2);
});

test("EX4 the shared limits stop a task earlier than its addressed limit: launches are refused before any launch with corrections left", async t => {
  const f = ex1Fixture(t, { budget: { maxCorrections: 3, roleLaunches: 3 } });
  addressedTo(f, taskOne(f).id, 5, { maxCorrections: 3, roleLaunches: 3 });
  f.behave({ implement: "wrong" });
  const runs = await f.run({ maxCorrections: 5 });
  assert.equal(runs[0]!.value.state, "interrupted");
  assert.match(runs[0]!.value.error!, /^execution_budget_exhausted/);
  assert.deepEqual([implementsOf(f).length, f.sends().length, correctionsUsed(f.store, f.plan, taskOne(f))], [2, 3, 1], "AT3a: the third launch is the review of the failed check");
});

// ---- EX5 (№4035): the five classes of self-review in the requests of both roles; every confirmed finding in one pass ----
const EX5_BASE = "abd9dd8943400f4ff978439f8feb9957a7c9d4af";
const absence = "ABSENCE: the intake store is missing — CLI command opens it with create-if-missing — after a lost response it reports persisted=false";
const masquerade = "MASQUERADE: an empty file without tables in place of the store — serve opens it as a new store — POST /api/command answers on a fresh canon";
const briefsOf = (f: ReturnType<typeof ex1Fixture>, mode: string) => f.provider().filter(call => call.mode === mode);

test("EX5 both roles are given the five classes from one place, made concrete on the task's own contract; two independent findings pass the adapter, the saved review and the correction whole; a pass with no finding commits", async t => {
  const f = ex1Fixture(t);
  f.behave({ "review:1": `code:${absence} | ${masquerade}` });
  const runs = await f.run({ maxCorrections: 1 });
  assert.deepEqual(runs.map(run => [run.value.state, run.value.attempt]), [["committed", 2], ["committed", 1]]);
  const [one, two] = f.plan.value.tasks as [CompiledTask, CompiledTask];
  const implement = briefsOf(f, "implement"), review = briefsOf(f, "review");
  assert.deepEqual([implement.length, review.length], [3, 3]);
  for (const call of [...implement, ...review]) {
    const task = call.task === one.id ? one : two;
    assert.ok(call.brief.includes(FIVE_CLASSES) && call.brief.includes(riskMap(task)), `${call.mode}: the five classes and the risk map of its own task`);
  }
  // AT3a: under admission the review rules are the addressed ones (one exact form), and the implementation may name an unexecutable contract.
  assert.ok(implement.every(call => call.brief.includes(IMPLEMENT_CLASSES) && call.brief.includes(IMPLEMENT_UNEXECUTABLE) && !call.brief.includes(reviewClasses("execution/v2"))));
  assert.ok(review.every(call => call.brief.includes(reviewClasses("execution/v2")) && !call.brief.includes(REVIEW_CLASSES) && !call.brief.includes(IMPLEMENT_CLASSES)));
  assert.deepEqual(implement.map(call => call.brief.includes(CORRECTION_CLASSES)), [false, true, false], "only the correction is told what a correction owes");
  // СОСЕДИ in the adapter's own words: a targeted check is allowed, the full check is the engine's, once.
  assert.ok(implement.every(call => call.brief.includes("targeted diagnostic checks of your own change are allowed") && !call.brief.includes("The engine owns testing")));
  // The map is the task's own: its write paths, what it produces, its kind of state.
  const map = riskMap(one);
  for (const part of [one.writePaths[0]!, one.produces[0]!, `${one.boundary.state} state`]) assert.ok(map.includes(part), part);
  // Two independent findings: kept by the adapter and the saved review, and given whole to the correction.
  const negative = f.store.history<TaskRun>(runs[0]!.id).find(row => row.value.state === "needs_code")!;
  assert.deepEqual(negative.value.review, { verdict: "request_changes", kind: "code", findings: [absence, masquerade].map(text => ({ text, address: null })),
    contract: EXECUTION_REVIEW_CONTRACT });
  assert.deepEqual(implement[1]!.correction!.review, negative.value.review);
  assert.equal(implement[1]!.correction!.error, `${absence}\n${masquerade}`);
  // A pass with an empty array is a pass: it commits.
  // AT3a: under admission a verdict is read in the addressed form and marked with its contract.
  const passed = { verdict: "pass", kind: "none", findings: [], contract: EXECUTION_REVIEW_CONTRACT };
  assert.deepEqual(runs.map(run => run.value.review), [passed, passed]);
});

test("EX5 a review that finds the plan unexecutable among code defects returns all its findings with kind=plan: the task stops for its plan with every finding kept, and no correction is bought", async t => {
  const f = ex1Fixture(t);
  const plan = "PLAN: the contract asks persisted=false where its own criterion forbids it after a lost response";
  f.behave({ "review:1": `plan-addressed:${absence} | ${plan}` });
  const runs = await f.run({ maxCorrections: 1 });
  assert.deepEqual(runs.map(run => run.value.state), ["needs_plan"]);
  // AT3a: the addressed form — the plan finding carries its address, the code one goes with it unaddressed.
  const review = runs[0]!.value.review!;
  assert.deepEqual([review.verdict, review.kind, review.contract, review.findings.map(item => typeof item === "string" ? item : [item.text, item.address === null])],
    ["request_changes", "plan", EXECUTION_REVIEW_CONTRACT, [[absence, true], [plan, false]]]);
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "review"]);
  const again = await f.run({ retry: true, maxCorrections: 1 });
  assert.equal(again[0]!.value.state, "needs_plan");
  assert.equal(f.provider().length, 2, "a plan finding buys nothing on a retry");
});

test("EX5 era: a negative review the base saved is read as it wrote it — its correction under the new code is given that finding with the five classes, and the task commits", async t => {
  const f = ex1Fixture(t, { legacy: true });
  f.behave({ "review:1": "code:The result is wrong" });
  const command = JSON.stringify(f.command({ maxCorrections: 0 }));
  assert.deepEqual(ex1AtCommit(f.directory, f.database, EX5_BASE, "ex5-era", `
out((await engine.execute(${command})).map(run => run.value.state));`), ["needs_code"]);
  assert.ok(!f.provider()[0]!.brief.includes(FIVE_CLASSES), "the base asked by its own rule");
  f.reopen();
  const runs = await f.run({ retry: true, maxCorrections: 1 });
  assert.deepEqual(runs.map(run => [run.value.state, run.value.attempt]), [["committed", 2], ["committed", 1]]);
  const correction = briefsOf(f, "implement")[1]!;
  assert.deepEqual(correction.correction!.review, { verdict: "request_changes", kind: "code", findings: ["The result is wrong"] });
  assert.ok(correction.brief.includes(FIVE_CLASSES) && correction.brief.includes(CORRECTION_CLASSES));
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "review", "implement", "review", "implement", "review"], "the saved review is not bought again");
});

test("EX5 №4045 a reviewer that answers exactly in the forms its brief states is understood: a pass commits with no correction, changes go to a correction with every finding, a plan finding stops", async t => {
  const f = ex1Fixture(t);
  f.behave({ review: "literal" });
  const runs = await f.run({ maxCorrections: 1 });
  // AT3a: under admission the verdict is read in the addressed form and marked with its contract.
  const pass = { ...REVIEW_PASS, contract: EXECUTION_REVIEW_CONTRACT };
  assert.deepEqual(runs.map(run => [run.value.state, run.value.attempt, run.value.review]),
    [["committed", 1, pass], ["committed", 1, pass]], "the stated pass is the protocol's pass");
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "review", "implement", "review"], "no correction is bought for a green candidate");
  assert.ok(f.provider().filter(call => call.mode === "review").every(call => call.brief.includes(JSON.stringify(REVIEW_PASS))));
  const g = ex1Fixture(t);
  g.behave({ "review:1": `literal-code:${absence} | ${masquerade}`, review: "literal" });
  const corrected = await g.run({ maxCorrections: 1 });
  assert.deepEqual(corrected.map(run => [run.value.state, run.value.attempt]), [["committed", 2], ["committed", 1]]);
  assert.deepEqual(briefsOf(g, "implement")[1]!.correction!.review, { ...REVIEW_CHANGES_ADDRESSED, findings: [absence, masquerade].map(text => ({ text, address: null })),
    contract: EXECUTION_REVIEW_CONTRACT });
  assert.ok(briefsOf(g, "review")[0]!.brief.includes(JSON.stringify(REVIEW_CHANGES_ADDRESSED)) && !briefsOf(g, "review")[0]!.brief.includes(JSON.stringify(REVIEW_CHANGES)),
    "one exact changes form: the addressed one");
  // AT3a row 4: a plan finding in the literal form names no address — it does not stop the task; the code goes on.
  const h = ex1Fixture(t);
  h.behave({ "review:1": `literal-plan:${absence}` });
  const unaddressed = await h.run({ maxCorrections: 0 });
  assert.deepEqual(unaddressed.map(run => [run.value.state, run.value.review?.kind, run.value.error?.split(":")[0]]), [["needs_code", "plan", "review_plan_unaddressed"]]);
});

// ---- EX6 (№4068): the owner's clarification of an exact task's contract, in its admission, with no recompilation ----
const EX6_BASE = "145d833e4937836033883bd2ef66846c4753ad39";
const VARIANT_1 = "Решение владельца (вариант 1): новый канон создаётся только явной инициализацией (CLI init). Приём поручения и восстановление работают с существующим каноном; его отсутствие не доказывает отсутствие commit. serve и npm run dev без канона не создают пустую базу и отвечают требованием явного init — это поведение по контракту, а не регрессия NEIGHBOURS.";

test("EX6 an owner's clarification of an exact task reaches that task's implementation, its correction and its review, and no other task's", async t => {
  const f = ex1Fixture(t);
  const one = taskOne(f).id;
  f.admit(f.execution({ taskClarifications: [{ task: one, text: VARIANT_1 }] }));
  f.behave({ "review:1": "code:NEIGHBOURS: serve without the store answers that init is required" });
  const runs = await f.run({ maxCorrections: 1 });
  assert.deepEqual(runs.map(run => [run.value.state, run.value.attempt]), [["committed", 2], ["committed", 1]]);
  assert.deepEqual(f.provider().filter(call => call.task === one).map(call => call.mode), ["implement", "review", "implement", "review"]);
  for (const [index, call] of f.provider().entries()) {
    const own = call.task === one;
    assert.equal(call.brief.includes(`${CLARIFICATION_HEAD}${call.mode === "review" ? ` ${CLARIFICATION_REVIEW}` : ""}\n${VARIANT_1}`), own, `${index} ${call.mode}`);
    assert.equal(call.brief.includes(CLARIFICATION_REVIEW), own && call.mode === "review", `${index}: only the review is told how to judge by it`);
  }
  assert.ok(briefsOf(f, "implement")[1]!.brief.includes(CORRECTION_CLASSES), "the correction carries it with what a correction owes");
});

test("EX6 a clarification names one exact task of this plan, once, with its text: a foreign or forged task, a duplicate, an empty list or text, or another form is refused by its writer and its command; a stored one by the boundary that reads it", async t => {
  const f = ex1Fixture(t, { admit: false });
  const pilot = () => f.store.get("reader-pilot:p")!, one = taskOne(f).id;
  const refuse = (taskClarifications: unknown, code: string, field?: string) => {
    const before = pilot().revision;
    assert.throws(() => f.admit(f.execution({ taskClarifications } as never)),
      (error: EngineError) => error.code === code && (!field || (error.details as { field?: string }).field === field), JSON.stringify(taskClarifications));
    assert.throws(() => configureReaderPilot(f.store, f.engine.environments, "p", { ...f.settings, execution: f.execution({ taskClarifications } as never) }, before,
      plan => planCurrentGuardsProbe(f, plan)), { code: "execution_admission_invalid" }, JSON.stringify(taskClarifications));
    assert.equal(pilot().revision, before, "nothing is written");
  };
  for (const value of [[], [{ task: one }], [{ text: VARIANT_1 }], [{ task: one, text: "" }], [{ task: "", text: VARIANT_1 }], [{ task: one, text: 5 }],
    [{ task: one, text: VARIANT_1, extra: true }], { [one]: VARIANT_1 }]) refuse(value, "command_invalid");
  refuse([{ task: `task:${hashJson(["q", "graph", "node"]).slice(0, 40)}`, text: VARIANT_1 }], "execution_admission_invalid", "execution.taskClarifications.0.task");
  refuse([{ task: one, text: VARIANT_1 }, { task: one.replace(/.$/, last => last === "0" ? "1" : "0"), text: VARIANT_1 }], "execution_admission_invalid", "execution.taskClarifications.1.task");
  refuse([{ task: one, text: VARIANT_1 }, { task: one, text: "another" }], "execution_admission_invalid", "execution.taskClarifications.1.task");
  f.admit(f.execution({ taskClarifications: [{ task: one, text: VARIANT_1 }] }));
  const stored = f.store.get<ReaderPilotSettings>("reader-pilot:p")!, second = new Store(f.database);
  assert.deepEqual(stored.value.execution!.taskClarifications, [{ task: one, text: VARIANT_1 }]);
  const forged = [[{ task: `task:${"0".repeat(40)}`, text: VARIANT_1 }], [{ task: one, text: VARIANT_1 }, { task: one, text: "another" }]];
  for (const [index, taskClarifications] of forged.entries()) {
    second.write({ id: stored.id, kind: "reader-pilot", expected: stored.revision + index, value: { ...stored.value, execution: { ...stored.value.execution!, taskClarifications } } as never });
    await assert.rejects(f.run({ maxCorrections: 1 }), { code: "execution_admission_invalid" }, JSON.stringify(taskClarifications));
  }
  second.write({ id: stored.id, kind: "reader-pilot", expected: stored.revision + forged.length, value: stored.value as never });
  second.close();
  assert.deepEqual([f.sends().length, f.store.list("task-run").length], [0, 0]);
  assert.deepEqual((await f.run({ maxCorrections: 1 })).map(run => run.value.state), ["committed", "committed"]);
});

test("EX6 era: without a clarification every request is byte for byte the base's, and the admission the base wrote reads as it wrote it", async t => {
  const f = ex1Fixture(t, { legacy: true });
  const command = JSON.stringify(f.command({ maxCorrections: 1 }));
  assert.deepEqual(ex1AtCommit(f.directory, f.database, EX6_BASE, "ex6-era", `
out((await engine.execute(${command})).map(run => run.value.state));`), ["committed", "committed"]);
  const g = ex1Fixture(t, { legacy: true });
  assert.deepEqual((await g.run({ maxCorrections: 1 })).map(run => run.value.state), ["committed", "committed"]);
  // AT3a: the requests are the base's but for exactly what AT3a adds under admission — the unexecutable outcome of the
  // implementation (the engine's rule and the adapter's line) and the addressed form of the review rules.
  const beforeAT3a = (brief: string) => brief.replace(` ${IMPLEMENT_UNEXECUTABLE}`, "")
    .replace("When the contract cannot be executed as planned, return instead exactly outcome (\"contract_unexecutable\") and findings (array of {text, address}) as the request describes.\n", "")
    .replace(reviewClasses("execution/v2"), REVIEW_CLASSES);
  assert.deepEqual(g.provider().map(call => beforeAT3a(call.brief)), f.provider().map(call => call.brief), "no clarification, the base's requests");
  f.reopen();
  assert.deepEqual((await f.run({ retry: true, maxCorrections: 1 })).map(run => run.value.state), ["committed", "committed"]);
  assert.equal(f.provider().length, 4, "the base's results stand; nothing is bought again");
});


// ---- AT3a (№4125): needs_plan only by an addressed finding; a failed full check is read by the reviewer first ----
const AT3A_BASE = "e475bd594fc2f4cde4fb58b6f26f2083f7c00954";
test("AT3a probes: an address is the exact attempt — another plan, task, attempt or tree, an unknown requirement, a path inside the write paths, a check that was not run, did not fail or does not hold the failure — each refused by its producer", t => {
  const f = ex1Fixture(t, { admit: false });
  const task = taskOne(f), plan = reference(f.plan);
  const failed = { command: { executable: "node", args: ["full.mjs"] }, result: { exitCode: 1, signal: null, stdout: "not ok 1 - produce returns its successor\n", stderr: "", truncated: false } };
  const green = { command: { executable: "node", args: ["check.mjs"] }, result: { exitCode: 0, signal: null, stdout: "ok", stderr: "", truncated: false } };
  const context: AddressContext = { plan, task, attempt: 2, tree: "t".repeat(40), checks: [failed, green] as never, source: "review" };
  const address: PlanFindingAddress = { plan, task: task.id, attempt: 2, tree: "t".repeat(40), requirement: task.tests[0]!.id, norm: "check.mjs keeps produce(1) === 2", path: null,
    check: { index: 0, failure: "not ok 1 - produce returns its successor" } };
  const verdict = (changed: Partial<typeof address>, source: AddressContext["source"] = "review") =>
    planDefectOf([{ text: "a plan defect", address: { ...address, ...changed } }], { ...context, source });
  const ok = verdict({});
  assert.ok(ok.ok && ok.defect.contract === "execution-plan-defect/v1" && ok.defect.source === "review");
  assert.ok(verdict({ norm: null, path: "check.mjs" }).ok, "a necessary path outside the write paths");
  assert.ok(verdict({ check: null }).ok, "a finding that rests on no check needs none");
  const refused: [string, Partial<typeof address>, AddressContext["source"]?][] = [
    ["plan", { plan: { ...plan, hash: "f".repeat(64) } }], ["task", { task: "task:other" }], ["attempt", { attempt: 1 }], ["tree", { tree: "f".repeat(40) }],
    ["requirement", { requirement: "no-such-test" }], ["path", { norm: null, path: task.writePaths[0]! }], ["path", { norm: null, path: "../outside.mjs" }],
    ["check", { check: { index: 9, failure: "x" } }], ["check", { check: { index: 1, failure: "ok" } }], ["check.failure", { check: { index: 0, failure: "not ok 2 - another" } }],
    ["check", {}, "implementation"],
  ];
  for (const [field, changed, source] of refused) {
    const result = verdict(changed, source ?? "review");
    assert.ok(!result.ok && result.code === (source === "implementation" ? "implementation_address_foreign" : "review_address_foreign") && result.message.startsWith(`${field}:`),
      `${field} ${JSON.stringify(changed)}: ${JSON.stringify(result)}`);
  }
  assert.deepEqual(planDefectOf(["a plan defect without address"], context), { ok: false, code: "review_plan_unaddressed",
    message: "A plan defect names its exact address: plan, task, attempt, requirement and the contradicting norm or the necessary path" });
});

test("AT3a rows 3, 5c: an expectation the contract cancels outside the write paths — the failed check is read by the reviewer, whose addressed plan finding stops the task with its defect; no correction is bought, a retry launches nothing", async t => {
  const f = ex1Fixture(t, { tap: true });
  f.behave({ "implement:1": "wrong", "review:1": "plan-addressed" });
  const [run] = await f.run({ maxCorrections: 1 });
  assert.equal(run!.value.state, "needs_plan");
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "review"], "the reviewer reads the failed check before any correction");
  const defect = run!.value.planDefect!, address = defect.findings[0]!.address!;
  assert.deepEqual([defect.contract, defect.source, address.plan, address.task, address.attempt, address.tree, address.check?.index],
    ["execution-plan-defect/v1", "review", reference(f.plan), taskOne(f).id, 1, run!.value.tree, 0]);
  assert.ok(run!.value.checks[0]!.result.stdout.includes(address.check!.failure), "the failure the finding quotes is in the saved check");
  assert.equal(run!.value.review?.contract, EXECUTION_REVIEW_CONTRACT);
  assert.ok(briefsOf(f, "review")[0]!.brief.includes("The full check FAILED"), "the review is told the check failed and pass is not allowed");
  await f.run({ retry: true, maxCorrections: 1 });
  assert.equal(f.provider().length, 2);
});

test("AT3a rows 5b, 8: a defect of the permitted code fails an unchanged neighbouring test — the reviewer answers code, the correction is shown the check and the finding, and commits", async t => {
  const f = ex1Fixture(t, { tap: true });
  f.behave({ "implement:1": "wrong" });
  const runs = await f.run({ maxCorrections: 1 });
  assert.deepEqual(runs.map(run => [run.value.state, run.value.attempt]), [["committed", 2], ["committed", 1]]);
  const negative = f.store.history<TaskRun>(runs[0]!.id).find(row => row.value.state === "needs_code")!;
  assert.deepEqual([negative.value.review?.kind, negative.value.planDefect], ["code", undefined]);
  const correction = implementsOf(f)[1]!.correction!;
  assert.match(correction.error!, /not ok 1 - produce returns its successor/);
  assert.deepEqual((correction.review as { kind: string }).kind, "code");
});

test("AT3a rows 4, 9, 5a: a test outside the write paths named without an address, or a pass of a failed check, never stops the task — the code goes on with the refusal named", async t => {
  for (const [step, code] of [["plan", "review_plan_unaddressed"], ["plan-forged:tree", "review_address_foreign"], ["pass-red", "review_pass_on_failed_check"]] as const) {
    const f = ex1Fixture(t, { tap: true });
    f.behave({ "implement:1": "wrong", "review:1": step });
    const [run] = await f.run({ maxCorrections: 0 });
    assert.deepEqual([run!.value.state, run!.value.error?.split(":")[0], run!.value.planDefect, run!.value.commit], ["needs_code", code, undefined, null], step);
    assert.ok(run!.value.review, `${step}: the review is kept for the correction`);
  }
});

test("AT3a rows 6, 7: an implementation finds its contract unexecutable — with its address and no check it stops the task before any check or review; an invented check or a path inside the write paths is refused and the code goes on", async t => {
  for (const step of ["unexecutable", "unexecutable-path"] as const) {
    const f = ex1Fixture(t);
    f.behave({ "implement:1": step });
    const [run] = await f.run({ maxCorrections: 1 });
    assert.equal(run!.value.state, "needs_plan", step);
    const defect = run!.value.planDefect!;
    assert.deepEqual([defect.source, defect.findings[0]!.address!.tree, defect.findings[0]!.address!.check, run!.value.checks, run!.value.tree],
      ["implementation", null, null, [], null], step);
    assert.deepEqual(f.provider().map(call => call.mode), ["implement"], `${step}: nothing is checked or reviewed`);
    assert.ok(f.sends().every(row => row.value.status === "answered"), `${step}: the launch is counted`);
  }
  const g = ex1Fixture(t);
  g.behave({ "implement:1": "unexecutable-check" });
  const [run] = await g.run({ maxCorrections: 0 });
  assert.deepEqual([run!.value.state, run!.value.error?.split(":")[0], run!.value.planDefect], ["needs_code", "implementation_address_foreign", undefined]);
});

test("AT3a row 10: the saved outcome of a failed check's review is read on a repeat — a lost process right after it buys no second review", async t => {
  const f = ex1Fixture(t, { tap: true });
  f.behave({ "implement:1": "wrong", "review:1": "plan-addressed" });
  assert.equal(await ex1Process(f, {}, "needs_plan"), 9);
  f.reopen();
  const [run] = await f.run({ retry: true, maxCorrections: 1 });
  assert.equal(run!.value.state, "needs_plan");
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "review"], "nothing is bought again");
});

test("AT3a rows 11, 12: era — the code before AT3a stops a task on a plan finding of strings, and the new code reads it as it wrote it; without admission the requests and outcomes stay as they were", async t => {
  const f = ex1Fixture(t, { legacy: true });
  f.behave({ "review:1": "plan" });
  const command = JSON.stringify(f.command());
  assert.deepEqual(ex1AtCommit(f.directory, f.database, AT3A_BASE, "at3a-era", `
out((await engine.execute(${command})).map(run => run.value.state));`), ["needs_plan"]);
  f.reopen();
  const saved = f.store.list<TaskRun>("task-run")[0]!;
  assert.deepEqual([saved.value.review?.findings, saved.value.review?.contract, saved.value.planDefect], [["The responsibility cannot deliver"], undefined, undefined]);
  const [again] = await f.run({ retry: true });
  assert.deepEqual([again!.value.state, again!.revision, f.provider().length], ["needs_plan", saved.revision, 2], "read by its own era, nothing bought");
  const legacy = legacyExecutionFixture(t, "plan-defect");
  const [stopped] = await legacy.engine.executor.run("p", reference(legacy.plan), legacy.options);
  assert.deepEqual([stopped!.value.state, stopped!.value.review?.findings, stopped!.value.review?.contract], ["needs_plan", ["The proposed responsibility cannot deliver the required result"], undefined],
    "without admission a plan finding of strings stops as before (legacy repair route)");
  assert.ok(!legacy.calls().some(call => JSON.stringify(call.subject).includes("answerForm")), "no addressed form is asked without admission");
});

/** The engine in its own process, dying at once after the first task-run write the predicate (JS over `item`) accepts. */
async function ex1ProcessWhen(f: ReturnType<typeof ex1Fixture>, extra: Record<string, unknown>, predicate: string): Promise<number | null> {
  const script = join(f.directory, `engine-when-${Date.now()}.mjs`);
  writeFileSync(script, `import {Store} from ${JSON.stringify(new URL("../src/storage/store.js", import.meta.url).href)};
import {ProductEngine} from ${JSON.stringify(new URL("../src/product/engine.js", import.meta.url).href)};
const store = new Store(${JSON.stringify(f.database)}), write = store.writeMany.bind(store);
store.writeMany = (inputs, guards) => { const written = write(inputs, guards);
  if (inputs.some(item => item.kind === 'task-run' && (${predicate}))) process.exit(9);
  return written; };
try { await new ProductEngine(store).execute(${JSON.stringify(f.command(extra as never))}); } catch (error) { process.stderr.write(String(error.code ?? error.message)); }
store.close();`);
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env } });
  const [code] = await once(child, "exit") as [number | null];
  return code;
}
test("AT3a row 10 (№4135): a lost process between the failed full check and its review — the repeat runs the free checks again and buys the review once, no second review send", async t => {
  const f = ex1Fixture(t, { tap: true });
  f.behave({ "implement:1": "wrong", "review:1": "plan-addressed" });
  assert.equal(await ex1ProcessWhen(f, {}, "item.value.state === 'checking' && item.value.checks.some(check => check.result.exitCode !== 0)"), 9);
  f.reopen();
  const saved = f.store.list<TaskRun>("task-run")[0]!;
  assert.deepEqual([saved.value.state, saved.value.review, f.sends().map(row => row.value.role)], ["checking", null, ["implement"]], "it died after the failed check, before the review");
  const [run] = await f.run({ retry: true, maxCorrections: 1 });
  assert.equal(run!.value.state, "needs_plan");
  assert.deepEqual(f.sends().map(row => [row.value.role, row.value.attempt, row.value.status]).sort(), [["implement", 1, "answered"], ["review", 1, "answered"]],
    "one implementation, one review: the paid implementation is kept and the review is bought once");
  assert.equal(run!.value.planDefect!.findings[0]!.address!.check!.index, 0);
});

// ---- AT3a return №4141: the saved failed check is reviewed as saved; the unexecutable answer binds the real working copy ----
test("AT3a return №4141 P2-1: the live form of task 1 — a needs_code the code before AT3a wrote, with its candidate, a failed full check, no review and no correction left — is reviewed once as saved, with no implementation bought and no correction slot opened", async t => {
  for (const [verdict, state] of [["plan-addressed", "needs_plan"], ["ok", "needs_code"]] as const) {
    const f = ex1Fixture(t, { legacy: true, tap: true });
    f.behave({ "implement:1": "wrong" });
    const command = JSON.stringify(f.command({ maxCorrections: 0 }));
    assert.deepEqual(ex1AtCommit(f.directory, f.database, AT3A_BASE, `at3a-live-${verdict}`, `
out((await engine.execute(${command})).map(run => run.value.state));`), ["needs_code"]);
    f.reopen();
    const saved = f.store.list<TaskRun>("task-run")[0]!;
    assert.deepEqual([saved.value.state, saved.value.review, saved.value.checks.some(check => check.result.exitCode !== 0), saved.value.tree !== null, f.sends().map(row => row.value.role)],
      ["needs_code", null, true, true, ["implement"]], "the live form: candidate, failed check, no review");
    f.behave({ review: verdict });
    const [run] = await f.run({ retry: true, maxCorrections: 0 });
    assert.equal(run!.value.state, state, verdict);
    assert.deepEqual(f.sends().map(row => [row.value.role, row.value.attempt]).sort(), [["implement", 1], ["review", 1]], `${verdict}: one review, no implementation`);
    assert.deepEqual([run!.value.attempt, run!.value.tree, run!.value.checks], [1, saved.value.tree, saved.value.checks], `${verdict}: the same attempt, candidate and saved check`);
    assert.equal(correctionsUsed(f.store, f.plan, taskOne(f)), 0, `${verdict}: no correction slot is opened`);
    assert.ok(briefsOf(f, "review")[0]!.brief.includes("The full check FAILED"), `${verdict}: the reviewer is given the saved failure`);
    if (state === "needs_plan") assert.equal(run!.value.planDefect!.findings[0]!.address!.check!.index, 0);
    // A repeat buys no second review: a stopped plan stays stopped; a code verdict with no correction left is refused as before.
    if (state === "needs_code") await assert.rejects(f.run({ retry: true, maxCorrections: 0 }), { code: "execution_corrections_exhausted" });
    else await f.run({ retry: true, maxCorrections: 0 });
    assert.equal(f.sends().length, 2, `${verdict}: a repeat buys no second review`);
  }
});

test("AT3a return №4141 P2-2: a lost process between a failed full check and its review keeps that failure — the repeat reviews the saved result, never runs the check again, and a pass of it is impossible even when a second run would be green", async t => {
  const f = ex1Fixture(t, { tap: true });
  // A full check that fails on its first run only: a run again would replace the failure with a green result.
  writeFileSync(join(f.directory, "full.mjs"), `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(f.directory, "order.log"))}, 'full\\n');
mkdirSync('build', { recursive: true }); writeFileSync('build/marker', 'built');
const flag = ${JSON.stringify(join(f.directory, "full-ran"))};
if (!existsSync(flag)) { writeFileSync(flag, '1'); console.log('not ok 1 first execution fails'); process.exit(1); }
`);
  assert.equal(await ex1ProcessWhen(f, { maxCorrections: 0 }, "item.value.state === 'checking' && item.value.checks.some(check => check.result.exitCode !== 0)"), 9);
  f.reopen();
  const [run] = await f.run({ retry: true, maxCorrections: 0 });
  assert.equal(f.order().filter(row => row === "full").length, 1, "the check is not run again");
  assert.deepEqual([run!.value.state, run!.value.commit, run!.value.review?.kind], ["needs_code", null, "code"], "no pass and no commit of the failed candidate");
  assert.ok(run!.value.checks[0]!.result.stdout.includes("not ok 1 first execution fails"), "the saved failure stays the basis");
  assert.ok(briefsOf(f, "review")[0]!.brief.includes("not ok 1 first execution fails"), "the reviewer is given the first saved result");
  assert.deepEqual(f.sends().map(row => row.value.role).sort(), ["implement", "review"]);
});

test("AT3a return №4141 P2-3: an unexecutable contract binds the real working copy — a paid candidate still in place is recorded by its exact tree, a change outside the write paths is refused as any candidate's", async t => {
  const f = ex1Fixture(t);
  f.behave({ "review:1": "code", "implement:2": "unexecutable" });
  const [run] = await f.run({ maxCorrections: 1 });
  const first = f.store.history<TaskRun>(run!.id).find(row => row.value.attempt === 1 && row.value.tree !== null)!.value.tree;
  assert.deepEqual([run!.value.state, run!.value.attempt, run!.value.tree, run!.value.planDefect!.findings[0]!.address!.tree], ["needs_plan", 2, first, first],
    "the paid candidate of the first attempt is the defect's exact basis, not null");
  const g = ex1Fixture(t);
  g.behave({ "implement:1": "unexecutable-foreign" });
  const [refused] = await g.run({ maxCorrections: 0 });
  assert.deepEqual([refused!.value.state, refused!.value.error?.includes("outside"), refused!.value.planDefect], ["interrupted", true, undefined], "write_scope_exceeded, never needs_plan");
});
