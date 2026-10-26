import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../src/canonical.js';
import { Evidence } from '../src/evidence/evidence.js';
import { reference } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import { packetAnswerSchema } from '../src/om/question-packet.js';
import { BRIEF_VERSION, BriefMemo, boundedBrief, briefMaterial, compactSchema, packetPrompt, type BriefBasis } from '../src/om/packet-brief.js';
import { gardenGraph } from './om-fixture.js';

// WB-SPEED: one continuation's probes share a BriefMemo, so their common response schema is compacted once. Every brief
// built with the memo equals, byte for byte and prompt for prompt, the one built without it.
function world(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-wb-speed-'))), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  new Evidence(store).document('garden', 'reference', 'Кириллица 😀 works-brief source', 'text/plain', 0);
  const context = store.write({ id: 'om-input:garden', kind: 'om-input', expected: 0, value: { known: true } });
  const basis: BriefBasis = { project: 'garden', graph: gardenGraph(), node: 'garden-consume-block',
    gaps: [{ question: 'q-native', target: 'criterion', field: 'checkKind', ref: { id: 'gap:garden:one', revision: 1, hash: '1'.repeat(64) }, evidence: [] }],
    contexts: [reference(context)], accepted: [], input: { requirements: [], criteria: [], contracts: [], questions: [] },
    material: briefMaterial(store, 'garden', root, false), materialBudget: 45000, codes: [] };
  const payload = (requestId: string, data: unknown) => ({ version: BRIEF_VERSION, requestId, task: 'fact', model: 'MC1', purpose: 'model-research',
    questions: [{ id: 'q-native', target: 'criterion', field: 'answer', contract: { establishes: 'Какова форма?', resultForm: { type: 'string' } } }],
    responseForm: { protocol: 'omg-answer/v3', requestId, schema: packetAnswerSchema('fact') }, refusals: [],
    sourceDeliveries: [{ contract: 'test-delivery', data: [{ read: { action: 'read_context', pointer: '/x' }, data }] }] });
  return { basis, payload };
}
const bytes = (packet: Record<string, any>) => canonical(packet) + '\n' + packetPrompt(packet);

test('WB-SPEED: probes of one continuation sharing a memo build exactly the briefs built without it', async t => {
  const f = world(t), memo = new BriefMemo();
  const fits = (packet: Record<string, any>) => packetPrompt(packet).length % 7 !== 3;
  for (const limit of [Number.MAX_SAFE_INTEGER, 60_000, 20_000])
    for (const data of ['a', 'x'.repeat(5000), { nested: ['value', 1, null] }, Array.from({ length: 40 }, (_, i) => `row ${i}`)]) {
      const plain = boundedBrief(f.payload('wb-request', data), f.basis, limit, fits);
      const kept = boundedBrief(f.payload('wb-request', data), f.basis, limit, fits, memo);
      assert.equal(bytes(kept), bytes(plain), `${limit} ${JSON.stringify(data).slice(0, 40)}`);
      assert.equal(bytes(boundedBrief(f.payload('wb-request', data), f.basis, limit, undefined, memo)),
        bytes(boundedBrief(f.payload('wb-request', data), f.basis, limit)));
    }
});

test('WB-SPEED: different response schemas never share a compact form, also beyond the memo bound', async t => {
  const f = world(t), memo = new BriefMemo();
  for (let round = 0; round < 2; round++)
    for (let i = 0; i < 20; i++) {
      const payload = f.payload(`wb-request-${i}`, `delivery ${i}`);
      const kept = boundedBrief(payload, f.basis, 60_000, undefined, memo);
      assert.equal(bytes(kept), bytes(boundedBrief(f.payload(`wb-request-${i}`, `delivery ${i}`), f.basis, 60_000)), `request ${i} round ${round}`);
      assert.ok(packetPrompt(kept).includes(`"requestId":{"const":"wb-request-${i}"}`), 'each brief names its own request');
    }
});

test('WB-SPEED: a brief built with the memo is independent of the next one, key order is part of the key, and a non-canonical schema is compacted directly', async t => {
  const f = world(t), memo = new BriefMemo();
  const first = boundedBrief(f.payload('wb-request', 'one'), f.basis, 60_000, undefined, memo), expected = bytes(first);
  (first as any).brief.labels.push({ mutated: true }); (first as any).brief.text = 'changed';
  const second = boundedBrief(f.payload('wb-request', 'one'), f.basis, 60_000, undefined, memo);
  assert.equal(bytes(second), expected);
  const schema = packetAnswerSchema('fact') as Record<string, any>, before = canonical(schema), sorted = JSON.parse(before);
  // The compact form numbers shared definitions in the schema's own key order: an equal schema in another order is another entry.
  assert.notEqual(canonical(compactSchema(sorted)), canonical(compactSchema(schema)), 'the fixture schema is order-sensitive');
  for (let i = 0; i < 2; i++) {
    assert.equal(canonical(memo.compact(schema) as never), canonical(compactSchema(schema)));
    assert.equal(canonical(memo.compact(sorted) as never), canonical(compactSchema(sorted)));
  }
  assert.equal(canonical(schema), before, 'the memo does not change its input');
  for (const odd of [undefined, 1, 'text', { a: undefined }, { f: () => 1 }]) {
    const direct = (() => { try { return { value: compactSchema(odd) }; } catch (error) { return { error: String(error) }; } })();
    const viaMemo = (() => { try { return { value: memo.compact(odd) }; } catch (error) { return { error: String(error) }; } })();
    assert.deepEqual(viaMemo, direct, String(odd));
  }
});
