import { EngineError } from '../src/errors.js';
import { configurePhasePolicy, phasePolicy } from '../src/discovery/phase-policy.js';
import { writeFeasibility } from '../src/om/feasibility.js';
import { writeHandoff } from '../src/om/handoff.js';
import type { MachinePlan } from '../src/compiler/model.js';
import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, type Json } from '../src/canonical.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import type { Question, DiscoveryDraft } from '../src/discovery/discovery.js';
import { V9_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import { acceptDiscoveryFinal } from '../src/product/owner-authority.js';
import { readAcceptedDiscoveryProjectionAt } from '../src/discovery/discovery-accepted-projection.js';
import { acceptedDiscoveryBasisCatalogue, withDiscoveryHandoffAt } from '../src/discovery/discovery-handoff.js';
import { readDiscoveryConsumerProjectionAt, consumerPreparationFields } from '../src/discovery/discovery-consumer-projection.js';
import { readOmAcceptedMaterial, withOmAcceptedMaterialAt } from '../src/om/accepted-material.js';
import { writeOmInput, type InputRequest } from '../src/om/input.js';
import { writeWorksAcceptance, type AtomicGateRecord } from '../src/om/atomic-gate.js';
import { taskSpecificationReader } from '../src/om/task-specification.js';
import { designOf } from '../src/graph/builder.js';
import { git } from '../src/runtime/environment.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { modeOf } from './discovery-v7-dossier-seed.js';
import { preparedField } from './preparation-fixture.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';
import { produceAtomicWorks } from './om-atomic-seed.js';
import { storeUnchanged } from './store-unchanged.js';

const ok = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: unknown }): T => { assert.ok(result.ok, canonical(result)); return result.value; };
const cleanups: (() => void)[] = [];
after(() => { for (const close of cleanups.reverse()) close(); });
const lifetime = { after: (close: () => void) => cleanups.push(close), diagnostic: () => {} } as unknown as TestContext;
const valueFor = (field: string): Json => JSON.parse(JSON.stringify(preparedField('p', field)).replaceAll('p-user', 'operator').replaceAll('p-result', 'record'));
function checkpoint(path: string) {
  const root = mkdtempSync(join(tmpdir(), 'omg-c3b-checkpoint-')), file = join(root, 'state.sqlite');
  const db = new DatabaseSync(path); try { db.prepare('VACUUM INTO ?').run(file); } finally { db.close(); }
  cleanups.push(() => rmSync(root, { recursive: true, force: true })); return file;
}
async function base() {
  const f = await finalAssessmentPaid(lifetime, { form: V9_FINAL_CONTRACT }); modeOf(f.store, 'bypass');
  const accepted = await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason: 'Build the exact accepted product' });
  assert.ok(accepted.accepted);
  const manifest = reference(accepted.accepted.manifest), source = await readAcceptedDiscoveryProjectionAt(f.store, 'p', manifest);
  const catalogue = acceptedDiscoveryBasisCatalogue(source), sections = valueFor('conceptSections') as any[];
  sections[0].requirements[0].acceptance = catalogue.constraints.map(c => (c.value as any).rule);
  sections[0].requirements[0].applications = [catalogue.variant, ...catalogue.constraints].map((entry, i) => ({
    contract: 'basis-application/v1', basis: entry.address,
    appliedAt: [i === 0 ? '/0/requirements/0/statement' : `/0/requirements/0/acceptance/${i - 1}`] }));
  const projection = await readDiscoveryConsumerProjectionAt(f.store, 'p', manifest, 'operation-map');
  const desired = enrichedGraph(JSON.parse(JSON.stringify(exampleGraph('p')).replaceAll('p-result', 'record')), 'p',
    consumerPreparationFields(projection).preparation!, sections as Json);
  desired.horizon = []; desired.nodes = desired.nodes.filter(n => !n.id.includes('-refusal-'));
  desired.artifacts = desired.artifacts.filter(a => a.id !== 'p-refusal'); desired.edges = [];
  desired.journeys!.push({ ...desired.journeys![0]!, id: 'payer-observes-record', actor: 'company' });
  return { root: f.root, path: checkpoint(f.path), manifest, source, catalogue, sections, desired,
    refs: { discovery: manifest } as Partial<InputRequest['stages']>, features: null as Ref | null };
}
type Seed = Awaited<ReturnType<typeof base>>;
function plant<T extends Seed>(t: TestContext, seed: T) {
  const root = mkdtempSync(join(tmpdir(), 'omg-c3b-copy-')), path = join(root, 'state.sqlite'); copyFileSync(seed.path, path);
  const stores: Store[] = [], open = () => { const s = new Store(path); stores.push(s); return s; }, store = open();
  t.after(() => { for (const s of stores) s.close(); rmSync(root, { recursive: true, force: true }); });
  return { ...seed, desired: structuredClone(seed.desired), refs: structuredClone(seed.refs), path, store, open, engine: new ProductEngine(store) };
}
const stages = ['concept', 'operation-map', 'specification', 'features'] as const;
const seeds: Promise<Seed>[] = [];
function seedAt(index: number): Promise<Seed> { return seeds[index] ??= build(index); }
async function build(index: number): Promise<Seed> {
  if (index === 0) return base();
  const w = plant(lifetime, await seedAt(index - 1)), stage = stages[index - 1]!;
  const draft = await w.engine.prepareAcceptedConsumer('p', stage, w.manifest);
  for (const id of draft.value.questions) {
    const question = w.store.get<Question>(id)!, field = question.value.spec.field;
    const value = field === 'conceptSections' ? w.sections as Json : field === 'mapDesign' ? designOf(w.desired) as Json : valueFor(field);
    if (field === 'behaviorContracts') (value as any[])[0].applications = [w.catalogue.variant, ...w.catalogue.constraints]
      .map(entry => ({ contract: 'basis-application/v1', basis: entry.address, appliedAt: ['/0/entry'] }));
    await w.engine.execute({ type: 'answer-decision', question: id, expected: question.revision, value });
  }
  if (stage === 'operation-map') {
    await w.engine.execute({ type: 'build-map', project: 'p', draftId: draft.id, expected: 0 });
    const graph = w.store.get<any>('graph:p')!.value; w.desired.id = graph.id; w.desired.title = graph.title;
  }
  const artifact = await w.engine.execute({ type: 'draft-stage', project: 'p', stage, draftId: draft.id, expected: 0 }) as any;
  await w.engine.execute({ type: 'accept-stage', project: 'p', stage, expected: artifact.revision });
  w.refs[stage] = reference(w.store.get(`stage:p:${stage}`)!);
  if (stage === 'features') w.features = reference(w.store.get<DiscoveryDraft>(draft.id)!);
  return { ...w, path: checkpoint(w.path) };
}
for (const [index, stage] of stages.entries()) test(`C3b: real v9 retains exact material through accepted ${stage}`, async t => {
  const w = plant(t, await seedAt(index + 1));
  assert.equal(w.store.get('stage:p:discovery'), null);
  const row = w.store.get<any>(w.refs[stage]!.id)!;
  assert.equal(row.value.status, 'accepted'); assert.deepEqual(row.value.content.discoveryHandoff.manifest, w.manifest);
});
async function buildWorks() {
  const w = plant(lifetime, await seedAt(4)); assert.ok(w.features);
  const om = await withDiscoveryHandoffAt(w.store, 'p', w.features, async () => {
    const input = ok(writeOmInput(w.store, { project: 'p', stages: w.refs as InputRequest['stages'], expected: 0 }));
    return produceAtomicWorks({ root: w.root, database: w.path, store: w.store, project: 'p', input, desired: w.desired,
      outcome: 'record', lateProof: null, environment: command => {
        const workspace = join(w.root, 'workspace'); mkdirSync(workspace, { recursive: true });
        git(workspace, ['init', '-q']); git(workspace, ['config', 'user.name', 'C3b Fixture']); git(workspace, ['config', 'user.email', 'fixture@example.invalid']);
        writeFileSync(join(workspace, 'README.md'), 'Accepted product workspace\n'); git(workspace, ['add', 'README.md']); git(workspace, ['commit', '-qm', 'Initial product workspace']);
        const previous = w.engine.environments.get('p'), { projectId: _project, ...settings } = previous.value;
        return w.engine.environments.configure('p', { ...settings, workspace,
          implementer: { ...settings.implementer, command }, reviewer: { ...settings.reviewer, command },
          fullCheck: { executable: process.execPath, args: ['--version'] }, requestCapacityChars: 500_000 }, previous.revision);
      } });
  });
  return { ...w, path: checkpoint(w.path), om: om.data };
}
let worksSeed: ReturnType<typeof buildWorks> | undefined;
async function worksWorld(t: TestContext) { return plant(t, await (worksSeed ??= buildWorks())); }
test('C3b: E4 physically delivers the complete accepted manifest and exact bundle/member catalogue', async t => {
  const w = await worksWorld(t), input = reference(w.om.input);
  const material = await storeUnchanged(w.store, () => withOmAcceptedMaterialAt(w.store, 'p', input,
    () => readOmAcceptedMaterial(w.store, 'p', input)));
  assert.deepEqual(material.discovery, w.source); assert.equal(material.accepted.length, 4);
  const packets = w.store.list<any>('question-packet'); assert.ok(packets.length);
  for (const packet of packets) {
    assert.equal(packet.value.briefSelection, 'om-brief-selection/v2');
    const text = packet.value.packet.brief.text;
    assert.ok(text.includes('discovery-basis-catalogue/v2'));
    assert.ok(text.includes(w.source.constitution.value.goal));
    assert.ok(packet.value.packet.brief.references.some((ref: Ref) => canonical(ref) === canonical(w.source.bundle)));
    assert.ok(packet.value.packet.brief.references.some((ref: Ref) => canonical(ref) === canonical(w.catalogue.variant.address.record)));
  }
  assert.ok(w.om.cycles.length > 0, 'The physical E4 carrier consumed those packets');
});
test('C3b: G5 consumes the same v2 selection and measures full preplan contexts', async t => {
  const w = await worksWorld(t);
  await withOmAcceptedMaterialAt(w.store, 'p', reference(w.om.input), () => {
    const selected = ok(taskSpecificationReader()(w.store, { project: 'p', input: reference(w.om.input),
      requirements: ['p-R1'], nodes: ['p-produce-work'], contract: 'selected-specification/v2' }));
    assert.deepEqual(selected.discovery, w.source); assert.equal(selected.contract, 'selected-specification/v2');
    if (selected.contract !== 'selected-specification/v2') throw new Error('Missing basis form');
    assert.deepEqual(selected.bases.catalogue, w.catalogue);
    const accepted = ok(writeWorksAcceptance(w.store, w.om.request));
    assert.equal(accepted.state, 'accepted', canonical(accepted));
    const gates = w.store.list<AtomicGateRecord>('om-atomic-gate'); assert.ok(gates.length);
    assert.ok(gates.every(g => g.value.request.taskContextContract === 'omg-task-context/v3'));
  });
});

