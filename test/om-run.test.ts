import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { historicalProofCounters } from "../src/history/proofs.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { refused, transfer, type OmResult, type Refusal } from "../src/om/refusal.js";
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
import { modelCallRecordId, prepareCompletionCause, runModelCall, runModelCycle, writeCompletionCessation } from "../src/om/model-call.js";
import { ResearchSources } from "../src/discovery/research-sources.js";
import { readQuestionPacket, writeQuestionPacket } from "../src/om/question-packet.js";
import { runStopAnalysis } from "../src/om/stop-analysis.js";
import { gapLineExpectedResult, gapLineKey } from "../src/om/gap-lines.js";
import { advanceRun as currentAdvanceRun, cycleStartOf, readRun, startRun, runId, type RunRequest, type RunRecord, type RunResult, type RunStep, type RunWait, type RunReason } from "../src/om/run.js";
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
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ database, steps })); },
    sent(): unknown[] { return existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) : []; },
    restart(make: (path: string) => Store = path => new Store(path)) { store.close(); store = make(database); engine = new ProductEngine(store); } };
}
type Fixture = ReturnType<typeof runFixture>;
/** An M5 answer addressing every item of its batch. */
function addressAll(f: Fixture, routes: Ref, kind = "repository-fact") {
  const saved = f.store.get<RoutesRecord>(routes.id, routes.revision)!.value;
  const batch = saved.batches.find(item => item.model === "MC2" && item.task === "input-field" && item.items.every(row => row.consumers.length === 0))!;
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
    results: batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: { consumer: "garden-consume-block", kind } })) } };
}
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
/** An MC1 answer to every fact of the block's batch, cited from the project brief. */
function factsAll(f: Fixture, routes: Ref, value: unknown = { answer: "UTF-8" }) {
  const saved = f.store.get<RoutesRecord>(routes.id, routes.revision)!.value;
  const batch = saved.batches.find(item => item.model === "MC1" && item.task === "fact")!;
  const source = f.store.get<{ content: string }>(`source:${project}:brief`)!;
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
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
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: batch.items.map(item => item.gap),
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
  // PF4 (№3499 row 42): the database carries the checks this process saved; a warm cache resumes nothing — the ended
  // pass stays ended on its own record.
  assert.ok(historicalProofCounters().writtenRecords > 0, "The restart meets a warm saved cache");
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
  f.steps([{ research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: m5.items.map(item => item.gap), action: "need_owner",
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
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: batch.items.map(item => item.gap), action: "need_owner",
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
  const ask = (gaps: string[], reason: string) => ({ research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: gaps,
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
  if (batch.model === "MC2") return { research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: batch.items.map(item => item.gap),
    action: "need_owner", reason: "Only the design decision needs the owner", decision: "Choose the design" }, usage };
  const brief = f.store.get<{ content: string }>(`source:${project}:brief`)!;
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", results: batch.items.map(item => ({
    questionId: item.gap, value: { answer: "UTF-8" }, citations: [{ source: reference(brief), selector: { kind: "text-range", start: 0, end: brief.value.content.length } }] })) }, usage };
}

// OWN1 (№3711, №3713) replaces R13 R8 №2045-2: a design question of the pass has its producer — the model decides it.
const OWN1_DECISION = { decision: "Keep the minimal spare records", rationale: "The minimal records do not duplicate the stage states",
  alternatives: [{ option: "Wait for the owner", consequences: "The pass stands at this question until the owner answers" },
    { option: "Record every spare command", consequences: "More records and a risk of duplicating the stage states" }] };
/** The model of the bypass: a fact gets its cited answer, a decision batch the decision with its alternatives. */
function decisionAnswer(f: Fixture, step: { request: unknown }) {
  const saved = (step.request as { packet: Ref }).packet;
  const packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
  const routes = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
  const batch = routes.batches.find(row => row.id === packet.value.request.batch)!;
  if (batch.model !== "MC2") return mixedAnswer(f, step);
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
    results: batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: OWN1_DECISION })) }, usage };
}
/** The paid requests that ask the model for a decision: their response form assigns an answer field. */
const decisionCalls = (f: Fixture) => f.sent().filter(line => (typeof line === "string" ? line : JSON.stringify(line))
  .includes('\\"field\\":{\\"const\\":\\"answer\\"}')).length;
async function restWithDecisions(f: Fixture, request: RunRequest, limit = 90) {
  const answers: Record<string, unknown>[] = [], answered = new Set<string>();
  for (let index = 0; index < limit; index++) {
    const now = ok(await advanceRun(f.store, request)).record.value.state as unknown as RunRecord["state"];
    if (now.phase === "step" && (now.step.action === "cycle" || now.step.action === "assess") && !answered.has(JSON.stringify(now.step.request))) {
      answered.add(JSON.stringify(now.step.request));
      answers.push(now.step.action === "assess" ? assessor("supported") : decisionAnswer(f, now.step));
      f.steps(answers);
    }
    if (now.phase === "waiting" || now.phase === "unable" || now.phase === "complete") return now;
  }
  assert.fail("The pass did not come to rest");
}
test("OWN1 H1.2 R13 R8 a fact and a design decision of one block are each asked once: the fact is applied, the model's decision with its alternatives stands decided in B1, and the pass ends on neither", async t => {
  const f = runFixture(t, ["encoding", "spare"]);
  addressQuestions(f, [["encoding", "repository-fact"], ["spare", "design-decision"]]);
  const request = f.request();
  ok(startRun(f.store, { project }));
  const state = await restWithDecisions(f, request);
  // At rest — idle on its bases or ending for another reason — never on these questions.
  assert.ok(!(state.phase === "unable" ? reasonsOf(state) : []).some(row => row.target === "discovery:spare" || row.target === "discovery:encoding"), JSON.stringify(state));
  const input = f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input;
  assert.deepEqual(input.decided?.map(row => [row.question.id, row.value]), [["discovery:spare", OWN1_DECISION]],
    `${JSON.stringify(state).slice(0, 600)} ${actions(f.store).join(",")}`);
  assert.ok(input.decided![0]!.decision.id.startsWith(`om-input-decision:${project}:`));
  assert.ok(input.facts?.some(row => row.question.id === "discovery:encoding"), "The fact is applied");
  assert.ok(!input.questions.some(row => row.id === "discovery:spare" || row.id === "discovery:encoding"));
  assert.equal(decisionCalls(f), 1, "The decision is paid once");
  const sent = f.sent().length;
  f.restart();
  for (let index = 0; index < 3; index++) ok(await advanceRun(f.store, request));
  assert.equal(f.sent().length, sent, "A restart pays for nothing again");
});

