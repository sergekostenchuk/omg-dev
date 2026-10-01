import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import type { OmResult, Refusal } from "../src/om/refusal.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import type { Graph } from "../src/graph/model.js";
import { ProductEngine } from "../src/product/engine.js";
import { git } from "../src/runtime/environment.js";
import { Evidence } from "../src/evidence/evidence.js";
import type { FrameRead, FrameRequest } from "../src/om/frame-obligations.js";
import type { HorizonRecords } from "../src/om/horizon.js";
import type { OmInputRecord } from "../src/om/input.js";
import type { QuestionPacketRecord } from "../src/om/question-packet.js";
import { prepareFrameProposals, type ProposalRequest } from "../src/om/frame-proposals.js";
import { gardenGraph } from "./om-fixture.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";
import { projectGraph } from "../src/graph/project.js";
import { fillObligations, prepareFrame, type FrameScope } from "../src/om/frame-obligations.js";
import { writeCandidate } from "../src/om/frame-candidate.js";
import { settleCandidate } from "../src/om/frame-accept.js";
import type { LayerProposal } from "../src/om/frame-proposals.js";
import type { Node } from "../src/graph/model.js";
import { preparedField } from "./preparation-fixture.js";
import { readOmInput, withHistoricalReads, writeOmInput } from "../src/om/input.js";
import { readHorizon, writeHorizon, writeHorizonIssuance } from "../src/om/horizon.js";
import { readPreparedSeriesTransition, writeSeriesTransition } from "../src/om/series-transition.js";
import { applySeriesActivation, beginAttempt, openSeries, ownerDecisionNamespace, OWNER_DECISION_KIND, readAnySeriesAt, readAppliedSeriesTransition, readCompletionBinding, readCurrentSeriesPointer, readSeriesMembership, resumeSeries, seriesRequestOf } from "../src/om/series.js";
import { recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND } from "../src/om/refusal-journal.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { readRoutes, type RouteBatch, type RoutesRecord } from "../src/om/routes.js";
import { readRouteProducers } from "../src/om/answers-gate.js";
import type { AnyRepairSeries, RepairSeries } from "../src/om/series.js";
import { closeAttempt, openAttempt, prepareManagedClaim } from "../src/om/repeat-gate.js";
import { runModelCycle } from "../src/om/model-call.js";
import { writeQuestionPacket } from "../src/om/question-packet.js";
import { runStopAnalysis } from "../src/om/stop-analysis.js";
import { gapLineExpectedResult, gapLineKey } from "../src/om/gap-lines.js";
import { advanceRun, readRun, startRun, runId, type RunRequest, type RunRecord, type RunStep, type RunWait, type RunReason } from "../src/om/run.js";
import { prepareRunBases, writeRunBases, type RunBases } from "../src/om/run-bases.js";

const project = "garden";
const adapterFixture = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`Unexpected refusal: ${result.refusal.code}: ${result.refusal.message} ${JSON.stringify(result.refusal.at)}`);
  return result.value;
}
function refusal<T>(result: OmResult<T>): Refusal { if (result.ok) assert.fail("Expected a refusal"); return result.refusal; }

/**
 * A real OM project up to its first bases: prepared stages with two open addressing questions, refined layers,
 * an environment whose implementer is the scripted adapter, B1 with every other design decision addressed, an
 * accepted horizon, D1, M6 and the owner's M3 queue.
 */
function runFixture(t: test.TestContext, questions = ["encoding", "spare"], refine = true, addressed: boolean | string[] = false, later = false, cold = false,
  unknowns: Readonly<Record<string, { consumer?: string; moment?: string }>> = {}) {
  const root = mkdtempSync(join(tmpdir(), "omg-h1-run-")), database = join(root, "state.sqlite"), workspace = join(root, "repo");
  mkdirSync(workspace); git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "H1 pass repository\n");
  writeFileSync(join(workspace, "h1-source.txt"), "UTF-8 is the supported encoding.\n");
  git(workspace, ["add", "README.md", "h1-source.txt"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  // The later variant is the L1 map of om-series-current: an independent requirement the later block implements.
  const { level: _level, ...upperMap } = projectGraph(gardenGraph(), 1);
  const graphData = later ? upperMap as Graph : gardenGraph();
  if (later) {
    graphData.requirements!.push({ ...structuredClone(graphData.requirements![0]!), id: "garden-R2", outcome: "garden-later", statement: "Deliver the later result" });
    graphData.nodes.find(node => node.id === "garden-later-block")!.implements!.push("garden-R2");
  }
  preparedFeatures(engine, project, graphData, field => {
    const value = preparedField(project, field);
    if (field === "preparation" && questions.length) (value as Record<string, Json>).unknowns = questions.map(id => ({ id,
      question: `Which ${id} is supported?`, consumer: unknowns[id]?.consumer ?? "garden-consume-block", moment: unknowns[id]?.moment ?? "om-pass", blocksCurrentStage: false,
      resolution: "Address this question during OM" }));
    // An independent later feature (as in om-series-current), so a block can be lawfully excluded from a horizon.
    if (later && field === "preparation") {
      const rows = (value as Record<string, Json>).outcomes as Record<string, Json>[];
      rows.push({ ...structuredClone(rows[0]!), id: "garden-later", result: "The later result" });
    }
    if (later && field === "conceptSections") {
      const rows = (value as unknown as { requirements: Record<string, Json>[] }[])[0]!.requirements;
      rows.push({ ...structuredClone(rows[0]!), id: "garden-R2", outcome: "garden-later", statement: "Deliver the later result" });
    }
    if (later && field === "operationRequirements") {
      const body = value as Record<string, Json>, rows = body.outcomes as Record<string, Json>[];
      rows.push({ ...structuredClone(rows[0]!), outcome: "garden-later" });
      (body.conceptCoverage as Json[]).push({ requirement: "garden-R2", outcome: "garden-later" });
    }
    if (later && field === "behaviorContracts") {
      const rows = value as unknown as Record<string, Json>[];
      rows.push({ ...structuredClone(rows[0]!), id: "garden-B2", requirements: ["garden-R2"], outcome: "garden-later" });
    }
    if (later && (field === "features" || field === "featurePreparation")) {
      const rows = value as unknown as Record<string, Json>[];
      rows.push({ ...structuredClone(rows[0]!), [field === "features" ? "title" : "featureTitle"]: "Deliver later result", outcome: "garden-later",
        ...(field === "featurePreparation" ? { requirements: ["garden-R2"], behaviorContracts: ["garden-B2"] } : {}) });
    }
    return value;
  });
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const environment = (amount = 100_000) => engine.environments.configure(project, { workspace,
    implementer: { actor: "run-implementer", model: "fixture", effort: "high", speed: "fast", command },
    reviewer: { actor: "run-reviewer", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: amount },
  store.get(`environment:${project}`)?.revision ?? 0);
  const configured = environment();
  if (refine) refinedLayers(engine, project);
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const graph = reference(store.get(`graph:${project}`)!);
  // A cold project has no OM record at all: its first B1 is written by the machine bases (H1.1).
  const input = cold ? null : fixtureInput();
  function fixtureInput() {
  const base = ok(writeOmInput(store, { project, expected: 0, stages }));
  const decisions = base.value.gaps.filter(gap => gap.code !== "inventory_missing" && gap.code !== "question_unaddressed").map(gap => {
    const field = gap.code === "contract_node_unbound" ? "nodes" : gap.code === "acceptance_kind_missing" ? "checkKind" : "state";
    const value: Json = field === "nodes" ? ["garden-produce-block", "garden-consume-block"] : field === "checkKind" ? "test"
      : { writer: "garden-produce-block", authority: "garden-user", rollback: "garden-produce-block" };
    return { pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph, layers: [],
      decision: { target: gap.target, field, value } })) as Write };
  });
  // Questions the owner already addressed in B1 (no M5 is needed for them).
  for (const id of addressed === true ? questions : addressed || []) decisions.push({ pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph, layers: [],
    decision: { target: `discovery:${id}`, field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write });
  return decisions.length ? ok(writeAddressing(store, { project, input: reference(base), graph, decisions })) : base;
  }
  const adapter = store.write({ id: `adapter:${project}:run`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  /**
   * The pass's own bases for today's B1 (H1.1): the common machine producer builds or finds them and, on the first call,
   * the pass with its launch intent. The arguments of the earlier owner-issued bases stay accepted and are ignored.
   */
  function bases(_choiceVersion?: string, _works = false): RunBases {
    return ok(writeRunBases(store, { project })).bases as RunBases;
  }
  /** The owner's B3 transition over the current roots: P and G2 on a horizon of this choice, then its application. */
  function activate(choiceVersion: string, choice: { features: { outcome: string }[]; excluded: { block: string; reason: string; returnCondition: string }[] }) {
    const horizon = ok(writeHorizon(store, { project, input: reference(store.get(`om-input:${project}`)!), graph,
      refinement: null, available: {}, choice: { choiceVersion, ...choice } }));
    assert.equal(horizon.gate.value.state, "accepted", JSON.stringify(horizon.gate.value));
    const roots = store.list<RepairSeries>("repair-series").filter(row => "block" in row.value)
      .filter(row => !store.list<RepairSeries>("repair-series").some(other => other.value.predecessor?.id === row.id)).map(reference);
    const prepared = ok(writeSeriesTransition(store, { project, choiceVersion, horizon: reference(horizon.gate), series: roots }));
    const issuance = ok(writeHorizonIssuance(store, { project, choiceVersion, horizon: reference(horizon.gate), transition: reference(prepared) }));
    return ok(applySeriesActivation(store, { project, prepared: reference(prepared), issuance: reference(issuance) }));
  }
  /** A pass is advanced by its project and dispatch contract; the bases argument of the earlier fixture is ignored. */
  const request = (_bases?: unknown): RunRequest => ({ project,
    dispatch: { adapter: reference(adapter), config: reference(store.get(`environment:${project}`)!) } });
  return { root, database, input, graph, configured, environment, bases, request, activate,
    get store() { return store; }, get engine() { return engine; },
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ steps })); },
    sent(): unknown[] { return existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) : []; },
    restart(make: (path: string) => Store = path => new Store(path)) { store.close(); store = make(database); engine = new ProductEngine(store); } };
}
type Fixture = ReturnType<typeof runFixture>;
/** An M5 answer addressing every item of its batch. */
function addressAll(f: Fixture, routes: Ref, kind = "repository-fact") {
  const saved = f.store.get<RoutesRecord>(routes.id, routes.revision)!.value;
  const batch = saved.batches.find(item => item.model === "MC2" && item.task === "input-field" && item.items.every(row => row.consumers.length === 0))!;
  return { research: { protocol: "omg-answer/v2", requestId: "$requestId", action: "answer",
    results: batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: { consumer: "garden-consume-block", kind } })) } };
}
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
/** An MC1 answer to every fact of the block's batch, cited from the project brief. */
function factsAll(f: Fixture, routes: Ref, value: unknown = { answer: "UTF-8" }) {
  const saved = f.store.get<RoutesRecord>(routes.id, routes.revision)!.value;
  const batch = saved.batches.find(item => item.model === "MC1" && item.task === "fact")!;
  const source = f.store.get<{ content: string }>(`source:${project}:brief`)!;
  return { research: { protocol: "omg-answer/v2", requestId: "$requestId", action: "answer",
    results: batch.items.map(item => ({ questionId: item.gap, value, citations: [{ source: reference(source),
      selector: { kind: "text-range", start: 0, end: source.value.content.length } }] })) }, usage };
}
type Verdict = "supported" | "insufficient" | "conflicting" | "off-form" | "interrupted";
function assessor(verdict: Verdict) {
  if (verdict === "off-form") return { research: { answer: "untyped reviewer reply" }, usage };
  if (verdict === "interrupted") return { rawStdout: "{broken", exitCode: 7, stderr: "intentional assessor failure" };
  return { research: { verdict, reasons: verdict === "supported" ? [] : ["source does not settle this fact"] }, usage };
}
const refOf = (record: { id: string; revision: number; hash: string }): Ref => ({ id: record.id, revision: record.revision, hash: record.hash });
/** The one M5 mechanism line of the project. */
const mechanismSeries = (f: Fixture) => f.store.list<AnyRepairSeries>("repair-series").find(row => "owner" in row.value)!;
/** The current line of the consuming block, read by its owner rather than by a guessed id. */
const blockSeries = (f: Fixture, block = "garden-consume-block") =>
  f.store.list<RepairSeries>("repair-series").find(row => (row.value as { block?: string }).block === block)!;
/** Every action the pass performed with a product, in order, from its own record history. */
const actions = (store: Store) => store.history(runId(project)).flatMap(row => {
  const last = (row.value as unknown as RunRecord).last, previous = store.get<RunRecord>(runId(project), row.revision - 1)?.value.last;
  return last && last.refusal === null && JSON.stringify(last) !== JSON.stringify(previous) ? [last.step.action] : [];
});
/** Every performed step of the pass with a product, in order, from its own record history. */
const actionsSteps = (store: Store): RunStep[] => store.history(runId(project)).flatMap(row => {
  const last = (row.value as unknown as RunRecord).last, previous = store.get<RunRecord>(runId(project), row.revision - 1)?.value.last;
  return last && last.refusal === null && JSON.stringify(last) !== JSON.stringify(previous) ? [last.step as RunStep] : [];
});
/**
 * Advances the pass until it waits or ends (complete or unable), recording every performed action; a bound stops an
 * accidental loop. With `until` it also stops right after that action was performed (№1995 п.11).
 */
async function ends(f: Fixture, request: RunRequest, bound = 30, until?: string) {
  const performed: string[] = [];
  for (let index = 0; index < bound; index++) {
    const advanced = ok(await advanceRun(f.store, request));
    if (advanced.performed) performed.push(advanced.performed.action);
    const state = advanced.record.value.state;
    if (["waiting", "complete", "unable"].includes(state.phase) || until !== undefined && advanced.performed?.action === until) return { performed, state, record: advanced.record };
  }
  assert.fail(`The pass neither waited nor ended within ${bound} transitions: ${performed.join(",")}`);
}
/**
 * After the M5 result the pass builds the new B1's bases itself and goes on with block work (H1.1): a mechanism test stops
 * there. A wait is reported, a pass that ended before the action fails the test.
 */
async function driveTo(f: Fixture, request: RunRequest, action: string, bound = 30) {
  const end = await ends(f, request, bound, action);
  if (end.state.phase === "complete" || end.state.phase === "unable") assert.fail(`The pass ended (${end.state.phase}) before ${action}: ${end.performed.join(",")}`);
  return { performed: end.performed, wait: end.state.phase === "waiting" ? end.state.wait as RunWait : null };
}
/** Advances the pass until it waits, recording every performed action; a pass that ended instead fails the test. */
async function drive(f: Fixture, request: RunRequest, bound = 30) {
  const end = await ends(f, request, bound);
  if (end.state.phase !== "waiting") assert.fail(`The pass reached ${end.state.phase}, not a wait: ${JSON.stringify(end.state)}`);
  return { performed: end.performed, wait: end.state.wait, record: end.record };
}
/** The grounds of an unable pass in their saved order; any other state fails the test. */
function reasonsOf(state: { readonly phase: string }): readonly RunReason[] {
  if (state.phase !== "unable") assert.fail(`The pass is ${state.phase}, not unable: ${JSON.stringify(state)}`);
  return (state as unknown as { reasons: readonly RunReason[] }).reasons;
}

test("26 1 C07 R4 H1.1 the pass runs the project mechanism M5 through G7, then builds the bases of the new B1 itself and goes on; a restart repeats nothing", async t => {
  const f = runFixture(t);
  const b = f.bases(), request = f.request();
  f.steps([addressAll(f, b.routes)]);
  const started = ok(startRun(f.store, { project }));
  assert.deepEqual(started.value.input, reference(f.store.get(`om-input:${project}`)!));
  // The fact of the addressed questions is the next block work: the pass reaches it without any issued bases.
  let working: RunStep | null = null;
  for (let index = 0; index < 20 && !working; index++) {
    const state = ok(await advanceRun(f.store, request)).record.value.state;
    if (state.phase === "waiting") assert.fail(JSON.stringify(state.wait));
    if (state.phase === "step" && state.step.action === "open-series" && (state.step.request as { block?: string }).block) working = state.step as unknown as RunStep;
  }
  assert.ok(working, "The pass chose the block's own work");
  assert.deepEqual(actions(f.store), ["open-series", "open", "packet", "cycle", "close", "bases"]);
  const series = f.store.list<RepairSeries>("repair-series").find(row => row.id.includes(":mechanism:"))!;
  const outcome = series.value.attempts[0]!.outcome!;
  assert.equal(outcome.reason, "result");
  assert.equal(outcome.achieved.length, 2);
  // The saved build names the new B1 of D3; its horizon is a new issue of the same intent over that B1.
  const input = f.store.get(`om-input:${project}`)!;
  assert.equal(input.revision, started.value.input.revision + 1, "D3 of M5 made the new B1");
  const built = ok(prepareRunBases(f.store, { project }));
  assert.equal(built.state, "ready");
  if (built.state !== "ready") return;
  assert.deepEqual(built.built.input, reference(input));
  assert.notDeepEqual(built.built.bases.horizon, b.horizon);
  assert.deepEqual((working.request as { block?: string }).block, "garden-consume-block");
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  // The saved step goes on after the restart; neither M5 nor the build is paid or written again.
  const again = ok(await advanceRun(f.store, { ...request, dispatch: { ...request.dispatch } }));
  assert.deepEqual(again.performed, working);
  assert.equal(f.sent().length, sends);
  assert.equal(actions(f.store).filter(action => action === "bases").length, 1);
  assert.ok(f.store.list().map(reference).length > before.length);
  assert.deepEqual(ok(startRun(f.store, { project })).value.input, started.value.input, "A repeated start reads the one pass");
});

test("3 8 25 C23 C17 C27 R5 H1.1 on its own new bases the pass works the block through MC1, E5 and G4b to one G7 close, then applies the accepted facts", async t => {
  const f = runFixture(t);
  const { m5, second, request } = await blockBases(f);
  f.steps([m5, factsAll(f, second.routes), assessor("supported"), assessor("supported")]);
  const driven = await drive(f, request, 40);
  assert.deepEqual(driven.performed, ["open-series", "open", "register", "packet", "cycle", "assess", "assess", "routes", "evaluate", "close",
    "apply", "bases", "apply", "bases"], JSON.stringify(driven.wait));
  const series = blockSeries(f);
  const outcome = series.value.attempts[0]!.outcome!;
  assert.equal(outcome.reason, "result");
  assert.equal(driven.wait.code, "run_idle");
  assert.equal(f.sent().length, 4, "Every paid call was made once; a new B1 never calls MC1 again");
  // №1860-4: the machine task's result form {answer} runs D5 → MC1 → E5 → the applied B1, read back from the saved input.
  const input = ok(readOmInput(f.store, project, reference(f.store.get(`om-input:${project}`)!)));
  assert.deepEqual(input.value.input.facts!.map(fact => [fact.question.id, fact.value]).sort(),
    [["discovery:encoding", { answer: "UTF-8" }], ["discovery:spare", { answer: "UTF-8" }]]);
  assert.deepEqual(input.value.input.questions, [], "An applied fact leaves the open questions");
  assert.deepEqual(driven.wait.basis[0], reference(f.store.get(`om-input:${project}`)!), "The idle pass names the bases it stands on");
});

