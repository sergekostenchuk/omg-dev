import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { Store, type Revision } from '../src/storage/store.js';
import { runDiscoveryFinalExecution } from '../src/discovery/discovery-final-execution.js';
import { readDiscoveryFinalSessionAt } from '../src/discovery/discovery-final-session.js';
import { readDiscoveryFinalAssessmentSourceAt } from '../src/discovery/discovery-final-assessment-source.js';
import { V8_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { finalPaid } from './discovery-v7-final-paid-seed.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { researchCall, resumeDiscoveryFinalAssessmentResearchCall } from '../src/discovery/research-protocol.js';
import { prepareDiscoveryFinalAssessmentSubject } from '../src/discovery/discovery-final-assessment-subject.js';
import { prepareDiscoveryFinalAssessmentSession } from '../src/discovery/discovery-final-assessment-session.js';
import { DISCOVERY_FINAL_ASSESSMENT_RESULT } from '../src/discovery/discovery-final-assessment-result.js';
import { discoveryFinalAssessmentExecutionId, readDiscoveryFinalAssessmentDispatchAdmission, readDiscoveryFinalAssessmentExecutionAt,
  readDiscoveryFinalAssessmentPaidResultAt, runDiscoveryFinalAssessmentExecution } from '../src/discovery/discovery-final-assessment-execution.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';
import { whileHidden } from './hidden-record.js';

// DR7 7b.3-class (codex-omg2 №16183): the recovery of both D7 contracts — a classed discovery-final/v8 world and the
// historical discovery-final/v7 one restore free of charge, hot and cold — and the refusal of a substituted version or
// class under the same or a recomputed Ref, without writes, calls or payments.
const option = (optionId: string, choice: 'accept' | 'decline') => ({ optionId, label: optionId, consequences: [`${optionId} follows`], choice });
const CLASSED = [
  { id: 'evidence-1', kind: 'evidence', condition: 'A source is available', criterion: 'A signed agreement' },
  { id: 'pick', kind: 'owner_choice', condition: 'The owner picks', criterion: 'An option is picked', class: 'choice',
    classReason: 'Both options stay inside the bundle', options: [option('pick-yes', 'accept'), option('pick-no', 'decline')] },
];
type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
const money = (store: Store) => canonical(store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind))
  .flatMap(row => store.history(row.id)) as never);
async function quiet<T>(f: World, store: Store, action: () => Promise<T>): Promise<T> {
  const calls = money(store), sent = canonical(f.wires() as never);
  const value = await storeUnchanged(store, action);
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
  return value;
}
async function refused(f: World, store: Store, action: () => Promise<unknown>) {
  const calls = money(store), sent = canonical(f.wires() as never);
  await storeRefused(store, action, error => error instanceof EngineError);
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
}
/** The whole product history — heads, revisions, events — with the calls, the ledger and the wire, unchanged by an action. */
function history(store: Store): string {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    const digest = createHash('sha256');
    for (const query of ['SELECT * FROM heads ORDER BY entity_id', 'SELECT * FROM revisions ORDER BY entity_id,revision',
      'SELECT * FROM events ORDER BY sequence']) {
      digest.update(query);
      for (const row of db.prepare(query).iterate()) for (const [key, value] of Object.entries(row)) {
        const text = String(value);
        digest.update(key).update(typeof value).update(`${Buffer.byteLength(text)}:`).update(text);
      }
    }
    return digest.digest('hex');
  } finally { db.close(); }
}
async function fixed<T>(f: { wires(): unknown[] }, store: Store, action: () => Promise<T>): Promise<T> {
  const before = history(store), calls = money(store), sent = canonical(f.wires() as never);
  const value = await storeUnchanged(store, action);
  assert.equal(history(store), before); assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
  return value;
}
/** An exact revision of the genuine Store answered differently while the action runs; its proof cache stays in use. */
async function masked<T>(store: Store, row: Revision<unknown>, action: () => Promise<T>): Promise<T> {
  const get = Store.prototype.get;
  Store.prototype.get = function (this: Store, id: string, revision?: number) {
    return this === store && id === row.id && (revision === undefined || revision === row.revision) ? row : get.call(this, id, revision);
  } as typeof get;
  try { return await action(); } finally { Store.prototype.get = get; }
}
/** Both paid contracts of a world restore without a new call: the D7 and its assessment, hot and on a cold Store. */
async function restoresFree(f: World) {
  for (const store of [f.store, f.open()]) {
    const final = await quiet(f, store, () => runDiscoveryFinalExecution(store, 'p', f.final.prepared, { restoreOnly: true }));
    assert.deepEqual(final.output, f.final.result);
    const assessment = await quiet(f, store, () => f.restore(store));
    assert.deepEqual(assessment.output, f.result);
  }
}