// OWN1 (№3711): an owner question of the pass is the model's since; a confirmation of the environment the pass itself
// needs (moment om-pass) still has no producer in this product.
test("H1.2 R13b a blocking question nobody can answer in this product ends the pass on that exact question, with no attempt open and nothing invented", async t => {
  const f = runFixture(t, ["encoding"]);
  const input = f.store.get(`om-input:${project}`)!;
  ok(writeAddressing(f.store, { project, input: reference(input), graph: f.graph, decisions: [{ pending: structuredClone(inputDecisionWrite({
    project, input: reference(input), graph: f.graph, layers: [], decision: { target: "discovery:encoding", field: "address",
      value: { consumer: "garden-consume-block", kind: "environment-confirmation" } } })) as Write }] }));
  const request = f.request();
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 10);
  const reasons = reasonsOf(end.state);
  assert.deepEqual(reasons.map(row => [row.kind, row.code, row.target]), [["unsupported-question", "route_result_unsupported", "discovery:encoding"]]);
  assert.equal(reasons[0]!.field, "answer");
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
  f.steps([m5, { research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: [gap], action: "need_owner",
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
  writeFileSync(scenario, JSON.stringify({ database: f.database, steps: [{ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", proposal: body, bindings: [] }, usage }] }));
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
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", proposal }, usage };
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
      steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", proposal: body, bindings: [] }, usage });
      writeFileSync(scenario, JSON.stringify({ database, steps }));
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

// OWN1 (№3711, №3716) replaces the end of R13/R13b: in the bypass a late question no H2 assigned no longer ends the pass —
// the engine carries it to its own consumer with what the pass knows of its own database; the question stays open.
test("OWN1 H1.2 R13 R13b a late question of the environment no H2 assigned is carried by the engine to its consumer with the facts of its own database; the works go on, the question stays open and no owner command is invented", async t => {
  const f = worksFixture(t, true);
  ok(startRun(f.store, { project }));
  const performed: string[] = [], answered = new Set<string>();
  let state: { phase: string; step?: { action: string; request: { packet: Ref } }; wait?: unknown } = { phase: "" };
  for (let index = 0; index < 200; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    if (advanced.performed) performed.push(advanced.performed.action);
    state = advanced.record.value.state as unknown as typeof state;
    if (state.phase === "step" && state.step!.action === "cycle" && !answered.has(state.step!.request.packet.id)) {
      answered.add(state.step!.request.packet.id); f.answer(state.step!.request.packet);
    }
    if (state.phase === "waiting" || state.phase === "complete" || state.phase === "unable") break;
  }
  // The works are asked of the model on the D7 ledger; binding the carried obligation to a work is the model's (this
  // fixture's answers bind none, so the works are not accepted here).
  assert.ok(performed.indexOf("obligations") >= 0 && performed.indexOf("cycle", performed.indexOf("obligations")) > 0,
    `D7 and the works go on: ${performed.join(",")} ${JSON.stringify(state)}`);
  assert.ok(f.sent().length > 0, "The works are asked of the model");
  const carried = f.store.list<{ assignments: { kind: string; responsibleNode: string; responsibleConsumer: string; reason: string; returnCondition: string | null }[] }>("om-obligations")
    .flatMap(row => row.value.assignments).filter(row => row.kind === "environment-confirmation");
  assert.ok(carried.length >= 1, "The late gap is in the ledger");
  for (const row of carried) {
    assert.deepEqual([row.responsibleNode, row.responsibleConsumer], ["garden-consume-block", "garden-consume-block"]);
    assert.match(row.reason, /^Assigned by the engine in the bypass: the consumer answers it at task-start\. Own database facts at this pass: stages discovery stage:garden:discovery@\d+/);
    assert.equal(row.returnCondition, "Which runtime does the task start on?");
  }
  assert.equal(f.store.list("om-owner-gap-assignment").length, 0, "The pass invents no owner command");
  assert.ok(f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input.questions.some(row => row.id === "discovery:later-env"), "The question stays open");
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
  f.steps([{ research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: m5.items.map(item => item.gap), action: "need_owner",
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
  // LP5 (№3278 rows 2, 6, 13): the replaced B1 of the area also ends the registered check, so the attempt closes by the
  // common G7 instead of waiting on its stale check; the bases of the new B1 come next.
  const driven = await driveTo(f, request, "close", 20);
  assert.deepEqual(driven.performed, ["cease", "cease-check", "close"], JSON.stringify(driven.wait));
  assert.equal(f.sent().length, sends, "The ended assignment is never sent");
  assert.ok(f.store.list().some(row => row.kind === "om-completion-cessation"), "The proved cessation is its own record");
  assert.equal(blockSeries(f).value.attempts[0]!.outcome!.reason, "interrupted");
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
  const loaded = historicalProofCounters().loaded;
  const resumed = ok(await advanceRun(f.store, request));
  // PF4 (№3499 row 43): the restarted process takes the checks the lost one saved; the saved receipt still decides.
  assert.ok(historicalProofCounters().loaded > loaded, "The restart is served by saved checks");
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
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: questions, action: "cannot_answer",
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

// OWN1 (№3711) replaces H1.5 №2164: an owner question of the pass is asked of the model once and decided by it.
test("OWN1 H1.5 №2164 an owner question of the pass is asked of the model once: its decision stands decided in B1, om-decisions shows it with its alternatives, and the pass does not end on it", async t => {
  const f = runFixture(t, ["spare"]);
  addressQuestions(f, [["spare", "owner-decision"]]);
  const bases = f.bases(), request = f.request();
  assert.ok(answerBatch(f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!.value), "M6 routes the question to the model");
  ok(startRun(f.store, { project }));
  const state = await restWithDecisions(f, request);
  assert.ok(!(state.phase === "unable" ? reasonsOf(state) : []).some(row => row.target === "discovery:spare"), JSON.stringify(state));
  const listed = ok(new ProductEngine(f.store).execute({ type: "om-decisions", project }) as unknown as OmResult<{ decisions: { id: string; kind: string; decision: string; alternatives: unknown[]; call: Ref | null; at: string | null }[] }>);
  assert.deepEqual(listed.decisions.map(row => [row.id, row.kind, row.decision, row.alternatives.length]),
    [["discovery:spare", "owner-decision", OWN1_DECISION.decision, 2]]);
  assert.ok(listed.decisions[0]!.call?.id.startsWith(`model-call:${project}:om:`), "The model call that decided it");
  assert.ok(!Number.isNaN(Date.parse(listed.decisions[0]!.at!)), "and when it started");
  assert.equal(f.store.list().filter(row => row.id.startsWith("om-owner-result:")).length, 0, "No owner result is invented");
  assert.equal(decisionCalls(f), 1, "The decision is paid once");
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

/** A managed attempt of `block` planned on exactly this batch — the plan an earlier pass saved (the reviewer's helper, №2221). */
function openPlanned(f: Fixture, bases: RunBases, block: string, batches: readonly RouteBatch[], slice = "before-h15", seriesCommit?: string) {
  const opening = { project, block, line: 1, slice, predecessor: null, basis: null };
  // Q3 (№2573-1, №2580): a line an earlier commit continues is opened by that commit's own producer; every other scenario
  // opens it with the current code, in the new era.
  if (seriesCommit) atCommit(f, seriesCommit, "era-series", `const { openSeries } = await import(src('om/series.js'));
out(reference(take(openSeries(store, args))));`, opening);
  else ok(openSeries(f.store, opening));
  const goal = { key: `${slice}:${block}`, questions: [...new Set(batches.flatMap(batch => batch.items.map(item => gapLineKey(project, item.target, item.field))))].sort(),
    result: gapLineExpectedResult(project, batches[0]!.items[0]!.target, batches[0]!.items[0]!.field) };
  return ok(openAttempt(f.store, { project, block, line: 1, attempt: 1, goal, completion: { routes: bases.routes, batches: batches.map(batch => batch.id).sort() } }));
}
/** The saved end comes back from a new store: the same record, nothing performed, nothing sent. */
async function sameEnd(f: Fixture, request: RunRequest, sends: number) {
  const saved = ok(readRun(f.store, { project }))!;
  f.restart();
  const again = ok(await advanceRun(f.store, request));
  assert.deepEqual([again.performed, again.record.hash], [null, saved.hash], "A new store returns the same end");
  assert.equal(f.sent().length, sends);
}

// OWN1 (№3719, return of Codex-omg): the owner's answer is above the model's, and a decision packet asks no owner.
import { issueOwnerInvitation, OwnerSessions } from "../src/product/owner-authority.js";
import { writeOwnerResult } from "../src/om/owner-result.js";
import { checkAnswerForm } from "../src/om/answer-form.js";
test("OWN1 №3719 P2-1 an owner's H2 answer of a question the bypass gives the model is its decision: the model is never asked, B1 holds the owner's value, om-decisions names the owner", async t => {
  const f = runFixture(t, ["spare"]);
  addressQuestions(f, [["spare", "owner-decision"]]);
  const bases = f.bases(), request = f.request();
  const routes = f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!;
  const routed = routes.value.routes.find(row => row.kind === "owner-decision")! as unknown as { record: Ref; route: string };
  assert.equal(routed.route, "design", "The bypass routes it to the model");
  const sessions = new OwnerSessions(f.store), { invitation } = ok(issueOwnerInvitation(f.store, { project }));
  const authority = sessions.authority(ok(sessions.exchange({ project, invitation })).bearer)!;
  const owner = ok(writeOwnerResult(f.store, authority, { project, routes: reference(routes), gap: routed.record,
    value: "Retain every record permanently", basis: "Explicit choice for this question" }, { routes: readRoutes, input: readOmInput }));
  ok(startRun(f.store, { project }));
  const state = await restWithDecisions(f, request);
  assert.ok(!(state.phase === "unable" ? reasonsOf(state) : []).some(row => row.target === "discovery:spare"), JSON.stringify(state));
  assert.equal(decisionCalls(f), 0, "The model is never asked the question the owner answered");
  const input = f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input;
  assert.deepEqual(input.decided?.map(row => [row.question.id, row.value]),
    [["discovery:spare", { owner: reference(owner.result), value: "Retain every record permanently" }]]);
  assert.ok(!input.questions.some(row => row.id === "discovery:spare"));
  const listed = ok(new ProductEngine(f.store).execute({ type: "om-decisions", project }) as unknown as OmResult<{ decisions: { id: string; by: string; decision: string; owner: Ref | null; alternatives: unknown[] }[] }>);
  assert.deepEqual(listed.decisions.map(row => [row.id, row.by, row.decision, row.owner, row.alternatives.length]),
    [["discovery:spare", "owner", "Retain every record permanently", reference(owner.result), 0]]);
});
test("OWN1 №3719 P2-2 a decision packet asks no owner: no need_owner in its form or examples, every example passes its own check, and a need_owner reply is a correctable refusal", async t => {
  const f = runFixture(t, ["spare"]);
  addressQuestions(f, [["spare", "design-decision"]]);
  const request = f.request();
  ok(startRun(f.store, { project }));
  let saved: Ref | null = null;
  for (let index = 0; index < 20 && !saved; index++) {
    const now = ok(await advanceRun(f.store, request)).record.value.state as unknown as RunRecord["state"];
    if (now.phase === "step" && now.step.action === "cycle") saved = (now.step.request as unknown as { packet: Ref }).packet;
    else if (now.phase !== "step" && now.phase !== "ready") assert.fail(`The pass stood before its decision cycle: ${JSON.stringify(now)}`);
  }
  assert.ok(saved, "The decision packet is issued");
  const payload = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!.value.packet as unknown as {
    responseForm: { schema: { oneOf: { properties: { action?: { const?: string } } }[] } }; brief: { examples: Record<string, Json>[]; text: string } };
  assert.ok(!payload.responseForm.schema.oneOf.some(branch => branch.properties.action?.const === "need_owner"));
  assert.ok(!payload.brief.examples.some(example => example.action === "need_owner"));
  assert.ok(payload.brief.text.includes("the owner is not asked in this pass"));
  for (const example of payload.brief.examples) {
    const checked = checkAnswerForm(f.store, { project, packet: saved, raw: canonical(example) });
    assert.ok(checked.ok, `${canonical(example)}: ${checked.ok ? "" : `${checked.refusal.code} ${checked.refusal.message}`}`);
    if (example.action === "answer") assert.equal(checked.value.kind, "input-decisions");
  }
  const control = payload.brief.examples.find(example => example.action === "cannot_answer")!;
  const asked = checkAnswerForm(f.store, { project, packet: saved, raw: canonical({ ...control, action: "need_owner", reason: "Ask the owner", decision: "Choose the policy" }) });
  assert.equal(asked.ok ? "accepted" : asked.refusal.code, "part_answer_invalid");
  // The pass itself: a model that asks for the owner gets the correction of its answer, and decides on it.
  const issued = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!.value.request;
  const batch = f.store.get<RoutesRecord>(issued.routes.id, issued.routes.revision)!.value.batches.find(row => row.id === issued.batch)!;
  f.steps([{ research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: batch.items.map(item => item.gap), action: "need_owner",
    reason: "The policy needs the owner", decision: "Choose the policy" }, usage },
  { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
    results: batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: OWN1_DECISION })) }, usage }]);
  let state: RunRecord["state"] | null = null;
  for (let index = 0; index < 60 && !state; index++) {
    const now = ok(await advanceRun(f.store, request)).record.value.state as unknown as RunRecord["state"];
    if (now.phase === "waiting" || now.phase === "unable" || now.phase === "complete") state = now;
  }
  assert.deepEqual(f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input.decided?.map(row => [row.question.id, row.value]),
    [["discovery:spare", OWN1_DECISION]], JSON.stringify(state));
  assert.equal(f.sent().length, 2, "The asked owner is one corrected answer, not a wait");
});

// OWN1 (№3711): the H1.5 tests of a blocking batch no producer serves are gone with it — a design or owner question of the
// pass is the model's now (above); a question of a later moment keeps its unserved batch and is no ground (below).
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




// ---- LP3 (№2817): a refusal caused by the content of a model answer or the size of its continuation ends the attempt ----
const LP3_BASE_COMMIT = "d519a6036f8b2cc4aee823ce24d7160262a08fb9";
const LP3_PACKET_COMMIT = "dd5fc67dec910d3c26c6516c0c2ebfc60413f981";
const lp3NativePacketFixtures = new Set<{ database: string; store: Store }>();
let lp3PacketProducer: string | undefined;
let lp3PacketDirectory: string | undefined;
process.once("exit", () => { if (lp3PacketDirectory) rmSync(lp3PacketDirectory, { recursive: true, force: true }); });
/** One genuine pre-brief build for the entire suite; each packet step runs in a separate process. */
function lp3Producer(): string {
  if (lp3PacketProducer) return lp3PacketProducer;
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "omg-lp3-native-packets-"));
  lp3PacketDirectory = root;
  const archive = execFileSync("git", ["archive", LP3_PACKET_COMMIT, "src", "package.json"], { cwd: repository, maxBuffer: 50_000_000 });
  execFileSync("tar", ["-x", "-C", root], { input: archive });
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", LP3_PACKET_COMMIT, "src"], { cwd: repository, encoding: "utf8" })
    .trim().split("\n").filter(path => path.endsWith(".ts"));
  for (const path of files) {
    const output = join(root, "dist", path.replace(/\.ts$/, ".js"));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, ts.transpileModule(readFileSync(join(root, path), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText);
  }
  lp3PacketProducer = join(root, "packet.mjs");
  writeFileSync(lp3PacketProducer, `import assert from 'node:assert/strict';
import { Store } from './dist/src/storage/store.js';
import { advanceRun, readRun } from './dist/src/om/run.js';
const store = new Store(process.argv[2]), request = JSON.parse(process.argv[3]);
try {
  const before = readRun(store, { project: request.project });
  assert.ok(before.ok && before.value?.value.state.phase === 'step' && before.value.value.state.step.action === 'packet');
  const result = await advanceRun(store, request);
  assert.ok(result.ok && result.value.performed?.action === 'packet');
  process.stdout.write(JSON.stringify(result));
} finally { store.close(); }
`);
  return lp3PacketProducer;
}
function lp3NativePackets<T extends { database: string; store: Store }>(t: test.TestContext, f: T): T {
  lp3NativePacketFixtures.add(f);
  t.after(() => lp3NativePacketFixtures.delete(f));
  return f;
}
/** Only opted-in LP3 roots use the old packet producer; selection, cycles, closure and recovery use today's code. */
async function advanceRun(...args: Parameters<typeof currentAdvanceRun>): ReturnType<typeof currentAdvanceRun> {
  const [store, request, control] = args;
  const fixture = [...lp3NativePacketFixtures].find(f => f.store === store);
  if (fixture && control === undefined) {
    const found = readRun(store, { project: request.project });
    const state = found.ok ? found.value?.value.state : null;
    if (state?.phase === "step" && state.step.action === "packet") {
      const body = state.step.request as { continuation?: unknown; previous?: unknown[] };
      assert.ok(!body.continuation && !body.previous?.length, "The legacy producer intercepts only an independent root's saved packet step");
      return JSON.parse(execFileSync(process.execPath, [lp3Producer(), fixture.database, JSON.stringify(request)],
        { encoding: "utf8", timeout: 180_000, maxBuffer: 10_000_000 })) as Awaited<ReturnType<typeof currentAdvanceRun>>;
    }
  }
  return currentAdvanceRun(...args);
}
/** A need_source of the M5 mechanism batch (MC2 input-field) asking for the given reads. */
function lp3Need(f: Fixture, routes: Ref, reads: unknown[]) {
  const saved = f.store.get<RoutesRecord>(routes.id, routes.revision)!.value;
  const batch = saved.batches.find(item => item.model === "MC2" && item.task === "input-field" && item.items.every(row => row.consumers.length === 0))!;
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_source", questionIds: batch.items.map(item => item.gap),
    missing: "Need the addressed data", reads }, usage };
}
/** Where the root packet of the first mechanism attempt stands among its work's products against its blocked continuation. */
function lp3Order(f: Fixture): "root-first" | "continuation-first" {
  const work = f.store.list<{ products: Ref[] }>("om-completion-work").map(row => f.store.history<{ products: Ref[] }>(row.id)[0]!).at(0)!;
  const last = f.store.history<{ products: Ref[] }>(work.id).at(-1)!;
  const packets = last.value.products.map(ref => f.store.get<{ packet?: Ref }>(ref.id, ref.revision)!).filter(row => row.kind === "om-completion-packet")
    .map(row => f.store.get<QuestionPacketRecord>(row.value.packet!.id, row.value.packet!.revision)!.value.request.continuation ? "continuation" : "root");
  assert.equal(packets.length, 2, "One root packet and its blocked continuation");
  return packets[0] === "root" ? "root-first" : "continuation-first";
}
/** Every cycle of the pass ended blocked; nothing but the attempts' own packets and the one review was sent. */
function lp3Blocked(f: Fixture, sends: number) {
  const cycles = f.store.list<{ terminal: string; next: Ref | null }>("om-model-cycle");
  assert.ok(cycles.length > 0 && cycles.every(row => row.value.terminal === "blocked" && row.value.next !== null), "Each cycle ends blocked on its continuation");
  for (const cycle of cycles) {
    const blocked = f.store.get<QuestionPacketRecord>(cycle.value.next!.id, cycle.value.next!.revision)!;
    assert.equal(blocked.value.state, "blocked");
    assert.equal(f.store.get(modelCallRecordId(project, (blocked.value.packet as { requestId?: string } | null)?.requestId ?? "none")), null,
      "The blocked continuation was never sent");
  }
  assert.equal(f.sent().length, sends);
}
const LP3_CONTENTS = { "root-first": "UTF-8 ".repeat(40_000) };
const LP3_UNPROVED: Record<string, string> = {};
/** A view of the store in which one exact record cannot be read; everything else, writes included, goes to the store. */
function lp3Hiding(store: Store, id: string): Store {
  return new Proxy(store, { get(target, key) {
    if (key === "get") return (at: string, revision?: number) => at === id ? null : target.get(at, revision);
    const member: unknown = Reflect.get(target, key, target);
    return typeof member === "function" ? member.bind(target) : member;
  } });
}

test("LP3 (№2817 rows 3, 4, №52) a continuation the capacity cannot hold ends its cycle blocked and is never sent: the pass closes each attempt through G7, goes up the ladder and ends by A6 — never waiting on the blocked packet; the start of the root's cycle is chosen by its links in both positions of root and continuation", async t => {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("lp3-52"), request = f.request(b);
  writeFileSync(join(f.root, "repo", "big.txt"), LP3_CONTENTS["root-first"]);
  const need = lp3Need(f, b.routes, [{ action: "read", path: "big.txt", media: "text/plain" }]);
  f.steps([need, need, need, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const first = await driveTo(f, request, "close", 20);
  assert.deepEqual(first.performed.slice(-2), ["cycle", "close"], `The blocked root is closed by G7, not waited on (products ${lp3Order(f)})`);
  // Both positions of the root packet and its blocked continuation, without relying on the order the hashes gave here.
  const packets = f.store.list<QuestionPacketRecord>("question-packet");
  const root = reference(packets.find(row => !row.value.request.continuation)!), continuation = reference(packets.find(row => row.value.request.continuation)!);
  for (const order of [[root, continuation], [continuation, root]]) assert.deepEqual(cycleStartOf(f.store, project, order), { ok: true, value: root });
  assert.deepEqual(cycleStartOf(f.store, project, [continuation]), { ok: true, value: null }, "A continuation alone starts no cycle");
  // №2870: a packet whose place E2's reader does not prove is no continuation: its refusal stands, in either position.
  const unproved = { missing: { ...continuation, id: `${continuation.id}-missing` }, stale: { ...continuation, hash: "0".repeat(64) }, foreign: lp3Context(f) };
  for (const [name, ref] of Object.entries(unproved)) {
    const refusals = [[root, ref], [ref, root]].map(order => cycleStartOf(f.store, project, order));
    assert.ok(refusals.every(found => !found.ok), `${name}: ${JSON.stringify(refusals)}`);
    assert.deepEqual(refusals[0], refusals[1], `${name}: the same refusal in both positions`);
    LP3_UNPROVED[name] = (refusals[0] as { refusal: { code: string } }).refusal.code;
  }
  assert.deepEqual(LP3_UNPROVED, { missing: "record_missing", stale: "record_forged", foreign: "record_foreign" });
  const end = await ends(f, request, 60);
  assert.equal(end.state.phase, "unable", JSON.stringify(end.state));
  assert.equal(mechanismSeries(f).value.attempts.length, 3, "Three attempts of the ladder");
  lp3Blocked(f, 4);
  const roots = f.store.list<QuestionPacketRecord>("question-packet").filter(row => !row.value.request.continuation).map(reference);
  const two = cycleStartOf(f.store, project, roots.slice(0, 2));
  assert.ok(!two.ok && two.refusal.code === "run_record_invalid", "Two starts are an addressed refusal, never a second dispatch");
  await sameEnd(f, request, 4);
});

/** The context record a search names as its scope: the B1 the mechanism packet supplies (a record of the project, no source). */
const lp3Context = (f: Fixture): Ref => reference(f.store.get(`om-input:${project}`)!);

test("LP3 (№2817 row 2, №53) a need_source whose search names a context record as its scope ends the cycle as reads-invalid with its record_foreign: the pass closes the attempt, goes on to the next and never waits on the refusal; a source scope and read_context of the same record still deliver", async t => {
  const f = lp3NativePackets(t, runFixture(t, ["encoding"]));
  const b = f.bases("lp3-53"), request = f.request(b);
  const need = lp3Need(f, b.routes, [{ action: "search", within: lp3Context(f), query: "encoding" }]);
  f.steps([need, need, need, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const first = await driveTo(f, request, "close", 20);
  assert.deepEqual(first.performed.slice(-2), ["cycle", "close"]);
  const end = await ends(f, request, 60);
  assert.equal(end.state.phase, "unable", JSON.stringify(end.state));
  const cycles = f.store.list<{ terminal: string; diagnostic: Ref }>("om-model-cycle");
  assert.equal(cycles.length, 3); assert.ok(cycles.every(row => row.value.terminal === "reads-invalid"));
  for (const cycle of cycles) assert.equal(f.store.get<{ refusals: { code: string }[] }>(cycle.value.diagnostic.id)!.value.refusals[0]!.code, "record_foreign");
  assert.deepEqual(f.store.list("om-read-delivery"), [], "Nothing was read");
  assert.equal(f.sent().length, 4, "Three attempts and the one review");
  await sameEnd(f, request, 4);
});

test("MP1 LP3 №53 in the brief era: a search scope naming a context Ref is refused by E2 label decoding during E3 admission; the pass closes all three attempts without waiting or delivering reads — MP2 (№2968): each managed attempt corrects that repairable answer once", async t => {
  const f = runFixture(t, ["encoding"]), b = f.bases("mp1-lp3-53"), request = f.request(b);
  const need = lp3Need(f, b.routes, [{ action: "search", within: lp3Context(f), query: "encoding" }]);
  // MP2 (№2968 §3): an unissued label in reads is answer content of MP1's closed repairable class (briefAnswerRepairable):
  // each attempt gets its one correction, answered here the same way.
  f.steps([need, need, need, need, need, need, stopAnswer(f, false)]);
  ok(startRun(f.store, { project }));
  const end = await ends(f, request, 80);
  assert.equal(end.state.phase, "unable", JSON.stringify(end.state));
  const packets = f.store.list<QuestionPacketRecord>("question-packet");
  const roots = packets.filter(row => !row.value.request.correction), corrections = packets.filter(row => row.value.request.correction);
  assert.equal(roots.length, 3); assert.equal(corrections.length, 3);
  assert.ok(packets.every(row => row.value.packetContract === "om-packet/brief-v1"));
  for (const correction of corrections) assert.ok(roots.some(root => root.id === correction.value.request.correction!.packet.id),
    "Each correction names the rejected step of its own chain");
  const calls = f.store.list<{ error: string | null; status: string; om?: { failure?: Refusal } }>("model-call")
    .filter(row => row.value.error === "answer_label_unknown");
  assert.equal(calls.length, 6);
  for (const call of calls) assert.deepEqual([call.value.status, call.value.om?.failure?.at.unit, call.value.om?.failure?.at.field],
    ["failed", "E2", "reads/0/within"]);
  const cycles = f.store.list<{ terminal: string; cyclePolicy?: string }>("om-model-cycle");
  assert.equal(cycles.length, 3);
  assert.ok(cycles.every(row => row.value.terminal === "outcome" && row.value.cyclePolicy === "brief-correction/v1"));
  assert.deepEqual(f.store.list("om-read-delivery"), []);
  assert.equal(end.performed.filter(action => action === "close").length, 3);
  assert.equal(f.sent().length, 7, "Six answers — one correction per attempt — and one review; no repeated delivery or paid call");
  await sameEnd(f, request, 7);
});

test("LP3 (№2870, №2817 row 9) a packet whose record cannot be read is never taken for a continuation: a saved cycle of it is performed as saved and its producer's record_missing stands as the pass's wait — no ready, no new packet, nothing sent; once the record is read again the same saved cycle goes on", { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, async t => {
  const f = lp3NativePackets(t, runFixture(t, ["encoding"]));
  const b = f.bases("lp3-2870"), request = f.request(b);
  f.steps([lp3Need(f, b.routes, [{ action: "search", within: lp3Context(f), query: "encoding" }])]);
  ok(startRun(f.store, { project }));
  // The selection: ready after the packet step, the root's packet unreadable — the pass's addressed refusal, nothing written,
  // never a second packet.
  let head = ok(readRun(f.store, { project }))!;
  for (let index = 0; index < 20 && !(head.value.state.phase === "ready" && head.value.last?.step.action === "packet"); index++)
    head = ok(await advanceRun(f.store, request)).record;
  assert.equal(head.value.last?.step.action, "packet");
  const packet = head.value.last!.products.find(ref => ref.id.startsWith(`om-question-packet:${project}:`))!;
  const chosen = await advanceRun(lp3Hiding(f.store, packet.id), request);
  assert.deepEqual(chosen.ok ? chosen.value.record.value.state : [chosen.refusal.code, chosen.refusal.at.target], ["record_missing", packet.id]);
  assert.equal(ok(readRun(f.store, { project }))!.revision, head.revision, "Nothing was written");
  // The saved step: the root's cycle chosen, then its packet unreadable — performed as saved, its refusal stands.
  const step = await until(f, request, "cycle");
  assert.ok(isRefOf(step.request, packet), "The saved cycle is the root's own");
  const before = ok(readRun(f.store, { project }))!.revision;
  const performed = ok(await advanceRun(lp3Hiding(f.store, packet.id), request));
  const state = performed.record.value.state;
  assert.notEqual(state.phase, "ready", JSON.stringify(state));
  assert.deepEqual([performed.record.revision, performed.performed?.action, performed.record.value.last?.refusal?.code, f.sent().length],
    [before + 1, "cycle", "record_missing", 0], "The cycle was performed as saved and refused by its producer; nothing was sent");
  assert.deepEqual(f.store.list("om-model-cycle"), []);
  const again = ok(await advanceRun(f.store, request));
  assert.deepEqual([again.performed?.action, f.sent().length], ["cycle", 1], "The same saved cycle goes on once its packet is read");
  assert.equal(f.store.list<{ terminal: string }>("om-model-cycle")[0]!.value.terminal, "reads-invalid");
});
const isRefOf = (request: unknown, packet: Ref): boolean => canonical((request as { packet?: Ref }).packet ?? null) === canonical(packet);

test("LP3 (№2870, works-v1) an H1 works root whose three lawful read_context reads leave a continuation the capacity cannot hold ends each cycle blocked, never sends the blocked packet and reaches the attempt's close through G7 — also after a restart between steps", async t => {
  const f = lp3NativePackets(t, worksFixture(t)), capture = new ResearchSources(f.store, project, f.root), reads: unknown[] = [];
  for (let index = 0; index < 3; index++) {
    writeFileSync(join(f.root, `context-${index}.txt`), `context ${index} ${"x".repeat(90_000)}`);
    reads.push({ action: "read_context", record: reference(capture.read(`context-${index}.txt`, "text/plain")), pointer: "/content" });
  }
  ok(startRun(f.store, { project }));
  const steps: unknown[] = [], performed: string[] = [], answered = new Set<string>();
  let closed = false;
  for (let index = 0; index < 45 && !closed; index++) {
    const advanced = ok(await advanceRun(f.store, f.request)), state = advanced.record.value.state;
    if (advanced.performed) performed.push(advanced.performed.action);
    assert.notEqual(state.phase, "waiting", JSON.stringify({ state, performed }));
    if (state.phase === "step" && state.step.action === "cycle") {
      const ref = (state.step.request as unknown as { packet: Ref }).packet;
      if (!answered.has(ref.id)) {
        answered.add(ref.id);
        const saved = f.store.get<QuestionPacketRecord>(ref.id, ref.revision)!.value;
        assert.deepEqual([saved.packetContract, saved.state], ["om-packet/works-v1", "ready"]);
        steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_source",
          questionIds: (saved.packet as { questions: { id: string }[] }).questions.map(question => question.id),
          missing: "Read the three supplied context values", reads }, usage });
        writeFileSync(join(f.root, "scenario.json"), JSON.stringify({ steps }));
      }
    }
    if (advanced.performed?.action === "cycle") {
      const cycles = f.store.list<{ terminal: string }>("om-model-cycle");
      assert.ok(cycles.length > 0 && cycles.every(row => row.value.terminal === "blocked"), JSON.stringify(cycles.map(row => row.value.terminal)));
      assert.equal(f.sent().length, steps.length, "The blocked continuation is never sent");
      f.restart();
    }
    closed = advanced.performed?.action === "close";
  }
  assert.ok(closed, performed.join(","));
  assert.ok(f.store.list("om-read-delivery").length >= 3, "The three lawful reads were delivered");
  assert.equal(f.sent().length, steps.length);
});

// LP3 (№2876, Q2b №2518-2): the start of a root's cycle keeps the narrow codes of H1 — its own and E2's reader's, marked
// with their source. The negative probe is real TypeScript: its `@ts-expect-error` line fails to compile for the stated
// reason only, so an unused directive breaks the build (tsc over test/**).
const asCycleStart = (result: ReturnType<typeof cycleStartOf>): ReturnType<typeof cycleStartOf> => result;
const asRunResult = <T>(result: RunResult<T>): RunResult<T> => result;
test("LP3 (№2876) a cycle start is refused only with the codes of H1 and of E2's reader marked with its source; the refusal keeps the reader's bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "omg-lp3-codes-")), store = new Store(join(root, "state.sqlite"));
  try {
    const ghost: Ref = { id: `om-question-packet:${project}:${"0".repeat(64)}`, revision: 1, hash: "0".repeat(64) };
    const read = readQuestionPacket(store, { project, record: ghost });
    const lawful = transfer("question-packet", read), started = cycleStartOf(store, project, [ghost]);
    // A lawful result of the reader, through its source, is a result of a cycle start; the result is one of H1's.
    assert.equal(asCycleStart(lawful).ok, false);
    assert.equal(asRunResult<Ref | null>(started).ok, false);
    const unmarked = refused("reviewer_arbitrary_code", "probe", { unit: "H1", target: "probe" }, "producer");
    // @ts-expect-error an unmarked refusal with an arbitrary code is no result of a cycle start (№2876)
    asCycleStart(unmarked);
    // Runtime: the mark is a type only — code, message, address and route are the reader's own.
    assert.ok(!read.ok && !started.ok);
    assert.equal(read.refusal.code, "record_missing");
    assert.equal(JSON.stringify(started.refusal), JSON.stringify(read.refusal));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("LP3 (№2817 п.4, п.7) the base d519a60 in its own process leaves the pass waiting on №52 and №53; the new code reopens it and finishes the saved work by an ordinary transition without paying the saved call again, the old revisions and records untouched", async t => {
  for (const kase of ["52", "53"] as const) await t.test(kase, async t => {
    const f = runFixture(t, ["encoding"]);
    if (kase === "53") lp3NativePackets(t, f);
    const b = f.bases(`lp3-era-${kase}`), request = f.request(b);
    writeFileSync(join(f.root, "repo", "big.txt"), LP3_CONTENTS["root-first"]);
    const need = lp3Need(f, b.routes, kase === "52" ? [{ action: "read", path: "big.txt", media: "text/plain" }]
      : [{ action: "search", within: lp3Context(f), query: "encoding" }]);
    f.steps([need, need, need, stopAnswer(f, false)]);
    const stuck = atCommit(f, LP3_BASE_COMMIT, `lp3-era-${kase}`, `const { advanceRun, startRun } = await import(src('om/run.js'));
take(startRun(store, { project: args.project }));
const seen = [];
for (let index = 0; index < 30; index++) {
  const advanced = take(await advanceRun(store, args.request));
  const state = advanced.record.value.state;
  seen.push(state.phase === 'waiting' ? 'waiting:' + state.wait.code : state.phase);
  if (state.phase === 'waiting' && seen.at(-2) === seen.at(-1)) break;
}
out(seen);`, { request, project }) as string[];
    assert.match(stuck.at(-1)!, /^waiting:/, `The base code stands on a wait: ${stuck.join(",")}`);
    assert.equal(f.sent().length, 1, "The base code paid once");
    f.restart();
    const before = f.store.list().map(reference);
    const end = await ends(f, request, 60);
    assert.equal(end.state.phase, "unable", JSON.stringify(end.state));
    assert.equal(f.sent().length, 4, "The saved call is not paid again: only the next attempts and the review are sent");
    for (const ref of before) assert.deepEqual(reference(f.store.get(ref.id, ref.revision)!), ref, `${ref.id}@${ref.revision} stands as the base code wrote it`);
    const terminals = f.store.list<{ terminal: string }>("om-model-cycle").map(row => row.value.terminal);
    assert.ok(terminals.length === 3 && terminals.every(terminal => terminal === (kase === "52" ? "blocked" : "reads-invalid")), terminals.join(","));
    await sameEnd(f, request, 4);
  });
});


// ---- LP4 (№2887): a step of a node's cycle ceased on a changed environment no longer stops the pass ----
const LP4_COMMITS = { "3cba953": "3cba9536e2d8fd8ad4fdb0b04b7a84014c9b7da0", "202c470": "202c4709a02316338275e66c7acb173498b30a39" } as const;
type WorksRun = ReturnType<typeof worksFixture>;
/** The roles moved onto another copy of the adapter: a lawful configure that ends their old steps (№2872). */
function lp4Configure(f: WorksRun, request: RunRequest): RunRequest {
  const moved = join(f.root, "adapter-next.mjs"), old = f.store.get<Record<string, Json>>(`environment:${project}`)!;
  writeFileSync(moved, readFileSync(adapterFixture));
  const { projectId: _project, ...environment } = structuredClone(old.value) as Record<string, Json> & { implementer: { command: { args: string[] } }; reviewer: { command: { args: string[] } } };
  for (const role of ["implementer", "reviewer"] as const) environment[role].command.args = [moved, ...environment[role].command.args.slice(1)];
  const current = f.engine.environments.configure(project, environment as never, old.revision);
  return { ...request, dispatch: { ...request.dispatch, config: reference(current) } };
}
const lp4Questions = (f: WorksRun, packet: Ref) =>
  (f.store.get<QuestionPacketRecord>(packet.id, packet.revision)!.value.packet as { questions: { id: string }[] }).questions.map(row => row.id);
const lp4Sent = (f: WorksRun, packet: Ref) => {
  const requestId = (f.store.get<QuestionPacketRecord>(packet.id, packet.revision)!.value.packet as { requestId: string }).requestId;
  return f.sent().filter(line => (JSON.parse(line as string) as { requestId?: string }).requestId === requestId).length;
};
/** Every step of the pass on a new Store (a stop after each transaction), until the first attempt's close. */
async function lp4Close(f: WorksRun, request: RunRequest, bound = 40) {
  const seen: string[] = [];
  for (let index = 0; index < bound; index++) {
    f.restart();
    const advanced = ok(await advanceRun(f.store, request)), state = advanced.record.value.state;
    seen.push(state.phase === "waiting" ? `waiting:${state.wait.code}` : `${state.phase}:${advanced.performed?.action ?? (state.phase === "step" ? (state as { step: RunStep }).step.action : "")}`);
    assert.notEqual(state.phase, "waiting", seen.join(","));
    if (advanced.performed?.action === "close") return seen;
  }
  return assert.fail(`The first attempt did not close: ${seen.join(",")}`);
}

test("LP4 (№2887 rows 1, 4, 9, §6.3, §6.4, §6.6) an addressed file the first or the second root waits for: without another environment the pass waits lawfully and nothing is ceased; once the roles move, the waiting step and then its node are ceased, the other root is worked by its own rules, the first attempt closes by G7 — on a new Store after every transaction, never waiting on completion_ceased and never sending the paid need_source again", async t => {
  for (const hang of ["first", "second"] as const) await t.test(`the ${hang} root waits`, async t => {
    const f = worksFixture(t), scenario = join(f.root, "scenario.json"), steps: unknown[] = [], cycled: Ref[] = [];
    ok(startRun(f.store, { project }));
    let state = null as { phase: string; step?: { action: string; request: unknown } } | null;
    for (let index = 0; index < 40 && state?.phase !== "waiting"; index++) {
      const advanced = ok(await advanceRun(f.store, f.request)); state = advanced.record.value.state as unknown as typeof state;
      if (state!.phase !== "step" || state!.step!.action !== "cycle") continue;
      const packet = (state!.step!.request as { packet: Ref }).packet;
      if (cycled.some(ref => ref.id === packet.id)) continue;
      cycled.push(packet);
      if (cycled.length === (hang === "first" ? 1 : 2)) steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_source",
        questionIds: lp4Questions(f, packet), missing: "The addressed file", reads: [{ action: "read", path: "lp4-later.txt", media: "text/plain" }] }, usage });
      else { f.answer(packet); steps.push((JSON.parse(readFileSync(scenario, "utf8")) as { steps: unknown[] }).steps.at(-1)); }
      writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
    }
    assert.equal(state?.phase, "waiting", JSON.stringify(state));
    const waiting = cycled[hang === "first" ? 0 : 1]!, other = cycled.find(ref => ref.id !== waiting.id) ?? null;
    // Row 9: the lawful wait for an external input stays as it is without another environment; nothing is ceased.
    // Row 9: a lawful wait for an external input; without another environment nothing is ceased and nothing sent again.
    const saved = (state as unknown as { wait: { code: string } }).wait.code;
    assert.deepEqual([saved, f.store.list("om-completion-cessation").length, lp4Sent(f, waiting)], ["model_read_unavailable", 0, 1]);
    f.restart();
    assert.equal(ok(prepareCompletionCause(f.store, project, (f.store.list<{ om: { completionOwner: { assignment: Ref } } }>("model-call")
      .find(row => row.value.om?.completionOwner)!).value.om.completionOwner.assignment)).cause, null);
    const request = lp4Configure(f, f.request), seen = await lp4Close(f, request);
    const cessations = f.store.list<{ assignment: Ref; remainder: string; cause: { kind: string } }>("om-completion-cessation");
    assert.deepEqual(cessations.map(row => row.value.cause.kind).sort(), ["cycle-step-ceased", "required-record-replaced"], seen.join(","));
    const root = cessations.find(row => row.value.cause.kind === "cycle-step-ceased")!;
    assert.equal(root.value.remainder, "assembly");
    assert.equal(f.store.get<{ kind: string }>(root.value.assignment.id)!.value.kind, "root");
    assert.equal(lp4Sent(f, waiting), 1, "The paid need_source is never sent again");
    // §6.3: the other root is worked by its own rules — its own cycle, never ceased because of the waiting one.
    const cycles = f.store.list<{ request: { packet: Ref }; terminal: string }>("om-model-cycle");
    const own = cycles.filter(row => row.value.request.packet.id !== waiting.id);
    assert.ok(own.length >= 1 && own.every(row => ["outcome", "assembled"].includes(row.value.terminal)), JSON.stringify(cycles.map(row => row.value.terminal)));
    if (other) assert.ok(own.some(row => row.value.request.packet.id === other.id));
    assert.ok(!cycles.some(row => row.value.request.packet.id === waiting.id), "No cycle terminal is invented for the ceased cycle");
    const series = f.store.list<RepairSeries>("repair-series")[0]!;
    assert.notEqual(series.value.attempts[0]!.outcome, null, "G7 closed the first attempt");
    // LP6 (№3325 row 15): an end by the moved environment and a ceased cycle step is no administrative end of the area's B1.
    const binding = ok(readCompletionBinding(f.store, project, reference(series), 1))!;
    const close = ok(readCompletionCloseAt(f.store, project, reference(f.store.get(completionCloseId(project, binding.id))!)));
    assert.deepEqual([close.contract, close.outcome.progress?.administrative], ["om-completion-close/v2", null]);
  });
});

test("LP4 (№2887 row 10, §6.2, §6.6) the producers 3cba953 and 202c470, each from its whole Git code in its own process, leave the pass on completion_ceased after the roles move — saved as a wait or as the step about to be performed; the new code on a new Store ends the remaining work by cease and G7 without sending the paid need_source again, every saved revision as the old code wrote it", async t => {
  for (const [name, commit] of Object.entries(LP4_COMMITS)) for (const stop of ["waiting", "step"] as const) await t.test(`${name} ${stop}`, async t => {
    const f = worksFixture(t), moved = join(f.root, "adapter-next.mjs");
    writeFileSync(moved, readFileSync(adapterFixture));
    const reads = name === "3cba953" ? [{ action: "search", within: reference(f.store.get(`om-input:${project}`)!), query: "question" }]
      : [{ action: "read", path: "lp4-later.txt", media: "text/plain" }];
    const stuck = atCommit(f, commit, `lp4-${name}-${stop}`, `const { advanceRun, startRun } = await import(src('om/run.js'));
const { ProductEngine } = await import(src('product/engine.js'));
const { reference } = await import(src('pipeline/contracts.js'));
const { writeFileSync } = await import('node:fs');
take(startRun(store, { project: args.project }));
let request = args.request, ceased = false;
const seen = [], steps = [];
async function drive(stopAtStep) {
  for (let index = 0; index < 40; index++) {
    const advanced = take(await advanceRun(store, request)), state = advanced.record.value.state;
    if (advanced.performed?.action === 'cease') ceased = true;
    if (state.phase === 'step' && state.step.action === 'cycle' && !steps.length) {
      const packet = store.get(state.step.request.packet.id, state.step.request.packet.revision);
      steps.push({ research: { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'need_source',
        questionIds: packet.value.packet.questions.map(row => row.id), missing: 'The addressed data', reads: args.reads }, usage: args.usage });
      writeFileSync(args.scenario, JSON.stringify({ steps }));
    }
    seen.push(state.phase === 'waiting' ? 'waiting:' + state.wait.code : state.phase + ':' + (advanced.performed?.action ?? ''));
    if (stopAtStep && ceased && state.phase === 'step' && state.step.action === 'cycle') return;
    if (state.phase === 'waiting' && seen.at(-2) === seen.at(-1)) return;
  }
}
await drive(false);
const engine = new ProductEngine(store), old = store.get('environment:' + args.project), environment = structuredClone(old.value);
delete environment.projectId;
for (const role of ['implementer', 'reviewer']) environment[role].command.args = [args.moved, ...environment[role].command.args.slice(1)];
request = { ...request, dispatch: { ...request.dispatch, config: reference(engine.environments.configure(args.project, environment, old.revision)) } };
await drive(args.stop === 'step');
out({ seen, request });`,
      { request: f.request, project, reads, usage, scenario: join(f.root, "scenario.json"), moved, stop }) as { seen: string[]; request: RunRequest };
    const last = stuck.seen.at(-1)!;
    assert.equal(last, stop === "waiting" ? "waiting:completion_ceased" : "step:", `The old code stands on its cessation: ${stuck.seen.join(",")}`);
    f.restart();
    const before = f.store.list().map(reference), head = ok(readRun(f.store, { project }))!;
    const step = head.value.state.phase === "step" ? head.value.state.step : head.value.last!.step;
    assert.equal(step.action, "cycle");
    const packet = (step.request as unknown as { packet: Ref }).packet, paid = lp4Sent(f, packet);
    assert.equal(paid, 1);
    if (stop === "step") {
      // §6.6: the saved step is not performed — an ordinary transition back to the choice, no cycle product invented.
      const first = ok(await advanceRun(f.store, stuck.request));
      assert.deepEqual([first.performed, first.record.value.state.phase, first.record.revision], [null, "ready", head.revision + 1]);
      assert.equal(f.store.list<{ request: { packet: Ref } }>("om-model-cycle").filter(row => row.value.request.packet.id === packet.id).length, 0);
    }
    const seen = await lp4Close(f, stuck.request);
    const roots = f.store.list<{ cause: { kind: string }; remainder: string }>("om-completion-cessation").filter(row => row.value.cause.kind === "cycle-step-ceased");
    assert.deepEqual(roots.map(row => row.value.remainder), ["assembly"], seen.join(","));
    assert.equal(lp4Sent(f, packet), 1, "The paid need_source of the old code is never sent again");
    for (const ref of before) assert.deepEqual(reference(f.store.get(ref.id, ref.revision)!), ref, `${ref.id}@${ref.revision} stands as the old code wrote it`);
  });
});

test("LP4 (№2902, rows 3/4) a saved cycle whose step ceased, while its root also has a direct cause of higher priority (a lawfully replaced B1), is not performed: saved as the step or — by the code 202c470 in its own process — as the wait on completion_ceased, the new code goes back to the choice, which ceases the root by its direct cause, without a stop on completion_ceased and without another send", async t => {
  for (const saved of ["step", "waiting"] as const) await t.test(saved, async t => {
    const f = worksFixture(t);
    let step: RunStep | null = null;
    if (saved === "waiting") {
      // LP1 transfer: 202c470 can only write its old waiting state over a packet of its own era.
      step = atCommit(f, LP4_COMMITS["202c470"], "lp4-direct-step", `const { startRun, advanceRun } = await import(src('om/run.js'));
take(startRun(store, { project: args.project }));
let step = null;
for (let index = 0; index < 40 && !step; index++) {
  const state = take(await advanceRun(store, args.request)).record.value.state;
  if (state.phase === 'waiting') throw new Error(JSON.stringify(state));
  if (state.phase === 'step' && state.step.action === 'cycle') step = state.step;
}
out(step);`, { project, request: f.request }) as RunStep | null;
      f.restart();
    } else {
      ok(startRun(f.store, { project }));
      for (let index = 0; index < 40 && !step; index++) {
        const state = ok(await advanceRun(f.store, f.request)).record.value.state;
        assert.notEqual(state.phase, "waiting", JSON.stringify(state));
        if (state.phase === "step" && state.step.action === "cycle") step = state.step as unknown as RunStep;
      }
    }
    assert.ok(step, "A cycle is chosen");
    const packet = (step.request as unknown as { packet: Ref }).packet;
    assert.equal(f.store.get<QuestionPacketRecord>(packet.id, packet.revision)!.value.answerProtocol,
      saved === "waiting" ? "omg-answer/v2" : "omg-answer/v3");
    writeFileSync(join(f.root, "scenario.json"), JSON.stringify({ database: f.database, steps: [{ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_source",
      questionIds: lp4Questions(f, packet), missing: "The addressed file", reads: [{ action: "read", path: "lp4-later.txt", media: "text/plain" }] }, usage }] }));
    // The paid need_source is applied while the pass's cursor still stands on the saved step (the boundary of its recovery).
    const owner = ok(await runModelCall(f.store, step.request as never)).record.value.om.completionOwner!;
    const request = lp4Configure(f, f.request);
    ok(writeCompletionCessation(f.store, { project, binding: owner.binding, assignment: owner.assignment }));
    const root = f.store.list<{ kind: string; batch: string }>("om-completion-assignment")
      .find(row => row.value.kind === "root" && row.value.batch === f.store.get<{ batch: string }>(owner.assignment.id)!.value.batch)!;
    assert.equal(ok(prepareCompletionCause(f.store, project, reference(root))).cause!.kind, "cycle-step-ceased");
    const inventory = f.store.write({ id: `repo-inventory:${project}`, kind: "repo-inventory", expected: 0, value: { projectId: project, paths: [] } });
    const before = f.store.get(`om-input:${project}`)!;
    const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
    ok(writeOmInput(f.store, { project, stages, inventory: reference(inventory), expected: before.revision }));
    const direct = ok(prepareCompletionCause(f.store, project, reference(root))).cause!;
    assert.deepEqual([direct.kind, (direct as { prerequisite: { kind: string } }).prerequisite.kind], ["required-record-replaced", "input"], "The direct cause keeps its priority");
    if (saved === "waiting") {
      const stood = atCommit(f, LP4_COMMITS["202c470"], "lp4-direct-waiting", `const { advanceRun } = await import(src('om/run.js'));
const advanced = take(await advanceRun(store, args.request));
out(advanced.record.value.state);`, { request }) as { phase: string; wait?: { code: string } };
      assert.deepEqual([stood.phase, stood.wait?.code], ["waiting", "completion_ceased"], "The code 202c470 performs the forbidden cycle and stands");
    }
    const sent = f.sent().length;
    f.restart();
    const head = ok(readRun(f.store, { project }))!;
    const first = ok(await advanceRun(f.store, request));
    if (saved === "step") assert.deepEqual([first.performed, first.record.value.state.phase, first.record.revision], [null, "ready", head.revision + 1],
      "The saved forbidden cycle goes back to the choice by an ordinary transition");
    else assert.notEqual(first.record.value.state.phase, "waiting", "The saved wait goes on to the choice");
    // On a new Store after every transaction, until the root is ceased: never a stop on completion_ceased.
    const seen: string[] = [];
    const rootCessation = () => f.store.list<{ assignment: Ref }>("om-completion-cessation").find(row => row.value.assignment.id === root.id);
    for (let index = 0; index < 12 && !rootCessation(); index++) {
      f.restart();
      const state = ok(await advanceRun(f.store, request)).record.value.state;
      seen.push(state.phase === "waiting" ? `waiting:${state.wait.code}` : state.phase);
      assert.ok(!seen.includes("waiting:completion_ceased"), seen.join(","));
    }
    const ceased = f.store.get<{ cause: { kind: string; prerequisite?: { kind: string } }; remainder: string }>(rootCessation()!.id)!;
    assert.deepEqual([ceased.value.cause.kind, ceased.value.cause.prerequisite?.kind, ceased.value.remainder], ["required-record-replaced", "input", "assembly"], seen.join(","));
    assert.equal(f.sent().length, sent, "Nothing of the ceased cycle is sent again");
  });
});

// ---- MP2 (№2968): the still unstarted roots of an attempt by the flows of their frame; neighbours of a brief root ----
import { rankExpansions } from "../src/om/run.js";
/** The upper graph the rank reads: only its connectors matter. */
const mp2Upper = (flows: readonly { id?: string; level?: number; producer: string; consumers: string[]; anchor?: string | null }[]) =>
  ({ connectors: [...new Map(flows.map((flow, index) => [flow.id ?? `c${index}`, flow.id ?? `c${index}`])).keys()].map(id => ({ id, artifact: "a", returnsTo: "x", wakeTest: null,
    bindings: flows.filter((flow, index) => (flow.id ?? `c${index}`) === id).map(flow => ({ level: flow.level ?? 2, anchor: flow.anchor ?? null,
      producer: { node: flow.producer, port: "out" }, consumers: flow.consumers.map(node => ({ node, port: "in" })) })) })) }) as unknown as Graph;
const mp2Items = (nodes: readonly string[]) => nodes.map((node, index) => ({ id: `assignment-${String.fromCharCode(122 - index)}`, node, batch: `batch-${node}`, level: 3 as const }));
const mp2Rank = (nodes: readonly string[], flows: Parameters<typeof mp2Upper>[0]) => {
  const items = mp2Items(nodes), byId = new Map(items.map(item => [item.id, item.node]));
  return rankExpansions(items, () => mp2Upper(flows)).map(id => byId.get(id)!);
};

test("MP2 (№2968 rows 1, 2) the rank of unstarted expansion roots: producer before consumer on a chain and a fork, equal ranks by node id; a cycle keeps its outer producer before and outer consumer after; every binding and consumer counts; sleeping flows, other levels and self-references set no order", () => {
  // Row 1: a chain whose ids run against the flow, and a fork; the ready component with the least id goes first.
  assert.deepEqual(mp2Rank(["c-op", "b-op", "a-op"], [{ producer: "c-op", consumers: ["b-op"] }, { producer: "b-op", consumers: ["a-op"] }]), ["c-op", "b-op", "a-op"]);
  assert.deepEqual(mp2Rank(["z-root", "b-leaf", "a-leaf"], [{ producer: "z-root", consumers: ["b-leaf", "a-leaf"] }]), ["z-root", "a-leaf", "b-leaf"]);
  assert.deepEqual(mp2Rank(["m", "k", "q"], []), ["k", "m", "q"], "Without flows: by node id, never by the hash of an assignment");
  // Row 2: a strongly connected pair with an outer producer and an outer consumer keeps both outer dependencies.
  assert.deepEqual(mp2Rank(["y", "p", "x", "q"], [{ producer: "p", consumers: ["y"] }, { producer: "x", consumers: ["y"] },
    { producer: "y", consumers: ["x"] }, { producer: "x", consumers: ["q"] }]), ["p", "x", "y", "q"]);
  // Two bindings of one connector and several consumers of one binding: each counts, not only the first.
  assert.deepEqual(mp2Rank(["a", "b", "c"], [{ id: "one", producer: "c", consumers: ["a"] }, { id: "one", producer: "b", consumers: ["c"] }]), ["b", "c", "a"]);
  assert.deepEqual(mp2Rank(["a", "b", "c"], [{ producer: "c", consumers: ["b", "a"] }]), ["c", "a", "b"]);
  // A sleeping flow, a flow of another level and a self-reference set no order.
  assert.deepEqual(mp2Rank(["a", "b"], [{ producer: "b", consumers: ["a"], anchor: "sleeping" }]), ["a", "b"]);
  assert.deepEqual(mp2Rank(["a", "b"], [{ producer: "b", consumers: ["a"], level: 1 }]), ["a", "b"]);
  assert.deepEqual(mp2Rank(["a", "b"], [{ producer: "b", consumers: ["b"] }]), ["a", "b"]);
  // One node with two batches: by batch, then by assignment.
  const items = [{ id: "z", node: "n", batch: "batch-2", level: 3 as const }, { id: "y", node: "n", batch: "batch-1", level: 3 as const },
    { id: "x", node: "n", batch: "batch-1", level: 3 as const }];
  assert.deepEqual(rankExpansions(items, () => mp2Upper([])), ["x", "y", "z"]);
});

/** Drives the works pass, answering each paid cycle for its exact saved packet, until the produce block closes. */
async function mp2Works(f: ReturnType<typeof worksFixture>, onStep?: (step: { action: string; request: { packet?: Ref } }) => void, bound = 200) {
  const cycles: Ref[] = [], answered = new Set<string>();
  for (let index = 0; index < bound; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const state = advanced.record.value.state as unknown as { phase: string; step?: { action: string; request: { packet?: Ref } } };
    if (state.phase === "step" && state.step) {
      onStep?.(state.step);
      if (state.step.action === "cycle" && state.step.request.packet && !answered.has(state.step.request.packet.id)) {
        answered.add(state.step.request.packet.id); cycles.push(state.step.request.packet); f.answer(state.step.request.packet);
      }
    }
    if (state.phase === "waiting" || state.phase === "complete") break;
    if (blockSeries(f as unknown as Fixture, "garden-produce-block")?.value.attempts[0]?.outcome) break;
  }
  return cycles;
}

test("MP2 (№2968 rows 1, 3, 4, 5) through the pass a block designs its producer operation first; the consumer's brief carries the producer's finished work with its write paths; the producer's own brief has the explicit empty set; a saved step goes on before any rank", async t => {
  const f = worksFixture(t);
  const works = f.routes.value.batches.filter(row => row.level === 3 && row.task === "node-expansion");
  const prep = works.find(row => row.node === "garden-prep-operation")!, produce = works.find(row => row.node === "garden-produce-operation")!;
  assert.ok(prep && produce, "The produce block owns two operations joined by garden-prep-flow");
  ok(startRun(f.store, { project }));
  let restarted = false;
  const trail: string[] = [];
  const cycles = await mp2Works(f, step => {
    const request = step.request as { batch?: string; packet?: Ref };
    const batch = request.batch ?? (request.packet ? f.store.get<QuestionPacketRecord>(request.packet.id)?.value.request.batch : undefined);
    trail.push(`${step.action}:${batch === prep.id ? "prep" : batch === produce.id ? "produce" : batch ?? "-"}`);
    // Row 4: a saved packet step of the producer continues after a restart, before the other root is ranked.
    if (!restarted && step.action === "cycle") { restarted = true; f.restart(); }
  });
  const batchOf = (packet: Ref) => f.store.get<QuestionPacketRecord>(packet.id, packet.revision)!.value.request.batch;
  const order = cycles.map(batchOf).filter(batch => batch === prep.id || batch === produce.id);
  assert.deepEqual(order, [prep.id, produce.id], `Row 1: the producer operation is designed first: ${trail.join(" ")}`);
  const at = (step: string) => trail.indexOf(step);
  assert.ok(at("packet:prep") < at("cycle:prep") && at("cycle:prep") < at("packet:produce"),
    `Row 4: begun work goes on before the next root is started, whatever the order of ids: ${trail.join(" ")}`);
  const root = (batch: string) => f.store.list<QuestionPacketRecord>("question-packet").find(row => row.value.request.batch === batch
    && !row.value.request.previous.length && !row.value.request.continuation && !row.value.request.correction)!;
  assert.deepEqual(root(prep.id).value.briefNeighbors, { contract: "om-brief-neighbors/v1", sources: [] }, "Row 19: the explicit empty set");
  const neighbours = root(produce.id).value.briefNeighbors!;
  assert.deepEqual(neighbours.sources.map(source => [source.node, source.batch]), [["garden-prep-operation", prep.id]], "Row 5: the finished producer");
  const text = (root(produce.id).value.packet as { brief: { text: string } }).brief.text;
  assert.ok(text.includes("# Accepted work of neighbouring roots"));
  const section = JSON.parse(text.split("# Accepted work of neighbouring roots\n")[1]!.split("\n")[1]!) as { works: { node: string; writes: string[]; nodes: { id: string }[] }[] };
  assert.equal(section.works[0]!.node, "garden-prep-operation");
  assert.ok(section.works[0]!.nodes.some(node => node.id === "garden-prep-work"), "Row 5: the producer's work node");
  assert.ok(section.works[0]!.writes.length > 0, "Row 5: the files it declared for writing");
});

test("MP2 (№2968 row 6) a packet issued before its neighbour finished keeps its set: the run reuses it as it is, with no later neighbour", async t => {
  const f = worksFixture(t);
  const works = f.routes.value.batches.filter(row => row.level === 3 && row.task === "node-expansion");
  const prep = works.find(row => row.node === "garden-prep-operation")!, produce = works.find(row => row.node === "garden-produce-operation")!;
  ok(startRun(f.store, { project }));
  const early: { ref: Ref | null } = { ref: null };
  await mp2Works(f, step => {
    // As soon as the producer's packet is issued, the consumer's root packet is issued too, before the producer finished.
    if (early.ref || step.action !== "cycle" || !step.request.packet) return;
    const saved = f.store.get<QuestionPacketRecord>(step.request.packet.id)!;
    if (saved.value.request.batch !== prep.id) return;
    early.ref = reference(ok(writeQuestionPacket(f.store, { ...saved.value.request, batch: produce.id })).record);
  });
  assert.ok(early.ref, "The consumer's packet was issued early");
  const issued = f.store.get<QuestionPacketRecord>(early.ref.id)!;
  assert.deepEqual(issued.value.briefNeighbors, { contract: "om-brief-neighbors/v1", sources: [] }, "Issued before the producer finished");
  assert.deepEqual(reference(f.store.get(early.ref.id)!), early.ref, "The issued packet is never replaced");
  const sentFor = f.store.list<QuestionPacketRecord>("question-packet").filter(row => row.value.request.batch === produce.id
    && !row.value.request.previous.length && !row.value.request.continuation && !row.value.request.correction);
  assert.equal(sentFor.length, 1, "No second root packet with the later neighbour");
});

/** The works answer of worksFixture for an exact saved packet, as research data: the desired work of its operation. */
function mp2WorkAnswer(f: ReturnType<typeof worksFixture>, saved: Ref) {
  const packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
  const routed = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
  const batch = routed.batches.find(row => row.id === packet.value.request.batch)!;
  const payload = packet.value.packet as unknown as { expansion: { assigned: string[]; obligations: { id: string; kind: string; upper: { port?: string } }[] } };
  const work: Node = structuredClone(f.desired.nodes.find(node => node.kind === "work" && node.parent === batch.node)!);
  const tests = structuredClone(f.desired.tests.filter(item => work.tests.includes(item.id)));
  if (!work.code.length) {
    work.code = [{ path: `${work.id}.ts`, access: "write", status: "planned" }]; work.tests = [`${work.id}-test`];
    const proof = structuredClone(f.desired.tests.find(item => item.node === "garden-consume-work")!);
    proof.id = work.tests[0]!; proof.node = work.id; proof.covers = [];
    proof.contract!.entrypoint.path = work.code[0]!.path; proof.contract!.counterfactuals = [];
    tests.push(proof);
  }
  return { batch: batch.id, research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", bindings: [], proposal: {
    nodes: [work], tests, fills: payload.expansion.obligations.filter(item => payload.expansion.assigned.includes(item.id))
      .map(item => ({ obligation: item.id, node: work.id, ...(item.kind === "connection-end" ? { port: item.upper.port!, codeRef: work.code[0]! } : {}) })),
    localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
    removes: [], replaces: [], redefines: [] } } };
}

test("MP2 (№2968 rows 8, 18) through the pass a refused works answer is corrected once; G7 closes the block attempt with its result, every physical call sent once, the first refusal kept in its history", async t => {
  const f = worksFixture(t);
  const works = f.routes.value.batches.filter(row => row.level === 3 && row.task === "node-expansion");
  const produce = works.find(row => row.node === "garden-produce-operation")!;
  const scenario = join(f.root, "scenario.json"), steps: unknown[] = [], answered = new Set<string>();
  let refused = 0;
  ok(startRun(f.store, { project }));
  for (let index = 0; index < 200; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const state = advanced.record.value.state as unknown as { phase: string; step?: { action: string; request: { packet?: Ref } } };
    if (state.phase === "step" && state.step?.action === "cycle" && state.step.request.packet && !answered.has(state.step.request.packet.id)) {
      answered.add(state.step.request.packet.id);
      const answer = mp2WorkAnswer(f, state.step.request.packet);
      if (answer.batch === produce.id && !refused++) {
        const wrong = structuredClone(answer.research);
        wrong.proposal.fills = wrong.proposal.fills.map((fill, at) => at === 0 ? { ...fill, obligation: "X999" } : fill);
        steps.push({ research: wrong, usage });
      }
      steps.push({ research: answer.research, usage });
      writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
    }
    if (state.phase === "waiting" || state.phase === "complete") break;
    if (blockSeries(f as unknown as Fixture, "garden-produce-block")?.value.attempts[0]?.outcome) break;
  }
  const attempt = blockSeries(f as unknown as Fixture, "garden-produce-block").value.attempts[0]!;
  assert.equal(attempt.outcome?.reason, "result", "Row 18: the corrected result decides, not the first refusal");
  const corrections = f.store.list<QuestionPacketRecord>("question-packet").filter(row => row.value.request.correction);
  assert.equal(corrections.length, 1, "Row 8: one correction");
  assert.equal(corrections[0]!.value.request.batch, produce.id);
  assert.equal(f.sent().length, steps.length, "Every scripted answer was asked for exactly once, nothing twice");
  const first = f.store.list<{ om: { failure: { code: string } | null; diagnostic: Ref | null } }>("model-call")
    .find(row => row.value.om?.failure?.code === "answer_label_unknown")!;
  assert.ok(first?.value.om.diagnostic, "The first refusal has its diagnostic");
  const rows = f.store.list<{ rows: { source: Ref; id: string }[] }>("om-refusal-journal").flatMap(row => row.value.rows ?? []);
  assert.ok(rows.some(row => row.source.id === first.value.om.diagnostic!.id), "Row 18: and its journal row stays in the history");
});

test("MP2 return №3147: through the pass after a restart, a changed environment between the paid repairable refusal and its correction ceases the step and its root and closes the attempt by G7 — never waiting on completion_claim_exists, nothing sent again", async t => {
  const f = worksFixture(t);
  ok(startRun(f.store, { project }));
  let cycle: { request: { packet: Ref } } | null = null;
  for (let index = 0; index < 40 && !cycle; index++) {
    const state = ok(await advanceRun(f.store, f.request)).record.value.state as unknown as { phase: string; step?: { action: string; request: { packet: Ref } } };
    assert.notEqual(state.phase, "waiting", JSON.stringify(state));
    if (state.phase === "step" && state.step!.action === "cycle") cycle = state.step!;
  }
  assert.ok(cycle, "A cycle step is chosen");
  const answer = mp2WorkAnswer(f, cycle!.request.packet).research;
  answer.proposal.fills = answer.proposal.fills.map((fill, at) => at === 0 ? { ...fill, obligation: "X999" } : fill);
  writeFileSync(join(f.root, "scenario.json"), JSON.stringify({ database: f.database, steps: [{ research: answer, usage }] }));
  const first = ok(await runModelCall(f.store, cycle!.request as never));
  assert.equal(first.record.value.om.failure?.code, "answer_label_unknown");
  const moved = lp4Configure(f, f.request);
  const seen: string[] = [];
  for (let index = 0; index < 40; index++) {
    f.restart();
    const advanced = ok(await advanceRun(f.store, moved)), state = advanced.record.value.state;
    seen.push(state.phase === "waiting" ? `waiting:${(state as unknown as { wait: { code: string } }).wait.code}` : `${state.phase}:${advanced.performed?.action ?? ""}`);
    assert.ok(!(state.phase === "waiting" && (state as unknown as { wait: { code: string } }).wait.code === "completion_claim_exists"), seen.join(","));
    if (advanced.performed?.action === "close") break;
  }
  assert.ok(seen.some(step => step.endsWith(":close")), `The attempt closes: ${seen.join(",")}`);
  const cessations = f.store.list<{ cause: { kind: string }; remainder: string }>("om-completion-cessation");
  assert.ok(cessations.some(row => row.value.cause.kind === "required-record-replaced" && row.value.remainder === "continuation"), "The owed step ceased");
  assert.ok(cessations.some(row => row.value.cause.kind === "cycle-step-ceased"), "Its root ceased by the ceased step");
  // §6.3: the other root is worked by its own rules in the new environment, so the sends are counted by packet.
  assert.equal(lp4Sent(f, cycle!.request.packet), 1, "The paid answer is never sent again");
  const corrections = f.store.list<QuestionPacketRecord>("question-packet").filter(row => row.value.request.correction && row.value.state === "ready");
  assert.ok(!corrections.some(row => lp4Sent(f, reference(row)) > 0
    || f.store.get(modelCallRecordId(project, (row.value.packet as { requestId: string }).requestId))), "The correction is never sent and no correction call exists");
});

test("MP2 №3153: through the pass in a second attempt, standing on the non-empty refusal journal of the first, a repairable refusal after a read is corrected — the correction is written and sent once, never input_stale on the journal head the refusal itself moved", async t => {
  const f = worksFixture(t);
  const produce = f.routes.value.batches.find(row => row.level === 3 && row.task === "node-expansion" && row.node === "garden-produce-operation")!;
  writeFileSync(join(f.root, "mp2-retry.txt"), "The produced artifact is written to the garden store.");
  const scenario = join(f.root, "scenario.json"), steps: unknown[] = [], answered = new Set<string>(), trail: string[] = [];
  let corrected = false;
  const sentCorrection = () => f.store.list<QuestionPacketRecord>("question-packet")
    .some(row => row.value.request.correction && row.value.state === "ready" && lp4Sent(f, reference(row)) > 0);
  ok(startRun(f.store, { project }));
  for (let index = 0; index < 300 && !sentCorrection(); index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const state = advanced.record.value.state as unknown as { phase: string; wait?: { code: string }; step?: { action: string; request: { packet?: Ref } } };
    trail.push(state.phase === "waiting" ? `waiting:${state.wait!.code}` : `${state.phase}:${advanced.performed?.action ?? ""}`);
    assert.ok(state.phase !== "waiting" && state.phase !== "complete", trail.join(","));
    if (state.phase !== "step" || state.step?.action !== "cycle" || !state.step.request.packet || answered.has(state.step.request.packet.id)) continue;
    const packet = state.step.request.packet; answered.add(packet.id);
    if (f.store.get<QuestionPacketRecord>(packet.id, packet.revision)!.value.request.attempt!.ordinal === 1)
      steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "cannot_answer", questionIds: lp4Questions(f, packet),
        reason: "The node needs another design" }, usage });
    else {
      const answer = mp2WorkAnswer(f, packet);
      if (answer.batch === produce.id && !corrected) {
        corrected = true;
        const wrong = structuredClone(answer.research);
        wrong.proposal.fills = wrong.proposal.fills.map((fill, at) => at === 0 ? { ...fill, obligation: "X999" } : fill);
        steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_source", questionIds: lp4Questions(f, packet),
          missing: "Where the produced artifact is written", reads: [{ action: "read", path: "mp2-retry.txt", media: "text/plain" }] }, usage },
        { research: wrong, usage });
      }
      steps.push({ research: answer.research, usage });
    }
    writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
  }
  assert.equal(blockSeries(f as unknown as Fixture, "garden-produce-block").value.attempts[0]!.outcome?.reason, "refused", "The model refused the first attempt");
  const correction = f.store.list<QuestionPacketRecord>("question-packet").find(row => row.value.request.correction)!;
  assert.ok(correction && sentCorrection(), `The correction is written and sent: ${trail.join(",")}`);
  const rejected = f.store.get<QuestionPacketRecord>(correction.value.request.correction!.packet.id)!.value;
  assert.ok(rejected.request.continuation, "It corrects the step after the read");
  assert.equal(correction.value.request.attempt!.ordinal, 2);
  assert.ok(correction.value.journal, "The chain stands on the journal of the refused attempt");
  assert.deepEqual(correction.value.journal, rejected.journal, "On its root's saved journal, not on the head its refusal moved");
  assert.notDeepEqual(reference(f.store.get(correction.value.journal!.id)!), correction.value.journal, "The refusal moved the head");
  assert.equal(lp4Sent(f, reference(correction)), 1, "The correction is sent once");
  assert.equal(f.sent().length, steps.length, "Every scripted answer was asked for exactly once, nothing twice");
});

