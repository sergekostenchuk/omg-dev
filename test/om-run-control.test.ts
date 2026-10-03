import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Environments } from "../src/runtime/environment.js";
import { Store, type Revision, type TransactionGuard, type Write } from "../src/storage/store.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { assessFact } from "../src/om/assessment.js";
import { gapLineExpectedResult, gapLineKey } from "../src/om/gap-lines.js";
import { writeGaps, type GapRequest } from "../src/om/gaps.js";
import { writeHorizon } from "../src/om/horizon.js";
import { writeOmInput } from "../src/om/input.js";
import { readModelCall, runModelCall, runModelCycle, type OmModelCall } from "../src/om/model-call.js";
import { probeProcessIdentity, stopOwnedGroup } from "../src/runtime/process-identity.js";
import { prepareQuestionTasks, writeQuestionPacket } from "../src/om/question-packet.js";
import type { OmResult, Refusal } from "../src/om/refusal.js";
import { recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND } from "../src/om/refusal-journal.js";
import { writeGuarded } from "../src/om/refs.js";
import { closeAttempt } from "../src/om/repeat-gate.js";
import { writeRoutes } from "../src/om/routes.js";
import { beginAttempt, openSeries, seriesAddress, type AnyRepairSeries, type AttemptGoal } from "../src/om/series.js";
import { runStopAnalysis } from "../src/om/stop-analysis.js";
import { acquireRunExecution, admitRunControl, readRunControl, releaseRunExecution, resumeStoppedRun, runControlId, RunControlGate,
  RunControlLost, RUN_CONTROL_CODES, stopRun, type RunControlRecord, type RunExecution } from "../src/om/run-control.js";
import { resumeStoppedPass, stopPass } from "../src/om/run-driver.js";
import { gardenGraph } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";

const adapterFixture = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));
const controlModule = new URL("../src/om/run-control.js", import.meta.url).href;
const storeModule = new URL("../src/storage/store.js", import.meta.url).href;
const modelModule = new URL("../src/om/model-call.js", import.meta.url).href;
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`Unexpected refusal: ${result.refusal.code}: ${result.refusal.message} ${JSON.stringify(result.refusal.at)}`);
  return result.value;
}
function refusal<T>(result: OmResult<T>): Refusal { if (result.ok) assert.fail("Expected a refusal"); return result.refusal; }
const snapshot = (store: Store): Ref[] => store.list().map(reference);

function bareStore(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-h13-control-")), database = join(root, "state.sqlite");
  let store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, database, get store() { return store; }, restart() { store.close(); store = new Store(database); } };
}
/** Another connection to the same file: another store, as another executor or operator would hold. */
function other<T>(database: string, action: (store: Store) => T): T {
  const store = new Store(database);
  try { return action(store); } finally { store.close(); }
}
/** The pause checkpoint of the adapter fixture, read again until its JSON is whole (the fixture writes it in place). */
async function checkpoint(path: string): Promise<{ pid: number }> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (existsSync(path)) { try { return JSON.parse(readFileSync(path, "utf8")) as { pid: number }; } catch { /* still being written */ } }
    if (Date.now() > deadline) assert.fail(`The adapter never reached its checkpoint ${path}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
/** A live executor in another process: it takes the execution of the pass and stays until killed. */
async function executorProcess(t: TestContext, database: string, project: string): Promise<{ child: ChildProcess; result: { ok: boolean; code?: string } }> {
  const script = `const [{ Store }, control] = await Promise.all([import(${JSON.stringify(storeModule)}), import(${JSON.stringify(controlModule)})]);
const store = new Store(${JSON.stringify(database)});
const got = control.acquireRunExecution(store, { project: ${JSON.stringify(project)} });
process.stdout.write(JSON.stringify(got.ok ? { ok: true } : { ok: false, code: got.refusal.code }) + "\\n");
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  const line = await new Promise<string>((resolve, reject) => {
    let out = ""; child.stdout!.on("data", data => { out += String(data); if (out.includes("\n")) resolve(out.split("\n")[0]!); });
    child.once("exit", () => reject(new Error("The executor process ended before it reported")));
  });
  return { child, result: JSON.parse(line) as { ok: boolean; code?: string } };
}
async function killed(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGKILL"); await exited;
}

