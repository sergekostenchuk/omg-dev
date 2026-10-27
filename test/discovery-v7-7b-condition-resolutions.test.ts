import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { ConditionChoiceSessions, FinalAcceptanceSessions, acceptDiscoveryFinal, issueConditionChoiceInvitation,
  issueFinalAcceptanceInvitation, resolveDiscoveryCondition } from '../src/product/owner-authority.js';
import { CONDITION_RESOLUTION_KIND, MANIFEST_SUCCESSOR_KIND, conditionResolutionId, manifestSuccessorId,
  readAcceptedDiscoveryManifestAt, type AcceptedDiscovery } from '../src/discovery/discovery-acceptance.js';
import { DISCOVERY_MANIFEST_KIND, discoveryManifestId } from '../src/discovery/discovery-manifest.js';
import type { OmResult } from '../src/om/refusal.js';
import { proveClaimAddress } from '../src/discovery/claim-address.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

// DR7 7b.3 (codex-omg2 №16156 п.1, №16160): the owner's choice on an owner_choice condition of one accepted conditional
// bundle publishes the next immutable manifest edition; a declining choice is the owner's saved act and fulfils nothing;
// an evidence condition stays open until the paid conformance assessment of 7b.3e. All over a real paid conditional D7
// with [evidence-1, owner-1, owner-2] and its real supported assessment, accepted by the owner.
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
const wire = (f: World) => canonical(f.wires() as never);
async function quiet<T>(f: World, store: Store, action: () => Promise<T>): Promise<T> {
  const calls = money(store), sent = wire(f);
  const value = await storeUnchanged(store, action);
  assert.equal(money(store), calls); assert.equal(wire(f), sent);
  return value;
}
async function refused(f: World, store: Store, action: () => Promise<unknown>, code?: string) {
  const calls = money(store), sent = wire(f);
  await storeRefused(store, action, error => error instanceof EngineError && (!code || error.code === code));
  assert.equal(money(store), calls); assert.equal(wire(f), sent);
}
/** A read overlay answering some exact revisions differently; the genuine Store stays the observed one. */
function overlay(store: Store, rows: { id: string; revision: number; value: unknown }[]): Store {
  const get = store.get.bind(store), bound = new Map<PropertyKey, unknown>();
  return new Proxy(store, { get(target, key) {
    if (key === 'get') return <T>(id: string, revision?: number) => {
      const found = rows.find(row => row.id === id && (revision === undefined || row.revision === revision));
      return (found ? found.value : get<T>(id, revision)) as Revision<T> | null;
    };
    if (!bound.has(key)) { const value = Reflect.get(target, key); bound.set(key, typeof value === 'function' ? value.bind(target) : value); }
    return bound.get(key);
  } });
}
/** The same overlay on the genuine Store itself: its prototype read answers some exact revisions differently while the
 * action runs, so the proof cache of the genuine Store stays in use. */
async function masked<T>(store: Store, rows: { id: string; revision: number; value: unknown }[], action: () => Promise<T>): Promise<T> {
  const get = Store.prototype.get;
  Store.prototype.get = function (this: Store, id: string, revision?: number) {
    const found = this === store ? rows.find(row => row.id === id && (revision === undefined || row.revision === revision)) : undefined;
    return found ? found.value : get.call(this, id, revision);
  } as typeof get;
  try { return await action(); } finally { Store.prototype.get = get; }
}
/** The real conditional world, accepted by the owner in questions mode. */
async function accepted(t: test.TestContext): Promise<{ f: World; first: AcceptedDiscovery }> {
  const f = await finalAssessmentPaid(t, { outcome: 'conditional', conditions: CONDITIONS });
  const mode = readProjectMode(f.store, 'p').ref, reason = 'The owner accepts the exact assessed bundle';
  const scope = { projectId: 'p', draft: f.packet.final.subject.basis.draft, paid: f.paidD7, assessment: f.paidResult,
    mode: { id: mode.id, revision: mode.revision, hash: mode.hash }, decision: 'accept', reason };
  const sessions = new FinalAcceptanceSessions(f.store);
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueFinalAcceptanceInvitation(f.store, scope)).invitation }));
  const outcome = await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason },
    sessions.authority(login.bearer));
  return { f, first: outcome.accepted! };
}
const choice = (edition: AcceptedDiscovery, conditionId: string, optionId: string, reason = 'The owner chooses') =>
  ({ projectId: 'p', manifest: reference(edition.manifest), conditionId, optionId, reason });
