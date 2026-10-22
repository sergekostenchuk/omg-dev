import test from 'node:test';
import { briefReadings } from '../src/om/packet-brief.js';
import { type OmCapacityDelivery, OM_CAPACITY_DELIVERY_CONTRACT, requireOmCapacityDelivery } from '../src/om/capacity-delivery.js';
import { removeProofCache } from '../src/storage/schema.js';
import { checkStoreIntegrity } from '../src/storage/fsck.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Json, canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { adapterRequest, readAdapterResponse, runModelCall, readModelCall, runModelCycle, readPartAssembly, assembleModelParts, runModelTransport, readModelTransport, readCompletionWorkAt, readModelApplicationRejection, deliverModelSources, finishModelAttempt, readManagedModelDiagnostic, readModelCycle, runModelCycle as mp2Cycle, type ReadDeliveryRecord, readOmContextPage, readContinuationEvidence, readCompletionEffectiveAt } from '../src/om/model-call.js';
import type { OmResult } from '../src/om/refusal.js';
import { runProcess } from '../src/runtime/process.js';
import { Store, type Revision } from '../src/storage/store.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { withHistoricalReads } from '../src/om/input.js';
import { writeQuestionPacket, type QuestionPacketRecord, readPartResult, readQuestionPacket } from '../src/om/question-packet.js';
import { readCompletionBinding, completionWorkId, type RepairSeries, seriesRequestOf, completeAttempt } from '../src/om/series.js';
import { readCall, recordCall } from '../src/om/call-record.js';
import { closeAttempt, openAttempt as managedOpenAttempt } from '../src/om/repeat-gate.js';
import { MP3_NOTES, completionE1, completionSnapshot, confirmed, currentPacketWire, e4CannotAnswer, e4Fact, e4Fixture, e4ManagedAnalysisFixture, e4ManagedFixture, e4NeedSource, e4Node, envelope, fixturePath, h15CannotAnswer, h15Heads, h15Refusal, h15Unserved, h15Written, mp2Managed, mp2Refused, mp3Carried, mp3Close, mp3Cycle, mp3Decisions, mp3Delivered, mp3ManagedCycle, mp3Open, mp3Origins, mp3Parts, mp3Readings, readsOf, request, unknownConfirmed, usage, valueOf } from './om-model-call-fixture.js';



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



