import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { hashJson, type Json } from '../src/canonical.js';
import { discoveryBasisCatalogue } from '../src/discovery/discovery-outcome.js';
import { behaviorContractsApplicationsSchema, behaviorContractsSchema } from '../src/discovery/preparation-contracts.js';
import { specificationApplicationFindings } from '../src/discovery/preparation-validation.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import { VERSION6_REQUIREMENTS } from '../src/discovery/requirements.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import { StageChecks } from '../src/product/stage-checks.js';
import { reference, stageId, type StageArtifact } from '../src/pipeline/contracts.js';
import { Store, type Write } from '../src/storage/store.js';
import { EngineError } from '../src/errors.js';
import { preparedField } from './preparation-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { contextValue, workingContext } from '../src/discovery/working-context.js';
import { researchPrerequisites } from '../src/discovery/research-context.js';

const origin = { id: 'stage:p:discovery', revision: 1, hash: hashJson('discovery basis') };
const originFields = { preparation: { actors: [], outcomes: [], constraints: [{ id: 'offline', rule: 'Saved results remain available offline', basis: 'owner brief' }] },
  verdict: { outcome: 'go', variant: 'One subscribed vendor and a separate API route' } } as unknown as Record<string, Json>;
const catalogue = discoveryBasisCatalogue({ ref: origin, fields: originFields });
const apply = (basis: typeof catalogue.variant.address, ...appliedAt: string[]) =>
  ({ contract: 'basis-application/v1', basis, appliedAt });
const concept = (): Json => [{ id: 'flow', title: 'Run a request', requirements: [
  { id: 'route', statement: 'Offer a subscribed vendor and a separate API route', benefit: 'Choose a route',
    beneficiary: 'user', outcome: 'result', acceptance: ['Both routes can complete'],
    applications: [apply(catalogue.variant.address, '/0/requirements/0/statement')] },
  { id: 'offline', statement: 'Keep saved results readable offline', benefit: 'Read prior work',
    beneficiary: 'user', outcome: 'result', acceptance: ['No network is required to read saved results'],
    applications: [apply(catalogue.constraints[0]!.address, '/0/requirements/1/acceptance/0')] },
] }] as unknown as Json;
const contracts = (): Json => {
  const rows = structuredClone(preparedField('p', 'behaviorContracts')) as Record<string, unknown>[];
  rows[0]!['requirements'] = ['route', 'offline'];
  rows[0]!['entry'] = 'Choose the subscription or API route';
  rows[0]!['success'] = ['Complete the request and save its result for offline reading'];
  rows[0]!['applications'] = [
    apply(catalogue.variant.address, '/0/entry', '/0/success/0'),
    apply(catalogue.constraints[0]!.address, '/0/success/0'),
  ];
  return rows as Json;
};

test('v6 behavior contracts require applications without changing the released v5 schema or constraints strings', () => {
  const ajv = new Ajv({ strict: true, allowUnionTypes: true });
  const v5 = ajv.compile(behaviorContractsSchema as object);
  const v6 = ajv.compile(behaviorContractsApplicationsSchema as object);
  const old = structuredClone(contracts()) as Record<string, unknown>[];
  delete old[0]!['applications'];
  assert.equal(v5(old), true);
  assert.equal(v6(old), false);
  assert.equal(v6(contracts()), true);
  assert.equal(v5(contracts()), false);
  assert.deepEqual(VERSION6_REQUIREMENTS.specification.find(row => row.field === 'constraints')?.schema,
    VERSION6_REQUIREMENTS.specification.find(row => row.field === 'behavior')?.schema);
  assert.equal(JSON.stringify(VERSION6_REQUIREMENTS.specification.find(row => row.field === 'constraints')?.schema)
    .includes('applications'), false);
});

