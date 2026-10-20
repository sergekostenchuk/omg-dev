import type test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { type Sealed, type OmResult, type Refusal } from "../src/om/refusal.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import type { Graph } from "../src/graph/model.js";
import { ProductEngine } from "../src/product/engine.js";
import { git } from "../src/runtime/environment.js";
import { Evidence } from "../src/evidence/evidence.js";
import type { FrameRead, FrameRequest } from "../src/om/frame-obligations.js";
import type { HorizonRecords } from "../src/om/horizon.js";
import type { OmInputRecord } from "../src/om/input.js";
import { writeQuestionPacket, type QuestionPacketRecord } from "../src/om/question-packet.js";
import { WORKS_BRIEF_PACKET_CONTRACT } from "../src/om/packet-brief.js";
import { prepareFrameProposals, type ProposalRequest } from "../src/om/frame-proposals.js";
import { gardenGraph, prepareNativeLayers } from "./om-fixture.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";
import { projectGraph } from "../src/graph/project.js";
import { fillObligations, prepareFrame, type FrameScope } from "../src/om/frame-obligations.js";
import { writeCandidate } from "../src/om/frame-candidate.js";
import { settleCandidate } from "../src/om/frame-accept.js";
import type { LayerProposal } from "../src/om/frame-proposals.js";
import type { Node } from "../src/graph/model.js";
import { preparedField } from "./preparation-fixture.js";
import { readOmInput, writeOmInput } from "../src/om/input.js";
import { writeHorizon, writeHorizonIssuance } from "../src/om/horizon.js";
import { writeSeriesTransition } from "../src/om/series-transition.js";
import { applySeriesActivation, beginAttempt, openSeries, readCompletionBinding } from "../src/om/series.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { readRoutes, type RouteBatch, type RoutesRecord } from "../src/om/routes.js";
import type { AnyRepairSeries, RepairSeries } from "../src/om/series.js";
import { closeAttempt, openAttempt, prepareManagedClaim } from "../src/om/repeat-gate.js";
import { type ModelCallOutcome, type ModelCycleRecord, readModelCall, runModelCall, readCompletionWorkAt, writeCompletionCessation } from "../src/om/model-call.js";
import { gapLineExpectedResult, gapLineKey } from "../src/om/gap-lines.js";
import { advanceRun as currentAdvanceRun, cycleStartOf, readRun, startRun, runId, type RunRequest, type RunRecord, type RunResult, type RunStep, type RunWait, type RunReason } from "../src/om/run.js";
import { prepareRunBases, writeRunBases, type RunBases } from "../src/om/run-bases.js";
import { regateRun } from "../src/om/run.js";
import { releaseRegateWait } from "../src/om/run.js";
import { gatePolicies } from "../src/om/atomic-gate.js";
// OWN1 (№3719, return of Codex-omg): the owner's answer is above the model's, and a decision packet asks no owner.
import { issueOwnerInvitation, OwnerSessions } from "../src/product/owner-authority.js";
import { writeOwnerResult } from "../src/om/owner-result.js";
import { writeOwnerDecision } from "../src/om/addressing.js";
// ---- MP2 (№2968): the still unstarted roots of an attempt by the flows of their frame; neighbours of a brief root ----
import { rankExpansions } from "../src/om/run.js";
// ---- LP5 (№3278): after a replaced B1 the old work ends by its own products, the new bases are built, paid assemblies answer again ----
import { COMPLETION_REUSE_KIND, prepareCompletionFinalization, type CompletionReuse } from "../src/om/model-call.js";
// ---- G5.1 (№3833, №3847, №3851): the wake choice of a producer end answered before the wake-test era ----
// ---- LP6 (№3325 §4–§5): stops saved by e7db0ba8 under the old rules, read literally and reconciled by the new era ----
import { completionCloseId, completionWorkId } from "../src/om/series.js";
import { readCompletionCloseAt } from "../src/om/repeat-gate.js";
import { writeGaps as lp7WriteGaps, type GapRequest as Lp7GapRequest } from "../src/om/gaps.js";
import { writeRoutes as lp7WriteRoutes } from "../src/om/routes.js";
// AT1 door (№4105): a works answer whose file a test may load through a transition nobody resolved is refused by G5; the
// group's rejection first asks that transition in B1 (its source the saved gate), research answers it with the exact files
// of the snapshot, the answer is applied, and the next works — now deciding the test the transition reaches — pass G5 on
// the same snapshot. The question is asked once; a repeat of the B1 transition writes nothing.
import { writeReadinessInput } from "../src/om/input.js";


const project = "garden";
const adapterFixture = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`Unexpected refusal: ${result.refusal.code}: ${result.refusal.message} ${JSON.stringify(result.refusal.at)}`);
  return result.value;
}
function refusal<T>(result: OmResult<T>): Refusal { if (result.ok) assert.fail("Expected a refusal"); return result.refusal; }

/**
 * A run with its own graph, questions and adapter. Explicit modes use current upstream producers and native
 * N2/L3 acceptance; boolean refinement remains for consumers not yet moved off the research route.
 * A cold run never prebuilds B1 or an OM frame, even if an accepted-layer mode was requested.
 */
type RunFixtureMode = "stages" | "n2" | "executed";
function runFixture(t: test.TestContext, questions = ["encoding", "spare"], refine: boolean | RunFixtureMode = true, addressed: boolean | string[] = false, later = false, cold = false,
  unknowns: Readonly<Record<string, { consumer?: string; moment?: string }>> = {}, historicalCommit?: string) {
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
  const mode = typeof refine === "string" ? refine : undefined;
  const { level: _currentLevel, ...currentUpper } = projectGraph(graphData, 1);
  preparedFeatures(engine, project, mode ? currentUpper as Graph : graphData, field => {
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
  }, mode ? "" : historicalCommit);
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const environment = (amount = 100_000) => engine.environments.configure(project, { workspace,
    implementer: { actor: "run-implementer", model: "fixture", effort: "high", speed: "fast", command },
    reviewer: { actor: "run-reviewer", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: amount },
  store.get(`environment:${project}`)?.revision ?? 0);
  const configured = environment();
  if (mode && mode !== "stages" && !cold) prepareNativeLayers(engine, project, graphData, mode);
  else if (refine === true) refinedLayers(engine, project);
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const graph = reference(store.get(`graph:${project}`)!);
  // A cold project has no OM record at all: its first B1 is written by the machine bases (H1.1).
  const input = cold ? null : fixtureInput();
  function fixtureInput() {
  const base = (mode ? store.get<OmInputRecord>(`om-input:${project}`) : null)
    ?? ok(writeOmInput(store, { project, expected: 0, stages }));
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
      refinement: mode && store.get(`om-frame:${project}:2`) ? reference(store.get(`graph-layer:${project}:2`)!) : null,
      available: {}, choice: { choiceVersion, ...choice } }));
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

