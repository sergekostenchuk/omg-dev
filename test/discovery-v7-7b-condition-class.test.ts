import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { FINAL_BUNDLE_CONTRACTS, V7_FINAL_CONTRACT, V7_FINAL_SCHEMA, V8_FINAL_CONTRACT, V8_FINAL_SCHEMA, checkFinalBundle,
  checkV7Final, finalBundleSchema } from '../src/discovery/v7-final-contracts.js';
import { decodeDiscoveryFinalEnvelopeInput } from '../src/discovery/discovery-final-packing.js';
import { reviewedConditionClasses } from '../src/discovery/discovery-final-assessment-result.js';

// DR7 7b.3-class (codex-omg2 №16183): the form of the explicitly versioned D7 bundle discovery-final/v8 — a class and
// its reason on every owner condition — beside the unchanged historical discovery-final/v7, and the version fixed in the
// closed preparation input. Pure form checks; the paid path and the recovery have their own files.
const ref = { id: 'discovery-dossier:p:x', revision: 1, hash: '0'.repeat(64) };
/** An owner condition; `class` and `classReason` are present only as given (an absent key is an absence). */
const owner = (fields: Record<string, unknown> = {}) => ({ id: 'pick', kind: 'owner_choice',
  condition: 'The owner picks', criterion: 'An option is picked', ...fields,
  options: [{ optionId: 'yes', label: 'Yes', consequences: ['Goes ahead'], choice: 'accept' },
    { optionId: 'no', label: 'No', consequences: ['Dropped'], choice: 'decline' }] });
const evidence = { id: 'source', kind: 'evidence', condition: 'A source is available', criterion: 'A signed agreement' };
const bundle = (contract: string, conditions: unknown[]) => ({ contract, dossier: ref,
  verdict: { outcome: 'conditional', reason: 'Saved reasons', conditions },
  summary: { what: 'Ledger', forWhom: 'Operators', why: 'Traceability', firstResult: 'A record', successCriterion: 'No gap', nonGoals: ['Payroll'] },
  projection: { users: ['Operator'], payers: [], rules: [], externalSystems: [], unresolved: [] },
  constitution: { goal: 'Traceability', consumers: ['Operator'], nonGoals: ['Payroll'], successCriterion: 'No gap' } });
const refusal = (action: () => unknown, field: string) => assert.throws(action,
  (error: unknown) => error instanceof EngineError && error.code === 'answer_invalid' && (error.details as { field?: string }).field === field, field);

test('7b.3-class form: discovery-final/v8 requires a known class and its reason on every owner condition', () => {
  for (const cls of ['choice', 'boundary', 'risk'])
    assert.equal(checkFinalBundle(bundle(V8_FINAL_CONTRACT, [evidence, owner({ class: cls, classReason: 'Both options stay inside the bundle' })]), V8_FINAL_CONTRACT).contract, V8_FINAL_CONTRACT);
  const at = 'final.verdict.conditions.1';
  refusal(() => checkFinalBundle(bundle(V8_FINAL_CONTRACT, [evidence, owner({ classReason: 'Both options stay inside the bundle' })]), V8_FINAL_CONTRACT), `${at}.class`);
  refusal(() => checkFinalBundle(bundle(V8_FINAL_CONTRACT, [evidence, owner({ class: null, classReason: 'Both options stay inside the bundle' })]), V8_FINAL_CONTRACT), `${at}.class`);
  refusal(() => checkFinalBundle(bundle(V8_FINAL_CONTRACT, [evidence, owner({ class: 'fine', classReason: 'Both options stay inside the bundle' })]), V8_FINAL_CONTRACT), `${at}.class`);
  refusal(() => checkFinalBundle(bundle(V8_FINAL_CONTRACT, [evidence, owner({ class: 'choice' })]), V8_FINAL_CONTRACT), `${at}.classReason`);
  refusal(() => checkFinalBundle(bundle(V8_FINAL_CONTRACT, [evidence, owner({ class: 'choice', classReason: ' ' })]), V8_FINAL_CONTRACT), `${at}.classReason`);
  // Extra fields stay no part of the form: on the owner condition and on an evidence condition.
  refusal(() => checkFinalBundle(bundle(V8_FINAL_CONTRACT, [evidence, { ...owner({ class: 'choice', classReason: 'Both options stay inside the bundle' }), extra: 1 }]), V8_FINAL_CONTRACT), 'final');
  refusal(() => checkFinalBundle(bundle(V8_FINAL_CONTRACT, [{ ...evidence, class: 'choice' }, owner({ class: 'choice', classReason: 'Both options stay inside the bundle' })]), V8_FINAL_CONTRACT), 'final');
});

