import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, linkSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { executionFixture } from "./execution-fixture.js";
import { reference } from "../src/pipeline/contracts.js";
import { git, type ExecutionRoot, type Environment } from "../src/runtime/environment.js";
import { Executor } from "../src/execution/runner.js";
import { receiptId, type ArtifactReceipt } from "../src/compiler/model.js";
import { resultGate } from "../src/execution/result.js";
import { resolveArtifact } from "../src/compiler/inputs.js";
import type { TaskRun } from "../src/execution/model.js";
import { treeFile } from "../src/runtime/git-files.js";
import { processStart } from "../src/runtime/process-identity.js";
import { requireWritePaths } from "../src/execution/candidate.js";
import { prepareWriterIndex, readWriterIndex, writerIndexId, type WriterIndex } from "../src/ownership/writer-index.js";
import { Store } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import { finishCommit } from "../src/execution/commit.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";
import { deriveLayerFixture } from "./layer-design-fixture.js";
import { requireGraph } from "../src/graph/validate.js";

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


test("writer-index CAS conflicts keep native acceptance atomic and recovery appends the writer once", async t => {
  for (const recovering of [false, true]) for (const existing of [false, true]) {
    await t.test(`${recovering ? "recovery" : "finishCommit"} with ${existing ? "existing" : "absent"} index`, async t => {
      const f = executionFixture(t, "delete");
      const path = f.plan.value.tasks[0]!.writePaths[0]!;
      const indexId = writerIndexId("p", path);
      if (existing) {
        const initial = prepareWriterIndex(f.store, "p", path, null);
        f.store.writeMany(initial.writes, initial.guards);
      }
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
          assert.equal(index.expected, existing ? 1 : 0);
          before = { run: store.list("task-run"), root: store.get("execution-root:p"), receipts: store.list("artifact"), indexes: store.list("writer-index") };
          const second = new Store(store.path);
          try {
            if (existing) {
              const run = second.list<TaskRun>("task-run")[0]!;
              const root = second.get<ExecutionRoot>("execution-root:p")!;
              const task = f.plan.value.tasks.find(task => task.id === run.value.taskId)!;
              const environment = second.get<Environment>(f.plan.value.environment.id, f.plan.value.environment.revision)!;
              finishCommit(second, root, run, f.plan.value, task, environment.value);
              before = { run: second.list("task-run"), root: second.get("execution-root:p"), receipts: second.list("artifact"), indexes: second.list("writer-index") };
            } else {
              const competing = prepareWriterIndex(second, "p", path, reference(second.get<ExecutionRoot>("execution-root:p")!));
              second.writeMany(competing.writes, competing.guards);
            }
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
      assert.deepEqual(store.list("writer-index").filter(index => index.id !== indexId),
        (snapshot.indexes as { id: string }[]).filter(index => index.id !== indexId), "Other path indexes do not partially commit");
      const pending = store.list<TaskRun>("task-run")[0]!;
      assert.equal(pending.value.state, existing ? "committed" : "commit_pending");
      assert.equal(f.calls().length, 2);
      f.reopen();
      const recovered = await f.engine.executor.recover("p");
      assert.equal(recovered.length, existing ? 0 : 1);
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
    const old = graph.nodes.find(node => node.id === `p-${name}-work`)!;
    const node = structuredClone(old); node.id = `p-upgrade-${name}`;
    node.title = name === "produce" ? "Upgrade producer safety" : "Upgrade consumer safety";
    node.code = node.code.map(ref => ({ ...ref, status: "existing" }));
    const check = structuredClone(graph.tests.find(test => test.node === old.id)!);
    check.id = `${node.id}-test`; check.node = node.id; check.contract!.entrypoint.status = "existing";
    check.covers = ["p-flow"];
    check.contract!.counterfactuals.push({ connector: "p-flow", mutation: "substitute", expectedFailure: name === "produce" ? "output_overflow" : "result_overflow",
      command: { executable: process.execPath, args: ["check.mjs", `overflow-${name}`] } });
    node.tests = [check.id]; graph.nodes.push(node); graph.tests.push(check);
    graph.transfers!.push({ id: `transfer-${name}`, path: node.code[0]!.path, from: old.id, to: node.id, condition: "producer_committed" });
    return node;
  });
  graph.horizon = successors.map(node => node.id);
  const binding = graph.connectors[0]!.bindings.find(binding => binding.level === 3)!;
  binding.producer = { node: successors[0]!.id, port: "out", codeRef: successors[0]!.code[0]! };
  binding.consumers = [{ node: successors[1]!.id, port: "in", codeRef: successors[1]!.code[0]! }];
  graph.edges!.push({ id: "use-previous-data", relation: "requires", source: successors[0]!.id, target: "p-produce-work", condition: "Use the accepted producer version as the implementation baseline" });
  requireGraph(graph);
  f.engine.graphs.save("p", graph, f.store.get("graph:p")!.revision, "fixture-researcher");
  const research = f.engine.refinement.begin("p", "R2"); answerTechnicalFixture(f.engine, "p", research);
  f.engine.refinement.finishResearch("p", "R2", reference(f.store.get(research.id)!), f.store.get("phase:p:R2")!.revision);
  deriveLayerFixture(f.engine, "p", 3);
  f.engine.refinement.sealLayer("p", 3, f.store.get("phase:p:L3")!.revision);
  const feasibility = f.engine.refinement.assess("p", f.store.get("feasibility:p")!.revision);
  const om = f.engine.refinement.publish("p", reference(feasibility), f.store.get("stage:p:om-g2")!.revision);
  f.engine.pipeline.accept("p", "om-g2", om.revision);
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
import { EXECUTION_SEND_KIND, ExecutionSendHandle, gateRefusalPath, type ExecutionSend } from "../src/execution/protocol.js";
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
if (mode === 'implement') {
  const file = subject.context.scope.code.find(item => item.access === 'write').path, wrong = step === 'wrong';
  writeFileSync(file, file === 'produce.mjs'
    ? 'export const produce=n=>{if(!Number.isFinite(n))throw new Error("input_missing");return n+' + (wrong ? 2 : 1) + '};\\n'
    : 'import {produce} from "./produce.mjs"; export const consume=n=>produce(n)*' + (wrong ? 3 : 2) + ';\\n');
  writeFileSync(output, JSON.stringify({ text: 'Implemented the bounded module', artifacts: step === 'no-artifacts' ? [] : subject.context.produces.map(id => ({ id })) }));
} else writeFileSync(output, JSON.stringify(step === 'code' ? { verdict: 'request_changes', kind: 'code', findings: ['The result is wrong'] }
  : step.startsWith('code:') ? { verdict: 'request_changes', kind: 'code', findings: [step.slice(5)] }
  : step === 'plan' ? { verdict: 'request_changes', kind: 'plan', findings: ['The responsibility cannot deliver'] } : { verdict: 'pass', kind: 'none', findings: [] }));
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
  budget?: Partial<Omit<ExecutionAdmissionSettings, "plan">>; implementer?: { executable: string; args: string[] } } = {}) {
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
  preparedFeatures(engine, "p", graph);
  // `progress`: the full check prints progress on stdout while its failure stays on stderr (№3986-2).
  writeFileSync(join(directory, "full.mjs"), options.tap ? EX2_TAP_FULL(directory)
    : options.progress ? EX1_FULL(directory).replace("\nappendFileSync(", "\nconsole.log('Building candidate...');\nappendFileSync(") : EX1_FULL(directory));
  const adapter = { executable: process.execPath, args: [fileURLToPath(new URL("../src/adapters/codex-stdio.js", import.meta.url))] };
  engine.environments.configure("p", { workspace, implementer: { actor: "worker", model: "fixture", effort: "high", command: options.implementer ?? adapter },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command: adapter },
    fullCheck: { executable: process.execPath, args: [join(directory, "full.mjs")] }, timeoutMs: options.timeoutMs ?? 30_000 }, 0);
  refinedLayers(engine, "p"); const feasibility = engine.refinement.assess("p", 0);
  const stage = engine.refinement.publish("p", reference(feasibility), 0); engine.pipeline.accept("p", "om-g2", stage.revision);
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
  rmSync(ghost);
  const runs = await f.run({ maxCorrections: 0 });
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
  const f = ex1Fixture(t);
  f.behave({ review: "plan" });
  assert.equal((await f.run())[0]!.value.state, "needs_plan");
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
const EX1_BASE = "88bc91e13f777004274ed9410be806f386fd9419";

test("EX1 era: the records the base wrote are read by the new code with the same result — a pilot without an admission keeps the boundary; a base attempt's code finding opens its one correction", async t => {
  const f = ex1Fixture(t, { admit: false });
  const command = JSON.stringify(f.command());
  const base = ex1AtCommit(f.directory, f.database, EX1_BASE, "era-boundary", `
try { await engine.execute(${command}); out('ran'); } catch (error) { out(error.code); }`);
  assert.equal(base, "pilot_boundary_reached");
  f.reopen();
  await assert.rejects(f.run(), { code: "pilot_boundary_reached" }, "The base's pilot and policy keep the same boundary for the new code");
  const g = executionFixture(t, "correct");
  const options = JSON.stringify(g.options), plan = JSON.stringify(reference(g.plan));
  assert.deepEqual(ex1AtCommit(g.directory, g.store.path, EX1_BASE, "era-correct", `
const runs = await engine.executor.run('p', ${plan}, ${options}); out(runs.map(run => run.value.state));`), ["needs_code"]);
  g.reopen();
  const written = g.store.list<TaskRun>("task-run")[0]!;
  assert.equal(written.value.state, "needs_code", "The base stopped on its code finding");
  assert.equal(g.store.list(EXECUTION_SEND_KIND).length, 0, "The base era records no launches");
  const runs = await g.engine.executor.run("p", reference(g.plan), { ...g.options, retry: true, maxCorrections: 1 });
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"]);
  assert.deepEqual(g.store.list<ExecutionSend>(EXECUTION_SEND_KIND).filter(row => row.value.role === "implement").map(row => row.value.correction).sort(),
    [false, true, true], "The base attempt's finding is corrected once; task 2 corrects its own");
});

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
  f.behave({ "review:1": "plan" });
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
  // A negative review saved but not applied (the window before this return): its outcome is applied on the next entry, no launch.
  for (const kind of ["plan", "code"] as const) {
    const h = ex1Fixture(t, { budget: { maxCorrections: 0 } });
    h.behave({ "review:1": kind });
    assert.equal(await ex1Process(h, { maxCorrections: 0 }, kind === "plan" ? "needs_plan" : "needs_code"), 9);
    const applied = h.store.list<TaskRun>("task-run")[0]!;
    h.store.write({ id: applied.id, kind: applied.kind, expected: applied.revision, value: { ...applied.value, state: "reviewing", error: null } as never });
    const entered = await h.run({ maxCorrections: 0 });
    assert.equal(entered[0]!.value.state, kind === "plan" ? "needs_plan" : "needs_code", kind);
    assert.equal(h.provider().length, 2, `${kind}: the saved review is applied, not bought again`);
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
      role: "implement", ordinal: 1, correction: true, admission: null, request: { hash: "h", chars: 1 }, group: null, status: "answered", usage: null, startedAt: index, finishedAt: index } as never });
  assert.equal(measure(), before, "300 launches of another plan are not read");
  assert.ok(before > 0);
});