/** Reaches the second rung of the M5 line: three refused attempts, the one undecided review, nothing ended yet. */
async function secondRung(t: test.TestContext, mode: boolean | RunFixtureMode = true) {
  const f = runFixture(t, ["encoding"], mode);
  const b = f.bases("h12-window"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, stopAnswer(f, false), addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  await driveTo(f, request, "analyze", 40);
  assert.equal(ok(readRun(f.store, { project }))!.value.state.phase, "ready");
  return { f, request };
}

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
/**
 * RL3 (№4205): the owner's om-regate over the accepted L3 of a completed pass — rows 1–9 of the outcome table of the
 * inventory (~/REPORTS/review/omg-rl3-inventory_121026.md). The door is AT1's own: a test the snapshot gained reaches the
 * file a work writes, and the work's impact decisions no longer cover it.
 */
/**
 * RL3: the garden pass of H1.2 started over its accepted operations, with the answering adapter of its own scenario: `respond`
 * answers a saved cycle with a work, `drive` advances to a chosen state and fails on any other stand.
 */
async function gardenPass(t: test.TestContext) {
  const f = (await loadOperations()).acceptedOperationsFixture(t, "planned", 0);
  const { store, workspace, desired } = f;
  const built = ok(writeRunBases(store, { project, outcomes: ["garden-result"] }));
  const scenario = join(f.root, "scenario.json"), trace = join(f.root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const environment = f.engine.environments.configure(project, { workspace,
    implementer: { actor: "rl3-works-producer", model: "fixture", effort: "high", command },
    reviewer: { actor: "rl3-works-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 200_000 }, 0);
  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(workspace, path), text);
    git(workspace, ["add", ...Object.keys(files)]);
    git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-qm", message]);
  };
  writeFileSync(join(workspace, "input.txt"), "A captured external input");
  new Evidence(store).file(project, "garden-data", workspace, "input.txt", "text/plain", 0);
  commit("capture input", { "input.txt": "A captured external input" });
  const adapter = store.write({ id: `adapter:${project}:rl3`, kind: "dispatch-adapter", expected: 0, value: { projectId: project, protocol: "codex-stdio" } });
  const g = { f, store, workspace, desired, built, adapter, commit, respond: null as unknown as typeof respond, drive: null as unknown as typeof drive,
    cycle: null as unknown as typeof cycle, request: { project, dispatch: { adapter: reference(adapter), config: reference(environment) } } as RunRequest };
  ok(startRun(store, { project }));
  // The pass works L3 through one paid answer to its completion, as in H1.2.
  const steps: Json[] = [];
  const respond = (step: RunStep, work: Node, removes: string[]) => {
    const packet = store.get<QuestionPacketRecord>((step.request as unknown as { packet: Ref }).packet.id)!;
    const payload = packet.value.packet as unknown as { expansion: { assigned: string[]; obligations: { id: string; kind: string; upper: { port?: string } }[] } };
    const body = { nodes: [work], tests: structuredClone(desired.tests.filter(proof => work.tests.includes(proof.id))),
      fills: payload.expansion.obligations.filter(item => payload.expansion.assigned.includes(item.id)).map(item => ({ obligation: item.id, node: work.id,
        ...(item.kind === "connection-end" ? { port: item.upper.port!, codeRef: work.code[0]! } : {}) })),
      localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
      removes, replaces: [], redefines: [] };
    steps.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", proposal: body, bindings: [] }, usage } as unknown as Json);
    writeFileSync(scenario, JSON.stringify({ database: f.database, steps }));
  };
  const drive = async (stop: (state: RunRecord["state"]) => boolean, bound = 40): Promise<string[]> => {
    const performed: string[] = [];
    for (let index = 0; index < bound; index++) {
      const advanced = ok(await advanceRun(store, g.request));
      if (advanced.performed) performed.push(advanced.performed.action);
      const state = advanced.record.value.state;
      if (stop(state as RunRecord["state"])) return performed;
      if (state.phase === "waiting" || state.phase === "unable" || state.phase === "complete")
        assert.fail(`The pass stood (${state.phase}) after ${performed.join(",")}: ${JSON.stringify(state).slice(0, 800)}`);
    }
    return assert.fail(`The pass did not reach its next stop: ${performed.join(",")}`);
  };
  const cycle = (state: RunRecord["state"]) => state.phase === "step" && state.step.action === "cycle";
  g.respond = respond; g.drive = drive; g.cycle = cycle;
  return g;
}
/**
 * RL3 (№4217, №4218): the policies the owner's reopening asked. The garden graph's door needs no durable policy, so the record
 * the regate wrote is given the one a durable producer of the reopened work's contract would need — in the form a G5 of the
 * impact era names it (policyGate) — and the readiness step, the owner's wait and its three exits are read on a real pass.
 */
async function regatePolicy(t: test.TestContext, exit: "owner" | "release" | "foreign") {
  const g = await gardenPass(t), { store, desired, commit, respond, drive, cycle } = g;
  const stepOf = () => (ok(readRun(store, { project }))!.value.state as { step: RunStep }).step;
  await drive(cycle);
  respond(stepOf(), structuredClone(desired.nodes.find(node => node.id === "garden-consume-work")!), []);
  await drive(state => state.phase === "complete");
  commit("a test reaches the consumed result", { "consume.txt": "consumed\n", "regate.test.mjs": "import \"./consume.txt\";\n" });
  const regated = ok(regateRun(store, { project })).reopen!;
  const graph = store.get<Graph>(`graph:${project}`)!.value, work = graph.nodes.find(node => node.id === "garden-consume-work")!;
  const contract = graph.artifacts.find(artifact => artifact.id === work.outcome)?.contract ?? work.outcome;
  const governs = { id: contract, hash: hashJson((graph.contracts.find(item => item.id === contract)?.schema ?? null) as Json) };
  const findings = [...regated.value.findings, { code: "work_policy_open", target: work.id, field: `appearance:garden-consume-block:${contract}`, message: "An undecided policy" }]
    .sort((a, b) => canonical(a as unknown as Json) < canonical(b as unknown as Json) ? -1 : 1);
  const reopen = store.write({ id: regated.id, kind: regated.kind, expected: regated.revision, value: { ...regated.value, findings,
    impact: { ...regated.value.impact, policies: [{ work: work.id, policy: "appearance", producer: "garden-consume-block", contract: governs, question: null }] } } as unknown as Json });
  // A pass that does not wait on the reopening's policies is not released, and nothing is written.
  const early = store.list().map(reference), unwaited = refusal(releaseRegateWait(store, { project }));
  assert.deepEqual([unwaited.code, unwaited.at.field], ["record_missing", "state.wait"]);
  assert.deepEqual(store.list().map(reference), early);
  // The readiness step asks the policy in B1 from the record before any work; the bases route it; the pass waits for the owner.
  assert.deepEqual(await drive(state => state.phase === "waiting"), ["readiness", "bases"]);
  const input = store.get<OmInputRecord>(`om-input:${project}`)!;
  const question = input.value.input.questions.find(row => row.readiness?.cause === "policy")!;
  assert.deepEqual([question.consumer, question.kind, question.source, question.readiness], ["garden-consume-block", "owner-decision", reference(reopen),
    { contract: "om-readiness/v1", cause: "policy", policy: "appearance", producer: "garden-consume-block", governs: { contract, hash: governs.hash }, works: [work.id] }]);
  const waiting = (ok(readRun(store, { project }))!.value.state as { wait: RunWait }).wait;
  assert.deepEqual([waiting.code, waiting.target, waiting.field, waiting.basis], ["regate_owner_policy", reopen.id, "policy", [reference(reopen), reference(input)]]);
  assert.match(waiting.message, new RegExp(question.id));
  // Exit 3: a repeat without the owner's answer or release writes nothing and spends nothing.
  const quiet = store.list().map(reference);
  assert.equal(ok(await advanceRun(store, g.request)).performed, null);
  assert.deepEqual(store.list().map(reference), quiet);
  if (exit === "foreign") {
    // Another policy, asked from a saved G5 of the impact era (as policyGate), stands open beside the reopening's: the wait is
    // the reopening's alone — the owner answers that one, and the pass goes on to its works with the other still open (OWN1).
    const head = store.get<OmInputRecord>(`om-input:${project}`)!;
    const candidate = store.write({ id: `om-candidate:${project}:rl3-foreign`, kind: "frame-candidate", expected: 0, value: { level: 3, graph: structuredClone(graph) } as unknown as Json });
    const gate = store.write({ id: `om-atomic-gate:${project}:rl3-foreign`, kind: "om-atomic-gate", expected: 0, value: { contract: "om-atomic-gate/v2", project,
      request: { project, candidate: reference(candidate), gaps: { sources: { project, input: reference(head), graph: reference(store.get(`graph:${project}`)!) }, records: [] } },
      result: { gate: "G5", passed: false, codes: ["work_policy_open"], findings: [{ code: "work_policy_open", target: work.id, field: "appearance:garden-produce-block:other-contract", message: "An undecided policy" }] },
      impact: { snapshot: null, works: [], policies: [{ work: work.id, policy: "appearance", producer: "garden-produce-block", contract: { id: "other-contract", hash: "other-contract-hash" }, question: null }] } } as unknown as Json });
    ok(writeReadinessInput(store, { project, input: reference(head), gate: reference(gate) }));
    assert.deepEqual(await drive(state => state.phase === "waiting"), ["bases"], "The new B1 gets its bases; the reopening's policy still waits");
  }
  const built = ok(prepareRunBases(store, { project }));
  assert.equal(built.state, "ready");
  const routes = store.get<RoutesRecord>((built as { built: { bases: RunBases } }).built.bases.routes.id)!;
  const routed = routes.value.routes.find(row => row.target === question.id)! as unknown as { record: Ref; route: string };
  assert.equal(routed.route, "design", "In the bypass the model would decide it");
  const line = gapLineKey(project, question.id, "answer");
  if (exit === "foreign") {
    const sessions = new OwnerSessions(store), { invitation } = ok(issueOwnerInvitation(store, { project }));
    const authority = sessions.authority(ok(sessions.exchange({ project, invitation })).bearer)!;
    ok(writeOwnerResult(store, authority, { project, routes: reference(routes), gap: routed.record, value: "The owner's rule for the reopened state",
      basis: "The owner's rule for this state" }, { routes: readRoutes, input: readOmInput }));
    const performed = await drive(state => state.phase === "step" && state.step.action === "open");
    assert.deepEqual(performed, ["apply", "bases"], "No wait on a policy the reopening did not ask");
    const open = store.get<OmInputRecord>(`om-input:${project}`)!.value.input.questions.filter(row => row.readiness?.cause === "policy");
    assert.deepEqual(open.map(row => [row.source.id, row.readiness!.cause === "policy" && row.readiness!.governs.contract]), [[`om-atomic-gate:${project}:rl3-foreign`, "other-contract"]]);
  } else if (exit === "owner") {
    // Exit 1: the owner's H2 answer is applied first; the model is never asked; every works brief and the gate get it decided.
    const sessions = new OwnerSessions(store), { invitation } = ok(issueOwnerInvitation(store, { project }));
    const authority = sessions.authority(ok(sessions.exchange({ project, invitation })).bearer)!;
    const value = "The consuming block creates the state on its first run; a missing state later is a loss";
    const owner = ok(writeOwnerResult(store, authority, { project, routes: reference(routes), gap: routed.record, value, basis: "The owner's rule for this state" },
      { routes: readRoutes, input: readOmInput }));
    const performed = await drive(cycle);
    assert.equal(performed[0], "apply", performed.join(","));
    const decided = store.get<OmInputRecord>(`om-input:${project}`)!.value.input;
    assert.deepEqual(decided.decided?.filter(row => row.question.id === question.id).map(row => row.value), [{ owner: reference(owner.result), value }]);
    assert.ok(!decided.questions.some(row => row.id === question.id));
    assert.ok(!blockSeries(g.f as unknown as Fixture).value.attempts.at(-1)!.goal.questions.includes(line), "No attempt asks the model the owner's policy");
    const packet = stepOf().request as unknown as { packet: Ref };
    assert.ok(JSON.stringify(store.get(packet.packet.id, packet.packet.revision)!.value).includes(value), "The works brief carries the decision");
    // The decision closes the policy of the contract for every work of it: two durable works of the contract refer to it.
    const durable = structuredClone(graph), second = { ...structuredClone(work), id: "garden-consume-work-2" };
    durable.nodes.push(second);
    durable.horizon = [...durable.horizon, second.id];
    for (const node of durable.nodes.filter(row => [work.id, second.id].includes(row.id))) node.boundary = { ...node.boundary, state: "durable", writer: "garden-consume-block" };
    assert.deepEqual(gatePolicies(durable, input.value.input).findings.map(row => [row.code, row.target]),
      [["work_policy_open", work.id], ["work_policy_open", second.id]]);
    const closed = gatePolicies(durable, decided);
    assert.deepEqual([closed.findings, closed.rows.map(row => [row.work, row.question])], [[], [[work.id, question.id], [second.id, question.id]]]);
  } else {
    // Exit 2: the owner's explicit release — one record naming the reopening; a repeat is that record; the pass goes on by OWN1.
    const released = ok(releaseRegateWait(store, { project }));
    assert.deepEqual([released.value.reopen, released.value.run, released.value.decision],
      [reference(reopen), reference(ok(readRun(store, { project }))!), { actor: "owner", command: "om-continue", release: "regate_owner_policy" }]);
    assert.deepEqual(reference(ok(releaseRegateWait(store, { project }))), reference(released));
    const performed = await drive(cycle);
    assert.equal(performed[0], "open", performed.join(","));
    assert.ok(blockSeries(g.f as unknown as Fixture).value.attempts.at(-1)!.goal.questions.includes(line), "The released policy goes to the model with the works");
    assert.ok(!(store.get<OmInputRecord>(`om-input:${project}`)!.value.input.decided ?? []).some(row => row.question.id === question.id));
  }
}

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

/**
 * The real L3 chain of several blocks (the proven path of the F5 atomic seed, om-atomic-gate): a native N2 acceptance of
 * the 'cross' graph, the owner's works horizon over that layer, D1 with the works frame, M6 and M3. The pass then pays one
 * MC2 works cycle per block and does everything else.
 */
function worksFixture(t: test.TestContext, late = false, fact: boolean | number = false, shape?: (graph: Graph) => void, historicalCommit?: string) {
  const facts = fact === true ? ["works-fact"] : Array.from({ length: Number(fact) }, (_, index) => index ? `works-fact-${index + 1}` : "works-fact");
  const root = mkdtempSync(join(tmpdir(), "omg-h1-works-")), database = join(root, "state.sqlite");
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const desired = gardenGraph("cross");
  shape?.(desired);
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  // A late question of the environment (checked when a task starts): D1 keeps it as a late gap and D7 needs its assignment.
  // FA1: a repository fact of the consuming block, asked by MC1 and assessed by E5 in the same attempt as its works.
  preparedFeatures(engine, project, l1 as Graph, late || fact ? field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = [
      ...(late ? [{ id: "later-env", question: "Which runtime does the task start on?",
        consumer: "garden-consume-block", moment: "task-start", blocksCurrentStage: false, resolution: "Confirm it when the task starts" }] : []),
      ...facts.map(id => ({ id, question: `Which ${id === "works-fact" ? "encoding" : id} is supported?`,
        consumer: "garden-consume-block", moment: "om-pass", blocksCurrentStage: false, resolution: "Address this question during OM" }))];
    return value;
  } : undefined, historicalCommit);
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
  for (const id of facts) decisions.push({ pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph: first, layers: [],
    decision: { target: `discovery:${id}`, field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } } })) as Write });
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
    /** One more scripted reply of the model, after those already sent. */
    push(step: Record<string, unknown>) { steps.push(step); writeFileSync(scenario, JSON.stringify({ database, steps })); },
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

