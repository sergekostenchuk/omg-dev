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
