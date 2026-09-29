import test from "node:test";
import assert from "node:assert/strict";
import { types } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, type Json } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import {
  adapterRequest, readAdapterResponse,
  type AdapterRequestInput, type AdapterResponseInput,
} from "../src/om/model-call.js";
import type { OmResult } from "../src/om/refusal.js";
import { runProcess, type ProcessResult } from "../src/runtime/process.js";

const requestId = "request:om-e4";
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
const unknownConfirmed = { model: null, effort: null, speed: null };
const confirmed = { model: "fixture-confirmed", effort: "high", speed: "fast" };
const fixturePath = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));

function valueOf<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`Unexpected refusal: ${result.refusal.code}: ${result.refusal.message} ${JSON.stringify(result.refusal.at)}`);
  return result.value;
}

function request(over: Partial<AdapterRequestInput> = {}): AdapterRequestInput {
  return { requestId, packet: { question: "Who produces this contract?" }, model: "fixture", effort: "high", ...over };
}

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { protocol: "omg-agent/v1", requestId, research: { answer: "producer" }, usage: null,
    confirmed: { ...unknownConfirmed }, ...over };
}

function processResult(stdout: string, over: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", ...over };
}

function decode(stdout: string, over: Partial<ProcessResult> = {}) {
  return valueOf(readAdapterResponse({ requestId, process: processResult(stdout, over) }));
}

function omit(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function deeplyFrozen(value: unknown): boolean {
  return value === null || typeof value !== "object"
    || (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));
}

test("E4 encodes only the research wire request and keeps caller packets independent", () => {
  const packet = { z: ["question", { consumer: "M5" }], a: { goal: "contract" } };
  const input = request({ packet, speed: "fast" });
  const originalPacket = structuredClone(packet);
  const result = adapterRequest(input), encoded = valueOf(result);
  assert.deepEqual(encoded, { protocol: "omg-agent/v1", requestId, mode: "research", model: "fixture",
    effort: "high", speed: "fast", prompt: canonical(originalPacket) });
  assert.ok(deeplyFrozen(result));
  assert.equal(Reflect.set(encoded, "prompt", "forged"), false);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(packet.a), false);
  packet.a.goal = "changed by caller";
  input.model = "another model";
  assert.equal(encoded.prompt, canonical(originalPacket));
  assert.equal(encoded.model, "fixture");
  assert.equal(Object.hasOwn(valueOf(adapterRequest(request())), "speed"), false);
  assert.equal(valueOf(adapterRequest(request({ speed: "inherited" }))).speed, "inherited");
});

test("E4 reports transport success without treating research as an accepted product answer", () => {
  const payloads: Json[] = [null, false, 7, "not a structured product answer", [], { unexpected: ["field", null] }];
  for (const research of payloads) {
    const result = decode(JSON.stringify(envelope({ research })));
    assert.equal(result.kind, "answered");
    if (result.kind !== "answered") assert.fail("Research form belongs to E3");
    assert.deepEqual(JSON.parse(result.raw), research);
    assert.equal(result.usage, null);
    assert.deepEqual(result.confirmed, unknownConfirmed);
  }
  const original = envelope({ usage: { ...usage }, confirmed: { ...confirmed } });
  const process = processResult(JSON.stringify(original));
  const result = readAdapterResponse({ requestId, process }), answer = valueOf(result);
  assert.equal(answer.kind, "answered");
  assert.deepEqual(answer.usage, usage);
  assert.deepEqual(answer.confirmed, confirmed);
  assert.ok(deeplyFrozen(result));
  assert.equal(Reflect.set(answer.usage!, "inputTokens", 0), false);
  assert.equal(Reflect.set(answer.confirmed, "model", "forged"), false);
  (original.usage as typeof usage).inputTokens = 1;
  (original.confirmed as typeof confirmed).model = "changed";
  process.stdout = "{}";
  assert.equal(answer.usage?.inputTokens, 120);
  assert.equal(answer.confirmed.model, "fixture-confirmed");
});

test("E4 retains usage from a failed matching dispatch and refuses attribution from foreign envelopes", () => {
  for (const status of [{ exitCode: 7 }, { exitCode: null, signal: "SIGTERM" as const }]) {
    const result = decode(JSON.stringify(envelope({ usage, confirmed })), status);
    assert.equal(result.kind, "interrupted");
    if (result.kind !== "interrupted") assert.fail("Process failure must be interrupted");
    assert.equal(result.error.code, "model_adapter_interrupted");
    assert.equal(result.error.field, "process");
    assert.deepEqual(result.usage, usage);
    assert.deepEqual(result.confirmed, confirmed);
    assert.ok(deeplyFrozen(result));
    assert.equal(Object.hasOwn(result, "raw"), false);
  }
  for (const foreign of [{ requestId: "another-dispatch" }, { protocol: "another-protocol" }]) {
    for (const exitCode of [0, 9]) {
      const result = decode(JSON.stringify(envelope({ ...foreign, usage, confirmed })), { exitCode });
      assert.equal(result.kind, exitCode === 0 ? "off-form" : "interrupted");
      assert.equal(result.usage, null);
      assert.deepEqual(result.confirmed, unknownConfirmed);
    }
  }
  const partial = decode(JSON.stringify({ protocol: "omg-agent/v1", requestId, usage }), { exitCode: 1 });
  assert.equal(partial.kind, "interrupted");
  assert.deepEqual(partial.usage, usage);
  assert.deepEqual(partial.confirmed, unknownConfirmed);
  assert.equal(decode("not JSON", { exitCode: 1 }).usage, null);
});

test("E4 returns addressed off-form outcomes for malformed or incomplete wire envelopes", () => {
  const cases: [string, string][] = [
    ["malformed stdout", "{broken"],
    ["multiple envelopes", `${JSON.stringify(envelope())}\n${JSON.stringify(envelope())}`],
    ["non-object envelope", "null"],
    ["missing protocol", JSON.stringify(omit(envelope(), "protocol"))],
    ["missing requestId", JSON.stringify(omit(envelope(), "requestId"))],
    ["missing research", JSON.stringify(omit(envelope(), "research"))],
    ["missing usage", JSON.stringify(omit(envelope(), "usage"))],
    ["missing confirmed", JSON.stringify(omit(envelope(), "confirmed"))],
    ["malformed confirmed", JSON.stringify(envelope({ confirmed: { model: "", effort: null, speed: null } }))],
    ["incomplete confirmed", JSON.stringify(envelope({ confirmed: { model: null, effort: null } }))],
    ["null confirmed", JSON.stringify(envelope({ confirmed: null }))],
    ["malformed usage", JSON.stringify(envelope({ usage: { ...usage, inputTokens: -1 } }))],
    ["incomplete usage", JSON.stringify(envelope({ usage: { inputTokens: 1, outputTokens: 1 } }))],
    ["impossible usage subsets", JSON.stringify(envelope({ usage: { ...usage, cachedInputTokens: 121 } }))],
    ["extra service field", JSON.stringify(envelope({ accepted: true }))],
    ["non-finite research", JSON.stringify(envelope()).replace('{"answer":"producer"}', "1e400")],
  ];
  for (const [name, stdout] of cases) {
    const result = decode(stdout);
    assert.equal(result.kind, "off-form", name);
    if (result.kind !== "off-form") assert.fail(name);
    assert.equal(result.error.code, "model_adapter_response_invalid", name);
    assert.ok(result.error.field.length > 0, name);
    assert.ok(result.error.message.length > 0, name);
    assert.equal(Object.hasOwn(result, "raw"), false, name);
    assert.ok(deeplyFrozen(result), name);
  }
  const known = decode(JSON.stringify(envelope({ usage, accepted: true })));
  assert.equal(known.kind, "off-form");
  assert.deepEqual(known.usage, usage, "A malformed payload does not erase measured usage for this request");
});

test("E4 exported boundaries reject missing or invalid arguments with EngineError", () => {
  const valid = request();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const badRequests: unknown[] = [undefined, null, [], ...["requestId", "packet", "model", "effort"].map(key => omit({ ...valid }, key)),
    { ...valid, requestId: " " }, { ...valid, model: 7 }, { ...valid, effort: "unknown" },
    { ...valid, speed: undefined }, { ...valid, speed: "unknown" }, { ...valid, approved: true },
    { ...valid, packet: undefined }, { ...valid, packet: cyclic }, { ...valid, packet: Infinity }];
  const succeeded = processResult(JSON.stringify(envelope()));
  const badResponses: unknown[] = [undefined, null, [], {}, { requestId }, { process: succeeded },
    { requestId: " ", process: succeeded }, { requestId, process: null }, { requestId, process: succeeded, accepted: true },
    ...["exitCode", "signal", "stdout", "stderr"].map(key => ({ requestId, process: omit({ ...succeeded }, key) })),
    { requestId, process: { ...succeeded, exitCode: -1 } },
    { requestId, process: { ...succeeded, signal: "" } },
    { requestId, process: { ...succeeded, stdout: {} } },
    { requestId, process: { ...succeeded, stderr: null } },
    { requestId, process: { ...succeeded, accepted: true } }];
  const invalid = (error: unknown): boolean => error instanceof EngineError && error.code === "model_call_request_invalid";
  for (const input of badRequests) assert.throws(() => adapterRequest(input as AdapterRequestInput), invalid);
  for (const input of badResponses) assert.throws(() => readAdapterResponse(input as AdapterResponseInput), invalid);
});

test("E4 exercises the local stdio fixture, ordered trace, exact request binding and process failure", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-e4-wire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scenario = join(root, "scenario.json"), trace = join(root, "trace.jsonl");
  const research = { call: "$requestId", nested: ["$requestId", { value: "$requestId" }],
    literal: "prefix:$requestId", "$requestId": "key retained", source: "process.exit(99)" };
  writeFileSync(scenario, JSON.stringify({ steps: [
    { research },
    { research: "off-form product answer", usage, confirmed },
    { research: false, usage, exitCode: 7, stderr: "intentional fixture process failure" },
    { rawStdout: JSON.stringify(envelope({ requestId: "foreign-request", usage, confirmed })), exitCode: 9 },
    { rawStdout: "{malformed stdout" },
  ] }));
  const command = { executable: process.execPath, args: [fixturePath, "--scenario", scenario, "--trace", trace] };
  const sent: unknown[] = [];
  async function dispatch(index: number) {
    const wire = valueOf(adapterRequest(request({ requestId: `fixture:${index}`, speed: "fast" })));
    sent.push(wire);
    const process = await runProcess(command, root, JSON.stringify(wire), 10_000);
    return { process, result: valueOf(readAdapterResponse({ requestId: wire.requestId, process })) };
  }
  const first = await dispatch(0);
  assert.equal(first.process.exitCode, 0);
  assert.equal(first.result.kind, "answered");
  if (first.result.kind !== "answered") assert.fail("Expected fixture research");
  assert.deepEqual(JSON.parse(first.result.raw), { ...research, call: "fixture:0", nested: ["fixture:0", { value: "fixture:0" }] });
  assert.equal(first.result.usage, null);
  assert.deepEqual(first.result.confirmed, unknownConfirmed);
  const second = await dispatch(1);
  assert.equal(second.result.kind, "answered");
  if (second.result.kind !== "answered") assert.fail("E3 owns product-form validation");
  assert.equal(JSON.parse(second.result.raw), "off-form product answer");
  assert.deepEqual(second.result.usage, usage);
  assert.deepEqual(second.result.confirmed, confirmed);
  const failed = await dispatch(2);
  assert.equal(failed.process.exitCode, 7);
  assert.equal(failed.process.stderr, "intentional fixture process failure");
  assert.equal(failed.result.kind, "interrupted");
  assert.deepEqual(failed.result.usage, usage);
  const foreign = await dispatch(3);
  assert.equal(foreign.result.kind, "interrupted");
  assert.equal(foreign.result.usage, null);
  assert.deepEqual(foreign.result.confirmed, unknownConfirmed);
  assert.equal((await dispatch(4)).result.kind, "off-form");
  const exhausted = await dispatch(5);
  assert.equal(exhausted.process.exitCode, 2);
  assert.match(exhausted.process.stderr, /Missing scenario step 5/);
  assert.deepEqual(readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line)), sent);
});

// Dispatch integration fixtures and lifecycle checks.
import type { TestContext } from 'node:test';
import { existsSync } from 'node:fs';
import { Store, type Revision, type Write } from '../src/storage/store.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { projectGraph } from '../src/graph/project.js';
import type { Graph, Node } from '../src/graph/model.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { historicalProof, historicalTrace, withHistoricalReads, writeOmInput } from '../src/om/input.js';
import { storeView } from '../src/storage/store-view.js';
import { transactionForTests } from '../src/om/atomic-gate.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeGuarded } from '../src/om/refs.js';
import { prepareQuestionTasks, prepareQuestionPacket, readQuestionPacket, readPartResult, writeQuestionPacket, type QuestionPacketRequest, type QuestionPacketRecord,
  type PartProposalBody } from '../src/om/question-packet.js';
import { writeRoutes } from '../src/om/routes.js';
import { openSeries, beginAttempt, seriesRequestOf, readCompletionBinding, completionWorkId } from '../src/om/series.js';
import { gapLineKey, gapLineExpectedResult, writeGapLines } from '../src/om/gap-lines.js';
import { prepareFrameProposals, type LayerProposal } from '../src/om/frame-proposals.js';
import { prepareFrame, fillObligations, type FrameRequest, type FrameScope } from '../src/om/frame-obligations.js';
import { writeCandidate } from '../src/om/frame-candidate.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import { normalizeOwnerGapAssignment, OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND, writeOmObligations } from '../src/om/obligations.js';
import { taskBindingId } from '../src/graph/task-obligations.js';
import type { CarriedObligation } from '../src/graph/obligation-policy.js';
import { runModelCall, readModelCall, readModelCallState, readManagedModelDiagnostic, finishModelAttempt, prepareModelAttemptFinish, readModelApplicationRejection, type ModelCallRequest, type OmModelCall } from '../src/om/model-call.js';
import { readCall } from '../src/om/call-record.js';
import { checkAnswerForm } from '../src/om/answer-form.js';

import { openAttempt as managedOpenAttempt } from '../src/om/repeat-gate.js';
import { checkCompletionLedger, pendingCallStore, readCompletionWorkAt } from '../src/om/model-call.js';

