import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { inheritanceCandidateFailure, researchPrerequisites } from '../src/discovery/research-context.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import { contextValue, workingContext } from '../src/discovery/working-context.js';
import { discoveryBasisCatalogue } from '../src/discovery/discovery-outcome.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, stageId, type StageArtifact, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { VERSION6_REQUIREMENTS } from '../src/discovery/requirements.js';
import { preparedField } from './preparation-fixture.js';
import type { Json } from '../src/canonical.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-basis-inheritance-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const stage = (name: StageArtifact['stage'], fields: Record<string, Json>, inputs: Ref[] = []) =>
    store.write<StageArtifact>({ id: stageId('p', name), kind: 'stage', expected: 0,
      value: { projectId: 'p', stage: name, status: 'accepted', content: { fields, graph: null }, inputs, proofs: [] } });
  const discoveryFields: Record<string, Json> = { preparation: {
    actors: [{ id: 'user' }], outcomes: [{ id: 'result' }], journeys: {}, externalSystems: [],
    constraints: [{ id: 'offline', rule: 'Read saved results offline', basis: 'owner request' }],
  }, verdict: { outcome: 'go', variant: 'Subscription and API routes' } };
  const discovery = stage('discovery', discoveryFields);
  const catalogue = discoveryBasisCatalogue({ ref: reference(discovery), fields: discoveryFields });
  const application = (basis: typeof catalogue.variant.address, appliedAt: string) =>
    ({ contract: 'basis-application/v1', basis, appliedAt: [appliedAt] });
  const conceptSections: Json = [{ id: 'journey', requirements: [
    { id: 'route', outcome: 'result', statement: 'Offer both routes', benefit: 'Choose access', acceptance: ['Both work'],
      applications: [application(catalogue.variant.address, '/0/requirements/0/statement')] },
    { id: 'offline', outcome: 'result', statement: 'Read saved result offline', benefit: 'Retain access', acceptance: ['No network'],
      applications: [application(catalogue.constraints[0]!.address, '/0/requirements/1/acceptance/0')] },
  ] }] as unknown as Json;
  const concept = stage('concept', { conceptSections }, [reference(discovery)]);
  const operationRequirements: Json = { outcomes: [{ outcome: 'result' }], conceptCoverage: [
    { requirement: 'route', outcome: 'result' }, { requirement: 'offline', outcome: 'result' },
  ] };
  const mapDesign: Json = { nodes: [{ id: 'execute', kind: 'block', implements: ['route', 'offline'] }] };
  const map = stage('operation-map', { operationRequirements, mapDesign }, [reference(concept)]);
  const behaviorContracts: Json = [{ id: 'execute-behavior', outcome: 'result', requirements: ['route', 'offline'],
    entry: 'Choose route', success: ['Persist readable result'],
    applications: [application(catalogue.variant.address, '/0/entry'),
      application(catalogue.constraints[0]!.address, '/0/success/0')] }] as unknown as Json;
  const specification = stage('specification', { behaviorContracts }, [reference(map)]);
  const mapFields: Record<string, Json> = { operationRequirements, mapDesign };
  const featureFields: Record<string, Json> = { featurePreparation: [{ featureTitle: 'Execute',
    outcome: 'result', behaviorContracts: ['execute-behavior'], requirements: ['route', 'offline'] }] };
  const mapInputs = [reference(discovery), reference(concept)];
  const featureInputs = [...mapInputs, reference(map), reference(specification)];
  const draft = (name: 'operation-map' | 'features', fields: Record<string, Json>, inputs: Ref[], version = 6): DiscoveryDraft => {
    const discovery = new Discovery(store);
    const made = discovery.create('p', name, 'R0', name,
      Object.keys(fields).map(field => ({ field, kind: 'design' as const, prompt: field, risk: field, schema: {} })),
      inputs, version);
    for (const id of made.value.questions) {
      const question = store.get<Question>(id)!;
      const value = fields[question.value.spec.field];
      if (value !== null) discovery.decision(id, question.revision, 'owner', value!);
    }
    return store.get<DiscoveryDraft>(made.id)!.value;
  };
  return { root, store, stage, discovery, catalogue, concept, map, specification, mapFields, featureFields,
    mapInputs, featureInputs, draft, application };
}