/** A real standalone MC1 fact attempt with its packet, its E4 dispatch and, after the original call, its E5 request. */
function factFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-h13-fact-")), database = join(root, "state.sqlite"), project = "garden";
  let store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), desired = gardenGraph("cross");
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = [{ id: "encoding", question: "What encoding is supported?",
      consumer: "garden-consume-block", moment: "om-pass", blocksCurrentStage: false, resolution: "Resolve the addressed question during OM" }];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: [{ pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: "discovery:encoding", field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write }] }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: "h13-fact", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(store, sources)), gapRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = ok(prepareQuestionTasks(store, { project, gaps: gapRequest,
    questions: gaps.records.filter(row => row.value.gap.kind === "repository-fact" && row.value.gap.code !== "inventory_missing" && !row.value.gap.deferral)
      .map(gap => ({ gap: reference(gap), requirements: [{ pointer: "/contracts/0" }], resultForm: { type: "string" } })) }));
  const routes = ok(writeRoutes(store, { project, gaps: gapRequest, tasks: tasks.tasks.map(task => ({ pending: structuredClone(task.writes[0]!) as Write })),
    catalog: { paths: ["h13-source.txt"], records: [] }, previous: null }));
  const batch = routes.value.batches.find(item => item.model === "MC1" && item.items.some(row => row.target === "discovery:encoding"))!;
  assert.ok(batch);
  writeFileSync(join(root, "h13-source.txt"), "UTF-8 is the supported encoding.");
  const source = store.get<{ content: string }>(`source:${project}:brief`)!, block = "garden-consume-block";
  const goal: AttemptGoal = { key: "h13:fact", questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  ok(openSeries(store, { project, block, line: 1, slice: "h13-fact", predecessor: null, basis: null }));
  const series = ok(beginAttempt(store, { project, block, line: 1, attempt: 1, goal }));
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const config = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "h13-researcher", model: "fixture", effort: "high", command },
    reviewer: { actor: "h13-assessor", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 100_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:h13`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  const packet = ok(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id, environment: reference(config),
    attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  const dispatch = { adapter: reference(adapter), config: reference(config) };
  const original = { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
    results: batch.items.map(item => ({ questionId: item.gap, value: "UTF-8", citations: [{ source: reference(source),
      selector: { kind: "text-range", start: 0, end: source.value.content.length } }] })) }, usage };
  const request = { project, packet: reference(packet), dispatch, role: "implementer" as const };
  return { root, database, project, request, original, dispatch, questionId: batch.items[0]!.gap, pause: join(root, "pause.json"),
    get store() { return store; }, restart(make: (path: string) => Store = path => new Store(path)) { store.close(); store = make(database); },
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ steps })); },
    sent(): unknown[] { return existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) : []; } };
}
const assessorStep = { research: { verdict: "supported", reasons: [] }, usage };

/** A block series stopped by three attempts without progress, and the request of its independent review (A6). */
function analysisFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-h13-a6-")), database = join(root, "state.sqlite"), project = "analysis";
  let store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const environment = new Environments(store).configure(project, { workspace: root,
    implementer: { actor: "analysis-author", model: "local-author", effort: "high", command },
    reviewer: { actor: "independent-reviewer", model: "local-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 200_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:analysis`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  const address = { project, block: "analysis-block", line: 1 };
  const goal: AttemptGoal = { key: "prove-workspace", questions: ["Which declared workspace condition prevents this work?"],
    result: "A checked workspace condition allowing the declared work" };
  ok(openSeries(store, { ...address, slice: "workspace-v1", predecessor: null, basis: null }));
  const source = store.write({ id: `${unitRefusalNamespace(project)}workspace`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: { gate: "G6", refusals: [{ code: "workspace_unavailable", goal: goal.key, remedy: "Observe the declared workspace condition",
      origin: { name: "workspace_unavailable", stage: "feasibility", subject: "workspace", sources: [{ role: "environment", ref: reference(environment) }] } }] } });
  const row = ok(recordRefusal(store, { project, source: reference(source) })).value.rows[0]!;
  for (let attempt = 1; attempt <= 3; attempt++) {
    ok(beginAttempt(store, { ...address, attempt, goal }));
    ok(closeAttempt(store, { ...address, attempt, outcome: { reason: "refused", accepting: [], cancelling: [], refusals: [{ row: row.id, name: row.code, goal: row.goal }] } }));
  }
  const series = store.get<AnyRepairSeries>(seriesAddress(address).id)!;
  assert.equal(series.value.stop?.attempt, 3);
  const request = { project, series: reference(series), hold: null, dispatch: { config: reference(environment), adapter: reference(adapter) } };
  const answer = { protocol: "omg-stop-analysis/v1",
    cause: { kind: "hypothesis", text: "The same unanswered workspace question is repeated without new observations.", sources: [] },
    change: { text: "Obtain the addressed workspace observation before repeating this goal.", addresses: [{ ref: request.series, field: "attempts" }] }, origin: null };
  return { root, database, project, request, answer, pause: join(root, "pause.json"),
    get store() { return store; },
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ steps })); },
    sent(): unknown[] { return existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) : []; } };
}
/** A store whose one write of the chosen kind runs `after` from another store right after it commits (a crash or race window). */
function afterWrite(match: (write: Write) => boolean, after: () => void) {
  return class extends Store {
    done = false;
    override writeMany<T = Json>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
      const written = super.writeMany<T>(inputs, guards);
      if (!this.done && inputs.some(match)) { this.done = true; after(); }
      return written;
    }
  };
}
const running = (write: Write) => write.kind === "model-call" && (write.value as { status?: string }).status === "running"
  && !(write.value as { execution?: { phase?: string } }).execution?.phase?.startsWith("auth");
