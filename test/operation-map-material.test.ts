import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Write } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, stageId, type Ref } from '../src/pipeline/contracts.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { researchPrerequisites } from '../src/discovery/research-context.js';
import { contextValue, workingContext } from '../src/discovery/working-context.js';
import { REQUIREMENTS, UPSTREAM_STAGES, RESEARCH_CONTRACT_VERSION, type UpstreamStage } from '../src/discovery/requirements.js';
import { EngineError } from '../src/errors.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { previewResearch } from '../src/discovery/research-preview.js';
import type { Graph } from '../src/graph/model.js';
import { designOf } from '../src/graph/builder.js';
import { preparedField } from './preparation-fixture.js';
import { currentUpstreamFixtureValue } from './product-fixture.js';
import { exampleGraph } from './graph-fixture.js';
import { enrichedGraph } from './enriched-graph-fixture.js';

function fixture(t: test.TestContext, external = true) {
  const root = mkdtempSync(join(tmpdir(), 'omg-l1a-')), database = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store), adapter = join(root, 'adapter.mjs'), log = join(root, 'wire.jsonl');
  engine.execute({ type: 'create-project', project: 'p', title: 'Service-backed result' });
  const values: Record<string, any> = Object.fromEntries(UPSTREAM_STAGES.flatMap(stage => REQUIREMENTS[stage].map(s => [s.field, preparedField('p', s.field)])));
  const outcome = 'p:ready-result.v1', actor = 'p:actor-requester', requirement = 'p:requirement-result';
  const replace = (value: any) => JSON.parse(JSON.stringify(value).replaceAll('p-result', outcome).replaceAll('p-user', actor).replaceAll('p-R1', requirement));
  for (const key of Object.keys(values)) values[key] = replace(values[key]);
  values['preparation'].externalSystems = external ? [{ id: 'vendor-service', purpose: 'Transform submitted input', inputs: ['caller request'], outputs: ['documented response'], availability: 'Documented service; runtime access is not established' }] : [];
  values['mapDesign'] = designOf(enrichedGraph(replace(exampleGraph('p')), 'p', values['preparation'], values['conceptSections']));
  const source = engine.discovery.evidence.document('p', 'service-documentation', JSON.stringify(values), 'application/json', 0);
  writeFileSync(join(root, 'values.json'), JSON.stringify(values));
  writeFileSync(adapter, `import{boundDiscoveryValue}from ${JSON.stringify(new URL('./preparation-fixture.js', import.meta.url).href)};
import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';
const root=${JSON.stringify(root)},r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,q=s.question??s.questions?.[0],role=s.continuation.role;
appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');
const file=root+'/counts.json',counts=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{},key=q.id+':'+role,n=(counts[key]??0)+1;
counts[key]=n;writeFileSync(file,JSON.stringify(counts));
const map=['operationRequirements','mapDesign'].includes(q.field),source=${JSON.stringify(reference(source))},pointer='/body/prerequisites/0/operationMapMaterial/catalogue';let research;
if(role==='assessor') research=map&&n===1?{action:'read_context',record:s.working.archive,pointer}:{verdict:'supported',reasons:[]};
else if(n===1) research={action:'read_source',source,start:0,end:${source.value.content.length}};
else if(map&&n===2&&!s.contextWorkspace.some(x=>x.pointer===pointer)) research={action:'read_context',record:s.working.archive,pointer};
else {
 let value=JSON.parse(readFileSync(root+'/values.json','utf8'))[q.field];
 if(map){
  const catalogue=s.contextWorkspace.find(x=>x.pointer===pointer)?.value;
  if(!catalogue)throw Error('The current model packet did not deliver the requested catalogue');
  if(q.field==='operationRequirements')value={...value,outcomes:value.outcomes.map((x,i)=>({...x,outcome:catalogue.outcomes[i].id})),conceptCoverage:catalogue.requirements.map(x=>({requirement:x.id,outcome:x.outcome}))};
  else value=JSON.parse(JSON.stringify(value).replaceAll(${JSON.stringify(outcome)},catalogue.outcomes[0].id));
 }
 research={action:'answer',question:q.id,value:boundDiscoveryValue(q.field,value,s.discoveryContext),citations:[{source,selector:{kind:'json-pointer',pointer:'/'+q.field}}]};
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'medium', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'medium', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  const wires = (): any[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const prepare = (stage: UpstreamStage) => {
    const draft = engine.prepare('p', stage);
    for (const id of draft.value.questions) {
      const question = store.get<Question>(id)!;
      if (question.value.spec.kind === 'fact') engine.discovery.fact(id, question.revision, reference(source), { kind: 'json-pointer', pointer: '/' + question.value.spec.field });
      if (question.value.spec.kind === 'decision') engine.discovery.decision(id, question.revision, 'owner', values[question.value.spec.field]);
    }
    return store.get<DiscoveryDraft>(draft.id)!;
  };
  const run = async (draftId: string, db = store) => {
    const result = await new ProductEngine(db).stageResearch.run('p', draftId, 30);
    if (result.status !== 'accepted' && result.research) {
      const run = db.get<any>(result.research.id)!.value;
      t.diagnostic(JSON.stringify({ status: run.status, code: run.pauseCode, error: run.error }));
    }
    return result;
  };
  const mapDraft = async () => {
    for (const stage of ['discovery', 'concept'] as const) {
      const draft = prepare(stage), result = await run(draft.id);
      assert.equal(result.status, 'accepted', JSON.stringify(result));
      if (stage === 'discovery') writeFileSync(join(root, 'values.json'), JSON.stringify({ ...values,
        conceptSections: currentUpstreamFixtureValue(engine, 'p', 'conceptSections', values['conceptSections']) }));
    }
    return prepare('operation-map');
  };
  return { root, store, engine, open, source, environment, values, outcome, actor, requirement, wires, prepare, run, mapDraft };
}

function addressed(store: Store, ref: Ref, pointer: string): any {
  const record = store.get(ref.id, ref.revision); assert.ok(record); assert.equal(record.hash, ref.hash);
  return contextValue(record.value, pointer);
}

for (const external of [true, false]) test(`L1A real map shares exact material with A and B, external systems ${external ? 'present' : 'explicitly empty'}`, async t => {
  const f = fixture(t, external), draft = await f.mapDraft(), result = await f.run(draft.id);
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(draft.value.contractVersion, RESEARCH_CONTRACT_VERSION);
  assert.deepEqual(draft.value.questions.map(id => f.store.get<Question>(id)!.value.spec), REQUIREMENTS['operation-map']);
  const acceptedDraft = f.store.get<DiscoveryDraft>(draft.id)!;
  const expected = researchPrerequisites(f.store, acceptedDraft.value), material = expected[0]!.operationMapMaterial!;
  assert.equal(material.contract, 'operation-map-material/v2');
  const basis = (material as unknown as { basis: { requirements: { id: string; grounds: unknown[] }[] } }).basis;
  assert.ok(basis.requirements.some(row => row.id === f.requirement && row.grounds.length > 0));
  assert.deepEqual(material.catalogue.outcomes.map(x => x.id), [f.outcome]);
  assert.deepEqual(material.catalogue.actors.map(x => x.id), [f.actor]);
  assert.deepEqual(material.catalogue.requirements.map(x => [x.id, x.outcome]), [[f.requirement, f.outcome]]);
  assert.equal(material.engineRules.origin, 'engine-rule');
  assert.ok(material.engineRules.rules.some(rule => rule.includes('intermediate artifacts are allowed')));
  assert.ok(material.engineRules.rules.some(rule => rule.includes('artifact.external=true') && rule.includes('documentary Source')));
  assert.ok(material.engineRules.rules.some(rule => rule.includes('does not require one separate block')));
  assert.deepEqual((expected.find(x => x.stage === 'discovery')!.fields['preparation'] as any).externalSystems, f.values['preparation'].externalSystems);
  for (const row of [...material.catalogue.outcomes, ...material.catalogue.actors, ...material.catalogue.requirements])
    assert.equal(addressed(f.store, row.source.record, row.source.pointer).id, row.id);
  const wires = f.wires().filter(w => ['operationRequirements', 'mapDesign'].includes(w.subject.question.field));
  assert.equal(wires.length, 10);
  for (const field of ['operationRequirements', 'mapDesign']) for (const role of ['analyst', 'assessor']) {
    const pair = wires.filter(w => w.subject.question.field === field && w.subject.continuation.role === role);
    assert.equal(pair.length, role === 'analyst' ? 3 : 2);
    const delivered = structuredClone(expected);
    const selected = delivered[0]!.operationMapMaterial as unknown as { basis: { coverage: unknown[]; blocks: unknown[] } };
    if (field === 'operationRequirements') selected.basis.coverage = [];
    if (field !== 'mapDesign' || role !== 'assessor') selected.basis.blocks = [];
    assert.deepEqual(pair[0].subject.prerequisites, delivered, `${role} ${field}: initial delivery`);
    assert.equal(pair[1].subject.continuation.kind, 'continuation');
    assert.deepEqual(addressed(f.store, pair[1].subject.continuation.foundation, '/body/prerequisites'), delivered);
    assert.deepEqual(addressed(f.store, pair[1].subject.continuation.current, '/body/prerequisites/0/operationMapMaterial'), selected);
    assert.ok(pair[1].subject.continuation.foundationPointers.includes('/body/prerequisites'));
    for (const wire of pair) for (const section of wire.subject.working.sections)
      addressed(f.store, wire.subject.working.archive, section.pointer);
    assert.deepEqual(pair.at(-1).subject.contextWorkspace.find((x: any) => x.pointer.endsWith('/catalogue')).value, material.catalogue);
  }
  const graph = f.store.get<Graph>('graph:p')!.value;
  assert.ok(graph.artifacts.some(x => x.id === f.outcome && x.terminal));
  assert.ok(graph.artifacts.some(x => x.id === 'p-data' && !x.terminal), 'Intermediate result is legal');
  assert.ok(graph.journeys?.some(x => x.outcome === f.outcome && x.terminal === 'success'));
  assert.ok(!graph.artifacts.some(x => x.id === 'vendor-service' || x.id === f.source.id || x.external));
  assert.ok(!graph.nodes.some(x => x.id === 'vendor-service'), 'Listing a service does not require a block');
  const count = f.wires().length;
  assert.equal((await f.run(draft.id, f.open())).status, 'accepted'); assert.equal(f.wires().length, count);
});

for (const role of ['analyst', 'assessor']) test(`L1A paid ${role} map request resumes its exact saved material after restart`, async t => {
  const f = fixture(t), draft = await f.mapDraft(), original = f.store.writeMany.bind(f.store); let hit = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    const rows = original(writes, guards), sent = f.wires().at(-1)?.subject;
    if (!hit && writes.some(write => write.kind === 'model-response'
      && String((write.value as any).text).includes(role === 'analyst' ? '"action":"answer"' : '"verdict":"supported"')) && sent?.question.field === 'mapDesign'
      && sent.continuation.role === role && sent.contextWorkspace.some((x: any) => x.pointer.endsWith('/catalogue'))) {
      hit = true; throw new EngineError('fixture_application_crash', 'Stop after the paid map answer is durable');
    }
    return rows;
  }) as typeof f.store.writeMany;
  const stopped = await f.run(draft.id); f.store.writeMany = original;
  assert.ok(hit); assert.notEqual(stopped.status, 'accepted');
  const before = f.wires(), roleCount = before.filter(w => w.subject.continuation.role === role).length;
  const archives = f.store.list('research-context'), db = f.open();
  const resumed = await f.run(draft.id, db);
  assert.equal(resumed.status, 'accepted', JSON.stringify(resumed));
  assert.equal(f.wires().filter(w => w.subject.continuation.role === role).length, roleCount, 'No replacement call for a paid reply');
  for (const row of archives) assert.deepEqual(db.get(row.id, row.revision), row, 'Saved request is never rebuilt');
  if (role === 'assessor') assert.equal(f.wires().length, before.length, 'Terminal B completes without any new call');
  const count = f.wires().length;
  assert.equal((await f.run(draft.id, f.open())).status, 'accepted'); assert.equal(f.wires().length, count);
});

test('L1A refuses missing, ambiguous and foreign prerequisite references without changing records', async t => {
  const f = fixture(t), draft = await f.mapDraft(), heads = f.store.list();
  for (const stage of ['discovery', 'concept'] as const) {
    const id = stageId('p', stage), ref = draft.value.inputs.find(x => x.id === id)!;
    for (const inputs of [draft.value.inputs.filter(x => x.id !== id), [...draft.value.inputs, ref],
      draft.value.inputs.map(x => x.id === id ? { ...x, id: stageId('another-project', stage) } : x)])
      assert.throws(() => researchPrerequisites(f.store, { ...draft.value, inputs }), (error: unknown) =>
        error instanceof EngineError && error.code === 'operation_map_material_invalid' && (error.details as any).target === id);
  }
  assert.deepEqual(f.store.list(), heads);
  const copy = researchPrerequisites(f.store, draft.value);
  copy[0]!.operationMapMaterial!.catalogue.outcomes[0]!.id = 'changed-by-caller';
  assert.equal(researchPrerequisites(f.store, draft.value)[0]!.operationMapMaterial!.catalogue.outcomes[0]!.id, f.outcome);
  const prior = f.store.get<any>(stageId('p', 'discovery'))!;
  const revised = f.engine.draft('p', 'discovery', prior.value.content.draft.id, prior.revision);
  const accepted = f.engine.pipeline.accept('p', 'discovery', revised.revision);
  const mixed = { ...draft.value, inputs: draft.value.inputs.map(ref => ref.id === accepted.id ? reference(accepted) : ref) };
  assert.throws(() => researchPrerequisites(f.store, mixed), (error: unknown) => error instanceof EngineError
    && error.code === 'operation_map_material_invalid' && (error.details as any).target === stageId('p', 'concept'));
  assert.equal(researchPrerequisites(f.store, draft.value)[0]!.operationMapMaterial!.sources.discovery.revision, prior.revision);
});

for (const stage of ['discovery', 'concept'] as const) test(`L1A exact prerequisites remain historical while native ${stage} change refuses the next packet atomically`, async t => {
  const f = fixture(t), draft = await f.mapDraft(), expected = researchPrerequisites(f.store, draft.value);
  const question = f.store.get<Question>(draft.value.questions[1]!)!, original = f.store.writeMany.bind(f.store); let hit = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!hit && writes.some(write => write.kind === 'research-context')) {
      hit = true;
      const other = new ProductEngine(f.open()), artifact = other.store.get(stageId('p', stage))!;
      const oldDraft = (artifact.value as any).content.draft.id;
      other.draft('p', stage, oldDraft, artifact.revision);
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  const calls = f.wires().length;
  assert.throws(() => workingContext(f.store, 'p', draft.id, question.id,
    { role: 'research', question: { id: question.id, ...question.value.spec }, prerequisites: expected }, 100000, { common: true }), { code: 'input_stale' });
  f.store.writeMany = original; assert.ok(hit);
  assert.deepEqual(researchPrerequisites(f.store, draft.value), expected, 'Never mix old draft inputs with current stage heads');
  assert.equal(f.wires().length, calls);
  assert.equal(f.store.list<any>('research-context').filter(row => row.value.draft.id === draft.id).length, 0);
});


test('L1A first catalogue in an existing A/B continuation is delivered instead of labelled already sent', async t => {
  const f = fixture(t), draft = await f.mapDraft();
  const question = f.store.get<Question>(draft.value.questions[1]!)!;
  const prerequisites = researchPrerequisites(f.store, draft.value);
  const beforeCatalogue = prerequisites.map(({ ref, stage, fields }) => {
    const priorFields = structuredClone(fields);
    if (stage === 'discovery') delete (priorFields['preparation'] as any).externalSystems;
    return { ref, stage, fields: priorFields };
  });
  for (const role of ['analyst', 'assessor']) {
    const context = { role: role === 'analyst' ? 'research' : 'assess-answer', question: { id: question.id, ...question.value.spec },
      prerequisites: beforeCatalogue, contextWorkspace: [], ...(role === 'assessor' ? { assessmentState: { offset: 0 }, value: f.values['operationRequirements'], observations: [] } : {}) };
    const audit = { store: f.store, draftId: draft.id, questionId: question.id, purpose: role };
    const who = role === 'analyst' ? f.environment.value.implementer : f.environment.value.reviewer;
    const invoke = (body: unknown) => researchCall(who, f.environment.value, 'Read the exact accepted material', body, undefined, audit);
    await invoke(context);
    const original = f.wires().at(-1)!;
    assert.equal(original.subject.prerequisites[0].operationMapMaterial, undefined);
    const updated = { ...context, prerequisites };
    await invoke(updated);
    const next = f.wires().at(-1)!;
    assert.equal(next.subject.continuation.kind, 'continuation');
    assert.deepEqual(next.subject.prerequisites, prerequisites);
    assert.equal(addressed(f.store, next.subject.continuation.foundation, '/body/prerequisites')[0].operationMapMaterial, undefined);
    assert.deepEqual(addressed(f.store, next.subject.continuation.current, '/body/prerequisites/0/operationMapMaterial'), prerequisites[0]!.operationMapMaterial);
    const saved = f.store.get<any>(original.subject.working.archive.id, original.subject.working.archive.revision)!;
    assert.deepEqual(saved.value.body.prerequisites, beforeCatalogue, 'The previously delivered request keeps its original material');
    const preview = JSON.parse((await previewResearch(() => invoke(updated))).input);
    assert.equal(preview.subject.prerequisites, undefined, 'Already delivered material is not repeated on every call');
    assert.deepEqual(addressed(f.store, preview.subject.continuation.current, '/body/prerequisites/0/operationMapMaterial'), prerequisites[0]!.operationMapMaterial);
    const count = f.wires().length;
    assert.throws(() => workingContext(f.store, 'p', draft.id, question.id, updated, 1000,
      { continuation: true, common: true, previous: original.subject.working.archive }), { code: 'pilot_core_limit' });
    assert.equal(f.wires().length, count, 'Oversized new material refuses before another physical call');
  }
});
