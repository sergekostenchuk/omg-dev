import test from 'node:test';
import assert from 'node:assert/strict';
import { reference } from '../src/pipeline/contracts.js';
import { type RepairSeries, readCompletionBinding, completionWorkId, seriesRequestOf } from '../src/om/series.js';
import { readCompletionWorkAt, readModelCycle, runModelCycle, runModelTransport } from '../src/om/model-call.js';
import { gapLineKey } from '../src/om/gap-lines.js';
import { readJournal } from '../src/om/refusal-journal.js';
import { callLedgerId, type CallLedger } from '../src/om/call-record.js';
import { type OriginHold, closeAttempt } from '../src/om/repeat-gate.js';
import { e4ManagedFixture, e4ManagedWorksFixture, e4ManagedAnalysisFixture, e4ManagedClose, mp3ManagedCycle,
  usage, confirmed, valueOf } from './om-model-call-fixture.js';

const snapshot = (store: Parameters<typeof readModelCycle>[0]) => store.list().flatMap(row => store.history(row.id));
function complete(f: Pick<Awaited<ReturnType<typeof e4ManagedFixture>>, 'store' | 'project' | 'series'>, ordinal: number) {
  const series = f.store.get<RepairSeries>(f.series.id)!;
  const binding = valueOf(readCompletionBinding(f.store, f.project, reference(series), ordinal));
  assert.ok(binding);
  return valueOf(readCompletionWorkAt(f.store, f.project, reference(f.store.get(completionWorkId(f.project, binding.id))!)));
}

for (const kind of ['fact', 'node', 'field', 'design'] as const) {
  test(`mc-helper explicit ${kind} opening owns its complete current batch without payment or closure`, async t => {
    const f = await e4ManagedFixture(t, kind), work = complete(f, 1);
    assert.equal(work.complete, false);
    assert.deepEqual(f.series.value.attempts[0]!.goal.questions, f.batch.items.map(item =>
      gapLineKey(f.project, item.target, item.field)));
    assert.deepEqual(work.binding.value.plan.routes, reference(f.routes));
    assert.equal(f.series.value.attempts[0]!.outcome, null);
    assert.equal(f.preparationCalls.length, 0); assert.equal(f.sent().length, 0);
    const before = snapshot(f.store);
    const refused = closeAttempt(f.store, { ...seriesRequestOf(f.series.value), attempt: 1,
      outcome: { reason: 'refused', accepting: [], cancelling: [], refusals: [] } });
    assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.refusal.code, 'completion_incomplete');
    assert.deepEqual(snapshot(f.store), before);
  });
}

test('mc-helper paid no-progress prefix has complete registries and explicit G7 before the next ordinal', async t => {
  const f = await e4ManagedFixture(t, 'fact', { priorNoProgress: 2 });
  assert.equal(f.packetRequest.attempt!.ordinal, 3); assert.equal(f.prefix.length, 2);
  assert.equal(f.sent().length, 2); assert.equal(f.preparationCalls.length, 2);
  const paid = f.store.get<CallLedger>(callLedgerId(f.project))!.value.calls;
  assert.equal(paid.length, 2); assert.ok(paid.every(row => row.status === 'failed'));
  for (const row of paid) assert.deepEqual(row.usage, usage, 'A technical refusal retains its real known expense');
  const closed = f.store.get<RepairSeries>(f.series.id)!;
  assert.equal(closed.value.withoutProgress, 2);
  for (const ordinal of [1, 2]) {
    assert.equal(complete(f, ordinal).complete, true);
    assert.ok(closed.value.attempts[ordinal - 1]!.outcome);
  }
  assert.equal(complete(f, 3).complete, false);
  const before = snapshot(f.store); f.restart();
  for (const record of f.prefix) valueOf(readModelCycle(f.store, { project: f.project, record }));
  assert.deepEqual(snapshot(f.store), before); assert.equal(f.sent().length, 2);
});

for (const kind of ['node', 'field'] as const) {
  test(`mc-helper ${kind} no-progress pays and G7-closes its own batch before opening another`, async t => {
    const f = await e4ManagedFixture(t, kind, { priorNoProgress: 1 });
    assert.equal(f.packetRequest.attempt!.ordinal, 2); assert.equal(f.sent().length, 1);
    assert.equal(complete(f, 1).complete, true); assert.equal(complete(f, 2).complete, false);
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.withoutProgress, 1);
  });
}

