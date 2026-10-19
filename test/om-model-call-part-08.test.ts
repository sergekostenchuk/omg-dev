import test from 'node:test';
import { packetPrompt } from '../src/om/packet-brief.js';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { runModelCall, readModelCall, type OmModelCall, readModelCallState, type ModelCallRequest, runModelTransport, type ModelTransportRequest, runModelCycle, deliverModelSources, runModelCycle as mp2Cycle, readModelCycle as mp2ReadCycle, CYCLE_POLICY, AREA_INPUT_VARIANT as LP5_AREA_INPUT, prepareCompletionReuse, writeCompletionReuse, readCompletionReuseAt } from '../src/om/model-call.js';
import { type ProcessResult } from '../src/runtime/process.js';
import { type Revision, Store, type Write } from '../src/storage/store.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { writeOmInput } from '../src/om/input.js';
import { prepareWorksSources } from '../src/om/atomic-gate.js';
import { writeAddressing, inputDecisionWrite } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { type GapRequest, writeGaps } from '../src/om/gaps.js';
import { writeGuarded } from '../src/om/refs.js';
import { prepareQuestionPacket, writeQuestionPacket, type QuestionPacketRecord, readQuestionPacket } from '../src/om/question-packet.js';
import { writeRoutes } from '../src/om/routes.js';
import { completeAttempt, seriesRequestOf, type RepairSeries, openSeries, readCompletionBinding, completionRootAssignments } from '../src/om/series.js';
import { gapLineKey, gapLineExpectedResult, writeGapLines } from '../src/om/gap-lines.js';
import { normalizeOwnerGapAssignment, OM_OWNER_ASSIGNMENT_CONTRACT, writeOmObligations, OM_OWNER_ASSIGNMENT_KIND } from '../src/om/obligations.js';
import { taskBindingId } from '../src/graph/task-obligations.js';
import type { CarriedObligation } from '../src/graph/obligation-policy.js';
import { writeAnswersRegistration, writeAnswersCheckCessation } from '../src/om/answers-gate.js';
import { recordCall } from '../src/om/call-record.js';
import { checkAnswerForm } from '../src/om/answer-form.js';
import { closeAttempt, openAttempt as managedOpenAttempt } from '../src/om/repeat-gate.js';
import { Evidence, Source } from '../src/evidence/evidence.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { prepareLateModelReceipt } from '../src/discovery/model-call-recovery.js';
import { MP3_EMPTY_SEARCH, MP3_NOTES, completionE1, completionSnapshot, currentPacketWire, e4AnalysisFixture, e4CannotAnswer, e4Fact, e4Fixture, e4NeedSource, e4Node, e4WorksFixture, ensureFixtureProject, fixtureCheckpoint, fixtureDriver, killFixtureDriver, mp2Managed, mp2Refused, mp2Step, mp3Carried, mp3Close, mp3Cycle, mp3Decisions, mp3Delivered, mp3Open, mp3Origins, mp3Readings, mp3SearchDelivery, publicRecovery, usage, valueOf } from './om-model-call-fixture.js';



