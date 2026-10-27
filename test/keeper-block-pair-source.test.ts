import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { configurePhasePolicy, phasePolicy } from '../src/discovery/phase-policy.js';
import { UPSTREAM_STAGES } from '../src/discovery/requirements.js';
import { projectGraph } from '../src/graph/project.js';
import { designOf } from '../src/graph/builder.js';
import type { Graph } from '../src/graph/model.js';
import type { FrameCandidateRecord } from '../src/om/frame-candidate.js';
import { acceptDiscoveryFinal } from '../src/product/owner-authority.js';
import { prepareKeeperBlockSource } from '../src/product/keeper-block-source.js';
import { readKeeperBlockPairSourceAt } from '../src/product/keeper-block-pair-source.js';
import { keeperCheckKey } from '../src/product/keeper.js';
import { finalAssessmentPaid, type FinalAssessmentSeedOptions } from './discovery-v7-final-assessment-seed.js';
import { modeOf, money, all } from './discovery-v7-dossier-seed.js';
import { gardenGraph, prepareNativeLayers } from './om-fixture.js';
import { answerDiscoveryFixture, currentUpstreamFixtureValue } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { storeUnchanged, storeRefused } from './store-unchanged.js';

type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
// The paid seed already owns project p. Build the normal upstream stages and native OM layers in that same Store;
// creating a second project or transplanting records would not prove a block paired to this constitution.
function nativeBlock(f: World) {
  const workspace = join(f.root, 'om-workspace'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'README.md'), 'Native OM block proof fixture\n');
  const git = (args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['add', 'README.md']);
  git(['-c', 'user.name=OMG Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture baseline']);
  const previous = f.engine.environments.get('p'), { projectId: _project, ...configuration } = previous.value;
  f.engine.environments.configure('p', { ...configuration, workspace, requestCapacityChars: 200_000,
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 10_000 }, previous.revision);
  // Unlike a fresh OM fixture, the paid seed has an active L2 reader pilot. Authorize this later native handoff
  // through its ordinary phase policy, retaining the active context preset and any existing budget segment.
  const policy = phasePolicy(f.store, 'p');
  configurePhasePolicy(f.store, 'p', 'compilation', policy?.value.budgetSegment ?? 'keeper-block-native-fixture', policy?.revision ?? 0);
  const desired = gardenGraph('cross', 'p'), { level: _level, ...l1 } = projectGraph(desired, 1);
  const source = f.engine.discovery.evidence.document('p', 'om-brief', 'The complete garden transformation', 'text/plain', 0);
  f.engine.graphs.save('p', l1 as Graph, f.store.get('graph:p')?.revision ?? 0, 'owner');
  for (const stage of UPSTREAM_STAGES) {
    const draft = f.engine.prepare('p', stage);
    for (const id of draft.value.questions) {
      const question = f.store.get<Question>(id)!;
      if (question.value.spec.kind === 'fact') f.engine.discovery.fact(id, question.revision, reference(source),
        { kind: 'text-range', start: 0, end: source.value.content.length });
      else {
        const field = question.value.spec.field;
        const value = currentUpstreamFixtureValue(f.engine, 'p', field,
          field === 'mapDesign' ? designOf(l1 as Graph) as Json : preparedField('p', field));
        if (stage === 'discovery' && ['researchPlan', 'researchReport', 'verdict', 'preparation'].includes(field))
          answerDiscoveryFixture(f.engine, 'p', f.store.get<DiscoveryDraft>(draft.id)!, question, value, source);
        else f.engine.discovery.decision(id, question.revision, 'owner', value);
      }
    }
    const artifact = f.engine.draft('p', stage, draft.id, 0);
    f.engine.pipeline.accept('p', stage, artifact.revision);
  }
  prepareNativeLayers(f.engine, 'p', desired, 'executed');
  const candidate = f.store.list<FrameCandidateRecord>('frame-candidate').find(row => row.value.level === 3)!;
  return prepareKeeperBlockSource(f.store, { project: 'p', candidate: reference(candidate), block: 'p-produce-block' });
}
async function world(t: test.TestContext, options: FinalAssessmentSeedOptions = {}) {
  const f = await finalAssessmentPaid(t, options); modeOf(f.store, 'bypass');
  const accepted = await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult,
    decision: 'accept', reason: 'Accept the exact independently assessed final' });
  assert.ok(accepted.accepted);
  return { f, manifest: reference(accepted.accepted.manifest), source: nativeBlock(f) };
}
async function quiet<T>(f: World, action: () => Promise<T>) {
  const finances = money(f.store), wire = structuredClone(f.wires());
  const result = await storeUnchanged(f.store, action);
  assert.deepEqual(money(f.store), finances); assert.deepEqual(f.wires(), wire); return result;
}
async function refused(f: World, action: () => Promise<unknown>, code?: string) {
  const finances = money(f.store), wire = structuredClone(f.wires());
  await storeRefused(f.store, action, e => e instanceof EngineError && (!code || e.code === code));
  assert.deepEqual(money(f.store), finances); assert.deepEqual(f.wires(), wire);
}

