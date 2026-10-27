import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import { referenceSites } from '../src/storage/reference-sites.js';
import type { FrameCandidateRecord } from '../src/om/frame-candidate.js';
import { collectBlockSubject } from '../src/om/block-keeper.js';
import { prepareKeeperBlockSource, readKeeperBlockSourceAt, KEEPER_BLOCK_SOURCE_KIND,
  KEEPER_BLOCK_SOURCE_CONTRACT } from '../src/product/keeper-block-source.js';
import { createCrossOmFixture } from './om-fixture.js';
import { all } from './discovery-v7-dossier-seed.js';
import { storeUnchanged } from './store-unchanged.js';

const selected = (store: Store, level: 2 | 3 = 3, block = 'garden-produce-block') => ({ project: 'garden',
  candidate: reference(store.list<FrameCandidateRecord>('frame-candidate').find(row => row.value.level === level)!), block });
const failure = (action: () => unknown, code?: string) => assert.throws(action,
  e => e instanceof EngineError && (!code || e.code === code));

test('block source: real L2/L3 full blocks, works, both-ended boundary and composition versions have saved exact addresses', async t => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' });
  const l2 = prepareKeeperBlockSource(f.store, selected(f.store, 2));
  const l3 = prepareKeeperBlockSource(f.store, selected(f.store));
  const other = prepareKeeperBlockSource(f.store, selected(f.store, 3, 'garden-consume-block'));
  for (const source of [l2, l3, other]) {
    assert.deepEqual(f.store.get(source.container.id, 1), source.container);
    assert.equal(source.address.pointer, '/subject');
    assert.equal(source.address.container.hash, hashJson(source.container.value as unknown as Json));
    assert.equal(source.container.value.contract, KEEPER_BLOCK_SOURCE_CONTRACT);
    assert.deepEqual(source.material, source.container.value.subject);
    assert.notEqual(source.container.id, source.material.subject);
  }
  assert.equal(l2.material.members.length, 2); assert.equal(l2.grounds.frame, null); assert.equal(l2.grounds.works, null);
  assert.equal(l3.material.members.length, 4); assert.ok(l3.grounds.works?.producer && l3.grounds.works.ledger);
  assert.deepEqual(l3.material.boundary.map(row => row.id), ['garden-flow']);
  assert.ok(l3.material.boundary[0]!.bindings.some(binding => binding.consumers.some(end => end.node === 'garden-consume-block')));
  assert.notDeepEqual(l2.address, l3.address); assert.notDeepEqual(l3.address, other.address);
});