test('E4 mechanism field dispatch applies E3 decisions through D3 and does not manufacture accepted progress', async t => {
  const f = e4Fixture(t, 'field');
  f.steps([{ research: { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer',
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




test('20 H1.0b exact MC2 remainder cessation preserves produced parts and blocks materialization without hiding siblings', async t => {
  const { prepareCompletionCessation, writeCompletionCessation, readCompletionCessationAt } = await import('../src/om/model-call.js');
  const measured = e4Fixture(t, 'node', 100_000, 0, 5000, false, true, true), f = e4Fixture(t, 'node', currentPacketWire(measured.packet.value.packet) - 1, 0, 5000, true, true, true);
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




test('MP1 field examples pass the genuine E3 parser with exact gap labels and permitted field values', t => {
  const f = e4Fixture(t, 'field');
  const payload = f.packet.value.packet as Record<string, any>;
  assert.ok(payload.brief.examples.some((example: { action: string }) => example.action === 'answer'));
  const before = JSON.stringify(f.store.list());
  for (const example of payload.brief.examples) {
    const actual = valueOf(checkAnswerForm(f.store, { project: f.project, packet: reference(f.packet), raw: canonical(example) }));
    if (example.action === 'answer') assert.equal(actual.kind, 'input-decisions');
  }
  assert.equal(JSON.stringify(f.store.list()), before);
});



test('MP2 (№2968 row 17) a correction that does not fit is the old blocked successor without a send; one that fits is sent', async t => {
  const f = mp2Managed(t), config = f.environment(currentPacketWire(f.packet.value.packet) + 40);
  const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
  assert.equal(packet.value.state, 'ready');
  const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
  f.steps([{ research: mp2Refused(f, packet as Revision<QuestionPacketRecord>) }, { research: e4Node(f, packet as Revision<QuestionPacketRecord>) }]);
  const cycle = valueOf(await mp2Cycle(f.store, request));
  assert.equal(cycle.record.value.terminal, 'blocked'); assert.equal(f.sent().length, 1);
  const next = f.store.get<QuestionPacketRecord>(cycle.record.value.next!.id)!;
  assert.ok(next.value.request.correction); assert.equal(next.value.state, 'blocked'); assert.equal(next.value.packet, null);
  assert.ok(next.value.refusal && ['node_unexpandable', 'packet_too_large'].includes(next.value.refusal.code));
  assert.deepEqual(next.value.plan, packet.value.plan, 'No hidden re-planning of the assignment');
  f.restart(); valueOf(mp2ReadCycle(f.store, { project: f.project, record: reference(cycle.record) }));
  assert.equal(valueOf(await mp2Cycle(f.store, request)).repeated, true); assert.equal(f.sent().length, 1);
});



test('MP2 (№2968 regression 4) the one correction for an MC1 fact and for input fields: an unissued label is corrected once; the corrected fact still awaits its E5 assessment, the corrected fields are applied', async t => {
  await t.test('MC1 fact', async t => {
    const f = e4Fixture(t, 'fact', 100_000, 0, 1000, true);
    const refused = e4Fact(f); refused.results = refused.results.map(row => ({ ...row, questionId: 'Q999' }));
    f.steps([{ research: refused }, { research: e4Fact(f) }]);
    const cycle = valueOf(await mp2Cycle(f.store, f.request));
    assert.equal(f.sent().length, 2); assert.equal(cycle.record.value.cyclePolicy, CYCLE_POLICY);
    const last = mp2Step(f, cycle.record.value.steps[1]!);
    assert.equal(last.diagnostic, null); assert.equal(last.outcome?.kind, 'fact-candidates');
    const snapshot = completionSnapshot(f);
    const facts = snapshot.assignments.filter(row => row.value.kind === 'fact');
    assert.ok(facts.length > 0 && facts.every(row => !snapshot.resolved.some(ref => ref.id === row.id)), 'The fact still awaits E5; E3 is no assessment');
  });
  await t.test('input fields', async t => {
    const f = e4Fixture(t, 'field', 100_000, 0, 1000, true);
    const answer = (basis: (item: typeof f.batch.items[number]) => unknown) => ({ protocol: '$answerProtocol', requestId: '$requestId', action: 'answer',
      results: f.batch.items.map(item => ({ target: item.target, field: item.field, basis: basis(item), value: { consumer: 'garden-consume-block', kind: 'repository-fact' } })) });
    f.steps([{ research: answer(() => 'G999') }, { research: answer(item => item.record) }]);
    const cycle = valueOf(await mp2Cycle(f.store, f.request));
    assert.equal(f.sent().length, 2);
    const first = mp2Step(f, cycle.record.value.steps[0]!), last = mp2Step(f, cycle.record.value.steps[1]!);
    assert.equal(first.record.value.om.failure?.code, 'answer_label_unknown');
    assert.equal(last.outcome?.kind, 'input-decisions'); assert.ok(last.record.value.om.input);
  });
});



test('OBL1 №3773 five reads that each fit alone but not together: the continuation shows the largest past what fits as their length and shape, keeps the rest whole, and the answer follows', async t => {
  const size = 4_000;
  const material = (store: Store, project: string) => {
    new Evidence(store).document(project, 'large-json', JSON.stringify(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`field${i}`, String(i).repeat(size)]))), 'application/json', 0);
  };
  const measured = e4Fixture(t, 'fact', 100_000, 0, 5000, false, true, false, undefined, material);
  const capacity = currentPacketWire(measured.packet.value.packet) + 2 * size;
  const f = e4Fixture(t, 'fact', capacity, 0, 5000, false, true, false, undefined, material);
  const source = f.store.get<Source>(`source:${f.project}:large-json`)!;
  const reads = Array.from({ length: 5 }, (_, i) => ({ action: 'read_source', source: reference(source), selector: { kind: 'json-pointer', pointer: `/field${i}` } }));
  f.steps([{ research: e4NeedSource(f, reads), usage }, { research: e4Fact(f), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'outcome', 'Never blocked by what the reads brought');
  const sent = f.sent(); assert.equal(sent.length, 2);
  assert.ok(sent[1].prompt.length <= capacity);
  const next = (f.store.list<QuestionPacketRecord>('question-packet').find(row => (row.value.packet as { requestId?: string } | null)?.requestId === sent[1].requestId)!
    .value.packet as { sourceDeliveries: { data: { data: { outcome: string } }[] }[] });
  const outcomes = next.sourceDeliveries.at(-1)!.data.map(row => row.data.outcome);
  assert.ok(outcomes.includes('complete') && outcomes.includes('too-large'), outcomes.join(','));
});



test('MP3 rows 3, 20, 24: known metadata gives no progress even at the first request; another end past EOF or another missing name is no new fact; a new served slice or omitted catalogue text is progress', async t => {
  await t.test('row 24: a length the catalogue shows ends the attempt at the first request', async child => {
    const m = mp3Cycle(child), { f, length } = m;
    f.steps([{ research: m.need([m.range(length + 10, length + 20)]), usage }]);
    const cycle = valueOf(await runModelCycle(f.store, f.request));
    assert.equal(cycle.record.value.terminal, 'research-no-progress'); assert.equal(f.sent().length, 1);
    assert.equal(f.store.list('om-read-delivery').length, 1, 'The addressed result stays a saved delivery');
  });
  await t.test('row 20: repeated EOF with another end, another missing key of the same parent and a known subslice', async child => {
    const m = mp3Cycle(child), { f, length } = m;
    f.steps([{ research: m.need([m.range(0, 9), m.pointer('/list/9')]), usage },
      { research: m.need([m.range(length + 50, length + 60), m.pointer('/list/10'), m.range(2, 8)]), usage }]);
    const cycle = valueOf(await runModelCycle(f.store, f.request));
    assert.equal(cycle.record.value.terminal, 'research-no-progress'); assert.equal(f.sent().length, 2, 'No third paid call');
    const diagnostic = f.store.get<{ refusals: { code: string }[] }>(cycle.diagnostic!.id)!;
    assert.equal(diagnostic.value.refusals[0]!.code, 'research_no_progress');
  });
  await t.test('row 24: known with new metadata, then an omitted catalogue text, are progress', async child => {
    const m = mp3Cycle(child), { f, length } = m;
    f.steps([{ research: m.need([m.range(length + 10, length + 20), m.range(10, 20)]), usage }, { research: e4Fact(f), usage }]);
    const cycle = valueOf(await runModelCycle(f.store, f.request));
    assert.equal(cycle.record.value.terminal, 'outcome'); assert.equal(f.sent().length, 2);
  });
});



test('MP3 rows 11, 12: a source changed before the first selection is omitted with its proved reason and its old text is not shown; an included source changed after issuance refuses current admission with no write or call, while history reproduces the packet', async t => {
  await t.test('row 11: a recaptured head is a proved head change', async child => {
    const m = await mp3Delivered(child, m => [m.range(0, 9), m.pointer('/format')]), { f } = m;
    writeFileSync(join(f.root, 'mp3-notes.txt'), 'Changed notes text.');
    const recaptured = new Evidence(f.store).file(f.project, 'mp3-notes', f.root, 'mp3-notes.txt', 'text/plain', 1);
    const root = mp3Open(f, 2).root(), readings = mp3Readings(root.value.packet);
    const notes = readings.entries.find(entry => canonical(entry.sources) === canonical([reference(m.notes)]))!;
    assert.deepEqual(notes.decision, { state: 'omitted', reason: 'head-changed', source: reference(m.notes), observed: reference(recaptured) });
    assert.deepEqual(mp3Carried(root).map(item => item.data.value ?? item.data.text), ['json'], 'Only the current config read is shown');
    assert.equal(packetPrompt(root.value.packet).includes(MP3_NOTES.slice(0, 9)), false, 'The changed text is never shown as current');
    f.restart(); assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(root) })), root);
  });
  await t.test('row 11: an unrecaptured changed file has an unconfirmed currency', async child => {
    const m = await mp3Delivered(child, m => [m.range(0, 9)]), { f } = m;
    writeFileSync(join(f.root, 'mp3-notes.txt'), 'Changed without a capture.');
    const root = mp3Open(f, 2).root();
    assert.deepEqual(mp3Readings(root.value.packet).entries[0]!.decision, { state: 'omitted', reason: 'currency-unconfirmed', source: reference(m.notes) });
    assert.deepEqual(mp3Carried(root), []);
    assert.deepEqual(JSON.parse(packetPrompt(root.value.packet).split('\n').at(-1)!), { omitted: { 'currency-unconfirmed': 1 } });
    f.restart(); assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(root) })), root);
  });
  await t.test('row 12: an included source changed after issuance', async child => {
    const m = await mp3Delivered(child, m => [m.pointer('/format')]), { f } = m;
    const next = mp3Open(f, 2), root = next.root();
    assert.deepEqual(mp3Decisions(root.value.packet), ['included']);
    new Evidence(f.store).document(f.project, 'mp3-config', '{"format":"xml"}', 'application/json', 1);
    const sends = f.sent().length, before = f.store.list().map(reference), calls = f.store.list('call-record').length;
    const refused = await runModelCall(f.store, { ...f.request, packet: reference(root) });
    assert.equal(refused.ok, false); if (!refused.ok) assert.deepEqual([refused.refusal.code, refused.refusal.at.ref], ['input_stale', reference(m.config)]);
    const prepared = prepareQuestionPacket(f.store, next.request);
    assert.equal(prepared.ok, false); if (!prepared.ok) assert.equal(prepared.refusal.code, 'input_stale');
    assert.deepEqual(f.store.list().map(reference), before); assert.equal(f.sent().length, sends); assert.equal(f.store.list('call-record').length, calls);
    f.restart(); assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(root) })), root);
  });
});



