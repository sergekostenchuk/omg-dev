import { fillObligations, prepareFrame, type FrameRead, type FrameRequest, type FrameScope } from "../src/om/frame-obligations.js";
import type { LayerProposal, ProposalRequest } from "../src/om/frame-proposals.js";
import { gateCandidate, writeCandidate } from "../src/om/frame-candidate.js";
import { settleCandidate } from "../src/om/frame-accept.js";
import { readLayerAcceptance } from "../src/om/layer-basis.js";
import { refusedWith } from "./om-fixture.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { ProductEngine } from "../src/product/engine.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { writeOmInput } from "../src/om/input.js";
import { inputDecisionWrite, writeAddressing, type InputDecisionProposal } from "../src/om/addressing.js";
import { writeGaps, type GapRequest } from "../src/om/gaps.js";
import { gapLineExpectedResult, gapLineKey, writeGapLines } from "../src/om/gap-lines.js";
import { writeOmObligations } from "../src/om/obligations.js";
import { writeWorksFrame } from "../src/om/works-frame.js";
import { writeNeighbors } from "../src/om/neighbors.js";
import { writeAtomicGate } from "../src/om/atomic-gate.js";
import { writeFeasibility } from "../src/om/feasibility.js";
import { resolveSnapshot } from "../src/om/impact.js";
import { writeHandoff } from "../src/om/handoff.js";
import { writeHorizon, prepareHorizonIssuance, writeHorizonIssuance, readHorizonIssuance,
  type HorizonRequest } from "../src/om/horizon.js";
import { completionWorkId, openSeries, readCompletionBinding, readSeriesAt, type RepairSeries } from "../src/om/series.js";
import { prepareSeriesTransition, writeSeriesTransition, readPreparedSeriesTransition, comparePreparedSeriesSlices,
  type PreparedSeriesTransitionRecord } from "../src/om/series-transition.js";
import { writeGuarded } from "../src/om/refs.js";
import { closeAttempt, openAttempt, prepareManagedClaim } from "../src/om/repeat-gate.js";
import { readCompletionWorkAt, runModelCall } from "../src/om/model-call.js";
import { prepareQuestionTasks, writeQuestionPacket } from "../src/om/question-packet.js";
import { writeRoutes } from "../src/om/routes.js";
import type { OmResult, Sealed } from "../src/om/refusal.js";
import { gardenGraph, prepareNativeLayers } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";
import { git } from "../src/runtime/environment.js";
import { nodeSignature, receiptId, type ArtifactReceipt, type CompiledTask } from "../src/compiler/model.js";
import type { TaskRun } from "../src/execution/model.js";

const project = "garden", producer = "garden-produce-block", block = "garden-consume-block", independent = "garden-later-block";
const opaqueSlice = "legacy:opaque-subject", clone = structuredClone;
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
const snapshot = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function rewrite<T>(store: Store, record: Revision<T>, value: T): Revision<T> {
  const database = new DatabaseSync(store.path), hash = hashJson(value);
  try {
    database.exec("DROP TRIGGER IF EXISTS revisions_no_update");
    database.prepare("UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?")
      .run(canonical(value), hash, record.id, record.revision);
  } finally { database.close(); }
  return { ...record, hash, value };
}
function frozen(value: unknown): boolean {
  return value === null || typeof value !== "object" || Object.isFrozen(value) && Object.values(value).every(frozen);
}
class ExactOnlyStore extends Store {
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    assert.notEqual(revision, undefined, `Historical preparation may not select the current head of ${id}`);
    return super.get<T>(id, revision);
  }
  override list<T = Json>(_kind?: string): Revision<T>[] { assert.fail("Historical preparation may not enumerate today's records"); }
}
function fixture(t: TestContext, change: (graph: Graph) => void = () => {}, includeLater = false, addressing = false, repositoryFact = false) {
  const root = mkdtempSync(join(tmpdir(), "omg-series-transition-")), path = join(root, "state.sqlite");
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), source = gardenGraph();
  const { level: _level, ...upper } = projectGraph(source, 1);
  if (includeLater) {
    upper.requirements!.push({ ...clone(upper.requirements![0]!), id: "garden-R2", outcome: "garden-later", statement: "Deliver the later result" });
    upper.nodes.find(node => node.id === independent)!.implements!.push("garden-R2");
  }
  change(upper as Graph);
  preparedFeatures(engine, project, upper as Graph, field => {
    const value = preparedField(project, field);
    if (addressing && field === "preparation") (value as Record<string, Json>).unknowns = [{ id: "unaddressed",
      question: "Which consumer owns this question?", consumer: "unresolved-consumer", moment: "om-pass", blocksCurrentStage: false,
      resolution: "Address the question during OM" }];
    if (repositoryFact && field === "preparation") (value as Record<string, Json>).unknowns = [{ id: "encoding",
      question: "What encoding is supported?", consumer: block, moment: "om-pass", blocksCurrentStage: false,
      resolution: "Read repository facts during OM" }];
    if (includeLater && field === "preparation") {
      const rows = (value as Record<string, Json>).outcomes as Record<string, Json>[];
      rows.push({ ...clone(rows[0]!), id: "garden-later", result: "The later result" });
    }
    if (includeLater && field === "conceptSections") {
      const rows = (value as { requirements: Record<string, Json>[] }[])[0]!.requirements;
      rows.push({ ...clone(rows[0]!), id: "garden-R2", outcome: "garden-later", statement: "Deliver the later result" });
    }
    if (includeLater && field === "operationRequirements") {
      const body = value as Record<string, Json>, rows = body.outcomes as Record<string, Json>[];
      rows.push({ ...clone(rows[0]!), outcome: "garden-later" });
      (body.conceptCoverage as Json[]).push({ requirement: "garden-R2", outcome: "garden-later" });
    }
    if (includeLater && field === "behaviorContracts") {
      const rows = value as Record<string, Json>[];
      rows.push({ ...clone(rows[0]!), id: "garden-B2", requirements: ["garden-R2"], outcome: "garden-later" });
    }
    if (includeLater && (field === "features" || field === "featurePreparation")) {
      const rows = value as Record<string, Json>[];
      rows.push({ ...clone(rows[0]!), [field === "features" ? "title" : "featureTitle"]: "Deliver later result", outcome: "garden-later",
        ...(field === "featurePreparation" ? { requirements: ["garden-R2"], behaviorContracts: ["garden-B2"] } : {}) });
    }
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage,
    reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = repositoryFact ? ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: [{ pending: clone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: "discovery:encoding", field: "address", value: { consumer: block, kind: "repository-fact" } } })) as Write }] })) : base;
  const horizon = (version: string, extra: Partial<HorizonRequest['choice']> = {}) => ok(writeHorizon(store, {
    project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: version, features: [{ outcome: "garden-result" }], excluded: [], ...extra },
  }));
  const series = (owner = block) => ok(openSeries(store, { project, block: owner, line: 1,
    slice: opaqueSlice, predecessor: null, basis: null }));
  return { root, path, input, graph, get store() { return store; }, horizon, series,
    restart() { store.close(); store = new Store(path); } };
}
function request(horizon: Ref, series: readonly Ref[], choiceVersion = "choice-1") {
  return { project, choiceVersion, horizon, series: [...series] };
}
function decision(record: Sealed<Revision<PreparedSeriesTransitionRecord>>, owner = block) {
  const found = record.value.decisions.find(item => item.block === owner);
  assert.ok(found, `Missing decision for ${owner}`);
  return found;
}
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
const adapterFixture = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));

/** LG07 st-a: the consuming block's own repository-fact carrier — the question declared in the input materials and
 *  addressed by writeAddressing goes through D1 gaps, question tasks and the M6 route into one whole MC1 batch. */
