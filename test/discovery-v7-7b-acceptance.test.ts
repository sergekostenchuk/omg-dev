import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { FinalAcceptanceSessions, acceptDiscoveryFinal, issueFinalAcceptanceInvitation } from '../src/product/owner-authority.js';
import { ACCEPTED_FINAL_BUNDLE_KIND, FINAL_ACCEPTANCE_ACT_KIND, FINAL_MACHINE_ADMISSION_KIND, finalAcceptanceActId,
  readAcceptedDiscoveryManifestAt } from '../src/discovery/discovery-acceptance.js';
import { DISCOVERY_MANIFEST_KIND, discoveryManifestId } from '../src/discovery/discovery-manifest.js';
import type { OmResult } from '../src/om/refusal.js';
import { modeOf } from './discovery-v7-dossier-seed.js';
import { finalAssessmentPaid, type FinalAssessmentSeedOptions } from './discovery-v7-final-assessment-seed.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

// DR7 7b.1+7b.2 (codex-omg2 №16106 п.1): the acceptance of one exact assessed D7 bundle and the atomic publication of its
// manifest, over real paid D7 results and their real paid assessments of the shared seed. Questions mode decides by the
// owner act, bypass mode by the machine admission of the proven saved policy; a refusal writes nothing.
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
const request = (f: World, decision: 'accept' | 'decline' = 'accept', reason = 'The owner accepts the exact assessed bundle') =>
  ({ projectId: 'p', assessment: f.paidResult, decision, reason });
/** The owner's scoped authority for exactly this decision under the current questions-mode record. */
async function owner(f: World, decision: 'accept' | 'decline' = 'accept', reason = 'The owner accepts the exact assessed bundle') {
  // The expected scope comes from the fixture; the invitation and the producer prove the grounds themselves.
  const mode = readProjectMode(f.store, 'p');
  const scope = { projectId: 'p', draft: f.packet.final.subject.basis.draft, paid: f.paidD7, assessment: f.paidResult,
    mode: { id: mode.ref.id, revision: mode.ref.revision, hash: mode.ref.hash }, decision, reason };
  const issued = ok(await issueFinalAcceptanceInvitation(f.store, scope));
  const sessions = new FinalAcceptanceSessions(f.store);
  const login = ok(sessions.exchange({ projectId: 'p', invitation: issued.invitation }));
  return { scope, sessions, bearer: login.bearer, authority: sessions.authority(login.bearer)!, request: request(f, decision, reason) };
}
/** A read overlay answering some exact revisions differently; the genuine Store stays the observed one. */
function overlay(store: Store, rows: { id: string; revision: number | 'head'; value: unknown }[]): Store {
  const get = store.get.bind(store), bound = new Map<PropertyKey, unknown>();
  return new Proxy(store, { get(target, key) {
    if (key === 'get') return <T>(id: string, revision?: number) => {
      const found = rows.find(row => row.id === id && (row.revision === 'head' ? revision === undefined
        : revision === undefined || row.revision === revision));
      return (found ? found.value : get<T>(id, revision)) as Revision<T> | null;
    };
    if (!bound.has(key)) { const value = Reflect.get(target, key); bound.set(key, typeof value === 'function' ? value.bind(target) : value); }
    return bound.get(key);
  } });
}
const absent = (store: Store, ref: Ref) => overlay(store, [{ id: ref.id, revision: ref.revision, value: null }]);
const newEvents = (store: Store, from: number) => store.eventsPage(from, store.lastEvent(), 1000);
async function world(t: test.TestContext, options: FinalAssessmentSeedOptions = {}) { return finalAssessmentPaid(t, options); }

// The first test of the file pays the first real construction of the shared seed; its own body stays small.
test('7b acceptance questions: without its owner authority a paid supported assessment is not accepted and nothing is written', async t => {
  const f = await world(t);
  assert.equal(readProjectMode(f.store, 'p').mode, 'questions');
  await refused(f, f.store, () => acceptDiscoveryFinal(f.store, request(f)), 'owner_authority_invalid');
  assert.equal(f.store.list(DISCOVERY_MANIFEST_KIND).length, 0);
});

