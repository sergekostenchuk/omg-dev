import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import { discoveryManifestId, DISCOVERY_MANIFEST_KIND } from '../src/discovery/discovery-manifest.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { FinalAcceptanceSessions, issueFinalAcceptanceInvitation, acceptDiscoveryFinal } from '../src/product/owner-authority.js';
import { readKeeperConstitutionSourceAt } from '../src/product/keeper-constitution-source.js';
import { all, money, modeOf } from './discovery-v7-dossier-seed.js';
import { finalAssessmentPaid, type FinalAssessmentSeedOptions } from './discovery-v7-final-assessment-seed.js';
import { storeUnchanged, storeRefused } from './store-unchanged.js';

type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
async function accepted(t: test.TestContext, options: FinalAssessmentSeedOptions = {}, owner = false) {
  const f = await finalAssessmentPaid(t, options);
  const request = { projectId: 'p', assessment: f.paidResult, decision: 'accept' as const, reason: 'Accept this exact assessed Discovery' };
  let authority: ReturnType<FinalAcceptanceSessions['authority']> = null;
  if (owner) {
    const scope = { ...request, draft: f.packet.final.subject.basis.draft, paid: f.paidD7,
      mode: reference(readProjectMode(f.store, 'p').record) };
    const issued = await issueFinalAcceptanceInvitation(f.store, scope);
    assert.ok(issued.ok);
    const sessions = new FinalAcceptanceSessions(f.store);
    const login = sessions.exchange({ projectId: 'p', invitation: issued.value.invitation });
    assert.ok(login.ok); authority = sessions.authority(login.value.bearer);
  } else modeOf(f.store, 'bypass');
  const result = await acceptDiscoveryFinal(f.store, request, authority ?? undefined);
  assert.ok(result.accepted);
  return { f, proven: result.accepted, ref: reference(result.accepted.manifest) };
}
async function unchanged<T>(f: World, store: Store, action: () => Promise<T>) {
  const financial = money(store), wire = structuredClone(f.wires());
  const value = await storeUnchanged(store, action);
  assert.deepEqual(money(store), financial); assert.deepEqual(f.wires(), wire);
  return value;
}
async function refused(f: World, observed: Store, action: () => Promise<unknown>, code?: string) {
  const financial = money(observed), wire = structuredClone(f.wires());
  await storeRefused(observed, action, e => e instanceof EngineError && (!code || e.code === code));
  assert.deepEqual(money(observed), financial); assert.deepEqual(f.wires(), wire);
}
/** Inject physical loss/corruption only into an isolated copied database. Restore both immutable-revision triggers
 * before the reader runs; the production Store and its proof methods remain intact. */
