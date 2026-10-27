import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import type { Store } from '../src/storage/store.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { FinalAcceptanceSessions, acceptDiscoveryFinal, issueFinalAcceptanceInvitation } from '../src/product/owner-authority.js';
import { readDiscoveryConditionClassAt } from '../src/discovery/discovery-condition-class.js';
import { V8_FINAL_CONTRACT, V8_FINAL_SCHEMA } from '../src/discovery/v7-final-contracts.js';
import { projectDiscoveryFinalAssessment } from '../src/discovery/discovery-final-assessment-result.js';
import type { OmResult } from '../src/om/refusal.js';
import { finalAssessmentPaid, type FinalAssessmentSeedOptions } from './discovery-v7-final-assessment-seed.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

// DR7 7b.3-class (codex-omg2 №16183): the classed D7 form on the real paid path — a real paid D7 of discovery-final/v8
// with choice, boundary and risk owner conditions, its real paid assessment reviewing every class, the owner's
// acceptance and the historical reader of the proven class.
const option = (optionId: string, choice: 'accept' | 'decline', consequence: string) =>
  ({ optionId, label: `Option ${optionId}`, consequences: [consequence], choice });
const owner = (id: string, cls: string, reason: string) => ({ id, kind: 'owner_choice', condition: `The owner decides ${id}`,
  criterion: `The owner picks an option of ${id}`, class: cls, classReason: reason,
  options: [option(`${id}-yes`, 'accept', `${id} goes ahead`), option(`${id}-no`, 'decline', `${id} is dropped`)] });
const CLASSED = [
  { id: 'evidence-1', kind: 'evidence', condition: 'A source is available', criterion: 'A signed agreement' },
  owner('pick', 'choice', 'Both options stay inside the defined bundle'),
  owner('scope', 'boundary', 'Accepting widens the first release beyond the bounds'),
  owner('debt', 'risk', 'Accepting carries a new integration risk'),
];
const classed = (options: FinalAssessmentSeedOptions = {}) =>
  ({ outcome: 'conditional' as const, conditions: CLASSED, form: V8_FINAL_CONTRACT, ...options });