/** The block's first bases after M5 of one question: the pass has closed M5 and stands on the owner's new chain. */
/** M5 through G7 and the pass's own build of the new B1's bases (H1.1): the block work comes next on those bases. */
async function blockBases(f: Fixture) {
  const first = f.bases(), m5 = addressAll(f, first.routes);
  f.steps([m5]);
  ok(startRun(f.store, { project }));
  const request = f.request();
  for (let index = 0; index < 20 && !actions(f.store).includes("bases"); index++) ok(await advanceRun(f.store, request));
  assert.ok(actions(f.store).includes("bases"), "The pass built the bases of the new B1 itself");
  return { m5, second: f.bases(), request };
}
const stopAnswer = (f: Fixture, decided: boolean) => ({ research: { protocol: "omg-stop-analysis/v1",
  cause: { kind: "hypothesis", text: "The brief does not settle the encoding", sources: [] },
  change: decided ? { text: "Name the encoding in the environment", addresses: [{ ref: reference(f.store.get(`environment:${project}`)!), field: "implementer" }] } : null,
  origin: null }, usage });

/** An M5 answer that addresses nothing: the attempt ends refused, without progress. */
function cannotAnswer(f: Fixture, routes: Ref) {
  const saved = f.store.get<RoutesRecord>(routes.id, routes.revision)!.value;
  const batch = saved.batches.find(item => item.model === "MC2" && item.task === "input-field" && item.items.every(row => row.consumers.length === 0))!;
  return { research: { protocol: "omg-answer/v2", requestId: "$requestId", questionIds: batch.items.map(item => item.gap),
    action: "cannot_answer", reason: "The requested information is unavailable" }, usage };
}

/** Everything but the Environment records: what an unchanged terminal must leave exactly as it is. */
const untouched = (store: Store) => store.list().map(reference).filter(ref => !ref.id.startsWith("environment:") && !ref.id.startsWith("workspace:"));

test("H1.2 R1 R3 R4 R10 17 19 20 C33 three attempts without progress stop the M5 series; A6 reviews the exact stop once, an undecided review ends the pass on the second rung, and nothing is written or paid again", async t => {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("h1-first"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, false), addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const attempt = ["open", "packet", "cycle", "close"];
  // R1: a stop of the first rung not yet reviewed is no ground: the one A6 of that exact stop is performed first.
  const reviewed = await driveTo(f, request, "analyze", 40);
  assert.deepEqual(reviewed.performed, ["open-series", ...attempt, ...attempt, ...attempt, "analyze"]);
  const series = mechanismSeries(f);
  assert.deepEqual(series.value.attempts.map(row => row.outcome?.reason), ["refused", "refused", "refused"]);
  assert.ok(series.value.stop, "A3 set the stop; the pass counts nothing itself");
  assert.equal(series.value.escalations.length, 1, "The undecided review escalated the stop atomically (A6)");
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "ready", "Nothing ended before the review's own result was read");
  const sends = f.sent().length;
  assert.equal(sends, 4, "Three attempts and the one review");
  // R3/R4: the saved review and the escalation are the ground; no further call is made and no decision is required or made.
  const end = await ends(f, request, 5);
  assert.deepEqual(end.performed, []);
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), [["stop-second-rung", "owner_decision", series.id, "stop"]]);
  assert.match(reasons[0]!.message, /attempt 3/);
  assert.equal(reasons[0]!.basis.length, 2);
  assert.ok(reasons[0]!.basis.some(ref => ref.id === series.id && ref.revision === series.revision), "The exact stopped line");
  assert.ok(reasons[0]!.basis.some(ref => ref.hash === series.value.escalations[0]!.review.hash), "The exact review of this stop");
  assert.equal(f.store.list().filter(row => row.id.startsWith(ownerDecisionNamespace(project))).length, 0);
  assert.equal(f.sent().length, sends);
  // R10: the saved end comes back from advance, start, a new store and a changed Environment; nothing is written or paid.
  const saved = ok(readRun(f.store, { project }))!, before = untouched(f.store);
  f.restart();
  assert.deepEqual(ok(await advanceRun(f.store, request)).record, saved);
  f.environment();
  const changed = ok(await advanceRun(f.store, f.request()));
  assert.deepEqual([changed.performed, changed.products, changed.record], [null, [], saved]);
  assert.deepEqual(ok(startRun(f.store, { project })), saved);
  assert.equal(refusal(startRun(f.store, { project, outcomes: ["another-outcome"] })).code, "run_intent_conflict", "A pass never changes its intent");
  // R10a: the direct entries of the builder read the saved end before any product of the chain: no base, no write.
  for (const refused of [refusal(prepareRunBases(f.store, { project })), refusal(writeRunBases(f.store, { project })),
    refusal(writeRunBases(f.store, { project, outcomes: saved.value.intent.outcomes as string[] }))]) {
    assert.deepEqual([refused.code, refused.at.target, refused.at.field, refused.at.ref], ["run_bases_terminal", runId(project), "state.phase", reference(saved)]);
    assert.match(refused.message, /unable/);
  }
  assert.equal(refusal(writeRunBases(f.store, { project, outcomes: ["another-outcome"] })).code, "run_intent_conflict", "The intent conflict is judged first");
  assert.deepEqual(untouched(f.store), before);
  assert.equal(f.sent().length, sends);
});

/**
 * A line of the consuming block stopped by A3 through the real producers: three attempts of the earlier mode, each closed by
 * G7 with a result that accepts nothing, move nothing. (The pass's own block attempts reach the same stop; that route
 * re-reads the whole refusal journal for every later packet, which costs minutes in the shared readers and adds nothing
 * to this row.)
 */
function stoppedBlockLine(f: Fixture, block = "garden-consume-block") {
  const address = { project, block, line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h12-stopped", predecessor: null, basis: null }));
  const goal = { key: "h12-stopped-goal", questions: ["Address one contract"], result: "A supported contract" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    ok(beginAttempt(f.store, { ...address, attempt, goal }));
    ok(closeAttempt(f.store, { ...address, attempt, outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } }));
  }
  return blockSeries(f, block);
}

test("H1.2 R4 R1 a block line stopped by three fruitless attempts: the one review is undecided and the second rung ends the pass on the block's exact stop", async t => {
  const f = runFixture(t, ["encoding"], true, true);
  const stopped = stoppedBlockLine(f);
  assert.ok(stopped.value.stop, "A3 stopped the line");
  assert.equal(stopped.value.escalations.length, 0, "Nothing reviewed it yet");
  const request = f.request(f.bases("h12-block-stop"));
  f.steps([stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 30);
  const series = blockSeries(f);
  assert.deepEqual(series.value.attempts.map(row => row.outcome?.reason), ["result", "result", "result"]);
  assert.equal(end.performed.filter(action => action === "analyze").length, 1, "The one review of the exact stop");
  assert.equal(end.performed.includes("open") || end.performed.includes("open-series"), false, "The stopped line opens no attempt");
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), [["stop-second-rung", "owner_decision", series.id, "stop"]]);
  assert.equal(series.value.escalations.length, 1, "The undecided review escalated the stop atomically (A6)");
  assert.ok(reasons[0]!.basis.some(ref => ref.hash === series.value.escalations[0]!.review.hash), "The review of this very stop");
  assert.equal(f.store.list().filter(row => row.id.startsWith(ownerDecisionNamespace(project))).length, 0, "No decision of the owner is required or made");
  const sends = f.sent().length;
  assert.equal(sends, 1, "Only the one review was paid");
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
  assert.equal(f.sent().length, sends);
});

test("H1.2 R8 R4 C31 a stopped line whose owner has no batch today keeps its barrier: its reviewed stop on the second rung ends the pass, and nothing is paid for that owner", async t => {
  const f = runFixture(t, []);
  const stopped = stoppedBlockLine(f);
  const request = f.request(f.bases("h12-idle"));
  f.steps([stopAnswer(f, false)]);
  // The one review of this exact stop is the earlier mode's own A6 (an operator act through the same producer); the second rung is what it leaves.
  const review = ok(await runStopAnalysis(f.store, { project, series: reference(stopped), hold: null, dispatch: request.dispatch }));
  assert.equal(review.value.state, "undecided");
  const series = blockSeries(f);
  assert.equal(series.value.escalations.length, 1);
  const sends = f.sent().length;
  assert.equal(sends, 1);
  // No question is open, so no route reaches the block: the old absence of a batch must not erase its stop.
  assert.deepEqual(f.store.list<RoutesRecord>("route-result").flatMap(row => row.value.batches.filter(batch => batch.items.length)), []);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 20);
  assert.deepEqual(reasonsOf(end.state).map(row => [row.kind, row.code, row.target, row.field]), [["stop-second-rung", "owner_decision", series.id, "stop"]]);
  assert.deepEqual(end.performed.filter(action => action !== "bases"), [], "The idle owner is asked for nothing: only the pass's own bases were built");
  assert.equal(f.sent().length, sends, "Nothing was paid for the owner that has no work");
  assert.notEqual(end.state.phase, "complete", "A proved barrier forbids the completion of the pass");
});

test("H1.2 R8 C31 №2045-1 a stopped line of a block outside the horizon of the launch intent stops nothing; of two stopped lines only the one inside the horizon is a ground", async t => {
  // Outside: the intent names garden-result, so the later block is no node of the horizon the pass derived.
  const f = runFixture(t, []);
  const stopped = stoppedBlockLine(f, "garden-later-block");
  ok(startRun(f.store, { project, outcomes: ["garden-result"] }));
  const request = f.request(), horizon = f.bases().horizon;
  assert.deepEqual(ok(readHorizon(f.store, project, horizon)).horizon.value.result.horizon.nodes, ["garden-consume-block", "garden-produce-block"]);
  f.steps([stopAnswer(f, false)]);
  const review = ok(await runStopAnalysis(f.store, { project, series: reference(stopped), hold: null, dispatch: request.dispatch }));
  assert.equal(review.value.state, "undecided");
  f.restart();
  const outside = await ends(f, request, 30);
  assert.notEqual(outside.state.phase, "unable", "The finished history of a block the intent never asked for is another subject's: " + JSON.stringify(outside.state));
  assert.equal(f.sent().length, 1, "Only the operator's review was paid");
  // Both: the same kind of stop on a block of the horizon is the pass's ground, and only it is named.
  const g = runFixture(t, []);
  const foreign = stoppedBlockLine(g, "garden-later-block"), own = stoppedBlockLine(g, "garden-produce-block");
  ok(startRun(g.store, { project, outcomes: ["garden-result"] }));
  const asked = g.request();
  g.bases();
  g.steps([stopAnswer(g, false), stopAnswer(g, false)]);
  for (const line of [foreign, own]) ok(await runStopAnalysis(g.store, { project, series: reference(line), hold: null, dispatch: asked.dispatch }));
  g.restart();
  const inside = await ends(g, asked, 30);
  assert.deepEqual(reasonsOf(inside.state).map(row => [row.kind, row.code, row.target, row.field]),
    [["stop-second-rung", "owner_decision", own.id, "stop"]], "The stop of the block outside the horizon is not among the grounds");
  assert.equal(g.sent().length, 2);
});

test("H1.2 R5 a failed review of the stop ends the pass on that very record: a restart pays no second review", async t => {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("h1-failed"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, { rawStdout: "{broken", exitCode: 7, stderr: "intentional reviewer failure" }, addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const attempt = ["open", "packet", "cycle", "close"];
  const reviewed = await driveTo(f, request, "analyze", 40);
  assert.deepEqual(reviewed.performed, ["open-series", ...attempt, ...attempt, ...attempt, "analyze"]);
  const failure = f.store.list().find(row => row.kind === "om-stop-analysis-failure")!;
  assert.ok(failure, "The failed review is a record of its own");
  const sends = f.sent().length, series = mechanismSeries(f);
  const end = await ends(f, request, 5);
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), [["stop-analysis-failed", "analysis_failed", series.id, "stop"]]);
  assert.ok(reasons[0]!.basis.some(ref => ref.id === failure.id && ref.hash === failure.hash), "The Ref of exactly this review");
  assert.equal(series.value.escalations.length, 0, "A failed review escalates nothing and opens no door of its own");
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
  assert.equal(f.sent().length, sends, "A restart does not pay the review again");
  assert.equal(f.store.list().filter(row => row.kind === "om-stop-analysis-failure").length, 1);
});

test("H1.2 R9 R5a a live reviewer keeps the pass waiting; once its loss is proved by the common recovery the failed review ends the pass, and nothing is sent twice", async t => {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("h1-a6-lost"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const analyzing = await until(f, request, "analyze", 50);
  const release = await heldAfterClaim(t, f, analyzing);
  const held = ok(await advanceRun(f.store, request)), sends = f.sent().length;
  const wait = (held.record.value.state as { wait?: { code: string } }).wait;
  assert.equal(held.record.value.state.phase, "waiting", "A live executor is not a ground of the end");
  assert.equal(wait?.code, "model_call_still_running");
  await release();
  // R5a: the loss is proved by the common recovery and the same saved review goes on to its failed record.
  const resumed = ok(await advanceRun(f.store, request));
  assert.deepEqual(resumed.performed, analyzing, "The exact saved A6 step");
  assert.ok(f.store.list().some(row => row.kind === "om-stop-analysis-failure"));
  const end = await ends(f, request, 5), series = mechanismSeries(f);
  assert.deepEqual(reasonsOf(end.state).map(row => [row.kind, row.code, row.target]), [["stop-analysis-failed", "analysis_failed", series.id]]);
  assert.equal(f.sent().length, sends, "Nothing is sent again and no second intent exists");
  assert.equal(f.store.list().filter(row => row.kind === "om-analysis-intent").length, 1);
});

test("H1.2 R5b a review that cannot even be prepared for its saved request ends the pass on that refusal: no failed record, no transport, no new dispatch", async t => {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("h1-a6-unavailable"), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  let request = f.request(b);
  for (let closes = 0; closes < 3;) {
    const advanced = ok(await advanceRun(f.store, request));
    if (advanced.performed?.action === "close") closes += 1;
  }
  // The environment now offers a request capacity no reviewer request can fit; the review is chosen with that dispatch.
  f.environment(1);
  request = f.request(b);
  const waiting = await ends(f, request, 6);
  assert.equal(waiting.state.phase, "waiting");
  assert.equal((waiting.state as unknown as { wait: RunWait }).wait.code, "context_too_large");
  const sends = f.sent().length, before = f.store.list().length, moved = ok(readRun(f.store, { project }))!.revision;
  const end = await ends(f, request, 3), series = mechanismSeries(f);
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code]), [["analysis-unavailable", "context_too_large"]]);
  assert.ok(reasons[0]!.basis.some(ref => ref.id === series.id), "The line it stands on");
  assert.ok(reasons[0]!.basis.some(ref => ref.id === request.dispatch.config.id && ref.hash === request.dispatch.config.hash), "The exact dispatch of the saved request");
  assert.equal(f.sent().length, sends, "No transport exists for a review that was never prepared");
  assert.equal(f.store.list("om-stop-analysis-failure").length, 0);
  assert.equal(f.store.list().length, before, "No record was added");
  assert.equal(ok(readRun(f.store, { project }))!.revision, moved + 1, "Only the pass record moved, once");
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
});

/** Reaches the second rung of the M5 line: three refused attempts, the one undecided review, nothing ended yet. */
async function secondRung(t: test.TestContext) {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("h12-window"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, false), addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  await driveTo(f, request, "analyze", 40);
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "ready");
  return { f, request };
}

test("H1.2 R10a a second store ending the pass between the builder's derivation and its first write: the lost write reads the pass again and builds no base", async t => {
  const f = runFixture(t);
  const b = f.bases(), request = f.request();
  f.steps([addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  await driveUntil(f, request, state => state.phase === "step" && state.step.action === "bases");
  const d1 = gapHeads(f.store), horizons = f.store.list("om-horizon").length;
  let raced = false;
  class Ending extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-horizon")) {
        raced = true;
        const other = new Store(f.database);
        try {
          const head = other.get<RunRecord>(runId(project))!, input = other.get(`om-input:${project}`)!;
          other.write({ id: head.id, kind: head.kind, expected: head.revision, value: { ...head.value, state: { phase: "unable", reasons: [
            { kind: "stop-second-rung", code: "owner_decision", message: "Ended by another store", target: "repair-series:h12", field: "stop", basis: [reference(input)] }] } } as unknown as Json });
        } finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new Ending(path));
  const advanced = await advanceRun(f.store, request);
  assert.ok(raced);
  assert.equal(refusal(advanced).code, "revision_conflict", "The pass moved under the saved step: its outcome is not written over the other store's end");
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "unable");
  assert.deepEqual(gapHeads(f.store), d1, "The lost build moved no D1 head");
  assert.equal(f.store.list("om-horizon").length, horizons);
  assert.equal(refusal(writeRunBases(f.store, { project })).code, "run_bases_terminal");
});

test("H1.2 R11 an end derived on a stop that another store lawfully continues before the write is not saved: the next choice reads the new ladder", async t => {
  const { f, request } = await secondRung(t);
  let raced = false;
  class Continuing extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-run" && (write.value as { state?: { phase?: string } }).state?.phase === "unable")) {
        raced = true;
        const other = new Store(f.database);
        try {
          const stopped = other.list<AnyRepairSeries>("repair-series").find(row => "owner" in row.value)!, stop = stopped.value.stop!;
          const decision = other.write({ id: `${ownerDecisionNamespace(project)}h12-window`, kind: OWNER_DECISION_KIND, expected: 0,
            value: { projectId: project, owner: { kind: "mechanism", mechanism: "M5:addressing" }, stop: stop.attempt, goals: [...stop.goals],
              decided: "go on: one more window", taken: { by: "the owner", through: "the command API", approved: true } } });
          ok(resumeSeries(other, { ...seriesRequestOf(stopped.value), stop: stop.attempt, ground: "owner-decision",
            text: "the owner decided to go on", decision: { ref: reference(decision) } } as never));
        } finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new Continuing(path));
  const lost = await advanceRun(f.store, request);
  assert.ok(raced);
  assert.equal(refusal(lost).code, "input_stale", "The line moved under the derivation: the stale end is not saved");
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "ready");
  f.restart();
  const window = await driveTo(f, request, "bases", 20);
  assert.deepEqual(window.performed, ["open", "packet", "cycle", "close", "bases"], JSON.stringify(window.wait));
  assert.notEqual(ok(readRun(f.store, { project }))!.value.state.phase, "unable", "The next choice read the ladder as it stands now");
});