function managedRoutes(f: ReturnType<typeof fixture>, horizon: Ref) {
  const input = reference(f.input), graph = reference(f.graph);
  const sources: GapRequest = { project, input, graph, horizon,
    operations: { proposals: [], frame: { project, level: 2, graph, horizon, layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(f.store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(f.store, sources)), gapRequest = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = ok(prepareQuestionTasks(f.store, { project, gaps: gapRequest,
    questions: gaps.records.filter(row => row.value.gap.kind === "repository-fact" && row.value.gap.code !== "inventory_missing" && !row.value.gap.deferral)
      .map(gap => ({ gap: reference(gap), requirements: [{ pointer: "/contracts/0" }], resultForm: { type: "string" as const } })) }));
  const routes = ok(writeRoutes(f.store, { project, gaps: gapRequest, tasks: tasks.tasks.map(task => ({ pending: clone(task.writes[0]!) as Write })),
    catalog: { paths: ["e4-source.txt"], records: [] }, previous: null }));
  writeFileSync(join(f.root, "e4-source.txt"), "UTF-8 is supported.");
  const batch = routes.value.batches.find(row => row.model === "MC1" && row.items.some(item => item.target === "discovery:encoding"));
  assert.ok(batch, "The addressed repository-fact question is routed into the consuming block's MC1 batch");
  const goal = { key: "current:fact", questions: batch.items.map(item => gapLineKey(project, item.target, item.field)).sort(),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  return { routes, batch, goal, completion: { routes: reference(routes), batches: [batch.id] } };
}

/** LG07 st-a: three managed attempts stop the line — each opened with its own completion plan, paid by one real
 *  off-form model call through its own E2 packet and closed through G7 with the claim the registry derives. */
async function managedStop(f: ReturnType<typeof fixture>, carrier: ReturnType<typeof managedRoutes>, count = 3) {
  const engine = new ProductEngine(f.store), scenario = join(f.root, "scenario.json"), trace = join(f.root, "trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const environment = engine.environments.configure(project, { workspace: f.root,
    implementer: { actor: "current-worker", model: "fixture", effort: "high", speed: "fast", command },
    reviewer: { actor: "current-reviewer", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5000, requestCapacityChars: 100000 }, 0);
  const adapter = f.store.write({ id: `adapter:${project}:current`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: project, protocol: "codex-stdio" } });
  writeFileSync(scenario, JSON.stringify({ database: f.store.path,
    steps: Array.from({ length: count }, () => ({ research: { malformed: true }, usage })) }));
  for (let attempt = 1; attempt <= count; attempt++) {
    const series = ok(openAttempt(f.store, { project, block, line: 1, attempt, goal: carrier.goal, completion: carrier.completion }));
    const binding = ok(readCompletionBinding(f.store, project, reference(series), attempt));
    assert.ok(binding); assert.deepEqual(binding.value.plan, carrier.completion);
    const packet = ok(writeQuestionPacket(f.store, { project, routes: reference(carrier.routes), batch: carrier.batch.id,
      environment: reference(environment), attempt: { series: reference(series), ordinal: attempt }, previous: [] })).record;
    const physical = ok(await runModelCall(f.store, { project, packet: reference(packet),
      dispatch: { adapter: reference(adapter), config: reference(environment) }, role: "implementer" }));
    assert.ok(physical.diagnostic);
    const work = ok(readCompletionWorkAt(f.store, project, reference(f.store.get(completionWorkId(project, binding.id))!)));
    assert.equal(work.complete, true);
    const claim = ok(prepareManagedClaim(f.store, { project, block, line: 1, attempt,
      outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } }));
    ok(closeAttempt(f.store, { project, block, line: 1, attempt, outcome: claim.outcome }));
  }
  assert.equal((existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) : []).length, count,
    "Each stopped attempt has its own physical producer");
  const stopped = f.store.get<RepairSeries>(`repair-series:${project}:1:${block}`)!;
  assert.ok(stopped.value.stop); assert.deepEqual(stopped.value.stop!.attempts, [1, 2, 3]);
  assert.deepEqual(stopped.value.attempts.map(item => item.outcome?.reason), ["off-form", "off-form", "off-form"]);
  return stopped;
}

/** LG07 st-rest (№10753 п.6): the stopped supplier's series is produced by its own managed work in this store — the
 *  question declared in the input materials and addressed to garden-produce-block goes through D1, the M6 route into
 *  the block's whole MC1 batch, and three real E2→E4 off-form calls, each opened with the exact completion plan and
 *  closed through G7. */
async function managedSupplierStop(store: Store, engine: ProductEngine, root: string, workspace: string): Promise<Revision<RepairSeries>> {
  const graph = reference(store.get<Graph>(`graph:${project}`)!), input = reference(store.get(`om-input:${project}`)!);
  const l2 = reference(store.get(`graph-layer:${project}:2`)!), l3 = reference(store.get(`graph-layer:${project}:3`)!);
  const horizon = ok(writeHorizon(store, { project, input, graph, refinement: l2, available: {},
    choice: { choiceVersion: "supplier-stop", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const horizonRef = reference(horizon.gate);
  assert.ok(horizon.horizon.value.result.horizon.nodes.includes(producer),
    "Without executed receipts the supplier stays inside the horizon and must answer its own question");
  const upperFrame = reference(store.get(`om-frame:${project}:2`)!), worksFrame = reference(store.get(`om-frame:${project}:3`)!);
  const sources: GapRequest = { project, input, graph, horizon: horizonRef,
    operations: { proposals: [], frame: { project, level: 2, graph, horizon: horizonRef, layer: l2, frame: upperFrame, upper: null } },
    works: { proposals: [], frame: { project, level: 3, graph, horizon: horizonRef, layer: l3,
      frame: worksFrame, upper: { horizon: horizonRef, frame: upperFrame }, workZoneContract: "accepted-l2-v1" } } };
  const gaps = ok(writeGaps(store, sources)), gapRequest = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = ok(prepareQuestionTasks(store, { project, gaps: gapRequest,
    questions: gaps.records.filter(row => row.value.gap.kind === "repository-fact" && row.value.gap.code !== "inventory_missing" && !row.value.gap.deferral)
      .map(gap => ({ gap: reference(gap), requirements: [{ pointer: "/contracts/0" }], resultForm: { type: "string" as const } })) }));
  const routes = ok(writeRoutes(store, { project, gaps: gapRequest, tasks: tasks.tasks.map(task => ({ pending: clone(task.writes[0]!) as Write })),
    catalog: { paths: ["supplier-source.txt"], records: [] }, previous: null }));
  writeFileSync(join(root, "supplier-source.txt"), "The supplier's repository fact answer.");
  const batch = routes.value.batches.find(row => row.model === "MC1" && row.items.some(item => item.target === "discovery:supplier-fact"));
  assert.ok(batch, "The supplier's own question is routed into the supplier block's whole MC1 batch");
  const goal = { key: "current:supplier-fact", questions: batch.items.map(item => gapLineKey(project, item.target, item.field)).sort(),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  const completion = { routes: reference(routes), batches: [batch.id] };
  const scenario = join(root, "supplier-scenario.json"), trace = join(root, "supplier-trace.jsonl");
  const command = { executable: process.execPath, args: [adapterFixture, "--scenario", scenario, "--trace", trace] };
  const environment = engine.environments.configure(project, { workspace,
    implementer: { actor: "current-worker", model: "fixture", effort: "high", speed: "fast", command },
    reviewer: { actor: "current-reviewer", model: "fixture-reviewer", effort: "medium", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5000, requestCapacityChars: 100_000 },
    engine.environments.get(project).revision);
  const adapter = store.write({ id: `adapter:${project}:supplier`, kind: "dispatch-adapter", expected: 0,
    value: { projectId: project, protocol: "codex-stdio" } });
  writeFileSync(scenario, JSON.stringify({ database: store.path,
    steps: Array.from({ length: 3 }, () => ({ research: { malformed: true }, usage })) }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const attemptSeries = ok(openAttempt(store, { project, block: producer, line: 1, attempt, goal, completion }));
    const binding = ok(readCompletionBinding(store, project, reference(attemptSeries), attempt));
    assert.ok(binding); assert.deepEqual(binding.value.plan, completion);
    const packet = ok(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id,
      environment: reference(environment), attempt: { series: reference(attemptSeries), ordinal: attempt }, previous: [] })).record;
    const physical = ok(await runModelCall(store, { project, packet: reference(packet),
      dispatch: { adapter: reference(adapter), config: reference(environment) }, role: "implementer" }));
    assert.ok(physical.diagnostic);
    const work = ok(readCompletionWorkAt(store, project, reference(store.get(completionWorkId(project, binding.id))!)));
    assert.equal(work.complete, true);
    const claim = ok(prepareManagedClaim(store, { project, block: producer, line: 1, attempt,
      outcome: { reason: "result", accepting: [], cancelling: [], refusals: [] } }));
    ok(closeAttempt(store, { project, block: producer, line: 1, attempt, outcome: claim.outcome }));
  }
  assert.equal((existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) : []).length, 3,
    "Each stopped attempt has its own physical producer");
  const stopped = store.get<RepairSeries>(`repair-series:${project}:1:${producer}`)!;
  assert.ok(stopped.value.stop); assert.deepEqual(stopped.value.stop!.attempts, [1, 2, 3]);
  assert.deepEqual(stopped.value.attempts.map(item => item.outcome?.reason), ["off-form", "off-form", "off-form"]);
  return stopped;
}

/** The same current OM route the garden fixture drives natively: L2 admission, addressing, L3 and the M8 handoff. */
function nativeSetup(engine: ProductEngine, desired: Graph) {
  const store = engine.store;
  let input = ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const graphRef = reference(store.get(`graph:${project}`)!);
  const first = ok(writeHorizon(store, { project, input: reference(input), graph: graphRef,
    refinement: null, available: {}, choice: { choiceVersion: "fixture-operations", features: [{ outcome: `${project}-result` }], excluded: [] } }));
  const proposal = (frame: FrameRead): Ref => {
    const graph = structuredClone(desired), level = frame.request.level;
    if (level === 3) {
      for (const field of ["nodes", "artifacts", "contracts", "anchors", "joins", "tests", "edges", "journeys", "packets", "transfers"] as const) {
        const upper = frame.upper[field] ?? [], ids = new Set(upper.map(item => item.id));
        Object.assign(graph, { [field]: [...structuredClone(upper), ...(graph[field] ?? []).filter(item => !ids.has(item.id))] });
      }
      graph.connectors = frame.upper.connectors.map(upper => ({ ...structuredClone(upper),
        wakeTest: desired.connectors.find(connector => connector.id === upper.id)?.wakeTest ?? upper.wakeTest, bindings: [...structuredClone(upper.bindings),
        ...(desired.connectors.find(connector => connector.id === upper.id)?.bindings ?? []).filter(binding => binding.level === 3)] }));
    }
    const projected = projectGraph(graph, level);
    const mapped = ok(fillObligations(frame.upper, frame.scope,
      { graph, reference: { ...frame.request.graph, hash: hashJson(graph) }, frame: null }, frame.upperRef, level));
    const nodes = projected.nodes.filter(node => node.kind === (level === 2 ? "operation" : "work")
      && (level === 2 || frame.scope.nodes.includes(node.parent!))), selected = new Set(nodes.map(node => node.id));
    const value: LayerProposal = { base: { graph: frame.request.graph, frame: null }, level,
      ...(level === 3 ? { worksContract: "works-frame/v1" as const } : {}), source: "decision", status: "proposed", nodes,
      fills: mapped.fills.filter(fill => selected.has(fill.node)).map(fill => {
        return { obligation: fill.obligation, node: fill.node,
        ...(fill.port === undefined ? {} : { port: fill.port,
          ...(level === 3 ? { codeRef: structuredClone(nodes.find(node => node.id === fill.node)!.code[0]!) } : {}) }) }; }),
      localConnectors: level === 3 ? [] : projected.connectors.map(connector => ({ ...connector,
        bindings: connector.bindings.filter(binding => binding.level === 2) })).filter(connector => connector.bindings.length),
      artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
      tests: projected.tests.filter(test => level === 2 || selected.has(test.node)), edges: projected.edges ?? [],
      journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
      anchors: level === 2 ? projected.anchors : [], removes: [], replaces: [], redefines: [] };
    return reference(store.write({ id: `om-proposal:${project}:fixture-${level}`, kind: "layer-proposal", expected: 0, value }));
  };
  const frame2: FrameRequest = { project, level: 2, graph: graphRef, horizon: reference(first.gate), layer: null, frame: null, upper: null };
  const candidate2 = ok(writeCandidate(store, { frame: frame2, proposals: [proposal(structuredClone(ok(prepareFrame(store, frame2))) as unknown as FrameRead)] }));
  assert.equal(candidate2.state, "candidate");
  if (candidate2.state !== "candidate") assert.fail("Native L2 candidate is required");
  const gate2 = ok(gateCandidate(store, { project, candidate: reference(candidate2.record) }));
  const accepted2 = ok(settleCandidate(store, { project, level: 2, candidate: reference(candidate2.record),
    outcome: { gate: "G3", candidate: gate2.candidate, graphHash: gate2.graphHash, passed: gate2.passed, codes: gate2.findings.map(finding => finding.code) } }));
  assert.equal(accepted2.state, "accepted"); assert.ok(accepted2.graph && accepted2.layer && accepted2.frame);
  const graph = reference(accepted2.graph), layer = reference(accepted2.layer), upperFrame = reference(accepted2.frame);
  const decisions: InputDecisionProposal["decision"][] = [
    { target: `${project}-B1`, field: "nodes", value: [`${project}-produce-block`, `${project}-consume-block`] },
    { target: `${project}-B1`, field: "state", value: { writer: `${project}-produce-block`, authority: `${project}-consume-block`, rollback: `${project}-consume-block` } },
    { target: `${project}-R1#1`, field: "checkKind", value: "test" },
  ];
  input = ok(writeAddressing(store, { project, input: reference(input), graph,
    decisions: decisions.map(decision => ({ pending: inputDecisionWrite({ project, input: reference(input), graph, layers: [], decision }) as Write })) }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph, refinement: layer, available: {},
    choice: { choiceVersion: "fixture-works", features: [{ outcome: `${project}-result` }], excluded: [] } }));
  const frame3: FrameRequest = { project, level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
    upper: { horizon: reference(horizon.gate), frame: upperFrame } };
  const works: ProposalRequest = { frame: frame3, proposals: [proposal(structuredClone(ok(prepareFrame(store, frame3))) as unknown as FrameRead)] };
  const gaps = ok(writeGaps(store, { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { frame: { ...frame2, graph, layer, frame: upperFrame, horizon: reference(horizon.gate) }, proposals: [] }, works }));
  const gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const handoff = ok(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [] }));
  assert.deepEqual(handoff.handoff.obligations, []);
  return { store, input, graph, layer, upperFrame, horizon, frame3, works, gapRead, handoff,
    environment: reference(engine.environments.get(project)) };
}

function nativeExecuted(engine: ProductEngine, desired: Graph, sources: Ref[] = []): void {
  const { store, works, gapRead, handoff, environment } = nativeSetup(engine, desired);
  const candidate3 = ok(writeWorksFrame(store, { ...works, works: { contract: "works-frame/v1",
    producer: reference(handoff.producer), ledger: reference(handoff.record), bindings: [] } }));
  assert.equal(candidate3.state, "candidate");
  if (candidate3.state !== "candidate") throw new EngineError("om_fixture_invalid", "Native L3 candidate is required");
  const neighbors = ok(writeNeighbors(store, { project, candidate: reference(candidate3.record) }));
  const gate3 = ok(writeAtomicGate(store, { project, candidate: reference(candidate3.record), neighbors: reference(neighbors),
    environment, gaps: gapRead, results: [], sources, snapshot: resolveSnapshot(engine.environments.get(project).value.workspace) }));
  assert.equal(gate3.value.result.passed, true, canonical(gate3.value.result.findings));
  const accepted3 = ok(settleCandidate(store, { project, level: 3, candidate: reference(candidate3.record),
    outcome: { ...gate3.value.result, codes: [...gate3.value.result.codes], basis: reference(gate3) } }));
  assert.equal(accepted3.state, "accepted"); assert.ok(accepted3.graph && accepted3.layer && accepted3.frame);
  const feasibility = ok(writeFeasibility(store, { project, graph: reference(accepted3.graph), layer: reference(accepted3.layer),
    frame: reference(accepted3.frame), environment, expected: 0 }));
  assert.equal(feasibility.value.ready, true);
  ok(writeHandoff(store, { project, feasibility: reference(feasibility), expected: 0 }));
}

test("prepared transition establishes an active legacy basis without changing its stopped series", async t => {
  const f = fixture(t, () => {}, false, false, true), horizon = f.horizon("choice-1");
  f.series(); const series = await managedStop(f, managedRoutes(f, reference(horizon.gate))), before = snapshot(f.store);
  const prepared = ok(prepareSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  assert.deepEqual(snapshot(f.store), before, "Preparing P is read-only");
  const row = decision(prepared.record);
  assert.equal(prepared.record.value.contract, "om-series-transition/v1");
  assert.equal(prepared.record.value.state, "prepared");
  assert.equal(row.participation, "active");
  assert.equal(row.outcome, "establish-basis");
  assert.equal(row.previousSlice, opaqueSlice);
  assert.deepEqual(row.series, reference(series));
  assert.equal(row.slice?.contract, "series-slice/v1");
  assert.match(row.slice!.hash, /^[a-f0-9]{64}$/);
  assert.equal(prepared.record.hash, hashJson(prepared.record.value));
  assert.ok(frozen(prepared));
  const saved = ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  assert.deepEqual(saved, prepared.record);
  assert.deepEqual(f.store.get(series.id), series);
  assert.deepEqual(ok(readSeriesAt(f.store, project, reference(series))), series);
  assert.deepEqual(ok(readPreparedSeriesTransition(f.store, { project, record: reference(saved) })).record, saved);
});

test("prepared participation retains excluded and unselected legacy lines without inventing active slices", t => {
  const f = fixture(t), a = f.series(), b = f.series(independent), c = f.series("garden-refusal-block");
  const horizon = f.horizon("choice-1", { excluded: [{ block: independent, reason: "Not selected", returnCondition: "Select later feature" }] });
  const before = [a, b, c].map(row => f.store.get(row.id));
  const prepared = ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(c), reference(b), reference(a)])));
  assert.equal(decision(prepared).outcome, "establish-basis");
  for (const [owner, participation] of [[independent, "excluded"], ["garden-refusal-block", "unselected"]] as const) {
    const row = decision(prepared, owner);
    assert.equal(row.participation, participation); assert.equal(row.outcome, "inactive");
    assert.equal(row.slice, null); assert.equal(row.previousSlice, opaqueSlice);
  }
  assert.deepEqual([a, b, c].map(row => f.store.get(row.id)), before);
  const reverse = ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(a), reference(b), reference(c)])));
  assert.deepEqual(reverse, prepared, "Only sets are normalized; caller ordering cannot create another P");
});

