import test from 'node:test';
import { BASIS_BRIEF_SELECTION_CONTRACT, packetPrompt } from '../src/om/packet-brief.js';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, type Json } from '../src/canonical.js';
import { runModelCall, deliverModelSources, readContinuationEvidence, readManagedModelDiagnostic, prepareModelAttemptFinish, finishModelAttempt, type OmModelCall, runModelCycle, runModelCycle as mp2Cycle, CYCLE_POLICY, readModelCycle as mp2ReadCycle } from '../src/om/model-call.js';
import { Store, type Revision, type Write } from '../src/storage/store.js';
import { type Ref, reference } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { writeAddressing, inputDecisionWrite } from '../src/om/addressing.js';
import { writeGuarded } from '../src/om/refs.js';
import { writeQuestionPacket, type QuestionPacketRecord, prepareQuestionPacket, readQuestionPacket } from '../src/om/question-packet.js';
import { readCompletionBinding, type RepairSeries, completionWorkId, completeAttempt, seriesRequestOf } from '../src/om/series.js';
import { recordCall } from '../src/om/call-record.js';
import { openAttempt as managedOpenAttempt } from '../src/om/repeat-gate.js';
import { Environments } from '../src/runtime/environment.js';
import { Evidence } from '../src/evidence/evidence.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { MP3_NOTES, MP3_SCOPES, completionE1, completionSnapshot, currentPacketWire, e4CannotAnswer, e4Fact, e4Fixture, e4NeedSource, e4Node, fixtureCheckpoint, fixtureDriver, h15CannotAnswer, h15Refusal, killFixtureProvider, lp4CeasedStep, lp4Need, lp4Root, mp2Managed, mp2Refused, mp2Step, mp3Carried, mp3Close, mp3Cycle, mp3DecisionOf, mp3Decisions, mp3Delivered, mp3Open, mp3Origins, mp3Readings, mp3ScopeAttempt, signalFixtureProvider, usage, valueOf } from './om-model-call-fixture.js';



test('E4 delivery writes guard source heads, and a repeat after restart returns the same deliveries without writes', async t => {
  const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true); f.steps([{ research: e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]) }]);
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
  assert.equal(valueOf(readContinuationEvidence(f.store, { ...basis, deliveries: delivered.deliveries as Ref[] })).data.length, 1);
  const before = f.store.list().map(reference); f.restart();
  assert.deepEqual(valueOf(deliverModelSources(f.store, basis)).deliveries, delivered.deliveries);
  assert.deepEqual(f.store.list().map(reference), before);
});


