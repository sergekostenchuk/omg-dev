import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import { readAcceptedDiscoveryProjectionAt } from '../src/discovery/discovery-accepted-projection.js';
import { V9_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { acceptDiscoveryFinal } from '../src/product/owner-authority.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { modeOf } from './discovery-v7-dossier-seed.js';
import { storeUnchanged, storeRefused } from './store-unchanged.js';

type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
async function accept(f: World) {
  modeOf(f.store, 'bypass');
  const result = await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult,
    decision: 'accept', reason: 'Accept the exact paid supported final' });
  assert.ok(result.accepted); return result.accepted;
}
async function quiet<T>(f: World, work: () => Promise<T>) {
  const wire = canonical(f.wires());
  try { return await storeUnchanged(f.store, work); }
  finally { assert.equal(canonical(f.wires()), wire); }
}
const world = (t: test.TestContext) => finalAssessmentPaid(t, { form: V9_FINAL_CONTRACT });

test('C1 recovery: hot/cold exact reads retain the original paid contents after later heads reopen the brief', async t => {
  const f = await world(t), accepted = await accept(f), at = reference(accepted.manifest);
  const result = await quiet(f, () => readAcceptedDiscoveryProjectionAt(f.store, 'p', at));
  const original = f.packet.final.brief.question, current = f.store.get(original.id)!;
  const late = f.discovery.reopen(current.id, current.revision);
  assert.ok(late.revision > original.revision); assert.equal(late.value.status, 'open');
  assert.deepEqual(await quiet(f, () => readAcceptedDiscoveryProjectionAt(f.store, 'p', at)), result);
  f.reopen();
  assert.deepEqual(await quiet(f, () => readAcceptedDiscoveryProjectionAt(f.store, 'p', at)), result);
});

test('C1 recovery: independently issued contents, addresses and claims cannot mutate each other or the saved bundle', async t => {
  const f = await world(t), accepted = await accept(f), at = reference(accepted.manifest);
  const result = await quiet(f, () => readAcceptedDiscoveryProjectionAt(f.store, 'p', at)), original = structuredClone(result);
  assert.ok('actors' in result.projection.value);
  result.projection.value.actors[0]!.role = 'Changed';
  result.projection.address.container.hash = '0'.repeat(64);
  assert.deepEqual(result.constitution, original.constitution); assert.deepEqual(result.bundle, original.bundle);
  assert.deepEqual(result.claims, original.claims);
  result.claims[0]!.address.container.id = 'changed'; result.claims[0]!.value = null;
  assert.deepEqual(result.grounds, original.grounds);
  result.grounds.resolutions.push(at);
  assert.deepEqual(result.conditions, original.conditions);
  assert.deepEqual(await quiet(f, () => readAcceptedDiscoveryProjectionAt(f.store, 'p', at)), original);
  assert.deepEqual(f.store.get(accepted.bundle.id, accepted.bundle.revision), accepted.bundle);
});

test('C1 recovery: missing, foreign and unaccepted exact inputs refuse; a getter is snapshotted once', async t => {
  const f = await world(t), accepted = await accept(f), at = reference(accepted.manifest);
  const candidates: unknown[] = [null, undefined, {}, { id: at.id }, { ...at, hash: '0'.repeat(64) },
    { ...at, revision: at.revision + 1 }, { ...at, id: 'discovery-manifest:p:missing' }, f.paidResult, f.paidD7];
  for (const value of candidates) await quiet(f, () => storeRefused(f.store,
    () => readAcceptedDiscoveryProjectionAt(f.store, 'p', value)));
  await quiet(f, () => storeRefused(f.store, () => readAcceptedDiscoveryProjectionAt(f.store, 'foreign', at)));
  for (const extra of [{ accepted: true }, { manifest: f.paidD7 }, { manifest: null }])
    await quiet(f, () => storeRefused(f.store, () => f.engine.execute({ type: 'discovery-accepted-projection', project: 'p', manifest: at, ...extra })));
  let reads = 0;
  const external = { ...at, get id() { return ++reads === 1 ? at.id : 'foreign'; } };
  const result = await quiet(f, () => readAcceptedDiscoveryProjectionAt(f.store, 'p', external));
  assert.equal(reads, 1); assert.deepEqual(result.manifest, at);
});

test('C1 recovery: insufficient_evidence is accepted as its own result but never enables a consumer', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'insufficient_evidence', form: V9_FINAL_CONTRACT }), accepted = await accept(f);
  const error = await quiet(f, () => storeRefused(f.store, () => f.engine.execute({ type: 'discovery-accepted-projection',
    project: 'p', manifest: reference(accepted.manifest) }),
  error => error instanceof EngineError && error.code === 'discovery_projection_unavailable')) as EngineError;
  assert.equal((error.details as { outcome: string }).outcome, 'insufficient_evidence');
  assert.equal(accepted.bundle.value.bundle.projection, null);
});
