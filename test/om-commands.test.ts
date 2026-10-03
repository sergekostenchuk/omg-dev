import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "../src/canonical.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { Evidence } from "../src/evidence/evidence.js";
import type { Graph } from "../src/graph/model.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { git } from "../src/runtime/environment.js";
import { Store, type Revision, type TransactionGuard, type Write } from "../src/storage/store.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import type { OmDispatch } from "../src/om/dispatch.js";
import { writeOmInput } from "../src/om/input.js";
import type { OmModelCall } from "../src/om/model-call.js";
import type { QuestionPacketRecord } from "../src/om/question-packet.js";
import type { OmResult, Refusal } from "../src/om/refusal.js";
import type { RoutesRecord } from "../src/om/routes.js";
import { prepareRunBases, writeRunBases } from "../src/om/run-bases.js";
import { runControlId, type RunControlRecord, type RunControlStatus } from "../src/om/run-control.js";
import { readPass, startPass, type PassOutcome } from "../src/om/run-driver.js";
import { advanceRun, runId, type RunRecord, type RunRequest } from "../src/om/run.js";
import { spendReport, type SpendReport } from "../src/om/spend-report.js";
import { gardenGraph } from "./om-fixture.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";

/**
 * H2 — the five OM commands of the one command API (№1821 + №2131): each goes through execute and its schema to the
 * common H1.3 driver, the common reader of the pass or the common F8.3 report, and answers with their own result.
 * Test names carry the rows of table №1821-2 they close.
 */
const project = "garden";
const adapterFixture = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
const COMMANDS = ["om-start", "om-continue", "om-state", "om-spend", "om-stop"] as const;
type State = { run: Revision<RunRecord> | null; control: RunControlStatus };

function ok<T>(result: unknown): T {
  const answer = result as OmResult<T>;
  if (!answer.ok) assert.fail(`Unexpected refusal: ${answer.refusal.code}: ${answer.refusal.message} ${JSON.stringify(answer.refusal.at)}`);
  return answer.value;
}
function refusal(result: unknown): Refusal {
  const answer = result as OmResult<unknown>;
  if (answer.ok) assert.fail("Expected a refusal");
  return answer.refusal;
}
function rejects(action: () => unknown, code: string) {
  assert.throws(action, (error: unknown) => (error as { code?: unknown }).code === code, `Expected ${code}`);
}
const snapshot = (store: Store): Ref[] => store.list().map(reference);
const stepOf = (run: Revision<RunRecord> | null) => (run?.value.state as { step?: { action: string } } | undefined)?.step;

/**
 * A real OM project reached by the operator's commands: prepared stages with one open question, the environment
 * configured through execute with its request capacity, refined layers and the dispatch of configure-om-dispatch.
 * A cold project has no OM record; otherwise B1 exists with every other decision addressed.
 */