const received = (write: Write) => write.kind === "model-call" && (write.value as unknown as OmModelCall).om?.application === "received";

test("R6 R14 R16 R17 H1.3 a stop is saved before any record, repeats without a revision and survives a restart; only the named stop is lifted, two resumes converge and a late one lifts nothing newer", t => {
  const f = bareStore(t), project = "garden";
  assert.equal(ok(readRunControl(f.store, { project })).control, null);
  const stopped = ok(stopRun(f.store, { project }));
  assert.equal(stopped.stopped, true); assert.equal(stopped.finished, true, "No executor and no claimed call: the end is proved");
  const stop = stopped.control!.value.stop!.token;
  assert.deepEqual(ok(stopRun(f.store, { project })).control, stopped.control, "A repeated stop is the saved one, without a revision");
  assert.equal(f.store.history(runControlId(project)).length, 1);
  f.restart();
  assert.equal(ok(readRunControl(f.store, { project })).stopped, true, "The stop is durable across a restart");
  assert.throws(() => admitRunControl(f.store, project), (error: unknown) => error instanceof RunControlLost && error.refusal.code === "run_stopped");
  assert.equal(refusal(resumeStoppedRun(f.store, { project, stop: "another-stop" })).code, "run_stop_stale");
  const resumed = ok(resumeStoppedRun(f.store, { project, stop }));
  assert.deepEqual([resumed.value.generation, resumed.value.stop, resumed.value.resumed], [2, null, stop]);
  assert.deepEqual(ok(resumeStoppedRun(f.store, { project, stop })), resumed, "Two resumes of one stop converge on one generation");
  const next = ok(stopRun(f.store, { project })).control!;
  assert.equal(refusal(resumeStoppedRun(f.store, { project, stop })).code, "run_stop_stale", "A late resume never lifts a newer stop");
  assert.equal(ok(readRunControl(f.store, { project })).control!.revision, next.revision);
  assert.equal(refusal(resumeStoppedRun(f.store, { project: "unknown", stop })).code, "run_not_stopped");
  for (const bad of [{}, { project: "" }, { project, extra: 1 }]) assert.throws(() => stopRun(f.store, bad as never),
    (error: unknown) => error instanceof EngineError && error.code === "run_control_request_invalid");
  assert.throws(() => resumeStoppedRun(f.store, { project, stop: "" }),
    (error: unknown) => error instanceof EngineError && error.code === "run_control_request_invalid");
  assert.deepEqual([...RUN_CONTROL_CODES].sort(), ["run_busy", "run_control_changed", "run_control_record_invalid", "run_control_request_invalid",
    "run_not_stopped", "run_stop_stale", "run_stop_unfinished", "run_stopped"]);
});

