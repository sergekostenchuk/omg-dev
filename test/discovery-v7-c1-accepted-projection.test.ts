import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import { readAcceptedDiscoveryProjectionAt } from '../src/discovery/discovery-accepted-projection.js';
import { V8_FINAL_CONTRACT, V9_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { acceptDiscoveryFinal, ConditionChoiceSessions, issueConditionChoiceInvitation,
  resolveDiscoveryCondition } from '../src/product/owner-authority.js';
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
const CONDITIONS = [{ id: 'channel', kind: 'owner_choice', class: 'choice', classReason: 'Both channels are in scope',
  condition: 'Pick the first delivery channel', criterion: 'A channel is chosen', options: [
    { optionId: 'web', label: 'Web', consequences: ['Deliver the web channel first'], choice: 'accept' },
    { optionId: 'none', label: 'No channel', consequences: ['Do not proceed'], choice: 'decline' }] }];
const conditional = (t: test.TestContext) => finalAssessmentPaid(t,
  { outcome: 'conditional', conditions: CONDITIONS, form: V9_FINAL_CONTRACT });

test('C1: real paid accepted v9 preserves every projection field, claim and selected variant through the public command', async t => {
  const f = await finalAssessmentPaid(t, { form: V9_FINAL_CONTRACT }), accepted = await accept(f);
  const at = reference(accepted.manifest), bundle = accepted.bundle.value.bundle;
  const result = await quiet(f, () => readAcceptedDiscoveryProjectionAt(f.store, 'p', at));
  assert.equal(result.form, V9_FINAL_CONTRACT); assert.equal(result.outcome, 'go');
  for (const field of ['summary', 'verdict', 'projection', 'constitution'] as const) {
    assert.deepEqual(result[field].value, bundle[field]);
    assert.deepEqual(result[field].address, { container: reference(accepted.bundle), pointer: `/bundle/${field}` });
  }
  assert.ok('actors' in result.projection.value);
  const p = result.projection.value;
  for (const field of ['actors', 'outcomes', 'journeys', 'constraints', 'externalSystems', 'risks', 'unknowns'] as const)
    assert.deepEqual(p[field], (bundle.projection as typeof p)[field]);
  assert.ok(p.constraints.length && p.risks.length && p.externalSystems.length);
  const dossier = accepted.grounds.source.packet.final.dossier;
  assert.deepEqual(result.claims, dossier.materials.map(m => ({ address: m.address, value: m.value, status: m.status })));
  assert.ok(result.selectedVariant && dossier.route.member && dossier.route.decision);
  assert.deepEqual(result.selectedVariant.member, { address: { container: dossier.route.member.ref, pointer: '' }, value: dossier.route.member.value });
  assert.deepEqual(result.selectedVariant.decision, { address: { container: dossier.route.decision.ref, pointer: '' }, value: dossier.route.decision.value });
  assert.deepEqual(result.selectedVariant.set, dossier.route.set!.ref);
  assert.deepEqual(result.grounds.assessment, f.paidResult); assert.deepEqual(result.grounds.paidFinal, f.paidD7);
  assert.deepEqual(result.grounds.dossier, bundle.dossier); assert.deepEqual(result.manifest, at);
  assert.equal('dossier' in result, false); assert.equal('materials' in result, false);
  assert.deepEqual(await quiet(f, async () => f.engine.execute({ type: 'discovery-accepted-projection', project: 'p', manifest: at })), result);
});

test('C1: acceptance alone cannot release the consumer while an exact condition is open', async t => {
  const f = await conditional(t), accepted = await accept(f), at = reference(accepted.manifest);
  const error = await quiet(f, () => storeRefused(f.store,
    () => readAcceptedDiscoveryProjectionAt(f.store, 'p', at), error => error instanceof EngineError
      && error.code === 'discovery_projection_conditions_open')) as EngineError;
  assert.deepEqual(error.details, { manifest: at, bundle: reference(accepted.bundle), outcome: 'conditional',
    conditions: { resolved: [], open: ['channel'] }, targets: [{ conditionId: 'channel', container: reference(accepted.bundle),
      pointer: '/bundle/verdict/conditions/0' }] });
  await quiet(f, () => storeRefused(f.store, () => f.engine.execute({ type: 'discovery-accepted-projection', project: 'p', manifest: at }),
    error => error instanceof EngineError && error.code === 'discovery_projection_conditions_open'));
});

test('C1: an authorized resolved conditional edition permits reading without upgrading its unresolved predecessor', async t => {
  const f = await conditional(t), first = await accept(f), predecessor = reference(first.manifest);
  const request = { projectId: 'p', manifest: predecessor, conditionId: 'channel', optionId: 'web', reason: 'Start with web' };
  const sessions = new ConditionChoiceSessions(f.store);
  const invitation = await issueConditionChoiceInvitation(f.store, { projectId: 'p', predecessor, bundle: first.manifest.value.bundle,
    conditionId: request.conditionId, optionId: request.optionId, reason: request.reason });
  assert.ok(invitation.ok);
  const login = sessions.exchange({ projectId: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok);
  const outcome = await resolveDiscoveryCondition(f.store, request, sessions.authority(login.value.bearer));
  assert.ok(outcome.resolved && outcome.edition); assert.ok(sessions.revoke(login.value.bearer).ok);
  const result = await quiet(f, () => readAcceptedDiscoveryProjectionAt(f.store, 'p', reference(outcome.edition!.manifest)));
  assert.equal(result.outcome, 'conditional'); assert.deepEqual(result.previous, predecessor);
  assert.deepEqual(result.conditions, { resolved: ['channel'], open: [] });
  assert.deepEqual(result.grounds.resolutions, [reference(outcome.resolution)]);
  assert.deepEqual(result.projection.value, first.bundle.value.bundle.projection);
  await quiet(f, () => storeRefused(f.store, () => readAcceptedDiscoveryProjectionAt(f.store, 'p', predecessor),
    error => error instanceof EngineError && error.code === 'discovery_projection_conditions_open'));
  const cold = f.open(), wire = canonical(f.wires());
  assert.deepEqual(await storeUnchanged(cold, () => readAcceptedDiscoveryProjectionAt(cold, 'p', result.manifest)), result);
  assert.equal(canonical(f.wires()), wire);
});

for (const form of [undefined, V8_FINAL_CONTRACT]) test(`C1: historical ${form ?? 'discovery-final/v7'} keeps its actual five lists`, async t => {
  const f = await finalAssessmentPaid(t, { ...(form ? { form } : {}) }), accepted = await accept(f);
  const result = await quiet(f, () => readAcceptedDiscoveryProjectionAt(f.store, 'p', reference(accepted.manifest)));
  assert.equal(result.form, form ?? 'discovery-final/v7');
  assert.deepEqual(result.projection.value, accepted.bundle.value.bundle.projection);
  assert.deepEqual(Object.keys(result.projection.value).sort(), ['externalSystems', 'payers', 'rules', 'unresolved', 'users']);
});

test('C1: a real accepted no_go remains an addressed consumer refusal, never an empty successful projection', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'no_go', form: V9_FINAL_CONTRACT }), accepted = await accept(f);
  const error = await quiet(f, () => storeRefused(f.store,
    () => readAcceptedDiscoveryProjectionAt(f.store, 'p', reference(accepted.manifest)),
    error => error instanceof EngineError && error.code === 'discovery_projection_unavailable')) as EngineError;
  assert.deepEqual(error.details, { manifest: reference(accepted.manifest), bundle: reference(accepted.bundle), outcome: 'no_go',
    reason: accepted.bundle.value.bundle.verdict.reason, target: { container: reference(accepted.bundle), pointer: '/bundle/verdict' } });
});