test("choice labels and independent exclusions do not change a proven active block slice", t => {
  const f = fixture(t), series = f.series();
  const first = f.horizon("choice-1"), second = f.horizon("choice-2", {
    excluded: [{ block: independent, reason: "Unrelated scope choice", returnCondition: "Select later feature" }],
  });
  const a = ok(writeSeriesTransition(f.store, request(reference(first.gate), [reference(series)])));
  const b = ok(writeSeriesTransition(f.store, request(reference(second.gate), [reference(series)], "choice-2")));
  assert.notDeepEqual(a.value.request.horizon, b.value.request.horizon);
  assert.deepEqual(decision(a).slice, decision(b).slice);
  assert.equal(ok(comparePreparedSeriesSlices(f.store, { project, previous: reference(a), next: reference(b), block })), "continue");
  assert.deepEqual(f.store.get(series.id), series, "Content comparison is not application or a new admission");
});

test("the local slice includes necessary providers but not other consumers of their shared connector", t => {
  const first = fixture(t), second = fixture(t, graph => {
    graph.nodes.find(node => node.id === independent)!.title = "A changed independent consumer";
    graph.nodes.find(node => node.id === independent)!.ports.push({ id: "second-in", direction: "in", contract: "garden-contract" });
    graph.connectors.find(connector => connector.id === "garden-flow")!.bindings[0]!.consumers.push({ node: independent, port: "second-in" });
  });
  const prepare = (f: ReturnType<typeof fixture>) => {
    const horizon = f.horizon("choice-1"), series = f.series();
    return ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  };
  const a = decision(prepare(first)), b = decision(prepare(second));
  assert.deepEqual(a.slice, b.slice);
  const text = canonical(a.slice!.body);
  assert.ok(text.includes(producer)); assert.ok(text.includes(block));
  assert.equal(text.includes("second-in"), false);
  assert.equal(text.includes("A changed independent consumer"), false);
});

test("local node and used schema changes alter the semantic slice while set ordering does not", t => {
  const base = fixture(t), reordered = fixture(t, graph => {
    graph.nodes.reverse(); graph.artifacts.reverse(); graph.contracts.reverse(); graph.connectors.reverse();
    for (const connector of graph.connectors) { connector.bindings.reverse(); for (const binding of connector.bindings) binding.consumers.reverse(); }
  });
  const title = fixture(t, graph => { graph.nodes.find(node => node.id === block)!.title += " changed"; });
  const schema = fixture(t, graph => { graph.contracts.find(contract => contract.id === "garden-contract")!.schema = { type: "string", minLength: 2 }; });
  const local = (f: ReturnType<typeof fixture>) => {
    const horizon = f.horizon("choice-1"), series = f.series();
    return decision(ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])))).slice;
  };
  const expected = local(base);
  assert.deepEqual(local(reordered), expected);
  assert.notDeepEqual(local(title), expected);
  assert.notDeepEqual(local(schema), expected);
});

test("a significant array order in a used schema is retained rather than normalized as a set", t => {
  const first = fixture(t, graph => { graph.contracts[0]!.schema = { type: "string", enum: ["first", "second"] }; });
  const second = fixture(t, graph => { graph.contracts[0]!.schema = { type: "string", enum: ["second", "first"] }; });
  const slice = (f: ReturnType<typeof fixture>) => {
    const h = f.horizon("choice-1"), s = f.series();
    return decision(ok(writeSeriesTransition(f.store, request(reference(h.gate), [reference(s)])))).slice;
  };
  assert.notDeepEqual(slice(first), slice(second));
});

test("a locally named test retains its full contract and the significant command argument order", t => {
  const withTest = (args: string[], resources = ["local-a", "local-b"]) => sharedAcceptedL2(t, graph => {
    const test = clone(gardenGraph().tests.find(item => item.node === "garden-consume-work")!);
    test.id = "garden-consume-operation-check"; test.node = "garden-consume-operation";
    test.command = { executable: "node", args }; test.covers = ["garden-flow"];
    test.contract!.resourceClass = "own_dirs"; test.contract!.resources = resources;
    const node = graph.nodes.find(node => node.id === test.node)!;
    node.code = clone(graph.nodes.find(node => node.id === "garden-consume-work")!.code);
    node.tests.push(test.id); graph.tests.push(test);
  });
  const first = withTest(["first", "second"]), second = withTest(["second", "first"]);
  const reordered = withTest(["first", "second"], ["local-b", "local-a"]);
  const slice = (f: ReturnType<typeof sharedAcceptedL2>) => decision(f.record).slice;
  const a = slice(first), b = slice(second);
  assert.notDeepEqual(a, b);
  assert.deepEqual(slice(reordered), a, "Declared resource sets are canonical, unlike command arguments");
  const body = a!.body as Record<string, Json>, selected = (body.tests as Record<string, Json>[])
    .find(item => item.id === "garden-consume-operation-check")!;
  assert.deepEqual(selected.command, { executable: "node", args: ["first", "second"] });
  assert.deepEqual(selected.contract, first.accepted.graph!.value.tests.find(item => item.id === selected.id)!.contract);
});

test("multiple incoming bindings retain their exact endpoint multiplicity without including independent consumers", t => {
  const f = fixture(t, graph => {
    const { level: _level, ...cross } = projectGraph(gardenGraph("cross"), 1); Object.assign(graph, cross);
  }), h = f.horizon("choice-1"), s = f.series();
  const row = decision(ok(writeSeriesTransition(f.store, request(reference(h.gate), [reference(s)]))));
  const body = row.slice!.body as Record<string, Json>;
  const flow = (body.connectors as Record<string, Json>[]).find(item => item.id === "garden-flow")!;
  const bindings = flow.bindings as { producer: { node: string; port: string }; consumers: { node: string; port: string }[] }[];
  assert.equal(bindings.length, 2);
  assert.equal(bindings.flatMap(binding => binding.consumers).length, 3);
  assert.ok(bindings.every(binding => binding.producer.node === producer && binding.consumers.every(consumer => consumer.node === block)));
  assert.deepEqual(bindings.map(binding => [binding.producer.port, binding.consumers.map(item => item.port).sort()]).sort(),
    [["out", ["in", "in-alt"]], ["out-alt", ["in"]]]);
});

