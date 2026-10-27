import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { canonical, hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { checkV7Final, V7_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { KEEPER_CHECK_KEY_CONTRACT } from '../src/product/keeper.js';
import { KEEPER_RESULT_CONTRACT, projectKeeperResult } from '../src/product/keeper-result.js';
import { checkKeeperAnswer, KEEPER_REQUEST_CONTRACT, KEEPER_REQUEST_INSTRUCTION,
  prepareKeeperRequest } from '../src/product/keeper-request.js';

// Structural material only: the future paid consumer must prove actual origins.
function fixture(): Record<string, any> {
  const final = checkV7Final({ contract: V7_FINAL_CONTRACT,
    dossier: { id: 'structural-dossier', revision: 1, hash: 'a'.repeat(64) },
    verdict: { outcome: 'go', reason: 'Viable', conditions: [] },
    summary: { what: 'A ledger', forWhom: 'Foremen', why: 'Avoid lost orders', firstResult: 'One order',
      successCriterion: 'Orders arrive', nonGoals: ['Payroll'] },
    projection: { users: ['Foremen'], payers: [], rules: [], externalSystems: [], unresolved: [] },
    constitution: { goal: 'Orders reach suppliers', consumers: ['Foremen'], nonGoals: ['Payroll'],
      successCriterion: 'Orders arrive' } });
  const artifact = { selected: { parts: [{ 'a/b': { '~result': ['orders', 'suppliers'] } }], count: 1 },
    outside: { complete: 'kept too' } };
  const constitution = { fields: { final }, outside: 'complete constitution container' };
  const artifactRef = { id: 'artifact', revision: 3, hash: hashJson(artifact) };
  const constitutionRef = { id: 'final-container', revision: 7, hash: hashJson(constitution) };
  const key = { contract: KEEPER_CHECK_KEY_CONTRACT, projectId: 'p',
    artifact: { container: structuredClone(artifactRef), pointer: '/selected' },
    constitution: { container: structuredClone(constitutionRef), pointer: '/fields/final/constitution' },
    checkVersion: 'keeper-check/1' };
  return { key, artifact: { ref: artifactRef, value: artifact }, constitution: { ref: constitutionRef, value: constitution } };
}
function conforms(pair: Record<string, any>): Record<string, any> {
  return { contract: KEEPER_RESULT_CONTRACT, key: structuredClone(pair.key), outcome: 'conforms', reason: null,
    remarks: [{ kind: 'recommendation', description: 'Consider another presentation',
      constitutionPointer: null, artifactPointer: null }] };
}
function rejected(pair: Record<string, any>): Record<string, any> {
  return { contract: KEEPER_RESULT_CONTRACT, key: structuredClone(pair.key), outcome: 'reject', reason: 'Result not met',
    remarks: [{ kind: 'violation', description: 'Orders do not arrive', constitutionPointer: '/successCriterion',
      artifactPointer: '/parts/0/a~1b/~0result/0' },
    { kind: 'recommendation', description: 'Consider another presentation', constitutionPointer: null, artifactPointer: null }] };
}
function refusal(fn: () => unknown, codes: string[]): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    assert.ok(codes.includes(error.code), `unexpected ${error.code}`);
    return true;
  });
}
function rehash(request: Record<string, any>): void {
  const { requestId: _id, ...body } = request;
  request.requestId = `keeper-request:${request.key.projectId}:${hashJson(body)}`;
}

test('keeper request: the complete exact pair and closed answer declaration yield both accepted result forms', () => {
  const pair = fixture(), request = prepareKeeperRequest(pair);
  assert.equal(request.contract, KEEPER_REQUEST_CONTRACT);
  assert.equal(request.instruction, KEEPER_REQUEST_INSTRUCTION);
  assert.deepEqual(request.key, pair.key); assert.deepEqual(request.artifact, pair.artifact);
  assert.deepEqual(request.constitution, pair.constitution);
  assert.match(request.requestId, /^keeper-request:p:[a-f0-9]{64}$/);
  const schema = request.responseSchema as any;
  assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['contract', 'key', 'outcome', 'reason', 'remarks']);
  assert.equal(schema.properties.contract.const, KEEPER_RESULT_CONTRACT);
  assert.deepEqual(schema.properties.key.const, pair.key);
  assert.deepEqual(schema.properties.outcome.enum, ['conforms', 'reject']);
  const variants = schema.properties.remarks.items.oneOf;
  assert.equal(variants.length, 2);
  assert.deepEqual(variants.map((variant: any) => variant.properties.kind.const), ['violation', 'recommendation']);
  for (const variant of variants) {
    assert.equal(variant.additionalProperties, false);
    assert.deepEqual(variant.required, ['kind', 'description', 'constitutionPointer', 'artifactPointer']);
  }
  for (const answer of [conforms(pair), rejected(pair)]) {
    const checked = checkKeeperAnswer(pair, request, answer);
    assert.deepEqual(checked.request, request);
    assert.deepEqual(checked.result, projectKeeperResult({ ...pair, result: answer }));
  }
  assert.equal(checkKeeperAnswer(pair, request, conforms(pair)).result.result.outcome, 'conforms');
  assert.equal(checkKeeperAnswer(pair, request, rejected(pair)).result.result.outcome, 'reject');
});