// ---- LP5 (№3278): after a replaced B1 the old work ends by its own products, the new bases are built, paid assemblies answer again ----
import { AREA_INPUT_VARIANT, COMPLETION_FINALIZATION_KIND, COMPLETION_REUSE_KIND, prepareCompletionFinalization, prepareCompletionReuse, readCompletionCessationAt, readCompletionFinalizationAt, writeCompletionFinalization, writeCompletionReuse, type CompletionCessation, type CompletionFinalization, type CompletionReuse } from "../src/om/model-call.js";
import type { WorksAcceptanceRecord } from "../src/om/atomic-gate.js";
/** A lawful new B1 by G1 (the writeOmInput writer): the repository inventory D1 asked for is recorded (or its paths change) and the input refreshed. */
function lp5ReplaceB1(f: WorksRun, paths: string[] = []): Ref {
  const before = f.store.get(`om-input:${project}`)!, id = `repo-inventory:${project}`, old = f.store.get<{ paths: string[] }>(id);
  const inventory = old && JSON.stringify(old.value.paths) === JSON.stringify(paths) ? old
    : f.store.write({ id, kind: "repo-inventory", expected: old?.revision ?? 0, value: { projectId: project, paths } });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  return reference(ok(writeOmInput(f.store, { project, stages, inventory: reference(inventory), expected: before.revision })));
}
const lp5Kind = <T = Json>(f: WorksRun, kind: string): Revision<T>[] => f.store.list<T>(kind);