test("P public inputs are explicit, an empty named series set is legal, and a mechanism cannot be treated as a block", t => {
  const f = fixture(t, () => {}, false, true), horizon = f.horizon("choice-1"), series = f.series();
  const given = request(reference(horizon.gate), [reference(series)]);
  const invalid = (action: () => unknown) => assert.throws(action,
    (error: unknown) => error instanceof EngineError && error.code === "series_transition_request_invalid");
  for (const key of ["project", "choiceVersion", "horizon", "series"] as const) {
    const missing = clone(given) as Record<string, unknown>; delete missing[key];
    invalid(() => prepareSeriesTransition(f.store, missing as typeof given));
    invalid(() => writeSeriesTransition(f.store, missing as typeof given));
    invalid(() => prepareSeriesTransition(f.store, { ...given, [key]: null }));
  }
  const empty = ok(writeSeriesTransition(f.store, { ...given, series: [] }));
  assert.deepEqual(empty.value.decisions, []);
  refusedWith(comparePreparedSeriesSlices(f.store, { project, previous: reference(empty), next: reference(empty), block }), "series_transition_unproven");
  invalid(() => readPreparedSeriesTransition(f.store, { project } as { project: string; record: Ref }));
  invalid(() => comparePreparedSeriesSlices(f.store, { project, previous: reference(empty), next: reference(empty) } as Parameters<typeof comparePreparedSeriesSlices>[1]));
  const sources: GapRequest = { project, input: reference(f.input), graph: reference(f.graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(f.graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(f.store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(f.store, sources));
  const mechanism = ok(openSeries(f.store, { project, owner: { kind: "mechanism", mechanism: "M5:addressing" }, line: 1,
    predecessor: null, basis: null, scope: { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) } }));
  refusedWith(prepareSeriesTransition(f.store, { ...given, series: [reference(mechanism)] }), "series_transition_unproven");
  const next = ok(openSeries(f.store, { project, block, line: 2, slice: "legacy:successor", predecessor: reference(series),
    basis: { ground: "inputs-changed", text: "The legacy owner changed the subject" } }));
  refusedWith(prepareSeriesTransition(f.store, { ...given, series: [reference(series), reference(next)] }), "series_transition_unproven");
});

test("P carries graph, stage, input and evidence guards to the same final transaction", t => {
  for (const kind of ["graph", "stage", "input", "evidence"] as const) {
    const f = fixture(t), h = f.horizon("choice-1"), s = f.series();
    const prepared = ok(prepareSeriesTransition(f.store, request(reference(h.gate), [reference(s)])));
    const other = new Store(f.path), engine = new ProductEngine(other);
    try {
      if (kind === "graph") {
        const changed = clone(f.graph.value); changed.nodes.find(node => node.id === block)!.title += " revised";
        const next = engine.graphs.save(project, changed, f.graph.revision, "owner"); assert.notDeepEqual(reference(next), reference(f.graph));
      }
      if (kind === "stage") {
        const old = other.get<{ content: Json }>(`stage:${project}:features`)!;
        engine.pipeline.draft(project, "features", old.value.content, old.revision);
      }
      if (kind === "input") ok(writeAddressing(other, { project, input: reference(f.input), graph: reference(f.graph),
        decisions: [{ pending: clone(inputDecisionWrite({ project, input: reference(f.input), graph: reference(f.graph), layers: [],
          decision: { target: "garden-B1", field: "nodes", value: [block] } })) }] }));
      if (kind === "evidence") {
        const old = other.get(`source:${project}:brief`)!;
        engine.discovery.evidence.document(project, "brief", "A changed owner brief", "text/plain", old.revision);
      }
    } finally { other.close(); }
    refusedWith(writeGuarded(f.store, { unit: "B3", target: prepared.record.id,
      writes: [...prepared.writes, { id: `neighbor:${kind}`, kind: "test", expected: 0, value: {} }], guards: prepared.guards }), "input_stale");
    assert.equal(f.store.get(prepared.record.id), null, kind); assert.equal(f.store.get(`neighbor:${kind}`), null, kind);
  }
});

test("prepared source CAS rejects a series changed by a second Store and writes no neighboring record", t => {
  const f = fixture(t, () => {}, false, false, true), horizon = f.horizon("choice-1"), series = f.series();
  const carrier = managedRoutes(f, reference(horizon.gate));
  const prepared = ok(prepareSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  const other = new Store(f.path);
  try { ok(openAttempt(other, { project, block, line: 1, attempt: 1, goal: carrier.goal, completion: carrier.completion })); }
  finally { other.close(); }
  const winner = snapshot(f.store);
  refusedWith(writeGuarded(f.store, { unit: "B3.0a", target: prepared.record.id,
    writes: [...prepared.writes, { id: "transition-neighbor", kind: "test", expected: 0, value: {} }], guards: prepared.guards }), "input_stale");
  assert.deepEqual(snapshot(f.store), winner, "The refused common write leaves no record of its own");
  assert.equal(f.store.get(prepared.record.id), null); assert.equal(f.store.get("transition-neighbor"), null);
});

test("prepared history remains exact after source heads advance and the Store is reopened", t => {
  const f = fixture(t, () => {}, false, false, true), horizon = f.horizon("choice-1"), series = f.series();
  const carrier = managedRoutes(f, reference(horizon.gate));
  const prepared = ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  const opened = ok(openAttempt(f.store, { project, block, line: 1, attempt: 1, goal: carrier.goal, completion: carrier.completion }));
  assert.ok(opened.revision > series.revision, "A real managed opening advances the series head");
  const source = f.store.get(`source:${project}:brief`)!;
  f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try { assert.deepEqual(ok(readPreparedSeriesTransition(exact, { project, record: reference(prepared) })).record, prepared); }
  finally { exact.close(); }
  const beforeRepeat = snapshot(f.store);
  assert.deepEqual(ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)]))), prepared);
  assert.deepEqual(snapshot(f.store), beforeRepeat, "An exact repeat of P writes nothing");
});

test("prepared records require exact source references and rederive decisions instead of trusting saved hashes", t => {
  const f = fixture(t), horizon = f.horizon("choice-1"), series = f.series();
  const valid = request(reference(horizon.gate), [reference(series)]), before = snapshot(f.store);
  const sources: [typeof valid, string][] = [
    [{ ...valid, horizon: { ...valid.horizon, hash: "0".repeat(64) } }, "record_forged"],
    [{ ...valid, horizon: { ...valid.horizon, revision: 900 } }, "record_missing"],
    [{ ...valid, horizon: { ...valid.horizon, id: "om-horizon:other:choice-1" } }, "record_foreign"],
    [{ ...valid, series: [{ ...reference(series), hash: "0".repeat(64) }] }, "record_forged"],
    [{ ...valid, series: [{ ...reference(series), revision: 900 }] }, "record_missing"],
    [{ ...valid, series: [reference(series), reference(series)] }, "series_transition_unproven"],
    [{ ...valid, choiceVersion: "another-choice" }, "series_transition_unproven"],
  ];
  for (const [source, code] of sources) refusedWith(prepareSeriesTransition(f.store, source), code);
  assert.deepEqual(snapshot(f.store), before);
  const saved = ok(writeSeriesTransition(f.store, valid));
  const mutations: ((value: Record<string, any>) => void)[] = [
    value => { delete value.contract; },
    value => { delete value.request; },
    value => { delete value.decisions; },
    value => { value.decisions = []; },
    value => { value.decisions[0].outcome = "continue"; },
    value => { value.decisions[0].slice.body = {}; value.decisions[0].slice.hash = hashJson({}); },
    value => { value.decisions[0].slice.hash = "0".repeat(64); },
    value => { value.decisions[0].previousSlice = "invented-legacy-subject"; },
    value => { value.decisions[0].participation = "boundary"; },
  ];
  for (const mutate of mutations) {
    const value = clone(saved.value) as Record<string, any>; mutate(value);
    const changed = rewrite(f.store, saved, value as PreparedSeriesTransitionRecord);
    refusedWith(readPreparedSeriesTransition(f.store, { project, record: reference(changed) }), "series_transition_unproven");
    f.restart();
    refusedWith(readPreparedSeriesTransition(f.store, { project, record: reference(changed) }), "series_transition_unproven");
    rewrite(f.store, saved, clone(saved.value) as PreparedSeriesTransitionRecord);
    assert.deepEqual(ok(readPreparedSeriesTransition(f.store, { project, record: reference(saved) })).record, saved);
  }
  f.restart();
  assert.deepEqual(ok(readPreparedSeriesTransition(f.store, { project, record: reference(saved) })).record, saved);
});

test("G2 issuance binds the saved P and accepted H without changing either source or any series", t => {
  const f = fixture(t), horizon = f.horizon("choice-1"), series = f.series();
  const transition = ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  const given = { project, choiceVersion: "choice-1", horizon: reference(horizon.gate), transition: reference(transition) };
  const before = snapshot(f.store), prepared = ok(prepareHorizonIssuance(f.store, given));
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(prepared.writes.length, 1); assert.equal(prepared.writes[0]!.kind, "om-horizon-issuance");
  assert.equal(prepared.record.value.state, "accepted"); assert.deepEqual(prepared.record.value.codes, []);
  assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(reference(transition))));
  const saved = ok(writeHorizonIssuance(f.store, given));
  assert.deepEqual(saved, prepared.record);
  assert.deepEqual(snapshot(f.store).filter(row => row.head.id !== saved.id), before);
  assert.ok(frozen(saved)); assert.equal(saved.hash, hashJson(saved.value));
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try { assert.deepEqual(ok(readHorizonIssuance(exact, { project, record: reference(saved) })).record, saved); }
  finally { exact.close(); }
  assert.deepEqual(ok(writeHorizonIssuance(f.store, given)), saved);
});

test("G2 refuses incomplete, foreign and mismatched issuance sources and recomputes saved content", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
  const f = fixture(t), first = f.horizon("choice-1"), second = f.horizon("choice-2"), series = f.series();
  const transition = ok(writeSeriesTransition(f.store, request(reference(first.gate), [reference(series)])));
  const given = { project, choiceVersion: "choice-1", horizon: reference(first.gate), transition: reference(transition) };
  for (const field of ["project", "choiceVersion", "horizon", "transition"] as const) {
    const missing = clone(given) as Record<string, unknown>; delete missing[field];
    refusedWith(prepareHorizonIssuance(f.store, missing as typeof given), "horizon_issuance_request_invalid");
    refusedWith(writeHorizonIssuance(f.store, missing as typeof given), "horizon_issuance_request_invalid");
  }
  for (const change of [
    { ...given, choiceVersion: "choice-2", horizon: reference(second.gate) },
    { ...given, choiceVersion: "choice-2" },
  ]) refusedWith(prepareHorizonIssuance(f.store, change), "horizon_issuance_binding_invalid");
  for (const field of ["horizon", "transition"] as const) {
    refusedWith(prepareHorizonIssuance(f.store, { ...given, [field]: { ...given[field], revision: 900 } }), "record_missing");
    refusedWith(prepareHorizonIssuance(f.store, { ...given, [field]: { ...given[field], hash: "0".repeat(64) } }), "record_forged");
    refusedWith(prepareHorizonIssuance(f.store, { ...given, [field]: { ...given[field], id: `${field}:other` } }), "record_foreign");
  }
  const refusedHorizon = f.horizon("refused", { excluded: [{ block: producer, reason: "Excluded producer", returnCondition: "Select provider" }] });
  assert.equal(refusedHorizon.gate.value.state, "refused");
  refusedWith(prepareHorizonIssuance(f.store, { ...given, choiceVersion: "refused", horizon: reference(refusedHorizon.gate) }), "horizon_issuance_binding_invalid");
  const saved = ok(writeHorizonIssuance(f.store, given));
  for (const mutate of [
    (value: Record<string, any>) => { delete value.transition; },
    (value: Record<string, any>) => { delete value.contract; },
    (value: Record<string, any>) => { delete value.codes; },
    (value: Record<string, any>) => { value.codes = ["invented-result"]; },
    (value: Record<string, any>) => { value.state = "refused"; },
  ]) {
    const value = clone(saved.value) as Record<string, any>; mutate(value);
    const changed = rewrite(f.store, saved, value as typeof saved.value);
    refusedWith(readHorizonIssuance(f.store, { project, record: reference(changed) }), "horizon_issuance_record_invalid");
    f.restart();
    refusedWith(readHorizonIssuance(f.store, { project, record: reference(changed) }), "horizon_issuance_record_invalid");
    rewrite(f.store, saved, saved.value);
  }
});