test('E4 retains terminal evidence when environment or captured file changes during the physical call before E3 preparation', async t => {
  for (const change of ['environment', 'file'] as const) {
    const f = e4Fixture(t, 'fact', 100_000, 0, 5000, true, true, false, undefined, (store, project, root) => {
      new Evidence(store).file(project, 'transport-file', root, 'e4-source.txt', 'text/plain', 0);
    }), reply = e4Fact(f);
    const file = f.store.get<import('../src/evidence/evidence.js').Source>(`source:${f.project}:transport-file`)!;
    if (change === 'file') reply.results[0]!.citations = [{ source: reference(file), selector: { kind: 'text-range', start: 0, end: file.value.content.length } }];
    f.steps([{ research: reply, usage }]);
    const get = f.store.get.bind(f.store); let injected = false;
    f.store.get = ((id, revision) => {
      if (!injected && f.sent().length && id === (change === 'environment' ? f.configured.id : file.id)) {
        injected = true;
        if (change === 'environment') {
          // A same-value rewrite is compatible under the managed admission; only a genuinely incompatible
          // replacement of the measured environment ceases the assignment at application.
          const env = get(f.configured.id)! as Revision<import('../src/runtime/environment.js').Environment>;
          const { projectId: _project, ...config } = structuredClone(env.value);
          config.implementer.model = 'changed-mid-call';
          new ProductEngine(f.store).environments.configure(f.project, config, env.revision);
        } else writeFileSync(join(f.root, 'e4-source.txt'), 'A different physical source after the request.');
      }
      return get(id, revision);
    }) as Store['get'];
    const actual = await runModelCall(f.store, f.request); f.store.get = get;
    assert.ok(injected); assert.equal(f.sent().length, 1);
    const exchanges = f.store.list('om-model-exchange'); assert.equal(exchanges.length, 1);
    assert.equal(f.store.list('part-response').length, 0);
    // Under the managed carrier either mid-call change ends in a typed refusal: an incompatible environment
    // ceases the assignment (its proved cessation is written); a changed captured file makes the answer
    // inapplicable at its exact source. The received exchange and the paid usage stay as they were.
    assert.equal(actual.ok, false);
    const expected = change === 'environment' ? 'completion_ceased' : 'answer_inapplicable';
    if (!actual.ok) {
      assert.equal(actual.refusal.code, expected);
      if (change === 'file') assert.deepEqual([actual.refusal.at.unit, actual.refusal.at.target, actual.refusal.at.field], ['D5', file.id, 'source']);
    }
    if (change === 'environment') assert.equal(f.store.list('om-completion-cessation').length, 1);
    // The refused application leaves the paid receipt untouched in its received state: a successful
    // transport, application still pending, no rejection, and response/exchange linked to the one
    // saved exchange — a mistakenly written failed/application-refused record cannot pass as this.
    const record = f.store.list<OmModelCall>('model-call')[0]!;
    assert.equal(record.value.status, 'succeeded');
    assert.equal(record.value.om.application, 'received');
    assert.equal(record.value.om.rejection, null);
    assert.deepEqual(record.value.om.exchange, reference(exchanges[0]!));
    assert.deepEqual(record.value.response?.record, reference(exchanges[0]!));
    assert.deepEqual(record.value.usage, usage);
    writeFileSync(join(f.root, 'e4-source.txt'), 'Still later file content must not reinterpret the refused window.');
    const before = f.store.list().map(reference); f.restart();
    const repeat = await runModelCall(f.store, f.request);
    assert.equal(repeat.ok, false);
    // On the repeat the same proved cessation refuses earlier — at the disposition check rather than
    // the application check — so field/message legitimately differ; the code and the address
    // (unit, target and the cessation record itself) must stay identical.
    if (!repeat.ok && !actual.ok) {
      assert.equal(repeat.refusal.code, actual.refusal.code);
      assert.deepEqual([repeat.refusal.at.unit, repeat.refusal.at.target, repeat.refusal.at.ref],
        [actual.refusal.at.unit, actual.refusal.at.target, actual.refusal.at.ref]);
    }
    assert.deepEqual(f.store.list().map(reference), before); assert.equal(f.sent().length, 1);
    assert.deepEqual(f.store.get(record.id), record, 'The refused receipt keeps its exact received state');
  }
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



test('C31 H1.0b selected MC2 E2 without E1 keeps every still compatible role', async t => {
  const { prepareCompletionCause, writeCompletionCessation, readCompletionCause, readCompletionCessationAt } = await import('../src/om/model-call.js');
  const measured = e4Fixture(t, 'node', 100_000, 0, 5000, true);
  for (const changed of ['implementer', 'reviewer', 'both', 'common', 'none'] as const) await t.test(changed, async child => {
    const f = e4Fixture(child, 'node', currentPacketWire(measured.packet.value.packet) - 1, 0, 5000, true);
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



test('H1.5 №2166 п.5 a changed basis between the choice and the claim does not open the prohibition: the saved packet stays refused, and the packet of the new environment is refused for the same question', async t => {
  const f = e4Fixture(t, 'design', 100_000, 0, 5000, true);
  f.steps([{ research: h15CannotAnswer, usage }]);
  // The environment is measured into the packet: a new capacity is another basis of the same batch.
  const changed = f.environment(120_000);
  assert.notDeepEqual(reference(changed), reference(f.configured));
  const stale = h15Refusal(await runModelCall(f.store, f.request));
  assert.notEqual(stale.code, 'ok');
  const request = { ...f.packetRequest, environment: reference(changed) };
  const next = valueOf(writeQuestionPacket(f.store, request)).record;
  assert.equal(next.value.state, 'ready');
  const nextRefusal = h15Refusal(await runModelCall(f.store, { ...f.request, packet: reference(next), dispatch: { adapter: reference(f.adapter), config: reference(changed) } }));
  assert.equal(nextRefusal.code, 'route_result_unsupported');
  assert.equal(nextRefusal.at.target, 'discovery:spare');
  assert.equal(f.sent().length, 0);
});



test('LP4 (№2887 row 3) a root with a direct cause of its own is ceased by that cause: the new ground never replaces it', async t => {
  const { prepareCompletionCause, writeCompletionCessation } = await import('../src/om/model-call.js');
  const f = e4Fixture(t, 'node', 100_000, 0, 5000, true, true, true);
  f.steps([{ research: lp4Need(f, f.packet), usage }]);
  const { owner, cease } = await lp4CeasedStep(f), root = lp4Root(f);
  f.environment(90_000); cease();
  assert.equal(valueOf(prepareCompletionCause(f.store, f.project, reference(root))).cause!.kind, 'cycle-step-ceased');
  valueOf(writeAddressing(f.store, { project: f.project, input: reference(f.input), graph: reference(f.graph),
    decisions: [{ pending: structuredClone(inputDecisionWrite({ project: f.project, input: reference(f.input), graph: reference(f.graph), layers: [],
      decision: { target: 'discovery:spare', field: 'address', value: { consumer: 'garden-consume-block', kind: 'repository-fact' } } })) as Write }] }));
  const direct = valueOf(prepareCompletionCause(f.store, f.project, reference(root))).cause!;
  assert.equal(direct.kind, 'required-record-replaced');
  const ceased = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(root) }));
  assert.deepEqual([ceased.value.remainder, ceased.value.cause], ['assembly', direct]);
  assert.equal(completionSnapshot(f).complete, true); assert.equal(f.sent().length, 1);
});



test('LP4 (№2887 row 5, §6.4) the other steps of a node whose step ceased, with no ground of their own (the environment configured back as it was), are ceased by the new cause with their own remainders: an unmaterialized part — expansion; a continuation inside the part materialized without a claim — not-dispatched; received and unapplied — application with its response and usage kept; with an applied need_source — continuation; a live call stays the common recovery\'s; the old cycle stays refused', async t => {
  const { prepareCompletionCause, writeCompletionCessation } = await import('../src/om/model-call.js');
  await t.test('expansion', async t => {
    const f = e4Fixture(t, 'node', 100_000, 0, 5000, true), capacity = currentPacketWire(f.packet.value.packet) - 1, config = f.environment(capacity);
    const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
    assert.ok(packet.value.plan!.assignments.length > 1);
    const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
    f.steps([{ research: lp4Need(f, packet), usage }]);
    const { cease, owner } = await lp4CeasedStep(f, request);
    f.environment(90_000); const step = cease(); f.environment(capacity);
    const later = completionSnapshot(f).assignments.filter(row => row.value.kind === 'part' && row.id !== owner.assignment.id);
    assert.ok(later.length > 0);
    for (const part of later) {
      assert.deepEqual(valueOf(prepareCompletionCause(f.store, f.project, reference(part))).cause, { kind: 'cycle-step-ceased',
        cessation: reference(step), work: reference(f.store.get(completionWorkId(f.project, owner.binding.id))!) });
      const ceased = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(part) }));
      assert.deepEqual([ceased.value.disposition, ceased.value.remainder, ceased.value.packet], ['branch-ceased', 'expansion', null]);
    }
    const root = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(lp4Root(f)) }));
    assert.deepEqual([root.value.remainder, root.value.cause.kind], ['assembly', 'cycle-step-ceased']);
    assert.equal(completionSnapshot(f).complete, true);
    const cycle = await runModelCycle(f.store, request);
    assert.ok(!cycle.ok && cycle.refusal.code === 'completion_ceased', '§6.4: the environment configured back revives no ceased cycle');
    assert.equal(f.sent().length, 1);
  });
  for (const variant of ['not-dispatched', 'application', 'continuation', 'live'] as const) await t.test(`continuation inside the part: ${variant}`, async t => {
    const f = e4Fixture(t, 'node', 100_000, 0, 30_000, true), checkpoint = join(f.root, 'lp4-live.json');
    const need = { research: lp4Need(f, f.packet), usage };
    f.steps([need, variant === 'live' ? { ...need, pauseAfterRequest: checkpoint } : need]);
    const { first, owner, cease } = await lp4CeasedStep(f);
    const basis = { project: f.project, packet: f.request.packet, call: first.call, response: first.response! };
    const delivered = valueOf(deliverModelSources(f.store, basis));
    const next = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, previous: [], continuation: { packet: basis.packet, call: basis.call,
      response: basis.response, deliveries: [...delivered.deliveries] } })).record;
    assert.equal(next.value.state, 'ready');
    const continued = { ...f.request, packet: reference(next) };
    let driver: ReturnType<typeof fixtureDriver> | null = null, provider: { pid: number; started: string } | null = null;
    if (variant === 'not-dispatched') valueOf(recordCall(f.store, f.project, completionE1(f, next)));
    if (variant === 'continuation') assert.equal(valueOf(await runModelCall(f.store, continued)).outcome?.kind, 'need-source');
    if (variant === 'application') {
      const write = f.store.writeMany.bind(f.store); let raced = false;
      f.store.writeMany = ((writes, guards) => {
        if (!raced && writes.some(row => row.kind === 'model-call' && (row.value as OmModelCall).om?.application === 'applied')) {
          raced = true;
          // A legal configure of the same environment in another Store moves the guarded head before the application.
          const other = new Store(f.database);
          try {
            const old = other.get<import('../src/runtime/environment.js').Environment>(f.configured.id)!;
            const { projectId: _project, ...config } = structuredClone(old.value);
            new ProductEngine(other).environments.configure(f.project, config, old.revision);
          } finally { other.close(); }
        }
        return write(writes, guards);
      }) as Store['writeMany'];
      const refused = await runModelCall(f.store, continued); f.store.writeMany = write;
      assert.ok(raced && !refused.ok);
    }
    if (variant === 'live') {
      driver = fixtureDriver(t, f.database, f.root, 'call', continued);
      await fixtureCheckpoint(checkpoint, driver.child);
      const running = f.store.list<ModelCall>('model-call').find(row => (row.value as unknown as OmModelCall).om?.request.packet.id === next.id)!;
      provider = running.value.execution!.provider!;
      t.after(() => { signalFixtureProvider(provider!.pid, provider!.started); });
    }
    const sent = f.sent().length, calls = f.store.list('model-call');
    f.environment(90_000); const step = cease(); f.environment(100_000);
    const continuation = completionSnapshot(f).assignments.find(row => row.value.kind === 'continuation')!;
    const cause = valueOf(prepareCompletionCause(f.store, f.project, reference(continuation))).cause!;
    assert.deepEqual([cause.kind, (cause as { cessation: Ref }).cessation], ['cycle-step-ceased', reference(step)]);
    const ceased = writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(continuation) });
    if (variant === 'live') {
      assert.ok(!ceased.ok && ceased.refusal.code === 'completion_claim_exists', 'A live call stays the common recovery\'s');
      assert.equal(f.store.list('om-completion-cessation').length, 1);
      await killFixtureProvider(provider!.pid, provider!.started); await driver!.exit;
      return;
    }
    const value = valueOf(ceased).value;
    assert.deepEqual([value.disposition, value.remainder], variant === 'not-dispatched' ? ['not-dispatched', null] : ['branch-ceased', variant]);
    assert.deepEqual(f.store.list('model-call'), calls, 'Every paid response, its exchange and its usage stay as they were');
    const root = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(lp4Root(f)) }));
    assert.deepEqual([root.value.remainder, root.value.cause.kind], ['assembly', 'cycle-step-ceased']);
    assert.equal(completionSnapshot(f).complete, true);
    for (const request of [f.request, continued]) {
      const repeated = await runModelCycle(f.store, request);
      assert.ok(!repeated.ok && repeated.refusal.code === 'completion_ceased');
    }
    assert.equal(f.sent().length, sent, 'Nothing is sent again');
  });
});