test("R4 R5 R17 H1.3 one executor by CAS: a live owner in this or another process is busy, a proved-dead one is replaced, and an old executor never releases a newer one", async t => {
  const f = bareStore(t), project = "garden";
  const first = ok(acquireRunExecution(f.store, { project })) as RunExecution;
  assert.equal(refusal(other(f.database, store => acquireRunExecution(store, { project }))).code, "run_busy", "A second store of the same live process is busy");
  releaseRunExecution(f.store, first);
  assert.equal(ok(readRunControl(f.store, { project })).control!.value.execution, null);
  const child = await executorProcess(t, f.database, project);
  assert.deepEqual(child.result, { ok: true });
  const busy = refusal(acquireRunExecution(f.store, { project }));
  assert.deepEqual([busy.code, busy.at.field], ["run_busy", "execution"], "A live executor of another process is never displaced");
  await killed(child.child);
  const taken = ok(acquireRunExecution(f.store, { project })) as RunExecution;
  assert.notEqual(taken.executor.token, first.executor.token, "A proved-dead executor is replaced by a new token");
  releaseRunExecution(f.store, first);
  assert.equal(ok(readRunControl(f.store, { project })).control!.value.execution!.token, taken.executor.token,
    "A released old executor does not clear the current one");
  const held = taken.hold;
  ok(stopRun(f.store, { project }));
  assert.throws(() => admitRunControl(f.store, project, held), (error: unknown) => error instanceof RunControlLost && error.refusal.code === "run_stopped");
  releaseRunExecution(f.store, taken);
  const stop = ok(readRunControl(f.store, { project })).control!.value.stop!.token;
  ok(resumeStoppedRun(f.store, { project, stop }));
  const fenced = (() => { try { admitRunControl(f.store, project, held); return null; } catch (error) { return error; } })();
  assert.ok(fenced instanceof RunControlLost && fenced.refusal.code === "run_control_changed",
    "An executor admitted before the stop keeps its old generation: it never takes the new head");
});

test("R7 H1.3 a stop between the check and the write of new work refuses the write: nothing is written, and a stale input of another record stays the producer's own race", t => {
  const f = bareStore(t), project = "garden";
  const gate = new RunControlGate(f.store, project);
  gate.admit();
  other(f.database, store => ok(stopRun(store, { project })));
  const before = snapshot(f.store);
  assert.throws(() => writeGuarded(gate.view(), { unit: "H1.3", target: "work:one", writes: [{ id: "work:one", kind: "work", expected: 0, value: {} }], guards: [] }),
    (error: unknown) => error instanceof RunControlLost && error.refusal.code === "run_stopped");
  assert.deepEqual(snapshot(f.store), before, "The stopped work wrote nothing");
  const unstopped = bareStore(t), basis = unstopped.store.write({ id: "basis:one", kind: "basis", expected: 0, value: { n: 1 } });
  const free = new RunControlGate(unstopped.store, project);
  other(unstopped.database, store => { const head = store.get("basis:one")!; store.write({ id: head.id, kind: head.kind, expected: head.revision, value: { n: 2 } }); });
  const raced = writeGuarded(free.view(), { unit: "H1.3", target: "work:two", writes: [{ id: "work:two", kind: "work", expected: 0, value: {} }], guards: [reference(basis)] });
  assert.equal(refusal(raced).code, "input_stale", "A changed basis is an ordinary stale input, not a lost control");
});