function commandFixture(t: TestContext, cold: boolean) {
  const root = mkdtempSync(join(tmpdir(), "omg-h2-commands-")), database = join(root, "state.sqlite"), workspace = join(root, "repo");
  mkdirSync(workspace); git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "H2 command repository\n");
  git(workspace, ["add", "README.md"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  preparedFeatures(engine, project, gardenGraph(), field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = [{ id: "encoding", question: "Which encoding is supported?",
      consumer: "garden-consume-block", moment: "om-pass", blocksCurrentStage: false, resolution: "Address this question during OM" }];
    return value;
  });
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  engine.execute({ type: "configure", project, expected: 0, environment: { workspace,
    implementer: { actor: "h2-implementer", model: "fixture", effort: "high", speed: "fast", command },
    reviewer: { actor: "h2-reviewer", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 100_000 } });
  refinedLayers(engine, project);
  if (!cold) {
    const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
    const graph = reference(store.get(`graph:${project}`)!), base = ok<Revision<{ gaps: { code: string; target: string }[] }>>(writeOmInput(store, { project, expected: 0, stages }));
    const decisions = base.value.gaps.filter(gap => gap.code !== "inventory_missing" && gap.code !== "question_unaddressed").map(gap => {
      const field = gap.code === "contract_node_unbound" ? "nodes" : gap.code === "acceptance_kind_missing" ? "checkKind" : "state";
      const value: Json = field === "nodes" ? ["garden-produce-block", "garden-consume-block"] : field === "checkKind" ? "test"
        : { writer: "garden-produce-block", authority: "garden-user", rollback: "garden-produce-block" };
      return { pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph, layers: [],
        decision: { target: gap.target, field, value } })) as Write };
    });
    if (decisions.length) ok(writeAddressing(store, { project, input: reference(base), graph, decisions }));
  }
  const configured = engine.execute({ type: "configure-om-dispatch", project, protocol: "codex-stdio" }) as OmDispatch;
  return { database, configured,
    get store() { return store; },
    get engine() { return engine; },
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ steps })); },
    sent(): { requestId: string }[] { return existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; },
    pause(name: string) { return join(root, `${name}.pause.json`); },
    restart(make: (path: string) => Store = path => new Store(path)) { store.close(); store = make(database); engine = new ProductEngine(store); } };
}
type Fixture = ReturnType<typeof commandFixture>;
/** Another store and a new engine over the same database, closed only when the command has finished. */
async function elsewhere<T>(database: string, action: (engine: ProductEngine) => T | Promise<T>): Promise<T> {
  const store = new Store(database);
  try { return await action(new ProductEngine(store)); } finally { store.close(); }
}
/** The pause checkpoint of the adapter fixture, read again until its JSON is whole (the fixture writes it in place). */
async function checkpoint(path: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (existsSync(path)) { try { JSON.parse(readFileSync(path, "utf8")); return; } catch { /* still being written */ } }
    if (Date.now() > deadline) assert.fail(`The adapter never reached its checkpoint ${path}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
/** A dispatch that holds its request: the provider has it and waits until it is stopped. */
const holding = (path: string) => ({ research: { held: true }, pauseAfterRequest: path });
function mechanismBatch(f: Fixture) {
  const built = ok<{ state: string; built: { bases: { routes: Ref } } }>(prepareRunBases(f.store, { project }));
  if (built.state !== "ready") assert.fail("The bases of the pass are built");
  const routes = f.store.get<RoutesRecord>(built.built.bases.routes.id, built.built.bases.routes.revision)!.value;
  return routes.batches.find(item => item.model === "MC2" && item.task === "input-field" && item.items.every(row => row.consumers.length === 0))!;
}
function addressAll(f: Fixture) {
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
    results: mechanismBatch(f).items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: { consumer: "garden-consume-block", kind: "repository-fact" } })) } };
}
function cannotAnswer(f: Fixture) {
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: mechanismBatch(f).items.map(item => item.gap),
    action: "cannot_answer", reason: "The requested information is unavailable" }, usage };
}
const undecided = { research: { protocol: "omg-stop-analysis/v1", cause: { kind: "hypothesis", text: "The brief does not settle the encoding", sources: [] },
  change: null, origin: null }, usage };
/**
 * The accepted N2 operations of the real upstream fixture (om-feasibility), loaded without registering its suite, as
 * the H1.2 end-to-end pass loads them: the only fixture whose pass reaches complete.
 */
type OperationsFixture = { root: string; workspace: string; database: string; desired: Graph; readonly store: Store; readonly engine: ProductEngine };
let operationsModule: Promise<{ acceptedOperationsFixture(t: TestContext, status: "planned", count: number): OperationsFixture }> | undefined;
function loadOperations() {
  operationsModule ??= (async () => {
    const url = new URL("./om-feasibility.test.js", import.meta.url), source = readFileSync(url, "utf8");
    const end = source.indexOf("const heads =");
    assert.ok(end > 0);
    const prefix = source.slice(0, end).replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
      (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`);
    assert.ok(!/\btest\(/.test(prefix), "Fixture loading does not register a neighboring test suite");
    return import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport { acceptedOperationsFixture };`).toString("base64")}`);
  })();
  return operationsModule;
}
/** Advances the pass by H1 itself until it saves the named step, so an answer can be written for its exact packet. */
async function savedStep(store: Store, request: RunRequest, action: string) {
  for (let index = 0; index < 20; index++) {
    const state = ok<{ record: Revision<RunRecord> }>(await advanceRun(store, request)).record.value.state;
    if (state.phase === "step" && state.step.action === action) return state.step;
    if (state.phase === "waiting" || state.phase === "complete" || state.phase === "unable") assert.fail(`The pass stood (${state.phase}) before choosing ${action}`);
  }
  assert.fail(`The pass did not choose ${action}`);
}

