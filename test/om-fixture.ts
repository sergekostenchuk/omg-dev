import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { receiptId, type ArtifactReceipt, type MachinePlan } from "../src/compiler/model.js";
import { EngineError } from "../src/errors.js";
import type { Graph, Node } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { ProductEngine } from "../src/product/engine.js";
import type { OmResult, Refusal } from "../src/om/refusal.js";
import { reference, type Ref, type StageArtifact } from "../src/pipeline/contracts.js";
import type { TaskRun } from "../src/execution/model.js";
import { git, inspectRepository, type ExecutionRoot, type RepositoryState } from "../src/runtime/environment.js";
import type { Revision } from "../src/storage/store.js";
import { Store, type Write } from "../src/storage/store.js";
import { inputDecisionWrite, writeAddressing, type InputDecisionProposal } from "../src/om/addressing.js";
import { writeOmInput } from "../src/om/input.js";
import { writeHorizon } from "../src/om/horizon.js";
import { fillObligations, prepareFrame, type FrameRead, type FrameRequest } from "../src/om/frame-obligations.js";
import { gateCandidate, writeCandidate } from "../src/om/frame-candidate.js";
import { settleCandidate } from "../src/om/frame-accept.js";
import type { LayerProposal, ProposalRequest } from "../src/om/frame-proposals.js";
import { writeGaps, type GapRequest } from "../src/om/gaps.js";
import { gapLinesId, writeGapLines, type GapLinesRecord } from "../src/om/gap-lines.js";
import { writeOmObligations } from "../src/om/obligations.js";
import { writeWorksFrame } from "../src/om/works-frame.js";
import { writeNeighbors } from "../src/om/neighbors.js";
import { writeAtomicGate } from "../src/om/atomic-gate.js";
import { writeFeasibility } from "../src/om/feasibility.js";
import { writeHandoff } from "../src/om/handoff.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { preparedFeatures, refinedLayers } from "./product-fixture.js";

export type GardenVariant = "standard" | "cross";
export const OM_FIXTURE_ERROR = "om_fixture_invalid";

// A refusal is checked together with its code: a check that accepts any addressed refusal is green for whatever refused
// first. The expected code is required and never defaulted — an empty string, an empty list and an empty item fail here
// instead of silently passing — and the two channels stay apart: a negative OmResult is refusedWith, a thrown EngineError
// is thrownWith. Neither says a record was saved or not; the caller's snapshot checks do. Every test of a value here is
// strict (`=== false`, `typeof … === "string"`, `instanceof`, list membership): a truthiness test would let a damaged
// envelope or a lookalike turn a check green.
const shown = (value: unknown): string => value === null ? "null" : typeof value === "object" ? "an object" : String(value);

const notRefusal = (wanted: string, result: unknown): string => {
  const flag = (result as { readonly ok?: unknown }).ok;
  return flag === true ? `${wanted}, received success` : `${wanted}, received a result whose ok is ${shown(flag)}`;
};

function expectedCodes(code: string | readonly string[]): readonly string[] {
  const codes: unknown = typeof code === "string" ? [code] : code;
  assert.ok(Array.isArray(codes) && codes.length > 0 && codes.every(item => typeof item === "string" && item.length > 0),
    "A refusal check names its expected code: a non-empty string or a non-empty list of non-empty strings");
  return codes as readonly string[];
}

/** The returned refusal of a negative result carries one of the named codes, an address and a reason. */
export function refusedWith(result: OmResult<unknown>, code: string | readonly string[]): Refusal {
  const codes = expectedCodes(code);
  const wanted = `Expected a refusal ${codes.join(" | ")}`;
  assert.ok(typeof result === "object" && result !== null, `${wanted}, received ${shown(result)}`);
  // The discriminator of a refusal is the literal `ok: false`: a missing, null, zero or otherwise falsy flag is a damaged
  // envelope, not a refusal, and `true` is an unexpected success.
  if (result.ok !== false) assert.fail(notRefusal(wanted, result));
  const refusal: unknown = result.refusal;
  assert.ok(typeof refusal === "object" && refusal !== null, `${wanted}, received a result without a refusal`);
  const { code: received, message, at } = refusal as { readonly code?: unknown; readonly message?: unknown; readonly at?: unknown };
  assert.ok(typeof received === "string" && codes.includes(received), `Expected ${codes.join(" | ")}, received ${shown(received)}: ${shown(message)}`);
  assert.ok(typeof at === "object" && at !== null && typeof (at as { target?: unknown }).target === "string"
    && (at as { target: string }).target.length > 0, "A refusal is addressed");
  assert.ok(typeof message === "string" && message.length > 0, "A refusal says why");
  return result.refusal;
}

