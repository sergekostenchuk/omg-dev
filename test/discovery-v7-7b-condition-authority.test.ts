import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { ConditionChoiceSessions, FinalAcceptanceSessions, ProjectModeSessions, acceptDiscoveryFinal, issueConditionChoiceInvitation,
  issueFinalAcceptanceInvitation, issueProjectModeInvitation, requireConditionChoiceAuthority, requireFinalAcceptanceAuthority,
  resolveDiscoveryCondition } from '../src/product/owner-authority.js';
import { CONDITION_CHOICE_ACTION, CONDITION_RESOLUTION_KIND, FINAL_ACCEPTANCE_ACTION, MANIFEST_SUCCESSOR_KIND, readAcceptedDiscoveryManifestAt,
  type AcceptedDiscovery } from '../src/discovery/discovery-acceptance.js';
import type { OmResult } from '../src/om/refusal.js';
import { modeOf } from './discovery-v7-dossier-seed.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { storeRefused } from './store-unchanged.js';

// DR7 7b.3 (codex-omg2 №16156 п.1, №16160): the separate owner authority of one choice on one condition of an accepted
// edition. No other owner authority — the acceptance of the bundle, a project-mode authority — stands for it, bypass mode
// does not replace it, and a revocation between the check and the commit writes nothing.
const option = (optionId: string, choice: 'accept' | 'decline', consequence: string) =>
  ({ optionId, label: `Option ${optionId}`, consequences: [consequence], choice });
const CONDITIONS = [
  { id: 'evidence-1', kind: 'evidence', condition: 'A source is available', criterion: 'A signed agreement' },
  { id: 'owner-1', kind: 'owner_choice', condition: 'The owner bounds the first release', criterion: 'The owner picks a bound',
    options: [option('narrow', 'accept', 'Only the ledger ships first'), option('refuse', 'decline', 'The bundle is not released')] },
  { id: 'owner-2', kind: 'owner_choice', condition: 'The owner accepts the integration risk', criterion: 'The owner decides on the risk',
    options: [option('carry', 'accept', 'The integration risk is carried'), option('stop', 'decline', 'The integration waits')] },
];
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
const world = (t: test.TestContext) => finalAssessmentPaid(t, { outcome: 'conditional', conditions: CONDITIONS });
/** The real conditional world accepted in its current mode: by the owner in questions mode, by the machine in bypass. */
async function accepted(f: World) {
  const mode = readProjectMode(f.store, 'p'), reason = 'The owner accepts the exact assessed bundle';
  const request = { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason };
  if (mode.mode === 'bypass') return { first: (await acceptDiscoveryFinal(f.store, request)).accepted!, acceptance: null };
  const scope = { projectId: 'p', draft: f.packet.final.subject.basis.draft, paid: f.paidD7, assessment: f.paidResult,
    mode: { id: mode.ref.id, revision: mode.ref.revision, hash: mode.ref.hash }, decision: 'accept', reason };
  const sessions = new FinalAcceptanceSessions(f.store);
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueFinalAcceptanceInvitation(f.store, scope)).invitation }));
  const acceptance = sessions.authority(login.bearer)!;
  return { first: (await acceptDiscoveryFinal(f.store, request, acceptance)).accepted!, acceptance };
}
const choice = (edition: AcceptedDiscovery, conditionId: string, optionId: string) =>
  ({ projectId: 'p', manifest: reference(edition.manifest), conditionId, optionId, reason: 'The owner chooses' });
const scopeOf = (edition: AcceptedDiscovery, conditionId: string, optionId: string) =>
  ({ projectId: 'p', predecessor: reference(edition.manifest), bundle: edition.manifest.value.bundle, conditionId, optionId, reason: 'The owner chooses' });
async function chooser(store: Store, edition: AcceptedDiscovery, conditionId: string, optionId: string) {
  const sessions = new ConditionChoiceSessions(store);
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueConditionChoiceInvitation(store, scopeOf(edition, conditionId, optionId))).invitation }));
  return { request: choice(edition, conditionId, optionId), sessions, bearer: login.bearer, authority: sessions.authority(login.bearer)! };
}

// The first test pays the first real construction of the conditional seed; its own body stays small.
test('7b.3 authority forms: no value other than a minted condition-choice authority decides', async t => {
  const f = await world(t);
  const scope = { projectId: 'p', predecessor: f.paidResult, bundle: f.paidD7, conditionId: 'owner-1', optionId: 'narrow', reason: 'x' };
  for (const fake of [undefined, null, { session: 'x' }, 'owner', true, Object.create(ConditionChoiceSessions.prototype)]) {
    const result = requireConditionChoiceAuthority(fake, { store: f.store, action: CONDITION_CHOICE_ACTION, scope });
    assert.equal(result.ok, false); assert.equal(!result.ok && result.refusal.code, 'owner_authority_invalid');
  }
});

