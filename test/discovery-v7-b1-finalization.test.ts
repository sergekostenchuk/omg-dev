import test from 'node:test';
import assert from 'node:assert/strict';
import { reference } from '../src/pipeline/contracts.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { readRunnerDossierAssessmentAt } from '../src/discovery/dossier-assessment-runner.js';
import { readDiscoveryFinalizationAt, readRunnerFinalizationAt } from '../src/discovery/discovery-finalization-runner.js';
import { V9_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { acceptDiscoveryFinal, FinalAcceptanceSessions, issueFinalAcceptanceInvitation } from '../src/product/owner-authority.js';
import { B1_BRIEF, bypassFinalizedWorld, dossierWorld, finalizationWorld, finalizationAdapter as adapter, waitingOwnerWorld, type FinalizationWorld as World } from './discovery-v7-b1-finalization-fixture.js';
import { all, completed, money } from './discovery-v7-dossier-seed.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { whileHidden } from './hidden-record.js';
import { EngineError } from '../src/errors.js';

function stamp(f: Pick<World, 'store' | 'wires'>) { return { history: all(f.store), event: f.store.lastEvent(), money: money(f.store), wires: f.wires() }; }
const run = (f: Pick<World, 'store' | 'discovery' | 'engine' | 'packet'>, limit = 8, restoreOnly = false) => new Researcher(f.store, f.discovery, f.engine.environments)
  .run('p', f.packet.subject.basis.draft.id, limit, undefined, { producerPolicy: { discovery: 7 }, restoreOnly });

test('B1 fixture: optional original brief keys preserve absence, spaces, Unicode and independent copies', async t => {
  const absent = await completed(t, 'owner');
  assert.equal(absent.store.get<any>(absent.draft.id, absent.draft.revision)!.value.fields.brief, null);
  for (const brief of [B1_BRIEF, B1_BRIEF + ' ', B1_BRIEF.replace('α', 'β')]) {
    const first = await completed(t, 'owner', brief), repeated = await completed(t, 'owner', brief);
    assert.equal(first.store.get<any>(first.draft.id, first.draft.revision)!.value.fields.brief, brief);
    assert.deepEqual(first.draft, repeated.draft);
    assert.notEqual(first.path, repeated.path);
  }
});

test('B1 recovery: one ordinary invocation shares its two calls across D6 and D7, leaving the reviewer unpaid', async t => {
  const f = await dossierWorld(t); await adapter(f, 'go');
  const before = new Set(f.store.list('model-call').map(row => row.id));
  const researcher = new Researcher(f.store, f.discovery, f.engine.environments);
  const first = await researcher.run('p', f.v.draft.id, 2, undefined, { producerPolicy: { discovery: 7 } });
  const proof = await readRunnerFinalizationAt(f.store, 'p', reference(first));
  assert.equal(f.store.list('model-call').filter(row => !before.has(row.id)).length, 2);
  assert.equal(proof.status, 'assessing'); assert.ok(proof.final); assert.equal(proof.assessment, null);
  const cash = money(f.store), wires = f.wires();
  const restored = await researcher.run('p', f.v.draft.id, 1, undefined, { restoreOnly: true });
  assert.deepEqual(restored, first); assert.deepEqual(money(f.store), cash); assert.deepEqual(f.wires(), wires);
});

test('B1: exact finalization reads refuse absent and non-record addresses without effects', async t => {
  const f = await finalizationWorld(t);
  const before = stamp(f);
  for (const at of [null, [], 'saved', 1, false, { id: 'missing', revision: 1, hash: '0'.repeat(64) }])
    await assert.rejects(readDiscoveryFinalizationAt(f.store, 'p', at), (error: unknown) =>
      error instanceof EngineError && error.code === 'discovery_finalization_invalid');
  assert.deepEqual(stamp(f), before);
});

test('B1: owner-selected D6 runs paid v9 and independent assessment, then waits for the owner', async t => {
  const f = await waitingOwnerWorld(t), { driven } = f;
  assert.equal(driven.end, 'needs_owner', JSON.stringify(driven.reason));
  assert.ok(driven.stageResult?.research);
  const proof = await readRunnerFinalizationAt(f.store, 'p', driven.stageResult.research), pending = proof.run;
  assert.equal(proof.status, 'needs_owner'); assert.equal(proof.outcome, 'go'); assert.equal(proof.accepted, null);
  assert.equal(proof.final!.bundle.contract, V9_FINAL_CONTRACT);
  const summary = driven.stageResult.finalSummary!;
  assert.equal(summary.acceptance.state, 'awaiting_decision'); assert.equal(summary.permitsNextStage, false);
  assert.deepEqual(summary.basis, { kind: 'assessment', record: proof.view.assessment });
  assert.deepEqual(summary.summary.value, proof.final!.bundle.summary);
  assert.deepEqual(summary.projection!.value, proof.final!.bundle.projection);
  assert.deepEqual(summary.constitution!.value, proof.final!.bundle.constitution);
  assert.deepEqual(proof.final!.packet.final.dossier, f.packet.dossier);
  const before = stamp(f); assert.deepEqual(await run(f, 1, true), pending); assert.deepEqual(stamp(f), before);
});

test('B1: owner-selected D6 waiting for the owner resumes exact owner acceptance', async t => {
  const f = await waitingOwnerWorld(t), proof = await readRunnerFinalizationAt(f.store, 'p', f.driven.stageResult!.research!);
  const request = { projectId: 'p', assessment: proof.record.value.assessment!, decision: 'accept' as const, reason: 'Owner accepts the complete exact bundle' };
  const mode = readProjectMode(f.store, 'p');
  const invitation = await issueFinalAcceptanceInvitation(f.store, { ...request, draft: f.packet.subject.basis.draft,
    paid: proof.record.value.final!, mode: { id: mode.ref.id, revision: mode.ref.revision, hash: mode.ref.hash } });
  assert.ok(invitation.ok, invitation.ok ? undefined : JSON.stringify(invitation.refusal));
  const sessions = new FinalAcceptanceSessions(f.store), opened = sessions.exchange({ projectId: 'p', invitation: invitation.value.invitation });
  assert.ok(opened.ok);
  const accepted = await acceptDiscoveryFinal(f.store, request, sessions.authority(opened.value.bearer)!);
  const afterOwner = money(f.store), wires = f.wires();
  const resumed = await run(f, 1, true), final = await readRunnerFinalizationAt(f.store, 'p', reference(resumed));
  assert.equal(final.status, 'accepted'); assert.deepEqual(final.accepted, accepted.accepted);
  assert.deepEqual(money(f.store), afterOwner); assert.deepEqual(f.wires(), wires);
});

for (const outcome of ['no_go', 'insufficient_evidence', 'conditional'] as const) {
  test(`B1: bypass ${outcome} is independently assessed and accepted with its exact lawful material`, async t => {
    const f = await bypassFinalizedWorld(t, outcome), proof = await readRunnerFinalizationAt(f.store, 'p', reference(f.value));
    assert.equal(proof.status, 'accepted'); assert.equal(proof.outcome, outcome);
    assert.equal(proof.accepted!.admission.kind, 'machine');
    if (outcome !== 'conditional') { assert.equal(proof.final!.bundle.projection, null); assert.equal(proof.final!.bundle.constitution, null); }
    else { assert.deepEqual(proof.accepted!.conditions.open, ['evidence-1']); assert.ok(proof.final!.bundle.projection); }
  });
  test(`B1: bypass ${outcome} restores its accepted bundle without a new purchase or write`, async t => {
    const f = await bypassFinalizedWorld(t, outcome);
    const before = stamp(f); assert.deepEqual(await run(f, 1, true), f.value); assert.deepEqual(stamp(f), before);
  });
}

test('B1: a nonempty partial D6 return keeps its paid correction instead of becoming final success', async t => {
  const f = await finalizationWorld(t, 'partial');
  const value = await run(f), proof = await readRunnerDossierAssessmentAt(f.store, 'p', reference(value));
  assert.equal(proof.assessment.value.result.completeness, 'partial'); assert.ok(proof.packet.materials.length);
  assert.equal(proof.result.verdict, 'return'); assert.equal(value.value.finalization, undefined);
  const before = stamp(f); assert.deepEqual(await run(f, 1, true), value); assert.deepEqual(stamp(f), before);
});

test('B1: supported nonempty partial D6 reaches a paid negative D7 while retaining its partial reasons', async t => {
  const f = await finalizationWorld(t, 'partial', 'supported');
  await adapter(f, 'insufficient_evidence');
  const value = await run(f), proof = await readRunnerFinalizationAt(f.store, 'p', reference(value));
  assert.equal(proof.dossier.assessment.value.result.completeness, 'partial');
  assert.ok(proof.dossier.packet.materials.length);
  assert.deepEqual(proof.final!.packet.final.dossier, f.packet.dossier);
  assert.equal(proof.status, 'needs_owner'); assert.equal(proof.accepted, null); assert.equal(proof.outcome, 'insufficient_evidence');
  assert.equal(proof.final!.bundle.projection, null); assert.equal(proof.final!.bundle.constitution, null);
  const before = stamp(f); assert.deepEqual(await run(f, 1, true), value); assert.deepEqual(stamp(f), before);
});

test('B1 recovery: malformed and mixed saved state fails typed without writes, money or wire', async t => {
  const f = await finalizationWorld(t); await adapter(f, 'go');
  const value = await run(f), proof = await readRunnerFinalizationAt(f.store, 'p', reference(value));
  const row = proof.record, before = stamp(f);
  const mutations: unknown[] = [null, [], 'saved', 42, true, { ...row.value, assessment: null, accepted: f.d6 },
    { ...row.value, final: f.d6 }, { ...row.value, prepared: row.value.assessmentPrepared }];
  for (const body of mutations) {
    const changed = { ...row, value: body as Json, hash: hashJson(body as never) };
    // The genuine Store answers with the changed row for the time of one read, so its proofs are kept; that nothing was written is the stamp below.
    await whileHidden(f.store, { id: row.id, revision: row.revision }, changed, () =>
      assert.rejects(readDiscoveryFinalizationAt(f.store, 'p', reference(changed)), (error: unknown) => error instanceof EngineError));
  }
  assert.deepEqual(stamp(f), before);
  assert.equal(canonical((await readRunnerFinalizationAt(f.open(), 'p', reference(value))).view), canonical(proof.view));
  assert.deepEqual(stamp(f), before);
});

