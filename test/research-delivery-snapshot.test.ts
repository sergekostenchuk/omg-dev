import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, hashJson } from '../src/canonical.js';
import { planResearchContextDelivery, planResearchDelivery, requireResearchContextDelivery,
  requireResearchDelivery, type AddressedOriginal, type ResearchDelivery } from '../src/discovery/research-delivery.js';

const record = () => ({ id: 'research-context:snapshot', revision: 1, hash: 'a'.repeat(64) });
const wire = (delivery: ResearchDelivery) => JSON.stringify({ action: 'read_context', delivery, suffix: 'complete' });
const key = 'exact-address';

test('delivery snapshot keeps stable wire bytes and the maximal positive prefix', () => {
  const original: AddressedOriginal = { record: record(), pointer: '/body/brief', value: 'А😀\\"'.repeat(300) };
  const max = 640;
  const result = planResearchDelivery(original, key, 2000, 1500, candidate => wire(candidate).length <= max);
  assert.ok(result && result.encoding === 'utf16-string');
  requireResearchDelivery(original, key, result);
  const n = result.served.end;
  assert.ok(n > 0 && n < (original.value as string).length);
  const expected = { contract: 'research-delivery/v1', original: { key, record: original.record,
    pointer: original.pointer, valueHash: hashJson(original.value), page: null },
    requested: { offset: 0, end: (original.value as string).length, total: (original.value as string).length, unit: 'utf16' },
    envelopeLimitChars: 2000, deliveryLimitChars: 1500,
    served: { offset: 0, end: n, total: (original.value as string).length, next: n, unit: 'utf16' },
    encoding: 'utf16-string', value: (original.value as string).slice(0, n) };
  assert.equal(JSON.stringify(result), JSON.stringify(expected));
  const larger = structuredClone(result);
  larger.served.end = n + 1;
  larger.served.next = n + 1;
  larger.value = (original.value as string).slice(0, n + 1);
  assert.ok(wire(result).length <= max && wire(larger).length > max);
  assert.equal(planResearchDelivery(original, key, 2000, 1500, () => false), null);
});

test('delivery snapshot isolates caller and each candidate from fits mutations', () => {
  const original: AddressedOriginal = { record: record(), pointer: '/body/items',
    value: [{ z: 'first', a: 'original' }, { z: 'second', a: 'saved' }],
    page: { offset: 3, end: 5, total: 8, unit: 'items', next: 5 } };
  const saved = structuredClone(original);
  let visits = 0;
  const seen: ResearchDelivery[] = [];
  const result = planResearchDelivery(original, key, 2000, 1500, candidate => {
    visits++;
    assert.equal(candidate.original.record.id, saved.record.id);
    assert.deepEqual(candidate.requested, { offset: 3, end: 5, total: 8, unit: 'items' });
    assert.equal((candidate.value as Array<{ z: string }>)[0]?.z, 'first');
    seen.push(candidate);
    candidate.original.record.id = 'forged-candidate';
    (candidate.original.page as { offset: number }).offset = 999;
    candidate.requested.offset = 999;
    candidate.served.offset = 999;
    (candidate.value as Array<{ z: string }>)[0]!.z = 'forged-candidate';
    original.record.id = 'forged-caller';
    original.pointer = '/forged';
    (original.page as { offset: number }).offset = 999;
    (original.value as Array<{ z: string }>)[0]!.z = 'forged-caller';
    return true;
  });
  assert.ok(result && visits >= 2);
  requireResearchDelivery(saved, key, result);
  assert.notEqual(result, seen[seen.length - 1]);
  assert.deepEqual(result.value, saved.value);
  assert.equal(JSON.stringify(result.value), JSON.stringify(saved.value));
  assert.equal(Object.isFrozen(original), false);
  (seen[0]!.original.page as { offset: number }).offset = -1;
  assert.equal((result.original.page as { offset: number }).offset, 3);
});

test('delivery snapshot reads changing getters once including page-source selection', () => {
  const full = canonical({ z: '😀text'.repeat(40), a: 'prefix' });
  const page = { offset: 9, end: 70, total: full.length, unit: 'utf16', next: 70, encoding: 'canonical-json' as const };
  const saved: AddressedOriginal = { record: record(), pointer: '/body/full', value: full.slice(page.offset, page.end), page };
  const counts = { record: 0, pointer: 0, value: 0, page: 0 };
  const changing: AddressedOriginal = {
    get record() { return ++counts.record === 1 ? saved.record : { ...record(), id: 'foreign' }; },
    get pointer() { return ++counts.pointer === 1 ? saved.pointer : '/other'; },
    get value() { return ++counts.value === 1 ? saved.value : 'foreign'; },
    get page() { return ++counts.page === 1 ? page : { ...page, offset: 0, end: 1, next: 1 }; },
  };
  const result = planResearchContextDelivery(changing, key, 2000, 1500, () => true);
  assert.ok(result);
  assert.deepEqual(counts, { record: 1, pointer: 1, value: 1, page: 1 });
  requireResearchContextDelivery(saved, key, result);
  assert.equal(result.text, saved.value);
  assert.deepEqual(result.served, { offset: 9, end: 70, total: full.length, next: 70, unit: 'utf16' });
});

test('delivery snapshot preserves array fallback and raw middle/last pages', () => {
  const array: AddressedOriginal = { record: record(), pointer: '/body/array',
    value: [{ z: 'large'.repeat(400), a: 'item' }, { z: 'last', a: 'item' }] };
  const max = 650;
  const fallback = planResearchDelivery(array, key, 2000, 1500, candidate => wire(candidate).length <= max);
  assert.ok(fallback && fallback.encoding === 'json-string-fragment' && fallback.text);
  requireResearchDelivery(array, key, fallback);
  assert.equal(fallback.text, canonical(array.value).slice(0, fallback.served.end));
  const larger = structuredClone(fallback);
  larger.served.end++;
  larger.served.next = larger.served.end;
  larger.text = canonical(array.value).slice(0, larger.served.end);
  assert.ok(wire(fallback).length <= max && wire(larger).length > max);

  const fullValue = { z: '😀\\"'.repeat(90), a: 'head' }, full = canonical(fullValue);
  for (const [offset, end] of [[13, 85], [full.length - 37, full.length]] as const) {
    const page = { offset, end, total: full.length, unit: 'utf16', next: end < full.length ? end : null,
      encoding: 'canonical-json' as const };
    const raw: AddressedOriginal = { record: record(), pointer: '/body/full', value: full.slice(offset, end), page };
    const context = planResearchContextDelivery(raw, key, 2000, 1500, () => true);
    assert.ok(context);
    requireResearchContextDelivery(raw, key, context);
    assert.equal(context.text, full.slice(offset, end));
    assert.deepEqual(context.served, { offset, end, total: full.length, next: page.next, unit: 'utf16' });
    const whole: AddressedOriginal = { ...raw, value: fullValue };
    const consolidation = planResearchDelivery(whole, key, 2000, 1500, () => true);
    assert.ok(consolidation);
    requireResearchDelivery(whole, key, consolidation);
    assert.equal(consolidation.text, full.slice(offset, end));
    assert.deepEqual(consolidation.served, context.served);
  }
});