test('MP3 row 13: deliveries of another block\'s series reading the same file, or of another goal on the same line, are never selected', async t => {
  const m = await mp3Delivered(t, m => [m.range(0, 9)]), { f } = m;
  const series = f.store.get<RepairSeries>(f.series.id)!, goal = series.value.attempts[0]!.goal;
  const nodeBatch = f.routes.value.batches.find(batch => batch.task === 'node-expansion' && batch.node === 'garden-produce-block')!;
  const other = { project: f.project, block: nodeBatch.node!, line: 1 };
  valueOf(openSeries(f.store, { ...other, slice: 'mp3-other-block', predecessor: null, basis: null }));
  const nodeGoal = { key: 'mp3:other-block', questions: nodeBatch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, nodeBatch.items[0]!.target, nodeBatch.items[0]!.field) };
  const foreign = valueOf(managedOpenAttempt(f.store, { ...other, attempt: 1, goal: nodeGoal, completion: { routes: reference(f.routes), batches: [nodeBatch.id] } } as never));
  const foreignRoot = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, batch: nodeBatch.id, attempt: { series: reference(foreign), ordinal: 1 } })).record;
  const nodeQuestions = (foreignRoot.value.packet as { questions: { id: string }[] }).questions.map(row => row.id);
  m.run([{ research: m.need([m.range(40, 50)], foreignRoot), usage }, { research: { protocol: '$answerProtocol', requestId: '$requestId',
    action: 'cannot_answer', questionIds: nodeQuestions, reason: 'Not in the named source' }, usage }]);
  valueOf(await runModelCycle(f.store, { ...f.request, packet: reference(foreignRoot) }));
  const changedGoal = valueOf(managedOpenAttempt(f.store, { ...seriesRequestOf(series.value), attempt: 2, goal: { ...goal, key: `${goal.key}:other` },
    completion: { routes: reference(f.routes), batches: [f.batch.id] } } as never));
  const changedRoot = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, attempt: { series: reference(changedGoal), ordinal: 2 } })).record;
  assert.deepEqual(mp3Readings(changedRoot.value.packet).entries, [], 'Another goal of the same line selects nothing');
  m.run([{ research: m.need([m.range(60, 70)], changedRoot), usage }, { research: e4CannotAnswer(f), usage }]);
  valueOf(await runModelCycle(f.store, { ...f.request, packet: reference(changedRoot) })); mp3Close(f, 2);
  const root = mp3Open(f, 3).root();
  assert.deepEqual(mp3Origins(root), [['attempt 1']], 'Only attempt 1 of this exact line and full goal');
  assert.deepEqual(mp3Carried(root).map(item => item.data.text), [MP3_NOTES.slice(0, 9)]);
  assert.equal(f.store.list('om-read-delivery').length, 3, 'The excluded deliveries stay saved');
});