test('each contract applies every basis inherited from its named requirements in its own behavior', () => {
  assert.deepEqual(specificationApplicationFindings(contracts(), concept(), catalogue), []);
  const missing = structuredClone(contracts()) as any[];
  missing[0].applications.pop();
  assert.equal(specificationApplicationFindings(missing, concept(), catalogue)[0]?.code, 'basis_application_missing');
  assert.equal(specificationApplicationFindings(missing, concept(), catalogue)[0]?.field, 'behaviorContracts');
  assert.equal(specificationApplicationFindings(missing, concept(), catalogue)[0]?.target,
    '/behaviorContracts/0/applications');
  const wrongOwner = structuredClone(contracts()) as any[];
  wrongOwner.push({ ...structuredClone(wrongOwner[0]), id: 'second', requirements: ['route'], applications: [] });
  assert.equal(specificationApplicationFindings(wrongOwner, concept(), catalogue)[0]?.target,
    '/behaviorContracts/1/applications');
  const foreign = structuredClone(contracts()) as any[];
  foreign[0].applications[0].basis.record = { ...origin, id: 'stage:other:discovery' };
  assert.equal(specificationApplicationFindings(foreign, concept(), catalogue)[0]?.code, 'basis_application_invalid');
  assert.equal(specificationApplicationFindings(foreign, concept(), catalogue)[0]?.target,
    '/behaviorContracts/0/applications/0/basis');
  const metadata = structuredClone(contracts()) as any[];
  metadata[0].applications[0].appliedAt = ['/0/requirements/0'];
  assert.equal(specificationApplicationFindings(metadata, concept(), catalogue)[0]?.code, 'basis_application_invalid');
  const noBehavior = structuredClone(contracts()) as any[];
  noBehavior[0].inputs = [];
  noBehavior[0].applications[0].appliedAt = ['/0/inputs'];
  assert.equal(specificationApplicationFindings(noBehavior, concept(), catalogue)[0]?.code, 'basis_application_invalid');
  const unrelated = structuredClone(contracts()) as any[];
  unrelated[0].requirements = ['not-in-concept'];
  assert.equal(specificationApplicationFindings(unrelated, concept(), catalogue)[0]?.target,
    '/behaviorContracts/0/requirements');
  assert.equal(specificationApplicationFindings(contracts(), [], catalogue)[0]?.code,
    'basis_application_material_invalid');
});

