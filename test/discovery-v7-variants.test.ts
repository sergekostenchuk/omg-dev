import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { referenceSites } from '../src/storage/reference-sites.js';
import { checkStoreIntegrity } from '../src/storage/fsck.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { VARIANT_CRITERIA, VARIANT_CONTRACT, VARIANT_SET_CONTRACT, VARIANT_NONE_CONTRACT,
  VARIANT_SNAPSHOT_CONTRACT, VARIANT_SUBJECT_CONTRACT, decodeVariantSubject, decodeVariantSnapshot,
  decodeDiscoveryVariant, decodeVariantSet, decodeVariantNone, readVariantSnapshotStructural,
  readDiscoveryVariantStructural, readVariantSetStructural, readVariantNoneStructural, variantRecordId,
  type VariantSnapshot, type DiscoveryVariant, type VariantSet, type VariantNone,
  type VariantScale, type VariantJudgements } from '../src/discovery/discovery-variants.js';

// These are structural fixtures, explicitly not paid outputs or accepted-claim/authority proofs.
function fixture(t: test.TestContext, count = 2) {
  const root = mkdtempSync(join(tmpdir(), 'omg-variant-forms-')), path = join(root, 'state.sqlite');
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const base = (name: string) => reference(store.write({ id: `basis:${name}`, kind: 'structural-test-basis', expected: 0, value: { name } }));
  const draft = base('draft'), frame = base('frame'), plan = base('plan'), mode = base('mode'), ground = base('ground');
  const origin = { intent: base('intent'), call: base('call'), response: base('response') };
  const save = <T extends { projectId: string }>(kind: string, value: T): Ref =>
    reference(store.write({ id: variantRecordId(kind, value), kind, expected: 0, value }));
  const snapshotValue: VariantSnapshot = { contract: VARIANT_SNAPSHOT_CONTRACT, projectId: 'p', draft, frame, plan,
    questions: [{ planQuestionId: 'q', question: base('question'), blocking: true, progress: null,
      applications: [], reason: { code: 'source_missing', message: 'Still unknown after this sweep', grounds: [ground] } }] };
  const snapshot = save('discovery-variant-snapshot', snapshotValue);
  const scale = Object.fromEntries(VARIANT_CRITERIA.map(k => [k, 'Explain grounds, assumptions and remaining uncertainty'])) as VariantScale;
  const memberValue = (i: number): DiscoveryVariant => ({ contract: VARIANT_CONTRACT, projectId: 'p', draft, snapshot, origin,
    key: `v${i}`, title: `Variant ${i}`, proposal: { product: `Product ${i}` }, scale,
    criteria: Object.fromEntries(VARIANT_CRITERIA.map(k => [k, { conclusion: `Qualitative ${k}`,
      grounds: [ground], assumptions: [], unknowns: ['Evidence may be incomplete'], quantity: null }])) as unknown as VariantJudgements });
  const values = Array.from({ length: count }, (_, i) => memberValue(i));
  const members = values.map(value => save('discovery-variant', value));
  const setValue: VariantSet = { contract: VARIANT_SET_CONTRACT, projectId: 'p', draft, snapshot, origin, members, scale,
    comparison: 'The simpler proposal has a smaller stated scope', recommendation: { member: members[0]!, reason: 'Lower stated scope' },
    searchLimits: ['One completed broad sweep'], unknowns: ['Payer willingness'] };
  const set = save('discovery-variant-set', setValue);
  const noneValue: VariantNone = { contract: VARIANT_NONE_CONTRACT, projectId: 'p', draft, snapshot, origin,
    reasons: [{ code: 'no_viable_proposal', message: 'No candidate within the mandate', grounds: [ground] }],
    searchLimits: ['One completed broad sweep'], unknowns: ['Market evidence is incomplete'] };
  return { store, path, save, draft, mode, ground, origin, snapshotValue, snapshot, values, members, setValue, set, noneValue };
}
const invalid = (run: () => unknown, code?: string) => assert.throws(run,
  (error: unknown) => error instanceof EngineError && (code ? error.code === code : error.code.startsWith('discovery_variant_')));
const without = (value: object, field: string) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));

test('DR4-M sets retain exactly 1, 2 or 3 immutable members and allow an open blocking unknown', t => {
  for (const count of [1, 2, 3]) {
    const f = fixture(t, count), result = readVariantSetStructural(f.store, 'p', f.set);
    assert.equal(result.verification, 'structural');
    assert.deepEqual(result.record.value, f.setValue);
    assert.equal(result.record.value.members.length, count);
    assert.deepEqual(readVariantSnapshotStructural(f.store, 'p', f.snapshot).record.value, f.snapshotValue);
    assert.equal(f.snapshotValue.questions[0]!.blocking, true);
    for (const member of f.members) assert.equal(Object.hasOwn(readDiscoveryVariantStructural(f.store, 'p', member).record.value, 'set'), false);
    const cold = new Store(f.path);
    try { assert.deepEqual(readVariantSetStructural(cold, 'p', f.set), result); } finally { cold.close(); }
  }
});

