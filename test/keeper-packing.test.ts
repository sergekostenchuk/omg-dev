import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { configurePhasePolicy, phasePolicy } from '../src/discovery/phase-policy.js';
import { UPSTREAM_STAGES } from '../src/discovery/requirements.js';
import { projectGraph } from '../src/graph/project.js';
import { designOf } from '../src/graph/builder.js';
import type { Graph } from '../src/graph/model.js';
import type { FrameCandidateRecord } from '../src/om/frame-candidate.js';
import { acceptDiscoveryFinal } from '../src/product/owner-authority.js';
import { prepareKeeperBlockSource } from '../src/product/keeper-block-source.js';
import { finalAssessmentPaid, type FinalAssessmentSeedOptions } from './discovery-v7-final-assessment-seed.js';
import { modeOf, money, all } from './discovery-v7-dossier-seed.js';
import { gardenGraph, prepareNativeLayers } from './om-fixture.js';
import { answerDiscoveryFixture, currentUpstreamFixtureValue } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

import { prepareKeeperSession, readKeeperSessionAt, type KeeperSessionInput } from '../src/product/keeper-session.js';
import { readKeeperArchive } from '../src/product/keeper-packing.js';
import { restoreTextFromParts } from '../src/discovery/request-parts.js';
import { referenceSites } from '../src/storage/reference-sites.js';

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

function input(w: Awaited<ReturnType<typeof world>>, capacity = 8_000_000): KeeperSessionInput {
  return { project: 'p', sourceKind: 'block', source: w.source.address.container, manifest: w.manifest,
    checkVersion: 'keeper-block-session/v1', environment: reference(w.f.engine.environments.get('p')),
    prompt: 'Check every block member, work and boundary against the entire constitution',
    packetChars: capacity, limitChars: capacity + 100_000, resultLimitChars: 250_000 };
}
const state = (f: World) => ({ all: all(f.store), ledger: f.store.integrityLedger(), money: money(f.store), wire: f.wires() });

test('packing: real full L3 block and paid constitution prepare the reviewer session and every archive byte', async t => {
  const w = await world(t), { f } = w, finances = money(f.store), wires = f.wires();
  const row = await prepareKeeperSession(f.store, input(w));
  assert.equal(row.value.request.key.artifact.pointer, '/subject');
  assert.deepEqual(row.value.request.artifact.value, w.source.container.value);
  const archive = readKeeperArchive(f.store, 'p', row.value.packing.archive, row.value.request);
  const restored = restoreTextFromParts({ store: f.store, projectId: 'p', parts: archive.parts,
    expectedSha256: archive.sha256, expectedChars: archive.chars, expectedBytes: archive.bytes });
  assert.deepEqual(JSON.parse(restored.text).request, row.value.request);
  assert.deepEqual(money(f.store), finances); assert.deepEqual(f.wires(), wires);
});

test('packing: common positive sequential deliveries reconstruct the entire request within every physical bound', async t => {
  const w = await world(t), { f } = w;
  const row = await prepareKeeperSession(f.store, input(w, 25_000));
  const pages = row.value.packing.envelopes;
  assert.ok(pages.length > 1);
  let end = 0, whole = '';
  for (const envelope of pages) {
    const d = envelope.packet.delivery;
    assert.equal(d.original.pointer, '/body/request');
    assert.deepEqual(d.original.record, row.value.packing.archive);
    assert.equal(d.served.offset, end); assert.ok(d.served.end > end);
    assert.equal(d.served.next, d.served.end === d.served.total ? null : d.served.end);
    assert.equal(d.encoding, 'json-string-fragment'); whole += d.text!; end = d.served.end;
    assert.equal(envelope.input.length, envelope.measuredChars);
    assert.ok(envelope.input.length <= row.value.limits.request);
    assert.ok(JSON.stringify(envelope.packet).length <= row.value.input.packetChars);
    const wire = JSON.parse(envelope.input);
    assert.deepEqual(wire.subject.key, row.value.request.key);
    assert.deepEqual(wire.subject.schema, row.value.request.responseSchema);
    assert.equal(wire.subject.replyLimitChars, 250_000);
  }
  assert.equal(whole, canonical(row.value.request)); assert.equal(end, whole.length);
  const archive = f.store.get(row.value.packing.archive.id, 1)!;
  assert.ok(row.value.packing.parts.length > 1);
  const normalize = (items: unknown[]) => items.map(x => canonical(x)).sort();
  const sites = (kind: string, value: unknown) => referenceSites(kind, value).map(x => [x.field, { id: x.ref.id, revision: x.ref.revision, hash: x.ref.hash }]);
  assert.deepEqual(normalize(sites('keeper-archive', archive.value)),
    normalize(row.value.packing.parts.map((ref, i) => [`parts[${i}]`, ref])));
  const v = row.value;
  const expected: unknown[] = [ ['input.source', v.input.source], ['input.manifest', v.input.manifest],
    ['input.environment', v.input.environment], ['request.key.artifact.container', v.request.key.artifact.container],
    ['request.key.constitution.container', v.request.key.constitution.container], ['request.artifact.ref', v.request.artifact.ref],
    ['request.constitution.ref', v.request.constitution.ref], ['packing.archive', v.packing.archive],
    ...v.packing.parts.map((ref, i) => [`packing.parts[${i}]`, ref]),
    ...v.packing.envelopes.flatMap((e, i) => [
      [`packing.envelopes[${i}].packet.key.artifact.container`, e.packet.key.artifact.container],
      [`packing.envelopes[${i}].packet.key.constitution.container`, e.packet.key.constitution.container],
      [`packing.envelopes[${i}].packet.delivery.original.record`, e.packet.delivery.original.record] ]) ];
  assert.deepEqual(normalize(sites('keeper-session', v)), normalize(expected));
  const material = structuredClone(v);
  (material.request.artifact.value as any).refLikeData = v.input.source;
  (material.request.constitution.value as any).refLikeData = v.input.manifest;
  (material.packing.envelopes[0]!.packet.schema as any).refLikeData = v.input.environment;
  assert.deepEqual(normalize(sites('keeper-session', material)), normalize(expected));

});

