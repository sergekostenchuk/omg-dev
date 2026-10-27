import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { checkV7Final, V7_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { KEEPER_CHECK_KEY_CONTRACT, keeperCheckKey } from '../src/product/keeper.js';
import { decodeKeeperResult, KEEPER_RESULT_CONTRACT, projectKeeperResult } from '../src/product/keeper-result.js';

// Pure structural inputs: no Store, manifest, acceptance, authority or payment.
// The D7 constitution itself is taken from the accepted v7 form checker.
function fixture(): Record<string, any> {
  const final = checkV7Final({ contract: V7_FINAL_CONTRACT,
    dossier: { id: 'structural-dossier', revision: 1, hash: 'a'.repeat(64) },
    verdict: { outcome: 'go', reason: 'The selected product is viable', conditions: [] },
    summary: { what: 'A ledger', forWhom: 'Foremen', why: 'Avoid lost orders', firstResult: 'One order',
      successCriterion: 'Orders arrive', nonGoals: ['Payroll'] },
    projection: { users: ['Foremen'], payers: [], rules: [], externalSystems: [], unresolved: [] },
    constitution: { goal: 'Orders reach suppliers', consumers: ['Foremen'], nonGoals: ['Payroll'],
      successCriterion: 'Orders arrive' } });
  const artifact = { selected: { parts: [{ 'a/b': { '~result': ['orders', 'suppliers'] } }],
    count: 1, '01': 'an object key', '~1': 'a literal tilde-one' },
    outside: { shouldNotBeAddressable: 'foreign material' } };
  const constitution = { fields: { final }, outside: 'not a constitution item' };
  const artifactRef = { id: 'structural-artifact', revision: 3, hash: hashJson(artifact) };
  const constitutionRef = { id: 'structural-final-container', revision: 7, hash: hashJson(constitution) };
  const key = { contract: KEEPER_CHECK_KEY_CONTRACT, projectId: 'p',
    artifact: { container: structuredClone(artifactRef), pointer: '/selected' },
    constitution: { container: structuredClone(constitutionRef), pointer: '/fields/final/constitution' },
    checkVersion: 'keeper-check/1' };
  return { key, artifact: { ref: artifactRef, value: artifact }, constitution: { ref: constitutionRef, value: constitution },
    result: { contract: KEEPER_RESULT_CONTRACT, key: structuredClone(key), outcome: 'conforms',
      reason: 'The supplied result is consistent with the stated constitution', remarks: [] } };
}
const violation = () => ({ kind: 'violation', description: 'The output does not reach the stated result',
  constitutionPointer: '/successCriterion', artifactPointer: '/parts/0/a~1b/~0result/0' });
const recommendation = () => ({ kind: 'recommendation', description: 'Consider another presentation',
  constitutionPointer: null, artifactPointer: null });
const reordered = (value: unknown): unknown => Array.isArray(value) ? value.map(reordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reordered(v)])) : value;
function rejected(): Record<string, any> {
  const input = fixture();
  input.result.outcome = 'reject'; input.result.reason = 'A specific result is not met';
  input.result.remarks = [violation(), recommendation()];
  return input;
}
function refused(input: unknown, field?: string): void {
  assert.throws(() => projectKeeperResult(input), (error: unknown) => {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    assert.equal(error.code, 'keeper_result_invalid');
    if (field) assert.equal((error.details as { field: string }).field, field);
    return true;
  });
}

test('keeper result: conforms keeps recommendations and all reasons, with deterministic exact structural identities', () => {
  const input = fixture();
  input.result.remarks = [recommendation(), { kind: 'recommendation', description: 'Inspect this consumer',
    constitutionPointer: '/consumers/0', artifactPointer: '/parts/0/a~1b/~0result/1' }];
  const decoded = decodeKeeperResult(input), projected = projectKeeperResult(input);
  assert.deepEqual(decoded, JSON.parse(canonical(input)));
  assert.equal(projected.checkId, keeperCheckKey(input.key));
  assert.match(projected.resultId, /^keeper-result:p:[0-9a-f]{64}$/);
  assert.deepEqual(projected.result.remarks, input.result.remarks);
  assert.equal(projected.result.outcome, 'conforms');
  assert.equal(projectKeeperResult(structuredClone(input)).resultId, projected.resultId);
  assert.equal(projectKeeperResult(reordered(input)).resultId, projected.resultId, 'JSON key order does not change identity');
  const changed = structuredClone(input); changed.result.reason = 'Another stated basis';
  assert.equal(projectKeeperResult(changed).checkId, projected.checkId);
  assert.notEqual(projectKeeperResult(changed).resultId, projected.resultId);
  changed.result.reason = null;
  assert.equal(projectKeeperResult(changed).result.reason, null, 'no separate explanation is required for conformity');
});

test('keeper result: rejection retains every linked violation and recommendation without deciding their meaning', () => {
  const input = rejected();
  input.result.remarks.push({ kind: 'violation', description: 'Another alleged result',
    constitutionPointer: '/nonGoals/0', artifactPointer: '/count' });
  const projected = projectKeeperResult(input);
  assert.equal(projected.result.outcome, 'reject');
  assert.equal(projected.result.reason, input.result.reason);
  assert.deepEqual(projected.result.remarks, input.result.remarks);
  assert.deepEqual(projected.artifact.value, input.artifact.value);
  assert.deepEqual(projected.constitution.value, input.constitution.value);
});