test('7b.3-class history: discovery-final/v7 keeps its own form, schema and door; versions never stand for one another', () => {
  // A1 (codex-omg2 №16384) adds discovery-final/v9 with the full projection; an unknown later version stays refused.
  assert.deepEqual(FINAL_BUNDLE_CONTRACTS, [V7_FINAL_CONTRACT, V8_FINAL_CONTRACT, 'discovery-final/v9']);
  assert.equal(finalBundleSchema(V7_FINAL_CONTRACT), V7_FINAL_SCHEMA); assert.equal(finalBundleSchema(V8_FINAL_CONTRACT), V8_FINAL_SCHEMA);
  assert.equal(canonical(V7_FINAL_SCHEMA as never).includes('classReason'), false, 'no class is added to the historical form');
  const legacy = bundle(V7_FINAL_CONTRACT, [evidence, owner()]);
  assert.deepEqual(checkV7Final(legacy), checkFinalBundle(legacy), 'a v7 bundle without a class stays readable by its own form');
  refusal(() => checkV7Final(bundle(V7_FINAL_CONTRACT, [evidence, owner({ class: 'choice', classReason: 'Both options stay inside the bundle' })])), 'final');
  refusal(() => checkV7Final(bundle(V8_FINAL_CONTRACT, [evidence, owner({ class: 'choice', classReason: 'Both options stay inside the bundle' })])), 'final.contract');
  refusal(() => checkFinalBundle(legacy, V8_FINAL_CONTRACT), 'final.contract');
  refusal(() => checkFinalBundle(bundle('discovery-final/v10', [evidence]), undefined), 'final.contract');
  refusal(() => checkFinalBundle(bundle('discovery-final/v10', [evidence]), V8_FINAL_CONTRACT), 'final.contract');
  // The assessor reviews classes exactly for a classed candidate.
  assert.equal(reviewedConditionClasses(checkFinalBundle(legacy)), null);
  assert.deepEqual(reviewedConditionClasses(checkFinalBundle(bundle(V8_FINAL_CONTRACT, [evidence, owner({ class: 'risk', classReason: 'Both options stay inside the bundle' })]))),
    [{ conditionId: 'pick', class: 'risk' }]);
});

test('7b.3-class preparation: the version is a closed input — absent is v7, only a known later form may be named', () => {
  const input = { prompt: 'Build', packetChars: 10, limitChars: 20, resultLimitChars: 30, environment: ref, role: { model: 'm' } };
  assert.equal(Object.hasOwn(decodeDiscoveryFinalEnvelopeInput(input), 'form'), false);
  assert.equal(decodeDiscoveryFinalEnvelopeInput({ ...input, form: V8_FINAL_CONTRACT }).form, V8_FINAL_CONTRACT);
  for (const form of [V7_FINAL_CONTRACT, 'discovery-final/v10', null, ''])
    assert.throws(() => decodeDiscoveryFinalEnvelopeInput({ ...input, form }),
      (error: unknown) => error instanceof EngineError && error.code === 'discovery_final_packing_invalid', String(form));
  assert.throws(() => decodeDiscoveryFinalEnvelopeInput({ ...input, form: V8_FINAL_CONTRACT, extra: 1 }),
    (error: unknown) => error instanceof EngineError && error.code === 'discovery_final_packing_invalid');
});
