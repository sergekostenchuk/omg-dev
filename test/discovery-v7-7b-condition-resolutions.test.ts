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
  // The caller's array is snapshotted before the first await: a later mutation never reaches the paid world.
  const given = structuredClone(CONDITIONS), f = await finalAssessmentPaid(t, { outcome: 'conditional', conditions: given });
  given[1]!.options![0]!.consequences[0] = 'mutated';
  assert.deepEqual(f.packet.candidate.verdict.conditions, CONDITIONS, 'the paid assessment reviewed exactly these conditions');
  assert.equal((await finalAssessmentPaid(t, { outcome: 'conditional', conditions: CONDITIONS })).paidResult.hash, f.paidResult.hash,
    'the same conditions share one paid baseline');
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

test('7b.3 owner accept: the resolution, the next edition and the successor are one write; the accepted bodies stay', async t => {
  const { f, first } = await accepted(t);
  const o = await chooser(f.store, first, 'owner-1', 'narrow'), from = f.store.lastEvent();
  const outcome = await resolveDiscoveryCondition(f.store, o.request, o.authority);
  assert.equal(outcome.choice, 'accept'); assert.equal(outcome.repeated, false);
  const edition = outcome.edition!, resolution = outcome.resolution;
  // Exactly the three new records, in one write.
  const events = f.store.eventsPage(from, f.store.lastEvent(), 1000).map(event => event.id).sort();
  assert.deepEqual(events, [edition.manifest.id, manifestSuccessorId(reference(first.manifest)),
    conditionResolutionId('p', first.manifest.value.bundle, 'owner-1')].sort());
  assert.deepEqual(edition.manifest.value.previous, reference(first.manifest));
  assert.deepEqual(edition.manifest.value.resolutions, [reference(resolution)]);
  for (const key of ['draft', 'bundle', 'assessment', 'admission'] as const)
    assert.deepEqual(edition.manifest.value[key], first.manifest.value[key], `the accepted ${key} is kept`);
  assert.deepEqual(edition.bundle, first.bundle); assert.deepEqual(edition.admission, first.admission);
  assert.deepEqual(edition.conditions, { resolved: ['owner-1'], open: ['evidence-1', 'owner-2'] });
  assert.equal(edition.bundle.value.bundle.verdict.outcome, 'conditional', 'conditional is never replaced by go');
  assert.deepEqual(resolution.value.option, CONDITIONS[1]!.options![0], 'the offered option verbatim, with its consequences');
  assert.deepEqual(resolution.value.predecessor, reference(first.manifest));
  // A repeat, a cold Store and the historical predecessor read the same.
  const again = await quiet(f, f.store, () => resolveDiscoveryCondition(f.store, o.request, o.authority));
  assert.equal(again.repeated, true); assert.deepEqual(again.edition, edition);
  const cold = f.open();
  assert.deepEqual(await quiet(f, cold, () => readAcceptedDiscoveryManifestAt(cold, 'p', reference(edition.manifest))), edition);
  assert.deepEqual(await readAcceptedDiscoveryManifestAt(f.store, 'p', reference(first.manifest)), first, 'the predecessor stays historical');
  // The other owner condition is chosen on the latest edition; the edition chain grows by one proven resolution.
  const second = await chooser(f.store, edition, 'owner-2', 'carry');
  const next = (await resolveDiscoveryCondition(f.store, second.request, second.authority)).edition!;
  assert.deepEqual(next.manifest.value.previous, reference(edition.manifest));
  assert.equal(next.resolutions.length, 2); assert.deepEqual(next.conditions, { resolved: ['owner-1', 'owner-2'], open: ['evidence-1'] });
});

