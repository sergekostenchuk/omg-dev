import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import type { Revision } from '../src/storage/store.js';
import type { Question } from '../src/discovery/discovery.js';
import { reference } from '../src/pipeline/contracts.js';
import { addContextLookup, contextLookupKey, contextProgress, contextWorkspace,
  packContextWorkspace, recordContextPacket, requireCompleteContextPacket,
  requireContextDelivery, type ContextLookup } from '../src/discovery/context-workspace.js';
import { addressArchivedMaterials, buildResearchResultCapacity, measureResearchResult, packAddressedValue,
  planResearchDelivery, requireResearchResultCapacity, requirePacketMaterialDelivery,
  requireResearchDelivery, serveArchivedMaterial } from '../src/discovery/research-delivery.js';
import { contextPage, contextValue, workingContext } from '../src/discovery/working-context.js';
import { addressedWorkspace } from '../src/discovery/research-continuation.js';
import { projectResearchContextRead, researchAction } from '../src/discovery/research-consumer-transition.js';
import { canonical, hashJson } from '../src/canonical.js';
import { requirePlanningNavigation } from '../src/discovery/planning-context.js';

const lookup = (value: unknown): ContextLookup => ({
  record: { id: 'research-context:delivery', revision: 1, hash: 'a'.repeat(64) },
  pointer: '/body/history', value,
});

test('RD2b stores a bounded positive part of one oversized original, with exact next and no full copy', () => {
  const original = lookup('z'.repeat(12_000));
  const packet: Record<string, any> = { contextWorkspace: [original] };
  packContextWorkspace(packet, 4_000, 3_000);
  assert.deepEqual(packet.contextWorkspace, []);
  assert.equal(packet.contextIndex.length, 1);
  assert.equal(packet.contextIndex[0].key, contextLookupKey(original));
  assert.equal(packet.contextDelivery.length, 1);
  const delivery = packet.contextDelivery[0];
  assert.equal(delivery.contract, 'research-delivery/v1');
  assert.equal(delivery.encoding, 'utf16-string');
  assert.equal(delivery.requested.total, 12_000);
  assert.ok(delivery.served.end > 0 && delivery.served.end < 12_000);
  assert.equal(delivery.served.next, delivery.served.end);
  assert.equal(delivery.value, (original.value as string).slice(0, delivery.served.end));
  assert.ok(JSON.stringify(packet).length < 4_000);
  requireContextDelivery([original], packet);
  const forged = structuredClone(packet);
  forged.contextDelivery[0].value = 'forged';
  assert.throws(() => requireContextDelivery([original], forged), { code: 'research_context_undelivered' });
});