test('LP4 (№2887 §6.7) a work moved by another Store between the preparation of a cycle-step-ceased cessation and its write — the other step ceased there — refuses that write as a whole; the write prepared afresh stands', async t => {
  const { prepareCompletionCessation, writeCompletionCessation } = await import('../src/om/model-call.js');
  const f = e4Fixture(t, 'node', 100_000, 0, 5000, true), capacity = currentPacketWire(f.packet.value.packet) - 1, config = f.environment(capacity);
  const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record;
  const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
  f.steps([{ research: lp4Need(f, packet), usage }]);
  const { owner, cease } = await lp4CeasedStep(f, request);
  f.environment(90_000); cease(); f.environment(capacity);
  const part = completionSnapshot(f).assignments.find(row => row.value.kind === 'part' && row.id !== owner.assignment.id)!;
  const prepared = valueOf(prepareCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(part) }));
  assert.equal(prepared.record.value.cause.kind, 'cycle-step-ceased');
  const other = new Store(f.database);
  try { valueOf(writeCompletionCessation(other, { project: f.project, binding: owner.binding, assignment: reference(lp4Root(f)) })); }
  finally { other.close(); }
  const before = f.store.list();
  const stale = writeGuarded(f.store, { unit: 'G7', target: prepared.record.id, writes: prepared.writes as Write[], guards: prepared.guards as never });
  assert.ok(!stale.ok, 'The moved work refuses the prepared write');
  assert.deepEqual(f.store.list(), before, 'Nothing of it is written');
  const fresh = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(part) }));
  assert.deepEqual([fresh.value.remainder, fresh.value.cause.kind], ['expansion', 'cycle-step-ceased']);
  assert.notDeepEqual(fresh.value.work, prepared.record.value.work, 'Proved on the work as it stands now');
  assert.equal(f.sent().length, 1);
});