/** The owner's scoped authority for exactly this choice on this edition. */
async function chooser(store: Store, edition: AcceptedDiscovery, conditionId: string, optionId: string) {
  const request = choice(edition, conditionId, optionId);
  const scope = { projectId: 'p', predecessor: request.manifest, bundle: edition.manifest.value.bundle, conditionId, optionId, reason: request.reason };
  const sessions = new ConditionChoiceSessions(store);
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueConditionChoiceInvitation(store, scope)).invitation }));
  return { request, scope, sessions, bearer: login.bearer, authority: sessions.authority(login.bearer)! };
}

// The first test pays the first real construction of the conditional seed; its own body stays small.
test('7b.3 forms: the seed carries the given conditions read once; malformed or unknown requests refuse before any proof', async t => {
  // CONDITION-SEED-SNAPSHOT-01: the caller's array is snapshotted before the first await — a mutation right after the
  // call, while the paid world is still being built, never reaches it — and the property is read exactly once.
  const given = structuredClone(CONDITIONS), pending = finalAssessmentPaid(t, { outcome: 'conditional', conditions: given });
  given[1]!.options![0]!.consequences[0] = 'mutated during the preparation';
  const f = await pending;
  assert.deepEqual(f.packet.candidate.verdict.conditions, CONDITIONS, 'the paid assessment reviewed exactly these conditions');
  let reads = 0;
  const once = { outcome: 'conditional' as const, get conditions() { reads++; if (reads > 1) throw new Error('read twice'); return CONDITIONS; } };
  assert.equal((await finalAssessmentPaid(t, once)).paidResult.hash, f.paidResult.hash, 'the same conditions share one paid baseline');
  assert.equal(reads, 1, 'the conditions are read once');
  const manifest = { id: 'discovery-manifest:p:x', revision: 1, hash: '0'.repeat(64) };
  const base = { projectId: 'p', manifest, conditionId: 'owner-1', optionId: 'narrow', reason: 'The owner chooses' };
  for (const bad of [null, {}, { ...base, extra: 1 }, { ...base, reason: ' ' }, { ...base, optionId: '' },
    { ...base, manifest: { ...manifest, extra: 1 } }, { projectId: 'p', manifest, conditionId: 'evidence-1', claims: [], reason: 'x' }])
    await refused(f, f.store, () => resolveDiscoveryCondition(f.store, bad), 'discovery_condition_resolution_invalid');
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, { ...base, projectId: 'other' }), 'owner_project_missing');
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, base), 'discovery_manifest_invalid');
});

test('7b.3 evidence: a real accepted claim is no proof of the criterion; the evidence condition stays open and nothing is written', async t => {
  const { f, first } = await accepted(t);
  assert.deepEqual(first.conditions, { resolved: [], open: ['evidence-1', 'owner-1', 'owner-2'] });
  assert.deepEqual(first.resolutions, []);
  const material = f.packet.final.dossier.materials.map(item => item.address).find(address => {
    try { proveClaimAddress(f.store, address); return true; } catch { return false; }
  });
  assert.ok(material, 'the dossier keeps a really accepted claim');
  const evidence = { projectId: 'p', manifest: reference(first.manifest), conditionId: 'evidence-1', claims: [material], reason: 'Accepted material' };
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, evidence), 'discovery_condition_evidence_unproven');
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, choice(first, 'evidence-1', 'narrow')), 'discovery_condition_evidence_unproven');
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, { ...evidence, claims: [{ ...material, project: 'other' }] }),
    'discovery_condition_resolution_invalid');
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, { ...evidence, conditionId: 'owner-1' }), 'discovery_condition_resolution_invalid');
  for (const [conditionId, optionId] of [['missing', 'narrow'], ['owner-1', 'carry']])
    await refused(f, f.store, () => resolveDiscoveryCondition(f.store, choice(first, conditionId!, optionId!)), 'discovery_condition_resolution_invalid');
});