test('block pair: full saved L3 block and genuinely paid accepted constitution, exact keys, isolation and hot/cold fixed point', async t => {
  const { f, source, manifest } = await world(t);
  const before = all(f.store);
  const read = () => readKeeperBlockPairSourceAt(f.store, 'p', source.address.container, manifest, 'block-check/v1');
  const pair = await quiet(f, read), expected = structuredClone(pair);
  assert.equal(pair.pair.key.artifact.pointer, '/subject');
  assert.deepEqual(pair.pair.artifact.value, source.container.value);
  assert.equal(hashJson(pair.pair.artifact.value), source.address.container.hash);
  assert.equal(pair.artifact.material.members.length, 4);
  assert.ok(pair.artifact.material.boundary.length && pair.artifact.grounds.works);
  assert.equal(pair.checkId, keeperCheckKey(pair.pair.key));
  pair.artifact.material.members.length = 0;
  assert.deepEqual(pair.artifact.container, expected.artifact.container);
  assert.deepEqual(pair.artifact.grounds, expected.artifact.grounds);
  assert.equal(hashJson(pair.artifact.container.value as unknown as Json), pair.artifact.container.hash);
  const changedMaterial = structuredClone(pair.artifact.material);
  pair.artifact.grounds.graph.value = null;
  assert.deepEqual(pair.artifact.container, expected.artifact.container);
  assert.deepEqual(pair.artifact.material, changedMaterial);
  assert.equal(hashJson(pair.artifact.container.value as unknown as Json), pair.artifact.container.hash);
  const changedGrounds = structuredClone(pair.artifact.grounds);
  pair.artifact.container.value.subject.boundary.length = 0;
  assert.deepEqual(pair.artifact.material, changedMaterial); assert.deepEqual(pair.artifact.grounds, changedGrounds);
  assert.deepEqual(pair.artifact.address, expected.artifact.address); assert.deepEqual(pair.pair, expected.pair);
  (pair.pair.artifact.value as any).subject.boundary.length = 0;
  assert.deepEqual(pair.artifact.material, changedMaterial); assert.deepEqual(pair.artifact.grounds, changedGrounds);
  f.reopen(); assert.deepEqual(await quiet(f, read), expected); assert.deepEqual(all(f.store), before);

});

test('block pair: snapshots both refs before async proof and rejects absent/foreign/open/narrowed refs and moving versions', async t => {
  const { f, source, manifest } = await world(t), counts: number[] = [];
  const changing = (ref: Ref) => Object.fromEntries(Object.keys(ref).map((key) => [key, ref[key as keyof Ref]]));
  const a = changing(source.address.container), m = changing(manifest);
  for (const [offset, ref, target] of [[0, source.address.container, a], [3, manifest, m]] as const)
    (Object.keys(ref) as (keyof Ref)[]).forEach((key, index) => Object.defineProperty(target, key, { enumerable: true,
      get() { const n = (counts[offset + index] ?? 0) + 1; counts[offset + index] = n; return n === 1 ? ref[key] : null; } }));
  const baseline = await quiet(f, () => readKeeperBlockPairSourceAt(f.store, 'p', a, m, 'block-check/v1'));
  const version = await quiet(f, () => readKeeperBlockPairSourceAt(f.store, 'p', source.address.container, manifest, 'block-check/v2'));
  assert.notEqual(version.checkId, baseline.checkId);
  const other = prepareKeeperBlockSource(f.store, { project: 'p', candidate: source.material.candidate, block: 'p-consume-block' });
  const otherPair = await quiet(f, () => readKeeperBlockPairSourceAt(f.store, 'p', other.address.container, manifest, 'block-check/v1'));
  assert.notEqual(otherPair.checkId, baseline.checkId);
  assert.deepEqual(counts, [1, 1, 1, 1, 1, 1]);
  const before = all(f.store);
  for (const [artifact, constitution, version] of [[null, manifest, 'v1'], [source.address.container, null, 'v1'],
    [{ ...source.address.container, proven: true }, manifest, 'v1'], [source.material.candidate, manifest, 'v1'],
    [source.address, manifest, 'v1'], [source.address.container, { ...manifest, hash: '0'.repeat(64) }, 'v1'],
    [source.address.container, manifest, 'latest'], [source.address.container, manifest, '']] as const)
    await refused(f, () => readKeeperBlockPairSourceAt(f.store, 'p', artifact, constitution, version));
  await refused(f, () => readKeeperBlockPairSourceAt(f.store, 'foreign', source.address.container, manifest, 'v1'));
  assert.deepEqual(all(f.store), before);
});

test('block pair: conditional constitution keeps its open conditions', async t => {
  const { f, source, manifest } = await world(t, { outcome: 'conditional' });
  const pair = await quiet(f, () => readKeeperBlockPairSourceAt(f.store, 'p', source.address.container, manifest, 'v1'));
  assert.equal(pair.constitution.container.value.bundle.verdict.outcome, 'conditional');
  assert.ok(pair.constitution.container.value.bundle.verdict.conditions.length);
  assert.deepEqual(pair.pair.constitution.value, pair.constitution.container.value);
});
for (const outcome of ['no_go', 'insufficient_evidence'] as const)
  test(`block pair: accepted ${outcome} has no constitution and never becomes a pair`, async t => {
    const { f, source, manifest } = await world(t, { outcome, ...(outcome === 'insufficient_evidence' ? { route: 'partial' as const } : {}) });
    if (outcome === 'insufficient_evidence') assert.ok(f.final.packet.dossier.materials.length);
    await refused(f, () => readKeeperBlockPairSourceAt(f.store, 'p', source.address.container, manifest, 'v1'), 'keeper_constitution_absent');
  });