test('MP2 (№2968 rows 7, 8, 14) a proved repairable E3 refusal of a managed brief chain gets one correction — the same material and labels, the exact refusal and the verbatim answer under a new request — and the corrected part assembles; a restart repeats without a send', async t => {
  const f = mp2Managed(t);
  assert.equal(f.packet.value.packetContract, 'om-packet/brief-v1');
  f.steps([{ research: mp2Refused(f) }, { research: e4Node(f) }]);
  const cycle = valueOf(await mp2Cycle(f.store, f.request));
  assert.equal(cycle.record.value.cyclePolicy, CYCLE_POLICY, 'Row 7: a new brief cycle carries the correction policy');
  assert.equal(cycle.record.value.terminal, 'assembled', 'Row 8: the corrected answer is the normal result');
  assert.equal(f.sent().length, 2, 'Row 7: exactly one new call');
  const [first, second] = cycle.record.value.steps;
  const rejected = mp2Step(f, first!), corrected = f.store.get<QuestionPacketRecord>(second!.packet.id)!;
  assert.ok(rejected.diagnostic && rejected.response && rejected.record.value.om.failure);
  assert.equal(rejected.record.value.om.failure!.code, 'answer_label_unknown');
  assert.deepEqual(corrected.value.request.correction, { packet: first!.packet, call: rejected.call, response: rejected.response, diagnostic: rejected.diagnostic });
  const { correction: _correction, ...root } = corrected.value.request;
  assert.deepEqual(root, f.packetRequest, 'Row 7: the same root, attempt and assignment, no new attempt');
  const prior = f.packet.value.packet as Record<string, any>, payload = corrected.value.packet as Record<string, any>;
  assert.notEqual(payload.requestId, prior.requestId, 'A new request and response form');
  assert.equal(payload.responseForm.requestId, payload.requestId);
  assert.deepEqual(payload.brief.labels, prior.brief.labels, 'The same label map');
  assert.deepEqual(payload.brief.manifest, prior.brief.manifest, 'The same material');
  assert.deepEqual(corrected.value.plan, f.packet.value.plan, 'The same assignment');
  const raw = f.store.get<{ raw: string }>(rejected.response!.id)!.value.raw;
  assert.deepEqual(payload.correction, { refusals: [{ code: 'answer_label_unknown', field: rejected.record.value.om.failure!.at.field,
    message: rejected.record.value.om.failure!.message, rule: 'Use the issued label in its declared reference domain.' }], answer: raw });
  const sent = f.sent()[1] as { prompt: string; requestId: string };
  assert.equal(sent.requestId, payload.requestId);
  assert.ok(sent.prompt.includes('# Correction of your previous answer') && sent.prompt.includes('answer_label_unknown') && sent.prompt.includes('X999'));
  // Row 14: the first refusal keeps its journal; a restart reads and repeats the cycle without any new record or send.
  assert.ok(f.store.get(rejected.diagnostic!.id));
  const snapshot = f.store.list().map(reference); f.restart();
  valueOf(mp2ReadCycle(f.store, { project: f.project, record: reference(cycle.record) }));
  assert.equal(valueOf(await mp2Cycle(f.store, f.request)).repeated, true);
  assert.equal(f.sent().length, 2); assert.deepEqual(f.store.list().map(reference), snapshot);
});



