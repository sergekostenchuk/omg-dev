import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "../src/canonical.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { git } from "../src/runtime/environment.js";
import { probeProcessIdentity } from "../src/runtime/process-identity.js";
import { Store, type Revision, type TransactionGuard, type Write } from "../src/storage/store.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { configureDispatch } from "../src/om/dispatch.js";
import { writeOmInput } from "../src/om/input.js";
import type { OmModelCall } from "../src/om/model-call.js";
import { prepareFrameProposals, type ProposalRequest } from "../src/om/frame-proposals.js";
import type { QuestionPacketRecord } from "../src/om/question-packet.js";
import type { Graph } from "../src/graph/model.js";
import type { OmResult, Refusal } from "../src/om/refusal.js";
import type { RoutesRecord } from "../src/om/routes.js";
import { prepareRunBases, writeRunBases } from "../src/om/run-bases.js";
import { acquireRunExecution, readRunControl, releaseRunExecution, runControlId,
  type RunExecution } from "../src/om/run-control.js";
import { continuePass, readPass, resumeStoppedPass, startPass, stopPass, type PassOutcome } from "../src/om/run-driver.js";
import { advanceRun, readRun, runId, startRun, type RunRecord, type RunRequest } from "../src/om/run.js";
import { gardenGraph } from "./om-fixture.js";
import { omStartReadiness, readEnvironmentReadiness } from "../src/om/environment-readiness.js";
import { Environments, type Environment } from "../src/runtime/environment.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";

const project = "garden";
const adapterFixture = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));
const driverModule = new URL("../src/om/run-driver.js", import.meta.url).href;
const productModule = new URL("../src/product/engine.js", import.meta.url).href;
const storeModule = new URL("../src/storage/store.js", import.meta.url).href;
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`Unexpected refusal: ${result.refusal.code}: ${result.refusal.message} ${JSON.stringify(result.refusal.at)}`);
  return result.value;
}
function refusal<T>(result: OmResult<T>): Refusal { if (result.ok) assert.fail("Expected a refusal"); return result.refusal; }
const snapshot = (store: Store): Ref[] => store.list().map(reference);

/**
 * A real OM project as the pass meets it: prepared stages with one open addressing question, refined layers, an
 * environment whose roles run the scripted adapter, and the dispatch configured by E4.1. A cold project has no OM
 * record at all; otherwise B1 exists with every other decision addressed.
 */
/** ENV1: the environment a fixture configures — by default a committed Git root, capacity and the dispatch. */
interface FixtureEnvironment { repo?: "git" | "none" | "no-head" | "nested"; capacity?: boolean; dispatch?: boolean;
  fullCheck?: { executable: string; args: string[] } }