test("G2 source and target CAS are atomic and old issuance keeps its exact prepared revision", t => {
  const f = fixture(t), horizon = f.horizon("choice-1"), series = f.series();
  const transition = ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])));
  const given = { project, choiceVersion: "choice-1", horizon: reference(horizon.gate), transition: reference(transition) };
  const prepared = ok(prepareHorizonIssuance(f.store, given)), other = new Store(f.path);
  const saved = (() => { try { return ok(writeHorizonIssuance(other, given)); } finally { other.close(); } })();
  refusedWith(writeGuarded(f.store, { unit: "G2", target: saved.id, writes: [...prepared.writes,
    { id: "issuance-neighbor", kind: "test", expected: 0, value: {} }], guards: prepared.guards }), "revision_conflict");
  assert.equal(f.store.get("issuance-neighbor"), null);
  const next = f.horizon("next"), p = ok(writeSeriesTransition(f.store, request(reference(next.gate), [reference(series)], "next")));
  const pending = ok(prepareHorizonIssuance(f.store, { ...given, choiceVersion: "next", horizon: reference(next.gate), transition: reference(p) }));
  const competing = new Store(f.path);
  try {
    // This is a later unproved head, not a fabricated B3 application or managed-series admission.
    competing.write({ id: p.id, kind: p.kind, expected: p.revision, value: { state: "discarded", source: reference(p) } });
    competing.write({ id: transition.id, kind: transition.kind, expected: transition.revision, value: { state: "applied", source: reference(transition) } });
  } finally { competing.close(); }
  refusedWith(writeGuarded(f.store, { unit: "G2", target: pending.record.id, writes: [...pending.writes,
    { id: "issuance-neighbor", kind: "test", expected: 0, value: {} }], guards: pending.guards }), "input_stale");
  assert.equal(f.store.get(pending.record.id), null); assert.equal(f.store.get("issuance-neighbor"), null);
  refusedWith(prepareHorizonIssuance(f.store, given), "input_stale");
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try { assert.deepEqual(ok(readHorizonIssuance(exact, { project, record: reference(saved) })).record, saved); }
  finally { exact.close(); }
  assert.deepEqual(ok(writeHorizonIssuance(f.store, given)), saved);
  assert.deepEqual(f.store.get(series.id), series);
});

test("active exclusion and return preserve the last comparable active content without modifying the series", t => {
  const f = fixture(t, () => {}, true), series = f.series(independent);
  const active = f.horizon("active", { features: [{ outcome: "garden-result" }, { outcome: "garden-later" }] });
  const outside = f.horizon("outside", { excluded: [{ block: independent, reason: "Outside this delivery", returnCondition: "Select later feature" }] });
  const back = f.horizon("returned", { features: [{ outcome: "garden-later" }, { outcome: "garden-result" }] });
  const a = ok(writeSeriesTransition(f.store, request(reference(active.gate), [reference(series)], "active")));
  const b = ok(writeSeriesTransition(f.store, request(reference(outside.gate), [reference(series)], "outside")));
  const c = ok(writeSeriesTransition(f.store, request(reference(back.gate), [reference(series)], "returned")));
  assert.equal(decision(b, independent).slice, null);
  assert.equal(decision(b, independent).outcome, "inactive");
  assert.equal(decision(c, independent).outcome, "establish-basis", "Preparation alone does not activate a managed series");
  assert.equal(ok(comparePreparedSeriesSlices(f.store, { project, previous: reference(a), next: reference(c), block: independent })), "continue");
  refusedWith(comparePreparedSeriesSlices(f.store, { project, previous: reference(b), next: reference(c), block: independent }), "series_transition_unproven");
  assert.deepEqual(f.store.get(series.id), series);
});