test('MP2 return №3147 (rows 14, 16; §4) a step whose chain owes its correction is ceased lawfully when the environment changes — before the correction is written and after it is written but not sent: branch ceased with its continuation remainder, the paid answer, diagnostic and expense kept, nothing sent, the root ceased by its ceased step, the cessation read back after a restart', async t => {
  const { prepareCompletionCause, writeCompletionCessation, readCompletionCessationAt } = await import('../src/om/model-call.js');
  for (const boundary of ['not written', 'written, not sent'] as const) await t.test(boundary, async t => {
    const f = mp2Managed(t);
    f.steps([{ research: mp2Refused(f) }, { research: e4Node(f) }]);
    const first = valueOf(await runModelCall(f.store, f.request));
    const owner = first.record.value.om.completionOwner!;
    const ground = { packet: first.packet, call: first.call, response: first.response!, diagnostic: first.diagnostic! };
    if (boundary === 'written, not sent') valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, correction: ground }));
    assert.equal(completionSnapshot(f).resolved.length, 0, 'The owed correction keeps the root open');
    f.environment(90_000);
    assert.ok(valueOf(prepareCompletionCause(f.store, f.project, owner.assignment)).cause, 'The changed environment ends the owed step');
    const ceased = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: owner.assignment }));
    assert.deepEqual([ceased.value.disposition, ceased.value.remainder, ceased.value.packet, ceased.value.physical],
      ['branch-ceased', 'continuation', null, null], 'The paid call is no never-dispatched claim; its remainder is the owed continuation');
    const rootCessation = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(lp4Root(f)) }));
    assert.equal(rootCessation.value.cause.kind, 'cycle-step-ceased');
    const snapshot = completionSnapshot(f);
    assert.equal(snapshot.complete, true, 'The attempt can close');
    assert.ok(snapshot.refusals.length > 0, 'The paid refusal keeps its journal rows for the close');
    assert.ok(snapshot.technical.some(row => row.reason === 'interrupted'), 'The cessation is the technical outcome');
    f.restart();
    assert.deepEqual(valueOf(readCompletionCessationAt(f.store, f.project, reference(ceased))), ceased, 'The common derivation reads it back');
    const cycle = await mp2Cycle(f.store, f.request);
    assert.equal(cycle.ok, false); if (!cycle.ok) assert.equal(cycle.refusal.code, 'completion_ceased');
    assert.equal(f.sent().length, 1, 'Nothing is sent: neither the paid answer again nor its correction');
    assert.ok(f.store.get(first.diagnostic!.id) && f.store.get(first.response!.id), 'The paid answer and its diagnostic stay');
  });
});