test('v6 map and features inherit exact Discovery grounds through selected requirements, blocks and contracts', t => {
  const f = fixture(t);
  const map = researchPrerequisites(f.store, f.draft('operation-map', f.mapFields, f.mapInputs));
  const basis = (map.find(row => row.stage === 'concept')!.operationMapMaterial as any).basis;
  assert.equal(map.find(row => row.stage === 'concept')!.operationMapMaterial!.contract, 'operation-map-material/v2');
  assert.deepEqual(basis.catalogue, f.catalogue);
  assert.deepEqual(basis.requirements.map((row: any) => [row.id, row.grounds]), [
    ['route', [f.catalogue.variant.address]], ['offline', [f.catalogue.constraints[0]!.address]],
  ]);
  assert.deepEqual(basis.coverage.map((row: any) => row.requirement), ['route', 'offline']);
  assert.deepEqual(basis.blocks[0]!.grounds, [f.catalogue.variant.address, f.catalogue.constraints[0]!.address]);
  const features = researchPrerequisites(f.store, f.draft('features', f.featureFields, f.featureInputs));
  const feature = features.find(row => row.stage === 'specification')!.featureBasisMaterial!;
  assert.deepEqual(feature.catalogue, f.catalogue);
  assert.deepEqual(feature.contracts[0]!.requirements, ['route', 'offline']);
  assert.deepEqual(feature.selected[0]!.grounds, [f.catalogue.variant.address, f.catalogue.constraints[0]!.address]);
  for (const row of feature.requirements) assert.equal((contextValue(f.store.get(row.source.record.id, row.source.record.revision)!.value,
    row.source.pointer) as { id: string }).id, row.id);
  for (const address of feature.selected[0]!.grounds) assert.notEqual(contextValue(
    f.store.get(address.record.id, address.record.revision)!.value, address.pointer), undefined);
});

test('v6 grounds reach author, assessor and continuation from the same exact archive', t => {
  const f = fixture(t), draft = new Discovery(f.store).create('p', 'operation-map', 'R0', 'operation-map', [
    { field: 'mapDesign', kind: 'design', prompt: 'Design the map', risk: 'Missing map', schema: { type: 'object' } },
  ], f.mapInputs, 6);
  const question = f.store.get<any>(draft.value.questions[0]!)!;
  const basis = researchPrerequisites(f.store, { ...draft.value, fields: f.mapFields });
  for (const role of ['research', 'assess-answer', 'assess-escalation']) {
    const context = { role, question: { id: question.id, ...question.value.spec }, prerequisites: basis,
      ...(role === 'assess-answer' ? { value: f.mapFields.mapDesign, observations: [] } : {}) };
    const first = workingContext(f.store, 'p', draft.id, question.id, context, 200000, { common: true });
    const archive = f.store.get(first.working.archive.id, first.working.archive.revision)!;
    assert.deepEqual(contextValue(archive.value, '/body/prerequisites'), basis);
    const continued = workingContext(f.store, 'p', draft.id, question.id, context, 200000,
      { continuation: true, common: true, previous: first.working.archive });
    const saved = f.store.get(continued.working.archive.id, continued.working.archive.revision)!;
    assert.deepEqual(contextValue(saved.value, '/body/prerequisites'), basis);
  }
});

test('the final proposed map and feature selection are projected before they enter draft fields', t => {
  const f = fixture(t);
  const mapDraft = f.draft('operation-map', { operationRequirements: f.mapFields.operationRequirements!, mapDesign: null }, f.mapInputs);
  const beforeMap = researchPrerequisites(f.store, mapDraft).find(row => row.stage === 'concept')!.operationMapMaterial as any;
  assert.deepEqual(beforeMap.basis.blocks, []);
  const proposedMap = researchPrerequisites(f.store, mapDraft,
    { field: 'mapDesign', value: f.mapFields.mapDesign! }).find(row => row.stage === 'concept')!.operationMapMaterial as any;
  assert.deepEqual(proposedMap.basis.blocks[0].grounds,
    [f.catalogue.variant.address, f.catalogue.constraints[0]!.address]);
  const featureDraft = f.draft('features', { featurePreparation: null }, f.featureInputs);
  const beforeFeature = researchPrerequisites(f.store, featureDraft).find(row => row.stage === 'specification')!.featureBasisMaterial!;
  assert.deepEqual(beforeFeature.selected, []);
  const proposedFeature = researchPrerequisites(f.store, featureDraft,
    { field: 'featurePreparation', value: f.featureFields.featurePreparation! }).find(row => row.stage === 'specification')!.featureBasisMaterial!;
  assert.deepEqual(proposedFeature.selected[0]!.grounds,
    [f.catalogue.variant.address, f.catalogue.constraints[0]!.address]);
});