test('7b acceptance owner: accept publishes the act, the saved whole bundle and the manifest in one write, read back exactly', async t => {
  const f = await world(t), o = await owner(f), before = f.store.lastEvent(), calls = money(f.store), sent = wire(f);
  const outcome = await acceptDiscoveryFinal(f.store, o.request, o.authority);
  const written = newEvents(f.store, before);
  assert.deepEqual(written.map(event => event.kind).sort(), [ACCEPTED_FINAL_BUNDLE_KIND, DISCOVERY_MANIFEST_KIND, FINAL_ACCEPTANCE_ACT_KIND].sort());
  assert.equal(money(f.store), calls); assert.equal(wire(f), sent, 'acceptance calls no model and pays nothing');
  assert.equal(outcome.decision, 'accept'); assert.equal(outcome.repeated, false);
  const accepted = outcome.accepted!;
  assert.equal(accepted.verification, 'accepted'); assert.equal(accepted.admission.kind, 'owner');
  assert.deepEqual(accepted.manifest.value.assessment, f.paidResult); assert.equal(accepted.manifest.value.previous, null);
  assert.deepEqual(accepted.manifest.value.resolutions, []);
  assert.deepEqual(accepted.bundle.value.bundle, f.result.value.projection.candidate, 'the whole assessed bundle is saved');
  assert.deepEqual(accepted.bundle.value.paid, f.paidD7);
  assert.equal(accepted.bundle.value.bundle.verdict.outcome, 'go', 'supported changes no D7 outcome');
  assert.deepEqual(accepted.bundle.value.bundle.constitution, f.result.value.projection.candidate.constitution, 'the constitution is not rewritten');
  // Repeat, late heads and a cold Store: the same proven acceptance, nothing written.
  assert.deepEqual((await quiet(f, f.store, () => acceptDiscoveryFinal(f.store, o.request, o.authority))).accepted, accepted);
  modeOf(f.store, 'bypass');
  const manifest = reference(accepted.manifest), cold = f.open();
  assert.deepEqual(await quiet(f, f.store, () => readAcceptedDiscoveryManifestAt(f.store, 'p', manifest)), accepted);
  assert.deepEqual(await quiet(f, cold, () => readAcceptedDiscoveryManifestAt(cold, 'p', manifest)), accepted);
  const again = await quiet(f, cold, () => acceptDiscoveryFinal(cold, o.request));
  assert.equal(again.repeated, true); assert.deepEqual(again.accepted, accepted, 'a saved decision is returned even after the mode moved');
});

test('7b acceptance owner decline: the act is saved and no accepted bundle or manifest is published', async t => {
  const f = await world(t), o = await owner(f, 'decline', 'The owner refuses this bundle'), before = f.store.lastEvent();
  const outcome = await acceptDiscoveryFinal(f.store, o.request, o.authority);
  assert.deepEqual(newEvents(f.store, before).map(event => event.kind), [FINAL_ACCEPTANCE_ACT_KIND]);
  assert.equal(outcome.decision, 'decline'); assert.equal(outcome.accepted, null);
  assert.equal(outcome.act!.value.scope.decision, 'decline');
  assert.equal(f.store.list(DISCOVERY_MANIFEST_KIND).length, 0); assert.equal(f.store.list(ACCEPTED_FINAL_BUNDLE_KIND).length, 0);
  // The same assessment cannot later be accepted under another act: its one decision stands.
  const repeat = await quiet(f, f.store, () => acceptDiscoveryFinal(f.store, request(f)));
  assert.equal(repeat.decision, 'decline'); assert.equal(repeat.repeated, true);
});