test('MP3 row 15: a carried read that does not fit is omitted first with its reason, the packet stays ready, and reading it again is progress', async t => {
  const m = await mp3Delivered(t, m => [m.range(0, 40_000, m.large)]), { f } = m;
  const next = mp3Open(f, 2), probe = valueOf(prepareQuestionPacket(f.store, next.request)).record;
  assert.deepEqual(mp3Decisions(probe.value.packet), ['included']);
  const tight = f.environment(currentPacketWire(probe.value.packet) - 1);
  const root = valueOf(writeQuestionPacket(f.store, { ...next.request, environment: reference(tight) })).record;
  assert.equal(root.value.state, 'ready'); assert.deepEqual(mp3Decisions(root.value.packet), ['capacity']);
  assert.ok(currentPacketWire(root.value.packet) <= tight.value.requestCapacityChars!); assert.deepEqual(mp3Carried(root), []);
  m.run([{ research: m.need([m.range(0, 100, m.large)], root), usage }, { research: e4CannotAnswer(f), usage }]);
  const cycle = valueOf(await runModelCycle(f.store, { ...f.request, packet: reference(root), dispatch: { ...f.request.dispatch, config: reference(tight) } }));
  assert.equal(cycle.record.value.steps.length, 2, 'Omitted carried text is not known: reading it again is progress');
});