test('real v6 assessors receive selected grounds of the map and feature answers before draft application', async t => {
  const f = fixture(t), engine = new ProductEngine(f.store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Basis inheritance' });
  const source = engine.discovery.evidence.document('p', 'brief', 'Offer both routes and saved results offline.', 'text/plain', 0);
  const citations = [{ source: reference(source), selector: { kind: 'text-range' as const, start: 0,
    end: source.value.content.length } }];
  const log = join(f.root, 'assessments.jsonl'), adapter = join(f.root, 'assessor.mjs');
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),context=request.subject;
appendFileSync(${JSON.stringify(log)},JSON.stringify({field:context.question.field,
  prerequisites:context.prerequisites})+'\\n');
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,
  research:{verdict:'supported',reasons:[]}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const discovery = new Discovery(f.store);
  const field = (name: string, schema: Json) => ({ field: name, kind: 'design' as const,
    prompt: `Propose ${name}`, risk: `Missing ${name}`, schema });
  const mapDraft = discovery.create('p', 'operation-map', 'R0', 'operation-map',
    [field('operationRequirements', { type: 'object' }), field('mapDesign', { type: 'object' })], f.mapInputs, 6);
  const requirements = f.store.get<Question>(mapDraft.value.questions[0]!)!;
  discovery.decision(requirements.id, requirements.revision, 'owner', f.mapFields.operationRequirements!);
  const mapQuestion = f.store.get<Question>(mapDraft.value.questions[1]!)!;
  const mapResult = await assessAnswer(f.store, mapQuestion, { action: 'answer', question: mapQuestion.id,
    value: f.mapFields.mapDesign!, citations }, environment, f.root);
  assert.equal(mapResult.value.verdict, 'supported');
  const featureDraft = discovery.create('p', 'features', 'R0', 'features',
    [field('featurePreparation', { type: 'array' })], f.featureInputs, 6);
  const featureQuestion = f.store.get<Question>(featureDraft.value.questions[0]!)!;
  const featureResult = await assessAnswer(f.store, featureQuestion, { action: 'answer', question: featureQuestion.id,
    value: f.featureFields.featurePreparation!, citations }, environment, f.root);
  assert.equal(featureResult.value.verdict, 'supported');
  const sent = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(sent.map(row => row.field), ['mapDesign', 'featurePreparation']);
  assert.deepEqual(sent[0].prerequisites.find((row: any) => row.stage === 'concept')
    .operationMapMaterial.basis.blocks[0].grounds, [f.catalogue.variant.address, f.catalogue.constraints[0]!.address]);
  assert.deepEqual(sent[1].prerequisites.find((row: any) => row.stage === 'specification')
    .featureBasisMaterial.selected[0].grounds, [f.catalogue.variant.address, f.catalogue.constraints[0]!.address]);
  const reopened = new Store(join(f.root, 'state.sqlite'));
  t.after(() => reopened.close());
  const resumedQuestion = reopened.get<Question>(featureQuestion.id)!;
  const resumed = await assessAnswer(reopened, resumedQuestion, { action: 'answer', question: resumedQuestion.id,
    value: f.featureFields.featurePreparation!, citations }, environment, f.root);
  assert.equal(resumed.value.verdict, 'supported');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2,
    'The new Store must reuse the paid assessment and its original selected grounds');
});