test('RD2b planning pages its own large requirements index from the pinned source', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-planning-delivery-'));
  const store = new Store(join(root, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const draft = store.write({ id: 'discovery:p:planning-delivery', kind: 'discovery-draft', expected: 0,
    value: { projectId: 'p', stage: 'discovery', level: 'R1', consumer: 'research', inputs: [],
      fields: {}, questions: ['question:p:planning-delivery'] } });
  const question = store.write({ id: 'question:p:planning-delivery', kind: 'question', expected: 0,
    value: { projectId: 'p', draftId: draft.id, status: 'open', spec: { field: 'preparation',
      prompt: 'Choose grounded reads', risk: 'Missing context', kind: 'design', schema: { type: 'object' } } } });
  const requirements = [{ requirements: Array.from({ length: 100 }, (_, index) => ({
    id: `r${index}`, statement: 'x'.repeat(1_000), outcome: 'o', beneficiary: 'a' })) }];
  const body = { role: 'research', question: { id: question.id }, dispatchMode: 'planning', repositoryRoot: root,
    core: { objective: 'O', problem: 'P', actors: [], constraints: [], specificationConstraints: [],
      concept: {}, requirements }, map: { ref: reference(draft), nodes: [] },
    inventory: { sources: [], files: [], filesTruncated: false }, catalogue: [], readings: [],
    directReadings: [], answers: [], readPlanStatus: [], contextWorkspace: [] };
  const packet = workingContext(store, 'p', draft.id, question.id, body, 50_000) as Record<string, any>;
  assert.ok(JSON.stringify(packet).length <= 50_000);
  assert.equal(Object.hasOwn(packet, 'requirements'), false);
  const address = packet.working.navigationAddresses.find((entry: any) => entry.field === 'requirements');
  assert.equal(address.pointer, '/body/core/requirements');
  assert.equal(address.sourceHash, hashJson(requirements));
  assert.equal(packet.materialDelivery.length, 1);
  assert.equal(packet.materialDelivery[0].original.pointer, address.pointer);
  const saved = store.get<any>(packet.working.archive.id, packet.working.archive.revision)!;
  requirePlanningNavigation(packet, packet.working.archive, saved.value.body);
  requirePacketMaterialDelivery(packet, packet.working.archive, (_record, pointer) => {
    assert.equal(pointer, address.pointer);
    return saved.value.body.core.requirements;
  });
  const fragment = packet.materialDelivery[0];
  assert.ok(fragment.served.end > 0 && fragment.served.next !== null);
  const changed = structuredClone(packet);
  changed.materialDelivery[0].original.valueHash = '0'.repeat(64);
  assert.throws(() => requirePacketMaterialDelivery(changed, packet.working.archive,
    () => requirements), { code: 'research_context_undelivered' });
  const forgedIndex = structuredClone(packet);
  forgedIndex.working.navigationAddresses[0].sourceHash = '0'.repeat(64);
  assert.throws(() => requirePlanningNavigation(forgedIndex, packet.working.archive,
    saved.value.body), { code: 'research_context_undelivered' });
  (body as Record<string, any>).discoveryContext = { accepted: 'd'.repeat(60_000) };
  const combined = workingContext(store, 'p', draft.id, question.id, body, 50_000) as Record<string, any>;
  assert.ok(JSON.stringify(combined).length <= 50_000);
  assert.equal(combined.materialDelivery[0].original.pointer, '/body/core/requirements');
  assert.ok(combined.working.materialAddresses.some((entry: any) => entry.field === 'discoveryContext'));
  const recorded = recordContextPacket(contextWorkspace(), combined);
  assert.ok(!recorded.deliveryCoverage?.some(entry => entry.pointer === '/body/core/requirements'),
    'An index page must not create a new obligation to read the whole source');
});

test('RD2b addresses every growing planner collection, including saved planned-child status', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-planning-collections-'));
  const store = new Store(join(root, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const draft = store.write({ id: 'discovery:p:planning-collections', kind: 'discovery-draft', expected: 0,
    value: { projectId: 'p', stage: 'discovery', level: 'R1', consumer: 'research', inputs: [],
      fields: {}, questions: ['question:p:planning-collections'] } });
  const question = store.write({ id: 'question:p:planning-collections', kind: 'question', expected: 0,
    value: { projectId: 'p', draftId: draft.id, status: 'open', spec: { field: 'preparation',
      prompt: 'Choose grounded reads', risk: 'Missing context', kind: 'design', schema: { type: 'object' } } } });
  const many = Array.from({ length: 100 }, (_, index) => `${index}:` + 'P'.repeat(1_000));
  const fields: Array<{ field: string; pointer: string; put: (body: any) => void;
    common?: boolean }> = [
    { field: 'readPlanStatus', pointer: '/body/readPlanStatus', put: body => { body.readPlanStatus = many.map((purpose, index) => ({
      ref: { id: `research-turn:planned:${index}`, revision: 1, hash: 'a'.repeat(64) },
      action: { action: 'read_bundle', purpose, inputs: [{ path: 'README.md', media: 'text/plain' }] },
      status: 'completed', error: null, current: true })); } },
    { field: 'answers', pointer: '/body/answers', put: body => { body.answers = many; } },
    { field: 'missing', pointer: '/body/researchMissing', put: body => { body.researchMissing = many; } },
    { field: 'corrections', pointer: '/body/history', put: body => { body.history = many.map((purpose, number) => ({
      number, action: { action: 'read_bundle', purpose }, error: 'reader_failed', feedback: 'Retry exact source' })); } },
    { field: 'corrections', pointer: '/body/history', common: true, put: body => { body.history = Array.from({ length: 1_000 }, (_, number) => ({
      number, action: { action: 'read_bundle', purpose: `correction-${number}` },
      error: 'reader_failed', feedback: 'Retry exact source' })); } },
    { field: 'openGaps', pointer: '/body/openGaps', put: body => { body.openGaps = many; } },
    { field: 'failures', pointer: '/body/failures', put: body => { body.failures = many; } },
    { field: 'files', pointer: '/body/inventory/files', put: body => { body.inventory.files = many; } },
    { field: 'mapStatusFindings', pointer: '/body/mapStatusFindings', put: body => { body.mapStatusFindings = many; } },
    { field: 'actors', pointer: '/body/core/actors', put: body => { body.core.actors = many; } },
    { field: 'constraints', pointer: '/body/core/constraints', put: body => { body.core.constraints = many; } },
    { field: 'specificationConstraints', pointer: '/body/core/specificationConstraints', put: body => {
      body.core.specificationConstraints = many; } },
    { field: 'concept', pointer: '/body/core/concept', put: body => { body.core.concept = { notes: many }; } },
    { field: 'researchScope', pointer: '/body/researchScope', put: body => { body.researchScope = {
      ref: reference(draft), outcome: 'accepted', nodes: [], boundaries: [], expansions: [],
      uiRequired: false, changedPaths: [], obligations: many.map((wake, index) => ({
        gap: { id: `gap:${index}`, target: 'R2', field: 'preparation', consumer: 'research' },
        state: 'deferred', wake })) }; } },
  ];
  for (const { field, pointer, put, common } of fields) {
    const body: any = { role: 'research', question: { id: question.id }, dispatchMode: 'planning',
      repositoryRoot: root, core: { objective: 'O', problem: 'P', actors: [], constraints: [],
        specificationConstraints: [], concept: {}, requirements: [] },
      map: { ref: reference(draft), nodes: [] }, inventory: { sources: [], files: [], filesTruncated: false },
      catalogue: [], readings: [], directReadings: [], answers: [], readPlanStatus: [], contextWorkspace: [] };
    put(body);
    const packet = workingContext(store, 'p', draft.id, question.id, body, 50_000,
      common ? { common: true } : {}) as Record<string, any>;
    assert.ok(JSON.stringify(packet).length <= 50_000, field);
    assert.ok(!Object.hasOwn(packet, field), `${field} must not remain inline`);
    const address = packet.working.navigationAddresses.find((item: any) => item.field === field);
    assert.equal(address?.pointer, pointer, field);
    const archive = store.get<any>(packet.working.archive.id, packet.working.archive.revision)!;
    requirePlanningNavigation(packet, packet.working.archive, archive.value.body);
    assert.equal(packet.materialDelivery[0].original.pointer, pointer, field);
    const forged = structuredClone(packet);
    forged.working.navigationAddresses[0].sourceHash = '0'.repeat(64);
    assert.throws(() => requirePlanningNavigation(forged, packet.working.archive, archive.value.body),
      { code: 'research_context_undelivered' }, field);
  }
  const researchBody: any = { role: 'research', repositoryRoot: root,
    inventory: { sources: [], files: many, filesTruncated: false }, contextWorkspace: [] };
  const initial = workingContext(store, 'p', draft.id, question.id, researchBody, 50_000) as Record<string, any>;
  assert.ok(JSON.stringify(initial).length <= 50_000);
  assert.ok(!Object.hasOwn(initial, 'sourceCatalogue'));
  const catalogue = initial.working.materialAddresses.find((item: any) => item.field === 'sourceCatalogue');
  assert.equal(catalogue?.pointer, '/body/sourceCatalogue');
  requirePacketMaterialDelivery(initial, initial.working.archive, (record, pointer) => {
    const saved = store.get<any>(record.id, record.revision)!;
    return saved.value.body[pointer.slice('/body/'.length)];
  });
});

test('RD2b pages a structured source catalogue together with its growing file index', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-planning-source-catalogue-'));
  const store = new Store(join(root, 'db.sqlite'));
  let cold: Store | undefined;
  t.after(() => { cold?.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const draft = store.write({ id: 'discovery:p:planning-sources', kind: 'discovery-draft', expected: 0,
    value: { projectId: 'p', stage: 'discovery', level: 'R1', consumer: 'research', inputs: [],
      fields: {}, questions: ['question:p:planning-sources'] } });
  const question = store.write({ id: 'question:p:planning-sources', kind: 'question', expected: 0,
    value: { projectId: 'p', draftId: draft.id, status: 'open', spec: { field: 'preparation',
      prompt: 'Read exact sources', risk: 'Missing source', kind: 'design', schema: { type: 'object' } } } });
  const files = Array.from({ length: 100 }, (_, index) => `file-${index}-` + 'x'.repeat(1_000));
  const inventory = { files, filesTruncated: false, sources: [{
    ref: reference(draft), location: join(root, 'source.md'), kind: 'file', media: 'text/markdown', length: 100,
    structureHash: 'a'.repeat(64), toc: { contract: 'source-toc/v1', sections: [
      { heading: 'Overview', start: 0, end: 100 }] },
  }] };
  const body = { role: 'research', dispatchMode: 'planning', repositoryRoot: root,
    core: { objective: 'O', problem: 'P', actors: [], constraints: [], specificationConstraints: [],
      concept: {}, requirements: [] }, map: { ref: reference(draft), nodes: [] }, inventory,
    catalogue: [], readings: [], directReadings: [], answers: [], readPlanStatus: [], contextWorkspace: [] };
  const packet = workingContext(store, 'p', draft.id, question.id, body, 50_000) as Record<string, any>;
  assert.ok(JSON.stringify(packet).length <= 50_000);
  assert.equal(Object.hasOwn(packet, 'sourceCatalogue'), false);
  const address = packet.working.navigationAddresses.find((item: any) => item.field === 'sourceCatalogue');
  assert.equal(address?.pointer, '/body/inventory');
  assert.equal(address.sourceHash, hashJson(inventory));
  const saved = store.get<any>(packet.working.archive.id, packet.working.archive.revision)!;
  requirePlanningNavigation(packet, packet.working.archive, saved.value.body);
  assert.ok(packet.materialDelivery[0].served.end > 0);
  const forged = structuredClone(packet);
  forged.working.navigationAddresses.find((item: any) => item.field === 'sourceCatalogue').sourceHash = '0'.repeat(64);
  assert.throws(() => requirePlanningNavigation(forged, packet.working.archive, saved.value.body),
    { code: 'research_context_undelivered' });

  const small = { ...body, dispatchMode: 'research', inventory: { ...inventory, files: [] } };
  const previous = workingContext(store, 'p', draft.id, question.id, small, 50_000,
    { common: true }) as Record<string, any>;
  const dbPath = join(root, 'db.sqlite');
  cold = new Store(dbPath);
  const resolve = (record: any, pointer: string) => {
    const saved = cold.get<any>(record.id, record.revision)!;
    assert.equal(saved.hash, record.hash);
    return contextValue(saved.value, pointer);
  };
  const large = { ...small, inventory };
  for (const options of [{ common: true }, { common: true, continuation: true,
    previous: previous.working.archive }]) {
    const delivered = workingContext(cold, 'p', draft.id, question.id, large, 50_000,
      options) as Record<string, any>;
    assert.ok(JSON.stringify(delivered).length <= 50_000);
    assert.ok(!Object.hasOwn(delivered, 'sourceCatalogue'));
    const original = delivered.working.materialAddresses.find((item: any) => item.field === 'sourceCatalogue');
    assert.equal(original?.pointer, '/body/sourceCatalogue');
    assert.ok(delivered.materialDelivery?.[0]?.served.end > 0);
    assert.equal(original.valueHash, hashJson(resolve(delivered.working.archive, original.pointer)));
    requirePacketMaterialDelivery(delivered, delivered.working.archive, resolve);
    const changed = structuredClone(delivered);
    changed.working.materialAddresses.find((item: any) => item.field === 'sourceCatalogue').valueHash = '0'.repeat(64);
    assert.throws(() => requirePacketMaterialDelivery(changed, delivered.working.archive, resolve),
      { code: 'research_context_undelivered' });
  }

  const history = Array.from({ length: 1_000 }, (_, number) => ({ number, action: 'read_bundle',
    error: 'reader_failed', assessment: null, feedback: { message: 'Retry exact source', code: 'reader_response_invalid' } }));
  const plain = { ...body, inventory: { sources: [], files: [], filesTruncated: false }, history: [] as typeof history };
  const priorPlan = workingContext(store, 'p', draft.id, question.id, plain, 50_000,
    { common: true }) as Record<string, any>;
  const correctionPacket = workingContext(cold, 'p', draft.id, question.id,
    { ...plain, history }, 50_000,
    { common: true, continuation: true, previous: priorPlan.working.archive }) as Record<string, any>;
  assert.ok(JSON.stringify(correctionPacket).length <= 50_000);
  assert.ok(!Object.hasOwn(correctionPacket, 'corrections'));
  const correctionAddress = correctionPacket.working.materialAddresses.find((item: any) => item.field === 'corrections');
  assert.equal(correctionAddress?.pointer, '/body/corrections');
  assert.ok(correctionPacket.materialDelivery?.[0]?.served.end > 0);
  const corrections = resolve(correctionPacket.working.archive, correctionAddress.pointer) as any[];
  assert.equal(corrections.length, 1_000);
  assert.deepEqual(resolve(corrections[0].original.record, corrections[0].original.pointer), history[0]);
  requirePacketMaterialDelivery(correctionPacket, correctionPacket.working.archive, resolve);
});

test('RD2b splits a single overlarge array item as an encoded JSON fragment, not a complete object', () => {
  const original = lookup([{ body: 'x'.repeat(20_000) }]);
  const delivery = planResearchDelivery(original, contextLookupKey(original), 4_000, 3_000,
    item => JSON.stringify({ contextDelivery: [item] }).length < 3_000);
  assert.ok(delivery);
  assert.equal(delivery.encoding, 'json-string-fragment');
  assert.equal(delivery.requested.unit, 'utf16');
  assert.ok(delivery.served.end > 0 && delivery.served.end < delivery.served.total);
  assert.equal(typeof delivery.text, 'string');
  assert.equal(Object.hasOwn(delivery, 'value'), false);
  requireResearchDelivery(original, contextLookupKey(original), delivery);
  const masquerade = { ...delivery, original: { ...delivery.original, key: 'foreign' } };
  assert.throws(() => requireResearchDelivery(original, contextLookupKey(original), masquerade),
    { code: 'research_context_undelivered' });
});

test('RD2b continues a too-large array item at its child pointer, never at the parent array offset', () => {
  const original = lookup([{ body: 'w'.repeat(16_000) }]);
  const packet: Record<string, any> = { contextWorkspace: [original],
    working: { archive: original.record } };
  packContextWorkspace(packet, 4_000, 3_000);
  const first = packet.contextDelivery[0];
  assert.equal(first.original.pointer, '/body/history/0');
  requireContextDelivery([original], packet);
  const next = first.served.next as number;
  const result = projectResearchContextRead({ body: { history: original.value } },
    original.record, first.original.pointer, { offset: next, limit: 1_000, encoding: 'canonical-json' }, 4_000);
  assert.equal(result.page?.offset, next);
  assert.equal(result.value, canonical((original.value as unknown[])[0]).slice(next, next + 1_000));
});

test('RD2b keeps a complete small lookup in the old full-value slot', () => {
  const original = lookup([{ result: 'small' }]);
  const packet: Record<string, any> = { contextWorkspace: [original] };
  packContextWorkspace(packet, 6_000, 5_000);
  assert.deepEqual(packet.contextWorkspace, [original]);
  assert.equal(packet.contextDelivery, undefined);
  requireContextDelivery([original], packet);
});

test('RD2b retrieves the next UTF-16 segment of a saved object JSON fragment with an exact read proof', () => {
  const value = { part: ['first', { body: 'y'.repeat(18_000) }], last: 'end' };
  const original = lookup(value);
  const first = planResearchDelivery(original, contextLookupKey(original), 4_000, 3_000,
    item => JSON.stringify({ contextDelivery: [item] }).length < 3_000);
  assert.ok(first && first.encoding === 'json-string-fragment' && first.served.next);
  const action = researchAction({ action: 'read_context', record: original.record, pointer: original.pointer,
    page: { offset: first.served.next, limit: 2_000, encoding: 'canonical-json' } });
  assert.equal(action.action, 'read_context');
  const saved = { body: { history: value } };
  const live = projectResearchContextRead(saved, original.record, original.pointer,
    { offset: first.served.next, limit: 2_000, encoding: 'canonical-json' }, 4_000);
  const expected = canonical(value);
  assert.equal(live.value, expected.slice(first.served.next, first.served.next + 2_000));
  assert.equal(live.page?.encoding, 'canonical-json');
  assert.equal(live.page?.next, first.served.next + 2_000);
  assert.deepEqual({ value: live.value, page: live.page }, contextPage(value,
    { offset: first.served.next, limit: 2_000, encoding: 'canonical-json' }));
  assert.throws(() => contextPage(value, { offset: expected.length + 1, limit: 1, encoding: 'canonical-json' }),
    { code: 'context_page_invalid' });
});

test('RD2b derives an omitted material fragment from its pinned archive, not a copied label', () => {
  const record = lookup(null).record;
  const value = { result: 'z'.repeat(12_000) };
  const packet: Record<string, any> = { conclusions: value,
    working: { archive: record, instruction: 'Original is saved', omitted: [] } };
  packAddressedValue(packet, 'conclusions', { record, pointer: '/body/history/0/action', value }, 4_000);
  assert.equal(Object.hasOwn(packet, 'conclusions'), false);
  requirePacketMaterialDelivery(packet, record, (_record, pointer) => {
    assert.equal(pointer, '/body/history/0/action');
    return value;
  });
  const forged = structuredClone(packet);
  forged.materialDelivery[0].original.pointer = '/body/history/1/action';
  assert.throws(() => requirePacketMaterialDelivery(forged, record, () => value),
    { code: 'research_context_undelivered' });
  assert.throws(() => requirePacketMaterialDelivery(packet, record, () => ({result: 'other'})),
    { code: 'research_context_undelivered' });
});

test('RD2b retains one exact material identity across changing packet archives and completes its pages', () => {
  const saved = lookup(null).record;
  const firstArchive = { ...saved, id: 'research-context:first-packet' };
  const nextArchive = { ...saved, id: 'research-context:next-packet' };
  const value = { accepted: 'A'.repeat(12_000) };
  const packet: Record<string, any> = { fields: value, contextWorkspace: [], contextIndex: [],
    working: { archive: firstArchive, deliveryContract: 'research-delivery/v1', instruction: 'Read exact pages' } };
  const originals = addressArchivedMaterials(packet, firstArchive, ['fields'], 10_000, () => saved);
  assert.equal(originals.length, 1);
  serveArchivedMaterial(packet, originals, 10_000);
  requirePacketMaterialDelivery(packet, firstArchive, (record, pointer) => {
    assert.ok([saved.id, firstArchive.id].includes(record.id));
    assert.equal(pointer, '/body/fields');
    return value;
  });
  assert.throws(() => requirePacketMaterialDelivery(packet, firstArchive,
    record => record.id === saved.id ? { accepted: 'unrelated' } : value),
  { code: 'research_context_undelivered' });
  const first = packet.materialDelivery[0];
  assert.ok(first.served.end > 0 && first.served.next);
  const partial = recordContextPacket(contextWorkspace(), packet);
  assert.throws(() => requireCompleteContextPacket(partial, packet),
    { code: 'research_context_incomplete' });
  const remainder = { record: saved, pointer: '/body/fields',
    ...contextPage(value, { offset: first.served.end, limit: 12_000, encoding: 'canonical-json' }) };
  const continued = addContextLookup(partial, remainder, []);
  const second: Record<string, any> = { fields: value, contextWorkspace: [remainder],
    working: { archive: nextArchive, deliveryContract: 'research-delivery/v1', instruction: 'Read exact pages' } };
  addressArchivedMaterials(second, nextArchive, ['fields'], 10_000, () => saved);
  packContextWorkspace(second, 10_000, 9_000);
  requirePacketMaterialDelivery(second, nextArchive, (record, pointer) => {
    assert.ok([saved.id, nextArchive.id].includes(record.id));
    assert.equal(pointer, '/body/fields');
    return value;
  });
  const coverage = recordContextPacket(continued, second).deliveryCoverage!;
  assert.equal(coverage.filter(item => item.pointer === '/body/fields').length, 1);
  assert.deepEqual(coverage[0]!.ranges, [{ offset: 0, end: canonical(value).length }]);
  requireCompleteContextPacket(continued, second);
});

test('RD2b keeps full mandatory material separate from a narrow lookup at the same address', () => {
  const saved = lookup(null).record;
  const firstArchive = { ...saved, id: 'research-context:mandatory-first' };
  const secondArchive = { ...saved, id: 'research-context:mandatory-second' };
  const value = { accepted: 'A'.repeat(12_000) };
  const first: Record<string, any> = { fields: value, contextWorkspace: [], contextIndex: [],
    working: { archive: firstArchive, deliveryContract: 'research-delivery/v1', instruction: 'Exact pages' } };
  serveArchivedMaterial(first,
    addressArchivedMaterials(first, firstArchive, ['fields'], 10_000, () => saved), 10_000);
  const prefix = first.materialDelivery[0].served.end;
  const partial = recordContextPacket(contextWorkspace(), first);
  assert.equal(partial.deliveryCoverage?.[0]?.materialRequired, true);
  const oneCharacter = { record: saved, pointer: '/body/fields',
    ...contextPage(value, { offset: prefix, limit: 1, encoding: 'canonical-json' }) };
  const state = addContextLookup(contextWorkspace(structuredClone(partial)), oneCharacter, []);
  const second: Record<string, any> = { fields: value, contextWorkspace: [oneCharacter],
    working: { archive: secondArchive, deliveryContract: 'research-delivery/v1', instruction: 'Exact pages' } };
  addressArchivedMaterials(second, secondArchive, ['fields'], 10_000, () => saved);
  packContextWorkspace(second, 10_000, 9_000);
  requirePacketMaterialDelivery(second, secondArchive, () => value);
  const recorded = recordContextPacket(state, second);
  assert.equal(recorded.deliveryCoverage?.[0]?.materialRequired, true);
  assert.throws(() => requireCompleteContextPacket(state, second),
    (error: any) => error.code === 'research_context_incomplete'
      && error.details.next > prefix && error.details.next < canonical(value).length);
  const lookupOnly = addContextLookup(contextWorkspace(), oneCharacter, []);
  const lookupPacket: Record<string, any> = { contextWorkspace: [oneCharacter],
    working: { archive: secondArchive, deliveryContract: 'research-delivery/v1' } };
  packContextWorkspace(lookupPacket, 10_000, 9_000);
  requireCompleteContextPacket(lookupOnly, lookupPacket);
});

test('RD2b counts only actually delivered context ranges before a final verdict', () => {
  const original = lookup('x'.repeat(9_000));
  const state = addContextLookup(contextWorkspace(), original);
  const first: Record<string, any> = { contextWorkspace: [original],
    working: { archive: original.record, deliveryContract: 'research-delivery/v1' } };
  packContextWorkspace(first, 4_000, 3_000);
  const afterFirst = recordContextPacket(state, first);
  assert.throws(() => requireCompleteContextPacket(state, first), { code: 'research_context_incomplete' });
  assert.deepEqual(contextProgress(state, first).checkpointedKeys, []);
  let current = afterFirst;
  let previousPacket = first;
  let offset: number | null = first.contextDelivery[0].served.next as number;
  while (offset !== null) {
    const page = contextPage(original.value, { offset, limit: 2_000 });
    const requested: ContextLookup = { ...original, ...page };
    current = addContextLookup(current, requested, [], undefined, previousPacket);
    const packet: Record<string, any> = { contextWorkspace: current.entries.map(entry => entry.result),
      working: { archive: original.record, deliveryContract: 'research-delivery/v1' } };
    packContextWorkspace(packet, 4_000, 3_000);
    current = recordContextPacket(current, packet);
    previousPacket = packet;
    offset = packet.contextDelivery?.[0]?.served.next ?? page.page!.next;
    if (offset !== null) assert.throws(() => requireCompleteContextPacket(current, packet),
      { code: 'research_context_incomplete' });
  }
  requireCompleteContextPacket(current, previousPacket);
  assert.equal(contextProgress(current, previousPacket).checkpointedKeys?.length, current.entries.length);
});

test('RD2b records a delivered empty value and an exact end page as present', () => {
  for (const value of ['', [], 'A']) {
    const result = lookup(value);
    const state = addContextLookup(contextWorkspace(), result, []);
    const packet: Record<string, any> = { contextWorkspace: [result],
      working: { archive: result.record, deliveryContract: 'research-delivery/v1' } };
    packContextWorkspace(packet, 4_000, 3_000);
    const recorded = recordContextPacket(state, packet);
    assert.deepEqual(recorded.deliveryCoverage?.[0]?.ranges,
      [{ offset: 0, end: Array.isArray(value) || typeof value === 'string' ? value.length : 0 }]);
    requireCompleteContextPacket(state, packet);
    contextWorkspace(recorded);
  }
  const end = { ...lookup([]), page: { offset: 3, end: 3, total: 3, unit: 'items', next: null } };
  const state = addContextLookup(contextWorkspace(), end, []);
  const packet: Record<string, any> = { contextWorkspace: [end],
    working: { archive: end.record, deliveryContract: 'research-delivery/v1' } };
  packContextWorkspace(packet, 4_000, 3_000);
  requireCompleteContextPacket(state, packet);
});

test('RD2b requires only the selected array page, while retaining the parent total', () => {
  const result = { ...lookup(['requested']),
    page: { offset: 1, end: 2, total: 3, unit: 'items', next: 2 } };
  const state = addContextLookup(contextWorkspace(), result, []);
  const packet: Record<string, any> = { contextWorkspace: [result],
    working: { archive: result.record, deliveryContract: 'research-delivery/v1' } };
  packContextWorkspace(packet, 4_000, 3_000);
  const delivered = recordContextPacket(state, packet);
  assert.equal(delivered.deliveryCoverage?.[0]?.total, 3);
  assert.deepEqual(delivered.deliveryCoverage?.[0]?.ranges, [{ offset: 1, end: 2 }]);
  requireCompleteContextPacket(state, packet);
  assert.deepEqual(contextProgress(state, packet).checkpointedKeys,
    [contextLookupKey(result)]);
  const missing: Record<string, any> = { ...packet, contextWorkspace: [] };
  assert.throws(() => requireCompleteContextPacket(state, missing),
    { code: 'research_context_undelivered' });
});

test('RD2b historical A fold counts full paid pages before the question head changes', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-rd2b-paid-pages-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(() => store.close());
  const draft = store.write({ id: 'draft:paid-pages', kind: 'discovery-draft', expected: 0,
    value: { projectId: 'p', inputs: [], questions: ['question:paid-pages'] } });
  const question = store.write({ id: 'question:paid-pages', kind: 'question', expected: 0,
    value: { projectId: 'p', draftId: draft.id, status: 'open', spec: { field: 'researchPlan' } } }) as unknown as Revision<Question>;
  const archive = store.write({ id: 'research-context:paid-pages', kind: 'research-context', expected: 0,
    value: { projectId: 'p', draft: reference(draft), question: reference(question),
      body: { blob: 'ABCD' } } });
  const pages = [0, 2].map(offset => projectResearchContextRead(archive.value,
    reference(archive), '/body/blob', { offset, limit: 2 }, 10_000));
  const packet = (delivered: ContextLookup[]) => {
    const subject: Record<string, any> = { contextWorkspace: delivered,
      working: { archive: reference(archive), deliveryContract: 'research-delivery/v1' } };
    packContextWorkspace(subject, 4_000, 3_000);
    return subject;
  };
  const packets = [packet([]), packet([pages[0]!]), packet(pages)];
  const turns = [0, 1, 2].map(index => store.write({ id: `research-turn:paid-pages:${index}`,
    kind: 'research-turn', expected: 0, value: { question: reference(question),
      status: 'completed', error: null, action: index < 2
        ? { action: 'read_context', record: reference(archive), pointer: '/body/blob',
          page: { offset: index * 2, limit: 2 } } : { action: 'checkpoint' },
      observation: index < 2 ? pages[index] : null } }));
  store.write({ id: question.id, kind: 'question', expected: question.revision,
    value: { ...question.value, status: 'answered' } });
  const workspace = addressedWorkspace(store, turns as any, question,
    turn => packets[Number(turn.id.split(':').at(-1))]!);
  assert.deepEqual(workspace.deliveryCoverage?.find(item => item.pointer === '/body/blob')?.ranges,
    [{ offset: 0, end: 4 }]);
  assert.deepEqual(workspace.checkpointedKeys,
    pages.map(page => contextLookupKey(page)));
});

test('result capacity uses the complete escaped JSON result and immutable mandatory projection', () => {
  const input = { operation: 'run:1', generation: 1, bindings: { question: 'q:1' },
    role: 'assessor' as const, purpose: 'review', actionMode: 'verdict', envelopeLimitChars: 2_000,
    mandatoryEnvelope: {
      protocol: 'omg-agent/v1', prompt: 'Review complete grounds', question: { id: 'q:1', spec: { risk: 'all' } }
    }, forms: [{ kind: 'verdict' }] };
  const saved = buildResearchResultCapacity(input);
  requireResearchResultCapacity(saved, input);
  assert.ok('projection' in saved.mandatory);
  assert.equal(saved.mandatory.hash.length, 64);
  assert.equal(saved.forms[0]?.minimumKey, 'shared');
  const small = measureResearchResult(saved, 'verdict', { reasons: ['quote " and slash \\ and 🌍'] });
  assert.equal(small.fits, true);
  assert.equal(small.requiredChars, saved.forms[0]!.minimumChars
    + JSON.stringify({ reasons: ['quote " and slash \\ and 🌍'] }).length);
  assert.equal(measureResearchResult(saved, 'verdict', { reasons: ['z'.repeat(2_000)] }).fits, false);
  assert.throws(() => requireResearchResultCapacity(saved, { ...input, bindings: { question: 'q:2' } }),
    { code: 'research_capacity_invalid' });
});

test('result capacity stores one mandatory projection for many forms, without multiplying the schema', () => {
  const mandatoryEnvelope = { question: { schema: 'x'.repeat(3000) }, grounds: 'exact accepted prefix' };
  const input = { operation: 'run:many', generation: 1, bindings: { question: 'q:many' },
    role: 'analyst' as const, purpose: 'answer', actionMode: 'research', envelopeLimitChars: 12_000,
    mandatoryEnvelope, forms: Array.from({ length: 16 }, (_, i) => ({ kind: `form-${i}` })) };
  const saved = buildResearchResultCapacity(input);
  assert.equal(saved.forms.length, 16);
  assert.ok(JSON.stringify(saved).length < 7_000);
  assert.equal(JSON.stringify(saved).match(/x{3000}/g)?.length, 1);
  assert.ok(saved.forms.every(form => form.minimumKey === 'shared'
    && form.minimumChars + form.maxResultChars === input.envelopeLimitChars));
  requireResearchResultCapacity(saved, input);
  assert.throws(() => requireResearchResultCapacity(saved, { ...input,
    mandatoryEnvelope: { ...mandatoryEnvelope, grounds: 'foreign prefix' } }),
  { code: 'research_capacity_invalid' });
});

test('result capacity stores an exact archive address while charging the full mandatory projection once', () => {
  const mandatoryEnvelope = { question: { schema: { description: 'unique-schema-body-'.repeat(1_000) } } };
  const archive = { record: lookup(null).record, pointer: '/body/resultMinimum',
    hash: hashJson(mandatoryEnvelope) };
  const input = { operation: 'stage', generation: 1, bindings: { draft: 'd' },
    role: 'assessor' as const, purpose: 'assessment', actionMode: 'answer',
    envelopeLimitChars: 50_000, mandatoryEnvelope, mandatoryArchive: archive,
    forms: Array.from({length:16}, (_, index) => ({kind:`form-${index}`})) };
  const capacity = buildResearchResultCapacity(input);
  assert.deepEqual(capacity.mandatory, { archive });
  assert.ok(JSON.stringify(capacity).length < 4_000,
    'the form table and saved declaration must not repeat a large schema');
  assert.ok(capacity.forms.every(form => form.minimumKey === 'shared'
    && form.minimumChars > JSON.stringify(mandatoryEnvelope).length));
  for (const form of capacity.forms) assert.equal(form.minimumChars,
    JSON.stringify({ mandatory: mandatoryEnvelope, capacity, form: form.kind, result: null }).length - 4);
  requireResearchResultCapacity(capacity, input, (record, pointer) => {
    assert.deepEqual(record, archive.record);
    assert.equal(pointer, archive.pointer);
    return mandatoryEnvelope;
  });
  assert.throws(() => requireResearchResultCapacity(capacity, input),
    { code: 'research_capacity_invalid' });
  assert.throws(() => requireResearchResultCapacity(capacity, input,
    () => ({ question: { schema: { description: 'another' } } })),
  { code: 'research_capacity_invalid' });
});

test('the saved result admission occupies one real subject slot in initial, continuation, planning and consolidation', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-rd2b-capacity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(() => store.close());
  const draft = store.write({ id: 'draft:rd2b-capacity', kind: 'discovery-draft', expected: 0,
    value: { projectId: 'p', contractVersion: 5, stage: 'discovery', level: 'R1',
      consumer: 'research', inputs: [], fields: {}, questions: ['question:rd2b-capacity'] } });
  const question = store.write({ id: 'question:rd2b-capacity', kind: 'question', expected: 0,
    value: { projectId: 'p', draftId: draft.id, status: 'open',
      spec: { field: 'preparation', prompt: 'Decide', risk: 'Evidence', kind: 'decision',
        schema: { type: 'object', properties: { answer: { type: 'string' } } } } } });
  const resultCapacity = { contract: 'result-capacity/v1', mandatory: { archive: {
    record: { id: 'research-context:minimum', revision: 1, hash: 'a'.repeat(64) },
    pointer: '/body/minimum', hash: 'b'.repeat(64) } }, forms: [] };
  const base = { role: 'research', question: { id: question.id }, history: [],
    contextWorkspace: [], resultCapacity };
  const planner = { ...base, dispatchMode: 'planning', repositoryRoot: root,
    core: { objective: 'O', problem: 'P', actors: [], constraints: [],
      specificationConstraints: [], concept: {}, requirements: [] },
    map: { ref: { id: draft.id, revision: draft.revision, hash: draft.hash }, nodes: [] },
    inventory: { sources: [], files: [], filesTruncated: false },
    catalogue: [], readings: [], directReadings: [], answers: [], readPlanStatus: [] };
  const consolidation = { ...base, dispatchMode: 'consolidation', synthesisNotes: [],
    synthesisSession: 'session:one', synthesisState: {}, consolidation: { targetChars: 1_000, format: 2 } };
  const cases = [
    workingContext(store, 'p', draft.id, question.id, base, 50_000, { common: true }),
    workingContext(store, 'p', draft.id, question.id, base, 50_000, { common: true, continuation: true }),
    workingContext(store, 'p', draft.id, question.id, planner, 50_000),
    workingContext(store, 'p', draft.id, question.id, consolidation, 50_000),
  ];
  for (const packet of cases) {
    assert.deepEqual(packet.resultCapacity, resultCapacity);
    assert.equal(JSON.stringify(packet).split('result-capacity/v1').length - 1, 1);
    assert.ok(JSON.stringify(packet).length < 50_000);
  }
  const crowded = workingContext(store, 'p', draft.id, question.id, {
    ...base, contextWorkspace: [], discoveryContext: { ground: 'G'.repeat(100_000) },
    history: [{ action: { action: 'checkpoint', question: question.id,
      value: { notes: 'N'.repeat(100_000) } } }],
  }, 50_000, { common: true, continuation: true });
  assert.ok(JSON.stringify(crowded).length < 50_000);
  assert.equal(crowded.materialDelivery.length, 1);
  assert.ok(crowded.working.materialAddresses.some((address: {field:string}) =>
    address.field === 'discoveryContext'));
  assert.ok(crowded.working.conclusionOrigins.length > 0);
  assert.equal(Object.hasOwn(crowded, 'conclusions'), false);
});
