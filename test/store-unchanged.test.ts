import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

/** A small fresh Store with one saved record, and a way to open further Stores and plain SQL connections on the same file. */
function fresh(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-store-unchanged-')), path = join(root, 'state.sqlite');
  const stores: Store[] = [], sql: DatabaseSync[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const external = () => { const db = new DatabaseSync(path); sql.push(db); return db; };
  const store = open();
  store.write({ id: 'probe:a', kind: 'probe', expected: 0, value: { n: 1 } });
  t.after(() => { for (const db of sql) db.close(); for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  let counter = 0;
  const write = (target: Store) => target.write({ id: `probe:new-${counter++}`, kind: 'probe', expected: 0, value: { n: counter } });
  return { store, open, external, write, path };
}
const caught = (message: RegExp) => (error: unknown) => error instanceof assert.AssertionError && message.test(error.message);
const heads = (db: DatabaseSync) => JSON.stringify(db.prepare('SELECT * FROM heads ORDER BY entity_id').all());

test('store unchanged: a read-only action passes, is awaited to its end and returns its value', async t => {
  const { store } = fresh(t);
  const stamp = store.changeStamp();
  assert.deepEqual(await storeUnchanged(store, () => store.get('probe:a')!.value), { n: 1 });
  assert.deepEqual(await storeUnchanged(store, () => ({ listed: store.list('probe').length, history: store.history('probe:a').length })), { listed: 1, history: 1 });
  // An action that settles later is awaited: the stamp is read after it, not at the moment it returns its promise.
  assert.equal(await storeUnchanged(store, async () => { await new Promise(resolve => setTimeout(resolve, 20)); return store.get('probe:a')!.revision; }), 1);
  assert.equal(store.changeStamp(), stamp, 'reads never move the stamp');
  // A write that happens after an await inside the action is inside the window.
  await assert.rejects(storeUnchanged(store, async () => { await new Promise(resolve => setTimeout(resolve, 20)); store.write({ id: 'probe:late', kind: 'probe', expected: 0, value: {} }); }),
    caught(/committed to the product store/));
});

test('store unchanged: own write, writeMany (even an empty one) and a non-empty atomicWrite are caught; an empty atomicWrite and a rolled-back write are not', async t => {
  const { store, write } = fresh(t);
  await assert.rejects(storeUnchanged(store, () => write(store)), caught(/change stamp 1:\d+ -> 2:\d+/));
  await assert.rejects(storeUnchanged(store, () => store.writeMany([{ id: 'probe:many-1', kind: 'probe', expected: 0, value: {} },
    { id: 'probe:many-2', kind: 'probe', expected: 0, value: {} }])), caught(/committed/));
  await assert.rejects(storeUnchanged(store, () => store.atomicWrite(() => ({ value: 1, guards: [],
    writes: [{ id: 'probe:atomic', kind: 'probe', expected: 0, value: {} }] }))), caught(/committed/));
  assert.ok(store.get('probe:atomic') && store.get('probe:many-2'), 'every write above really happened');
  // writeMany([]) commits an empty transaction: the stricter signal is reported, not masked.
  await assert.rejects(storeUnchanged(store, () => store.writeMany([])), caught(/committed/));
  // No commit: the empty batch is a read-only repeat, a failed preparation and a stale expected revision roll back.
  assert.deepEqual(await storeUnchanged(store, () => store.atomicWrite(() => ({ value: 7, guards: [], writes: [] }))), { value: 7, records: [] });
  const failed = await storeRefused(store, () => store.atomicWrite<number>(() => { throw new EngineError('prepare_refused', 'refused while preparing'); }));
  assert.ok(failed instanceof EngineError && failed.code === 'prepare_refused');
  const stale = await storeRefused(store, () => store.writeMany([{ id: 'probe:a', kind: 'probe', expected: 5, value: { n: 9 } }]));
  assert.ok(stale instanceof EngineError && stale.code === 'revision_conflict');
  assert.deepEqual(store.get('probe:a')!.value, { n: 1 }, 'the refused write left the record as it was');
});

test('store unchanged: a commit of another Store is caught on the observing Store, in both directions', async t => {
  const { store, open, write } = fresh(t), other = open();
  await assert.rejects(storeUnchanged(store, () => write(other)), caught(/change stamp 1:(\d+) -> 1:(?!\1\b)\d+/));
  await assert.rejects(storeUnchanged(other, () => write(store)), caught(/committed/));
  // Neither Store reads its own silence as the other's: with both quiet, both windows pass.
  await storeUnchanged(store, () => other.get('probe:a'));
  await storeUnchanged(other, () => store.get('probe:a'));
});

test('store unchanged: external SQL that changes a body without a new revision, or moves a head, is caught', async t => {
  const { store, external } = fresh(t), db = external();
  db.exec('DROP TRIGGER revisions_no_update');
  await assert.rejects(storeUnchanged(store, () => db.exec(`UPDATE revisions SET body='{"n":2}' WHERE entity_id='probe:a' AND revision=1`)), caught(/committed/));
  assert.deepEqual(store.get('probe:a')!.value, { n: 2 }, 'the body really changed under the same revision');
  db.exec(`INSERT INTO revisions(entity_id, revision, kind, body, sha256) VALUES('probe:a', 2, 'probe', '{"n":3}', 'forged')`);
  await assert.rejects(storeUnchanged(store, () => db.exec(`UPDATE heads SET revision=2 WHERE entity_id='probe:a'`)), caught(/committed/));
  assert.equal(store.get('probe:a')!.revision, 2, 'the head really moved without an event');
});

test('store unchanged: two external writes that restore the first value are caught although the content is equal again', async t => {
  const { store, external } = fresh(t), db = external();
  db.exec(`INSERT INTO revisions(entity_id, revision, kind, body, sha256) VALUES('probe:a', 2, 'probe', '{"n":2}', 'second')`);
  const first = heads(db);
  await assert.rejects(storeUnchanged(store, () => { db.exec(`UPDATE heads SET revision=2 WHERE entity_id='probe:a'`); db.exec(`UPDATE heads SET revision=1 WHERE entity_id='probe:a'`); }),
    caught(/committed/));
  assert.equal(heads(db), first, 'the heads are exactly what they were: a content comparison alone would have passed');
});

test('store unchanged: a write followed by an error or a refusal is not hidden, and the error is kept as the cause', async t => {
  const { store, write } = fresh(t), refusal = new EngineError('probe_refusal', 'refused after writing');
  const afterWriting = () => { write(store); throw refusal; };
  const first = await storeUnchanged(store, afterWriting).then(() => assert.fail('must reject'), error => error);
  assert.ok(first instanceof assert.AssertionError && /and then threw/.test(first.message) && first.cause === refusal);
  const second = await storeRefused(store, async () => { await Promise.resolve(); write(store); throw refusal; }).then(() => assert.fail('must reject'), error => error);
  assert.ok(second instanceof assert.AssertionError && /and then threw/.test(second.message) && second.cause === refusal);
  // A refusal that wrote nothing keeps being the refusal: the window returns it and rethrows it.
  const plain = new EngineError('probe_plain', 'refused');
  assert.equal(await storeRefused(store, () => { throw plain; }), plain);
  await assert.rejects(storeUnchanged(store, () => { throw plain; }), error => error === plain);
});

test('store unchanged: storeRefused demands a refusal of the expected kind', async t => {
  const { store } = fresh(t), code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
  await assert.rejects(storeRefused(store, () => store.get('probe:a')), caught(/must refuse/));
  await assert.rejects(storeRefused(store, () => { throw new TypeError('not a product refusal'); }), caught(/unexpected error: not a product refusal/));
  await assert.rejects(storeRefused(store, () => { throw new EngineError('other_code', 'other'); }, code('wanted_code')), caught(/unexpected error: other/));
  await storeRefused(store, () => { throw new EngineError('wanted_code', 'wanted'); }, code('wanted_code'));
  await assert.rejects(storeRefused(store, () => Promise.resolve('resolved')), caught(/must refuse/));
});

test('store unchanged: only the genuine open Store is accepted', async t => {
  const { store, open } = fresh(t), read = () => 1;
  await assert.rejects(storeUnchanged({ changeStamp: () => '0:0' } as unknown as Store, read), caught(/genuine Store/));
  await assert.rejects(storeUnchanged(null as unknown as Store, read), caught(/genuine Store/));
  await assert.rejects(storeUnchanged(new Proxy(store, {}), read), caught(/genuine Store/));
  const replaced = open();
  Object.defineProperty(replaced, 'changeStamp', { value: () => '0:0', configurable: true });
  await assert.rejects(storeUnchanged(replaced, () => replaced.write({ id: 'probe:hidden', kind: 'probe', expected: 0, value: {} })), caught(/genuine changeStamp/));
  delete (replaced as { changeStamp?: unknown }).changeStamp;
  await storeUnchanged(replaced, read);
  // A Store that was closed proves nothing, before or during the action.
  const closing = open();
  await assert.rejects(storeUnchanged(closing, () => closing.close()), error => error instanceof EngineError && error.code === 'store_busy');
  await assert.rejects(storeUnchanged(closing, read), error => error instanceof EngineError && error.code === 'store_busy');
});