test("the whole b1143aa producer leaves its stopped legacy series and exact B1 horizon bytes unchanged", t => {
  const base = "b1143aa7343db45896a134ee3cb3a273b211057e", root = mkdtempSync(join(tmpdir(), "omg-series-base-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const run = (executable: string, args: string[], cwd: string) => {
    const child = spawnSync(executable, args, { cwd, env: environment, encoding: "utf8", timeout: 90_000, maxBuffer: 20_000_000 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, `${executable} ${args.join(" ")}\n${child.stdout}\n${child.stderr}`);
    return child.stdout;
  };
  const repository = run("git", ["rev-parse", "--show-toplevel"], dirname(fileURLToPath(import.meta.url))).trim();
  const legacy = join(root, "base"), archive = join(root, "base.tar"); mkdirSync(legacy);
  run("git", ["archive", "--format=tar", "--output", archive, base], repository);
  run("tar", ["-xf", archive, "-C", legacy], root);
  symlinkSync(join(repository, "node_modules"), join(legacy, "node_modules"), "dir");
  writeFileSync(join(legacy, "tsconfig.transition-history.json"), JSON.stringify({ extends: "./tsconfig.json",
    include: ["src/**/*.ts", "test/om-fixture.ts", "test/product-fixture.ts"], exclude: [] }));
  run(process.execPath, [join(legacy, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.transition-history.json"], legacy);
  const path = join(root, "old.sqlite"), output = join(root, "old.json"), producerFile = join(legacy, "old-producer.mjs");
  writeFileSync(producerFile, `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Store } from './dist/src/storage/store.js';
import { canonical } from './dist/src/canonical.js';
import { ProductEngine } from './dist/src/product/engine.js';
import { projectGraph } from './dist/src/graph/project.js';
import { reference } from './dist/src/pipeline/contracts.js';
import { UPSTREAM_STAGES } from './dist/src/discovery/requirements.js';
import { writeOmInput } from './dist/src/om/input.js';
import { writeHorizon } from './dist/src/om/horizon.js';
import { openSeries, beginAttempt, completeAttempt } from './dist/src/om/series.js';
import { preparedFeatures } from './dist/test/product-fixture.js';
import { gardenGraph } from './dist/test/om-fixture.js';
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const project = 'garden', block = 'garden-consume-block', store = new Store(process.argv[2]);
const { level, ...upper } = projectGraph(gardenGraph(), 1);
preparedFeatures(new ProductEngine(store), project, upper);
const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get('stage:'+project+':'+stage))]));
const input = ok(writeOmInput(store,{project,expected:0,stages}));
const graph = store.get('graph:'+project);
const horizon = ok(writeHorizon(store,{project,input:reference(input),graph:reference(graph),refinement:null,available:{},
 choice:{choiceVersion:'old-choice',features:[{outcome:'garden-result'}],excluded:[]}}));
let series = ok(openSeries(store,{project,block,line:1,slice:'legacy:opaque-subject',predecessor:null,basis:null}));
for(let attempt=1;attempt<=3;attempt++){
 ok(beginAttempt(store,{project,block,line:1,attempt,goal:{key:'legacy-question',questions:['Which proposal works?'],result:'accepted proposal'}}));
 series=ok(completeAttempt(store,{project,block,line:1,attempt,outcome:{reason:'off-form',achieved:[],cancelled:[],refusals:[]}}));
}
assert.ok(series.value.stop);
const rows=store.list().flatMap(row=>store.history(row.id));
writeFileSync(process.argv[3],JSON.stringify({input,horizon,series,rows,bytes:canonical(rows)}));store.close();
`);
  run(process.execPath, [producerFile, path, output], legacy);
  const previous = JSON.parse(readFileSync(output, "utf8")) as {
    input: Revision; horizon: { gate: Revision }; series: Revision<RepairSeries>; rows: Revision[]; bytes: string;
  };
  let store = new Store(path);
  try {
    assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), previous.bytes);
    assert.deepEqual(ok(readSeriesAt(store, project, reference(previous.series))), previous.series);
    const saved = ok(writeSeriesTransition(store, request(reference(previous.horizon.gate), [reference(previous.series)], "old-choice")));
    assert.equal(decision(saved).outcome, "establish-basis");
    for (const row of previous.rows) assert.deepEqual(store.get(row.id, row.revision), row);
    store.close(); store = new Store(path);
    assert.deepEqual(ok(readPreparedSeriesTransition(store, { project, record: reference(saved) })).record, saved);
    assert.deepEqual(ok(readSeriesAt(store, project, reference(previous.series))), previous.series);
  } finally { store.close(); }
});

// Append below the existing fixture/request/decision helpers. No accepted records
// are fabricated: the proposal is accepted by the ordinary C3/C5 producers.
function sharedAcceptedL2(t: TestContext, change: (graph: Graph) => void = () => {}) {
  const f = fixture(t), graph = gardenGraph();
  change(graph);
  const initial = f.horizon("shared-l2-open"), series = f.series();
  const before = ok(writeSeriesTransition(f.store,
    request(reference(initial.gate), [reference(series)], "shared-l2-open")));
  const frame: FrameRequest = { project, level: 2, graph: reference(f.graph), horizon: reference(initial.gate),
    layer: null, frame: null, upper: null };
  const base = ok(prepareFrame(f.store, frame)), projected = projectGraph(graph, 2);
  // This pure mapping is only proposal construction, as in om-frame-accept.test.ts.
  const mapped = ok(fillObligations(base.upper as Graph, base.scope as FrameScope,
    { graph, reference: { ...frame.graph, hash: hashJson(graph) }, frame: null }, base.upperRef, 2));
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: null }, level: 2, source: "decision", status: "proposed",
    nodes: projected.nodes.filter(node => node.kind === "operation"),
    fills: mapped.fills.map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length > 0),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    removes: [], replaces: [], redefines: [] };
  const offered = f.store.write({ id: "om-proposal:garden:shared-l2-slice", kind: "layer-proposal", expected: 0, value: proposal });
  const candidate = ok(writeCandidate(f.store, { frame, proposals: [reference(offered)] }));
  assert.equal(candidate.state, "candidate");
  if (candidate.state !== "candidate") assert.fail("The genuine shared L2 proposal must form a candidate");
  const candidateRef = reference(candidate.record);
  const accepted = ok(settleCandidate(f.store, { project, level: 2, candidate: candidateRef,
    outcome: { gate: "G3", candidate: candidateRef, graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  assert.ok(accepted.graph && accepted.layer && accepted.frame);
  assert.equal(ok(readLayerAcceptance(f.store, { project, level: 2,
    graph: reference(accepted.graph), layer: reference(accepted.layer) })).producer, "om");
  const horizon = ok(writeHorizon(f.store, { project, input: reference(f.input), graph: reference(accepted.graph),
    refinement: reference(accepted.layer), available: {},
    choice: { choiceVersion: "shared-l2-accepted", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const record = ok(writeSeriesTransition(f.store,
    request(reference(horizon.gate), [reference(series)], "shared-l2-accepted")));
  return { f, before, record, accepted, horizon };
}

test("accepted shared L2 frame changes for independent C without changing B while local B refinement changes its slice", t => {
  const base = sharedAcceptedL2(t);
  const changedC = sharedAcceptedL2(t, graph => {
    graph.nodes.find(node => node.id === "garden-later-operation")!.title = "Independent C operation changed";
  });
  const changedB = sharedAcceptedL2(t, graph => {
    graph.nodes.find(node => node.id === "garden-consume-operation")!.title = "Local B operation changed";
  });
  assert.notEqual(base.accepted.graph!.hash, changedC.accepted.graph!.hash);
  assert.notEqual(base.accepted.layer!.hash, changedC.accepted.layer!.hash);
  assert.notEqual(base.accepted.frame!.hash, changedC.accepted.frame!.hash,
    "The unrelated edit must actually change the shared accepted frame source");
  assert.deepEqual(decision(base.record).slice, decision(changedC.record).slice,
    "A common graph/layer/frame hash is evidence identity, not B's local semantic content");
  assert.notDeepEqual(decision(base.record).slice, decision(changedB.record).slice,
    "A real accepted change to B's operation must change both local body and hash");
  assert.ok(canonical(decision(base.record).slice!.body).includes("garden-consume-operation"));
  assert.equal(canonical(decision(changedC.record).slice!.body).includes("Independent C operation changed"), false);
  assert.equal(ok(comparePreparedSeriesSlices(base.f.store, { project,
    previous: reference(base.before), next: reference(base.record), block })), "new-work",
  "Newly accepted L2 disclosure differs from the proved no-L2 basis in the same history");
  assert.deepEqual(ok(readPreparedSeriesTransition(base.f.store,
    { project, record: reference(base.before) })).record, base.before,
  "The earlier exact graph/horizon remains readable after C5 changes their heads");
});

test("boundary slices ignore unrelated real receipt revisions but bind consumed receipts and preserve a stopped supplier", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-transition-boundary-")), workspace = join(root, "workspace"),
    database = join(root, "state.sqlite");
  mkdirSync(workspace); writeFileSync(join(workspace, "README.md"), "Local boundary supplier fixture.\n");
  git(workspace, ["init", "-b", "main"]); git(workspace, ["add", "README.md"]);
  git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture baseline"]);
  const store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const desired = gardenGraph(), { level: _level, ...l1 } = projectGraph(desired, 1);
  // The supplier's own question is declared in the input materials before any plan or route is formed (№10753 п.6);
  // the stopped series below is produced by the supplier's own managed path, not a consumer-side substitute.
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = [{ id: "supplier-fact",
      question: "Which repository fact does the produce block need?", consumer: producer, moment: "om-pass",
      blocksCurrentStage: false, resolution: "Read repository facts during OM" }];
    return value;
  });
  const agent = join(root, "agent.mjs");
  writeFileSync(agent, `
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
const request=JSON.parse(readFileSync(0,'utf8')),context=request.subject.context;
const response={protocol:request.protocol,requestId:request.requestId};
if(request.mode==='implement'){
 for(const ref of context.scope.code.filter(item=>item.access==='write')){
  mkdirSync(dirname(ref.path),{recursive:true});writeFileSync(ref.path,'fixture:'+context.binding.task+'\\n');
 }
 response.text='Implemented deterministic fixture';response.artifacts=context.produces.map(id=>({id}));
}else response.review={verdict:'pass',kind:'none',findings:[]};
process.stdout.write(JSON.stringify(response));
`);
  const command = { executable: process.execPath, args: [agent] };
  engine.environments.configure(project, { workspace,
    implementer: { actor: "fixture-implementer", model: "fixture", effort: "high", command },
    reviewer: { actor: "fixture-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000,
    requestCapacityChars: 100_000 }, 0);
  prepareNativeLayers(engine, project, desired, "executed");
  const plan = engine.compiler.compile(project), compilation = engine.compiler.publish(project, reference(plan), 0);
  engine.pipeline.accept(project, "compilation", compilation.revision);
  const runs = await engine.executor.run(project, reference(plan), { retry: false, maxContextChars: 100_000, maxCorrections: 0 });
  assert.ok(runs.every(run => run.value.state === "committed"), "Every garden task finishes with a committed run");
  // The supplier's own question is addressed to it on the accepted input head — a level-1 consumer carries an empty
  // proof set — before its managed route plan is formed below.
  ok(writeAddressing(store, { project, input: reference(store.get(`om-input:${project}`)!),
    graph: reference(store.get<Graph>(`graph:${project}`)!),
    decisions: [{ pending: clone(inputDecisionWrite({ project,
      input: reference(store.get(`om-input:${project}`)!), graph: reference(store.get<Graph>(`graph:${project}`)!), layers: [],
      decision: { target: "discovery:supplier-fact", field: "address",
        value: { consumer: producer, kind: "repository-fact" } } })) as Write }] }));
  const graph = reference(store.get<Graph>(`graph:${project}`)!);
  const consumerSeries = ok(openSeries(store, { project, block, line: 1, slice: opaqueSlice, predecessor: null, basis: null }));
  ok(openSeries(store, { project, block: producer, line: 1, slice: opaqueSlice, predecessor: null, basis: null }));
  const supplierSeries = await managedSupplierStop(store, engine, root, workspace),
    series = [reference(consumerSeries), reference(supplierSeries)];
  const input = store.get(`om-input:${project}`)!;
  const data = store.get<ArtifactReceipt>(receiptId(project, "garden-data"))!,
    extra = store.get<ArtifactReceipt>(receiptId(project, "garden-prep"))!;
  assert.ok(data.value.run && extra.value.run, "Both receipts come from real fixture execution");
  const preparedAt = (version: string, dataRef: Ref, extraRef: Ref) => {
    const horizon = ok(writeHorizon(store, { project, input: reference(input), graph,
      refinement: reference(store.get(`graph-layer:${project}:2`)!),
      choice: { choiceVersion: version, features: [{ outcome: "garden-result" }], excluded: [] },
      available: { [producer]: { "garden-data": dataRef, "garden-prep": extraRef } } }));
    assert.deepEqual(horizon.horizon.value.result.horizon.nodes, [block]);
    assert.deepEqual(horizon.horizon.value.result.horizon.boundary,
      [{ block: producer, basis: { "garden-data": dataRef, "garden-prep": extraRef } }]);
    return { horizon, record: ok(writeSeriesTransition(store, request(reference(horizon.gate), series, version))) };
  };
  const first = preparedAt("boundary-receipts-1", reference(data), reference(extra));
  // A new exact revision of genuine bytes tests Ref semantics, not a claim of new execution.
  const nextExtra = store.write({ id: extra.id, kind: extra.kind, expected: extra.revision, value: extra.value });
  const unrelated = preparedAt("boundary-receipts-2", reference(data), reference(nextExtra));
  assert.notEqual(first.horizon.horizon.hash, unrelated.horizon.horizon.hash);
  assert.deepEqual(decision(first.record).slice, decision(unrelated.record).slice);
  assert.equal(ok(comparePreparedSeriesSlices(store, { project,
    previous: reference(first.record), next: reference(unrelated.record), block })), "continue");
  assert.equal(canonical(decision(first.record).slice!.body).includes(extra.id), false,
    "The supplier's unconsumed prep receipt is not part of B's subject");
  const nextData = store.write({ id: data.id, kind: data.kind, expected: data.revision, value: data.value });
  const consumed = preparedAt("boundary-receipts-3", reference(nextData), reference(nextExtra));
  assert.notDeepEqual(decision(unrelated.record).slice, decision(consumed.record).slice);
  assert.equal(ok(comparePreparedSeriesSlices(store, { project,
    previous: reference(unrelated.record), next: reference(consumed.record), block })), "new-work");
  for (const item of [first, unrelated, consumed]) {
    const boundaryDecision = decision(item.record, producer);
    assert.equal(boundaryDecision.participation, "boundary");
    assert.equal(boundaryDecision.outcome, "inactive");
    assert.equal(boundaryDecision.slice, null);
    assert.equal(boundaryDecision.previousSlice, opaqueSlice);
    assert.deepEqual(boundaryDecision.series, reference(supplierSeries));
  }
  assert.deepEqual(store.get(supplierSeries.id), supplierSeries,
    "Boundary participation does not reset the supplier's stop, ladder or no-progress history");
  assert.deepEqual(store.get(consumerSeries.id), consumerSeries);
  assert.deepEqual(ok(readPreparedSeriesTransition(store, { project, record: reference(first.record) })).record, first.record,
    "Historical P reads use the original receipt revisions after both receipt heads advance");
});

test("a separate provider flow to independent C changes neither B's frame obligations nor its slice", t => {
  const base = fixture(t), unrelated = fixture(t, graph => {
    const source = graph.connectors.find(item => item.id === "garden-flow")!;
    graph.connectors.push({ ...clone(source), id: "garden-independent-flow", bindings: [{
      level: 1, producer: { node: producer, port: "out" }, consumers: [{ node: independent, port: "in" }], anchor: null,
    }] });
  });
  const selected = fixture(t, graph => {
    const source = graph.connectors.find(item => item.id === "garden-flow")!;
    graph.connectors.push({ ...clone(source), id: "garden-local-flow", bindings: [{
      level: 1, producer: { node: producer, port: "out" }, consumers: [{ node: block, port: "in" }], anchor: null,
    }] });
  });
  const local = (f: ReturnType<typeof fixture>) => {
    const horizon = f.horizon("choice-1"), series = f.series();
    return decision(ok(writeSeriesTransition(f.store, request(reference(horizon.gate), [reference(series)])))).slice!;
  };
  const expected = local(base), excluded = local(unrelated), added = local(selected);
  assert.deepEqual(excluded, expected, "Excluded producer-end obligations must not retain a separate unrelated flow");
  assert.equal(canonical(excluded.body).includes("garden-independent-flow"), false);
  assert.notDeepEqual(added, expected, "A second genuinely selected flow changes the block's subject");
  const oldBody = expected.body as Record<string, any>, nextBody = added.body as Record<string, any>;
  assert.equal(nextBody.connectors.length, oldBody.connectors.length + 1);
  assert.equal(nextBody.obligations.length, oldBody.obligations.length + 2,
    "The distinct selected flow retains both its producer and consumer connection-end obligations");
  assert.equal(nextBody.open.length, oldBody.open.length + 2);
  assert.deepEqual(nextBody.obligations.filter((item: { kind: string }) => item.kind === "block-outcome"),
    oldBody.obligations.filter((item: { kind: string }) => item.kind === "block-outcome"));
  const ports = (graph: Graph) => {
    graph.nodes.find(node => node.id === producer)!.ports.push({ id: "other-out", direction: "out", contract: "garden-contract" });
    graph.nodes.find(node => node.id === independent)!.ports.push({ id: "other-in", direction: "in", contract: "garden-contract" });
  };
  const oneConnector = fixture(t, ports), extraBinding = fixture(t, graph => {
    ports(graph);
    graph.connectors.find(item => item.id === "garden-flow")!.bindings.push({ level: 1,
      producer: { node: producer, port: "other-out" }, consumers: [{ node: independent, port: "other-in" }], anchor: null });
  });
  assert.deepEqual(local(extraBinding), local(oneConnector),
    "A different producer-end flow of an otherwise selected connector is still unrelated to B");
});

test("a genuinely refused horizon has an exact prepared transition and negative issuance without asserting block participation", async t => {
  const f = fixture(t, () => {}, false, false, true); f.series();
  const series = await managedStop(f, managedRoutes(f, reference(f.horizon("setup").gate))), savedSeries = f.store.history(series.id);
  const horizon = f.horizon("refused-choice", { excluded: [{ block: producer,
    reason: "The owner excluded a required provider", returnCondition: "Select the provider again" }] });
  assert.equal(horizon.gate.value.state, "refused");
  assert.ok(horizon.gate.value.codes.includes("horizon_requires_excluded"));
  const given = request(reference(horizon.gate), [reference(series)], "refused-choice"), before = snapshot(f.store);
  refusedWith(prepareSeriesTransition(f.store, { ...given, series: [{ ...reference(series), revision: 900 }] }), "record_missing");
  const prepared = ok(prepareSeriesTransition(f.store, given));
  assert.deepEqual(snapshot(f.store), before);
  assert.deepEqual(prepared.record.value.decisions, [], "Refusal does not prove active, boundary or excluded participation");
  const transition = ok(writeSeriesTransition(f.store, given));
  assert.deepEqual(transition, prepared.record);
  const issuanceRequest = { project, choiceVersion: "refused-choice", horizon: reference(horizon.gate), transition: reference(transition) };
  const beforeIssuance = snapshot(f.store), ready = ok(prepareHorizonIssuance(f.store, issuanceRequest));
  assert.deepEqual(snapshot(f.store), beforeIssuance);
  const issued = ok(writeHorizonIssuance(f.store, issuanceRequest));
  assert.deepEqual(issued, ready.record);
  assert.equal(issued.value.state, "refused");
  assert.deepEqual(issued.value.codes, horizon.gate.value.codes);
  assert.deepEqual(issued.value.horizon, reference(horizon.gate));
  assert.deepEqual(issued.value.transition, reference(transition));
  assert.deepEqual(f.store.history(series.id), savedSeries);
  assert.deepEqual(f.store.get(transition.id), transition);
  const accepted = f.horizon("other-accepted"), otherTransition = ok(writeSeriesTransition(f.store,
    request(reference(accepted.gate), [reference(series)], "other-accepted")));
  const emptyAccepted = ok(writeSeriesTransition(f.store, request(reference(accepted.gate), [], "other-accepted")));
  assert.deepEqual(emptyAccepted.value.decisions, []);
  const emptyIssued = ok(writeHorizonIssuance(f.store, { project, choiceVersion: "other-accepted",
    horizon: reference(accepted.gate), transition: reference(emptyAccepted) }));
  assert.equal(emptyIssued.value.state, "accepted", "The exact H outcome determines G; an empty decision set does not imply refusal");
  assert.deepEqual(emptyIssued.value.codes, []);
  refusedWith(comparePreparedSeriesSlices(f.store, { project, previous: reference(otherTransition), next: reference(transition), block }), "series_transition_unproven");
  refusedWith(prepareHorizonIssuance(f.store, { ...issuanceRequest, transition: reference(otherTransition) }), "horizon_issuance_binding_invalid");
  refusedWith(prepareHorizonIssuance(f.store, { ...issuanceRequest, horizon: reference(accepted.gate), choiceVersion: "other-accepted" }), "horizon_issuance_binding_invalid");
  f.restart();
  const exact = new ExactOnlyStore(f.path);
  try {
    assert.deepEqual(ok(readPreparedSeriesTransition(exact, { project, record: reference(transition) })).record, transition);
    assert.deepEqual(ok(readHorizonIssuance(exact, { project, record: reference(issued) })).record, issued);
  } finally { exact.close(); }
  const beforeRepeats = snapshot(f.store);
  assert.deepEqual(ok(writeSeriesTransition(f.store, given)), transition);
  assert.deepEqual(ok(writeHorizonIssuance(f.store, issuanceRequest)), issued);
  assert.deepEqual(snapshot(f.store), beforeRepeats, "Exact repeats of P and G2 write nothing");
  assert.deepEqual(f.store.history(series.id), savedSeries);
});

test("external inputs on the current OM route: an executed supplier's internal receipt is exact and retained, an external-only supplier outside the horizon needs none, a supplier inside the horizon cannot add an external L1 flow, and no work claims an external outcome", async t => {
  // LG15 (codex-omg2 №7682): the same executed supplier cannot also provide an external input on this accepted L1 —
  // the slice consumes external inputs through L1 bindings, writeHorizon keeps the exact accepted L1, and an in-horizon
  // supplier's L1 flow must be refined down to a work that would claim the external artifact. The scenarios below
  // measure that obstacle instead of an unreachable positive same-supplier case.
  for (const onlyExternal of [false, true]) await t.test(onlyExternal
    ? "an external-only supplier outside the horizon and its ready boundary carries no receipt; cold read and repeat change nothing"
    : "an executed supplier's committed receipt is exact and retained in the slice; an external L1 flow cannot be added over its accepted L1", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-transition-external-")), workspace = join(root, "workspace"), database = join(root, "state.sqlite");
  mkdirSync(workspace); writeFileSync(join(workspace, "README.md"), "Local external-flow regression fixture.\n");
  git(workspace, ["init", "-b", "main"]); git(workspace, ["add", "README.md"]);
  git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture baseline"]);
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = gardenGraph(), external = "garden-external-input", flowId = "garden-external-flow";
  const extProvider = "garden-later-block";
  if (onlyExternal) {
    graph.artifacts.push({ ...clone(graph.artifacts.find(item => item.id === "garden-data")!), id: external, external: true });
    for (const id of ["garden-later-block", "garden-later-operation", "w-garden-later-operation"])
      graph.nodes.find(node => node.id === id)!.ports.push({ id: "out", direction: "out", contract: "garden-contract" });
    const flow = graph.connectors.find(item => item.id === "garden-flow")!;
    graph.connectors.push({ ...clone(flow), id: flowId, artifact: external, wakeTest: null,
      bindings: ([1, 2, 3] as const).map(level => {
        const binding = clone(flow.bindings.find(item => item.level === level && item.anchor === null)!);
        binding.producer = { node: level === 1 ? "garden-later-block" : level === 2 ? "garden-later-operation" : "w-garden-later-operation", port: "out" };
        binding.consumers = binding.consumers.filter(endpoint => endpoint.node.includes("consume"));
        return binding;
      }) });
    for (const binding of flow.bindings) binding.consumers = binding.consumers.filter(endpoint => !endpoint.node.includes("consume"));
    flow.bindings = flow.bindings.filter(binding => binding.consumers.length > 0);
    for (const journey of graph.journeys ?? []) if (journey.path[0] === "garden-produce-block" && journey.path[1] === "garden-consume-block") {
      journey.entry = "garden-later-block"; journey.path = ["garden-later-block", "garden-consume-block"];
    }
  }
  const { level: _level, ...l1 } = projectGraph(graph, 1);
  preparedFeatures(engine, project, l1 as Graph, undefined, "");
  const source = engine.discovery.evidence.document(project, external, "Declared external fixture input", "text/plain", 0);
  const agent = join(root, "agent.mjs");
  writeFileSync(agent, `
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
const request=JSON.parse(readFileSync(0,'utf8')),context=request.subject.context;
const response={protocol:request.protocol,requestId:request.requestId};
if(request.mode==='implement'){
 for(const ref of context.scope.code.filter(item=>item.access==='write')){
  mkdirSync(dirname(ref.path),{recursive:true});writeFileSync(ref.path,'fixture:'+context.binding.task+'\\n');
 }
 response.text='Implemented deterministic fixture';response.artifacts=context.produces.map(id=>({id}));
}else response.review={verdict:'pass',kind:'none',findings:[]};
process.stdout.write(JSON.stringify(response));
`);
  const command = { executable: process.execPath, args: [agent] };
  engine.environments.configure(project, { workspace,
    implementer: { actor: "fixture-implementer", model: "fixture", effort: "high", command },
    reviewer: { actor: "fixture-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000,
    requestCapacityChars: 100_000 }, 0);
  nativeExecuted(engine, graph, onlyExternal ? [reference(source)] : []);
  const plan = engine.compiler.compile(project), compilation = engine.compiler.publish(project, reference(plan), 0);
  engine.pipeline.accept(project, "compilation", compilation.revision);
  const runs = await engine.executor.run(project, reference(plan), { retry: false, maxContextChars: 100_000, maxCorrections: 0 });
  const supplierTask = plan.value.tasks.find(task => task.node === "garden-produce-work");
  const supplierRun = supplierTask ? runs.find(run => run.value.taskId === supplierTask.id) : undefined;
  const consumerTask = plan.value.tasks.find(task => task.node === "garden-consume-work")!;
  const consumerRun = runs.find(run => run.value.taskId === consumerTask.id)!;
  // V3 executes the external consumer; B3 still consumes the exact committed supplier evidence below.
  assert.equal(consumerRun.value.state, "committed");
  assert.equal(consumerRun.value.error, null);
  const dataReceipt = store.get<ArtifactReceipt>(receiptId(project, "garden-data"));
  if (!onlyExternal) assert.ok(dataReceipt?.value.run && supplierRun?.value.state === "committed",
    "The internal receipt is produced by actual committed fixture execution");
  else assert.equal(dataReceipt, null, "The external-only route never executes the internal supplier");
  const evidence: [Revision<ArtifactReceipt>, CompiledTask, Revision<TaskRun>][] =
    onlyExternal ? [] : [[dataReceipt!, supplierTask!, supplierRun!]];
  const acceptedGraph = store.get<Graph>(`graph:${project}`)!;
  for (const [receipt, task, run] of evidence) {
    assert.deepEqual(receipt.value.plan, reference(plan));
    assert.deepEqual(receipt.value.run, reference(run));
    assert.equal(receipt.value.node, task.node);
    assert.equal(receipt.value.signature, nodeSignature(acceptedGraph.value,
      acceptedGraph.value.nodes.find(node => node.id === task.node)!));
    assert.equal(receipt.value.commit, run.value.commit);
    assert.equal(receipt.value.tree, run.value.tree);
  }
  const input = reference(store.get(`om-input:${project}`)!), graphHead = reference(store.get<Graph>(`graph:${project}`)!),
    l2Layer = reference(store.get(`graph-layer:${project}:2`)!);
  const series = ok(openSeries(store, { project, block, line: 1, slice: opaqueSlice, predecessor: null, basis: null }));
  const prepare = (version: string) => {
    const horizon = ok(writeHorizon(store, { project, input, graph: graphHead,
      refinement: l2Layer,
      choice: { choiceVersion: version, features: [{ outcome: "garden-result" }], excluded: [] },
      available: onlyExternal ? {} : { [producer]: { "garden-data": reference(dataReceipt!) } } }));
    assert.equal(horizon.gate.value.state, "accepted");
    assert.deepEqual(horizon.horizon.value.result.horizon.nodes, [block]);
    if (onlyExternal) {
      assert.deepEqual(horizon.horizon.value.result.horizon.boundary, []);
      assert.equal(Object.hasOwn(horizon.horizon.value.result.horizon.execution, producer), false,
        "The explicit receipt belongs to a supplier outside both the selected horizon and its ready boundary");
      assert.equal(horizon.horizon.value.result.horizon.externalInputs.some(item => item.artifact === external && item.source === extProvider), true);
    } else {
      assert.deepEqual(horizon.horizon.value.result.horizon.boundary.find(item => item.block === producer)?.basis,
        { "garden-data": reference(dataReceipt!) }, "The ready supplier's basis is exactly its committed receipt");
      assert.deepEqual(horizon.horizon.value.result.horizon.externalInputs, []);
    }
    const record = ok(writeSeriesTransition(store, request(reference(horizon.gate), [reference(series)], version)));
    return { horizon, record };
  };
  const without = prepare("external-unnamed");
  const receipts = (record: typeof without.record) => (decision(record).slice!.body as Record<string, Json>).receipts;
  const internalReceipts = onlyExternal ? [] : [{ source: producer, artifact: "garden-data", receipt: reference(dataReceipt!) }];
  assert.deepEqual(receipts(without.record), internalReceipts);
  store.close(); store = new Store(database);
  const exact = new ExactOnlyStore(database);
  try {
    assert.deepEqual(ok(readPreparedSeriesTransition(exact, { project, record: reference(without.record) })).record, without.record);
  } finally { exact.close(); }
  assert.deepEqual(store.get(series.id), series);
  // A repeat of the same preparation reads the saved records and writes nothing.
  const settled = snapshot(store), again = prepare("external-unnamed");
  assert.deepEqual(again.record, without.record);
  assert.deepEqual(snapshot(store), settled, "The repeated preparation changes nothing");
  if (!onlyExternal) {
    // The obstacle, measured: the supplier's external L1 flow cannot be added over the previously accepted L1 — the
    // L2 frame over the accepted layer refuses the changed upper layer before any write.
    const desired = clone(store.get<Graph>(`graph:${project}`)!.value);
    desired.artifacts.push({ ...clone(desired.artifacts.find(item => item.id === "garden-data")!), id: external, external: true });
    desired.nodes.find(node => node.id === producer)!.ports.push({ id: "out-external", direction: "out", contract: "garden-contract" });
    const baseFlow = desired.connectors.find(item => item.id === "garden-flow")!;
    const l1Binding = clone(baseFlow.bindings.find(item => item.level === 1 && item.anchor === null)!);
    l1Binding.producer = { node: producer, port: "out-external" };
    l1Binding.consumers = l1Binding.consumers.filter(endpoint => endpoint.node.includes("consume"));
    desired.connectors.push({ ...clone(baseFlow), id: flowId, artifact: external, wakeTest: null, bindings: [l1Binding] });
    const frame2: FrameRequest = { project, level: 2, graph: graphHead, horizon: reference(without.horizon.gate),
      layer: l2Layer, frame: reference(store.get(`om-frame:${project}:2`)!), upper: null };
    const read = ok(prepareFrame(store, frame2)) as unknown as FrameRead;
    const before = snapshot(store);
    const drift = fillObligations(read.upper, read.scope,
      { graph: desired, reference: { ...read.request.graph, hash: hashJson(desired) }, frame: null }, read.upperRef, 2);
    assert.equal(drift.ok, false, "A changed upper layer is refused");
    if (!drift.ok) assert.deepEqual([drift.refusal.code, drift.refusal.at.target, drift.refusal.at.field],
      ["frame_upper_drift", `graph:${project}`, "upper"]);
    assert.deepEqual(snapshot(store), before, "The refused frame writes nothing");
  }
  });

  await t.test("a supplier inside the horizon cannot realize an external flow: L2 refines it, the supplier's L3 work would produce a second artifact and L3 is not accepted", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-transition-inside-external-")), workspace = join(root, "workspace"), database = join(root, "state.sqlite");
  mkdirSync(workspace); writeFileSync(join(workspace, "README.md"), "Local inside-horizon external-flow fixture.\n");
  git(workspace, ["init", "-b", "main"]); git(workspace, ["add", "README.md"]);
  git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture baseline"]);
  const store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = gardenGraph(), external = "garden-external-input", flowId = "garden-external-flow";
  graph.artifacts.push({ ...clone(graph.artifacts.find(item => item.id === "garden-data")!), id: external, external: true });
  // The same supplier at every level declares the external output next to its internal garden-data flow.
  const flow = graph.connectors.find(item => item.id === "garden-flow")!;
  const bindings = ([1, 2, 3] as const).map(level => {
    const binding = clone(flow.bindings.find(item => item.level === level && item.anchor === null)!);
    graph.nodes.find(node => node.id === binding.producer.node)!.ports.push({ id: "out-external", direction: "out", contract: "garden-contract" });
    binding.producer = { node: binding.producer.node, port: "out-external" };
    binding.consumers = binding.consumers.filter(endpoint => endpoint.node.includes("consume"));
    return binding;
  });
  graph.connectors.push({ ...clone(flow), id: flowId, artifact: external, wakeTest: null, bindings });
  const supplierWork = bindings[2]!.producer.node;
  // The supplier work's own test covers the new connector too, so only the single-artifact rule can stand in the way.
  const proof = graph.tests.find(item => item.node === supplierWork && item.covers.includes("garden-flow"))!;
  proof.covers.push(flowId);
  proof.contract!.counterfactuals.push({ ...clone(proof.contract!.counterfactuals.find(item => item.connector === "garden-flow")!), connector: flowId });
  const { level: _level, ...l1 } = projectGraph(graph, 1);
  preparedFeatures(engine, project, l1 as Graph, undefined, "");
  engine.environments.configure(project, { workspace,
    implementer: { actor: "fixture-implementer", model: "fixture", effort: "high", command: { executable: process.execPath, args: ["--version"] } },
    reviewer: { actor: "fixture-reviewer", model: "fixture", effort: "high", command: { executable: process.execPath, args: ["--version"] } },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000, requestCapacityChars: 100_000 }, 0);
  const { works, gapRead, handoff, environment } = nativeSetup(engine, graph);
  const l2 = store.get<Graph>(`graph:${project}`)!.value;
  assert.ok(l2.connectors.find(item => item.id === flowId)?.bindings.some(binding => binding.level === 2),
    "The supplier's external flow is refined at L2 — operations carry no single-artifact rule");
  const candidate3 = ok(writeWorksFrame(store, { ...works, works: { contract: "works-frame/v1",
    producer: reference(handoff.producer), ledger: reference(handoff.record), bindings: [] } }));
  assert.equal(candidate3.state, "candidate", "The works frame itself admits the refined flow");
  if (candidate3.state !== "candidate") return;
  const neighbors = ok(writeNeighbors(store, { project, candidate: reference(candidate3.record) }));
  const gate3 = ok(writeAtomicGate(store, { project, candidate: reference(candidate3.record), neighbors: reference(neighbors),
    environment, gaps: gapRead, results: [], sources: [], snapshot: null }));
  assert.equal(gate3.value.result.passed, false);
  assert.deepEqual(gate3.value.result.findings.map(finding => [finding.code, finding.target]), [["work_artifact_not_single", supplierWork]],
    "Exactly the supplier's work would produce both garden-data and the external artifact");
  const before = snapshot(store);
  const settled = settleCandidate(store, { project, level: 3, candidate: reference(candidate3.record),
    outcome: { ...gate3.value.result, codes: [...gate3.value.result.codes], basis: reference(gate3) } });
  assert.equal(ok(settled).state, "rejected", "A failed gate never accepts L3");
  assert.equal(store.get(`om-frame:${project}:3`), null, "No accepted L3 frame exists");
  const evidence = (rows: ReturnType<typeof snapshot>) => rows.filter(row => {
    const kind = store.get(row.head.id)?.kind;
    return kind === "artifact" || kind === "task-run" || kind === "plan" || kind === "graph-layer" || kind === "om-frame";
  });
  assert.deepEqual(evidence(snapshot(store)), evidence(before), "The refused settlement adds no layer, frame, plan, run or receipt");
  });

  await t.test("a horizon producer cannot claim an external artifact as its outcome", async t => {
  const { store, request, rogue } = externalOutcomeFixture(t);
  const attempt = refusedWithoutEvidence(store, request);
  const finding = (attempt.findings ?? []).find(item => item.code === "external_outcome")!;
  assert.ok(finding, "The refusal names the exact external outcome claim");
  assert.equal(finding.target, rogue);
  });
});

/** The external-outcome refusal scenario: a work that claims an external artifact as its outcome, on the current
 * native route up to its works frame request. */
function externalOutcomeFixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-transition-external-outcome-")), workspace = join(root, "workspace"), database = join(root, "state.sqlite");
  mkdirSync(workspace); writeFileSync(join(workspace, "README.md"), "Local external-outcome regression fixture.\n");
  git(workspace, ["init", "-b", "main"]); git(workspace, ["add", "README.md"]);
  git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture baseline"]);
  const store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = gardenGraph(), rogue = "garden-rogue-work";
  graph.artifacts.push({ ...clone(graph.artifacts.find(item => item.id === "garden-data")!), id: "garden-claimed-external",
    external: true, terminal: true });
  graph.nodes.push({ ...clone(graph.nodes.find(node => node.id === "garden-produce-work")!), id: rogue,
    outcome: "garden-claimed-external", ports: [], tests: [],
    code: [{ path: `${rogue}.txt`, access: "write", status: "planned" }] });
  const { level: _level, ...l1 } = projectGraph(graph, 1);
  preparedFeatures(engine, project, l1 as Graph, undefined, "");
  engine.environments.configure(project, { workspace,
    implementer: { actor: "fixture-implementer", model: "fixture", effort: "high",
      command: { executable: process.execPath, args: ["--version"] } },
    reviewer: { actor: "fixture-reviewer", model: "fixture", effort: "high",
      command: { executable: process.execPath, args: ["--version"] } },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10_000,
    requestCapacityChars: 100_000 }, 0);
  const { works, handoff } = nativeSetup(engine, graph);
  const request = { ...works, works: { contract: "works-frame/v1" as const,
    producer: reference(handoff.producer), ledger: reference(handoff.record), bindings: [] } };
  return { store, request, rogue };
}

/** LG15-02 (codex-omg2 №7575): two refused works-frame attempts measured from a snapshot taken BEFORE the first one: the same refusal, no new or
 * changed record after either attempt, and no L3 candidate, plan, run or receipt (kind "artifact") evidence. */
function refusedWithoutEvidence(store: Store, request: Parameters<typeof writeWorksFrame>[1]) {
  const before = snapshot(store);
  const attempt = writeWorksFrame(store, request);
  assert.equal(attempt.ok, false, "A horizon work claiming an external outcome is refused");
  if (attempt.ok) assert.fail("unreachable");
  assert.equal(attempt.refusal.code, "graph_invalid");
  assert.deepEqual(snapshot(store), before, "The first refused attempt writes nothing");
  const again = writeWorksFrame(store, request);
  assert.deepEqual(again.ok ? {} : again.refusal, attempt.refusal, "The repeat reproduces the exact refusal");
  assert.deepEqual(snapshot(store), before, "The repeated refused attempt writes nothing");
  assert.equal(store.list().filter(row => row.kind === "artifact" || row.kind === "task-run" || row.kind === "plan"
    || row.kind === "frame-candidate" && (row.value as { level?: number }).level === 3).length, 0,
    "The refused work leaves no L3 candidate, plan, run or receipt evidence");
  return attempt.refusal;
}