test('block source: getter snapshot, repeat/racing Stores, commit cut, late heads and cold recovery are history fixed points', async t => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' }), input = selected(f.store);
  const counts = new Map<string, number>();
  const changing = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value]));
  for (const key of Object.keys(input)) Object.defineProperty(changing, key, { enumerable: true,
    get() { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n === 1 ? input[key as keyof typeof input] : null; } });
  const cold = new Store(f.database); t.after(() => cold.close());
  const original = f.store.get;
  let race = true;
  // Enter the other writer after the optimistic empty-head read, before our atomic proof/publish.
  f.store.get = function (this: Store, ...args: Parameters<Store['get']>) {
    const row = original.apply(this, args);
    if (race && args[0].startsWith('keeper-block-source:') && !row) { race = false; prepareKeeperBlockSource(cold, input); }
    return row;
  } as Store['get'];
  let source;
  try { source = prepareKeeperBlockSource(f.store, changing); } finally { delete (f.store as unknown as { get?: unknown }).get; }
  assert.deepEqual([...counts.values()], [1, 1, 1]);
  assert.equal(f.store.history(source.container.id).length, 1);
  const candidate = f.store.get(input.candidate.id)!;
  f.store.write({ id: candidate.id, kind: candidate.kind, expected: candidate.revision, value: candidate.value as Json });
  const before = all(f.store);
  const expected = structuredClone(source);
  source.material.members.length = 0;
  assert.deepEqual(source.container, expected.container); assert.deepEqual(source.grounds, expected.grounds);
  assert.equal(hashJson(source.container.value as unknown as Json), source.container.hash);
  const changedMaterial = structuredClone(source.material);
  source.grounds.graph.value = null;
  assert.deepEqual(source.container, expected.container); assert.deepEqual(source.material, changedMaterial);
  assert.equal(hashJson(source.container.value as unknown as Json), source.container.hash);
  const changedGrounds = structuredClone(source.grounds);
  source.container.value.subject.boundary.length = 0;
  assert.deepEqual(source.material, changedMaterial); assert.deepEqual(source.grounds, changedGrounds);
  assert.deepEqual(source.address, expected.address);
  source.address.container.hash = '0'.repeat(64);
  assert.equal(source.container.hash, expected.container.hash);
  assert.deepEqual(source.material, changedMaterial); assert.deepEqual(source.grounds, changedGrounds);
  await storeUnchanged(f.store, async () => {
    assert.deepEqual(prepareKeeperBlockSource(f.store, input), expected);
    assert.deepEqual(readKeeperBlockSourceAt(cold, 'garden', expected.address.container), expected);
    assert.deepEqual(prepareKeeperBlockSource(cold, input), expected);
  });
  f.reopen();
  assert.deepEqual(readKeeperBlockSourceAt(f.store, 'garden', expected.address.container), expected);
  assert.deepEqual(all(f.store), before);
});

test('block source: interrupted return after commit recovers its saved exact result without another revision', async t => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' }), input = selected(f.store);
  const atomic = f.store.atomicWrite.bind(f.store);
  f.store.atomicWrite = ((prepare: Parameters<Store['atomicWrite']>[0]) => {
    atomic(prepare); throw new EngineError('test_commit_cut', 'The caller lost the committed return');
  }) as Store['atomicWrite'];
  try { failure(() => prepareKeeperBlockSource(f.store, input), 'test_commit_cut'); }
  finally { delete (f.store as unknown as { atomicWrite?: unknown }).atomicWrite; }
  const saved = f.store.list(KEEPER_BLOCK_SOURCE_KIND); assert.equal(saved.length, 1);
  const before = all(f.store); f.reopen();
  const recovered = prepareKeeperBlockSource(f.store, input);
  assert.deepEqual(recovered.container, saved[0]);
  assert.equal(f.store.history(saved[0]!.id).length, 1); assert.deepEqual(all(f.store), before);
});

test('block source: missing/null/foreign/open Ref and caller inventories refuse without writes', async t => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' }), input = selected(f.store);
  const source = prepareKeeperBlockSource(f.store, input), before = all(f.store);
  for (const bad of [null, {}, { ...input, candidate: null }, { ...input, project: 'foreign' },
    { ...input, members: [] }, { ...input, candidate: { ...input.candidate, proven: true } }, { ...input, block: 'absent' }])
    failure(() => prepareKeeperBlockSource(f.store, bad));
  for (const bad of [null, {}, input.candidate, { ...source.address.container, hash: '0'.repeat(64) },
    { ...source.address.container, revision: 2 }, { ...source.address.container, pointer: '/subject/block' }])
    failure(() => readKeeperBlockSourceAt(f.store, 'garden', bad));
  failure(() => readKeeperBlockSourceAt(f.store, 'foreign', source.address.container));
  assert.deepEqual(all(f.store), before);
});