function e4Fixture(t: TestContext, kind: 'fact' | 'node' | 'field' = 'fact', capacity = 100_000, priorNoProgress = 0, timeoutMs = 1000, managed = false, materialize = true, extraQuestion = false) {
  const root = mkdtempSync(join(tmpdir(), 'omg-e4-dispatch-')), database = join(root, 'state.sqlite');
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = 'garden', graphData = gardenGraph('cross');
  graphData.nodes.find(node => node.id === 'garden-produce-block')!.ports.push({ id: 'out-side', direction: 'out', contract: 'garden-contract' });
  graphData.nodes.find(node => node.id === 'garden-consume-block')!.ports.push({ id: 'in-side', direction: 'in', contract: 'garden-contract' });
  graphData.connectors.push({ id: 'garden-side-flow', artifact: 'garden-data', returnsTo: 'garden-produce-block', wakeTest: null,
    bindings: [{ level: 1, producer: { node: 'garden-produce-block', port: 'out-side' },
      consumers: [{ node: 'garden-consume-block', port: 'in-side' }], anchor: null }] });
  const { level: _level, ...l1 } = projectGraph(graphData, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'encoding', question: 'What encoding is supported?',
      consumer: 'garden-consume-block', moment: 'om-pass', blocksCurrentStage: false, resolution: 'Resolve the addressed question during OM' }, ...(extraQuestion ? [{ id: 'spare', question: 'Which optional format?', consumer: 'garden-consume-block', moment: 'om-pass', blocksCurrentStage: false, resolution: 'Address during OM' }] : [])];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = valueOf(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = kind === 'field' ? base : valueOf(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: [{ pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: 'discovery:encoding', field: 'address', value: { consumer: 'garden-consume-block', kind: 'repository-fact' } } })) as Write }] }));
  const horizon = valueOf(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: 'e4-fixture', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = valueOf(writeGaps(store, sources));
  const gapRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = valueOf(prepareQuestionTasks(store, { project, gaps: gapRequest,
    questions: gaps.records.filter(row => row.value.gap.kind === 'repository-fact' && row.value.gap.code !== 'inventory_missing' && !row.value.gap.deferral)
      .map(gap => ({ gap: reference(gap), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) }));
  const source = store.get<{content: string}>(`source:${project}:brief`)!;
  const routes = valueOf(writeRoutes(store, { project, gaps: gapRequest,
    tasks: tasks.tasks.map(task => ({ pending: structuredClone(task.writes[0]!) as Write })),
    catalog: { paths: ['e4-source.txt'], records: [] }, previous: null }));
  writeFileSync(join(root, 'e4-source.txt'), 'UTF-8 is the supported encoding.');
  const batch = routes.value.batches.find(batch => kind === 'node' ? batch.task === 'node-expansion' && batch.node === 'garden-produce-block'
    : kind === 'field' ? batch.model === 'MC2' && batch.task === 'input-field' && batch.items.some(item => item.target === 'discovery:encoding')
    : batch.model === 'MC1' && batch.items.some(item => item.target === 'discovery:encoding'))!;
  assert.ok(batch);
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [fixturePath, '--scenario', scenario, '--trace', trace] };
  function environment(amount = capacity) {
    return engine.environments.configure(project, { workspace: root,
      implementer: { actor: 'e4-implementer', model: 'fixture', effort: 'high', speed: 'fast', command },
      reviewer: { actor: 'e4-reviewer', model: 'fixture-reviewer', effort: 'medium', command },
      fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs, requestCapacityChars: amount },
    store.get(`environment:${project}`)?.revision ?? 0);
  }
  const configured = environment(), adapter = store.write({ id: `adapter:${project}:e4`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: project, protocol: 'codex-stdio' } });
  const goal = { key: `e4:${kind}`, questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  const address = kind === 'field' ? { project, owner: { kind: 'mechanism' as const, mechanism: 'M5:addressing' as const }, line: 1 }
    : { project, block: kind === 'node' ? batch.node! : 'garden-consume-block', line: 1 };
  const admission = { gaps: gapRequest, routes: reference(routes), batch: batch.id };
  valueOf(openSeries(store, kind === 'field' ? { ...address, scope: gapRequest, predecessor: null, basis: null } as never
    : { ...address, slice: 'e4-fixture', predecessor: null, basis: null } as never));
  for (let attempt = 1; attempt <= priorNoProgress; attempt++) {
    valueOf(beginAttempt(store, kind === 'field' ? { ...address, attempt, goal, admission } as never : { ...address, attempt, goal } as never));
    valueOf(completeAttempt(store, { ...address, attempt, outcome: { reason: 'result', achieved: [], cancelled: [], refusals: [] } } as never));
  }
  const ordinal = priorNoProgress + 1;
  const opening = { ...address, attempt: ordinal, goal, ...(kind === 'field' ? { admission } : {}),
    ...(managed ? { completion: { routes: reference(routes), batches: [batch.id] } } : {}) };
  const series = valueOf((managed ? managedOpenAttempt : beginAttempt)(store, opening as never));
  const packetRequest: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(configured),
    attempt: { series: reference(series), ordinal }, previous: [] };
  const packet = valueOf((materialize ? writeQuestionPacket : prepareQuestionPacket)(store, packetRequest)).record;
  const request: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(configured) }, role: 'implementer' };
  const frame = valueOf(prepareFrameProposals(store, sources.operations));
  const obligations = frame.frame.result.obligations.filter(item => item.upper.node === batch.node);
  return { root, database, project, graph, fullGraph: graphData, input, source, routes, gaps, gapRequest, batch, packet, request, packetRequest,
    configured, adapter, series, obligations, scenario, trace, environment,
    get store() { return store; }, get engine() { return engine; },
    restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); },
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ steps })); },
    sent() { return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; },
  };
}
function e4Fact(f: ReturnType<typeof e4Fixture>) {
  return { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'answer',
    results: [{ questionId: f.batch.items[0]!.gap, value: 'UTF-8',
      citations: [{ source: reference(f.source), selector: { kind: 'text-range', start: 0, end: f.source.value.content.length } }] }] };
}
function e4Node(f: ReturnType<typeof e4Fixture>, packet: Revision<QuestionPacketRecord> = f.packet as Revision<QuestionPacketRecord>) {
  const plan = packet.value.plan!, ids = plan.assignments[plan.position]!.obligations;
  const assigned = f.obligations.filter(item => ids.includes(item.id));
  const upper = f.graph.value.nodes.find(node => node.id === f.batch.node)!;
  const node: Node = { ...structuredClone(upper), id: `garden-part-${plan.position}`, kind: 'operation', parent: upper.id,
    title: `Expansion part ${plan.position}`, ports: assigned.filter(item => item.kind === 'connection-end').map((item, index) => ({
      id: `part-port-${index}`, direction: item.role === 'producer' ? 'out' : 'in',
      contract: f.graph.value.artifacts.find(artifact => artifact.id === item.artifact)!.contract,
    })), code: [], tests: [] };
  let port = 0;
  const proposal: PartProposalBody = { nodes: [node], fills: assigned.map(item => ({ obligation: item.id, node: node.id,
    ...(item.kind === 'connection-end' ? { port: node.ports[port++]!.id } : {}) })), localConnectors: [], artifacts: [], contracts: [],
    joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
  return { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'answer', proposal };
}

/** A first works pass through C2/C4/C5, with a genuine owner assignment and no accepted L3. */
function e4WorksFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-e4-works-')), database = join(root, 'state.sqlite'), project = 'garden';
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const desired = gardenGraph('cross'), { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'late-proof',
      question: 'Which result proof must the concrete producer provide?', consumer: 'garden-produce-operation',
      moment: 'task-result', blocksCurrentStage: false, resolution: 'Retain the result proof for the concrete work' }];
    return value;
  });
  let input = valueOf(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const initial = valueOf(writeHorizon(store, { project, input: reference(input), graph: reference(store.get(`graph:${project}`)!),
    refinement: null, available: {}, choice: { choiceVersion: 'e4-work-upper', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame2: FrameRequest = { project, level: 2, graph: reference(store.get(`graph:${project}`)!), horizon: reference(initial.gate),
    layer: null, frame: null, upper: null };
  const frame = valueOf(prepareFrame(store, frame2)), projected = projectGraph(desired, 2);
  const fills = valueOf(fillObligations(frame.upper as Graph, frame.scope as FrameScope, { graph: desired,
    reference: { ...frame.request.graph, hash: hashJson(desired) }, frame: null }, frame.upperRef, 2));
  const nodes = projected.nodes.filter(node => node.kind === 'operation'), nodeIds = new Set(nodes.map(node => node.id));
  const proposalValue: LayerProposal = { base: { graph: frame.request.graph, frame: null }, level: 2, source: 'decision', status: 'proposed', nodes,
    fills: fills.fills.filter(fill => nodeIds.has(fill.node)).map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length), artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
    tests: projected.tests, edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [],
    transfers: projected.transfers ?? [], anchors: projected.anchors, removes: [], replaces: [], redefines: [] };
  const proposal = store.write({ id: `om-proposal:${project}:e4-work-upper`, kind: 'layer-proposal', expected: 0, value: proposalValue });
  const candidate = valueOf(writeCandidate(store, { frame: frame2, proposals: [reference(proposal)] }));
  assert.equal(candidate.state, 'candidate'); if (candidate.state !== 'candidate') throw new Error('Missing upper candidate');
  const accepted = valueOf(settleCandidate(store, { project, level: 2, candidate: reference(candidate.record), outcome: {
    gate: 'G3', candidate: reference(candidate.record), graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  const graph = reference(accepted.graph!), layer2 = reference(accepted.layer!), upperFrame = reference(accepted.frame!);
  input = valueOf(writeAddressing(store, { project, input: reference(input), graph, decisions: [{ pending: inputDecisionWrite({ project,
    input: reference(input), graph, layers: [layer2], decision: { target: 'discovery:late-proof', field: 'address',
      value: { consumer: 'garden-produce-operation', kind: 'post-implementation-proof' } } }) as Write }] }));
  const horizon = valueOf(writeHorizon(store, { project, input: reference(input), graph, refinement: layer2, available: {},
    choice: { choiceVersion: 'e4-work-pass', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { ...frame2, graph, horizon: reference(horizon.gate), layer: layer2, frame: upperFrame } },
    works: { proposals: [], frame: { project, level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
      upper: { horizon: reference(horizon.gate), frame: upperFrame } } } };
  const gaps = valueOf(writeGaps(store, sources)), gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = valueOf(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const late = gaps.records.find(row => row.value.gap.target === 'discovery:late-proof')!; assert.ok(late);
  const assignment = normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project, context: { gaps: gapRead, lines: reference(lines) },
    gap: reference(late), assignments: late.value.gap.consumers.map(consumer => ({ responsibleNode: 'garden-produce-operation',
      responsibleConsumer: consumer, reason: 'Retain the concrete result test', returnCondition: `Prove result for ${consumer}`, wake: null })) });
  const ledger = valueOf(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [{ pending: {
    id: `om-owner-gap-assignment:${project}:${hashJson(assignment)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value: assignment } }] }));
  const routes = valueOf(writeRoutes(store, { project, gaps: gapRead, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const batch = routes.value.batches.find(batch => batch.level === 3 && batch.node === 'garden-produce-operation')!; assert.ok(batch);
  const address = { project, block: 'garden-produce-block', line: 1 };
  valueOf(openSeries(store, { ...address, slice: 'e4-work', predecessor: null, basis: null }));
  const series = valueOf(beginAttempt(store, { ...address, attempt: 1, goal: { key: 'e4-work',
    questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) } }));
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [fixturePath, '--scenario', scenario, '--trace', trace] };
  function environment(requestCapacityChars = 100_000) {
    return engine.environments.configure(project, { workspace: root,
      implementer: { actor: 'e4-work-producer', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'e4-work-reviewer', model: 'fixture', effort: 'high', command },
      fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars },
    store.get(`environment:${project}`)?.revision ?? 0);
  }
  const configured = environment(), adapter = store.write({ id: `adapter:${project}:e4-work`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: project, protocol: 'codex-stdio' } });
  const packetRequest: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(configured),
    attempt: { series: reference(series), ordinal: 1 }, previous: [], works: { producer: reference(ledger.producer), ledger: reference(ledger.record) } };
  const packet = valueOf(writeQuestionPacket(store, packetRequest)).record;
  const request: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(configured) }, role: 'implementer' };
  const work = structuredClone(desired.nodes.find(node => node.id === 'garden-produce-work')!);
  const tests = structuredClone(desired.tests.filter(test => work.tests.includes(test.id)));
  const worksSource = gapRead.sources.works; assert.ok(!('state' in worksSource));
  const obligations = valueOf(prepareFrameProposals(store, worksSource)).frame.result.obligations.filter(item => item.upper.node === batch.node);
  const bindings = ledger.handoff.obligations.map(obligation => ({ id: taskBindingId(obligation as CarriedObligation),
    scope: obligation.scope, obligation: obligation.obligation, consumers: [{ node: work.id, tests: work.tests }] }));
  assert.ok(bindings.length);
  function answer(current = packet as Revision<QuestionPacketRecord>, position = current.value.plan!.position) {
    const plan = current.value.plan!, assigned = obligations.filter(item => plan.assignments[position]!.obligations.includes(item.id));
    const proposal: PartProposalBody = { nodes: position === 0 ? [work] : [], tests: position === 0 ? tests : [],
      fills: assigned.map(item => ({ obligation: item.id, node: work.id,
        ...(item.kind === 'connection-end' ? { port: item.upper.port!, codeRef: work.code[0]! } : {}) })),
      localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
      removes: [], replaces: [], redefines: [] };
    return { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'answer', proposal,
      bindings: position === plan.assignments.length - 1 ? bindings : [] };
  }
  return { project, packet, request, packetRequest, series, ledger, bindings, work, answer, environment, configured,
    get store() { return store; }, restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); },
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ steps })); },
    sent() { return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; } };
}

test('E4 admits before spawning, saves MC1 candidates and actual usage, and replays exact history without native reissuance', async t => {
  const f = e4Fixture(t), native = f.store.list('question').map(reference);
  f.steps([{ research: e4Fact(f), usage, confirmed }]);
  const writeMany = f.store.writeMany.bind(f.store);
  let admissionWritten = false, runningWritten = false;
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === 'call-record' && write.expected === 0)) { assert.equal(f.sent().length, 0); admissionWritten = true; }
    if (writes.some(write => write.kind === 'model-call' && (write.value as {status: string}).status === 'running')) {
      assert.ok(admissionWritten); assert.equal(f.sent().length, 0); runningWritten = true;
    }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  const actual = valueOf(await runModelCall(f.store, f.request));
  f.store.writeMany = writeMany;
  assert.ok(runningWritten); assert.equal(actual.outcome?.kind, 'fact-candidates'); assert.equal(actual.record.value.status, 'succeeded');
  assert.deepEqual(actual.record.value.usage, usage); assert.equal(actual.record.value.usageSource, 'adapter');
  assert.equal(valueOf(readCall(f.store, f.project, reference(f.store.get(actual.call.id)!))).value.status, 'succeeded');
  assert.equal(f.sent().length, 1); assert.equal(f.store.list('accepted-answer').length, 0);
  assert.deepEqual(f.store.list('question').map(reference), native);
  const historical = valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) }));
  const before = f.store.list().map(reference);
  f.environment(); f.restart();
  const replay = valueOf(await runModelCall(f.store, f.request));
  assert.deepEqual(replay, historical); assert.equal(f.sent().length, 1);
  assert.equal(f.store.history(actual.record.id).length, 4);
  assert.ok(before.some(ref => ref.id === actual.record.id));
});

test('E4 saves node response, proposal, result and completed runtime atomically while leaving acceptance to C5', async t => {
  const f = e4Fixture(t, 'node'); f.steps([{ research: e4Node(f) }]);
  const writeMany = f.store.writeMany.bind(f.store), batches: string[][] = [];
  f.store.writeMany = ((writes, guards) => { batches.push(writes.map(write => write.kind)); return writeMany(writes, guards); }) as Store['writeMany'];
  const actual = valueOf(await runModelCall(f.store, f.request)); f.store.writeMany = writeMany;
  assert.equal(actual.outcome?.kind, 'node-proposal'); assert.ok(actual.part); assert.equal(actual.record.value.usage, null);
  assert.equal(f.store.get<{status: string}>(actual.call.id)!.value.status, 'open');
  const atomic = batches.find(kinds => kinds.includes('part-result'))!;
  assert.ok(atomic.includes('part-response') && atomic.includes('layer-proposal') && atomic.includes('model-call'));
  assert.equal(f.store.get<{status: string}>(actual.part.proposal.id)!.value.status, 'proposed');
  assert.deepEqual(valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) })).part, actual.part);
});

test('E4 control and malformed outcomes complete their attempt once, preserve unanswered questions, and replay after restart', async t => {
  for (const action of ['need_owner', 'cannot_answer', 'pause', 'malformed', 'process_failure'] as const) {
    const f = e4Fixture(t, 'fact', 100_000, action === 'need_owner' ? 1 : 0), common = { protocol: 'omg-answer/v2', requestId: '$requestId', questionIds: [f.batch.items[0]!.gap] };
    f.steps([action === 'malformed' ? { research: { invalid: true }, usage }
      : action === 'process_failure' ? { rawStdout: '{broken', exitCode: 7 }
      : { research: { ...common, action, reason: 'Need a concrete source', ...(action === 'need_owner' ? { decision: 'Choose the source' } : {}) }, usage }]);
    const actual = valueOf(await runModelCall(f.store, f.request));
    assert.ok(actual.diagnostic, action); assert.equal(f.store.list('accepted-answer').length, 0);
    const current = f.store.get<{attempts: {outcome: unknown; verdict: string}[]; withoutProgress: number}>(f.series.id)!;
    assert.ok(current.value.attempts.at(-1)!.outcome, action); assert.notEqual(current.value.attempts.at(-1)!.verdict, 'progress');
    assert.equal((current.value.attempts.at(-1)!.outcome as {reason:string}).reason, action === 'need_owner' ? 'awaiting-owner' : action === 'malformed' ? 'off-form' : action === 'process_failure' ? 'interrupted' : 'refused');
    if (action === 'need_owner') { assert.equal(actual.outcome?.kind, 'awaiting-owner');
      assert.equal(f.series.value.withoutProgress, 1); assert.equal(current.value.withoutProgress, 1);
      if (actual.outcome?.kind === 'awaiting-owner') { assert.equal(actual.outcome.recipient, 'owner'); assert.ok(actual.outcome.questions[0]!.consumers.length); } }
    const snapshot = f.store.list().map(reference); f.restart();
    const replay = valueOf(await runModelCall(f.store, f.request));
    assert.equal(replay.repeated, true); assert.deepEqual(replay.diagnostic, actual.diagnostic);
    assert.deepEqual(f.store.list().map(reference), snapshot); assert.equal(f.sent().length, 1);
  }
});

test('E4 current admission blocks stale packets, mismatched configs and masqueraded adapters without spawning', async t => {
  for (const change of ['stale', 'config', 'adapter'] as const) {
    const f = e4Fixture(t); f.steps([{ research: e4Fact(f) }]);
    const request = structuredClone(f.request);
    if (change === 'stale') f.environment();
    else if (change === 'config') request.dispatch = { ...request.dispatch, config: reference(f.environment()) };
    else request.dispatch = { ...request.dispatch, adapter: reference(f.store.write({ id: 'fake-adapter:garden', kind: 'dispatch-adapter', expected: 0, value: { protocol: 'pretend-codex' } })) };
    const actual = await runModelCall(f.store, request);
    assert.equal(actual.ok, false); assert.equal(f.sent().length, 0); assert.equal(f.store.list('call-record').length, 0);
  }
});

// Whole attempt: delivery continuation, complete parts, and immutable playback.
import { runModelCycle, readModelCycle, readContinuationEvidence, readPartAssembly, deliverModelSources,
  assembleModelParts } from '../src/om/model-call.js';
import { hashJson } from '../src/canonical.js';
function e4NeedSource(f: ReturnType<typeof e4Fixture>, reads: unknown[]) {
  return { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'need_source',
    questionIds: f.batch.items.map(item => item.gap), missing: 'Need the addressed source data', reads };
}

test('E4 cycle delivers all addressed read forms then answers once in the same attempt with immutable history', async t => {
  const f = e4Fixture(t), native = f.store.list('question').map(reference), originalInput = reference(f.input), originalGraph = reference(f.graph);
  const reads = [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' },
    { action: 'read_source', source: reference(f.source), selector: { kind: 'text-range', start: 0, end: f.source.value.content.length } },
    { action: 'read_context', record: reference(f.input), pointer: '/input/questions/0/question' },
    { action: 'search', within: 'e4-source.txt', query: 'UTF-8' }];
  f.steps([{ research: e4NeedSource(f, reads), usage }, { research: e4Fact(f), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'outcome'); assert.equal(cycle.last.outcome?.kind, 'fact-candidates');
  const sent = f.sent(); assert.equal(sent.length, 2); assert.notEqual(sent[0].requestId, sent[1].requestId);
  const first = JSON.parse(sent[0].prompt), second = JSON.parse(sent[1].prompt);
  assert.deepEqual(second.questions, first.questions); assert.equal(second.responseForm.requestId, sent[1].requestId);
  assert.equal(second.sourceDeliveries[0].data.length, 4);
  assert.equal(second.sourceDeliveries[0].data[0].data, 'UTF-8 is the supported encoding.');
  assert.deepEqual(second.sourceDeliveries[0].data[3].data.map((item: {line: number; text: string}) => [item.line, item.text]), [[1, 'UTF-8 is the supported encoding.']]);
  assert.equal(f.store.list('call-record').length, 2); assert.deepEqual(f.store.list('question').map(reference), native);
  assert.deepEqual(reference(f.store.get(f.input.id)!), originalInput); assert.deepEqual(reference(f.store.get(f.graph.id)!), originalGraph);
  assert.equal(f.store.get<{attempts: {outcome: unknown}[]}>(f.series.id)!.value.attempts[0]!.outcome, null);
  const snapshot = f.store.list().map(reference); writeFileSync(join(f.root, 'e4-source.txt'), 'changed after delivery');
  f.restart();
  assert.deepEqual(valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) })).last.outcome, cycle.last.outcome);
  assert.equal(valueOf(await runModelCycle(f.store, f.request)).repeated, true);
  assert.equal(f.sent().length, 2); assert.deepEqual(f.store.list().map(reference), snapshot);
});

test('E4 direct continuation refuses repeated knowledge atomically before a third dispatch and replays after restart', async t => {
  for (const kind of ['fact', 'field'] as const) {
    const f = e4Fixture(t, kind);
    const need = e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]);
    f.steps([{ research: need, usage }, { research: need, usage }, { research: need, usage }]);
    const first = valueOf(await runModelCall(f.store, f.request));
    const firstBasis = { project: f.project, packet: f.request.packet, call: first.call, response: first.response! };
    const delivered = valueOf(deliverModelSources(f.store, firstBasis));
    const nextRequest: QuestionPacketRequest = { ...f.packetRequest, continuation: { packet: firstBasis.packet,
      call: firstBasis.call, response: firstBasis.response, deliveries: [...delivered.deliveries] } };
    const next = valueOf(writeQuestionPacket(f.store, nextRequest));
    assert.equal(next.record.value.state, 'ready');
    f.restart();
    const secondRequest = { ...f.request, packet: reference(next.record) };
    const second = valueOf(await runModelCall(f.store, secondRequest));
    const basis = { project: f.project, packet: secondRequest.packet, call: second.call, response: second.response! };
    const again = valueOf(deliverModelSources(f.store, basis));
    assert.equal(valueOf(readContinuationEvidence(f.store, { ...basis, deliveries: [...again.deliveries] })).novel, false);
    const terminalRequest: QuestionPacketRequest = { ...next.record.value.request, previous: [...next.record.value.request.previous],
      continuation: { packet: basis.packet, call: basis.call, response: basis.response, deliveries: [...again.deliveries] } };
    const before = f.store.list().map(reference);
    const prepared = valueOf(prepareQuestionPacket(f.store, terminalRequest));
    assert.equal(prepared.record.value.state, 'blocked');
    assert.equal(prepared.record.value.refusal?.code, 'research_no_progress');
    assert.deepEqual(f.store.list().map(reference), before, 'Preparation never completes the attempt by itself');
    assert.ok(prepared.writes.some(write => write.id === f.series.id));
    const pendingOnly = new Proxy(f.store, { get(target, key) {
      if (key === 'get') return (id: string, revision?: number) => id === prepared.record.id ? prepared.record : target.get(id, revision);
      const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    assert.equal(readQuestionPacket(pendingOnly, { project: f.project, record: reference(prepared.record) }).ok, false,
      'A lone blocked record does not prove the atomic completion');
    const terminal = valueOf(writeQuestionPacket(f.store, terminalRequest));
    assert.equal(terminal.record.value.state, 'blocked');
    const series = f.store.get<{ attempts: { outcome: { reason: string } }[]; withoutProgress: number }>(f.series.id)!;
    assert.equal(series.value.attempts[0]!.outcome.reason, 'refused');
    assert.equal(series.value.withoutProgress, 1);
    const refusedCall = await runModelCall(f.store, { ...f.request, packet: reference(terminal.record) });
    assert.equal(refusedCall.ok, false); assert.equal(f.sent().length, 2);
    assert.equal(f.store.list('call-record').length, 2);
    const after = f.store.list().map(reference);
    f.restart(); writeFileSync(join(f.root, 'e4-source.txt'), 'changed after the completed transition');
    valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(terminal.record) }));
    assert.equal(valueOf(writeQuestionPacket(f.store, terminalRequest)).existing, true);
    assert.equal(valueOf(writeQuestionPacket(f.store, nextRequest)).existing, true);
    assert.equal(prepareQuestionPacket(f.store, nextRequest).ok, false,
      'Historical replay does not authorize a new call under the completed attempt');
    assert.equal(valueOf(await runModelCall(f.store, secondRequest)).repeated, true);
    assert.equal(valueOf(writeQuestionPacket(f.store, terminalRequest)).writes.length, 0);
    assert.deepEqual(f.store.list().map(reference), after); assert.equal(f.sent().length, 2);
  }
});

test('E4 no-progress preparation guards concurrent completion without a partial blocked packet or diagnostic', async t => {
  const f = e4Fixture(t), need = e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]);
  f.steps([{ research: need }, { research: need }]);
  let packet = f.packet;
  let terminalRequest: QuestionPacketRequest | undefined;
  for (let index = 0; index < 2; index++) {
    const call = valueOf(await runModelCall(f.store, { ...f.request, packet: reference(packet) }));
    const basis = { project: f.project, packet: reference(packet), call: call.call, response: call.response! };
    const deliveries = valueOf(deliverModelSources(f.store, basis));
    terminalRequest = { ...packet.value.request, previous: [...packet.value.request.previous],
      continuation: { packet: basis.packet, call: basis.call, response: basis.response, deliveries: [...deliveries.deliveries] } };
    if (index === 0) packet = valueOf(writeQuestionPacket(f.store, terminalRequest)).record;
  }
  const prepared = valueOf(prepareQuestionPacket(f.store, terminalRequest!));
  const other = new Store(f.database);
  try {
    valueOf(completeAttempt(other, { project: f.project, block: 'garden-consume-block', line: 1, attempt: 1,
      outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } }));
  } finally { other.close(); }
  const snapshot = f.store.list().map(reference);
  const conflict = writeGuarded(f.store, { unit: 'E2', target: prepared.record.id,
    writes: structuredClone(prepared.writes) as Write[], guards: [...prepared.guards] });
  assert.equal(conflict.ok, false); assert.equal(f.store.get(prepared.record.id), null);
  assert.deepEqual(f.store.list().map(reference), snapshot);
  f.restart();
  assert.equal(writeQuestionPacket(f.store, terminalRequest!).ok, false);
  assert.deepEqual(f.store.list().map(reference), snapshot); assert.equal(f.sent().length, 2);
});

test('E4 cycle repeated unchanged reads refuse once while exact late replay adds no calls, deliveries or completions', async t => {
  const f = e4Fixture(t), read = { action: 'read', path: 'e4-source.txt', media: 'text/plain' };
  const need = e4NeedSource(f, [read, read]); f.steps([{ research: need }, { research: need }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'research-no-progress'); assert.ok(cycle.diagnostic);
  assert.equal(f.sent().length, 2); assert.equal(f.store.list('om-read-delivery').length, 2);
  const series = f.store.get<{attempts: {outcome: {reason: string}}[]; withoutProgress: number}>(f.series.id)!;
  assert.equal(series.value.attempts.length, 1); assert.equal(series.value.attempts[0]!.outcome.reason, 'refused');
  assert.equal(series.value.withoutProgress, 1);
  for (const alteration of ['diagnostic', 'dispatch'] as const) {
    const body = { ...cycle.record.value,
      ...(alteration === 'diagnostic' ? { diagnostic: null } : { request: { ...cycle.record.value.request, role: 'reviewer' } }) };
    const forged = { ...cycle.record, id: `om-model-cycle:${f.project}:${hashJson(body.request)}`, value: body, hash: hashJson(body) };
    const view = new Proxy(f.store, { get(target, key) {
      if (key === 'get') return (id: string, revision?: number) => id === forged.id ? forged : target.get(id, revision);
      const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    assert.equal(readModelCycle(view, { project: f.project, record: reference(forged) }).ok, false, alteration);
  }
  const snapshot = f.store.list().map(reference); f.restart();
  valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) }));
  valueOf(await runModelCycle(f.store, f.request));
  assert.equal(f.sent().length, 2); assert.deepEqual(f.store.list().map(reference), snapshot);
});

test('E4 narrowing the questions of an unchanged source read does not manufacture progress', async t => {
  const f = e4Fixture(t, 'node');
  const need = e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]);
  assert.ok(need.questionIds.length > 1);
  f.steps([{ research: need }, { research: { ...need, questionIds: need.questionIds.slice(0, 1) } }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'research-no-progress'); assert.equal(f.sent().length, 2);
  f.restart(); valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) }));
});

test('E4 missing addressed file can be supplied and resumed without redispatching the saved source request', async t => {
  const f = e4Fixture(t);
  f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'later.txt', media: 'text/plain' }]) }, { research: e4Fact(f) }]);
  const missing = await runModelCycle(f.store, f.request);
  assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.refusal.code, 'model_read_unavailable');
  assert.equal(f.sent().length, 1);
  f.restart(); writeFileSync(join(f.root, 'later.txt'), 'The requested encoding is UTF-8.');
  const resumed = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(resumed.record.value.terminal, 'outcome'); assert.equal(f.sent().length, 2);
});

test('E4 cycle saves delivery overflow without a second dispatch or context truncation', async t => {
  const f = e4Fixture(t), config = f.environment(f.packet.value.fingerprint!.chars + 100);
  const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
  const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
  writeFileSync(join(f.root, 'e4-source.txt'), 'UTF-8 '.repeat(20_000));
  f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]) }]);
  const cycle = valueOf(await runModelCycle(f.store, request));
  assert.equal(cycle.record.value.terminal, 'blocked'); assert.equal(f.sent().length, 1); assert.ok(cycle.record.value.next);
  const blocked = f.store.get<QuestionPacketRecord>(cycle.record.value.next.id)!;
  assert.equal(blocked.value.state, 'blocked'); assert.equal(blocked.value.packet, null);
  assert.ok(blocked.value.fullChars! > config.value.requestCapacityChars!);
  assert.ok(f.store.list('om-read-delivery').some(record => (record.value as {data: unknown}).data === 'UTF-8 '.repeat(20_000)));
  f.restart(); valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) }));
  assert.equal(valueOf(await runModelCycle(f.store, request)).repeated, true); assert.equal(f.sent().length, 1);
});

test('E4 cycle assembles all node parts after a source continuation with exact coverage and no hidden final call', async t => {
  const f = e4Fixture(t, 'node'), config = f.environment(f.packet.value.fullChars! - 1);
  const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
  assert.equal(packet.value.state, 'ready'); assert.equal(packet.value.plan!.mode, 'parts');
  const total = packet.value.plan!.assignments.length;
  const answers = Array.from({length: total}, (_, position) => e4Node(f, { ...packet,
    value: { ...packet.value, plan: { ...packet.value.plan!, position } } } as Revision<QuestionPacketRecord>));
  const need = { ...e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]),
    questionIds: (packet.value.packet as {questions: {id: string}[]}).questions.map(question => question.id) };
  f.steps([{ research: need }, ...answers.map(research => ({ research }))]);
  const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
  const cycle = valueOf(await runModelCycle(f.store, request));
  assert.equal(cycle.record.value.terminal, 'assembled'); assert.ok(cycle.assembly); assert.equal(f.sent().length, total + 1);
  const assembly = valueOf(readPartAssembly(f.store, { project: f.project, record: cycle.assembly }));
  assert.equal(assembly.proposal.value.status, 'proposed'); assert.equal(assembly.record.value.results.length, total);
  assert.deepEqual(assembly.proposal.value.fills.map(fill => fill.obligation).sort(), packet.value.plan!.assignments.flatMap(item => item.obligations).sort());
  assert.equal(f.store.get<{attempts: {outcome: unknown}[]}>(f.series.id)!.value.attempts[0]!.outcome, null);
  const snapshot = f.store.list().map(reference); f.restart();
  valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) }));
  assert.deepEqual(valueOf(assembleModelParts(f.store, { project: f.project, results: cycle.record.value.results as Ref[] })).record, assembly.record);
  valueOf(await runModelCycle(f.store, request)); assert.deepEqual(f.store.list().map(reference), snapshot);
});

test('S1.1 a saved assembly is proved once per operation on its original source: a repeat reuses the proof, the historical path opens no pending view, the current assembly keeps its pending proposal, a re-entry is a cycle', async t => {
  const f = e4Fixture(t, 'node'), config = f.environment(f.packet.value.fullChars! - 1);
  const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
  const total = packet.value.plan!.assignments.length;
  f.steps(Array.from({ length: total }, (_, position) => ({ research: e4Node(f, { ...packet,
    value: { ...packet.value, plan: { ...packet.value.plan!, position } } } as Revision<QuestionPacketRecord>) })));
  const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
  const cycle = valueOf(await runModelCycle(f.store, request));
  assert.equal(cycle.record.value.terminal, 'assembled'); assert.ok(cycle.assembly);
  const read = (store: Store) => valueOf(readPartAssembly(store, { project: f.project, record: cycle.assembly! }));
  const assembly = read(f.store);
  const parts = assembly.record.value.results.map(record => valueOf(readPartResult(f.store, { project: f.project, record })));
  // Every exact read of the assembly, its proposal, its parts and their packets, through any Store; and every pending view
  // the producer builds (a frozen overlay that is itself a Store), observed where it is made.
  const originalGet = Store.prototype.get, reads = new Map<string, number>(), freeze = Object.freeze, views: unknown[] = [];
  const watched = new Set([cycle.assembly.id, assembly.proposal.id, ...assembly.record.value.results.map(ref => ref.id),
    ...parts.map(part => part.record.value.request.packet.id)]);
  Store.prototype.get = function (this: Store, id: string, revision?: number) {
    if (watched.has(id)) reads.set(id, (reads.get(id) ?? 0) + 1); return originalGet.call(this, id, revision);
  } as typeof Store.prototype.get;
  Object.freeze = (<T>(value: T): T => { if (value instanceof Store) views.push(value); return freeze(value); }) as typeof Object.freeze;
  t.after(() => { Store.prototype.get = originalGet; Object.freeze = freeze; });
  const count = () => [...reads.values()].reduce((sum, value) => sum + value, 0);
  withHistoricalReads(() => {
    const first = read(f.store), cold = count();
    assert.ok(cold > 0); assert.deepEqual(first, assembly);
    assert.equal(views.length, 0, 'The historical derivation of a saved assembly proves its frame on the original source, without a pending view');
    const again = read(f.store);
    assert.deepEqual(again, first);
    assert.equal(count(), cold, 'The repeat is served by the proof: nothing of the assembly, its parts, packets or proposal is read again');
    assert.deepEqual(again.references, first.references);
  });
  const outside = count();
  assert.deepEqual(read(f.store), assembly);
  assert.ok(count() > outside, 'A new operation proves the saved assembly again');
  assert.equal(views.length, 0);
  // The current assembly of the same parts still checks its pending proposal on a pending view, and writes nothing new.
  const snapshot = f.store.list().map(reference);
  assert.deepEqual(valueOf(assembleModelParts(f.store, { project: f.project, results: [...cycle.record.value.results] })).record, assembly.record);
  assert.deepEqual(f.store.list().map(reference), snapshot);
  const fresh = e4Fixture(t, 'node'), freshConfig = fresh.environment(fresh.packet.value.fullChars! - 1);
  const freshPacket = valueOf(writeQuestionPacket(fresh.store, { ...fresh.packetRequest, environment: reference(freshConfig) })).record;
  const freshTotal = freshPacket.value.plan!.assignments.length;
  fresh.steps(Array.from({ length: freshTotal }, (_, position) => ({ research: e4Node(fresh, { ...freshPacket,
    value: { ...freshPacket.value, plan: { ...freshPacket.value.plan!, position } } } as Revision<QuestionPacketRecord>) })));
  const before = views.length;
  const freshCycle = valueOf(await runModelCycle(fresh.store, { ...fresh.request, packet: reference(freshPacket), dispatch: { ...fresh.request.dispatch, config: reference(freshConfig) } }));
  assert.equal(freshCycle.record.value.terminal, 'assembled');
  assert.ok(views.length > before, 'A new current assembly still stands on its pending proposal before it is written');
  // A re-entry into the same active exact key is a cyclic derivation, addressed at the assembly; the outer read completes.
  let inner: OmResult<unknown> | null = null, probe = true;
  const view: Store = new Proxy(f.store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) => {
      if (probe && id === assembly.record.value.results[0]!.id) { probe = false; inner = readPartAssembly(view, { project: f.project, record: cycle.assembly! }); }
      return target.get(id, revision);
    };
    const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  withHistoricalReads(() => {
    assert.deepEqual(read(view).record, assembly.record);
    assert.ok(inner !== null && !(inner as OmResult<unknown>).ok);
    const refusal = (inner as OmResult<unknown> & { ok: false }).refusal;
    assert.deepEqual([refusal.code, refusal.at.target, refusal.at.field, refusal.at.ref], ['model_parts_invalid', cycle.assembly!.id, 'history', cycle.assembly]);
  });
});

test('E4 carries checked works handoffs through local dispatch, split assembly, restart and exact late repeats without accepting L3', async t => {
  for (const split of [false, true]) await t.test(split ? 'split with prior work and test' : 'whole node', async t => {
    const f = e4WorksFixture(t), config = split ? f.environment(f.packet.value.fullChars! - 1) : f.configured;
    const packet = split ? valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record : f.packet;
    assert.equal(packet.value.state, 'ready'); assert.equal(packet.value.plan!.mode, split ? 'parts' : 'whole');
    const count = packet.value.plan!.assignments.length;
    assert.ok(split ? count > 1 : count === 1);
    const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
    const payload = packet.value.packet as { requestId: string; works: { assigned: string[]; nodeAssignments: string[] } };
    const beforeForm = f.store.list().map(reference), answer = f.answer(packet as Revision<QuestionPacketRecord>);
    const raw = (body: object) => JSON.stringify({ ...body, requestId: payload.requestId });
    const { bindings: _bindings, ...missing } = answer;
    assert.equal(checkAnswerForm(f.store, { project: f.project, packet: reference(packet), raw: raw(missing) }).ok, false);
    if (split) {
      assert.deepEqual(payload.works.assigned, []); assert.ok(payload.works.nodeAssignments.length);
      assert.equal(checkAnswerForm(f.store, { project: f.project, packet: reference(packet), raw: raw({ ...answer, bindings: f.bindings }) }).ok, false);
    }
    assert.deepEqual(f.store.list().map(reference), beforeForm); assert.equal(f.sent().length, 0);
    f.steps(Array.from({ length: count }, (_, position) => ({ research: f.answer(packet as Revision<QuestionPacketRecord>, position), usage })));
    const acceptedIds = [`graph:${f.project}`, `graph-layer:${f.project}:2`, `graph-layer:${f.project}:3`, `om-frame:${f.project}:3`];
    const acceptedBefore = acceptedIds.map(id => f.store.get(id));
    if (split) {
      const writeMany = f.store.writeMany.bind(f.store); let stopped = false;
      f.store.writeMany = ((writes, guards) => {
        const saved = writeMany(writes, guards);
        if (!stopped && writes.some(write => write.kind === 'part-result')) {
          stopped = true; throw new Error('E4 stop after saved work part');
        }
        return saved;
      }) as Store['writeMany'];
      await assert.rejects(runModelCycle(f.store, request), /E4 stop after saved work part/);
      f.store.writeMany = writeMany; assert.equal(f.sent().length, 1); f.restart();
    }
    const cycle = valueOf(await runModelCycle(f.store, request));
    assert.equal(cycle.record.value.terminal, 'assembled'); assert.ok(cycle.assembly); assert.equal(f.sent().length, count);
    const assembly = valueOf(readPartAssembly(f.store, { project: f.project, record: cycle.assembly }));
    const expected = { contract: 'works-frame/v1', producer: reference(f.ledger.producer), ledger: reference(f.ledger.record), bindings: f.bindings };
    assert.deepEqual(assembly.record.value.works, expected); assert.equal(assembly.proposal.value.worksContract, 'works-frame/v1');
    assert.equal(assembly.proposal.value.status, 'proposed'); assert.equal(Object.hasOwn(assembly.proposal.value, 'bindings'), false);
    const parts = cycle.record.value.results.map(record => valueOf(readPartResult(f.store, { project: f.project, record })));
    assert.equal(parts.length, count);
    parts.forEach((part, position) => {
      const issued = f.store.get<QuestionPacketRecord>(part.record.value.request.packet.id, part.record.value.request.packet.revision)!;
      const context = issued.value.packet as { works: { obligations: unknown[]; nodeAssignments: string[]; assigned: string[] } };
      assert.deepEqual(context.works.obligations, f.ledger.handoff.obligations);
      assert.deepEqual(context.works.nodeAssignments, payload.works.nodeAssignments);
      assert.deepEqual(context.works.assigned, position === count - 1 ? payload.works.nodeAssignments : []);
      assert.equal(issued.value.fingerprint!.chars, canonical(issued.value.packet).length);
      assert.ok(issued.value.fingerprint!.chars <= config.value.requestCapacityChars!);
      assert.deepEqual(part.record.value.works, { ...expected, bindings: position === count - 1 ? f.bindings : [] });
      const response = f.store.get<{ raw: string }>(part.record.value.request.response.id, part.record.value.request.response.revision)!;
      assert.deepEqual(JSON.parse(response.value.raw).bindings, position === count - 1 ? f.bindings : []);
      const runtime = cycle.record.value.steps[position]!;
      const call = valueOf(readModelCall(f.store, { project: f.project, record: runtime.record }));
      assert.equal(call.outcome?.kind, 'node-proposal');
      if (call.outcome?.kind === 'node-proposal') assert.deepEqual(call.outcome.works, part.record.value.works);
      assert.deepEqual(valueOf(readCall(f.store, f.project, reference(f.store.get(call.call.id)!))).value.usage, usage);
    });
    if (split) {
      assert.ok(parts[0]!.proposal.value.nodes.some(node => node.id === f.work.id));
      assert.deepEqual(parts.at(-1)!.proposal.value.nodes, []); assert.deepEqual(parts.at(-1)!.proposal.value.tests, []);
    }
    assert.deepEqual(acceptedIds.map(id => f.store.get(id)), acceptedBefore);
    assert.equal(f.store.get<{attempts: {outcome: unknown}[]}>(f.series.id)!.value.attempts[0]!.outcome, null);
    assert.equal(f.store.list('accepted-answer').length, 0);
    const snapshot = f.store.list().map(reference); f.restart();
    assert.deepEqual(valueOf(readPartAssembly(f.store, { project: f.project, record: cycle.assembly })).record, assembly.record);
    assert.deepEqual(valueOf(assembleModelParts(f.store, { project: f.project, results: [...cycle.record.value.results] })).record, assembly.record);
    valueOf(await runModelCycle(f.store, request)); valueOf(await runModelCall(f.store, request));
    assert.deepEqual(f.store.list().map(reference), snapshot); assert.equal(f.sent().length, count);
    for (const substitute of [null, { ...expected, bindings: [] }]) {
      const value = structuredClone(assembly.record.value) as import('../src/om/model-call.js').PartAssemblyRecord;
      if (substitute) value.works = substitute as NonNullable<typeof value.works>; else delete value.works;
      const forged = { ...assembly.record, hash: hashJson(value), value };
      const view = new Proxy(f.store, { get(target, key) {
        if (key === 'get') return (id: string, revision?: number) => id === forged.id && (revision === undefined || revision === forged.revision)
          ? forged : target.get(id, revision);
        const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
      } });
      const denied = readPartAssembly(view, { project: f.project, record: reference(forged) });
      assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.refusal.code, 'model_parts_invalid');
    }
    if (split) {
      const measured = packet.value.packet as { responseForm: unknown; works: unknown };
      const tooSmall = f.environment(canonical(measured.responseForm).length + canonical(measured.works).length - 1);
      const blocked = valueOf(prepareQuestionPacket(f.store, { ...f.packetRequest, environment: reference(tooSmall) }));
      assert.equal(blocked.record.value.state, 'blocked');
      assert.equal(blocked.record.value.refusal?.code, 'node_unexpandable');
      assert.equal(blocked.record.value.packet, null); assert.equal(f.sent().length, count);
    }
  });
});

test('E4 delivery reader rejects substituted data, response and source even when record hashes are recomputed', async t => {
  const f = e4Fixture(t); f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]) }]);
  const call = valueOf(await runModelCall(f.store, f.request)); assert.ok(call.response);
  const basis = { project: f.project, packet: f.request.packet, call: call.call, response: call.response };
  const delivered = valueOf(deliverModelSources(f.store, basis));
  for (const change of ['data', 'response', 'sources'] as const) {
    const original = f.store.get<Record<string, Json>>(delivered.deliveries[0]!.id)!, value = structuredClone(original.value);
    if (change === 'data') value.data = 'forged';
    else if (change === 'response') value.response = reference(f.source) as unknown as Json;
    else value.sources = [reference(f.source)] as unknown as Json;
    const forged = f.store.write({ id: `om-read-delivery:${f.project}:${hashJson(value)}`, kind: 'om-read-delivery', expected: 0, value });
    const actual = readContinuationEvidence(f.store, { ...basis, deliveries: [reference(forged)] });
    assert.equal(actual.ok, false, change);
  }
  const before = f.store.list().map(reference); f.restart();
  assert.deepEqual(valueOf(deliverModelSources(f.store, basis)).deliveries, delivered.deliveries);
  assert.deepEqual(f.store.list().map(reference), before);
});

// E1 analysis admissions use the same physical boundary, without manufacturing E2 or A6 forms.
import { Environments } from '../src/runtime/environment.js';
import { completeAttempt, readSeries, type RepairSeries } from '../src/om/series.js';
import { recordCall } from '../src/om/call-record.js';
import { recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND } from '../src/om/refusal-journal.js';
import { closeAttempt } from '../src/om/repeat-gate.js';
import { runModelTransport, readModelTransport, type ModelTransportRequest } from '../src/om/model-call.js';

function e4AnalysisFixture(t: TestContext, purpose: 'stop-analysis' | 'origin-analysis', timeoutMs = 1000) {
  const root = mkdtempSync(join(tmpdir(), 'omg-e4-analysis-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = 'analysis', block = 'analyzed-block', address = { project, block, line: 1 };
  const goal = { key: 'analysis-fixture-goal', questions: ['Address one contract'], result: 'A supported contract' };
  valueOf(openSeries(store, { ...address, slice: 'analysis-slice', predecessor: null, basis: null }));
  let series = valueOf(beginAttempt(store, { ...address, attempt: 1, goal })) as Revision<RepairSeries>;
  let basis: {kind: 'series-stop';series: Ref;attempt: number} | {kind: 'origin-hold';hold: Ref};
  if (purpose === 'stop-analysis') {
    for (const attempt of [1, 2, 3]) {
      if (attempt > 1) valueOf(beginAttempt(store, { ...address, attempt, goal }));
      series = valueOf(completeAttempt(store, { ...address, attempt,
        outcome: { reason: 'result', achieved: [], cancelled: [], refusals: [] } })) as Revision<RepairSeries>;
    }
    basis = { kind: 'series-stop', series: reference(series), attempt: 3 };
  } else {
    const refusal = store.write({ id: `${unitRefusalNamespace(project)}analysis-source`, kind: UNIT_REFUSAL_KIND, expected: 0,
      value: { gate: 'G3', refusals: [{ code: 'unrecognized_fixture_refusal', goal: goal.key, remedy: 'Identify the exact origin',
        origin: { name: 'artifact_missing', stage: 'layer-check', subject: 'artifact:fixture', sources: [] } }] } });
    const journal = valueOf(recordRefusal(store, { project, source: reference(refusal) }));
    const row = journal.value.rows[0]!;
    const closed = valueOf(closeAttempt(store, { ...address, attempt: 1,
      outcome: { reason: 'refused', accepting: [], cancelling: [], refusals: [{ row: row.id, name: row.code, goal: row.goal }] } }));
    assert.equal(closed.holds.length, 1);
    series = store.get<RepairSeries>(series.id)!; basis = { kind: 'origin-hold', hold: closed.holds[0]! };
  }
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [fixturePath, '--scenario', scenario, '--trace', trace] };
  const environment = new Environments(store).configure(project, { workspace: root, implementer: { actor: 'analysis-executor', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'analysis-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs }, 0);
  const adapter = store.write({ id: `adapter:${project}`, kind: 'dispatch-adapter', expected: 0, value: { protocol: 'codex-stdio' } });
  const packet = { task: 'Diagnose the named ground', note: 'No fabricated A6 protocol', basis } as unknown as Json;
  const reviewGoal = { key: purpose, questions: ['What caused this ground?'], result: 'A cause or explicit hypothesis with an addressed change' };
  const admitted = valueOf(recordCall(store, project, { call: `e4:${purpose}`, purpose, basis, block,
    gaps: [{ id: purpose, goal: purpose, field: 'cause-and-change', consumer: 'A6:stop-analysis' }], series: reference(series),
    attempt: purpose === 'stop-analysis' ? 3 : 1, goal: reviewGoal,
    dispatch: { adapter: reference(adapter), config: reference(environment) }, packet }));
  const request: ModelTransportRequest = { project, call: reference(admitted.call), packet, role: 'reviewer' };
  writeFileSync(scenario, JSON.stringify({ steps: [{ research: { cause: 'fixture observation', hypothesis: true }, usage, confirmed }] }));
  return { root, database: path, scenario, trace, project, packet, request, series, address, environment,
    get store() { return store; }, restart() { store.close(); store = new Store(path); },
    sent() { return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean) : []; } };
}

test('E4 analysis transport sends both real E1 purposes, preserves opaque A6 data and settles without another attempt', async t => {
  for (const purpose of ['stop-analysis', 'origin-analysis'] as const) {
    const f = e4AnalysisFixture(t, purpose), before = reference(f.store.get(f.series.id)!);
    const sent = valueOf(await runModelTransport(f.store, f.request));
    assert.equal(sent.result.kind, 'answered'); assert.equal(sent.record.value.purpose, purpose);
    if (sent.result.kind === 'answered') assert.deepEqual(JSON.parse(sent.result.raw), { cause: 'fixture observation', hypothesis: true });
    assert.deepEqual(sent.record.value.usage, usage); assert.equal(f.sent().length, 1);
    assert.deepEqual(reference(f.store.get(f.series.id)!), before); assert.equal(f.store.list('question-packet').length, 0);
    assert.equal(f.store.get<{status:string}>(sent.call.id)!.value.status, 'succeeded');
    const expected = valueOf(readModelTransport(f.store, { project: f.project, record: reference(sent.record) }));
    f.store.write({ id: f.environment.id, kind: f.environment.kind, expected: f.environment.revision, value: f.environment.value });
    f.restart();
    assert.deepEqual(valueOf(await runModelTransport(f.store, f.request)), expected); assert.equal(f.sent().length, 1);
  }
});

test('E4 analysis transport rejects another actual body and stale fresh-dispatch grounds without spawning', async t => {
  const f = e4AnalysisFixture(t, 'stop-analysis');
  const wrongBody = await runModelTransport(f.store, { ...f.request, packet: { text: 'Copied call ref with a different payload' } });
  assert.equal(wrongBody.ok, false); if (!wrongBody.ok) assert.equal(wrongBody.refusal.code, 'packet_invalid');
  f.store.write({ id: f.environment.id, kind: f.environment.kind, expected: f.environment.revision, value: f.environment.value });
  const stale = await runModelTransport(f.store, f.request);
  assert.equal(stale.ok, false); assert.equal(f.sent().length, 0); assert.equal(f.store.list('model-call').length, 0);
});

test('E4 mechanism field dispatch applies E3 decisions through D3 and does not manufacture accepted progress', async t => {
  const f = e4Fixture(t, 'field');
  f.steps([{ research: { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'answer',
    results: f.batch.items.map(item => ({ target: item.target, field: item.field, basis: item.record,
      value: { consumer: 'garden-consume-block', kind: 'repository-fact' } })) } }]);
  const sent = valueOf(await runModelCall(f.store, f.request));
  assert.equal(sent.outcome?.kind, 'input-decisions'); assert.ok(sent.record.value.om.input);
  assert.equal(f.store.get<{attempts:{outcome: unknown}[]}>(f.series.id)!.value.attempts[0]!.outcome, null);
  const changed = f.store.get<{input:{questions:{id:string;kind:string}[]}}>(f.input.id)!;
  assert.equal(changed.value.input.questions.find(question => question.id === 'discovery:encoding')!.kind, 'repository-fact');
  assert.equal(f.store.list('accepted-answer').length, 0);
  assert.deepEqual(valueOf(readModelCall(f.store, { project: f.project, record: reference(sent.record) })).record, sent.record);
});

test('E4 cycle refuses missing coverage and conflicting definitions without accepting a partial node', async t => {
  for (const issue of ['coverage', 'conflict'] as const) {
    const f = e4Fixture(t, 'node'), config = f.environment(f.packet.value.fullChars! - 1);
    const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
    assert.equal(packet.value.plan!.mode, 'parts'); assert.ok(packet.value.plan!.assignments.length > 1);
    const answers = packet.value.plan!.assignments.map((_, position) => e4Node(f, { ...packet,
      value: { ...packet.value, plan: { ...packet.value.plan!, position } } } as Revision<QuestionPacketRecord>));
    if (issue === 'coverage') answers.at(-1)!.proposal.fills.pop();
    else for (let i = 0; i < 2; i++) answers[i]!.proposal.contracts.push({ id: 'e4-extra-contract', schema: { type: i === 0 ? 'string' : 'number' } });
    f.steps(answers.map(research => ({ research })));
    const cycle = valueOf(await runModelCycle(f.store, { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } }));
    assert.equal(cycle.record.value.terminal, 'parts-invalid', issue); assert.equal(cycle.assembly, null); assert.ok(cycle.diagnostic);
    const diagnostic = f.store.get<{refusals: {code: string}[]}>(cycle.diagnostic.id)!;
    assert.equal(diagnostic.value.refusals[0]!.code, issue === 'coverage' ? 'model_parts_invalid' : 'model_parts_conflict');
    assert.equal(f.store.list('om-part-assembly').length, 0);
    assert.equal(f.store.get<{withoutProgress:number}>(f.series.id)!.value.withoutProgress, 1);
    f.restart(); valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) }));
  }
});

test('E4 delivery writes guard source heads and reject corrupt replay records with addressed errors', async t => {
  const f = e4Fixture(t); f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]) }]);
  const call = valueOf(await runModelCall(f.store, f.request)); assert.ok(call.response);
  const basis = { project: f.project, packet: f.request.packet, call: call.call, response: call.response };
  const writeMany = f.store.writeMany.bind(f.store); let raced = false;
  f.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(write => write.kind === 'om-read-delivery')) {
      raced = true;
      const source = guards!.map(ref => f.store.get<{origin: {location: string}}>(ref.id))
        .find(record => record?.kind === 'source' && record.value.origin.location === join(f.configured.value.workspace, 'e4-source.txt'))!;
      writeMany([{ id: source.id, kind: source.kind, expected: source.revision, value: source.value }]);
    }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  const refused = deliverModelSources(f.store, basis); f.store.writeMany = writeMany;
  assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.refusal.code, 'input_stale');
  assert.equal(f.store.list('om-read-delivery').length, 0); assert.equal(f.store.list('om-read-delivery-set').length, 0);
  const delivered = valueOf(deliverModelSources(f.store, basis));
  const set = f.store.list('om-read-delivery-set')[0]!;
  const get = f.store.get.bind(f.store);
  f.store.get = ((id, revision) => id === set.id ? { ...set, value: null } : get(id, revision)) as Store['get'];
  const malformed = deliverModelSources(f.store, basis); f.store.get = get;
  assert.equal(malformed.ok, false); if (!malformed.ok) assert.equal(malformed.refusal.code, 'model_delivery_invalid');
  assert.equal(valueOf(readContinuationEvidence(f.store, { ...basis, deliveries: delivered.deliveries as Ref[] })).data.length, 1);
});

test('E4 node result conflict leaves no partial response/proposal/result, accounts observed usage and never dispatches twice', async t => {
  const f = e4Fixture(t, 'node'); f.steps([{ research: e4Node(f), usage }]);
  const writeMany = f.store.writeMany.bind(f.store); let injected = false;
  f.store.writeMany = ((writes, guards) => {
    if (!injected && writes.some(write => write.kind === 'part-result')) {
      injected = true;
      const env = f.store.get(f.configured.id)!;
      writeMany([{ id: env.id, kind: env.kind, expected: env.revision, value: env.value }]);
    }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  const actual = valueOf(await runModelCall(f.store, f.request)); f.store.writeMany = writeMany;
  assert.equal(actual.record.value.status, 'failed'); assert.equal(actual.record.value.error, 'input_stale');
  assert.ok(actual.record.value.om.rejection && actual.record.value.om.exchange && actual.diagnostic);
  assert.equal(actual.outcome, null);
  assert.ok(injected); assert.equal(f.sent().length, 1);
  for (const kind of ['part-response', 'part-result']) assert.equal(f.store.list(kind).length, 0);
  assert.equal(f.store.list('layer-proposal').length, 0);
  const call = f.store.list<{usage: typeof usage;status:string}>('call-record')[0]!;
  assert.deepEqual(call.value.usage, usage); assert.equal(call.value.status, 'failed');
  const expected = valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) }));
  f.restart();
  const repeated = valueOf(await runModelCall(f.store, f.request));
  assert.deepEqual(repeated, expected);
  assert.equal(f.sent().length, 1);
});

import { Evidence } from '../src/evidence/evidence.js';
test('E4 retains terminal evidence when environment or captured file changes during the physical call before E3 preparation', async t => {
  for (const change of ['environment', 'file'] as const) {
    const f = e4Fixture(t), reply = e4Fact(f);
    const file = new Evidence(f.store).file(f.project, 'transport-file', f.root, 'e4-source.txt', 'text/plain', 0);
    if (change === 'file') reply.results[0]!.citations = [{ source: reference(file), selector: { kind: 'text-range', start: 0, end: file.value.content.length } }];
    f.steps([{ research: reply, usage }]);
    const get = f.store.get.bind(f.store); let injected = false;
    f.store.get = ((id, revision) => {
      if (!injected && f.sent().length && id === (change === 'environment' ? f.configured.id : file.id)) {
        injected = true;
        if (change === 'environment') {
          const env = get(f.configured.id)!;
          f.store.write({ id: env.id, kind: env.kind, expected: env.revision, value: env.value });
        } else writeFileSync(join(f.root, 'e4-source.txt'), 'A different physical source after the request.');
      }
      return get(id, revision);
    }) as Store['get'];
    const actual = valueOf(await runModelCall(f.store, f.request)); f.store.get = get;
    assert.ok(injected); assert.equal(actual.record.value.status, 'failed'); assert.ok(actual.record.value.om.rejection);
    assert.equal(actual.response, null); assert.equal(f.store.list('part-response').length, 0);
    assert.deepEqual(actual.record.value.usage, usage); assert.equal(f.sent().length, 1);
    const saved = valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) }));
    writeFileSync(join(f.root, 'e4-source.txt'), 'Still later file content must not reinterpret the failed window.');
    f.restart();
    assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), saved); assert.equal(f.sent().length, 1);
    assert.equal(f.store.history(actual.record.id).length, 4);
  }
});

test('E4 exact malformed environment and adapter sources return addressed refusals instead of raw property exceptions', async t => {
  for (const malformed of ['environment', 'adapter'] as const) {
    const f = e4AnalysisFixture(t, 'stop-analysis'), get = f.store.get.bind(f.store);
    const source = malformed === 'environment' ? f.environment.id : 'adapter:analysis';
    f.store.get = ((id, revision) => {
      const row = get(id, revision); return row && id === source ? { ...row, value: null } : row;
    }) as Store['get'];
    const actual = await runModelTransport(f.store, f.request); f.store.get = get;
    assert.equal(actual.ok, false); if (!actual.ok) assert.equal(actual.refusal.code, 'dispatch_contract_invalid');
    assert.equal(f.sent().length, 0);
  }
});

test('E4 public persistence paths reject absent or malformed requests before reading the store', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-e4-arguments-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const calls = [readContinuationEvidence, deliverModelSources, readPartAssembly, assembleModelParts, readModelCycle,
    readModelCall, readModelTransport, finishModelAttempt, prepareModelAttemptFinish, readModelApplicationRejection, runModelCycle, runModelCall, runModelTransport];
  const before = store.list();
  for (const call of calls) for (const request of [undefined, null, [], {}, { project: 'p', record: null }]) {
    let error: unknown;
    try { await (call as (s: Store, value: unknown) => unknown)(store, request); }
    catch (caught) { error = caught; }
    assert.ok(error instanceof EngineError, call.name);
    assert.equal(error.code, 'model_call_request_invalid', call.name);
  }
  assert.deepEqual(store.list(), before);
});

test('E4 preserves received exchange when another Store completes the attempt during dispatch or application', async t => {
  for (const phase of ['before-form', 'application'] as const) for (const kind of ['fact', 'node'] as const) {
    const f = e4Fixture(t, kind);
    f.steps([{ research: kind === 'node' ? e4Node(f) : e4Fact(f), usage }]);
    const get = f.store.get.bind(f.store), writeMany = f.store.writeMany.bind(f.store);
    let completed: Revision<unknown> | null = null;
    const complete = () => {
      const other = new Store(f.database);
      try { completed = valueOf(completeAttempt(other, { ...seriesRequestOf(f.series.value), attempt: 1,
        outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } })); }
      finally { other.close(); }
    };
    f.store.get = ((id, revision) => {
      if (phase === 'before-form' && !completed && f.sent().length && id === f.series.id) complete();
      return get(id, revision);
    }) as Store['get'];
    f.store.writeMany = ((writes, guards) => {
      if (phase === 'application' && !completed && writes.some(write => write.kind === 'part-response')) complete();
      return writeMany(writes, guards);
    }) as Store['writeMany'];
    const actual = valueOf(await runModelCall(f.store, f.request));
    f.store.get = get; f.store.writeMany = writeMany;
    assert.ok(completed); assert.equal(actual.record.value.status, 'failed'); assert.equal(actual.outcome, null);
    assert.equal(actual.diagnostic, null); assert.equal(actual.record.value.om.part, null);
    assert.equal(f.store.list('om-model-exchange').length, 1); assert.equal(f.sent().length, 1);
    const exchange = f.store.list<{process: {stdout: string}}>('om-model-exchange')[0]!;
    assert.deepEqual(JSON.parse(exchange.value.process.stdout).usage, usage);
    assert.deepEqual(f.store.get(f.series.id), completed);
    for (const recordKind of ['part-response', 'part-result', 'layer-proposal']) assert.equal(f.store.list(recordKind).length, 0);
    const call = f.store.list<{usage: typeof usage;status: string}>('call-record')[0]!;
    assert.deepEqual(call.value.usage, usage); assert.equal(call.value.status, 'failed');
    const expected = valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) }));
    const saved = f.store.list();
    f.restart();
    assert.deepEqual(valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) })), expected);
    assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), expected);
    assert.deepEqual(f.store.list(), saved); assert.equal(f.sent().length, 1);
    if (phase === 'before-form' && kind === 'fact') {
      const rejection = f.store.get<Record<string, Json>>(actual.record.value.om.rejection!.id)!;
      const forged = { ...structuredClone(rejection.value), completion: reference(f.series) };
      const record = f.store.write({ id: `om-model-application-rejection:${f.project}:${hashJson(forged)}`,
        kind: rejection.kind, expected: 0, value: forged });
      const denied = readModelApplicationRejection(f.store, { project: f.project, record: reference(record) });
      assert.equal(denied.ok, false);
      if (!denied.ok) assert.equal(denied.refusal.at.field, 'completion');
      const head = f.store.get(f.series.id)!;
      const later = f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
      const substituted = { ...structuredClone(rejection.value), completion: reference(later) };
      const wrongWindow = f.store.write({ id: `om-model-application-rejection:${f.project}:${hashJson(substituted)}`,
        kind: rejection.kind, expected: 0, value: substituted });
      const wrong = readModelApplicationRejection(f.store, { project: f.project, record: reference(wrongWindow) });
      assert.equal(wrong.ok, false, 'Another legal completed revision is not the preserved rejection window');
      if (!wrong.ok) assert.equal(wrong.refusal.at.field, 'completion');
      f.restart();
      assert.deepEqual(valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) })), expected);
    }
  }
});


test('E4 physical receipt survives a second race that prevents applying the rejection and completing A3', async t => {
  const f = e4Fixture(t, 'node'); f.steps([{ research: e4Node(f), usage }]);
  const writeMany = f.store.writeMany.bind(f.store); let changed = false, completed: Revision<unknown> | null = null;
  f.store.writeMany = ((writes, guards) => {
    if (!changed && writes.some(write => write.kind === 'part-result')) {
      changed = true;
      const env = f.store.get(f.configured.id)!;
      writeMany([{ id: env.id, kind: env.kind, expected: env.revision, value: env.value }]);
    }
    if (!completed && writes.some(write => write.kind === 'om-model-application-rejection')) {
      const other = new Store(f.database);
      try { completed = valueOf(completeAttempt(other, { ...seriesRequestOf(f.series.value), attempt: 1,
        outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } })); }
      finally { other.close(); }
    }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  const applied = await runModelCall(f.store, f.request); f.store.writeMany = writeMany;
  assert.equal(applied.ok, false); assert.ok(changed && completed);
  const runtime = f.store.list<OmModelCall>('model-call')[0]!;
  assert.equal(runtime.value.status, 'succeeded'); assert.equal(runtime.value.om.application, 'received');
  assert.deepEqual(runtime.value.usage, usage); assert.equal(f.store.list('om-model-exchange').length, 1);
  const physical = valueOf(readModelCallState(f.store, { project: f.project, record: reference(runtime) }));
  assert.equal(physical.state, 'received');
  const pending = readModelCall(f.store, { project: f.project, record: reference(runtime) });
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.equal(pending.refusal.code, 'model_call_application_pending');
  assert.deepEqual(f.store.get(f.series.id), completed);
  const unsettled = f.store.list<{status: string; usage: unknown}>('call-record')[0]!;
  assert.equal(unsettled.value.status, 'open'); assert.equal(unsettled.value.usage, null);
  for (const recordKind of ['part-response', 'part-result', 'layer-proposal']) assert.equal(f.store.list(recordKind).length, 0);
  f.restart();
  const resumed = valueOf(await runModelCall(f.store, f.request));
  assert.equal(resumed.record.value.om.application, 'application-refused');
  assert.ok(resumed.record.value.om.rejection); assert.equal(resumed.part, null); assert.equal(resumed.diagnostic, null);
  assert.deepEqual(f.store.get(f.series.id), completed);
  const accounted = f.store.list<{usage: typeof usage; status: string}>('call-record')[0]!;
  assert.deepEqual(accounted.value.usage, usage); assert.equal(accounted.value.status, 'failed');
  assert.equal(f.store.history(accounted.id).length, 2);
  assert.equal(f.store.list('om-model-exchange').length, 1);
  const before = f.store.list(); f.restart();
  const replay = valueOf(await runModelCall(f.store, f.request));
  assert.deepEqual(replay, valueOf(readModelCall(f.store, { project: f.project, record: reference(resumed.record) })));
  assert.deepEqual(f.store.list(), before); assert.equal(f.sent().length, 1);
});

test('E4 control completion cannot replace an outcome saved after the control response was received', async t => {
  const f = e4Fixture(t);
  f.steps([{ research: { protocol: 'omg-answer/v2', requestId: '$requestId', questionIds: [f.batch.items[0]!.gap],
    action: 'cannot_answer', reason: 'The requested information is unavailable' }, usage }]);
  const get = f.store.get.bind(f.store); let completed: Revision<unknown> | null = null;
  f.store.get = ((id, revision) => {
    if (!completed && f.sent().length && id.startsWith(`om-unit-refusal:${f.project}:e4:`)) {
      const other = new Store(f.database);
      try { completed = valueOf(completeAttempt(other, { ...seriesRequestOf(f.series.value), attempt: 1,
        outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } })); }
      finally { other.close(); }
    }
    return get(id, revision);
  }) as Store['get'];
  const actual = valueOf(await runModelCall(f.store, f.request)); f.store.get = get;
  assert.ok(completed); assert.equal(actual.record.value.status, 'failed'); assert.equal(actual.diagnostic, null);
  assert.equal(actual.record.value.om.application, 'application-refused'); assert.equal(f.store.list('om-model-exchange').length, 1);
  assert.deepEqual(f.store.get(f.series.id), completed); assert.equal(f.store.list('part-response').length, 0);
  assert.deepEqual(actual.record.value.usage, usage);
  const snapshot = f.store.list(), historical = valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) }));
  f.restart(); assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), historical);
  assert.deepEqual(f.store.list(), snapshot); assert.equal(f.sent().length, 1);
});

// A stopped process can leave any durable prefix of the cycle. The assertions cover every
// writeMany commit, including admission/claim before spawning and accounting after application.
const cycleCommitPhases = ['admitted', 'running', 'authorized', 'received', 'applied', 'settled', 'cycle'] as const;
type CycleCommitPhase = typeof cycleCommitPhases[number] | 'source' | 'deliveries' | 'continuation' | 'assembly' | 'application-refused';
function cycleCommitPhase(writes: Write[]): CycleCommitPhase {
  const runtime = writes.find(write => write.kind === 'model-call');
  if (runtime) {
    const body = runtime.value as unknown as OmModelCall;
    if (body.status === 'running') return body.execution?.phase === 'authorized' ? 'authorized' : 'running';
    assert.ok(body.om.application);
    assert.notEqual(body.om.application, 'running');
    return body.om.application as 'received' | 'applied' | 'application-refused';
  }
  const call = writes.find(write => write.kind === 'call-record');
  if (call) return call.expected === 0 ? 'admitted' : 'settled';
  if (writes.some(write => write.kind === 'om-model-cycle')) return 'cycle';
  if (writes.some(write => write.kind === 'question-packet')) return 'continuation';
  if (writes.some(write => write.kind === 'om-read-delivery-set')) return 'deliveries';
  if (writes.some(write => write.kind === 'om-part-assembly')) return 'assembly';
  if (writes.every(write => write.kind === 'source')) return 'source';
  assert.fail(`Uncovered durable cycle transaction: ${writes.map(write => write.kind).join(', ')}`);
}
function e4CannotAnswer(f: ReturnType<typeof e4Fixture>) {
  return { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'cannot_answer',
    questionIds: [f.batch.items[0]!.gap], reason: 'The requested fact is unavailable in the named source' };
}

test('E4 restarts every durable cycle prefix with one physical send and one settlement for content and cannot_answer', async t => {
  for (const action of ['fact', 'cannot_answer'] as const) {
    const baseline = e4Fixture(t);
    baseline.steps([{ research: action === 'fact' ? e4Fact(baseline) : e4CannotAnswer(baseline), usage }]);
    const baselineWrite = baseline.store.writeMany.bind(baseline.store), actualPhases: CycleCommitPhase[] = [];
    baseline.store.writeMany = ((writes, guards) => {
      const committed = baselineWrite(writes, guards);
      if (writes.length) actualPhases.push(cycleCommitPhase(writes));
      return committed;
    }) as Store['writeMany'];
    valueOf(await runModelCycle(baseline.store, baseline.request)); baseline.store.writeMany = baselineWrite;
    assert.deepEqual(actualPhases, cycleCommitPhases, `${action}: enumerate every saving transaction`);
    // Authorization callback errors forbid stdin and are handled by runProcess; real owner loss
    // at the authorized boundary is exercised by the driver/provider recovery tests below.
    for (const stopAfter of cycleCommitPhases.filter(phase => phase !== 'authorized')) {
      await t.test(`${action}: durable ${stopAfter}`, async nested => {
        const f = e4Fixture(nested);
        f.steps([{ research: action === 'fact' ? e4Fact(f) : e4CannotAnswer(f), usage }]);
        const writeMany = f.store.writeMany.bind(f.store), phases: CycleCommitPhase[] = [];
        let stopped = false;
        f.store.writeMany = ((writes, guards) => {
          const committed = writeMany(writes, guards);
          if (writes.length) {
            const phase = cycleCommitPhase(writes); phases.push(phase);
            if (!stopped && phase === stopAfter) {
              stopped = true; throw new Error(`E4 simulated stop after durable ${stopAfter}`);
            }
          }
          return committed;
        }) as Store['writeMany'];
        try { await assert.rejects(runModelCycle(f.store, f.request), /E4 simulated stop after durable/); }
        finally { f.store.writeMany = writeMany; }
        assert.ok(stopped); assert.deepEqual(phases, cycleCommitPhases.slice(0, cycleCommitPhases.indexOf(stopAfter) + 1));
        const beforeResumeSends = f.sent().length;
        assert.equal(beforeResumeSends, ['admitted', 'running'].includes(stopAfter) ? 0 : 1);
        const receipt = f.store.list<OmModelCall>('model-call')[0];
        if (stopAfter === 'received') {
          assert.equal(receipt!.value.om.application, 'received');
          assert.deepEqual(receipt!.value.usage, usage);
          const state = valueOf(readModelCallState(f.store, { project: f.project, record: reference(receipt!) }));
          assert.equal(state.state, 'received');
          const pending = readModelCall(f.store, { project: f.project, record: reference(receipt!) });
          assert.equal(pending.ok, false, 'A receipt cannot masquerade as an empty product outcome');
          if (!pending.ok) assert.equal(pending.refusal.code, 'model_call_application_pending');
          assert.equal(f.store.list('om-model-cycle').length, 0);
          assert.equal(f.store.get<{attempts: {outcome: unknown}[]}>(f.series.id)!.value.attempts[0]!.outcome, null);
        }
        f.restart();
        const resumed = await runModelCycle(f.store, f.request);
        if (stopAfter === 'running') {
          assert.equal(resumed.ok, false, 'A dispatch claim without a receipt is uncertain and must not resend');
          if (!resumed.ok) assert.equal(resumed.refusal.code, 'model_call_in_progress');
          assert.equal(f.sent().length, 0); assert.equal(f.store.list('om-model-cycle').length, 0);
          assert.equal(f.store.list('om-model-exchange').length, 0);
          const snapshot = f.store.list(); f.restart();
          assert.deepEqual(await runModelCycle(f.store, f.request), resumed);
          assert.deepEqual(f.store.list(), snapshot); assert.equal(f.sent().length, 0);
          return;
        }
        const actual = valueOf(resumed);
        assert.equal(actual.record.value.terminal, 'outcome');
        assert.equal(actual.last.record.value.om.application, 'applied');
        assert.equal(actual.last.outcome?.kind, action === 'fact' ? 'fact-candidates' : 'no-result');
        assert.equal(f.sent().length, 1); assert.equal(f.store.list('om-model-exchange').length, 1);
        assert.equal(f.store.list('part-response').length, 1); assert.equal(f.store.list('accepted-answer').length, 0);
        const current = f.store.get<{attempts: {outcome: {reason: string} | null}[]; withoutProgress: number}>(f.series.id)!;
        if (action === 'fact') {
          assert.equal(current.value.attempts[0]!.outcome, null); assert.equal(current.revision, f.series.revision);
        } else {
          assert.equal(current.value.attempts[0]!.outcome?.reason, 'refused');
          assert.equal(current.revision, f.series.revision + 1); assert.equal(current.value.withoutProgress, 1);
          assert.ok(actual.last.diagnostic);
        }
        const call = f.store.list<{status: string; usage: typeof usage}>('call-record')[0]!;
        assert.equal(call.value.status, 'succeeded'); assert.deepEqual(call.value.usage, usage);
        assert.equal(f.store.history(call.id).length, 2, 'E1 stores one admission and one actual settlement');
        const ledger = f.store.list<{calls: {call: Ref; usage: typeof usage}[]}>('om-call-ledger')[0]!;
        assert.equal(ledger.value.calls.length, 1); assert.deepEqual(ledger.value.calls[0]!.usage, usage);
        assert.equal(f.store.history(ledger.id).length, 2);
        assert.equal(f.store.history(actual.last.record.id).length, 4);
        const snapshot = f.store.list(); f.restart();
        const repeated = valueOf(await runModelCycle(f.store, f.request));
        assert.equal(repeated.repeated, true);
        assert.deepEqual(repeated, valueOf(readModelCycle(f.store, { project: f.project, record: reference(actual.record) })));
        assert.deepEqual(f.store.list(), snapshot); assert.equal(f.sent().length, 1);
      });
    }
  }
});

test('E4 resumes saved source deliveries and continuation packets before content or cannot_answer without duplicate sources or sends', async t => {
  for (const action of ['fact', 'cannot_answer'] as const) for (const stopAfter of ['source', 'deliveries', 'continuation'] as const) {
    await t.test(`${action}: durable ${stopAfter}`, async nested => {
      const f = e4Fixture(nested);
      const read = { action: 'read', path: 'e4-source.txt', media: 'text/plain' };
      f.steps([{ research: e4NeedSource(f, [read]), usage },
        { research: action === 'fact' ? e4Fact(f) : e4CannotAnswer(f), usage }]);
      const writeMany = f.store.writeMany.bind(f.store); let stopped = false;
      f.store.writeMany = ((writes, guards) => {
        const committed = writeMany(writes, guards);
        if (!stopped && writes.length && cycleCommitPhase(writes) === stopAfter) {
          stopped = true; throw new Error(`E4 simulated stop after durable ${stopAfter}`);
        }
        return committed;
      }) as Store['writeMany'];
      try { await assert.rejects(runModelCycle(f.store, f.request), /E4 simulated stop after durable/); }
      finally { f.store.writeMany = writeMany; }
      assert.ok(stopped); assert.equal(f.sent().length, 1);
      const deliveries = f.store.list('om-read-delivery').map(reference);
      assert.equal(deliveries.length, stopAfter === 'source' ? 0 : 1); assert.equal(f.store.list('om-model-cycle').length, 0);
      const sources = f.store.list('source').map(reference);
      f.restart();
      const actual = valueOf(await runModelCycle(f.store, f.request));
      assert.equal(actual.record.value.terminal, 'outcome');
      assert.equal(actual.last.outcome?.kind, action === 'fact' ? 'fact-candidates' : 'no-result');
      assert.equal(f.sent().length, 2);
      assert.deepEqual(f.store.list('source').map(reference), sources, 'Resume reuses the already captured source');
      if (stopAfter !== 'source') assert.deepEqual(f.store.list('om-read-delivery').map(reference), deliveries);
      else assert.equal(f.store.list('om-read-delivery').length, 1);
      const calls = f.store.list<{usage: typeof usage; status: string}>('call-record');
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.equal(call.value.status, 'succeeded'); assert.deepEqual(call.value.usage, usage);
        assert.equal(f.store.history(call.id).length, 2);
      }
      const attempt = f.store.get<{attempts: {outcome: {reason: string} | null}[]}>(f.series.id)!;
      assert.equal(attempt.value.attempts[0]!.outcome?.reason ?? null, action === 'fact' ? null : 'refused');
      assert.equal(attempt.revision, f.series.revision + (action === 'fact' ? 0 : 1));
      const saved = f.store.list(); f.restart();
      assert.equal(valueOf(await runModelCycle(f.store, f.request)).repeated, true);
      assert.deepEqual(f.store.list(), saved); assert.equal(f.sent().length, 2);
    });
  }
});

test('E4 restarts a later node part after receipt or application and assembles or completes cannot_answer once', async t => {
  for (const action of ['node', 'cannot_answer'] as const) for (const stopAfter of ['received', 'applied', 'settled', 'assembly'] as const) {
    if (stopAfter === 'assembly' && action === 'cannot_answer') continue;
    await t.test(`${action}: later part ${stopAfter}`, async nested => {
      const f = e4Fixture(nested, 'node'), config = f.environment(f.packet.value.fullChars! - 1);
      const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
      assert.equal(packet.value.state, 'ready'); assert.equal(packet.value.plan!.mode, 'parts');
      const total = packet.value.plan!.assignments.length; assert.ok(total > 1);
      const answers = Array.from({ length: total }, (_, position) => e4Node(f, { ...packet,
        value: { ...packet.value, plan: { ...packet.value.plan!, position } } } as Revision<QuestionPacketRecord>));
      const control = { ...e4CannotAnswer(f), questionIds: f.batch.items
        .filter(item => packet.value.plan!.assignments[1]!.obligations.includes(item.target)).map(item => item.gap) };
      assert.ok(control.questionIds.length);
      f.steps(answers.map((answer, position) => ({ research: action === 'cannot_answer' && position === 1 ? control : answer, usage })));
      const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
      const writeMany = f.store.writeMany.bind(f.store); let stopped = false;
      f.store.writeMany = ((writes, guards) => {
        const committed = writeMany(writes, guards);
        if (!stopped && f.sent().length === (stopAfter === 'assembly' ? total : 2) && writes.length && cycleCommitPhase(writes) === stopAfter) {
          stopped = true; throw new Error(`E4 simulated stop after later part ${stopAfter}`);
        }
        return committed;
      }) as Store['writeMany'];
      try { await assert.rejects(runModelCycle(f.store, request), /E4 simulated stop after later part/); }
      finally { f.store.writeMany = writeMany; }
      assert.ok(stopped); assert.equal(f.sent().length, 2); assert.equal(f.store.list('om-model-cycle').length, 0);
      f.restart();
      const actual = valueOf(await runModelCycle(f.store, request));
      assert.equal(actual.record.value.terminal, action === 'node' ? 'assembled' : 'outcome');
      assert.equal(f.sent().length, action === 'node' ? total : 2);
      const attempt = f.store.get<{attempts: {outcome: {reason: string} | null}[]}>(f.series.id)!;
      assert.equal(attempt.value.attempts[0]!.outcome?.reason ?? null, action === 'node' ? null : 'refused');
      assert.equal(attempt.revision, f.series.revision + (action === 'node' ? 0 : 1));
      const calls = f.store.list<{usage: typeof usage; status: string}>('call-record');
      assert.equal(calls.length, action === 'node' ? total : 2);
      for (const call of calls) {
        assert.deepEqual(call.value.usage, usage); assert.equal(call.value.status, 'succeeded');
        assert.equal(f.store.history(call.id).length, 2);
      }
      if (action === 'node') {
        assert.ok(actual.assembly);
        assert.equal(valueOf(readPartAssembly(f.store, { project: f.project, record: actual.assembly })).record.value.results.length, total);
      } else {
        assert.equal(actual.assembly, null); assert.equal(actual.last.outcome?.kind, 'no-result');
        assert.equal(f.store.list('part-result').length, 1);
      }
      const saved = f.store.list(); f.restart();
      assert.equal(valueOf(await runModelCycle(f.store, request)).repeated, true);
      assert.deepEqual(f.store.list(), saved); assert.equal(f.sent().length, calls.length);
    });
  }
});

test('E4 receipt state requires an explicit application discriminator and preserves the original historical receipt', async t => {
  const f = e4Fixture(t); f.steps([{ research: e4Fact(f), usage }]);
  const writeMany = f.store.writeMany.bind(f.store); let stopped = false;
  f.store.writeMany = ((writes, guards) => {
    const committed = writeMany(writes, guards);
    if (!stopped && writes.some(write => write.kind === 'model-call'
      && (write.value as unknown as OmModelCall).om.application === 'received')) {
      stopped = true; throw new Error('E4 simulated stop after durable receipt');
    }
    return committed;
  }) as Store['writeMany'];
  try { await assert.rejects(runModelCall(f.store, f.request), /E4 simulated stop after durable receipt/); }
  finally { f.store.writeMany = writeMany; }
  const receipt = f.store.list<OmModelCall>('model-call')[0]!;
  assert.equal(valueOf(readModelCallState(f.store, { project: f.project, record: reference(receipt) })).state, 'received');
  for (const application of [undefined, 'terminal'] as const) {
    const body = structuredClone(receipt.value) as unknown as {om: Record<string, Json>};
    if (application === undefined) delete body.om.application;
    else body.om.application = application;
    const forged = f.store.write({ id: receipt.id, kind: receipt.kind, expected: f.store.get(receipt.id)!.revision,
      value: body as unknown as Json });
    const denied = readModelCallState(f.store, { project: f.project, record: reference(forged) });
    assert.equal(denied.ok, false);
    if (!denied.ok) { assert.equal(denied.refusal.code, 'model_call_record_invalid'); assert.equal(denied.refusal.at.field, 'application'); }
  }
  f.restart();
  assert.equal(valueOf(readModelCallState(f.store, { project: f.project, record: reference(receipt) })).state, 'received');
  assert.equal(f.sent().length, 1); assert.equal(f.store.list('om-model-exchange').length, 1);
});

import { spawn, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as fixtureDelay } from 'node:timers/promises';
import { processStart } from '../src/runtime/process-identity.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { prepareLateModelReceipt, readModelCallRecovery } from '../src/discovery/model-call-recovery.js';

type FixtureCheckpoint = { pid: number; parent: number; writes?: Write[] };
type DriverCheckpoint = { path: string; kind: string; matches: { path: string[]; value: Json }[]; when?: 'before' };
function fixtureDriver(t: TestContext, database: string, root: string, operation: 'call' | 'transport',
  request: ModelCallRequest | ModelTransportRequest, checkpoint?: DriverCheckpoint) {
  const spec = join(root, 'driver.json'), output = join(root, 'driver-output.json');
  writeFileSync(spec, JSON.stringify({ database, output, operation, request, ...(checkpoint ? { checkpoint } : {}) }));
  const child = spawn(process.execPath, [fixturePath, '--driver', spec], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr!.on('data', data => { stderr += data.toString(); }); child.stdout!.resume();
  const exit = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
  });
  return { child, exit, output, errors: () => stderr };
}
async function fixtureCheckpoint(path: string, child: ChildProcess): Promise<FixtureCheckpoint> {
  if (!existsSync(path)) await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(deadline); watcher.close(); child.off('exit', ended); };
    const ended = () => { stop(); reject(new Error(`Fixture driver exited before checkpoint ${path}`)); };
    const watcher = watch(dirname(path), () => { if (existsSync(path)) { stop(); resolve(); } });
    const deadline = setTimeout(() => { stop(); reject(new Error(`Fixture checkpoint was not reached: ${path}`)); }, 20_000);
    child.once('exit', ended);
    if (existsSync(path)) { stop(); resolve(); }
  });
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureCheckpoint;
}
async function killFixtureDriver(driver: ReturnType<typeof fixtureDriver>) {
  assert.equal(driver.child.exitCode, null); assert.equal(driver.child.signalCode, null);
  assert.equal(driver.child.kill('SIGKILL'), true); await driver.exit;
}
function signalFixtureProvider(pid: number, started: string): boolean {
  // EOF after owner loss may let the supplier exit before cleanup reaches it.
  // A gone/reused PID is never signalled; ESRCH also means it exited in this window.
  if (processStart(pid) !== started) return false;
  try { process.kill(pid, 'SIGKILL'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function killFixtureProvider(pid: number, started: string) {
  if (!signalFixtureProvider(pid, started)) return;
  const deadline = Date.now() + 10_000;
  while (processStart(pid) === started) {
    assert.ok(Date.now() < deadline, 'The killed fixture provider must terminate');
    await fixtureDelay(10);
  }
}
function publicRecovery(store: Store, project: string, record: Ref): Revision<ModelCall> {
  return new ProductEngine(store).execute({ type: 'recover-model-call', project, call: record }) as Revision<ModelCall>;
}
function refusesLiveRecovery(store: Store, project: string, record: Ref) {
  assert.throws(() => publicRecovery(store, project, record),
    (error: unknown) => error instanceof EngineError && error.code === 'model_call_still_running');
}
function ensureFixtureProject(store: Store, project: string) {
  if (!store.get(`project:${project}`)) store.write({ id: `project:${project}`, kind: 'project', expected: 0,
    value: { id: project, title: 'Local physical recovery fixture' } });
}

test('E4 public recovery closes a truly lost pre-spawn owner for products and analysis without sending or inventing usage', async t => {
  for (const purpose of ['fact', 'node', 'stop-analysis', 'origin-analysis'] as const) await t.test(purpose, async nested => {
    const product = purpose === 'fact' || purpose === 'node';
    const f = product ? e4Fixture(nested, purpose, 100_000, 0, 30_000) : e4AnalysisFixture(nested, purpose, 30_000);
    ensureFixtureProject(f.store, f.project);
    const checkpoint = join(f.root, 'claimed.json');
    const research = product ? (purpose === 'fact' ? e4Fact(f as ReturnType<typeof e4Fixture>) : e4Node(f as ReturnType<typeof e4Fixture>))
      : { cause: 'Unsent local analysis', hypothesis: true };
    writeFileSync(f.scenario, JSON.stringify({ steps: [{ research, usage }] }));
    const originalSeries = reference(f.store.get(f.series.id)!);
    const driver = fixtureDriver(nested, f.database, f.root, product ? 'call' : 'transport', f.request,
      { path: checkpoint, kind: 'model-call', matches: [{ path: ['execution', 'phase'], value: 'claimed' }] });
    const paused = await fixtureCheckpoint(checkpoint, driver.child);
    assert.equal(paused.pid, driver.child.pid); assert.equal(f.sent().length, 0);
    const claimed = f.store.list<ModelCall>('model-call')[0]!;
    assert.equal(claimed.value.execution?.owner.pid, paused.pid); assert.equal(claimed.value.execution?.provider, null);
    const unchanged = f.store.list(); refusesLiveRecovery(f.store, f.project, reference(claimed));
    assert.deepEqual(f.store.list(), unchanged);
    let completed: Revision<unknown> | null = null;
    if (purpose === 'fact') {
      const other = new Store(f.database);
      try { completed = valueOf(completeAttempt(other, { ...seriesRequestOf(f.series.value), attempt: 1,
        outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } })); }
      finally { other.close(); }
    }
    await killFixtureDriver(driver);
    const recovered = publicRecovery(f.store, f.project, reference(claimed));
    assert.equal(recovered.value.status, 'failed'); assert.equal(recovered.value.error, 'process_lost');
    const proof = readModelCallRecovery(f.store, f.project, reference(recovered));
    assert.equal(proof.proof!.request, 'not-authorized'); assert.equal(proof.proof!.physical, 'unknown');
    assert.equal(recovered.value.usage, null); assert.equal(recovered.value.response, null);
    const call = f.store.list<{status: string;usage: unknown}>('call-record')[0]!;
    assert.equal(call.value.status, 'open'); assert.equal(call.value.usage, null); assert.equal(f.store.history(call.id).length, 1);
    assert.equal(f.store.list('om-model-exchange').length, 0); assert.equal(f.store.list('part-response').length, 0);
    if (product) {
      assert.equal((recovered.value as OmModelCall).om.application, 'recovered');
      const series = f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!;
      assert.equal(series.value.attempts[0]!.outcome?.reason, 'interrupted'); assert.equal(series.revision, originalSeries.revision + 1);
      if (completed) {
        assert.deepEqual(series, completed);
        assert.deepEqual((recovered.value as OmModelCall).om.completion, reference(completed));
        assert.equal((recovered.value as OmModelCall).om.diagnostic, null);
      }
      const expected = valueOf(readModelCall(f.store, { project: f.project, record: reference(recovered) }));
      const snapshot = f.store.list(); f.restart();
      assert.deepEqual(valueOf(await runModelCall(f.store, f.request as ModelCallRequest)), expected);
      assert.deepEqual(f.store.list(), snapshot);
    } else {
      assert.deepEqual(reference(f.store.get(f.series.id)!), originalSeries);
      const expected = valueOf(readModelTransport(f.store, { project: f.project, record: reference(recovered) }));
      assert.equal(expected.result.kind, 'interrupted');
      const snapshot = f.store.list(); f.restart();
      assert.deepEqual(valueOf(await runModelTransport(f.store, f.request as ModelTransportRequest)), expected);
      assert.deepEqual(f.store.list(), snapshot);
    }
    assert.equal(f.sent().length, 0);
  });
});

test('E4 actual owner and provider loss recover both product calls and analysis purposes through the public command', async t => {
  for (const purpose of ['fact', 'node', 'stop-analysis', 'origin-analysis'] as const) await t.test(purpose, async nested => {
    const product = purpose === 'fact' || purpose === 'node';
    const f = product ? e4Fixture(nested, purpose, 100_000, 0, 30_000) : e4AnalysisFixture(nested, purpose, 30_000);
    ensureFixtureProject(f.store, f.project);
    const checkpoint = join(f.root, 'provider.json');
    const research = product ? (purpose === 'fact' ? e4Fact(f as ReturnType<typeof e4Fixture>) : e4Node(f as ReturnType<typeof e4Fixture>))
      : { cause: 'Local analysis evidence', hypothesis: true };
    writeFileSync(f.scenario, JSON.stringify({ steps: [{ research, usage, pauseAfterRequest: checkpoint }] }));
    const originalSeries = reference(f.store.get(f.series.id)!);
    const driver = fixtureDriver(nested, f.database, f.root, product ? 'call' : 'transport', f.request);
    const supplier = await fixtureCheckpoint(checkpoint, driver.child);
    assert.equal(supplier.parent, driver.child.pid); assert.equal(f.sent().length, 1);
    const running = f.store.list<ModelCall>('model-call')[0]!, provider = running.value.execution!.provider!;
    assert.equal(running.value.execution!.phase, 'authorized'); assert.equal(provider.pid, supplier.pid);
    nested.after(() => {
      signalFixtureProvider(provider.pid, provider.started);
    });
    const before = f.store.list(); refusesLiveRecovery(f.store, f.project, reference(running)); assert.deepEqual(f.store.list(), before);
    await killFixtureDriver(driver);
    refusesLiveRecovery(f.store, f.project, reference(running)); assert.deepEqual(f.store.list(), before);
    await killFixtureProvider(provider.pid, provider.started);
    const recovered = publicRecovery(f.store, f.project, reference(running));
    assert.equal(recovered.value.status, 'failed'); assert.equal(recovered.value.error, 'process_lost');
    assert.equal(recovered.value.usage, null); assert.equal(recovered.value.response, null);
    const proof = readModelCallRecovery(f.store, f.project, reference(recovered));
    assert.equal(proof.proof!.request, 'unknown'); assert.equal(proof.proof!.physical, 'group-terminated');
    const admitted = f.store.list<{status: string;usage: unknown}>('call-record')[0]!;
    assert.equal(admitted.value.status, 'open'); assert.equal(admitted.value.usage, null); assert.equal(f.store.history(admitted.id).length, 1);
    assert.equal(f.store.list('om-model-exchange').length, 0);
    if (product) {
      assert.equal((recovered.value as OmModelCall).om.application, 'recovered');
      const series = f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!;
      assert.equal(series.value.attempts[0]!.outcome?.reason, 'interrupted'); assert.equal(series.revision, originalSeries.revision + 1);
      const expected = valueOf(readModelCall(f.store, { project: f.project, record: reference(recovered) }));
      const snapshot = f.store.list(); f.restart();
      assert.deepEqual(valueOf(await runModelCall(f.store, f.request as ModelCallRequest)), expected);
      assert.deepEqual(f.store.list(), snapshot);
    } else {
      assert.deepEqual(reference(f.store.get(f.series.id)!), originalSeries, 'Recovery must not resolve an analysis ground or invent A6 results');
      const expected = valueOf(readModelTransport(f.store, { project: f.project, record: reference(recovered) }));
      assert.equal(expected.result.kind, 'interrupted');
      const snapshot = f.store.list(); f.restart();
      assert.deepEqual(valueOf(await runModelTransport(f.store, f.request as ModelTransportRequest)), expected);
      assert.deepEqual(f.store.list(), snapshot);
    }
    assert.equal(f.sent().length, 1); assert.equal(f.store.list('model-call-recovery').length, 1);
  });
});

test('E4 competing public recoveries commit one terminal product transition and one A3 outcome', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 30_000), checkpoint = join(f.root, 'claimed-race.json');
  f.steps([{ research: e4Fact(f), usage }]);
  const driver = fixtureDriver(t, f.database, f.root, 'call', f.request,
    { path: checkpoint, kind: 'model-call', matches: [{ path: ['execution', 'phase'], value: 'claimed' }] });
  await fixtureCheckpoint(checkpoint, driver.child); await killFixtureDriver(driver);
  const running = f.store.list<ModelCall>('model-call')[0]!, writeMany = f.store.writeMany.bind(f.store);
  let winner: Revision<ModelCall> | null = null;
  f.store.writeMany = ((writes, guards) => {
    if (!winner && writes.some(write => write.kind === 'model-call-recovery')) {
      const other = new Store(f.database);
      try { winner = publicRecovery(other, f.project, reference(running)); }
      finally { other.close(); }
    }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  try {
    assert.throws(() => publicRecovery(f.store, f.project, reference(running)),
      (error: unknown) => error instanceof EngineError && ['input_stale', 'revision_conflict', 'model_call_foreign'].includes(error.code));
  } finally { f.store.writeMany = writeMany; }
  assert.ok(winner); assert.deepEqual(f.store.get(running.id), winner);
  assert.equal(f.store.list('model-call-recovery').length, 1); assert.equal(f.sent().length, 0);
  const series = f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!;
  assert.equal(series.value.attempts[0]!.outcome?.reason, 'interrupted'); assert.equal(series.revision, f.series.revision + 1);
  const historical = valueOf(readModelCall(f.store, { project: f.project, record: reference(f.store.get(running.id)!) }));
  const saved = f.store.list(); f.restart();
  assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), historical);
  assert.deepEqual(f.store.list(), saved);
});

test('E4 retains actual late transport evidence after lost-owner recovery and accounts it once for product and analysis', async t => {
  for (const purpose of ['fact', 'stop-analysis'] as const) await t.test(purpose, async nested => {
    const product = purpose === 'fact';
    const f = product ? e4Fixture(nested, 'fact', 100_000, 0, 30_000) : e4AnalysisFixture(nested, 'stop-analysis', 30_000);
    ensureFixtureProject(f.store, f.project);
    const checkpoint = join(f.root, 'late-receipt.json');
    const research = product ? e4Fact(f as ReturnType<typeof e4Fixture>) : { cause: 'Received local analysis evidence', hypothesis: true };
    writeFileSync(f.scenario, JSON.stringify({ steps: [{ research, usage }] }));
    const driver = fixtureDriver(nested, f.database, f.root, product ? 'call' : 'transport', f.request,
      { path: checkpoint, kind: 'om-model-exchange', matches: [], when: 'before' });
    const pending = await fixtureCheckpoint(checkpoint, driver.child);
    assert.equal(pending.pid, driver.child.pid); assert.equal(f.sent().length, 1);
    const exchange = pending.writes!.find(write => write.kind === 'om-model-exchange')!.value as unknown as {
      process: ProcessResult; launchError: null;
    };
    const evidence = { process: exchange.process, launchError: exchange.launchError };
    assert.equal(evidence.process.exitCode, 0); assert.deepEqual(JSON.parse(evidence.process.stdout).usage, usage);
    assert.equal(f.store.list('om-model-exchange').length, 0, 'The physical response is received but its commit was not reached');
    const dispatch = f.store.list<ModelCall>('model-call')[0]!;
    assert.equal(dispatch.value.execution?.phase, 'authorized');
    await killFixtureDriver(driver);
    const recovered = publicRecovery(f.store, f.project, reference(dispatch));
    const series = reference(f.store.get(f.series.id)!);
    const admitted = f.store.list<{status:string;usage:unknown}>('call-record')[0]!;
    assert.equal(admitted.value.status, 'open'); assert.equal(admitted.value.usage, null);
    const late = prepareLateModelReceipt(f.store, f.project, reference(dispatch), evidence);
    valueOf(writeGuarded(f.store, { unit: 'E4', target: dispatch.id, writes: late.writes, guards: late.guards }));
    assert.deepEqual(late.record.value.evidence.process, evidence.process);
    assert.deepEqual(late.record.value.recovered, reference(recovered));
    assert.equal(f.store.list('model-late-receipt').length, 1);
    assert.deepEqual(reference(f.store.get(f.series.id)!), series); assert.deepEqual(f.store.get(recovered.id), recovered);
    assert.deepEqual(prepareLateModelReceipt(f.store, f.project, reference(dispatch), evidence).writes, []);
    f.restart();
    if (product) valueOf(await runModelCall(f.store, f.request as ModelCallRequest));
    else valueOf(await runModelTransport(f.store, f.request as ModelTransportRequest));
    const settled = f.store.get<{status:string;usage:unknown}>(admitted.id)!;
    assert.equal(settled.value.status, 'failed'); assert.deepEqual(settled.value.usage, usage);
    assert.equal(f.store.history(admitted.id).length, 2);
    assert.deepEqual(f.store.get(recovered.id), recovered); assert.deepEqual(reference(f.store.get(f.series.id)!), series);
    const saved = f.store.list(); f.restart();
    assert.deepEqual(prepareLateModelReceipt(f.store, f.project, reference(dispatch), evidence).record, late.record);
    if (product) valueOf(await runModelCall(f.store, f.request as ModelCallRequest));
    else valueOf(await runModelTransport(f.store, f.request as ModelTransportRequest));
    assert.deepEqual(f.store.list(), saved); assert.equal(f.sent().length, 1);
  });
});

test('E4 records real local supplier death while its owner survives as one interrupted MC2 attempt', async t => {
  const f = e4Fixture(t, 'node', 100_000, 0, 30_000), checkpoint = join(f.root, 'child-only.json');
  f.steps([{ research: e4Node(f), usage, pauseAfterRequest: checkpoint }]);
  const driver = fixtureDriver(t, f.database, f.root, 'call', f.request);
  const paused = await fixtureCheckpoint(checkpoint, driver.child);
  assert.equal(paused.parent, driver.child.pid);
  const running = f.store.list<ModelCall>('model-call')[0]!, provider = running.value.execution!.provider!;
  assert.equal(provider.pid, paused.pid);
  t.after(() => { signalFixtureProvider(provider.pid, provider.started); });
  await killFixtureProvider(provider.pid, provider.started); await driver.exit;
  assert.equal(driver.child.exitCode, 0, driver.errors());
  const recovered = f.store.get<OmModelCall>(running.id)!;
  assert.equal(recovered.value.om.application, 'applied'); assert.equal(recovered.value.status, 'failed');
  assert.equal(recovered.value.usage, null); assert.equal(f.store.list('om-model-exchange').length, 1);
  const series = f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!;
  assert.equal(series.value.attempts[0]!.outcome?.reason, 'interrupted'); assert.equal(series.revision, f.series.revision + 1);
  const call = f.store.list<{status:string;usage:unknown}>('call-record')[0]!;
  assert.equal(call.value.status, 'open'); assert.equal(call.value.usage, null);
  const expected = valueOf(readModelCall(f.store, { project: f.project, record: reference(recovered) }));
  const saved = f.store.list(); f.restart();
  assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), expected);
  assert.deepEqual(f.store.list(), saved); assert.equal(f.sent().length, 1);
});

test('E4 owner loss after authorization but before stdin preserves unknown delivery for product and analysis', async t => {
  for (const purpose of ['fact', 'stop-analysis'] as const) await t.test(purpose, async nested => {
    const product = purpose === 'fact';
    const f = product ? e4Fixture(nested, 'fact', 100_000, 0, 30_000) : e4AnalysisFixture(nested, 'stop-analysis', 30_000);
    ensureFixtureProject(f.store, f.project);
    const checkpoint = join(f.root, 'authorized.json');
    const research = product ? e4Fact(f as ReturnType<typeof e4Fixture>) : { cause: 'No request yet transferred', hypothesis: true };
    writeFileSync(f.scenario, JSON.stringify({ steps: [{ research, usage }] }));
    const driver = fixtureDriver(nested, f.database, f.root, product ? 'call' : 'transport', f.request,
      { path: checkpoint, kind: 'model-call', matches: [{ path: ['execution', 'phase'], value: 'authorized' }] });
    const paused = await fixtureCheckpoint(checkpoint, driver.child); assert.equal(paused.pid, driver.child.pid);
    const dispatch = f.store.list<ModelCall>('model-call')[0]!, provider = dispatch.value.execution!.provider!;
    nested.after(() => { signalFixtureProvider(provider.pid, provider.started); });
    assert.equal(f.sent().length, 0, 'Authorization alone is not evidence that stdin was transferred');
    refusesLiveRecovery(f.store, f.project, reference(dispatch));
    await killFixtureDriver(driver);
    if (processStart(provider.pid) === provider.started) await killFixtureProvider(provider.pid, provider.started);
    const recovered = publicRecovery(f.store, f.project, reference(dispatch));
    const proof = readModelCallRecovery(f.store, f.project, reference(recovered));
    assert.equal(proof.proof!.request, 'unknown'); assert.equal(proof.proof!.physical, 'group-terminated');
    assert.equal(recovered.value.usage, null); assert.equal(recovered.value.response, null); assert.equal(f.sent().length, 0);
    const saved = f.store.list(); f.restart();
    if (product) valueOf(await runModelCall(f.store, f.request as ModelCallRequest));
    else valueOf(await runModelTransport(f.store, f.request as ModelTransportRequest));
    assert.deepEqual(f.store.list(), saved); assert.equal(f.sent().length, 0);
  });
});

test('E4 owner loss after spawn but before authorization proves no request transfer without claiming supplier termination', async t => {
  for (const purpose of ['fact', 'stop-analysis'] as const) await t.test(purpose, async nested => {
    const product = purpose === 'fact';
    const f = product ? e4Fixture(nested, 'fact', 100_000, 0, 30_000) : e4AnalysisFixture(nested, 'stop-analysis', 30_000);
    ensureFixtureProject(f.store, f.project);
    const checkpoint = join(f.root, 'spawned-uncommitted.json');
    const research = product ? e4Fact(f as ReturnType<typeof e4Fixture>) : { cause: 'Authorization not committed', hypothesis: true };
    writeFileSync(f.scenario, JSON.stringify({ steps: [{ research, usage }] }));
    const driver = fixtureDriver(nested, f.database, f.root, product ? 'call' : 'transport', f.request,
      { path: checkpoint, kind: 'model-call', matches: [{ path: ['execution', 'phase'], value: 'authorized' }], when: 'before' });
    const paused = await fixtureCheckpoint(checkpoint, driver.child); assert.equal(paused.pid, driver.child.pid);
    const pending = paused.writes!.find(write => write.kind === 'model-call')!.value as unknown as ModelCall;
    const provider = pending.execution!.provider!;
    assert.notEqual(provider.pid, paused.pid); assert.equal(processStart(provider.pid), provider.started, 'The supplier really was spawned');
    nested.after(() => { signalFixtureProvider(provider.pid, provider.started); });
    const claimed = f.store.list<ModelCall>('model-call')[0]!;
    assert.equal(claimed.value.execution!.phase, 'claimed'); assert.equal(claimed.value.execution!.provider, null);
    assert.equal(claimed.value.providerProcess, undefined); assert.equal(f.sent().length, 0);
    refusesLiveRecovery(f.store, f.project, reference(claimed));
    await killFixtureDriver(driver);
    const recovered = publicRecovery(f.store, f.project, reference(claimed));
    const proof = readModelCallRecovery(f.store, f.project, reference(recovered));
    assert.equal(proof.proof!.request, 'not-authorized'); assert.equal(proof.proof!.provider, 'not-authorized');
    assert.equal(proof.proof!.physical, 'unknown', 'An authorization-free state proves no transfer, not absence of a spawned supplier');
    assert.equal(f.sent().length, 0); assert.equal(recovered.value.usage, null);
    if (processStart(provider.pid) === provider.started) await killFixtureProvider(provider.pid, provider.started);
    const saved = f.store.list(); f.restart();
    if (product) valueOf(await runModelCall(f.store, f.request as ModelCallRequest));
    else valueOf(await runModelTransport(f.store, f.request as ModelTransportRequest));
    assert.deepEqual(f.store.list(), saved); assert.equal(f.sent().length, 0);
  });
});


test('E4 failed dispatch authorization preserves a terminal physical outcome without transmitting for both transports', async t => {
  for (const purpose of ['fact', 'stop-analysis'] as const) await t.test(purpose, async nested => {
    const product = purpose === 'fact';
    const f = product ? e4Fixture(nested) : e4AnalysisFixture(nested, 'stop-analysis');
    const writeMany = f.store.writeMany.bind(f.store);
    f.store.writeMany = ((writes, guards) => {
      if (writes.some(write => write.kind === 'model-call'
        && (write.value as unknown as ModelCall).execution?.phase === 'authorized'))
        throw new EngineError('model_call_identity_missing', 'Fixture: provider identity could not be persisted');
      return writeMany(writes, guards);
    }) as Store['writeMany'];
    const result = product ? await runModelCall(f.store, f.request as ModelCallRequest)
      : await runModelTransport(f.store, f.request as ModelTransportRequest);
    f.store.writeMany = writeMany;
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const finished = result.value;
    assert.equal(finished.record.value.status, 'failed');
    assert.equal(finished.record.value.error, 'model_call_identity_missing');
    assert.equal(finished.record.value.execution?.phase, 'claimed');
    assert.equal(finished.record.value.usage, null); assert.equal(f.sent().length, 0);
    assert.equal(f.store.list('om-model-exchange').length, 1);
    if (product) {
      assert.equal((finished.record.value as OmModelCall).om.application, 'applied');
      assert.equal(f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!.value.attempts[0]!.outcome?.reason, 'interrupted');
    }
    const snapshot = f.store.list(); f.restart();
    if (product) valueOf(await runModelCall(f.store, f.request as ModelCallRequest));
    else valueOf(await runModelTransport(f.store, f.request as ModelTransportRequest));
    assert.deepEqual(f.store.list(), snapshot); assert.equal(f.sent().length, 0);
  });
});

test('E4 cycle replay accounts a late receipt once before or after the cycle is saved without changing product history', async t => {
  for (const kind of ['fact', 'node'] as const) for (const timing of ['before-cycle', 'after-cycle'] as const) {
    const replayPaths = kind === 'fact' && timing === 'after-cycle' ? ['cycle', 'public-recovery'] as const : ['cycle'] as const;
    for (const replayPath of replayPaths) await t.test(`${kind}: ${timing} via ${replayPath}`, async nested => {
      const f = e4Fixture(nested, kind, 100_000, 0, 30_000), checkpoint = join(f.root, 'late-cycle.json');
      f.steps([{ research: kind === 'fact' ? e4Fact(f) : e4Node(f), usage }]);
      const driver = fixtureDriver(nested, f.database, f.root, 'call', f.request,
        { path: checkpoint, kind: 'om-model-exchange', matches: [], when: 'before' });
      const pending = await fixtureCheckpoint(checkpoint, driver.child);
      assert.equal(pending.pid, driver.child.pid); assert.equal(f.sent().length, 1);
      const exchange = pending.writes!.find(write => write.kind === 'om-model-exchange')!.value as unknown as {
        process: ProcessResult; launchError: null;
      };
      const evidence = { process: exchange.process, launchError: exchange.launchError };
      assert.equal(evidence.process.exitCode, 0); assert.deepEqual(JSON.parse(evidence.process.stdout).usage, usage);
      const dispatch = f.store.list<ModelCall>('model-call')[0]!;
      await killFixtureDriver(driver);
      const recovered = publicRecovery(f.store, f.project, reference(dispatch));
      const completed = f.store.get(f.series.id)!, admitted = f.store.list<{status: string; usage: unknown}>('call-record')[0]!;
      assert.equal(admitted.value.status, 'open'); assert.equal(admitted.value.usage, null);
      assert.equal(f.store.list('om-model-exchange').length, 0);
      const priorCycle = timing === 'after-cycle' ? valueOf(await runModelCycle(f.store, f.request)).record : null;
      if (priorCycle) {
        assert.equal(priorCycle.value.terminal, 'outcome');
        assert.equal(f.store.get<{status: string}>(admitted.id)!.value.status, 'open');
      } else assert.equal(f.store.list('om-model-cycle').length, 0);
      const late = prepareLateModelReceipt(f.store, f.project, reference(dispatch), evidence);
      const writeMany = f.store.writeMany.bind(f.store); let stopped = false;
      f.store.writeMany = ((writes, guards) => {
        const committed = writeMany(writes, guards);
        if (!stopped && writes.some(write => write.kind === 'model-late-receipt')) {
          stopped = true; throw new Error('E4 simulated stop after durable late receipt before settlement');
        }
        return committed;
      }) as Store['writeMany'];
      try {
        assert.throws(() => writeGuarded(f.store, { unit: 'E4', target: dispatch.id, writes: late.writes, guards: late.guards }),
          /E4 simulated stop after durable late receipt before settlement/);
      } finally { f.store.writeMany = writeMany; }
      assert.ok(stopped); assert.equal(f.store.list('model-late-receipt').length, 1);
      assert.equal(f.store.get<{status: string}>(admitted.id)!.value.status, 'open');
      f.restart();
      if (priorCycle) {
        const beforeRead = f.store.list();
        const historical = valueOf(readModelCycle(f.store, { project: f.project, record: reference(priorCycle) }));
        assert.equal(historical.last.record.value.om.application, 'recovered');
        assert.deepEqual(f.store.list(), beforeRead, 'Historical reading cannot perform settlement');
        assert.equal(f.store.get<{status: string}>(admitted.id)!.value.status, 'open');
      }
      if (replayPath === 'public-recovery') {
        assert.deepEqual(publicRecovery(f.store, f.project, reference(recovered)), recovered);
        const accounted = f.store.get<{status: string; usage: unknown}>(admitted.id)!;
        assert.equal(accounted.value.status, 'failed'); assert.deepEqual(accounted.value.usage, usage);
      }
      const cycle = valueOf(await runModelCycle(f.store, f.request));
      assert.equal(cycle.record.value.terminal, 'outcome');
      assert.equal(cycle.last.record.value.om.application, 'recovered');
      if (priorCycle) assert.deepEqual(cycle.record, priorCycle, 'Late accounting must not replace the saved cycle');
      const settled = f.store.get<{status: string;usage: unknown}>(admitted.id)!;
      assert.equal(settled.value.status, 'failed'); assert.deepEqual(settled.value.usage, usage);
      assert.equal(f.store.history(admitted.id).length, 2, 'One original admission and one settlement');
      const ledger = f.store.list<{calls: {call: Ref; usage: unknown}[]}>('om-call-ledger')[0]!;
      assert.equal(ledger.value.calls.length, 1); assert.deepEqual(ledger.value.calls[0]!.usage, usage);
      assert.equal(f.store.history(ledger.id).length, 2);
      assert.deepEqual(f.store.get(recovered.id), recovered); assert.deepEqual(f.store.get(f.series.id), completed);
      assert.equal(f.store.history(cycle.record.id).length, 1); assert.equal(f.sent().length, 1);
      assert.deepEqual(f.store.get(late.record.id), late.record);
      const afterSettlement = f.store.list();
      assert.deepEqual(valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) })).record, cycle.record);
      assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), cycle.last, 'Direct and cycle replay expose the same recovered result');
      assert.deepEqual(publicRecovery(f.store, f.project, reference(recovered)), recovered);
      assert.deepEqual(f.store.list(), afterSettlement);
      f.restart();
      const repeated = valueOf(await runModelCycle(f.store, f.request));
      assert.equal(repeated.repeated, true); assert.deepEqual(repeated.record, cycle.record);
      assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), repeated.last);
      assert.deepEqual(f.store.list(), afterSettlement); assert.equal(f.sent().length, 1);
    });
  }
});


test('3 H1.0a managed opening fixes the complete root before E1 and MC1 reveals unpaid fact children without closing A3', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 1000, true);
  const binding = valueOf(readCompletionBinding(f.store, f.project, reference(f.series), 1));
  assert.ok(binding);
  const id = completionWorkId(f.project, binding.id);
  const initial = valueOf(readCompletionWorkAt(f.store, f.project, reference(f.store.get(id)!)));
  assert.equal(initial.work.revision, 2);
  assert.equal(initial.products.length, 1);
  assert.equal(f.store.get(initial.products[0]!.id)!.kind, 'om-completion-packet');
  assert.equal(initial.assignments.length, 1);
  assert.equal(initial.complete, false);
  await t.test('7 unpaid root is present and incomplete before E1',()=>{
    assert.equal(f.store.list('om-call').length,0);assert.equal(initial.complete,false);
  });
  f.steps([{ research: e4Fact(f), usage }]);
  const called = valueOf(await runModelCall(f.store, f.request));
  await t.test('6 ordinary entry selects managed ownership from its exact sources',()=>{
    assert.equal(called.record.value.om.version,'om-model-call/managed-v1');
    assert.ok(called.record.value.om.completionOwner);
  });
  assert.equal(called.outcome?.kind, 'fact-candidates');
  const work = valueOf(readCompletionWorkAt(f.store, f.project, reference(f.store.get(id)!)));
  assert.equal(work.complete, false);
  await t.test('17 all response facts are registered before any assessor intent or E1',()=>{
    assert.equal(work.assignments.filter(row=>row.value.kind==='fact').length,1);
    assert.equal(f.store.list('om-assessment-intent').length,0);
    assert.equal(work.complete,false);
  });
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  f.restart();
  assert.equal(valueOf(readModelCall(f.store, { project: f.project, record: reference(called.record) })).outcome?.kind, 'fact-candidates');
  assert.equal(valueOf(await runModelCall(f.store, f.request)).repeated, true);
  assert.equal(f.sent().length, 1);
});

test('13 H1.0a local off-form stays open until G7; the exact complete close survives a new Store', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 1000, true);
  f.steps([{ research: { nonsense: true }, usage }]);
  const called = valueOf(await runModelCall(f.store, f.request));
  assert.equal(called.record.value.om.failure?.code, 'part_answer_invalid');
  assert.ok(called.diagnostic);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  const binding = valueOf(readCompletionBinding(f.store, f.project, reference(f.series), 1))!;
  const work = valueOf(readCompletionWorkAt(f.store, f.project, reference(f.store.get(completionWorkId(f.project, binding.id))!)));
  assert.equal(work.complete, true);
  const claim = { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'off-form' as const, accepting: [], cancelling: [], refusals: work.refusals } };
  const closed = valueOf(closeAttempt(f.store, claim));
  assert.equal(closed.attempt, 1);
  const saved = f.store.get(f.series.id)!;
  f.restart();
  assert.equal(valueOf(readSeries(f.store, seriesRequestOf(f.series.value))).value.attempts[0]!.outcome?.reason, 'off-form');
  await t.test('30 exact close replays from its saved proof without another series revision',()=>{
    valueOf(closeAttempt(f.store,claim));assert.deepEqual(f.store.get(f.series.id),saved);
  });
  assert.equal(valueOf(await runModelCall(f.store, f.request)).repeated, true);
  assert.equal(f.sent().length, 1);
});

test('26 H1.0a raw A3 and empty G7 cannot close an unpaid managed root', t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 1000, true);
  const request = { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'off-form' as const, achieved: [], cancelled: [], refusals: [] } };
  const raw = completeAttempt(f.store, request as never);
  assert.equal(raw.ok, false);
  if (!raw.ok) assert.equal(raw.refusal.code, 'completion_required');
  const gate = closeAttempt(f.store, { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'off-form', accepting: [], cancelling: [], refusals: [] } });
  assert.equal(gate.ok, false);
  assert.equal(f.store.get(f.series.id)!.revision, f.series.revision);
});

function completionSnapshot(f: ReturnType<typeof e4Fixture>) {
  const binding = valueOf(readCompletionBinding(f.store, f.project, reference(f.series), f.packetRequest.attempt!.ordinal))!;
  return valueOf(readCompletionWorkAt(f.store, f.project, reference(f.store.get(completionWorkId(f.project, binding.id))!)));
}

test('32 H1.0a cycle cursor recovery after G7 uses only the exact closed products', async t => {
  const { prepareCompletionProducts } = await import('../src/om/model-call.js');
  for (const mode of ['off-form', 'interrupted', 'cannot-answer', 'assembly', 'parts-and-continuation'] as const) {
    await t.test(mode, async child => {
      const node = mode === 'assembly' || mode === 'parts-and-continuation';
      const f = e4Fixture(child, node ? 'node' : 'fact', 100_000, 0, 5000, true);
      let request = f.request;
      if (node) {
        const split = mode === 'parts-and-continuation';
        const config = split ? f.environment(f.packet.value.fullChars! - 1) : f.configured;
        const packet = split ? valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record : f.packet;
        const answers = packet.value.plan!.assignments.map((_, position) => ({ research: e4Node(f, { ...packet,
          value: { ...packet.value, plan: { ...packet.value.plan!, position } } } as Revision<QuestionPacketRecord>), usage }));
        const need = { ...e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]),
          questionIds: (packet.value.packet as { questions: { id: string }[] }).questions.map(row => row.id) };
        f.steps([...(split ? [{ research: need, usage }] : []), ...answers]);
        request = { ...request, packet: reference(packet), dispatch: { ...request.dispatch, config: reference(config) } };
      } else f.steps([{ research: mode === 'cannot-answer' ? e4CannotAnswer(f) : { bad: true }, usage,
        ...(mode === 'interrupted' ? { exitCode: 7 } : {}) }]);
      const write = f.store.writeMany.bind(f.store);
      let cursor: Write | undefined;
      f.store.writeMany = ((writes, guards) => {
        const cycle = writes.find(row => row.kind === 'om-model-cycle');
        if (cycle) { cursor = cycle; throw Error('stop before cycle cursor'); }
        return write(writes, guards);
      }) as Store['writeMany'];
      try { await assert.rejects(runModelCycle(f.store, request), /stop before cycle cursor/); }
      finally { f.store.writeMany = write; }
      assert.ok(cursor);
      assert.equal(f.store.list('om-model-cycle').length, 0);
      const work = completionSnapshot(f);
      assert.equal(work.complete, true);
      let refusals = [...work.refusals];
      if (node) {
        // Assembly is ready, but it is not a C5 achievement. An independent G3 supplies reason.
        const source = f.store.write({ id: `${unitRefusalNamespace(f.project)}cycle-recovery`, kind: UNIT_REFUSAL_KIND, expected: 0,
          value: { gate: 'G3', refusals: [{ code: 'unrecognized_fixture_refusal', goal: 'cycle-recovery', remedy: 'Review the assembly',
            origin: { name: 'artifact_missing', stage: 'layer-check', subject: 'artifact:fixture', sources: [] } }] } });
        const journal = valueOf(recordRefusal(f.store, { project: f.project, source: reference(source) }));
        const row = journal.value.rows.find(row => row.source.id === source.id)!;
        refusals.push({ row: row.id, name: row.code, goal: row.goal });
      }
      const reason = mode === 'off-form' ? 'off-form' : mode === 'interrupted' ? 'interrupted' : 'refused';
      const claim = { ...seriesRequestOf(f.series.value), attempt: 1,
        outcome: { reason, accepting: [], cancelling: [], refusals } } as const;
      const closed = valueOf(closeAttempt(f.store, claim));
      const before = f.store.list(), sends = f.sent().length;
      writeFileSync(join(f.root, 'e4-source.txt'), 'changed after completed work');
      f.restart();
      const resumed = valueOf(await runModelCycle(f.store, request));
      assert.equal(resumed.record.id, cursor.id);
      assert.deepEqual(resumed.record.value, cursor.value);
      assert.equal(resumed.record.revision, 1);
      assert.deepEqual(valueOf(readModelCycle(f.store, { project: f.project, record: reference(resumed.record) })).record, resumed.record);
      assert.deepEqual(f.store.list().filter(row => row.kind !== 'om-model-cycle'), before,
        'Recovery writes only the cycle cursor, never closed work, A3, E4, parts or accounting');
      assert.equal(f.sent().length, sends);
      const forbidden = prepareCompletionProducts(f.store, reference(work.binding), [reference(resumed.record)]);
      assert.equal(forbidden.ok, false, 'Cursor recovery does not open a registration path into closed work');
      if (!forbidden.ok) assert.equal(forbidden.refusal.code, 'completion_closed');
      const after = f.store.list();
      f.restart();
      await child.test('31 completed cycle and each local part replay without further writes', async () => {
        assert.equal(valueOf(await runModelCycle(f.store, request)).repeated, true);
        for (const step of resumed.record.value.steps)
          valueOf(await runModelCall(f.store, { ...request, packet: step.packet }));
        if (resumed.assembly) valueOf(assembleModelParts(f.store, { project: f.project, results: [...resumed.record.value.results] }));
        assert.deepEqual(valueOf(closeAttempt(f.store, claim)), closed);
        assert.deepEqual(f.store.list(), after);
        assert.equal(f.sent().length, sends);
      });
    });
  }
});

test('C13 H1.0a G7 racing cycle registration retries as closed cursor recovery', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  f.steps([{ research: { bad: true }, usage }]);
  valueOf(await runModelCall(f.store, f.request));
  const work = completionSnapshot(f);
  const claim = { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'off-form' as const, accepting: [], cancelling: [], refusals: work.refusals } };
  const write = f.store.writeMany.bind(f.store);
  let closed = false;
  f.store.writeMany = ((writes, guards) => {
    if (!closed && writes.some(row => row.kind === 'om-model-cycle')) {
      const second = new Store(f.database);
      try { valueOf(closeAttempt(second, claim)); closed = true; } finally { second.close(); }
    }
    return write(writes, guards);
  }) as Store['writeMany'];
  try {
    const raced = await runModelCycle(f.store, f.request);
    assert.equal(raced.ok, false);
    if (!raced.ok) assert.equal(raced.refusal.code, 'input_stale');
  } finally { f.store.writeMany = write; }
  assert.equal(closed, true);
  assert.equal(f.store.list('om-model-cycle').length, 0);
  const before = f.store.list(); f.restart();
  valueOf(await runModelCycle(f.store, f.request));
  assert.deepEqual(f.store.list().filter(row => row.kind !== 'om-model-cycle'), before);
  assert.equal(f.sent().length, 1);
});

test('21 H1.0a MC2 complete parts require assembly, and assembly alone cannot impersonate an accepted achievement', async t => {
  for (const split of [false, true]) await t.test(split ? 'split with source child' : 'single direct part', async t => {
    const f = e4Fixture(t, 'node', 100_000, 0, 1000, true);
    const config = split ? f.environment(f.packet.value.fullChars! - 1) : f.configured;
    const packet = split ? valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record : f.packet;
    const count = packet.value.plan!.assignments.length;
    const answers = Array.from({ length: count }, (_, position) => e4Node(f, { ...packet,
      value: { ...packet.value, plan: { ...packet.value.plan!, position } } } as Revision<QuestionPacketRecord>));
    const need = { ...e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]),
      questionIds: (packet.value.packet as { questions: {id:string}[] }).questions.map(row => row.id) };
    f.steps([...(split ? [{ research: need }] : []), ...answers.map(research => ({ research, usage }))]);
    const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
    const first = valueOf(await runModelCall(f.store, request));
    await t.test('27 physical terminal or source receipt without assembly remains incomplete',()=>{
      assert.equal(completionSnapshot(f).complete,false);
    });
    assert.equal(completionSnapshot(f).assignments.filter(row => row.value.kind === 'part').length, count);
    assert.equal(first.record.value.om.completionOwner!.call.id, first.call.id);
    const cycle = valueOf(await runModelCycle(f.store, request));
    assert.equal(cycle.record.value.terminal, 'assembled');
    assert.ok(cycle.assembly);
    assert.equal(completionSnapshot(f).complete, true);
    const owners = cycle.record.value.steps.map(step => valueOf(readModelCall(f.store, { project:f.project, record:step.record })).record.value.om.completionOwner!);
    assert.equal(new Set(owners.map(row => row.call.id)).size, count + Number(split));
    await t.test('22 source continuation keeps one binding and distinct exact steps',()=>{
      assert.equal(new Set(owners.map(row=>row.binding.id)).size,1);
      assert.equal(new Set(owners.map(row=>row.assignment.id)).size,count+Number(split));
    });
    await t.test('23 proved assembly discharges the logical MC2 root',()=>{assert.equal(completionSnapshot(f).complete,true);assert.ok(cycle.assembly);});
    await t.test('28 ready assembly alone cannot claim an empty result',()=>{
      assert.equal(closeAttempt(f.store,{...seriesRequestOf(f.series.value),attempt:1,
        outcome:{reason:'result',accepting:[],cancelling:[],refusals:[]}}).ok,false);
    });
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
    const before = f.store.list(); f.restart();
    assert.equal(valueOf(await runModelCycle(f.store, request)).repeated, true);
    assert.equal(completionSnapshot(f).complete, true);
    assert.deepEqual(f.store.list(), before);
    assert.equal(f.sent().length, count + Number(split));
  });
});

test('15 H1.0a exact no-progress, blocked successor and invalid assembly discharge their root without local A3', async t => {
  for (const terminal of ['research-no-progress', 'blocked', 'parts-invalid'] as const) await t.test(terminal, async t => {
    const f = e4Fixture(t, terminal === 'parts-invalid' ? 'node' : 'fact', 100_000, 0, 1000, true);
    let request = f.request;
    if (terminal === 'parts-invalid') {
      const config = f.environment(f.packet.value.fullChars! - 1);
      const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
      const answers = packet.value.plan!.assignments.map((_,position) => e4Node(f, { ...packet,
        value:{...packet.value,plan:{...packet.value.plan!,position}} } as Revision<QuestionPacketRecord>));
      answers.at(-1)!.proposal.fills.pop();
      f.steps(answers.map(research => ({ research, usage })));
      request = { ...request, packet:reference(packet),dispatch:{...request.dispatch,config:reference(config)} };
    } else {
      const need = e4NeedSource(f, [{action:'read',path:'e4-source.txt',media:'text/plain'}]);
      if (terminal === 'blocked') {
        const config = f.environment(f.packet.value.fingerprint!.chars + 100);
        const packet = valueOf(writeQuestionPacket(f.store, {...f.packetRequest, environment:reference(config)})).record;
        request = {...request,packet:reference(packet),dispatch:{...request.dispatch,config:reference(config)}};
        writeFileSync(join(f.root,'e4-source.txt'),'UTF-8 '.repeat(20_000));
      }
      f.steps([{research:need,usage},{research:need,usage}]);
    }
    const cycle = valueOf(await runModelCycle(f.store, request));
    assert.equal(cycle.record.value.terminal, terminal);
    const work = completionSnapshot(f); assert.equal(work.complete, true);
    assert.ok(work.refusals.length);
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
    const claim = {...seriesRequestOf(f.series.value),attempt:1,
      outcome:{reason:'refused' as const,accepting:[],cancelling:[],refusals:work.refusals}};
    const closed = valueOf(closeAttempt(f.store,claim)), sends=f.sent().length;
    const saved=f.store.list(); f.restart();
    for (const row of f.store.list<QuestionPacketRecord>('question-packet')) valueOf(readQuestionPacket(f.store,{project:f.project,record:reference(row)}));
    assert.deepEqual(valueOf(closeAttempt(f.store,claim)),closed);
    valueOf(await runModelCycle(f.store,request));
    assert.deepEqual(f.store.list(),saved); assert.equal(f.sent().length,sends);
  });
});

test('14 H1.0a physical technical and control terminals keep their own diagnostic through G7 and exact restart', async t => {
  for (const kind of ['interrupted','awaiting-owner','refused','mechanism'] as const) await t.test(`${kind==='awaiting-owner'?'16':'14'} ${kind}`,async t => {
    const f=e4Fixture(t,kind==='mechanism'?'field':'fact',100_000,0,1000,true);
    const action=kind==='awaiting-owner'?'need_owner':'cannot_answer';
    f.steps([kind==='interrupted' ? {exitCode:1,usage} : {research:{protocol:'omg-answer/v2',requestId:'$requestId',action,
      questionIds:[f.batch.items[0]!.gap],reason:'A concrete external source is required',...(action==='need_owner'?{decision:'Choose the source'}:{})},usage}]);
    const call=valueOf(await runModelCall(f.store,f.request));
    assert.ok(call.diagnostic);
    const work=completionSnapshot(f); assert.equal(work.complete,true);
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
    const reason=kind==='mechanism'?'refused':kind;
    const claim={...seriesRequestOf(f.series.value),attempt:1,outcome:{reason,accepting:[],cancelling:[],refusals:work.refusals}};
    const closed=valueOf(closeAttempt(f.store,claim));
    assert.equal(f.store.list('om-origin-hold').length,0);
    assert.equal(work.waiting.length,Number(kind==='awaiting-owner'));
    const before=f.store.list(); f.restart();
    assert.deepEqual(valueOf(closeAttempt(f.store,claim)),closed);
    valueOf(readModelCall(f.store,{project:f.project,record:reference(call.record)}));
    assert.deepEqual(f.store.list(),before); assert.equal(f.sent().length,1);
  });
});

function alteredRead(store: Store, replacement: (record: Revision<unknown> | null) => Revision<unknown> | null): Store {
  return new Proxy(store, { get(target, key) {
    if (key === 'get') return (id:string, revision?:number) => replacement(target.get(id, revision));
    const value:unknown=Reflect.get(target,key,target); return typeof value==='function'?value.bind(target):value;
  } });
}

test('5 H1.0a managed history rejects missing or counterfeit independent ownership instead of selecting legacy', async t => {
  const f=e4Fixture(t,'fact',100_000,0,1000,true);
  f.steps([{research:e4Fact(f),usage}]);
  const call=valueOf(await runModelCall(f.store,f.request)); f.restart();
  for (const kind of ['om-completion-era','om-completion-owner','om-completion-assignment','om-completion-work']) {
    for (const damage of ['missing','kind','body'] as const) {
      const view=alteredRead(f.store, row => {
        if (row?.kind!==kind) return row;
        if (damage==='missing') return null;
        if (damage==='kind') return {...row,kind:'unrelated'};
        const body={...(row.value as object),contract:'fabricated'};
        return {...row,value:body,hash:hashJson(body)};
      });
      assert.equal(readModelCallState(view,{project:f.project,record:reference(call.record)}).ok,false,`${kind}/${damage}`);
    }
  }
  await t.test('36 foreign step and contradictory physical family cannot become a second assignment',()=>{
  for (const damage of ['marker','version','both','other-family','foreign-assignment'] as const) {
    const body=structuredClone(call.record.value) as OmModelCall;
    if (damage==='marker'||damage==='both') delete body.om.completionOwner;
    if (damage==='version'||damage==='both') body.om.version='om-model-call/v1';
    if (damage==='other-family') Object.assign(body,{transport:{version:'om-model-transport/v1'}});
    if (damage==='foreign-assignment') body.om.completionOwner!.assignment=body.om.completionOwner!.binding;
    const forged={...call.record,value:body,hash:hashJson(body)};
    const view=alteredRead(f.store,row => row?.id===forged.id&&row.revision===forged.revision?forged:row);
    assert.equal(readModelCallState(view,{project:f.project,record:reference(forged)}).ok,false,damage);
  }
  });
  assert.equal(f.sent().length,1);
});

test('33 H1.0a direct E1 cannot rename or replace the proved E2, and an unpaid admitted step resumes once',async t => {
  const f=e4Fixture(t,'fact',100_000,0,1000,true);
  const payload=f.packet.value.packet as Record<string,Json> & {requestId:string;purpose:'model-research'};
  const request={call:payload.requestId,purpose:payload.purpose,basis:null,block:'garden-consume-block',
    series:reference(f.series),attempt:1,goal:f.series.value.attempts[0]!.goal,dispatch:f.request.dispatch,packet:payload,
    gaps:f.batch.items.flatMap(item=>item.consumers.map(consumer=>({id:item.target,goal:item.target,field:item.field,consumer})))};
  for (const changed of [{...request,call:'forged-call'}, {...request,packet:{...payload,extra:'forged'}},
    {...request,purpose:'model-design' as const}]) {
    const before=f.store.list(); assert.equal(recordCall(f.store,f.project,changed).ok,false);
    assert.deepEqual(f.store.list(),before);
  }
  const admitted=valueOf(recordCall(f.store,f.project,request));
  await t.test('8 E1 without physical claim still holds the barrier',()=>{
    assert.equal(f.store.list('model-call').length,0);assert.equal(completionSnapshot(f).complete,false);
  });
  f.restart(); f.steps([{research:{nonsense:true},usage}]);
  const call=valueOf(await runModelCall(f.store,f.request));
  assert.deepEqual(call.call,reference(admitted.call)); assert.equal(f.sent().length,1);
  const work=completionSnapshot(f);
  valueOf(closeAttempt(f.store,{...seriesRequestOf(f.series.value),attempt:1,
    outcome:{reason:'off-form',accepting:[],cancelling:[],refusals:work.refusals}}));
  const before=f.store.list();
  assert.equal(recordCall(f.store,f.project,{...request,call:'new-after-close'}).ok,false);
  assert.deepEqual(f.store.list(),before);
});

test('9 H1.0a durable running, received and unapplied work retain the barrier and reuse the original dispatch',async t => {
  for (const phase of ['running','received','applied','missing-work'] as const) await t.test(`${({running:9,received:11,applied:12,'missing-work':32})[phase]} ${phase}`,async t => {
    const f=e4Fixture(t,'fact',100_000,0,1000,true); f.steps([{research:{nonsense:true},usage}]);
    const write=f.store.writeMany.bind(f.store); let stopped=false;
    f.store.writeMany=((writes,guards)=>{
      const reaches=writes.some(row=>row.kind==='model-call' && (row.value as OmModelCall).om?.application===(phase==='missing-work'?'applied':phase));
      if (reaches && phase==='missing-work') {
        assert.ok(writes.some(row=>row.kind==='om-completion-work'),'The real producer writes product and registry atomically');
        // Model the specified recovered prefix: the paid terminal survives, its registry cursor does not.
        const kept=writes.filter(row=>row.kind!=='om-completion-work');
        const result=write(kept,guards); stopped=true; throw new Error(`managed durable ${result.length}`);
      }
      const result=write(writes,guards);
      if (!stopped&&reaches) {stopped=true;throw new Error('managed durable stop');}
      return result;
    }) as Store['writeMany'];
    try { await assert.rejects(runModelCall(f.store,f.request),/managed durable/); }
    finally {f.store.writeMany=write;}
    assert.ok(stopped);
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
    if (phase!=='applied') assert.equal(completionSnapshot(f).complete,false);
    f.restart();
    if (phase==='running') {
      const before=f.store.list(); const retry=await runModelCall(f.store,f.request);
      assert.equal(retry.ok,false); if (!retry.ok) assert.equal(retry.refusal.code,'model_call_in_progress');
      assert.deepEqual(f.store.list(),before); assert.equal(f.sent().length,0); return;
    }
    const resumed=valueOf(await runModelCall(f.store,f.request));
    assert.equal(resumed.record.value.om.application,'applied'); assert.equal(completionSnapshot(f).complete,true);
    const work=completionSnapshot(f); const claim={...seriesRequestOf(f.series.value),attempt:1,
      outcome:{reason:'off-form' as const,accepting:[],cancelling:[],refusals:work.refusals}};
    valueOf(closeAttempt(f.store,claim)); const before=f.store.list(); f.restart();
    valueOf(await runModelCall(f.store,f.request)); valueOf(closeAttempt(f.store,claim));
    assert.deepEqual(f.store.list(),before); assert.equal(f.sent().length,1);
  });
});

test('10 H1.0a recovery of a lost managed owner preserves unknown expense and closes only through explicit G7',async t => {
  const f=e4Fixture(t,'fact',100_000,0,30_000,true), checkpoint=join(f.root,'managed-claimed.json');
  ensureFixtureProject(f.store,f.project); f.steps([{research:e4Fact(f),usage}]);
  const driver=fixtureDriver(t,f.database,f.root,'call',f.request,
    {path:checkpoint,kind:'model-call',matches:[{path:['execution','phase'],value:'claimed'}]});
  await fixtureCheckpoint(checkpoint,driver.child);
  const claimed=f.store.list<ModelCall>('model-call')[0]!;
  assert.equal(completionSnapshot(f).complete,false); refusesLiveRecovery(f.store,f.project,reference(claimed));
  await killFixtureDriver(driver);
  const recovered=publicRecovery(f.store,f.project,reference(claimed));
  assert.equal(recovered.value.error,'process_lost'); assert.equal(recovered.value.usage,null);
  assert.equal(completionSnapshot(f).complete,true);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
  const work=completionSnapshot(f), claim={...seriesRequestOf(f.series.value),attempt:1,
    outcome:{reason:'interrupted' as const,accepting:[],cancelling:[],refusals:work.refusals}};
  valueOf(closeAttempt(f.store,claim)); const before=f.store.list(); f.restart();
  valueOf(readModelCall(f.store,{project:f.project,record:reference(recovered)}));
  valueOf(await runModelCall(f.store,f.request)); valueOf(closeAttempt(f.store,claim));
  assert.deepEqual(f.store.list(),before); assert.equal(f.sent().length,0);
  assert.equal(f.store.list('model-call-recovery').length,1);
});

test('1 H1.0a standalone physical history retains its original completion and never acquires an owner', async t => {
  const f=e4Fixture(t); f.steps([{research:{wrong:true},usage}]);
  const original=valueOf(await runModelCall(f.store,f.request));
  assert.equal(original.record.value.om.version,'om-model-call/v1');
  assert.equal(original.record.value.om.completionOwner,undefined);
  assert.equal(f.store.list('om-completion-owner').length,0);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome?.reason,'off-form');
  const saved=f.store.list();f.restart();
  assert.equal(valueOf(await runModelCall(f.store,f.request)).repeated,true);
  assert.deepEqual(f.store.list(),saved);assert.equal(f.sent().length,1);
});

test('4 H1.0a an existing standalone opening cannot be adopted even before any physical call',t=>{
  const f=e4Fixture(t), before=f.store.list();
  const request={...seriesRequestOf(f.series.value),attempt:1,goal:f.series.value.attempts[0]!.goal,
    completion:{routes:reference(f.routes),batches:[f.batch.id]}};
  const result=managedOpenAttempt(f.store,request as never);
  assert.equal(result.ok,false); if(!result.ok) assert.equal(result.refusal.code,'completion_conflict');
  assert.deepEqual(f.store.list(),before);
});

test('C03 H1.0a completion threshold preserves old ordinals and an exact managed opening ignores later M6 heads',async t=>{
  const f=e4Fixture(t,'fact',100_000,2,1000,true);
  assert.equal(valueOf(readCompletionBinding(f.store,f.project,reference(f.series),1)),null);
  const address=seriesRequestOf(f.series.value),goal=f.series.value.attempts.at(-1)!.goal;
  const routes=valueOf(writeRoutes(f.store,JSON.parse(canonical({...f.routes.value.request,tasks:f.routes.value.request.tasks.map(record=>({record})),previous:reference(f.routes)}))));
  const before=f.store.list();
  assert.deepEqual(valueOf(managedOpenAttempt(f.store,{...address,attempt:3,goal} as never)),f.series);
  assert.equal(managedOpenAttempt(f.store,{...address,attempt:3,goal,
    completion:{routes:reference(routes),batches:[f.batch.id]}} as never).ok,false);
  assert.deepEqual(f.store.list(),before);
  assert.equal(beginAttempt(f.store,{...address,attempt:4,goal} as never).ok,false);
});

test('34 H1.0a analysis of a stopped managed ordinal remains a separate transport and preserves its closed registry',async t=>{
  const f=e4Fixture(t,'fact',100_000,2,1000,true);
  f.steps([{research:{wrong:true},usage},{research:{cause:'fixture observation',hypothesis:true},usage}]);
  valueOf(await runModelCall(f.store,f.request));
  const work=completionSnapshot(f),address=seriesRequestOf(f.series.value);
  valueOf(closeAttempt(f.store,{...address,attempt:3,outcome:{reason:'off-form',accepting:[],cancelling:[],refusals:work.refusals}}));
  const series=f.store.get<RepairSeries>(f.series.id)!;assert.ok(series.value.stop);
  const closedWork=f.store.get(work.work.id),packet={task:'Diagnose this exact stop'};
  const admitted=valueOf(recordCall(f.store,f.project,{call:'managed-stop-analysis',purpose:'stop-analysis',
    basis:{kind:'series-stop',series:reference(series),attempt:3},block:series.value.block,
    gaps:[{id:'stop-analysis',goal:'stop-analysis',field:'cause-and-change',consumer:'A6:stop-analysis'}],
    series:reference(series),attempt:3,goal:{key:'stop-analysis',questions:['Why stopped?'],result:'Addressed change'},
    dispatch:f.request.dispatch,packet}));
  const request={project:f.project,call:reference(admitted.call),packet,role:'reviewer' as const};
  const called=valueOf(await runModelTransport(f.store,request));
  assert.equal(called.record.value.transport.version,'om-model-transport/v1');
  assert.equal(called.record.value.transport.completionOwner,undefined);
  f.restart();assert.equal(valueOf(await runModelTransport(f.store,request)).repeated,true);
  assert.deepEqual(f.store.get(work.work.id),closedWork);assert.deepEqual(f.store.get(series.id),series);
  assert.equal(f.sent().length,2);
});

test('33 H1.0b equivalent reconfiguration after receipt applies the same answer with a fresh environment guard',async t=>{
  const f=e4Fixture(t,'fact',100_000,0,1000,true);f.steps([{research:e4Fact(f),usage}]);
  const original=f.store.writeMany.bind(f.store);let moved=false;
  f.store.writeMany=((writes,guards)=>{
    const result=original(writes,guards);
    if(!moved && writes.some(row=>row.kind==='model-call' && (row.value as OmModelCall).om?.application==='received')){
      moved=true; f.environment();
    }
    return result;
  }) as Store['writeMany'];
  const called=valueOf(await runModelCall(f.store,f.request)); f.store.writeMany=original;
  assert.equal(moved,true);assert.equal(called.record.value.om.application,'applied');
  assert.equal(called.diagnostic,null);assert.equal(completionSnapshot(f).complete,false);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
  const saved=f.store.list();f.restart();
  assert.equal(valueOf(await runModelCall(f.store,f.request)).record.value.om.application,'applied');
  assert.deepEqual(f.store.list(),saved);assert.equal(f.sent().length,1);
});

test('37 H1.0a direct local finish proves its diagnostic and repeats without current journal or A3 mutation',async t=>{
  const f=e4Fixture(t,'fact',100_000,0,1000,true);f.steps([{research:{wrong:true},usage}]);
  const called=valueOf(await runModelCall(f.store,f.request));
  const binding=valueOf(readCompletionBinding(f.store,f.project,reference(f.series),1))!;
  const proof=valueOf(readManagedModelDiagnostic(f.store,binding,called.diagnostic!));
  const finishRequest={...proof.request,evidence:[...(proof.request.evidence??[])]};
  assert.equal(valueOf(prepareModelAttemptFinish(f.store,finishRequest)).writes.length,0);
  assert.equal(prepareModelAttemptFinish(f.store,{...finishRequest,reason:'refused'}).ok,false);
  const before=f.store.list();
  assert.deepEqual(valueOf(finishModelAttempt(f.store,finishRequest)),{diagnostic:called.diagnostic});
  assert.deepEqual(f.store.list(),before);assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
  f.restart();assert.equal(valueOf(prepareModelAttemptFinish(f.store,finishRequest)).writes.length,0);
});

test('C28 H1.0a retained completion producer addresses refuse lost B1 even for incomplete records',async t=>{
  for(const kind of ['om-completion-owner','om-completion-era','om-completion-assignment','om-completion-work','om-completion-close']){
    await t.test(kind,child=>{
      const root=mkdtempSync(join(tmpdir(),'omg-h10a-era-')),path=join(root,'state.sqlite');let store=new Store(path);
      child.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
      new ProductEngine(store).execute({type:'create-project',project:'era',title:'Before B1'});
      store.write({id:`${kind}:era:retained`,kind,expected:0,value:{}});
      for(const restart of [false,true]){
        if(restart){store.close();store=new Store(path);}
        const before=store.list();
        assert.throws(()=>new ProductEngine(store).projection('era'),(error:unknown)=>error instanceof EngineError && error.code==='record_missing');
        assert.deepEqual(store.list(),before);
      }
    });
  }
});

test('32 H1.0a direct assembly repeat restores a lost registry cursor without producing or paying twice',async t=>{
  const f=e4Fixture(t,'node',100_000,0,1000,true);f.steps([{research:e4Node(f,f.packet as Revision<QuestionPacketRecord>),usage}]);
  const call=valueOf(await runModelCall(f.store,f.request));assert.ok(call.part);
  const request={project:f.project,results:[call.part.result]},write=f.store.writeMany.bind(f.store);
  let stopped=false;
  f.store.writeMany=((writes,guards)=>{
    if(!stopped&&writes.some(row=>row.kind==='om-part-assembly')){
      stopped=true;assert.ok(writes.some(row=>row.kind==='om-completion-work'));
      write(writes.filter(row=>row.kind!=='om-completion-work'),guards);throw Error('assembly cursor lost');
    }
    return write(writes,guards);
  })as Store['writeMany'];
  try{assert.throws(()=>assembleModelParts(f.store,request),/assembly cursor lost/);}finally{f.store.writeMany=write;}
  assert.equal(stopped,true);assert.equal(completionSnapshot(f).complete,false);
  const assembly=f.store.list('om-part-assembly')[0]!,physical=f.store.list('model-call');f.restart();
  assert.deepEqual(valueOf(assembleModelParts(f.store,request)).record,assembly);assert.equal(completionSnapshot(f).complete,true);
  const saved=f.store.list();f.restart();
  assert.deepEqual(valueOf(assembleModelParts(f.store,request)).record,assembly);
  assert.deepEqual(f.store.list(),saved);assert.deepEqual(f.store.list('model-call'),physical);assert.equal(f.sent().length,1);
});

test('C09 H1.0a a current-only assembly admission failure cannot manufacture a historical parts-invalid terminal',async t=>{
  const f=e4Fixture(t,'node',100_000,0,1000,true);f.steps([{research:e4Node(f,f.packet as Revision<QuestionPacketRecord>),usage}]);
  valueOf(await runModelCall(f.store,f.request));
  const graph=f.store.get<Graph>(`graph:${f.project}`)!;
  new ProductEngine(f.store).graphs.save(f.project,graph.value,graph.revision,'fixture graph source refresh');
  const before=f.store.list('om-unit-refusal'),failed=await runModelCycle(f.store,f.request);
  assert.equal(failed.ok,false);assert.equal(completionSnapshot(f).complete,false);
  assert.deepEqual(f.store.list('om-unit-refusal'),before);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
  f.restart();assert.equal((await runModelCycle(f.store,f.request)).ok,false);
  assert.equal(completionSnapshot(f).complete,false);assert.equal(f.sent().length,1);
});

test('C06 H1.0a successor inherits original completion proofs but starts its own independent ordinal threshold',async t=>{
  const f=e4Fixture(t,'fact',100_000,0,1000,true);f.steps([{research:{wrong:true},usage}]);
  valueOf(await runModelCall(f.store,f.request));const work=completionSnapshot(f),address=seriesRequestOf(f.series.value);
  valueOf(closeAttempt(f.store,{...address,attempt:1,outcome:{reason:'off-form',accepting:[],cancelling:[],refusals:work.refusals}}));
  const closed=f.store.get<RepairSeries>(f.series.id)!;
  const next=valueOf(openSeries(f.store,{project:f.project,block:closed.value.block,line:2,slice:'successor-subject',predecessor:reference(closed),
    basis:{ground:'inputs-changed',text:'A separately recorded subject supersedes this legacy slice'}}));
  assert.equal(next.value.inherited.length,1);
  assert.deepEqual(valueOf(readCompletionBinding(f.store,f.project,reference(next),1)),work.binding);
  const goal=closed.value.attempts[0]!.goal;
  const standalone=valueOf(beginAttempt(f.store,{project:f.project,block:closed.value.block,line:2,attempt:2,goal}));
  assert.equal(valueOf(readCompletionBinding(f.store,f.project,reference(standalone),2)),null);
  valueOf(completeAttempt(f.store,{project:f.project,block:closed.value.block,line:2,attempt:2,
    outcome:{reason:'awaiting-owner',achieved:[],cancelled:[],refusals:[]}}));
  const managed=valueOf(managedOpenAttempt(f.store,{project:f.project,block:closed.value.block,line:2,attempt:3,goal,
    completion:{routes:reference(f.routes),batches:[f.batch.id]}}));
  const binding=valueOf(readCompletionBinding(f.store,f.project,reference(managed),3))!;
  assert.notEqual(binding.id,work.binding.id);assert.equal(binding.value.series.id,next.id);
  assert.deepEqual(f.store.list<{firstManagedAttempt:number}>('om-completion-era').map(row=>row.value.firstManagedAttempt).sort(),[1,3]);
  f.restart();assert.deepEqual(valueOf(readCompletionBinding(f.store,f.project,reference(managed),1)),work.binding);
  assert.deepEqual(valueOf(readCompletionBinding(f.store,f.project,reference(managed),3)),binding);
  assert.equal(f.sent().length,1);
});

test('C36 H1.0a a closed A3 needs the full exact close proof and cannot use an old terminal marker',async t=>{
  const f=e4Fixture(t,'fact',100_000,0,1000,true);f.steps([{research:{wrong:true},usage}]);
  valueOf(await runModelCall(f.store,f.request));const work=completionSnapshot(f),address=seriesRequestOf(f.series.value);
  valueOf(closeAttempt(f.store,{...address,attempt:1,outcome:{reason:'off-form',accepting:[],cancelling:[],refusals:work.refusals}}));
  f.restart();const closed=f.store.get(f.series.id)!;
  for(const damage of ['missing','foreign-kind','false-claim','missing-work','legacy-terminal']){
    const view=alteredRead(f.store,row=>{
      if(row?.kind==='om-completion-close'){
        if(damage==='missing')return null;
        if(damage==='foreign-kind')return {...row,kind:'another-contract'};
        if(damage==='false-claim'){
          const value=structuredClone(row.value) as {claim:{accepting:Ref[];reason:string}};
          value.claim.reason='result';return {...row,value,hash:hashJson(value)};
        }
      }
      if(damage==='missing-work'&&row?.kind==='om-completion-work')return null;
      if(damage==='legacy-terminal'&&row?.id===closed.id&&row.revision===closed.revision){
        const value=structuredClone(row.value) as RepairSeries;
        Object.assign(value.attempts[0]!,{terminal:{source:work.products[0],call:work.products[0]}});
        return {...row,value,hash:hashJson(value)};
      }
      return row;
    });
    assert.equal(readSeries(view,address).ok,false,damage);
  }
  assert.equal(f.sent().length,1);
});

test('C39 H1.0a technical diagnostics retain the stop and a real independent A6 decision can resume it',async t=>{
  const {runStopAnalysis}=await import('../src/om/stop-analysis.js');
  const {resumeSeries}=await import('../src/om/series.js');
  const f=e4Fixture(t,'fact',100_000,2,1000,true);f.steps([{research:{wrong:true},usage}]);
  valueOf(await runModelCall(f.store,f.request));const work=completionSnapshot(f),address=seriesRequestOf(f.series.value);
  valueOf(closeAttempt(f.store,{...address,attempt:3,outcome:{reason:'off-form',accepting:[],cancelling:[],refusals:work.refusals}}));
  const stopped=f.store.get<RepairSeries>(f.series.id)!,closedWork=f.store.get(work.work.id);assert.equal(stopped.value.stop?.attempt,3);
  const research={protocol:'omg-stop-analysis/v1',cause:{kind:'hypothesis',text:'The response format needs an explicit instruction',sources:[]},
    change:{text:'Clarify the requested answer contract',addresses:[{ref:reference(stopped),field:'attempts'}]},origin:null};
  f.steps([{research:{wrong:true},usage},{research,usage}]);
  const request={project:f.project,series:reference(stopped),hold:null,dispatch:f.request.dispatch};
  const analysis=valueOf(await runStopAnalysis(f.store,request));assert.equal(analysis.value.state,'decided');
  assert.equal(f.store.list('om-origin-hold').length,0);
  const resumed=valueOf(resumeSeries(f.store,{...address,stop:3,ground:'review-record',text:'Use the exact reviewed change',review:{ref:reference(analysis)}}));
  assert.equal(resumed.value.stop,null);assert.deepEqual(f.store.get(work.work.id),closedWork);
  const opened=valueOf(managedOpenAttempt(f.store,{project:f.project,block:(f.series.value as RepairSeries).block,line:f.series.value.line,attempt:4,goal:f.series.value.attempts.at(-1)!.goal,
    completion:{routes:reference(f.routes),batches:[f.batch.id]}}));
  assert.equal(opened.value.attempts.at(-1)!.outcome,null);
  const saved=f.store.list();f.restart();
  assert.deepEqual(valueOf(await runStopAnalysis(f.store,request)),analysis);assert.deepEqual(f.store.list(),saved);
  assert.equal(f.sent().length,2);
});

test('5 H1.0a exact completion readers reject missing source fields and a closed cursor without its whole G7 derivation',async t=>{
  const {readCompletionOwnerAt}=await import('../src/om/series.js');
  const {readCompletionAssignmentAt}=await import('../src/om/model-call.js');
  const f=e4Fixture(t,'fact',100_000,0,1000,true);f.steps([{research:{wrong:true},usage}]);
  valueOf(await runModelCall(f.store,f.request));const work=completionSnapshot(f);
  valueOf(closeAttempt(f.store,{...seriesRequestOf(f.series.value),attempt:1,
    outcome:{reason:'off-form',accepting:[],cancelling:[],refusals:work.refusals}}));
  const owner=work.binding,part=work.assignments.find(row=>row.value.kind==='part')!,closed=f.store.get(work.work.id)!;
  for(const [row,field,reader]of [
    [owner,'goal',readCompletionOwnerAt],[part,'source',readCompletionAssignmentAt],[part,'kind',readCompletionAssignmentAt],
    [closed,'previous',readCompletionWorkAt],
  ] as const){
    const value={...row.value as object} as Record<string,unknown>;delete value[field];
    const changed={...row,value,hash:hashJson(value)},view=alteredRead(f.store,r=>r?.id===changed.id&&r.revision===changed.revision?changed:r);
    const result=reader(view,f.project,reference(changed));assert.equal(result.ok,false,field);
    if(!result.ok)assert.equal(result.refusal.code,'completion_invalid');
  }
  const value={...closed.value as object,closed:reference(f.routes)},changed={...closed,value,hash:hashJson(value)};
  assert.equal(readCompletionWorkAt(alteredRead(f.store,r=>r?.id===changed.id&&r.revision===changed.revision?changed:r),f.project,reference(changed)).ok,false);
  f.restart();assert.equal(valueOf(readCompletionWorkAt(f.store,f.project,reference(closed))).complete,true);
});

test('C10 H1.0a E1 ledger races protect G7 and a closed owner invalidates its earlier claim guards',async t=>{
  const {prepareCloseAttempt}=await import('../src/om/repeat-gate.js');
  for(const first of ['E1','G7'] as const)await t.test(first,async child=>{
    const f=e4Fixture(child,'fact',100_000,0,1000,true);f.steps([{research:{wrong:true},usage}]);
    valueOf(await runModelCall(f.store,f.request));const work=completionSnapshot(f);
    const address={project:f.project,block:'garden-produce-block',line:1};
    valueOf(openSeries(f.store,{...address,slice:'independent-call',predecessor:null,basis:null}));
    const goal={key:'independent',questions:['another-question'],result:'another-result'};
    const other=valueOf(beginAttempt(f.store,{...address,attempt:1,goal}));
    const request={call:'concurrent-unmanaged-call',purpose:'model-research' as const,basis:null,block:address.block,
      series:reference(other),attempt:1,goal,dispatch:f.request.dispatch,packet:{question:'independent'},
      gaps:[{id:'another-question',goal:'another-question',field:'value',consumer:address.block}]};
    const claim={...seriesRequestOf(f.series.value),attempt:1,outcome:{reason:'off-form' as const,accepting:[],cancelling:[],refusals:work.refusals}};
    if(first==='E1'){
      const prepared=valueOf(prepareCloseAttempt(f.store,claim));
      const second=new Store(f.database);try{valueOf(recordCall(second,f.project,request));}finally{second.close();}
      const stale=writeGuarded(f.store,{unit:'G7',target:f.series.id,writes:prepared.writes,guards:prepared.guards});
      assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.refusal.code,'input_stale');
      assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
      valueOf(closeAttempt(f.store,claim));
    }else{
      const {prepareCompletionCall}=await import('../src/om/model-call.js');
      const oldCall=f.store.list<{call:string;purpose:'model-research';basis:null;block:string;gaps:never[];series:Ref;attempt:number;goal:RepairSeries['attempts'][number]['goal'];dispatch:typeof f.request.dispatch}>('call-record')[0]!.value;
      const claimAdmission=valueOf(prepareCompletionCall(f.store,f.project,{call:oldCall.call,purpose:oldCall.purpose,basis:oldCall.basis,
        block:oldCall.block,gaps:oldCall.gaps,series:oldCall.series,attempt:oldCall.attempt,goal:oldCall.goal,
        dispatch:oldCall.dispatch,packet:f.packet.value.packet as Json}));
      const write=f.store.writeMany.bind(f.store);let closed=false;
      f.store.writeMany=((writes,guards)=>{
        if(!closed&&writes.some(row=>row.kind==='call-record')){
          closed=true;const second=new Store(f.database);try{valueOf(closeAttempt(second,claim));}finally{second.close();}
        }
        return write(writes,guards);
      }) as Store['writeMany'];
      try{valueOf(recordCall(f.store,f.project,request));}
      finally{f.store.writeMany=write;}
      assert.equal(closed,true);
      const stale=writeGuarded(f.store,{unit:'E4',target:'old-claim',writes:[{id:'test:stale-claim',kind:'test',expected:0,value:{}}],guards:claimAdmission.guards});
      assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.refusal.code,'input_stale');
      assert.equal(f.store.get('test:stale-claim'),null);
    }
    const saved=f.store.list();f.restart();valueOf(closeAttempt(f.store,claim));valueOf(recordCall(f.store,f.project,request));
    assert.deepEqual(f.store.list(),saved);assert.equal(f.store.list('call-record').length,2);assert.equal(f.sent().length,1);
  });
});

test('C03 H1.0a original managed opening protects all M6 sources in the same transaction',async t=>{
  const {prepareManagedBeginAttempt}=await import('../src/om/series.js');
  const f=e4Fixture(t);f.steps([{research:{wrong:true},usage}]);valueOf(await runModelCall(f.store,f.request));
  const closed=f.store.get<RepairSeries>(f.series.id)!,goal=closed.value.attempts[0]!.goal;
  valueOf(openSeries(f.store,{project:f.project,block:closed.value.block,line:2,slice:'next-line',predecessor:reference(closed),
    basis:{ground:'inputs-changed',text:'The declared task was revised'}}));
  const request={project:f.project,block:closed.value.block,line:2,attempt:2,goal,
    completion:{routes:reference(f.routes),batches:[f.batch.id]}};
  const prepared=valueOf(prepareManagedBeginAttempt(f.store,request));
  assert.ok(prepared.writes.some(row=>row.kind==='om-completion-owner'));
  assert.ok(prepared.writes.some(row=>row.kind==='om-completion-era'));
  const second=new Store(f.database);try{
    const graph=second.get<Graph>(`graph:${f.project}`)!;
    new ProductEngine(second).graphs.save(f.project,graph.value,graph.revision,'concurrent shared source');
  }finally{second.close();}
  const result=writeGuarded(f.store,{unit:'G7',target:f.project,writes:prepared.writes,guards:prepared.guards});
  assert.equal(result.ok,false);if(!result.ok)assert.equal(result.refusal.code,'input_stale');
  assert.equal(f.store.list('om-completion-owner').length,0);assert.equal(f.store.list('om-completion-era').length,0);
});

test('10 H1.0a exact late paid bytes settle one recovered dispatch after G7 without changing its terminal or completion',async t=>{
  const {spendReport}=await import('../src/om/spend-report.js');
  const f=e4Fixture(t,'fact',100_000,0,30_000,true),checkpoint=join(f.root,'managed-late.json');
  ensureFixtureProject(f.store,f.project);f.steps([{research:e4Fact(f),usage}]);
  const driver=fixtureDriver(t,f.database,f.root,'call',f.request,{path:checkpoint,kind:'om-model-exchange',matches:[],when:'before'});
  const pending=await fixtureCheckpoint(checkpoint,driver.child);
  const exchange=pending.writes!.find(write=>write.kind==='om-model-exchange')!.value as unknown as {process:ProcessResult;launchError:null};
  assert.equal(JSON.parse(exchange.process.stdout).usage.inputTokens,usage.inputTokens);assert.equal(f.sent().length,1);
  const dispatch=f.store.list<ModelCall>('model-call')[0]!;await killFixtureDriver(driver);
  const recovered=publicRecovery(f.store,f.project,reference(dispatch)),work=completionSnapshot(f);
  const claim={...seriesRequestOf(f.series.value),attempt:1,outcome:{reason:'interrupted' as const,accepting:[],cancelling:[],refusals:work.refusals}};
  valueOf(closeAttempt(f.store,claim));const completed=f.store.get(f.series.id),closedWork=f.store.get(work.work.id);
  const before=valueOf(spendReport(f.store,{project:f.project}));assert.equal(before.totals.calls,1);
  assert.equal(before.totals.unmeasuredCalls,1);
  const late=prepareLateModelReceipt(f.store,f.project,reference(dispatch),{process:exchange.process,launchError:exchange.launchError});
  valueOf(writeGuarded(f.store,{unit:'E4',target:dispatch.id,writes:late.writes,guards:late.guards}));f.restart();
  valueOf(await runModelCall(f.store,f.request));
  const after=valueOf(spendReport(f.store,{project:f.project}));assert.equal(after.totals.calls,1);assert.equal(after.totals.unmeasuredCalls,0);
  assert.deepEqual(f.store.get(f.series.id),completed);assert.deepEqual(f.store.get(work.work.id),closedWork);
  assert.deepEqual(f.store.get(recovered.id),recovered);
  const saved=f.store.list();f.restart();valueOf(await runModelCall(f.store,f.request));valueOf(closeAttempt(f.store,claim));
  assert.deepEqual(f.store.list(),saved);assert.equal(f.sent().length,1);
});

test('34 H1.0a a completion ledger retains the exact journal context of a genuine mechanism origin analysis',async t=>{
  const f=e4Fixture(t,'field',100_000,0,1000,true);
  f.steps([{research:{protocol:'omg-answer/v2',requestId:'$requestId',action:'cannot_answer',
    questionIds:[f.batch.items[0]!.gap],reason:'An external decision is required'},usage}]);
  valueOf(await runModelCall(f.store,f.request));
  const work=completionSnapshot(f);
  const refusal=f.store.write({id:`${unitRefusalNamespace(f.project)}h10a-origin`,kind:UNIT_REFUSAL_KIND,expected:0,
    value:{gate:'G3',refusals:[{code:'unrecognized_fixture_refusal',goal:'origin',remedy:'Identify this exact origin',
      origin:{name:'artifact_missing',stage:'layer-check',subject:'artifact:fixture',sources:[]}}]}});
  const journal=valueOf(recordRefusal(f.store,{project:f.project,source:reference(refusal)}));
  const row=journal.value.rows.find(row=>row.source.id===refusal.id)!;
  const claim={...seriesRequestOf(f.series.value),attempt:1,outcome:{reason:'refused' as const,accepting:[],cancelling:[],
    refusals:[...work.refusals,{row:row.id,name:row.code,goal:row.goal}]}};
  const closed=valueOf(closeAttempt(f.store,claim));assert.equal(closed.holds.length,1);
  const owner={kind:'mechanism' as const,mechanism:'M5:addressing' as const};
  const analysis=valueOf(recordCall(f.store,f.project,{call:'h10a:mechanism-origin',purpose:'origin-analysis',owner,
    admission:{gaps:f.gapRequest,routes:reference(f.routes),batch:f.batch.id},
    basis:{kind:'origin-hold',hold:closed.holds[0]!},series:reference(f.store.get(f.series.id)!),attempt:1,
    gaps:[{id:'origin',goal:'origin',field:'cause-and-change',consumer:owner}],
    goal:{key:'origin',questions:['What caused this exact refusal?'],result:'A proved origin or a hypothesis'},
    dispatch:f.request.dispatch,packet:{origin:closed.holds[0]!} as unknown as Json}));
  assert.equal(analysis.call.value.purpose,'origin-analysis');
  const ledger=reference(f.store.get(`om-call-ledger:${f.project}`)!),cut=reference(f.store.get(`om-refusal-journal:${f.project}`)!);
  assert.equal(checkCompletionLedger(f.store,work,ledger).ok,false,'Mechanism history cannot guess its journal');
  assert.equal(valueOf(checkCompletionLedger(f.store,work,ledger,cut)),true);
  // A different owner closes after this analysis is already in the project-wide E1 ledger.
  const input=valueOf(writeAddressing(f.store,{project:f.project,input:reference(f.input),graph:reference(f.graph),
    decisions:[{pending:structuredClone(inputDecisionWrite({project:f.project,input:reference(f.input),graph:reference(f.graph),layers:[],
      decision:{target:'discovery:encoding',field:'address',value:{consumer:'garden-consume-block',kind:'repository-fact'}}})) as Write}]}));
  const horizon=valueOf(writeHorizon(f.store,{project:f.project,input:reference(input),graph:reference(f.graph),refinement:null,available:{},
    choice:{choiceVersion:'h10a-after-analysis',features:[{outcome:'garden-result'}],excluded:[]}}));
  const gaps=valueOf(writeGaps(f.store,{project:f.project,input:reference(input),graph:reference(f.graph),horizon:reference(horizon.gate),
    operations:{proposals:[],frame:{project:f.project,level:2,graph:reference(f.graph),horizon:reference(horizon.gate),layer:null,frame:null,upper:null}},
    works:{state:'upper-not-accepted',layer:reference(f.store.get(`graph-layer:${f.project}:2`)!)}}));
  const scope={sources:structuredClone(gaps.sources) as GapRequest,records:gaps.records.map(reference)};
  const tasks=valueOf(prepareQuestionTasks(f.store,{project:f.project,gaps:scope,questions:gaps.records
    .filter(row=>row.value.gap.kind==='repository-fact'&&row.value.gap.code!=='inventory_missing'&&!row.value.gap.deferral)
    .map(row=>({gap:reference(row),requirements:[{pointer:'/contracts/0'}],resultForm:{type:'string'}}))}));
  const routes=valueOf(writeRoutes(f.store,{project:f.project,gaps:scope,tasks:tasks.tasks.map(task=>({pending:structuredClone(task.writes[0]!) as Write})),
    catalog:{paths:['e4-source.txt'],records:[]},previous:reference(f.routes)}));
  const batch=routes.value.batches.find(row=>row.model==='MC1')!,address={project:f.project,block:'garden-consume-block',line:1};
  valueOf(openSeries(f.store,{...address,slice:'after-mechanism-analysis',predecessor:null,basis:null}));
  const series=valueOf(managedOpenAttempt(f.store,{...address,attempt:1,
    goal:{key:'after-analysis',questions:batch.items.map(item=>gapLineKey(f.project,item.target,item.field)),result:'accepted-gap-fill'},
    completion:{routes:reference(routes),batches:[batch.id]}}));
  const packet=valueOf(writeQuestionPacket(f.store,{project:f.project,routes:reference(routes),batch:batch.id,environment:reference(f.configured),
    attempt:{series:reference(series),ordinal:1},previous:[]})).record;
  f.steps([{}, {research:{malformed:'a preserved technical outcome'},usage}]);
  const called=valueOf(await runModelCall(f.store,{...f.request,packet:reference(packet)}));
  assert.ok(called.diagnostic);
  const binding=valueOf(readCompletionBinding(f.store,f.project,reference(series),1))!;
  const remaining=valueOf(readCompletionWorkAt(f.store,f.project,reference(f.store.get(completionWorkId(f.project,binding.id))!)));
  assert.equal(remaining.complete,true);
  const secondClaim={...address,attempt:1,outcome:{reason:'off-form' as const,accepting:[],cancelling:[],refusals:remaining.refusals}};
  const secondClosed=valueOf(closeAttempt(f.store,secondClaim));
  const later=f.store.write({id:`${unitRefusalNamespace(f.project)}h10a-later`,kind:UNIT_REFUSAL_KIND,expected:0,
    value:{gate:'G3',refusals:[{code:'later_refusal',goal:'later',remedy:'Later independent issue',
      origin:{name:'artifact_missing',stage:'layer-check',subject:'artifact:later',sources:[]}}]}});
  valueOf(recordRefusal(f.store,{project:f.project,source:reference(later)}));
  const saved=f.store.list();f.restart();const get=f.store.get.bind(f.store);
  f.store.get=((id:string,revision?:number)=>{
    if(id===cut.id||id===ledger.id)assert.notEqual(revision,undefined,'Historical completion uses its exact ledger and journal');
    return get(id,revision);
  }) as Store['get'];
  try{
    assert.equal(valueOf(checkCompletionLedger(f.store,work,ledger,cut)),true);
    assert.deepEqual(valueOf(closeAttempt(f.store,secondClaim)),secondClosed);
  }
  finally{f.store.get=get;}
  assert.deepEqual(f.store.list(),saved);assert.equal(f.sent().length,2);
  assert.deepEqual(valueOf(closeAttempt(f.store,claim)),closed);
});


test('2 H1.0b a retained cessation address cannot downgrade the project after losing B1', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-h10b-era-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  new ProductEngine(store).execute({ type: 'create-project', project: 'era', title: 'Before B1' });
  store.write({ id: 'om-completion-cessation:era:retained', kind: 'om-completion-cessation', expected: 0, value: {} });
  for (const restart of [false, true]) {
    if (restart) { store.close(); store = new Store(path); }
    const before = store.list();
    assert.throws(() => new ProductEngine(store).projection('era'),
      (error: unknown) => error instanceof EngineError && error.code === 'record_missing');
    assert.deepEqual(store.list(), before);
  }
});

test('20 H1.0b exact MC2 remainder cessation preserves produced parts and blocks materialization without hiding siblings', async t => {
  const { prepareCompletionCessation, writeCompletionCessation, readCompletionCessationAt } = await import('../src/om/model-call.js');
  const measured = e4Fixture(t, 'node', 100_000, 0, 5000, false, true, true), f = e4Fixture(t, 'node', measured.packet.value.fullChars! - 1, 0, 5000, true, true, true);
  assert.ok(f.packet.value.plan!.assignments.length > 1);
  f.steps([{ research: e4Node(f), usage }]);
  const first = valueOf(await runModelCall(f.store, f.request)); assert.ok(first.part);
  const nextRequest = { ...f.packetRequest, previous: [{ packet: reference(f.packet), ...first.part! }] };
  const prepared = valueOf(prepareQuestionPacket(f.store, nextRequest));
  assert.equal(prepared.record.value.state, 'ready'); assert.equal(f.store.get(prepared.record.id), null);
  const originalPart = f.store.get(first.part!.result.id);
  const before = completionSnapshot(f), future = before.assignments.filter(row => row.value.kind === 'part' && row.value.position !== 0);
  const root = before.assignments.find(row => row.value.kind === 'root')!;
  valueOf(writeAddressing(f.store, { project: f.project, input: reference(f.input), graph: reference(f.graph),
    decisions: [{ pending: structuredClone(inputDecisionWrite({ project: f.project, input: reference(f.input), graph: reference(f.graph), layers: [],
      decision: { target: 'discovery:spare', field: 'address', value: { consumer: 'garden-consume-block', kind: 'repository-fact' } } })) as Write }] }));
  const rootCessation = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: reference(before.binding), assignment: reference(root) }));
  assert.equal(rootCessation.value.remainder, 'assembly'); assert.equal(completionSnapshot(f).complete, false);
  const obsolete = writeGuarded(f.store, { unit: 'E2', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards });
  assert.equal(obsolete.ok, false); assert.equal(f.store.get(prepared.record.id), null);
  const cessations = [rootCessation];
  for (const [i, part] of future.entries()) {
    const stopped = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: reference(before.binding), assignment: reference(part) }));
    assert.equal(stopped.value.remainder, 'expansion'); assert.equal(stopped.value.packet, null); assert.equal(stopped.value.physicalId, null);
    assert.equal(completionSnapshot(f).complete, i + 1 === future.length); cessations.push(stopped);
  }
  assert.deepEqual(f.store.get(first.part!.result.id), originalPart); assert.equal(f.store.list('om-part-assembly').length, 0);
  assert.equal(prepareCompletionCessation(f.store, { project: f.project, binding: reference(before.binding),
    assignment: reference(before.assignments.find(row => row.value.kind === 'part' && row.value.position === 0)!) }).ok, false);
  const closed = { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'interrupted' as const, accepting: [], cancelling: [], refusals: [] } };
  valueOf(closeAttempt(f.store, closed)); f.restart(); const history = f.store.list();
  assert.deepEqual(valueOf(await runModelCall(f.store, f.request)).part, first.part);
  const cycle = await runModelCycle(f.store, f.request); assert.equal(cycle.ok, false);
  if (!cycle.ok) assert.equal(cycle.refusal.code, 'completion_ceased');
  assert.equal(writeQuestionPacket(f.store, nextRequest).ok, false);
  for (const row of cessations) assert.deepEqual(valueOf(readCompletionCessationAt(f.store, f.project, reference(row))), row);
  valueOf(closeAttempt(f.store, closed)); assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 1);
});

test('33 H1.0b CAS loss leaves a received response retryable without irreversible refusal or another physical expense', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true); f.steps([{ research: e4Fact(f), usage }]);
  const write = f.store.writeMany.bind(f.store); let conflict = false;
  f.store.writeMany = ((writes, guards) => {
    if (!conflict && writes.some(row => row.kind === 'model-call' && (row.value as OmModelCall).om?.application === 'applied')) {
      conflict = true;
      // A legal configure in the other Store changes the guarded head, without changing the assignment.
      const other = new Store(f.database);
      try {
        const old = other.get<import('../src/runtime/environment.js').Environment>(f.configured.id)!;
        const { projectId: _project, ...config } = structuredClone(old.value);
        new ProductEngine(other).environments.configure(f.project, config, old.revision);
      } finally { other.close(); }
    }
    return write(writes, guards);
  }) as Store['writeMany'];
  const refused = await runModelCall(f.store, f.request); f.store.writeMany = write;
  assert.equal(conflict, true); assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.refusal.code, 'input_stale');
  const received = f.store.list<OmModelCall>('model-call')[0]!;
  assert.equal(received.value.om.application, 'received'); assert.equal(f.store.list('om-completion-cessation').length, 0);
  await t.test('10 received ordinary output is still I until its application transaction', () => {
    assert.equal(completionSnapshot(f).complete, false);
    assert.equal(f.store.list('om-completion-close').length, 0);
    assert.equal(f.store.list('om-assessment-result').length, 0);
  });
  const exchange = f.store.get(received.value.om.exchange!.id), e1 = f.store.history(received.value.om.call.id);
  f.restart(); const applied = valueOf(await runModelCall(f.store, f.request));
  assert.equal(applied.record.value.om.application, 'applied'); assert.deepEqual(f.store.get(received.value.om.exchange!.id), exchange);
  assert.deepEqual(f.store.history(received.value.om.call.id), e1); assert.equal(f.sent().length, 1);
  f.restart(); const history = f.store.list(); valueOf(await runModelCall(f.store, f.request)); assert.deepEqual(f.store.list(), history);
});

test('16 H1.0b a genuine H1.0a application-refused replays its exact exchange without another settlement', async t => {
  const { pathToFileURL } = await import('node:url');
  const { execFile } = await import('node:child_process');
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true, false); f.steps([{ research: e4Fact(f), usage }]);
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const loader = join(f.root, 'h10a-loader.mjs'), producer = join(f.root, 'h10a-producer.mjs'), spec = join(f.root, 'h10a.json');
  writeFileSync(loader, String.raw`import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';
let root,ts;export async function initialize(data){root=data.root;ts=(await import(data.typescript)).default;}
export async function load(url,context,next){const prefix=new URL('dist/src/',root).href;
if(url.startsWith(prefix)&&/\.js$/.test(url)){const relative='src/'+url.slice(prefix.length).replace(/\.js$/,'.ts');
const source=execFileSync('git',['show','7aa19cc95adc5c94152c17425d17b6e88d64617f:'+relative],{cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
return{format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};}return next(url,context);}`);
  writeFileSync(spec, JSON.stringify({ database: f.database, request: f.request, packet: f.packetRequest, repo: pathToFileURL(repo + '/').href }));
  writeFileSync(producer, String.raw`import{readFileSync}from'node:fs';
const spec=JSON.parse(readFileSync(process.argv[2],'utf8')),src=p=>new URL('dist/src/'+p,spec.repo).href;
const{Store}=await import(src('storage/store.js'));const{Environments}=await import(src('runtime/environment.js'));
const{runModelCall}=await import(src('om/model-call.js'));const{writeQuestionPacket}=await import(src('om/question-packet.js'));
const store=new Store(spec.database);const packet=writeQuestionPacket(store,spec.packet);if(!packet.ok)throw Error(JSON.stringify(packet));spec.request.packet={id:packet.value.record.id,revision:packet.value.record.revision,hash:packet.value.record.hash};
const write=store.writeMany.bind(store);let moved=false;
store.writeMany=(writes,guards)=>{const saved=write(writes,guards);
 if(!moved&&writes.some(w=>w.kind==='model-call'&&w.value.om?.application==='received')){moved=true;
 const old=store.get('environment:'+spec.request.project),{projectId,...config}=old.value;new Environments(store).configure(projectId,config,old.revision);}return saved;};
try{const result=await runModelCall(store,spec.request);if(!result.ok||result.value.record.value.om.application!=='application-refused')throw Error(JSON.stringify(result));}
finally{store.close();}`);
  const registration = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)}, {data:${JSON.stringify({
    root: pathToFileURL(repo + '/').href, typescript: pathToFileURL(join(repo, 'node_modules/typescript/lib/typescript.js')).href })}});`;
  await new Promise<void>((resolve, reject) => execFile(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(registration)}`, producer, spec],
    { cwd: repo, timeout: 90000, maxBuffer: 1000000 }, (error, _out, stderr) => error ? reject(new Error(stderr || error.message)) : resolve()));
  const old = f.store.list<OmModelCall>('model-call')[0]!;
  f.request.packet = reference(f.store.get(f.request.packet.id)!);
  assert.equal(old.value.om.application, 'application-refused');
  assert.equal(valueOf(readModelCallState(f.store, { project: f.project, record: reference(old) })).state, 'application-refused');
  const e1 = f.store.history(old.value.om.call.id), physical = f.store.history(old.id), exchange = f.store.get(old.value.om.exchange!.id);
  f.restart(); const applied = valueOf(await runModelCall(f.store, f.request));
  assert.equal(applied.record.value.om.application, 'applied');
  assert.deepEqual(applied.record.value.om.resume, { contract: 'om-model-application-resume/v1', previous: reference(old) });
  assert.deepEqual(f.store.history(old.id).slice(0, -1), physical); assert.deepEqual(f.store.history(old.value.om.call.id), e1);
  assert.deepEqual(f.store.get(old.value.om.exchange!.id), exchange);
  assert.equal(valueOf(readModelCallState(f.store, { project: f.project, record: reference(old) })).state, 'application-refused');
  f.restart(); const history = f.store.list();
  assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), valueOf(readModelCall(f.store, { project: f.project, record: reference(applied.record) })));
  assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 1);
});

function completionE1(f: ReturnType<typeof e4Fixture>, packet = f.packet, config = f.configured) {
  const payload = packet.value.packet as Record<string, Json> & { requestId: string; purpose: 'model-research' | 'model-design' };
  return { call: payload.requestId, purpose: payload.purpose, basis: null, block: f.series.value.block!,
    series: reference(f.series), attempt: 1, goal: f.series.value.attempts[0]!.goal,
    dispatch: { adapter: reference(f.adapter), config: reference(config) }, packet: payload,
    gaps: f.batch.items.flatMap(item => item.consumers.map(consumer => ({ id: item.target, goal: item.target, field: item.field, consumer }))) };
}

test('35 H1.0b candidate E2 materializations preserve one executable plan selected atomically with E1', async t => {
  const { readCompletionPacketAt } = await import('../src/om/model-call.js');
  for (const kind of ['fact', 'node'] as const) await t.test(kind, async child => {
    const f = e4Fixture(child, kind, 100_000, 0, 5000, true), initial = completionSnapshot(f);
    assert.equal(initial.assignments.length, 1); assert.equal(initial.complete, false);
    const configured = f.environment(90_000), packet = valueOf(writeQuestionPacket(f.store,
      { ...f.packetRequest, environment: reference(configured) })).record;
    const candidates = f.store.list('om-completion-packet'), unselected = completionSnapshot(f);
    assert.equal(candidates.length, 2); assert.equal(unselected.assignments.length, 1);
    assert.equal(unselected.complete, false); assert.equal(f.store.list('call-record').length, 0);
    assert.equal(recordCall(f.store, f.project, completionE1(f)).ok, false);
    const admitted = valueOf(recordCall(f.store, f.project, completionE1(f, packet, configured)));
    const selected = completionSnapshot(f), plan = selected.assignments.map(reference);
    assert.equal(selected.assignments.filter(row => row.value.kind === 'part').length, packet.value.plan?.assignments.length ?? 1);
    assert.equal(selected.complete, false); assert.equal(f.store.list('model-call').length, 0);
    const before = f.store.list();
    valueOf(writeQuestionPacket(f.store, f.packetRequest));
    assert.deepEqual(f.store.list(), before, 'An exact old candidate repeats historically without changing the choice');
    const thirdConfig = f.environment(80_000);
    assert.equal(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(thirdConfig) }).ok, false);
    assert.deepEqual(completionSnapshot(f).assignments.map(reference), plan);
    f.restart();
    for (const row of candidates) valueOf(readCompletionPacketAt(f.store, f.project, reference(row)));
    assert.deepEqual(valueOf(recordCall(f.store, f.project, completionE1(f, packet, configured))).call, admitted.call);
    assert.equal((await runModelCall(f.store, f.request)).ok, false);
    assert.equal(f.sent().length, 0);
  });
});

test('35 H1.0b a racing different E1 choice writes exactly one plan and one unpaid call', t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true), write = f.store.writeMany.bind(f.store);
  let raced = false, winning: ReturnType<typeof completionE1> | null = null;
  f.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(row => row.kind === 'call-record')) {
      raced = true;
      const config = f.environment(90_000), other = new Store(f.database);
      try {
        const packet = valueOf(writeQuestionPacket(other, { ...f.packetRequest, environment: reference(config) })).record;
        winning = completionE1(f, packet, config);
        valueOf(recordCall(other, f.project, winning));
      } finally { other.close(); }
    }
    return write(writes, guards);
  }) as Store['writeMany'];
  const losing = recordCall(f.store, f.project, completionE1(f)); f.store.writeMany = write;
  assert.equal(raced, true); assert.equal(losing.ok, false);
  assert.equal(f.store.list('call-record').length, 1); assert.equal(f.store.list('model-call').length, 0);
  assert.equal(completionSnapshot(f).assignments.filter(row => row.value.kind === 'part').length, 1);
  f.restart(); const history = f.store.list(); valueOf(recordCall(f.store, f.project, winning!));
  assert.equal(recordCall(f.store, f.project, completionE1(f)).ok, false);
  assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 0);
});

test('32 H1.0b exact accepted frame ends a required absence and ceases only the selected unclaimed assignment', async t => {
  const { prepareCompletionCause, writeCompletionCessation, readCompletionCause, readCompletionCessationAt } = await import('../src/om/model-call.js');
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  valueOf(recordCall(f.store, f.project, completionE1(f)));
  const before = completionSnapshot(f), assignment = before.assignments.find(row => row.value.kind === 'part')!;
  const frameRequest = structuredClone(f.gapRequest.sources.operations.frame);
  const frame = valueOf(prepareFrame(f.store, frameRequest)), graph = structuredClone(f.fullGraph);
  graph.nodes.find(row => row.id === 'garden-produce-operation')!.ports.push({ id: 'out-side', direction: 'out', contract: 'garden-contract' });
  graph.nodes.find(row => row.id === 'garden-consume-operation')!.ports.push({ id: 'in-side', direction: 'in', contract: 'garden-contract' });
  graph.connectors.find(row => row.id === 'garden-side-flow')!.bindings.push({ level: 2, producer: { node: 'garden-produce-operation', port: 'out-side' }, consumers: [{ node: 'garden-consume-operation', port: 'in-side' }], anchor: null });
  const projected = projectGraph(graph, 2);
  const fills = valueOf(fillObligations(frame.upper as Graph, frame.scope as FrameScope,
    { graph, reference: { ...reference(f.graph), hash: hashJson(graph) }, frame: null }, frame.upperRef, 2));
  const proposal = f.store.write({ id: `om-proposal:${f.project}:h10b-frame`, kind: 'layer-proposal', expected: 0, value: {
    base: { graph: reference(f.graph), frame: null }, level: 2, source: 'decision', status: 'proposed',
    nodes: projected.nodes.filter(row => row.kind === 'operation'),
    fills: fills.fills.map(row => ({ obligation: row.obligation, node: row.node, ...(row.port === undefined ? {} : { port: row.port }) })),
    localConnectors: projected.connectors.map(row => ({ ...row, bindings: row.bindings.filter(binding => binding.level === 2) })).filter(row => row.bindings.length),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    removes: [], replaces: [], redefines: [] } });
  const candidate = valueOf(writeCandidate(f.store, { frame: frameRequest, proposals: [reference(proposal)] }));
  assert.equal(candidate.state, 'candidate'); if (candidate.state !== 'candidate') assert.fail('Full frame must be proposed');
  const accepted = valueOf(settleCandidate(f.store, { project: f.project, level: 2, candidate: reference(candidate.record),
    outcome: { gate: 'G3', candidate: reference(candidate.record), graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  assert.equal(accepted.state, 'accepted');
  const cause = valueOf(prepareCompletionCause(f.store, f.project, reference(assignment))).cause!;
  assert.equal(cause.kind, 'required-absence-ended');
  const ceased = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: reference(before.binding), assignment: reference(assignment) }));
  assert.equal(ceased.value.disposition, 'not-dispatched'); assert.equal(completionSnapshot(f).complete, true);
  f.restart(); const history = f.store.list();
  valueOf(readCompletionCause(f.store, f.project, reference(assignment), cause));
  assert.deepEqual(valueOf(readCompletionCessationAt(f.store, f.project, reference(ceased))), ceased);
  assert.equal((await runModelCall(f.store, f.request)).ok, false); assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 0);
});

test('C47 H1.0b managed M5 completes its own ceased remainder without inventing block participation', async t => {
  const { writeCompletionCessation, readCompletionCessationAt } = await import('../src/om/model-call.js');
  const f = e4Fixture(t, 'field', 100_000, 0, 5000, true), before = completionSnapshot(f);
  const root = before.assignments.find(row => row.value.kind === 'root')!;
  valueOf(writeAddressing(f.store, { project: f.project, input: reference(f.input), graph: reference(f.graph),
    decisions: [{ pending: structuredClone(inputDecisionWrite({ project: f.project, input: reference(f.input), graph: reference(f.graph), layers: [],
      decision: { target: 'discovery:encoding', field: 'address', value: { consumer: 'garden-consume-block', kind: 'repository-fact' } } })) as Write }] }));
  const ceased = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: reference(before.binding), assignment: reference(root) }));
  assert.equal(ceased.value.cause.kind, 'required-record-replaced'); assert.equal(completionSnapshot(f).complete, true);
  const close = { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'interrupted' as const, accepting: [], cancelling: [], refusals: [] } };
  const closed = valueOf(closeAttempt(f.store, close)); f.restart(); const history = f.store.list();
  assert.deepEqual(valueOf(readCompletionCessationAt(f.store, f.project, reference(ceased))), ceased);
  assert.deepEqual(valueOf(closeAttempt(f.store, close)), closed);
  assert.equal((await runModelCall(f.store, f.request)).ok, false); assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 0);
});

test('C31 H1.0b an applied source request can cease its continuation without a synthetic cycle terminal', async t => {
  const { writeCompletionCessation, readCompletionCessationAt } = await import('../src/om/model-call.js');
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]), usage }]);
  const first = valueOf(await runModelCall(f.store, f.request)); assert.equal(first.outcome?.kind, 'need-source');
  const before = completionSnapshot(f), marker = first.record.value.om.completionOwner!;
  f.environment(90_000);
  const ceased = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: marker.binding, assignment: marker.assignment }));
  assert.equal(ceased.value.disposition, 'branch-ceased'); assert.equal(ceased.value.remainder, 'continuation');
  assert.equal(ceased.value.physical, null); assert.equal(completionSnapshot(f).complete, true);
  const close = { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'interrupted' as const, accepting: [], cancelling: [], refusals: before.refusals } };
  valueOf(closeAttempt(f.store, close)); f.restart(); const history = f.store.list();
  assert.deepEqual(valueOf(readCompletionCessationAt(f.store, f.project, reference(ceased))), ceased);
  assert.deepEqual(valueOf(await runModelCall(f.store, f.request)).record, first.record);
  const cycle = await runModelCycle(f.store, f.request); assert.equal(cycle.ok, false);
  if (!cycle.ok) { assert.equal(cycle.refusal.code, 'completion_ceased'); assert.deepEqual(cycle.refusal.at.ref, reference(ceased)); }
  assert.deepEqual(f.store.list(), history); assert.equal(f.store.list('om-model-cycle').length, 0); assert.equal(f.sent().length, 1);
});


test('3 H1.0b ordinary paid reviewer output binds only its own role when Environment changes', async t => {
  const { readCompletionCessationAt } = await import('../src/om/model-call.js');
  for (const changed of ['implementer', 'reviewer'] as const) await t.test(changed, async t => {
    const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true); f.steps([{ research: e4Fact(f), usage }]);
    const request = { ...f.request, role: 'reviewer' as const };
    const write = f.store.writeMany.bind(f.store); let moved = false;
    f.store.writeMany = ((writes, guards) => {
      const rows = write(writes, guards);
      if (!moved && writes.some(row => row.kind === 'model-call' && (row.value as OmModelCall).om?.application === 'received')) {
        moved = true;
        const { projectId: _project, ...config } = structuredClone(f.configured.value);
        config[changed].model = 'changed-binding';
        new ProductEngine(f.store).environments.configure(f.project, config, f.configured.revision);
      }
      return rows;
    }) as Store['writeMany'];
    const result = await runModelCall(f.store, request); f.store.writeMany = write;
    assert.equal(moved, true);
    if (changed === 'implementer') {
      assert.equal(valueOf(result).record.value.om.application, 'applied');
      assert.equal(f.store.list('om-completion-cessation').length, 0);
    } else {
      assert.equal(result.ok, false); if (!result.ok) assert.equal(result.refusal.code, 'completion_ceased');
      const cessation = f.store.list('om-completion-cessation')[0]!;
      valueOf(readCompletionCessationAt(f.store, f.project, reference(cessation)));
    }
    const history = f.store.list(); f.restart();
    const repeat = await runModelCall(f.store, request); assert.equal(repeat.ok, result.ok);
    assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 1);
  });
});

test('3 H1.0b equivalent configure after selected E1 preserves ordinary, cycle and continuation first claim', async t => {
  const { prepareCompletionCause, prepareCompletionCessation } = await import('../src/om/model-call.js');
  for (const mode of ['call', 'cycle', 'continuation'] as const) await t.test(mode, async child => {
    const f = e4Fixture(child, 'fact', 100_000, 0, 5000, true);
    let packet = f.packet;
    if (mode === 'continuation') {
      f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]), usage },
        { research: e4Fact(f), usage }]);
      const first = valueOf(await runModelCall(f.store, f.request));
      const basis = { project: f.project, packet: f.request.packet, call: first.call, response: first.response! };
      const delivery = valueOf(deliverModelSources(f.store, basis));
      packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest,
        continuation: { packet: basis.packet, call: basis.call, response: basis.response, deliveries: [...delivery.deliveries] } })).record;
    } else f.steps([{ research: e4Fact(f), usage }]);
    const e1 = completionE1(f, packet), selected = valueOf(recordCall(f.store, f.project, e1));
    const work = completionSnapshot(f), assignments = work.assignments.map(reference);
    const part = work.assignments.find(row => row.value.kind === (mode === 'continuation' ? 'continuation' : 'part'))!;
    const current = f.environment(); f.restart();
    const before = f.store.list();
    assert.equal(valueOf(recordCall(f.store, f.project, e1)).repeated, true);
    assert.deepEqual(f.store.list(), before, 'Direct E1 replay retains the exact chosen plan');
    assert.equal(valueOf(prepareCompletionCause(f.store, f.project, reference(part))).cause, null);
    const refused = prepareCompletionCessation(f.store, { project: f.project, binding: reference(work.binding), assignment: reference(part) });
    assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.refusal.code, 'completion_cause_unproved');
    const request = { ...f.request, packet: reference(packet) };
    const outcome = mode === 'cycle' ? valueOf(await runModelCycle(f.store, request)).last : valueOf(await runModelCall(f.store, request));
    assert.equal(outcome.outcome?.kind, 'fact-candidates');
    assert.deepEqual(outcome.call, reference(selected.call));
    assert.deepEqual(outcome.record.value.om.request, request);
    assert.deepEqual(f.store.get(selected.call.id, 1), selected.call);
    assert.ok(assignments.every(ref => completionSnapshot(f).assignments.some(row => canonical(reference(row)) === canonical(ref))));
    const exchange = f.store.get<{ admissionGuards: Ref[] }>(outcome.record.value.om.exchange!.id)!;
    assert.ok(exchange.value.admissionGuards.some(ref => canonical(ref) === canonical(reference(current))));
    f.restart(); const history = f.store.list();
    const replay = mode === 'cycle' ? valueOf(await runModelCycle(f.store, request)).last : valueOf(await runModelCall(f.store, request));
    assert.deepEqual(replay.record, outcome.record); assert.deepEqual(f.store.list(), history);
    assert.equal(f.sent().length, mode === 'continuation' ? 2 : 1);
  });
});

test('34 H1.0b equivalent preclaim admission guards the current Environment against a second Store', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  const selected = valueOf(recordCall(f.store, f.project, completionE1(f)));
  f.environment(); f.steps([{ research: e4Fact(f), usage }]);
  const write = f.store.writeMany.bind(f.store); let raced = false;
  f.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(row => row.kind === 'model-call' && (row.value as OmModelCall).status === 'running')) {
      raced = true;
      const other = new Store(f.database);
      try {
        const head = other.get<import('../src/runtime/environment.js').Environment>(f.configured.id)!;
        const { projectId: _project, ...config } = structuredClone(head.value);
        new ProductEngine(other).environments.configure(f.project, config, head.revision);
      } finally { other.close(); }
    }
    return write(writes, guards);
  }) as Store['writeMany'];
  const first = await runModelCall(f.store, f.request); f.store.writeMany = write;
  assert.equal(raced, true); assert.equal(first.ok, false); if (!first.ok) assert.equal(first.refusal.code, 'input_stale');
  assert.equal(f.sent().length, 0); assert.equal(f.store.list('model-call').length, 0);
  assert.deepEqual(f.store.get(selected.call.id), selected.call);
  assert.equal(f.store.list('om-completion-cessation').length, 0);
  f.restart(); assert.equal(valueOf(await runModelCall(f.store, f.request)).outcome?.kind, 'fact-candidates');
  assert.equal(f.sent().length, 1);
});

test('4 H1.0b changed preclaim Environment is a proved cause while corrupt replacement is an integrity refusal', async t => {
  const { prepareCompletionCause, writeCompletionCessation } = await import('../src/om/model-call.js');
  for (const kind of ['changed', 'corrupt'] as const) await t.test(kind, async child => {
    const f = e4Fixture(child, 'fact', 100_000, 0, 5000, true);
    const selected = valueOf(recordCall(f.store, f.project, completionE1(f))), work = completionSnapshot(f);
    const part = work.assignments.find(row => row.value.kind === 'part')!;
    if (kind === 'changed') f.environment(90_000);
    else f.store.write({ id: f.configured.id, kind: 'environment', expected: f.configured.revision,
      value: { ...structuredClone(f.configured.value), reviewer: { ...f.configured.value.reviewer, effort: 'invalid' } } });
    const before = f.store.list(), sent = await runModelCall(f.store, f.request);
    assert.equal(sent.ok, false); assert.equal(f.sent().length, 0); assert.deepEqual(f.store.list(), before);
    const cause = prepareCompletionCause(f.store, f.project, reference(part));
    const cease = writeCompletionCessation(f.store, { project: f.project, binding: reference(work.binding), assignment: reference(part) });
    if (kind === 'changed') {
      assert.equal(valueOf(cause).cause?.kind, 'required-record-replaced');
      assert.equal(valueOf(cease).value.disposition, 'not-dispatched');
    } else { assert.equal(cause.ok, false); assert.equal(cease.ok, false); }
    assert.deepEqual(f.store.get(selected.call.id), selected.call);
    f.restart(); assert.equal((await runModelCall(f.store, f.request)).ok, false); assert.equal(f.sent().length, 0);
  });
});

test('C28 H1.0b selected continuation uses one compatible admission before E2, direct E1 and cycle', async t => {
  for (const stage of ['before-E2', 'before-E1', 'cycle', 'E2-race', 'E1-race'] as const) await t.test(stage, async child => {
    const f = e4Fixture(child, 'fact', 100_000, 0, 5000, true);
    f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]), usage },
      { research: e4Fact(f), usage }]);
    const first = valueOf(await runModelCall(f.store, f.request));
    const basis = { project: f.project, packet: f.request.packet, call: first.call, response: first.response! };
    const delivery = valueOf(deliverModelSources(f.store, basis));
    const nextRequest: QuestionPacketRequest = { ...f.packetRequest,
      continuation: { packet: basis.packet, call: basis.call, response: basis.response, deliveries: [...delivery.deliveries] } };
    if (stage === 'before-E1') valueOf(writeQuestionPacket(f.store, nextRequest));
    f.environment(); f.restart();
    const write = f.store.writeMany.bind(f.store); let raced = false;
    if (stage.endsWith('-race')) f.store.writeMany = ((writes, guards) => {
      if (!raced && writes.some(row => row.kind === (stage === 'E2-race' ? 'question-packet' : 'call-record'))) {
        raced = true; const other = new Store(f.database);
        try {
          const head = other.get<import('../src/runtime/environment.js').Environment>(f.configured.id)!;
          const { projectId: _project, ...config } = structuredClone(head.value);
          new ProductEngine(other).environments.configure(f.project, config, head.revision);
        } finally { other.close(); }
      }
      return write(writes, guards);
    }) as Store['writeMany'];
    if (stage === 'cycle') {
      const cycle = valueOf(await runModelCycle(f.store, f.request));
      assert.equal(cycle.record.value.steps.length, 2); assert.equal(cycle.last.outcome?.kind, 'fact-candidates');
    } else {
      const prepared = prepareQuestionPacket(f.store, nextRequest);
      assert.equal(prepared.ok, true);
      let materialized = writeQuestionPacket(f.store, nextRequest);
      if (stage === 'E2-race') {
        assert.equal(raced, true); assert.equal(materialized.ok, false);
        if (!materialized.ok) assert.equal(materialized.refusal.code, 'input_stale');
        assert.equal(f.store.get(valueOf(prepared).record.id), null); assert.equal(f.sent().length, 1);
        f.store.writeMany = write; materialized = writeQuestionPacket(f.store, nextRequest);
      }
      const packet = valueOf(materialized).record;
      assert.deepEqual(packet.value.request.environment, reference(f.configured));
      const e1 = completionE1(f, packet);
      let admitted = recordCall(f.store, f.project, e1);
      if (stage === 'E1-race') {
        assert.equal(raced, true); assert.equal(admitted.ok, false);
        if (!admitted.ok) assert.equal(admitted.refusal.code, 'input_stale');
        assert.equal(f.store.list('call-record').length, 1); assert.equal(f.sent().length, 1);
        f.store.writeMany = write; admitted = recordCall(f.store, f.project, e1);
      }
      const registered = valueOf(admitted); assert.notEqual(registered.call.id, first.call.id);
      const before = f.store.list(); assert.equal(valueOf(recordCall(f.store, f.project, e1)).repeated, true);
      assert.deepEqual(f.store.list(), before);
      const last = valueOf(await runModelCall(f.store, { ...f.request, packet: reference(packet) }));
      assert.equal(last.outcome?.kind, 'fact-candidates');
    }
    f.store.writeMany = write;
    assert.equal(f.sent().length, 2); assert.equal(f.store.list('call-record').length, 2);
    f.restart(); const cycle = valueOf(await runModelCycle(f.store, f.request));
    const history = f.store.list(); f.restart();
    assert.deepEqual(valueOf(await runModelCycle(f.store, f.request)).record, cycle.record);
    assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 2);
  });
});

test('C31 H1.0b equivalent configuration preserves the next exact MC2 part before its E1', async t => {
  const measured = e4Fixture(t, 'node', 100_000, 0, 5000);
  const f = e4Fixture(t, 'node', measured.packet.value.fullChars! - 1, 0, 5000, true);
  assert.ok(f.packet.value.plan!.assignments.length > 1);
  const firstBody = e4Node(f); f.steps([{ research: firstBody, usage }]);
  const first = valueOf(await runModelCall(f.store, f.request)); assert.ok(first.part);
  const nextRequest = { ...f.packetRequest, previous: [{ packet: f.request.packet, ...first.part! }] };
  f.environment(); f.restart();
  const next = valueOf(writeQuestionPacket(f.store, nextRequest)).record;
  assert.deepEqual(next.value.plan!.assignments, f.packet.value.plan!.assignments);
  assert.equal(next.value.plan!.position, 1);
  const e1 = completionE1(f, next);
  const questionIds = new Set(((next.value.packet as Record<string, Json>).questions as { id: string }[]).map(row => row.id));
  e1.gaps = f.batch.items.filter(item => questionIds.has(item.gap)).flatMap(item => item.consumers.map(consumer =>
    ({ id: item.target, goal: item.target, field: item.field, consumer })));
  const admitted = valueOf(recordCall(f.store, f.project, e1));
  f.steps([{ research: firstBody, usage }, { research: e4Node(f, next as Revision<QuestionPacketRecord>), usage }]);
  const second = valueOf(await runModelCall(f.store, { ...f.request, packet: reference(next) }));
  assert.ok(second.part); assert.notEqual(second.call.id, first.call.id); assert.deepEqual(second.call, reference(admitted.call));
  f.restart(); const history = f.store.list();
  valueOf(await runModelCall(f.store, { ...f.request, packet: reference(next) }));
  assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 2);
});

test('C49 H1.0b ordinary E1 compatibility does not authorize a changed reviewer role at claim', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]), usage }, { research: e4Fact(f), usage }]);
  const first = valueOf(await runModelCall(f.store, f.request));
  const delivery = valueOf(deliverModelSources(f.store, { project: f.project, packet: f.request.packet, call: first.call, response: first.response! }));
  const nextRequest = { ...f.packetRequest, continuation: { packet: f.request.packet, call: first.call,
    response: first.response!, deliveries: [...delivery.deliveries] } };
  const { projectId: _project, ...config } = structuredClone(f.configured.value);
  config.reviewer.model = 'changed-reviewer';
  new Environments(f.store).configure(f.project, config, f.configured.revision);
  const next = valueOf(writeQuestionPacket(f.store, nextRequest)).record;
  valueOf(recordCall(f.store, f.project, completionE1(f, next)));
  const wrong = await runModelCall(f.store, { ...f.request, packet: reference(next), role: 'reviewer' });
  assert.equal(wrong.ok, false); if (!wrong.ok) assert.equal(wrong.refusal.code, 'input_stale');
  assert.equal(f.sent().length, 1); assert.equal(f.store.list('model-call').length, 1);
  assert.equal(valueOf(await runModelCall(f.store, { ...f.request, packet: reference(next) })).outcome?.kind, 'fact-candidates');
  assert.equal(f.sent().length, 2);
});

test('35 H1.0b equivalent configuration grants no privilege to an unselected old candidate', t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true), configured = f.environment();
  const next = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(configured) })).record;
  const chosen = valueOf(recordCall(f.store, f.project, completionE1(f, next, configured)));
  f.environment(); f.restart(); const history = f.store.list();
  const other = recordCall(f.store, f.project, completionE1(f));
  assert.equal(other.ok, false); if (!other.ok) assert.equal(other.refusal.code, 'completion_conflict');
  assert.deepEqual(f.store.list(), history); assert.deepEqual(f.store.get(chosen.call.id), chosen.call);
  assert.equal(f.sent().length, 0);
});

test('C31 H1.0b restored compatible environment cannot materialize or register a ceased continuation', async t => {
  const { writeCompletionCessation } = await import('../src/om/model-call.js');
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
  f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]), usage }]);
  const first = valueOf(await runModelCall(f.store, f.request));
  const delivery = valueOf(deliverModelSources(f.store, { project: f.project, packet: f.request.packet, call: first.call, response: first.response! }));
  const nextRequest = { ...f.packetRequest, continuation: { packet: f.request.packet, call: first.call,
    response: first.response!, deliveries: [...delivery.deliveries] } };
  const next = valueOf(writeQuestionPacket(f.store, nextRequest)).record, marker = first.record.value.om.completionOwner!;
  f.environment(90_000);
  valueOf(writeCompletionCessation(f.store, { project: f.project, binding: marker.binding, assignment: marker.assignment }));
  f.environment(); f.restart();
  for (const closed of [false, true]) {
    if (closed) valueOf(closeAttempt(f.store, { ...seriesRequestOf(f.series.value), attempt: 1,
      outcome: { reason: 'interrupted', accepting: [], cancelling: [], refusals: [] } }));
    const history = f.store.list();
    assert.equal(valueOf(writeQuestionPacket(f.store, nextRequest)).existing, true);
    assert.equal(prepareQuestionPacket(f.store, nextRequest).ok, false);
    assert.equal(recordCall(f.store, f.project, completionE1(f, next)).ok, false);
    assert.equal((await runModelCycle(f.store, f.request)).ok, false);
    assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 1);
  }
});

// №1601: the role is a set before claim, and exact physical evidence selects one role afterwards.
test('3 H1.0b staged ordinary roles agree at cessation, historical reading and physical entry', async t => {
  const { prepareCompletionCause, readCompletionCause, writeCompletionCessation, readCompletionCessationAt } = await import('../src/om/model-call.js');
  for (const kind of ['fact', 'node'] as const) for (const stage of ['E2', 'E1', 'claim', 'received'] as const)
    for (const changed of ['implementer', 'reviewer', 'both', 'common', 'none'] as const)
      for (const selected of (stage === 'claim' || stage === 'received' ? ['implementer', 'reviewer'] as const : [changed === 'implementer' ? 'reviewer' : 'implementer'] as const))
        await t.test(`${kind}/${stage}/${changed}/${selected}`, async child => {
          const f = e4Fixture(child, kind, 100_000, 0, 5000, true);
          f.steps([{ research: kind === 'fact' ? e4Fact(f) : e4Node(f), usage }]);
          const request = { ...f.request, role: selected };
          if (stage !== 'E2') valueOf(recordCall(f.store, f.project, completionE1(f)));
          if (stage === 'claim' || stage === 'received') {
            const write = f.store.writeMany.bind(f.store); let stopped = false;
            f.store.writeMany = ((writes, guards) => {
              const rows = write(writes, guards);
              if (!stopped && writes.some(row => row.kind === 'model-call'
                && (row.value as OmModelCall).om?.application === (stage === 'claim' ? 'running' : 'received'))) {
                stopped = true; throw new Error('role matrix durable boundary');
              }
              return rows;
            }) as Store['writeMany'];
            try { await assert.rejects(runModelCall(f.store, request), /role matrix durable boundary/); }
            finally { f.store.writeMany = write; }
            assert.equal(stopped, true);
          }
          const work = completionSnapshot(f), assignment = work.assignments.find(row => row.value.kind === (stage === 'E2' ? 'root' : 'part'))!;
          const { projectId: _project, ...config } = structuredClone(f.configured.value);
          if (changed === 'implementer' || changed === 'both') config.implementer.model = 'changed-implementer';
          if (changed === 'reviewer' || changed === 'both') config.reviewer.model = 'changed-reviewer';
          if (changed === 'common') config.timeoutMs += 1000;
          if (changed === 'none') config.fullCheck.args = ['-v'];
          const replacement = f.engine.environments.configure(f.project, config, f.configured.revision);
          const blocks = stage !== 'E2' && (changed === 'common' || changed === 'both'
            || ((stage === 'claim' || stage === 'received') && changed === selected));
          f.restart();
          const proof = valueOf(prepareCompletionCause(f.store, f.project, reference(assignment))).cause;
          assert.equal(proof !== null, blocks);
          if (proof) {
            assert.equal(proof.kind, 'required-record-replaced');
            if (proof.kind !== 'required-record-replaced' || proof.prerequisite.kind !== 'environment') assert.fail('Environment cause');
            assert.equal(proof.prerequisite.role, stage === 'E1' ? null : selected);
            valueOf(readCompletionCause(f.store, f.project, reference(assignment), proof));
            assert.equal(readCompletionCause(f.store, f.project, reference(assignment), {
              ...proof, prerequisite: { ...proof.prerequisite, role: stage === 'E1' ? 'implementer' : null },
            }).ok, false, 'A caller cannot select another stage for the saved cause');
          } else if (stage !== 'E2') {
            const physical = f.store.list<OmModelCall>('model-call')[0];
            const falseCause = { kind: 'required-record-replaced' as const, prerequisite: { kind: 'environment' as const,
              source: reference(f.configured), context: assignment.value.source,
              physical: physical ? reference(f.store.get(physical.id, 1)!) : null,
              role: stage === 'E1' ? null : selected }, replacement: reference(replacement), proof: null };
            assert.equal(readCompletionCause(f.store, f.project, reference(assignment), falseCause).ok, false);
            if (stage === 'E1' && (changed === 'implementer' || changed === 'reviewer'))
              assert.equal(readCompletionCause(f.store, f.project, reference(assignment), {
                ...falseCause, prerequisite: { ...falseCause.prerequisite, role: changed },
              }).ok, false, 'The previous assumed-role proof must fail at historical reading too');
          }
          const before = f.store.list(), ceaseRequest = { project: f.project, binding: reference(work.binding), assignment: reference(assignment) };
          const ceased = writeCompletionCessation(f.store, ceaseRequest);
          assert.equal(ceased.ok, blocks && stage !== 'claim');
          if (ceased.ok) {
            assert.equal(ceased.value.value.disposition, stage === 'received' ? 'branch-ceased' : 'not-dispatched');
            f.environment(); f.restart();
            valueOf(readCompletionCause(f.store, f.project, reference(assignment), proof!));
            assert.deepEqual(valueOf(readCompletionCessationAt(f.store, f.project, reference(ceased.value))), ceased.value);
            if (stage === 'E1') {
              const closed = closeAttempt(f.store, { ...seriesRequestOf(f.series.value), attempt: 1,
                outcome: { reason: 'interrupted', accepting: [], cancelling: [], refusals: [] } });
              if (kind === 'fact') valueOf(closed);
              else assert.equal(closed.ok, false, 'A stopped MC2 part does not manufacture the still-missing assembly disposition');
            }
            const closedWork = f.store.get(work.work.id), closedSeries = f.store.get(f.series.id);
            const repeated = await runModelCall(f.store, request); assert.equal(repeated.ok, false);
            if (!repeated.ok) assert.equal(repeated.refusal.code, 'completion_ceased');
            assert.deepEqual(f.store.get(work.work.id), closedWork); assert.deepEqual(f.store.get(f.series.id), closedSeries);
            // The first replay may settle the exact paid receipt after the simulated stop; subsequent reads are inert.
            const history = f.store.list(); f.restart();
            assert.equal((await runModelCall(f.store, request)).ok, false); assert.deepEqual(f.store.list(), history);
            assert.equal(f.sent().length, stage === 'received' ? 1 : 0);
          } else {
            assert.deepEqual(f.store.list(), before);
            if (stage === 'claim') {
              assert.equal(ceased.refusal.code, blocks ? 'completion_claim_exists' : 'completion_cause_unproved');
              assert.equal((await runModelCall(f.store, request)).ok, false); assert.equal(f.sent().length, 0);
              if (proof) { f.environment(); f.restart(); valueOf(readCompletionCause(f.store, f.project, reference(assignment), proof)); }
            } else {
              assert.equal(ceased.refusal.code, 'completion_cause_unproved');
              let executable = request;
              if (stage === 'E2') {
                // Before the first E1 this is still a candidate, not an immutable selected plan.
                const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(replacement) })).record;
                executable = { ...request, packet: reference(packet), dispatch: { ...request.dispatch, config: reference(replacement) } };
              } else if (stage === 'E1') {
                assert.equal(closeAttempt(f.store, { ...seriesRequestOf(f.series.value), attempt: 1,
                  outcome: { reason: 'interrupted', accepting: [], cancelling: [], refusals: [] } }).ok, false);
              }
              const result = valueOf(await runModelCall(f.store, executable));
              assert.equal(result.record.value.om.application, 'applied');
              if (kind === 'fact') assert.equal(result.outcome?.kind, 'fact-candidates'); else assert.ok(result.part);
              assert.equal(f.store.list('om-completion-cessation').length, 0); assert.equal(f.sent().length, 1);
              const history = f.store.list(); f.restart();
              assert.deepEqual(valueOf(await runModelCall(f.store, executable)).record, result.record);
              assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 1);
            }
          }
        });
});

test('C31 H1.0b selected MC2 E2 without E1 keeps every still compatible role', async t => {
  const { prepareCompletionCause, writeCompletionCessation, readCompletionCause, readCompletionCessationAt } = await import('../src/om/model-call.js');
  const measured = e4Fixture(t, 'node', 100_000, 0, 5000);
  for (const changed of ['implementer', 'reviewer', 'both', 'common', 'none'] as const) await t.test(changed, async child => {
    const f = e4Fixture(child, 'node', measured.packet.value.fullChars! - 1, 0, 5000, true);
    const firstBody = e4Node(f); f.steps([{ research: firstBody, usage }]);
    const first = valueOf(await runModelCall(f.store, f.request)); assert.ok(first.part);
    const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, previous: [{ packet: f.request.packet, ...first.part! }] })).record;
    assert.equal(packet.value.plan!.position, 1);
    const work = completionSnapshot(f), assignment = work.assignments.find(row => row.value.kind === 'part' && row.value.position === 1)!;
    assert.equal(f.store.list('call-record').length, 1, 'The second E2 is materialized, but its E1 does not exist');
    const { projectId: _project, ...config } = structuredClone(f.configured.value);
    if (changed === 'implementer' || changed === 'both') config.implementer.model = 'changed-implementer';
    if (changed === 'reviewer' || changed === 'both') config.reviewer.model = 'changed-reviewer';
    if (changed === 'common') config.timeoutMs += 1000;
    if (changed === 'none') config.fullCheck.args = ['-v'];
    f.engine.environments.configure(f.project, config, f.configured.revision); f.restart();
    const proof = valueOf(prepareCompletionCause(f.store, f.project, reference(assignment))).cause;
    const blocks = changed === 'both' || changed === 'common'; assert.equal(proof !== null, blocks);
    const ceased = writeCompletionCessation(f.store, { project: f.project, binding: reference(work.binding), assignment: reference(assignment) });
    assert.equal(ceased.ok, blocks);
    const request = { ...f.request, packet: reference(packet), role: changed === 'implementer' ? 'reviewer' as const : 'implementer' as const };
    if (ceased.ok) {
      assert.equal(ceased.value.value.disposition, 'not-dispatched'); f.environment(); f.restart();
      valueOf(readCompletionCause(f.store, f.project, reference(assignment), proof!));
      valueOf(readCompletionCessationAt(f.store, f.project, reference(ceased.value)));
      assert.equal((await runModelCall(f.store, request)).ok, false); assert.equal(f.sent().length, 1);
    } else {
      assert.equal(ceased.refusal.code, 'completion_cause_unproved');
      f.steps([{ research: firstBody, usage }, { research: e4Node(f, packet as Revision<QuestionPacketRecord>), usage }]);
      const second = valueOf(await runModelCall(f.store, request)); assert.ok(second.part);
      assert.equal(f.store.list('call-record').length, 2); assert.equal(f.sent().length, 2);
      f.restart(); const history = f.store.list();
      assert.deepEqual(valueOf(await runModelCall(f.store, request)).record, second.record);
      assert.deepEqual(f.store.list(), history); assert.equal(f.sent().length, 2);
    }
  });
});

test('S1.1 the basis of a rejected application is collected through the common transparent trace: the rejection reads the same cold, hot inside one operation, and after its nested proofs were warmed before the collector attached', async t => {
  const f = e4Fixture(t);
  f.steps([{ research: e4Fact(f), usage }]);
  const writeMany = f.store.writeMany.bind(f.store);
  let completed: Revision<unknown> | null = null;
  f.store.writeMany = ((writes, guards) => {
    // Another Store completes the attempt while the application is being written: the application is rejected input_stale.
    if (!completed && writes.some(write => write.kind === 'part-response')) {
      const other = new Store(f.database);
      try { completed = valueOf(completeAttempt(other, { ...seriesRequestOf(f.series.value), attempt: 1,
        outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } })); }
      finally { other.close(); }
    }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  const actual = valueOf(await runModelCall(f.store, f.request));
  f.store.writeMany = writeMany;
  assert.ok(completed); assert.equal(actual.record.value.status, 'failed'); assert.ok(actual.record.value.om.rejection);
  const rejection = actual.record.value.om.rejection!;
  const read = () => valueOf(readModelApplicationRejection(f.store, { project: f.project, record: rejection }));
  const cold = read();
  assert.equal(cold.failure.code, 'input_stale');
  const hot = withHistoricalReads(() => { read(); return read(); });
  const warmed = withHistoricalReads(() => {
    valueOf(readQuestionPacket(f.store, { project: f.project, record: f.request.packet }));
    valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) }));
    return read();
  });
  assert.deepEqual(hot, cold); assert.deepEqual(warmed, cold);
  f.restart();
  assert.deepEqual(read(), cold);
});

test('S1.1 the collected application basis alone proves a rejection: a dispatch adapter that moved during the application is a stale relevant source only through the transparent collector; the rejection reads the same cold, hot, warmed and after restart', async t => {
  const f = e4Fixture(t);
  f.steps([{ research: e4Fact(f), usage }]);
  const adapter = f.request.dispatch.adapter, writeMany = f.store.writeMany.bind(f.store);
  let moved: Revision<unknown> | null = null;
  f.store.writeMany = ((writes, guards) => {
    // Another Store re-registers the dispatch adapter while the application is being written: only the adapter guard moves.
    if (!moved && writes.some(write => write.kind === 'part-response')) {
      const other = new Store(f.database);
      try {
        const current = other.get(adapter.id)!;
        moved = other.write({ id: adapter.id, kind: current.kind, expected: current.revision, value: { ...(current.value as Record<string, unknown>), registered: 'again' } });
      } finally { other.close(); }
    }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  const actual = valueOf(await runModelCall(f.store, f.request));
  f.store.writeMany = writeMany;
  assert.ok(moved); assert.equal(actual.record.value.status, 'failed'); assert.ok(actual.record.value.om.rejection);
  const rejection = actual.record.value.om.rejection!;
  const read = () => valueOf(readModelApplicationRejection(f.store, { project: f.project, record: rejection }));
  const cold = read();
  assert.equal(cold.failure.code, 'input_stale');
  assert.equal(cold.record.value.completion, null, 'No completion: the adapter guard alone proves the rejected class');
  assert.ok(cold.record.value.guards.some(ref => canonical(ref) === canonical(adapter)), 'The admitted adapter is a guard of the rejected application');
  assert.deepEqual(cold.record.value.heads.find(row => row.id === adapter.id)!.head, reference(moved!), 'The observed head is the re-registered adapter');
  const hot = withHistoricalReads(() => { read(); return read(); });
  const warmed = withHistoricalReads(() => {
    valueOf(readQuestionPacket(f.store, { project: f.project, record: f.request.packet }));
    valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) }));
    return read();
  });
  assert.deepEqual(hot, cold); assert.deepEqual(warmed, cold);
  f.restart();
  assert.deepEqual(read(), cold);
});

test('S1.1 (№2012) the pending overlay of E4 is frozen only over proved reads: a genuine Store, a write-only guarded view, its own overlay and a preview of the acceptance transaction reuse a proof; a frozen shell on Store.prototype over a traced Store keeps the opaque Proxy and the lower collector sees both readings; pending rows by head and exact next revision, list and history lower, both write forms through the guarded view, no physical write', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-s11-pending-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const row = store.write({ id: 'base', kind: 'fixture', expected: 0, value: { v: 1 } });
  const pendingWrite: Write = { id: 'new', kind: 'fixture', expected: 0, value: { v: 'n' } };
  const pendingRow = { id: 'new', kind: 'fixture', revision: 1, hash: hashJson(pendingWrite.value), value: pendingWrite.value };
  const shell = (target: Store): Store => {
    const view = Object.create(Store.prototype) as Record<string, unknown>;
    Object.defineProperties(view, { path: { value: target.path }, databaseId: { get: () => target.databaseId } });
    for (const name of ['get', 'list', 'history', 'write', 'writeMany'] as const)
      Object.defineProperty(view, name, { get: () => (target[name] as (...args: never[]) => unknown).bind(target) });
    return Object.freeze(view) as unknown as Store;
  };
  const key = { reader: 'S1.1.pending', project: 'p', ref: reference(row) };
  const probe = (view: Store) => withHistoricalReads(() => {
    let bodies = 0;
    const read = () => historicalProof(view, key, seen => { bodies++; return { base: seen.get(row.id, 1), head: seen.get('new'), exact: seen.get('new', 1), later: seen.get('new', 2) }; },
      () => assert.fail('The pending read is not cyclic'));
    const first = read(); assert.deepEqual(read(), first);
    return { bodies, first };
  });
  // Proved reads by construction: the frozen overlay, one body per operation, the pending row by head and exact revision.
  const guarded = storeView(store, { write: (writes, guards) => store.writeMany(writes, guards) });
  for (const [label, lower] of [['a genuine Store', store], ['a write-only guarded view', guarded], ['its own overlay', pendingCallStore(store, [])],
    ['a preview of the acceptance transaction', transactionForTests(store).view]] as const) {
    const view = pendingCallStore(lower, [pendingWrite]);
    assert.equal(types.isProxy(view), false, label + ' keeps the frozen overlay'); assert.ok(Object.isFrozen(view)); assert.ok(view instanceof Store);
    const { bodies, first } = probe(view);
    assert.equal(bodies, 1, label + ': the proof is reused');
    assert.deepEqual(first, { base: row, head: pendingRow, exact: pendingRow, later: null });
  }
  const view = pendingCallStore(store, [pendingWrite]);
  assert.deepEqual(view.list().map(item => item.id), ['base'], 'list stays the lower Store\'s'); assert.deepEqual(view.history('new'), [], 'history stays the lower Store\'s');
  assert.equal(store.get('new'), null, 'No physical write'); assert.equal(view.path, store.path);
  // The reviewer's shell (№2012-1): not a Proxy, Store.prototype beneath, own reading accessors reaching a traced Store —
  // the overlay stays opaque and the lower collector sees both readings.
  let observed = 0;
  const lower = shell(historicalTrace(store, () => observed++));
  assert.equal(types.isProxy(lower), false); assert.equal(Object.getPrototypeOf(lower), Store.prototype);
  const opaque = pendingCallStore(lower, [pendingWrite]);
  assert.equal(types.isProxy(opaque), true, 'A shell of unknown reads keeps the opaque Proxy');
  const shellProbe = probe(opaque);
  assert.equal(shellProbe.bodies, 2); assert.equal(observed, 2, 'The lower collector sees both readings');
  assert.deepEqual(shellProbe.first, { base: row, head: pendingRow, exact: pendingRow, later: null }, 'The same answers through the opaque branch');
  // A traced Store and a genuine Store with an own reading override: opaque as well.
  assert.equal(types.isProxy(pendingCallStore(historicalTrace(store), [pendingWrite])), true);
  const overridden = new Store(store.path); t.after(() => overridden.close());
  Object.defineProperty(overridden, 'get', { value: overridden.get.bind(overridden) });
  assert.equal(types.isProxy(pendingCallStore(overridden, [pendingWrite])), true);
  // Both write forms through the guarded view beneath reach its policy with their guards; the overlay writes nothing itself.
  const calls: [number, number][] = [];
  const policed = storeView(store, { write: (writes, guards) => { calls.push([writes.length, guards.length]); return store.writeMany(writes, guards); } });
  const over = pendingCallStore(policed, [pendingWrite]);
  assert.equal(types.isProxy(over), false);
  over.write({ id: 'w1', kind: 'fixture', expected: 0, value: { v: 'w1' } });
  over.writeMany([{ id: 'w2', kind: 'fixture', expected: 0, value: { v: 'w2' } }], [reference(row)]);
  assert.deepEqual(calls, [[1, 0], [1, 1]]); assert.ok(store.get('w1')); assert.ok(store.get('w2')); assert.equal(store.get('new'), null);
});