test('7b.3 owner decline: the saved refusal fulfils nothing, publishes no edition, and an opposite repeat is a conflict', async t => {
  const { f, first } = await accepted(t);
  const o = await chooser(f.store, first, 'owner-1', 'refuse');
  const outcome = await resolveDiscoveryCondition(f.store, o.request, o.authority);
  assert.equal(outcome.choice, 'decline'); assert.equal(outcome.edition, null);
  assert.deepEqual(outcome.resolution.value.option, CONDITIONS[1]!.options![1]);
  assert.equal(f.store.get(manifestSuccessorId(reference(first.manifest))), null, 'no successor');
  assert.equal(f.store.list(DISCOVERY_MANIFEST_KIND).length, 1, 'no new edition');
  assert.deepEqual((await readAcceptedDiscoveryManifestAt(f.store, 'p', reference(first.manifest))).conditions.open, ['evidence-1', 'owner-1', 'owner-2']);
  const again = await quiet(f, f.store, () => resolveDiscoveryCondition(f.store, o.request, o.authority));
  assert.equal(again.choice, 'decline'); assert.equal(again.repeated, true);
  // The opposite choice is an explicit conflict, never the old decline as a success, and never a rewrite of it.
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, choice(first, 'owner-1', 'narrow')), 'discovery_condition_resolution_conflict');
  // A decline placed into an edition under recomputed identities is no resolution of the edition.
  const forged = edition(first, outcome.resolution);
  await refused(f, f.store, () => readAcceptedDiscoveryManifestAt(overlay(f.store, forged.rows), 'p', forged.ref), 'discovery_acceptance_invalid');
});

/** An edition over a predecessor adding one resolution Ref, with its successor record, under recomputed identities. */
function edition(predecessor: AcceptedDiscovery, resolution: Revision<unknown> | Ref, changes: (value: any) => void = () => {}) {
  const added = 'value' in resolution ? reference(resolution as Revision<unknown>) : resolution;
  const value = structuredClone(predecessor.manifest.value) as any;
  value.previous = reference(predecessor.manifest); value.resolutions = [...value.resolutions, added]; changes(value);
  const ref = { id: discoveryManifestId(value), revision: 1, hash: hashJson(value as Json) };
  const successor = { contract: 'discovery-manifest-successor/v1', projectId: 'p', predecessor: value.previous, successor: ref, resolution: added };
  const row = (id: string, kind: string, body: unknown) => ({ id, revision: 1, value: { id, revision: 1, kind, hash: hashJson(body as Json), value: body } });
  return { ref, value, rows: [row(ref.id, DISCOVERY_MANIFEST_KIND, value),
    row(manifestSuccessorId(value.previous), MANIFEST_SUCCESSOR_KIND, successor)] };
}

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

test('7b.3 forged editions: a substituted, rehashed, re-pointed or lost ground of an edition is refused without writes', async t => {
  const { f, first } = await accepted(t);
  // A real owner-2 choice on the same predecessor, prepared before owner-1 is resolved and held back.
  const fork = await held(f.open(), first, 'owner-2', 'carry');
  const o = await chooser(f.store, first, 'owner-1', 'narrow');
  const real = (await resolveDiscoveryCondition(f.store, o.request, o.authority)).edition!, resolution = real.resolutions[0]!;
  const read = (store: Store, ref: Ref) => () => readAcceptedDiscoveryManifestAt(store, 'p', ref);
  // ACCEPTANCE-EXACT-REF-01: the edition names revision 2 of its resolution and the overlay answers with the saved row.
  const moved = { ...reference(resolution), revision: 2 }, shifted = edition(first, moved);
  await refused(f, f.store, read(overlay(f.store, [...shifted.rows, { id: moved.id, revision: 2, value: resolution }]), shifted.ref), 'discovery_acceptance_invalid');
  // The saved option rewritten (its consequences) under a consistent hash is not the offered option.
  const rewritten = structuredClone(resolution) as any; rewritten.value.option.consequences = ['Everything ships at once'];
  rewritten.hash = hashJson(rewritten.value as Json);
  const rehashed = edition(first, reference(rewritten));
  await refused(f, f.store, read(overlay(f.store, [...rehashed.rows, { id: rewritten.id, revision: 1, value: rewritten }]), rehashed.ref), 'discovery_acceptance_invalid');
  // An edition that changes an accepted body, adds the same resolution again, or is not named by the successor record.
  const draft = edition(first, resolution, value => { value.draft = value.assessment; });
  await refused(f, f.store, read(overlay(f.store, draft.rows), draft.ref), 'discovery_acceptance_invalid');
  const twice = edition(real, resolution);
  await refused(f, f.store, read(overlay(f.store, twice.rows), twice.ref), 'discovery_manifest_invalid');
  // A second edition on the same predecessor, with its real resolution and manifest planted but not named by the one
  // successor record: the one-line limit holds on reading, not only on writing.
  const planted = fork.writes.filter(w => w.kind !== MANIFEST_SUCCESSOR_KIND), forkManifest = planted.find(w => w.kind === DISCOVERY_MANIFEST_KIND)!;
  const forkRef = { id: forkManifest.id, revision: 1, hash: hashJson(forkManifest.value as Json) };
  await refused(f, f.store, read(overlay(f.store, planted.map(w => ({ id: w.id, revision: 1,
    value: { id: w.id, revision: 1, kind: w.kind, hash: hashJson(w.value as Json), value: w.value } }))), forkRef), 'discovery_acceptance_invalid');
  // Lost grounds of the real edition: the successor record, the resolution, the predecessor manifest.
  for (const lost of [{ id: manifestSuccessorId(reference(first.manifest)), revision: 1 }, reference(resolution), reference(first.manifest)])
    await refused(f, f.store, read(overlay(f.store, [{ id: lost.id, revision: lost.revision, value: null }]), reference(real.manifest)));
});