/** The call throws an EngineError with one of the named codes; a returned result, even a refusal, does not count. */
export function thrownWith(action: () => unknown, code: string | readonly string[]): EngineError {
  const codes = expectedCodes(code);
  let outcome: { readonly thrown: true; readonly error: unknown } | { readonly thrown: false };
  // The failure of this check stays outside the try: its own AssertionError is never taken for the expected exception.
  try { action(); outcome = { thrown: false }; } catch (error) { outcome = { thrown: true, error }; }
  if (!outcome.thrown) assert.fail(`Expected ${codes.join(" | ")} to be thrown, the call returned`);
  const error = outcome.error;
  assert.ok(error instanceof EngineError, `Expected an EngineError ${codes.join(" | ")}, received ${shown(error)}`);
  assert.ok(typeof error.code === "string" && codes.includes(error.code), `Expected ${codes.join(" | ")}, received ${shown(error.code)}: ${shown(error.message)}`);
  return error;
}

export interface FixtureLayer {
  projection: ReturnType<typeof projectGraph>;
  inputs: Ref[];
  obligations: Json[];
  layerProofs?: { level: 1 | 2 | 3; hash: string; inputs: Ref[] }[];
}

export type OmFixtureMode = "stages" | "n2" | "executed";
export interface OmFixtureOptions { mode: OmFixtureMode }

export interface OmPreparedFixture {
  project: string;
  root: string;
  workspace: string;
  database: string;
  graph: Graph;
  graphRevision: Revision<Graph>;
  stages: Readonly<Record<UpstreamStage, Revision<StageArtifact>>>;
  layers: Readonly<Record<1 | 2 | 3, Revision<FixtureLayer>>>;
  readonly store: Store;
  readonly engine: ProductEngine;
  reopen(): ProductEngine;
}

export interface OmFixture extends OmPreparedFixture {
  plan: Revision<MachinePlan>;
  runs: readonly Revision<TaskRun>[];
  repository: RepositoryState;
  receipts: Readonly<Record<string, Revision<ArtifactReceipt>>>;
}

const endpointCode = (graph: Graph, nodeId: string) => structuredClone(graph.nodes.find(node => node.id === nodeId)!.code[0]!);

const AGENT = String.raw`
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
const request=JSON.parse(readFileSync(0,'utf8')),context=request.subject.context;
const response={protocol:request.protocol,requestId:request.requestId};
if(request.mode==='implement'){
  for(const ref of context.scope.code.filter(item=>item.access==='write')){
    mkdirSync(dirname(ref.path),{recursive:true});
    writeFileSync(ref.path,'fixture:'+context.binding.task+'\n');
  }
  response.text='Implemented the deterministic garden fixture task';
  response.artifacts=context.produces.map(id=>({id}));
}else response.review={verdict:'pass',kind:'none',findings:[]};
process.stdout.write(JSON.stringify(response));
`;

function validateGardenArguments(variant: GardenVariant, project: string): void {
  if (variant !== "standard" && variant !== "cross") {
    throw new EngineError(OM_FIXTURE_ERROR, "Garden variant must be standard or cross", { target: "/variant" });
  }
  if (typeof project !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(project)) {
    throw new EngineError(OM_FIXTURE_ERROR, "Garden project needs a valid project ID", { target: "/project" });
  }
}

