import test, { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../src/runtime/environment.js';
import { canonical, type Json } from '../src/canonical.js';
import { reference, type Ref, type StageArtifact } from '../src/pipeline/contracts.js';
import { EarlyStageDriver } from '../src/product/early-stage-driver.js';
import { ProductEngine } from '../src/product/engine.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { readAcceptedDiscoveryProjectionAt } from '../src/discovery/discovery-accepted-projection.js';
import { acceptedDiscoveryBasisCatalogue, withDiscoveryHandoffAt, readDiscoveryHandoffAt } from '../src/discovery/discovery-handoff.js';
import { researchPrerequisitesAt, researchPrerequisites } from '../src/discovery/research-context.js';
import { readDiscoveryConsumerProjectionAt, consumerPreparationFields } from '../src/discovery/discovery-consumer-projection.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import { V9_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { configureDispatch } from '../src/om/dispatch.js';
import { prepareOmInputAt, type InputRequest } from '../src/om/input.js';
import { designOf } from '../src/graph/builder.js';
import { acceptedAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { money } from './discovery-v7-dossier-seed.js';
import { preparedField } from './preparation-fixture.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';
import { storeUnchanged } from './store-unchanged.js';

const valueFor = (field: string): Json => JSON.parse(JSON.stringify(preparedField('p', field))
  .replaceAll('p-user', 'operator').replaceAll('p-result', 'record'));
async function world(t: test.TestContext) {
  // The accepted paid v9 product is a precondition here, so it is copied from the run's catalog (layer `accepted`), not accepted again.
  const f = await acceptedAssessmentPaid(t, { form: V9_FINAL_CONTRACT });
  const manifest = f.data.accepted.manifest, source = await readAcceptedDiscoveryProjectionAt(f.store, 'p', manifest);
  const catalogue = acceptedDiscoveryBasisCatalogue(source), sections = valueFor('conceptSections') as any[];
  sections[0].requirements[0].statement = 'Deliver the selected product while retaining its accepted constraints';
  sections[0].requirements[0].acceptance = catalogue.constraints.map(c => (c.value as any).rule);
  sections[0].requirements[0].applications = [catalogue.variant, ...catalogue.constraints].map((entry, i) => ({
    contract: 'basis-application/v1', basis: entry.address,
    appliedAt: [i === 0 ? '/0/requirements/0/statement' : `/0/requirements/0/acceptance/${i - 1}`],
  }));
  return { f, manifest, source, catalogue, sections };
}

test('C2: author and independent paid assessor receive the full exact concept material on the ordinary research APIs', async t => {
  const { f, manifest, source, catalogue, sections } = await world(t);
  const engine = new ProductEngine(f.open()), draft = await engine.prepareAcceptedConsumer('p', 'concept', manifest);
  const question = draft.value.questions.map(id => engine.store.get<Question>(id)!).find(q => q.value.spec.field === 'conceptSections')!;
  const prerequisites = await researchPrerequisitesAt(engine.store, 'p', reference(draft));
  const material = prerequisites.find(p => p.conceptBasisMaterial)?.conceptBasisMaterial;
  assert.deepEqual(material, { source: { manifest, bundle: source.bundle }, summary: source.summary,
    projection: source.projection, constitution: source.constitution, catalogue });
  const instruction = engine.discovery.evidence.document('p', 'concept-instruction',
    'The ledger serves its operator. Preserve the accepted product constraints and deliver the recorded result.', 'text/plain', 0);
  const action = { action: 'answer' as const, question: question.id, value: sections as Json, citations: [{ source: reference(instruction),
    selector: { kind: 'text-range' as const, start: 0, end: instruction.value.content.length } }] };
  f.reply(action);
  const start = f.wires().length;
  await withDiscoveryHandoffAt(engine.store, 'p', reference(draft), async () => {
    const authored = await researchCall(f.environment.value.implementer, f.environment.value, question.value.spec.prompt,
      { role: 'research', question: { id: question.id, ...question.value.spec }, prerequisites: researchPrerequisites(engine.store, draft.value),
        discoveryBasisCatalogue: catalogue }, undefined, { store: engine.store, draftId: draft.id, questionId: question.id, purpose: 'analyst' });
    assert.deepEqual(authored, action);
    f.reply({ verdict: 'supported', reasons: ['The concept preserves the accepted variant, projection and constitution'] });
    const assessed = await assessAnswer(engine.store, question, action, f.environment, f.root);
    assert.equal(assessed.value.verdict, 'supported');
    engine.discovery.researched(question.id, question.revision, reference(assessed));
  });
  const wires = f.wires().slice(start);
  assert.ok(wires.length >= 2);
  for (const wire of wires) {
    const body = JSON.stringify(wire);
    assert.ok(body.includes('conceptBasisMaterial'));
    for (const key of ['summary','projection','constitution']) assert.ok(body.includes(JSON.stringify((material as any)[key].value)));
  }
  const latest = engine.store.get<DiscoveryDraft>(draft.id)!;
  assert.deepEqual(await storeUnchanged(f.open(), () => readDiscoveryHandoffAt(f.open(), 'p', reference(latest))).then(h => h.source.manifest), manifest);
});

async function buildDownstream(t: test.TestContext) {
  const prepared = await world(t);
  const { f, manifest, catalogue, sections } = prepared;
  const h = await readDiscoveryConsumerProjectionAt(f.store, 'p', manifest, 'operation-map');
  const base = JSON.parse(JSON.stringify(exampleGraph('p')).replaceAll('p-result', 'record'));
  const graph = enrichedGraph(base, 'p', consumerPreparationFields(h).preparation!, sections as Json);
  graph.horizon = []; graph.nodes = graph.nodes.filter(n => !n.id.includes('-refusal-'));
  graph.artifacts = graph.artifacts.filter(a => a.id !== 'p-refusal'); graph.edges = [];
  graph.journeys!.push({ ...graph.journeys![0]!, id: 'payer-observes-record', actor: 'company' });
  const refs: Partial<Record<string, Ref>> = { discovery: manifest };
  let operationDraftId: string | undefined;
  for (const stage of ['concept', 'operation-map', 'specification', 'features'] as const) {
    const engine = new ProductEngine(f.open());
    const draft = stage === 'operation-map' && operationDraftId
      ? engine.store.get<DiscoveryDraft>(operationDraftId)! : await engine.prepareAcceptedConsumer('p', stage, manifest);
    if (stage === 'concept') assert.deepEqual(draft.value.inputs, [manifest]);
    for (const id of draft.value.questions) {
      const question = engine.store.get<Question>(id)!;
      const field = question.value.spec.field;
      let value = field === 'conceptSections' ? sections as Json : field === 'mapDesign' ? designOf(graph) as Json : valueFor(field);
      if (field === 'behaviorContracts') {
        value = structuredClone(value);
        (value as any[])[0].applications = [catalogue.variant, ...catalogue.constraints].map(entry => ({
          contract: 'basis-application/v1', basis: entry.address, appliedAt: ['/0/entry'],
        }));
      }
      await engine.execute({ type: 'answer-decision', question: id, expected: question.revision, value });
    }
    if (stage === 'operation-map') await engine.execute({ type: 'build-map', project: 'p', draftId: draft.id, expected: 0 });
    const artifact = await engine.execute({ type: 'draft-stage', project: 'p', stage, draftId: draft.id, expected: 0 }) as any;
    const accepted = await engine.execute({ type: 'accept-stage', project: 'p', stage, expected: artifact.revision }) as any;
    const current = engine.store.get<StageArtifact>(`stage:p:${stage}`)!;
    assert.equal(current.value.status, 'accepted', canonical(accepted));
    assert.deepEqual(current.value.inputs, [stage === 'concept' ? manifest : refs[stage === 'operation-map' ? 'concept' : stage === 'specification' ? 'operation-map' : 'specification']]);
    assert.ok(current.value.proofs.some(ref => canonical(ref) === canonical(manifest)));
    assert.equal(engine.store.get('stage:p:discovery'), null);
    refs[stage] = reference(current);
    if (stage === 'concept') {
      const adapter = join(f.root, 'adapter.mjs'), script = readFileSync(adapter, 'utf8');
      assert.ok(script.includes('let research='));
      writeFileSync(adapter, script.replace('console.log(JSON.stringify(',
        "if(r.subject.stage==='operation-map')research={action:'read_context',record:r.subject.working.archive,pointer:'/body/prerequisites'};\nconsole.log(JSON.stringify("));
      const calls = f.store.list('model-call').length;
      const advanced = await new EarlyStageDriver(new ProductEngine(f.open()), undefined, { discovery: 7 })
        .run({ project: 'p', maxTurns: 1, maxCalls: 1 });
      assert.equal(advanced.stage, 'operation-map', canonical(advanced));
      assert.ok(advanced.draft, canonical(advanced));
      operationDraftId = advanced.draft.id;
      assert.deepEqual(f.store.get<DiscoveryDraft>(operationDraftId)!.value.discoveryHandoff!.manifest, manifest);
      assert.equal(advanced.budget.callsMade, 1, canonical(advanced));
      assert.equal(f.store.list('model-call').length, calls + 1);
      writeFileSync(adapter, script);
    }
  }
  return { ...prepared, refs };
}
const downstreamCleanup: (() => unknown)[] = [];
after(async () => { for (const cleanup of downstreamCleanup.reverse()) await cleanup(); });
let downstreamSource: Promise<Awaited<ReturnType<typeof buildDownstream>>> | undefined;
async function downstreamCheckpoint(t: test.TestContext) {
  const owner = new Proxy(t, { get(target, key) {
    if (key === 'after') return (cleanup: () => unknown) => downstreamCleanup.push(cleanup);
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const source = await (downstreamSource ??= buildDownstream(owner));
  const directory = mkdtempSync(join(tmpdir(), 'omg-c2-downstream-')), path = join(directory, 'state.sqlite');
  const database = new DatabaseSync(source.f.path);
  try { database.prepare('VACUUM INTO ?').run(path); } finally { database.close(); }
  const stores: Store[] = [], open = () => { const store = new Store(path); stores.push(store); return store; };
  const store = open(), engine = new ProductEngine(store);
  t.after(() => { for (const connection of stores) connection.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...source, f: { ...source.f, store, engine, discovery: engine.discovery, path, open } };
}

test('C2: cold exact manifest produces real concept, L1, specification and features with no Discovery StageArtifact', async t => {
  const { f, refs, manifest } = await downstreamCheckpoint(t);
  assert.deepEqual(refs.discovery, manifest);
  assert.deepEqual(reference(f.store.get<StageArtifact>('stage:p:features')!), refs.features);
  assert.equal(f.store.get('stage:p:discovery'), null);
});

test('C2: the saved real downstream chain starts and resumes OM cold with its exact manifest root', async t => {
  const { f, refs, manifest } = await downstreamCheckpoint(t);
  const cold = f.open();
  const result = await prepareOmInputAt(cold, { project: 'p', stages: refs as InputRequest['stages'], expected: 0 });
  assert.ok(result.ok, canonical(result));
  assert.deepEqual(result.value.record.input.discovery!.manifest, manifest);
  assert.ok(result.value.record.input.contracts.some(row => row.outcome === 'record'));
  assert.equal(cold.get('stage:p:discovery'), null);
  const configured = new ProductEngine(f.open());
  const environment = configured.environments.get('p');
  const { projectId: _project, ...settings } = environment.value;
  const workspace = join(f.root, 'om-repository');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), 'The accepted ledger enters OM.\n');
  git(workspace, ['init', '-b', 'main']); git(workspace, ['add', 'README.md']);
  git(workspace, ['-c', 'user.name=OMG Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'OM input', '--', 'README.md']);
  configured.environments.configure('p', { ...settings, workspace, requestCapacityChars: 1_000_000,
    fullCheck: { executable: process.execPath, args: ['--version'] } }, environment.revision);
  assert.equal(configureDispatch(configured.store, { project: 'p', protocol: 'codex-stdio' }).ok, true);
  const request = { project: 'p', maxTurns: 4, maxCalls: 1, outcomes: ['record'] };
  const started = await new EarlyStageDriver(new ProductEngine(f.open()), undefined, { discovery: 7 }).run(request);
  assert.ok(f.store.get('om-run:p'), canonical(started));
  const run = f.store.get<any>('om-run:p')!;
  const input = f.store.get<any>(run.value.input.id, run.value.input.revision)!;
  assert.deepEqual(input.value.input.discovery.manifest, manifest);
  const cash = money(f.store), wire = f.wires(), drafts = f.store.list('discovery-draft').map(reference);
  const resumed = await new EarlyStageDriver(new ProductEngine(f.open()), undefined, { discovery: 7 }).run(request);
  assert.ok(resumed.end.startsWith('om_'), canonical(resumed));
  assert.notEqual(resumed.reason?.code, 'discovery_handoff_proof_required', canonical(resumed));
  assert.deepEqual(f.store.get<any>('om-run:p')!.value.input, run.value.input);
  assert.deepEqual(f.store.list('discovery-draft').map(reference), drafts);
  assert.deepEqual(money(f.store), cash); assert.deepEqual(f.wires(), wire);
});