// ---- EX2 (№3980): the correction sees what failed; a blind slot is restored narrowly ----
import { checkFeedback, blindCorrection, EXECUTION_RECOVERY_KIND, PATHS_RULE, CORRECTION_PATHS_RULE, type ExecutionRecovery } from "../src/execution/runner.js";
const EX2_BASE = "afb55c7ddd110c7cf27b1493a722209e68455f73";

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

/** The live case: the base (EX1) executes with a correction that fails again — its errors are the stderr tail, its correction launch names no feedback. */
async function blindByBase(t: test.TestContext, then: Record<string, string>, fixture: { tap?: boolean; progress?: boolean } = { tap: true }) {
  const f = ex1Fixture(t, fixture);
  f.behave({ "implement:1": "wrong", "implement:2": "wrong" });
  const command = JSON.stringify(f.command());
  assert.equal(ex1AtCommit(f.directory, f.database, EX2_BASE, "ex2-blind", `
try { await engine.execute(${command}); out('ran'); } catch (error) { out(error.code); }`), "ran");
  f.reopen();
  const runs = f.store.list<TaskRun>("task-run");
  assert.deepEqual([runs[0]!.value.state, runs[0]!.value.attempt], ["needs_code", 2], "the base spent its one correction");
  const blind = f.sends().find(row => row.value.attempt === 2)!;
  assert.equal("feedback" in blind.value, false, "the base's launch names no feedback");
  if (fixture.tap) assert.match(f.provider().filter(call => call.mode === "implement")[1]!.correction!.error!, /^\(node:\d+\) Warning|ExperimentalWarning/, "the base showed only the stderr tail");
  f.behave(then);
  return { f, blind };
}
test("EX2 a correction slot the earlier producer spent blind is restored once, by its exact launch: a restart does not restore it again, and the restored correction is shown what failed", async t => {
  const { f, blind } = await blindByBase(t, {});
  const runs = await f.run({ retry: true });
  assert.deepEqual(runs.map(run => run.value.state), ["committed", "committed"]);
  const recoveries = f.store.list<ExecutionRecovery>(EXECUTION_RECOVERY_KIND);
  assert.equal(recoveries.length, 1);
  assert.deepEqual([recoveries[0]!.value.send.id, recoveries[0]!.value.check], [blind.id, 0]);
  const sighted = f.provider().filter(call => call.mode === "implement")[2]!.correction!;
  assert.match(sighted.error!, /not ok 1 - produce returns its successor/, "the restored correction sees the failure of the attempt it corrects");
  assert.ok(f.sends().find(row => row.value.attempt === 3)!.value.feedback, "and its launch names it");
  assert.equal(f.sends().filter(row => row.value.role === "implement" && row.value.task === f.plan.value.tasks[0]!.id).length, 3, "both earlier launches stay in the account");
});
test("EX2 the restored slot is one: a restored correction that fails again exhausts the limit, a restart creates no second slot; an ordinary failed correction of this era exhausts it as before", async t => {
  const { f } = await blindByBase(t, { "implement:3": "wrong" });
  const runs = await f.run({ retry: true });
  assert.equal(runs[0]!.value.state, "needs_code");
  f.reopen();
  await assert.rejects(f.run({ retry: true }), { code: "execution_corrections_exhausted" });
  assert.equal(f.store.list(EXECUTION_RECOVERY_KIND).length, 1, "no second restoration");
  const g = ex1Fixture(t, { tap: true });
  g.behave({ "implement:1": "wrong", "implement:2": "wrong" });
  assert.equal((await g.run())[0]!.value.state, "needs_code");
  await assert.rejects(g.run({ retry: true }), { code: "execution_corrections_exhausted" });
  assert.equal(g.store.list(EXECUTION_RECOVERY_KIND).length, 0, "a correction shown its failure is no basis");
});
test("EX2 a restoration is proved when it is created and read as written: the reader takes no history and its cost does not grow with later revisions; a record without its launch is refused by its form", async t => {
  const { f, blind } = await blindByBase(t, {});
  const task = f.plan.value.tasks[0]!;
  assert.ok(blindCorrection(f.store, f.plan, task, blind), "the base's blind launch is a basis when the restoration is created");
  await f.run({ retry: true });
  assert.equal(f.store.list(EXECUTION_RECOVERY_KIND).length, 1);
  const measure = () => {
    let histories = 0, rows = 0;
    const history = f.store.history.bind(f.store), get = f.store.get.bind(f.store), identities = f.store.identities.bind(f.store);
    f.store.history = ((...args: Parameters<Store["history"]>) => { histories++; const found = history(...args); rows += found.length; return found; }) as Store["history"];
    f.store.get = ((...args: Parameters<Store["get"]>) => { const found = get(...args); if (found) rows++; return found; }) as Store["get"];
    f.store.identities = ((...args: Parameters<Store["identities"]>) => { const found = identities(...args); rows += found.length; return found; }) as Store["identities"];
    try { correctionsUsed(f.store, f.plan, task); } finally { f.store.history = history; f.store.get = get; f.store.identities = identities; }
    return { histories, rows };
  };
  const before = measure();
  assert.equal(before.histories, 0, "the saved restoration is not derived again");
  const run = f.store.list<TaskRun>("task-run").find(row => row.value.taskId === task.id)!;
  for (let index = 0; index < 300; index++) {
    const head = f.store.get<TaskRun>(run.id)!;
    f.store.write({ id: run.id, kind: "task-run", expected: head.revision, value: { ...head.value, updatedAt: head.value.updatedAt + 1 } as never });
  }
  assert.deepEqual(measure(), before, "300 later revisions of the task run add nothing to the read");
  const id = blind.id.replace(/^execution-send:/, `${EXECUTION_RECOVERY_KIND}:`), saved = f.store.get<ExecutionRecovery>(id)!;
  const { send: _send, ...withoutSend } = saved.value;
  f.store.write({ id, kind: EXECUTION_RECOVERY_KIND, expected: saved.revision, value: withoutSend as never });
  assert.throws(() => correctionsUsed(f.store, f.plan, task), { code: "execution_recovery_invalid" }, "T4: a restoration without its launch");
});

