import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { ConditionChoiceSessions, FinalAcceptanceSessions, acceptDiscoveryFinal, issueConditionChoiceInvitation,
  issueFinalAcceptanceInvitation, resolveDiscoveryCondition } from '../src/product/owner-authority.js';
import { CONDITION_RESOLUTION_KIND, MANIFEST_SUCCESSOR_KIND, conditionResolutionId,
  type AcceptedDiscovery } from '../src/discovery/discovery-acceptance.js';
import { DISCOVERY_MANIFEST_KIND } from '../src/discovery/discovery-manifest.js';
import { V8_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import type { OmResult } from '../src/om/refusal.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

// DR7 7b.3 (codex-omg2 №16299): the windows of the positive resolution — two Stores with the same choice, other
// conditions on one predecessor, a decline against a concurrent accept, a revocation before the commit, a failed write
// and a lost return after the commit. One proven edition or an addressed act/refusal, never a partial write.
const option = (optionId: string, choice: 'accept' | 'decline') =>
  ({ optionId, label: `Option ${optionId}`, consequences: [`${optionId} follows`], choice });
const owner = (id: string, cls: string) => ({ id, kind: 'owner_choice', condition: `The owner decides ${id}`,
  criterion: `An option of ${id} is picked`, class: cls, classReason: `The options of ${id} are a ${cls}`,
  options: [option(`${id}-yes`, 'accept'), option(`${id}-no`, 'decline')] });
const CONDITIONS = [{ id: 'evidence-1', kind: 'evidence', condition: 'A source is available', criterion: 'A signed agreement' },
  owner('pick1', 'choice'), owner('pick2', 'choice'), owner('scope', 'boundary'), owner('debt', 'risk')];
type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
const world = (t: test.TestContext) => finalAssessmentPaid(t, { outcome: 'conditional', conditions: CONDITIONS, form: V8_FINAL_CONTRACT });
function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.refusal.code}: ${result.refusal.message}`);
  return (result as { ok: true; value: T }).value;
}
const money = (store: Store) => canonical(store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind))
  .flatMap(row => store.history(row.id)) as never);
async function quiet<T>(f: World, store: Store, action: () => Promise<T>): Promise<T> {
  const calls = money(store), sent = canonical(f.wires() as never);
  const value = await storeUnchanged(store, action);
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
  return value;
}
async function refused(f: World, store: Store, action: () => Promise<unknown>, code?: string) {
  const calls = money(store), sent = canonical(f.wires() as never);
  await storeRefused(store, action, error => error instanceof EngineError && (!code || error.code === code));
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
}
/** The owner accepts the exact assessed bundle in the current mode: by the owner act in questions, by the machine in bypass. */
async function accepted(f: World): Promise<AcceptedDiscovery> {
  const mode = readProjectMode(f.store, 'p'), reason = 'The owner accepts the exact assessed bundle';
  const request = { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason };
  if (mode.mode === 'bypass') return (await acceptDiscoveryFinal(f.store, request)).accepted!;
  const scope = { projectId: 'p', draft: f.packet.final.subject.basis.draft, paid: f.paidD7, assessment: f.paidResult,
    mode: { id: mode.ref.id, revision: mode.ref.revision, hash: mode.ref.hash }, decision: 'accept', reason };
  const sessions = new FinalAcceptanceSessions(f.store);
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueFinalAcceptanceInvitation(f.store, scope)).invitation }));
  return (await acceptDiscoveryFinal(f.store, request, sessions.authority(login.bearer))).accepted!;
}
const choice = (edition: AcceptedDiscovery, conditionId: string, optionId: string) =>
  ({ projectId: 'p', manifest: reference(edition.manifest), conditionId, optionId, reason: 'The owner chooses' });
/** The owner's scoped authority for exactly this choice on this edition. */
async function chooser(store: Store, edition: AcceptedDiscovery, conditionId: string, optionId: string) {
  const request = choice(edition, conditionId, optionId);
  const sessions = new ConditionChoiceSessions(store);
  const scope = { projectId: 'p', predecessor: request.manifest, bundle: edition.manifest.value.bundle, conditionId, optionId, reason: request.reason };
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueConditionChoiceInvitation(store, scope)).invitation }));
  return { request, authority: sessions.authority(login.bearer)! };
}
async function resolve(store: Store, edition: AcceptedDiscovery, conditionId: string, optionId: string) {
  const o = await chooser(store, edition, conditionId, optionId);
  return { ...o, outcome: await resolveDiscoveryCondition(store, o.request, o.authority) };
}

type Held = { writes: Parameters<Store['writeMany']>[0]; guards: Parameters<Store['writeMany']>[1] };
const isChoice = (writes: readonly { kind: string }[]) => writes.some(w => w.kind === CONDITION_RESOLUTION_KIND);
/** A real act prepared by the producer on another Store; its one write is held back, not committed. */
async function held(other: Store, on: AcceptedDiscovery, conditionId: string, optionId: string): Promise<Held> {
  const b = await chooser(other, on, conditionId, optionId), previous = Store.prototype.writeMany;
  let captured: Held | null = null;
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    if (this === other && isChoice(writes) && !captured) { captured = { writes, guards }; throw new EngineError('held', 'held'); }
    return previous.call(this, writes, guards);
  } as typeof previous;
  try { await assert.rejects(() => resolveDiscoveryCondition(other, b.request, b.authority), (error: unknown) => error instanceof EngineError && error.code === 'held'); }
  finally { Store.prototype.writeMany = previous; }
  return captured!;
}
/** This Store's write of a choice runs after `before` — another Store's committed winner or a revocation. */
async function racing<T>(store: Store, before: () => void, action: () => Promise<T>): Promise<T> {
  const previous = Store.prototype.writeMany;
  let raced = false;
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    if (this === store && !raced && isChoice(writes)) { raced = true; before(); }
    return previous.call(this, writes, guards);
  } as typeof previous;
  try { return await action(); } finally { Store.prototype.writeMany = previous; assert.equal(raced, true); }
}
const counts = (store: Store) => [CONDITION_RESOLUTION_KIND, MANIFEST_SUCCESSOR_KIND, DISCOVERY_MANIFEST_KIND].map(kind => store.list(kind).length);
const stale = (error: unknown) => error instanceof EngineError && error.code === 'discovery_condition_resolution_stale';

// The first test pays the first real construction of the classed seed; its own body stays small.
test('7b.3 edition races: the classed paid world carries its two choice conditions', async t => {
  const f = await world(t);
  assert.deepEqual(f.packet.candidate.verdict.conditions, CONDITIONS);
});

test('7b.3 edition races: a failed write leaves no resolution, edition or successor, and the next attempt resolves', async t => {
  const f = await world(t), first = await accepted(f), previous = Store.prototype.writeMany;
  const a = await chooser(f.store, first, 'pick1', 'pick1-yes'), before = counts(f.store);
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    if (this === f.store && isChoice(writes)) throw new EngineError('injected_write_failure', 'The publication fails');
    return previous.call(this, writes, guards);
  } as typeof previous;
  try { await refused(f, f.store, () => resolveDiscoveryCondition(f.store, a.request, a.authority), 'injected_write_failure'); }
  finally { Store.prototype.writeMany = previous; }
  assert.deepEqual(counts(f.store), before);
  assert.equal((await resolveDiscoveryCondition(f.store, a.request, a.authority)).resolved, true);
});

test('7b.3 edition races: the same choice from two Stores has one proven winner; another condition on that predecessor is stale', async t => {
  const f = await world(t), first = await accepted(f), other = f.open();
  const a = await chooser(f.store, first, 'pick1', 'pick1-yes'), same = await held(other, first, 'pick1', 'pick1-yes');
  const b = await chooser(other, first, 'pick2', 'pick2-yes');
  const won = await racing(f.store, () => other.writeMany(same.writes, same.guards), () => resolveDiscoveryCondition(f.store, a.request, a.authority));
  assert.equal(won.repeated, true); assert.equal(won.resolved, true); assert.deepEqual(counts(f.store), [1, 1, 2]);
  // On the same predecessor another condition lost the race: stale, nothing written, the winner kept.
  await refused(f, other, () => resolveDiscoveryCondition(other, b.request, b.authority), 'discovery_condition_resolution_stale');
  const invitation = await issueConditionChoiceInvitation(f.store, { projectId: 'p', predecessor: reference(first.manifest),
    bundle: first.manifest.value.bundle, conditionId: 'pick2', optionId: 'pick2-yes', reason: 'The owner chooses' });
  assert.equal(!invitation.ok && invitation.refusal.code, 'discovery_condition_resolution_stale', 'no invitation on the old predecessor');
  assert.deepEqual(counts(f.store), [1, 1, 2]);
  // New work on the remaining condition goes to the new exact edition.
  assert.equal((await resolve(f.store, won.edition!, 'pick2', 'pick2-yes')).outcome.edition!.resolutions.length, 2);
});

test('7b.3 edition races: a decline against a concurrent accept of another condition is stale and saves no decline', async t => {
  const f = await world(t), first = await accepted(f), other = f.open();
  const declining = await chooser(f.store, first, 'pick2', 'pick2-no'), winner = await held(other, first, 'pick1', 'pick1-yes');
  await racing(f.store, () => other.writeMany(winner.writes, winner.guards),
    () => assert.rejects(() => resolveDiscoveryCondition(f.store, declining.request, declining.authority), stale));
  assert.equal(f.store.get(conditionResolutionId('p', first.manifest.value.bundle, 'pick2')), null, 'no decline was saved');
  assert.deepEqual(counts(f.store), [1, 1, 2], 'the winner is kept');
});

test('7b.3 edition races: a revocation before the commit writes nothing, and a lost return after the commit reads the saved edition', async t => {
  const f = await world(t), first = await accepted(f), previous = Store.prototype.writeMany;
  const sessions = new ConditionChoiceSessions(f.store), request = choice(first, 'pick1', 'pick1-yes');
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueConditionChoiceInvitation(f.store,
    { projectId: 'p', predecessor: request.manifest, bundle: first.manifest.value.bundle, conditionId: 'pick1', optionId: 'pick1-yes', reason: request.reason })).invitation }));
  await racing(f.store, () => { ok(sessions.revoke(login.bearer)); },
    () => assert.rejects(() => resolveDiscoveryCondition(f.store, request, sessions.authority(login.bearer)), stale));
  assert.deepEqual(counts(f.store), [0, 0, 1]);
  // The commit succeeds and its return is lost; the repeat reads the complete saved result, free.
  const a = await chooser(f.store, first, 'pick1', 'pick1-yes');
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    const value = previous.call(this, writes, guards);
    if (this === f.store && isChoice(writes)) throw new Error('lost-return');
    return value;
  } as typeof previous;
  try { await assert.rejects(() => resolveDiscoveryCondition(f.store, a.request, a.authority), /lost-return/); }
  finally { Store.prototype.writeMany = previous; }
  const restored = await quiet(f, f.store, () => resolveDiscoveryCondition(f.store, a.request));
  assert.equal(restored.repeated, true); assert.equal(restored.resolved, true); assert.deepEqual(counts(f.store), [1, 1, 2]);
});