/**
 * G6 (№3857 п.5): works are accepted only when their G5 gate passed and layer 3 is written — a performed works step proves
 * neither (FA1 claimed it; №3855 п.5). The gates of the pass, their findings, and the accepted layer.
 */
function worksAcceptance(store: Store) {
  const gates = store.list<{ result: { passed: boolean; findings: { code: string; target: string }[] } }>("om-atomic-gate");
  return { passed: gates.some(row => row.value.result.passed), frame: !!store.get(`om-frame:${project}:3`),
    findings: gates.flatMap(row => row.value.result.findings.map(item => `${item.code} ${item.target}`)) };
}


// FA1 (№3816, №3817): the consuming block's attempt asks its fact (MC1), E5 assesses it, and its works are answered. A
// technical E5 terminal of its own fact (off-form, interrupted) fails the complete check for good — E5 assesses a fact
// once — so the attempt closes through the common G7 with the reason the close derives, and the next attempt asks the
// fact again (OMG-LIVE 0537: n-state 10 stood on frame_gate forever). A lawful negative verdict is no technical failure.
async function factWorksPass(t: test.TestContext, verdicts: Verdict[], facts = 1) {
  const f = worksFixture(t, false, facts);
  ok(startRun(f.store, { project }));
  const performed: string[] = [], answered = new Set<string>(), assessed: string[] = [];
  let state: { phase: string; step?: { action: string; request: { packet: Ref } }; wait?: unknown } = { phase: "" };
  for (let index = 0; index < 300 && !performed.includes("works"); index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    if (advanced.performed) performed.push(advanced.performed.action);
    state = advanced.record.value.state as unknown as typeof state;
    const key = state.phase === "step" ? JSON.stringify(state.step!.request) : "";
    if (state.phase === "step" && state.step!.action === "cycle" && !answered.has(key)) {
      answered.add(key);
      const saved = state.step!.request.packet, packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
      const routed = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
      const batch = routed.batches.find(row => row.id === packet.value.request.batch)!;
      if (batch.model !== "MC1") f.answer(saved);
      else {
        const source = f.store.get<{ content: string }>(`source:${project}:brief`)!;
        f.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
          results: batch.items.map(item => ({ questionId: item.gap, value: { answer: "UTF-8" }, citations: [{ source: reference(source),
            selector: { kind: "text-range", start: 0, end: source.value.content.length } }] })) }, usage });
      }
    }
    if (state.phase === "step" && state.step!.action === "assess" && !answered.has(key)) {
      answered.add(key); const verdict = verdicts[Math.min(assessed.length, verdicts.length - 1)]!;
      assessed.push(verdict); f.push(assessor(verdict));
    }
    if (state.phase === "waiting" || state.phase === "complete" || state.phase === "unable") break;
  }
  return { f, performed, state, assessed, consume: blockSeries(f as unknown as Fixture) };
}

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