test("R18 H1.3 a stop belongs to its own store and project: another copy of the database and another project keep working", t => {
  const f = bareStore(t), copy = join(f.root, "copy.sqlite");
  f.store.write({ id: "seed:one", kind: "seed", expected: 0, value: {} });
  f.store.close(); copyFileSync(f.database, copy); f.restart();
  ok(stopRun(f.store, { project: "garden" }));
  assert.throws(() => admitRunControl(f.store, "garden"), (error: unknown) => error instanceof RunControlLost);
  assert.equal(admitRunControl(f.store, "orchard").hold.control, null, "Another project of the same store is not stopped");
  other(copy, store => {
    assert.equal(ok(readRunControl(store, { project: "garden" })).stopped, false, "Another copy with the same project is not stopped");
    ok(acquireRunExecution(store, { project: "garden" }));
  });
});

test("R15 H1.3 a saved stop refuses every direct physical entry without a signal: E4, E5 and A6 write no intent, E1 or claim and send nothing", async t => {
  const f = factFixture(t);
  f.steps([f.original, assessorStep]);
  const original = ok(await runModelCall(f.store, f.request));
  assert.equal(original.outcome?.kind, "fact-candidates");
  ok(stopRun(f.store, { project: f.project }));
  const before = snapshot(f.store), sent = f.sent().length;
  const assessed = refusal(await assessFact(f.store, { project: f.project, modelCall: reference(original.record), questionId: f.questionId, dispatch: f.dispatch }));
  assert.equal(assessed.code, "run_stopped");
  assert.deepEqual(snapshot(f.store), before, "E5 wrote no intent, no E1 and no claim");
  const repeated = ok(await runModelCall(f.store, f.request));
  assert.deepEqual(repeated.record, original.record, "The saved E4 call is read under any control: nothing is sent again");
  assert.equal(f.sent().length, sent);
  const a = analysisFixture(t);
  a.steps([{ research: a.answer, usage }]);
  ok(stopRun(a.store, { project: a.project }));
  const kept = snapshot(a.store);
  assert.equal(refusal(await runStopAnalysis(a.store, a.request)).code, "run_stopped");
  assert.deepEqual(snapshot(a.store), kept, "A6 wrote no intent, no E1 and no claim");
  assert.equal(a.sent().length, 0);
  const e4 = factFixture(t);
  ok(stopRun(e4.store, { project: e4.project }));
  const clean = snapshot(e4.store);
  assert.equal(refusal(await runModelCall(e4.store, e4.request)).code, "run_stopped");
  assert.deepEqual(snapshot(e4.store), clean, "E4 wrote no E1 and no claim");
  assert.equal(e4.sent().length, 0);
});

test("R8 H1.3 a stop landing after the running claim and before the transfer authorization sends nothing: the created process is stopped and the call keeps its typed launch error", async t => {
  const f = factFixture(t);
  f.steps([f.original]);
  f.restart(path => new (afterWrite(running, () => other(f.database, store => ok(stopRun(store, { project: f.project })))))(path));
  const outcome = ok(await runModelCall(f.store, f.request));
  assert.equal(f.sent().length, 0, "The provider never received the request");
  assert.deepEqual([outcome.record.value.status, outcome.record.value.error], ["failed", "run_stopped"]);
  const exchange = f.store.get<{ launchError: { code: string } | null }>(outcome.record.value.om.exchange!.id)!;
  assert.equal(exchange.value.launchError?.code, "run_stopped", "The refused authorization is the call's own physical result");
  f.restart();
  assert.deepEqual(ok(readModelCall(f.store, { project: f.project, record: reference(outcome.record) })).record, outcome.record);
  assert.deepEqual(ok(await runModelCall(f.store, f.request)).record, outcome.record, "The same dispatch is read again, never resent");
  assert.throws(() => admitRunControl(f.store, f.project), (error: unknown) => error instanceof RunControlLost && error.refusal.code === "run_stopped");
  assert.equal(f.sent().length, 0);
});