test('7b.3 authority: only its own scoped live authority chooses; the acceptance, a mode authority, another option or Store refuse', async t => {
  const f = await world(t), { first, acceptance } = await accepted(f);
  const request = choice(first, 'owner-1', 'narrow');
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, request), 'owner_authority_invalid');
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, request, acceptance), 'owner_authority_foreign');
  const modeSessions = new ProjectModeSessions(f.store);
  const modeInvite = ok(issueProjectModeInvitation(f.store, { project: 'p', mode: 'bypass', previous: reference(readProjectMode(f.store, 'p').record) }));
  const modeLogin = ok(modeSessions.exchange({ project: 'p', invitation: modeInvite.invitation }));
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, request, modeSessions.authority(modeLogin.bearer)), 'owner_authority_foreign');
  // The authority of one option does not choose another, and it is bound to its Store.
  const narrow = await chooser(f.store, first, 'owner-1', 'narrow');
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, choice(first, 'owner-1', 'refuse'), narrow.authority), 'owner_authority_foreign');
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, choice(first, 'owner-2', 'carry'), narrow.authority), 'owner_authority_foreign');
  const other = f.open();
  await refused(f, other, () => resolveDiscoveryCondition(other, request, narrow.authority), 'owner_authority_foreign');
  // Nor does a condition-choice authority stand for the acceptance of the bundle.
  const asAcceptance = requireFinalAcceptanceAuthority(narrow.authority, { store: f.store, action: FINAL_ACCEPTANCE_ACTION,
    scope: { projectId: 'p', draft: f.paidD7, paid: f.paidD7, assessment: f.paidResult, mode: f.paidD7, decision: 'accept', reason: 'x' } });
  assert.equal(!asAcceptance.ok && asAcceptance.refusal.code, 'owner_authority_foreign');
  // Invitations over a scope that is not a proven offered choice on the latest edition refuse.
  for (const [bad, code] of [[{ ...scopeOf(first, 'owner-1', 'narrow'), extra: 1 }, 'owner_invitation_invalid'],
    [{ ...scopeOf(first, 'owner-1', 'narrow'), projectId: 'other' }, 'owner_project_missing'],
    [{ ...scopeOf(first, 'owner-1', 'narrow'), bundle: first.manifest.value.assessment }, 'discovery_condition_resolution_invalid'],
    [scopeOf(first, 'evidence-1', 'narrow'), 'discovery_condition_evidence_unproven'],
    [scopeOf(first, 'owner-1', 'carry'), 'discovery_condition_resolution_invalid']] as const) {
    const result = await issueConditionChoiceInvitation(f.store, bad);
    assert.equal(result.ok, false); assert.equal(!result.ok && result.refusal.code, code, canonical(bad as never));
  }
  assert.equal((await resolveDiscoveryCondition(f.store, request, narrow.authority)).unproven, 'condition_class_unproven');
  const again = await issueConditionChoiceInvitation(f.store, scopeOf(first, 'owner-1', 'refuse'));
  assert.equal(!again.ok && again.refusal.code, 'discovery_condition_resolution_stale', 'the owner has already acted on this condition');
});

test('7b.3 authority bypass: a machine admission does not replace the owner choice; the owner still acts on its edition', async t => {
  const f = await world(t);
  modeOf(f.store, 'bypass');
  const { first } = await accepted(f);
  assert.equal(first.admission.kind, 'machine');
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, choice(first, 'owner-1', 'narrow')), 'owner_authority_invalid');
  const o = await chooser(f.store, first, 'owner-1', 'narrow');
  const outcome = await resolveDiscoveryCondition(f.store, o.request, o.authority);
  assert.equal(outcome.choice, 'accept'); assert.equal(outcome.edition, null); assert.equal(outcome.unproven, 'condition_class_unproven');
  assert.deepEqual((await readAcceptedDiscoveryManifestAt(f.store, 'p', reference(first.manifest))).conditions.resolved, []);
});

test('7b.3 authority revocation and window: a revoked session no longer acts, its saved act stays provable cold, and a revocation before the commit writes nothing', async t => {
  const f = await world(t), { first } = await accepted(f), previous = Store.prototype.writeMany;
  const revoked = await chooser(f.store, first, 'owner-1', 'narrow');
  ok(revoked.sessions.revoke(revoked.bearer));
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, revoked.request, revoked.authority), 'owner_session_revoked');
  const o = await chooser(f.store, first, 'owner-1', 'narrow');
  const act = (await resolveDiscoveryCondition(f.store, o.request, o.authority)).resolution;
  ok(o.sessions.revoke(o.bearer));
  const cold = f.open();
  assert.deepEqual((await resolveDiscoveryCondition(cold, o.request)).resolution, act, 'the act stays proven after revocation');
  // The session is revoked between the authority check and the commit: the guarded write refuses and writes nothing.
  const w = await chooser(f.store, first, 'owner-2', 'carry');
  let moved = false;
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    if (this === f.store && !moved && writes.some(item => item.kind === CONDITION_RESOLUTION_KIND)) { moved = true; ok(w.sessions.revoke(w.bearer)); }
    return previous.call(this, writes, guards);
  } as typeof previous;
  try {
    await assert.rejects(() => resolveDiscoveryCondition(f.store, w.request, w.authority),
      (error: unknown) => error instanceof EngineError && error.code === 'discovery_condition_resolution_stale');
  } finally { Store.prototype.writeMany = previous; }
  assert.equal(moved, true);
  assert.equal(f.store.list(CONDITION_RESOLUTION_KIND).length, 1, 'no second act');
  assert.equal(f.store.list(MANIFEST_SUCCESSOR_KIND).length, 0, 'no successor');
});