test('7b acceptance bypass: the machine admission stands on the proven bypass record; an owner authority or a refusal is no machine decision', async t => {
  // The project's own saved policy decides: the owner world moves to bypass through the real project-mode door.
  const f = await world(t), intruder = await owner(f);
  modeOf(f.store, 'bypass');
  assert.equal(readProjectMode(f.store, 'p').mode, 'bypass');
  await refused(f, f.store, () => acceptDiscoveryFinal(f.store, intruder.request, intruder.authority), 'discovery_acceptance_mode_mismatch');
  await refused(f, f.store, () => acceptDiscoveryFinal(f.store, request(f, 'decline')), 'discovery_acceptance_mode_mismatch');
  const before = f.store.lastEvent(), outcome = await acceptDiscoveryFinal(f.store, request(f));
  assert.deepEqual(newEvents(f.store, before).map(event => event.kind).sort(), [ACCEPTED_FINAL_BUNDLE_KIND, DISCOVERY_MANIFEST_KIND, FINAL_MACHINE_ADMISSION_KIND].sort());
  const accepted = outcome.accepted!;
  assert.equal(accepted.admission.kind, 'machine'); assert.equal(outcome.act, null);
  assert.equal((accepted.admission.record.value as { policy: string }).policy, 'bypass');
  assert.deepEqual((accepted.admission.record.value as { mode: Ref }).mode, reference(readProjectMode(f.store, 'p').record));
  const cold = f.open();
  assert.deepEqual(await quiet(f, cold, () => readAcceptedDiscoveryManifestAt(cold, 'p', reference(accepted.manifest))), accepted);
});

test('7b acceptance refusals: a paid return assessment is never accepted nor offered to the owner', async t => {
  const back = await world(t, { verdict: 'return' });
  await refused(back, back.store, () => acceptDiscoveryFinal(back.store, request(back)), 'discovery_acceptance_not_supported');
  await refused(back, back.store, () => issueFinalAcceptanceInvitation(back.store, { projectId: 'p', draft: back.paidD7, paid: back.paidD7,
    assessment: back.paidResult, mode: reference(readProjectMode(back.store, 'p').record), decision: 'accept', reason: 'x' })
    .then(result => { if (!result.ok) throw new EngineError(result.refusal.code, result.refusal.message); }), 'discovery_acceptance_not_supported');
});