test("R9 R10 H1.3 an authorization won before the stop is an existing call: a stop from another store cancels the live E4, E5 and A6 call during its dispatch, its exact outcome is saved and nothing further is admitted", async t => {
  // E4: the provider has the request and holds it; the stop reaches the live call through its watch, not its timeout.
  const e4 = factFixture(t);
  e4.steps([{ ...e4.original, pauseAfterRequest: e4.pause }]);
  const started = Date.now(), call = runModelCall(e4.store, e4.request);
  await checkpoint(e4.pause);
  other(e4.database, store => ok(stopRun(store, { project: e4.project })));
  const cancelled = ok(await call);
  assert.ok(Date.now() - started < 9_000, "The stop was seen during the call, before its 10 s timeout");
  assert.equal(e4.sent().length, 1);
  assert.deepEqual([cancelled.record.value.status, cancelled.record.value.error], ["failed", "process_cancelled"]);
  assert.deepEqual(ok(await runModelCall(e4.store, e4.request)).record, cancelled.record, "The cancelled call is its saved outcome, not resent");
  assert.throws(() => admitRunControl(e4.store, e4.project), (error: unknown) => error instanceof RunControlLost && error.refusal.code === "run_stopped",
    "No next admission after the cancelled call");
  assert.equal(e4.sent().length, 1);
  // E5: the original call is complete; the assessor holds its request when the stop arrives.
  const e5 = factFixture(t);
  e5.steps([e5.original, { ...assessorStep, pauseAfterRequest: e5.pause }]);
  const original = ok(await runModelCall(e5.store, e5.request));
  const assessing = assessFact(e5.store, { project: e5.project, modelCall: reference(original.record), questionId: e5.questionId, dispatch: e5.dispatch });
  await checkpoint(e5.pause);
  other(e5.database, store => ok(stopRun(store, { project: e5.project })));
  const terminal = ok(await assessing);
  assert.equal(terminal.value.verdict, "interrupted", "The cancelled assessor is its own exact physical outcome");
  assert.equal(e5.sent().length, 2);
  // A6: the reviewer holds its request when the stop arrives.
  const a6 = analysisFixture(t);
  a6.steps([{ research: a6.answer, usage, pauseAfterRequest: a6.pause }]);
  const analysing = runStopAnalysis(a6.store, a6.request);
  await checkpoint(a6.pause);
  other(a6.database, store => ok(stopRun(store, { project: a6.project })));
  const analysis = ok(await analysing);
  assert.notEqual(analysis.value.state, "decided", "A cancelled review decides nothing");
  assert.equal(a6.sent().length, 1);
});

test("R12 R13 H1.3 a complete receipt saved before the stop is applied by the live call; the next dispatch is refused and a new store reads the same result", async t => {
  const f = factFixture(t);
  f.steps([f.original, assessorStep]);
  f.restart(path => new (afterWrite(received, () => other(f.database, store => ok(stopRun(store, { project: f.project })))))(path));
  const applied = ok(await runModelCall(f.store, f.request));
  assert.equal(applied.outcome?.kind, "fact-candidates", "The paid complete answer is applied, not turned into a loss");
  assert.equal(f.sent().length, 1);
  assert.equal(refusal(await assessFact(f.store, { project: f.project, modelCall: reference(applied.record), questionId: f.questionId, dispatch: f.dispatch })).code,
    "run_stopped", "The assessor is a new dispatch and does not start");
  f.restart();
  const read = ok(readModelCall(f.store, { project: f.project, record: reference(applied.record) }));
  const candidates = (outcome: unknown) => (outcome as { facts?: unknown }).facts;
  assert.deepEqual([read.record, read.outcome?.kind, candidates(read.outcome)], [applied.record, applied.outcome?.kind, candidates(applied.outcome)],
    "A new store reads the same complete bytes and the same facts");
  assert.equal(f.sent().length, 1);
});