test('keeper result: an incomplete blocking triple, mixed outcomes, missing fields and claimed payment or acceptance are typed refusals', () => {
  const cases: [string, (input: Record<string, any>) => void, string][] = [
    ['no constitution item', input => { input.result.remarks[0].constitutionPointer = null; }, 'result.remarks.0.constitutionPointer'],
    ['no artifact place', input => { input.result.remarks[0].artifactPointer = null; }, 'result.remarks.0.artifactPointer'],
    ['no result description', input => { input.result.remarks[0].description = '  '; }, 'result.remarks.0.description'],
    ['absent item', input => { delete input.result.remarks[0].constitutionPointer; }, 'result.remarks.0.constitutionPointer'],
    ['absent place', input => { delete input.result.remarks[0].artifactPointer; }, 'result.remarks.0.artifactPointer'],
    ['absent result description', input => { delete input.result.remarks[0].description; }, 'result.remarks.0.description'],
    ['recommendations alone cannot reject', input => { input.result.remarks = [recommendation()]; }, 'result.remarks'],
    ['conforms with a violation', input => { input.result.outcome = 'conforms'; }, 'result.remarks'],
    ['missing reason', input => { delete input.result.reason; }, 'result.reason'],
    ['blank reason', input => { input.result.reason = ''; }, 'result.reason'],
    ['missing remarks', input => { delete input.result.remarks; }, 'result.remarks'],
    ['paid result', input => { input.result.paid = true; }, 'result.paid'],
    ['accepted result', input => { input.result.accepted = true; }, 'result.accepted'],
    ['top-level accepted', input => { input.accepted = true; }, 'input.accepted'],
    ['paid remark', input => { input.result.remarks[0].paid = true; }, 'result.remarks.0.paid'],
    ['missing key', input => { delete input.key; }, 'input.key'],
    ['mixed extra outcome', input => { input.result.blocked = true; }, 'result.blocked'],
    ['unknown contract', input => { input.result.contract = 'keeper-result/v2'; }, 'result.contract'],
    ['unknown outcome', input => { input.result.outcome = 'recommendation'; }, 'result.outcome'],
    ['unknown remark', input => { input.result.remarks[0].kind = 'warning'; }, 'result.remarks.0.kind'],
  ];
  for (const [name, change, at] of cases) {
    const input = rejected(); change(input);
    assert.doesNotThrow(() => refused(input, at), name);
  }
  refused(null, 'input');
});

test('keeper result: pointers stay inside the exact selected material and obey RFC 6901 escaping and array indices', () => {
  assert.doesNotThrow(() => projectKeeperResult(rejected()), 'escaped slash, tilde and index resolve');
  const wholeArtifact = rejected(); wholeArtifact.result.remarks[0].artifactPointer = '';
  assert.doesNotThrow(() => projectKeeperResult(wholeArtifact), 'the empty pointer is the exact selected artifact');
  const objectKey = rejected(); objectKey.result.remarks[0].artifactPointer = '/01';
  assert.doesNotThrow(() => projectKeeperResult(objectKey), 'a leading zero is a legal object key');
  objectKey.result.remarks[0].artifactPointer = '/~01';
  assert.doesNotThrow(() => projectKeeperResult(objectKey), '~01 decodes once to the literal key ~1');
  const cases: [string, (input: Record<string, any>) => void, string][] = [
    ['missing artifact property', input => { input.result.remarks[0].artifactPointer = '/missing'; }, 'result.remarks.0.artifactPointer'],
    ['outside selected subtree', input => { input.result.remarks[0].artifactPointer = '/outside/shouldNotBeAddressable'; }, 'result.remarks.0.artifactPointer'],
    ['prototype property', input => { input.result.remarks[0].artifactPointer = '/__proto__'; }, 'result.remarks.0.artifactPointer'],
    ['bad escape', input => { input.result.remarks[0].artifactPointer = '/parts/0/a~2b'; }, 'result.remarks.0.artifactPointer'],
    ['dangling escape', input => { input.result.remarks[0].artifactPointer = '/parts/0/~'; }, 'result.remarks.0.artifactPointer'],
    ['no slash', input => { input.result.remarks[0].artifactPointer = 'parts'; }, 'result.remarks.0.artifactPointer'],
    ['leading zero index', input => { input.result.remarks[0].artifactPointer = '/parts/00'; }, 'result.remarks.0.artifactPointer'],
    ['negative index', input => { input.result.remarks[0].artifactPointer = '/parts/-1'; }, 'result.remarks.0.artifactPointer'],
    ['append index', input => { input.result.remarks[0].artifactPointer = '/parts/-'; }, 'result.remarks.0.artifactPointer'],
    ['out of bounds', input => { input.result.remarks[0].artifactPointer = '/parts/1'; }, 'result.remarks.0.artifactPointer'],
    ['unsafe index', input => { input.result.remarks[0].artifactPointer = '/parts/9007199254740992'; }, 'result.remarks.0.artifactPointer'],
    ['through scalar', input => { input.result.remarks[0].artifactPointer = '/count/value'; }, 'result.remarks.0.artifactPointer'],
    ['no constitution item', input => { input.result.remarks[0].constitutionPointer = '/missing'; }, 'result.remarks.0.constitutionPointer'],
    ['whole constitution is not an item', input => { input.result.remarks[0].constitutionPointer = ''; }, 'result.remarks.0.constitutionPointer'],
    ['constitution list is not an item', input => { input.result.remarks[0].constitutionPointer = '/consumers'; }, 'result.remarks.0.constitutionPointer'],
    ['missing selected artifact', input => { input.key.artifact.pointer = '/absent'; input.result.key = structuredClone(input.key); }, 'key.artifact.pointer'],
    ['missing selected constitution', input => { input.key.constitution.pointer = '/missing'; input.result.key = structuredClone(input.key); }, 'key.constitution.pointer'],
    ['a text is not a complete constitution', input => { input.key.constitution.pointer = '/outside'; input.result.key = structuredClone(input.key); }, 'key.constitution.pointer'],
  ];
  for (const [name, change, at] of cases) {
    const input = rejected(); change(input);
    assert.doesNotThrow(() => refused(input, at), name);
  }
});