test("H2 rows 1 3 9 of №1821-2: every malformed OM command is command_invalid before any action; a bare project is read without writes, stopped before its first B1, resumed only by its named stop; a stop between the resume and the continue stands", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-h2-bare-")), database = join(root, "state.sqlite");
  const store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: "create-project", project, title: project });
  engine.execute({ type: "create-project", project: "orchard", title: "orchard" });
  const blank = snapshot(store);
  // Row 1: a strict form. Internal Refs, a claimed state and the driver's own field names are not command input.
  const malformed: unknown[] = [
    ...COMMANDS.flatMap(type => [{ type }, { type, project: "" }, { type, project: `${project}:om` }, { type, project: 7 },
      { type, project, dispatch: {} }, { type, project, hold: null }, { type, project, bases: {} }, { type, project, writes: [] }]),
    ...[[], [""], [" "], [1], [null], "garden-result", null].map(outcomes => ({ type: "om-start", project, outcomes })),
    { type: "om-start", project, intent: { outcomes: ["garden-result"] } }, { type: "om-start", project, end: "complete" },
    ...["", " ", null, true, 7, ["token"], { token: "token" }].map(resumeStop => ({ type: "om-continue", project, resumeStop })),
    { type: "om-continue", project, stop: "token" }, { type: "om-continue", project, resumeStopped: true },
    { type: "om-state", project, run: null }, { type: "om-spend", project, histories: [] }, { type: "om-spend", project, significance: [] },
    { type: "om-stop", project, token: "token" }, { type: "om-stop", project, finished: true },
    { type: "om-resume", project }, { type: "OM-START", project },
  ];
  for (const command of malformed) rejects(() => engine.execute(command), "command_invalid");
  for (const type of COMMANDS) rejects(() => engine.execute({ type, project: "nowhere" }), "project_missing");
  assert.deepEqual(snapshot(store), blank, "No refused command wrote anything");

  // Row 3: a project without a pass is read by the common readers, with no pass created and nothing written.
  const empty = ok<State>(engine.execute({ type: "om-state", project }));
  assert.deepEqual(empty, { run: null, control: { control: null, stopped: false, finished: true, pending: [] } });
  assert.deepEqual(empty, ok(readPass(store, { project })));
  const spend = ok<SpendReport>(engine.execute({ type: "om-spend", project }));
  assert.deepEqual([spend.scope, spend.totals], ["om-e1", { calls: 0, measuredCalls: 0, unmeasuredCalls: 0, reportedTokens: null }]);
  assert.deepEqual(spend, ok(spendReport(store, { project })), "The report is the common one, unchanged");
  assert.equal(refusal(await engine.execute({ type: "om-continue", project })).code, "record_missing", "A continue never starts a pass");
  assert.deepEqual(refusal(await engine.execute({ type: "om-start", project })), refusal(await startPass(store, { project })),
    "An unconfigured dispatch is the driver's own refusal");
  assert.equal(refusal(await engine.execute({ type: "om-continue", project, resumeStop: "no-stop" })).code, "run_not_stopped",
    "A refused resume is the answer; no continue follows it");
  assert.deepEqual(snapshot(store), blank, "Reads, a refused continue and an unconfigured start wrote nothing");

  // The stop holds before any OM input and does not make the project an OM project.
  const stopped = ok<RunControlStatus>(engine.execute({ type: "om-stop", project }));
  assert.deepEqual([stopped.stopped, stopped.finished], [true, true]);
  const first = stopped.control!.value.stop!.token;
  assert.equal(store.get(`om-input:${project}`), null);
  assert.equal(engine.projection(project).feasibilityGate, null, "The saved stop is not evidence of the OM era");
  const held = snapshot(store);
  for (const command of [{ type: "om-start", project }, { type: "om-start", project, outcomes: ["garden-result"] }, { type: "om-continue", project }])
    assert.deepEqual(ok<PassOutcome>(await engine.execute(command)), { end: "stopped", run: null, control: stopped, refusal: null });
  assert.deepEqual(ok(engine.execute({ type: "om-state", project })), { run: null, control: stopped });
  assert.deepEqual(ok(engine.execute({ type: "om-stop", project })), stopped, "A repeated stop is the saved one");
  assert.deepEqual(snapshot(store), held);
  const foreign = ok<RunControlStatus>(engine.execute({ type: "om-stop", project: "orchard" })).control!.value.stop!.token;
  assert.equal(refusal(await engine.execute({ type: "om-continue", project, resumeStop: foreign })).code, "run_stop_stale",
    "Another project's stop lifts nothing here");

  // Row 9: a second store stops the pass right after the resume is written. The continue meets that stop; the written
  // resume is not undone and nothing resumes a second time.
  const raced = { stop: null as string | null };
  const racing = class extends Store {
    override writeMany<T = Json>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
      const written = super.writeMany<T>(inputs, guards);
      const lifted = inputs.some(write => write.id === runControlId(project)
        && (write.value as unknown as RunControlRecord).stop === null && (write.value as unknown as RunControlRecord).resumed === first);
      if (lifted && raced.stop === null) {
        const other = new Store(database);
        try { raced.stop = ok<RunControlStatus>(new ProductEngine(other).execute({ type: "om-stop", project })).control!.value.stop!.token; }
        finally { other.close(); }
      }
      return written;
    }
  };
  const racingStore = new racing(database);
  try {
    const met = ok<PassOutcome>(await new ProductEngine(racingStore).execute({ type: "om-continue", project, resumeStop: first }));
    assert.deepEqual([met.end, met.refusal, met.run, met.control.stopped], ["stopped", null, null, true]);
    assert.deepEqual([met.control.control!.value.stop!.token, met.control.control!.value.resumed], [raced.stop, first]);
  } finally { racingStore.close(); }
  assert.deepEqual(store.history(runControlId(project)).map(row => (row.value as unknown as RunControlRecord).stop?.token ?? null),
    [first, null, raced.stop], "One stop, its one resume, the new stop");
  assert.equal(refusal(await engine.execute({ type: "om-continue", project, resumeStop: first })).code, "run_stop_stale");
  // The exact stop is lifted; its resume stays written although the continue then finds no pass to drive.
  assert.equal(refusal(await engine.execute({ type: "om-continue", project, resumeStop: raced.stop! })).code, "record_missing");
  const lifted = ok<State>(engine.execute({ type: "om-state", project })).control;
  assert.deepEqual([lifted.stopped, lifted.control!.value.resumed], [false, raced.stop]);
  const settled = snapshot(store);
  assert.equal(refusal(await engine.execute({ type: "om-continue", project, resumeStop: raced.stop! })).code, "record_missing");
  assert.deepEqual(snapshot(store), settled, "Two resumes of one stop converge without a revision");
});