test("R11 H1.3 a stop whose old execution is not proved over keeps its addressed reasons: a live executor, then an unrecovered claimed call; resume is refused until the end is proved", async t => {
  const f = factFixture(t);
  const executor = await executorProcess(t, f.database, f.project);
  assert.deepEqual(executor.result, { ok: true });
  const stopped = ok(stopRun(f.store, { project: f.project }));
  assert.equal(stopped.finished, false);
  assert.deepEqual(stopped.pending.map(item => [item.code, item.at.field]), [["run_stop_unfinished", "execution"]]);
  const stop = stopped.control!.value.stop!.token;
  assert.equal(refusal(resumeStoppedPass(f.store, { project: f.project, stop })).code, "run_stop_unfinished");
  await killed(executor.child);
  // A claim of this live process with no receipt: its end is not proved while its owner lives.
  f.steps([f.original]);
  ok(resumeStoppedPass(f.store, { project: f.project, stop }));
  const crashing = class extends Store {
    override writeMany<T = Json>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
      const written = super.writeMany<T>(inputs, guards);
      if (inputs.some(running)) throw new Error("simulated crash after the durable claim");
      return written;
    }
  };
  f.restart(path => new crashing(path));
  await assert.rejects(runModelCall(f.store, f.request), /simulated crash after the durable claim/);
  f.restart();
  const again = ok(stopRun(f.store, { project: f.project }));
  assert.deepEqual(again.pending.map(item => [item.code, item.at.field]), [["run_stop_unfinished", "status"]]);
  const refused = refusal(resumeStoppedPass(f.store, { project: f.project, stop: again.control!.value.stop!.token }));
  assert.deepEqual([refused.code, refused.at.field], ["run_stop_unfinished", "recovery"], "A live owner of the claim is not presumed dead");
  assert.equal(f.sent().length, 0);
  assert.equal(ok(readRunControl(f.store, { project: f.project })).stopped, true, "The stop stays");
  const record = f.store.get<RunControlRecord>(runControlId(f.project))!;
  assert.equal(record.value.generation, 2);
});

test("Т4 H1.3 an absent dispatch or pass and a masquerading control input are typed refusals: no E4.1 dispatch, a continue without a pass, a hold of another project or with a changed hash", async t => {
  const { startPass, continuePass } = await import("../src/om/run-driver.js");
  const f = bareStore(t), project = "garden";
  const missing = refusal(await startPass(f.store, { project }));
  assert.equal(missing.code, "environment_missing", "The dispatch comes only from the E4.1 reader");
  assert.equal(refusal(await continuePass(f.store, { project })).code, "record_missing", "A continue never starts a pass");
  assert.equal(f.store.list().length, 0, "Nothing was written for either");
  assert.throws(() => admitRunControl(f.store, project, { project: "orchard", control: null }),
    (error: unknown) => error instanceof EngineError && error.code === "run_control_request_invalid");
  const held = (ok(acquireRunExecution(f.store, { project })) as RunExecution).hold;
  const forged = { project, control: { ...held.control!, hash: "0".repeat(64) } };
  assert.throws(() => admitRunControl(f.store, project, forged), (error: unknown) => error instanceof RunControlLost && error.refusal.code === "run_control_changed",
    "A hold with another hash is not the admitted control");
});