test('mc-helper design preserves the current unsupported producer refusal without unpaid closure', async t => {
  const f = await e4ManagedFixture(t, 'design'), before = snapshot(f.store);
  const result = await runModelCycle(f.store, f.request);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.refusal.code, 'route_result_unsupported');
    assert.equal(result.refusal.at.target, 'discovery:spare');
    assert.equal(result.refusal.at.field, 'answer');
  }
  assert.deepEqual(snapshot(f.store), before); assert.equal(f.sent().length, 0);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
});

test('mc-helper priorRefused is a paid node cycle, its own G7 and a fresh complete M6 attempt', async t => {
  const f = await e4ManagedFixture(t, 'node', { priorRefused: true });
  assert.equal(f.packetRequest.attempt!.ordinal, 2); assert.equal(f.sent().length, 1);
  assert.equal(complete(f, 1).complete, true); assert.equal(complete(f, 2).complete, false);
  const cycle = valueOf(readModelCycle(f.store, { project: f.project, record: f.prefix[0]! }));
  assert.equal(cycle.last.outcome?.kind, 'no-result'); assert.ok(cycle.last.response);
  assert.ok(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome?.refusals.length);
});

test('mc-helper works uses its own full managed batch and closes only after the real paid E4 refusal', async t => {
  const f = e4ManagedWorksFixture(t), before = complete(f, 1);
  assert.equal(before.complete, false);
  const questions = (f.packet.value.packet as { questions: { id: string }[] }).questions;
  f.steps([{ research: { protocol: '$answerProtocol', requestId: '$requestId', action: 'cannot_answer',
    questionIds: questions.map(item => item.id), reason: 'Need another concrete work design' }, usage, confirmed }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.last.outcome?.kind, 'no-result');
  assert.equal(complete(f, 1).complete, true); assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  e4ManagedClose(f); assert.ok(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome);
  assert.equal(f.sent().length, 1);
});

test('mc-helper MP3 material is delivered by the managed cycle and explicit G7 preserves the paid prefix', async t => {
  const m = await mp3ManagedCycle(t, 'fact', { priorNoProgress: 1 }), { f } = m;
  f.steps([{ research: m.need([m.range(0, 9)]), usage, confirmed }, { research: { protocol: '$answerProtocol', requestId: '$requestId',
    action: 'cannot_answer', questionIds: f.batch.items.map(item => item.gap), reason: 'The delivered material does not answer it' }, usage, confirmed }]);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.record.value.steps.length, 2); assert.equal(f.sent().length, 3);
  assert.equal(complete(f, 2).complete, true); e4ManagedClose(f);
  const before = snapshot(f.store); f.restart();
  assert.equal(valueOf(await runModelCycle(f.store, f.request)).repeated, true);
  assert.deepEqual(snapshot(f.store), before); assert.equal(f.sent().length, 3);
});

for (const purpose of ['stop-analysis', 'origin-analysis'] as const) {
  test(`mc-helper ${purpose} stands on its genuine managed ground and cold paid replay is inert`, async t => {
    const f = await e4ManagedAnalysisFixture(t, purpose);
    assert.ok(f.preparationCalls.length > 0); assert.equal(f.sent().length, 0);
    if (f.basis.kind === 'series-stop') {
      assert.deepEqual(f.series.value.stop?.attempts, [1, 2, 3]);
      for (const ordinal of [1, 2, 3]) assert.equal(complete(f, ordinal).complete, true);
    } else {
      const hold = f.store.get<OriginHold>(f.basis.hold.id, f.basis.hold.revision)!;
      assert.equal(hold.value.lift, null); assert.equal(hold.value.block, f.series.value.block);
      const journal = valueOf(readJournal(f.store, { project: f.project }));
      const row = journal.value.rows.find(row => row.id === hold.value.row)!;
      assert.equal(row.origin.stage, 'atomicity'); assert.ok(row.origin.sources.length > 0);
      assert.equal(row.gate, 'G5'); assert.ok(f.store.get(row.source.id, row.source.revision));
    }
    const series = reference(f.store.get(f.series.id)!);
    const sent = valueOf(await runModelTransport(f.store, f.request));
    assert.equal(sent.result.kind, 'answered'); assert.deepEqual(sent.record.value.usage, usage);
    assert.equal(f.sent().length, 1); assert.deepEqual(reference(f.store.get(f.series.id)!), series);
    const before = snapshot(f.store); f.restart();
    valueOf(await runModelTransport(f.store, f.request));
    assert.deepEqual(snapshot(f.store), before); assert.equal(f.sent().length, 1);
  });
}