test('real v6 map and feature runs retain grounds across the analyst continuation and owner escalation', async t => {
  const f = fixture(t), engine = new ProductEngine(f.store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Basis inheritance' });
  const source = engine.discovery.evidence.document('p', 'brief', 'Offer both routes and saved results offline.', 'text/plain', 0);
  const log = join(f.root, 'runs.jsonl'), adapter = join(f.root, 'runner.mjs');
  writeFileSync(adapter, `import {readFileSync,appendFileSync,existsSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),context=request.subject,log=${JSON.stringify(log)};
const field=context.question?.field??context.questions?.[0]?.field;
const past=existsSync(log)?readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse):[];
appendFileSync(log,JSON.stringify({field,role:context.role,archive:context.working?.archive,
  prerequisites:context.prerequisites??null,continuation:context.continuation??null})+'\\n');
let research;
if(context.role==='assess-escalation')research={necessary:true,reason:'Only the owner can choose'};
else if(!past.some(row=>row.field===field&&row.role==='research'))research={action:'read_source',
  source:${JSON.stringify(reference(source))},start:0,end:${source.value.content.length}};
else research={action:'need_owner',question:context.questions?.[0]?.id??context.question?.id,
  reason:'Choose the remaining route',searched:[${JSON.stringify(reference(source))}]};
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const discovery = new Discovery(f.store);
  const field = (name: string, schema: Json) => ({ field: name, kind: 'design' as const,
    prompt: `Propose ${name}`, risk: `Missing ${name}`, schema });
  const mapDraft = discovery.create('p', 'operation-map', 'R0', 'operation-map',
    [field('operationRequirements', { type: 'object' }), field('mapDesign', { type: 'object' })], f.mapInputs, 6);
  const requirements = f.store.get<Question>(mapDraft.value.questions[0]!)!;
  discovery.decision(requirements.id, requirements.revision, 'owner', f.mapFields.operationRequirements!);
  const featureDraft = discovery.create('p', 'features', 'R0', 'features',
    [field('featurePreparation', { type: 'array' })], f.featureInputs, 6);
  for (const draft of [mapDraft, featureDraft]) {
    const run = await engine.researcher.run('p', draft.id, 2);
    assert.equal(run.value.status, 'needs_owner', JSON.stringify(run.value));
  }
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const name of ['mapDesign', 'featurePreparation']) {
    const sent = calls.filter(row => row.field === name);
    assert.deepEqual(sent.map(row => row.role), ['research', 'research', 'assess-escalation']);
    for (const row of sent) {
      const archive = f.store.get(row.archive.id, row.archive.revision)!;
      const delivered = contextValue(archive.value, '/body/prerequisites') as any[];
      const material = delivered.find(entry => entry.stage === (name === 'mapDesign' ? 'concept' : 'specification'))
        [name === 'mapDesign' ? 'operationMapMaterial' : 'featureBasisMaterial'];
      assert.deepEqual(name === 'mapDesign' ? material.basis.catalogue : material.catalogue, f.catalogue);
      if (row.continuation) {
        const current = f.store.get(row.continuation.current.id, row.continuation.current.revision)!;
        assert.deepEqual(contextValue(current.value, '/body/prerequisites'), delivered);
      } else assert.deepEqual(row.prerequisites, delivered);
    }
  }
});

test('old-era material stays unchanged and v6 refuses absent, foreign and mismatched grounds', t => {
  const f = fixture(t);
  const old = researchPrerequisites(f.store, f.draft('operation-map', f.mapFields, f.mapInputs, 5));
  assert.equal(old.find(row => row.stage === 'concept')!.operationMapMaterial!.contract, 'operation-map-material/v1');
  assert.equal('basis' in old.find(row => row.stage === 'concept')!.operationMapMaterial!, false);
  assert.equal(researchPrerequisites(f.store, f.draft('features', f.featureFields, f.featureInputs, 5))
    .find(row => row.stage === 'specification')!.featureBasisMaterial, undefined);
  const missing = { ...f.draft('features', f.featureFields, f.featureInputs), inputs: f.featureInputs.filter(ref => ref.id !== f.specification.id) };
  assert.throws(() => researchPrerequisites(f.store, missing), (error: unknown) =>
    error instanceof EngineError && error.code === 'basis_inheritance_material_invalid'
      && (error.details as any).field === 'specification');
  const foreign = { ...f.draft('features', f.featureFields, f.featureInputs), fields: {
    featurePreparation: [{ featureTitle: 'Execute', behaviorContracts: ['foreign'], requirements: ['route'] }],
  } };
  assert.throws(() => researchPrerequisites(f.store, foreign), { code: 'basis_inheritance_material_invalid' });
  const wrongUnion = { ...f.draft('features', f.featureFields, f.featureInputs), fields: {
    featurePreparation: [{ featureTitle: 'Execute', behaviorContracts: ['execute-behavior'], requirements: ['route'] }],
  } };
  assert.throws(() => researchPrerequisites(f.store, wrongUnion), { code: 'basis_inheritance_material_invalid' });
  const badBlock = { ...f.draft('operation-map', f.mapFields, f.mapInputs), fields: {
    ...f.mapFields, mapDesign: { nodes: [{ id: 'execute', kind: 'block', implements: ['foreign'] }] },
  } };
  assert.throws(() => researchPrerequisites(f.store, badBlock), { code: 'basis_inheritance_material_invalid' });
});

test('historical inheritance resolves original refs after a newer Discovery head appears', t => {
  const f = fixture(t), draft = f.draft('features', f.featureFields, f.featureInputs);
  const before = researchPrerequisites(f.store, draft);
  f.store.write<StageArtifact>({ id: f.discovery.id, kind: 'stage', expected: f.discovery.revision,
    value: { ...f.discovery.value, content: { fields: { preparation: { constraints: [] }, verdict: { outcome: 'go', variant: 'Other route' } }, graph: null } } });
  assert.deepEqual(researchPrerequisites(f.store, draft), before);
});

test('selected contracts, requirements, coverage and implements cannot use duplicates as missing links', t => {
  const f = fixture(t);
  const feature = f.draft('features', { featurePreparation: null }, f.featureInputs);
  for (const candidate of [
    [{ featureTitle: 'Execute', behaviorContracts: ['execute-behavior'], requirements: ['route', 'route'] }],
    [{ featureTitle: 'Execute', behaviorContracts: ['execute-behavior', 'execute-behavior'], requirements: ['route', 'offline'] }],
  ]) assert.throws(() => researchPrerequisites(f.store, feature,
    { field: 'featurePreparation', value: candidate }), { code: 'basis_inheritance_material_invalid' });
  const duplicateCoverage = structuredClone(f.mapFields.operationRequirements!) as any;
  duplicateCoverage.conceptCoverage[1] = duplicateCoverage.conceptCoverage[0];
  const coverageDraft = f.draft('operation-map', { operationRequirements: duplicateCoverage, mapDesign: null }, f.mapInputs);
  assert.throws(() => researchPrerequisites(f.store, coverageDraft), { code: 'basis_inheritance_material_invalid' });
  const designDraft = f.draft('operation-map', { operationRequirements: f.mapFields.operationRequirements!, mapDesign: null }, f.mapInputs);
  assert.throws(() => researchPrerequisites(f.store, designDraft, { field: 'mapDesign', value: {
    nodes: [{ id: 'execute', kind: 'block', implements: ['route', 'route'] }],
  } }), { code: 'basis_inheritance_material_invalid' });
});

test('reopened map and feature answers never return their retained draft value as an accepted ground', t => {
  const f = fixture(t), discovery = new Discovery(f.store);
  const map = f.draft('operation-map', f.mapFields, f.mapInputs);
  const mapQuestion = f.store.get<Question>(map.questions[0]!)!;
  discovery.reopen(mapQuestion.id, mapQuestion.revision);
  const currentMap = f.store.get<DiscoveryDraft>(mapQuestion.value.draftId)!.value;
  const material = researchPrerequisites(f.store, currentMap,
    { field: 'mapDesign', value: f.mapFields.mapDesign! }).find(row => row.stage === 'concept')!.operationMapMaterial as any;
  assert.deepEqual(material.basis.coverage, []);
  assert.deepEqual(material.basis.blocks, []);
  const feature = f.draft('features', f.featureFields, f.featureInputs);
  const featureQuestion = f.store.get<Question>(feature.questions[0]!)!;
  discovery.reopen(featureQuestion.id, featureQuestion.revision);
  const currentFeature = f.store.get<DiscoveryDraft>(featureQuestion.value.draftId)!.value;
  const selected = researchPrerequisites(f.store, currentFeature).find(row => row.stage === 'specification')!.featureBasisMaterial!.selected;
  assert.deepEqual(selected, []);
});

test('candidate refusal needs the exact delivered inheritance material, never a current or missing premise', t => {
  const f = fixture(t);
  const draft = f.draft('features', { featurePreparation: null }, f.featureInputs);
  const original = researchPrerequisites(f.store, draft);
  const candidate = [{ featureTitle: 'Execute', behaviorContracts: ['foreign'], requirements: ['route'] }];
  assert.equal(inheritanceCandidateFailure(draft, 'featurePreparation', candidate, original)?.code,
    'basis_inheritance_material_invalid');
  assert.equal(inheritanceCandidateFailure(draft, 'featurePreparation', candidate, null), null);
  const changed = structuredClone(original) as any[];
  changed.find(row => row.stage === 'specification').featureBasisMaterial.sources.specification.hash = 'foreign';
  assert.equal(inheritanceCandidateFailure(draft, 'featurePreparation', candidate, changed), null);
  assert.equal(inheritanceCandidateFailure({ ...draft, contractVersion: 5 }, 'featurePreparation', candidate, original), null);
  const map = f.draft('operation-map', { operationRequirements: f.mapFields.operationRequirements!, mapDesign: null }, f.mapInputs);
  const mapMaterial = researchPrerequisites(f.store, map);
  const badMap = { nodes: [{ id: 'execute', kind: 'block', implements: ['foreign'] }] };
  assert.equal(inheritanceCandidateFailure(map, 'mapDesign', badMap, mapMaterial)?.code,
    'basis_inheritance_material_invalid');
  const missingCoverage = structuredClone(mapMaterial) as any[];
  missingCoverage.find(row => row.stage === 'concept').operationMapMaterial.basis.coverage = [{ requirement: 'foreign', outcome: 'result' }];
  assert.equal(inheritanceCandidateFailure(map, 'mapDesign', badMap, missingCoverage), null,
    'A corrupt accepted premise is technical, never a model correction');
});

for (const kind of ['foreign', 'wrong-union'] as const) test(`invalid ${kind} feature answer repairs after restart without replaying its payment`, async t => {
  const f = fixture(t), engine = new ProductEngine(f.store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Feature grounds' });
  const source = engine.discovery.evidence.document('p', 'brief', 'Offer both routes and saved results offline.', 'text/plain', 0);
  const valid = preparedField('p', 'featurePreparation') as any[];
  Object.assign(valid[0], { outcome: 'result', beneficiary: 'user', behaviorContracts: ['execute-behavior'],
    requirements: ['route', 'offline'] });
  const bad = structuredClone(valid);
  if (kind === 'foreign') bad[0].behaviorContracts = ['foreign'];
  else bad[0].requirements = ['route'];
  const log = join(f.root, 'corrections.jsonl'), adapter = join(f.root, 'feature-adapter.mjs');
  writeFileSync(adapter, `import{readFileSync,appendFileSync,existsSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject,log=${JSON.stringify(log)};
const old=existsSync(log)?readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse):[];
appendFileSync(log,JSON.stringify({role:c.role,failures:c.failures??[]})+'\\n');
const research=c.role==='assess-answer'?{verdict:'supported',reasons:[]}:!old.length
  ?{action:'read_source',source:${JSON.stringify(reference(source))},start:0,end:${source.value.content.length}}
  :{action:'answer',question:c.question?.id??c.questions?.[0]?.id,
    value:c.failures?.length?${JSON.stringify(valid)}:${JSON.stringify(bad)},
    citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'text-range',start:0,end:${source.value.content.length}}}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const draft = engine.discovery.create('p', 'features', 'R0', 'features', VERSION6_REQUIREMENTS.features, f.featureInputs, 6);
  for (const id of draft.value.questions) {
    const question = f.store.get<Question>(id)!;
    if (question.value.spec.field !== 'featurePreparation')
      engine.discovery.decision(id, question.revision, 'owner', preparedField('p', question.value.spec.field));
  }
  const first = await engine.researcher.run('p', draft.id, 4);
  assert.equal(first.value.status, 'paused');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
  const reopened = new Store(join(f.root, 'state.sqlite'));
  t.after(() => reopened.close());
  const resumed = await new ProductEngine(reopened).researcher.run('p', draft.id, 4);
  assert.equal(resumed.value.status, 'completed');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 4);
  assert.equal(calls.filter(call => call.role === 'research').length, 3);
  assert.ok(reopened.list<any>('research-turn').some(turn => turn.value.status === 'completed'
    && (turn.value.observation as { code?: string } | null)?.code === 'basis_inheritance_material_invalid'));
});
