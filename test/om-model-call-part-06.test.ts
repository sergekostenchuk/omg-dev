import test from 'node:test';
import { packetPrompt } from '../src/om/packet-brief.js';
import assert from 'node:assert/strict';
import { types } from 'node:util';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, type Json, hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { adapterRequest, readAdapterResponse, type AdapterRequestInput, type AdapterResponseInput, runModelCall, runModelCycle, readModelCycle, deliverModelSources, readContinuationEvidence, readPartAssembly, readModelCall, readManagedModelDiagnostic, assembleModelParts, runModelTransport, readModelTransport, finishModelAttempt, prepareModelAttemptFinish, readModelApplicationRejection, type OmModelCall, readModelCallState, type ModelCallRequest, type ModelTransportRequest, pendingCallStore, runModelCycle as mp2Cycle } from '../src/om/model-call.js';
import { type ProcessResult } from '../src/runtime/process.js';
import { Store, type Write, type Revision } from '../src/storage/store.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import type { Graph } from '../src/graph/model.js';
import { withHistoricalReads, historicalProof, historicalTrace } from '../src/om/input.js';
import { storeView, readServer } from '../src/storage/store-view.js';
import { transactionForTests } from '../src/om/atomic-gate.js';
import { writeGuarded } from '../src/om/refs.js';
import { type QuestionPacketRequest, writeQuestionPacket, prepareQuestionPacket, readQuestionPacket, type QuestionPacketRecord, readPartResult } from '../src/om/question-packet.js';
import { seriesRequestOf, type RepairSeries } from '../src/om/series.js';
import { answerProducerOf, prepareAnswersGateTrace } from '../src/om/answers-gate.js';
import { readCall, recordCall } from '../src/om/call-record.js';
import { checkAnswerForm } from '../src/om/answer-form.js';
import { closeAttempt, prepareManagedClaim } from '../src/om/repeat-gate.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { readModelCallRecovery, prepareLateModelReceipt } from '../src/discovery/model-call-recovery.js';
import { CycleCommitPhase, MP3_NOTES, completionE1, completionSnapshot, confirmed, currentPacketWire, cycleCommitPhase, cycleCommitPhases, decode, deeplyFrozen, e4CannotAnswer, e4Fact, e4Fixture, e4ManagedAnalysisFixture, e4ManagedClose, e4ManagedFixture, e4WorksFixture, e4NeedSource, e4Node, ensureFixtureProject, envelope, fixtureCheckpoint, fixtureDriver, h15CannotAnswer, h15Heads, h15Refusal, h15Unserved, h15Written, killFixtureDriver, killFixtureProvider, lp4Root, mp2Managed, mp2Refused, mp2StopAfter, mp3Carried, mp3Close, mp3Cycle, mp3Delivered, mp3Open, mp3Readings, mp3SearchDelivery, omit, processResult, publicRecovery, refusesLiveRecovery, request, requestId, signalFixtureProvider, unknownConfirmed, usage, valueOf } from './om-model-call-fixture.js';



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



test('E4 control and malformed outcomes complete their attempt once, preserve unanswered questions, and replay after restart', async t => {
  for (const action of ['need_owner', 'cannot_answer', 'pause', 'malformed', 'process_failure'] as const) {
    // LG07 (№10753 п.8): managed carriers — an attempt the managed E4 opens stays open until an explicit G7.
    // The need_owner line keeps one genuine no-progress ordinal through the paid managed prefix.
    const f = action === 'need_owner' ? await e4ManagedFixture(t, 'fact', { priorNoProgress: 1 })
      : e4Fixture(t, 'fact', 100_000, 0, 1000, true), common = { protocol: '$answerProtocol', requestId: '$requestId', questionIds: [f.batch.items[0]!.gap] };
    f.steps([action === 'malformed' ? { research: { invalid: true }, usage }
      : action === 'process_failure' ? { rawStdout: '{broken', exitCode: 7 }
      : { research: { ...common, action, reason: 'Need a concrete source', ...(action === 'need_owner' ? { decision: 'Choose the source' } : {}) }, usage }]);
    const sendsBefore = f.sent().length;
    const actual = valueOf(await runModelCall(f.store, f.request));
    assert.ok(actual.diagnostic, action); assert.equal(f.store.list('accepted-answer').length, 0);
    const opened = f.store.get<{attempts: {outcome: unknown}[]}>(f.series.id)!;
    assert.equal(opened.value.attempts.at(-1)!.outcome, null, action);
    e4ManagedClose(f);
    const current = f.store.get<{attempts: {outcome: unknown; verdict: string}[]; withoutProgress: number}>(f.series.id)!;
    assert.ok(current.value.attempts.at(-1)!.outcome, action); assert.notEqual(current.value.attempts.at(-1)!.verdict, 'progress');
    assert.equal((current.value.attempts.at(-1)!.outcome as {reason:string}).reason, action === 'need_owner' ? 'awaiting-owner' : action === 'malformed' ? 'off-form' : action === 'process_failure' ? 'interrupted' : 'refused');
    if (action === 'need_owner') { assert.equal(actual.outcome?.kind, 'awaiting-owner');
      assert.equal(current.value.withoutProgress, 1); // only the paid prior ordinal counts — awaiting-owner is not no-progress
      if (actual.outcome?.kind === 'awaiting-owner') { assert.equal(actual.outcome.recipient, 'owner'); assert.ok(actual.outcome.questions[0]!.consumers.length); } }
    const snapshot = f.store.list().map(reference); f.restart();
    const replay = valueOf(await runModelCall(f.store, f.request));
    assert.equal(replay.repeated, true); assert.deepEqual(replay.diagnostic, actual.diagnostic);
    assert.deepEqual(f.store.list().map(reference), snapshot); assert.equal(f.sent().length, sendsBefore + 1);
  }
});