test('7b acceptance forged and lost grounds: no mode, a foreign project, malformed requests, a lost record or a forged act or supported accept nothing', async t => {
  const f = await world(t), back = await world(t, { verdict: 'return' });
  const mode = readProjectMode(f.store, 'p').record;
  // Only the current head is absent: the historical mode records of the paid grounds stay readable.
  await refused(f, f.store, () => acceptDiscoveryFinal(overlay(f.store, [{ id: mode.id, revision: 'head', value: null }]), request(f)),
    'discovery_acceptance_mode_unset');
  await refused(f, f.store, () => acceptDiscoveryFinal(f.store, { ...request(f), projectId: 'other' }));
  for (const bad of [null, {}, { ...request(f), extra: 1 }, { ...request(f), assessment: f.paidD7 }, { ...request(f), assessment: { ...f.paidResult, hash: '0'.repeat(64) } },
    { ...request(f), decision: 'maybe' }, { ...request(f), reason: ' ' }])
    await refused(f, f.store, () => acceptDiscoveryFinal(f.store, bad));
  // Lost grounds of a saved acceptance and a forged supported/act are never an accepted Discovery.
  const o = await owner(f), accepted = (await acceptDiscoveryFinal(f.store, o.request, o.authority)).accepted!;
  const manifest = reference(accepted.manifest);
  // The saved bundle and act of this acceptance; the paid assessment's own doors are covered by its source and execution tests.
  for (const lost of [accepted.manifest.value.bundle, accepted.manifest.value.admission.record])
    await refused(f, f.store, () => readAcceptedDiscoveryManifestAt(absent(f.store, lost), 'p', manifest));
  const act = accepted.admission.record as Revision<any>, forged = structuredClone(act.value);
  forged.scope.decision = 'decline';
  const forgedRow = { ...act, value: forged, hash: hashJson(forged as Json) };
  await refused(f, f.store, () => readAcceptedDiscoveryManifestAt(overlay(f.store, [{ id: act.id, revision: 1, value: forgedRow }]), 'p', manifest));
  // ACCEPTANCE-EXACT-REF-01: a manifest re-pointed at another revision of its bundle or another id of its act, under a
  // recomputed identity and hash, while the overlay answers that address with the original row, is no exact record.
  const saved = accepted.manifest, bundleRef = saved.value.bundle, actRef = saved.value.admission.record;
  for (const [field, at] of [['bundle', { ...bundleRef, revision: 2 }], ['act', { ...actRef, id: `${actRef.id}x` }]] as const) {
    const value = structuredClone(saved.value) as any;
    if (field === 'bundle') value.bundle = at; else value.admission.record = at;
    const row = { ...saved, id: discoveryManifestId(value), value, hash: hashJson(value as Json) };
    const original = f.store.get(field === 'bundle' ? bundleRef.id : actRef.id, 1);
    await refused(f, f.store, () => readAcceptedDiscoveryManifestAt(overlay(f.store, [{ id: row.id, revision: 1, value: row },
      { id: at.id, revision: at.revision, value: original }]), 'p', reference(row)), 'discovery_acceptance_invalid');
  }
  // A return assessment rewritten as supported under its own consistent hash is no paid supported assessment.
  const rewritten = structuredClone(back.result.value) as any; rewritten.projection.verdict = 'supported';
  const rewrittenRef = { ...back.paidResult, hash: hashJson(rewritten as Json) };
  await refused(back, back.store, () => acceptDiscoveryFinal(overlay(back.store, [{ id: back.result.id, revision: 1,
    value: { ...back.result, value: rewritten, hash: rewrittenRef.hash } }]), { ...request(back), assessment: rewrittenRef }));
  assert.equal(finalAcceptanceActId('p', f.paidResult), act.id);
});

test('7b acceptance atomicity: a failed write leaves no half of the acceptance, and a second Store committing first is the one winner', async t => {
  const f = await world(t), o = await owner(f), previous = Store.prototype.writeMany;
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    if (this === f.store && writes.some(w => w.kind === DISCOVERY_MANIFEST_KIND)) throw new EngineError('injected_write_failure', 'The publication fails');
    return previous.call(this, writes, guards);
  } as typeof previous;
  try { await refused(f, f.store, () => acceptDiscoveryFinal(f.store, o.request, o.authority), 'injected_write_failure'); }
  finally { Store.prototype.writeMany = previous; }
  for (const kind of [FINAL_ACCEPTANCE_ACT_KIND, ACCEPTED_FINAL_BUNDLE_KIND, DISCOVERY_MANIFEST_KIND]) assert.equal(f.store.list(kind).length, 0, kind);
  // The other Store commits the very same publication just before this Store writes; this Store reads that winner.
  const other = f.open(); let raced = false;
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    if (this === f.store && !raced && writes.some(w => w.kind === DISCOVERY_MANIFEST_KIND)) { raced = true; previous.call(other, writes, guards); }
    return previous.call(this, writes, guards);
  } as typeof previous;
  let outcome: Awaited<ReturnType<typeof acceptDiscoveryFinal>>;
  try { outcome = await acceptDiscoveryFinal(f.store, o.request, o.authority); } finally { Store.prototype.writeMany = previous; }
  assert.equal(raced, true); assert.equal(outcome.repeated, true);
  assert.equal(f.store.list(DISCOVERY_MANIFEST_KIND).length, 1);
  assert.deepEqual(outcome.accepted, await readAcceptedDiscoveryManifestAt(other, 'p', reference(outcome.accepted!.manifest)));
});