// The first test pays the first real construction of the classed seed; its own body stays small.
test('7b.3-class recovery: a classed paid D7 and its paid assessment restore free of charge, hot and cold', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'conditional', conditions: CLASSED, form: V8_FINAL_CONTRACT });
  await restoresFree(f);
});

test('7b.3-class bounded recovery: a paid multi-page assessment of a v8 candidate survives a lost early response and resumes on its claim', async t => {
  // A real paid v8 D7 over the partial dossier of the shared lazy seed; the assessment is prepared here with a small wire.
  const f = await finalPaid(t, 'conditional', 'partial', CLASSED, V8_FINAL_CONTRACT);
  const bundle = f.result.value.projection.result.bundle;
  const packet = await prepareDiscoveryFinalAssessmentSubject(f.store, 'p', f.d6, bundle);
  f.reply({ action: 'answer', question: 'reader', value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'Calibration' }, citations: [] });
  await researchCall(f.environment.value.reviewer, f.environment.value, 'Measure the independent reviewer', {}, undefined,
    { store: f.store, draftId: f.data.calibration.draft.id, questionId: f.data.calibration.question.id, purpose: 'assessor' });
  const cell = await prepareDiscoveryFinalAssessmentSession(f.store, 'p', packet.subject, { prompt: 'Small bounded pages',
    packetChars: 64_000, limitChars: 400_000, resultLimitChars: 10_000_000, environment: reference(f.environment), role: f.environment.value.reviewer });
  const prepared = reference(cell);
  assert.deepEqual(cell.value.subject.candidate.verdict.conditions, CLASSED, 'the complete classed candidate is the subject');
  f.reply({ contract: DISCOVERY_FINAL_ASSESSMENT_RESULT, subject: packet.subject, verdict: 'supported', reasons: ['Reviewed'],
    bases: [{ candidate: '/verdict' }], return: null, classes: [{ conditionId: 'pick', class: 'choice', judgement: 'confirmed',
      reason: 'The options stay inside the bundle', bases: [{ candidate: '/verdict/conditions/1' }] }] });
  const calls = () => f.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'discovery-final-assessment'
    && canonical((row.value as unknown as Record<string, any>).finalContinuation?.prepared) === canonical(prepared));
  const start = f.wires().length, original = Store.prototype.writeMany;
  let claims = 0;
  Store.prototype.writeMany = function (this: Store, ...args: Parameters<Store['writeMany']>) {
    const cut = this === f.store && args[0].some(row => row.kind === 'model-call' && row.expected === 0) && ++claims === 3;
    const value = original.apply(this, args);
    if (cut) throw new Error('cut-after-third-reservation');
    return value;
  } as Store['writeMany'];
  try {
    await assert.rejects(() => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { profile: f.profile }),
      /cut-after-third-reservation/);
  } finally { Store.prototype.writeMany = original; }
  const wires = f.wires().slice(start) as Record<string, any>[];
  assert.equal(wires.length, 2, 'two real paid bounded pages before the next claim');
  const delivered = JSON.stringify(wires);
  for (const condition of CLASSED.filter(item => item.kind === 'owner_choice') as Record<string, any>[])
    for (const text of [condition.classReason, ...condition.options.flatMap((item: any) => item.consequences)])
      assert.ok(delivered.includes(JSON.stringify(text).slice(1, -1)), `the reviewer was delivered ${text}`);
  const active = calls().find(row => row.value.status === 'running');
  const prior = calls().filter(row => row.value.status === 'succeeded').sort((a, b) => a.value.startedAt - b.value.startedAt)[0];
  assert.ok(active && prior && active.value.execution?.phase === 'claimed', 'the next claim is kept before its send');
  const missing = f.store.get(`model-response:${prior.value.requestId}`)!;
  const cursor = f.store.get(discoveryFinalAssessmentExecutionId(f.paidResult, prepared))!;
  const application = (active.value as unknown as Record<string, any>).finalAssessmentApplication as Ref;
  assert.ok(missing && cursor && application);
  // The first real response hidden: history, admission and a direct resume refuse, typed, with no send, payment or write;
  // the claim stays claimed. The genuine Store answers without that record, so its proofs are derived once and kept
  // across the three doors, as in production.
  const lost = (error: unknown) => error instanceof EngineError && error.code === 'response_recovery_wire_invalid';
  await whileHidden(f.store, { id: missing.id, revision: missing.revision }, null, () => fixed(f, f.store, async () => {
    await assert.rejects(() => readDiscoveryFinalAssessmentExecutionAt(f.store, 'p', reference(cursor)), lost);
    await assert.rejects(() => readDiscoveryFinalAssessmentDispatchAdmission(f.store, application), lost);
    await assert.rejects(() => resumeDiscoveryFinalAssessmentResearchCall(f.store, application), lost);
    assert.deepEqual(f.store.get(active.id), active);
  }));
  // The same history door through an opaque read-only view: no proof is kept across its reads, the whole history of the
  // paid run is derived again (about ten seconds), so one door stands for that path.
  const view = new Proxy(f.store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) =>
      id === missing.id && (revision === undefined || revision === missing.revision) ? null : f.store.get(id, revision);
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await fixed(f, f.store, async () => {
    await assert.rejects(() => readDiscoveryFinalAssessmentExecutionAt(view, 'p', reference(cursor)), lost);
    assert.deepEqual(f.store.get(active.id), active);
  });
  // On the real Store the same claim continues; its paid response is applied, and the saved run restores free of
  // charge, hot and cold, at one fixed point.
  await resumeDiscoveryFinalAssessmentResearchCall(f.store, application);
  assert.equal(f.wires().length, start + 3, 'the kept claim is the one sent');
  const paid = money(f.store), sent = canonical(f.wires() as never);
  const restored = await runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { restoreOnly: true, allowance: 0 });
  assert.equal(money(f.store), paid, 'applying the saved response pays nothing'); assert.equal(canonical(f.wires() as never), sent);
  for (const store of [f.store, f.open()])
    assert.deepEqual((await fixed(f, store, () => runDiscoveryFinalAssessmentExecution(store, 'p', f.paidResult, prepared,
      { restoreOnly: true, allowance: 0 }))).result, restored.result);
});

