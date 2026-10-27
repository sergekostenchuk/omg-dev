import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { Store, type Revision } from '../src/storage/store.js';
import { runDiscoveryFinalExecution } from '../src/discovery/discovery-final-execution.js';
import { readDiscoveryFinalSessionAt } from '../src/discovery/discovery-final-session.js';
import { readDiscoveryFinalAssessmentSourceAt } from '../src/discovery/discovery-final-assessment-source.js';
import { readDiscoveryFinalAssessmentPaidResultAt } from '../src/discovery/discovery-final-assessment-execution.js';
import { V8_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

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