test('MP3 row 18 (MP2 correction of an attempt root): the correction shows the carried set after its own sections; fullChars keeps the MP1 meaning; the model sees the read', async t => {
  const m = mp3Cycle(t, 'node', 100_000, true), { f } = m;
  f.steps([{ research: m.need([m.range(0, 9)]), usage }, { research: e4CannotAnswer(f), usage }]);
  valueOf(await runModelCycle(f.store, f.request)); mp3Close(f, 1);
  const second = mp3Open(f, 2), root2 = second.root() as Revision<QuestionPacketRecord>;
  assert.deepEqual(mp3Decisions(root2.value.packet), ['included']);
  f.steps([{ research: m.need([m.range(0, 9)]), usage }, { research: e4CannotAnswer(f), usage }, { research: mp2Refused(f, root2), usage }, { research: e4Node(f, root2), usage }]);
  const cycle = valueOf(await mp2Cycle(f.store, { ...f.request, packet: reference(root2) }));
  assert.equal(cycle.record.value.terminal, 'assembled'); assert.equal(f.sent().length, 4, 'One correction call');
  const [, correction] = cycle.record.value.steps.map(step => valueOf(readQuestionPacket(f.store, { project: f.project, record: step.packet })));
  assert.ok(correction!.value.request.correction);
  assert.deepEqual(mp3Readings(correction!.value.packet), mp3Readings(root2.value.packet), 'The same snapshots, entries and decisions as the root it corrects');
  assert.deepEqual(mp3Carried(correction!).map(item => item.data.text), [MP3_NOTES.slice(0, 9)]);
  const text = packetPrompt(correction!.value.packet), own = text.indexOf('# Correction of your previous answer'), carried = text.indexOf('\n# Carried reads');
  assert.ok(own >= 0 && carried > own, 'The carried section follows the correction and the rest of the bounded brief');
  assert.equal(correction!.value.fullChars, carried, 'fullChars counts the bounded brief without the carried section');
  const sent = f.sent()[3] as { prompt: string };
  assert.ok(sent.prompt.includes('# Carried reads') && sent.prompt.includes(JSON.stringify(MP3_NOTES.slice(0, 9))), 'The model sees the carried read with the correction');
  f.restart();
  assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(correction!) })), correction);
});