const commitAll = (workspace: string) => {
  git(workspace, ["add", "-A"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
};
function driverFixture(t: TestContext, cold = false, questions = ["encoding"], refine = true, env: FixtureEnvironment = {}) {
  const root = mkdtempSync(join(tmpdir(), "omg-h13-drive-")), database = join(root, "state.sqlite"), repository = join(root, "repo");
  const mode = env.repo ?? "git", workspace = mode === "nested" ? join(repository, "sub") : repository;
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, "README.md"), "H1.3 pass repository\n");
  if (mode !== "none") git(repository, ["init", "-b", "main"]);
  if (mode === "git" || mode === "nested") commitAll(repository);
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  preparedFeatures(engine, project, gardenGraph(), field => {
    const value = preparedField(project, field);
    if (field === "preparation" && questions.length) (value as Record<string, Json>).unknowns = questions.map(id => ({ id, question: `Which ${id} is supported?`,
      consumer: "garden-consume-block", moment: "om-pass", blocksCurrentStage: false, resolution: "Address this question during OM" }));
    return value;
  });
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  engine.environments.configure(project, { workspace,
    implementer: { actor: "run-implementer", model: "fixture", effort: "high", speed: "fast", command },
    reviewer: { actor: "run-reviewer", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: env.fullCheck ?? { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000,
    ...(env.capacity === false ? {} : { requestCapacityChars: 100_000 }) }, 0);
  if (refine) refinedLayers(engine, project);
  if (!cold) {
    const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
    const graph = reference(store.get(`graph:${project}`)!), base = ok(writeOmInput(store, { project, expected: 0, stages }));
    const decisions = base.value.gaps.filter(gap => gap.code !== "inventory_missing" && gap.code !== "question_unaddressed").map(gap => {
      const field = gap.code === "contract_node_unbound" ? "nodes" : gap.code === "acceptance_kind_missing" ? "checkKind" : "state";
      const value: Json = field === "nodes" ? ["garden-produce-block", "garden-consume-block"] : field === "checkKind" ? "test"
        : { writer: "garden-produce-block", authority: "garden-user", rollback: "garden-produce-block" };
      return { pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph, layers: [],
        decision: { target: gap.target, field, value } })) as Write };
    });
    if (decisions.length) ok(writeAddressing(store, { project, input: reference(base), graph, decisions }));
  }
  const dispatch = env.dispatch === false ? null : ok(configureDispatch(store, { project, protocol: "codex-stdio" })).dispatch;
  return { root, database, workspace, repository, get engine() { return engine; }, dispatch: dispatch!,
    get store() { return store; },
    request(): RunRequest { return { project, dispatch: dispatch! }; },
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ database: store.path, steps })); },
    sent(): { requestId: string }[] { return existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; },
    pause(name: string) { return join(root, `${name}.pause.json`); },
    restart(make: (path: string) => Store = path => new Store(path)) { store.close(); store = make(database); engine = new ProductEngine(store); } };
}
type Fixture = ReturnType<typeof driverFixture>;
function other<T>(database: string, action: (store: Store) => T): T {
  const store = new Store(database);
  try { return action(store); } finally { store.close(); }
}
/** Another store for an asynchronous entry: it stays open until the entry has finished. */
async function otherDrive<T>(database: string, action: (store: Store) => Promise<T>): Promise<T> {
  const store = new Store(database);
  try { return await action(store); } finally { store.close(); }
}
/** The pause checkpoint of the adapter fixture, read again until its JSON is whole (the fixture writes it in place). */
async function checkpoint(path: string): Promise<{ pid: number }> {
  // The pass reaches a later dispatch through M5, a new B1 and its bases: under a loaded machine this takes minutes.
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (existsSync(path)) { try { return JSON.parse(readFileSync(path, "utf8")) as { pid: number }; } catch { /* still being written */ } }
    if (Date.now() > deadline) assert.fail(`The adapter never reached its checkpoint ${path}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
/** A dispatch that holds its request: the provider has it and waits until it is stopped. */
const holding = (path: string) => ({ research: { held: true }, pauseAfterRequest: path });
/** The mechanism batch of the pass's M5 on its current bases. */
function mechanismBatch(f: Fixture) {
  const built = ok(prepareRunBases(f.store, { project }));
  if (built.state !== "ready") assert.fail("The bases of the pass are built");
  const routes = f.store.get<RoutesRecord>(built.built.bases.routes.id, built.built.bases.routes.revision)!.value;
  return routes.batches.find(item => item.model === "MC2" && item.task === "input-field" && item.items.every(row => row.consumers.length === 0))!;
}
function addressAll(f: Fixture) {
  const batch = mechanismBatch(f);
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
    results: batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: { consumer: "garden-consume-block", kind: "repository-fact" } })) } };
}
function cannotAnswer(f: Fixture) {
  const batch = mechanismBatch(f);
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: batch.items.map(item => item.gap),
    action: "cannot_answer", reason: "The requested information is unavailable" }, usage };
}
const undecided = { research: { protocol: "omg-stop-analysis/v1", cause: { kind: "hypothesis", text: "The brief does not settle the encoding", sources: [] },
  change: null, origin: null }, usage };
/** Every action the pass performed with a product, in order, from its own record history. */
const actions = (store: Store) => store.history(runId(project)).flatMap(row => {
  const last = (row.value as unknown as RunRecord).last, previous = store.get<RunRecord>(runId(project), row.revision - 1)?.value.last;
  return last && last.refusal === null && JSON.stringify(last) !== JSON.stringify(previous) ? [last.step.action] : [];
});
const stateOf = (outcome: PassOutcome) => outcome.run?.value.state as { phase: string; step?: { action: string } } | undefined;

/** A cold project driven to its first real dispatch, stopped from another store during that live call. */
async function stoppedAtFirstDispatch(t: TestContext) {
  const f = driverFixture(t, true);
  assert.equal(f.store.get(`om-input:${project}`), null, "No OM record exists");
  f.steps([holding(f.pause("first"))]);
  const driving = startPass(f.store, { project });
  await checkpoint(f.pause("first"));
  const stop = other(f.database, store => ok(stopPass(store, { project })));
  assert.equal(stop.stopped, true);
  const outcome = ok(await driving) as PassOutcome;
  return { f, outcome, stop: stop.control!.value.stop!.token };
}

test("R1 R9 R10 H1.3 cold OM × start: the machine bases of the intent, the E4.1 dispatch and the first real dispatch without client Refs; a stop from another store ends the live call and the drive", async t => {
  const { f, outcome } = await stoppedAtFirstDispatch(t);
  assert.equal(outcome.end, "stopped");
  assert.equal(f.store.get(`om-input:${project}`)!.revision, 1, "The machine wrote the first B1 of the pass");
  const run = ok(readRun(f.store, { project }))!;
  assert.deepEqual(run.value.intent.outcomes, ["garden-result"], "The launch intent defaults to every outcome of the first B1");
  assert.deepEqual(actions(f.store), ["open-series", "open", "packet"], "M5 is the first work: nobody issued any bases");
  assert.equal(stateOf(outcome)?.step?.action, "cycle", "The stopped cycle stays the saved step of the pass");
  assert.equal(f.sent().length, 1, "One real dispatch reached the provider");
  const call = f.store.list<OmModelCall>("model-call")[0]!;
  assert.equal(call.value.om.request.dispatch.adapter.id, `adapter:${project}:codex-stdio`, "The dispatch is the one E4.1 configured");
  assert.deepEqual([call.value.status, call.value.error], ["failed", "process_cancelled"], "The live call was cancelled, its outcome saved");
  const control = ok(readRunControl(f.store, { project }));
  assert.deepEqual([control.stopped, control.finished, control.control!.value.execution], [true, true, null], "The drive gave its execution up");
  // Every entry keeps the stop: continue, a direct advance and a direct start begin nothing, and nothing is sent.
  const before = snapshot(f.store);
  assert.equal(ok(await continuePass(f.store, { project })).end, "stopped");
  assert.equal(refusal(await advanceRun(f.store, f.request())).code, "run_stopped");
  assert.equal(refusal(startRun(f.store, { project })).code, "run_stopped");
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(f.sent().length, 1);
});

test("R16 R2 R17 H1.3 continue never lifts the stop; after the named resume the saved step goes on without paying it again, M5 is answered and the pass builds its new bases and goes on; a late resume lifts nothing", async t => {
  const { f, stop } = await stoppedAtFirstDispatch(t);
  f.steps([holding(f.pause("first")), addressAll(f), holding(f.pause("second"))]);
  assert.equal(ok(await continuePass(f.store, { project })).end, "stopped", "An ordinary continue keeps the stop");
  assert.equal(f.sent().length, 1);
  const resumed = ok(resumeStoppedPass(f.store, { project, stop }));
  assert.deepEqual([resumed.value.generation, resumed.value.stop], [2, null]);
  const driving = continuePass(f.store, { project });
  const reached = await Promise.race([checkpoint(f.pause("second")).then(() => null), driving]);
  if (reached) assert.fail(`The drive ended before its next dispatch: ${JSON.stringify(ok(reached).end)} ${JSON.stringify(ok(reached).run?.value.state)} ${actions(f.store).join(",")}`);
  const second = other(f.database, store => ok(stopPass(store, { project })));
  const outcome = ok(await driving);
  assert.equal(outcome.end, "stopped");
  const sent = f.sent().map(row => row.requestId);
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent).size, 3, "The cancelled first call was never sent again");
  const done = actions(f.store);
  assert.ok(done.indexOf("bases") > done.lastIndexOf("close"), `M5 closed, then the pass built the bases of its new B1: ${done.join(",")}`);
  assert.equal(f.store.get(`om-input:${project}`)!.revision, 2, "D3 of M5 made the new B1");
  assert.equal(refusal(resumeStoppedPass(f.store, { project, stop })).code, "run_stop_stale", "The first stop's resume never lifts the new one");
  assert.equal(ok(readRunControl(f.store, { project })).control!.value.stop!.token, second.control!.value.stop!.token);
});

test("R3 H1.3 an unchanged wait and a saved unable: a repeat and a new store return the saved pass without a revision, a loop or a payment", async t => {
  // An unable pass: three fruitless M5 attempts, one undecided review, the second rung.
  const u = driverFixture(t);
  ok(writeRunBases(u.store, { project }));
  u.steps([cannotAnswer(u), cannotAnswer(u), cannotAnswer(u), undecided]);
  const ended = ok(await startPass(u.store, { project }));
  assert.equal(ended.end, "unable");
  const run = ended.run!, sends = u.sent().length;
  assert.equal(sends, 4);
  for (const again of [await continuePass(u.store, { project }), await startPass(u.store, { project }),
    await otherDrive(u.database, store => continuePass(store, { project }))])
    assert.deepEqual([ok(again).end, ok(again).run], ["unable", run]);
  assert.equal(u.sent().length, sends);
  assert.equal(u.store.history(runControlId(project)).length, 2, "The ended pass was read without taking the execution again");
  // An unchanged wait: the saved cycle's claim belongs to this live process and has no receipt.
  const w = driverFixture(t);
  ok(writeRunBases(w.store, { project }));
  w.steps([addressAll(w)]);
  const crashing = class extends Store {
    override writeMany<T = Json>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
      const written = super.writeMany<T>(inputs, guards);
      if (inputs.some(write => write.kind === "model-call" && (write.value as { status?: string }).status === "running")) throw new Error("simulated crash after the claim");
      return written;
    }
  };
  w.restart(path => new crashing(path));
  await assert.rejects(startPass(w.store, { project }), /simulated crash after the claim/);
  w.restart();
  const waiting = ok(await continuePass(w.store, { project }));
  assert.equal(waiting.end, "waiting");
  const standing = waiting.run!;
  for (const again of [await continuePass(w.store, { project }), await otherDrive(w.database, store => continuePass(store, { project }))])
    assert.deepEqual([ok(again).end, ok(again).run], ["waiting", standing], "The standing wait is returned without a revision");
  assert.equal(w.sent().length, 0, "The claimed call never reached the provider and is never resent");
});

test("R4 H1.3 two starts from two stores: one executor holds the pass, the second is busy, and one physical call is made", async t => {
  const f = driverFixture(t);
  ok(writeRunBases(f.store, { project }));
  f.steps([holding(f.pause("held"))]);
  const first = startPass(f.store, { project });
  await checkpoint(f.pause("held"));
  const second = await otherDrive(f.database, store => startPass(store, { project }));
  assert.deepEqual([ok(second).end, ok(second).refusal?.code, ok(second).refusal?.at.field], ["busy", "run_busy", "execution"]);
  assert.equal(f.sent().length, 1, "The busy start made no second call");
  other(f.database, store => ok(stopPass(store, { project })));
  assert.equal(ok(await first).end, "stopped");
  assert.equal(f.sent().length, 1);
});

test("R6 H1.3 a stop before the pass and between steps: start, continue, advance and a direct start begin nothing; no pass, B1 or base is written", async t => {
  const f = driverFixture(t, true);
  const stop = ok(stopPass(f.store, { project }));
  assert.deepEqual([stop.stopped, stop.finished], [true, true]);
  const before = snapshot(f.store);
  const started = ok(await startPass(f.store, { project }));
  assert.deepEqual([started.end, started.run], ["stopped", null]);
  assert.equal(ok(await continuePass(f.store, { project })).end, "stopped");
  assert.equal(refusal(startRun(f.store, { project })).code, "run_stopped");
  assert.deepEqual(snapshot(f.store), before, "No pass, no B1 and no base were written for the stopped project");
  assert.deepEqual(ok(stopPass(f.store, { project })).control, stop.control, "A repeated stop is the saved one");
  // Between steps: the pass is started, then stopped; the next advance begins no step.
  const g = driverFixture(t);
  ok(writeRunBases(g.store, { project }));
  const run = ok(readRun(g.store, { project }))!;
  ok(stopPass(g.store, { project }));
  assert.equal(refusal(await advanceRun(g.store, g.request())).code, "run_stopped");
  assert.deepEqual(ok(readRun(g.store, { project })), run, "No step was chosen for the stopped pass");
  assert.deepEqual(ok(readPass(g.store, { project })).run, run, "Reading the pass takes no execution and writes nothing");
});

test("R5 H1.3 a dead executor's saved step: its death is proved, its lost call is recovered by the common recovery and the same step goes on without a second send", async t => {
  const f = driverFixture(t);
  ok(writeRunBases(f.store, { project }));
  f.steps([holding(f.pause("lost")), holding(f.pause("next"))]);
  const script = `const [{ Store }, driver] = await Promise.all([import(${JSON.stringify(storeModule)}), import(${JSON.stringify(driverModule)})]);
const store = new Store(${JSON.stringify(f.database)});
await driver.startPass(store, { project: ${JSON.stringify(project)} });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  const provider = await checkpoint(f.pause("lost"));
  // The executor process dies with its call in flight; its own provider is then stopped by this test.
  child.kill("SIGKILL"); await exited;
  process.kill(provider.pid, "SIGKILL");
  for (let tries = 0; probeProcessIdentity(provider.pid).state === "present" && tries < 200; tries++) await new Promise(resolve => setTimeout(resolve, 20));
  const lost = f.store.list<OmModelCall>("model-call")[0]!;
  assert.equal(lost.value.status, "running", "The lost call has no receipt");
  const driving = continuePass(f.store, { project });
  await checkpoint(f.pause("next"));
  other(f.database, store => ok(stopPass(store, { project })));
  assert.equal(ok(await driving).end, "stopped");
  const recovered = f.store.get<OmModelCall & { recovery?: unknown }>(lost.id)!;
  assert.ok(recovered.value.recovery, "The common recovery proved the owner and the provider gone");
  const sent = f.sent().map(row => row.requestId);
  assert.deepEqual([sent.length, new Set(sent).size], [2, 2], "The lost request was never sent again");
});