/** The MC2 answer that addresses nothing for the exact saved packet: the node root ends by its proved terminal. */
function nodeRefusal(f: { store: Store }, step: { request: unknown }) {
  const saved = (step.request as { packet: Ref }).packet;
  const packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
  const questions = (packet.value.packet as unknown as { questions: { id: string }[] }).questions.map(row => row.id);
  return { research: { protocol: "$answerProtocol", requestId: "$requestId", questionIds: questions, action: "cannot_answer",
    reason: "The requested information is unavailable" }, usage };
}

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
// OWN1.1 (№3722): every owner answer holds — those given together are applied together, and one given on earlier bases
// still applies while its very question is open.
async function ownerAnswers(f: Fixture, ids: readonly string[]) {
  const bases = f.bases(), routes = f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)!;
  const sessions = new OwnerSessions(f.store), { invitation } = ok(issueOwnerInvitation(f.store, { project }));
  const authority = sessions.authority(ok(sessions.exchange({ project, invitation })).bearer)!;
  return ids.map(id => {
    const routed = routes.value.routes.find(row => row.target === `discovery:${id}`)! as unknown as { record: Ref };
    return ok(writeOwnerResult(f.store, authority, { project, routes: reference(routes), gap: routed.record,
      value: `Explicit owner choice for ${id}`, basis: "Explicit choice for this question" }, { routes: readRoutes, input: readOmInput }));
  });
}
async function twoOwnerAnswers(t: test.TestContext, moved: boolean, mode: boolean | RunFixtureMode = true) {
  const f = runFixture(t, ["encoding", "spare"], mode);
  addressQuestions(f, [["encoding", "owner-decision"], ["spare", "owner-decision"]]);
  const request = f.request(), [encoding, spare] = await ownerAnswers(f, ["encoding", "spare"]);
  if (moved) {
    // The first answer is applied by itself: B1, D1 and M6 move, and the second answer was given on the earlier bases.
    const input = f.store.get<OmInputRecord>(`om-input:${project}`)!;
    ok(writeOwnerDecision(f.store, { project, input: reference(input), graph: f.graph,
      owners: [{ target: "discovery:encoding", owner: reference(encoding!.result), value: "Explicit owner choice for encoding" }] }));
  }
  ok(startRun(f.store, { project }));
  const state = await restWithDecisions(f, request);
  assert.equal(decisionCalls(f), 0, `The model is never asked a question the owner answered: ${JSON.stringify(state)}`);
  const input = f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input;
  assert.deepEqual(input.decided?.map(row => [row.question.id, row.value]), [
    ["discovery:encoding", { owner: reference(encoding!.result), value: "Explicit owner choice for encoding" }],
    ["discovery:spare", { owner: reference(spare!.result), value: "Explicit owner choice for spare" }]]);
}




