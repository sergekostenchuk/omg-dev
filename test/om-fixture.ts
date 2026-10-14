import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Json } from "../src/canonical.js";
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
import { Store } from "../src/storage/store.js";
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

export interface OmFixture {
  project: string;
  root: string;
  workspace: string;
  database: string;
  graph: Graph;
  graphRevision: Revision<Graph>;
  plan: Revision<MachinePlan>;
  runs: readonly Revision<TaskRun>[];
  repository: RepositoryState;
  stages: Readonly<Record<UpstreamStage, Revision<StageArtifact>>>;
  layers: Readonly<Record<1 | 2 | 3, Revision<FixtureLayer>>>;
  receipts: Readonly<Record<string, Revision<ArtifactReceipt>>>;
  readonly store: Store;
  readonly engine: ProductEngine;
  reopen(): ProductEngine;
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

export async function createOmFixture(t: TestContext, variant: GardenVariant = "standard", project = "garden", historicalCommit?: string): Promise<OmFixture> {
  validateTestContext(t);
  validateGardenArguments(variant, project);
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
  preparedFeatures(engine, project, graph, undefined, historicalCommit);
  const command = { executable: process.execPath, args: [agent] };
  engine.environments.configure(project, {
    workspace,
    implementer: { actor: "fixture-implementer", model: "fixture", effort: "high", command },
    reviewer: { actor: "fixture-reviewer", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] },
    timeoutMs: 10_000,
  }, 0);
  refinedLayers(engine, project);

  const feasibility = engine.refinement.assess(project, 0);
  const om = engine.refinement.publish(project, reference(feasibility), 0);
  engine.pipeline.accept(project, "om-g2", om.revision);
  const plan = engine.compiler.compile(project);
  const compilation = engine.compiler.publish(project, reference(plan), 0);
  engine.pipeline.accept(project, "compilation", compilation.revision);
  const runs = await engine.executor.run(project, reference(plan), { retry: false, maxContextChars: 100_000, maxCorrections: 0 });
  if (runs.length !== plan.value.tasks.length || !plan.value.tasks.every(task =>
    runs.some(run => run.value.taskId === task.id && run.value.state === "committed"))) {
    throw new EngineError(OM_FIXTURE_ERROR, "Every garden task must finish with a committed run", { target: "/runs" });
  }

  const read = <T>(id: string): Revision<T> => {
    const record = store.get<T>(id);
    if (!record) throw new EngineError(OM_FIXTURE_ERROR, "Required garden fixture record is missing", { target: id });
    return record;
  };
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

export async function createCrossOmFixture(t: TestContext, project = "garden"): Promise<OmFixture> {
  return createOmFixture(t, "cross", project);
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