test('7b.3 owner accept: the act is saved alone; the condition stays open with condition_class_unproven and the address of a new D7', async t => {
  const { f, first } = await accepted(t);
  const o = await chooser(f.store, first, 'owner-1', 'narrow'), from = f.store.lastEvent();
  const outcome = await resolveDiscoveryCondition(f.store, o.request, o.authority);
  assert.equal(outcome.choice, 'accept'); assert.equal(outcome.repeated, false);
  assert.equal(outcome.edition, null); assert.equal(outcome.resolved, false); assert.equal(outcome.unproven, 'condition_class_unproven');
  assert.deepEqual(outcome.route, { target: 'D7', predecessor: reference(first.manifest), bundle: first.manifest.value.bundle,
    paid: f.paidD7, assessment: f.paidResult, conditionId: 'owner-1', optionId: 'narrow' });
  const id = conditionResolutionId('p', first.manifest.value.bundle, 'owner-1');
  assert.deepEqual(f.store.eventsPage(from, f.store.lastEvent(), 1000).map(event => event.id), [id], 'the act is the one write');
  assert.deepEqual(outcome.resolution.value.option, CONDITIONS[1]!.options![0], 'the offered option verbatim, with its consequences');
  assert.deepEqual(outcome.resolution.value.predecessor, reference(first.manifest));
  assert.equal(f.store.get(manifestSuccessorId(reference(first.manifest))), null, 'no successor');
  assert.equal(f.store.list(DISCOVERY_MANIFEST_KIND).length, 1, 'no edition');
  assert.deepEqual(await readAcceptedDiscoveryManifestAt(f.store, 'p', reference(first.manifest)), first, 'every condition stays open');
  // A repeat and a cold Store return the same proven act; the other owner condition is chosen on the same edition.
  const again = await quiet(f, f.store, () => resolveDiscoveryCondition(f.store, o.request, o.authority));
  assert.equal(again.repeated, true); assert.deepEqual(again.resolution, outcome.resolution);
  const cold = f.open();
  assert.deepEqual((await quiet(f, cold, () => resolveDiscoveryCondition(cold, o.request))).resolution, outcome.resolution);
  const second = await chooser(f.store, first, 'owner-2', 'carry');
  assert.equal((await resolveDiscoveryCondition(f.store, second.request, second.authority)).unproven, 'condition_class_unproven');
});

test('7b.3 owner decline: the refusal is saved alone, an opposite repeat is a conflict, and a malformed saved act is a typed refusal', async t => {
  const { f, first } = await accepted(t);
  const o = await chooser(f.store, first, 'owner-1', 'refuse');
  const outcome = await resolveDiscoveryCondition(f.store, o.request, o.authority);
  assert.equal(outcome.choice, 'decline'); assert.equal(outcome.edition, null);
  assert.equal(outcome.unproven, null); assert.equal(outcome.route, null);
  assert.deepEqual(outcome.resolution.value.option, CONDITIONS[1]!.options![1]);
  assert.equal(f.store.get(manifestSuccessorId(reference(first.manifest))), null, 'no successor');
  const again = await quiet(f, f.store, () => resolveDiscoveryCondition(f.store, o.request, o.authority));
  assert.equal(again.choice, 'decline'); assert.equal(again.repeated, true);
  // The opposite choice is an explicit conflict, never the old refusal as a success, and never a rewrite of it.
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, choice(first, 'owner-1', 'narrow')), 'discovery_condition_resolution_conflict');
  // CONDITION-SAVED-SHAPE-01: a saved act whose value is no record, under a consistent hash, is typed on the public repeat.
  const id = conditionResolutionId('p', first.manifest.value.bundle, 'owner-1');
  for (const value of [null, 'x', []])
    await refused(f, f.store, () => masked(f.store, [{ id, revision: 1,
      value: { id, revision: 1, kind: CONDITION_RESOLUTION_KIND, hash: hashJson(value as Json), value } }], () => resolveDiscoveryCondition(f.store, o.request)),
    'discovery_acceptance_invalid');
});

type Held = { writes: Parameters<Store['writeMany']>[0]; guards: Parameters<Store['writeMany']>[1] };
const isChoice = (writes: readonly { kind: string }[]) => writes.some(w => w.kind === CONDITION_RESOLUTION_KIND);
/** A real choice prepared by the producer on another Store; its one write is held back, not committed. */
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

/** An edition over a predecessor naming one more resolution Ref, under recomputed identities. */
function edition(predecessor: AcceptedDiscovery, resolution: Ref) {
  const value = structuredClone(predecessor.manifest.value) as any;
  value.previous = reference(predecessor.manifest); value.resolutions = [...value.resolutions, resolution];
  const ref = { id: discoveryManifestId(value), revision: 1, hash: hashJson(value as Json) };
  return { ref, rows: [{ id: ref.id, revision: 1, value: { id: ref.id, revision: 1, kind: DISCOVERY_MANIFEST_KIND, hash: ref.hash, value } }] };
}