const advanceRun = currentAdvanceRun;
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
  assert.equal(packets.length, 2, "One root packet and its blocked continuation: " + JSON.stringify(f.store.list<QuestionPacketRecord>("question-packet").map(row => ({ state: row.value.state, correction: !!row.value.request.correction, continuation: !!row.value.request.continuation, refusal: row.value.refusal }))));
  return packets[0] === "root" ? "root-first" : "continuation-first";
}
/** Distinct real leaves of one already-addressed context, without adding historical or forged records. */
function lp3Pointers(value: Json): string[] {
  const visit = (item: Json, pointer: string): string[] => item !== null && typeof item === "object"
    ? Object.entries(item).flatMap(([key, child]) => visit(child as Json, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`))
    : [pointer];
  return visit(value, "");
}
/** Check the exact continuation and real E3 calls; a null blocked payload has no request id. */
function lp3Blocked(f: { store: Store; sent(): unknown[] }, sends: number, code: string, reads: number, capacity: number) {
  const cycles = f.store.list<ModelCycleRecord>("om-model-cycle");
  assert.ok(cycles.length > 0);
  const calls = f.store.list<{ om?: unknown }>("model-call").filter(row => row.value.om).map(row => ok(readModelCall(f.store, { project, record: reference(row) })));
  for (const cycle of cycles) {
    assert.equal(cycle.value.terminal, "blocked");
    assert.ok(cycle.value.next);
    const blocked = f.store.get<QuestionPacketRecord>(cycle.value.next.id, cycle.value.next.revision)!;
    assert.deepEqual(reference(blocked), cycle.value.next);
    assert.equal(blocked.value.state, "blocked");
    assert.equal(blocked.value.refusal?.code, code);
    const origin = blocked.value.request.continuation!;
    assert.deepEqual(origin.packet, cycle.value.request.packet);
    assert.equal(origin.deliveries.length, reads, "Every distinct lawful read was delivered");
    const call = ok(readModelCall(f.store, { project, record: cycle.value.steps[0]!.record }));
    assert.equal(call.outcome?.kind, "need-source", "E3 admitted the reads, without label correction");
    assert.equal(cycle.value.steps.length, 1);
    assert.ok(calls.every(row => canonical(row.record.value.om.request.packet) !== canonical(cycle.value.next)),
      "No call refers to this exact blocked continuation");
    const root = f.store.get<QuestionPacketRecord>(origin.packet.id, origin.packet.revision)!;
    assert.equal(root.value.state, "ready");
    const requestId = (root.value.packet as { requestId: string }).requestId;
    assert.equal(f.sent().filter(line => JSON.parse(line as string).requestId === requestId).length, 1);
  }
  assert.equal(f.sent().length, sends);
  for (const line of f.sent()) assert.ok((line as string).length <= capacity,
    "The full adapter wire, including its actual model/effort/speed, fits the fixed budget (roots and A6)");
}
const LP3_UNPROVED: Record<string, string> = {};
/** A view of the store in which one exact record cannot be read; everything else, writes included, goes to the store. */
function lp3Hiding(store: Store, ref: Ref, intercepted: () => void): Store {
  return new Proxy(store, { get(target, key) {
    if (key === "get") return (at: string, revision?: number) => {
      if (at === ref.id && revision === ref.revision) { intercepted(); return null; }
      return target.get(at, revision);
    };
    const member: unknown = Reflect.get(target, key, target);
    return typeof member === "function" ? member.bind(target) : member;
  } });
}

/** The context record a search names as its scope: the B1 the mechanism packet supplies (a record of the project, no source). */
const lp3Context = (f: Fixture): Ref => reference(f.store.get(`om-input:${project}`)!);
const isRefOf = (request: unknown, packet: Ref): boolean => canonical((request as { packet?: Ref }).packet ?? null) === canonical(packet);

// LP3 (№2876, Q2b №2518-2): the start of a root's cycle keeps the narrow codes of H1 — its own and E2's reader's, marked
// with their source. The negative probe is real TypeScript: its `@ts-expect-error` line fails to compile for the stated
// reason only, so an unused directive breaks the build (tsc over test/**).
const asCycleStart = (result: ReturnType<typeof cycleStartOf>): ReturnType<typeof cycleStartOf> => result;
const asRunResult = <T>(result: RunResult<T>): RunResult<T> => result;


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

/** The works answer of worksFixture for an exact saved packet, as research data: the desired work of its operation. */
function mp2WorkAnswer(f: Pick<ReturnType<typeof worksFixture>, "store" | "desired">, saved: Ref) {
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

// G6.2 (№3883, №3884): the producing operation also produces a second artifact through its other output (like o-state on
// the live pass). The example answer of its new works packet gives each artifact a work of its own, so the example passes
// the packet's own acceptance (E3, one artifact per work); every new works packet of the pass is checked the same way.
function twoArtifacts(graph: Graph) {
  graph.artifacts.push({ ...structuredClone(graph.artifacts.find(row => row.id === "garden-data")!), id: "garden-alt", terminal: false });
  const flow = graph.connectors.find(row => row.id === "garden-flow")!;
  const moved = flow.bindings.filter(binding => binding.producer.port === "out-alt");
  flow.bindings = flow.bindings.filter(binding => binding.producer.port !== "out-alt");
  graph.connectors.push({ ...structuredClone(flow), id: "garden-alt-flow", artifact: "garden-alt", wakeTest: null, bindings: moved });
  for (const test of graph.tests.filter(row => row.covers.includes("garden-flow") && row.node.startsWith("garden-produce"))) {
    test.covers.push("garden-alt-flow");
    const pair = test.contract?.counterfactuals.find(row => row.connector === "garden-flow");
    if (pair) test.contract!.counterfactuals.push({ ...structuredClone(pair), connector: "garden-alt-flow" });
  }
}

// G6.1 return №3913 (Codex's probe): three works of the producing operation, one per artifact, all write one file, and the
// model gave the transfer of the first two. That transfer is a link of the one chain: no option it is offered breaks it,
// an answer that does is refused, and the next intent's lawful choice keeps the link and the group is accepted.
function threeArtifacts(graph: Graph) {
  twoArtifacts(graph);
  graph.artifacts.push({ ...structuredClone(graph.artifacts.find(row => row.id === "garden-alt")!), id: "garden-third" });
  const third = structuredClone(graph.connectors.find(row => row.id === "garden-alt-flow")!);
  third.id = "garden-third-flow"; third.artifact = "garden-third";
  for (const binding of third.bindings) {
    const producer = graph.nodes.find(node => node.id === binding.producer.node)!;
    producer.ports.push({ ...structuredClone(producer.ports.find(port => port.id === binding.producer.port)!), id: "out-third" });
    binding.producer.port = "out-third";
    for (const consumer of binding.consumers) {
      const node = graph.nodes.find(item => item.id === consumer.node)!;
      node.ports.push({ ...structuredClone(node.ports.find(port => port.id === consumer.port)!), id: "in-third" });
      consumer.port = "in-third";
    }
  }
  graph.connectors.push(third);
  for (const test of graph.tests.filter(row => row.covers.includes("garden-alt-flow"))) {
    test.covers.push(third.id);
    const pair = test.contract?.counterfactuals.find(row => row.connector === "garden-alt-flow");
    if (pair) test.contract!.counterfactuals.push({ ...structuredClone(pair), connector: third.id });
  }
  for (const kind of ["block", "operation", "work"]) graph.joins.push({ id: `three-input-${kind}`, consumer: `garden-consume-${kind}`,
    connectors: ["garden-flow", "garden-alt-flow", "garden-third-flow"],
    ...(kind === "work" ? { required: ["garden-flow", "garden-alt-flow", "garden-third-flow"], optional: [], condition: "all required" } : {}),
    failures: { missing: "missing", extra: "extra", foreign: "foreign", stale: "stale", duplicate: "duplicate", returnsTo: "garden-consume-block" } } as unknown as Graph["joins"][number]);
}

// G6.2: current E3 accepts the work's shape; G5 refuses its missing write scope. Only that proposal is
// rejected; G7 closes it on its own rows, preserves the sound member and never reuses the rejected assembly.
const G62_BASE = "a62940ecc6ee43d2b44ef315abf1067b060d4db0";
async function g62Rejection(t: test.TestContext, chain: boolean, prior = false) {
  const f = worksFixture(t, false, false, undefined, ""), scenario = join(f.root, "scenario.json"), steps: unknown[] = [], trail: string[] = [];
  const push = (research: unknown) => { steps.push({ research, usage }); writeFileSync(scenario, JSON.stringify({ database: f.database, steps })); };
  const paid = new Map<string, number>(), count = (node: string) => paid.set(node, (paid.get(node) ?? 0) + 1);
  const consumeAddress = { project, block: "garden-consume-block", line: 1 };
  if (prior) {
    ok(openSeries(f.store, { ...consumeAddress, slice: "g62-prior", predecessor: null, basis: null } as Parameters<typeof openSeries>[1]));
    const goal = { key: "g62-prior", questions: ["Address one contract"], result: "A supported contract" };
    for (let attempt = 1; attempt <= 2; attempt++) {
      ok(beginAttempt(f.store, { ...consumeAddress, attempt, goal } as Parameters<typeof beginAttempt>[1]));
      ok(closeAttempt(f.store, { ...consumeAddress, attempt, outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } } as Parameters<typeof closeAttempt>[1]));
    }
  }
  ok(startRun(f.store, { project }));
  for (let round = 0; round < 4; round++) {
    let issued: Ref | null = null;
    for (let index = 0; index < 40; index++) {
      const state = ok(await advanceRun(f.store, f.request)).record.value.state;
      if (state.phase === "step" && state.step.action === "cycle") { issued = (state.step.request as unknown as { packet: Ref }).packet; break; }
      if (state.phase === "waiting") break;
    }
    assert.ok(issued, "The current producer issues the works packet");
    const answer = mp2WorkAnswer(f, issued), node = answer.research.proposal.nodes[0]!.parent!;
    if (node === "garden-produce-operation") {
      // One artifact is already checked by E3; G5 still checks that the work has an exact write scope.
      for (const code of answer.research.proposal.nodes[0]!.code) code.access = "read";
      for (const fill of answer.research.proposal.fills) if (fill.codeRef) fill.codeRef.access = "read";
    }
    count(node); push(answer.research);
    const cycled = ok(await advanceRun(f.store, f.request));
    assert.equal(cycled.performed?.action, "cycle");
    assert.ok(f.store.list("layer-proposal").some(row => row.id.startsWith("om-proposal:") && row.id !== "om-proposal:garden:h1-upper"),
      "The current E3 accepted a real proposal before G5 checks its contents");
    if (node === "garden-produce-operation") break;
  }
  f.restart();
  // The chain: G1 replaces the B1 under the group before its acceptance, LP5 ends it and every root is answered again by
  // a reuse of its paid assembly — the defective one included, so G5 rejects the reuse's origin.
  if (chain) lp5ReplaceB1(f);
  const answered = new Set<string>();
  let probed: string[] = [];
  for (let index = 0; index < 300 && !worksAcceptance(f.store).frame; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    const state = advanced.record.value.state as unknown as { phase: string; wait?: { code: string }; step?: { action: string; request: { packet?: Ref } } };
    trail.push(state.phase === "waiting" ? `waiting:${state.wait!.code}` : `${state.phase}:${advanced.performed?.action ?? ""}`);
    if (state.phase === "waiting" || state.phase === "unable") break;
    // The one producer of the new end admits it only for the group on the rejection's own D1: the consuming block's next
    // attempt, on the next D1, is never ended by the old group's rejection.
    const consume = blockSeries(f as unknown as Fixture, "garden-consume-block")?.value;
    const later = prior ? 3 : 1;
    if (!probed.length && consume?.attempts[later] && consume.attempts[later]!.outcome === null) {
      const next = ok(readCompletionBinding(f.store, project, reference(f.store.get(`repair-series:${project}:1:garden-consume-block`)!), later + 1))!;
      const denied = refusal(prepareCompletionFinalization(f.store, { project, binding: reference(next), phase: "acceptance",
        rejection: reference(f.store.list("om-work-rejection")[0]!) }) as never);
      probed = [denied.code, denied.at.field ?? ""];
    }
    if (state.phase !== "step" || state.step!.action !== "cycle" || !state.step!.request.packet || answered.has(state.step!.request.packet.id)) continue;
    const saved = state.step!.request.packet, packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
    answered.add(saved.id);
    const answer = mp2WorkAnswer(f, saved), node = answer.research.proposal.nodes[0]!.parent!;
    count(node);
    if (node === "garden-produce-operation") {
      const example = (packet.value.packet as unknown as { brief: { examples: { action: string; proposal: unknown }[] } }).brief.examples.find(row => row.action === "answer")!;
      push({ ...answer.research, proposal: example.proposal });
    } else push(answer.research);
  }
  const text = trail.join(",");
  assert.ok(!text.includes("input_stale"), `Never input_stale: ${text}`);
  const rejections = f.store.list<{ proposals: Ref[] }>("om-work-rejection");
  assert.equal(rejections.length, 1, text);
  assert.equal(rejections[0]!.value.proposals.length, 1, "Only the proposal defining the defective work is rejected");
  const rejected = f.store.get<LayerProposal>(rejections[0]!.value.proposals[0]!.id)!;
  assert.ok(rejected.value.status === "rejected" && rejected.value.nodes.some(node => node.parent === "garden-produce-operation"), "The producing work's proposal");
  assert.equal(f.store.list("om-origin-hold").length, 0, "No hold, no origin analysis");
  const journal = f.store.get<{ rows: { id: string; gate: string; code: string }[]; classifications: { row: string; class: string; addressee: string }[] }>(`om-refusal-journal:${project}`)!.value;
  assert.ok(journal.rows.some(row => row.gate === "G5" && row.code === "work_write_scope_unbounded"), "The content finding comes from G5");
  const g5 = new Set(journal.rows.filter(row => row.gate === "G5").map(row => row.id));
  const placed = journal.classifications.filter(row => g5.has(row.row));
  assert.ok(placed.length > 0 && placed.every(row => row.class === "proposal"), `The rows are placed as the proposal's: ${JSON.stringify(placed)}`);
  const guilty = chain ? 1 : 0;
  assert.equal(blockSeries(f as unknown as Fixture, "garden-produce-block").value.attempts[guilty]!.outcome?.reason, "refused", text);
  assert.ok((paid.get("garden-produce-operation") ?? 0) >= 2, `The producing root is answered anew: ${text.slice(-900)}`);
  for (const [node, times] of paid) if (node !== "garden-produce-operation") assert.equal(times, 1, `${node} is paid once`);
  // The whole group ended by the rejection: the sound member by its finalization (interrupted), the defective one on its
  // rows; their next attempts reuse every sound assembly, and the new candidate is accepted.
  const ends = f.store.list<{ cause: { kind: string } }>("om-completion-finalization").map(row => row.value.cause.kind);
  assert.ok(ends.length >= 2 && ends.every(kind => kind === "group-rejected"), `Every member ends by the group's rejection: ${JSON.stringify(ends)}`);
  // The consuming block's first attempt of the pass is a sound member of the rejected group: it ends by the rejection,
  // neutrally — its progress names the rejection, the line is not stopped and no A6 is planned.
  const member = blockSeries(f as unknown as Fixture, "garden-consume-block").value.attempts[prior ? 2 : 0]!;
  assert.equal(member.outcome?.reason, "interrupted");
  assert.equal((member.outcome as unknown as { progress?: { administrative: { kind: string } | null } }).progress?.administrative?.kind, "group-rejected",
    JSON.stringify(member.outcome));
  assert.ok(!text.includes("analyze"), `No A6 is planned: ${text.slice(-500)}`);
  const acceptance = worksAcceptance(f.store);
  assert.deepEqual([acceptance.passed, acceptance.frame], [true, true], `The new candidate is accepted: ${text.slice(-600)}`);
  assert.deepEqual(probed, ["completion_cause_unproved", "group"], "An attempt of the next D1 is never ended by the old group's rejection");
  const reuses = f.store.list<CompletionReuse>(COMPLETION_REUSE_KIND);
  if (chain) assert.ok(reuses.some(row => row.value.origin.proposal.id === rejected.id), "The rejected assembly had come by a reuse");
  const after = reuses.filter(row => f.store.get<{ status: string }>(row.value.origin.proposal.id)!.value.status === "rejected"
    && f.store.get<{ attempt: number }>(row.value.binding.id, row.value.binding.revision)!.value.attempt > (chain ? 2 : 1));
  assert.deepEqual(after.map(row => row.id), [], "No attempt after the rejection reuses the rejected assembly");
}
/** A lawful new B1 by G1 (the writeOmInput writer): the repository inventory D1 asked for is recorded (or its paths change) and the input refreshed. */
function lp5ReplaceB1(f: WorksRun, paths: string[] = []): Ref {
  const before = f.store.get(`om-input:${project}`)!, id = `repo-inventory:${project}`, old = f.store.get<{ paths: string[] }>(id);
  const inventory = old && JSON.stringify(old.value.paths) === JSON.stringify(paths) ? old
    : f.store.write({ id, kind: "repo-inventory", expected: old?.revision ?? 0, value: { projectId: project, paths } });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  return reference(ok(writeOmInput(f.store, { project, stages, inventory: reference(inventory), expected: before.revision })));
}
const lp5Kind = <T = Json>(f: WorksRun, kind: string): Revision<T>[] => f.store.list<T>(kind);
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

type Lp5State = { phase: string; wait?: { code: string }; step?: { action: string; request: Record<string, unknown> & { packet?: Ref }; series?: string | null; attempt: number | null } };
/** The produce root answered by the base before G5: every test of its work that covers a connection has a twin, no choice. */
function g51AmbiguousAnswer(f: WorksRun, saved: Ref) {
  const answer = mp2WorkAnswer(f, saved), proposal = answer.research.proposal;
  const twins = proposal.tests.filter(test => test.covers.length).map(test => ({ ...structuredClone(test), id: `${test.id}-twin` }));
  proposal.tests.push(...twins); proposal.nodes[0]!.tests.push(...twins.map(test => test.id));
  return answer;
}
const LP6_BASE = "e7db0ba81cf6f049420b5ea3c054108bf99c2cdb";
const LP5_BASE_COMMIT = "febbee2cf8187e1c230eec325e183fc8203e06ae";

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
function lp6Line(t: test.TestContext, historicalCommit = LP6_BASE) {
  const root = mkdtempSync(join(tmpdir(), "omg-lp6-era-")), database = join(root, "state.sqlite");
  let store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), { level: _level, ...l1 } = projectGraph(gardenGraph("cross"), 1);
  preparedFeatures(engine, project, l1 as Graph, field => preparedField(project, field), historicalCommit);
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

/** Current joined routes; mixed failures are produced in a distinct expansion batch beside the field answer. */
async function lp6CurrentRounds(f: ReturnType<typeof lp6Line>, ops: Lp6Op[]) {
  const steps: unknown[] = [], verdicts: (string | null)[] = [], calls: Sealed<ModelCallOutcome>[] = [];
  for (const item of ops) {
    if (item.op === "round") {
      const routes = lp7Routes(f);
      const batches = item.answers.map(answer => routes.value.batches.find(batch => answer.field === "expansion"
        ? batch.task === "node-expansion" && batch.items.every(row => row.consumers.includes(f.block))
        : batch.task === "input-field" && batch.items.some(row => row.field === answer.field && row.consumers.includes(f.block)))!);
      assert.equal(new Set(batches.map(batch => batch.id)).size, batches.length, "One reply for each current batch");
      const items = batches.flatMap(batch => batch.items);
      const goal = { key: `lp6-current:${item.ordinal}`, questions: items.map(row => gapLineKey(project, row.target, row.field)).sort(),
        result: gapLineExpectedResult(project, items[0]!.target, items[0]!.field) };
      const series = ok(openAttempt(f.store, { ...f.address, attempt: item.ordinal, goal,
        completion: { routes: reference(routes), batches: batches.map(batch => batch.id).sort() } } as never));
      const packets = batches.map(batch => ok(writeQuestionPacket(f.store, { project, routes: reference(routes), batch: batch.id,
        environment: f.dispatch.config, attempt: { series: reference(series), ordinal: item.ordinal }, previous: [] })).record);
      for (const [index, batch] of batches.entries()) {
        const answer = item.answers[index]!;
        if (answer.unsent) continue;
        steps.push(answer.exit !== undefined ? { exitCode: answer.exit } : { research: answer.cannot !== undefined
          ? { protocol: "$answerProtocol", requestId: "$requestId", questionIds: batch.items.map(row => row.gap), action: "cannot_answer", reason: answer.cannot }
          : answer.owner !== undefined ? { protocol: "$answerProtocol", requestId: "$requestId", questionIds: batch.items.map(row => row.gap), action: "need_owner", reason: answer.owner, decision: "Decide it" }
          : { protocol: "$answerProtocol", requestId: "$requestId", action: "answer", results: batch.items.filter(row => row.field === answer.field)
            .map(row => ({ target: row.target, field: row.field, basis: row.record, value: answer.value })) }, usage });
        writeFileSync(join(f.root, "scenario.json"), JSON.stringify({ database: f.database, steps }));
        calls.push(ok(await runModelCall(f.store, { project, packet: reference(packets[index]!), dispatch: f.dispatch, role: "implementer" })));
      }
    } else if (item.op === "cease") {
      const binding = ok(readCompletionBinding(f.store, project, reference(f.head()), item.ordinal))!;
      for (;;) {
        const work = ok(readCompletionWorkAt(f.store, project, reference(f.store.get(completionWorkId(project, binding.id))!)));
        const resolved = new Set(work.resolved.map(ref => ref.id));
        const next = work.assignments.filter(row => !resolved.has(row.id)).sort((a, b) => Number(a.value.kind !== "root") - Number(b.value.kind !== "root"))[0];
        if (!next) break;
        ok(writeCompletionCessation(f.store, { project, binding: reference(binding), assignment: reference(next) }));
      }
    } else if (item.op === "close") {
      const claim = ok(prepareManagedClaim(f.store, { ...f.address, attempt: item.ordinal, outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } } as never));
      verdicts.push(ok(closeAttempt(f.store, { ...f.address, attempt: item.ordinal, outcome: claim.outcome } as never)).verdict);
    } else assert.fail(`Unexpected current-round operation ${item.op}`);
  }
  return { verdicts, calls };
}

type Reopened = { phase: "reopened"; from: Ref; reasons: RunReason[]; ground: { step?: RunStep; wait?: RunWait; complete?: Ref[] } };
const passRows = (store: Store) => store.history(runId(project)).map(row => (row.value as unknown as RunRecord).state.phase);
/** A genuine current failed review ends unable; the review's exact failure record and its paid exchange stay as written. */
async function unavailableReview(t: test.TestContext) {
  const f = runFixture(t, ["encoding"], "executed");
  const b = f.bases("lp81-unavailable"), request = f.request(b), none = cannotAnswer(f, b.routes);
  f.steps([none, none, none, { ...stopAnswer(f, true), confirmed: null }, addressAll(f, b.routes)]);
  ok(startRun(f.store, { project }));
  await driveTo(f, request, "analyze", 40);
  const failure = f.store.list<{ transport: Ref }>("om-stop-analysis-failure")[0]!;
  assert.ok(failure, "The current review producer saved its real wrapper failure");
  const physical = f.store.get<{ transport: { exchange: Ref } }>(failure.value.transport.id, failure.value.transport.revision)!;
  const exchangeRef = physical.value.transport.exchange;
  const exchange = f.store.get(exchangeRef.id, exchangeRef.revision)!;
  assert.equal(exchange.hash, exchangeRef.hash);
  for (let index = 0; index < 8; index++) {
    const state = ok(await advanceRun(f.store, request)).record.value.state;
    if (state.phase === "unable") break;
    assert.notEqual(state.phase, "waiting", JSON.stringify(state));
  }
  const unable = ok(readRun(f.store, { project }))!;
  assert.equal(unable.value.state.phase, "unable", "The producer persisted unable, visible through the ordinary Store");
  assert.deepEqual(reasonsOf(unable.value.state).map(row => [row.kind, row.code]), [["stop-analysis-failed", "analysis_failed"]]);
  const unchanged = () => {
    assert.deepEqual(f.store.get(failure.id, failure.revision), failure);
    assert.deepEqual(f.store.get(exchangeRef.id, exchangeRef.revision), exchange);
    assert.equal(f.store.history(failure.id).length, 1);
    assert.equal(f.store.history(exchangeRef.id).length, 1);
  };
  unchanged(); f.restart();
  return { f, request, failure: reference(failure), unable, unchanged };
}

// AT1 (№4117, contract §1.3): the appearance policy of a durable work's state is decided once at its producer. G5 refuses
// the work at that producer; the group's rejection asks the policy in B1 at the producer, as an owner decision: in the pass
// the model decides it (OWN1, the model's decision, never the owner's), or the owner's H2 answer decides it and the model
// is never asked. Every works brief then carries the decision, and the next works pass G5 referring to it.
async function policyDoor(t: test.TestContext, owner: boolean) {
  const f = worksFixture(t, false, false, graph => {
    // The producing chain keeps a durable state its block writes; each durable node proves a cold read and a cold restart.
    for (const node of graph.nodes.filter(item => ["garden-produce-block", "garden-produce-operation", "garden-produce-work"].includes(item.id))) {
      node.boundary = { ...node.boundary, state: "durable", writer: "garden-produce-block" };
      for (const proof of graph.tests.filter(item => node.tests.includes(item.id)))
        proof.obligations = [...new Set([...(proof.obligations ?? ["outcome"]), "durable_cold_read", "restart_cold"] as const)];
    }
  });
  ok(startRun(f.store, { project }));
  const performed: string[] = [], answered = new Set<string>();
  let given: Ref | null = null, last: unknown = null, decisions = 0;
  for (let index = 0; index < 500 && !worksAcceptance(f.store).frame; index++) {
    const advanced = ok(await advanceRun(f.store, f.request));
    if (advanced.performed) performed.push(advanced.performed.action);
    const asked = f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input.questions.find(row => row.readiness?.cause === "policy");
    if (owner && asked && !given) {
      const built = prepareRunBases(f.store, { project });
      const bases = built.ok && built.value.state === "ready" ? built.value.built.bases : null;
      const routes = bases ? f.store.get<RoutesRecord>(bases.routes.id, bases.routes.revision)! : null;
      const routed = routes?.value.routes.find(row => row.target === asked.id) as unknown as { record: Ref } | undefined;
      if (routes && routed) {
        const sessions = new OwnerSessions(f.store), { invitation } = ok(issueOwnerInvitation(f.store, { project }));
        const authority = sessions.authority(ok(sessions.exchange({ project, invitation })).bearer)!;
        given = reference(ok(writeOwnerResult(f.store, authority, { project, routes: reference(routes), gap: routed.record,
          value: "The producing block creates the state on its first run; a missing state later is a loss", basis: "The owner's rule for this state" },
          { routes: readRoutes, input: readOmInput })).result);
      }
    }
    const state = advanced.record.value.state as unknown as { phase: string; step?: { action: string; request: { packet: Ref } } };
    last = state;
    if (state.phase === "waiting" || state.phase === "complete" || state.phase === "unable") break;
    if (state.phase !== "step") continue;
    const key = JSON.stringify(state.step!.request);
    if (state.step!.action === "cycle" && !answered.has(key)) {
      answered.add(key);
      const saved = state.step!.request.packet, packet = f.store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
      const routed = f.store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
      const batch = routed.batches.find(row => row.id === packet.value.request.batch)!;
      if (batch.model === "MC2" && batch.task === "input-field") {
        decisions++;
        f.push({ research: { protocol: "$answerProtocol", requestId: "$requestId", action: "answer",
          results: batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record, value: OWN1_DECISION })) }, usage });
      } else f.answer(saved);
    }
    if (state.step!.action === "assess" && !answered.has(key)) { answered.add(key); f.push(assessor("supported")); }
  }
  const trail = `${performed.join(",")} ${JSON.stringify(last).slice(0, 1500)}`;
  const gates = f.store.list<{ result: { passed: boolean; findings: { code: string; target: string; field?: string }[] };
    impact?: { policies?: { work: string; policy: string; producer: string; contract: { id: string; hash: string }; question: string | null }[] } }>("om-atomic-gate");
  const refused = gates.find(row => row.value.result.findings.some(item => item.code === "work_policy_open"));
  assert.ok(refused, `G5 refused the durable work without its producer's policy: ${trail}`);
  const work = f.desired.nodes.find(node => node.id === "garden-produce-work")!;
  const contract = f.desired.artifacts.find(artifact => artifact.id === work.outcome)!.contract;
  // Return №4135 P2-1: the consuming work uses the durable garden data — it refers to the same producer's policy of the same contract.
  assert.deepEqual(refused!.value.result.findings.filter(item => item.code === "work_policy_open").map(item => [item.target, item.field]),
    [["garden-consume-work", `appearance:garden-produce-block:${contract}`], ["garden-produce-work", `appearance:garden-produce-block:${contract}`]],
    "at the address of its contract and producer, for its producer and its consumer");
  const governs = refused!.value.impact!.policies!.find(row => row.work === "garden-produce-work")!.contract;
  assert.deepEqual(performed.filter(row => row === "readiness"), ["readiness"], `The policy is asked once: ${trail}`);
  const input = f.store.get<OmInputRecord>(`om-input:${project}`)!.value.input;
  const decided = (input.decided ?? []).filter(row => row.question.readiness?.cause === "policy");
  assert.equal(decided.length, 1, `One policy, decided once: ${trail}`);
  const question = decided[0]!.question;
  assert.deepEqual([question.consumer, question.kind, question.source.id, question.readiness],
    ["garden-produce-block", "owner-decision", refused!.id, { contract: "om-readiness/v1", cause: "policy", policy: "appearance",
      producer: "garden-produce-block", governs: { contract, hash: governs.hash }, works: ["garden-consume-work", "garden-produce-work"] }], "one question for both");
  if (owner) {
    assert.deepEqual(decided[0]!.value, { owner: given, value: "The producing block creates the state on its first run; a missing state later is a loss" });
    assert.equal(decisions, 0, "The model is never asked the policy the owner answered");
  } else {
    assert.deepEqual(decided[0]!.value, OWN1_DECISION, "The model's decision in the bypass, not the owner's");
    assert.equal(decisions, 1, "The model decides it once");
    assert.equal(f.store.list().filter(row => row.id.startsWith("om-owner-result:")).length, 0, "No owner result is invented");
  }
  const passed = gates.find(row => row.value.result.passed);
  assert.ok(passed, `G5 passed: ${JSON.stringify(worksAcceptance(f.store).findings)} ${trail}`);
  assert.deepEqual(passed!.value.impact!.policies, ["garden-consume-work", "garden-produce-work"].map(work =>
    ({ work, policy: "appearance", producer: "garden-produce-block", contract: governs, question: question.id })), "both refer to the one decision");
  const decision = owner ? "The producing block creates the state on its first run" : OWN1_DECISION.decision;
  const works = f.store.list<QuestionPacketRecord>("question-packet").filter(row => row.value.packetContract === WORKS_BRIEF_PACKET_CONTRACT && row.value.packet
    && JSON.stringify(row.value.packet).includes(decision));
  assert.ok(works.length > 0, "The works brief after the decision carries it");
}