test('MP3 №3171: a search over an existing empty directory is a lawful delivery without sources or rows; the next attempt root carries it beside the text read, stays ready and reopens unchanged', async t => {
  const m = mp3Cycle(t, 'fact', 100_000, true), { f } = m;
  mkdirSync(join(f.root, 'empty-search'));
  f.steps([{ research: m.need([MP3_EMPTY_SEARCH, m.range(0, 9)]), usage }, { research: e4CannotAnswer(f), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.steps.length, 2);
  const empty = mp3SearchDelivery(f);
  assert.deepEqual([empty.value.sources, empty.value.data], [[], []], 'The producer writes no source and no row');
  mp3Close(f, 1);
  const second = mp3Open(f, 2), root2 = second.root();
  assert.equal(root2.value.state, 'ready');
  const carried = mp3Readings(root2.value.packet).entries.find(entry => entry.origins.some(origin => origin.delivery.id === empty.id))!;
  assert.deepEqual(carried.sources, []); assert.equal(carried.decision.state, 'included');
  assert.deepEqual(mp3Decisions(root2.value.packet), ['included', 'included']);
  const shown = mp3Carried(root2);
  assert.deepEqual(shown.find(item => item.read.action === 'search'), { origins: [{ kind: 'attempt', attempt: 1 }], read: MP3_EMPTY_SEARCH, data: [] });
  assert.ok(shown.some(item => item.data.text === MP3_NOTES.slice(0, 9)), 'The text read is carried beside it');
  const sends = f.sent().length, before = f.store.list().map(reference);
  f.restart();
  assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(root2) })), root2);
  assert.deepEqual(valueOf(writeQuestionPacket(f.store, second.request)).record, root2);
  assert.deepEqual(f.store.list().map(reference), before); assert.equal(f.sent().length, sends);
});


