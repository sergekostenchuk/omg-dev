import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashJson } from '../src/canonical.js';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { EngineError } from '../src/errors.js';
import { reference, stageId, type Ref } from '../src/pipeline/contracts.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { readAcceptedUpstreamStageAt, prepareOmInput, type InputRequest } from '../src/om/input.js';
import { currentUpstreamFixtureValue, answerDiscoveryFixture } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { storeUnchanged } from './store-unchanged.js';

function world(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'keeper-stage-prefix-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store); engine.execute({ type: 'create-project', project: 'p', title: 'Prefix' });
  writeFileSync(join(root, 'brief.txt'), 'The exact original brief');
  const source = engine.discovery.evidence.file('p', 'brief', root, 'brief.txt', 'text/plain', 0);
  const accept = (stage: 'discovery' | 'concept') => {
    const draft = engine.prepare('p', stage);
    for (const id of draft.value.questions) {
      const question = store.get<Question>(id)!;
      if (question.value.spec.kind === 'fact') engine.discovery.fact(id, question.revision, reference(source),
        { kind: 'text-range', start: 0, end: source.value.content.length });
      else {
        const value = currentUpstreamFixtureValue(engine, 'p', question.value.spec.field, preparedField('p', question.value.spec.field));
        if (stage === 'discovery' && ['researchPlan', 'researchReport', 'verdict', 'preparation'].includes(question.value.spec.field))
          answerDiscoveryFixture(engine, 'p', store.get<DiscoveryDraft>(draft.id)!, question, value, source);
        else engine.discovery.decision(id, question.revision, 'owner', value);
      }
    }
    const row = engine.draft('p', stage, draft.id, store.get(stageId('p', stage))?.revision ?? 0);
    return engine.pipeline.accept('p', stage, row.revision);
  };
  return { root, store, engine, source, accept };
}
const fails = (fn: () => unknown) => assert.throws(fn, e => e instanceof EngineError && e.code === 'stage_history_invalid');
function overlay(store: Store, target: Ref, replacement: unknown): Store {
  return new Proxy(store, { get(base, key) {
    if (key === 'get') return (id: string, revision?: number) => id === target.id && (revision === undefined || revision === target.revision)
      ? replacement : base.get(id, revision);
    const value = Reflect.get(base, key); return typeof value === 'function' ? value.bind(base) : value;
  } });
}

test('upstream prefix: genuine early acceptances need no future stages and survive late heads and file changes hot/cold', async t => {
  const f = world(t), discovery = f.accept('discovery');
  assert.equal(f.store.get(stageId('p', 'features')), null);
  const early = await storeUnchanged(f.store, () => readAcceptedUpstreamStageAt(f.store, 'p', 'discovery', reference(discovery)));
  assert.deepEqual(early.artifact, discovery);
  const concept = f.accept('concept'), ref = reference(concept);
  const initial = await storeUnchanged(f.store, () => readAcceptedUpstreamStageAt(f.store, 'p', 'concept', ref));
  assert.ok(initial.grounds.some(at => canonical(at) === canonical(reference(discovery))));
  writeFileSync(join(f.root, 'brief.txt'), 'late external file');
  f.store.write({ id: discovery.id, kind: 'stage', expected: discovery.revision, value: { ...discovery.value, status: 'draft' } });
  assert.equal(f.engine.pipeline.inspect('p', 'concept').state, 'stale');
  const cold = new Store(f.store.path); t.after(() => cold.close());
  for (const store of [f.store, cold])
    assert.deepEqual(await storeUnchanged(store, () => readAcceptedUpstreamStageAt(store, 'p', 'concept', ref)), initial);
});

test('upstream prefix: missing/substituted proof, foreign stage, rehashed mixed or cyclic chain cannot prove acceptance', async t => {
  const f = world(t); f.accept('discovery'); const concept = f.accept('concept'), ref = reference(concept);
  const later = f.accept('discovery');
  await storeUnchanged(f.store, () => {
    fails(() => readAcceptedUpstreamStageAt(f.store, 'other', 'concept', ref));
    fails(() => readAcceptedUpstreamStageAt(f.store, 'p', 'discovery', ref));
    for (const bad of [null, { ...ref, accepted: true }, { ...ref, hash: '0'.repeat(64) }])
      fails(() => readAcceptedUpstreamStageAt(f.store, 'p', 'concept', bad));
    const proof = concept.value.proofs.find(at => at.id.startsWith('discovery:'))!;
    assert.ok(proof);
    fails(() => readAcceptedUpstreamStageAt(overlay(f.store, proof, null), 'p', 'concept', ref));
    const body = f.store.get(proof.id, proof.revision)!;
    fails(() => readAcceptedUpstreamStageAt(overlay(f.store, proof, { ...body, id: 'alien' }), 'p', 'concept', ref));
    for (const inputs of [[ref], [], [reference(later)], [{ ...concept.value.inputs[0]!, id: stageId('other', 'discovery') }]]) {
      const value = { ...concept.value, inputs }, forged = { ...concept, value, hash: hashJson(value) };
      fails(() => readAcceptedUpstreamStageAt(overlay(f.store, ref, forged), 'p', 'concept', reference(forged)));
    }
  });
});

test('upstream prefix: complete OM admission still refuses shortened and mismatched caller inventories', async t => {
  const f = world(t), discovery = f.accept('discovery'), concept = f.accept('concept');
  for (const stages of [{ discovery: reference(discovery), concept: reference(concept) },
    { discovery: reference(concept), concept: reference(discovery) }]) {
    const result = await storeUnchanged(f.store, () => prepareOmInput(f.store,
      { project: 'p', stages, expected: 0 } as InputRequest));
    assert.equal(result.ok, false);
  }
});
