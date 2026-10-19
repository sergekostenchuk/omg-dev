import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { Evidence } from "../src/evidence/evidence.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { beginLegacyOperation } from "../src/product/preparation-run.js";
import { processStart } from "../src/runtime/process-identity.js";
import { git } from "../src/runtime/environment.js";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { inputDecisionWrite, writeAddressing } from "../src/om/addressing.js";
import { applySeriesActivation, beginAttempt, openSeries } from "../src/om/series.js";
import { writeSeriesTransition } from "../src/om/series-transition.js";
import { readHorizon, writeHorizon, writeHorizonIssuance, type HorizonRecord } from "../src/om/horizon.js";
import type { OmInputRecord } from "../src/om/input.js";
import type { OmResult, Refusal } from "../src/om/refusal.js";
import { readBlockQueue } from "../src/om/queue.js";
import type { RoutesRecord } from "../src/om/routes.js";
import { readRun, startRun } from "../src/om/run.js";
import { FACT_RESULT_FORM, RUN_BASES_POLICY, prepareRunBases, writeRunBases, type BuiltRunBases } from "../src/om/run-bases.js";
import { gardenGraph } from "./om-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { deriveLayerFixture } from "./layer-design-fixture.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";
import type { LayerBasis } from "../src/om/layer-basis.js";
import { prepareAtomicGate, prepareCandidateSources, type AtomicGateRequest } from "../src/om/atomic-gate.js";
import { settleCandidate } from "../src/om/frame-accept.js";
import { writeCandidate } from "../src/om/frame-candidate.js";
import { fillObligations, prepareFrame, type FrameRead, type FrameRequest } from "../src/om/frame-obligations.js";
import type { LayerProposal, ProposalRequest } from "../src/om/frame-proposals.js";
import { writeGaps, type GapRequest } from "../src/om/gaps.js";
import { writeGapLines } from "../src/om/gap-lines.js";
import { writeOmInput } from "../src/om/input.js";
import { writeNeighbors } from "../src/om/neighbors.js";
import { writeOmObligations } from "../src/om/obligations.js";
import { writeWorksFrame } from "../src/om/works-frame.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";

