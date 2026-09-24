import test from "node:test";
import assert from "node:assert/strict";
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
  if (!result.ok) assert.fail(`Unexpected refusal: ${result.refusal.code}`);
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
import { writeOmInput } from '../src/om/input.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeGuarded } from '../src/om/refs.js';
import { prepareQuestionTasks, prepareQuestionPacket, readQuestionPacket, writeQuestionPacket, type QuestionPacketRequest, type QuestionPacketRecord,
  type PartProposalBody } from '../src/om/question-packet.js';
import { writeRoutes } from '../src/om/routes.js';
import { openSeries, beginAttempt, seriesRequestOf } from '../src/om/series.js';
import { gapLineKey, gapLineExpectedResult } from '../src/om/gap-lines.js';
import { prepareFrameProposals } from '../src/om/frame-proposals.js';
import { runModelCall, readModelCall, readModelCallState, finishModelAttempt, prepareModelAttemptFinish, readModelApplicationRejection, type ModelCallRequest, type OmModelCall } from '../src/om/model-call.js';
import { readCall } from '../src/om/call-record.js';

function e4Fixture(t: TestContext, kind: 'fact' | 'node' | 'field' = 'fact', capacity = 100_000, priorNoProgress = 0, timeoutMs = 1000) {
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
      consumer: 'garden-consume-block', blocksCurrentStage: false, resolution: 'Resolve the addressed question during OM' }];
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
  const series = valueOf(beginAttempt(store, kind === 'field' ? { ...address, attempt: ordinal, goal, admission } as never
    : { ...address, attempt: ordinal, goal } as never));
  const packetRequest: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(configured),
    attempt: { series: reference(series), ordinal }, previous: [] };
  const packet = valueOf(writeQuestionPacket(store, packetRequest)).record;
  const request: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(configured) }, role: 'implementer' };
  const frame = valueOf(prepareFrameProposals(store, sources.operations));
  const obligations = frame.frame.result.obligations.filter(item => item.upper.node === batch.node);
  return { root, database, project, graph, input, source, routes, gaps, gapRequest, batch, packet, request, packetRequest,
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
import { completeAttempt, type RepairSeries } from '../src/om/series.js';
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