test("EX2 №3986-2 progress output on stdout proves no blindness: when the earlier correction was given the whole failure on stderr, no slot is restored", async t => {
  const { f, blind } = await blindByBase(t, {}, { progress: true });
  const given = f.provider().filter(call => call.mode === "implement")[1]!.correction!.error!;
  assert.match(given, /AssertionError/, "the earlier producer passed the whole failure");
  const basis = f.store.history<TaskRun>(f.store.list<TaskRun>("task-run")[0]!.id).find(row => row.value.state === "needs_code" && row.value.attempt === 1)!;
  assert.match(basis.value.checks[0]!.result.stdout, /Building candidate/);
  assert.equal(blindCorrection(f.store, f.plan, f.plan.value.tasks[0]!, blind), null);
  await assert.rejects(f.run({ retry: true }), { code: "execution_corrections_exhausted" });
  assert.equal(f.store.list(EXECUTION_RECOVERY_KIND).length, 0);
  assert.equal(f.provider().length, 2, "no further paid launch");
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
  f.behave({ "implement:1": "wrong", "review:1": "code" });
  const runs = await f.run({ maxCorrections: 3 });
  assert.deepEqual(runs.map(run => [run.value.state, run.value.attempt]), [["committed", 3], ["committed", 1]]);
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "implement", "review", "implement", "review", "implement", "review"]);
  const [, sighted, reviewed] = implementsOf(f);
  assert.match(sighted!.correction!.error!, /not ok 1 - produce returns its successor/, "the first correction is shown the failed check");
  assert.deepEqual(reviewed!.correction!.review, { verdict: "request_changes", kind: "code", findings: ["The result is wrong"] }, "the next is shown the review's finding");
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
  assert.deepEqual([implementsOf(f).length, f.sends().length], [4, 4], "the fourth correction reaches no provider and is no launch");
  assert.equal(f.store.get<TaskRun>(second[0]!.id)!.revision, second[0]!.revision, "the refusal writes nothing");
});