test("H1.2 R11 C11 an end derived on bases that another store lawfully renews before the write is not saved: the next choice starts from the new B1", async t => {
  const { f, request } = await secondRung(t);
  let raced = false;
  class Renewing extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-run" && (write.value as { state?: { phase?: string } }).state?.phase === "unable")) {
        raced = true;
        const other = new Store(f.database);
        try {
          // The owner addresses the open question to the block: a lawful new B1 while the end was being derived.
          const input = other.get<OmInputRecord>(`om-input:${project}`)!;
          ok(writeAddressing(other, { project, input: reference(input), graph: f.graph, decisions: [{ pending: structuredClone(inputDecisionWrite({
            project, input: reference(input), graph: f.graph, layers: [], decision: { target: "discovery:encoding", field: "address",
              value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write }] }));
        } finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new Renewing(path));
  const sends = f.sent().length;
  const lost = await advanceRun(f.store, request);
  assert.ok(raced);
  assert.equal(refusal(lost).code, "input_stale", "The B1 moved under the derivation: the stale end is not saved");
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "ready");
  f.restart();
  const next = ok(await advanceRun(f.store, request)).record.value.state;
  assert.equal(next.phase === "step" && next.step.action, "bases", "The next choice builds the bases of the renewed B1 before any end");
  assert.equal(f.sent().length, sends);
});

test("H1.2 R11 two stores deriving the same end: one write wins, the other reads the winner's pass, and the grounds are the same", async t => {
  const { f, request } = await secondRung(t);
  let raced = false;
  class Losing extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-run" && (write.value as { state?: { phase?: string } }).state?.phase === "unable")) {
        raced = true;
        const other = new Store(f.database);
        try { void advanceRun(other, request); } finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new Losing(path));
  const lost = await advanceRun(f.store, request);
  assert.ok(raced);
  assert.equal(refusal(lost).code, "revision_conflict");
  const winner = ok(readRun(f.store, { project }))!;
  assert.equal(winner.value.state.phase, "unable");
  f.restart();
  const same = ok(await advanceRun(f.store, request));
  assert.deepEqual(same.record, winner, "The loser converges to the one saved end");
  assert.equal(f.store.history(runId(project)).filter(row => (row.value as unknown as RunRecord).state.phase === "unable").length, 1);
  assert.equal(reasonsOf(winner.value.state).length, 1);
});

test("H1.2 R7 R7a R8 6 C54 M5 asks the owner while the independent block is worked to its end; only then does the pass end, on the goal that stays open, and its grounds keep the canonical order", async t => {
  const f = runFixture(t, ["encoding", "spare"], true, ["encoding"]);
  const b = f.bases("h12-independent"), request = f.request(b);
  const saved = f.store.get<RoutesRecord>(b.routes.id, b.routes.revision)!.value;
  const m5 = saved.batches.find(item => item.model === "MC2" && item.task === "input-field")!;
  f.steps([{ research: { protocol: "omg-answer/v2", requestId: "$requestId", questionIds: m5.items.map(item => item.gap), action: "need_owner",
    reason: "The owner must name the optional format", decision: "Name it" }, usage }, factsAll(f, b.routes), assessor("supported")]);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 80);
  const mechanism = mechanismSeries(f), reasons = reasonsOf(end.state);
  assert.deepEqual(mechanism.value.attempts.map(row => row.outcome?.reason), ["awaiting-owner"], "M5's goal is held, not closed as done");
  // R8: the independent block was worked, paid and applied before the end; the goal that waits for the owner is the ground.
  assert.ok(end.performed.includes("assess") && end.performed.filter(action => action === "close").length >= 2, end.performed.join(","));
  assert.equal(blockSeries(f).value.attempts[0]!.outcome!.reason, "result");
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]),
    [["owner-control", "model_need_owner", mechanism.id, "attempt.1"]]);
  assert.equal(reasons[0]!.message, "The owner must name the optional format; Name it", "The message is the saved diagnostic of E4");
  // R7a: the applied facts made a new B1 and with it a new composition of M6; the held question stays the one ground, asked once.
  assert.ok(end.performed.includes("apply") && end.performed.includes("bases"), end.performed.join(","));
  assert.ok(f.store.list("route-result").length >= 2, "The independent batch changed the composition of M6 while the question stayed held");
  assert.equal(f.sent().length, 3, "M5, the facts and their assessment: nothing is paid twice and nothing is paid for the held goal");
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
});

/** The scripted answer of a paid cycle for its exact saved packet: an MC1 packet asks the owner, an MC2 packet assembles its part. */
function frameAnswer(f: Fixture, step: { request: unknown }) {
  const saved = (step.request as { packet: Ref }).packet;
  const packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
  const routes = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
  const batch = routes.batches.find(row => row.id === packet.value.request.batch)!;
  if (batch.model !== "MC1") return nodeAnswer(f, step);
  return { research: { protocol: "omg-answer/v2", requestId: "$requestId", questionIds: batch.items.map(item => item.gap), action: "need_owner",
    reason: "Need a concrete source", decision: "Choose the source" }, usage };
}

test("H1.2 R13a R8 an open N2 attempt whose MC1 asked the owner: after the neighbour's work the full G4b proves that exact question, and no close, C5 or D2 is invented", async t => {
  const f = runFixture(t, ["encoding"], false, true);
  const b = f.bases("h12-frame-owner"), request = f.request(b);
  ok(startRun(f.store, { project }));
  const answers: Record<string, unknown>[] = [], answered = new Set<string>();
  let state: RunRecord["state"] | null = null;
  for (let index = 0; index < 150 && !state; index++) {
    const advanced = ok(await advanceRun(f.store, request)), now = advanced.record.value.state as unknown as RunRecord["state"];
    if (now.phase === "step" && now.step.action === "cycle") {
      const packet = (now.step.request as unknown as { packet: Ref }).packet;
      if (!answered.has(packet.id)) { answered.add(packet.id); answers.push(frameAnswer(f, now.step)); f.steps(answers); }
    }
    if (now.phase === "waiting" || now.phase === "unable" || now.phase === "complete") state = now;
  }
  assert.ok(state, "The pass came to rest");
  const reasons = reasonsOf(state);
  const need = reasons.filter(row => row.kind === "frame-need-owner");
  assert.deepEqual(need.map(row => [row.code, row.target, row.field, row.message]),
    [["model_need_owner", "discovery:encoding", "answer", "Need a concrete source; Choose the source"]], JSON.stringify(reasons));
  assert.ok(need[0]!.basis.length >= 3, "The gate, the call and the diagnostic of E4");
  for (const block of ["garden-produce-block", "garden-consume-block"])
    assert.equal(blockSeries(f, block).value.attempts[0]!.outcome, null, `${block}: the attempt stays open, no close is invented`);
  assert.equal(f.store.get(`om-frame:${project}:2`), null, "No C5");
  assert.ok(!actions(f.store).some(action => ["accept", "confirm", "lines"].includes(action)), "No C5 and no D2 without a passed G4b");
  assert.equal(f.sent().length, 3, "The neighbour's MC2 and the consumer's MC1 and MC2: everything reachable was worked first");
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
  assert.equal(f.sent().length, 3);
});

test("H1.2 R7 C01 C33 C59 both kinds of line ask the owner: the grounds keep their canonical order without a repeat, and a malformed end is an integrity refusal", async t => {
  const f = runFixture(t, ["encoding", "spare"], true, ["encoding"]);
  const b = f.bases("h12-both"), request = f.request(b);
  const saved = f.store.get<RoutesRecord>(b.routes.id, b.routes.revision)!.value;
  const m5 = saved.batches.find(item => item.model === "MC2" && item.task === "input-field")!;
  const facts = saved.batches.find(item => item.model === "MC1")!;
  const ask = (gaps: string[], reason: string) => ({ research: { protocol: "omg-answer/v2", requestId: "$requestId", questionIds: gaps,
    action: "need_owner", reason, decision: "Decide it" }, usage });
  f.steps([ask(m5.items.map(item => item.gap), "The optional format is not named"), ask(facts.items.map(item => item.gap), "The encoding source is not named")]);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 60);
  const reasons = reasonsOf(end.state);
  assert.equal(reasons.length, 2, JSON.stringify(reasons));
  assert.deepEqual(reasons.map(row => row.kind), ["owner-control", "owner-control"]);
  assert.deepEqual(reasons.map(row => row.target), [mechanismSeries(f).id, blockSeries(f).id].sort(), "Canonical order, not the order the grounds were met in");
  assert.deepEqual(reasons.map(row => row.message).sort(), ["The encoding source is not named; Decide it", "The optional format is not named; Decide it"]);
  // A malformed end is an integrity refusal of the pass, never a guess: an empty list, and a list out of its canonical order.
  const head = f.store.get<RunRecord>(runId(project))!;
  const bad = (state: unknown) => f.store.write({ id: head.id, kind: head.kind, expected: f.store.get(head.id)!.revision, value: { ...head.value, state } as unknown as Json });
  bad({ phase: "unable", reasons: [] });
  assert.equal(refusal(readRun(f.store, { project })).code, "run_record_invalid");
  bad({ phase: "unable", reasons: [...reasons].reverse() });
  assert.equal(refusal(readRun(f.store, { project })).code, "run_record_invalid");
  assert.equal(refusal(await advanceRun(f.store, request)).code, "run_record_invalid");
  bad({ phase: "unable", reasons });
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "unable");
});

test("H1.2 R8 R9 C11 3 a standalone open attempt of another owner defers the end: the proved second rung of M5 does not end a pass that may still change", async t => {
  const f = runFixture(t, ["encoding", "spare"], true, ["encoding"]);
  const b = f.bases("h12-defer"), request = f.request(b), none = cannotAnswer(f, b.routes);
  // The independent block has an attempt of the earlier mode still open: the pass never adopts it and never ends over it.
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h12-standalone", predecessor: null, basis: null }));
  ok(beginAttempt(f.store, { ...address, attempt: 1, goal: { key: "h12-standalone", questions: ["Address one contract"], result: "A supported contract" } }));
  f.steps([none, none, none, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 60);
  assert.equal(end.state.phase, "waiting", JSON.stringify(end.state));
  assert.equal((end.state as unknown as { wait: RunWait }).wait.code, "standalone_attempt");
  assert.equal(mechanismSeries(f).value.escalations.length, 1, "M5 stands on its second rung, proved by its review");
  assert.equal(f.sent().length, 4, "Only M5's three attempts and its one review were paid");
  const before = f.store.list().map(reference);
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
  assert.deepEqual(f.store.list().map(reference), before, "The standing wait is read, not written");
});

/** The scripted answer of a paid cycle for its exact saved packet: an MC1 packet answers its facts, an MC2 packet asks the owner. */
function mixedAnswer(f: Fixture, step: { request: unknown }) {
  const saved = (step.request as { packet: Ref }).packet;
  const packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
  const routes = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
  const batch = routes.batches.find(row => row.id === packet.value.request.batch)!;
  if (batch.model === "MC2") return { research: { protocol: "omg-answer/v2", requestId: "$requestId", questionIds: batch.items.map(item => item.gap),
    action: "need_owner", reason: "Only the design decision needs the owner", decision: "Choose the design" }, usage };
  const brief = f.store.get<{ content: string }>(`source:${project}:brief`)!;
  return { research: { protocol: "omg-answer/v2", requestId: "$requestId", action: "answer", results: batch.items.map(item => ({
    questionId: item.gap, value: { answer: "UTF-8" }, citations: [{ source: reference(brief), selector: { kind: "text-range", start: 0, end: brief.value.content.length } }] })) }, usage };
}

test("H1.2 R13 R8 №2045-2 H1.5 a fact and a design decision nobody answers in one block: the fact runs through E4, E5 and G7 and is applied, the design decision is never planned nor paid for, and the pass ends on that exact question", async t => {
  const f = runFixture(t, ["encoding", "spare"]);
  const input = f.store.get(`om-input:${project}`)!;
  // One block gets a fact (MC1) and a design decision (MC2): the second has no answer producer (H1.5, №2166).
  ok(writeAddressing(f.store, { project, input: reference(input), graph: f.graph, decisions: ["encoding", "spare"].map(id => ({
    pending: structuredClone(inputDecisionWrite({ project, input: reference(input), graph: f.graph, layers: [], decision: { target: `discovery:${id}`,
      field: "address", value: { consumer: "garden-consume-block", kind: id === "encoding" ? "repository-fact" : "design-decision" } } })) as Write })) }));
  const request = f.request(), answers: Record<string, unknown>[] = [], answered = new Set<string>();
  ok(startRun(f.store, { project }));
  let state: RunRecord["state"] | null = null;
  for (let index = 0; index < 90 && !state; index++) {
    const advanced = ok(await advanceRun(f.store, request)), now = advanced.record.value.state as unknown as RunRecord["state"];
    if (now.phase === "step" && (now.step.action === "cycle" || now.step.action === "assess") && !answered.has(JSON.stringify(now.step.request))) {
      answered.add(JSON.stringify(now.step.request));
      answers.push(now.step.action === "assess" ? assessor("supported") : mixedAnswer(f, now.step));
      f.steps(answers);
    }
    if (now.phase === "waiting" || now.phase === "unable" || now.phase === "complete") state = now;
  }
  assert.ok(state, "The pass came to rest");
  const reasons = reasonsOf(state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), [["unsupported-question", "route_result_unsupported", "discovery:spare", "answer"]]);
  assert.ok(reasons[0]!.basis.length >= 1, "The exact gap of the question");
  assert.equal(actions(f.store).filter(action => action === "evaluate").length, 1, "The saved evaluation is read, never repeated");
  // H1.5 (№2166): the plan of the attempt holds the fact batch only, so its own check is complete after that fact and the
  // attempt is closed by G7 with its result; the design decision is neither planned nor paid for and stays open at its address.
  assert.deepEqual(actions(f.store), ["bases", "open-series", "open", "register", "packet", "cycle", "assess", "routes", "evaluate", "close", "apply", "bases"],
    "The fact is asked, assessed, checked, closed, applied to B1; the bases are built again; nothing else is done");
  const attempt = blockSeries(f).value.attempts[0]!;
  assert.equal(attempt.outcome?.reason, "result", "The fact attempt is closed by G7 with its result");
  assert.equal(attempt.outcome?.reason === "result" ? attempt.outcome.achieved.length : -1, 1, "Only the fact is achieved");
  assert.equal(f.store.get(`om-frame:${project}:2`), null, "No C5");
  assert.ok(!actions(f.store).some(action => ["accept", "confirm", "lines"].includes(action)), "No C5 or D2 without a passed G4b");
  assert.equal(f.sent().length, 2, "The fact and the one assessment: nothing was paid for the design decision");
  assert.ok(f.sent().every(line => !String(line).includes("Which spare is supported?")), "No paid request carries the design question");
  const series = blockSeries(f), binding = ok(readCompletionBinding(f.store, project, reference(series), 1))!;
  const routes = ok(readRoutes(f.store, { project, record: binding.value.plan.routes })).record.value;
  assert.deepEqual(binding.value.plan.batches, routes.batches.filter(batch => batch.model === "MC1").map(batch => batch.id).sort(),
    "The plan of the attempt holds the fact batch only");
  assert.ok(routes.batches.some(batch => batch.model === "MC2" && batch.task === "input-field" && batch.items.some(item => item.target === "discovery:spare" && item.field === "answer")),
    "M6 still describes the batch: its presence never was a right to pay");
  const saved = ok(readRun(f.store, { project }))!;
  f.restart();
  const again = ok(await advanceRun(f.store, request));
  assert.deepEqual([again.performed, again.record.hash], [null, saved.hash], "A new store returns the same end");
  assert.equal(f.sent().length, 2);
});

test("H1.2 R13b a blocking question nobody can answer in this product ends the pass on that exact question, with no attempt open and nothing invented", async t => {
  const f = runFixture(t, ["encoding"]);
  const input = f.store.get(`om-input:${project}`)!;
  ok(writeAddressing(f.store, { project, input: reference(input), graph: f.graph, decisions: [{ pending: structuredClone(inputDecisionWrite({
    project, input: reference(input), graph: f.graph, layers: [], decision: { target: "discovery:encoding", field: "address",
      value: { consumer: "garden-consume-block", kind: "owner-decision" } } })) as Write }] }));
  const request = f.request();
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 10);
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target]), [["unsupported-question", "owner_result_unavailable", "discovery:encoding"]]);
  assert.equal(reasons[0]!.field, "owner-result");
  assert.equal(f.store.list("repair-series").length, 0, "No line, no attempt: nobody was asked to answer it");
  assert.equal(f.store.list().filter(row => row.id.startsWith("om-owner-result:")).length, 0, "No owner result is invented");
  assert.equal(f.sent().length, 0);
});

test("H1.2 R4 R2 a stop after a spent continuation is on the second rung by that spent window: the first review is not borrowed, no second one is paid", async t => {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("h12-spent"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, true), none, none, none]);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 80);
  const series = mechanismSeries(f), stop = series.value.stop!;
  assert.equal(end.performed.filter(action => action === "analyze").length, 1, "Only the first stop was reviewed");
  assert.equal(end.performed.filter(action => action === "resume").length, 1, "The first stop was continued by its decided review");
  assert.equal(series.value.continuations.length, 1);
  assert.ok(stop.attempt > 3, "The stop that ended the pass is a later stop of the same line");
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), [["stop-second-rung", "owner_decision", series.id, "stop"]]);
  assert.match(reasons[0]!.message, new RegExp(`attempt ${stop.attempt}`), "The message names the later stop, not the first");
  assert.deepEqual(reasons[0]!.basis, [reference(series)], "No review of another stop is borrowed to fill the reference");
  assert.equal(f.sent().length, series.value.attempts.length + 1, "The attempts and the one review of the first stop");
});

test("H1.2 R6 an origin the review establishes lifts its own hold and the pass goes on; it is no ground of the end", async t => {
  const f = runFixture(t, ["encoding"], true, true);
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h12-established", predecessor: null, basis: null }));
  const goal = { key: "h12-established-goal", questions: ["Address one contract"], result: "A supported contract" };
  ok(beginAttempt(f.store, { ...address, attempt: 1, goal }));
  const source = f.store.write({ id: `${unitRefusalNamespace(project)}h12-workspace`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: { gate: "G6", refusals: [{ code: "workspace_unavailable", goal: goal.key, remedy: "Observe the declared workspace condition",
      origin: { name: "workspace_unavailable", stage: "feasibility", subject: "workspace", sources: [] } }] } });
  const journal = ok(recordRefusal(f.store, { project, source: reference(source) }));
  const row = journal.value.rows.find(item => item.source.id === source.id)!;
  const closed = ok(closeAttempt(f.store, { ...address, attempt: 1, outcome: { reason: "refused", accepting: [], cancelling: [],
    refusals: [{ row: row.id, name: row.code, goal: row.goal }] } }));
  assert.equal(closed.holds.length, 1, "G7 raised one hold of unknown origin");
  const request = f.request(f.bases("h12-established"));
  f.steps([{ research: { protocol: "omg-stop-analysis/v1", cause: null, change: null,
    origin: { class: "conditions", basis: [{ role: "environment", ref: request.dispatch.config }] } }, usage }]);
  ok(startRun(f.store, { project }));
  const driven = await driveTo(f, request, "open", 10);
  assert.deepEqual(driven.performed, ["analyze", "open"], "The review lifts its own hold and the next attempt opens on the same line");
  const hold = f.store.get<{ lift: { class: string } | null }>(closed.holds[0]!.id)!;
  assert.equal(hold.value.lift?.class, "conditions");
  assert.notEqual(ok(readRun(f.store, { project }))!.value.state.phase, "unable");
});

test("H1.2 R2 18 19 H1 a decided first-rung review grounds resumeSeries of that exact stop, the next attempt works on, and the pass does not end", async t => {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("h1-first"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, true), addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const driven = await driveTo(f, request, "bases", 50);
  const attempt = ["open", "packet", "cycle", "close"];
  assert.deepEqual(driven.performed, ["open-series", ...attempt, ...attempt, ...attempt, "analyze", "resume", ...attempt, "bases"], JSON.stringify(driven.wait));
  const series = mechanismSeries(f);
  assert.equal(series.value.stop, null);
  assert.equal(series.value.continuations.length, 1);
  assert.equal(series.value.attempts.at(-1)!.outcome!.reason, "result");
  assert.equal(f.store.get(`om-input:${project}`)!.revision, 3, "The applied addressing made a new B1, and the pass built its bases itself");
  assert.notEqual(ok(readRun(f.store, { project }))!.value.state.phase, "unable", "A decided review is a lawful continuation, never a ground of the end");
});