function validateTestContext(t: TestContext): void {
  if (typeof t !== "object" || t === null || typeof (t as { after?: unknown }).after !== "function") {
    throw new EngineError(OM_FIXTURE_ERROR, "OM fixture needs a node:test context", { target: "/t" });
  }
}

function identityWork(operation: Node): Node {
  return { ...structuredClone(operation), id: `w-${operation.id}`, kind: "work", parent: operation.id,
    title: `${operation.title} (representative operation)` };
}

export function gardenGraph(variant: GardenVariant = "standard", project = "garden"): Graph {
  validateGardenArguments(variant, project);
  const graph = exampleGraph(project);
  const boundary = graph.nodes[0]!.boundary;
  const contract = `${project}-contract`;
  const port = (id: string, direction: "in" | "out") => ({ id, direction, contract });
  const node = (id: string, kind: "block" | "operation" | "work", parent: string, outcome: string,
    ports: ReturnType<typeof port>[], active = false): Node => ({
      id, kind, parent, title: id, outcome, boundary, ports,
      code: active ? [{ path: `${id}.txt`, access: "write", status: "planned" }] : [],
      tests: active ? [`${id}-test`] : [],
    });

  graph.artifacts.push(
    { id: `${project}-prep`, contract, external: false, terminal: false },
    { id: `${project}-later`, contract, external: false, terminal: true },
  );
  graph.nodes.push(
    node(`${project}-prep-operation`, "operation", `${project}-produce-block`, `${project}-prep`, [port("out", "out")]),
    node(`${project}-prep-work`, "work", `${project}-prep-operation`, `${project}-prep`, [port("out", "out")], true),
    node(`${project}-later-block`, "block", `${project}-product`, `${project}-later`, [port("in", "in")]),
    node(`${project}-later-operation`, "operation", `${project}-later-block`, `${project}-later`, [port("in", "in")]),
  );
  for (const id of [`${project}-produce-operation`, `${project}-produce-work`]) {
    graph.nodes.find(item => item.id === id)!.ports.push(port("in", "in"));
  }
  graph.connectors.push({ id: `${project}-prep-flow`, artifact: `${project}-prep`, returnsTo: `${project}-produce-block`, wakeTest: null,
    bindings: [
      { level: 2, producer: { node: `${project}-prep-operation`, port: "out" },
        consumers: [{ node: `${project}-produce-operation`, port: "in" }], anchor: null },
      { level: 3, producer: { node: `${project}-prep-work`, port: "out" },
        consumers: [{ node: `${project}-produce-work`, port: "in" }], anchor: null },
    ] });
  const flow = graph.connectors.find(item => item.id === `${project}-flow`)!;
  flow.bindings.find(binding => binding.level === 1)!.consumers.push({ node: `${project}-later-block`, port: "in" });
  flow.bindings.find(binding => binding.level === 2)!.consumers.push({ node: `${project}-later-operation`, port: "in" });

  if (variant === "cross") for (const [kind, level] of [["block", 1], ["operation", 2], ["work", 3]] as const) {
    graph.nodes.find(item => item.id === `${project}-produce-${kind}`)!.ports.push(port("out-alt", "out"));
    graph.nodes.find(item => item.id === `${project}-consume-${kind}`)!.ports.push(port("in-alt", "in"));
    flow.bindings.find(binding => binding.level === level)!.consumers.push({ node: `${project}-consume-${kind}`, port: "in-alt" });
    flow.bindings.push({ level, producer: { node: `${project}-produce-${kind}`, port: "out-alt" },
      consumers: [{ node: `${project}-consume-${kind}`, port: "in" }], anchor: null });
  }

  graph.tests.push({ id: `${project}-prep-work-test`, node: `${project}-prep-work`,
    command: { executable: "node", args: ["--version"] }, covers: [`${project}-prep-flow`] });
  graph.horizon.push(`${project}-prep-work`);

  const full = enrichedGraph(graph, project);
  for (const suffix of ["later", "refusal"] as const) {
    full.nodes.push(identityWork(full.nodes.find(item => item.id === `${project}-${suffix}-operation`)!));
  }
  const fullFlow = full.connectors.find(item => item.id === `${project}-flow`)!;
  const wakeTest = `${project}-produce-work-test`;
  const anchor = `anchor-${project}-flow`;
  fullFlow.wakeTest = wakeTest;
  full.anchors.push({ id: anchor, owner: `${project}-produce-work`, outcome: `${project}-data`, test: wakeTest });
  fullFlow.bindings.push({ level: 3,
    producer: { node: `${project}-produce-work`, port: "out", codeRef: endpointCode(full, `${project}-produce-work`) },
    consumers: [{ node: `w-${project}-later-operation`, port: "in" }], anchor });
  const success = full.journeys!.find(journey => journey.terminal === "success")!;
  full.journeys!.push({ ...structuredClone(success), id: `${project}-journey-later`,
    path: [`${project}-produce-block`, `${project}-later-block`], outcome: `${project}-later` });
  return full;
}