test('E4 admits before spawning, saves MC1 candidates and actual usage, and replays exact history without native reissuance', async t => {
  // LG07 mc-04 (№11277): the attempt is the managed one — opened by G7 with its exact completion, its E2 packet issued.
  const f = await e4ManagedFixture(t), native = f.store.list('question').map(reference);
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
  const f = await e4ManagedFixture(t, 'node'); f.steps([{ research: e4Node(f) }]);
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



/**
 * LG07 mc-04 (№11277): a node attempt of the managed carrier whose root packet is a multi-part plan from the start — the
 * carrier is opened with a capacity just under the single packet of an identical one — and the real scripted answer of every part.
 */
async function multiPartNode(t: test.TestContext) {
  const measured = await e4ManagedFixture(t, 'node');
  const f = await e4ManagedFixture(t, 'node', { capacity: currentPacketWire(measured.packet.value.packet) - 1 });
  const packet = f.packet as Revision<QuestionPacketRecord>;
  assert.equal(packet.value.plan?.mode, 'parts');
  const total = packet.value.plan!.assignments.length;
  f.steps(Array.from({ length: total }, (_, position) => ({ research: e4Node(f, { ...packet,
    value: { ...packet.value, plan: { ...packet.value.plan!, position } } } as Revision<QuestionPacketRecord>) })));
  return { f, packet, total };
}

test('S1.1 a saved assembly is proved once per operation on its original source: a repeat reuses the proof, the historical path opens no pending view, the current assembly keeps its pending proposal, a re-entry is a cycle', async t => {
  const { f } = await multiPartNode(t);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
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
  let cold = 0;
  withHistoricalReads(() => {
    // NR1: the saved assembly is read as written; a kept proof of this process may already serve the first read.
    const first = read(f.store);
    cold = count();
    assert.deepEqual(first, assembly);
    assert.equal(views.length, 0, 'The historical derivation of a saved assembly proves its frame on the original source, without a pending view');
    const again = read(f.store);
    assert.deepEqual(again, first);
    assert.equal(count(), cold, 'The repeat is served by the proof: nothing of the assembly, its parts, packets or proposal is read again');
    assert.deepEqual(again.references, first.references);
  });
  // NR1 (№3591): a new operation reads the saved assembly as written — by its exact reads, or through the proof the Store
  // kept of them (E4.part-assembly is an observed reader, PF3.1): never more than the first operation read.
  const outside = count();
  assert.deepEqual(read(f.store), assembly);
  assert.ok(count() - outside <= Math.max(cold, watched.size), 'A new operation reads the saved assembly at most once more');
  assert.equal(views.length, 0);
  // The current assembly of the same parts still checks its pending proposal on a pending view, and writes nothing new.
  const snapshot = f.store.list().map(reference);
  assert.deepEqual(valueOf(assembleModelParts(f.store, { project: f.project, results: [...cycle.record.value.results] })).record, assembly.record);
  assert.deepEqual(f.store.list().map(reference), snapshot);
  const { f: fresh } = await multiPartNode(t);
  const before = views.length;
  const freshCycle = valueOf(await runModelCycle(fresh.store, fresh.request));
  assert.equal(freshCycle.record.value.terminal, 'assembled');
  assert.ok(views.length > before, 'A new current assembly still stands on its pending proposal before it is written');
  // A re-entry into the same active exact key is a cyclic derivation, addressed at the assembly; the outer read completes.
  // NR1: the read is made cold — no proof kept in this process or saved with the database serves it.
  f.store.close(); removeProofCache(f.database); f.restart();
  let inner: OmResult<unknown> | null = null, probe = true;
  const view: Store = new Proxy(f.store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) => {
      // NR1: the saved assembly is read as written — its parts are not read again — so the re-entry starts at its own record.
      if (probe && id === cycle.assembly!.id) { probe = false; inner = readPartAssembly(view, { project: f.project, record: cycle.assembly! }); }
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



test('E4 analysis transport sends both real E1 purposes, preserves opaque A6 data and settles without another attempt', async t => {
  // LG07 mc-04 (№11277): the stop is the managed one — paid E2→E4 attempts closed by G7 — and the origin hold is the block's own;
  // the analysis is told from that paid preparation by its own wire trace and by the packets the preparation left.
  for (const purpose of ['stop-analysis', 'origin-analysis'] as const) {
    const f = await e4ManagedAnalysisFixture(t, purpose), before = reference(f.store.get(f.series.id)!);
    const packets = f.store.list('question-packet').map(reference), calls = f.store.list('model-call').map(reference);
    const sent = valueOf(await runModelTransport(f.store, f.request));
    assert.equal(sent.result.kind, 'answered'); assert.equal(sent.record.value.purpose, purpose);
    if (sent.result.kind === 'answered') assert.deepEqual(JSON.parse(sent.result.raw), { cause: 'fixture observation', hypothesis: true });
    assert.deepEqual(sent.record.value.usage, usage); assert.equal(f.sent().length, 1);
    assert.deepEqual(reference(f.store.get(f.series.id)!), before); assert.deepEqual(f.store.list('question-packet').map(reference), packets);
    assert.deepEqual(f.store.list('model-call').map(reference).filter(ref => !calls.some(own => own.id === ref.id)), [reference(sent.record)]);
    assert.equal(f.store.get<{status:string}>(sent.call.id)!.value.status, 'succeeded');
    const expected = valueOf(readModelTransport(f.store, { project: f.project, record: reference(sent.record) }));
    f.store.write({ id: f.environment.id, kind: f.environment.kind, expected: f.environment.revision, value: f.environment.value });
    f.restart();
    assert.deepEqual(valueOf(await runModelTransport(f.store, f.request)), expected); assert.equal(f.sent().length, 1);
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



test('C31 H1.0b equivalent configuration preserves the next exact MC2 part before its E1', async t => {
  const measured = e4Fixture(t, 'node', 100_000, 0, 5000);
  const f = e4Fixture(t, 'node', currentPacketWire(measured.packet.value.packet) - 1, 0, 5000, true);
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



test('H1.5 №2164 E4 sends nothing for a design-decision answer batch through runModelCycle either, the reviewer role included', async t => {
  const f = e4Fixture(t, 'design', 100_000, 0, 5000, true);
  f.steps([{ research: h15CannotAnswer, usage }, { research: h15CannotAnswer, usage }]);
  const before = h15Heads(f.store);
  for (const request of [f.request, { ...f.request, role: 'reviewer' as const }]) {
    const { result, kinds } = await h15Written(f.store, () => runModelCycle(f.store, request));
    const refusal = h15Refusal(result);
    assert.deepEqual({ code: refusal.code, unit: refusal.at.unit, target: refusal.at.target, field: refusal.at.field, route: refusal.route }, h15Unserved, request.role);
    assert.deepEqual(kinds, [], request.role);
  }
  f.restart();
  assert.equal(h15Refusal(await runModelCycle(f.store, f.request)).code, 'route_result_unsupported');
  assert.equal(f.sent().length, 0);
  assert.deepEqual(h15Heads(f.store), before, 'No cycle record, no call, no ledger row');
});



test('LP3 current blocked continuation resumes after call, deliveries, continuation or diagnostic with one paid call and exact replay', async t => {
  for (const stop of ['call', 'deliveries', 'continuation', 'diagnostic'] as const) await t.test('blocked after ' + stop, async t => {
    const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true);
    const config = f.environment(currentPacketWire(f.packet.value.packet) + 100);
    const packetRequest = { ...f.packetRequest, environment: reference(config) };
    const packet = valueOf(writeQuestionPacket(f.store, packetRequest)).record;
    const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
    writeFileSync(join(f.root, 'e4-source.txt'), 'UTF-8 '.repeat(20_000));
    const reads = [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }];
    f.steps([{ research: e4NeedSource(f, reads), usage }, { research: e4NeedSource(f, reads), usage }]);
    const call = valueOf(await runModelCall(f.store, request));
    const basis = { project: f.project, packet: request.packet, call: call.call, response: call.response! };
    let expectedNext: Ref | undefined, expectedDiagnostic: Ref | undefined;
    if (stop !== 'call') {
      const delivered = valueOf(deliverModelSources(f.store, basis));
      if (stop !== 'deliveries') {
        const next = valueOf(writeQuestionPacket(f.store, { ...packetRequest, previous: [], continuation: { packet: basis.packet, call: basis.call,
          response: basis.response, deliveries: [...delivered.deliveries] } })).record;
        assert.equal(next.value.state, 'blocked');
        expectedNext = reference(next);
        if (stop === 'diagnostic') expectedDiagnostic = valueOf(finishModelAttempt(f.store, { ...basis, code: next.value.refusal!.code,
          message: next.value.refusal!.message, reason: 'refused', evidence: [reference(next)] })).diagnostic;
      }
    }
    f.restart();
    const cycle = valueOf(await runModelCycle(f.store, request));
    assert.equal(cycle.record.value.terminal, 'blocked');
    assert.equal(f.sent().length, 1, 'The saved call is finished, never sent again');
    assert.ok(cycle.record.value.next && cycle.record.value.diagnostic);
    if (expectedNext) assert.deepEqual(cycle.record.value.next, expectedNext);
    if (expectedDiagnostic) assert.deepEqual(cycle.record.value.diagnostic, expectedDiagnostic);
    const next = f.store.get<QuestionPacketRecord>(cycle.record.value.next.id)!;
    assert.deepEqual([next.value.request.continuation!.packet, next.value.request.continuation!.call, next.value.request.continuation!.response],
      [basis.packet, basis.call, basis.response]);
    const diagnostic = valueOf(readManagedModelDiagnostic(f.store, completionSnapshot(f).binding, cycle.record.value.diagnostic));
    assert.deepEqual([diagnostic.request.packet, diagnostic.request.call, diagnostic.request.response, diagnostic.request.evidence],
      [basis.packet, basis.call, basis.response, [reference(next)]]);
    assert.equal(completionSnapshot(f).complete, true);
    const saved = f.store.list(); f.restart();
    assert.deepEqual(valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) })).record, cycle.record);
    assert.deepEqual(valueOf(await runModelCycle(f.store, request)).record, cycle.record);
    assert.deepEqual(f.store.list(), saved); assert.equal(f.sent().length, 1);
  });
});



test('MP2 (№2968 rows 14, 18) stopped after the first applied refusal the root stays open; the continued cycle reuses the paid call, corrects once, and the registry decides by the corrected chain with the first refusal kept in its history', async t => {
  const f = mp2Managed(t);
  f.steps([{ research: mp2Refused(f) }, { research: e4Node(f) }]);
  const call = valueOf(await runModelCall(f.store, f.request));
  assert.ok(call.diagnostic);
  const pending = completionSnapshot(f);
  assert.equal(pending.resolved.length, 0, 'Row 14: the owed correction keeps the root open');
  assert.ok(!pending.technical.length, 'The owed refusal decides nothing yet');
  // Stop after the correction packet is written, before its call: the cycle finds the same packet and sends once.
  const ground = { packet: call.packet, call: call.call, response: call.response!, diagnostic: call.diagnostic! };
  const written = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, correction: ground })).record;
  const cycle = valueOf(await mp2Cycle(f.store, f.request));
  assert.equal(f.sent().length, 2, 'The paid first call is never sent again');
  assert.deepEqual(cycle.record.value.steps[1]!.packet, reference(written));
  const done = completionSnapshot(f);
  const root = done.assignments.find(row => row.value.kind === 'root')!;
  assert.ok(done.resolved.some(ref => ref.id === root.id), 'Row 18: the corrected chain resolves the root');
  assert.ok(!done.technical.some(row => row.source.id === call.record.id), 'Row 18: the replaced refusal does not decide the outcome');
  const journal = f.store.list('om-unit-refusal').some(row => row.id === call.diagnostic!.id);
  assert.ok(journal, 'The first refusal stays in the history');
  const correction = done.assignments.find(row => row.value.kind === 'continuation' && row.value.key.includes(':correct:'));
  assert.ok(correction, 'The correction is its own physical step under the rejected one');
  // LP6 (return №3371): the replaced refusal is a corrected diagnostic of the registry — owed no more, kept in its history.
  assert.deepEqual(done.corrected, [call.diagnostic]);
});



// OBL1 (№3768): a whole record read by a pointer can exceed what a continuation may carry.
test('OBL1 №3768 №3773 a large context result is shown as an exact bounded fragment, the delivery stays whole, and a small read is shown whole', async t => {
  const measured = await mp3ManagedCycle(t), graphChars = canonical(measured.f.graph.value as unknown as Json).length;
  const capacity = currentPacketWire(measured.f.packet.value.packet) + Math.floor(graphChars / 2);
  const m = await mp3ManagedCycle(t, 'fact', { capacity }), { f } = m;
  const whole = { action: 'read_context', record: reference(f.graph), pointer: '' }, small = { action: 'read_context', record: reference(f.input), pointer: '/input/questions/0/question' };
  const graph = f.store.get(f.graph.id, f.graph.revision)!.value as Record<string, unknown>;
  assert.ok(canonical(graph as Json).length + currentPacketWire(f.packet.value.packet) > capacity, 'Whole, the graph would not fit beside the packet');
  f.steps([{ research: m.need([whole, small]), usage }, { research: e4Fact(f), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'outcome', 'The continuation is built and answered, never blocked');
  const sent = f.sent(); assert.equal(sent.length, 2);
  const next = m.payload(sent[1].requestId);
  const data = new Map((next.sourceDeliveries[0].data as { read: Record<string, any>; data: unknown }[]).map(row => [canonical(row.read), row.data]));
  const shown = data.get(canonical(whole)) as OmCapacityDelivery;
  const delivery = f.store.list<ReadDeliveryRecord>('om-read-delivery').find(row => canonical(row.value.read as Json) === canonical(whole as unknown as Json))!;
  assert.equal(shown.contract, OM_CAPACITY_DELIVERY_CONTRACT);
  requireOmCapacityDelivery({ record: reference(delivery), pointer: '/data', value: delivery.value.data,
    packet: delivery.value.packet, call: delivery.value.call, response: delivery.value.response,
    delivery: reference(delivery) }, shown);
  assert.ok(shown.served.end > 0 && shown.served.end < shown.requested.end);
  assert.equal(shown.served.next, shown.served.end);
  assert.equal(shown.text, canonical(delivery.value.data).slice(shown.served.offset, shown.served.end));
  assert.equal((data.get(canonical(small)) as { outcome: string }).outcome, 'complete');
  assert.ok(currentPacketWire(next) <= capacity, 'The complete continuation wire fits its capacity');
  assert.equal((delivery.value.data as { outcome: string }).outcome, 'complete', 'The delivery itself keeps the whole value');
});



test('OBL1 №3780 what is new is judged by what the reader is shown: the same bounded fragment asked again is research-no-progress without another send; a narrower read is progress', async t => {
  const measured = await mp3ManagedCycle(t), graphChars = canonical(measured.f.graph.value as unknown as Json).length;
  const capacity = currentPacketWire(measured.f.packet.value.packet) + Math.floor(graphChars / 2);
  const m = await mp3ManagedCycle(t, 'fact', { capacity }), { f } = m;
  const whole = { action: 'read_context', record: reference(f.graph), pointer: '' };
  f.steps([{ research: m.need([whole]), usage }, { research: m.need([whole]), usage }, { research: m.need([whole]), usage }, { research: e4Fact(f), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'research-no-progress');
  assert.equal(f.sent().length, 2, 'The same shown fragment is not paid for a third time');
  // №3784: the same in a managed attempt, as the pass runs it — the finish sees the continuation it is written with.
  await t.test('managed: the same fragment again ends research-no-progress with its finish, after two sends', async child => {
    const n = mp3Cycle(child, 'fact', capacity, true), g = n.f;
    const again = { action: 'read_context', record: reference(g.graph), pointer: '' };
    g.steps([{ research: n.need([again]), usage }, { research: n.need([again]), usage }, { research: n.need([again]), usage }, { research: e4Fact(g), usage }]);
    const managed = valueOf(await runModelCycle(g.store, g.request));
    assert.equal(managed.record.value.terminal, 'research-no-progress');
    assert.equal(g.sent().length, 2);
  });
  await t.test('a narrower read after the fragment is progress', async child => {
    const n = await mp3ManagedCycle(child, 'fact', { capacity }), g = n.f;
    const narrow = { action: 'read_context', record: reference(g.graph), pointer: '/id' };
    g.steps([{ research: n.need([{ action: 'read_context', record: reference(g.graph), pointer: '' }]), usage }, { research: n.need([narrow]), usage },
      { research: e4Fact(g), usage }]);
    const narrowed = valueOf(await runModelCycle(g.store, g.request));
    assert.equal(narrowed.record.value.terminal, 'outcome');
    assert.equal(g.sent().length, 3);
    const parent = n.packets().find(row => (row.value.packet as { requestId?: string } | null)?.requestId === g.sent()[1].requestId)!;
    const current = n.payload(g.sent()[2].requestId);
    assert.deepEqual(current.sourceDeliveryHistory, { contract: 'om-source-delivery-history/v1',
      record: reference(parent), pointer: '/packet/sourceDeliveries', count: 1,
      read: { action: 'read_context', record: reference(parent), pointer: '/packet/sourceDeliveries' } });
    assert.deepEqual(readOmContextPage(parent.value, '/packet/sourceDeliveries', { offset: 0, end: 1, total: 1, unit: 'items' }),
      (parent.value.packet as { sourceDeliveries: unknown[] }).sourceDeliveries);
    const currentRecord = n.packets().find(row => (row.value.packet as { requestId?: string } | null)?.requestId === g.sent()[2].requestId)!;
    g.restart();
    assert.deepEqual(valueOf(readQuestionPacket(g.store, { project: g.project, record: reference(currentRecord) })), currentRecord);
    assert.deepEqual(checkStoreIntegrity(g.store).findings, []);
  });
});



test('MP3 row 8: after reopen with the working file changed or removed, a delivery is the same data and Ref from saved sources; current applicability is checked separately', async t => {
  const m = await mp3ManagedCycle(t), { f } = m;
  f.steps([{ research: m.need([m.range(0, 9), { action: 'read', path: 'mp3-notes.txt', media: 'text/plain' }]), usage }, { research: e4Fact(f), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  const link = valueOf(readQuestionPacket(f.store, { project: f.project, record: cycle.record.value.steps[1]!.packet })).value.request.continuation!;
  const evidence = { project: f.project, ...link, deliveries: [...link.deliveries] };
  const saved = valueOf(readContinuationEvidence(f.store, evidence));
  for (const change of ['changed', 'removed'] as const) {
    if (change === 'changed') writeFileSync(join(f.root, 'mp3-notes.txt'), 'replaced working file');
    else rmSync(join(f.root, 'mp3-notes.txt'));
    f.restart();
    const before = f.store.list().map(reference);
    assert.deepEqual(valueOf(readContinuationEvidence(f.store, evidence)), saved, change);
    assert.deepEqual(valueOf(deliverModelSources(f.store, { project: f.project, packet: link.packet, call: link.call, response: link.response })).deliveries, link.deliveries);
    const current = readContinuationEvidence(f.store, evidence, true);
    assert.equal(current.ok, false); if (!current.ok) assert.equal(current.refusal.code, 'input_stale', change);
    assert.deepEqual(valueOf(readModelCycle(f.store, { project: f.project, record: reference(cycle.record) })).record, cycle.record);
    assert.deepEqual(f.store.list().map(reference), before);
  }
});



test('MP3 row 14: an identical delivery of two admissible attempts is one shown item listing both origins; a different slice stays its own item', async t => {
  const m = await mp3Delivered(t, m => [m.range(0, 9)]), { f } = m;
  const root2 = mp3Open(f, 2).root();
  m.run([{ research: m.need([m.range(0, 9), m.range(5, 15)], root2), usage }, { research: e4CannotAnswer(f), usage }]);
  const second = valueOf(await runModelCycle(f.store, { ...f.request, packet: reference(root2) }));
  assert.equal(second.record.value.steps.length, 2, 'The partly new slice is progress');
  mp3Close(f, 2);
  const root3 = mp3Open(f, 3).root(), readings = mp3Readings(root3.value.packet);
  const byText = new Map(readings.entries.map(entry => [(entry.data as { text: string }).text, entry.origins.map(origin => origin.kind === 'attempt' && origin.ordinal)]));
  assert.deepEqual(byText.get(MP3_NOTES.slice(0, 9)), [2, 1]); assert.deepEqual(byText.get(MP3_NOTES.slice(5, 15)), [2]);
  assert.equal(readings.entries.length, 2);
  assert.equal(f.store.list('om-read-delivery').length, 3, 'Repeated deliveries keep their own records');
  const shown = mp3Carried(root3).find(item => item.data.text === MP3_NOTES.slice(0, 9))!;
  assert.deepEqual(shown.origins, [{ kind: 'attempt', attempt: 2 }, { kind: 'attempt', attempt: 1 }]);
});


test('MP3 row 18 (MP2 correction after reads): the next part carries the reads of a part chain that went through a correction', async t => {
  const { m, f, packet, total, at, request, steps } = mp3Parts(t);
  f.steps([{ research: m.need([m.range(0, 9)], packet), usage }, { research: mp2Refused(f, at(0)), usage }, { research: e4Node(f, at(0)), usage },
    ...Array.from({ length: total - 1 }, (_, index) => ({ research: e4Node(f, at(index + 1)), usage }))]);
  const cycle = valueOf(await mp2Cycle(f.store, request));
  assert.equal(cycle.record.value.terminal, 'assembled'); assert.equal(f.sent().length, total + 2, 'No call is added for carried reads');
  const [root, continuation, correction, ...parts] = steps(cycle);
  assert.ok(continuation!.value.request.continuation && correction!.value.request.correction);
  for (const step of [root!, continuation!, correction!, ...parts]) assert.ok(briefReadings(step.value.packet), 'Every packet keeps the root era');
  assert.deepEqual(mp3Readings(correction!.value.packet), mp3Readings(continuation!.value.packet), 'The correction shows the set of the step it corrects');
  const next = parts[0]!;
  assert.equal(next.value.request.previous.length, 1); assert.equal(next.value.request.continuation, undefined, 'A carried read is no continuation edge');
  assert.deepEqual(mp3Readings(next.value.packet).snapshots, [{ kind: 'packet', packet: reference(correction!) }]);
  assert.deepEqual(mp3Origins(next), [['part 0']]); assert.deepEqual(mp3Decisions(next.value.packet), ['included']);
  assert.deepEqual(mp3Carried(next).map(item => item.data.text), [MP3_NOTES.slice(0, 9)], 'The read before the correction reaches the next part');
  f.restart();
  for (const step of [root!, continuation!, correction!, ...parts]) assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(step) })), step);
});



test('PF3.1 rows 1, 33, 34: completion-effective is one derivation per exact closure — empty and non-empty additions, a repeat in this and the next operation, the real work and guards; a malformed closure is refused again, never normalized by its key', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 1000, true);
  const binding = valueOf(readCompletionBinding(f.store, f.project, reference(f.series), 1))!;
  const id = completionWorkId(f.project, binding.id);
  f.steps([{ research: e4Fact(f), usage }]);
  valueOf(await runModelCall(f.store, f.request));
  const revisions = f.store.history(id);
  const pair = revisions.findIndex((row, index) => index > 0 && (row.value as unknown as { products: Ref[] }).products.length
    > (revisions[index - 1]!.value as unknown as { products: Ref[] }).products.length);
  assert.ok(pair > 0, 'The fixture adds products to the work');
  const prior = revisions[pair - 1]!, next = revisions[pair]!;
  const added = (next.value as unknown as { products: Ref[] }).products.filter(ref => !(prior.value as unknown as { products: Ref[] }).products.some(old => canonical(old) === canonical(ref)));
  const closure = { work: reference(prior), additions: added, journal: (next.value as unknown as { journal: Ref | null }).journal };
  const empty = { work: reference(next), additions: [] as Ref[], journal: (next.value as unknown as { journal: Ref | null }).journal };
  for (const request of [closure, empty]) {
    // Row 1: the first derivation is the common one; rows 33: the same snapshot again in this and the next operation.
    let first!: unknown;
    const cold = readsOf(() => withHistoricalReads(() => { first = valueOf(readCompletionEffectiveAt(f.store, f.project, request));
      assert.equal(readsOf(() => assert.deepEqual(valueOf(readCompletionEffectiveAt(f.store, f.project, request)), first)), 0, 'A repeat in the operation reads nothing'); }));
    void cold; // NR1: a kept proof of this process may already serve the first derivation.
    // Across operations only a complete trail is kept (om-input rows 2, 17); this fixture's history reads through
    // non-proved views, so the next operation derives the same snapshot again.
    assert.deepEqual(withHistoricalReads(() => valueOf(readCompletionEffectiveAt(f.store, f.project, request))), first);
    const snapshot = first as { work: Revision<unknown>; guards: Ref[] };
    assert.deepEqual(reference(snapshot.work), request.work, 'The snapshot names the real work it stands on, never a revision to be');
    assert.deepEqual(snapshot.guards, valueOf(readCompletionWorkAt(f.store, f.project, request.work)).guards);
  }
  assert.deepEqual(valueOf(readCompletionEffectiveAt(f.store, f.project, empty)), valueOf(readCompletionWorkAt(f.store, f.project, empty.work)),
    'Empty additions return the exact prior snapshot');
  // Row 34: a malformed closure is refused before any proof, and again at every repeat — the key never normalizes it.
  const refusedWith = (request: unknown, code: string) => {
    for (let round = 0; round < 2; round++) {
      let outcome: OmResult<unknown> | undefined;
      try { outcome = readCompletionEffectiveAt(f.store, f.project, request as never); }
      catch (error) { assert.ok(error instanceof EngineError && error.code === code, `${code}: ${String(error)}`); continue; }
      assert.equal(outcome.ok, false); if (!outcome.ok) assert.equal(outcome.refusal.code, code);
    }
  };
  refusedWith({ work: closure.work, additions: closure.additions }, 'model_call_request_invalid');
  if (added.length) refusedWith({ ...closure, additions: [...added, added[0]!] }, 'completion_invalid');
  if (added.length > 1) refusedWith({ ...closure, additions: [...added].reverse() }, 'completion_invalid');
  const cut = (prior.value as unknown as { journal: Ref | null }).journal;
  if (cut) refusedWith({ ...closure, journal: { ...cut, revision: cut.revision - 1 } }, 'completion_invalid');
});

