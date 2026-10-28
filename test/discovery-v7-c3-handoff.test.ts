import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { admitRunControl, RunControlLost, stopRun } from '../src/om/run-control.js';
import { prepareRunBases } from '../src/om/run-bases.js';
import { reference } from '../src/pipeline/contracts.js';
import { V9_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { prepareDiscoveryHandoff, readDiscoveryHandoffAt, requireDiscoveryHandoff, withDiscoveryHandoffAt } from '../src/discovery/discovery-handoff.js';
import { researchPrerequisitesAt } from '../src/discovery/research-context.js';
import type { DiscoveryDraft } from '../src/discovery/discovery.js';
import { acceptDiscoveryFinal, ConditionChoiceSessions, issueConditionChoiceInvitation, resolveDiscoveryCondition } from '../src/product/owner-authority.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { modeOf } from './discovery-v7-dossier-seed.js';
import { storeUnchanged } from './store-unchanged.js';

const conditions = [{ id: 'channel', kind: 'owner_choice', class: 'choice', classReason: 'Both channels are in scope',
  condition: 'Choose a channel', criterion: 'A channel is selected', options: [
    { optionId: 'web', label: 'Web', consequences: ['Web first'], choice: 'accept' },
    { optionId: 'none', label: 'None', consequences: ['Stop'], choice: 'decline' }] }];
async function world(t: test.TestContext, conditional = false) {
  const f = await finalAssessmentPaid(t, { form: V9_FINAL_CONTRACT, ...(conditional ? { outcome: 'conditional' as const, conditions } : {}) });
  modeOf(f.store, 'bypass');
  const accepted = await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason: 'Accept supported final' });
  assert.ok(accepted.accepted); return { f, accepted: accepted.accepted, manifest: reference(accepted.accepted.manifest) };
}

test('C3 handoff: the bound-draft producer pins the manifest, cold research material proves C1 and neither delivery nor repeats spend', async t => {
  const { f, manifest } = await world(t);
  const draft = await prepareDiscoveryHandoff(f.store, { project: 'p', stage: 'specification', manifest, inputs: [] });
  const wire = canonical(f.wires()), cold = f.open();
  const material = await storeUnchanged(cold, () => researchPrerequisitesAt(cold, 'p', reference(draft)));
  assert.equal(material.length, 1); assert.deepEqual(material[0]!.ref, manifest);
  assert.equal(material[0]!.stage, 'discovery'); assert.ok(material[0]!.discoveryMaterial);
  assert.deepEqual(material[0]!.fields.preparation, material[0]!.discoveryMaterial!.preparation);
  const handoff = await storeUnchanged(cold, () => readDiscoveryHandoffAt(cold, 'p', reference(draft)));
  assert.equal(handoff.binding.draft, draft.id); assert.deepEqual(handoff.binding.manifest, manifest);
  assert.throws(() => requireDiscoveryHandoff(cold, draft.value), (e: any) => e.code === 'discovery_handoff_proof_required');
  await storeUnchanged(cold, () => withDiscoveryHandoffAt(cold, 'p', reference(draft), () => {
    assert.deepEqual(requireDiscoveryHandoff(cold, draft.value).catalogue, handoff.catalogue);
    const bases = prepareRunBases(cold, { project: 'p' });
    assert.ok(!bases.ok);
    assert.equal(bases.refusal.code, 'record_missing');
    assert.equal(bases.refusal.at.target, 'stage:p:discovery', 'An unrelated C1 scope cannot replace an absent accepted chain');
  }));
  material[0]!.discoveryMaterial!.preparation.actors.length = 0;
  assert.deepEqual(await storeUnchanged(cold, () => readDiscoveryHandoffAt(cold, 'p', reference(draft))), handoff);
  assert.equal(canonical(f.wires()), wire);
});

