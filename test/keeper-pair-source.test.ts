import test from 'node:test';
import assert from 'node:assert/strict';
import { hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { acceptDiscoveryFinal } from '../src/product/owner-authority.js';
import { readKeeperPairSourceAt } from '../src/product/keeper-pair-source.js';
import { keeperCheckKey } from '../src/product/keeper.js';
import { finalAssessmentPaid, type FinalAssessmentSeedOptions } from './discovery-v7-final-assessment-seed.js';
import { modeOf, money, all } from './discovery-v7-dossier-seed.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { storeUnchanged, storeRefused } from './store-unchanged.js';

type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
/** Normal era-six stage producers, evidence and acceptance; no fabricated accepted stage or no-op validator. The D7
 * and its supported assessment are the genuinely paid seed. Their exact historical manifest survives this new draft. */
function artifact(f: World) {
  const source = f.engine.discovery.evidence.document('p', 'keeper-stage-brief', 'Stage material for the accepted product', 'text/plain', 0);
  const draft = f.engine.prepare('p', 'discovery');
  for (const id of draft.value.questions) {
    const question = f.store.get<Question>(id)!;
    if (question.value.spec.kind === 'fact') f.engine.discovery.fact(id, question.revision, reference(source),
      { kind: 'text-range', start: 0, end: source.value.content.length });
    else if (['researchPlan', 'researchReport', 'verdict', 'preparation'].includes(question.value.spec.field))
      answerDiscoveryFixture(f.engine, 'p', f.store.get<DiscoveryDraft>(draft.id)!, question, preparedField('p', question.value.spec.field), source);
    else f.engine.discovery.decision(id, question.revision, 'owner', preparedField('p', question.value.spec.field));
  }
  const row = f.engine.draft('p', 'discovery', draft.id, 0);
  return f.engine.pipeline.accept('p', 'discovery', row.revision);
}
async function world(t: test.TestContext, options: FinalAssessmentSeedOptions = {}) {
  const f = await finalAssessmentPaid(t, options); modeOf(f.store, 'bypass');
  const accepted = await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult,
    decision: 'accept', reason: 'Accept exact assessed product' });
  assert.ok(accepted.accepted);
  return { f, stage: artifact(f), manifest: reference(accepted.accepted.manifest) };
}
async function quiet<T>(f: World, action: () => Promise<T>) {
  const finances = money(f.store), wire = structuredClone(f.wires());
  const value = await storeUnchanged(f.store, action);
  assert.deepEqual(money(f.store), finances); assert.deepEqual(f.wires(), wire); return value;
}
async function refused(f: World, action: () => Promise<unknown>, code?: string) {
  const finances = money(f.store), wire = structuredClone(f.wires());
  await storeRefused(f.store, action, e => e instanceof EngineError && (!code || e.code === code));
  assert.deepEqual(money(f.store), finances); assert.deepEqual(f.wires(), wire);
}

test('keeper pair: a genuine paid D7 or paid assessment is not an accepted stage artifact', async t => {
  const f = await finalAssessmentPaid(t);
  await refused(f, () => readKeeperPairSourceAt(f.store, 'p', f.paidD7, f.paidResult, 'test/v1'));
});