test('MP3 №3171 (novelty): an existing empty directory is new knowledge the first time it is searched; searching it again with any query adds nothing', async t => {
  const m = mp3Cycle(t), { f } = m;
  mkdirSync(join(f.root, 'empty-search'));
  f.steps([{ research: m.need([MP3_EMPTY_SEARCH]), usage }, { research: m.need([{ ...MP3_EMPTY_SEARCH, query: 'another' }]), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(f.sent().length, 2, 'The first search of the empty directory is progress: its continuation is sent');
  assert.equal(cycle.record.value.terminal, 'research-no-progress', 'The same directory again holds nothing new');
});



test('LP5 (№3278 rows 17, 19) a reuse carries a non-empty D7 to today\'s handoff: the same assignments by their common key, today\'s binding ids and scopes, every consumer and its tests kept; an old D7 is refused; G5 reads the reuse as a checked source of today\'s handoff', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const f = e4WorksFixture(t, true), project = f.project;
  const series = () => reference(f.store.get(f.series.id)!);
  const first = valueOf(readCompletionBinding(f.store, project, series(), 1))!;
  valueOf(writeAnswersRegistration(f.store, { project, binding: reference(first) }));
  f.steps([{ research: f.answer(), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.terminal, 'assembled');
  // The B1 of the area is replaced (G1): the check ends by it and the attempt closes interrupted, its paid assembly kept.
  const before = f.store.get(`om-input:${project}`)!;
  const inventory = f.store.write({ id: `repo-inventory:${project}`, kind: 'repo-inventory', expected: 0, value: { projectId: project, paths: [] } });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const input = valueOf(writeOmInput(f.store, { project, stages, inventory: reference(inventory), expected: before.revision }));
  assert.equal(valueOf(writeAnswersCheckCessation(f.store, { project, binding: reference(first) })).value.variant, LP5_AREA_INPUT);
  valueOf(closeAttempt(f.store, { ...f.address, attempt: 1, outcome: { reason: 'interrupted', accepting: [], cancelling: [], refusals: [] } }));
  // The plan of the next attempt over the new B1: its own horizon, D1, D2, D7 with the owner's assignment in its context, M6.
  const horizon = valueOf(writeHorizon(f.store, { project, input: reference(input), graph: f.graph, refinement: f.layer2, available: {},
    choice: { choiceVersion: 'e4-work-pass-lp5', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: f.graph, horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { ...f.frame2, graph: f.graph, horizon: reference(horizon.gate), layer: f.layer2, frame: f.upperFrame } },
    works: { proposals: [], frame: { project, level: 3, graph: f.graph, horizon: reference(horizon.gate), layer: null, frame: null,
      upper: { horizon: reference(horizon.gate), frame: f.upperFrame } } } };
  const gaps = valueOf(writeGaps(f.store, sources)), gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = valueOf(writeGapLines(f.store, { project, previous: reference(f.store.get(f.lines.id)!), pass: 2, gaps: gapRead, closures: [] }));
  const late = gaps.records.find(row => row.value.gap.target === 'discovery:late-proof')!;
  const assignment = normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project, context: { gaps: gapRead, lines: reference(lines) },
    gap: reference(late), assignments: late.value.gap.consumers.map(consumer => ({ responsibleNode: 'garden-produce-operation',
      responsibleConsumer: consumer, reason: 'Retain the concrete result test', returnCondition: `Prove result for ${consumer}`, wake: null })) });
  const ledger = valueOf(writeOmObligations(f.store, { project, gaps: gapRead, lines: reference(lines), assignments: [{ pending: {
    id: `om-owner-gap-assignment:${project}:${hashJson(assignment)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value: assignment } }] }));
  const routes = valueOf(writeRoutes(f.store, { project, gaps: gapRead, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const batch = routes.value.batches.find(row => row.level === 3 && row.node === 'garden-produce-operation')!;
  valueOf(managedOpenAttempt(f.store, { ...f.address, attempt: 2, goal: f.goal, completion: { routes: reference(routes), batches: [batch.id] } } as never));
  const second = valueOf(readCompletionBinding(f.store, project, series(), 2))!;
  const root = completionRootAssignments(second).find(row => row.value.batch === batch.id)!;
  const works = { producer: reference(ledger.producer), ledger: reference(ledger.record) };
  // Row 19: the D7 of the old area is never taken for today's.
  assert.equal(prepareCompletionReuse(f.store, { project, binding: reference(second), root: reference(root),
    works: { producer: reference(f.ledger.producer), ledger: reference(f.ledger.record) } }).ok, false);
  const reuse = valueOf(writeCompletionReuse(f.store, { project, binding: reference(second), root: reference(root), works }));
  const sorted = <T>(rows: readonly T[]) => [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const expected = ledger.handoff.obligations.map(item => ({ id: taskBindingId(item as CarriedObligation), scope: item.scope, obligation: item.obligation,
    consumers: [{ node: f.work.id, tests: [...f.work.tests] }] }));
  assert.ok(expected.length > 0, 'Today\'s handoff is not empty');
  assert.deepEqual(sorted(reuse.value.works.bindings), sorted(expected), 'Every binding carried by its common key to today\'s ids and scopes');
  assert.ok(reuse.value.works.bindings.every(row => !f.bindings.some(old => old.id === row.id)), 'No binding keeps the old authority');
  assert.deepEqual([reuse.value.works.producer, reuse.value.works.ledger], [works.producer, works.ledger]);
  f.restart();
  assert.deepEqual(valueOf(readCompletionReuseAt(f.store, project, reference(reuse))), reuse, 'Read back by its common derivation');
  // A saved reuse that lost a proof reference, or carries one more field, is a typed refusal of its reader — never a crash.
  for (const value of [{ ...reuse.value, source: { ...reuse.value.source, close: undefined } }, { ...reuse.value, works: { ...reuse.value.works, ledger: null } },
    { ...reuse.value, origin: { assembly: reuse.value.origin.assembly } }, { ...reuse.value, extra: true }]) {
    const body = JSON.parse(JSON.stringify(value)) as Json, forged = { ...reuse, value: body, hash: hashJson(body) };
    const view = new Proxy(f.store, { get(target, property) {
      if (property === 'get') return (key: string, revision?: number) => key === forged.id ? forged : target.get(key, revision);
      const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    const read = readCompletionReuseAt(view, project, reference(forged as never));
    assert.deepEqual(read.ok ? 'accepted' : read.refusal.code, 'completion_invalid', JSON.stringify(Object.keys(value)));
  }
  // G5 takes the reuse as a checked source of today's handoff: its non-empty bindings pass the transfer to the final D7;
  // only the works of the other operation, never asked here, keep the candidate open (the whole C4/G5 is the pass's test).
  const gate = prepareWorksSources(f.store, { project, results: [{ kind: 'reuse', record: reference(reuse) }] });
  assert.deepEqual(gate.ok ? 'accepted' : [gate.refusal.code, gate.refusal.at.field], ['work_blocking_gap_open', 'candidate']);
});