function damage(path: string, change: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path);
  try {
    const triggers = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name IN ('revisions_no_delete','revisions_no_update')")
      .all().map(row => String(row['sql']));
    assert.equal(triggers.length, 2);
    db.exec('PRAGMA foreign_keys=OFF; BEGIN; DROP TRIGGER revisions_no_delete; DROP TRIGGER revisions_no_update');
    try { change(db); for (const sql of triggers) db.exec(sql); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}
test('keeper constitution: a paid assessment alone and caller accepted/proven marks supply no accepted source', async t => {
  const f = await finalAssessmentPaid(t);
  for (const ref of [f.paidResult, null, undefined, { verification: 'accepted', proven: true, manifest: f.paidResult }])
    await refused(f, f.store, () => readKeeperConstitutionSourceAt(f.store, 'p', ref));
});

test('keeper constitution: questions owner acceptance returns the exact full container and isolated addressed bytes', async t => {
  const { f, proven, ref } = await accepted(t, {}, true), history = all(f.store);
  const source = await unchanged(f, f.store, () => readKeeperConstitutionSourceAt(f.store, 'p', ref));
  assert.deepEqual(source.manifest, proven.manifest); assert.deepEqual(source.container, proven.bundle);
  assert.deepEqual(source.address, { container: reference(proven.bundle), pointer: '/bundle/constitution' });
  assert.notDeepEqual(source.address.container, ref);
  assert.equal(hashJson(source.container.value as never), source.address.container.hash);
  assert.deepEqual(source.constitution, proven.bundle.value.bundle.constitution);
  const original = structuredClone(source);
  source.manifest.value.resolutions.push(f.paidResult);
  source.container.value.bundle.verdict.reason = 'caller mutation'; source.constitution.goal = 'caller mutation';
  assert.deepEqual(source.container.value.bundle.constitution, original.constitution, 'the selected value is an independent copy');
  assert.deepEqual(await unchanged(f, f.store, () => readKeeperConstitutionSourceAt(f.store, 'p', ref)), original);
  modeOf(f.store, 'bypass');
  // Late heads of the actual container and manifest cannot replace either exact accepted record.
  f.store.write({ id: proven.bundle.id, kind: proven.bundle.kind, expected: proven.bundle.revision,
    value: { ...proven.bundle.value, bundle: { ...proven.bundle.value.bundle, constitution: null } } });
  f.store.write({ id: proven.manifest.id, kind: proven.manifest.kind, expected: proven.manifest.revision, value: { late: true } });
  const late = all(f.store), cold = f.open();
  assert.deepEqual(await unchanged(f, f.store, () => readKeeperConstitutionSourceAt(f.store, 'p', ref)), original);
  assert.deepEqual(await unchanged(f, cold, () => readKeeperConstitutionSourceAt(cold, 'p', ref)), original);
  assert.equal(all(cold), late); assert.notEqual(late, history);
});

test('keeper constitution: bypass conditional preserves its constitution and unresolved conditions', async t => {
  const { f, proven, ref } = await accepted(t, { outcome: 'conditional' });
  assert.equal(proven.admission.kind, 'machine');
  const source = await unchanged(f, f.store, () => readKeeperConstitutionSourceAt(f.store, 'p', ref));
  assert.equal(source.container.value.bundle.verdict.outcome, 'conditional');
  assert.ok(source.container.value.bundle.verdict.conditions.length);
  assert.deepEqual(source.container, proven.bundle);
  assert.deepEqual(source.constitution, f.packet.candidate.constitution);
});

test('keeper constitution: lawful accepted no_go has no constitution source', async t => {
  const { f, ref } = await accepted(t, { outcome: 'no_go', route: 'model' });
  await refused(f, f.store, () => readKeeperConstitutionSourceAt(f.store, 'p', ref), 'keeper_constitution_absent');
});

test('keeper constitution: accepted insufficient evidence retains nonempty partial and refuses a synthetic constitution', async t => {
  const { f, ref } = await accepted(t, { outcome: 'insufficient_evidence', route: 'partial' });
  assert.ok(f.final.packet.dossier.materials.length);
  assert.equal(f.final.packet.dossier.manifest.value.completeness, 'partial');
  await refused(f, f.store, () => readKeeperConstitutionSourceAt(f.store, 'p', ref), 'keeper_constitution_absent');
});

test('keeper constitution: one snapshot of caller getters fixes the manifest before asynchronous proof', async t => {
  const { f, ref } = await accepted(t), reads = { id: 0, revision: 0, hash: 0 };
  const external = Object.fromEntries(Object.keys(reads).map(key => [key, null]));
  for (const key of Object.keys(reads) as (keyof Ref)[]) Object.defineProperty(external, key,
    { enumerable: true, get() { reads[key]++; return reads[key] === 1 ? ref[key] : null; } });
  const source = await unchanged(f, f.store, () => readKeeperConstitutionSourceAt(f.store, 'p', external));
  assert.deepEqual(reference(source.manifest), ref); assert.deepEqual(reads, { id: 1, revision: 1, hash: 1 });
});

test('keeper constitution: foreign, structural and substituted containers and lost paid/authority grounds refuse hot and cold without writes', async t => {
  const { f, proven, ref } = await accepted(t), history = all(f.store);
  await refused(f, f.store, () => readKeeperConstitutionSourceAt(f.store, 'other', ref));
  for (const bad of [{ ...ref, revision: 2 }, { ...ref, hash: '0'.repeat(64) }, { ...ref, accepted: true }, proven.manifest.value])
    await refused(f, f.store, () => readKeeperConstitutionSourceAt(f.store, 'p', bad));
  // A structurally canonical manifest is not an accepted source: it names a genuine bundle under alien grounds.
  const value = { ...proven.manifest.value, assessment: f.paidD7 }, id = discoveryManifestId(value);
  // Each fault gets a physical copy of the same genuine accepted world. Unlike an opaque get Proxy, a real Store can
  // reuse shared historical proofs while still revalidating their physical dependencies. No proof/read API is mocked.
  const snapshot = join(f.root, 'accepted-snapshot.sqlite'), db = new DatabaseSync(f.path, { readOnly: true });
  try { db.prepare('VACUUM INTO ?').run(snapshot); } finally { db.close(); }
  let index = 0;
  const copy = () => {
    const path = join(f.root, `fault-${index++}.sqlite`);
    copyFileSync(snapshot, path);
    const store = new Store(path); t.after(() => store.close()); return store;
  };
  const structural = copy(), fake = structural.write({ id, kind: DISCOVERY_MANIFEST_KIND, expected: 0, value });
  await refused(f, structural, () => readKeeperConstitutionSourceAt(structural, 'p', reference(fake)));
  const lost = [ref, reference(proven.bundle), proven.manifest.value.admission.record, f.paidResult,
    f.result.value.response, f.final.result.value.response];
  for (const missing of lost) {
    const store = copy();
    // A real live Store has already proved the paid response before another connection removes it.
    const hot = missing === f.result.value.response;
    if (hot) await unchanged(f, store, () => readKeeperConstitutionSourceAt(store, 'p', ref));
    damage(store.path, fault => {
      fault.prepare('DELETE FROM heads WHERE entity_id=? AND revision=?').run(missing.id, missing.revision);
      fault.prepare('DELETE FROM revisions WHERE entity_id=? AND revision=?').run(missing.id, missing.revision);
    });
    const before = all(store);
    await refused(f, store, () => readKeeperConstitutionSourceAt(store, 'p', ref));
    if (hot) {
      const cold = new Store(store.path); t.after(() => cold.close());
      await refused(f, cold, () => readKeeperConstitutionSourceAt(cold, 'p', ref));
    }
    assert.equal(all(store), before);
  }
  const forged = copy();
  const replaced = { ...proven.bundle.value, bundle: { ...proven.bundle.value.bundle,
    constitution: { goal: 'alien', consumers: ['x'], nonGoals: ['y'], successCriterion: 'z' } } };
  damage(forged.path, fault => { fault.prepare('UPDATE revisions SET body=? WHERE entity_id=? AND revision=?')
    .run(JSON.stringify(replaced), proven.bundle.id, proven.bundle.revision); });
  const corruptHistory = all(forged);
  await refused(f, forged, () => readKeeperConstitutionSourceAt(forged, 'p', ref));
  assert.equal(all(forged), corruptHistory); assert.equal(all(f.store), history);
  assert.equal(f.store.list(DISCOVERY_MANIFEST_KIND).length, 1);
});