test('MP3 window (Т7): a second Store moving an included carried source between preparation and write refuses the whole packet write', async t => {
  const m = await mp3Delivered(t, m => [m.pointer('/format')]), { f } = m;
  const next = mp3Open(f, 2), prepared = valueOf(prepareQuestionPacket(f.store, next.request));
  assert.deepEqual(mp3Decisions(prepared.record.value.packet), ['included']);
  assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(reference(m.config))), 'The included source is a condition of the write');
  const second = new Store(f.database);
  try { new Evidence(second).document(f.project, 'mp3-config', '{"format":"xml"}', 'application/json', 1); } finally { second.close(); }
  const before = f.store.list().map(reference);
  const written = writeGuarded(f.store, { unit: 'E2', target: prepared.record.id, writes: prepared.writes as Write[], guards: prepared.guards as Parameters<typeof writeGuarded>[1]['guards'] });
  assert.equal(written.ok, false); if (!written.ok) assert.equal(written.refusal.code, 'input_stale');
  assert.deepEqual(f.store.list().map(reference), before); assert.equal(f.store.get(prepared.record.id), null);
});


test('MP3 №3190: an unchanged scope is carried; a file added after the selection refuses the current admission of the issued packet by the delivery itself, while its history replays the saved choice without walking the disk', async t => {
  for (const [name, files] of MP3_SCOPES) await t.test(name, async t => {
    const { f, search, second } = await mp3ScopeAttempt(t, files);
    const root2 = second.root();
    assert.equal(mp3DecisionOf(root2, search), 'included', 'Positive control: the unchanged scope is current');
    assert.deepEqual(valueOf(prepareQuestionPacket(f.store, second.request)).record, root2, 'Unchanged: current admission prepares the same packet');
    writeFileSync(join(f.root, 'scope', 'new.txt'), 'the newneedle is here');
    const refused = prepareQuestionPacket(f.store, second.request);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.deepEqual([refused.refusal.code, refused.refusal.at.target, refused.refusal.at.field], ['input_stale', search.id, 'readings']);
    assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(root2) })), root2, 'History keeps the saved choice');
    f.restart();
    assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(root2) })), root2);
  });
});


test('MP3 on merged MP2 (№3147 junction): an attempt ceased with its correction owed after reads carries its delivery into the next attempt — by the series outcome and the physical steps, the cessation code untouched', async t => {
  const { prepareCompletionCause, writeCompletionCessation } = await import('../src/om/model-call.js');
  const m = mp3Cycle(t, 'node', 100_000, true), { f } = m;
  f.steps([{ research: m.need([m.range(0, 9)]), usage }, { research: mp2Refused(f), usage }, { research: e4Node(f), usage }]);
  // The cycle stops where it would write the correction: the refusal after the reads stays owed.
  const writeMany = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === 'question-packet' && (write.value as { request?: { correction?: unknown } }).request?.correction))
      throw new Error('MP3 stop before the correction');
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  try { await assert.rejects(runModelCycle(f.store, f.request), /MP3 stop before the correction/); }
  finally { f.store.writeMany = writeMany; }
  assert.equal(f.sent().length, 2, 'The read request and the refused answer were sent; the correction was not');
  const delivery = f.store.list('om-read-delivery')[0]!;
  const rejected = f.store.list<OmModelCall>('model-call').find(row => row.value.om.failure)!, owner = rejected.value.om.completionOwner!;
  const changed = f.environment(90_000);
  assert.ok(valueOf(prepareCompletionCause(f.store, f.project, owner.assignment)).cause, 'The changed environment ends the owed step');
  const ceased = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: owner.assignment }));
  assert.deepEqual([ceased.value.disposition, ceased.value.remainder], ['branch-ceased', 'continuation'], 'The owed correction is ceased by the common outcome');
  valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: reference(lp4Root(f)) }));
  assert.equal(completionSnapshot(f).complete, true, 'The attempt can close');
  mp3Close(f, 1, 'interrupted');
  const second = mp3Open(f, 2, reference(changed)), root2 = second.root();
  assert.equal(root2.value.state, 'ready');
  assert.deepEqual(mp3Readings(root2.value.packet).entries.map(entry => entry.origins.map(origin => origin.delivery.id)), [[delivery.id]]);
  assert.deepEqual(mp3Origins(root2), [['attempt 1']]); assert.deepEqual(mp3Decisions(root2.value.packet), ['included']);
  assert.deepEqual(mp3Carried(root2).map(item => item.data.text), [MP3_NOTES.slice(0, 9)], 'The read before the owed correction is carried');
  const sends = f.sent().length, before = f.store.list().map(reference);
  f.restart();
  assert.deepEqual(valueOf(readQuestionPacket(f.store, { project: f.project, record: reference(root2) })), root2);
  assert.deepEqual(valueOf(writeQuestionPacket(f.store, second.request)).record, root2);
  assert.deepEqual(f.store.list().map(reference), before); assert.equal(f.sent().length, sends);
});



