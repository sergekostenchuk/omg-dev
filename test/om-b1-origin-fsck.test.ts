import type { Sealed } from "../src/om/refusal.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store, storeReads } from '../src/storage/store.js';
import { StageChecks } from '../src/product/stage-checks.js';
import { ProductEngine } from '../src/product/engine.js';
import { integrityGate, integrityId, runIntegrityCheck, type IntegrityRecord } from '../src/om/integrity.js';
import { startPass, continuePass } from '../src/om/run-driver.js';
import { checkStoreIntegrity, INTEGRITY_FINDING_CODES } from '../src/storage/fsck.js';
import { writeOmInput } from '../src/om/input.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { preparedFeatures } from './product-fixture.js';
import { EngineError } from '../src/errors.js';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'omg-g7-')), store = new Store(join(directory, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'p' });
  return { store, engine };
}
const missing = (record: Sealed<IntegrityRecord>) => record.findings.filter(f => f.code === 'record_missing');
const expected = [{ code: 'record_missing', id: 'om-input:p', revision: 1, field: 'revision', ref: null,
  message: 'OM provenance requires the exact first B1 input' }];

for (const kind of ['producer', 'writer-index', 'historical-owner', 'incomplete-ref'] as const)
  test(`G7 fsck/start/continue find ${kind} provenance without the first B1`, async t => {
    const { store, engine } = fixture(t);
    if (kind === 'producer') store.write({ id: 'om-horizon:p:saved', kind: 'unrelated-kind', expected: 0, value: {} });
    if (kind === 'writer-index' || kind === 'historical-owner') {
      store.write({ id: 'writer-index', kind: 'writer-index', expected: 0, value: { project: 'p', contract: 'writer-index/om-m8-v1' } });
      if (kind === 'historical-owner') store.write({ id: 'writer-index', kind: 'writer-index', expected: 1,
        value: { project: 'other', contract: 'writer-index/legacy' } });
    }
    if (kind === 'incomplete-ref') store.write({ id: 'graph-layer:p:1', kind: 'graph-layer', expected: 0,
      value: { inputs: [{ id: 'om-input:p' }] } });
    const reads = storeReads();
    assert.deepEqual(engine.checks.legacyRoute('p'), { om: false, guards: [{ id: 'om-input:p', absent: true }] });
    assert.equal(storeReads() - reads, 1, 'hot routing does not scan saved provenance');
    const manual = engine.execute({ type: 'om-fsck', project: 'p' }) as ReturnType<typeof runIntegrityCheck>;
    assert.ok(manual.ok);
    assert.deepEqual(missing(manual.value.value), expected);
    assert.ok(INTEGRITY_FINDING_CODES.includes('record_missing'));
    const cold = new Store(store.path); t.after(() => cold.close());
    for (const source of [store, cold]) for (const action of [startPass, continuePass]) {
      const before = source.lastEvent(), denied = await action(source, { project: 'p' });
      assert.equal(denied.ok, false);
      if (!denied.ok) {
        assert.equal(denied.refusal.code, 'store_damaged');
        assert.ok(denied.refusal.message.includes('record_missing om-input:p@1 revision'));
      }
      assert.equal(source.lastEvent(), before, 'same finding set neither starts a pass nor rewrites its report');
      assert.deepEqual(missing(source.get<IntegrityRecord>(integrityId('p'))!.value), expected);
    }
  });

test('G7 omProject stays at one read with 10x actual history, foreign projects, and no provenance', t => {
  const { store } = fixture(t), checks = new StageChecks(store);
  const measure = () => { const before = storeReads(); assert.equal(checks.omProject('p'), false); return storeReads() - before; };
  store.write({ id: 'writer-index:foreign', kind: 'writer-index', expected: 0, value: { project: 'other', contract: 'writer-index/om-m8-v1' } });
  store.write({ id: 'om-owner-decision:p:data', kind: 'om-owner-decision', expected: 0,
    value: { text: 'om-input:p', nested: { id: 'om-input:p' } } });
  assert.equal(measure(), 1);
  for (let n = 1; n < 10; n++) store.write({ id: 'writer-index:foreign', kind: 'writer-index', expected: n,
    value: { project: 'other', contract: 'writer-index/om-m8-v1', step: n } });
  for (let n = 0; n < 100; n++) store.write({ id: `om-horizon:foreign-${n}:saved`, kind: 'om-horizon', expected: 0, value: {} });
  assert.equal(measure(), 1);
  assert.equal(integrityGate(store, 'p'), null, 'foreign ownership and arbitrary data do not imply B1');
  const route = checks.legacyRoute('p');
  const other = new Store(store.path);
  try { other.write({ id: 'om-input:p', kind: 'om-input', expected: 0, value: {} }); } finally { other.close(); }
  assert.throws(() => store.writeMany([{ id: 'legacy:p:work', kind: 'legacy', expected: 0, value: {} }], route.guards),
    (e: unknown) => e instanceof EngineError && e.code === 'input_stale');
  assert.equal(store.get('legacy:p:work'), null, 'appearance of B1 still invalidates a pending legacy write');
});