function take<T>(result: OmResult<T>): T {
  if (!result.ok) throw new EngineError(OM_FIXTURE_ERROR,
    `${result.refusal.code}: ${result.refusal.message}`, result.refusal.at);
  return result.value;
}

/** Prepare only current upstream stages, even when called from an inherited era scope. */
export function prepareOmFixtureStages(engine: ProductEngine, project: string, graph: Graph): void {
  const { level: _level, ...l1 } = projectGraph(graph, 1);
  // Explicit empty era bypasses an inherited historical scope; undefined would select its old producer.
  preparedFeatures(engine, project, l1 as Graph, undefined, "");
}

/** Build each accepted layer through the current OM producers, without Refinement phases. */
export function prepareNativeLayers(engine: ProductEngine, project: string, desired: Graph, mode: "n2" | "executed"): void {
  const store = engine.store;
  let input = take(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const graphRef = reference(store.get(`graph:${project}`)!);
  const first = take(writeHorizon(store, { project, input: reference(input), graph: graphRef,
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
    const mapped = take(fillObligations(frame.upper, frame.scope,
      { graph, reference: { ...frame.request.graph, hash: hashJson(graph) }, frame: null }, frame.upperRef, level));
    const nodes = projected.nodes.filter(node => node.kind === (level === 2 ? "operation" : "work")
      && (level === 2 || frame.scope.nodes.includes(node.parent!))), selected = new Set(nodes.map(node => node.id));
    const value: LayerProposal = { base: { graph: frame.request.graph, frame: null }, level,
      ...(level === 3 ? { worksContract: "works-frame/v1" as const } : {}), source: "decision", status: "proposed", nodes,
      fills: mapped.fills.filter(fill => selected.has(fill.node)).map(fill => ({ obligation: fill.obligation, node: fill.node,
        ...(fill.port === undefined ? {} : { port: fill.port,
          ...(level === 3 ? { codeRef: structuredClone(nodes.find(node => node.id === fill.node)!.code[0]!) } : {}) }) })),
      localConnectors: level === 3 ? [] : projected.connectors.map(connector => ({ ...connector,
        bindings: connector.bindings.filter(binding => binding.level === 2) })).filter(connector => connector.bindings.length),
      artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
      tests: projected.tests.filter(test => level === 2 || selected.has(test.node)), edges: projected.edges ?? [],
      journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
      anchors: level === 2 ? projected.anchors : [], removes: [], replaces: [], redefines: [] };
    return reference(store.write({ id: `om-proposal:${project}:fixture-${level}`, kind: "layer-proposal", expected: 0, value }));
  };
  const frame2: FrameRequest = { project, level: 2, graph: graphRef, horizon: reference(first.gate), layer: null, frame: null, upper: null };
  const candidate2 = take(writeCandidate(store, { frame: frame2, proposals: [proposal(structuredClone(take(prepareFrame(store, frame2))) as unknown as FrameRead)] }));
  assert.equal(candidate2.state, "candidate");
  if (candidate2.state !== "candidate") throw new EngineError(OM_FIXTURE_ERROR, "Native L2 candidate is required");
  const gate2 = take(gateCandidate(store, { project, candidate: reference(candidate2.record) }));
  const accepted2 = take(settleCandidate(store, { project, level: 2, candidate: reference(candidate2.record),
    outcome: { gate: "G3", candidate: gate2.candidate, graphHash: gate2.graphHash, passed: gate2.passed, codes: gate2.findings.map(finding => finding.code) } }));
  assert.equal(accepted2.state, "accepted"); assert.ok(accepted2.graph && accepted2.layer && accepted2.frame);
  if (mode === "n2") return;
  const graph = reference(accepted2.graph), layer = reference(accepted2.layer), upperFrame = reference(accepted2.frame);
  const decisions: InputDecisionProposal["decision"][] = [
    { target: `${project}-B1`, field: "nodes", value: [`${project}-produce-block`, `${project}-consume-block`] },
    { target: `${project}-B1`, field: "state", value: { writer: `${project}-produce-block`, authority: `${project}-consume-block`, rollback: `${project}-consume-block` } },
    { target: `${project}-R1#1`, field: "checkKind", value: "test" },
  ];
  input = take(writeAddressing(store, { project, input: reference(input), graph,
    decisions: decisions.map(decision => ({ pending: inputDecisionWrite({ project, input: reference(input), graph, layers: [], decision }) as Write })) }));
  const horizon = take(writeHorizon(store, { project, input: reference(input), graph, refinement: layer, available: {},
    choice: { choiceVersion: "fixture-works", features: [{ outcome: `${project}-result` }], excluded: [] } }));
  const frame3: FrameRequest = { project, level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
    upper: { horizon: reference(horizon.gate), frame: upperFrame } };
  const works: ProposalRequest = { frame: frame3, proposals: [proposal(structuredClone(take(prepareFrame(store, frame3))) as unknown as FrameRead)] };
  acceptNativeWorks(engine, project,
    { frame: { ...frame2, graph, layer, frame: upperFrame, horizon: reference(horizon.gate) }, proposals: [] }, works);
}

/** Accept a fresh works proposal (including an explicit replacement) and publish its M8/M9. */
export function acceptNativeWorks(engine: ProductEngine, project: string, operations: ProposalRequest, works: ProposalRequest): void {
  const store = engine.store;
  const gaps = take(writeGaps(store, { project, input: reference(store.get(`om-input:${project}`)!),
    graph: works.frame.graph, horizon: works.frame.horizon, operations, works }));
  const gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const previous = store.get<GapLinesRecord>(gapLinesId(project));
  const lines = take(writeGapLines(store, { project, previous: previous ? reference(previous) : null,
    pass: (previous?.value.request.pass ?? 0) + 1, gaps: gapRead, closures: [] }));
  const handoff = take(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [] }));
  assert.deepEqual(handoff.handoff.obligations, []);
  const candidate3 = take(writeWorksFrame(store, { ...works, works: { contract: "works-frame/v1",
    producer: reference(handoff.producer), ledger: reference(handoff.record), bindings: [] } }));
  assert.equal(candidate3.state, "candidate");
  if (candidate3.state !== "candidate") throw new EngineError(OM_FIXTURE_ERROR, "Native L3 candidate is required");
  const neighbors = take(writeNeighbors(store, { project, candidate: reference(candidate3.record) }));
  const environment = reference(engine.environments.get(project));
  const gate3 = take(writeAtomicGate(store, { project, candidate: reference(candidate3.record), neighbors: reference(neighbors),
    environment, gaps: gapRead, results: [], sources: [] }));
  assert.equal(gate3.value.result.passed, true, canonical(gate3.value.result.findings));
  const accepted3 = take(settleCandidate(store, { project, level: 3, candidate: reference(candidate3.record),
    outcome: { ...gate3.value.result, codes: [...gate3.value.result.codes], basis: reference(gate3) } }));
  assert.equal(accepted3.state, "accepted"); assert.ok(accepted3.graph && accepted3.layer && accepted3.frame);
  const feasibility = take(writeFeasibility(store, { project, graph: reference(accepted3.graph), layer: reference(accepted3.layer),
    frame: reference(accepted3.frame), environment, expected: store.get(`om-feasibility:${project}`)?.revision ?? 0 }));
  assert.equal(feasibility.value.ready, true);
  take(writeHandoff(store, { project, feasibility: reference(feasibility), expected: store.get(`stage:${project}:om-g2`)?.revision ?? 0 }));
}

export function createOmFixture(t: TestContext, variant: GardenVariant, project: string, options: { mode: "executed" }): Promise<OmFixture>;
export function createOmFixture(t: TestContext, variant: GardenVariant, project: string, options: OmFixtureOptions): Promise<OmPreparedFixture>;
export function createOmFixture(t: TestContext, variant?: GardenVariant, project?: string, historicalCommit?: string): Promise<OmFixture>;
export async function createOmFixture(t: TestContext, variant: GardenVariant = "standard", project = "garden", route?: string | OmFixtureOptions): Promise<OmPreparedFixture | OmFixture> {
  validateTestContext(t);
  validateGardenArguments(variant, project);
  if (route !== undefined && typeof route !== "string" && (route === null || typeof route !== "object"
    || !["stages", "n2", "executed"].includes(route.mode)))
    throw new EngineError(OM_FIXTURE_ERROR, "Fixture mode must be stages, n2 or executed", { target: "/mode" });
  const mode = typeof route === "object" ? route.mode : undefined;
  const maxContextChars = mode ? 200_000 : 100_000;
  const root = mkdtempSync(join(tmpdir(), "omg-om-fixture-"));
  const workspace = join(root, "workspace");
  const database = join(root, "state.sqlite");
  const agent = join(root, "agent.mjs");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "README.md"), "A deterministic garden product fixture.\n");
  writeFileSync(agent, AGENT);
  git(workspace, ["init", "-b", "main"]);
  git(workspace, ["add", "README.md"]);
  git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture baseline"]);
  let store = new Store(database);
  let engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  const graph = gardenGraph(variant, project);
  if (mode) prepareOmFixtureStages(engine, project, graph);
  else preparedFeatures(engine, project, graph, undefined, route as string | undefined);
  const command = { executable: process.execPath, args: [agent] };
  engine.environments.configure(project, {
    workspace,
    implementer: { actor: "fixture-implementer", model: "fixture", effort: "high", command },
    reviewer: { actor: "fixture-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] },
    timeoutMs: 10_000,
    ...(mode ? { requestCapacityChars: maxContextChars } : {}),
  }, 0);
  const read = <T>(id: string): Revision<T> => {
    const record = store.get<T>(id);
    if (!record) throw new EngineError(OM_FIXTURE_ERROR, "Required garden fixture record is missing", { target: id });
    return record;
  };
  const prepared = (): OmPreparedFixture => {
    const graphRevision = read<Graph>(`graph:${project}`);
    return { project, root, workspace, database, graph: graphRevision.value, graphRevision,
      stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, read<StageArtifact>(`stage:${project}:${stage}`)])) as Record<UpstreamStage, Revision<StageArtifact>>,
      layers: Object.fromEntries(([1, 2, 3] as const).map(level => [level, read<FixtureLayer>(`graph-layer:${project}:${level}`)])) as Record<1 | 2 | 3, Revision<FixtureLayer>>,
      get store() { return store; }, get engine() { return engine; },
      reopen() { store.close(); store = new Store(database); engine = new ProductEngine(store); return engine; },
    };
  };
  if (mode === "stages") return prepared();
  if (mode) {
    prepareNativeLayers(engine, project, graph, mode);
    if (mode === "n2") return prepared();
  } else {
    refinedLayers(engine, project);
    const feasibility = engine.refinement.assess(project, 0);
    const om = engine.refinement.publish(project, reference(feasibility), 0);
    engine.pipeline.accept(project, "om-g2", om.revision);
  }
  const plan = engine.compiler.compile(project);
  const compilation = engine.compiler.publish(project, reference(plan), 0);
  engine.pipeline.accept(project, "compilation", compilation.revision);
  const runs = await engine.executor.run(project, reference(plan), { retry: false, maxContextChars, maxCorrections: 0 });
  if (runs.length !== plan.value.tasks.length || !plan.value.tasks.every(task =>
    runs.some(run => run.value.taskId === task.id && run.value.state === "committed"))) {
    throw new EngineError(OM_FIXTURE_ERROR, "Every garden task must finish with a committed run", { target: "/runs" });
  }


  const graphRevision = read<Graph>(`graph:${project}`);
  const acceptedGraph = graphRevision.value;
  const receipts = Object.fromEntries([`${project}-data`, `${project}-prep`, `${project}-result`].map(artifactId => [artifactId,
    read<ArtifactReceipt>(receiptId(project, artifactId))])) as Record<string, Revision<ArtifactReceipt>>;
  const execution = read<ExecutionRoot>(`execution-root:${project}`);
  const inspected = inspectRepository({ ...engine.environments.get(project).value, workspace: execution.value.path }, acceptedGraph);
  if (!inspected.state || inspected.findings.length !== 0) {
    throw new EngineError(OM_FIXTURE_ERROR, "Executed garden repository must remain valid", { target: execution.value.path });
  }
  const repository: RepositoryState = inspected.state;
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage,
    read<StageArtifact>(`stage:${project}:${stage}`)])) as Record<UpstreamStage, Revision<StageArtifact>>;
  const layers = Object.fromEntries(([1, 2, 3] as const).map(level => [level,
    read<FixtureLayer>(`graph-layer:${project}:${level}`)])) as Record<1 | 2 | 3, Revision<FixtureLayer>>;
  return {
    project, root, workspace, database, graph: acceptedGraph, graphRevision, plan, runs, repository, stages, layers, receipts,
    get store() { return store; },
    get engine() { return engine; },
    reopen() { store.close(); store = new Store(database); engine = new ProductEngine(store); return engine; },
  };
}