async function buildCompiled() {
  const w = await worksWorld(lifetime);
  await withOmAcceptedMaterialAt(w.store, 'p', reference(w.om.input), () => {
    const accepted = ok(writeWorksAcceptance(w.store, w.om.request)); assert.ok(accepted.acceptance);
    const a = accepted.acceptance;
    const policy = phasePolicy(w.store, 'p');
    configurePhasePolicy(w.store, 'p', 'compilation', policy?.value.budgetSegment ?? 'c3b-test', policy?.revision ?? 0);
    const feasibility = ok(writeFeasibility(w.store, { project: 'p', graph: a.graph, layer: a.layer, frame: a.frame,
      environment: reference(w.om.environment), expected: 0 }));
    assert.equal(feasibility.value.ready, true, canonical(feasibility.value.findings));
    ok(writeHandoff(w.store, { project: 'p', feasibility: reference(feasibility), expected: 0 }));
  });
  // The public cold command must itself recover C1; no caller scope is active here.
  const cold = new ProductEngine(w.open());
  const plan = await cold.execute({ type: 'compile', project: 'p' }) as Revision<MachinePlan>;
  return { ...w, path: checkpoint(w.path), plan };
}
let compiledSeed: ReturnType<typeof buildCompiled> | undefined;
async function compiledWorld(t: TestContext) { return plant(t, await (compiledSeed ??= buildCompiled())); }
test('C3b: cold compile, context and detail deliver exact accepted material without manual scope', async t => {
  const w = await compiledWorld(t), cold = new ProductEngine(w.open()), plan = reference(w.plan), task = w.plan.value.tasks[0]!.id;
  assert.deepEqual(await cold.execute({ type: 'compile', project: 'p' }), w.plan);
  const command = { type: 'task-context', project: 'p', plan, task, maxChars: 1_000_000 };
  const context = await storeUnchanged(cold.store, () => cold.execute(command)) as { text: string };
  const material = JSON.parse(context.text).selectedSpecification;
  assert.deepEqual(material.discovery, w.source); assert.deepEqual(material.bases.catalogue, w.catalogue);
  const selector = { id: '', pointer: '', start: null, end: null };
  const index = await storeUnchanged(cold.store, () => cold.execute({ type: 'task-detail', project: 'p', plan, task,
    kind: 'evidence-index', selector, maxChars: 1_000_000 })) as { text: string };
  assert.ok(JSON.parse(index.text).value.some((row: any) => canonical(row.ref) === canonical(w.source.bundle)));
  for (const entry of [w.catalogue.variant, ...w.catalogue.constraints]) {
    const detail = await storeUnchanged(cold.store, () => cold.execute({ type: 'task-detail', project: 'p', plan, task,
      kind: 'evidence', selector: { ...selector, id: entry.address.record.id, pointer: entry.address.pointer }, maxChars: 1_000_000 })) as { text: string };
    assert.deepEqual(JSON.parse(detail.text).value, entry.value);
  }
  await assert.rejects(Promise.resolve().then(() => cold.execute({ ...command, maxChars: 10 })), { code: 'context_budget_exceeded' });
});
test('C3b: later Discovery heads and caller Ref mutation cannot replace the exact cold plan material', async t => {
  const w = await compiledWorld(t), cold = new ProductEngine(w.open());
  const frame = w.store.get(w.source.grounds.frame.id)!;
  w.store.write({ id: frame.id, kind: frame.kind, expected: frame.revision, value: frame.value });
  const command = { type: 'task-context', project: 'p', plan: reference(w.plan), task: w.plan.value.tasks[0]!.id, maxChars: 1_000_000 };
  const work = cold.execute(command); command.plan.hash = '0'.repeat(64);
  const result = await storeUnchanged(cold.store, () => work) as { text: string };
  assert.deepEqual(JSON.parse(result.text).selectedSpecification.discovery, w.source);
  await assert.rejects(Promise.resolve().then(() => cold.execute(command)), { code: 'plan_stale' });
});
test('C3b: missing, null or foreign manifest bindings refuse without a fallback or new writes', async t => {
  const w = await worksWorld(t), exactInput = reference(w.om.input);
  for (const change of [
    (value: any) => { value.input.discovery.manifest.hash = '0'.repeat(64); },
    (value: any) => { delete value.input.discovery; },
    (value: any) => { value.input.sources.find((row: any) => row.stage === 'discovery').hash = '0'.repeat(64); },
    (value: any) => { value.input.sources.push(value.input.sources[0]); },
  ]) {
    const value = structuredClone(w.om.input.value); change(value);
    const head = w.store.get(exactInput.id)!;
    const bad = w.store.write({ id: head.id, kind: head.kind, expected: head.revision, value });
    await storeUnchanged(w.store, () => assert.rejects(withOmAcceptedMaterialAt(w.store, 'p', reference(bad), () => null),
      (error: unknown) => error instanceof EngineError && error.code === 'om_accepted_material_invalid'));
  }
  const head = w.store.get(exactInput.id)!;
  const empty = w.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: null });
  await storeUnchanged(w.store, () => assert.rejects(withOmAcceptedMaterialAt(w.store, 'p', reference(empty), () => null),
    (error: unknown) => error instanceof EngineError && error.code === 'om_accepted_material_invalid'));
  // Historical reads still use the exact original, never the latest damaged head.
  await storeUnchanged(w.store, () => withOmAcceptedMaterialAt(w.store, 'p', exactInput,
    () => assert.deepEqual(readOmAcceptedMaterial(w.store, 'p', exactInput).discovery, w.source)));
});

test('C3b: a concurrent change after C1 proof refuses compilation without publishing a new plan', async t => {
  const w = await compiledWorld(t), cold = new ProductEngine(w.open()), concurrent = w.open();
  const plans = cold.store.list('plan').map(reference), pointer = cold.store.get('current-plan:p');
  const original = cold.compile.bind(cold);
  let cut = false;
  cold.compile = (project, guards) => {
    cut = true;
    const stage = concurrent.get('stage:p:om-g2')!;
    concurrent.write({ id: stage.id, kind: stage.kind, expected: stage.revision, value: stage.value });
    return original(project, guards);
  };
  await assert.rejects(Promise.resolve().then(() => cold.execute({ type: 'compile', project: 'p' })),
    (error: unknown) => error instanceof EngineError && ['revision_conflict', 'input_stale', 'plan_stale', 'guard_conflict'].includes(error.code));
  assert.equal(cut, true, 'The concurrent write occurs after entering the proved material operation');
  assert.deepEqual(cold.store.list('plan').map(reference), plans);
  assert.deepEqual(cold.store.get('current-plan:p'), pointer);
});