test('G7 a real exact first B1 keeps its historical read, and a malformed first record keeps its typed refusal', t => {
  const { store, engine } = fixture(t);
  preparedFeatures(engine, 'ready');
  const input = writeOmInput(store, { project: 'ready', expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:ready:${stage}`)!)])) as Record<UpstreamStage, Ref> });
  assert.ok(input.ok, input.ok ? '' : input.refusal.message);
  const cold = new Store(store.path); t.after(() => cold.close());
  const before = storeReads();
  assert.equal(new StageChecks(cold).omProject('ready'), true);
  assert.equal(storeReads() - before, 2, 'one first-revision lookup and one exact trusted reader');
  assert.equal(integrityGate(cold, 'ready'), null);
  store.write({ id: 'om-input:p', kind: 'wrong-kind', expected: 0, value: {} });
  assert.throws(() => new StageChecks(store).omProject('p'),
    (e: unknown) => e instanceof EngineError && e.code === 'record_foreign');
});

test('G7 provenance and integrity use the same snapshot and existing two revision passes', t => {
  const { store } = fixture(t);
  const ledger = store.integrityLedger.bind(store), revisions = store.integrityRevisions.bind(store);
  let ledgerCalls = 0, revisionPasses = 0;
  t.mock.method(store, 'integrityLedger', () => {
    ledgerCalls++;
    const snapshot = ledger();
    const other = new Store(store.path);
    try { other.write({ id: 'writer-index:new', kind: 'writer-index', expected: 0,
      value: { project: 'p', contract: 'writer-index/om-m8-v1' } }); } finally { other.close(); }
    return snapshot;
  });
  t.mock.method(store, 'integrityRevisions', () => { revisionPasses++; return revisions(); });
  const report = runIntegrityCheck(store, { project: 'p' });
  assert.ok(report.ok); assert.deepEqual(report.value.value.findings, []);
  assert.equal(ledgerCalls, 1); assert.equal(revisionPasses, 2, 'B1 does not introduce a third scan');
  t.mock.restoreAll();
  assert.equal(integrityGate(store, 'p')?.ok, false, 'the next operation sees the concurrently saved provenance');
});

const damagedReports: { name: string; body: (report: Sealed<IntegrityRecord>) => string }[] = [
  { name: 'missing findings', body: report => {
    const { findings: _findings, ...without } = report; return JSON.stringify(without);
  } },
  { name: 'null report', body: () => 'null' },
  { name: 'array report', body: () => '[]' },
  { name: 'null findings', body: report => JSON.stringify({ ...report, findings: null }) },
  { name: 'object findings', body: report => JSON.stringify({ ...report, findings: {} }) },
  { name: 'invalid finding', body: report => JSON.stringify({ ...report, findings: [null] }) },
  { name: 'numeric overflow in findings', body: report => JSON.stringify({ ...report, findings: ['overflow'] }).replace('["overflow"]', '[1e400]') },
];
for (const [entry, action] of [['om-start', startPass], ['om-continue', continuePass]] as const)
  for (const damage of damagedReports) test(`G7 ${entry} returns store_damaged for its own ${damage.name} report`, async t => {
    const { store } = fixture(t), saved = runIntegrityCheck(store, { project: 'p' });
    assert.ok(saved.ok);
    const broken = damage.body(saved.value.value), raw = new DatabaseSync(store.path);
    try {
      raw.exec('DROP TRIGGER IF EXISTS revisions_no_update');
      raw.prepare('UPDATE revisions SET body=? WHERE entity_id=? AND revision=?')
        .run(broken, saved.value.id, saved.value.revision);
    } finally { raw.close(); }
    const findings = checkStoreIntegrity(store).findings;
    assert.deepEqual(findings.map(f => [f.code, f.id, f.revision]), [['revision_corrupt', saved.value.id, saved.value.revision]]);
    const denied = await action(store, { project: 'p' });
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.refusal.code, 'store_damaged');
      assert.equal(denied.refusal.route, 'owner');
      assert.ok(denied.refusal.message.includes(`revision_corrupt ${saved.value.id}@${saved.value.revision}`));
    }
    const renewed = store.get<IntegrityRecord>(saved.value.id)!;
    assert.equal(renewed.revision, saved.value.revision + 1);
    assert.deepEqual(renewed.value.findings, findings);
    assert.deepEqual(store.get(saved.value.id, saved.value.revision)!.value, JSON.parse(broken), 'The damaged original is not rewritten');
    const cold = new Store(store.path); t.after(() => cold.close());
    const sequence = cold.lastEvent();
    for (const again of [startPass, continuePass]) {
      const repeat = await again(cold, { project: 'p' });
      assert.equal(repeat.ok, false);
      if (!repeat.ok) assert.equal(repeat.refusal.code, 'store_damaged');
      assert.equal(cold.lastEvent(), sequence, 'Canonical comparison of the new valid report prevents duplicate writes');
    }
    assert.equal(cold.get('om-run:p'), null);
    assert.equal(cold.list('model-call').length, 0);
  });