test('keeper pair: exact full accepted sources and check key survive later heads hot/cold without writes', async t => {
  const { f, stage, manifest } = await world(t), at = reference(stage);
  const source = await quiet(f, () => readKeeperPairSourceAt(f.store, 'p', at, manifest, 'test/v1'));
  assert.equal(source.checkId, keeperCheckKey(source.pair.key));
  assert.deepEqual(source.pair.key.artifact, { container: at, pointer: '/content' });
  assert.deepEqual(source.pair.key.constitution, source.constitution.address);
  assert.deepEqual(source.pair.artifact.value, stage.value);
  assert.deepEqual(source.pair.constitution.value, source.constitution.container.value);
  assert.equal(hashJson(source.pair.artifact.value), at.hash);
  assert.equal(hashJson(source.pair.constitution.value), source.pair.key.constitution.container.hash);
  const original = structuredClone(source);
  source.artifact.content = null; source.pair.artifact.value = null; source.constitution.constitution.goal = 'caller';
  f.store.write({ id: stage.id, kind: 'stage', expected: stage.revision, value: { ...stage.value, status: 'draft' } });
  const before = all(f.store), finances = money(f.store), wire = structuredClone(f.wires()), cold = f.open();
  assert.deepEqual(await quiet(f, () => readKeeperPairSourceAt(f.store, 'p', at, manifest, 'test/v1')), original);
  assert.deepEqual(await storeUnchanged(cold, () => readKeeperPairSourceAt(cold, 'p', at, manifest, 'test/v1')), original);
  assert.equal(all(cold), before); assert.deepEqual(money(cold), finances); assert.deepEqual(f.wires(), wire);
});

test('keeper pair: conditional remains conditional with unknowns and unresolved conditions, not admission', async t => {
  const { f, stage, manifest } = await world(t, { outcome: 'conditional' });
  const source = await quiet(f, () => readKeeperPairSourceAt(f.store, 'p', reference(stage), manifest, 'test/v1'));
  assert.equal(source.constitution.container.value.bundle.verdict.outcome, 'conditional');
  assert.ok(source.constitution.container.value.bundle.verdict.conditions.length);
  assert.deepEqual(source.pair.constitution.value, source.constitution.container.value);
});

test('keeper pair: accepted negative D7 has no constitution and cannot become a Keeper pair', async t => {
  const { f, stage, manifest } = await world(t, { outcome: 'no_go' });
  await refused(f, () => readKeeperPairSourceAt(f.store, 'p', reference(stage), manifest, 'test/v1'), 'keeper_constitution_absent');
});

test('keeper pair: insufficient evidence preserves nonempty partial and its missing constitution', async t => {
  const { f, stage, manifest } = await world(t, { outcome: 'insufficient_evidence', route: 'partial' });
  assert.ok(f.final.packet.dossier.materials.length);
  await refused(f, () => readKeeperPairSourceAt(f.store, 'p', reference(stage), manifest, 'test/v1'), 'keeper_constitution_absent');
});

test('keeper pair: one snapshot of both external refs; missing/foreign/flags/narrowed pair and moving version refuse', async t => {
  const { f, stage, manifest } = await world(t), at = reference(stage), reads: number[] = [];
  const changing = (ref: Ref) => Object.fromEntries(Object.keys(ref).map(key => [key, ref[key as keyof Ref]]));
  const a = changing(at), m = changing(manifest);
  for (const [index, ref, value] of [[0, at, a], [3, manifest, m]] as const)
    (Object.keys(ref) as (keyof Ref)[]).forEach((key, i) => Object.defineProperty(value, key, { enumerable: true,
      get() { reads[index + i] = (reads[index + i] ?? 0) + 1; return reads[index + i] === 1 ? ref[key] : null; } }));
  const source = await quiet(f, () => readKeeperPairSourceAt(f.store, 'p', a, m, 'test/v1'));
  assert.deepEqual(reads, [1, 1, 1, 1, 1, 1]);
  for (const [artifactRef, manifestRef, version] of [[null, manifest, 'test/v1'], [at, null, 'test/v1'],
    [{ ...at, accepted: true }, manifest, 'test/v1'], [at, { ...manifest, hash: '0'.repeat(64) }, 'test/v1'],
    [source.pair, manifest, 'test/v1'], [{ ...at, pointer: '/content/fields' }, manifest, 'test/v1'], [at, manifest, 'latest']] as const)
    await refused(f, () => readKeeperPairSourceAt(f.store, 'p', artifactRef, manifestRef, version));
  await refused(f, () => readKeeperPairSourceAt(f.store, 'other', at, manifest, 'test/v1'));
});
