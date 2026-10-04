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
import { readRunControl, runControlId } from "../src/om/run-control.js";
import { continuePass, readPass, resumeStoppedPass, startPass, stopPass, type PassOutcome } from "../src/om/run-driver.js";
import { advanceRun, readRun, runId, startRun, type RunRecord, type RunRequest } from "../src/om/run.js";
import { gardenGraph } from "./om-fixture.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";

const project = "garden";
const adapterFixture = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));
const driverModule = new URL("../src/om/run-driver.js", import.meta.url).href;
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
function driverFixture(t: TestContext, cold = false, questions = ["encoding"], refine = true) {
  const root = mkdtempSync(join(tmpdir(), "omg-h13-drive-")), database = join(root, "state.sqlite"), workspace = join(root, "repo");
  mkdirSync(workspace); git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "H1.3 pass repository\n");
  git(workspace, ["add", "README.md"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
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
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 100_000 }, 0);
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
  const dispatch = ok(configureDispatch(store, { project, protocol: "codex-stdio" })).dispatch;
  return { root, database, dispatch,
    get store() { return store; },
    request(): RunRequest { return { project, dispatch }; },
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