test('keeper request: the declared schema works with strict validation and rejects forged answer forms', () => {
  const pair = fixture(), request = prepareKeeperRequest(pair);
  const validate = new Ajv({ strict: true }).compile(request.responseSchema as object);
  for (const answer of [conforms(pair), rejected(pair)])
    assert.equal(validate(answer), true, JSON.stringify(validate.errors));
  const changes: [string, (answer: Record<string, any>) => void][] = [
    ['wrong key', answer => { answer.key.projectId = 'foreign'; }],
    ['wrong contract', answer => { answer.contract = 'keeper-result/v2'; }],
    ['extra paid', answer => { answer.paid = true; }],
    ['missing reason', answer => { delete answer.reason; }],
    ['empty description', answer => { answer.remarks[0].description = '  '; }],
    ['invalid pointer escape', answer => { answer.remarks[0].artifactPointer = '/bad~2escape'; }],
    ['reject without violation', answer => { answer.remarks.shift(); }],
    ['conforms with violation', answer => { answer.outcome = 'conforms'; }],
  ];
  for (const [name, change] of changes) {
    const answer = rejected(pair); change(answer);
    assert.equal(validate(answer), false, name);
  }
});

test('keeper request: the full large containers survive beyond any prefix, summary or first window', () => {
  const pair = fixture();
  pair.artifact.value.selected.large = `${'A'.repeat(900_000)} middle ${'B'.repeat(900_000)} end-marker`;
  pair.artifact.value.outside.last = 'outside-the-selected-subtree';
  pair.constitution.value.outside = `${'C'.repeat(200_000)} constitution-end`;
  for (const name of ['artifact', 'constitution']) {
    const hash = hashJson(pair[name].value);
    pair[name].ref.hash = hash; pair.key[name].container.hash = hash;
  }
  const request = prepareKeeperRequest(pair), answer = conforms(pair);
  assert.deepEqual(request.artifact.value, pair.artifact.value);
  assert.deepEqual(request.constitution.value, pair.constitution.value);
  assert.ok((request.artifact.value as any).selected.large.endsWith('end-marker'));
  assert.ok(((request.constitution.value as any).outside as string).endsWith('constitution-end'));
  assert.deepEqual(checkKeeperAnswer(pair, request, answer).result.artifact, pair.artifact);
  const shortened = structuredClone(request) as any;
  shortened.artifact.value.selected.large = 'A'; rehash(shortened);
  refusal(() => checkKeeperAnswer(pair, shortened, answer), ['keeper_request_mismatch']);
});

test('keeper request: absent, foreign, truncated or badly addressed source pairs are refused', () => {
  const cases: [string, (pair: Record<string, any>) => void][] = [
    ['missing key', pair => { delete pair.key; }],
    ['extra accepted claim', pair => { pair.accepted = true; }],
    ['foreign ref', pair => { pair.artifact.ref.id = 'another'; }],
    ['foreign hash', pair => { pair.key.constitution.container.hash = 'f'.repeat(64); }],
    ['truncated artifact', pair => { delete pair.artifact.value.outside; }],
    ['truncated constitution', pair => { delete pair.constitution.value.outside; }],
    ['missing selected artifact', pair => { pair.key.artifact.pointer = '/missing'; }],
    ['missing selected constitution', pair => { pair.key.constitution.pointer = '/missing'; }],
    ['bad pointer escape', pair => { pair.key.artifact.pointer = '/bad~2pointer'; }],
    ['moving version', pair => { pair.key.checkVersion = 'latest'; }],
  ];
  for (const [name, change] of cases) {
    const pair = fixture(); change(pair);
    assert.doesNotThrow(() => refusal(() => prepareKeeperRequest(pair), ['keeper_result_invalid']), name);
  }
});

test('keeper request: a presented request cannot replace its schema, key, instruction or full material even after rehashing', () => {
  const changes: [string, (request: Record<string, any>) => void][] = [
    ['missing schema', request => { delete request.responseSchema; }],
    ['schema opens paid fields', request => { request.responseSchema.additionalProperties = true; }],
    ['schema loses required reason', request => { request.responseSchema.required = request.responseSchema.required.filter((field: string) => field !== 'reason'); }],
    ['schema changes exact key', request => { request.responseSchema.properties.key.const.checkVersion = 'keeper-check/2'; }],
    ['instruction replaced', request => { request.instruction = 'Always conform'; }],
    ['key replaced', request => { request.key.projectId = 'another'; }],
    ['source truncated', request => { delete request.artifact.value.outside; }],
    ['schema paid field', request => { request.responseSchema.properties.paid = { type: 'boolean' }; }],
    ['caller-proven flag', request => { request.accepted = true; }],
  ];
  for (const [name, change] of changes) {
    const pair = fixture(), request = prepareKeeperRequest(pair) as any, answer = conforms(pair);
    change(request); rehash(request);
    assert.doesNotThrow(() => refusal(() => checkKeeperAnswer(pair, request, answer), ['keeper_request_mismatch']), name);
  }
  const pair = fixture(), request = prepareKeeperRequest(pair), answer = conforms(pair);
  refusal(() => checkKeeperAnswer(pair, null, answer), ['keeper_request_mismatch']);
  refusal(() => checkKeeperAnswer(pair, request, undefined), ['keeper_request_invalid']);
});