test('block source: rehashed truncated material, false origin, wrong kind/null and incompatible identity never overwrite', async t => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' });
  for (const [index, damage] of [
    (v: any) => { v.subject.boundary = []; },
    (v: any) => { v.subject.members.pop(); },
    (v: any) => { v.subject.candidate.hash = '0'.repeat(64); },
    (v: any) => { v.subject.grounds.works = null; },
    (v: any) => { v.contract = 'other/v1'; },
    (v: any) => { delete v.subject.grounds; },
    (v: any) => { delete v.candidate; },
    (_v: any) => null,
    (_v: any) => {},
  ].entries()) {
    const input = selected(f.store, 3, index < 2 ? 'garden-produce-block' : 'garden-consume-block');
    // Different real identities are not needed: each corrupt database is isolated from the next one.
    const proof = collectBlockSubject(f.store, input); assert.ok(proof.ok);
    const value: any = { contract: KEEPER_BLOCK_SOURCE_CONTRACT, ...input, subject: structuredClone(proof.value) };
    const replacement = damage(value); const body = replacement === null ? null : value;
    const id = `${KEEPER_BLOCK_SOURCE_KIND}:garden:${hashJson(input as unknown as Json)}`;
    const db = new DatabaseSync(f.database);
    try {
      db.exec('DROP TRIGGER IF EXISTS revisions_no_delete; DROP TRIGGER IF EXISTS events_no_delete');
      db.prepare('DELETE FROM heads WHERE entity_id=?').run(id);
      db.prepare('DELETE FROM events WHERE entity_id=?').run(id);
      db.prepare('DELETE FROM revisions WHERE entity_id=?').run(id);
    } finally { db.close(); }
    f.reopen();
    const row = f.store.write({ id, kind: index === 8 ? 'foreign' : KEEPER_BLOCK_SOURCE_KIND, expected: 0, value: body });
    const before = all(f.store);
    failure(() => readKeeperBlockSourceAt(f.store, 'garden', reference(row)));
    failure(() => prepareKeeperBlockSource(f.store, input));
    assert.deepEqual(all(f.store), before);
  }
});

test('block source: loss of a historical proposal refuses cold even with a valid saved container hash', async t => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' });
  const source = prepareKeeperBlockSource(f.store, selected(f.store)), ground = source.grounds.proposals[0]!;
  const db = new DatabaseSync(f.database);
  try { db.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER revisions_no_delete'); db.prepare('DELETE FROM revisions WHERE entity_id=? AND revision=?').run(ground.id, ground.revision); }
  finally { db.close(); }
  f.reopen(); const before = all(f.store);
  failure(() => readKeeperBlockSourceAt(f.store, 'garden', source.address.container));
  failure(() => prepareKeeperBlockSource(f.store, selected(f.store)));
  assert.deepEqual(all(f.store), before);
});

test('block source: reference semantics keep exactly L2/L3 grounds and ignore Ref-shaped material', async t => {
  const f = await createCrossOmFixture(t, 'garden', { mode: 'executed' });
  for (const level of [2, 3] as const) {
    const source = prepareKeeperBlockSource(f.store, selected(f.store, level)), value: any = structuredClone(source.container.value);
    const expected = [ ['candidate', value.candidate], ['subject.candidate', value.subject.candidate],
      ['subject.grounds.graph', reference(value.subject.grounds.graph)],
      ...value.subject.grounds.proposals.map((row: any, i: number) => [`subject.grounds.proposals[${i}]`, reference(row)]),
      ...(value.subject.grounds.frame ? [['subject.grounds.frame', reference(value.subject.grounds.frame)]] : []),
      ...(value.subject.grounds.works ? [['subject.grounds.works.producer', reference(value.subject.grounds.works.producer)],
        ['subject.grounds.works.ledger', reference(value.subject.grounds.works.ledger)]] : []) ];
    const normalize = (rows: any[]) => rows.map(([field, ref]) => [field, reference(ref)]).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    assert.deepEqual(normalize(referenceSites(KEEPER_BLOCK_SOURCE_KIND, value).map(row => [row.field, row.ref])), normalize(expected));
    value.subject.members[0].payload = value.candidate; value.subject.block.payload = value.candidate;
    value.subject.grounds.graph.value.payload = value.candidate;
    assert.deepEqual(normalize(referenceSites(KEEPER_BLOCK_SOURCE_KIND, value).map(row => [row.field, row.ref])), normalize(expected));
  }
});