// AT1 return №4124 P2-6: a group the code before AT1 refused by its own G5 (the era before the impact) ends the way it
// always did under the new code — its rejection asks no readiness question and never stands on a refusal of the era.
const AT1_BASE = "e475bd594fc2f4cde4fb58b6f26f2083f7c00954";

export { project, adapterFixture, ok, refusal, runFixture, addressAll, usage, factsAll, assessor, refOf, mechanismSeries, blockSeries, actions, actionsSteps, ends, driveTo, drive, reasonsOf, blockBases, stopAnswer, cannotAnswer, untouched, stoppedBlockLine, secondRung, frameAnswer, OWN1_DECISION, decisionCalls, restWithDecisions, until, RacingStore, loadOperations, gardenPass, regatePolicy, nodeAnswer, worksFixture, worksAcceptance, factWorksPass, LostApplication, lostAfterClaim, heldAfterClaim, a6Survives, nodeRefusal, driveUntil, gapHeads, addressQuestions, answerBatch, atCommit, openPlanned, sameEnd, twoOwnerAnswers, advanceRun, lp3Need, lp3Order, lp3Blocked, lp3Pointers, LP3_UNPROVED, lp3Hiding, lp3Context, isRefOf, asCycleStart, asRunResult, LP4_COMMITS, lp4Configure, lp4Questions, lp4Sent, lp4Close, mp2Upper, mp2Rank, mp2Works, mp2WorkAnswer, twoArtifacts, threeArtifacts, G62_BASE, g62Rejection, lp5ReplaceB1, lp5Kind, lp5Pass, g51AmbiguousAnswer, LP5_BASE_COMMIT, lp6Line, lp6CurrentRounds, lp6Close, LP7_VALUES, lp7Routes, passRows, unavailableReview, policyDoor, AT1_BASE };
export type { Fixture, Verdict, Lp5State, Lp6Op, Reopened };