test('E4 cycle delivers all addressed read forms then answers once in the same attempt with immutable history', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true), native = f.store.list('question').map(reference), originalInput = reference(f.input), originalGraph = reference(f.graph); // LG07: managed E4 carrier
  const reads = [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' },
    { action: 'read_source', source: reference(f.source), selector: { kind: 'text-range', start: 0, end: f.source.value.content.length } },
    { action: 'read_context', record: reference(f.input), pointer: '/input/questions/0/question' },
    { action: 'search', within: 'e4-source.txt', query: 'UTF-8' }];
  f.steps([{ research: e4NeedSource(f, reads), usage }, { research: e4Fact(f), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'outcome'); assert.equal(cycle.last.outcome?.kind, 'fact-candidates');
  const sent = f.sent(); assert.equal(sent.length, 2); assert.notEqual(sent[0].requestId, sent[1].requestId);
  const payloadOf = (wire: { requestId: string; prompt: string }) => {
    const payload = f.store.list<{ packet: Record<string, any> }>('question-packet').find(row => row.value.packet?.requestId === wire.requestId)!.value.packet;
    assert.equal(wire.prompt, packetPrompt(payload, wire.requestId)); return payload;
  };
  const first = payloadOf(sent[0]), second = payloadOf(sent[1]);
  assert.deepEqual(second.questions, first.questions); assert.equal(second.responseForm.requestId, sent[1].requestId);
  assert.deepEqual(second.brief.labels.slice(0, first.brief.labels.length), first.brief.labels);
  const deliveredSource = second.sourceDeliveries[0].data[0].sources[0];
  assert.ok(second.brief.labels.some((label: any) => label.domain === 'source' && canonical(label.value) === canonical(deliveredSource)));
  assert.ok(!first.brief.labels.some((label: any) => canonical(label.value) === canonical(deliveredSource)));
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



test('E4 no-progress preparation guards concurrent completion without a partial blocked packet or diagnostic', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 1000, true), need = e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]);
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
    // LG07: a managed attempt cannot be closed concurrently — the only lawful race is an incompatible
    // required-record replacement; the guards of the prepared bundle go stale exactly like a lost CAS.
    const head = other.get<import('../src/runtime/environment.js').Environment>(f.configured.id)!;
    const { projectId: _project, ...config } = structuredClone(head.value);
    new ProductEngine(other).environments.configure(f.project, { ...config, timeoutMs: config.timeoutMs + 1 }, head.revision);
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
  const f = e4Fixture(t, 'fact', 100_000, 0, 1000, true), read = { action: 'read', path: 'e4-source.txt', media: 'text/plain' };
  const need = e4NeedSource(f, [read, read]); f.steps([{ research: need }, { research: need }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'research-no-progress'); assert.ok(cycle.diagnostic);
  assert.equal(f.sent().length, 2); assert.equal(f.store.list('om-read-delivery').length, 2);
  // LG07: under a managed attempt the refusal journal is written but the attempt stays open until explicit G7.
  const opened = f.store.get<{attempts: {outcome: unknown}[]}>(f.series.id)!;
  assert.equal(opened.value.attempts.length, 1); assert.equal(opened.value.attempts[0]!.outcome, null);
  e4ManagedClose(f);
  const series = f.store.get<{attempts: {outcome: {reason: string}}[]; withoutProgress: number}>(f.series.id)!;
  assert.equal(series.value.attempts[0]!.outcome!.reason, 'refused');
  assert.equal(series.value.withoutProgress, 1);
  const snapshot = f.store.list().map(reference); f.restart();
  valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) }));
  valueOf(await runModelCycle(f.store, f.request));
  assert.equal(f.sent().length, 2); assert.deepEqual(f.store.list().map(reference), snapshot);
});



test('E4 cycle saves delivery overflow without a second dispatch or context truncation', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true), config = f.environment(currentPacketWire(f.packet.value.packet) + 100); // LG07: managed E4 carrier
  const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
  const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
  writeFileSync(join(f.root, 'e4-source.txt'), 'UTF-8 '.repeat(20_000));
  f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]) }]);
  const cycle = valueOf(await runModelCycle(f.store, request));
  assert.equal(cycle.record.value.terminal, 'blocked'); assert.equal(f.sent().length, 1); assert.ok(cycle.record.value.next);
  const blocked = f.store.get<QuestionPacketRecord>(cycle.record.value.next.id)!;
  assert.equal(blocked.value.state, 'blocked'); assert.equal(blocked.value.packet, null);
  assert.ok(blocked.value.fullChars! <= config.value.requestCapacityChars!, 'The saved refusal is about full wire capacity, even when prompt text fits');
  assert.equal(blocked.value.refusal?.code, 'packet_too_large');
  assert.ok(f.store.list('om-read-delivery').some(record => (record.value as {data: unknown}).data === 'UTF-8 '.repeat(20_000)));
  f.restart(); valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) }));
  assert.equal(valueOf(await runModelCycle(f.store, request)).repeated, true); assert.equal(f.sent().length, 1);
});



test('E4 carries checked works handoffs through local dispatch, split assembly, restart and exact late repeats without accepting L3', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  for (const split of [false, true]) await t.test(split ? 'split with prior work and test' : 'whole node', async t => {
    const f = e4WorksFixture(t), config = split ? f.environment(currentPacketWire(f.packet.value.packet, null) - 1) : f.configured;
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
      if (position > 0) {
        const previous = (issued.value.packet as Record<string, any>).expansion.previous;
        assert.deepEqual(previous.map((item: any) => item.tests), parts.slice(0, position).map(item => item.proposal.value.tests));
        assert.deepEqual(previous.map((item: any) => item.edges), parts.slice(0, position).map(item => item.proposal.value.edges));
      }
      assert.deepEqual(context.works.obligations, f.ledger.handoff.obligations);
      assert.deepEqual(context.works.nodeAssignments, payload.works.nodeAssignments);
      assert.deepEqual(context.works.assigned, position === count - 1 ? payload.works.nodeAssignments : []);
      assert.equal(issued.value.fingerprint!.chars, packetPrompt(issued.value.packet).length);
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



test('E4 analysis transport rejects another actual body and stale fresh-dispatch grounds without spawning', async t => {
  const f = await e4ManagedAnalysisFixture(t, 'stop-analysis');
  const before = f.store.list();
  const wrongBody = await runModelTransport(f.store, { ...f.request, packet: { text: 'Copied call ref with a different payload' } });
  assert.equal(wrongBody.ok, false); if (!wrongBody.ok) assert.equal(wrongBody.refusal.code, 'packet_invalid');
  assert.deepEqual(f.store.list(), before);
  f.store.write({ id: f.environment.id, kind: f.environment.kind, expected: f.environment.revision, value: f.environment.value });
  const afterEnv = f.store.list();
  const stale = await runModelTransport(f.store, f.request);
  assert.equal(stale.ok, false); assert.equal(f.sent().length, 0);
  assert.deepEqual(f.store.list(), afterEnv);
});



test('E4 cycle refuses missing coverage and conflicting definitions without accepting a partial node', async t => {
  for (const issue of ['coverage', 'conflict'] as const) {
    const f = e4Fixture(t, 'node', 100_000, 0, 5000, true), config = f.environment(currentPacketWire(f.packet.value.packet) - 1); // LG07: managed E4 carrier
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
    assert.equal(f.store.get<{attempts: {outcome: unknown}[]}>(f.series.id)!.value.attempts[0]!.outcome, null, issue);
    e4ManagedClose(f); // LG07: the parts-invalid refusal is owned by the explicit G7 close
    assert.equal(f.store.get<{withoutProgress:number}>(f.series.id)!.value.withoutProgress, 1);
    f.restart(); valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) }));
  }
});



