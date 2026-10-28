import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { hideRecord, whileHidden } from './hidden-record.js';

function world(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-hidden-record-')), path = join(root, 'state.sqlite'), store = new Store(path), other = new Store(path);
  t.after(() => { store.close(); other.close(); rmSync(root, { recursive: true, force: true }); });
  store.write({ id: 'fixture:a', kind: 'transport-fixture', expected: 0, value: { projectId: 'p', n: 1 } });
  store.write({ id: 'fixture:a', kind: 'transport-fixture', expected: 1, value: { projectId: 'p', n: 2 } });
  store.write({ id: 'fixture:b', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } });
  return { store, other };
}

test('a hidden record is absent for the named Store only, by the reads asked for, and is back when the action ends', async t => {
  const { store, other } = world(t), get = Store.prototype.get;
  assert.equal(await whileHidden(store, { id: 'fixture:a' }, null, () => [store.get('fixture:a'), store.get('fixture:a', 1), store.get('fixture:a', 2)]).then(row => row.every(item => item === null)), true,
    'exact without a revision: the head and every revision');
  await whileHidden(store, { id: 'fixture:a', revision: 1 }, null, () => {
    assert.equal(store.get('fixture:a'), null); assert.equal(store.get('fixture:a', 1), null);
    assert.equal(store.get<{ n: number }>('fixture:a', 2)!.value.n, 2, 'another revision is read as before');
  });
  await whileHidden(store, { id: 'fixture:a', reads: 'head' }, null, () => {
    assert.equal(store.get('fixture:a'), null); assert.equal(store.get<{ n: number }>('fixture:a', 1)!.value.n, 1);
  });
  await whileHidden(store, { id: 'fixture:a', reads: 'every' }, null, () => assert.equal(store.get('fixture:a', 1), null));
  await whileHidden(store, { id: 'fixture:a' }, null, () => {
    assert.equal(store.get('fixture:b')!.id, 'fixture:b', 'another record is read as before');
    assert.equal(other.get<{ n: number }>('fixture:a')!.value.n, 2, 'another Store on the same file is not affected');
    assert.equal(store.list('transport-fixture').length, 2, 'only get changes: the record is still listed');
    assert.equal(store.history('fixture:a').length, 2);
  });
  const replacement = { ...store.get('fixture:b')!, value: { projectId: 'p', replaced: true } };
  await whileHidden(store, { id: 'fixture:a' }, replacement, () => assert.equal(store.get('fixture:a'), replacement));
  assert.equal(Store.prototype.get, get, 'the reads of the Store are restored');
  assert.equal(store.get<{ n: number }>('fixture:a')!.value.n, 2);
});

test('the reads are restored when the action throws, and hides of two Stores and nested hides end one by one', async t => {
  const { store, other } = world(t), get = Store.prototype.get;
  await assert.rejects(() => whileHidden(store, { id: 'fixture:a' }, null, () => { throw new Error('refused'); }), /refused/);
  assert.equal(Store.prototype.get, get);
  const endOuter = hideRecord(store, { id: 'fixture:a' }), endInner = hideRecord(other, { id: 'fixture:b' });
  assert.equal(store.get('fixture:a'), null); assert.equal(other.get('fixture:b'), null); assert.ok(store.get('fixture:b'));
  endOuter();
  assert.ok(store.get('fixture:a')); assert.equal(other.get('fixture:b'), null, 'the other hide is still on');
  assert.notEqual(Store.prototype.get, get);
  endInner();
  assert.equal(Store.prototype.get, get); assert.ok(other.get('fixture:b'));
  const late = await Promise.all([whileHidden(store, { id: 'fixture:a' }, null, async () => { await Promise.resolve(); return store.get('fixture:a'); }),
    whileHidden(other, { id: 'fixture:b' }, null, async () => { await Promise.resolve(); return other.get('fixture:b'); })]);
  assert.deepEqual(late, [null, null]);
  assert.equal(Store.prototype.get, get);
});