/** Advances until the pass has SAVED the given action (chosen, not yet performed), returning the saved step. */
async function until(f: Fixture, request: RunRequest, action: string, bound = 20) {
  for (let index = 0; index < bound; index++) {
    const advanced = ok(await advanceRun(f.store, request));
    const state = advanced.record.value.state;
    if (state.phase === "step" && state.step.action === action) return state.step;
    if (state.phase === "waiting") assert.fail(`The pass waited before choosing ${action}: ${state.wait.code}`);
  }
  assert.fail(`The pass did not choose ${action}`);
}
class RacingStore extends Store {
  target = ""; remaining = 0; run: ((store: Store) => void) | null = null;
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    const found = super.get<T>(id, revision);
    if (id === this.target && this.remaining > 0 && --this.remaining === 0 && this.run) {
      const run = this.run; this.run = null;
      const other = new Store(this.path);
      try { run(other); } finally { other.close(); }
    }
    return found;
  }
}

test("C41 C43 К7 H1 a product written before the cursor moved is found again by the saved request: no second call, open or close", async t => {
  const f = runFixture(t);
  const b = f.bases("h1-first"), request = f.request(b);
  f.steps([addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  // Window after the producer of the opening and before the cursor: the same saved request finds the same attempt.
  const opening = await until(f, request, "open");
  const opened = ok(openAttempt(f.store, opening.request as never));
  const resumed = ok(await advanceRun(f.store, request));
  assert.deepEqual(resumed.products, [refOf(opened)]);
  // Window after a paid cycle and before the cursor: a restart repeats the cycle by its request without a send.
  const cycling = await until(f, request, "cycle");
  // №1737 п.5: the common claim preparer keeps the typed incompleteness of an unfinished composition.
  const address = { project, owner: { kind: "mechanism" as const, mechanism: "M5:addressing" as const }, line: 1, attempt: 1 };
  const empty = { reason: "result" as const, accepting: [], cancelling: [], refusals: [] };
  assert.equal(refusal(prepareManagedClaim(f.store, { ...address, outcome: empty } as never)).code, "completion_incomplete");
  const cycle = ok(await runModelCycle(f.store, cycling.request as never));
  assert.equal(f.sent().length, 1);
  f.restart();
  const found = ok(await advanceRun(f.store, request));
  assert.deepEqual(found.products, [refOf(cycle.record)]);
  assert.equal(f.sent().length, 1, "The saved call is not sent again");
  // Window after G7 and before the cursor: the close is repeated only with its saved claim, and changes nothing.
  const closing = await until(f, request, "close");
  // The saved claim is the preparer's: every applied M5 addressing is named by the registry itself, not by the caller.
  const claim = ok(prepareManagedClaim(f.store, { ...address, outcome: empty } as never));
  assert.deepEqual((closing.request as unknown as { outcome: unknown }).outcome, JSON.parse(JSON.stringify(claim.outcome)));
  assert.deepEqual(claim.outcome.accepting, [refOf(cycle.last!.record)], "The applied E4 is required even when the caller names nothing");
  assert.ok(claim.guards.some(guard => "id" in guard && guard.id === mechanismSeries(f).id), "The claim carries the heads it stands on");
  ok(closeAttempt(f.store, closing.request as never));
  const closedAt = f.store.list().map(reference);
  const after = ok(await advanceRun(f.store, request));
  assert.equal(after.performed?.action, "close");
  assert.deepEqual(f.store.list().map(reference).filter(ref => ref.id !== runId(project)), closedAt.filter(ref => ref.id !== runId(project)));
  assert.equal(mechanismSeries(f).value.attempts.length, 1, "No second attempt or close");
});

test("К10 C41 H1 two stores choosing the next step at once: the first saved choice wins and the other performs that same step", async t => {
  const f = runFixture(t);
  const b = f.bases("h1-first"), request = f.request(b);
  ok(startRun(f.store, { project }));
  const racing = new RacingStore(f.database);
  t.after(() => racing.close());
  racing.target = runId(project); racing.remaining = 1;
  racing.run = other => { void advanceRun(other, request); };
  const lost = await advanceRun(racing, request);
  assert.equal(lost.ok, false, "The losing choice is refused by the run's own revision guard");
  const saved = ok(readRun(f.store, { project }))!;
  assert.equal(saved.revision, 2);
  assert.equal(saved.value.state.phase, "step");
  const performed = ok(await advanceRun(racing, request));
  assert.deepEqual(performed.performed, (saved.value.state as { step: unknown }).step, "The other store performs the saved step, not a new name");
  assert.equal(f.store.list("repair-series").length, 1);
});

test("2 R1 H1.1 cold OM to the first model step: the machine builds B1, the pass and its bases; a pass without built bases builds them first", async t => {
  const f = runFixture(t, ["encoding"], true, false, false, true);
  assert.equal(f.store.get(`om-input:${project}`), null, "No OM record exists");
  const built = ok(writeRunBases(f.store, { project }));
  f.steps([addressAll(f, built.bases.routes)]);
  const request = f.request();
  const cycling = await until(f, request, "cycle", 10);
  assert.deepEqual(actions(f.store), ["open-series", "open", "packet"], "M5 is the first work; nobody issued any bases");
  assert.ok(ok(await advanceRun(f.store, request)).performed?.action === "cycle" && cycling);
  assert.equal(f.sent().length, 1, "The first paid model step");
  // A pass whose bases were never built: its first step is its own saved build, before any series or attempt.
  const g = runFixture(t, ["encoding"]);
  ok(startRun(g.store, { project }));
  assert.equal(g.store.list("horizon").length, 0);
  const first = ok(await advanceRun(g.store, g.request())).record.value.state;
  assert.equal(first.phase === "step" && first.step.action, "bases");
  assert.equal(g.store.list("repair-series").length, 0);
  assert.equal(ok(await advanceRun(g.store, g.request())).performed?.action, "bases");
  assert.equal(g.store.list("om-horizon").length, 1, "One issue of the launch intent");
});

test("C01 №1852 H1 one pass per project: a repeated start reads it, equal concurrent creations converge to one winner, and the record is B1-born", async t => {
  const f = runFixture(t);
  const racing = new RacingStore(f.database);
  t.after(() => racing.close());
  racing.target = runId(project); racing.remaining = 1;
  racing.run = other => { ok(startRun(other, { project })); };
  // №1852-2: the losing creation reads the winner again; an equal intent converges to it without a second record.
  const lost = ok(startRun(racing, { project }));
  const again = ok(startRun(racing, { project }));
  assert.deepEqual(lost, again);
  assert.equal(again.revision, 1);
  assert.deepEqual(again.value.input, reference(f.store.get(`om-input:${project}`)!));
  // The engine recognizes even an incomplete run record as B1-born: without its first B1 the era is an integrity refusal.
  const other = new Store(join(f.root, "orphan.sqlite"));
  t.after(() => other.close());
  other.write({ id: runId(project), kind: "om-run", expected: 0, value: { contract: "om-run/v1" } });
  assert.throws(() => new ProductEngine(other).legacyRoute(project), (error: unknown) => error instanceof EngineError && error.code === "record_missing");
});

test("H1.2 R7 R10a 15 16 C33 need_owner of a goal ends the pass on that goal at any reason of its close; new bases or a restart neither release it nor pay again", async t => {
  const f = runFixture(t, ["encoding"]);
  const { m5, second, request } = await blockBases(f);
  const saved = f.store.get<RoutesRecord>(second.routes.id, second.routes.revision)!.value;
  const gap = saved.batches.find(item => item.model === "MC1")!.items[0]!.gap;
  f.steps([m5, { research: { protocol: "omg-answer/v2", requestId: "$requestId", questionIds: [gap], action: "need_owner",
    reason: "Need a concrete source", decision: "Choose the source" }, usage }]);
  const end = await ends(f, request);
  assert.equal(end.performed.at(-1), "close", JSON.stringify(end.state));
  const series = blockSeries(f);
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), [["owner-control", "model_need_owner", series.id, "attempt.1"]]);
  assert.equal(reasons[0]!.message, "Need a concrete source; Choose the source", "The message is the saved diagnostic of E4");
  assert.equal(reasons[0]!.basis.length, 3, "The line, the close of that very attempt and the saved diagnostic");
  assert.equal(series.value.attempts[0]!.outcome!.reason, "awaiting-owner");
  const sends = f.sent().length, before = untouched(f.store);
  // R10a: no base of any kind is built for a pass that ended; the saved end stands across a new store and a restart.
  f.restart();
  assert.equal(refusal(writeRunBases(f.store, { project })).code, "run_bases_terminal");
  assert.equal(refusal(prepareRunBases(f.store, { project })).code, "run_bases_terminal");
  const again = ok(await advanceRun(f.store, request));
  assert.deepEqual([again.performed, again.record.value.state.phase], [null, "unable"]);
  assert.deepEqual(untouched(f.store), before);
  assert.equal(f.sent().length, sends);
  assert.equal(blockSeries(f).value.attempts.length, 1, "The held goal opens no second attempt");
});

/**
 * The accepted N2 operations of the real upstream fixture (om-feasibility), loaded without registering its suite: the
 * same producer chain that G2 uses, reused rather than copied.
 */
type OperationsFixture = { root: string; workspace: string; database: string; project: string; desired: Graph; basis: FrameRead;
  frame2: FrameRequest; graph: Ref; layer: Ref; upperFrame: Ref; input: Revision<OmInputRecord>; horizon: HorizonRecords;
  readonly store: Store; readonly engine: ProductEngine; restart(): void };
let operationsModule: Promise<{ acceptedOperationsFixture(t: test.TestContext, status: "planned", count: number): OperationsFixture }> | undefined;
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

