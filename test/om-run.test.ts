import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import { hashJson, type Json } from "../src/canonical.js";
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
import { writeOmInput } from "../src/om/input.js";
import { writeHorizon, writeHorizonIssuance } from "../src/om/horizon.js";
import { writeSeriesTransition } from "../src/om/series-transition.js";
import { applySeriesActivation, beginAttempt, openSeries, ownerDecisionNamespace, OWNER_DECISION_KIND, resumeSeries, seriesRequestOf } from "../src/om/series.js";
import { recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND } from "../src/om/refusal-journal.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { writeGaps, type GapRequest } from "../src/om/gaps.js";
import { prepareQuestionTasks } from "../src/om/question-packet.js";
import { writeRoutes, type RoutesRecord } from "../src/om/routes.js";
import { readAcceptedFrameLayer } from "../src/om/layer-basis.js";
import { writeBlockQueue, QUEUE_POLICY_VERSION, type QueuePolicy } from "../src/om/queue.js";
import type { AnyRepairSeries, RepairSeries } from "../src/om/series.js";
import { closeAttempt, openAttempt, prepareManagedClaim } from "../src/om/repeat-gate.js";
import { runModelCycle } from "../src/om/model-call.js";
import { advanceRun, readRun, startRun, runId, type RunRequest, type RunRecord } from "../src/om/run.js";

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
function runFixture(t: test.TestContext, questions = ["encoding", "spare"], refine = true, addressed: boolean | string[] = false, later = false) {
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
      question: `Which ${id} is supported?`, consumer: "garden-consume-block", moment: "om-pass", blocksCurrentStage: false,
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
  const base = ok(writeOmInput(store, { project, expected: 0, stages }));
  const graph = reference(store.get(`graph:${project}`)!);
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
  const input = decisions.length ? ok(writeAddressing(store, { project, input: reference(base), graph, decisions })) : base;
  const adapter = store.write({ id: `adapter:${project}:run`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  /** The owner's (external) bases for today's B1: horizon, D1, M6 and the M3 queue — never produced by the pass. */
  function bases(choiceVersion: string, works = false) {
    const current = store.get(`om-input:${project}`)!;
    // After an accepted N2 the owner's works bases: a horizon refined by that exact layer and D1 with the works frame.
    const accepted = works ? ok(readAcceptedFrameLayer(store, { project, level: 2, frame: reference(store.get(`om-frame:${project}:2`)!) })) : null;
    const on = accepted ? reference(accepted.graph) : graph;
    const horizon = ok(writeHorizon(store, { project, input: reference(current), graph: on,
      refinement: accepted ? reference(accepted.layer) : refine ? reference(store.get(`phase:${project}:L2`)!) : null,
      available: {}, choice: { choiceVersion, features: [{ outcome: "garden-result" }], excluded: [] } }));
    const at = reference(horizon.gate);
    const layer = (level: 2 | 3) => reference(store.get(`graph-layer:${project}:${level}`)!);
    const frame = (level: 2 | 3) => ({ proposals: [], frame: { project, level, graph, horizon: at, layer: layer(level),
      frame: null, upper: level === 2 ? null : { horizon: at, frame: null } } });
    // Without refined layers the operations frame is open and the works wait for their accepted upper layer.
    const operations = accepted ? { proposals: [], frame: { project, level: 2 as const, graph: on, horizon: at, layer: reference(accepted.layer), frame: reference(accepted.frame), upper: null } }
      : refine ? frame(2) : { proposals: [], frame: { project, level: 2 as const, graph, horizon: at, layer: null, frame: null, upper: null } };
    const worksSource = accepted ? { proposals: [], frame: { project, level: 3 as const, graph: on, horizon: at, layer: null, frame: null, upper: { horizon: at, frame: reference(accepted.frame) } } }
      : refine ? frame(3) : { state: "upper-not-accepted" as const, layer: reference(store.get(`graph-layer:${project}:2`)!) };
    const gaps = ok(writeGaps(store, { project, input: reference(current), graph: on, horizon: at, operations, works: worksSource } as GapRequest));
    const scope = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
    const questions = gaps.records.filter(row => row.value.gap.kind === "repository-fact" && row.value.gap.code !== "inventory_missing" && !row.value.gap.deferral)
      .map(gap => ({ gap: reference(gap), requirements: [{ pointer: "/contracts/0" }], resultForm: { type: "string" } }));
    const tasks = questions.length ? ok(prepareQuestionTasks(store, { project, gaps: scope, questions })).tasks : [];
    const routes = ok(writeRoutes(store, { project, gaps: scope, tasks: tasks.map(task => ({ pending: structuredClone(task.writes[0]!) as Write })),
      catalog: { paths: ["h1-source.txt"], records: [] }, previous: null }));
    const map = store.get<{ content: { graph: Ref } }>(`stage:${project}:operation-map`)!.value.content;
    const queue = ok(writeBlockQueue(store, { project, horizon: at, policy: policy(map.graph), override: null }));
    return { horizon: at, queue: reference(queue), routes: reference(routes), sources: [] as Ref[] };
  }
  /** The owner's M3 policy: the success journey to the garden result, on the operation map's graph. */
  function policy(layer: Ref): QueuePolicy {
    const journey = store.get<Graph>(`graph:${project}`)!.value.journeys!.find(item => item.terminal === "success" && item.outcome === "garden-result")!;
    return { version: QUEUE_POLICY_VERSION, ownerPath: { layer, journeyId: journey.id, actorId: journey.actor, outcomeId: journey.outcome } };
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
  const request = (b: ReturnType<typeof bases>): RunRequest => ({ project, bases: b,
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
function factsAll(f: Fixture, routes: Ref, value = "UTF-8") {
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
/** Advances the pass until it waits, recording every performed action; a bound stops an accidental loop. */
async function drive(f: Fixture, request: RunRequest, bound = 30) {
  const performed: string[] = [];
  for (let index = 0; index < bound; index++) {
    const advanced = ok(await advanceRun(f.store, request));
    if (advanced.performed) performed.push(advanced.performed.action);
    const state = advanced.record.value.state;
    if (state.phase === "waiting") return { performed, wait: state.wait, record: advanced.record };
  }
  assert.fail(`The pass did not reach a wait within ${bound} transitions: ${performed.join(",")}`);
}

test("26 1 C07 H1 the pass runs the project mechanism M5 through G7 and then waits for the owner's bases of the new B1", async t => {
  const f = runFixture(t);
  const b = f.bases("h1-first"), request = f.request(b);
  f.steps([addressAll(f, b.routes)]);
  const started = ok(startRun(f.store, { project }));
  assert.deepEqual(started.value.input, reference(f.store.get(`om-input:${project}`)!));
  const driven = await drive(f, request);
  assert.deepEqual(driven.performed, ["open-series", "open", "packet", "cycle", "close"], JSON.stringify(driven.wait));
  const series = f.store.list<RepairSeries>("repair-series").find(row => row.id.includes(":mechanism:"))!;
  const outcome = series.value.attempts[0]!.outcome!;
  assert.equal(outcome.reason, "result");
  assert.equal(outcome.achieved.length, 2);
  assert.equal(driven.wait.code, "bases_stale");
  assert.equal(driven.wait.field, "horizon");
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  const again = ok(await advanceRun(f.store, { ...request, dispatch: { ...request.dispatch } }));
  assert.equal(again.performed, null);
  assert.deepEqual(f.store.list().map(reference), before, "A standing wait is returned without a write");
  assert.equal(f.sent().length, sends);
  assert.deepEqual(ok(startRun(f.store, { project })).value.input, started.value.input, "A repeated start reads the one pass");
});

test("3 8 25 C23 C17 C27 H1 after the owner's new bases the same pass works the block of M3 through MC1, E5 and G4b to one G7 close", async t => {
  const f = runFixture(t);
  const first = f.bases("h1-first");
  const m5 = addressAll(f, first.routes);
  f.steps([m5]);
  ok(startRun(f.store, { project }));
  const waited = await drive(f, f.request(first));
  assert.equal(waited.wait.code, "bases_stale");
  // The owner (or H2) issues the lawful new chain for the new B1 between two continuations of the same pass (№1737 п.8).
  const second = f.bases("h1-second");
  f.steps([m5, factsAll(f, second.routes), assessor("supported"), assessor("supported")]);
  const driven = await drive(f, f.request(second));
  assert.deepEqual(driven.performed, ["open-series", "open", "register", "packet", "cycle", "assess", "assess", "routes", "evaluate", "close"], JSON.stringify(driven.wait));
  const series = blockSeries(f);
  const outcome = series.value.attempts[0]!.outcome!;
  assert.equal(outcome.reason, "result");
  assert.equal(driven.wait.code, "run_idle");
  assert.equal(f.sent().length, 4, "Every paid call was made once");
});

/** The block's first bases after M5 of one question: the pass has closed M5 and stands on the owner's new chain. */
async function blockBases(f: Fixture) {
  const first = f.bases("h1-first"), m5 = addressAll(f, first.routes);
  f.steps([m5]);
  ok(startRun(f.store, { project }));
  assert.equal((await drive(f, f.request(first))).wait.code, "bases_stale");
  const second = f.bases("h1-second");
  return { m5, second, request: f.request(second) };
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

test("17 19 20 C33 H1 three attempts without progress stop the series; A6 reviews the exact stop and an undecided review waits for the owner", async t => {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("h1-first"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, false), addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const driven = await drive(f, request, 40);
  const attempt = ["open", "packet", "cycle", "close"];
  assert.deepEqual(driven.performed, ["open-series", ...attempt, ...attempt, ...attempt, "analyze"], JSON.stringify(driven.wait));
  const series = mechanismSeries(f);
  assert.deepEqual(series.value.attempts.map(row => row.outcome?.reason), ["refused", "refused", "refused"]);
  assert.ok(series.value.stop, "A3 set the stop; the pass counts nothing itself");
  assert.equal(driven.wait.code, "owner_decision");
  assert.equal(series.value.escalations.length, 1, "The undecided review escalated the stop atomically (A6)");
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  const again = ok(await advanceRun(f.store, request));
  assert.equal(again.performed, null);
  assert.deepEqual(f.store.list().map(reference), before, "The second rung waits without a write and without a paid repeat");
  assert.equal(f.sent().length, sends);
  // The owner's exact decision on this stop (the owner's own act, not the pass's) opens the next window of work.
  const stopped = mechanismSeries(f), stop = stopped.value.stop!;
  const decision = f.store.write({ id: `${ownerDecisionNamespace(project)}h1-window`, kind: OWNER_DECISION_KIND, expected: 0,
    value: { projectId: project, owner: { kind: "mechanism", mechanism: "M5:addressing" }, stop: stop.attempt, goals: [...stop.goals],
      decided: "go on: I have read what was tried and I want one more window", taken: { by: "the owner", through: "the command API", approved: true } } });
  ok(resumeSeries(f.store, { ...seriesRequestOf(stopped.value), stop: stop.attempt, ground: "owner-decision",
    text: "the owner decided to go on", decision: { ref: reference(decision) } } as never));
  const window = await drive(f, request, 20);
  assert.deepEqual(window.performed, ["open", "packet", "cycle", "close"], JSON.stringify(window.wait));
  assert.equal(mechanismSeries(f).value.attempts.at(-1)!.outcome!.reason, "result");
});

test("18 19 H1 a decided first-rung review grounds resumeSeries of that exact stop, and the next attempt works on", async t => {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("h1-first"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, true), addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  const driven = await drive(f, request, 50);
  const attempt = ["open", "packet", "cycle", "close"];
  assert.deepEqual(driven.performed, ["open-series", ...attempt, ...attempt, ...attempt, "analyze", "resume", ...attempt], JSON.stringify(driven.wait));
  const series = mechanismSeries(f);
  assert.equal(series.value.stop, null);
  assert.equal(series.value.continuations.length, 1);
  assert.equal(series.value.attempts.at(-1)!.outcome!.reason, "result");
  assert.equal(driven.wait.code, "bases_stale", "The applied addressing made a new B1");
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

test("2 H1 without the owner's horizon the pass waits addressed and chooses no horizon, series or attempt itself", async t => {
  const f = runFixture(t);
  ok(startRun(f.store, { project }));
  const missing = { id: `om-horizon:${project}:never-chosen`, revision: 1, hash: "0".repeat(64) };
  const request: RunRequest = { ...f.request({ horizon: missing, queue: missing, routes: missing, sources: [] }) };
  const driven = await drive(f, request, 3);
  assert.deepEqual(driven.performed, []);
  assert.equal(driven.wait.target, missing.id);
  assert.equal(f.store.list("repair-series").length, 0);
  assert.equal(f.store.list().filter(row => row.id.startsWith(`om-horizon:${project}:`)).length, 0);
});

test("C01 H1 one pass per project: a repeated start reads it, the first creation has one winner, and the record is B1-born", async t => {
  const f = runFixture(t);
  const racing = new RacingStore(f.database);
  t.after(() => racing.close());
  racing.target = runId(project); racing.remaining = 1;
  racing.run = other => { ok(startRun(other, { project })); };
  const lost = startRun(racing, { project });
  assert.equal(lost.ok, false, "The losing creation is refused by expected=0");
  const again = ok(startRun(racing, { project }));
  assert.equal(again.revision, 1);
  assert.deepEqual(again.value.input, reference(f.store.get(`om-input:${project}`)!));
  // The engine recognizes even an incomplete run record as B1-born: without its first B1 the era is an integrity refusal.
  const other = new Store(join(f.root, "orphan.sqlite"));
  t.after(() => other.close());
  other.write({ id: runId(project), kind: "om-run", expected: 0, value: { contract: "om-run/v1" } });
  assert.throws(() => new ProductEngine(other).legacyRoute(project), (error: unknown) => error instanceof EngineError && error.code === "record_missing");
});

test("15 16 C33 H1 owner-control of a goal holds it at any reason; new bases or a restart do not release it and nothing is paid again", async t => {
  const f = runFixture(t, ["encoding"]);
  const { m5, second, request } = await blockBases(f);
  const saved = f.store.get<RoutesRecord>(second.routes.id, second.routes.revision)!.value;
  const gap = saved.batches.find(item => item.model === "MC1")!.items[0]!.gap;
  f.steps([m5, { research: { protocol: "omg-answer/v2", requestId: "$requestId", questionIds: [gap], action: "need_owner",
    reason: "Need a concrete source", decision: "Choose the source" }, usage }]);
  const driven = await drive(f, request);
  assert.equal(driven.performed.at(-1), "close", JSON.stringify(driven.wait));
  assert.equal(driven.wait.code, "owner_control");
  assert.ok(driven.wait.basis.length > 1, "The wait names the exact waiting sources of the close");
  const sends = f.sent().length;
  // The owner issues other bases for the same B1; the same goal stays held, and no second attempt is opened.
  const third = f.bases("h1-third");
  f.restart();
  const again = await drive(f, f.request(third));
  assert.equal(again.wait.code, "owner_control");
  assert.deepEqual(again.performed, []);
  assert.equal(f.sent().length, sends);
  assert.equal(blockSeries(f).value.attempts.length, 1);
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

test("27 25 7 C61 C28 H1 end to end: the pass works L3 through MC2, G4b and one bound works acceptance, then M8, M9 and the existing compiler", async t => {
  const f = (await loadOperations()).acceptedOperationsFixture(t, "planned", 0);
  const { store, project: name, workspace, graph, layer, upperFrame, input, horizon, basis, frame2, desired } = f;
  assert.equal(name, project);
  // The owner's bases for the works: the accepted horizon, D1 over the accepted operations and the works frame, M6, M3.
  const gaps = ok(writeGaps(store, { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { frame: { ...frame2, graph, layer, frame: upperFrame, horizon: reference(horizon.gate) }, proposals: [] },
    works: { frame: structuredClone(basis.request) as FrameRequest, proposals: [] } }));
  const scope = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const routes = ok(writeRoutes(store, { project, gaps: scope, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  assert.ok(routes.value.batches.some(batch => batch.level === 3 && batch.task === "node-expansion"));
  const map = store.get<{ content: { graph: Ref } }>(`stage:${project}:operation-map`)!.value.content;
  const journey = store.get<Graph>(`graph:${project}`)!.value.journeys!.find(item => item.terminal === "success" && item.outcome === "garden-result")!;
  const queue = ok(writeBlockQueue(store, { project, horizon: reference(horizon.gate), override: null,
    policy: { version: QUEUE_POLICY_VERSION, ownerPath: { layer: map.graph, journeyId: journey.id, actorId: journey.actor, outcomeId: journey.outcome } } }));
  const scenario = join(f.root, "scenario.json"), trace = join(f.root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const environment = f.engine.environments.configure(project, { workspace,
    implementer: { actor: "h1-works-producer", model: "fixture", effort: "high", command },
    reviewer: { actor: "h1-works-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 200_000 }, 0);
  writeFileSync(join(workspace, "input.txt"), "A captured external input");
  const source = new Evidence(store).file(project, "garden-data", workspace, "input.txt", "text/plain", 0);
  git(workspace, ["add", "input.txt"]);
  git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "capture input"]);
  const adapter = store.write({ id: `adapter:${project}:h1`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  const request: RunRequest = { project, bases: { horizon: reference(horizon.gate), queue: reference(queue), routes: reference(routes), sources: [reference(source)] },
    dispatch: { adapter: reference(adapter), config: reference(environment) } };
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
  assert.deepEqual(performed, ["cycle", "evaluate", "works", "gaps", "confirm", "close", "feasibility", "feasibility", "handoff", "compile"],
    "One bound works acceptance, the D2 event of the original goal and G7; M8 again after its finding is fixed; then M9 and the compiler");
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

test("25 C61 7 №1749 H1 two blocks of one N2 frame: G4b waits for both, one bound C5, a D2 event per original goal and each own G7, across restarts", async t => {
  const f = runFixture(t, [], false);
  const b = f.bases("h1-n2"), request = f.request(b);
  const saved = f.store.get<RoutesRecord>(b.routes.id, b.routes.revision)!.value;
  assert.equal(saved.batches.filter(row => row.task === "node-expansion" && row.level === 2).length, 2, "Both blocks expand the one operations frame");
  ok(startRun(f.store, { project }));
  // Block A (first in M3) pays its MC2; its part alone cannot form the frame, so A stays open and B is worked next.
  const first = await until(f, request, "cycle");
  const answers = [nodeAnswer(f, first)];
  f.steps(answers);
  const second = await until(f, request, "cycle", 30);
  assert.notEqual(second.series, first.series, "The pass moved on to the other block instead of waiting globally");
  const a = f.store.get<AnyRepairSeries>(first.series!)!;
  assert.equal(a.value.attempts.length, 1, "A kept its one open attempt: no second ordinal, no repaid call");
  answers.push(nodeAnswer(f, second));
  f.steps(answers);
  const accept = await until(f, request, "accept", 40);
  const binding = (accept.request as unknown as { settle: { binding: { series: Ref; ordinal: number } } }).settle.binding;
  assert.equal(binding.series.id, accept.series, "The coordinator binds only its own goal");
  assert.equal(ok(await advanceRun(f.store, request)).performed?.action, "accept");
  // Window: the acceptance is written and the D2 events are not; a restart continues with D2, never a second C5.
  f.restart();
  // The current D1 over the accepted N2 needs the owner's works horizon (its refinement is that layer): D2 waits for it.
  const stands = await drive(f, request, 5);
  assert.deepEqual(stands.performed, []);
  assert.equal(stands.wait.code, "d2_bases", JSON.stringify(stands.wait));
  const works = f.request(f.bases("h1-works", true));
  const after: string[] = [];
  let stood: unknown = null;
  for (let index = 0; index < 20 && after.filter(action => action === "close").length < 2; index++) {
    const advanced = ok(await advanceRun(f.store, works));
    if (advanced.performed) {
      after.push(advanced.performed.action);
      // Window: a D2 event is written and its G7 is not; a restart restores the same D2 Ref.
      if (advanced.performed.action === "confirm") f.restart();
    }
    const state = advanced.record.value.state as unknown as { phase: string; wait?: unknown };
    if (state.phase === "waiting") { stood = state.wait; break; }
  }
  assert.deepEqual(after, ["confirm", "close", "confirm", "close"], JSON.stringify(stood));
  const blocks = ["garden-produce-block", "garden-consume-block"].map(block => blockSeries(f, block));
  for (const series of blocks) {
    assert.equal(series.value.attempts.length, 1);
    assert.equal(series.value.attempts[0]!.outcome!.reason, "result", series.id);
  }
  assert.equal(f.store.history(`om-frame:${project}:2`).length, 1, "One common acceptance");
  const lines = f.store.history(`om-gap-lines:${project}:history`);
  assert.equal(lines.filter(row => (row.value as { request: { closures: unknown[] } }).request.closures.length).length, 2, "One D2 event per original goal");
  assert.equal(f.sent().length, 2, "Nothing was paid twice");
});

/**
 * The real L3 chain of several blocks (the proven path of the F5 atomic seed, om-atomic-gate): a native N2 acceptance of
 * the 'cross' graph, the owner's works horizon over that layer, D1 with the works frame, M6 and M3. The pass then pays one
 * MC2 works cycle per block and does everything else.
 */
function worksFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-h1-works-")), database = join(root, "state.sqlite");
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const desired = gardenGraph("cross"), { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph);
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
  const graph = reference(accepted.graph!), layer = reference(accepted.layer!), frame = reference(accepted.frame!);
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph, refinement: layer, available: {},
    choice: { choiceVersion: "h1-works", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const at = reference(horizon.gate);
  const gaps = ok(writeGaps(store, { project, input: reference(input), graph, horizon: at,
    operations: { proposals: [], frame: { ...frame2, graph, horizon: at, layer, frame } },
    works: { proposals: [], frame: { project, level: 3, graph, horizon: at, layer: null, frame: null, upper: { horizon: at, frame } } } }));
  const scope = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const routes = ok(writeRoutes(store, { project, gaps: scope, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const map = store.get<{ content: { graph: Ref } }>(`stage:${project}:operation-map`)!.value.content;
  const journey = store.get<Graph>(`graph:${project}`)!.value.journeys!.find(item => item.terminal === "success" && item.outcome === "garden-result")!;
  const queue = ok(writeBlockQueue(store, { project, horizon: at, override: null,
    policy: { version: QUEUE_POLICY_VERSION, ownerPath: { layer: map.graph, journeyId: journey.id, actorId: journey.actor, outcomeId: journey.outcome } } }));
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "h1-atomic-producer", model: "fixture", effort: "high", command },
    reviewer: { actor: "h1-atomic-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 200_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:h1-works`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  const request: RunRequest = { project, bases: { horizon: at, queue: reference(queue), routes: reference(routes), sources: [] },
    dispatch: { adapter: reference(adapter), config: reference(environment) } };
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

test("1 24 23 22 C57 H1 registered roots work only after B3 activation; excluded blocks start no work; B3's return opens work on the line it proves", async t => {
  const f = runFixture(t, ["encoding"], false, true, true);
  // The project is already transition-managed: the owner's P/G2 activated an independent block's root.
  ok(openSeries(f.store, { project, block: "garden-later-block", line: 1, slice: "h1-other", predecessor: null, basis: null }));
  f.activate("h1-initial", { features: [{ outcome: "garden-result" }], excluded: [] });
  const request = f.request(f.bases("h1-b3"));
  ok(startRun(f.store, { project }));
  // Row 1: roots are registered by the ordinary producer, but a managed root does not work before its activation.
  const registered = await drive(f, request, 8);
  assert.ok(registered.performed.length > 0 && registered.performed.every(action => action === "open-series"), registered.performed.join(","));
  const roots = ["garden-produce-block", "garden-consume-block"].map(block => blockSeries(f, block)).filter(Boolean);
  assert.ok(roots.length > 0);
  for (const root of roots) {
    assert.equal((root.value as { activation?: { state: string } }).activation?.state, "unactivated", root.id);
    assert.equal(root.value.attempts.length, 0);
  }
  assert.ok(roots.some(root => root.id === registered.wait.target), JSON.stringify(registered.wait));
  // Row 24: the owner's transition excludes the consuming block; its line stays and the pass starts no work of it.
  f.activate("h1-excluded", { features: [{ outcome: "garden-later" }],
    excluded: [{ block: "garden-consume-block", reason: "Keep the independent result only", returnCondition: "Select the original feature again" }] });
  // The producing block stays active and works; its part alone cannot form the frame, so it waits for the other block.
  const cycling = await until(f, request, "cycle", 12);
  assert.ok(cycling.series!.includes("garden-produce-block"), cycling.series!);
  f.steps([nodeAnswer(f, cycling)]);
  const excluded = await drive(f, request, 12);
  assert.equal(excluded.wait.code, "frame_participants", JSON.stringify(excluded.wait));
  assert.equal(blockSeries(f, "garden-consume-block").value.attempts.length, 0, "The excluded block starts no work");
  // Rows 23, 22: the return goes through B3 with its proven basis; new work goes to the current line B3 proves.
  f.activate("h1-return", { features: [{ outcome: "garden-result" }], excluded: [] });
  const opening = await until(f, request, "open", 10);
  const all = f.store.list<RepairSeries>("repair-series");
  const current = all.find(row => row.id === opening.series)!;
  assert.ok(!all.some(other => other.value.predecessor?.id === current.id), "The chosen line has no successor");
  assert.equal((current.value as { activation?: { state: string } }).activation?.state, "activated");
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

test("12 21 H1 stop and origin holds together: the origin route goes first (A6 on the exact hold), no attempt opens, an unestablished origin waits", async t => {
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
  const driven = await drive(f, request, 10);
  assert.deepEqual(driven.performed, ["analyze"], "The origin route first; the stop is not reviewed while a hold stands");
  assert.equal(driven.wait.code, "origin_hold");
  assert.ok(holds.some(hold => hold.id === driven.wait.target), "The wait names the exact hold");
  const analysis = f.store.list().find(row => row.kind === "om-origin-analysis")!;
  assert.equal((analysis.value as { state: string }).state, "origin-unestablished");
  assert.equal(blockSeries(f).value.attempts.length, 3, "No new attempt while the stop and the hold stand");
  const before = f.store.list().map(reference), sends = f.sent().length;
  f.restart();
  assert.equal(ok(await advanceRun(f.store, request)).performed, null);
  assert.deepEqual(f.store.list().map(reference), before, "The standing wait is read, not paid again");
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
  const driven = await drive(f, request, 40);
  const attempt = ["open", "packet", "cycle", "close"];
  assert.deepEqual(driven.performed, ["open-series", ...attempt, ...attempt, ...attempt], JSON.stringify(driven.wait));
  assert.deepEqual(mechanismSeries(f).value.attempts.map(row => row.outcome?.reason), ["off-form", "interrupted", "result"]);
  assert.equal(driven.wait.code, "bases_stale");
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
  const driven = await drive(f, request, 20);
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