test("H2 rows 3 5 9 11 of №1821-2: a configured cold project starts through execute; a second store is busy, its stop leaves the live call unfinished and refuses the resume; reads write nothing and report the unknown spend; a reopened store keeps the pass and resumes it only by the named stop", async t => {
  const f = commandFixture(t, true);
  assert.equal(f.store.get(`om-input:${project}`), null, "No OM record exists");
  f.steps([holding(f.pause("first")), holding(f.pause("second"))]);
  const driving = f.engine.execute({ type: "om-start", project });
  assert.ok(driving instanceof Promise, "A start answers with the promise of its drive");
  await checkpoint(f.pause("first"));
  const otherStore = new Store(f.database), other = new ProductEngine(otherStore);
  let stop: RunControlStatus;
  try {
    const live = ok<State>(other.execute({ type: "om-state", project }));
    assert.equal(stepOf(live.run)?.action, "cycle");
    assert.notEqual(live.control.control!.value.execution, null, "The live executor holds the pass");
    for (const command of [{ type: "om-start", project }, { type: "om-continue", project }]) {
      const busy = ok<PassOutcome>(await other.execute(command));
      assert.deepEqual([busy.end, busy.refusal?.code, busy.refusal?.at.field], ["busy", "run_busy", "execution"]);
    }
    assert.equal(f.sent().length, 1, "A busy command made no second call");
    stop = ok<RunControlStatus>(other.execute({ type: "om-stop", project }));
    // Decided at once, while the live executor still holds its call: no end is proved, and no continue follows.
    const early = other.execute({ type: "om-continue", project, resumeStop: stop.control!.value.stop!.token });
    assert.deepEqual([stop.stopped, stop.finished], [true, false], "The stop is requested, the end is not proved");
    assert.ok(stop.pending.length > 0 && stop.pending.every(item => item.code === "run_stop_unfinished"));
    assert.deepEqual(refusal(await early), stop.pending[0], "The resume answers with the addressed unfinished end");
  } finally { otherStore.close(); }
  const outcome = ok<PassOutcome>(await driving);
  assert.equal(outcome.end, "stopped");
  assert.ok(["run_stopped", "run_control_changed"].includes(outcome.refusal?.code ?? ""), `The driver's control refusal is kept: ${outcome.refusal?.code}`);
  assert.equal(f.store.get(`om-input:${project}`)!.revision, 1, "The machine wrote the first B1 of the pass");
  const calls = f.store.list<OmModelCall>("model-call");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.value.om.request.dispatch, f.configured.dispatch, "The call used the dispatch configure-om-dispatch saved");

  // Row 3: the readers write nothing; the cancelled call's unknown usage is not a zero.
  const before = snapshot(f.store);
  const state = ok<State>(f.engine.execute({ type: "om-state", project }));
  assert.deepEqual([state.control.stopped, state.control.finished, state.control.control!.value.execution], [true, true, null]);
  assert.deepEqual(state.run!.value.intent.outcomes, ["garden-result"], "The launch intent is every outcome of the first B1");
  assert.equal(stepOf(state.run)?.action, "cycle", "The stopped cycle stays the saved step");
  assert.deepEqual(state, ok(readPass(f.store, { project })));
  const spend = ok<SpendReport>(f.engine.execute({ type: "om-spend", project }));
  assert.deepEqual([spend.scope, spend.totals.calls, spend.totals.measuredCalls, spend.totals.unmeasuredCalls, spend.totals.reportedTokens],
    ["om-e1", 1, 0, 1, null]);
  assert.deepEqual(spend, ok(spendReport(f.store, { project })));
  // H1.3 finds the saved stop first: an ordinary continue or start answers stopped with no refusal of its own.
  for (const command of [{ type: "om-continue", project }, { type: "om-start", project }])
    assert.deepEqual(ok<PassOutcome>(await f.engine.execute(command)), { end: "stopped", run: state.run, control: state.control, refusal: null });
  assert.deepEqual(snapshot(f.store), before, "Reads, a continue and a start under the stop wrote nothing");
  assert.equal(f.sent().length, 1);

  // Row 11: a reopened store and a new engine keep intent, step and control; the named resume continues the saved step.
  f.restart();
  assert.deepEqual(ok(f.engine.execute({ type: "om-state", project })), state);
  const token = stop.control!.value.stop!.token;
  const resuming = f.engine.execute({ type: "om-continue", project, resumeStop: token }) as Promise<unknown>;
  const reached = await Promise.race([checkpoint(f.pause("second")).then(() => null), resuming]);
  if (reached) assert.fail(`The drive ended before its next dispatch: ${JSON.stringify(reached)}`);
  const second = await elsewhere(f.database, engine => ok<RunControlStatus>(engine.execute({ type: "om-stop", project })));
  const resumed = ok<PassOutcome>(await resuming);
  assert.equal(resumed.end, "stopped");
  assert.deepEqual([resumed.run!.id, resumed.run!.value.intent, resumed.run!.value.input], [state.run!.id, state.run!.value.intent, state.run!.value.input],
    "The same pass went on");
  const sent = f.sent().map(row => row.requestId);
  assert.deepEqual([sent.length, new Set(sent).size], [2, 2], "The cancelled request was never sent again");
  // Row 9: the first stop's token lifts nothing after the new stop.
  const settled = snapshot(f.store);
  assert.equal(refusal(await f.engine.execute({ type: "om-continue", project, resumeStop: token })).code, "run_stop_stale");
  assert.deepEqual(snapshot(f.store), settled);
  assert.equal(f.sent().length, 2);
  assert.equal(ok<State>(f.engine.execute({ type: "om-state", project })).control.control!.value.stop!.token, second.control!.value.stop!.token);
});