test('DR4-M no_variants has its own reasons, limits, unknowns and origin; it is neither an empty set nor reject_all', t => {
  const f = fixture(t), ref = f.save('discovery-variant-none', f.noneValue);
  assert.deepEqual(readVariantNoneStructural(f.store, 'p', ref).record.value, f.noneValue);
  invalid(() => decodeVariantSet({ ...f.setValue, members: [] }));
  invalid(() => decodeVariantNone({ ...f.noneValue, reasons: [] }));
  invalid(() => decodeVariantNone({ ...f.noneValue, reasons: Array(1) }));
  invalid(() => decodeVariantNone({ ...f.noneValue, outcome: { kind: 'reject_all' } }));
  for (const field of Object.keys(f.noneValue)) invalid(() => decodeVariantNone(without(f.noneValue, field)));
});

test('DR4-M subject pins snapshot or set, mode and explicit expectedSelection before payment', t => {
  const f = fixture(t);
  for (const subject of [
    { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal', snapshot: f.snapshot, mode: f.mode, expectedSelection: null },
    { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision', set: f.set, mode: f.mode, expectedSelection: f.ground },
  ]) {
    assert.deepEqual(decodeVariantSubject(subject), subject);
    const carrier: Pick<ModelCall, 'variantSubject'> = { variantSubject: decodeVariantSubject(subject) };
    assert.deepEqual(referenceSites('model-call', carrier).map(s => s.ref),
      [subject.kind === 'proposal' ? f.snapshot : f.set, f.mode, ...(subject.expectedSelection ? [f.ground] : [])]);
    for (const field of Object.keys(subject)) invalid(() => decodeVariantSubject(without(subject, field)), 'discovery_variant_subject_invalid');
    for (const value of [null, undefined, { ...subject, contract: 'discovery-variant-subject/v9' },
      { ...subject, kind: 'plan-question', planQuestionId: 'q' }, { ...subject, mode: null },
      { ...subject, expectedSelection: undefined }, { ...subject, paid: true }])
      invalid(() => decodeVariantSubject(value), 'discovery_variant_subject_invalid');
  }
  const legacy: Pick<ModelCall, 'variantSubject'> = {};
  assert.deepEqual(referenceSites('model-call', legacy), []);
});

test('DR4-M rejects cardinality, duplicates, missing criteria, fabricated proofs and unsupported versions', t => {
  const f = fixture(t), member = f.values[0]!;
  for (const value of [{ ...f.setValue, members: [f.members[0], f.members[0]] },
    { ...f.setValue, members: [...f.members, f.ground, f.mode] }, { ...f.setValue, members: Array(1) },
    { ...f.setValue, recommendation: { member: f.ground, reason: 'Not a member' } },
    { ...f.setValue, contract: 'discovery-variant-set/v2' }, { ...f.setValue, searchLimits: [] }]) invalid(() => decodeVariantSet(value));
  for (const [value, decode] of [[member, decodeDiscoveryVariant], [f.setValue, decodeVariantSet],
    [f.snapshotValue, decodeVariantSnapshot]] as const) {
    for (const field of Object.keys(value)) invalid(() => decode(without(value, field)));
    for (const flag of ['paid', 'owner', 'accepted', 'ready']) invalid(() => decode({ ...value, [flag]: true }));
    invalid(() => decode({ ...value, contract: 'unknown/v9' }));
  }
  for (const criterion of VARIANT_CRITERIA) invalid(() => decodeDiscoveryVariant({ ...member, criteria: without(member.criteria, criterion) }));
  invalid(() => decodeDiscoveryVariant({ ...member, criteria: { ...member.criteria, totalScore: 99 } }));
  invalid(() => decodeVariantSnapshot({ ...f.snapshotValue, questions: Array(1) }));
  invalid(() => decodeVariantSnapshot({ ...f.snapshotValue, questions: [f.snapshotValue.questions[0], f.snapshotValue.questions[0]] }));
  invalid(() => decodeVariantSnapshot({ ...f.snapshotValue, questions: [{ ...f.snapshotValue.questions[0], reason: null }] }));
  invalid(() => decodeDiscoveryVariant({ ...member, proposal: { x: undefined } }));
  invalid(() => decodeDiscoveryVariant({ ...member, proposal: Array(1) }));
  invalid(() => decodeDiscoveryVariant({ ...member, proposal: new Date() }));
});

test('DR4-M qualitative unknowns stay null; quantitative values require unit, finite range, limits and basis', t => {
  const f = fixture(t), value = structuredClone(f.values[0]!);
  value.criteria.costAndTime = { conclusion: 'Not measured', grounds: [], assumptions: [], unknowns: ['Cost unknown'], quantity: null };
  assert.equal(decodeDiscoveryVariant(value).criteria.costAndTime.quantity, null);
  const quantity = { unit: 'days', minimum: 0, maximum: 3, limitations: 'Prototype only', grounds: [f.ground] };
  value.criteria.costAndTime.quantity = quantity;
  assert.deepEqual(decodeDiscoveryVariant(value).criteria.costAndTime.quantity, quantity);
  for (const broken of [0, without(quantity, 'unit'), { ...quantity, minimum: 5 }, { ...quantity, maximum: Infinity },
    { ...quantity, grounds: [] }, { ...quantity, limitations: '' }]) {
    invalid(() => decodeDiscoveryVariant({ ...value, criteria: { ...value.criteria,
      costAndTime: { ...value.criteria.costAndTime, quantity: broken } } }));
  }
});

test('DR4-M exact readers reject project/kind/hash/address/member substitutions and never follow a newer head', t => {
  const f = fixture(t);
  invalid(() => readVariantSetStructural(f.store, 'other', f.set), 'discovery_variant_basis_invalid');
  invalid(() => readVariantSetStructural(f.store, 'p', f.members[0]!), 'discovery_variant_basis_invalid');
  invalid(() => readVariantSetStructural(f.store, 'p', { ...f.set, hash: '0'.repeat(64) }), 'discovery_variant_basis_invalid');
  invalid(() => readVariantSetStructural(f.store, 'p', { ...f.set, revision: 2 }), 'discovery_variant_basis_invalid');
  const renamed = reference(f.store.write({ id: 'discovery-variant-set:p:renamed', kind: 'discovery-variant-set', expected: 0, value: f.setValue }));
  invalid(() => readVariantSetStructural(f.store, 'p', renamed), 'discovery_variant_basis_invalid');
  const view = { get: <T>(id: string, revision?: number) => {
    const row = f.store.get<T>(id, revision);
    return row && id === f.set.id ? { ...row, value: { ...f.setValue, comparison: 'Forged bytes' } as T } : row;
  } };
  invalid(() => readVariantSetStructural(view, 'p', f.set), 'discovery_variant_basis_invalid');
  for (const changed of [{ ...f.values[0]!, projectId: 'foreign' }, { ...f.values[0]!, draft: f.mode },
    { ...f.values[0]!, snapshot: f.set }, { ...f.values[0]!, origin: { ...f.origin, call: f.mode } },
    { ...f.values[0]!, scale: { ...f.values[0]!.scale, risk: 'Different scale' } }, { ...f.values[0]!, key: 'v1' }]) {
    const member = f.save('discovery-variant', changed);
    const set = f.save('discovery-variant-set', { ...f.setValue, members: [member, f.members[1]!], recommendation: { member, reason: 'First' } });
    invalid(() => readVariantSetStructural(f.store, 'p', set));
  }
  f.store.write({ id: f.set.id, kind: 'discovery-variant-set', expected: 1, value: { ...f.setValue, comparison: 'Later body' } });
  assert.deepEqual(readVariantSetStructural(f.store, 'p', f.set).record.value, f.setValue);
  invalid(() => readVariantSetStructural(f.store, 'p', reference(f.store.get(f.set.id)!)));
  assert.equal(f.store.history(f.set.id).length, 2);
});

test('DR4-M registry/fsck sees every service reference while proposal JSON remains data', t => {
  const f = fixture(t), fake = { id: 'not-a-reference', revision: 9, hash: 'f'.repeat(64) };
  const member = structuredClone(f.values[0]!);
  member.proposal = { nested: [fake] };
  member.criteria.risk.quantity = { unit: 'events', minimum: 0, maximum: 2, limitations: 'Estimate', grounds: [f.ground] };
  const memberRef = f.save('discovery-variant', member);
  f.save('discovery-variant-none', f.noneValue);
  assert.deepEqual(checkStoreIntegrity(f.store).findings, []);
  assert.deepEqual(referenceSites('discovery-variant', member).map(s => s.field).sort(),
    ['draft', 'snapshot', 'origin.intent', 'origin.call', 'origin.response',
      ...VARIANT_CRITERIA.map(k => `criteria.${k}.grounds[0]`), 'criteria.risk.quantity.grounds[0]'].sort());
  const missing = { ...member, origin: { ...member.origin, call: fake } };
  const broken = f.save('discovery-variant', missing);
  const findings = checkStoreIntegrity(f.store).findings;
  assert.deepEqual(findings.map(x => [x.code, x.id, x.field]), [['reference_missing', broken.id, 'origin.call']]);
  assert.equal(findings.some(x => x.id === memberRef.id), false);
  const snapshotWithApplication = { ...f.snapshotValue, questions: [{ ...f.snapshotValue.questions[0]!, progress: f.ground, applications: [f.ground] }] };
  assert.deepEqual(referenceSites('discovery-variant-snapshot', snapshotWithApplication).map(s => s.field).sort(),
    ['draft', 'frame', 'plan', 'questions[0].question', 'questions[0].progress', 'questions[0].applications[0]', 'questions[0].reason.grounds[0]'].sort());
  assert.deepEqual(referenceSites('discovery-variant-set', f.setValue).map(s => s.field).sort(),
    ['draft', 'snapshot', 'origin.intent', 'origin.call', 'origin.response', 'members[0]', 'members[1]', 'recommendation.member'].sort());
  assert.deepEqual(referenceSites('discovery-variant-none', f.noneValue).map(s => s.field).sort(),
    ['draft', 'snapshot', 'origin.intent', 'origin.call', 'origin.response', 'reasons[0].grounds[0]'].sort());
});