test("EX3 the shared limits stop an execution with corrections left: launches or input, refused before any launch; a new admission continues with the correction the saved check asks", async t => {
  const f = ex1Fixture(t, { tap: true, budget: { maxCorrections: 3, roleLaunches: 3 } });
  f.behave({ implement: "wrong" });
  const runs = await f.run({ maxCorrections: 3 });
  assert.equal(runs[0]!.value.state, "interrupted");
  assert.match(runs[0]!.value.error!, /^execution_budget_exhausted/);
  assert.deepEqual([implementsOf(f).length, f.sends().length, correctionsUsed(f.store, f.plan, taskOne(f))], [3, 3, 2], "one correction is left, yet nothing is launched");
  f.behave({});
  f.admit(f.execution({ maxCorrections: 3, roleLaunches: 7 }));
  const resumed = await f.run({ retry: true, maxCorrections: 3 });
  assert.deepEqual(resumed.map(run => run.value.state), ["committed", "committed"]);
  assert.match(implementsOf(f).at(-1)!.correction!.error!, /not ok 1 - produce returns its successor/);
  assert.equal(correctionsUsed(f.store, f.plan, taskOne(f)), 3);
  const g = ex1Fixture(t, { tap: true, budget: { maxCorrections: 3, softInput: 2500, roleReserve: { implement: 1000, review: 1000 } } });
  g.behave({ implement: "wrong" });
  const stopped = await g.run({ maxCorrections: 3 });
  assert.equal(stopped[0]!.value.state, "interrupted");
  assert.match(stopped[0]!.value.error!, /^execution_budget_exhausted: The admitted input would be exceeded/);
  assert.deepEqual([implementsOf(g).length, correctionsUsed(g.store, g.plan, taskOne(g))], [2, 1]);
});