test("H2 rows 4 6 of №1821-2: a start of the existing pass drives it to its saved unable; every later start or continue, from any store, returns it without a payment; an equal intent is the same pass, another is run_intent_conflict; the report counts the measured calls", async t => {
  const f = commandFixture(t, false);
  ok(writeRunBases(f.store, { project }));
  const existing = f.store.get<RunRecord>(runId(project))!;
  f.steps([cannotAnswer(f), cannotAnswer(f), cannotAnswer(f), undecided]);
  const ended = ok<PassOutcome>(await f.engine.execute({ type: "om-start", project, outcomes: ["garden-result"] }));
  assert.equal(ended.end, "unable");
  assert.deepEqual([ended.run!.id, ended.run!.value.intent, ended.run!.value.input], [existing.id, existing.value.intent, existing.value.input],
    "The start kept the identity and the intent of the existing pass");
  assert.equal(f.sent().length, 4);
  const controls = f.store.history(runControlId(project)).length, settled = snapshot(f.store);
  for (const again of [await f.engine.execute({ type: "om-continue", project }), await f.engine.execute({ type: "om-start", project }),
    await f.engine.execute({ type: "om-start", project, outcomes: ["garden-result", "garden-result"] }),
    await elsewhere(f.database, engine => engine.execute({ type: "om-continue", project }))])
    assert.deepEqual([ok<PassOutcome>(again).end, ok<PassOutcome>(again).run], ["unable", ended.run]);
  const conflict = refusal(await f.engine.execute({ type: "om-start", project, outcomes: ["garden-other"] }));
  assert.deepEqual([conflict.code, conflict.at.field], ["run_intent_conflict", "intent.outcomes"]);
  f.restart();
  const state = ok<State>(f.engine.execute({ type: "om-state", project }));
  assert.deepEqual([state.run, state.run!.value.state.phase], [ended.run, "unable"], "The saved unable with its bases is read back");
  const spend = ok<SpendReport>(f.engine.execute({ type: "om-spend", project }));
  assert.deepEqual([spend.totals.calls, spend.totals.measuredCalls, spend.totals.unmeasuredCalls], [4, 4, 0]);
  assert.notEqual(spend.totals.reportedTokens, null);
  assert.deepEqual(spend, ok(spendReport(f.store, { project })));
  assert.deepEqual([snapshot(f.store), f.store.history(runControlId(project)).length, f.sent().length], [settled, controls, 4],
    "The ended pass was only read: no revision, no execution taken, no payment");
});

