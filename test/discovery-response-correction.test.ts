import assert from 'node:assert/strict';
import test from 'node:test';
import { hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import type { Revision } from '../src/storage/store.js';
import { referenceSites } from '../src/storage/reference-sites.js';
import { readResponseCorrectionChain, type ResponseCorrectionReader } from '../src/discovery/response-correction.js';

type Step = { generation: number; previous: Ref | null; role: string;
  outcome: 'form' | 'transport' | 'valid' | 'pending' | 'provider-label-only' };
function fixture() {
  const rows: Revision<Step>[] = [];
  const append = (outcome: Step['outcome'], role = 'variant-proposal') => {
    const value: Step = { generation: rows.length, previous: rows.length ? reference(rows.at(-1)!) : null, role, outcome };
    const row: Revision<Step> = { id: `attempt:${rows.length}`, kind: 'test-attempt', revision: 1, hash: hashJson(value), value };
    rows.push(row); return row;
  };
  const reader: ResponseCorrectionReader<Step> = {
    read: ref => { const row = rows.find(row => row.id === ref.id); assert.ok(row); return row; },
    latest: () => rows.at(-1)!, previous: value => value.previous,
    follows: (before, after) => before.role === after.role && before.generation + 1 === after.generation,
    formFailure: row => row.value.outcome === 'form' ? new EngineError('form_invalid', 'Exact decoder refusal') : null,
    // A label cannot replace the role reader's proof of a response-free call.
    responseFreeFailure: row => row.value.outcome === 'transport',
  };
  return { rows, append, reader };
}
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;

test('L30: one correction retains its root across proved transport failures and closes on a paid answer', () => {
  const f = fixture(), root = f.append('form');
  assert.deepEqual(readResponseCorrectionChain(reference(root), f.reader).retry, reference(root));
  const transport = f.append('transport');
  const permission = readResponseCorrectionChain(reference(root), f.reader);
  assert.deepEqual(permission.retry, reference(transport));
  const answer = f.append('valid');
  const restored = readResponseCorrectionChain(reference(root), f.reader);
  assert.equal(restored.retry, null);
  assert.deepEqual(restored.chain.map(reference), [root, transport, answer].map(reference));
  assert.deepEqual(permission.retry, reference(transport), 'a captured entry permit must not follow a later generation');
});

test('L30: an invalid correcting answer is terminal even when selected as another root', () => {
  const f = fixture(), root = f.append('form');
  f.append('transport'); const correction = f.append('form');
  assert.equal(readResponseCorrectionChain(reference(root), f.reader).retry, null);
  assert.throws(() => readResponseCorrectionChain(reference(correction), f.reader), code('research_response_retry_invalid'));
  f.append('pending');
  assert.throws(() => readResponseCorrectionChain(reference(root), f.reader), code('research_response_retry_stale'));
});

test('L30: provider labels, a child role, and an unrelated position cannot extend a correction', () => {
  for (const substitute of ['provider-label-only', 'valid', 'pending'] as const) {
    const f = fixture(), root = f.append('form'); f.append(substitute); f.append('pending');
    assert.throws(() => readResponseCorrectionChain(reference(root), f.reader), code('research_response_retry_stale'));
  }
  const f = fixture(), root = f.append('form'); f.append('pending', 'escalation-assessor');
  assert.throws(() => readResponseCorrectionChain(reference(root), f.reader), code('research_response_retry_stale'));
});

test('L30: exact refusal revision and complete acyclic lineage are mandatory', () => {
  const f = fixture(), root = f.append('form');
  assert.throws(() => readResponseCorrectionChain({ ...reference(root), hash: 'f'.repeat(64) }, f.reader), code('research_response_retry_invalid'));
  const next = f.append('pending'); next.value.previous = reference(next);
  assert.throws(() => readResponseCorrectionChain(reference(root), f.reader), code('research_response_retry_stale'));
  next.value.previous = null;
  assert.throws(() => readResponseCorrectionChain(reference(root), f.reader), code('research_response_retry_stale'));
});

test('L30: all D7 correction proof links survive fsck enumeration while refused model JSON stays data', () => {
  const ref=(id:string):Ref=>({id,revision:1,hash:'a'.repeat(64)});
  const proof={root:ref('original'),call:ref('paid-call'),request:ref('request'),response:ref('response'),
    previousResponse:{forged:ref('payload-only')},validation:{lookalike:ref('validation-only')}};
  for(const kind of ['discovery-final-application','discovery-final-assessment-application',
    'discovery-condition-evidence-application']) {
    const value={contract:`${kind}/v1`,session:ref('session'),context:{failures:[proof]},
      responseCorrection:{contract:'application-response-correction/v1',root:ref('original'),
        previous:ref('transport'),generation:2,failure:proof}};
    const ids=new Set(referenceSites(kind,value).map(site=>site.ref.id));
    assert.deepEqual([...ids].sort(),['original','paid-call','request','response','session','transport']);
  }
});

test('L30: correction payload masks apply only to its declared era; history and unknown contracts keep their scan', () => {
  const ref=(id:string):Ref=>({id,revision:1,hash:'b'.repeat(64)});
  const value={contract:'research-consumer-intent/v1',cursor:{context:{failures:[{
    root:ref('proof'),previousResponse:{lookalike:ref('payload-only')}}]}}};
  assert.ok(referenceSites('research-consumer-intent',value).some(site=>site.ref.id==='payload-only'));
  const correction={...value,cursor:{...value.cursor,responseCorrection:ref('original')}};
  assert.deepEqual(referenceSites('research-consumer-intent',correction).map(site=>site.ref.id).sort(),['original','proof']);
  assert.ok(referenceSites('research-consumer-intent',{...correction,contract:'foreign/v1'})
    .some(site=>site.ref.id==='payload-only'));
  assert.ok(referenceSites('research-consumer-intent',{...value,cursor:{...value.cursor,responseCorrection:{id:'broken'}}})
    .some(site=>site.ref.id==='payload-only'));
});