test("EX3 era: the base stops a task at its negative review with its one correction spent; under a new admission of three the new code continues it — the saved review is shown to the correction, never bought again, and the count goes on from the base's", async t => {
  const f = ex1Fixture(t, { tap: true });
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
  const f = ex1Fixture(t, { budget: { maxCorrections: 3 } });
  f.behave({ implement: "wrong" });
  const command = JSON.stringify(f.command({ maxCorrections: 3 }));
  assert.deepEqual(ex1AtCommit(f.directory, f.database, EX4_BASE, "ex4-era", `
out((await engine.execute(${command})).map(run => [run.value.state, run.value.attempt]));`), [["needs_code", 4]]);
  f.reopen();
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
  f.behave({ "implement:1": "wrong", "review:1": `code:${serve}`, "review:3": "code:The neighbour is wrong" });
  const runs = await f.run({ maxCorrections: 2 });
  assert.deepEqual(runs.map(run => [run.value.state, run.value.attempt]), [["committed", 3], ["needs_code", 1]]);
  assert.deepEqual(f.provider().map(call => call.mode), ["implement", "implement", "review", "implement", "review", "implement", "review"]);
  const [first, afterCheck, afterReview] = implementsOf(f);
  assert.ok(first!.brief.includes(PATHS_RULE) && !first!.brief.includes(CORRECTION_PATHS_RULE), "every implementation is given the rule of paths");
  assert.ok(afterCheck!.brief.includes(CORRECTION_PATHS_RULE) && afterReview!.brief.includes(CORRECTION_PATHS_RULE), "a correction is tied to what it answers");
  assert.deepEqual(afterReview!.correction!.review, { verdict: "request_changes", kind: "code", findings: [serve] });
  await assert.rejects(f.run({ retry: true, maxCorrections: 2 }), { code: "execution_corrections_exhausted" }, "the neighbour's retry");
  assert.equal(f.provider().length, 7);
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
  assert.deepEqual([implementsOf(f).length, f.sends().length, correctionsUsed(f.store, f.plan, taskOne(f))], [3, 3, 2]);
});