test("R17 №2121-1 H1.3 a direct cycle keeps the one admission of its chain: a stop and resume between its first paid result and its continuation fence the old invocation, which sends nothing more", async t => {
  const f = factFixture(t);
  const needSource = { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_source", questionIds: [f.questionId],
    missing: "Need the addressed source data", reads: [{ action: "read", path: "h13-source.txt", media: "text/plain" }] } };
  f.steps([needSource, f.original]);
  let resumed: Revision<RunControlRecord> | null = null;
  const applied = (write: Write) => write.kind === "model-call" && (write.value as unknown as OmModelCall).om?.application === "applied";
  f.restart(path => new (afterWrite(applied, () => other(f.database, store => {
    const stopped = ok(stopRun(store, { project: f.project }));
    assert.equal(stopped.finished, true, "The old invocation holds no execution and no claimed call at this point");
    resumed = ok(resumeStoppedRun(store, { project: f.project, stop: stopped.control!.value.stop!.token }));
  })))(path));
  // The direct entry without a hold: its first dispatch takes the chain's admission, the continuation must stand on it.
  const outcome = refusal(await runModelCycle(f.store, f.request));
  assert.equal(outcome.code, "run_control_changed", "The continuation of the old invocation is fenced by its own generation");
  assert.equal(resumed!.value.generation, 2);
  assert.equal(f.sent().length, 1, "The old invocation dispatched no continuation in the new generation");
  const first = f.store.list<OmModelCall>("model-call")[0]!;
  assert.deepEqual([first.value.status, first.value.om.application], ["succeeded", "applied"], "The first paid answer is accounted");
  assert.equal(f.store.list("om-model-cycle").length, 0, "The fenced cycle left no record: a new invocation finds its saved call again");
  f.restart();
  const again = ok(await runModelCycle(f.store, f.request));
  assert.equal(again.record.value.steps.length, 2, "A new invocation in the new generation reuses the paid call and sends only the continuation");
  assert.equal(f.sent().length, 2);
});

test("R11 R14 №2121-2 H1.3 a stop after the owner's death stops its recorded live provider by the common D8.5 function; the common recovery then proves the end and the resume opens", async t => {
  const f = factFixture(t);
  f.steps([{ ...f.original, pauseAfterRequest: f.pause }]);
  const script = `const [{ Store }, control, model] = await Promise.all([import(${JSON.stringify(storeModule)}), import(${JSON.stringify(controlModule)}), import(${JSON.stringify(modelModule)})]);
const store = new Store(${JSON.stringify(f.database)});
const execution = control.acquireRunExecution(store, { project: ${JSON.stringify(f.project)} });
if (!execution.ok) throw new Error("owner refused");
await model.runModelCall(store, ${JSON.stringify(f.request)}, undefined, execution.value.hold);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let provider: { pid: number; started: string } | null = null;
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; if (provider) stopOwnedGroup(provider); });
  const paused = await checkpoint(f.pause);
  provider = f.store.list<OmModelCall & { providerProcess?: { pid: number; started: string } }>("model-call")[0]!.value.providerProcess!;
  assert.equal(paused.pid, provider.pid, "The authorized provider holds the request");
  child.kill("SIGKILL"); await exited;
  assert.equal(probeProcessIdentity(provider.pid).state, "present", "The owner is gone; its provider still runs");
  // The product stop alone: nobody stops the provider by hand before it.
  const stopped = ok(stopPass(f.store, { project: f.project }));
  assert.equal(probeProcessIdentity(provider.pid).state, "absent", "The stop stopped the recorded provider group of the lost call");
  assert.deepEqual([stopped.stopped, stopped.finished, stopped.pending], [true, true, []], "Owner and provider proved gone; the claimed call is recovered");
  const recovered = f.store.list<OmModelCall & { recovery?: unknown }>("model-call")[0]!;
  assert.ok(recovered.value.recovery, "The common recovery closed the lost call");
  ok(resumeStoppedPass(f.store, { project: f.project, stop: stopped.control!.value.stop!.token }));
  assert.equal(f.sent().length, 1, "Nothing was sent again");
});