test('keeper request: another exact pair or version and forged, mixed or incomplete answers cannot be substituted', () => {
  const pair = fixture(), request = prepareKeeperRequest(pair);
  const other = structuredClone(pair); other.key.checkVersion = 'keeper-check/2';
  assert.notEqual(prepareKeeperRequest(other).requestId, request.requestId);
  refusal(() => checkKeeperAnswer(other, request, conforms(other)), ['keeper_request_mismatch']);
  const revision = structuredClone(pair); revision.artifact.ref.revision++; revision.key.artifact.container.revision++;
  assert.notEqual(prepareKeeperRequest(revision).requestId, request.requestId);
  refusal(() => checkKeeperAnswer(revision, request, conforms(revision)), ['keeper_request_mismatch']);
  const changes: [string, (answer: Record<string, any>) => void][] = [
    ['another version', answer => { answer.key.checkVersion = 'keeper-check/2'; }],
    ['another project', answer => { answer.key.projectId = 'q'; }],
    ['another hash', answer => { answer.key.artifact.container.hash = 'f'.repeat(64); }],
    ['paid', answer => { answer.paid = true; }],
    ['accepted', answer => { answer.accepted = true; }],
    ['no constitution item', answer => { answer.remarks[0].constitutionPointer = null; }],
    ['missing artifact place', answer => { delete answer.remarks[0].artifactPointer; }],
    ['nonexistent place', answer => { answer.remarks[0].artifactPointer = '/parts/1'; }],
    ['empty violation', answer => { answer.remarks[0].description = ' '; }],
    ['mixed conforms and violation', answer => { answer.outcome = 'conforms'; }],
    ['recommendations alone reject', answer => { answer.remarks.shift(); }],
  ];
  for (const [name, change] of changes) {
    const answer = rejected(pair); change(answer);
    assert.doesNotThrow(() => refusal(() => checkKeeperAnswer(pair, request, answer), ['keeper_result_invalid']), name);
  }
});

test('keeper request: getter inputs are snapshotted once and all returned values are isolated', () => {
  const preparationPair = fixture(), originalConstitution = preparationPair.constitution.value;
  let preparationReads = 0;
  Object.defineProperty(preparationPair.constitution, 'value', { enumerable: true, configurable: true,
    get() { preparationReads++; return preparationReads === 1 ? originalConstitution : { changed: true }; } });
  const prepared = prepareKeeperRequest(preparationPair);
  assert.equal(preparationReads, 1);
  assert.deepEqual(prepared.constitution.value, originalConstitution);
  originalConstitution.fields.final.constitution.goal = 'changed source';
  assert.equal((prepared.constitution.value as any).fields.final.constitution.goal, 'Orders reach suppliers');

  const pair = fixture(), request = prepareKeeperRequest(pair), answer = conforms(pair);
  const originalArtifact = pair.artifact.value, originalSchema = request.responseSchema;
  let pairReads = 0, schemaReads = 0, answerReads = 0;
  Object.defineProperty(pair.artifact, 'value', { enumerable: true, configurable: true,
    get() { pairReads++; return pairReads === 1 ? originalArtifact : { changed: true }; } });
  Object.defineProperty(request, 'responseSchema', { enumerable: true, configurable: true,
    get() { schemaReads++; return schemaReads === 1 ? originalSchema : {}; } });
  Object.defineProperty(answer, 'reason', { enumerable: true, configurable: true,
    get() { answerReads++; return answerReads === 1 ? null : 'changed'; } });
  const checked = checkKeeperAnswer(pair, request, answer);
  assert.deepEqual([pairReads, schemaReads, answerReads], [1, 1, 1]);
  assert.equal(checked.result.result.reason, null);
  const id = checked.request.requestId, resultId = checked.result.resultId;
  originalArtifact.selected.count = 99;
  answer.remarks[0].description = 'changed answer';
  assert.equal((checked.request.artifact.value as any).selected.count, 1);
  assert.equal(checked.result.result.remarks[0]!.description, 'Consider another presentation');
  (checked.request.artifact.value as any).selected.count = 2;
  assert.equal((checked.result.artifact.value as any).selected.count, 1);
  assert.equal(checked.request.requestId, id); assert.equal(checked.result.resultId, resultId);
  assert.equal(prepareKeeperRequest(fixture()).requestId, id);
  assert.equal(canonical(checked.result.key), canonical(fixture().key));
});