test('7b.3 atomicity and races: a failed write leaves no half edition; on one predecessor the same choice has one winner and another condition is stale', async t => {
  const { f, first } = await accepted(t), previous = Store.prototype.writeMany;
  const a = await chooser(f.store, first, 'owner-1', 'narrow');
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    if (this === f.store && isChoice(writes)) throw new EngineError('injected_write_failure', 'The publication fails');
    return previous.call(this, writes, guards);
  } as typeof previous;
  try { await refused(f, f.store, () => resolveDiscoveryCondition(f.store, a.request, a.authority), 'injected_write_failure'); }
  finally { Store.prototype.writeMany = previous; }
  for (const kind of [CONDITION_RESOLUTION_KIND, MANIFEST_SUCCESSOR_KIND]) assert.equal(f.store.list(kind).length, 0, kind);
  assert.equal(f.store.list(DISCOVERY_MANIFEST_KIND).length, 1);
  // A second Store prepares its own real choice on the same predecessor; its writes are held and committed first.
  const other = f.open();
  async function race(winner: Held, action: () => Promise<unknown>) {
    let raced = false;
    Store.prototype.writeMany = function (this: Store, writes, guards) {
      if (this === f.store && !raced && isChoice(writes)) { raced = true; previous.call(other, winner.writes, winner.guards); }
      return previous.call(this, writes, guards);
    } as typeof previous;
    try { return await action(); } finally { Store.prototype.writeMany = previous; assert.equal(raced, true); }
  }
  // Another condition committed first on the same predecessor: this choice is stale and writes nothing.
  const otherCondition = await held(other, first, 'owner-2', 'carry');
  await race(otherCondition, () => assert.rejects(() => resolveDiscoveryCondition(f.store, a.request, a.authority),
    (error: unknown) => error instanceof EngineError && error.code === 'discovery_condition_resolution_stale'));
  assert.equal(f.store.get(conditionResolutionId('p', first.manifest.value.bundle, 'owner-1')), null, 'the stale choice wrote nothing');
  const winner = await readAcceptedDiscoveryManifestAt(f.store, 'p', reference(f.store.get<any>(manifestSuccessorId(reference(first.manifest)))!.value.successor));
  assert.deepEqual(winner.conditions.resolved, ['owner-2']);
  // On the winner's edition the same choice raced by the second Store has one proven winner.
  const c = await chooser(f.store, winner, 'owner-1', 'narrow'), sameChoice = await held(other, winner, 'owner-1', 'narrow');
  const outcome = await race(sameChoice, () => resolveDiscoveryCondition(f.store, c.request, c.authority)) as Awaited<ReturnType<typeof resolveDiscoveryCondition>>;
  assert.equal(outcome.repeated, true); assert.deepEqual(outcome.edition!.conditions.resolved, ['owner-1', 'owner-2']);
  assert.equal(f.store.list(CONDITION_RESOLUTION_KIND).length, 2);
});