test('packing: mandatory minimum and invalid limits refuse before archive/session/parts writes', async t => {
  const w = await world(t), { f } = w, before = state(f);
  await assert.rejects(prepareKeeperSession(f.store, { ...input(w), packetChars: 1, limitChars: 2 }),
    e => e instanceof EngineError && e.code === 'keeper_request_limit');
  for (const bad of [null, {}, { ...input(w), role: f.environment.value.implementer }])
    await assert.rejects(prepareKeeperSession(f.store, bad), e => e instanceof EngineError);
  assert.deepEqual(state(f), before);
});

test('packing: isolated exact version and Environment bindings produce distinct prepared identities', async t => {
  const w = await world(t), { f } = w, original = input(w);
  const a = await prepareKeeperSession(f.store, original);
  const b = await prepareKeeperSession(f.store, { ...original, checkVersion: 'keeper-block-session/v2' });
  assert.notEqual(a.id, b.id); assert.notEqual(a.value.packing.archive.id, b.value.packing.archive.id);
  const env = f.engine.environments.get('p');
  const changed = f.store.write({ id: env.id, kind: env.kind, expected: env.revision,
    value: { ...env.value, timeoutMs: env.value.timeoutMs + 1 } as unknown as Json });
  const c = await prepareKeeperSession(f.store, { ...original, environment: reference(changed) });
  assert.notEqual(c.id, a.id);
  a.value.request.artifact.value = null;
  assert.ok(a.value.packing.envelopes[0]!.packet.key.artifact.container.hash);
  assert.deepEqual(b.value.request.artifact.value, w.source.container.value);
});

test('packing: L2 null works and late heads remain exact after cold reopen', async t => {
  const w = await world(t), { f } = w;
  const candidate = f.store.list<FrameCandidateRecord>('frame-candidate').find(row => row.value.level === 2)!;
  const source = prepareKeeperBlockSource(f.store, { project: 'p', candidate: reference(candidate), block: 'p-produce-block' });
  assert.equal(source.grounds.works, null);
  const row = await prepareKeeperSession(f.store, { ...input(w), source: source.address.container });
  const latest = f.store.get(candidate.id)!;
  f.store.write({ id: latest.id, kind: latest.kind, expected: latest.revision, value: latest.value as Json });
  const before = state(f); f.reopen();
  assert.deepEqual(await readKeeperSessionAt(f.store, 'p', reference(row)), row);
  assert.deepEqual(state(f), before);
});

test('packing: real conditional constitution keeps its open conditions and grants no continuation', async t => {
  const w = await world(t, { outcome: 'conditional' }), { f } = w;
  const before = money(f.store), row = await prepareKeeperSession(f.store, input(w));
  const bundle = (row.value.request.constitution.value as any).bundle;
  assert.ok(bundle.verdict.conditions.length > 0);
  assert.equal(row.value.state, 'prepared');
  assert.deepEqual(money(f.store), before);
});
