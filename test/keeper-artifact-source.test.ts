import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, stageId, type StageArtifact, type Ref } from '../src/pipeline/contracts.js';
import { readKeeperArtifactSourceAt } from '../src/product/keeper-artifact-source.js';
import { prepareOmInput, type InputRequest } from '../src/om/input.js';
import { UPSTREAM_STAGES } from '../src/discovery/requirements.js';
import { preparedFeatures } from './product-fixture.js';
import { all, money } from './discovery-v7-dossier-seed.js';
import { storeUnchanged, storeRefused } from './store-unchanged.js';

test('keeper artifact: standard producer/accept yields exact full content and isolated copies after late heads hot/cold', async t => {
  const root = mkdtempSync(join(tmpdir(), 'keeper-artifact-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store); preparedFeatures(engine, 'p');
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(stageId('p', stage))!)])) as InputRequest['stages'];
  assert.equal((await storeUnchanged(store, () => prepareOmInput(store, { project: 'p', stages, expected: 0 }))).ok, true);
  assert.equal((await storeUnchanged(store, () => prepareOmInput(store,
    { project: 'p', stages: { ...stages, discovery: stages.concept }, expected: 0 }))).ok, false);
  const row = store.get<StageArtifact>(stageId('p', 'concept'))!, ref = reference(row);
  const finances = money(store), initial = await storeUnchanged(store, () => readKeeperArtifactSourceAt(store, 'p', ref));
  assert.deepEqual(initial.container, row); assert.deepEqual(initial.address, { container: ref, pointer: '/content' });
  assert.equal(hashJson(initial.container.value), initial.address.container.hash);
  assert.deepEqual(initial.content, row.value.content);
  const original = structuredClone(initial);
  initial.content = null; initial.container.value.content = null; initial.acceptance.grounds.length = 0;
  assert.deepEqual(await storeUnchanged(store, () => readKeeperArtifactSourceAt(store, 'p', ref)), original);
  store.write({ id: row.id, kind: 'stage', expected: row.revision, value: { ...row.value, status: 'draft' } });
  const history = all(store), cold = new Store(store.path); t.after(() => cold.close());
  for (const source of [store, cold]) assert.deepEqual(await storeUnchanged(source, () => readKeeperArtifactSourceAt(source, 'p', ref)), original);
  assert.equal(all(store), history); assert.deepEqual(money(store), finances);
});

test('keeper artifact: one Ref snapshot; flags, narrowing pointer, missing content, fake accepted and foreign stage refuse', async t => {
  const root = mkdtempSync(join(tmpdir(), 'keeper-artifact-invalid-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store); preparedFeatures(engine, 'p');
  const row = store.get<StageArtifact>(stageId('p', 'discovery'))!, ref = reference(row), reads = { id: 0, revision: 0, hash: 0 };
  const input = {};
  for (const key of Object.keys(reads) as (keyof Ref)[]) Object.defineProperty(input, key,
    { enumerable: true, get() { reads[key]++; return reads[key] === 1 ? ref[key] : null; } });
  await storeUnchanged(store, () => readKeeperArtifactSourceAt(store, 'p', input));
  assert.deepEqual(reads, { id: 1, revision: 1, hash: 1 });
  for (const bad of [null, undefined, { ...ref, pointer: '/content/fields' }, { ...ref, accepted: true }, row.value,
    { ...ref, id: stageId('other', 'discovery') }, { ...ref, revision: 1 }, { ...ref, hash: '0'.repeat(64) }])
    await storeRefused(store, () => readKeeperArtifactSourceAt(store, 'p', bad), e => e instanceof EngineError);
  const value = { projectId: 'p', stage: 'concept' as const, status: 'accepted' as const, content: null, inputs: [], proofs: [] };
  const fake = store.write({ id: stageId('p', 'concept'), kind: 'stage', expected: store.get(stageId('p', 'concept'))!.revision, value });
  await storeRefused(store, () => readKeeperArtifactSourceAt(store, 'p', reference(fake)), e => e instanceof EngineError);
});