export function createCrossOmFixture(t: TestContext, project: string, options: { mode: "executed" }): Promise<OmFixture>;
export function createCrossOmFixture(t: TestContext, project: string, options: OmFixtureOptions): Promise<OmPreparedFixture>;
export function createCrossOmFixture(t: TestContext, project?: string): Promise<OmFixture>;
export async function createCrossOmFixture(t: TestContext, project = "garden", options?: OmFixtureOptions): Promise<OmPreparedFixture> {
  return options === undefined ? createOmFixture(t, "cross", project) : createOmFixture(t, "cross", project, options);
}

/**
 * NR1 (№3591, №3600): a trusted reader returns what its records hold and names the records it read itself; the checked
 * reader of an earlier era named the whole trail it had checked again. Outputs of the eras are equal but for `references`,
 * and the trusted ones are a subset of the trail. Compares exactly that.
 */
export function sameButReferences(actual: unknown, expected: unknown, message?: string): void {
  const parsed = typeof expected === "string" ? JSON.parse(expected) as unknown : JSON.parse(JSON.stringify(expected)) as unknown;
  const current = JSON.parse(JSON.stringify(actual)) as unknown;
  const collect = (value: unknown, into: Set<string>): unknown => {
    if (Array.isArray(value)) return value.map(item => collect(item, into));
    if (value === null || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "references" && Array.isArray(item)) {
        for (const ref of item) into.add(JSON.stringify(Object.fromEntries(Object.entries(ref as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1))));
        continue;
      }
      result[key] = collect(item, into);
    }
    return result;
  };
  const mine = new Set<string>(), theirs = new Set<string>();
  assert.deepEqual(collect(current, mine), collect(parsed, theirs), message);
  const extra = [...mine].filter(ref => !theirs.has(ref));
  const named = (refs: Iterable<string>, id: string) => [...refs].filter(ref => (JSON.parse(ref) as { id: string }).id === id).map(ref => (JSON.parse(ref) as { revision: number }).revision);
  assert.deepEqual(extra.map(ref => { const { id, revision } = JSON.parse(ref) as { id: string; revision: number };
    return `${id}@${revision} (trail: ${named(theirs, id).join(",") || "none"})`; }), [], `${message ?? "references"}: a trusted reader names only records of the checked trail`);
}