test('keeper result: foreign pair, revision, hash, version and incomplete or changed full material cannot be substituted', () => {
  const cases: [string, (input: Record<string, any>) => void, string][] = [
    ['foreign answer project', input => { input.result.key.projectId = 'q'; }, 'result.key'],
    ['foreign answer revision', input => { input.result.key.artifact.container.revision++; }, 'result.key'],
    ['foreign answer hash', input => { input.result.key.constitution.container.hash = 'f'.repeat(64); }, 'result.key'],
    ['foreign answer pointer', input => { input.result.key.artifact.pointer = ''; }, 'result.key'],
    ['foreign answer version', input => { input.result.key.checkVersion = 'keeper-check/2'; }, 'result.key'],
    ['foreign material revision', input => { input.artifact.ref.revision++; }, 'artifact.ref'],
    ['foreign constitution id', input => { input.constitution.ref.id = 'another'; }, 'constitution.ref'],
    ['changed full artifact', input => { input.artifact.value.outside = null; }, 'artifact.value'],
    ['truncated constitution container', input => { delete input.constitution.value.outside; }, 'constitution.value'],
    ['missing material value', input => { delete input.artifact.value; }, 'artifact.value'],
    ['claimed material paid', input => { input.artifact.paid = true; }, 'artifact.paid'],
    ['claimed key accepted', input => { input.key.accepted = true; }, 'key'],
    ['moving version', input => { input.key.checkVersion = 'latest'; }, 'key'],
  ];
  for (const [name, change, at] of cases) {
    const input = rejected(); change(input);
    assert.doesNotThrow(() => refused(input, at), name);
  }
});

test('keeper result: changed exact revision, content hash or declared version changes the check identity', () => {
  const input = fixture(), original = projectKeeperResult(input);
  const revised = structuredClone(input);
  revised.key.artifact.container.revision++; revised.artifact.ref.revision++;
  revised.result.key = structuredClone(revised.key);
  assert.notEqual(projectKeeperResult(revised).checkId, original.checkId);
  assert.notEqual(projectKeeperResult(revised).resultId, original.resultId);
  const changed = structuredClone(input);
  changed.constitution.value.fields.final.constitution.goal = 'A different goal';
  const hash = hashJson(changed.constitution.value as Json);
  changed.key.constitution.container.hash = hash; changed.constitution.ref.hash = hash;
  changed.result.key = structuredClone(changed.key);
  assert.notEqual(projectKeeperResult(changed).checkId, original.checkId);
  assert.notEqual(projectKeeperResult(changed).resultId, original.resultId);
  const version = structuredClone(input); version.key.checkVersion = 'keeper-check/2';
  version.result.key = structuredClone(version.key);
  assert.notEqual(projectKeeperResult(version).checkId, original.checkId);
});

test('keeper result: one JSON snapshot isolates input, return values, identities and accessor reads', () => {
  const input = rejected();
  let reads = 0;
  Object.defineProperty(input.result, 'reason', { enumerable: true, configurable: true,
    get() { reads++; return reads === 1 ? 'original basis' : 'changed basis'; } });
  const projected = projectKeeperResult(input);
  const originalId = projected.resultId;
  assert.equal(reads, 1);
  assert.equal(projected.result.reason, 'original basis');
  input.artifact.value.selected.count = 42;
  input.result.remarks[0].description = 'changed by caller';
  assert.equal((projected.artifact.value as any).selected.count, 1);
  assert.equal(projected.result.remarks[0]!.description, 'The output does not reach the stated result');
  projected.result.remarks[0]!.description = 'changed projection';
  assert.equal(input.result.remarks[0].description, 'changed by caller');
  assert.equal(projected.resultId, originalId, 'id is a detached string');
});