test("H1.2 R12 R10a 27 25 7 C61 C28 H1 end to end: the pass works L3 through MC2, G4b and one bound works acceptance, then M8 (not ready, then fixed), M9 and the existing compiler; no base is built for the completed pass", async t => {
  const f = (await loadOperations()).acceptedOperationsFixture(t, "planned", 0);
  const { store, project: name, workspace, desired } = f;
  assert.equal(name, project);
  // The pass's own works bases over the accepted operations (H1.1), for the launch intent of the garden result.
  const built = ok(writeRunBases(store, { project, outcomes: ["garden-result"] }));
  const routes = store.get<RoutesRecord>(built.bases.routes.id, built.bases.routes.revision)!;
  assert.ok(routes.value.batches.some(batch => batch.level === 3 && batch.task === "node-expansion"));
  const scenario = join(f.root, "scenario.json"), trace = join(f.root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const environment = f.engine.environments.configure(project, { workspace,
    implementer: { actor: "h1-works-producer", model: "fixture", effort: "high", command },
    reviewer: { actor: "h1-works-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 200_000 }, 0);
  writeFileSync(join(workspace, "input.txt"), "A captured external input");
  // The external input of the works; G5 finds exactly this Source through the candidate's own task derivation (№1860 п.7).
  new Evidence(store).file(project, "garden-data", workspace, "input.txt", "text/plain", 0);
  git(workspace, ["add", "input.txt"]);
  git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "capture input"]);
  const adapter = store.write({ id: `adapter:${project}:h1`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  const request: RunRequest = { project, dispatch: { adapter: reference(adapter), config: reference(environment) } };
  ok(startRun(store, { project }));
  // The pass chooses and saves the paid cycle first; its answer is written for the exact saved packet.
  const cycling = await until({ store } as unknown as Fixture, request, "cycle");
  const packet = store.get<QuestionPacketRecord>((cycling.request as unknown as { packet: Ref }).packet.id)!;
  const payload = packet.value.packet as unknown as { expansion: { assigned: string[]; obligations: { id: string; kind: string; upper: { port?: string } }[] } };
  const work = structuredClone(desired.nodes.find(node => node.id === "garden-consume-work")!);
  const body = { nodes: [work], tests: structuredClone(desired.tests.filter(proof => work.tests.includes(proof.id))),
    fills: payload.expansion.obligations.filter(item => payload.expansion.assigned.includes(item.id)).map(item => ({ obligation: item.id, node: work.id,
      ...(item.kind === "connection-end" ? { port: item.upper.port!, codeRef: work.code[0]! } : {}) })),
    localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
    removes: [], replaces: [], redefines: [] };
  writeFileSync(scenario, JSON.stringify({ steps: [{ research: { protocol: "omg-answer/v2", requestId: "$requestId", action: "answer", proposal: body, bindings: [] }, usage }] }));
  const performed: string[] = [];
  let phase = "", dirty = false;
  const readme = join(workspace, "README.md"), original = readFileSync(readme);
  for (let index = 0; index < 40 && phase !== "complete"; index++) {
    const advanced = ok(await advanceRun(store, request));
    if (advanced.performed) performed.push(advanced.performed.action);
    const state = advanced.record.value.state as unknown as { phase: string; step?: { action: string }; wait?: { code: string } };
    phase = state.phase;
    // №1766 п.2: the repository becomes dirty before the first M8; M8 lawfully finds it not ready.
    if (state.phase === "step" && state.step!.action === "feasibility" && !dirty) { dirty = true; writeFileSync(readme, "An unrecorded local edit\n"); }
    if (state.phase === "waiting") {
      assert.equal(state.wait!.code, "feasibility_not_ready", JSON.stringify(state.wait));
      const saved = store.get(`om-feasibility:${project}`)!;
      assert.equal((saved.value as { ready: boolean }).ready, false);
      // The unchanged finding stands: no new M8 record and no write of the pass.
      const before = store.list().map(reference);
      assert.equal(ok(await advanceRun(store, request)).performed, null);
      assert.deepEqual(store.list().map(reference), before);
      // Fixing the named ground admits a new M8 step on the saved revision.
      writeFileSync(readme, original);
    }
  }
  assert.deepEqual(performed, ["cycle", "evaluate", "works", "bases", "confirm", "close", "feasibility", "feasibility", "handoff", "compile"],
    "One bound works acceptance, the machine bases over it for the D2 event of the original goal and G7; M8 again after its finding is fixed; then M9 and the compiler");
  // №1860 п.7: the works acceptance names exactly the external Source its candidate's own task derivation needs.
  const works = actionsSteps(store).find(row => row.action === "works")!.request as unknown as { works: { sources: Ref[] } };
  assert.deepEqual(works.works.sources, [reference(store.get(`source:${project}:garden-data`)!)]);
  assert.equal(store.get(`om-feasibility:${project}`)!.revision, 2);
  assert.equal((store.get(`om-feasibility:${project}`)!.value as { ready: boolean }).ready, true);
  assert.deepEqual(actions(store), ["open-series", "open", "register", "lines", "obligations", "packet", ...performed],
    "D2 and D7 of the exact scope precede the works packet; the check is registered before them");
  assert.equal(phase, "complete");
  const series = blockSeries(f as unknown as Fixture);
  assert.equal(series.value.attempts[0]!.outcome!.reason, "result");
  assert.ok(series.value.attempts[0]!.outcome!.achieved.length > 0, "G7 confirmed the achievement from the D2 event and the own C5");
  const frame = store.get(`om-frame:${project}:3`)!;
  assert.deepEqual((frame.value as { acceptance: { binding: { ordinal: number } } }).acceptance.binding.ordinal, 1, "The works acceptance is bound to the attempt");
  assert.equal(store.get<{ status: string }>(`stage:${project}:compilation`)!.value.status, "accepted");
  assert.equal(readFileSync(trace, "utf8").trim().split("\n").length, 1, "One paid call made the whole works");
  // A completed pass returns its proved completion and starts nothing.
  const before = store.list().map(reference);
  const again = ok(await advanceRun(store, request));
  assert.equal(again.performed, null);
  assert.deepEqual(store.list().map(reference), before);
  // R10a: the same saved end is refused to the direct entries of the builder, with the phase named.
  for (const refused of [refusal(prepareRunBases(store, { project })), refusal(writeRunBases(store, { project }))]) {
    assert.equal(refused.code, "run_bases_terminal");
    assert.match(refused.message, /complete/);
  }
  assert.deepEqual(store.list().map(reference), before);
});

/**
 * The MC2 answer of a block for its exact saved packet: one operation filling exactly the obligations the packet
 * assigned, with a port per connection end (the shape of the real node-part protocol).
 */
function nodeAnswer(f: Fixture, step: { request: unknown }) {
  const saved = (step.request as { packet: Ref }).packet;
  const packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
  const plan = packet.value.plan!, ids = plan.assignments[plan.position]!.obligations;
  const routes = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
  const batch = routes.batches.find(row => row.id === packet.value.request.batch)!;
  const operations = routes.request.gaps.sources.operations as unknown as ProposalRequest;
  const obligations = ok(prepareFrameProposals(f.store, operations)).frame.result.obligations.filter(item => ids.includes(item.id));
  const graph = f.store.get<Graph>(`graph:${project}`)!.value, upper = graph.nodes.find(node => node.id === batch.node)!;
  const node = { ...structuredClone(upper), id: `garden-h1-operation-${batch.node}`, kind: "operation", parent: upper.id,
    title: `Operation of ${batch.node}`, ports: obligations.filter(item => item.kind === "connection-end").map((item, index) => ({
      id: `h1-port-${index}`, direction: item.role === "producer" ? "out" : "in",
      contract: graph.artifacts.find(artifact => artifact.id === item.artifact)!.contract })), code: [], tests: [] };
  let port = 0;
  const proposal = { nodes: [node], fills: obligations.map(item => ({ obligation: item.id, node: node.id,
    ...(item.kind === "connection-end" ? { port: node.ports[port++]!.id } : {}) })), localConnectors: [], artifacts: [], contracts: [],
    joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
  return { research: { protocol: "omg-answer/v2", requestId: "$requestId", action: "answer", proposal }, usage };
}

test("25 C61 7 R8 №1749 №1860-12 H1.1 two blocks of one N2 frame: G4b waits for both, one bound C5, machine bases over it, a D2 event per goal and each own G7 across second stores, then L3", async t => {
  const f = runFixture(t, [], false);
  const b = f.bases("h1-n2"), request = f.request(b);
  const saved = f.store.get<RoutesRecord>(b.routes.id, b.routes.revision)!.value;
  assert.equal(saved.batches.filter(row => row.task === "node-expansion" && row.level === 2).length, 2, "Both blocks expand the one operations frame");
  ok(startRun(f.store, { project }));
  // Block A (first in M3) pays its MC2; its part alone cannot form the frame, so A stays open and B is worked next.
  const first = await until(f, request, "cycle");
  const answers = [nodeAnswer(f, first)];
  f.steps(answers);
  const d1 = f.store.list().filter(row => row.id.startsWith("om-gap:")).map(reference), done = actions(f.store).length;
  const second = await until(f, request, "cycle", 30);
  assert.notEqual(second.series, first.series, "The pass moved on to the other block instead of waiting globally");
  // №1860-12: the waiting A keeps its scope; B is opened on the same bases, with no build and no D1 rewrite between them.
  assert.ok(!actions(f.store).slice(done).includes("bases"));
  assert.deepEqual(f.store.list().filter(row => row.id.startsWith("om-gap:")).map(reference), d1);
  const a = f.store.get<AnyRepairSeries>(first.series!)!;
  assert.equal(a.value.attempts.length, 1, "A kept its one open attempt: no second ordinal, no repaid call");
  answers.push(nodeAnswer(f, second));
  f.steps(answers);
  const accept = await until(f, request, "accept", 40);
  const binding = (accept.request as unknown as { settle: { binding: { series: Ref; ordinal: number } } }).settle.binding;
  assert.equal(binding.series.id, accept.series, "The coordinator binds only its own goal");
  assert.equal(ok(await advanceRun(f.store, request)).performed?.action, "accept");
  // R8: the acceptance is written and the bases over it are not; then the bases are written and no D2 yet; then a D2
  // event and not its G7 — each window is continued by a second store: one C5, one delivery per goal, then L3 work.
  f.restart();
  const after: string[] = [];
  let next: RunStep | null = null;
  for (let index = 0; index < 30 && !next; index++) {
    const advanced = ok(await advanceRun(f.store, request));
    const state = advanced.record.value.state;
    if (advanced.performed) {
      after.push(advanced.performed.action);
      if (["bases", "confirm"].includes(advanced.performed.action)) f.restart();
    }
    if (state.phase === "waiting") assert.fail(`${after.join(",")}: ${JSON.stringify(state.wait)}`);
    if (state.phase === "step" && after.filter(action => action === "close").length === 2) next = state.step as unknown as RunStep;
  }
  assert.deepEqual(after, ["bases", "confirm", "close", "confirm", "close"], "The machine bases over the accepted N2 serve both D2 events; no d2_bases wait");
  const built = ok(prepareRunBases(f.store, { project }));
  if (built.state !== "ready") assert.fail("The bases over the accepted N2 are current");
  assert.deepEqual(ok(readHorizon(f.store, project, built.built.bases.horizon)).horizon.value.request.refinement,
    reference(f.store.get(`graph-layer:${project}:2`)!), "The new issue stands on the accepted N2 layer");
  const l3 = f.store.get<RoutesRecord>(built.built.bases.routes.id, built.built.bases.routes.revision)!.value;
  assert.ok(l3.batches.some(row => row.task === "node-expansion" && row.level === 3), "The accepted N2 opens its L3 works");
  assert.ok(next && ["open-series", "open"].includes(next.action), `New work comes only after both D2/G7: ${JSON.stringify(next)}`);
  const blocks = ["garden-produce-block", "garden-consume-block"].map(block => blockSeries(f, block));
  for (const series of blocks) {
    assert.equal(series.value.attempts.length, 1);
    assert.equal(series.value.attempts[0]!.outcome!.reason, "result", series.id);
  }
  assert.equal(f.store.history(`om-frame:${project}:2`).length, 1, "One common acceptance");
  const lines = f.store.history(`om-gap-lines:${project}:history`);
  assert.equal(lines.filter(row => (row.value as { request: { closures: unknown[] } }).request.closures.length).length, 2, "One D2 event per original goal");
  assert.equal(f.sent().length, 2, "Nothing was paid twice");
  // №1961: a project without OM records stays in its lawful legacy participation through N2: no activation, no pointer.
  const membership = ok(readSeriesMembership(f.store, { project }));
  assert.equal(membership.value.mode, "legacy");
  assert.equal(membership.value.activation, null);
  assert.equal(f.store.list("om-series-applied").length, 0, "No activation was written");
  assert.equal(f.store.get(`om-series-current:${project}`), null, "No current pointer was written");
});

/**
 * The real L3 chain of several blocks (the proven path of the F5 atomic seed, om-atomic-gate): a native N2 acceptance of
 * the 'cross' graph, the owner's works horizon over that layer, D1 with the works frame, M6 and M3. The pass then pays one
 * MC2 works cycle per block and does everything else.
 */
function worksFixture(t: test.TestContext, late = false) {
  const root = mkdtempSync(join(tmpdir(), "omg-h1-works-")), database = join(root, "state.sqlite");
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const desired = gardenGraph("cross"), { level: _level, ...l1 } = projectGraph(desired, 1);
  // A late question of the environment (checked when a task starts): D1 keeps it as a late gap and D7 needs its assignment.
  preparedFeatures(engine, project, l1 as Graph, late ? field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = [{ id: "later-env", question: "Which runtime does the task start on?",
      consumer: "garden-consume-block", moment: "task-start", blocksCurrentStage: false, resolution: "Confirm it when the task starts" }];
    return value;
  } : undefined);
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, expected: 0, stages }));
  const first = reference(store.get(`graph:${project}`)!);
  const decisions = base.value.gaps.filter(gap => gap.code !== "inventory_missing" && gap.code !== "question_unaddressed").map(gap => {
    const field = gap.code === "contract_node_unbound" ? "nodes" : gap.code === "acceptance_kind_missing" ? "checkKind" : "state";
    const value: Json = field === "nodes" ? ["garden-produce-block", "garden-consume-block"] : field === "checkKind" ? "test"
      : { writer: "garden-produce-block", authority: "garden-consume-block", rollback: "garden-consume-block" };
    return { pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph: first, layers: [],
      decision: { target: gap.target, field, value } })) as Write };
  });
  if (late) decisions.push({ pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph: first, layers: [],
    decision: { target: "discovery:later-env", field: "address", value: { consumer: "garden-consume-block", kind: "environment-confirmation" } } })) as Write });
  const input = decisions.length ? ok(writeAddressing(store, { project, input: reference(base), graph: first, decisions })) : base;
  const upper = ok(writeHorizon(store, { project, input: reference(input), graph: first, refinement: null, available: {},
    choice: { choiceVersion: "h1-upper", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const frame2: FrameRequest = { project, level: 2, graph: first, horizon: reference(upper.gate), layer: null, frame: null, upper: null };
  const prepared = ok(prepareFrame(store, frame2)), projected = projectGraph(desired, 2);
  const mapped = ok(fillObligations(prepared.upper as Graph, prepared.scope as FrameScope, { graph: desired,
    reference: { ...prepared.request.graph, hash: hashJson(desired) }, frame: null }, prepared.upperRef, 2));
  const nodes = projected.nodes.filter(node => node.kind === "operation"), nodeIds = new Set(nodes.map(node => node.id));
  const value: LayerProposal = { base: { graph: prepared.request.graph, frame: null }, level: 2, source: "decision", status: "proposed", nodes,
    fills: mapped.fills.filter(fill => nodeIds.has(fill.node)).map(fill => ({ obligation: fill.obligation, node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length), artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
    tests: projected.tests, edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [],
    transfers: projected.transfers ?? [], anchors: projected.anchors, removes: [], replaces: [], redefines: [] };
  const proposal = store.write({ id: `om-proposal:${project}:h1-upper`, kind: "layer-proposal", expected: 0, value });
  const candidate = ok(writeCandidate(store, { frame: frame2, proposals: [reference(proposal)] }));
  if (candidate.state !== "candidate") assert.fail("The native N2 candidate is formed");
  const accepted = ok(settleCandidate(store, { project, level: 2, candidate: reference(candidate.record), outcome: {
    gate: "G3", candidate: reference(candidate.record), graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  assert.ok(accepted.graph && accepted.layer && accepted.frame, "The native N2 is accepted");
  // The pass's own works bases over the accepted N2 (H1.1), for the launch intent of the garden result.
  const built = ok(writeRunBases(store, { project, outcomes: ["garden-result"] }));
  const routes = store.get<RoutesRecord>(built.bases.routes.id, built.bases.routes.revision)!;
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "h1-atomic-producer", model: "fixture", effort: "high", command },
    reviewer: { actor: "h1-atomic-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 200_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:h1-works`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  const request: RunRequest = { project, dispatch: { adapter: reference(adapter), config: reference(environment) } };
  const steps: unknown[] = [];
  return { root, database, desired, routes, request,
    get store() { return store; }, get engine() { return engine; },
    restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); },
    sent(): unknown[] { return existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) : []; },
    /** The MC2 works answer for the exact saved packet: the desired work of its operation, as in the F5 seed. */
    answer(saved: Ref) {
      const packet = store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
      const routed = store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
      const batch = routed.batches.find(row => row.id === packet.value.request.batch)!;
      const payload = packet.value.packet as unknown as { expansion: { assigned: string[]; obligations: { id: string; kind: string; upper: { port?: string } }[] } };
      const work: Node = structuredClone(desired.nodes.find(node => node.kind === "work" && node.parent === batch.node)!);
      const tests = structuredClone(desired.tests.filter(item => work.tests.includes(item.id)));
      if (!work.code.length) {
        work.code = [{ path: `${work.id}.ts`, access: "write", status: "planned" }]; work.tests = [`${work.id}-test`];
        const proof = structuredClone(desired.tests.find(item => item.node === "garden-consume-work")!);
        proof.id = work.tests[0]!; proof.node = work.id; proof.covers = [];
        proof.contract!.entrypoint.path = work.code[0]!.path; proof.contract!.counterfactuals = [];
        tests.push(proof);
      }
      const body = { nodes: [work], tests, fills: payload.expansion.obligations.filter(item => payload.expansion.assigned.includes(item.id))
        .map(item => ({ obligation: item.id, node: work.id, ...(item.kind === "connection-end" ? { port: item.upper.port!, codeRef: work.code[0]! } : {}) })),
        localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
        removes: [], replaces: [], redefines: [] };
      steps.push({ research: { protocol: "omg-answer/v2", requestId: "$requestId", action: "answer", proposal: body, bindings: [] }, usage });
      writeFileSync(scenario, JSON.stringify({ steps }));
    } };
}

test("25 7 C61 №1749 H1 works of several blocks: each pays once, the full G4b waits for all, one bound works acceptance, a D2 event and G7 per goal", async t => {
  const f = worksFixture(t);
  const works = f.routes.value.batches.filter(row => row.level === 3 && row.task === "node-expansion");
  const blocks = [...new Set(works.flatMap(row => row.items[0]!.consumers))];
  assert.ok(blocks.length > 1, `Several blocks own works: ${blocks.join(",")}`);
  ok(startRun(f.store, { project }));
  const performed: string[] = [], answered = new Set<string>();
  let stood: unknown = null, phase = "";
  for (let index = 0; index < 200; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    if (advanced.performed) performed.push(advanced.performed.action);
    const state = advanced.record.value.state as unknown as { phase: string; step?: { action: string; request: { packet: Ref } }; wait?: unknown };
    phase = state.phase;
    // Each paid cycle is answered for its exact saved packet before it runs.
    if (state.phase === "step" && state.step!.action === "cycle" && !answered.has(state.step!.request.packet.id)) {
      answered.add(state.step!.request.packet.id); f.answer(state.step!.request.packet);
    }
    // Windows: after the common acceptance before D2, and after a D2 event before its G7.
    if (advanced.performed?.action === "works" || advanced.performed?.action === "confirm") f.restart();
    if (state.phase === "waiting" || state.phase === "complete") { stood = state.wait ?? null; break; }
    if (performed.filter(action => action === "close").length === blocks.length) break;
  }
  const count = (action: string) => performed.filter(item => item === action).length;
  assert.equal(count("works"), 1, `One common works acceptance: ${performed.join(",")} ${JSON.stringify(stood)}`);
  assert.equal(count("cycle"), works.length, "One paid cycle per works root; a block's roots share its one attempt");
  assert.equal(count("confirm"), blocks.length, "A D2 event per original goal");
  assert.equal(count("close"), blocks.length);
  for (const block of blocks) assert.equal(blockSeries(f as unknown as Fixture, block).value.attempts[0]!.outcome!.reason, "result", block);
  assert.equal(f.sent().length, works.length, "Each works root paid its one call, nothing twice");
  void phase;
});

test("H1.2 R13 R13b a late question of the environment that D7 cannot assign ends the pass on that gap, after the works are otherwise ready; no assignment is invented", async t => {
  const f = worksFixture(t, true);
  ok(startRun(f.store, { project }));
  const end = await ends({ store: f.store } as unknown as Fixture, f.request, 60);
  const reasons = reasonsOf(end.state);
  assert.ok(reasons.length >= 1, JSON.stringify(end.state));
  assert.ok(reasons.every(row => row.kind === "late-obligation" && row.code === "obligation_assignment_unresolved" && row.target === "discovery:later-env"), JSON.stringify(reasons));
  assert.equal(new Set(reasons.map(row => JSON.stringify([row.target, row.field, row.basis]))).size, reasons.length, "One ground per meaning, however many roots meet it");
  assert.equal(f.sent().length, 0, "Nothing is asked of a model for works that D7 cannot allow");
  assert.equal(f.store.list("om-owner-gap-assignment").length, 0, "The pass invents no assignment");
  const before = f.store.list().map(reference);
  assert.equal(ok(await advanceRun(f.store, f.request)).performed, null);
  assert.deepEqual(f.store.list().map(reference), before);
});

test("1 24 22 C57 R20 №1860-8 H1.1 a managed project works only on the activation of the pass's own issue: the machine runs B3, a new root works after it, a block outside the intent never", async t => {
  const f = runFixture(t, ["encoding"], false, true, true);
  // The project is already transition-managed: another issue activated an independent block's root.
  ok(openSeries(f.store, { project, block: "garden-later-block", line: 1, slice: "h1-other", predecessor: null, basis: null }));
  f.activate("h1-initial", { features: [{ outcome: "garden-later" }], excluded: [] });
  ok(startRun(f.store, { project, outcomes: ["garden-result"] }));
  const request = f.request();
  const pointer = () => f.store.get<{ applied: Ref; series: { block: string; participation: string }[] }>(`om-series-current:${project}`)!;
  const issued = () => {
    const applied = f.store.get<{ prepared: Ref }>(pointer().value.applied.id, pointer().value.applied.revision)!;
    return f.store.get<{ request: { horizon: Ref } }>(applied.value.prepared.id, applied.value.prepared.revision)!.value.request.horizon;
  };
  const initial = issued();
  // The current activation belongs to another issue: no work stands on it; the pass first builds its bases and B3.
  assert.deepEqual((await driveTo(f, request, "bases", 3)).performed, ["bases"]);
  const built = ok(prepareRunBases(f.store, { project }));
  if (built.state !== "ready") assert.fail("The bases of the pass's own issue are current");
  assert.notDeepEqual(initial, built.built.bases.horizon);
  assert.deepEqual(issued(), built.built.bases.horizon, "The current pointer now stands on the pass's own issue");
  // Row 1: a root registered for new work is unactivated; the machine's next B3 (a new P of the same issue) activates it.
  assert.deepEqual((await driveTo(f, request, "open-series", 3)).performed, ["open-series"]);
  const root = () => f.store.list<RepairSeries>("repair-series").find(row => (row.value as { block?: string }).block === "garden-produce-block"
    || (row.value as { block?: string }).block === "garden-consume-block")!;
  assert.equal((root().value as { activation?: { state: string } }).activation?.state, "unactivated");
  assert.equal(root().value.attempts.length, 0);
  assert.deepEqual((await driveTo(f, request, "bases", 3)).performed, ["bases"]);
  assert.deepEqual((root().value as { activation?: { state: string; participation: string } }).activation,
    { ...(root().value as { activation: object }).activation, state: "activated", participation: "active" });
  // Row 22: new work opens on the line B3 proved — the current line, without a successor.
  const opened = await driveTo(f, request, "open", 3);
  assert.deepEqual(opened.performed, ["open"]);
  const all = f.store.list<RepairSeries>("repair-series"), current = root();
  assert.ok(!all.some(other => other.value.predecessor?.id === current.id));
  assert.equal(current.value.attempts.length, 1);
  // Row 24: the block outside the intent keeps its line and starts no work.
  assert.equal(pointer().value.series.find(row => row.block === "garden-later-block")!.participation, "unselected");
  assert.equal(blockSeries(f, "garden-later-block").value.attempts.length, 0);
});

test("6 C54 H1 a lawfully changed required condition of an unfinished assignment is ended by the common cessation producer, never sent", async t => {
  const f = runFixture(t, ["encoding", "spare"], true, ["encoding"]);
  const b = f.bases("h1-cease"), request = f.request(b);
  const saved = f.store.get<RoutesRecord>(b.routes.id, b.routes.revision)!.value;
  const m5 = saved.batches.find(item => item.model === "MC2" && item.task === "input-field")!;
  // M5 waits for its owner, so the independent block is worked (row 3); its first packet is chosen.
  f.steps([{ research: { protocol: "omg-answer/v2", requestId: "$requestId", questionIds: m5.items.map(item => item.gap), action: "need_owner",
    reason: "The owner must name the optional format", decision: "Name it" }, usage }]);
  ok(startRun(f.store, { project }));
  // The block's first packet is chosen (after M5 waits for its owner).
  for (let index = 0; ; index++) {
    assert.ok(index < 30, "The block's packet is chosen");
    const state = ok(await advanceRun(f.store, request)).record.value.state as unknown as { phase: string; step?: { action: string; series: string } };
    if (state.phase === "step" && state.step!.action === "packet" && state.step!.series.includes("garden-consume-block")) break;
  }
  const sends = f.sent().length;
  // The owner addresses the other question in B1 before the block's first dispatch: its required input is replaced.
  const current = f.store.get(`om-input:${project}`)!;
  ok(writeAddressing(f.store, { project, input: reference(current), graph: f.graph, decisions: [{ pending: structuredClone(inputDecisionWrite({
    project, input: reference(current), graph: f.graph, layers: [], decision: { target: "discovery:spare", field: "address",
      value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write }] }));
  // The saved packet is refused by its own producer (its input is stale), without a send; the next choice ends the
  // assignment by the proved cause instead of retrying it.
  const refused = await drive(f, request, 5);
  assert.deepEqual(refused.performed, ["packet"]);
  assert.equal(refused.wait.code, "input_stale");
  const driven = await drive(f, request, 20);
  assert.ok(driven.performed.includes("cease"), `${driven.performed.join(",")} ${JSON.stringify(driven.wait)}`);
  assert.equal(f.sent().length, sends, "The ended assignment is never sent");
  assert.ok(f.store.list().some(row => row.kind === "om-completion-cessation"), "The proved cessation is its own record");
});

test("H1.2 R7 C25 an owner-control whose question is no longer open holds nothing: the line's work on today's question goes on", async t => {
  const f = runFixture(t, ["encoding"], true, true);
  const request = f.request(f.bases("h12-resolved"));
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h12-resolved", predecessor: null, basis: null }));
  // The earlier attempt asked the owner about a question that today's routes no longer carry (it was decided elsewhere).
  ok(beginAttempt(f.store, { ...address, attempt: 1, goal: { key: "h12-gone-goal", questions: [gapLineKey(project, "discovery:gone", "answer")], result: "A supported fact" } }));
  ok(closeAttempt(f.store, { ...address, attempt: 1, outcome: { reason: "awaiting-owner", accepting: [], cancelling: [], refusals: [] } }));
  ok(startRun(f.store, { project }));
  const driven = await driveTo(f, request, "open", 10);
  assert.deepEqual(driven.performed, ["open"], "A new attempt of the line opens for today's question; the old one holds nothing");
  assert.equal(blockSeries(f).value.attempts.length, 2);
  assert.notEqual(ok(readRun(f.store, { project }))!.value.state.phase, "unable");
});

test("H1.2 R6 R7 C32 a standing hold and the goal's own owner-control are both grounds: each is named once with its own records, and nothing else is paid", async t => {
  const f = runFixture(t, ["encoding"], true, true);
  const b = f.bases("h12-hold-owed"), request = f.request(b);
  const item = f.store.get<RoutesRecord>(b.routes.id, b.routes.revision)!.value.batches.find(row => row.model === "MC1")!.items[0]!;
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h12-hold-owed", predecessor: null, basis: null }));
  // Attempt 1 of the earlier mode asked the owner about today's very question; attempt 2 was refused with a refusal of unknown origin.
  ok(beginAttempt(f.store, { ...address, attempt: 1, goal: { key: "h12-owed-goal", questions: [gapLineKey(project, item.target, item.field)], result: "A supported fact" } }));
  ok(closeAttempt(f.store, { ...address, attempt: 1, outcome: { reason: "awaiting-owner", accepting: [], cancelling: [], refusals: [] } }));
  const goal = { key: "h12-hold-goal", questions: ["Address one contract"], result: "A supported contract" };
  ok(beginAttempt(f.store, { ...address, attempt: 2, goal }));
  const source = f.store.write({ id: `${unitRefusalNamespace(project)}h12-owed-origin`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: { gate: "G3", refusals: [{ code: "unrecognized_fixture_refusal", goal: goal.key, remedy: "Identify the exact origin",
      origin: { name: "artifact_missing", stage: "layer-check", subject: "artifact:fixture", sources: [] } }] } });
  const row = ok(recordRefusal(f.store, { project, source: reference(source) })).value.rows.find(entry => entry.source.id === source.id)!;
  const closed = ok(closeAttempt(f.store, { ...address, attempt: 2, outcome: { reason: "refused", accepting: [], cancelling: [],
    refusals: [{ row: row.id, name: row.code, goal: row.goal }] } }));
  assert.equal(closed.holds.length, 1, "G7 raised the hold of an unknown origin");
  f.steps([{ research: { protocol: "omg-stop-analysis/v1", cause: null, change: null, origin: null }, usage }]);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 10);
  const series = blockSeries(f), reasons = reasonsOf(end.state);
  assert.deepEqual(end.performed, ["analyze"], "Only the review of the hold was paid");
  assert.deepEqual(reasons.map(entry => [entry.kind, entry.code, entry.target, entry.field]), [
    ["hold-origin-unestablished", "origin_hold", closed.holds[0]!.id, "hold"],
    ["owner-control", "awaiting_owner", series.id, "attempt.1"]]);
  assert.equal(f.sent().length, 1);
});

test("H1.2 R6 R6a 12 21 H1 stop and origin holds together: the origin route goes first (A6 on the exact hold), no attempt opens, an unestablished origin ends the pass without paying the other holds or the stop", async t => {
  const f = runFixture(t, ["encoding"], true, true);
  const request = f.request(f.bases("h1-hold"));
  // Three earlier standalone attempts of the block were refused with a refusal of unknown origin: A3 stopped the
  // series and G7 raised a hold for each (the earlier mode, read by its own contract).
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h1-hold", predecessor: null, basis: null }));
  const goal = { key: "h1-hold-goal", questions: ["Address one contract"], result: "A supported contract" };
  const holds: Ref[] = [];
  for (const attempt of [1, 2, 3]) {
    ok(beginAttempt(f.store, { ...address, attempt, goal }));
    const source = f.store.write({ id: `${unitRefusalNamespace(project)}h1-origin-${attempt}`, kind: UNIT_REFUSAL_KIND, expected: 0,
      value: { gate: "G3", refusals: [{ code: "unrecognized_fixture_refusal", goal: goal.key, remedy: "Identify the exact origin",
        origin: { name: "artifact_missing", stage: "layer-check", subject: `artifact:fixture-${attempt}`, sources: [] } }] } });
    const journal = ok(recordRefusal(f.store, { project, source: reference(source) }));
    const row = journal.value.rows.find(item => item.source.id === source.id)!;
    const closed = ok(closeAttempt(f.store, { ...address, attempt, outcome: { reason: "refused", accepting: [], cancelling: [],
      refusals: [{ row: row.id, name: row.code, goal: row.goal }] } }));
    holds.push(...closed.holds);
  }
  assert.ok(blockSeries(f).value.stop, "A3 stopped the series");
  assert.ok(holds.length > 0, "G7 raised the origin holds");
  f.steps([{ research: { protocol: "omg-stop-analysis/v1", cause: null, change: null, origin: null }, usage }]);
  ok(startRun(f.store, { project }));
  const driven = await ends(f, request, 10);
  assert.deepEqual(driven.performed, ["analyze"], "The origin route first; nothing else of the line is paid once a hold stands unlifted");
  const reasons = reasonsOf(driven.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.field]), [["hold-origin-unestablished", "origin_hold", "hold"]]);
  assert.ok(holds.some(hold => hold.id === reasons[0]!.target), "The reason names the exact hold");
  const analyses = f.store.list().filter(row => row.kind === "om-origin-analysis");
  assert.equal(analyses.length, 1, "R6a: the other holds and the stop are not reviewed just to fill the report");
  assert.equal((analyses[0]!.value as { state: string }).state, "origin-unestablished");
  assert.ok(reasons[0]!.basis.some(ref => ref.id === analyses[0]!.id), "The review of this very hold is a Ref of the reason");
  assert.equal(blockSeries(f).value.attempts.length, 3, "No new attempt while the stop and the hold stand");
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
  assert.deepEqual(f.store.list().map(reference), before, "The saved end is read, not paid again");
  assert.equal(f.sent().length, sends);
});

test("29 H1 a pass record that lost a required saved field is an integrity refusal: nothing is chosen, sent or written", async t => {
  const f = runFixture(t);
  const request = f.request(f.bases("h1-29"));
  ok(startRun(f.store, { project }));
  await until(f, request, "open-series");
  const head = f.store.get<RunRecord>(runId(project))!;
  const lost = structuredClone(head.value) as unknown as { state: { step: Record<string, unknown> } };
  delete lost.state.step.request;
  f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: lost as unknown as Json });
  const before = f.store.list().map(reference);
  assert.equal(refusal(await advanceRun(f.store, request)).code, "run_record_invalid");
  assert.equal(refusal(readRun(f.store, { project })).code, "run_record_invalid");
  assert.deepEqual(f.store.list().map(reference), before, "The saved step is not guessed from the last head");
  assert.equal(f.store.list("repair-series").length, 0);
  assert.equal(f.sent().length, 0);
});

/** A store whose process is lost right when the received answer is applied (the write after the receipt). */
class LostApplication extends Store {
  armed = true;
  override writeMany<T = Json>(inputs: Write[], guards: Parameters<Store["writeMany"]>[1] = []): Revision<T>[] {
    if (this.armed && inputs.some(item => item.kind === "model-call" && (item.value as { om?: { application?: string } } | null)?.om?.application === "applied")) {
      this.armed = false;
      throw new Error("The process was lost after the receipt, before the application");
    }
    return super.writeMany<T>(inputs, guards);
  }
}

test("5 4 H1 an answer received before a lost process is applied by the same saved step after restart, without a second send", async t => {
  const f = runFixture(t);
  const b = f.bases("h1-5"), request = f.request(b);
  f.steps([addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const cycling = await until(f, request, "cycle");
  f.restart(path => new LostApplication(path));
  await assert.rejects(advanceRun(f.store, request), /lost after the receipt/);
  assert.equal(f.sent().length, 1, "The adapter answered once");
  const call = f.store.list().find(row => row.kind === "model-call")!;
  assert.notEqual((call.value as { om?: { application?: string } }).om?.application, "applied");
  f.restart();
  const resumed = ok(await advanceRun(f.store, request));
  assert.deepEqual(resumed.performed, cycling, "The saved request is performed, not a new choice");
  assert.equal(f.sent().length, 1, "The saved receipt is applied without a second send");
  assert.equal((f.store.get(call.id)!.value as { om: { application: string } }).om.application, "applied");
});

test("13 H1 technical outcomes are closed by G7 with their proved reason; the next attempt opens only after the previous one is closed", async t => {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("h1-13"), request = f.request(b);
  f.steps([{ research: { invalid: true }, usage }, { rawStdout: "{broken", exitCode: 7 }, addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const driven = await driveTo(f, request, "bases", 40);
  const attempt = ["open", "packet", "cycle", "close"];
  assert.deepEqual(driven.performed, ["open-series", ...attempt, ...attempt, ...attempt, "bases"], JSON.stringify(driven.wait));
  assert.deepEqual(mechanismSeries(f).value.attempts.map(row => row.outcome?.reason), ["off-form", "interrupted", "result"]);
  assert.equal(f.sent().length, 3);
});

test("C11 3 H1 a standalone open attempt of the earlier mode is not adopted: the pass waits on it, opens no next ordinal, and works independent owners", async t => {
  const f = runFixture(t, ["encoding"], true, true);
  const request = f.request(f.bases("h1-c11"));
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h1-standalone", predecessor: null, basis: null }));
  ok(beginAttempt(f.store, { ...address, attempt: 1, goal: { key: "h1-standalone", questions: ["Address one contract"], result: "A supported contract" } }));
  ok(startRun(f.store, { project }));
  const driven = await drive(f, request, 6);
  assert.deepEqual(driven.performed, [], "No binding is attached later and no next ordinal is opened");
  assert.equal(driven.wait.code, "standalone_attempt");
  assert.equal(driven.wait.target, blockSeries(f).id);
  assert.equal(blockSeries(f).value.attempts.length, 1);
  assert.equal(f.sent().length, 0);
});

/**
 * Performs one saved physical step in a separate process that is lost right after the durable physical claim, before
 * the adapter is launched (the reviewer's probe of №1766 п.1).
 */
function lostAfterClaim(f: Fixture, step: { action: string; request: unknown }) {
  const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = `import { readFileSync } from "node:fs";
import { Store } from ${url("../src/storage/store.js")};
import { runModelCycle } from ${url("../src/om/model-call.js")};
import { assessFact } from ${url("../src/om/assessment.js")};
const { database, action, request } = JSON.parse(readFileSync(process.argv[1], "utf8"));
const store = new Store(database), write = store.writeMany.bind(store);
store.writeMany = (writes, guards) => {
  const result = write(writes, guards);
  if (writes.some(item => item.kind === "model-call" && item.value.status === "running")) { store.close(); process.exit(0); }
  return result;
};
await (action === "cycle" ? runModelCycle : assessFact)(store, request);
throw new Error("The claim was not reached");`;
  const args = join(f.root, `lost-${step.action}.json`);
  writeFileSync(args, JSON.stringify({ database: f.database, action: step.action, request: step.request }));
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, args], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
}

test("4 9 C21 C22 C25 H1 a lost E4 executor after its claim is recovered by the common recovery; the same saved cycle goes on without a send", async t => {
  const f = runFixture(t);
  const b = f.bases("h1-lost"), request = f.request(b);
  f.steps([addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const cycling = await until(f, request, "cycle");
  lostAfterClaim(f, cycling);
  const running = f.store.list().find(row => row.kind === "model-call" && (row.value as { om?: unknown }).om)!;
  assert.equal((running.value as { status: string }).status, "running");
  assert.equal(f.sent().length, 0, "The lost process never reached the adapter");
  // The saved cycle is performed again: the common recovery proves the loss and the cycle reads the recovered call.
  const resumed = ok(await advanceRun(f.store, request));
  assert.deepEqual(resumed.performed, cycling);
  assert.equal(resumed.record.value.state.phase, "ready");
  const recovered = f.store.get(running.id)!.value as { status: string; error: string; om: { application: string } };
  assert.deepEqual([recovered.status, recovered.error, recovered.om.application], ["failed", "process_lost", "recovered"]);
  assert.equal(f.sent().length, 0, "Recovery sends nothing");
  const cycles = f.store.list().filter(row => row.kind === "om-model-cycle").length;
  const driven = await driveTo(f, request, "bases", 20);
  assert.deepEqual(mechanismSeries(f).value.attempts.map(row => row.outcome?.reason), ["interrupted", "result"],
    `${driven.performed.join(",")} ${JSON.stringify(driven.wait)}`);
  assert.equal(driven.performed.filter(action => action === "cycle").length, 1, "Only the next attempt cycles; the recovered one is not re-sent");
  assert.equal(f.store.list().filter(row => row.kind === "om-model-cycle").length, cycles + 1);
  assert.equal(f.sent().length, 1);
});

test("4 9 C21 H1 a lost assessor after its claim is recovered the same way: the saved assessment reads its recovered transport, no second intent", async t => {
  const f = runFixture(t, ["encoding"], true, true);
  const b = f.bases("h1-lost-e5"), request = f.request(b);
  f.steps([factsAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const assessing = await until(f, request, "assess", 20);
  const sends = f.sent().length;
  lostAfterClaim(f, assessing);
  assert.equal(f.sent().length, sends, "The lost assessor never reached the adapter");
  const intents = f.store.list().filter(row => row.kind === "om-assessment-intent").length;
  const resumed = ok(await advanceRun(f.store, request));
  assert.deepEqual(resumed.performed, assessing);
  assert.equal(resumed.record.value.state.phase, "ready", JSON.stringify(resumed.record.value.state));
  const terminal = f.store.get(resumed.products[0]!.id)!.value as { verdict: string };
  assert.equal(terminal.verdict, "interrupted", "The recovered assessor is a technical terminal, not a new call");
  assert.equal(f.store.list().filter(row => row.kind === "om-assessment-intent").length, intents);
  assert.equal(f.sent().length, sends);
});

/**
 * Performs one saved A6 step in a separate process that stops itself right after the durable physical claim, before
 * the adapter is launched: its executor is alive until the returned release kills it (the reviewer's probe of №1814).
 */
async function heldAfterClaim(t: { after(fn: () => void): void }, f: Fixture, step: { action: string; request: unknown }) {
  const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = `import { readFileSync } from "node:fs";
import { Store } from ${url("../src/storage/store.js")};
import { runStopAnalysis } from ${url("../src/om/stop-analysis.js")};
const { database, request } = JSON.parse(readFileSync(process.argv[1], "utf8"));
const store = new Store(database), write = store.writeMany.bind(store);
store.writeMany = (writes, guards) => {
  const result = write(writes, guards);
  if (writes.some(item => item.kind === "model-call" && item.value.status === "running")) { process.send({ claimed: true }); process.kill(process.pid, "SIGSTOP"); }
  return result;
};
await runStopAnalysis(store, request);
throw new Error("The claim was not reached");`;
  const args = join(f.root, `held-${step.action}.json`);
  writeFileSync(args, JSON.stringify({ database: f.database, request: step.request }));
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, args], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk; });
  t.after(() => { child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  const early = exited.then(([code]) => { throw new Error(`The held executor exited (${code}) before its claim: ${stderr}`); });
  early.catch(() => undefined);
  assert.deepEqual(await Promise.race([once(child, "message").then(([message]) => message), early]), { claimed: true });
  return async () => { child.kill("SIGKILL"); await exited; };
}
/** The live-executor wait, its proven loss, the same Environment configured again (a new revision) and a restart. */
async function a6Survives(t: { after(fn: () => void): void }, f: Fixture, request: RunRequest, analyzing: { action: string; request: unknown }, next: () => RunRequest) {
  const release = await heldAfterClaim(t, f, analyzing);
  const held = ok(await advanceRun(f.store, request));
  const wait = (held.record.value.state as { wait?: { code: string; target: string } }).wait;
  assert.equal(wait?.code, "model_call_still_running", "A live executor keeps holding the dispatch");
  const call = wait.target, sends = f.sent().length;
  const intents = f.store.list().filter(row => row.kind === "om-analysis-intent").map(reference);
  assert.equal(intents.length, 1);
  await release();
  const configured = f.store.get(`environment:${project}`)!.revision;
  f.environment(); f.restart();
  const current = next();
  assert.equal(current.dispatch.config.revision, configured + 1, "The same values configured again are a new Environment revision");
  // The saved A6 step goes on with its own request — the original dispatch — and the common recovery proves the loss.
  const resumed = ok(await advanceRun(f.store, current));
  assert.deepEqual(resumed.performed, analyzing, "The exact saved A6 step, never one rebuilt with today's dispatch");
  const lost = f.store.get<{ status: string; error: string }>(call)!.value;
  assert.deepEqual([lost.status, lost.error], ["failed", "process_lost"]);
  // Its producer keeps its own current-admission guard: the original dispatch names the earlier Environment.
  const stale = (resumed.record.value.state as { wait?: { code: string; target: string } }).wait;
  assert.deepEqual([stale?.code, stale?.target], ["input_stale", `environment:${project}`], JSON.stringify(resumed.record.value.state));
  assert.equal(f.sent().length, sends, "Nothing is sent again");
  assert.deepEqual(f.store.list().filter(row => row.kind === "om-analysis-intent").map(reference), intents, "No second intent");
  const before = f.store.list().map(reference);
  assert.equal(ok(await advanceRun(f.store, current)).performed, null);
  assert.deepEqual(f.store.list().map(reference), before, "The standing refusal is read, not paid again");
}

test("4 9 17 21 C21 №1814 H1 A6 on a stop keeps its saved request through a live executor, its loss, a new Environment revision and a restart", async t => {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("h1-a6-stop"), request = f.request(b);
  const none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const analyzing = await until(f, request, "analyze", 50);
  assert.equal((analyzing.request as { hold: unknown }).hold, null, "A6 reviews the stop");
  await a6Survives(t, f, request, analyzing, () => f.request(b));
  assert.equal(f.sent().length, 3, "Only the three M5 attempts were ever sent");
});

test("4 9 12 21 C21 №1814 H1 A6 on an origin hold keeps its saved request through a live executor, its loss, a new Environment revision and a restart", async t => {
  const f = runFixture(t, ["encoding"], true, true);
  const b = f.bases("h1-a6-hold"), request = f.request(b);
  // Three earlier standalone attempts refused with a refusal of unknown origin: A3 stopped the series, G7 raised holds.
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h1-a6-hold", predecessor: null, basis: null }));
  const goal = { key: "h1-a6-hold-goal", questions: ["Address one contract"], result: "A supported contract" };
  for (const attempt of [1, 2, 3]) {
    ok(beginAttempt(f.store, { ...address, attempt, goal }));
    const source = f.store.write({ id: `${unitRefusalNamespace(project)}h1-a6-origin-${attempt}`, kind: UNIT_REFUSAL_KIND, expected: 0,
      value: { gate: "G3", refusals: [{ code: "unrecognized_fixture_refusal", goal: goal.key, remedy: "Identify the exact origin",
        origin: { name: "artifact_missing", stage: "layer-check", subject: `artifact:fixture-${attempt}`, sources: [] } }] } });
    const journal = ok(recordRefusal(f.store, { project, source: reference(source) }));
    const row = journal.value.rows.find(item => item.source.id === source.id)!;
    ok(closeAttempt(f.store, { ...address, attempt, outcome: { reason: "refused", accepting: [], cancelling: [],
      refusals: [{ row: row.id, name: row.code, goal: row.goal }] } }));
  }
  ok(startRun(f.store, { project }));
  const analyzing = await until(f, request, "analyze", 10);
  assert.ok((analyzing.request as { hold: unknown }).hold !== null, "A6 reviews the exact hold first");
  await a6Survives(t, f, request, analyzing, () => f.request(b));
  assert.equal(f.sent().length, 0);
});

/** The MC2 answer that addresses nothing for the exact saved packet: the node root ends by its proved terminal. */
function nodeRefusal(f: { store: Store }, step: { request: unknown }) {
  const saved = (step.request as { packet: Ref }).packet;
  const packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
  const questions = (packet.value.packet as unknown as { questions: { id: string }[] }).questions.map(row => row.id);
  return { research: { protocol: "omg-answer/v2", requestId: "$requestId", questionIds: questions, action: "cannot_answer",
    reason: "The requested information is unavailable" }, usage };
}

test("25 11 R2 №1770 H1 an N2 root that ended without assembly closes its own attempt through G7: no candidate, C5 or D2, no waiting for the frame", async t => {
  const f = runFixture(t, [], false);
  const b = f.bases("h1-negative"), request = f.request(b);
  ok(startRun(f.store, { project }));
  const a1 = await until(f, request, "cycle");
  f.steps([nodeRefusal(f, a1)]);
  for (let index = 0; index < 20 && f.store.get<RepairSeries>(a1.series!)!.value.attempts[0]!.outcome === null; index++) {
    const advanced = ok(await advanceRun(f.store, request));
    if (advanced.record.value.state.phase === "waiting") assert.fail(JSON.stringify(advanced.record.value.state));
    if (advanced.performed) f.restart();
  }
  assert.equal(f.store.get<RepairSeries>(a1.series!)!.value.attempts[0]!.outcome!.reason, "refused");
  assert.deepEqual(actions(f.store).slice(-3), ["cycle", "evaluate", "close"]);
  assert.ok(!actions(f.store).some(action => ["candidate", "accept", "lines", "confirm"].includes(action)),
    "A negative close needs no candidate, C5 or D2");
  assert.equal(f.sent().length, 1);
});

test("25 R4 №1770 H1 N2 mixed: A's assembly waits open for the frame; B's negative attempt closes by its own G7 meanwhile, nothing is paid twice", async t => {
  const f = runFixture(t, [], false);
  const b = f.bases("h1-mixed"), request = f.request(b);
  ok(startRun(f.store, { project }));
  const a1 = await until(f, request, "cycle");
  const answers: unknown[] = [nodeAnswer(f, a1)];
  f.steps(answers as Record<string, unknown>[]);
  const b1 = await until(f, request, "cycle", 30);
  assert.notEqual(b1.series, a1.series, "A waits for the frame; the independent block is worked");
  answers.push(nodeRefusal(f, b1)); f.steps(answers as Record<string, unknown>[]);
  for (let index = 0; index < 20 && f.store.get<RepairSeries>(b1.series!)!.value.attempts[0]!.outcome === null; index++) {
    const advanced = ok(await advanceRun(f.store, request));
    if (advanced.record.value.state.phase === "waiting") assert.fail(JSON.stringify(advanced.record.value.state));
  }
  assert.equal(f.store.get<RepairSeries>(b1.series!)!.value.attempts[0]!.outcome!.reason, "refused", "B's negative attempt closed while A waited");
  assert.equal(f.store.get<RepairSeries>(a1.series!)!.value.attempts[0]!.outcome, null, "A kept its one open attempt and its assembly");
  assert.ok(!actions(f.store).some(action => ["accept", "confirm"].includes(action)), "No C5 and no D2 without the filled frame");
  assert.equal(f.sent().length, 2, "A1 and B1 — nothing paid twice");
});

test("R10 H1.1 a saved step is performed by its own request when the bases have changed meanwhile: no build, cycle or ordinal comes first", async t => {
  const f = runFixture(t);
  const b = f.bases(), request = f.request();
  f.steps([addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const cycling = await until(f, request, "cycle");
  // Meanwhile B1 changes (a lawful D3 decision of another producer): the machine bases of new work are no longer these.
  const input = f.store.get(`om-input:${project}`)!, graph = reference(f.store.get(`graph:${project}`)!);
  ok(writeAddressing(f.store, { project, input: reference(input), graph, decisions: [{ pending: structuredClone(inputDecisionWrite({ project,
    input: reference(input), graph, layers: [], decision: { target: "discovery:spare", field: "address",
      value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write }] }));
  assert.equal(ok(prepareRunBases(f.store, { project })).state, "missing");
  const cycles = f.store.list().filter(row => row.kind === "om-model-cycle").length;
  const performed = ok(await advanceRun(f.store, request));
  assert.deepEqual(performed.performed, cycling, "The saved cycle keeps its exact request");
  // The producer keeps its own current admission: the packet stands on the earlier B1, so the saved cycle is refused
  // there and nothing is sent — the refusal is its outcome, not a rebuilt request.
  const state = performed.record.value.state;
  assert.deepEqual(state.phase === "waiting" && [state.wait.code, state.wait.target], ["input_stale", `om-input:${project}`]);
  assert.equal(f.store.list().filter(row => row.kind === "om-model-cycle").length, cycles);
  assert.equal(f.sent().length, 0);
  assert.ok(!actions(f.store).includes("bases"), "No build came before the saved step");
  assert.equal(mechanismSeries(f).value.attempts.length, 1, "No new ordinal");
});

/** Advances the pass, recording performed actions, until the predicate holds for the saved state; a wait fails the test. */
async function driveUntil(f: Fixture, request: RunRequest, until: (state: RunRecord["state"], trail: string[]) => boolean, bound = 40, restartAfter: string[] = []) {
  const trail: string[] = [];
  for (let index = 0; index < bound; index++) {
    const advanced = ok(await advanceRun(f.store, request)), state = advanced.record.value.state;
    if (advanced.performed) {
      trail.push(advanced.performed.action);
      if (restartAfter.includes(advanced.performed.action)) f.restart();
    }
    if (until(state as unknown as RunRecord["state"], trail)) return { trail, state: state as unknown as RunRecord["state"] };
    if (state.phase === "waiting") assert.fail(`${trail.join(",")}: ${JSON.stringify(state.wait)}`);
  }
  assert.fail(`The pass did not get there within ${bound} transitions`);
}
const gapHeads = (store: Store) => store.list().filter(row => row.id.startsWith("om-gap:")).map(reference);

test("25 R20 №1937-1 №1860-5 H1.1 managed N2: while the first participant waits for the frame, the missing one is registered and activated by B3 of the same issue and paid; the first keeps its scope", async t => {
  const f = runFixture(t, [], false);
  // The managed era began with an activation of the producing block's root only; the consuming root does not exist yet.
  ok(openSeries(f.store, { project, block: "garden-produce-block", line: 1, slice: "h11-initial", predecessor: null, basis: null }));
  f.activate("h11-initial", { features: [{ outcome: "garden-result" }], excluded: [] });
  const request = f.request(f.bases());
  const first = await until(f, request, "cycle", 40);
  f.steps([nodeAnswer(f, first)]);
  const d1 = gapHeads(f.store), done = actions(f.store).length;
  const reached = await driveUntil(f, request, state => state.phase === "step" && state.step.action === "cycle" && state.step.series !== first.series);
  assert.deepEqual(actions(f.store).slice(done), ["cycle", "open-series", "bases", "open", "register", "packet"],
    "The first pays and waits; the missing root is registered, activated by B3 of the same issue, and opens its own work");
  assert.equal(reached.state.phase, "step");
  const consume = blockSeries(f, "garden-consume-block");
  assert.deepEqual([(consume.value as { activation?: { state: string; participation: string } }).activation?.state,
    (consume.value as { activation?: { participation: string } }).activation?.participation], ["activated", "active"]);
  const produce = blockSeries(f, "garden-produce-block");
  assert.deepEqual(produce.value.attempts.map(attempt => attempt.outcome), [null], "The first participant keeps its one open attempt");
  assert.deepEqual(gapHeads(f.store), d1, "No D1 head moved under the waiting participant");
  ok(await advanceRun(f.store, request));
  assert.equal(f.sent().length, 2, "The missing participant is actually paid");
});

test("25 R8 R20 №1937-2 №1860-8 H1.1 managed N2 after C5: completion bases serve both D2 and G7 through second stores, with no B3 before the group is closed; S1.2 №1961-4 then the common B3 of the new slices and the first L3 step on the joint base, nothing paid again", async t => {
  const f = runFixture(t, [], false);
  for (const block of ["garden-produce-block", "garden-consume-block"])
    ok(openSeries(f.store, { project, block, line: 1, slice: "h11-initial", predecessor: null, basis: null }));
  f.activate("h11-initial", { features: [{ outcome: "garden-result" }], excluded: [] });
  const request = f.request(f.bases());
  const first = await until(f, request, "cycle", 40);
  const answers = [nodeAnswer(f, first)];
  f.steps(answers);
  const second = await until(f, request, "cycle", 40);
  answers.push(nodeAnswer(f, second));
  f.steps(answers);
  await until(f, request, "accept", 40);
  assert.equal(ok(await advanceRun(f.store, request)).performed?.action, "accept");
  f.restart();
  const applied = f.store.list("om-series-applied").length, transitions = f.store.list("series-transition").length;
  const pointer = reference(f.store.get(`om-series-current:${project}`)!);
  const closed = await driveUntil(f, request, (_state, trail) => trail.filter(action => action === "close").length === 2, 30, ["bases", "confirm"]);
  assert.deepEqual(closed.trail, ["bases", "confirm", "close", "confirm", "close"], "The group's own D2 and G7 on completion bases: no attempt_running");
  // The completion bases admit no new work: no transition, no activation, the pointer stays while the group closes.
  assert.equal(f.store.list("series-transition").length, transitions);
  assert.equal(f.store.list("om-series-applied").length, applied);
  assert.deepEqual(reference(f.store.get(`om-series-current:${project}`)!), pointer);
  for (const block of ["garden-produce-block", "garden-consume-block"])
    assert.equal(blockSeries(f, block).value.attempts.at(-1)!.outcome!.reason, "result", block);
  // ---- S1.2 (№1961-4): on the joint base the same pass goes on past the closed group ----
  // The common B3 of the new slices — P over both current lines, its G2 issuance and the activation, each by its own
  // producer, inside the pass's own bases step — then the lawful first L3 step of new work on the line that activation
  // made, through a second store after the activation. The accepted N2 stays the exact basis of the new issue, both
  // participants are named by their exact revisions, the closed attempts stay closed and nothing is paid again.
  const paid = f.sent().length, acceptances = f.store.history(`om-frame:${project}:2`).length;
  const roots = ok(readSeriesMembership(f.store, { project })).value.roots;
  const blocks = ["garden-consume-block", "garden-produce-block"];
  const previous = blocks.map(block => reference(f.store.get(`repair-series:${project}:1:${block}`)!));
  const l3 = await driveUntil(f, request, state => state.phase === "step" && state.step.action === "cycle", 30, ["bases"]);
  assert.deepEqual(l3.trail, ["bases", "open", "register", "obligations", "packet"],
    "One B3 of the new slices inside the pass's own bases, then the first L3 work opens on the line it activated: no second bases, no open-series");
  const built = ok(prepareRunBases(f.store, { project }));
  if (built.state !== "ready") assert.fail("The bases over the accepted N2 are current");
  assert.deepEqual(ok(readHorizon(f.store, project, built.built.bases.horizon)).horizon.value.request.refinement,
    reference(f.store.get(`graph-layer:${project}:2`)!), "The new issue stands on the accepted N2 layer");
  // The activation the pointer names is of this very issue, over the complete registered membership, by exact revisions.
  assert.notDeepEqual(reference(f.store.get(`om-series-current:${project}`)!), pointer, "The pointer moved to the new activation");
  const current = ok(readCurrentSeriesPointer(f.store, { project })).value;
  const activation = ok(readAppliedSeriesTransition(f.store, { project, record: current.applied })).value;
  const plan = ok(readPreparedSeriesTransition(f.store, { project, record: activation.prepared })).record.value;
  assert.deepEqual(plan.request.horizon, built.built.bases.horizon, "P names the horizon of the pass's own new issue");
  // The producer normalizes its series by the canonical form of the whole Ref (hash included), so the lawful order of
  // the two lines depends on the fixture's hashes: the set is compared through the same sorting of copies (№2347).
  const byCanonical = (a: Ref, b: Ref) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0;
  assert.equal(plan.request.series.length, previous.length, "P names exactly the two current lines");
  assert.deepEqual([...plan.request.series].sort(byCanonical), [...previous].sort(byCanonical), "P covers both current lines at their exact revisions");
  assert.deepEqual(activation.decisions.map(row => [row.block, row.participation, row.outcome]),
    blocks.map(block => [block, "active", "new-work"]), "Both participants are active on their new slices");
  assert.deepEqual(activation.roots, roots, "The registered membership is the same");
  assert.equal(f.store.list("series-transition").length, transitions + 1, "One P");
  assert.equal(f.store.list("om-series-applied").length, applied + 1, "One activation");
  for (const [index, block] of blocks.entries()) {
    // The new line of each block stands on its exact previous line; the pointer names the new line's activation revision.
    const next = f.store.get<RepairSeries>(`repair-series:${project}:2:${block}`)!;
    assert.deepEqual(next.value.predecessor, previous[index], block);
    assert.deepEqual(current.series.find(row => row.block === block), { block, activation: reference(f.store.get(next.id, 1)!), participation: "active" }, block);
    assert.deepEqual(f.store.get<RepairSeries>(previous[index]!.id)!.value.attempts.map(attempt => attempt.outcome?.reason), ["result"], `${block}: the closed attempt of line 1 stays closed`);
  }
  // The first L3 step: the produce block's new line (first in M3), on a level-3 batch of these bases — chosen, not yet paid.
  const step = l3.state.phase === "step" ? l3.state.step : assert.fail("A saved step");
  assert.equal(step.series, `repair-series:${project}:2:garden-produce-block`);
  assert.deepEqual(f.store.get<RepairSeries>(step.series!)!.value.attempts.map(attempt => attempt.outcome), [null], "One open attempt on the new line");
  const saved = (step.request as unknown as { packet: Ref }).packet, packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
  assert.deepEqual(packet.value.request.routes, built.built.bases.routes, "The L3 packet stands on the routes of the new bases");
  const batch = f.store.get<RoutesRecord>(built.built.bases.routes.id, built.built.bases.routes.revision)!.value.batches.find(row => row.id === packet.value.request.batch)!;
  assert.deepEqual([batch.task, batch.level, batch.node], ["node-expansion", 3, "garden-h1-operation-garden-produce-block"]);
  assert.equal(f.sent().length, paid, "Nothing was paid again: the L3 call is chosen, not yet made");
  assert.equal(f.store.history(`om-frame:${project}:2`).length, acceptances, "One common acceptance");
  // A new store finds the same saved step on the same bases: the build repeated with the open attempt named writes
  // nothing — no second P, issuance or activation — and nothing is sent again.
  f.restart();
  assert.deepEqual(ok(readRun(f.store, { project }))!.value.state, l3.state);
  const heads = f.store.list().map(reference);
  assert.deepEqual(ok(writeRunBases(f.store, { project }, { open: [step.series!] })).bases, built.built.bases);
  assert.deepEqual(f.store.list().map(reference), heads, "The repeated build found its bases and wrote nothing");
  assert.equal(f.sent().length, paid);
  // The exact references P stands on read the same however its nested proofs are served (№2329): cold on this store,
  // hot inside one operation (replayed from the operation's own proofs), warmed by the nested readers before the
  // collector attaches (replayed from kept proofs), and again on a new store.
  const readPlan = () => ok(readPreparedSeriesTransition(f.store, { project, record: activation.prepared }));
  const cold = readPlan();
  assert.deepEqual(cold.record.value, plan);
  const hot = withHistoricalReads(() => { readPlan(); return readPlan(); });
  const warmed = withHistoricalReads(() => {
    ok(readHorizon(f.store, project, plan.request.horizon));
    for (const ref of plan.request.series) ok(readAnySeriesAt(f.store, project, ref));
    return readPlan();
  });
  assert.deepEqual(hot, cold); assert.deepEqual(warmed, cold);
  f.restart();
  assert.deepEqual(readPlan(), cold);
});

test("R19 №1937-3 H1.1 a second store opening work between the saved bases step's admission and its write: the step is refused, D1 does not move", async t => {
  const f = runFixture(t);
  const b = f.bases(), request = f.request();
  f.steps([addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  await driveUntil(f, request, state => state.phase === "step" && state.step.action === "bases");
  // A registered root without attempts exists; a second store begins its attempt right before the build moves G2.
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h11-race", predecessor: null, basis: null }));
  const d1 = gapHeads(f.store), horizons = f.store.list("om-horizon").length;
  let raced = false;
  class Race extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-horizon")) {
        raced = true;
        const other = new Store(f.database);
        try { ok(beginAttempt(other, { ...address, attempt: 1, goal: { key: "h11-raced", questions: ["Hold the area"], result: "A held area" } })); }
        finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new Race(path));
  const advanced = ok(await advanceRun(f.store, request)), state = advanced.record.value.state;
  assert.ok(raced);
  assert.equal(advanced.performed?.action, "bases");
  assert.deepEqual(state.phase === "waiting" && [state.wait.code, state.wait.target], ["run_bases_work_open", `repair-series:${project}:1:garden-consume-block`]);
  assert.deepEqual(gapHeads(f.store), d1, "The losing build moved no D1 head");
  assert.equal(f.store.list("om-horizon").length, horizons);
});

// ---- H1.5 (№2164, №2166): a batch whose answer no producer serves is not paid for ----

/** Addresses questions of B1 the way M5 would, in one D3 write, so the pass meets them as addressed predecessor questions. */
function addressQuestions(f: Fixture, rows: readonly (readonly [id: string, kind: string, consumer?: string])[]) {
  const input = f.store.get(`om-input:${project}`)!;
  ok(writeAddressing(f.store, { project, input: reference(input), graph: f.graph, decisions: rows.map(([id, kind, consumer]) => ({
    pending: structuredClone(inputDecisionWrite({ project, input: reference(input), graph: f.graph, layers: [], decision: { target: `discovery:${id}`,
      field: "address", value: { consumer: consumer ?? "garden-consume-block", kind } } })) as Write })) }));
}
const answerBatch = (routes: RoutesRecord) => routes.batches.find(batch => batch.model === "MC2" && batch.task === "input-field"
  && batch.items.some(item => item.target === "discovery:spare" && item.field === "answer"))!;

test("H1.5 №2164 a design-decision question nobody answers is never paid for: M6 keeps describing its batch, the pass opens no line and sends nothing, and it ends on that exact question", async t => {
  const f = runFixture(t, ["spare"]);
  addressQuestions(f, [["spare", "design-decision"]]);
  const bases = f.bases(), request = f.request();
  assert.ok(answerBatch(f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value), "M6 describes the batch of the question");
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 12);
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), [["unsupported-question", "route_result_unsupported", "discovery:spare", "answer"]]);
  assert.ok(reasons[0]!.basis.length >= 1, "The exact D1 gap of the question");
  assert.ok(!end.performed.some(action => ["open-series", "open", "register", "packet", "cycle", "assess"].includes(action)), end.performed.join(","));
  assert.equal(f.store.list("repair-series").length, 0, "No line and no attempt: nobody was asked to answer it");
  assert.equal(f.sent().length, 0);
  const saved = ok(readRun(f.store, { project }))!;
  f.restart();
  const again = ok(await advanceRun(f.store, request));
  assert.deepEqual([again.performed, again.record.hash], [null, saved.hash], "A new store returns the same end");
  assert.equal(f.sent().length, 0);
});

test("H1.5 №2166 п.2 independent work goes on: the fact of another block is asked and assessed, the design decision of this block is not, and the end names that question only", async t => {
  const f = runFixture(t, ["encoding", "spare"], true, false, false, false, { encoding: { consumer: "garden-produce-block" } });
  addressQuestions(f, [["encoding", "repository-fact", "garden-produce-block"], ["spare", "design-decision", "garden-consume-block"]]);
  const request = f.request(), answers: Record<string, unknown>[] = [], answered = new Set<string>();
  ok(startRun(f.store, { project }));
  let state: RunRecord["state"] | null = null;
  for (let index = 0; index < 90 && !state; index++) {
    const now = ok(await advanceRun(f.store, request)).record.value.state as unknown as RunRecord["state"];
    if (now.phase === "step" && (now.step.action === "cycle" || now.step.action === "assess") && !answered.has(JSON.stringify(now.step.request))) {
      answered.add(JSON.stringify(now.step.request));
      answers.push(now.step.action === "assess" ? assessor("supported") : mixedAnswer(f, now.step));
      f.steps(answers);
    }
    if (now.phase === "waiting" || now.phase === "unable" || now.phase === "complete") state = now;
  }
  assert.ok(state, "The pass came to rest");
  assert.deepEqual(reasonsOf(state).map(row => [row.kind, row.code, row.target, row.field]), [["unsupported-question", "route_result_unsupported", "discovery:spare", "answer"]]);
  assert.equal(f.sent().length, 2, "The fact and its one assessment");
  assert.ok(f.sent().every(line => !String(line).includes("Which spare is supported?")));
  assert.equal(blockSeries(f, "garden-produce-block").value.attempts.length, 1, "The block of the fact worked");
  assert.equal(f.store.list<RepairSeries>("repair-series").some(row => (row.value as { block?: string }).block === "garden-consume-block"), false,
    "The block whose only batch is unserved has no line at all");
});

test("H1.5 №2166 п.4 the moment decides, not the kind: an environment confirmation or a post-implementation proof of the pass is a ground of its end, one of task-start or task-result is no barrier of the pass", async t => {
  for (const [kind, later] of [["environment-confirmation", "task-start"], ["post-implementation-proof", "task-result"]] as const) {
    const blocking = runFixture(t, ["proof"]);
    addressQuestions(blocking, [["proof", kind]]);
    ok(startRun(blocking.store, { project }));
    const ended = await ends(blocking, blocking.request(), 12);
    assert.deepEqual(reasonsOf(ended.state).map(row => [row.kind, row.code, row.target, row.field]), [["unsupported-question", "route_result_unsupported", "discovery:proof", "answer"]], kind);
    assert.equal(blocking.sent().length, 0, kind);
    const deferred = runFixture(t, ["proof"], true, false, false, false, { proof: { moment: later } });
    addressQuestions(deferred, [["proof", kind]]);
    ok(startRun(deferred.store, { project }));
    const idle = await ends(deferred, deferred.request(), 12);
    assert.equal(idle.state.phase, "waiting", `${kind}: ${JSON.stringify(idle.state)}`);
    assert.equal((idle.state as unknown as { wait: RunWait }).wait.code, "run_idle", `${kind}: nothing to do is a wait for new bases, not the end of the pass`);
    assert.equal(deferred.sent().length, 0, kind);
    assert.equal(deferred.store.list("repair-series").length, 0, kind);
  }
});

test("H1.5 №2166 п.4 a design question of task-start has a batch M6 describes and no producer: it is left out of every plan as well, yet it is no ground of the end", async t => {
  const f = runFixture(t, ["proof"], true, false, false, false, { proof: { moment: "task-start" } });
  addressQuestions(f, [["proof", "design-decision"]]);
  const bases = f.bases(), routes = f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value;
  const batch = routes.batches.find(item => item.items.some(row => row.target === "discovery:proof" && row.field === "answer"));
  assert.ok(batch, "M6 makes a batch of every design decision, whatever its moment");
  const read = ok(readRouteProducers(f.store, { project, routes: bases.routes }));
  assert.deepEqual(read.batches.filter(row => row.unserved.length).map(row => row.batch), [batch!.id], "The batch has no producer, blocking or not");
  ok(startRun(f.store, { project }));
  const idle = await ends(f, f.request(), 12);
  assert.equal(idle.state.phase, "waiting", JSON.stringify(idle.state));
  assert.equal((idle.state as unknown as { wait: RunWait }).wait.code, "run_idle", "A question of task-start does not end the pass");
  assert.equal(f.store.list("repair-series").length, 0, "Not planned, not asked");
  assert.equal(f.sent().length, 0);
});

/**
 * Runs a producer script with every engine module loaded from one exact commit, in its own process (the era check of
 * test/om-answers-gate.test.ts): the loader serves each module from Git and refuses an engine module outside the commit,
 * so a missed prefix cannot fall back to the current build and let the test pass vacuously.
 */
function atCommit(f: { root: string; database: string }, commit: string, name: string, body: string, input: unknown): unknown {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const loader = join(f.root, `${name}-loader.mjs`), producer = join(f.root, `${name}-producer.mjs`);
  const argsFile = join(f.root, `${name}-input.json`), served = join(f.root, `${name}-served.log`);
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
    const source = execFileSync('git', ['show', ${JSON.stringify(commit)} + ':' + relative],
      { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  if (url.startsWith('file:') && url.includes('/dist/src/') && !url.includes('/node_modules/'))
    throw new Error('An engine module outside the era checkout: ' + url);
  return next(url, context);
}`);
  writeFileSync(producer, `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository, database, input] = process.argv.slice(2);
const src = path => pathToFileURL(join(repository, 'dist/src', path)).href;
const { Store } = await import(src('storage/store.js'));
const { reference } = await import(src('pipeline/contracts.js'));
const args = JSON.parse(readFileSync(input, 'utf8')), store = new Store(database);
const take = result => { if (!result.ok) throw Error(JSON.stringify(result.refusal)); return result.value; };
const out = value => process.stdout.write(JSON.stringify(value));
try {
${body}
} finally { store.close(); }`);
  writeFileSync(argsFile, JSON.stringify(input));
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},
    { data: { root: ${JSON.stringify(pathToFileURL(repository).href)}, log: ${JSON.stringify(served)} } });`;
  const output: unknown = JSON.parse(execFileSync(process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, f.database, argsFile],
    { cwd: repository, encoding: "utf8", timeout: 180_000, maxBuffer: 10_000_000 }));
  const loaded = readFileSync(served, "utf8").split("\n").filter(Boolean);
  assert.ok(loaded.includes("src/storage/store.ts") && loaded.includes("src/om/run.ts"), `The producer ran on the modules of ${commit}: ${loaded.join(", ")}`);
  return output;
}

const H15_BASE_COMMIT = "479b307f8aa3d43745f5313c1f5c8a712bd7d55a";
/** A managed attempt of `block` planned on exactly this batch — the plan an earlier pass saved (the reviewer's helper, №2221). */
function openPlanned(f: Fixture, bases: RunBases, block: string, batches: readonly RouteBatch[], slice = "before-h15") {
  ok(openSeries(f.store, { project, block, line: 1, slice, predecessor: null, basis: null }));
  const goal = { key: `${slice}:${block}`, questions: [...new Set(batches.flatMap(batch => batch.items.map(item => gapLineKey(project, item.target, item.field))))].sort(),
    result: gapLineExpectedResult(project, batches[0]!.items[0]!.target, batches[0]!.items[0]!.field) };
  return ok(openAttempt(f.store, { project, block, line: 1, attempt: 1, goal, completion: { routes: bases.routes, batches: batches.map(batch => batch.id).sort() } }));
}
const unsupportedSpare = [["unsupported-question", "route_result_unsupported", "discovery:spare", "answer"]];
/** The saved end comes back from a new store: the same record, nothing performed, nothing sent. */
async function sameEnd(f: Fixture, request: RunRequest, sends: number) {
  const saved = ok(readRun(f.store, { project }))!;
  f.restart();
  const again = ok(await advanceRun(f.store, request));
  assert.deepEqual([again.performed, again.record.hash], [null, saved.hash], "A new store returns the same end");
  assert.equal(f.sent().length, sends);
}

test("H1.5 №2221 reviewer-H15 current public producers: an open managed attempt planned on an unserved batch ends the pass unable on that exact question — no packet, no cycle, nothing sent, the attempt stays open and a new store repeats the end", async t => {
  const f = runFixture(t, ["spare"]);
  addressQuestions(f, [["spare", "design-decision"]]);
  const bases = f.bases(), batch = answerBatch(f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value);
  openPlanned(f, bases, "garden-consume-block", [batch], "reviewer-current-h15");
  ok(startRun(f.store, { project }));
  const end = await ends(f, f.request(), 15);
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target, row.field]), unsupportedSpare, "A proved permanently unserved active question is a ground, not a wait");
  assert.deepEqual(reasons[0]!.basis, [reference(f.store.get<Revision<unknown>>(reasons[0]!.basis[0]!.id, reasons[0]!.basis[0]!.revision)!)], "The exact D1 gap of the question");
  assert.deepEqual(actions(f.store), ["register"], "The check is registered; the unserved root makes no packet and no cycle");
  assert.equal(f.sent().length, 0);
  assert.equal(blockSeries(f).value.attempts[0]!.outcome, null, "The attempt stays open: no G7 outcome is invented");
  assert.equal(f.store.list("question-packet").length, 0, "No packet of the unserved batch was made");
  await sameEnd(f, f.request(), 0);
});

test("H1.5 №2221 reviewer-H15 unserved open work does not starve independent admitted work: the neighbour's fact is asked, assessed and closed with its result (kept for the next pass: №1860 п.5 applies no new B1 while the unserved attempt stays open), and only then the pass ends on the unserved question", async t => {
  const f = runFixture(t, ["encoding", "spare"], true, false, false, false, { encoding: { consumer: "garden-produce-block" } });
  addressQuestions(f, [["encoding", "repository-fact", "garden-produce-block"], ["spare", "design-decision", "garden-consume-block"]]);
  const bases = f.bases(), routes = f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value;
  const bad = answerBatch(routes), good = routes.batches.find(row => row.model === "MC1" && row.items.some(item => item.target === "discovery:encoding"))!;
  assert.ok(good);
  openPlanned(f, bases, "garden-consume-block", [bad], "reviewer-current-h15");
  openPlanned(f, bases, "garden-produce-block", [good], "reviewer-current-h15");
  ok(startRun(f.store, { project }));
  const request = f.request(), answers: Record<string, unknown>[] = [], answered = new Set<string>();
  let state: RunRecord["state"] | null = null;
  for (let index = 0; index < 60 && !state; index++) {
    const advanced = ok(await advanceRun(f.store, request)), now = advanced.record.value.state as unknown as RunRecord["state"];
    if (now.phase === "step" && (now.step.action === "cycle" || now.step.action === "assess") && !answered.has(JSON.stringify(now.step.request))) {
      answered.add(JSON.stringify(now.step.request));
      answers.push(now.step.action === "assess" ? assessor("supported") : mixedAnswer(f, now.step));
      f.steps(answers);
    }
    if (now.phase === "unable" || now.phase === "complete" || now.phase === "waiting" && advanced.performed === null) state = now;
  }
  assert.ok(state, "The pass came to rest");
  assert.equal(f.sent().length, 2, "The independent admitted fact and its assessment were sent");
  assert.deepEqual(reasonsOf(state).map(row => [row.kind, row.code, row.target, row.field]), unsupportedSpare);
  assert.equal(blockSeries(f, "garden-produce-block").value.attempts[0]!.outcome?.reason, "result", "The neighbour's attempt closed by G7 with its result");
  assert.equal(blockSeries(f, "garden-consume-block").value.attempts[0]!.outcome, null, "The unserved attempt stays open");
  assert.ok(f.store.list().some(row => row.id.startsWith(`om-answer:${project}:`)), "The fact is accepted (D5) and kept for the next pass");
  // №1860 п.5 stands: a new B1 is not applied while an attempt — here the unserved one — is still open on the current one.
  assert.ok(!actions(f.store).includes("apply") && !actions(f.store).includes("bases"), actions(f.store).join(","));
  assert.ok(f.sent().every(line => !String(line).includes("Which spare is supported?")));
  await sameEnd(f, request, 2);
});

test("H1.5 №2221 the same attempt holds an admitted fact and an unserved batch: the fact is asked and assessed, the unserved root is never sent, and the pass ends on that question with the attempt open", async t => {
  const f = runFixture(t, ["encoding", "spare"]);
  addressQuestions(f, [["encoding", "repository-fact"], ["spare", "design-decision"]]);
  const bases = f.bases(), routes = f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value;
  const bad = answerBatch(routes), good = routes.batches.find(row => row.model === "MC1" && row.items.some(item => item.target === "discovery:encoding"))!;
  openPlanned(f, bases, "garden-consume-block", [bad, good], "mixed-plan");
  ok(startRun(f.store, { project }));
  const request = f.request(), answers: Record<string, unknown>[] = [], answered = new Set<string>();
  let state: RunRecord["state"] | null = null;
  for (let index = 0; index < 60 && !state; index++) {
    const advanced = ok(await advanceRun(f.store, request)), now = advanced.record.value.state as unknown as RunRecord["state"];
    if (now.phase === "step" && (now.step.action === "cycle" || now.step.action === "assess") && !answered.has(JSON.stringify(now.step.request))) {
      answered.add(JSON.stringify(now.step.request));
      answers.push(now.step.action === "assess" ? assessor("supported") : mixedAnswer(f, now.step));
      f.steps(answers);
    }
    if (now.phase === "unable" || now.phase === "complete" || now.phase === "waiting" && advanced.performed === null) state = now;
  }
  assert.ok(state, "The pass came to rest");
  assert.equal(f.sent().length, 2, "The fact and its assessment; nothing for the design question");
  assert.ok(f.sent().every(line => !String(line).includes("Which spare is supported?")));
  assert.deepEqual(reasonsOf(state).map(row => [row.kind, row.code, row.target, row.field]), unsupportedSpare);
  assert.ok(actions(f.store).includes("assess") && !actions(f.store).includes("close"), actions(f.store).join(","));
  assert.equal(blockSeries(f).value.attempts[0]!.outcome, null, "The attempt cannot finish while its unserved root stays open; no outcome is invented");
  await sameEnd(f, request, 2);
});

test("H1.5 №2221 a saved but unsent packet of an unserved batch is left as it is: the pass neither sends nor repeats it and ends on the question", async t => {
  const f = runFixture(t, ["spare"]);
  addressQuestions(f, [["spare", "design-decision"]]);
  const bases = f.bases(), batch = answerBatch(f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value);
  const series = openPlanned(f, bases, "garden-consume-block", [batch]);
  // The packet the earlier pass would have made (the current E2 producer): registered as the root's product, never sent.
  const packet = ok(writeQuestionPacket(f.store, { project, routes: bases.routes, batch: batch.id, environment: reference(f.store.get(`environment:${project}`)!),
    attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  assert.equal(packet.value.state, "ready");
  ok(startRun(f.store, { project }));
  const end = await ends(f, f.request(), 15);
  assert.deepEqual(reasonsOf(end.state).map(row => [row.kind, row.code, row.target, row.field]), unsupportedSpare);
  assert.equal(f.sent().length, 0, "The saved packet was not sent");
  assert.ok(!actions(f.store).includes("cycle") && !actions(f.store).includes("packet"), actions(f.store).join(","));
  assert.deepEqual(reference(f.store.get(packet.id)!), reference(packet), "The saved packet is untouched");
  await sameEnd(f, f.request(), 0);
});

test("H1.5 №2221 a non-blocking unserved batch (a design question of task-start) in a saved plan is not sent and is no ground: the pass waits on the open work instead of ending", async t => {
  const f = runFixture(t, ["proof"], true, false, false, false, { proof: { moment: "task-start" } });
  addressQuestions(f, [["proof", "design-decision"]]);
  const bases = f.bases(), routes = f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value;
  const batch = routes.batches.find(item => item.items.some(row => row.target === "discovery:proof" && row.field === "answer"))!;
  assert.ok(batch);
  const read = ok(readRouteProducers(f.store, { project, routes: bases.routes })).batches.find(row => row.batch === batch.id)!;
  assert.deepEqual(read.unserved.map(row => [row.target, row.blocking]), [["discovery:proof", false]], "Unserved, but not a blocking question of the pass");
  openPlanned(f, bases, "garden-consume-block", [batch], "task-start-plan");
  ok(startRun(f.store, { project }));
  const end = await ends(f, f.request(), 15);
  assert.equal(end.state.phase, "waiting", JSON.stringify(end.state));
  assert.equal((end.state as unknown as { wait: RunWait }).wait.code, "work_pending", "Open work without a ground is a wait, not an end");
  assert.equal(f.sent().length, 0);
  assert.deepEqual(actions(f.store), ["register"]);
  f.restart();
  assert.equal(ok(await advanceRun(f.store, f.request())).performed, null);
  assert.equal(f.sent().length, 0);
});

test("H1.5 №2166 п.3 →№2221 a plan saved before this rule that holds an unserved batch: the pass registers the check, sends nothing, and ends unable on that exact question (was: a standing wait on the E4 refusal)", async t => {
  const f = runFixture(t, ["spare"]);
  addressQuestions(f, [["spare", "design-decision"]]);
  const bases = f.bases(), batch = answerBatch(f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value);
  openPlanned(f, bases, "garden-consume-block", [batch]);
  const request = f.request();
  f.steps([{ research: { protocol: "omg-answer/v2", requestId: "$requestId", action: "cannot_answer", code: "cannot_answer", message: "never needed" }, usage }]);
  const end = await ends(f, request, 12);
  assert.deepEqual(reasonsOf(end.state).map(row => [row.kind, row.code, row.target, row.field]), unsupportedSpare);
  assert.deepEqual(actions(f.store), ["register"], "The check is registered; the unserved root is neither packed nor cycled");
  assert.equal(f.sent().length, 0, "Nothing was sent");
  await sameEnd(f, request, 0);
});

test("H1.5 ERA №2221 a pass written by the code of the base commit, which planned the unserved batch and made its packet, is continued by the new code without payment: the saved packet is not sent, the pass ends unable, and a new store changes nothing (was: a standing wait)", async t => {
  const f = runFixture(t, ["spare"]);
  addressQuestions(f, [["spare", "design-decision"]]);
  f.bases();
  const request = f.request();
  f.steps([{ research: { protocol: "omg-answer/v2", requestId: "$requestId", action: "cannot_answer", code: "cannot_answer", message: "never needed" }, usage }]);
  // The base code chooses and performs the free steps up to the packet of the unserved batch; its next step would be the paid cycle.
  const written = atCommit(f, H15_BASE_COMMIT, "h15-pass", `const { advanceRun } = await import(src('om/run.js'));
const performed = [];
for (let index = 0; index < 12; index++) {
  const advanced = take(await advanceRun(store, args.request));
  if (advanced.performed) performed.push(advanced.performed.action);
  if (advanced.performed?.action === 'packet') break;
}
out(performed);`, { request }) as string[];
  assert.deepEqual(written.slice(-4), ["open-series", "open", "register", "packet"], "The base code planned the unserved batch and made its packet");
  assert.equal(f.sent().length, 0);
  f.restart();
  const end = await ends(f, request, 12);
  assert.deepEqual(reasonsOf(end.state).map(row => [row.kind, row.code, row.target, row.field]), unsupportedSpare);
  assert.equal(f.sent().length, 0, "The saved packet was never sent");
  assert.deepEqual(actions(f.store), written, "The history the base code wrote is read as it is; nothing was performed on top of it");
  await sameEnd(f, request, 0);
});

test("H1.5 ERA №2221 physical work of an unserved batch paid by the base code is finished and accounted by the new code, never sent again: the paid cycle goes through the check, and the pass ends on the question the full G4b names", async t => {
  const f = runFixture(t, ["spare"]);
  addressQuestions(f, [["spare", "design-decision"]]);
  const bases = f.bases(), batch = answerBatch(f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value);
  openPlanned(f, bases, "garden-consume-block", [batch]);
  const request = f.request();
  f.steps([{ research: { protocol: "omg-answer/v2", requestId: "$requestId", action: "cannot_answer", code: "cannot_answer", message: "never needed" }, usage }]);
  // The base code has no producer check: it sends the unserved packet and receives the paid answer.
  const paid = atCommit(f, H15_BASE_COMMIT, "h15-paid", `const { advanceRun, startRun } = await import(src('om/run.js'));
take(startRun(store, { project: args.project }));
const performed = [];
for (let index = 0; index < 12; index++) {
  const advanced = take(await advanceRun(store, args.request));
  if (advanced.performed) performed.push(advanced.performed.action);
  if (advanced.performed?.action === 'cycle') break;
}
out(performed);`, { request, project }) as string[];
  assert.deepEqual(paid.slice(-3), ["register", "packet", "cycle"]);
  assert.equal(f.sent().length, 1, "The base code paid once");
  f.restart();
  const end = await ends(f, request, 20);
  assert.equal(f.sent().length, 1, "The paid call is finished and accounted; nothing is sent again");
  assert.deepEqual(reasonsOf(end.state).map(row => [row.kind, row.code, row.target, row.field]), unsupportedSpare, "The full G4b of the paid result names the question");
  assert.ok(end.performed.includes("evaluate"), `The paid result went through the attempt's check: ${end.performed.join(",")}`);
  assert.ok(!end.performed.includes("cycle") || f.sent().length === 1, "A repeated cycle step only replays the saved call");
  await sameEnd(f, request, 1);
});