test("DRV1 common stop recovers a lost early model-call through its research producer, never the OM reader", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-drv1-early-recovery-")), database = join(root, "state.sqlite"),
    workspace = join(root, "repo"), adapter = join(root, "adapter.mjs"), pause = join(root, "provider.pause.json");
  mkdirSync(workspace); git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "early recovery\n");
  git(workspace, ["add", "README.md"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  writeFileSync(adapter, `import{readFileSync,writeFileSync}from'node:fs';JSON.parse(readFileSync(0,'utf8'));
writeFileSync(${JSON.stringify(pause)},JSON.stringify({pid:process.pid}));process.kill(process.pid,'SIGSTOP');`);
  const store = new Store(database), engine = new ProductEngine(store), earlyProject = "early-recovery";
  engine.execute({ type: "create-project", project: earlyProject, title: "Early recovery" });
  engine.discovery.evidence.document(earlyProject, "brief", "A local early-stage recovery fixture", "text/plain", 0);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure(earlyProject, { workspace,
    implementer: { actor: "early-author", model: "fixture", effort: "high", command },
    reviewer: { actor: "early-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 30_000 }, 0);
  const draft = engine.prepare(earlyProject, "discovery");
  const script = `const [{Store},{ProductEngine}]=await Promise.all([import(${JSON.stringify(storeModule)}),import(${JSON.stringify(productModule)})]);
const store=new Store(${JSON.stringify(database)});await new ProductEngine(store).stageResearch.run(${JSON.stringify(earlyProject)},${JSON.stringify(draft.id)},10);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited;
    store.close(); rmSync(root, { recursive: true, force: true }); });
  const provider = await checkpoint(pause);
  child.kill("SIGKILL"); await exited;
  process.kill(provider.pid, "SIGKILL");
  for (let tries = 0; probeProcessIdentity(provider.pid).state === "present" && tries < 200; tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const lost = store.list<Record<string, unknown>>("model-call")[0]!;
  assert.equal(lost.value["status"], "running");
  assert.equal(Object.hasOwn(lost.value, "om") || Object.hasOwn(lost.value, "transport"), false);
  const stopped = ok(stopPass(store, { project: earlyProject }));
  const recovered = store.get<any>(lost.id)!;
  assert.deepEqual([recovered.value.status, recovered.value.error], ["failed", "process_lost"]);
  assert.ok(recovered.value.recovery, "the common stop used the early recovery producer");
  assert.equal(stopped.finished, true);
  const resumed = resumeStoppedPass(store, { project: earlyProject, stop: stopped.control!.value.stop!.token });
  assert.equal(resumed.ok, true);
  assert.equal(store.list("model-call").length, 1, "recovery never sends the lost request again");
});

async function until(f: Fixture, request: RunRequest, action: string, bound = 30) {
  for (let index = 0; index < bound; index++) {
    const state = ok(await advanceRun(f.store, request)).record.value.state;
    if (state.phase === "step" && state.step.action === action) return state.step;
    if (state.phase === "waiting") assert.fail(`The pass waited before choosing ${action}: ${state.wait.code}`);
  }
  assert.fail(`The pass did not choose ${action}`);
}
/** An MC2 answer to the saved node-expansion packet: one operation filling exactly its assigned obligations. */
function nodeAnswer(f: Fixture, step: { request: unknown }) {
  const saved = (step.request as { packet: Ref }).packet;
  const packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
  const plan = packet.value.plan!, ids = plan.assignments[plan.position]!.obligations;
  const routes = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
  const batch = routes.batches.find(row => row.id === packet.value.request.batch)!;
  const operations = routes.request.gaps.sources.operations as unknown as ProposalRequest;
  const obligations = ok(prepareFrameProposals(f.store, operations)).frame.result.obligations.filter(item => ids.includes(item.id));
  const graph = f.store.get<Graph>(`graph:${project}`)!.value, upper = graph.nodes.find(node => node.id === batch.node)!;
  const node = { ...structuredClone(upper), id: `garden-h13-operation-${batch.node}`, kind: "operation", parent: upper.id,
    title: `Operation of ${batch.node}`, ports: obligations.filter(item => item.kind === "connection-end").map((item, index) => ({
      id: `h13-port-${index}`, direction: item.role === "producer" ? "out" : "in",
      contract: graph.artifacts.find(artifact => artifact.id === item.artifact)!.contract })), code: [], tests: [] };
  let port = 0;
  const proposal = { nodes: [node], fills: obligations.map(item => ({ obligation: item.id, node: node.id,
    ...(item.kind === "connection-end" ? { port: node.ports[port++]!.id } : {}) })), localConnectors: [], artifacts: [], contracts: [],
    joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", proposal }, usage };
}

test("R2 R6 №1991-4 №1991-7 H1.3 legacy N2 × the bases over it: a stop on the saved D2 of the accepted group (Ф3) performs nothing; after the resume the driver goes through both D2/G7 and the works ledger to the first L3 dispatch, never looping on bases_stale or d2_bases", async t => {
  const f = driverFixture(t, false, [], false);
  ok(writeRunBases(f.store, { project }));
  const request = f.request();
  const first = await until(f, request, "cycle");
  const answers: Record<string, unknown>[] = [nodeAnswer(f, first)];
  f.steps(answers);
  const second = await until(f, request, "cycle");
  answers.push(nodeAnswer(f, second), holding(f.pause("l3")));
  f.steps(answers);
  await until(f, request, "confirm", 40);
  // Ф3: one C5 is accepted and its bases are built; the first D2 of the group is saved and not performed.
  const stop = other(f.database, store => ok(stopPass(store, { project }))).control!.value.stop!.token;
  const saved = ok(readRun(f.store, { project }))!, before = snapshot(f.store);
  assert.equal(ok(await continuePass(f.store, { project })).end, "stopped");
  assert.equal(refusal(await advanceRun(f.store, request)).code, "run_stopped");
  assert.deepEqual([ok(readRun(f.store, { project })), snapshot(f.store)], [saved, before], "The saved D2 of the stopped pass was not performed");
  ok(resumeStoppedPass(f.store, { project, stop }));
  const done = actions(f.store).length;
  const driving = continuePass(f.store, { project });
  const reached = await Promise.race([checkpoint(f.pause("l3")).then(() => null), driving]);
  if (reached) assert.fail(`The drive ended before an L3 dispatch: ${JSON.stringify(ok(reached).run?.value.state)} ${actions(f.store).join(",")}`);
  other(f.database, store => ok(stopPass(store, { project })));
  assert.equal(ok(await driving).end, "stopped");
  const after = actions(f.store).slice(done);
  assert.deepEqual(after.slice(0, 4), ["confirm", "close", "confirm", "close"], `A D2 and a G7 per goal: ${after.join(",")}`);
  assert.equal(f.sent().length, 3, "Each block paid once; the third call is the first L3 work");
  const built = ok(prepareRunBases(f.store, { project }));
  if (built.state !== "ready") assert.fail("The bases over the accepted N2 are current");
  const routes = f.store.get<RoutesRecord>(built.built.bases.routes.id, built.built.bases.routes.revision)!.value;
  const third = f.store.list<OmModelCall>("model-call").map(row => f.store.get<QuestionPacketRecord>(row.value.om.request.packet.id, row.value.om.request.packet.revision)!)
    .find(packet => routes.batches.some(batch => batch.id === packet.value.request.batch && batch.level === 3));
  assert.ok(third, "The last dispatch is work of an L3 batch of the new issue");
  const run = ok(readRun(f.store, { project }))!;
  assert.ok(!f.store.history(run.id).some(row => ["bases_stale", "d2_bases"].includes((row.value as unknown as RunRecord).state.phase === "waiting"
    ? ((row.value as unknown as RunRecord).state as { wait: { code: string } }).wait.code : "")), "The drive never stood on bases_stale or d2_bases");
});

// ENV1 (contract №4864 §4): the conditions of a NEW OM pass are observed at its start, before any B1, pass record or call.
const conditionOf = (store: Store, name: string) => readEnvironmentReadiness(store, { project }).conditions.find(row => row.condition === name)!;
function reconfigure(store: Store, change: Partial<Omit<Environment, "projectId">>) {
  const head = store.get<Environment>(`environment:${project}`)!, { projectId: _projectId, ...value } = head.value;
  return new Environments(store).configure(project, { ...value, ...change }, head.revision);
}
async function heldStart(f: Fixture, name: string) {
  f.steps([holding(f.pause(name))]);
  const driving = startPass(f.store, { project });
  const first = await Promise.race([checkpoint(f.pause(name)).then(() => null), driving]);
  if (first) assert.fail(`The start ended before its first dispatch: ${JSON.stringify(first.ok ? first.value.end : first.refusal)}`);
  other(f.database, store => ok(stopPass(store, { project })));
  return ok(await driving) as PassOutcome;
}

for (const cold of [true, false])
test(`ENV1 a live execution precedes readiness for a ${cold ? "cold project" : "saved B1"}; once free, the unready environment writes nothing`, async t => {
  const f = driverFixture(t, cold, ["encoding"], true, { repo: "none" });
  const execution = ok(acquireRunExecution(f.store, { project })) as RunExecution;
  const occupied = snapshot(f.store);
  try {
    const busy = ok(await startPass(f.store, { project }));
    assert.deepEqual([busy.end, busy.refusal?.code, busy.refusal?.at.field], ["busy", "run_busy", "execution"],
      "The existing executor wins over today's readiness refusal");
    assert.deepEqual(busy.refusal, refusal(acquireRunExecution(f.store, { project })),
      "The read-only precedence check returns the same refusal as the final executor CAS");
    assert.deepEqual(snapshot(f.store), occupied, "The read-only busy check writes nothing");
    assert.equal(f.sent().length, 0, "A busy start sends nothing");
  } finally {
    releaseRunExecution(f.store, execution);
  }

  const free = snapshot(f.store);
  const unready = refusal(await startPass(f.store, { project }));
  assert.deepEqual([unready.code, unready.at.field], ["environment_not_ready", "repository"],
    "The free executor exposes the addressed readiness refusal");
  assert.deepEqual(snapshot(f.store), free, "A free but unready start writes no control, B1, pass or call");
  assert.equal(f.sent().length, 0);
  assert.equal(ok(readRun(f.store, { project })), null);
  assert.equal(cold ? f.store.get(`om-input:${project}`) : null, null, "A cold refusal creates no B1");
});

for (const repo of ["none", "no-head", "nested"] as const)
test(`ENV1 a ${repo} workspace: the research runners stand, the status names the repository, a new pass writes and calls nothing; after the operator's fix the same start goes on`, async t => {
  const f = driverFixture(t, true, ["encoding"], true, { repo });
  assert.deepEqual(["research:implementer", "research:reviewer"].map(name => conditionOf(f.store, name).state), ["available", "available"],
    "Documentary research keeps its runner");
  const repository = conditionOf(f.store, "repository");
  assert.deepEqual([repository.state, repository.code, repository.requiredBy], repo === "nested" ? ["invalid", "repository_root", "om-start"]
    : ["missing", repo === "none" ? "repository_unavailable" : "repository_head_missing", "om-start"]);
  const before = snapshot(f.store);
  const refused = refusal(await startPass(f.store, { project }));
  assert.deepEqual([refused.code, refused.at.field, refused.at.target], ["environment_not_ready", "repository", repository.at]);
  assert.deepEqual(snapshot(f.store), before, "No B1, pass or call record");
  assert.equal(f.sent().length, 0, "Nothing is sent");
  if (repo === "none") { git(f.repository, ["init", "-b", "main"]); commitAll(f.repository); }
  else if (repo === "no-head") commitAll(f.repository);
  // Selecting another folder would invalidate the refined layers made on this workspace; the operator makes it a root.
  else { git(f.workspace, ["init", "-b", "main"]); commitAll(f.workspace); }
  assert.equal(conditionOf(f.store, "repository").state, "available");
  assert.equal((await heldStart(f, "fixed")).end, "stopped");
  assert.ok(f.store.get(`om-input:${project}`) && ok(readRun(f.store, { project })), "The same start now writes the pass");
});

test("ENV1 a saved om-input without a pass gets the same admission at startRun: refused before the pass; after the fix the start goes on", async t => {
  const f = driverFixture(t, false, ["encoding"], true, { repo: "no-head" });
  const input = reference(f.store.get(`om-input:${project}`)!);
  assert.equal(ok(readRun(f.store, { project })), null);
  const before = snapshot(f.store);
  assert.deepEqual([refusal(await startPass(f.store, { project })).code], ["environment_not_ready"]);
  assert.deepEqual(snapshot(f.store), before);
  commitAll(f.repository);
  assert.equal((await heldStart(f, "saved")).end, "stopped");
  assert.ok(ok(readRun(f.store, { project })), "The pass is written on the saved input");
  assert.deepEqual(reference(f.store.get(`om-input:${project}`, input.revision)!), input, "The saved B1 history stays");
});

for (const change of ["environment", "dispatch"] as const)
test(`ENV1 a second Store changes the ${change} after the admission and before the first write of the new pass: it refuses and nothing of the pass is written`, async t => {
  const f = driverFixture(t, true);
  const original = f.store.writeMany.bind(f.store); let moved = false;
  f.store.writeMany = function<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    if (!moved && writes.some(write => write.id === `om-input:${project}` || write.id === runId(project))) {
      moved = true;
      other(f.database, store => change === "environment" ? reconfigure(store, { timeoutMs: 11_000 })
        : ok(configureDispatch(store, { project, protocol: "devin-stdio" })));
    }
    return original<T>(writes, guards);
  };
  let result: Awaited<ReturnType<typeof startPass>>;
  try { result = await startPass(f.store, { project }); } finally { f.store.writeMany = original; }
  assert.ok(moved, "The change landed inside the window");
  assert.equal(refusal(result).code, "input_stale");
  assert.equal(f.store.get(`om-input:${project}`), null, "No B1");
  assert.equal(ok(readRun(f.store, { project })), null, "No pass");
  assert.equal(f.sent().length, 0);
});

test("ENV1 a dispatch switched after the first selection and before readiness is the guarded dispatch used by the new pass", async t => {
  const f = driverFixture(t, true);
  const original = f.store.get.bind(f.store); let activeReads = 0, moved = false;
  f.store.get = function<T = Json>(id: string, revision?: number): Revision<T> | null {
    const found = original<T>(id, revision);
    if (!moved && revision === undefined && id === `adapter:${project}:active` && ++activeReads === 1) {
      moved = true;
      other(f.database, store => ok(configureDispatch(store, { project, protocol: "devin-stdio" })));
    }
    return found;
  };
  const outcome = await heldStart(f, "dispatch-selection");
  assert.equal(outcome.end, "stopped");
  assert.ok(moved, "The dispatch moved between the first selection and the readiness snapshot");
  const call = f.store.list<OmModelCall>("model-call")[0]!;
  assert.equal(call.value.om.request.dispatch.adapter.id, `adapter:${project}:active`,
    "The call uses the dispatch selected by the readiness snapshot, not the stale earlier selection");
});

test("ENV1 a check script the product will write is a future condition — neither ready nor a refusal — and the check is never run here", async t => {
  const f = driverFixture(t, true, ["encoding"], true, { fullCheck: { executable: process.execPath, args: ["scripts/check.mjs"] } });
  assert.deepEqual([conditionOf(f.store, "check").state, conditionOf(f.store, "check").requiredBy], ["future", "check"]);
  assert.equal(omStartReadiness(f.store, project).ok, true, "A future check does not forbid OM");
  const marker = join(f.root, "check-ran");
  mkdirSync(join(f.workspace, "scripts"), { recursive: true });
  writeFileSync(join(f.workspace, "scripts", "check.mjs"), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');`);
  assert.equal(conditionOf(f.store, "check").state, "unverified", "An existing check is not reported ready either");
  assert.equal((await heldStart(f, "check")).end, "stopped");
  assert.equal(existsSync(marker), false, "No baseline run");
});

test("ENV1 a saved pass is continued under its own record: today's missing repository is shown, but neither blocks the continuation nor reinterprets history", async t => {
  const { f, stop } = await stoppedAtFirstDispatch(t);
  rmSync(join(f.repository, ".git"), { recursive: true, force: true });
  assert.equal(conditionOf(f.store, "repository").state, "missing", "Today's status names it");
  const saved = ok(readPass(f.store, { project }));
  assert.ok(saved.run, "The saved pass reads as it is");
  ok(resumeStoppedPass(f.store, { project, stop }));
  const continued = await startPass(f.store, { project });
  assert.notEqual(continued.ok ? null : continued.refusal.code, "environment_not_ready", "A saved pass is not started again");
});

test("ENV1 a change between the new B1 and its pass refuses the pass; the B1 stands as a saved input and the next start takes it without a second B1", async t => {
  const f = driverFixture(t, true);
  const original = f.store.writeMany.bind(f.store); let moved = false;
  f.store.writeMany = function<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    if (!moved && writes.some(write => write.id === runId(project))) { moved = true; other(f.database, store => reconfigure(store, { timeoutMs: 11_000 })); }
    return original<T>(writes, guards);
  };
  let result: Awaited<ReturnType<typeof startPass>>;
  try { result = await startPass(f.store, { project }); } finally { f.store.writeMany = original; }
  assert.ok(moved);
  assert.equal(refusal(result).code, "input_stale");
  assert.equal(ok(readRun(f.store, { project })), null, "No pass on the stale reading");
  const input = reference(f.store.get(`om-input:${project}`)!);
  assert.equal((await heldStart(f, "after")).end, "stopped");
  assert.ok(ok(readRun(f.store, { project })), "The pass is written on today's conditions");
  assert.deepEqual(reference(f.store.get(`om-input:${project}`, input.revision)!), input);
  assert.equal(f.store.history(`om-input:${project}`).length >= 1, true);
});

for (const missing of ["capacity", "dispatch"] as const)
test(`ENV1 a missing ${missing}: the status names its address before OM; the start refuses before any write; after configure the same start goes on without a second B1`, async t => {
  // The dispatch is configured under a capacity: without one the operator configures both, capacity first.
  const f = driverFixture(t, true, ["encoding"], true, missing === "capacity" ? { capacity: false, dispatch: false } : { dispatch: false });
  const shown = conditionOf(f.store, missing);
  assert.deepEqual([shown.state, shown.requiredBy], ["missing", "om-start"]);
  assert.equal(shown.at, missing === "capacity" ? `environment:${project}` : `adapter:${project}:codex-stdio`);
  const before = snapshot(f.store);
  const refused = refusal(await startPass(f.store, { project }));
  assert.equal(refused.code, missing === "capacity" ? "capacity_missing" : "record_missing");
  assert.deepEqual(snapshot(f.store), before, "Nothing is written");
  assert.equal(f.sent().length, 0);
  if (missing === "capacity") reconfigure(f.store, { requestCapacityChars: 100_000 });
  ok(configureDispatch(f.store, { project, protocol: "codex-stdio" }));
  assert.equal(conditionOf(f.store, missing).state, "available");
  assert.equal((await heldStart(f, "configured")).end, "stopped");
  assert.equal(f.store.history(`om-input:${project}`).length, 1, "One B1");
});