test('7b.3 forged acts and editions: no edition resolves a condition, and a rewritten, moved or re-pointed act is refused without writes', async t => {
  const { f, first } = await accepted(t);
  const o = await chooser(f.store, first, 'owner-1', 'narrow');
  const act = (await resolveDiscoveryCondition(f.store, o.request, o.authority)).resolution;
  // A later edition naming the real accepting act as its resolution, without the successor record of its predecessor.
  // (7b.3 CHOICE-EDITIONS, codex-omg2 №16299: editions now exist, so the planted one is refused as an unnamed edition.)
  const planted = edition(first, reference(act));
  await refused(f, f.store, () => readAcceptedDiscoveryManifestAt(overlay(f.store, planted.rows), 'p', planted.ref), 'discovery_acceptance_invalid');
  // The saved act at its canonical address: its option rewritten, its predecessor re-pointed under a consistent hash, or
  // another revision answered — each is a typed refusal on the public repeat.
  const rewritten = structuredClone(act) as any; rewritten.value.option.consequences = ['Everything ships at once'];
  const repointed = structuredClone(act) as any; repointed.value.predecessor = repointed.value.bundle;
  for (const row of [rewritten, repointed]) row.hash = hashJson(row.value as Json);
  for (const row of [rewritten, repointed, { ...structuredClone(act), revision: 2 }])
    await refused(f, f.store, () => masked(f.store, [{ id: act.id, revision: 1, value: row }], () => resolveDiscoveryCondition(f.store, o.request)),
      'discovery_acceptance_invalid');
});

test('7b.3 atomicity and races: a failed write leaves no act; on one edition the same choice has one winner and the opposite is a conflict', async t => {
  const { f, first } = await accepted(t), previous = Store.prototype.writeMany;
  const a = await chooser(f.store, first, 'owner-1', 'narrow');
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    if (this === f.store && isChoice(writes)) throw new EngineError('injected_write_failure', 'The publication fails');
    return previous.call(this, writes, guards);
  } as typeof previous;
  try { await refused(f, f.store, () => resolveDiscoveryCondition(f.store, a.request, a.authority), 'injected_write_failure'); }
  finally { Store.prototype.writeMany = previous; }
  assert.equal(f.store.list(CONDITION_RESOLUTION_KIND).length, 0);
  // A second Store prepares its own real act on the same edition; its write is held and committed first.
  const other = f.open();
  async function race(winner: Held, action: () => Promise<unknown>) {
    let raced = false;
    Store.prototype.writeMany = function (this: Store, writes, guards) {
      if (this === f.store && !raced && isChoice(writes)) { raced = true; previous.call(other, winner.writes, winner.guards); }
      return previous.call(this, writes, guards);
    } as typeof previous;
    try { return await action(); } finally { Store.prototype.writeMany = previous; assert.equal(raced, true); }
  }
  const same = await race(await held(other, first, 'owner-1', 'narrow'), () => resolveDiscoveryCondition(f.store, a.request, a.authority)) as
    Awaited<ReturnType<typeof resolveDiscoveryCondition>>;
  assert.equal(same.repeated, true); assert.equal(f.store.list(CONDITION_RESOLUTION_KIND).length, 1);
  const b = await chooser(f.store, first, 'owner-2', 'carry');
  await race(await held(other, first, 'owner-2', 'stop'), () => assert.rejects(() => resolveDiscoveryCondition(f.store, b.request, b.authority),
    (error: unknown) => error instanceof EngineError && error.code === 'discovery_condition_resolution_conflict'));
  const kept = f.store.get<any>(conditionResolutionId('p', first.manifest.value.bundle, 'owner-2'))!;
  assert.equal(kept.value.option.optionId, 'stop', 'the winner is kept');
  assert.equal(f.store.list(MANIFEST_SUCCESSOR_KIND).length, 0);
});

test('7b.3 seed cache: other conditions get their own paid baseline, never the one of the shared conditions', async t => {
  const other = CONDITIONS.slice(0, 2), shared = await finalAssessmentPaid(t, { outcome: 'conditional', conditions: CONDITIONS });
  const own = await finalAssessmentPaid(t, { outcome: 'conditional', conditions: other });
  assert.deepEqual(own.packet.candidate.verdict.conditions, other);
  assert.notEqual(own.paidResult.hash, shared.paidResult.hash);
  assert.notEqual(own.paidD7.hash, shared.paidD7.hash, 'a separate paid D7 as well');
});