type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.refusal.code}: ${result.refusal.message}`);
  return (result as { ok: true; value: T }).value;
}
const money = (store: Store) => canonical(store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind))
  .flatMap(row => store.history(row.id)) as never);
async function quiet<T>(f: World, store: Store, action: () => Promise<T>): Promise<T> {
  const calls = money(store), sent = canonical(f.wires() as never);
  const value = await storeUnchanged(store, action);
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
  return value;
}
async function refused(f: World, store: Store, action: () => Promise<unknown>, code: string) {
  const calls = money(store), sent = canonical(f.wires() as never);
  await storeRefused(store, action, error => error instanceof EngineError && error.code === code);
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
}
/** The owner accepts the exact assessed bundle in questions mode. */
async function accept(f: World) {
  const mode = readProjectMode(f.store, 'p').ref, reason = 'The owner accepts the exact assessed bundle';
  const scope = { projectId: 'p', draft: f.packet.final.subject.basis.draft, paid: f.paidD7, assessment: f.paidResult,
    mode: { id: mode.id, revision: mode.revision, hash: mode.hash }, decision: 'accept', reason };
  const sessions = new FinalAcceptanceSessions(f.store);
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueFinalAcceptanceInvitation(f.store, scope)).invitation }));
  return (await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason },
    sessions.authority(login.bearer))).accepted!;
}

// The first test pays the first real construction of the classed seed; its own body stays small.
test('7b.3-class paid: a real paid D7 of discovery-final/v8 keeps its classes, and its paid assessment reviewed each one', async t => {
  const f = await finalAssessmentPaid(t, classed());
  const final = f.final.result.value, prepared = f.store.get<any>(f.final.prepared.id, f.final.prepared.revision)!;
  assert.equal(prepared.value.input.form, V8_FINAL_CONTRACT, 'the version is fixed in the immutable preparation before payment');
  // The model and the assessor were given the classed forms: the D7 schema of v8 and the class review of every condition.
  assert.deepEqual(prepared.value.envelope.packet.schema.properties.bundle, V8_FINAL_SCHEMA);
  const review = f.store.get<any>(f.prepared.id, f.prepared.revision)!.value.envelope.packet.schema.properties.classes;
  assert.equal(review.minItems, 3); assert.equal(review.maxItems, 3);
  assert.equal(final.projection.result.bundle.contract, V8_FINAL_CONTRACT);
  assert.deepEqual(final.projection.result.bundle.verdict.conditions, CLASSED, 'the model classes and reasons, verbatim');
  assert.equal(f.result.value.projection.verdict, 'supported');
  assert.deepEqual(f.result.value.projection.result.classes!.map(review => [review.conditionId, review.class, review.judgement]),
    [['pick', 'choice', 'confirmed'], ['scope', 'boundary', 'confirmed'], ['debt', 'risk', 'confirmed']]);
});

test('7b.3-class review form: the answer reviews exactly the classes of the candidate; supported confirms every one', async t => {
  const f = await finalAssessmentPaid(t, classed()), packet = f.packet, answer = f.result.value.projection.result;
  const project = (change: (value: any) => void) => () => {
    const value = structuredClone(answer) as any; change(value);
    return projectDiscoveryFinalAssessment({ packet, result: value });
  };
  assert.deepEqual(project(() => {})().result, answer, 'the paid answer projects again unchanged');
  for (const [label, change] of [
    ['a supported answer with a rejected class', (value: any) => { value.classes[1].judgement = 'rejected'; }],
    ['no class review', (value: any) => { delete value.classes; }],
    ['a review of another class', (value: any) => { value.classes[0].class = 'risk'; }],
    ['reviews in another order', (value: any) => { value.classes.reverse(); }],
    ['a missing review', (value: any) => { value.classes.pop(); }],
    ['an unknown judgement', (value: any) => { value.classes[2].judgement = 'maybe'; }],
    ['a review without its reason', (value: any) => { value.classes[0].reason = ' '; }],
  ] as const)
    assert.throws(project(change), (error: unknown) => error instanceof EngineError && error.code === 'discovery_final_assessment_result_invalid', label);
});

test('7b.3-class reader: the proven class of each owner condition of the accepted bundle, read hot and cold without writes', async t => {
  const f = await finalAssessmentPaid(t, classed()), accepted = await accept(f), manifest = reference(accepted.manifest);
  for (const [id, cls] of [['pick', 'choice'], ['scope', 'boundary'], ['debt', 'risk']] as const) {
    const read = await quiet(f, f.store, () => readDiscoveryConditionClassAt(f.store, 'p', manifest, id));
    assert.equal(read.class, cls); assert.equal(read.review.judgement, 'confirmed');
    assert.deepEqual(read.condition, CLASSED.find(condition => condition.id === id), 'the exact condition with its options and consequences');
    assert.deepEqual(read.bundle, accepted.bundle); assert.deepEqual(read.grounds.assessment, f.paidResult);
  }
  const cold = f.open();
  assert.deepEqual(await quiet(f, cold, () => readDiscoveryConditionClassAt(cold, 'p', manifest, 'scope')),
    await readDiscoveryConditionClassAt(f.store, 'p', manifest, 'scope'));
  await refused(f, f.store, () => readDiscoveryConditionClassAt(f.store, 'p', manifest, 'evidence-1'), 'discovery_condition_not_owner_choice');
  await refused(f, f.store, () => readDiscoveryConditionClassAt(f.store, 'p', manifest, 'missing'), 'discovery_condition_class_invalid');
  await refused(f, f.store, () => readDiscoveryConditionClassAt(f.store, 'p', manifest, ''), 'discovery_condition_class_invalid');
});

test('7b.3-class return: a paid assessment rejecting the classes is an addressed return, and its bundle is never accepted', async t => {
  const f = await finalAssessmentPaid(t, classed({ verdict: 'return' }));
  assert.equal(f.result.value.projection.verdict, 'return');
  assert.deepEqual(f.result.value.projection.result.classes!.map(review => review.judgement), ['rejected', 'rejected', 'rejected']);
  await refused(f, f.store, () => acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason: 'x' }),
    'discovery_acceptance_not_supported');
});

test('7b.3-class legacy: an owner condition of an accepted discovery-final/v7 bundle has no class and is never read as a choice', async t => {
  const legacy = CLASSED.map(({ class: _class, classReason: _reason, ...condition }: any) => condition);
  const f = await finalAssessmentPaid(t, { outcome: 'conditional', conditions: legacy }), accepted = await accept(f);
  assert.equal(accepted.bundle.value.bundle.contract, 'discovery-final/v7');
  assert.equal(f.result.value.projection.result.classes, undefined, 'a v7 answer has no class review');
  assert.throws(() => projectDiscoveryFinalAssessment({ packet: f.packet, result: { ...f.result.value.projection.result, classes: [] } }),
    (error: unknown) => error instanceof EngineError && error.code === 'discovery_final_assessment_result_invalid', 'a v7 answer never reviews classes');
  await refused(f, f.store, () => readDiscoveryConditionClassAt(f.store, 'p', reference(accepted.manifest), 'pick'), 'discovery_condition_class_unproven');
});
