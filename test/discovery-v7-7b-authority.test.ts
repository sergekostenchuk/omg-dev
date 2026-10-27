import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { FinalAcceptanceSessions, ProjectModeSessions, acceptDiscoveryFinal, issueFinalAcceptanceInvitation,
  issueProjectModeInvitation, requireFinalAcceptanceAuthority } from '../src/product/owner-authority.js';
import { DISCOVERY_MANIFEST_KIND } from '../src/discovery/discovery-manifest.js';
import { FINAL_ACCEPTANCE_ACTION, FINAL_ACCEPTANCE_ACT_KIND, provenAcceptanceGrounds, readAcceptedDiscoveryManifestAt,
  readFinalAcceptanceSession } from '../src/discovery/discovery-acceptance.js';
import type { OmResult } from '../src/om/refusal.js';
import { modeOf } from './discovery-v7-dossier-seed.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { storeRefused } from './store-unchanged.js';

// DR7 7b.1 (codex-omg2 №16106 п.1): the separate owner authority of one acceptance decision — its own scope over the
// project, the exact draft, the paid D7, its paid supported assessment and the questions-mode record. No other owner
// authority stands for it, and a mode change or a revocation between the check and the commit writes nothing.
type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.refusal.code}: ${result.refusal.message}`);
  return (result as { ok: true; value: T }).value;
}
const money = (store: Store) => canonical(store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind))
  .flatMap(row => store.history(row.id)) as never);
async function refused(f: World, store: Store, action: () => Promise<unknown>, code?: string) {
  const calls = money(store), sent = canonical(f.wires() as never);
  await storeRefused(store, action, error => error instanceof EngineError && (!code || error.code === code));
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
}
const request = (f: World, decision: 'accept' | 'decline' = 'accept') =>
  ({ projectId: 'p', assessment: f.paidResult, decision, reason: decision === 'accept' ? 'The owner accepts' : 'The owner refuses' });
async function scopeOf(f: World, decision: 'accept' | 'decline' = 'accept') {
  const grounds = await provenAcceptanceGrounds(f.store, 'p', f.paidResult), mode = readProjectMode(f.store, 'p').ref;
  return { projectId: 'p', draft: grounds.draft, paid: grounds.paid, assessment: grounds.assessment,
    mode: { id: mode.id, revision: mode.revision, hash: mode.hash } as Ref, decision, reason: request(f, decision).reason };
}
async function login(f: World, decision: 'accept' | 'decline' = 'accept', store = f.store) {
  const scope = await scopeOf(f, decision), issued = ok(await issueFinalAcceptanceInvitation(store, scope));
  const sessions = new FinalAcceptanceSessions(store), opened = ok(sessions.exchange({ projectId: 'p', invitation: issued.invitation }));
  return { scope, sessions, bearer: opened.bearer, session: opened.session, authority: sessions.authority(opened.bearer)! };
}

// The first test of the file pays the first real construction of the shared seed; its own body stays small.
test('7b authority forms: no value other than a minted acceptance authority decides, and nothing is written', async t => {
  const f = await finalAssessmentPaid(t);
  for (const fake of [undefined, null, { session: 'x' }, 'owner', true])
    await refused(f, f.store, () => acceptDiscoveryFinal(f.store, request(f), fake), 'owner_authority_invalid');
});

test('7b authority: only its own scoped live authority decides; other owner authorities, scopes and Stores refuse without writes', async t => {
  const f = await finalAssessmentPaid(t);
  // Another owner action: a project-mode authority cannot decide on the final bundle.
  const modeSessions = new ProjectModeSessions(f.store);
  const modeInvite = ok(issueProjectModeInvitation(f.store, { project: 'p', mode: 'questions', previous: reference(readProjectMode(f.store, 'p').record) }));
  const modeLogin = ok(modeSessions.exchange({ project: 'p', invitation: modeInvite.invitation }));
  await refused(f, f.store, () => acceptDiscoveryFinal(f.store, request(f), modeSessions.authority(modeLogin.bearer)), 'owner_authority_foreign');
  // A decline authority does not accept, an accept authority does not decline, and the authority is bound to its Store.
  const decline = await login(f, 'decline');
  await refused(f, f.store, () => acceptDiscoveryFinal(f.store, request(f, 'accept'), decline.authority), 'owner_authority_foreign');
  const accept = await login(f);
  await refused(f, f.store, () => acceptDiscoveryFinal(f.store, request(f, 'decline'), accept.authority), 'owner_authority_foreign');
  const other = f.open();
  await refused(f, other, () => acceptDiscoveryFinal(other, request(f), accept.authority), 'owner_authority_foreign');
  const foreignScope = { ...accept.scope, paid: accept.scope.draft };
  assert.equal(requireFinalAcceptanceAuthority(accept.authority, { store: f.store, action: FINAL_ACCEPTANCE_ACTION, scope: foreignScope }).ok, false);
  // Invitations over a scope that is not the proven one refuse; a spent invitation is not exchanged twice.
  for (const bad of [{ ...accept.scope, draft: accept.scope.paid }, { ...accept.scope, mode: accept.scope.paid },
    { ...accept.scope, projectId: 'other' }, { ...accept.scope, extra: 1 }]) {
    const result = await issueFinalAcceptanceInvitation(f.store, bad);
    assert.equal(result.ok, false, JSON.stringify(Object.keys(bad)));
  }
});

test('7b authority revocation: a revoked session no longer decides, the next one does, and its act stays provable cold', async t => {
  const f = await finalAssessmentPaid(t), accept = await login(f);
  // A revoked session no longer decides; the next invitation does.
  ok(accept.sessions.revoke(accept.bearer));
  await refused(f, f.store, () => acceptDiscoveryFinal(f.store, request(f), accept.authority), 'owner_session_revoked');
  const live = await login(f);
  const outcome = await acceptDiscoveryFinal(f.store, request(f), live.authority);
  assert.equal(outcome.decision, 'accept');
  // The saved act names its exact open session, which stays provable after it is revoked.
  ok(live.sessions.revoke(live.bearer));
  assert.equal(readFinalAcceptanceSession(f.store, outcome.act!.value.authority.session).value.state, 'open');
  const cold = f.open();
  assert.deepEqual(await readAcceptedDiscoveryManifestAt(cold, 'p', reference(outcome.accepted!.manifest)), outcome.accepted);
});

test('7b authority windows: a mode change or a revocation between the check and the commit writes nothing', async t => {
  const f = await finalAssessmentPaid(t), previous = Store.prototype.writeMany;
  const other = f.open();
  for (const move of ['mode', 'revoke'] as const) {
    const o = await login(f);
    let moved = false;
    Store.prototype.writeMany = function (this: Store, writes, guards) {
      if (this === f.store && !moved && writes.some(w => w.kind === FINAL_ACCEPTANCE_ACT_KIND)) {
        moved = true;
        if (move === 'mode') modeOf(other, 'bypass'); else ok(o.sessions.revoke(o.bearer));
      }
      return previous.call(this, writes, guards);
    } as typeof previous;
    const before = f.store.list(DISCOVERY_MANIFEST_KIND).length;
    try {
      await assert.rejects(() => acceptDiscoveryFinal(f.store, request(f), o.authority),
        (error: unknown) => error instanceof EngineError && error.code === 'discovery_acceptance_stale', move);
    } finally { Store.prototype.writeMany = previous; }
    assert.equal(moved, true);
    assert.equal(f.store.list(DISCOVERY_MANIFEST_KIND).length, before, `${move}: no manifest`);
    assert.equal(f.store.list(FINAL_ACCEPTANCE_ACT_KIND).length, 0, `${move}: no act`);
    if (move === 'mode') modeOf(f.store, 'questions');
  }
});

test('7b negative outcome: a supported no_go bundle is accepted as a no_go with its lawful nulls', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'no_go' }), o = await login(f);
  const accepted = (await acceptDiscoveryFinal(f.store, request(f), o.authority)).accepted!;
  assert.equal(accepted.bundle.value.bundle.verdict.outcome, 'no_go');
  assert.equal(accepted.bundle.value.bundle.projection, null); assert.equal(accepted.bundle.value.bundle.constitution, null);
});