test('7b.3-class recovery of history: a discovery-final/v7 world restores free of charge under its own unchanged preparation', async t => {
  const f = await finalAssessmentPaid(t);
  const prepared = f.store.get<any>(f.final.prepared.id, f.final.prepared.revision)!;
  assert.equal(Object.hasOwn(prepared.value.input, 'form'), false, 'the v7 preparation names no form');
  assert.equal(f.final.result.value.projection.result.bundle.contract, 'discovery-final/v7');
  await restoresFree(f);
});

test('7b.3-class substitution: another version or class under the same or a recomputed Ref is refused without writes', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'conditional', conditions: CLASSED, form: V8_FINAL_CONTRACT });
  const variants = <T>(row: Revision<T>, change: (value: any) => void) => {
    const value = structuredClone(row.value) as any; change(value);
    return [{ ...row, value }, { ...row, value, hash: hashJson(value as Json) }];
  };
  // The paid D7 result with the class of its owner condition changed.
  for (const row of variants(f.final.result, value => { value.projection.result.bundle.verdict.conditions[1].class = 'boundary'; }))
    await refused(f, f.store, () => masked(f.store, row, () => readDiscoveryFinalAssessmentSourceAt(f.store, 'p',
      { id: row.id, revision: row.revision, hash: row.hash })));
  // The prepared session with its version removed: the preparation of v7 is not the one that was paid.
  const session = f.store.get<any>(f.final.prepared.id, f.final.prepared.revision)!;
  for (const row of variants(session, value => { delete value.input.form; }))
    await refused(f, f.store, () => masked(f.store, row, () => readDiscoveryFinalSessionAt(f.store, 'p',
      { id: row.id, revision: row.revision, hash: row.hash })));
  // The paid assessment with a class review turned into a rejection.
  for (const row of variants(f.result, value => { value.projection.result.classes[0].judgement = 'rejected'; }))
    await refused(f, f.store, () => masked(f.store, row, () => readDiscoveryFinalAssessmentPaidResultAt(f.store, 'p',
      { id: row.id, revision: row.revision, hash: row.hash })));
});