test("LP5 (№3278 rows 2, 6, 7, 9, 13, 14, 18, 20, 23) through the pass on a new Store after every transaction: a B1 replaced by G1 while a works attempt is open ends its remaining work by its own products, the attempt closes by the common G7, the bases of the new B1 are built and the paid complete assemblies answer their roots again — never a wait, never a second send of a paid answer, one common C4/G5 of reused and new results", async t => {
  for (const moment of ["after the first root", "after the check", "after the acceptance"] as const) await t.test(moment, async t => {
    const f = worksFixture(t);
    const scenario = join(f.root, "scenario.json"), steps: unknown[] = [], answered = new Set<string>(), trail: string[] = [];
    let replaced: Ref | null = null;
    const line = () => blockSeries(f as unknown as Fixture, "garden-produce-block")?.value ?? null;
    const done = () => moment === "after the acceptance" ? !!line()?.attempts[0]?.outcome && (line()!.attempts[0]!.outcome!.reason === "result" || !!line()?.attempts[1]?.outcome)
      : !!line()?.attempts[1]?.outcome;
    ok(startRun(f.store, { project }));
    for (let index = 0; index < 300 && !done(); index++) {
      f.restart();
      const advanced = ok(await advanceRun(f.store, f.request));
      const state = advanced.record.value.state as unknown as { phase: string; wait?: { code: string }; step?: { action: string; request: { packet?: Ref }; attempt: number | null } };
      const performed = advanced.performed?.action ?? "";
      trail.push(state.phase === "waiting" ? `waiting:${state.wait!.code}` : `${state.phase}:${performed}${state.phase === "step" ? `>${state.step!.action}#${state.step!.attempt}` : ""}`);
      assert.ok(state.phase === "step" || state.phase === "ready", trail.join(","));
      if (!replaced && (moment === "after the first root" && performed === "cycle" || moment === "after the check" && performed === "evaluate"
        || moment === "after the acceptance" && performed === "works")) replaced = lp5ReplaceB1(f);
      if (state.phase !== "step" || state.step!.action !== "cycle" || !state.step!.request.packet || answered.has(state.step!.request.packet.id)) continue;
      answered.add(state.step!.request.packet.id);
      steps.push({ research: mp2WorkAnswer(f, state.step!.request.packet).research, usage });
      writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
    }
    assert.ok(replaced && done(), trail.join(","));
    t.diagnostic(trail.join(","));
    const [first, second] = line()!.attempts;
    // LP6 (№3325 rows 12, 15, 19): the old attempt ended only by the replaced B1 of its area is an administrative end —
    // neutral, nothing counted — while the end of a confirmation remainder is not one; a reuse is no achievement.
    const close = (ordinal: number) => {
      const binding = ok(readCompletionBinding(f.store, project, reference(blockSeries(f as unknown as Fixture, "garden-produce-block")!), ordinal))!;
      return ok(readCompletionCloseAt(f.store, project, reference(f.store.get(completionCloseId(project, binding.id))!)));
    };
    const packets = f.store.list<QuestionPacketRecord>("question-packet");
    // The produce block's own packets of the new attempt: the reused roots get none, every other root one, sent once.
    const produced = (ordinal: number) => packets.filter(row => row.value.request.attempt?.series.id === blockSeries(f as unknown as Fixture, "garden-produce-block").id
      && row.value.request.attempt.ordinal === ordinal && row.value.state === "ready");
    for (const packet of packets.filter(row => row.value.state === "ready")) assert.ok(lp4Sent(f, reference(packet)) <= 1, "A paid answer is never sent again");
    assert.equal(f.sent().length, steps.length, "Every scripted answer was asked for exactly once");
    const reuses = lp5Kind<CompletionReuse>(f, COMPLETION_REUSE_KIND);
    if (moment === "after the acceptance") {
      // Rows 9, 10: the acceptance stays; either the confirmation is completed by D2 and the attempt keeps its result, or the
      // remainder of the confirmation alone is ended — the accepted frame is never ceased and no closure is made up.
      const finalized = lp5Kind(f, COMPLETION_FINALIZATION_KIND);
      if (finalized.length) assert.deepEqual([first!.outcome!.reason, (finalized[0]!.value as { phase: string }).phase], ["interrupted", "confirmation"]);
      if (finalized.length) assert.deepEqual([close(1).contract, close(1).outcome.progress, first!.verdict],
        ["om-completion-close/v2", { contract: "om-attempt-progress/v1", administrative: null }, "none"], "LP6 row 15: a confirmation end is no administrative end");
      else assert.equal(first!.outcome!.reason, "result", "Row 9: the accepted goal is confirmed on the new bases");
      assert.equal(reuses.length, finalized.length ? reuses.length : 0);
      return;
    }
    assert.equal(first!.outcome!.reason, "interrupted", "The old attempt ends without a verdict");
    assert.equal(second!.outcome!.reason, "result", "The next attempt reaches its result");
    const end = close(1).outcome.progress?.administrative;
    assert.deepEqual([end?.kind, first!.verdict, line()!.withoutProgress], ["area-input-replaced", "neutral", 0], "LP6 row 12: neutral, nothing counted");
    assert.ok(end!.sources.every(ref => [COMPLETION_FINALIZATION_KIND, "om-completion-cessation"].includes(f.store.get(ref.id, ref.revision)!.kind)));
    assert.equal(second!.verdict, "progress");
    const cessations = lp5Kind<CompletionCessation>(f, "om-completion-cessation");
    if (moment === "after the first root") {
      // Rows 2, 6: the unsent second root by LP4, the registered check by its area's replaced B1 (a variant of its own era).
      assert.ok(cessations.some(row => row.value.disposition !== "check-ceased" && row.value.cause.kind === "required-record-replaced"), "Row 2");
      const check = cessations.find(row => row.value.disposition === "check-ceased")!;
      assert.deepEqual([check.value.cause.kind, check.value.variant, (check.value.cause as { replacement: Ref }).replacement], ["required-record-replaced", AREA_INPUT_VARIANT, replaced], "Row 6");
      assert.equal(reuses.length, 1, "Row 14: the paid first root answers again");
      assert.deepEqual(produced(2).map(row => lp4Sent(f, reference(row))), [1], "Row 18: only the unsent second root is asked, once, in the new attempt");
      // Row 20: the second root of the new attempt sees its reused neighbour by the exact reuse.
      const later = packets.filter(row => row.value.request.attempt?.ordinal === 2 && row.value.state === "ready");
      assert.ok(later.some(row => (row.value as unknown as { briefNeighbors?: { sources: { reuse?: Ref }[] } }).briefNeighbors?.sources
        .some(source => source.reuse?.id === reuses[0]!.id)), "Row 20: the neighbour form names the reuse");
    } else {
      // Row 7: the complete check keeps its evaluation; only the remaining acceptance ends.
      const finalized = lp5Kind(f, COMPLETION_FINALIZATION_KIND);
      assert.deepEqual(finalized.map(row => (row.value as { phase: string }).phase), ["acceptance"]);
      // Row 7: the check is complete without a pass (the full G4b still waits for the group's works) and no C5 exists.
      const evaluation = (finalized[0]!.value as unknown as { evaluation: Ref }).evaluation;
      const gate = f.store.get<{ gate: Ref }>(evaluation.id, evaluation.revision)!.value.gate;
      assert.equal(f.store.get<{ result: { passed: boolean } }>(gate.id, gate.revision)!.value.result.passed, false, "Row 7");
      assert.ok(!cessations.some(row => row.value.disposition === "check-ceased"), "A complete check is never ceased");
      assert.equal(reuses.length, 2, "Row 14: both paid roots answer again");
      assert.deepEqual(produced(2), [], "No root of the new attempt is asked: 0 new E1, calls or expense");
    }
    for (const reuse of reuses) assert.equal(reuse.value.binding.id === reuse.value.source.binding.id, false, "A reuse answers a later attempt");
    // LP6 row 19: no achievement stands on a reuse; the result of the new attempt is its own C5/D2.
    assert.ok(close(2).outcome.achieved.length > 0 && close(2).outcome.achieved.every(item => !reuses.some(reuse => reuse.id === item.basis.id)));
    // Row 18: the one common C4/G5 of the new attempt takes the reuses themselves, beside the new assemblies.
    const acceptance = lp5Kind<WorksAcceptanceRecord>(f, "om-works-acceptance").find(row => row.value.acceptance);
    assert.ok(acceptance, "G5 accepts the works of the new attempt");
    assert.deepEqual(acceptance!.value.request.results.filter(row => row.kind === "reuse").map(row => row.record).sort((a, b) => a.id.localeCompare(b.id)),
      reuses.map(row => reference(row)).sort((a, b) => a.id.localeCompare(b.id)));
  });
});

import { completionRootAssignments } from "../src/om/series.js";
import { writeGuarded } from "../src/om/refs.js";
type Lp5State = { phase: string; wait?: { code: string }; step?: { action: string; request: Record<string, unknown> & { packet?: Ref }; series?: string | null; attempt: number | null } };
/** The pass on a new Store after every transaction, every new cycle answered with the work of its operation; `hook` sees each state. */
async function lp5Pass(f: WorksRun, hook: (state: Lp5State, performed: string) => Promise<"stop" | void> | "stop" | void, bound = 300) {
  const scenario = join(f.root, "scenario.json"), steps: unknown[] = existsSync(scenario) ? (JSON.parse(readFileSync(scenario, "utf8")) as { steps: unknown[] }).steps : [];
  const answered = new Set(f.store.list<{ om?: { request: { packet: Ref } } }>("model-call").map(row => row.value.om?.request.packet.id ?? "")), trail: string[] = [];
  for (let index = 0; index < bound; index++) {
    f.restart();
    const advanced = ok(await advanceRun(f.store, f.request));
    const state = advanced.record.value.state as unknown as Lp5State, performed = advanced.performed?.action ?? "";
    trail.push(state.phase === "waiting" ? `waiting:${state.wait!.code}` : `${state.phase}:${performed}${state.phase === "step" ? `>${state.step!.action}#${state.step!.attempt}` : ""}`);
    assert.ok(state.phase === "step" || state.phase === "ready", trail.join(","));
    if (await hook(state, performed) === "stop") return trail;
    if (state.phase !== "step" || state.step!.action !== "cycle" || !state.step!.request.packet || answered.has(state.step!.request.packet.id)) continue;
    answered.add(state.step!.request.packet.id);
    steps.push({ research: mp2WorkAnswer(f, state.step!.request.packet).research, usage });
    writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
  }
  return assert.fail(`The pass did not reach the awaited state: ${trail.join(",")}`);
}

test("LP5 (№3278 rows 8, 9, 10, 11, 15, 19, 22, 23, 24; §3; return №3294 п.1–2) the producers of the transition on the pass's own states: an accepted goal whose D2 is still admissible keeps its acceptance and its confirmation, its own reuses included, and only a superseded graph or frame ends its confirmation; a passed check whose C5 is not made ends its remaining acceptance all the same; through a second replacement a reuse is admitted again from the earlier reuse, its origin the first assembly; a reuse refuses a foreign D7 and finds nothing for another operation; a work moved between preparation and writing refuses the prepared reuse without a partial write; a loss after the reuse is written repeats it exactly; an accepted goal keeps its acceptance — only its confirmation remainder ends, and nothing ends once D2 confirmed it", async t => {
  await t.test("the reuse", async t => {
    const f = worksFixture(t);
    const produce = () => blockSeries(f as unknown as Fixture, "garden-produce-block");
    let replaced = false, reuse: Record<string, unknown> | null = null;
    ok(startRun(f.store, { project }));
    await lp5Pass(f, (state, performed) => {
      if (!replaced && performed === "cycle") { lp5ReplaceB1(f); replaced = true; }
      if (state.phase === "step" && state.step!.action === "reuse") { reuse = state.step!.request; return "stop"; }
    });
    const request = reuse! as { project: string; binding: Ref; root: Ref; works: { producer: Ref; ledger: Ref } };
    const binding = ok(readCompletionBinding(f.store, project, reference(produce()), 2))!;
    const first = f.store.list<QuestionPacketRecord>("question-packet").find(row => row.value.request.attempt?.ordinal === 1 && row.value.state === "ready")!;
    // Row 19: the D7 of the old area is never taken for today's.
    const foreign = prepareCompletionReuse(f.store, { ...request, works: first.value.request.works! });
    assert.equal(foreign.ok, false, "An old D7 is no basis of a reuse");
    // Row 15: another operation of the attempt finds no paid result of its own.
    const other = completionRootAssignments(binding).find(row => row.id !== request.root.id)!;
    assert.equal(ok(prepareCompletionReuse(f.store, { ...request, root: reference(other) })).record, null);
    // Rows 22, 24: the work moves between the preparation and the write — the prepared reuse refuses as a whole.
    const prepared = ok(prepareCompletionReuse(f.store, request));
    assert.ok(prepared.record && prepared.writes.length);
    ok(writeQuestionPacket(f.store, { project, routes: binding.value.plan.routes, batch: other.value.batch, environment: f.request.dispatch.config,
      attempt: { series: reference(produce()), ordinal: 2 }, previous: [], works: request.works }));
    const stored = f.store.list().map(reference);
    assert.equal(writeGuarded(f.store, { unit: "G7", target: prepared.record!.id, writes: [...prepared.writes], guards: [...prepared.guards] }).ok, false);
    assert.deepEqual(f.store.list().map(reference), stored, "Nothing of it is written");
    // Row 23: the reuse written by its producer and the pass lost before its cursor moved — the same saved step repeats it.
    const saved = ok(writeCompletionReuse(f.store, request));
    f.restart();
    const repeated = ok(await advanceRun(f.store, f.request));
    assert.deepEqual([repeated.performed?.action, f.store.list<CompletionReuse>(COMPLETION_REUSE_KIND).map(reference)], ["reuse", [reference(saved)]]);
    await lp5Pass(f, () => produce()?.value.attempts[1]?.outcome ? "stop" : undefined);
    assert.equal(produce().value.attempts[1]!.outcome!.reason, "result");
    for (const packet of f.store.list<QuestionPacketRecord>("question-packet").filter(row => row.value.state === "ready"))
      assert.ok(lp4Sent(f, reference(packet)) <= 1, "Nothing paid is sent again");
  });
  await t.test("the confirmation", async t => {
    const f = worksFixture(t);
    const produce = () => blockSeries(f as unknown as Fixture, "garden-produce-block");
    ok(startRun(f.store, { project }));
    await lp5Pass(f, (_state, performed) => performed === "works" ? "stop" : undefined);
    lp5ReplaceB1(f);
    const binding = reference(ok(readCompletionBinding(f.store, project, reference(produce()), 1))!);
    // Row 9 (return №3294 п.1): the real acceptance stays, and with its accepted frame and graph still the heads D2 is
    // admissible on the new B1 — neither the acceptance nor its confirmation may end.
    const acceptance = prepareCompletionFinalization(f.store, { project, binding, phase: "acceptance" });
    assert.deepEqual(acceptance.ok ? "ended" : acceptance.refusal.code, "completion_resolved");
    const confirmation = prepareCompletionFinalization(f.store, { project, binding, phase: "confirmation" });
    assert.deepEqual(confirmation.ok ? "ended" : [confirmation.refusal.code, confirmation.refusal.at.field], ["completion_cause_unproved", "confirmation"]);
    // The same pass confirms the goal on its new bases (the reviewer's probe №3294 п.1); row 11: once D2 confirmed it,
    // nothing of it ends any more.
    await lp5Pass(f, () => produce()?.value.attempts[0]?.outcome ? "stop" : undefined);
    assert.equal(produce().value.attempts[0]!.outcome!.reason, "result");
    assert.equal(lp5Kind(f, COMPLETION_FINALIZATION_KIND).length, 0, "Nothing of the accepted goal was ended");
    const late = prepareCompletionFinalization(f.store, { project, binding, phase: "confirmation" });
    assert.ok(!late.ok && ["completion_resolved", "completion_closed"].includes(late.refusal.code), late.ok ? "ended" : late.refusal.code);
  });
  await t.test("a superseded graph", async t => {
    const f = worksFixture(t);
    const produce = () => blockSeries(f as unknown as Fixture, "garden-produce-block");
    ok(startRun(f.store, { project }));
    await lp5Pass(f, (_state, performed) => performed === "works" ? "stop" : undefined);
    lp5ReplaceB1(f);
    // Row 10 (return №3294 п.1): the owner saves the map again (save-graph), so the graph the works were accepted on is no
    // longer the head: the machine D1 can never stand on this acceptance again and its D2 is proved impossible.
    const head = f.store.get<Graph>(`graph:${project}`)!;
    f.engine.graphs.save(project, head.value, head.revision, "lp5-owner");
    const moved = reference(f.store.get(`graph:${project}`)!), frame = reference(f.store.get(`om-frame:${project}:3`)!);
    assert.equal(moved.revision, head.revision + 1);
    const binding = reference(ok(readCompletionBinding(f.store, project, reference(produce()), 1))!);
    const accepted = f.store.list<WorksAcceptanceRecord>("om-works-acceptance").find(row => row.value.acceptance)!;
    const prepared = ok(prepareCompletionFinalization(f.store, { project, binding, phase: "confirmation" }));
    assert.deepEqual([prepared.record.value.accepted, prepared.record.value.basis], [accepted.value.acceptance!.frame, { frame, graph: moved }]);
    assert.ok(prepared.guards.some(guard => JSON.stringify(guard) === JSON.stringify(moved)), "The superseding graph head is guarded");
    // A ground that moves between the preparation and the write refuses the whole write: nothing is written.
    f.engine.graphs.save(project, f.store.get<Graph>(`graph:${project}`)!.value, moved.revision, "lp5-owner-race");
    const raced = writeGuarded(f.store, { unit: "G7", target: prepared.record.id, writes: [...prepared.writes], guards: [...prepared.guards] });
    assert.equal(raced.ok, false);
    assert.ok(!f.store.get(prepared.record.id), "Nothing is written");
    const latest = reference(f.store.get(`graph:${project}`)!);
    // The pass ends exactly that remainder by the same derivation, on today's ground: the acceptance stays, interrupted.
    await lp5Pass(f, () => produce()?.value.attempts[0]?.outcome ? "stop" : undefined);
    assert.equal(produce().value.attempts[0]!.outcome!.reason, "interrupted");
    const ended = lp5Kind<CompletionFinalization>(f, COMPLETION_FINALIZATION_KIND).find(row => row.value.binding.id === binding.id)!;
    assert.deepEqual([ended.value.phase, ended.value.accepted, ended.value.basis], ["confirmation", accepted.value.acceptance!.frame, { frame, graph: latest }]);
    assert.ok(f.store.get(accepted.id), "The real acceptance is kept");
    // Its reader proves the saved ground at its exact references after a restart and a later graph.
    const later = f.store.get<Graph>(`graph:${project}`)!;
    f.engine.graphs.save(project, later.value, later.revision, "lp5-owner-2");
    f.restart();
    assert.deepEqual(ok(readCompletionFinalizationAt(f.store, project, reference(ended))), ended);
  });
  await t.test("accepted reuses", async t => {
    const f = worksFixture(t);
    const produce = () => blockSeries(f as unknown as Fixture, "garden-produce-block");
    ok(startRun(f.store, { project }));
    // The first B1 after the check of attempt 1; attempt 2 answers both its roots by reuse and reaches the real C5.
    let replaced = false;
    await lp5Pass(f, (_state, performed) => {
      if (!replaced && performed === "evaluate") { lp5ReplaceB1(f); replaced = true; }
      else if (replaced && performed === "works") return "stop";
    });
    const binding = reference(ok(readCompletionBinding(f.store, project, reference(produce()), 2))!);
    const accepted = f.store.list<WorksAcceptanceRecord>("om-works-acceptance").find(row => row.value.acceptance)!;
    assert.equal(accepted.value.request.results.filter(row => row.kind === "reuse").length, 2, "The real C5 took both reuses");
    lp5ReplaceB1(f, ["src"]);
    // Return №3294 п.2 (the reviewer's probe): the acceptance of the reuses is the attempt's own — never declared absent,
    // and its confirmation is no remainder while D2 is admissible.
    const acceptance = prepareCompletionFinalization(f.store, { project, binding, phase: "acceptance" });
    assert.deepEqual(acceptance.ok ? "ended" : [acceptance.refusal.code, acceptance.refusal.at.ref], ["completion_resolved", accepted.value.acceptance!.frame]);
    const confirmation = prepareCompletionFinalization(f.store, { project, binding, phase: "confirmation" });
    assert.deepEqual(confirmation.ok ? "ended" : confirmation.refusal.code, "completion_cause_unproved");
    await lp5Pass(f, () => produce()?.value.attempts[1]?.outcome ? "stop" : undefined);
    assert.deepEqual(produce().value.attempts.map(row => row.outcome?.reason), ["interrupted", "result"]);
  });
  await t.test("a passed check", async t => {
    const f = worksFixture(t);
    ok(startRun(f.store, { project }));
    // The full G4b of the group passed: C5 is chosen, not yet made, by the attempt whose current check passed (№1749 п.3),
    // when the B1 of the area is replaced.
    const chosen: { series?: string; attempt?: number } = {};
    await lp5Pass(f, state => {
      if (state.phase !== "step" || state.step!.action !== "works") return;
      chosen.series = state.step!.series!; chosen.attempt = state.step!.attempt!;
      return "stop";
    });
    lp5ReplaceB1(f);
    const line = () => f.store.get<RepairSeries>(chosen.series!)!.value.attempts.find(row => row.ordinal === chosen.attempt)!;
    const binding = reference(ok(readCompletionBinding(f.store, project, reference(f.store.get(chosen.series!)!), chosen.attempt!))!);
    // Row 8: the old pass gives no current C5; the remaining acceptance ends exactly as after a check that did not pass.
    const ended = ok(writeCompletionFinalization(f.store, { project, binding, phase: "acceptance" }));
    const gate = f.store.get<{ gate: Ref }>(ended.value.evaluation.id, ended.value.evaluation.revision)!.value.gate;
    assert.equal(f.store.get<{ result: { passed: boolean } }>(gate.id, gate.revision)!.value.result.passed, true);
    // The chosen C5 stands on the replaced B1 and is refused by its own producer; the attempt closes by the common G7.
    const trail: string[] = [];
    for (let index = 0; index < 20 && !line().outcome; index++) {
      f.restart();
      const advanced = ok(await advanceRun(f.store, f.request)), state = advanced.record.value.state as unknown as Lp5State;
      trail.push(state.phase === "waiting" ? `waiting:${state.wait!.code}` : `${state.phase}:${advanced.performed?.action ?? ""}`);
    }
    assert.equal(line().outcome?.reason, "interrupted", trail.join(","));
    assert.equal(f.store.list<WorksAcceptanceRecord>("om-works-acceptance").some(row => row.value.acceptance), false, "No C5 is made on the replaced B1");
  });
  await t.test("a second replacement", async t => {
    const f = worksFixture(t);
    const produce = () => blockSeries(f as unknown as Fixture, "garden-produce-block");
    const reuses = () => lp5Kind<CompletionReuse>(f, COMPLETION_REUSE_KIND);
    ok(startRun(f.store, { project }));
    // The first B1 after the check of attempt 1; the second once attempt 2 holds the reuses of both its roots.
    let replaced = 0;
    await lp5Pass(f, (_state, performed) => {
      if (replaced === 0 && performed === "evaluate") { lp5ReplaceB1(f); replaced = 1; }
      else if (replaced === 1 && performed === "reuse" && reuses().length === 2) { lp5ReplaceB1(f, ["src"]); replaced = 2; }
      return produce()?.value.attempts[2]?.outcome ? "stop" : undefined;
    });
    assert.deepEqual(produce().value.attempts.map(row => row.outcome?.reason), ["interrupted", "interrupted", "result"]);
    // §3: through several replacements the origin stays the first complete assembly; each admission is its own.
    const bindingOf = (ordinal: number) => ok(readCompletionBinding(f.store, project, reference(produce()), ordinal))!.id;
    const second = reuses().filter(row => row.value.binding.id === bindingOf(2)), third = reuses().filter(row => row.value.binding.id === bindingOf(3));
    assert.deepEqual([second.length, third.length], [2, 2], "Both roots answered again after each replacement");
    for (const row of third) {
      const source = second.find(item => item.id === row.value.source.result.id && item.revision === row.value.source.result.revision);
      assert.ok(source, "The third admission stands on the second attempt's own reuse");
      assert.deepEqual(row.value.origin, source!.value.origin, "The origin stays the first complete assembly");
      assert.notDeepEqual(row.value.works, source!.value.works, "Its bindings are carried to today's handoff again");
    }
    for (const packet of f.store.list<QuestionPacketRecord>("question-packet").filter(row => row.value.state === "ready"))
      assert.ok(lp4Sent(f, reference(packet)) <= 1, "A paid answer is never sent again");
  });
});

const LP5_BASE_COMMIT = "febbee2cf8187e1c230eec325e183fc8203e06ae";
test("LP5 (№3278 §4, rows 13, 21) era: febbee2c, run from Git in its own process on the B1 replaced under its open works attempt, ends the unsent root by LP4 and stands on input_stale; the new code reads its records as they are and continues that very open work — the check ceased, the attempt closed, the new bases built, the paid root answered by its reuse", async t => {
  const f = worksFixture(t);
  const produce = () => blockSeries(f as unknown as Fixture, "garden-produce-block");
  ok(startRun(f.store, { project }));
  await lp5Pass(f, (_state, performed) => performed === "cycle" ? "stop" : undefined);
  lp5ReplaceB1(f);
  const stood = atCommit(f, LP5_BASE_COMMIT, "lp5-base", `const { advanceRun } = await import(src('om/run.js'));
const trail = [];
for (let index = 0; index < 20; index++) {
  const advanced = take(await advanceRun(store, args.request)), state = advanced.record.value.state;
  trail.push(state.phase === 'waiting' ? 'waiting:' + state.wait.code + ':' + state.wait.target : state.phase + ':' + (advanced.performed?.action ?? ''));
  if (state.phase === 'waiting') break;
}
out(trail);`, { request: f.request }) as string[];
  assert.equal(stood.at(-1), `waiting:input_stale:om-input:${project}`, `The base stands on the replaced B1: ${stood.join(",")}`);
  f.restart();
  const ceased = f.store.list<CompletionCessation>("om-completion-cessation");
  assert.deepEqual(ceased.map(row => [row.value.disposition, row.value.cause.kind]), [["branch-ceased", "required-record-replaced"]], "The base ended the unsent root by LP4");
  assert.deepEqual(ok(readCompletionCessationAt(f.store, project, reference(ceased[0]!))), ceased[0], "Its record reads as it is");
  const trail = await lp5Pass(f, () => produce()?.value.attempts[1]?.outcome ? "stop" : undefined);
  assert.ok(trail.some(row => row.endsWith(">cease-check#1")) && trail.some(row => row.endsWith(">reuse#2")), trail.join(","));
  assert.deepEqual(produce().value.attempts.map(row => row.outcome?.reason), ["interrupted", "result"]);
  assert.equal(f.store.list(COMPLETION_REUSE_KIND).length, 1);
});

// ---- LP6 (№3325 §4–§5): stops saved by e7db0ba8 under the old rules, read literally and reconciled by the new era ----
import { decidedFieldsBefore, prepareReconcileSeries, readSeries, readStopHistory, readSeriesProgressTransitionAt, reconcileSeries,
  completionCloseId, seriesProgressTransitionId, SERIES_PROGRESS_TRANSITION_KIND } from "../src/om/series.js";
import { readCompletionCloseAt, prepareCloseAttempt as lp6PrepareClose } from "../src/om/repeat-gate.js";
import { readStopAnalysis, prepareStopAnalysis as lp6PrepareAnalysis } from "../src/om/stop-analysis.js";
import { readStopReport, stopReportOfNewEra, STOP_REPORT_CONTRACT_V2 } from "../src/om/stop-report.js";

const LP6_BASE = "e7db0ba81cf6f049420b5ea3c054108bf99c2cdb";
type Lp6Op = { op: "round"; ordinal: number; answers: { field: "nodes" | "state" | "checkKind" | "expansion"; value?: Json; cannot?: string; owner?: string; exit?: number; unsent?: true }[] }
  | { op: "replace"; target: string; field: string; value: Json } | { op: "cease"; ordinal: number } | { op: "close"; ordinal: number }
  | { op: "analyze"; decided: boolean } | { op: "resume"; stop: number };
/** The operations of a line, performed by the WHOLE code of e7db0ba8 in its own process — every record as that code writes it. */
const LP6_OLD_BODY = `
await import(src('om/run.js'));
const { writeFileSync } = await import('node:fs');
const { writeHorizon } = await import(src('om/horizon.js'));
const { writeGaps } = await import(src('om/gaps.js'));
const { writeRoutes } = await import(src('om/routes.js'));
const { writeQuestionPacket } = await import(src('om/question-packet.js'));
const { runModelCall, writeCompletionCessation, readCompletionWorkAt } = await import(src('om/model-call.js'));
const { openAttempt, prepareManagedClaim, closeAttempt } = await import(src('om/repeat-gate.js'));
const { readCompletionBinding, completionWorkId, resumeSeries } = await import(src('om/series.js'));
const { inputDecisionWrite, writeAddressing } = await import(src('om/addressing.js'));
const { gapLineKey, gapLineExpectedResult } = await import(src('om/gap-lines.js'));
const { runStopAnalysis } = await import(src('om/stop-analysis.js'));
const { project, block, scenario, dispatch } = args, steps = args.steps, address = { project, block, line: 1 }, done = [];
const head = () => store.get('repair-series:' + project + ':1:' + block);
const say = step => { steps.push(step); writeFileSync(scenario, JSON.stringify({ database, steps })); };
const routesNow = () => {
  const input = store.get('om-input:' + project), graph = store.get('graph:' + project);
  const horizon = take(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: 'lp6-' + input.revision, features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get('graph-layer:' + project + ':2')) } };
  const gaps = take(writeGaps(store, sources));
  return take(writeRoutes(store, { project, gaps: { sources: structuredClone(gaps.sources), records: gaps.records.map(reference) },
    tasks: [], catalog: { paths: [], records: [] }, previous: null }));
};
let analysis = null;
for (const item of args.ops) {
  if (item.op === 'round') {
    const routes = routesNow();
    const batches = item.answers.map(answer => routes.value.batches.find(batch => answer.field === 'expansion'
      ? batch.task === 'node-expansion' && batch.items.every(row => row.consumers.includes(block))
      : batch.task === 'input-field' && batch.items.some(row => row.field === answer.field && row.consumers.includes(block))));
    const items = batches.flatMap(batch => batch.items);
    const goal = { key: 'lp6:' + item.ordinal + ':' + item.answers.map(answer => answer.field).join('+'),
      questions: items.map(row => gapLineKey(project, row.target, row.field)).sort(), result: gapLineExpectedResult(project, items[0].target, items[0].field) };
    const series = take(openAttempt(store, { ...address, attempt: item.ordinal, goal, completion: { routes: reference(routes), batches: batches.map(batch => batch.id).sort() } }));
    const packets = batches.map(batch => take(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id, environment: dispatch.config,
      attempt: { series: reference(series), ordinal: item.ordinal }, previous: [] })).record);
    for (const [index, batch] of batches.entries()) {
      const answer = item.answers[index];
      if (answer.unsent) continue;
      say(answer.exit !== undefined ? { exitCode: answer.exit } : { research: answer.cannot !== undefined ? { protocol: '$answerProtocol', requestId: '$requestId', questionIds: batch.items.map(row => row.gap), action: 'cannot_answer', reason: answer.cannot }
        : answer.owner !== undefined ? { protocol: '$answerProtocol', requestId: '$requestId', questionIds: batch.items.map(row => row.gap), action: 'need_owner', reason: answer.owner, decision: 'Decide it' }
        : { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer', results: batch.items.map(row => ({ target: row.target, field: row.field, basis: row.record, value: answer.value })) },
        usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 } });
      take(await runModelCall(store, { project, packet: reference(packets[index]), dispatch, role: 'implementer' }));
    }
  } else if (item.op === 'replace') {
    const input = store.get('om-input:' + project), graph = store.get('graph:' + project);
    take(writeAddressing(store, { project, input: reference(input), graph: reference(graph), decisions: [{ pending: structuredClone(inputDecisionWrite({
      project, input: reference(input), graph: reference(graph), layers: [], decision: { target: item.target, field: item.field, value: item.value } })) }] }));
  } else if (item.op === 'cease') {
    // Roots first: a part under a ceased root owes nothing more; whatever still stands open is ended after them.
    const binding = take(readCompletionBinding(store, project, reference(head()), item.ordinal));
    for (let open = true; open;) {
      const snapshot = take(readCompletionWorkAt(store, project, reference(store.get(completionWorkId(project, binding.id)))));
      const resolved = new Set(snapshot.resolved.map(ref => ref.id));
      const row = snapshot.assignments.filter(row => !resolved.has(row.id)).sort((a, b) => Number(a.value.kind !== 'root') - Number(b.value.kind !== 'root'))[0];
      open = row !== undefined;
      if (open) take(writeCompletionCessation(store, { project, binding: reference(binding), assignment: reference(row) }));
    }
  } else if (item.op === 'close') {
    const claim = take(prepareManagedClaim(store, { ...address, attempt: item.ordinal, outcome: { reason: 'result', accepting: [], cancelling: [], refusals: [] } }));
    done.push(take(closeAttempt(store, { ...address, attempt: item.ordinal, outcome: claim.outcome })).verdict);
  } else if (item.op === 'analyze') {
    const series = reference(head());
    say({ research: { protocol: 'omg-stop-analysis/v1', cause: { kind: 'hypothesis', text: 'The work of this window stopped on its own input', sources: [] },
      change: { text: 'Continue on the decided input', addresses: [{ ref: item.decided ? series : series.id, field: 'review-record' }] }, origin: null },
      usage: { inputTokens: 90, outputTokens: 20, cachedInputTokens: 0, reasoningOutputTokens: 5 } });
    analysis = take(await runStopAnalysis(store, { project, series, hold: null, dispatch }));
  } else if (item.op === 'resume') {
    take(resumeSeries(store, { ...address, stop: item.stop, ground: 'review-record', text: 'The independent review of this stop decided', review: { ref: reference(analysis) } }));
  }
}
out({ verdicts: done, analysis: analysis && reference(analysis), steps });
`;
/** The garden block garden-consume-block on a B1 that leaves its contract's nodes and state and its criterion's checkKind open. */
function lp6Line(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-lp6-era-")), database = join(root, "state.sqlite");
  let store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), { level: _level, ...l1 } = projectGraph(gardenGraph("cross"), 1);
  preparedFeatures(engine, project, l1 as Graph, field => preparedField(project, field));
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  ok(writeOmInput(store, { project, expected: 0, stages }));
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl"), block = "garden-consume-block";
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const configured = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "lp6-implementer", model: "fixture", effort: "high", speed: "fast", command },
    reviewer: { actor: "lp6-reviewer", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 400_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:lp6`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  ok(openSeries(store, { project, block, line: 1, slice: "lp6", predecessor: null, basis: null } as never));
  const address = { project, block, line: 1 }, dispatch = { adapter: reference(adapter), config: reference(configured) };
  let steps: unknown[] = [];
  return {
    root, database, address, dispatch, block,
    get store() { return store; },
    restart() { store.close(); store = new Store(database); },
    head: () => store.get<RepairSeries>(`repair-series:${project}:1:${block}`)!,
    sent(): unknown[] { return existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) : []; },
    old(name: string, ops: Lp6Op[], commit = LP6_BASE) {
      store.close();
      const output = atCommit({ root, database }, commit, name, LP6_OLD_BODY, { project, block, scenario, dispatch, steps, ops }) as
        { verdicts: string[]; analysis: Ref | null; steps: unknown[] };
      steps = output.steps;
      store = new Store(database);
      return output;
    },
  };
}
const lp6Close = (f: ReturnType<typeof lp6Line>, ordinal: number) => {
  const binding = ok(readCompletionBinding(f.store, project, reference(f.head()), ordinal))!;
  return ok(readCompletionCloseAt(f.store, project, reference(f.store.get(completionCloseId(project, binding.id))!)));
};

test("LP6 rows 1, 21, 23, 26, 27, 28, 29, 30, 32: a stop e7db0ba8 saved over fresh input-field results and a clean end of the replaced B1 is read literally — closes, verdicts, stop and the failed A6 — and the new era reconciles exactly that stop once: the results enter the history, the old records stay, a repeat, a reopen and a second Store write nothing more", async t => {
  const f = lp6Line(t);
  const old = f.old("research", [
    { op: "round", ordinal: 1, answers: [{ field: "nodes", value: ["garden-produce-block", "garden-consume-block"] }, { field: "expansion", unsent: true }] },
    { op: "cease", ordinal: 1 }, { op: "close", ordinal: 1 },
    { op: "round", ordinal: 2, answers: [{ field: "expansion", unsent: true }] },
    { op: "replace", target: "garden-B1", field: "state", value: { writer: "garden-produce-block" } },
    { op: "cease", ordinal: 2 }, { op: "close", ordinal: 2 },
    { op: "round", ordinal: 3, answers: [{ field: "checkKind", value: "test" }, { field: "expansion", unsent: true }] },
    { op: "cease", ordinal: 3 }, { op: "close", ordinal: 3 },
    { op: "analyze", decided: false },
  ]);
  // Row 1: the old producer's records as it wrote them — v1 closes without progress, three verdicts "none", the stop.
  assert.deepEqual(old.verdicts, ["none", "none", "none"]);
  for (const ordinal of [1, 2, 3]) {
    const close = lp6Close(f, ordinal);
    assert.deepEqual([close.contract, close.outcome.reason, close.outcome.achieved, Object.hasOwn(close.outcome, "progress")],
      ["om-completion-close/v1", "interrupted", [], false], `attempt ${ordinal}`);
  }
  const stopped = ok(readSeries(f.store, f.address as never)).value as RepairSeries;
  assert.deepEqual([stopped.stop?.attempt, stopped.ladder.rung, stopped.withoutProgress, stopped.attempts.map(row => row.verdict), stopped.progressPolicy],
    [3, 1, 3, ["none", "none", "none"], undefined]);
  // Row 32: the saved A6 failure, its v1 intent and its v1 report read as they are; a new request repeats that intent.
  const failure = ok(readStopAnalysis(f.store, { project, record: old.analysis! }));
  assert.deepEqual([failure.value.contract, failure.value.state, failure.value.error?.code], ["om-stop-analysis/v1", "failed", "analysis_response_invalid"]);
  const intent = f.store.get<{ contract: string; sources: Json; report: Json }>(failure.value.intent.id)!;
  assert.equal(intent.value.contract, "om-stop-analysis/v1");
  assert.deepEqual(ok(readStopReport(f.store, { project, sources: intent.value.sources as never })), intent.value.report, "D row 1: the v1 report, byte for byte");
  const repeated = ok(lp6PrepareAnalysis(f.store, { project, series: failure.value.intent && (intent.value as unknown as { request: { series: Ref } }).request.series, hold: null, dispatch: f.dispatch }));
  assert.deepEqual([repeated.intent.contract, repeated.writes.length], ["om-stop-analysis/v1", 0], "The saved intent is repeated, never issued again as v2");
  // Row 30: the report of the new era shows what every attempt of the window proves — no "environment" for a moved input.
  const report = ok(stopReportOfNewEra(f.store, f.address as never));
  assert.equal(report.contract, STOP_REPORT_CONTRACT_V2);
  assert.deepEqual(report.completionEvidence!.map(row => [row.ordinal, row.effect]), [[1, "input-field"], [2, "administrative"], [3, "input-field"]]);
  assert.equal(report.finding.subject, "input-transition");
  assert.ok(report.lines.some(line => line.includes("filling anew nodes of garden-B1")), "The facts are written into the text of the report");
  // Rows 21, 23, 28: the transition is proved row by row; prepared on one Store, it loses to the same transition written
  // by a second one, and no record is left alone.
  const before = reference(f.head());
  const prepared = ok(prepareReconcileSeries(f.store, { ...f.address, stop: 3 } as never));
  assert.deepEqual(prepared.writes.map(write => write.kind).sort(), ["om-series-progress-transition", "repair-series"]);
  const second = new Store(f.database);
  try { ok(reconcileSeries(second, { ...f.address, stop: 3 } as never)); } finally { second.close(); }
  const lost = writeGuarded(f.store, { unit: "store-repairs", target: before.id, writes: [...prepared.writes] as Write[], guards: [...prepared.guards] });
  assert.equal(lost.ok, false, "The prepared transition of a state that moved is refused whole");
  assert.equal(f.store.list(SERIES_PROGRESS_TRANSITION_KIND).length, 1);
  const series = ok(readSeries(f.store, f.address as never)).value as RepairSeries;
  const transition = series.reconciliations![0]!;
  const record = ok(readSeriesProgressTransitionAt(f.store, project, transition.transition)).value;
  assert.deepEqual(record.rows.map(row => [row.ordinal, row.result, row.achieved.length]), [[1, "input-field", 1], [2, "administrative", 0], [3, "input-field", 1]]);
  assert.deepEqual(record.series, before);
  assert.deepEqual([series.stop, series.ladder.rung, series.ladder.windows, series.withoutProgress], [null, 1, [], 0]);
  assert.deepEqual(series.attempts.map(row => [row.verdict, row.outcome?.reason]), [["none", "interrupted"], ["none", "interrupted"], ["none", "interrupted"]], "The old outcomes and verdicts stay");
  assert.deepEqual(series.progressPolicy, { contract: "om-series-progress/v1", previous: before, from: 4 });
  assert.deepEqual(transition.achieved.map(row => row.goal).sort(), stopped.attempts.filter(row => row.ordinal !== 2).map(row => row.goal.key).sort());
  const history = ok(readStopHistory(f.store, f.address as never));
  assert.deepEqual([history.stops.length, history.stops[0]!.attempt, history.stops[0]!.reconciliation, history.stops[0]!.window, history.standing],
    [1, 3, transition.transition, { ended: "open" }, null], "The history shows the stop and the transition that followed it");
  // Row 26: the decided fields of the line hold the reconciled results for whatever comes after.
  assert.deepEqual(decidedFieldsBefore(series as never, 4), transition.achieved.map(row => row.key).sort());
  // Row 27: a repeat, a reopen and another stop of the line write nothing and transfer nothing.
  assert.equal(ok(prepareReconcileSeries(f.store, { ...f.address, stop: 3 } as never)).writes.length, 0);
  f.restart();
  assert.equal(ok(prepareReconcileSeries(f.store, { ...f.address, stop: 3 } as never)).writes.length, 0);
  assert.equal(refusal(prepareReconcileSeries(f.store, { ...f.address, stop: 2 } as never)).code, "stop_absent");
  assert.equal(refusal(prepareReconcileSeries(f.store, { project, block: "garden-produce-block", line: 1, stop: 3 } as never)).code, "series_missing");
  // Row 29: a transition that is not at its exact reference is an addressed refusal, never "no ground".
  assert.equal(refusal(readSeriesProgressTransitionAt(f.store, project, { ...transition.transition, revision: 2 })).code, "record_missing");
  // Row 1 again: a repeat of an old close is the old close, with no progress written after it.
  const close = lp6Close(f, 1);
  assert.equal(ok(lp6PrepareClose(f.store, { ...f.address, attempt: 1, outcome: close.claim } as never)).writes.length, 0);
  // Row 26: a successor of the line carries the boundary and the reconciliation whole; its decided fields are the same.
  const successor = ok(openSeries(f.store, { project, block: f.block, line: 2, slice: "lp6-2", predecessor: reference(f.head()),
    basis: { ground: "inputs-changed", text: "The input of the block changed" } } as never)).value as RepairSeries;
  assert.deepEqual([successor.progressPolicy, successor.reconciliations], [series.progressPolicy, series.reconciliations]);
  assert.deepEqual(decidedFieldsBefore(successor as never, 4), decidedFieldsBefore(series as never, 4));
});

test("LP6 rows 22, 24, 25: on the second rung the pass reconciles a stop e7db0ba8 saved over clean ends of the replaced B1 before it asks for the owner's decision — the rung and its window stay, the real earlier stop and its review are not revisited, and a window with a real failure is never reconciled", async t => {
  const f = lp6Line(t);
  f.old("state-1", [1, 2, 3].flatMap(ordinal => [{ op: "round", ordinal, answers: [{ field: "checkKind", cannot: `Not decidable ${ordinal}` }] },
    { op: "close", ordinal }] as Lp6Op[]));
  // Row 24: three real refusals make a real stop; the transition of the new era is not available for it.
  const early = refusal(prepareReconcileSeries(f.store, { ...f.address, stop: 3 } as never));
  assert.deepEqual([early.code, early.at.field], ["progress_unproved", "attempts.1"]);
  const old = f.old("state-2", [{ op: "analyze", decided: true }, { op: "resume", stop: 3 },
    ...[[4, "state", { writer: "garden-produce-block" }], [5, "nodes", ["garden-produce-block", "garden-consume-block"]], [6, "state", { authority: "garden-consume-block" }]]
      .flatMap(([ordinal, field, value]) => [{ op: "round", ordinal, answers: [{ field: "expansion", unsent: true }] },
        { op: "replace", target: "garden-B1", field, value }, { op: "cease", ordinal }, { op: "close", ordinal }] as Lp6Op[])]);
  assert.deepEqual(old.verdicts, ["none", "none", "none"]);
  const stopped = ok(readSeries(f.store, f.address as never)).value as RepairSeries;
  assert.deepEqual([stopped.stop?.attempt, stopped.ladder.rung, stopped.ladder.windows, stopped.continuations.map(item => [item.after, item.ground])],
    [6, 2, [3], [[3, "review-record"]]]);
  // garden-produce-block comes first in M3: its own real stop on the second rung — fruitless standalone attempts and the
  // owner's decision between them — is no transition (row 24 through the pass) and ends nothing, so the pass goes on.
  const produce = { project, block: "garden-produce-block", line: 1 };
  ok(openSeries(f.store, { ...produce, slice: "lp6-produce", predecessor: null, basis: null } as never));
  const fruitless = { key: "lp6-produce-goal", questions: ["Expand the producer"], result: "An expanded producer" };
  const fail = (from: number) => { for (let attempt = from; attempt < from + 3; attempt++) {
    ok(beginAttempt(f.store, { ...produce, attempt, goal: fruitless } as never));
    ok(closeAttempt(f.store, { ...produce, attempt, outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } } as never));
  } };
  fail(1);
  const decision = f.store.write({ id: `${ownerDecisionNamespace(project)}lp6-produce`, kind: OWNER_DECISION_KIND, expected: 0,
    value: { projectId: project, block: produce.block, stop: 3, goals: [fruitless.key], decided: "go on: one more window",
      taken: { by: "the owner", through: "the command API", approved: true } } });
  ok(resumeSeries(f.store, { ...produce, stop: 3, ground: "owner-decision", text: "the owner decided to go on", decision: { ref: reference(decision) } } as never));
  fail(4);
  assert.equal(refusal(prepareReconcileSeries(f.store, { ...produce, stop: 6 } as never)).code, "progress_unproved");
  // Rows 22, 25: the pass chooses the transition before the second rung could end it; nothing else is paid or asked.
  ok(startRun(f.store, { project }));
  const sent = f.sent().length, trail: string[] = [];
  for (let index = 0; index < 12 && !trail.includes("reconcile"); index++) {
    f.restart();
    const advanced = ok(await advanceRun(f.store, { project, dispatch: f.dispatch } as RunRequest));
    const state = advanced.record.value.state as { phase: string; step?: { action: string } };
    trail.push(advanced.performed?.action ?? state.phase);
    assert.ok(state.phase !== "unable", `The pass never ends on the reconcilable stop: ${trail.join(",")}`);
  }
  assert.ok(trail.includes("reconcile"), trail.join(","));
  assert.equal(f.sent().length, sent, "No model was asked on the way to the transition");
  const series = ok(readSeries(f.store, f.address as never)).value as RepairSeries;
  assert.deepEqual([series.stop, series.ladder.rung, series.ladder.windows, series.withoutProgress], [null, 2, [3], 0]);
  const record = ok(readSeriesProgressTransitionAt(f.store, project, series.reconciliations![0]!.transition)).value;
  assert.deepEqual(record.rows.map(row => [row.ordinal, row.result]), [[4, "administrative"], [5, "administrative"], [6, "administrative"]]);
  // Row 25: the real stop after attempt 3 and its review-record stay as they were; the history shows both stops.
  assert.deepEqual(series.continuations.map(item => [item.after, item.ground]), [[3, "review-record"]]);
  const history = ok(readStopHistory(f.store, f.address as never)).stops;
  assert.deepEqual(history.map(item => [item.attempt, item.continuation?.ground ?? null, item.reconciliation ? "reconciled" : null]),
    [[3, "review-record", null], [6, null, "reconciled"]]);
  assert.deepEqual(series.attempts.slice(3).map(row => row.verdict), ["none", "none", "none"], "The old verdicts stay as they were written");
});

test("LP6 row 2: an attempt e7db0ba8 opened and left open is closed by the new code in the new era — a v2 close with its input-field result, the boundary activated at that very attempt on the revision before it", async t => {
  const f = lp6Line(t);
  f.old("open", [{ op: "round", ordinal: 1, answers: [{ field: "nodes", value: ["garden-produce-block", "garden-consume-block"] }, { field: "expansion", unsent: true }] },
    { op: "cease", ordinal: 1 }]);
  const before = reference(f.head());
  assert.equal(f.head().value.attempts[0]!.outcome, null, "The old code left the attempt open");
  const claim = ok(prepareManagedClaim(f.store, { ...f.address, attempt: 1, outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } } as never));
  const closed = ok(closeAttempt(f.store, { ...f.address, attempt: 1, outcome: claim.outcome } as never));
  assert.equal(closed.verdict, "progress");
  const close = lp6Close(f, 1);
  assert.deepEqual([close.contract, close.outcome.reason, close.outcome.progress], ["om-completion-close/v2", "result", { contract: "om-attempt-progress/v1", administrative: null }]);
  assert.deepEqual((ok(readSeries(f.store, f.address as never)).value as RepairSeries).progressPolicy, { contract: "om-series-progress/v1", previous: before, from: 1 });
});

test("LP6 return №3371: an accepted field beside a real failure of the same attempt — a refusal of the model (the reviewer's probe), the owner's wait, an interrupted call — is no reconciled row: the stop stands for the producer, for the reader of a transition and after a reopen, and the facts A6 is shown keep the mixed end", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  // A stop e7db0ba8 saved over three mixed attempts, the producer and the reader of the new era over it.
  const check = (f: ReturnType<typeof lp6Line>, failures: RegExp[]) => {
    const stopped = ok(readSeries(f.store, f.address as never)).value as RepairSeries;
    assert.deepEqual([stopped.stop?.attempt, stopped.withoutProgress], [3, 3]);
    // The facts of every attempt: a fresh result of its own field AND the failure beside it — never an input transition.
    const report = ok(stopReportOfNewEra(f.store, f.address as never)), evidence = report.completionEvidence!;
    assert.deepEqual(evidence.map(row => [row.ordinal, row.effect, row.results.length > 0]), [[1, "failure", true], [2, "failure", true], [3, "failure", true]]);
    evidence.forEach((row, index) => assert.ok(row.remaining.some(item => failures[index]!.test(item)), row.remaining.join("; ")));
    assert.notEqual(report.finding.subject, "input-transition");
    assert.ok(report.lines.some(line => line.includes("beside real failure")), "The text of the report says the end was mixed");
    // The producer: no transition — the first row with a real failure answers for the whole window; nothing is prepared.
    const unfit = refusal(prepareReconcileSeries(f.store, { ...f.address, stop: 3 } as never));
    assert.deepEqual([unfit.code, unfit.at.field], ["progress_unproved", "attempts.1"]);
    assert.match(unfit.message, failures[0]!);
    // The reader: a transition of this stop that took the fresh fields alone (as a derivation blind to the failures would
    // write it), seen through a view — the database is never touched — is refused by the one derivation it is read by.
    const goals = new Map(stopped.attempts.map(row => [row.ordinal, row.goal]));
    const blind = { contract: "om-series-progress-transition/v1", project, series: reference(f.head()), stop: 3,
      rows: evidence.map(row => ({ ordinal: row.ordinal, goal: goals.get(row.ordinal)!, close: row.close!, result: "input-field",
        achieved: [...row.results], sources: row.decisions.map(decision => decision.e4) })) };
    const id = seriesProgressTransitionId(project, reference(f.head()), 3), planted = { id, revision: 1, hash: hashJson(blind as unknown as Json) };
    const view = new Proxy(f.store, { get(target, property) {
      if (property === "get") return (key: string, revision?: number) => key === id
        ? { id, kind: SERIES_PROGRESS_TRANSITION_KIND, revision: 1, hash: planted.hash, value: blind } : target.get(key, revision);
      const member: unknown = Reflect.get(target, property, target); return typeof member === "function" ? member.bind(target) : member;
    } }) as Store;
    assert.equal(refusal(readSeriesProgressTransitionAt(view, project, planted)).code, "progress_unproved");
    // After a reopen: the stop stands, the count is not cleared, no transition exists.
    f.restart();
    const again = ok(readSeries(f.store, f.address as never)).value as RepairSeries;
    assert.deepEqual([again.stop?.attempt, again.withoutProgress, again.reconciliations, again.progressPolicy], [3, 3, undefined, undefined]);
    assert.equal(f.store.list(SERIES_PROGRESS_TRANSITION_KIND).length, 0);
    assert.equal(refusal(prepareReconcileSeries(f.store, { ...f.address, stop: 3 } as never)).code, "progress_unproved");
  };
  // The reviewer's probe (№3371): each attempt refused by the model on its node and, beside it, its own field applied.
  const probe = lp6Line(t);
  const refused = probe.old("probe", ([[1, "nodes", ["garden-produce-block", "garden-consume-block"]],
    [2, "state", { writer: "garden-produce-block", authority: "garden-consume-block", rollback: "garden-produce-block" }], [3, "checkKind", "test"]] as const)
    .flatMap(([ordinal, field, value]) => [{ op: "round", ordinal, answers: [{ field: "expansion", cannot: `Real unresolved refusal ${ordinal}` }, { field, value }] },
      { op: "cease", ordinal }, { op: "close", ordinal }] as Lp6Op[]));
  assert.deepEqual(refused.verdicts, ["none", "none", "none"]);
  check(probe, [/model_cannot_answer/, /model_cannot_answer/, /model_cannot_answer/]);
  // The owner's wait and an interrupted call beside an applied field, each in an attempt the old rules count.
  const other = lp6Line(t);
  const mixed = other.old("mixed", [
    { op: "round", ordinal: 1, answers: [{ field: "checkKind", owner: "The owner names the check of the criterion" },
      { field: "nodes", value: ["garden-produce-block", "garden-consume-block"] }, { field: "expansion", unsent: true }] },
    { op: "cease", ordinal: 1 }, { op: "close", ordinal: 1 },
    { op: "round", ordinal: 2, answers: [{ field: "expansion", exit: 1 },
      { field: "state", value: { writer: "garden-produce-block", authority: "garden-consume-block", rollback: "garden-produce-block" } }] },
    { op: "cease", ordinal: 2 }, { op: "close", ordinal: 2 },
    { op: "round", ordinal: 3, answers: [{ field: "expansion", exit: 1 }, { field: "checkKind", value: "test" }] },
    { op: "cease", ordinal: 3 }, { op: "close", ordinal: 3 },
  ]);
  assert.deepEqual(mixed.verdicts, ["none", "none", "none"]);
  check(other, [/waiting for the owner/, /model_adapter_interrupted/, /model_adapter_interrupted/]);
});

import { readCompletionWorkAt } from "../src/om/model-call.js";
import { completionWorkId } from "../src/om/series.js";
import { writeGaps as lp7WriteGaps, type GapRequest as Lp7GapRequest } from "../src/om/gaps.js";
import { writeRoutes as lp7WriteRoutes, prepareRoutes } from "../src/om/routes.js";
import { gapLineKey as lp7LineKey, gapLineExpectedResult as lp7Result } from "../src/om/gap-lines.js";
const LP7_VALUES: Record<string, Json> = { nodes: ["garden-produce-block", "garden-consume-block"], checkKind: "test",
  state: { writer: "garden-produce-block", authority: "garden-consume-block", rollback: "garden-consume-block" } };
/** Today's routes of the LP6 line's current B1: the open input fields of its block are one batch (LP7). */
function lp7Routes(f: ReturnType<typeof lp6Line>) {
  const input = f.store.get(`om-input:${project}`)!, graph = f.store.get(`graph:${project}`)!;
  const horizon = ok(writeHorizon(f.store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: `lp7-${input.revision}`, features: [{ outcome: "garden-result" }], excluded: [] } }));
  const sources: Lp7GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(f.store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(lp7WriteGaps(f.store, sources));
  return ok(lp7WriteRoutes(f.store, { project, gaps: { sources: structuredClone(gaps.sources) as Lp7GapRequest, records: gaps.records.map(reference) },
    tasks: [], catalog: { paths: [], records: [] }, previous: null }));
}

test("LP7 row 30: one full answer to the joined input fields replaces B1 once; the rest of the attempt ends cleanly by that replacement, the v2 close takes every LP6 key, the line moves on without a false stop, and a reopen reads it all and pays nothing again", async t => {
  const f = lp6Line(t), scenario = join(f.root, "scenario.json");
  const routes = lp7Routes(f), byBlock = routes.value.batches.filter(batch => batch.items.every(item => item.consumers.includes(f.block)));
  const joined = byBlock.find(batch => batch.task === "input-field" && new Set(batch.items.map(item => item.field)).size > 1)!;
  const expansion = byBlock.find(batch => batch.task === "node-expansion")!;
  assert.deepEqual([routes.value.grouping, [...new Set(joined.items.map(item => item.field))].sort()], ["block-input-v1", ["checkKind", "nodes", "state"]]);
  assert.ok(expansion);
  const items = [...joined.items, ...expansion.items];
  const goal = { key: "lp7:30", questions: items.map(item => lp7LineKey(project, item.target, item.field)).sort(), result: lp7Result(project, items[0]!.target, items[0]!.field) };
  const series = ok(openAttempt(f.store, { ...f.address, attempt: 1, goal, completion: { routes: reference(routes), batches: [joined.id, expansion.id].sort() } } as never));
  const packetOf = (batch: typeof joined) => ok(writeQuestionPacket(f.store, { project, routes: reference(routes), batch: batch.id,
    environment: f.dispatch.config, attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  const packet = packetOf(joined); packetOf(expansion);
  writeFileSync(scenario, JSON.stringify({ database: f.database, steps: [{ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
    results: joined.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: LP7_VALUES[item.field]! })) }, usage }] }));
  const before = f.store.get(`om-input:${project}`)!.revision;
  const sent = ok(await runModelCall(f.store, { project, packet: reference(packet), dispatch: f.dispatch, role: "implementer" }));
  assert.deepEqual([sent.outcome?.kind, f.store.get(`om-input:${project}`)!.revision], ["input-decisions", before + 1], "One application, one B1 revision");
  // The unsent expansion of the same attempt ends by the replaced B1 of its own area — the LP4/LP5 door, never a failure.
  const binding = ok(readCompletionBinding(f.store, project, reference(f.head()), 1))!;
  for (let open = true; open;) {
    const work = ok(readCompletionWorkAt(f.store, project, reference(f.store.get(completionWorkId(project, binding.id))!)));
    const resolved = new Set(work.resolved.map(ref => ref.id));
    const row = work.assignments.filter(item => !resolved.has(item.id)).sort((a, b) => Number(a.value.kind !== "root") - Number(b.value.kind !== "root"))[0];
    open = row !== undefined;
    if (row) ok(writeCompletionCessation(f.store, { project, binding: reference(binding), assignment: reference(row) }));
  }
  const claim = ok(prepareManagedClaim(f.store, { ...f.address, attempt: 1, outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } } as never));
  assert.equal(ok(closeAttempt(f.store, { ...f.address, attempt: 1, outcome: claim.outcome } as never)).verdict, "progress");
  const close = lp6Close(f, 1);
  assert.deepEqual([close.contract, close.outcome.reason], ["om-completion-close/v2", "result"]);
  assert.deepEqual(close.outcome.achieved.map(item => item.key.startsWith("om-result:input-field:")), [true, true, true, true, true], "nodes, writer, authority, rollback, checkKind");
  const line = ok(readSeries(f.store, f.address as never)).value as RepairSeries;
  assert.deepEqual([line.stop, line.withoutProgress, line.attempts.map(row => row.verdict)], [null, 0, ["progress"]], "No false stop");
  assert.equal(f.store.get(`om-input:${project}`)!.revision, before + 1, "The cessation and the close replace no B1 again");
  const sends = f.sent().length, saved = f.store.list().map(reference);
  f.restart();
  assert.deepEqual(lp6Close(f, 1), close);
  assert.deepEqual(ok(readSeries(f.store, f.address as never)).value, line);
  assert.deepEqual([f.sent().length, f.store.list().map(reference)], [sends, saved], "A reopen reads; it neither pays nor writes");
});




test("LP7 row 26: one question of a joined batch waiting for the owner holds that whole batch — none of its fields is asked again — while a free batch the wait does not hold is worked on", async t => {
  const f = runFixture(t, ["encoding"], true, false, false, true);
  const built = ok(writeRunBases(f.store, { project })), request = f.request();
  assert.equal(f.store.get<RoutesRecord>(built.bases.routes.id, built.bases.routes.revision)!.value.grouping, "block-input-v1");
  const source = () => f.store.get<{ content: string }>(`source:${project}:brief`)!;
  const steps: Record<string, unknown>[] = [], sent: string[][] = [];
  let state = ok(await advanceRun(f.store, request)).record.value.state;
  for (let index = 0; index < 80 && !["waiting", "complete", "unable"].includes(state.phase); index++) {
    if (state.phase === "step" && state.step.action === "assess") { steps.push(assessor("supported")); f.steps(steps); }
    if (state.phase === "step" && state.step.action === "cycle") {
      const packet = f.store.get<QuestionPacketRecord>((state.step.request as unknown as { packet: Ref }).packet.id)!;
      const routes = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
      const batch = routes.batches.find(row => row.id === packet.value.request.batch)!;
      sent.push([...new Set(batch.items.map(item => item.field))].sort());
      // M5 addresses the encoding; the block asks the owner one question of its joined batch and answers its fact.
      steps.push(batch.items.every(item => item.field === "address") ? { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
          results: batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: { consumer: "garden-consume-block", kind: "repository-fact" } })) }, usage }
        : batch.task === "input-field" ? { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "need_owner",
          questionIds: batch.items.filter(item => item.field === "checkKind").map(item => item.gap), reason: "The owner decides the check kind", decision: "Name it" }, usage }
        : { research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", results: batch.items.map(item => ({ questionId: item.gap, value: { answer: "UTF-8" },
          citations: [{ source: reference(source()), selector: { kind: "text-range", start: 0, end: source().value.content.length } }] })) }, usage });
      f.steps(steps);
    }
    state = ok(await advanceRun(f.store, request)).record.value.state;
  }
  assert.deepEqual(sent[0], ["address"], "Row 6: M5 goes first, and the address keeps its own batch beside the joined one");
  assert.deepEqual(sent.map(row => row.join("+")).sort(), ["address", "answer", "checkKind+nodes+state"],
    `Each batch once: M5, the free fact and the joined batch whose one question waits: ${JSON.stringify(sent)}`);
  assert.ok(actions(f.store).includes("assess"), "The free fact batch is worked on — its answer is assessed — beside the wait");
  assert.equal(state.phase, "waiting");
  // The wait holds the whole joined batch: further steps ask none of its fields again and pay nothing.
  const calls = f.sent().length;
  for (let index = 0; index < 3; index++) ok(await advanceRun(f.store, request));
  assert.deepEqual([f.sent().length, blockSeries(f).value.attempts.length], [calls, 1]);
});

const LP7_BASE = "7c7d3cccb88d0a6c17b21051069f0244d98248f9";
test("LP7 row 21 (run): a field packet the base code 7c7d3ccc issued on its split route before the release is answered by today's code — the exact route stays current and the paid answer applies once", async t => {
  const f = lp6Line(t);
  f.old("lp7-issued", [{ op: "round", ordinal: 1, answers: [{ field: "nodes", unsent: true }] }], LP7_BASE);
  const packet = f.store.list<QuestionPacketRecord>("question-packet")[0]!;
  const routes = ok(readRoutes(f.store, { project, record: packet.value.request.routes })).record as unknown as Revision<RoutesRecord>;
  assert.equal(routes.value.grouping, "consumer-set-v1", "The base code's own split route");
  // Split by field: today's birth rule joins exactly these (row 30 on the same line); the saved route stays current by its own algorithm.
  assert.equal(routes.value.batches.filter(row => row.task === "input-field" && row.items.every(item => item.consumers.includes(f.block))).length, 3);
  const saved = routes.value.request, again = ok(prepareRoutes(f.store, { project, gaps: saved.gaps as never, tasks: saved.tasks.map(record => ({ record })),
    catalog: { paths: [...saved.catalog.paths], records: [...saved.catalog.records] }, previous: saved.previous }));
  assert.deepEqual([again.existing, again.writes.length, reference(again.record)], [true, 0, reference(routes)]);
  const batch = routes.value.batches.find(row => row.id === packet.value.request.batch)!;
  writeFileSync(join(f.root, "scenario.json"), JSON.stringify({ database: f.database, steps: [{ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
    results: batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: LP7_VALUES[item.field]! })) }, usage }] }));
  const before = f.store.get(`om-input:${project}`)!.revision;
  const sent = ok(await runModelCall(f.store, { project, packet: reference(packet), dispatch: f.dispatch, role: "implementer" }));
  assert.deepEqual([sent.outcome?.kind, f.store.get(`om-input:${project}`)!.revision, f.sent().length], ["input-decisions", before + 1, 1]);
});

test("LP7 rows 14, 24 (run): an answer of some joined fields — part of state included — applies only them; on the new B1 today's routing joins the rest, and its answer completes the subject keys of one full answer", async t => {
  const f = lp6Line(t), scenario = join(f.root, "scenario.json"), steps: unknown[] = [], keys: string[] = [];
  const round = async (ordinal: number, values: Record<string, Json>) => {
    const routes = lp7Routes(f), joined = routes.value.batches.find(batch => batch.task === "input-field" && batch.items.every(item => item.consumers.includes(f.block))
      && new Set(batch.items.map(item => item.field)).size > 1)!;
    const goal = { key: `lp7:${ordinal}`, questions: joined.items.map(item => lp7LineKey(project, item.target, item.field)).sort(), result: lp7Result(project, joined.items[0]!.target, joined.items[0]!.field) };
    const series = ok(openAttempt(f.store, { ...f.address, attempt: ordinal, goal, completion: { routes: reference(routes), batches: [joined.id] } } as never));
    const packet = ok(writeQuestionPacket(f.store, { project, routes: reference(routes), batch: joined.id, environment: f.dispatch.config,
      attempt: { series: reference(series), ordinal }, previous: [] })).record;
    steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", results: joined.items.filter(item => Object.hasOwn(values, item.field))
      .map(item => ({ target: item.target, field: item.field, basis: item.record, value: values[item.field]! })) }, usage });
    writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
    const sent = ok(await runModelCall(f.store, { project, packet: reference(packet), dispatch: f.dispatch, role: "implementer" }));
    const claim = ok(prepareManagedClaim(f.store, { ...f.address, attempt: ordinal, outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } } as never));
    assert.equal(ok(closeAttempt(f.store, { ...f.address, attempt: ordinal, outcome: claim.outcome } as never)).verdict, "progress");
    keys.push(...lp6Close(f, ordinal).outcome.achieved.map(item => item.key));
    return { joined, sent };
  };
  const first = await round(1, { nodes: LP7_VALUES.nodes!, state: { writer: "garden-produce-block" } });
  assert.deepEqual(first.sent.outcome?.unanswered, first.joined.items.filter(item => item.field === "checkKind").map(item => item.gap));
  assert.equal(keys.length, 2, "nodes and the writer of state only");
  const second = await round(2, { state: LP7_VALUES.state!, checkKind: "test" });
  assert.deepEqual([...new Set(second.joined.items.map(item => item.field))].sort(), ["checkKind", "state"], "Row 14: the new B1's route joins the rest");
  assert.deepEqual([keys.length, f.store.get(`om-input:${project}`)!.revision], [5, 3], "The rest adds authority, rollback and checkKind — never the writer again");
  assert.deepEqual(ok(readSeries(f.store, f.address as never)).value.withoutProgress, 0);
});

test("LP7 row 22 (run): the routes, packets, paid applied answer and close the base code 7c7d3ccc wrote are read by today's code after a reopen exactly as written — nothing is executed again to read them", async t => {
  const f = lp6Line(t);
  f.old("lp7-history", [{ op: "round", ordinal: 1, answers: [{ field: "nodes", value: LP7_VALUES.nodes! }, { field: "checkKind", unsent: true }] },
    { op: "cease", ordinal: 1 }, { op: "close", ordinal: 1 }], LP7_BASE);
  f.restart();
  const before = f.store.list().map(reference), calls = f.sent().length;
  const routes = f.store.list<RoutesRecord>("route-result");
  assert.ok(routes.length > 0 && routes.every(row => row.value.grouping === "consumer-set-v1"), "The base code's own split routes");
  for (const row of routes) assert.deepEqual(ok(readRoutes(f.store, { project, record: reference(row) })).record, row);
  for (const row of f.store.list<QuestionPacketRecord>("question-packet")) assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(row) })), row);
  const close = lp6Close(f, 1);
  assert.deepEqual([close.contract, close.outcome.reason, close.outcome.achieved.length], ["om-completion-close/v2", "result", 1]);
  assert.equal(ok(readSeries(f.store, f.address as never)).value.withoutProgress, 0);
  assert.deepEqual([f.store.list().map(reference), f.sent().length, calls], [before, calls, 1], "Reading wrote nothing and paid nothing again");
});

// ---- LP8.1 (№3670): an unable pass weighs its grounds again by today's rules at every entry ----
import { continuePass, startPass } from "../src/om/run-driver.js";
import { configureDispatch } from "../src/om/dispatch.js";
import { prepareRunBases as lp81PrepareRunBases } from "../src/om/run-bases.js";
const LP81_BASE_COMMIT = "ea207137a7e26a96792f12a3bffd8bc255df59f2";
type Reopened = { phase: "reopened"; from: Ref; reasons: RunReason[]; ground: { step?: RunStep; wait?: RunWait; complete?: Ref[] } };
const passRows = (store: Store) => store.history(runId(project)).map(row => (row.value as unknown as RunRecord).state.phase);
/** The R5 scenario whose review the old adapter wrapper refused (`confirmed` missing): ea207137, run from Git, ends the pass on it. */
async function wrapperUnable(t: test.TestContext) {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("lp81-wrapper"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, { ...stopAnswer(f, true), confirmed: null }, addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  await driveTo(f, request, "analyze", 40);
  const failure = f.store.list().find(row => row.kind === "om-stop-analysis-failure")!;
  assert.ok(failure, "The review was refused for the wrapper and saved as a failure");
  const ended = atCommit(f, LP81_BASE_COMMIT, "lp81-base", `const { advanceRun } = await import(src('om/run.js'));
let state = null;
for (let index = 0; index < 10; index++) {
  state = take(await advanceRun(store, args.request)).record.value.state;
  if (state.phase === 'unable' || state.phase === 'waiting') break;
}
out(state);`, { request }) as { phase: string };
  assert.equal(ended.phase, "unable", `The base ends the pass on the failed review: ${JSON.stringify(ended)}`);
  f.restart();
  const unable = ok(readRun(f.store, { project }))!;
  assert.deepEqual(reasonsOf(unable.value.state).map(row => [row.kind, row.code]), [["stop-analysis-failed", "analysis_failed"]]);
  return { f, request, failure: reference(failure), unable };
}

test("LP8.1 (№3670) era: a pass ea207137 ended unable on a review the old adapter wrapper refused is reopened at the next entry by one transition — the exact unable revision, its grounds and the recovery step — and goes on without a call; a repeat, a reopened store and a second entry write no second reopening", async t => {
  const { f, request, failure, unable } = await wrapperUnable(t);
  const sends = f.sent().length;
  const reopened = ok(await advanceRun(f.store, request));
  assert.equal(reopened.performed, null);
  const state = reopened.record.value.state as unknown as Reopened;
  assert.deepEqual([state.phase, state.from, state.reasons], ["reopened", reference(unable), (unable.value.state as unknown as Reopened).reasons]);
  assert.deepEqual([state.ground.step?.action, state.ground.step?.request], ["recover-analysis", { project, failure }]);
  assert.deepEqual(reopened.record.value.last, unable.value.last, "The reopening keeps the last performed step of the pass");
  f.restart();
  const recovered = await driveTo(f, request, "recover-analysis", 5);
  assert.deepEqual(recovered.performed, ["recover-analysis"]);
  const review = f.store.list().find(row => row.kind === "om-stop-review" && (row.value as { recovery?: { failure: Ref } }).recovery);
  assert.ok(review, "The saved answer is accepted once at the review's own address");
  assert.equal(f.sent().length, sends, "The recovery calls no model");
  const went = await ends(f, request, 5, "resume");
  assert.deepEqual(went.performed, ["resume"], "The decided review resumes the M5 line: the pass goes on past its old end");
  assert.equal(passRows(f.store).filter(phase => phase === "reopened").length, 1, "One reopening, whatever came after it");
  assert.equal(passRows(f.store).filter(phase => phase === "unable").length, 1);
});

test("LP8.1 grounds that stay final: an unable pass on a review that never completed stands — advance, start and continue write nothing, take no execution and send nothing, also after a restart", async t => {
  const f = runFixture(t, ["encoding"]);
  const b = f.bases("lp81-final"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, { rawStdout: "{broken", exitCode: 7, stderr: "intentional reviewer failure" }, addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  await driveTo(f, request, "analyze", 40);
  const end = await ends(f, request, 5);
  assert.equal(end.state.phase, "unable");
  const before = canonical(f.store.list().map(reference) as unknown as Json), sends = f.sent().length;
  for (const restart of [false, true]) {
    if (restart) f.restart();
    assert.equal(ok(await advanceRun(f.store, request)).performed, null);
    const started = ok(await startPass(f.store, { project })), continued = ok(await continuePass(f.store, { project }));
    assert.deepEqual([started.end, continued.end], ["unable", "unable"]);
    assert.equal(canonical(f.store.list().map(reference) as unknown as Json), before, "Nothing is written — no reopening, no execution claim");
    assert.equal(f.sent().length, sends);
  }
  assert.deepEqual(passRows(f.store).filter(phase => phase === "reopened"), []);
});

test("LP8.1 start and continue of an unable pass whose grounds no longer stand drive it: the reopening, the recovery and the next work under one execution", async t => {
  const { f, failure, unable } = await wrapperUnable(t);
  ok(configureDispatch(f.store, { project, protocol: "codex-stdio" }));
  const sends = f.sent().length;
  ok(await continuePass(f.store, { project }));
  const rows = passRows(f.store);
  assert.equal(rows.filter(phase => phase === "reopened").length, 1);
  assert.ok(f.store.history(runId(project)).some(row => row.revision > unable.revision + 1
    && (row.value as unknown as RunRecord).last?.step.action === "resume"), "The continue drove the pass past its old end");
  assert.ok(f.store.list().some(row => row.kind === "om-stop-review" && canonical((row.value as { recovery?: { failure: Ref } }).recovery?.failure as unknown as Json) === canonical(failure as unknown as Json)));
  assert.ok(f.sent().length >= sends, "Only the work after the recovery may call");
  // A second start finds the pass live and never reopens it again.
  ok(await startPass(f.store, { project }));
  assert.equal(passRows(f.store).filter(phase => phase === "reopened").length, 1);
});

test("LP8.1 the reopening is guarded by the exact unable revision: another store moving the pass between the weighing and the write leaves its record, nothing is written over it", async t => {
  const { f, request, unable } = await wrapperUnable(t);
  let raced = false;
  class Moving extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "om-run" && (write.value as { state?: { phase?: string } }).state?.phase === "reopened")) {
        raced = true;
        const other = new Store(f.database);
        try {
          const head = other.get<RunRecord>(runId(project))!;
          other.write({ id: head.id, kind: head.kind, expected: head.revision, value: { ...head.value, state: { phase: "ready" } } as unknown as Json });
        } finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  f.restart(path => new Moving(path));
  const advanced = await advanceRun(f.store, request);
  assert.ok(raced);
  assert.equal(refusal(advanced).code, "revision_conflict");
  const head = ok(readRun(f.store, { project }))!;
  assert.deepEqual([head.revision, head.value.state.phase], [unable.revision + 1, "ready"], "The other store's record stands");
  assert.deepEqual(passRows(f.store).filter(phase => phase === "reopened"), []);
});

test("LP8.1 a reopened record names the exact unable revision, its grounds and exactly one new ground; absence or excess is refused on reading; bases are read as of a live pass only while it weighs its grounds again", async t => {
  const { f, unable } = await wrapperUnable(t);
  const reasons = (unable.value.state as unknown as Reopened).reasons;
  const step: RunStep = { action: "recover-analysis", request: { project } as unknown as Json, series: null, attempt: null };
  const bad = (state: unknown) => {
    const head = f.store.get<RunRecord>(runId(project))!;
    const written = f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: { ...head.value, state } as unknown as Json });
    assert.equal(refusal(readRun(f.store, { project })).code, "run_record_invalid", JSON.stringify(state));
    f.store.write({ id: head.id, kind: head.kind, expected: written.revision, value: head.value as unknown as Json });
  };
  const from = reference(unable);
  bad({ phase: "reopened", from, reasons, ground: {} });
  bad({ phase: "reopened", from, reasons, ground: { step, wait: { code: "x", message: "x", target: "x", field: "x", basis: [] } } });
  bad({ phase: "reopened", from, reasons });
  bad({ phase: "reopened", reasons, ground: { step } });
  bad({ phase: "reopened", from, reasons: [], ground: { step } });
  bad({ phase: "reopened", from: { id: from.id }, reasons, ground: { step } });
  bad({ phase: "reopened", from, reasons, ground: { complete: [from] } });
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "unable");
  assert.equal(refusal(lp81PrepareRunBases(f.store, { project })).code, "run_bases_terminal", "An unable pass takes no bases");
  assert.throws(() => lp81PrepareRunBases(f.store, { project }, { reweigh: "yes" } as never), (error: unknown) => error instanceof EngineError && error.code === "run_bases_request_invalid");
  assert.ok(ok(lp81PrepareRunBases(f.store, { project }, { reweigh: true })), "Weighing its grounds again, it reads them as a live pass");
});