test("H2 row 6 of №1821-2: a continue through execute drives the pass to its saved complete; every later start or continue, from any store, returns it with its proof and no payment", async t => {
  const f = (await loadOperations()).acceptedOperationsFixture(t, "planned", 0);
  const { store, engine, workspace } = f;
  ok(writeRunBases(store, { project, outcomes: ["garden-result"] }));
  const scenario = join(f.root, "scenario.json"), trace = join(f.root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  engine.execute({ type: "configure", project, expected: 0, environment: { workspace,
    implementer: { actor: "h2-works-producer", model: "fixture", effort: "high", command },
    reviewer: { actor: "h2-works-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 200_000 } });
  writeFileSync(join(workspace, "input.txt"), "A captured external input");
  new Evidence(store).file(project, "garden-data", workspace, "input.txt", "text/plain", 0);
  git(workspace, ["add", "input.txt"]);
  git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "capture input"]);
  const configured = engine.execute({ type: "configure-om-dispatch", project, protocol: "codex-stdio" }) as OmDispatch;
  // The works answer is written for the exact saved packet (as in H1.2), then the command drives the saved step on.
  const cycling = await savedStep(store, { project, dispatch: configured.dispatch }, "cycle");
  const packet = store.get<QuestionPacketRecord>((cycling.request as unknown as { packet: Ref }).packet.id)!;
  const payload = packet.value.packet as unknown as { expansion: { assigned: string[]; obligations: { id: string; kind: string; upper: { port?: string } }[] } };
  const work = structuredClone(f.desired.nodes.find(node => node.id === "garden-consume-work")!);
  const body = { nodes: [work], tests: structuredClone(f.desired.tests.filter(proof => work.tests.includes(proof.id))),
    fills: payload.expansion.obligations.filter(item => payload.expansion.assigned.includes(item.id)).map(item => ({ obligation: item.id, node: work.id,
      ...(item.kind === "connection-end" ? { port: item.upper.port!, codeRef: work.code[0]! } : {}) })),
    localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
    removes: [], replaces: [], redefines: [] };
  writeFileSync(scenario, JSON.stringify({ steps: [{ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", proposal: body, bindings: [] }, usage }] }));
  const sent = () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).length : 0;
  const done = ok<PassOutcome>(await engine.execute({ type: "om-continue", project }));
  assert.deepEqual([done.end, done.refusal, done.run!.value.state.phase], ["complete", null, "complete"]);
  assert.equal((done.run!.value.state as { proof?: Ref[] }).proof?.length, 3, "The saved completion keeps its proof");
  assert.equal(store.get<{ status: string }>(`stage:${project}:compilation`)!.value.status, "accepted", "M9 and the compiler ran");
  assert.equal(sent(), 1);
  const controls = store.history(runControlId(project)).length, settled = snapshot(store);
  for (const again of [await engine.execute({ type: "om-continue", project }), await engine.execute({ type: "om-start", project }),
    await engine.execute({ type: "om-start", project, outcomes: ["garden-result"] }),
    await elsewhere(f.database, other => other.execute({ type: "om-start", project })),
    await elsewhere(f.database, other => other.execute({ type: "om-continue", project }))])
    assert.deepEqual([ok<PassOutcome>(again).end, ok<PassOutcome>(again).run], ["complete", done.run]);
  assert.deepEqual(ok<State>(await elsewhere(f.database, other => other.execute({ type: "om-state", project }))).run, done.run);
  const spend = ok<SpendReport>(engine.execute({ type: "om-spend", project }));
  assert.deepEqual([spend.totals.calls, spend.totals.measuredCalls, spend.totals.unmeasuredCalls], [1, 1, 0]);
  assert.deepEqual([snapshot(store), store.history(runControlId(project)).length, sent()], [settled, controls, 1],
    "The completed pass was only read: no recompilation, no execution taken, no payment");
});

test("H2 row 5 of №1821-2: a continue returns the driver's standing wait once; a repeat and another store get the same pass revision, with no loop and no send", async t => {
  const f = commandFixture(t, false);
  ok(writeRunBases(f.store, { project }));
  f.steps([addressAll(f)]);
  const crashing = class extends Store {
    override writeMany<T = Json>(inputs: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
      const written = super.writeMany<T>(inputs, guards);
      if (inputs.some(write => write.kind === "model-call" && (write.value as { status?: string }).status === "running")) throw new Error("simulated crash after the claim");
      return written;
    }
  };
  f.restart(path => new crashing(path));
  await assert.rejects(f.engine.execute({ type: "om-start", project }) as Promise<unknown>, /simulated crash after the claim/);
  f.restart();
  const waiting = ok<PassOutcome>(await f.engine.execute({ type: "om-continue", project }));
  assert.equal(waiting.end, "waiting");
  for (const again of [await f.engine.execute({ type: "om-continue", project }),
    await elsewhere(f.database, engine => engine.execute({ type: "om-continue", project }))])
    assert.deepEqual([ok<PassOutcome>(again).end, ok<PassOutcome>(again).run], ["waiting", waiting.run], "The standing wait is returned without a revision");
  assert.equal(f.sent().length, 0, "The claimed call never reached the provider and is never resent");
});