test('NR1 №3674 п.2: a packet of the previous attempt is not registered in the work of the next one — the producer checks a new packet against its receiving attempt; the right packet of that attempt is then materialized', async () => {
  const t = { after: (fn: () => void) => cleanups.push(fn) }, cleanups: (() => void)[] = [];
  try {
    const f = e4Fixture(t as unknown as TestContext, 'fact');
    const goal = f.series.value.attempts[0]!.goal;
    valueOf(completeAttempt(f.store, { ...seriesRequestOf(f.series.value), attempt: 1, outcome: { reason: 'result', achieved: [], cancelled: [], refusals: [] } }));
    const second = valueOf(managedOpenAttempt(f.store, { ...seriesRequestOf(f.series.value), attempt: 2, goal,
      completion: { routes: reference(f.routes), batches: [f.batch.id] } } as never));
    const binding = valueOf(readCompletionBinding(f.store, f.project, reference(second), 2))!;
    const { prepareCompletionProducts } = await import('../src/om/model-call.js');
    const before = f.store.list().map(reference);
    const foreign = prepareCompletionProducts(f.store, reference(binding), [reference(f.packet)]);
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.deepEqual([foreign.refusal.code, foreign.refusal.at.target, foreign.refusal.at.field], ['completion_foreign', f.packet.id, 'packet']);
    assert.deepEqual(f.store.list().map(reference), before, 'Nothing of the foreign registration is written');
    const correct = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, attempt: { series: reference(second), ordinal: 2 } })).record;
    assert.equal(correct.value.state, 'ready');
    assert.equal(correct.value.request.attempt!.ordinal, 2);
  } finally { for (const fn of cleanups.reverse()) fn(); }
});



test('SP1a №4714 §2.1: the legal correction of a new managed root — a paid repairable E3 refusal with its diagnostic — keeps briefSelection and the same selected section', async t => {
  const f = mp2Managed(t);
  assert.equal(f.packet.value.briefSelection, BASIS_BRIEF_SELECTION_CONTRACT, 'A new root declares the selection era');
  f.steps([{ research: mp2Refused(f) }, { research: e4Node(f) }]);
  const cycle = valueOf(await mp2Cycle(f.store, f.request));
  const [first, second] = cycle.record.value.steps;
  const rejected = mp2Step(f, first!), corrected = f.store.get<QuestionPacketRecord>(second!.packet.id)!;
  assert.deepEqual(corrected.value.request.correction, { packet: first!.packet, call: rejected.call, response: rejected.response, diagnostic: rejected.diagnostic });
  assert.equal(corrected.value.briefSelection, BASIS_BRIEF_SELECTION_CONTRACT, 'The correction keeps its root era');
  const scope = (packet: Json) => JSON.parse(packetPrompt(packet).split('# Scope and exact context\n')[1]!.split('\n')[0]!).input;
  const selected = scope(f.packet.value.packet as Json).selected;
  assert.ok(selected && selected.contract === 'selected-specification/v2', 'The root shows the selected specification');
  assert.deepEqual(scope(corrected.value.packet as Json).selected, selected, 'The correction shows the same selected material');
});