const project = "garden";
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message} (${result.refusal.at.target}/${result.refusal.at.field})`);
  return result.value;
}
function refusal<T>(result: OmResult<T>): Refusal {
  if (result.ok) assert.fail("A refusal was expected");
  return result.refusal;
}
const heads = (store: Store) => store.list().map(reference);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * A cold OM project: accepted stages and graph, no OM record yet. `later` adds an independent second outcome with its
 * own successful journey (as in om-series-current); `refine` accepts the research layers up to L2.
 */
function basesFixture(t: test.TestContext, options: { questions?: string[]; refine?: boolean; refineTo?: 2 | 3; later?: boolean; consumers?: Record<string, string> } = {}) {
  const { questions = ["encoding"], refine = false, refineTo, later = false, consumers = {} } = options;
  const root = mkdtempSync(join(tmpdir(), "omg-h11-bases-")), database = join(root, "state.sqlite");
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const { level: _level, ...upperMap } = projectGraph(gardenGraph(), 1);
  const graphData = later ? upperMap as Graph : gardenGraph();
  if (later) {
    graphData.requirements!.push({ ...structuredClone(graphData.requirements![0]!), id: "garden-R2", outcome: "garden-later", statement: "Deliver the later result" });
    graphData.nodes.find(node => node.id === "garden-later-block")!.implements!.push("garden-R2");
  }
  const valueFor = (field: string): Json => {
    const value = preparedField(project, field);
    if (field === "preparation" && questions.length) (value as Record<string, Json>).unknowns = questions.map(id => ({ id,
      question: `Which ${id} is supported?`, consumer: consumers[id] ?? "garden-consume-block", moment: "om-pass", blocksCurrentStage: false,
      resolution: "Address this question during OM" }));
    if (!later) return value;
    if (field === "preparation") {
      const rows = (value as Record<string, Json>).outcomes as Record<string, Json>[];
      rows.push({ ...structuredClone(rows[0]!), id: "garden-later", result: "The later result" });
    }
    if (field === "conceptSections") {
      const rows = (value as unknown as { requirements: Record<string, Json>[] }[])[0]!.requirements;
      rows.push({ ...structuredClone(rows[0]!), id: "garden-R2", outcome: "garden-later", statement: "Deliver the later result" });
    }
    if (field === "operationRequirements") {
      const body = value as Record<string, Json>, rows = body.outcomes as Record<string, Json>[];
      rows.push({ ...structuredClone(rows[0]!), outcome: "garden-later" });
      (body.conceptCoverage as Json[]).push({ requirement: "garden-R2", outcome: "garden-later" });
    }
    if (field === "behaviorContracts") {
      const rows = value as unknown as Record<string, Json>[];
      rows.push({ ...structuredClone(rows[0]!), id: "garden-B2", requirements: ["garden-R2"], outcome: "garden-later" });
    }
    if (field === "features" || field === "featurePreparation") {
      const rows = value as unknown as Record<string, Json>[];
      rows.push({ ...structuredClone(rows[0]!), [field === "features" ? "title" : "featureTitle"]: "Deliver later result", outcome: "garden-later",
        ...(field === "featurePreparation" ? { requirements: ["garden-R2"], behaviorContracts: ["garden-B2"] } : {}) });
    }
    return value;
  };
  preparedFeatures(engine, project, graphData, valueFor);
  if (refine || refineTo !== undefined) {
    const command = { executable: process.execPath, args: ["--version"] }, workspace = join(root, "repo");
    mkdirSync(workspace); git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "H1.1 bases repository\n");
    git(workspace, ["add", "README.md"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
    engine.environments.configure(project, { workspace, implementer: { actor: "bases-implementer", model: "fixture", effort: "high", command },
      reviewer: { actor: "bases-reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 5000, requestCapacityChars: 100_000 }, 0);
    if (refineTo === undefined) refinedLayers(engine, project);
    else for (const [level, layer] of [["R0", 1], ["R1", 2]] as const) {
      const draft = engine.refinement.begin(project, level);
      if (level !== "R0") answerTechnicalFixture(engine, project, draft);
      const current = engine.store.get(draft.id)!;
      engine.refinement.finishResearch(project, level, reference(current), 0);
      if (layer !== 1) deriveLayerFixture(engine, project, layer);
      engine.refinement.sealLayer(project, layer, 0);
    }
  }
  return { root, database, valueFor, get store() { return store; }, get engine() { return engine; },
    restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); } };
}
type Fixture = ReturnType<typeof basesFixture>;
/** The features stage prepared again through the engine: a lawful new draft, accepted only when asked. */
function redraftFeatures(f: Fixture, accept: boolean) {
  const draft = f.engine.prepare(project, "features");
  for (const id of draft.value.questions) {
    const question = f.engine.projection(project).questions.find(row => row.id === id)!;
    f.engine.discovery.decision(id, question.revision, "owner", f.valueFor(question.value.spec.field));
  }
  const head = f.store.get(`stage:${project}:features`)!;
  const artifact = f.engine.draft(project, "features", draft.id, head.revision);
  if (accept) f.engine.pipeline.accept(project, "features", artifact.revision);
}
/** D3 decisions over the current B1, as M5 (address) and the MC2 input fields (nodes, state, checkKind) apply them. */
function decide(f: Fixture, decisions: { target: string; field: "state" | "nodes" | "address" | "checkKind"; value: Json }[]): Revision<OmInputRecord> {
  const input = f.store.get<OmInputRecord>(`om-input:${project}`)!, graph = reference(f.store.get(`graph:${project}`)!);
  return ok(writeAddressing(f.store, { project, input: reference(input), graph, decisions: decisions.map(decision =>
    ({ pending: structuredClone(inputDecisionWrite({ project, input: reference(input), graph, layers: [], decision })) as Write })) })) as Revision<OmInputRecord>;
}
const horizonOf = (store: Store, built: BuiltRunBases) => ok(readHorizon(store, project, built.bases.horizon)).horizon as unknown as Revision<HorizonRecord>;
const routesOf = (store: Store, built: BuiltRunBases) => store.get<RoutesRecord>(built.bases.routes.id, built.bases.routes.revision)!;

test("R1 R3 №1852 H1.1 cold OM: the machine writes B1, the pass with every outcome of B1 and linked bases; a new store repeats them without a write", t => {
  const f = basesFixture(t);
  assert.equal(f.store.get(`om-input:${project}`), null, "No OM record exists yet");
  const built = ok(writeRunBases(f.store, { project }));
  const run = ok(readRun(f.store, { project }))!;
  const input = f.store.get<OmInputRecord>(`om-input:${project}`)!;
  assert.deepEqual(built.input, reference(input));
  assert.deepEqual(run.value.input, reference(input), "The pass begins from the exact first B1");
  assert.deepEqual(run.value.intent.outcomes, [...new Set(input.value.input.features.map(feature => feature.outcome))].sort());
  assert.deepEqual(built.outcomes, run.value.intent.outcomes);
  // G2: every intended outcome, nothing excluded, closure by M2/G2; the issue version is the full hash of the request.
  const horizon = horizonOf(f.store, built), request = horizon.value.request;
  assert.deepEqual(request.choice.features, [{ outcome: "garden-result" }]);
  assert.deepEqual([request.choice.excluded, request.available, request.refinement], [[], {}, null]);
  const { choiceVersion, ...choice } = request.choice;
  assert.match(choiceVersion, /^[0-9a-f]{64}$/);
  assert.equal(choiceVersion, hashJson({ policyVersion: RUN_BASES_POLICY, normalizedRequest: { ...request, choice } } as unknown as Json));
  // D1, D5, M6 and C1 are one consistent chain over this B1 and this horizon.
  const routes = routesOf(f.store, built);
  assert.deepEqual(routes.value.request.gaps.sources.input, reference(input));
  assert.deepEqual(routes.value.request.gaps.sources.horizon, built.bases.horizon);
  assert.deepEqual(routes.value.request.catalog, { paths: [], records: [] }, "Reading addresses are never invented");
  const queue = ok(readBlockQueue(f.store, { project, record: built.bases.queue }));
  assert.deepEqual(queue.value.request.horizon, built.bases.horizon);
  assert.equal(queue.value.request.override, null);
  assert.equal(queue.value.request.policy.machinePath.outcomeId, "garden-result");
  assert.deepEqual(built.bases.sources, [], "No works need external Sources yet");
  assert.deepEqual(ok(prepareRunBases(f.store, { project })), { state: "ready", built });
  // R3: the same exact sources in a new store give the same products and no revision.
  const before = heads(f.store);
  f.restart();
  assert.deepEqual(ok(writeRunBases(f.store, { project })), built);
  assert.deepEqual(heads(f.store), before, "An equal repeat writes nothing");
});

test("R2 H1.1 the first B1 keeps its admission: an active legacy operation or an unaccepted stage is refused and nothing later is built", t => {
  const f = basesFixture(t);
  // A legacy preparation is running (its lease is the pending preparation record, as the engine writes it).
  const value = { projectId: project, status: "running", phase: "R2", draft: null, plan: null,
    owner: { pid: process.pid, started: processStart(process.pid) }, error: null, code: null, findings: [], calls: 0 };
  const lease: Write = { id: `preparation-run:${project}`, kind: "preparation-run", expected: 0, value };
  beginLegacyOperation(f.store, project, "prepare", { id: lease.id, revision: 1, hash: hashJson(value) }, [lease]);
  const legacy = refusal(writeRunBases(f.store, { project }));
  assert.equal(legacy.code, "legacy_operation_active");
  assert.deepEqual(f.store.list().filter(row => row.id.startsWith("om-")).map(row => row.id), [], "No OM record is written");
  const g = basesFixture(t);
  redraftFeatures(g, false);
  const unaccepted = refusal(writeRunBases(g.store, { project }));
  assert.equal(unaccepted.code, "stage_not_accepted");
  assert.equal(g.store.get(`om-run:${project}`), null);
  assert.deepEqual(g.store.list("horizon"), []);
});

test("№1852 R12 R13 H1.1 the launch intent: a named subset, the default, an equal permuted repeat, another set and an unknown outcome", t => {
  const f = basesFixture(t, { later: true });
  const subset = ok(writeRunBases(f.store, { project, outcomes: ["garden-result"] }));
  const run = ok(readRun(f.store, { project }))!;
  assert.deepEqual(run.value.intent.outcomes, ["garden-result"], "The named subset is the intent, although B1 accepts two outcomes");
  assert.deepEqual(horizonOf(f.store, subset).value.request.choice.features, [{ outcome: "garden-result" }]);
  // The path is chosen only among the journeys of the intended outcomes: the later outcome's journey, whose key is
  // smaller, is never taken for this horizon.
  const queue = ok(readBlockQueue(f.store, { project, record: subset.bases.queue }));
  assert.equal(queue.value.request.policy.machinePath.outcomeId, "garden-result");
  const before = heads(f.store);
  assert.deepEqual(ok(writeRunBases(f.store, { project })), subset, "A repeat without outcomes continues the saved intent");
  assert.deepEqual(ok(startRun(f.store, { project, outcomes: ["garden-result", "garden-result"] })), run, "An equal set is the same pass");
  assert.deepEqual(heads(f.store), before);
  const conflict = refusal(writeRunBases(f.store, { project, outcomes: ["garden-later"] }));
  assert.deepEqual([conflict.code, conflict.at.target, conflict.at.field], ["run_intent_conflict", `om-run:${project}`, "intent.outcomes"]);
  assert.deepEqual(conflict.at.ref, reference(run));
  assert.deepEqual(heads(f.store), before, "Another intent writes nothing");
  // The default of a first pass is every outcome of its exact B1.
  const g = basesFixture(t, { later: true });
  const all = ok(writeRunBases(g.store, { project }));
  assert.deepEqual(all.outcomes, ["garden-later", "garden-result"]);
  assert.deepEqual(horizonOf(g.store, all).value.request.choice.features, [{ outcome: "garden-later" }, { outcome: "garden-result" }]);
  assert.equal(ok(readBlockQueue(g.store, { project, record: all.bases.queue })).value.request.policy.machinePath.outcomeId, "garden-later",
    "The canonical key orders by outcome first");
  // An outcome B1 does not accept: addressed to B1, and neither a pass nor a horizon exists for it.
  const h = basesFixture(t, { later: true });
  const unknown = refusal(writeRunBases(h.store, { project, outcomes: ["garden-result", "garden-unknown"] }));
  assert.deepEqual([unknown.code, unknown.at.target, unknown.at.field], ["run_outcome_unknown", `om-input:${project}`, "outcomes"]);
  assert.equal(h.store.get(`om-run:${project}`), null);
  assert.deepEqual(h.store.list("horizon"), []);
  assert.throws(() => writeRunBases(h.store, { project, outcomes: [] }), (error: unknown) => error instanceof EngineError && error.code === "run_bases_request_invalid");
  assert.throws(() => startRun(h.store, { project, outcomes: [] }), (error: unknown) => error instanceof EngineError && error.code === "run_request_invalid");
});

test("R4 R9 H1.1 after M5 the new B1 keeps its decisions: a new G2 issue of the same intent, new D1, M6 and C1; the earlier issue stays history", t => {
  const f = basesFixture(t);
  const first = ok(writeRunBases(f.store, { project }));
  const firstHorizon = horizonOf(f.store, first);
  const addressed = decide(f, [{ target: "discovery:encoding", field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } }]);
  const second = ok(writeRunBases(f.store, { project }));
  assert.deepEqual(second.input, reference(addressed), "The addressed B1 is used as it is, never rebuilt from the stages");
  assert.deepEqual(second.outcomes, first.outcomes);
  assert.notEqual(second.bases.horizon.id, first.bases.horizon.id, "New exact bases are a new issue of the same intent");
  assert.deepEqual(horizonOf(f.store, second).value.request.choice.features, firstHorizon.value.request.choice.features);
  assert.deepEqual(ok(readHorizon(f.store, project, first.bases.horizon)).horizon, firstHorizon, "The earlier issue is unchanged history");
  assert.notDeepEqual(second.bases.routes, first.bases.routes);
  assert.notDeepEqual(second.bases.queue, first.bases.queue);
  // The addressed question is now a fact of its block: one D5 task with the machine's result form.
  const routes = routesOf(f.store, second);
  assert.ok(routes.value.batches.some(batch => batch.model === "MC1" && batch.task === "fact"));
  const tasks = f.store.list<{ request: { resultForm: Json } }>("answer-task");
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0]!.value.request.resultForm, FACT_RESULT_FORM);
});

test("R14 №1860-3 H1.1 each fact has its own task: requirements are only the contracts bound to its own consumer, otherwise none", t => {
  const f = basesFixture(t, { questions: ["encoding", "spare"], consumers: { spare: "garden-produce-block" } });
  ok(writeRunBases(f.store, { project }));
  const input = f.store.get<OmInputRecord>(`om-input:${project}`)!;
  const contract = input.value.input.contracts[0]!;
  decide(f, [{ target: contract.id, field: "nodes", value: ["garden-consume-block"] },
    { target: "discovery:encoding", field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } },
    { target: "discovery:spare", field: "address", value: { consumer: "garden-produce-block", kind: "repository-fact" } }]);
  ok(writeRunBases(f.store, { project }));
  const tasks = f.store.list<{ request: { gap: Ref; requirements: { pointer: string }[]; resultForm: Json } }>("answer-task");
  const byTarget = new Map(tasks.map(task => [f.store.get<{ gap: { target: string } }>(task.value.request.gap.id, task.value.request.gap.revision)!.value.gap.target, task.value.request]));
  assert.deepEqual(byTarget.get("discovery:encoding")?.requirements, [{ pointer: "/contracts/0" }], "The contract bound to its consumer");
  assert.deepEqual(byTarget.get("discovery:spare")?.requirements, [], "No contract is bound to this consumer: nothing else of B1 is borrowed");
  for (const task of byTarget.values()) assert.deepEqual(task.resultForm, FACT_RESULT_FORM);
});

test("R21 STALE-1 H1.1 a newly accepted upstream stage under a derived B1 is input_refresh_conflict; the machine never rebuilds a clean input", t => {
  const f = basesFixture(t);
  ok(writeRunBases(f.store, { project }));
  const addressed = decide(f, [{ target: "discovery:encoding", field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } }]);
  const built = ok(writeRunBases(f.store, { project }));
  redraftFeatures(f, true);
  const before = heads(f.store).filter(ref => !ref.id.startsWith("stage:"));
  const conflict = refusal(writeRunBases(f.store, { project }));
  assert.deepEqual([conflict.code, conflict.route], ["input_refresh_conflict", "producer"]);
  assert.deepEqual(f.store.get(`om-input:${project}`), addressed, "B1 keeps its decisions");
  assert.deepEqual(heads(f.store).filter(ref => !ref.id.startsWith("stage:")), before);
  assert.notDeepEqual(ok(readRun(f.store, { project }))!.value.intent, null);
  assert.equal(built.input.revision, addressed.revision);
});

test("№1860-2 R6 H1.1 D1 stands on the lawful upper representation: no refinement, or the accepted research L2", t => {
  const f = basesFixture(t);
  const cold = ok(writeRunBases(f.store, { project }));
  const plain = routesOf(f.store, cold).value.request.gaps.sources;
  assert.deepEqual(plain.works, { state: "upper-not-accepted", layer: reference(f.store.get(`graph-layer:${project}:2`)!) });
  assert.equal((plain.operations.frame as { layer: Ref | null }).layer, null);
  assert.equal(horizonOf(f.store, cold).value.request.refinement, null);
  const g = basesFixture(t, { refine: true });
  const refined = ok(writeRunBases(g.store, { project }));
  assert.deepEqual(horizonOf(g.store, refined).value.request.refinement, reference(g.store.get(`phase:${project}:L2`)!));
  const sources = routesOf(g.store, refined).value.request.gaps.sources as unknown as { operations: { frame: Record<string, unknown> };
    works: { frame: Record<string, unknown> } };
  assert.deepEqual(sources.operations.frame.layer, reference(g.store.get(`graph-layer:${project}:2`)!));
  assert.deepEqual(sources.works.frame.upper, { horizon: refined.bases.horizon, frame: null }, "Works of an accepted research L2 are a level-three frame");
});

test("R20 H1.1 a legacy project stays legacy: the machine writes no membership, transition, issuance or activation", t => {
  const f = basesFixture(t);
  ok(writeRunBases(f.store, { project }));
  for (const kind of ["om-series-membership", "series-transition", "om-horizon-issuance", "om-series-applied", "om-series-current"])
    assert.deepEqual(f.store.list(kind), [], kind);
});

/** A store whose process is lost right after the n-th committed transaction. */
class DyingStore extends Store {
  constructor(path: string, private remaining: number) { super(path); }
  override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
    const written = super.writeMany<T>(writes, guards);
    if (--this.remaining === 0) throw new Error("lost after commit");
    return written;
  }
}

test("R18 №1852-5 H1.1 a build lost after each of its products is completed from another store: one pass, one issue, no second choice", t => {
  const f = basesFixture(t);
  const products: string[] = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    const dying = new DyingStore(f.database, 1);
    try {
      const built = writeRunBases(dying, { project });
      if (built.ok) break;
      assert.fail(`${built.refusal.code}: ${built.refusal.message}`);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "lost after commit") throw error;
      products.push(dying.list().map(row => row.id).filter(id => id.startsWith("om-") || id.startsWith("horizon:") || id.startsWith("block-weight:")).length.toString());
    } finally { dying.close(); }
  }
  assert.ok(products.length >= 4, `The build was interrupted after B1, the pass, the horizon and D1: ${products.join(",")}`);
  f.restart();
  const built = ok(writeRunBases(f.store, { project }));
  assert.equal(f.store.list("om-run").length, 1);
  assert.equal(f.store.list("om-horizon").length, 1, "One issue for one intent on equal bases");
  assert.equal(f.store.list("route-result").length, 1);
  assert.equal(f.store.list("block-weight").length, 1);
  assert.deepEqual(ok(prepareRunBases(f.store, { project })), { state: "ready", built });
});

/** Runs another store's action once, right when this store first reads the given record. */
class RacingStore extends Store {
  target = ""; run: ((store: Store) => void) | null = null;
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    if (id === this.target && this.run) {
      const run = this.run; this.run = null;
      const other = new Store(this.path);
      try { run(other); } finally { other.close(); }
    }
    return super.get<T>(id, revision);
  }
}

test("R19 №1852-5 H1.1 concurrent builds: equal intents converge to the winner's products; another intent conflicts without overwriting it", t => {
  const f = basesFixture(t, { later: true });
  const racing = new RacingStore(f.database);
  t.after(() => racing.close());
  racing.target = `om-run:${project}`;
  let other: BuiltRunBases | null = null;
  racing.run = store => { other = ok(writeRunBases(store, { project, outcomes: ["garden-result"] })); };
  const mine = ok(writeRunBases(racing, { project, outcomes: ["garden-result"] }));
  assert.ok(other, "The other store built first");
  assert.deepEqual(mine, other, "The loser finds the winner's products");
  assert.equal(racing.list("om-run").length, 1);
  assert.equal(racing.list("om-horizon").length, 1);
  const g = basesFixture(t, { later: true });
  const second = new RacingStore(g.database);
  t.after(() => second.close());
  second.target = `om-run:${project}`;
  second.run = store => { ok(writeRunBases(store, { project, outcomes: ["garden-later"] })); };
  const lost = refusal(writeRunBases(second, { project, outcomes: ["garden-result"] }));
  assert.equal(lost.code, "run_intent_conflict");
  assert.deepEqual(ok(readRun(second, { project }))!.value.intent.outcomes, ["garden-later"], "The winner's intent stands");
});

test("№1852-5 R15 H1.1 M5 keeps the named subset; a question addressed to a late or unsupported kind gets its honest route and no fact task", t => {
  const f = basesFixture(t, { later: true, questions: ["encoding", "spare"] });
  const first = ok(writeRunBases(f.store, { project, outcomes: ["garden-result"] }));
  decide(f, [{ target: "discovery:encoding", field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } },
    { target: "discovery:spare", field: "address", value: { consumer: "garden-consume-block", kind: "owner-decision" } }]);
  const second = ok(writeRunBases(f.store, { project }));
  assert.deepEqual(second.outcomes, ["garden-result"], "New bases never return to every outcome");
  assert.deepEqual(horizonOf(f.store, second).value.request.choice.features, [{ outcome: "garden-result" }]);
  assert.notDeepEqual(second.bases.horizon, first.bases.horizon);
  const routes = routesOf(f.store, second).value;
  const owner = routes.routes.find(route => route.target === "discovery:spare")!;
  // OWN1 (№3711): in the bypass the model decides an owner question of the pass — its own MC2 batch, never a fact task.
  assert.deepEqual([owner.route, owner.state], ["design", "pending"], "The bypass route of an owner decision, not a fact");
  assert.deepEqual(routes.batches.filter(batch => batch.items.some(item => item.target === "discovery:spare"))
    .map(batch => [batch.model, batch.task, batch.items.map(item => item.field)]), [["MC2", "input-field", ["answer"]]]);
  const tasks = f.store.list<{ request: { gap: Ref } }>("answer-task").map(task =>
    f.store.get<{ gap: { target: string } }>(task.value.request.gap.id, task.value.request.gap.revision)!.value.gap.target);
  assert.deepEqual(tasks, ["discovery:encoding"], "Only the repository fact gets a D5 task");
});

/** The owner's earlier B3 of the managed era: a horizon of its own choice, P over the registered roots, G2 issuance, activation. */
function activate(f: Fixture, choiceVersion: string, outcome: string) {
  const input = f.store.get<OmInputRecord>(`om-input:${project}`)!;
  const horizon = ok(writeHorizon(f.store, { project, input: reference(input), graph: reference(f.store.get(`graph:${project}`)!),
    refinement: null, available: {}, choice: { choiceVersion, features: [{ outcome }], excluded: [] } }));
  const roots = f.store.list<{ predecessor: Ref | null }>("repair-series").filter(row => "block" in (row.value as object))
    .filter(row => !f.store.list<{ predecessor: Ref | null }>("repair-series").some(other => other.value.predecessor?.id === row.id)).map(reference);
  const prepared = ok(writeSeriesTransition(f.store, { project, choiceVersion, horizon: reference(horizon.gate), series: roots }));
  const issuance = ok(writeHorizonIssuance(f.store, { project, choiceVersion, horizon: reference(horizon.gate), transition: reference(prepared) }));
  return ok(applySeriesActivation(f.store, { project, prepared: reference(prepared), issuance: reference(issuance) }));
}
const issuedHorizon = (store: Store) => {
  const pointer = store.get<{ applied: Ref }>(`om-series-current:${project}`)!;
  const applied = store.get<{ prepared: Ref }>(pointer.value.applied.id, pointer.value.applied.revision)!;
  return store.get<{ request: { horizon: Ref } }>(applied.value.prepared.id, applied.value.prepared.revision)!.value.request.horizon;
};
/** A store whose process is lost right after the first transaction that writes a record of the given kind. */
class LostAfterKind extends Store {
  constructor(path: string, private readonly kind: string) { super(path); }
  override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
    const written = super.writeMany<T>(writes, guards);
    if (writes.some(write => write.kind === this.kind)) throw new Error("lost after commit");
    return written;
  }
}

test("R20 №1860-8 №1860-12 H1.1 managed: another activated issue admits no work until the machine's own B3; a basis changed between P and activation gets a new P", t => {
  const f = basesFixture(t, { later: true });
  ok(writeRunBases(f.store, { project, outcomes: ["garden-result"] }));
  // The project entered the managed era by an earlier B3 of another issue (the later outcome only).
  ok(openSeries(f.store, { project, block: "garden-later-block", line: 1, slice: "h11-other", predecessor: null, basis: null }));
  activate(f, "h11-initial", "garden-later");
  const other = issuedHorizon(f.store);
  // The machine's check sees an activation of another issue: its own bases are not ready for new work.
  assert.deepEqual(ok(prepareRunBases(f.store, { project })), { state: "missing", stage: "transition" });
  // The build is lost right after its P; before the activation the B1 changes (a lawful D3 decision).
  const lost = new LostAfterKind(f.database, "series-transition");
  assert.throws(() => writeRunBases(lost, { project }), /lost after commit/);
  lost.close();
  const stale = f.store.list<{ request: { horizon: Ref } }>("series-transition").find(row => !same(row.value.request.horizon, other))!;
  assert.ok(stale, "The P of the first build was written");
  decide(f, [{ target: "discovery:encoding", field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } }]);
  const built = ok(writeRunBases(f.store, { project }));
  assert.deepEqual(issuedHorizon(f.store), built.bases.horizon, "The activation stands on the issue of the changed basis");
  assert.notDeepEqual(stale.value.request.horizon, built.bases.horizon, "The P prepared on the earlier basis is not applied");
  assert.ok(!f.store.list<{ prepared: Ref }>("om-series-applied").some(row => row.value.prepared.id === stale.id), "The half pair stays history");
  assert.deepEqual(ok(prepareRunBases(f.store, { project })), { state: "ready", built });
});

/**
 * A works candidate with one external input, built as in om-atomic-gate (externalCandidate): the native N2 is accepted,
 * the L3 frame is filled by a proposal of the enriched example graph, and garden-data is an external artifact.
 */
function externalCandidate(t: test.TestContext, selfInput = false) {
  const root = mkdtempSync(join(tmpdir(), "omg-h11-external-")), database = join(root, "state.sqlite");
  const store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const desired = enrichedGraph(exampleGraph(), project);
  desired.artifacts.find(artifact => artifact.id === "garden-data")!.external = true;
  // The reviewer's example (№1937): garden-flow runs from the consuming block back into itself on every level, with its
  // output ports, the covering test and codeRef; the successful journey is the consuming block alone.
  if (selfInput) {
    for (const binding of desired.connectors[0]!.bindings) {
      binding.producer = { ...structuredClone(binding.consumers[0]!), port: "out" };
      desired.nodes.find(node => node.id === binding.producer.node)!.ports.push({ id: "out", direction: "out", contract: "garden-contract" } as never);
    }
    const covering = desired.tests.find(item => item.node === "garden-consume-work")!;
    covering.covers = ["garden-flow"];
    covering.contract!.counterfactuals = structuredClone(desired.tests.find(item => item.node === "garden-produce-work")!.contract!.counterfactuals);
    for (const journey of desired.journeys!) if (journey.terminal === "success") { journey.entry = "garden-consume-block"; journey.path = ["garden-consume-block"]; }
  }
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph, field => preparedField(project, field));
  let input = ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const first = ok(writeHorizon(store, { project, input: reference(input), graph: reference(store.get(`graph:${project}`)!),
    refinement: null, available: {}, choice: { choiceVersion: "external-upper", features: [{ outcome: "garden-result" }], excluded: [] } }));
  function proposal(frame: FrameRead): Ref {
    const graph = structuredClone(desired), level = frame.request.level;
    if (level === 3) {
      for (const field of ["nodes", "artifacts", "contracts", "anchors", "joins", "tests", "edges", "journeys", "packets", "transfers"] as const) {
        const upper = frame.upper[field] ?? [], ids = new Set(upper.map(item => item.id));
        Object.assign(graph, { [field]: [...structuredClone(upper), ...(graph[field] ?? []).filter(item => !ids.has(item.id))] });
      }
      graph.connectors = frame.upper.connectors.map(upper => ({ ...structuredClone(upper), bindings: [...structuredClone(upper.bindings),
        ...desired.connectors.find(connector => connector.id === upper.id)!.bindings.filter(binding => binding.level === 3)] }));
    }
    const projected = projectGraph(graph, level), mapped = ok(fillObligations(frame.upper, frame.scope, {
      graph, reference: { ...frame.request.graph, hash: hashJson(graph) }, frame: null }, frame.upperRef, level));
    const nodes = projected.nodes.filter(node => node.kind === (level === 2 ? "operation" : "work")
      && (level === 2 || frame.scope.nodes.includes(node.parent!))), selected = new Set(nodes.map(node => node.id));
    const value: LayerProposal = { base: { graph: frame.request.graph, frame: null }, level,
      ...(level === 3 ? { worksContract: "works-frame/v1" as const } : {}), source: "decision", status: "proposed", nodes,
      fills: mapped.fills.filter(fill => selected.has(fill.node)).map(fill => ({ obligation: fill.obligation, node: fill.node,
        ...(fill.port === undefined ? {} : { port: fill.port, ...(level === 3 ? { codeRef: structuredClone(nodes.find(node => node.id === fill.node)!.code[0]!) } : {}) }) })),
      localConnectors: level === 3 ? [] : projected.connectors.map(connector => ({ ...connector,
        bindings: connector.bindings.filter(binding => binding.level === 2) })).filter(connector => connector.bindings.length),
      artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
      tests: projected.tests.filter(test => level === 2 || selected.has(test.node)), edges: projected.edges ?? [],
      journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
      anchors: level === 2 ? projected.anchors : [], removes: [], replaces: [], redefines: [] };
    return reference(store.write({ id: `om-proposal:garden:external-${level}`, kind: "layer-proposal", expected: 0, value }));
  }
  const frame2: FrameRequest = { project, level: 2, graph: reference(store.get("graph:garden")!), horizon: reference(first.gate),
    layer: null, frame: null, upper: null };
  const upperCandidate = ok(writeCandidate(store, { frame: frame2, proposals: [proposal(structuredClone(ok(prepareFrame(store, frame2))) as unknown as FrameRead)] }));
  if (upperCandidate.state !== "candidate") assert.fail("The native L2 candidate is formed");
  const upperRef = reference(upperCandidate.record);
  const accepted = ok(settleCandidate(store, { project, level: 2, candidate: upperRef,
    outcome: { gate: "G3", candidate: upperRef, graphHash: upperCandidate.record.value.graphHash, passed: true, codes: [] } }));
  const graph = reference(accepted.graph!), layer = reference(accepted.layer!), upperFrame = reference(accepted.frame!);
  const decisions = [
    { target: "garden-B1", field: "nodes" as const, value: ["garden-produce-block", "garden-consume-block"] },
    { target: "garden-B1", field: "state" as const, value: { writer: "garden-produce-block", authority: "garden-consume-block", rollback: "garden-consume-block" } },
    { target: "garden-R1#1", field: "checkKind" as const, value: "test" }];
  input = ok(writeAddressing(store, { project, input: reference(input), graph, decisions: decisions.map(decision =>
    ({ pending: inputDecisionWrite({ project, input: reference(input), graph, layers: [], decision }) as Write })) }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph, refinement: layer,
    available: {}, choice: { choiceVersion: "external-works", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const basis = ok(prepareFrame(store, { project, level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
    upper: { horizon: reference(horizon.gate), frame: upperFrame } }));
  const works: ProposalRequest = { frame: structuredClone(basis.request) as FrameRequest, proposals: [proposal(structuredClone(basis) as unknown as FrameRead)] };
  const gaps = ok(writeGaps(store, { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { frame: { ...frame2, graph, layer, frame: upperFrame, horizon: reference(horizon.gate) }, proposals: [] }, works }));
  const gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const handoff = ok(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [] }));
  const candidate = ok(writeWorksFrame(store, { ...works, works: { contract: "works-frame/v1",
    producer: reference(handoff.producer), ledger: reference(handoff.record), bindings: [] } }));
  if (candidate.state !== "candidate") assert.fail("The native external-input candidate is formed");
  const neighbors = ok(writeNeighbors(store, { project, candidate: reference(candidate.record) }));
  const command = { executable: process.execPath, args: ["--version"] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: "external-producer", model: "fixture", effort: "high", command },
    reviewer: { actor: "external-reviewer", model: "fixture", effort: "high", command }, fullCheck: command,
    timeoutMs: 5000, requestCapacityChars: 200_000 }, 0);
  const path = join(root, "input.txt");
  const request: AtomicGateRequest = { project, candidate: reference(candidate.record), neighbors: reference(neighbors),
    environment: reference(environment), gaps: gapRead, results: [], sources: [] };
  return { store, root, path, first, candidate, neighbors, request };
}

test("R16 №1860-7 STALE-8 H1.1 works Sources are exactly the ones the candidate's own task derivation needs: none extra, a missing or unfit one refused", t => {
  const f = externalCandidate(t);
  const sourcesOf = () => prepareCandidateSources(f.store, { project, candidate: f.request.candidate, neighbors: f.request.neighbors });
  // Before any Source exists, the needed artifact is named: nothing is invented and no declaration stands for it.
  const missing = refusal(sourcesOf());
  assert.deepEqual([missing.code, missing.at.target, missing.at.field], ["atomic_gate_basis_unproven", "garden-data", "sources"]);
  writeFileSync(f.path, "A captured external input");
  const source = new Evidence(f.store).file(project, "garden-data", f.root, "input.txt", "text/plain", 0);
  // An unrelated captured Source of the same project is never passed on.
  new Evidence(f.store).document(project, "garden-unrelated", "Not a task input", "text/plain", 0);
  const needed = ok(sourcesOf());
  assert.deepEqual(needed.sources, [reference(source)]);
  const gate = ok(prepareAtomicGate(f.store, { ...f.request, sources: [...needed.sources] }));
  assert.equal(gate.record.value.result.passed, true, "G5 admits exactly this list");
  assert.deepEqual(f.first.horizon.value.result.horizon.externalInputs.map(row => row.artifact), ["garden-data"]);
  // A captured file changed since its Source: the common resolver's refusal, addressed to the artifact.
  writeFileSync(f.path, "Changed without advancing the Source record");
  const unfit = refusal(sourcesOf());
  assert.deepEqual([unfit.code, unfit.at.target], ["external_input_missing", "garden-data"]);
});


test("C19 №1860-5 H1.1 new heads wait for open work: a build refuses while an attempt not named by its caller is open, and never rewrites D1 under it", t => {
  const f = basesFixture(t);
  const first = ok(writeRunBases(f.store, { project }));
  // A block attempt is open on the current bases (its check and close still need them) when M5 changes B1.
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h11-open", predecessor: null, basis: null }));
  const series = ok(beginAttempt(f.store, { ...address, attempt: 1, goal: { key: "h11-open-goal", questions: ["Hold the scope"], result: "A held scope" } }));
  decide(f, [{ target: "discovery:encoding", field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } }]);
  assert.deepEqual(ok(prepareRunBases(f.store, { project })), { state: "missing", stage: "horizon" });
  const gaps = heads(f.store).filter(ref => ref.id.startsWith("om-gap:"));
  const refused = refusal(writeRunBases(f.store, { project }));
  assert.deepEqual([refused.code, refused.at.target, refused.at.field], ["run_bases_work_open", series.id, "attempts"]);
  assert.deepEqual(heads(f.store).filter(ref => ref.id.startsWith("om-gap:")), gaps, "No D1 head moves under the open attempt");
  assert.equal(f.store.list("om-horizon").length, 1);
  // The caller that owns that attempt's completion (the D2 of an accepted frame) names it; then the build goes on.
  const built = ok(writeRunBases(f.store, { project }, { open: [series.id] }));
  assert.notDeepEqual(built.bases.horizon, first.bases.horizon);
});

test("R16 №1937 M5 STALE-8 H1.1 the L1 external inputs are not the list: a self connector is named by L1 while the candidate's tasks need no Source", t => {
  const f = externalCandidate(t, true);
  new Evidence(f.store).document(project, "garden-data", "Captured external data", "text/plain", 0);
  assert.deepEqual(f.first.horizon.value.result.horizon.externalInputs.map(row => row.artifact), ["garden-data"], "L1 names the external input");
  const needed = ok(prepareCandidateSources(f.store, { project, candidate: f.request.candidate, neighbors: f.request.neighbors }));
  assert.deepEqual(needed.sources, [], "deriveTasks skips a binding whose producer is its own consumer: no Source is needed");
  // G5 on exactly this list keeps its own finding for this candidate (the work has a result and another outgoing artifact).
  assert.deepEqual(ok(prepareAtomicGate(f.store, { ...f.request, sources: [...needed.sources] })).record.value.result.codes, ["work_artifact_not_single"]);
});

test("R19 №1937-3 H1.1 a second store opening work between the builder's admission and its write makes the write fail; D1 does not move under it", t => {
  const f = basesFixture(t);
  ok(writeRunBases(f.store, { project }));
  const address = { project, block: "garden-consume-block", line: 1 };
  ok(openSeries(f.store, { ...address, slice: "h11-race", predecessor: null, basis: null }));
  decide(f, [{ target: "discovery:encoding", field: "address", value: { consumer: "garden-consume-block", kind: "repository-fact" } }]);
  const d1 = heads(f.store).filter(ref => ref.id.startsWith("om-gap:")), horizons = f.store.list("om-horizon").length;
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
  const race = new Race(f.database);
  t.after(() => race.close());
  const lost = refusal(writeRunBases(race, { project }));
  assert.ok(raced, "The second store opened its attempt right before the horizon write");
  assert.deepEqual([lost.code, lost.at.target], ["run_bases_work_open", `repair-series:${project}:1:garden-consume-block`]);
  assert.deepEqual(heads(f.store).filter(ref => ref.id.startsWith("om-gap:")), d1, "No D1 head moves under the newly opened work");
  assert.equal(f.store.list("om-horizon").length, horizons, "The losing write stored nothing");
});

/** An L3 derivation left unsealed on purpose (№2157 line 3): R2 finished, deriveLayer done, no sealLayer(3). */
function deriveUnsealedL3(engine: ProductEngine, project: string) {
  const draft = engine.refinement.begin(project, "R2");
  answerTechnicalFixture(engine, project, draft);
  engine.refinement.finishResearch(project, "R2", reference(engine.store.get(draft.id)!), 0);
  deriveLayerFixture(engine, project, 3);
}
const worksFrameOf = (store: Store, built: BuiltRunBases) =>
  (routesOf(store, built).value.request.gaps.sources as unknown as { works: { frame: { level: number; layer: Ref | null; frame: Ref | null; upper: unknown } } }).works.frame;
const layerProofLevels = (store: Store) =>
  (store.get<LayerBasis>(`graph-layer:${project}:3`)!.value.layerProofs ?? []).map(proof => proof.level);

test("H1.4 №2157-1 L2 accepted, L3 a shell with inherited proofs only: the build reaches D1/M6/C1 and the level-3 work stays open; repeats and a new store write nothing", t => {
  const f = basesFixture(t, { refineTo: 2 });
  assert.deepEqual(layerProofLevels(f.store), [2], "the shell carries only the inherited L2 proof");
  assert.equal(f.store.get(`phase:${project}:L3`), null);
  const built = ok(writeRunBases(f.store, { project }));
  const works = worksFrameOf(f.store, built);
  assert.equal(works.level, 3);
  assert.deepEqual([works.layer, works.frame], [null, null], "an unaccepted shell never fills the level-3 slot");
  assert.deepEqual(works.upper, { horizon: built.bases.horizon, frame: null }, "the accepted L2 horizon stays the upper basis");
  assert.ok(f.store.get(built.bases.routes.id) && f.store.get(built.bases.queue.id), "D5/M6 and C1 are built");
  assert.ok(f.store.list("gap").length > 0, "D1 is written with the level-3 work open");
  const before = heads(f.store);
  ok(writeRunBases(f.store, { project }));
  assert.deepEqual(heads(f.store), before, "a repeat on the same bases writes nothing");
  f.restart();
  ok(writeRunBases(f.store, { project }));
  assert.deepEqual(heads(f.store), before, "a new store on the same bases writes nothing");
});

test("H1.4 №2157-2 L2 and L3 both accepted: the previous accepted layer and the result are preserved", t => {
  const f = basesFixture(t, { refine: true });
  const built = ok(writeRunBases(f.store, { project }));
  const works = worksFrameOf(f.store, built);
  assert.deepEqual(works.layer, reference(f.store.get(`graph-layer:${project}:3`)!), "the accepted layer keeps the level-3 slot");
  assert.equal(works.frame, null);
  assert.deepEqual(works.upper, { horizon: built.bases.horizon, frame: null });
  const before = heads(f.store);
  ok(writeRunBases(f.store, { project }));
  assert.deepEqual(heads(f.store), before, "a repeat writes nothing");
});

test("H1.4 №2157-3 L3 derived through deriveLayer before phase:L3 is published: the legitimate own proof is not lost", t => {
  const f = basesFixture(t, { refineTo: 2 });
  deriveUnsealedL3(f.engine, project);
  assert.equal(f.store.get(`phase:${project}:L3`), null, "no L3 phase is published yet");
  assert.ok(layerProofLevels(f.store).includes(3), "the derivation left its own level-3 proof");
  const built = ok(writeRunBases(f.store, { project }));
  assert.deepEqual(worksFrameOf(f.store, built).layer, reference(f.store.get(`graph-layer:${project}:3`)!),
    "the proven layer fills the level-3 slot without a published phase");
});

test("H1.4 №2157-4 an accepted L3 stale by its own bases is an addressed refusal, never turned into open work", t => {
  const f = basesFixture(t, { refine: true });
  const built = ok(writeRunBases(f.store, { project }));
  assert.deepEqual(worksFrameOf(f.store, built).layer, reference(f.store.get(`graph-layer:${project}:3`)!));
  const d1 = heads(f.store).filter(ref => ref.id.startsWith("om-gap:"));
  // The layer's own R2 basis moves through a lawful new research result: the accepted layer goes stale.
  const draft = f.engine.refinement.begin(project, "R2");
  answerTechnicalFixture(f.engine, project, draft);
  f.engine.refinement.finishResearch(project, "R2", reference(f.store.get(draft.id)!), 1);
  const lost = refusal(writeRunBases(f.store, { project }));
  assert.deepEqual([lost.code, lost.at.target, lost.at.field], ["frame_basis_unproven", `phase:${project}:R2`, "graph_evidence_stale"],
    "the common acceptance derivation refuses with the original address");
  assert.deepEqual(heads(f.store).filter(ref => ref.id.startsWith("om-gap:")), d1, "no open-work D1 is written instead");
});

test("H1.4 №2157-5 a level-3 derivation between the choice and the D1 write loses the guard; the whole chain is derived again", t => {
  const f = basesFixture(t, { refineTo: 2 });
  let raced = false;
  class Race extends Store {
    override writeMany<T = Json>(writes: Write[], guards?: Parameters<Store["writeMany"]>[1]): Revision<T>[] {
      if (!raced && writes.some(write => write.kind === "gap")) {
        raced = true;
        const other = new Store(f.database);
        try { deriveUnsealedL3(new ProductEngine(other), project); } finally { other.close(); }
      }
      return super.writeMany<T>(writes, guards);
    }
  }
  const race = new Race(f.database);
  t.after(() => race.close());
  const built = ok(writeRunBases(race, { project }));
  assert.ok(raced, "the second store derived L3 right before the D1 write");
  assert.deepEqual(worksFrameOf(race, built).layer, reference(race.get(`graph-layer:${project}:3`)!),
    "the lost guard re-derived the chain onto the proven layer");
});

test("H1.4 №2157-3 a sealed L3 whose head moved without a new phase is the addressed run_bases_basis_stale", t => {
  const f = basesFixture(t, { refine: true });
  const sealedHead = reference(f.store.get(`graph-layer:${project}:3`)!);
  assert.ok(f.store.get(`phase:${project}:L3`));
  // A new derivation moves the level-3 head; the published phase still names the sealed one.
  deriveLayerFixture(f.engine, project, 3);
  assert.notDeepEqual(reference(f.store.get(`graph-layer:${project}:3`)!), sealedHead, "the head moved without a new phase");
  const lost = refusal(writeRunBases(f.store, { project }));
  assert.deepEqual([lost.code, lost.at.target, lost.at.field], ["run_bases_basis_stale", `phase:${project}:L3`, "layer"]);
});