test('the v6 specification assessor receives exact Discovery, concept and separate constraints', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-spec-basis-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Harness' });
  const source = engine.discovery.evidence.document('p', 'brief', 'Keep saved results available offline.', 'text/plain', 0);
  const citations = [{ source: reference(source), selector: {
    kind: 'text-range' as const, start: 0, end: source.value.content.length } }];
  const log = join(root, 'assessor.json'), adapter = join(root, 'assessor.mjs');
  writeFileSync(adapter, `import {readFileSync,writeFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),context=request.subject;
writeFileSync(${JSON.stringify(log)},JSON.stringify({catalogue:context.discoveryBasisCatalogue,
  concept:context.prerequisites?.find(row=>row.stage==='concept')?.fields?.conceptSections,
  neighbors:context.stageNeighbors,prompt:request.prompt}));
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,
  research:{verdict:'supported',reasons:[]}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const discovery = store.write<StageArtifact>({ id: stageId('p', 'discovery'), kind: 'stage', expected: 0,
    value: { projectId: 'p', stage: 'discovery', status: 'accepted',
      content: { fields: originFields, graph: null }, inputs: [], proofs: [] } });
  const exactCatalogue = discoveryBasisCatalogue({ ref: reference(discovery), fields: originFields });
  const acceptedConcept = structuredClone(concept()) as any[];
  acceptedConcept[0].requirements[0].applications[0].basis = exactCatalogue.variant.address;
  acceptedConcept[0].requirements[1].applications[0].basis = exactCatalogue.constraints[0]!.address;
  const conceptStage = store.write<StageArtifact>({ id: stageId('p', 'concept'), kind: 'stage', expected: 0,
    value: { projectId: 'p', stage: 'concept', status: 'accepted',
      content: { fields: { conceptSections: acceptedConcept }, graph: null }, inputs: [reference(discovery)], proofs: [] } });
  const map = store.write<StageArtifact>({ id: stageId('p', 'operation-map'), kind: 'stage', expected: 0,
    value: { projectId: 'p', stage: 'operation-map', status: 'accepted',
      content: { fields: {}, graph: null }, inputs: [reference(conceptStage)], proofs: [] } });
  const draft = engine.discovery.create('p', 'specification', 'R0', 'specification', VERSION6_REQUIREMENTS.specification,
    [reference(discovery), reference(conceptStage), reference(map)], 6);
  for (const id of draft.value.questions) {
    const question = store.get<Question>(id)!;
    if (question.value.spec.field === 'behaviorContracts') break;
    const value = question.value.spec.field === 'constraints' ? ['Saved results remain available offline']
      : ['The user can run a request'];
    if (question.value.spec.field === 'constraints') {
      const assessed = await assessAnswer(store, question, { action: 'answer', question: id,
        value, citations }, environment, root);
      assert.equal(assessed.value.verdict, 'supported');
      const context = JSON.parse(readFileSync(log, 'utf8'));
      assert.deepEqual(context.catalogue, exactCatalogue);
      assert.deepEqual(context.concept, acceptedConcept);
      assert.match(context.prompt, /compare the separate constraints strings with the exact selected Discovery variant/);
      rmSync(log);
    }
    engine.discovery.decision(id, question.revision, 'owner', value);
  }
  let question = store.get<Question>(draft.value.questions.at(-1)!)!;
  const value = structuredClone(contracts()) as any[];
  value[0].applications[0].basis = exactCatalogue.variant.address;
  value[0].applications[1].basis = exactCatalogue.constraints[0]!.address;
  const missing = structuredClone(value) as any[];
  missing[0].applications.pop();
  engine.discovery.decision(question.id, question.revision, 'owner', missing);
  const proposed = store.get<DiscoveryDraft>(draft.id)!;
  const gate = new StageChecks(store).validateStage('specification', { projectId: 'p',
    content: { draft: reference(proposed), fields: proposed.value.fields, graph: null } as unknown as Json,
    inputs: [map], accepted: true });
  assert.ok(gate.findings.some(row => row.code === 'basis_application_missing'
    && row.field === 'behaviorContracts' && row.target === '/behaviorContracts/0/applications'),
  JSON.stringify(gate.findings));
  question = engine.discovery.reopen(question.id, store.get<Question>(question.id)!.revision);
  await assert.rejects(assessAnswer(store, question, { action: 'answer', question: question.id,
    value: missing, citations }, environment, root), (error: any) => error.code === 'basis_application_missing');
  assert.equal(existsSync(log), false);
  const supported = await assessAnswer(store, question, { action: 'answer', question: question.id,
    value, citations }, environment, root);
  assert.equal(supported.value.verdict, 'supported');
  const sent = JSON.parse(readFileSync(log, 'utf8'));
  assert.deepEqual(sent.catalogue, exactCatalogue);
  assert.deepEqual(sent.concept, acceptedConcept);
  assert.deepEqual(sent.neighbors.fields.find((row: any) => row.field === 'constraints')?.value,
    ['Saved results remain available offline']);
  assert.match(sent.prompt, /compare the separate constraints strings with the exact selected Discovery variant/);
  const peer = new Store(join(root, 'state.sqlite'));
  try {
    const moved = peer.get<StageArtifact>(discovery.id)!;
    peer.write<StageArtifact>({ id: discovery.id, kind: 'stage', expected: moved.revision,
      value: { ...moved.value, content: { fields: { ...originFields,
        verdict: { variant: 'A different route' } }, graph: null } } });
  } finally { peer.close(); }
  assert.throws(() => engine.discovery.researched(question.id, question.revision, reference(supported)),
    (error: any) => error.code === 'research_assessment_basis_stale');
});

test('v6 specification A initial/continuation and C receive the exact catalogue and concept requirements', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-spec-delivery-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), project = 'delivery';
  preparedFeatures(engine, project);
  const source = store.get<any>(`source:${project}:brief`)!;
  const stages = ['discovery', 'concept', 'operation-map'].map(stage => store.get<StageArtifact>(stageId(project, stage as any))!);
  const draft = engine.discovery.create(project, 'specification', 'R0', 'features', VERSION6_REQUIREMENTS.specification,
    stages.map(reference), 6);
  for (const id of draft.value.questions) {
    const question = store.get<Question>(id)!;
    if (question.value.spec.field !== 'behaviorContracts') engine.discovery.decision(id, question.revision, 'owner',
      preparedField(project, question.value.spec.field));
  }
  const current = store.get<DiscoveryDraft>(draft.id)!, behaviorQuestion = store.get<Question>(draft.value.questions.at(-1)!)!;
  const prerequisites = researchPrerequisites(store, current.value);
  const basis = discoveryBasisCatalogue({ ref: reference(stages[0]!),
    fields: (stages[0]!.value.content as { fields: Record<string, Json> }).fields });
  const packet = { role: 'research', question: { id: behaviorQuestion.id, ...behaviorQuestion.value.spec },
    prerequisites, discoveryBasisCatalogue: basis };
  assert.throws(() => workingContext(store, project, draft.id, behaviorQuestion.id,
    { ...packet, discoveryBasisCatalogue: undefined }, 200000), { code: 'context_discovery_incomplete' });
  assert.throws(() => workingContext(store, project, draft.id, behaviorQuestion.id,
    { ...packet, prerequisites: [] }, 200000), { code: 'context_discovery_incomplete' });
  const foreignPrerequisites = structuredClone(prerequisites) as any[];
  foreignPrerequisites.find(row => row.stage === 'concept').ref.id = stageId('foreign', 'concept');
  assert.throws(() => workingContext(store, project, draft.id, behaviorQuestion.id,
    { ...packet, prerequisites: foreignPrerequisites }, 200000), { code: 'context_discovery_incomplete' });
  assert.throws(() => workingContext(store, project, draft.id, behaviorQuestion.id, packet, 100),
    { code: 'pilot_core_limit' });
  const log = join(root, 'calls.jsonl'), adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import {readFileSync,appendFileSync,existsSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),context=request.subject,log=${JSON.stringify(log)};
const previous=existsSync(log)?readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse):[];
appendFileSync(log,JSON.stringify({role:context.role,catalogue:context.discoveryBasisCatalogue??null,
  concept:context.prerequisites?.find(row=>row.stage==='concept')?.fields?.conceptSections??null,
  archive:context.working?.archive??null,continuation:context.continuation??null})+'\\n');
let research;
if(context.role==='assess-escalation')research={necessary:true,reason:'Only the owner can choose the remaining option'};
else if(!previous.some(row=>row.role==='research'))research={action:'read_source',source:${JSON.stringify(reference(source))},start:0,end:${source.value.content.length}};
else research={action:'need_owner',question:context.questions[0].id,reason:'Choose the remaining behavior',searched:[${JSON.stringify(reference(source))}]};
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const run = await engine.researcher.run(project, draft.id, 2);
  assert.equal(run.value.status, 'needs_owner');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(row => row.role), ['research', 'research', 'assess-escalation']);
  const expected = discoveryBasisCatalogue({ ref: reference(stages[0]!),
    fields: (stages[0]!.value.content as { fields: Record<string, Json> }).fields });
  for (const call of calls) {
    assert.deepEqual(call.catalogue, expected);
    const acceptedConcept = (stages[1]!.value.content as { fields: Record<string, Json> }).fields['conceptSections'];
    const archived = store.get(call.archive.id, call.archive.revision)!;
    assert.deepEqual((archived.value as any).body.discoveryBasisCatalogue, expected);
    assert.deepEqual((archived.value as any).body.prerequisites.find((row: any) => row.stage === 'concept')
      .fields.conceptSections, acceptedConcept);
    if (call.concept !== null) assert.deepEqual(call.concept, acceptedConcept);
    else {
      assert.equal(call.continuation.kind, 'continuation');
      const record = store.get(call.continuation.current.id, call.continuation.current.revision)!;
      assert.deepEqual((contextValue(record.value, '/body/prerequisites') as any[])
        .find(row => row.stage === 'concept').fields.conceptSections, acceptedConcept);
    }
  }
});

test('v6 specification refuses a paid incomplete application, then cold restart pays only one correcting A', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-spec-repair-'));
  const database = join(root, 'state.sqlite'), store = new Store(database), stores = [store];
  t.after(() => { for (const opened of stores) opened.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), project = 'repair';
  preparedFeatures(engine, project);
  const source = store.get<any>(`source:${project}:brief`)!, discovery = store.get<StageArtifact>(stageId(project, 'discovery'))!;
  const catalogue = discoveryBasisCatalogue({ ref: reference(discovery),
    fields: (discovery.value.content as { fields: Record<string, Json> }).fields });
  const oldConcept = store.get<StageArtifact>(stageId(project, 'concept'))!;
  const conceptFields = structuredClone((oldConcept.value.content as { fields: Record<string, Json> }).fields) as any;
  const requirement = conceptFields.conceptSections[0].requirements[0];
  const apply = (basis: typeof catalogue.variant.address, appliedAt: string) =>
    ({ contract: 'basis-application/v1', basis, appliedAt: [appliedAt] });
  requirement.applications = [apply(catalogue.variant.address, '/0/requirements/0/statement'),
    ...catalogue.constraints.map(row => apply(row.address, '/0/requirements/0/acceptance/0'))];
  const concept = store.write<StageArtifact>({ id: oldConcept.id, kind: 'stage', expected: oldConcept.revision,
    value: { ...oldConcept.value, content: { ...oldConcept.value.content as object, fields: conceptFields } as any } });
  const oldMap = store.get<StageArtifact>(stageId(project, 'operation-map'))!;
  const map = store.write<StageArtifact>({ id: oldMap.id, kind: 'stage', expected: oldMap.revision,
    value: { ...oldMap.value, inputs: oldMap.value.inputs.map(ref => ref.id === concept.id ? reference(concept) : ref) } });
  const draft = engine.discovery.create(project, 'specification', 'R0', 'features', VERSION6_REQUIREMENTS.specification,
    [reference(discovery), reference(concept), reference(map)], 6);
  for (const id of draft.value.questions) {
    const question = store.get<Question>(id)!;
    if (question.value.spec.field !== 'behaviorContracts') engine.discovery.decision(id, question.revision, 'owner',
      preparedField(project, question.value.spec.field));
  }
  const valid = structuredClone(preparedField(project, 'behaviorContracts')) as any[];
  valid[0].applications = [apply(catalogue.variant.address, '/0/entry'),
    ...catalogue.constraints.map(row => apply(row.address, '/0/success/0'))];
  const incomplete = structuredClone(valid) as any[];
  incomplete[0].applications.pop();
  writeFileSync(join(root, 'valid.json'), JSON.stringify(valid));
  writeFileSync(join(root, 'incomplete.json'), JSON.stringify(incomplete));
  const log = join(root, 'calls.jsonl'), adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import {readFileSync,appendFileSync,existsSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),context=request.subject,log=${JSON.stringify(log)};
const history=existsSync(log)?readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse):[];
appendFileSync(log,JSON.stringify({role:context.role,failures:context.failures??[],
  catalogue:context.discoveryBasisCatalogue??null,archive:context.working?.archive??null})+'\\n');
let research;
if(context.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(!history.some(row=>row.role==='research'))research={action:'read_source',source:${JSON.stringify(reference(source))},start:0,end:${source.value.content.length}};
else research={action:'answer',question:context.question.id,
  value:JSON.parse(readFileSync(${JSON.stringify(root)}+(context.failures?.length?'/valid.json':'/incomplete.json'),'utf8')),
  citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'text-range',start:0,end:${source.value.content.length}}}]};
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const original = store.writeMany.bind(store);
  let stopped = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const saved = original(writes, guards);
    if (!stopped && writes.some(write => write.kind === 'research-turn'
      && (write.value as any)?.observation?.code === 'basis_application_missing')) {
      stopped = true;
      throw new EngineError('fixture_crash', 'Stop after the completed paid refusal is durable');
    }
    return saved;
  }) as typeof store.writeMany;
  try { await engine.researcher.run(project, draft.id, 6); } catch (error) {
    assert.ok(error instanceof EngineError && error.code === 'fixture_crash');
  } finally { store.writeMany = original; }
  assert.equal(stopped, true, 'The first incomplete answer must complete as a repairable refusal');
  const before = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(before.filter(row => row.role === 'research').length, 2);
  const reopened = new Store(database); stores.push(reopened);
  const resumed = await new ProductEngine(reopened).researcher.run(project, draft.id, 6);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(resumed.value.status, 'completed', JSON.stringify({ run: resumed.value, calls }));
  assert.equal(calls.filter(row => row.role === 'research').length, 3, 'Only the correcting A is newly paid');
  assert.equal(calls.filter(row => row.role === 'assess-answer').length, 1);
  assert.equal(calls[2]!.failures[0].code, 'basis_application_missing');
  assert.deepEqual(calls[2]!.catalogue, catalogue);
  assert.equal(reopened.get<Question>(draft.value.questions.at(-1)!)!.value.status, 'answered');
});
