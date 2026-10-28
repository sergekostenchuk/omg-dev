import test from 'node:test';
import assert from 'node:assert/strict';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { FINAL_SEED_BRIEF } from './discovery-v7-final-paid-seed.js';

test('A2: the original owner goal reaches paid D7 and its independent assessment verbatim, including whitespace and Unicode', async t => {
  const f = await finalAssessmentPaid(t, { route: 'partial', outcome: 'insufficient_evidence' });
  const final = f.final.result.value.projection.packet;
  assert.equal(final.brief.text, FINAL_SEED_BRIEF);
  assert.equal(final.brief.observation.value, FINAL_SEED_BRIEF);
  assert.equal(f.packet.final.brief.text, FINAL_SEED_BRIEF);
  assert.deepEqual(f.packet.final.subject.basis.brief, final.subject.basis.brief);
  const calls = f.store.list('model-call').length, wires = f.wires().length;
  f.reopen();
  const restored = await f.restore();
  assert.ok(restored.output);
  assert.equal(restored.output.value.projection.packet.final.brief.text, FINAL_SEED_BRIEF);
  assert.equal(f.store.list('model-call').length, calls); assert.equal(f.wires().length, wires);
});