test('C3 handoff: changed, absent and foreign binding refuse, while exact initial input survives a late draft head', async t => {
  const { f, manifest } = await world(t);
  const draft = await prepareDiscoveryHandoff(f.store, { project: 'p', stage: 'specification', manifest, inputs: [] });
  const first = await readDiscoveryHandoffAt(f.store, 'p', reference(draft));
  await assert.rejects(readDiscoveryHandoffAt(f.store, 'foreign', reference(draft)), (e: any) => e.code === 'discovery_handoff_invalid');
  let head = draft;
  for (const change of [
    (value: DiscoveryDraft) => { delete value.discoveryHandoff; },
    (value: DiscoveryDraft) => { (value as any).discoveryHandoff = null; },
    (value: DiscoveryDraft) => { value.discoveryHandoff!.manifest = { ...manifest, hash: 'f'.repeat(64) }; },
    (value: DiscoveryDraft) => { value.discoveryHandoff!.draft = 'discovery:p:foreign'; },
  ]) {
    const value = structuredClone(draft.value); change(value);
    head = f.store.write({ id: draft.id, kind: 'discovery-draft', expected: head.revision, value });
    await storeUnchanged(f.store, async () => {
      await assert.rejects(researchPrerequisitesAt(f.store, 'p', reference(head)), (e: any) => e.code === 'discovery_handoff_invalid');
      assert.deepEqual(await readDiscoveryHandoffAt(f.store, 'p', reference(draft)), first);
    });
  }
});

test('C3 handoff: open conditional writes nothing; a proved choice edition is pinned and does not release its predecessor', async t => {
  const { f, accepted, manifest } = await world(t, true);
  const prepare = (at: typeof manifest) => prepareDiscoveryHandoff(f.store, { project: 'p', stage: 'specification', manifest: at, inputs: [] });
  await storeUnchanged(f.store, async () => { await assert.rejects(prepare(manifest), (e: any) => e.code === 'discovery_projection_conditions_open'); });
  const request = { projectId: 'p', manifest, conditionId: 'channel', optionId: 'web', reason: 'Web first' };
  const sessions = new ConditionChoiceSessions(f.store);
  const invitation = await issueConditionChoiceInvitation(f.store, { projectId: 'p', predecessor: manifest, bundle: reference(accepted.bundle),
    conditionId: 'channel', optionId: 'web', reason: request.reason }); assert.ok(invitation.ok);
  const login = sessions.exchange({ projectId: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok);
  const resolved = await resolveDiscoveryCondition(f.store, request, sessions.authority(login.value.bearer));
  assert.ok(resolved.edition && resolved.resolved); assert.ok(sessions.revoke(login.value.bearer).ok);
  const edition = reference(resolved.edition.manifest), draft = await prepare(edition);
  const cold = f.open(), h = await storeUnchanged(cold, () => readDiscoveryHandoffAt(cold, 'p', reference(draft)));
  assert.deepEqual(h.binding.manifest, edition); assert.deepEqual(h.source.previous, manifest);
  assert.deepEqual(h.source.conditions, { resolved: ['channel'], open: [] });
  await storeUnchanged(f.store, async () => { await assert.rejects(prepare(manifest), (e: any) => e.code === 'discovery_projection_conditions_open'); });
});


test('C3 handoff: held preparation uses full historical readers and a second Store stop fences the new draft', async t => {
  const { f, manifest } = await world(t), wire = canonical(f.wires());
  const request = { project: 'p', stage: 'concept' as const, manifest, inputs: [manifest] };
  const supplied = { ...admitRunControl(f.store, 'p').hold };
  const first = prepareDiscoveryHandoff(f.store, request, supplied);
  supplied.project = 'changed-after-entry';
  const draft = await first;
  assert.deepEqual(draft.value.discoveryHandoff!.manifest, manifest);
  assert.deepEqual(draft.value.inputs, [manifest]);
  assert.equal(draft.value.stage, 'concept');
  // The async C1 proof has started; stop the real project through another Store before its guarded publication.
  const pending = prepareDiscoveryHandoff(f.store, request, admitRunControl(f.store, 'p').hold);
  const stopped = stopRun(f.open(), { project: 'p' });
  assert.ok(stopped.ok && stopped.value.stopped);
  await storeUnchanged(f.store, () => assert.rejects(pending,
    (error: unknown) => error instanceof RunControlLost && error.refusal.code === 'run_stopped'));
  assert.equal(canonical(f.wires()), wire);
});