test('E4 exact malformed environment and adapter sources return addressed refusals instead of raw property exceptions', async t => {
  for (const malformed of ['environment', 'adapter'] as const) {
    const f = await e4ManagedAnalysisFixture(t, 'stop-analysis'), get = f.store.get.bind(f.store);
    const source = malformed === 'environment' ? f.environment.id : `adapter:${f.project}:managed-analysis`;
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



test('E4 control completion cannot replace an outcome saved after the control response was received', async t => {
  // LG07: managed carrier — the competing completion is a lawful explicit G7 from a second Store over the same
  // database (the received refusal already proves the registry complete), not the retired standalone close.
  const f = e4Fixture(t, 'fact', 100_000, 0, 1000, true);
  f.steps([{ research: { protocol: '$answerProtocol', requestId: '$requestId', questionIds: [f.batch.items[0]!.gap],
    action: 'cannot_answer', reason: 'The requested information is unavailable' }, usage }]);
  const writeMany = f.store.writeMany.bind(f.store); let completed: Revision<unknown> | null = null;
  f.store.writeMany = ((writes, guards) => {
    const committed = writeMany(writes, guards);
    // The refusal journal is durable now — a second Store sees the complete registry and may lawfully G7-close.
    if (!completed && writes.some(write => write.kind === 'om-refusal-journal')) {
      const other = new Store(f.database);
      try {
        const request = { ...seriesRequestOf(f.series.value), attempt: 1,
          outcome: { reason: 'refused' as const, accepting: [], cancelling: [], refusals: [] } };
        valueOf(closeAttempt(other, { ...request, outcome: valueOf(prepareManagedClaim(other, request)).outcome }));
        completed = other.get(f.series.id);
      }
      finally { other.close(); }
    }
    return committed;
  }) as Store['writeMany'];
  const actual = valueOf(await runModelCall(f.store, f.request)); f.store.writeMany = writeMany;
  assert.ok(completed); assert.equal(actual.record.value.om.application, 'applied');
  assert.equal(actual.record.value.status, 'succeeded');
  // The saved outcome stands: the apply owns only its own accounting, never the closed attempt's A3 row.
  assert.deepEqual(f.store.get(f.series.id), completed);
  assert.equal(f.store.list('om-model-exchange').length, 1);
  assert.equal(f.store.list('part-response').length, 1); // the genuine managed application product
  assert.deepEqual(actual.record.value.usage, usage);
  const snapshot = f.store.list(), historical = valueOf(readModelCall(f.store, { project: f.project, record: reference(actual.record) }));
  f.restart(); assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), historical);
  assert.deepEqual(f.store.list(), snapshot); assert.equal(f.sent().length, 1);
});



test('E4 restarts every durable cycle prefix with one physical send and one settlement for content and cannot_answer', async t => {
  for (const action of ['fact', 'cannot_answer'] as const) {
    const baseline = e4Fixture(t, 'fact', 100_000, 0, 1000, true);
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
        const f = e4Fixture(nested, 'fact', 100_000, 0, 1000, true);
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
          // LG07: the managed refusal journal is durable but the attempt stays open until the explicit G7.
          assert.equal(current.value.attempts[0]!.outcome, null);
          e4ManagedClose(f);
          const closed = f.store.get<{attempts: {outcome: {reason: string} | null}[]; withoutProgress: number}>(f.series.id)!;
          assert.equal(closed.value.attempts[0]!.outcome?.reason, 'refused');
          assert.equal(closed.revision, f.series.revision + 1); assert.equal(closed.value.withoutProgress, 1);
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
      const f = e4Fixture(nested, 'fact', 100_000, 0, 1000, true);
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
      assert.equal(attempt.value.attempts[0]!.outcome, null);
      if (action !== 'fact') { // LG07: managed — refusal journal durable; explicit G7 owns the outcome
        e4ManagedClose(f);
        const closed = f.store.get<{attempts: {outcome: {reason: string} | null}[]}>(f.series.id)!;
        assert.equal(closed.value.attempts[0]!.outcome?.reason, 'refused');
        assert.equal(closed.revision, f.series.revision + 1);
      } else assert.equal(attempt.revision, f.series.revision);
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
      const f = e4Fixture(nested, 'node', 100_000, 0, 1000, true), config = f.environment(currentPacketWire(f.packet.value.packet) - 1);
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
      assert.equal(attempt.value.attempts[0]!.outcome, null);
      if (action !== 'node') { // LG07: managed — refusal journal durable; explicit G7 derives the outcome
        e4ManagedClose(f);
        const closed = f.store.get<{attempts: {outcome: {reason: string} | null}[]}>(f.series.id)!;
        assert.equal(closed.value.attempts[0]!.outcome?.reason, 'refused');
        assert.equal(closed.revision, f.series.revision + 1);
      } else assert.equal(attempt.revision, f.series.revision);
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



test('E4 public recovery closes a truly lost pre-spawn owner for products and analysis without sending or inventing usage', async t => {
  for (const purpose of ['fact', 'node', 'stop-analysis', 'origin-analysis'] as const) await t.test(purpose, async nested => {
    const product = purpose === 'fact' || purpose === 'node';
    const f = product ? e4Fixture(nested, purpose, 100_000, 0, 30_000, true) : await e4ManagedAnalysisFixture(nested, purpose, 30_000);
    ensureFixtureProject(f.store, f.project);
    const checkpoint = join(f.root, 'claimed.json');
    const research = product ? (purpose === 'fact' ? e4Fact(f as ReturnType<typeof e4Fixture>) : e4Node(f as ReturnType<typeof e4Fixture>))
      : { cause: 'Unsent local analysis', hypothesis: true };
    writeFileSync(f.scenario, JSON.stringify({ steps: [{ research, usage }] }));
    const originalSeries = reference(f.store.get(f.series.id)!), exchangeCount = f.store.list('om-model-exchange').length,
      partCount = f.store.list('part-response').length;
    const driver = fixtureDriver(nested, f.database, f.root, product ? 'call' : 'transport', f.request,
      { path: checkpoint, kind: 'model-call', matches: [{ path: ['execution', 'phase'], value: 'claimed' }] });
    const paused = await fixtureCheckpoint(checkpoint, driver.child);
    assert.equal(paused.pid, driver.child.pid); assert.equal(f.sent().length, 0);
    const claimed = f.store.list<ModelCall>('model-call').find(row => row.value.status === 'running')!;
    assert.equal(claimed.value.execution?.owner.pid, paused.pid); assert.equal(claimed.value.execution?.provider, null);
    const unchanged = f.store.list(); refusesLiveRecovery(f.store, f.project, reference(claimed));
    assert.deepEqual(f.store.list(), unchanged);
    await killFixtureDriver(driver);
    let completed: Revision<unknown> | null = null;
    // LG07: the lawful competitor is the same public recovery reaching the terminal close first —
    // no standalone completeAttempt over an unpaid managed registry.
    if (purpose === 'fact') {
      const other = new Store(f.database);
      try { publicRecovery(other, f.project, reference(claimed)); completed = other.get(f.series.id); }
      finally { other.close(); }
    }
    const recovered = publicRecovery(f.store, f.project, reference(claimed));
    assert.equal(recovered.value.status, 'failed'); assert.equal(recovered.value.error, 'process_lost');
    const proof = readModelCallRecovery(f.store, f.project, reference(recovered));
    assert.equal(proof.proof!.request, 'not-authorized'); assert.equal(proof.proof!.physical, 'unknown');
    assert.equal(recovered.value.usage, null); assert.equal(recovered.value.response, null);
    const call = product ? f.store.list<{status: string;usage: unknown}>('call-record')[0]!
      : f.store.get<{status: string;usage: unknown}>((f.request as ModelTransportRequest).call.id)!;
    assert.equal(call.value.status, 'open'); assert.equal(call.value.usage, null); assert.equal(f.store.history(call.id).length, 1);
    assert.equal(f.store.list('om-model-exchange').length, exchangeCount); assert.equal(f.store.list('part-response').length, partCount);
    if (product) {
      assert.equal((recovered.value as OmModelCall).om.application, 'recovered');
      const series = f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!;
      // LG07: the physical recovery is terminal but the managed attempt stays open; the concurrent recovery
      // commits the same transition, om.completion names the written unit refusal, completion is owner-set.
      assert.equal(series.value.attempts[0]!.outcome, null);
      if (completed) {
        assert.deepEqual(series, completed);
        assert.ok((recovered.value as OmModelCall).om.diagnostic, 'The interrupted outcome is a written managed unit refusal');
      }
      if (purpose === 'fact') { // the complete registry closes at the explicit G7 as 'interrupted'
        e4ManagedClose(f as ReturnType<typeof e4Fixture>);
        const closed = f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!;
        assert.equal(closed.value.attempts[0]!.outcome?.reason, 'interrupted'); assert.equal(closed.revision, originalSeries.revision + 1);
      } else {
        // LG07: the still-owed node parts keep the registry honestly incomplete; the durable physical outcome is
        // the written unit refusal and no managed close can be fabricated over the lost call.
        const diagnostic = valueOf(readManagedModelDiagnostic(f.store,
          completionSnapshot(f as ReturnType<typeof e4Fixture>).binding, (recovered.value as OmModelCall).om.diagnostic!));
        assert.equal(diagnostic.reason, 'interrupted');
        assert.deepEqual([diagnostic.request.packet, diagnostic.request.call],
          [(recovered.value as OmModelCall).om.request.packet, (recovered.value as OmModelCall).om.call]);
        const unclosed = prepareManagedClaim(f.store, { ...seriesRequestOf(f.series.value), attempt: 1,
          outcome: { reason: 'interrupted', accepting: [], cancelling: [], refusals: [] } });
        assert.equal(unclosed.ok, false); if (!unclosed.ok) assert.equal(unclosed.refusal.code, 'completion_incomplete');
      }
      const expected = valueOf(readModelCall(f.store, { project: f.project, record: reference(recovered) }));
      const snapshot = f.store.list(); f.restart();
      assert.deepEqual(valueOf(await runModelCall(f.store, f.request as ModelCallRequest)), expected);
      assert.deepEqual(f.store.list(), snapshot);
      if (purpose !== 'fact') assert.equal(valueOf(readManagedModelDiagnostic(f.store,
        completionSnapshot(f as ReturnType<typeof e4Fixture>).binding, (recovered.value as OmModelCall).om.diagnostic!)).reason,
        'interrupted', 'The interrupted proof survives the restart');
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
    const f = product ? e4Fixture(nested, purpose, 100_000, 0, 30_000, true) : await e4ManagedAnalysisFixture(nested, purpose, 30_000);
    ensureFixtureProject(f.store, f.project);
    const checkpoint = join(f.root, 'provider.json');
    const research = product ? (purpose === 'fact' ? e4Fact(f as ReturnType<typeof e4Fixture>) : e4Node(f as ReturnType<typeof e4Fixture>))
      : { cause: 'Local analysis evidence', hypothesis: true };
    writeFileSync(f.scenario, JSON.stringify({ steps: [{ research, usage, pauseAfterRequest: checkpoint }] }));
    const originalSeries = reference(f.store.get(f.series.id)!), exchangeCount = f.store.list('om-model-exchange').length;
    const driver = fixtureDriver(nested, f.database, f.root, product ? 'call' : 'transport', f.request);
    const supplier = await fixtureCheckpoint(checkpoint, driver.child);
    assert.equal(supplier.parent, driver.child.pid); assert.equal(f.sent().length, 1);
    const running = f.store.list<ModelCall>('model-call').find(row => row.value.status === 'running')!, provider = running.value.execution!.provider!;
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
    const admitted = product ? f.store.list<{status: string;usage: unknown}>('call-record')[0]!
      : f.store.get<{status: string;usage: unknown}>((f.request as ModelTransportRequest).call.id)!;
    assert.equal(admitted.value.status, 'open'); assert.equal(admitted.value.usage, null); assert.equal(f.store.history(admitted.id).length, 1);
    assert.equal(f.store.list('om-model-exchange').length, exchangeCount);
    if (product) {
      assert.equal((recovered.value as OmModelCall).om.application, 'recovered');
      const series = f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!;
      // LG07: the managed attempt stays open after the terminal recovery.
      assert.equal(series.value.attempts[0]!.outcome, null);
      if (purpose === 'fact') { // the complete registry closes at the explicit G7 as 'interrupted'
        e4ManagedClose(f as ReturnType<typeof e4Fixture>);
        const closed = f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!;
        assert.equal(closed.value.attempts[0]!.outcome?.reason, 'interrupted'); assert.equal(closed.revision, originalSeries.revision + 1);
      } else {
        // LG07: the still-owed node parts keep the registry honestly incomplete; the durable physical outcome is
        // the written unit refusal and no managed close can be fabricated over the lost call.
        const diagnostic = valueOf(readManagedModelDiagnostic(f.store,
          completionSnapshot(f as ReturnType<typeof e4Fixture>).binding, (recovered.value as OmModelCall).om.diagnostic!));
        assert.equal(diagnostic.reason, 'interrupted');
        assert.deepEqual([diagnostic.request.packet, diagnostic.request.call],
          [(recovered.value as OmModelCall).om.request.packet, (recovered.value as OmModelCall).om.call]);
        const unclosed = prepareManagedClaim(f.store, { ...seriesRequestOf(f.series.value), attempt: 1,
          outcome: { reason: 'interrupted', accepting: [], cancelling: [], refusals: [] } });
        assert.equal(unclosed.ok, false); if (!unclosed.ok) assert.equal(unclosed.refusal.code, 'completion_incomplete');
      }
      const expected = valueOf(readModelCall(f.store, { project: f.project, record: reference(recovered) }));
      const snapshot = f.store.list(); f.restart();
      assert.deepEqual(valueOf(await runModelCall(f.store, f.request as ModelCallRequest)), expected);
      assert.deepEqual(f.store.list(), snapshot);
      if (purpose !== 'fact') assert.equal(valueOf(readManagedModelDiagnostic(f.store,
        completionSnapshot(f as ReturnType<typeof e4Fixture>).binding, (recovered.value as OmModelCall).om.diagnostic!)).reason,
        'interrupted', 'The interrupted proof survives the restart');
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
  const f = e4Fixture(t, 'fact', 100_000, 0, 30_000, true), checkpoint = join(f.root, 'claimed-race.json');
  f.steps([{ research: e4Fact(f), usage }]);
  const driver = fixtureDriver(t, f.database, f.root, 'call', f.request,
    { path: checkpoint, kind: 'model-call', matches: [{ path: ['execution', 'phase'], value: 'claimed' }] });
  await fixtureCheckpoint(checkpoint, driver.child); await killFixtureDriver(driver);
  const running = f.store.list<ModelCall>('model-call')[0]!, writeMany = f.store.writeMany.bind(f.store);
  let winner: Revision<ModelCall> | null = null, raced: ReturnType<Store['list']> | null = null;
  f.store.writeMany = ((writes, guards) => {
    if (!winner && writes.some(write => write.kind === 'model-call-recovery')) {
      const other = new Store(f.database);
      try { winner = publicRecovery(other, f.project, reference(running)); raced = f.store.list(); }
      finally { other.close(); }
    }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  try {
    assert.throws(() => publicRecovery(f.store, f.project, reference(running)),
      (error: unknown) => error instanceof EngineError && ['input_stale', 'revision_conflict', 'model_call_foreign'].includes(error.code));
  } finally { f.store.writeMany = writeMany; }
  // LG07: the losing refusal wrote nothing — the store still holds exactly the winner's commit.
  assert.ok(winner); assert.deepEqual(f.store.list(), raced);
  assert.deepEqual(f.store.get(running.id), winner);
  assert.equal(f.store.list('model-call-recovery').length, 1); assert.equal(f.sent().length, 0);
  // LG07: the winning recovery is the terminal physical transition; the managed attempt closes at explicit G7.
  const series = f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!;
  assert.equal(series.value.attempts[0]!.outcome, null);
  e4ManagedClose(f);
  const closed = f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!;
  assert.equal(closed.value.attempts[0]!.outcome?.reason, 'interrupted'); assert.equal(closed.revision, f.series.revision + 1);
  const historical = valueOf(readModelCall(f.store, { project: f.project, record: reference(f.store.get(running.id)!) }));
  const saved = f.store.list(); f.restart();
  assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), historical);
  assert.deepEqual(f.store.list(), saved);
});



test('E4 records real local supplier death while its owner survives as one interrupted MC2 attempt', async t => {
  const f = e4Fixture(t, 'node', 100_000, 0, 30_000, true), checkpoint = join(f.root, 'child-only.json');
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
  // LG07: the interrupted physical outcome is a written managed unit refusal; the still-owed node parts keep
  // the registry honestly incomplete — the attempt stays open and no managed close can be fabricated over it.
  const series = f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!;
  assert.equal(series.value.attempts[0]!.outcome, null);
  const diagnostic = valueOf(readManagedModelDiagnostic(f.store, completionSnapshot(f).binding, recovered.value.om.diagnostic!));
  assert.equal(diagnostic.reason, 'interrupted');
  assert.deepEqual([diagnostic.request.packet, diagnostic.request.call], [recovered.value.om.request.packet, recovered.value.om.call]);
  const unclosed = prepareManagedClaim(f.store, { ...seriesRequestOf(f.series.value), attempt: 1,
    outcome: { reason: 'interrupted', accepting: [], cancelling: [], refusals: [] } });
  assert.equal(unclosed.ok, false); if (!unclosed.ok) assert.equal(unclosed.refusal.code, 'completion_incomplete');
  const call = f.store.list<{status:string;usage:unknown}>('call-record')[0]!;
  assert.equal(call.value.status, 'open'); assert.equal(call.value.usage, null);
  const expected = valueOf(readModelCall(f.store, { project: f.project, record: reference(recovered) }));
  const saved = f.store.list(); f.restart();
  assert.deepEqual(valueOf(await runModelCall(f.store, f.request)), expected);
  assert.deepEqual(f.store.list(), saved); assert.equal(f.sent().length, 1);
  assert.equal(valueOf(readManagedModelDiagnostic(f.store, completionSnapshot(f).binding, recovered.value.om.diagnostic!)).reason,
    'interrupted', 'The interrupted proof survives the restart');
});



test('E4 owner loss after spawn but before authorization proves no request transfer without claiming supplier termination', async t => {
  for (const purpose of ['fact', 'stop-analysis'] as const) await t.test(purpose, async nested => {
    const product = purpose === 'fact';
    const f = product ? e4Fixture(nested, 'fact', 100_000, 0, 30_000, true) : await e4ManagedAnalysisFixture(nested, 'stop-analysis', 30_000);
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
    const claimed = f.store.list<ModelCall>('model-call').find(row => row.value.execution?.phase === 'claimed')!;
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
    const f = product ? e4Fixture(nested, 'fact', 100_000, 0, 1000, true) : await e4ManagedAnalysisFixture(nested, 'stop-analysis');
    const exchangeCount = f.store.list('om-model-exchange').length, writeMany = f.store.writeMany.bind(f.store);
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
    assert.equal(f.store.list('om-model-exchange').length, exchangeCount + 1);
    if (product) {
      assert.equal((finished.record.value as OmModelCall).om.application, 'applied');
      // LG07: the managed attempt stays open; the explicit G7 derives 'interrupted'.
      assert.equal(f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!.value.attempts[0]!.outcome, null);
      e4ManagedClose(f as ReturnType<typeof e4Fixture>);
      assert.equal(f.store.get<{attempts:{outcome:{reason:string}|null}[]}>(f.series.id)!.value.attempts[0]!.outcome?.reason, 'interrupted');
    }
    const snapshot = f.store.list(); f.restart();
    if (product) valueOf(await runModelCall(f.store, f.request as ModelCallRequest));
    else valueOf(await runModelTransport(f.store, f.request as ModelTransportRequest));
    assert.deepEqual(f.store.list(), snapshot); assert.equal(f.sent().length, 0);
  });
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



test('15 H1.0a exact no-progress, blocked successor and invalid assembly discharge their root without local A3', async t => {
  for (const terminal of ['research-no-progress', 'blocked', 'parts-invalid'] as const) await t.test(terminal, async t => {
    const f = e4Fixture(t, terminal === 'parts-invalid' ? 'node' : 'fact', 100_000, 0, 1000, true);
    let request = f.request;
    if (terminal === 'parts-invalid') {
      const config = f.environment(currentPacketWire(f.packet.value.packet) - 1);
      const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
      const answers = packet.value.plan!.assignments.map((_,position) => e4Node(f, { ...packet,
        value:{...packet.value,plan:{...packet.value.plan!,position}} } as Revision<QuestionPacketRecord>));
      answers.at(-1)!.proposal.fills.pop();
      f.steps(answers.map(research => ({ research, usage })));
      request = { ...request, packet:reference(packet),dispatch:{...request.dispatch,config:reference(config)} };
    } else {
      const need = e4NeedSource(f, [{action:'read',path:'e4-source.txt',media:'text/plain'}]);
      if (terminal === 'blocked') {
        const config = f.environment(currentPacketWire(f.packet.value.packet) + 100);
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
  // A traced Store: a registered layer since PF3.3 (№3568 §1) — a trace of the common factory over a proved Store is a known
  // composition. A genuine Store with an own reading override stays opaque.
  assert.equal(types.isProxy(pendingCallStore(historicalTrace(store), [pendingWrite])), false);
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



test('H1.5 №2164 E4 sends nothing for a design-decision answer batch: a ready packet is no right to pay, so runModelCall refuses before E1, the claim and the authorization', async t => {
  const f = e4Fixture(t, 'design', 100_000, 0, 5000, true);
  assert.equal(f.packet.value.state, 'ready', 'E2 still calls the packet ready: the prohibition stands in E4');
  assert.deepEqual([f.batch.model, f.batch.task, f.batch.items.map(item => item.field)], ['MC2', 'input-field', ['answer']]);
  // The reviewer's probe (№2164): no producer of the pass answers it, so paying buys nothing; a later question is no
  // blocking gap of the pass, so the full G4b names nothing for it (OWN1: D7 carries it).
  const spare = f.gaps.records.find(row => row.value.gap.target === 'discovery:spare')!.value.gap;
  assert.deepEqual([spare.moment, answerProducerOf(spare).present], ['task-start', false]);
  const judged = valueOf(prepareAnswersGateTrace(f.store, { project: f.project, gaps: f.gapRequest, routes: reference(f.routes), results: [] }))
    .trace.filter(entry => entry.finding.at.target === 'discovery:spare');
  assert.deepEqual(judged, []);
  f.steps([{ research: h15CannotAnswer, usage }]);
  const before = h15Heads(f.store), gap = f.gaps.records.find(row => row.value.gap.target === 'discovery:spare')!;
  const { result, kinds } = await h15Written(f.store, () => runModelCall(f.store, f.request));
  const refusal = h15Refusal(result);
  assert.deepEqual({ code: refusal.code, unit: refusal.at.unit, target: refusal.at.target, field: refusal.at.field, route: refusal.route }, h15Unserved);
  assert.deepEqual(refusal.at.ref, reference(gap), 'Addressed to the exact D1 gap of the question');
  assert.equal(f.sent().length, 0, 'The adapter was never called');
  assert.deepEqual(kinds, [], 'Nothing was written: no E1 row, no running claim, no dispatch counter');
  assert.deepEqual(h15Heads(f.store), before);
  // The refusal repeats after a new store: the saved unsent packet is refused the same way.
  f.restart();
  const again = h15Refusal(await runModelCall(f.store, f.request));
  assert.deepEqual([again.code, again.at.target, again.at.field], [refusal.code, refusal.at.target, refusal.at.field]);
  assert.equal(f.sent().length, 0);
  assert.deepEqual(h15Heads(f.store), before);
});



test('PF1 (№2797-2) pendingCallStore is the common pending overlay: later writes of one id replace earlier ones, rows are sealed copies, a nested call store keeps its layer, a proved base gives a frozen registered layer and an unproved one the opaque Proxy, and a value that is no JSON is refused as before', t => {
  const { isProxy } = types;
  const root = mkdtempSync(join(tmpdir(), 'omg-pf1-call-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const written = store.write({ id: 'pf1m:b', kind: 'k', expected: 0, value: { b: 1 } });
  const value = { v: 2, nested: { n: 1 } };
  const view = pendingCallStore(store, [{ id: 'pf1m:a', kind: 'k', expected: 0, value: { v: 1 } }, { id: 'pf1m:a', kind: 'k', expected: 0, value }]);
  value.nested.n = 9;
  assert.deepEqual(view.get('pf1m:a')!.value, { v: 2, nested: { n: 1 } }, 'The later write of one id replaces the earlier one, as a sealed copy');
  assert.ok(!isProxy(view) && Object.isFrozen(view.get('pf1m:a')));
  const outer = pendingCallStore(view, [{ id: 'pf1m:b', kind: 'k', expected: 1, value: { b: 2 } }]);
  assert.deepEqual([outer.get('pf1m:b')!.revision, outer.get('pf1m:b', 1), outer.get('pf1m:a')!.value], [2, store.get(written.id, 1), { v: 2, nested: { n: 1 } }],
    'A nested call store keeps its layer over the one beneath');
  assert.deepEqual([readServer(outer, 'get', 'pf1m:b', undefined), readServer(outer, 'get', 'pf1m:b', 1), readServer(outer, 'list', 'k', undefined)], ['pending', store, store]);
  const opaque = pendingCallStore(new Proxy(store, { get: (target, key) => { const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member; } }),
    [{ id: 'pf1m:c', kind: 'k', expected: 0, value: {} }]);
  assert.ok(isProxy(opaque) && readServer(opaque, 'get', 'pf1m:c', undefined) === null, 'Over an unproved view the call store stays opaque');
  assert.throws(() => pendingCallStore(store, [{ id: 'pf1m:d', kind: 'k', expected: 0, value: { f: (() => 1) as unknown as Json } }]),
    (error: unknown) => error instanceof EngineError && error.code === 'invalid_json', 'A value that is no JSON is refused as before: its hash is taken first');
});



test('MP2 return №3147 (§4): a correction admitted but never claimed is still owed — the rejected step\'s cessation guards the absence of its claim; once claimed, received or applied the rejected step owes nothing: its cessation is refused on the correction\'s own claim or as resolved, nothing written, nothing sent again', async t => {
  const { prepareCompletionCessation, writeCompletionCessation, modelCallRecordId } = await import('../src/om/model-call.js');
  for (const boundary of ['admitted', 'running', 'received', 'applied'] as const) await t.test(boundary, async t => {
    const f = mp2Managed(t);
    f.steps([{ research: mp2Refused(f) }, { research: mp2Refused(f) }]);
    await mp2StopAfter(f, boundary);
    const rejected = f.store.list<OmModelCall>('model-call').find(row => row.value.om.request.packet.id === f.packet.id)!;
    const correction = f.store.list<QuestionPacketRecord>('question-packet').find(row => row.value.request.correction)!;
    const claim = modelCallRecordId(f.project, (correction.value.packet as { requestId: string }).requestId);
    const owner = rejected.value.om.completionOwner!, sent = f.sent().length;
    assert.equal(sent, ['admitted', 'running'].includes(boundary) ? 1 : 2);
    f.environment(90_000);
    const before = f.store.list().map(reference);
    if (boundary === 'admitted') {
      assert.equal(f.store.get(claim) ?? null, null, 'Admitted, never claimed');
      const prepared = valueOf(prepareCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: owner.assignment }));
      assert.deepEqual([prepared.record.value.disposition, prepared.record.value.remainder], ['branch-ceased', 'continuation'], 'The correction is still owed');
      assert.ok(prepared.guards.some(guard => guard.id === claim && (guard as { absent?: boolean }).absent === true),
        'Its claim stays absent until the cessation commits');
    } else {
      const refused = writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: owner.assignment });
      assert.equal(refused.ok, false, 'A dispatched correction leaves no owed remainder on the rejected step');
      if (!refused.ok) assert.deepEqual([refused.refusal.code, refused.refusal.at.target],
        boundary === 'applied' ? ['completion_resolved', owner.assignment.id] : ['completion_claim_exists', claim]);
    }
    assert.deepEqual(f.store.list().map(reference), before, 'Nothing is written');
    assert.equal(f.sent().length, sent, 'Nothing is sent again');
  });
});



test('MP2 return №3147 (§4; №2968 ¶25): once admitted the correction is the leaf the pass ceases first — admitted but never claimed as never dispatched with its unpaid E1, received by its application; the rejected step is resolved by it and its refusal stays final: it completes the step and decides the close with its rows, as when the step itself is ceased', async t => {
  const { writeCompletionCessation } = await import('../src/om/model-call.js');
  for (const boundary of ['admitted', 'received'] as const) await t.test(boundary, async t => {
    const f = mp2Managed(t);
    f.steps([{ research: mp2Refused(f) }, { research: e4Node(f) }]);
    await mp2StopAfter(f, boundary);
    const rejected = f.store.list<OmModelCall>('model-call').find(row => row.value.om.request.packet.id === f.packet.id)!;
    const owner = rejected.value.om.completionOwner!, diagnostic = rejected.value.om.diagnostic!, sent = f.sent().length;
    const correction = completionSnapshot(f).assignments.find(row => row.value.kind === 'continuation' && row.value.parent?.id === owner.assignment.id)!;
    assert.ok(correction, 'The correction is the leaf of the rejected step');
    f.environment(90_000);
    const ceased = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(correction) }));
    assert.deepEqual([ceased.value.disposition, ceased.value.remainder, ceased.value.call !== null],
      boundary === 'received' ? ['branch-ceased', 'application', true] : ['not-dispatched', null, true]);
    const snapshot = completionSnapshot(f);
    assert.ok(snapshot.resolved.some(ref => ref.id === owner.assignment.id), 'The rejected step is resolved through its ceased correction');
    assert.ok(snapshot.technical.some(row => row.source.id === rejected.id && row.reason === 'off-form'), 'Its refusal is final: no verified answer replaced it');
    const rows = f.store.get<{ rows: { id: string; source: Ref }[] }>(`om-refusal-journal:${f.project}`)!.value.rows.filter(row => row.source.id === diagnostic.id);
    assert.ok(rows.length && rows.every(row => snapshot.refusals.some(item => item.row === row.id)), 'It decides the close with its journal rows');
    const root = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(lp4Root(f)) }));
    assert.equal(root.value.cause.kind, 'cycle-step-ceased');
    assert.equal(completionSnapshot(f).complete, true, 'The attempt can close');
    const cycle = await mp2Cycle(f.store, f.request);
    assert.equal(cycle.ok, false); if (!cycle.ok) assert.equal(cycle.refusal.code, 'completion_ceased');
    assert.equal(f.sent().length, sent, 'Nothing is sent again');
  });
});



test('MP3 row 16: the saved set is not selected again — continuations keep it, the running attempt\'s own deliveries never join it, repeated preparation and reopen reproduce it', async t => {
  const m = await mp3Delivered(t, m => [m.range(0, 9)]), { f } = m;
  const next = mp3Open(f, 2), root = next.root();
  const issued = f.store.list().map(reference);
  assert.deepEqual(valueOf(prepareQuestionPacket(f.store, next.request)).writes, [], 'A repeated preparation selects nothing again');
  assert.deepEqual(valueOf(writeQuestionPacket(f.store, next.request)).record, root);
  assert.deepEqual(f.store.list().map(reference), issued);
  m.run([{ research: m.need([m.range(20, 30)], root), usage }, { research: e4CannotAnswer(f), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, { ...f.request, packet: reference(root) }));
  const continuation = valueOf(readQuestionPacket(f.store, { project: f.project, record: cycle.record.value.steps[1]!.packet }));
  const strip = (packet: unknown) => mp3Readings(packet).entries.map(({ decision: _decision, ...entry }) => entry);
  assert.deepEqual(mp3Readings(continuation.value.packet).snapshots, mp3Readings(root.value.packet).snapshots);
  assert.deepEqual(strip(continuation.value.packet), strip(root.value.packet));
  assert.equal((continuation.value.packet as Record<string, any>).sourceDeliveries[0].data[0].data.text, MP3_NOTES.slice(20, 30));
  const before = f.store.list().map(reference);
  assert.deepEqual(valueOf(writeQuestionPacket(f.store, next.request)).record, root, 'The saved root is replayed, its set unchanged by later deliveries');
  f.restart();
  for (const packet of [root, continuation]) assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(packet) })), packet);
  assert.deepEqual(f.store.list().map(reference), before);
});


test('MP3 №3171 (control): a search without a match inside a file path has its one source and no rows and is carried', async t => {
  const m = mp3Cycle(t, 'fact', 100_000, true), { f } = m;
  f.steps([{ research: m.need([{ action: 'search', within: 'mp3-notes.txt', query: 'absent' }, m.range(0, 9)]), usage }, { research: e4CannotAnswer(f), usage }]);
  valueOf(await runModelCycle(f.store, f.request));
  const search = mp3SearchDelivery(f);
  assert.equal(search.value.sources.length, 1); assert.deepEqual(search.value.data, []);
  mp3Close(f, 1);
  const root2 = mp3Open(f, 2).root();
  assert.equal(root2.value.state, 'ready');
  assert.equal(mp3Readings(root2.value.packet).entries.find(entry => entry.origins.some(origin => origin.delivery.id === search.id))!.decision.state, 'included');
});


test('MP3 №3171: a literal read of a captured file is carried into the next attempt root and shown by the path it asked for', async t => {
  const m = mp3Cycle(t, 'fact', 100_000, true), { f } = m;
  writeFileSync(join(f.root, 'mp3-extra.txt'), 'Extra file read by its path.');
  f.steps([{ research: m.need([{ action: 'read', path: 'mp3-extra.txt', media: 'text/plain' }]), usage }, { research: e4CannotAnswer(f), usage }]);
  valueOf(await runModelCycle(f.store, f.request));
  const delivery = f.store.list<{ read: { action: string }; sources: Ref[] }>('om-read-delivery').find(row => row.value.read.action === 'read')!;
  assert.equal(delivery.value.sources.length, 1, 'The producer captures the one requested file');
  mp3Close(f, 1);
  const root2 = mp3Open(f, 2).root();
  const carried = mp3Readings(root2.value.packet).entries.find(entry => entry.origins.some(origin => origin.delivery.id === delivery.id))!;
  assert.equal(carried.decision.state, 'included');
  assert.deepEqual(mp3Carried(root2).find(item => item.read.action === 'read'),
    { origins: [{ kind: 'attempt', attempt: 1 }], read: { action: 'read', path: 'mp3-extra.txt', media: 'text/plain' }, data: 'Extra file read by its path.' });
});



test('MP3 row 21 (delivery): an addressed read whose source changed after E3 keeps the prior freshness refusal of delivery and writes nothing', async t => {
  const m = mp3Cycle(t, 'fact', 100_000, true), { f } = m;
  f.steps([{ research: m.need([m.range(0, 9)]), usage }]);
  const first = valueOf(await runModelCall(f.store, f.request));
  assert.equal(first.outcome?.kind, 'need-source');
  writeFileSync(join(f.root, 'mp3-notes.txt'), 'Changed after E3.');
  const before = f.store.list().map(reference);
  const refused = deliverModelSources(f.store, { project: f.project, packet: first.packet, call: first.call, response: first.response! });
  assert.equal(refused.ok, false); if (!refused.ok) assert.deepEqual([refused.refusal.code, refused.refusal.at.ref], ['input_stale', reference(m.notes)]);
  assert.deepEqual(f.store.list().map(reference), before);
});

