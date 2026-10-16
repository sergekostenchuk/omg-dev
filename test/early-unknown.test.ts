import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { Store, type Write } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, stageId, type StageArtifact } from '../src/pipeline/contracts.js';
import { earlyResearchCorrection, earlyResearchFailure, earlyUpstreamTargets } from '../src/discovery/early-research-outcome.js';
import { admittedResearchAction, earlyUnknownEra, EARLY_ACTIONS, responseAction } from '../src/discovery/research-consumer-transition.js';
import { researchPrerequisites } from '../src/discovery/research-context.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField, preparationValue } from './preparation-fixture.js';
import { UPSTREAM_STAGES, REQUIREMENTS } from '../src/discovery/requirements.js';
import type { ResearchRun, ResearchTurn } from '../src/discovery/research-model.js';
import { designOf } from '../src/graph/builder.js';
import { exampleGraph } from './graph-fixture.js';
import { enrichedGraph } from './enriched-graph-fixture.js';

/** Accepted upstream stages from the shared product fixture; Discovery carries two addressed unknowns. */
function upstream(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'unk1-')), store = new Store(join(root, 'state.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const unknowns = [
    { id: 'tariff', question: 'Which tariff applies?', consumer: 'concept', blocksCurrentStage: false, resolution: 'Read the tariff document', moment: 'om-pass' },
    { id: 'quota', question: 'What is the vendor quota?', consumer: 'operation-map', blocksCurrentStage: false, resolution: 'Measure the quota', moment: 'task-result' },
  ];
  preparedFeatures(engine, 'p', undefined, field => field === 'preparation'
    ? { ...(preparationValue('p') as Record<string, Json>), unknowns } as Json : preparedField('p', field));
  const draftOf = (stage: string) => store.list<DiscoveryDraft>('discovery-draft').find(row => row.value.stage === stage)!;
  return { store, engine, unknowns, draftOf, discovery: store.get<StageArtifact>(stageId('p', 'discovery'))! };
}
const failure = (error: EngineError | null, code: string) => { assert.ok(error); assert.equal(error.code, code); };
function draftOfStage(stage: string, inputs: DiscoveryDraft['inputs'] = []): DiscoveryDraft {
  return { projectId: 'p', stage, questions: ['q-1', 'q-2'], inputs } as unknown as DiscoveryDraft;
}
const question = { projectId: 'p', draftId: 'd', stage: 'concept', spec: { field: 'conceptSections', schema: { type: 'array' } } } as unknown as Question;

test('UNK1 №4686 era: without the unknown era an early need_research stays the DRY5FIX refusal it always was', () => {
  failure(earlyResearchFailure(draftOfStage('concept'), question, 'analyst', { action: 'need_research', question: 'q-2', missing: ['tariff'] }),
    'research_question_foreign');
  assert.equal(earlyUnknownEra({ run: 'r' }), false);
  assert.equal(earlyUnknownEra({ earlyActions: EARLY_ACTIONS }), true);
});

test('UNK1 №4686 §3: in the unknown era need_research on the current question is a result; a foreign question, a synthesize or a malformed reply stays a correctable refusal', () => {
  const unknown = { questionId: 'q-2', targets: [] };
  assert.equal(earlyResearchFailure(draftOfStage('concept'), question, 'analyst',
    { action: 'need_research', question: 'q-2', missing: ['tariff'] }, null, false, unknown), null);
  failure(earlyResearchFailure(draftOfStage('concept'), question, 'analyst',
    { action: 'need_research', question: 'q-1', missing: ['tariff'] }, null, false, unknown), 'research_question_foreign');
  failure(earlyResearchFailure(draftOfStage('concept'), question, 'analyst', { action: 'synthesize', question: 'q-2' }, null, false, unknown),
    'research_question_foreign');
  failure(earlyResearchFailure(draftOfStage('concept'), question, 'analyst',
    { action: 'need_research', question: 'q-2', missing: [] }, null, false, unknown), 'research_response_invalid');
  failure(earlyResearchFailure(draftOfStage('concept'), question, 'analyst',
    { action: 'need_research', question: 'q-2', missing: ['x'], upstream: { field: 'preparation' } }, null, false, unknown), 'research_response_invalid');
});

test('UNK1 №4686 §3 п.3: an upstream names an exact accepted input stage of the draft and its field — another stage or a missing field is an addressed refusal', t => {
  const f = upstream(t), concept = f.draftOf('concept');
  const targets = earlyUpstreamTargets(f.store, concept.value);
  assert.deepEqual(targets.map(row => row.stage), [reference(f.discovery)]);
  assert.ok(targets[0]!.fields.includes('preparation'));
  const admission = { questionId: concept.value.questions.at(-1)!, targets };
  const ask = (upstream: unknown) => earlyResearchFailure(concept.value, f.store.get<Question>(admission.questionId)!.value, 'analyst',
    { action: 'need_research', question: admission.questionId, missing: ['tariff'], upstream }, null, false, admission);
  assert.equal(ask({ stage: reference(f.discovery), field: 'preparation' }), null);
  failure(ask({ stage: reference(f.discovery), field: 'invented' }), 'research_upstream_invalid');
  const other = f.store.get<StageArtifact>(stageId('p', 'concept'))!;
  failure(ask({ stage: reference(other), field: 'conceptSections' }), 'research_upstream_invalid');
  failure(ask({ stage: { ...reference(f.discovery), revision: f.discovery.revision + 1 }, field: 'preparation' }), 'research_upstream_invalid');
});

test('UNK1 №4686 era: the global parser stays as it was — an upstream address is admitted only by the unknown era and by its admitted turn', () => {
  const reply = { action: 'need_research', question: 'q-2', missing: ['tariff'],
    upstream: { stage: { id: 'stage:p:discovery', revision: 1, hash: 'a'.repeat(64) }, field: 'preparation' } };
  assert.throws(() => responseAction(reply, false), (error: unknown) => error instanceof EngineError && error.code === 'research_response_invalid');
  assert.deepEqual(responseAction(reply, false, true), reply);
  assert.deepEqual(admittedResearchAction(reply), reply);
  assert.deepEqual(responseAction({ action: 'need_research', question: 'q-2', missing: ['tariff'] }, false, true),
    { action: 'need_research', question: 'q-2', missing: ['tariff'] });
});

test('UNK1 №4686 §3: the corrective request names the unknown door only for a call of the unknown era', () => {
  const error = new EngineError('research_response_invalid', 'bad');
  const plain = earlyResearchCorrection('analyst', error, null, question) as { responseContract: Record<string, unknown> };
  const era = earlyResearchCorrection('analyst', error, null, question, false, true) as { responseContract: Record<string, unknown> };
  assert.equal(Object.hasOwn(plain.responseContract, 'unknownAction'), false);
  assert.ok(!String(plain.responseContract['instruction']).includes('need_research'));
  assert.deepEqual(era.responseContract['unknownAction'], { action: 'need_research', required: ['action', 'question', 'missing'], optional: ['upstream'] });
  assert.ok(String(era.responseContract['instruction']).includes('instead of inventing a value'));
});

test('UNK1 №4686 §3 п.4: every early stage after Discovery receives the accepted Discovery unknowns at their exact stage reference, consumer and moment — with the late-moment rule', t => {
  const f = upstream(t);
  for (const stage of ['concept', 'operation-map', 'specification', 'features']) {
    const draft = f.draftOf(stage);
    const entry = researchPrerequisites(f.store, draft.value).find(row => row.stage === 'discovery') as unknown as { unknowns?: { rule: string; items: Record<string, Json>[] } };
    assert.ok(entry?.unknowns, stage);
    assert.deepEqual(entry.unknowns.items.map(row => [row.id, row.consumer, row.moment]), f.unknowns.map(row => [row.id, row.consumer, row.moment]), stage);
    assert.deepEqual(entry.unknowns.items.map(row => row.source), f.unknowns.map((_row, index) =>
      ({ record: reference(f.discovery), pointer: `/content/fields/preparation/unknowns/${index}` })), stage);
    assert.ok(entry.unknowns.rule.includes('A later moment does not resolve an unknown now'));
  }
  const discovery = f.draftOf('discovery');
  assert.ok(researchPrerequisites(f.store, discovery.value).every(row => !Object.hasOwn(row, 'unknowns')), 'Discovery itself has no older Discovery');
});

// ---- UNK1 on the real research path: the public stage command, a scripted assessor/analyst process, saved records ----

const UNK1_ADAPTER = `import {boundDiscoveryValue} from ${JSON.stringify(new URL('./preparation-fixture.js', import.meta.url).href)};
import{readFileSync,writeFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,controlPath=process.argv[4],control=JSON.parse(readFileSync(controlPath,'utf8'));
appendFileSync(process.argv[3],JSON.stringify(r)+'\\n');
const q=s.questions?.[0]??s.question,field=q.field,values=JSON.parse(readFileSync(process.argv[2],'utf8'));
const source=(s.inventory?.sources??[]).find(x=>x.location==='values')??{ref:control.values};
const value=boundDiscoveryValue(field,values[field],s.discoveryContext);
if(field==='conceptSections'&&s.discoveryBasisCatalogue)
 for(const [sectionIndex,section] of value.entries())for(const [requirementIndex,requirement] of section.requirements.entries())
  requirement.applications=[s.discoveryBasisCatalogue.variant,...s.discoveryBasisCatalogue.constraints].map(entry=>({
   contract:'basis-application/v1',basis:entry.address,appliedAt:['/'+sectionIndex+'/requirements/'+requirementIndex+'/'+
    (entry===s.discoveryBasisCatalogue.variant?'statement':'acceptance/0')]}));
if(field==='behaviorContracts'&&s.discoveryBasisCatalogue)
 for(const [index,contract] of value.entries())contract.applications=[s.discoveryBasisCatalogue.variant,...s.discoveryBasisCatalogue.constraints].map(entry=>({
  contract:'basis-application/v1',basis:entry.address,appliedAt:[entry===s.discoveryBasisCatalogue.variant?'/'+index+'/entry':'/'+index+'/success/0']}));
let research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}:
{action:'answer',question:q.id,value,citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+field}}]};
if(control.web===field&&s.role==='research'&&s.webResearch&&!control.fetched){
 control.fetched=true;writeFileSync(controlPath,JSON.stringify(control));
 research={action:'web_fetch',url:'https://example.org/tariff',purpose:'the tariff table'};
}else if(control.remaining>0&&field===control.field&&s.role==='research'){
 control.remaining--;writeFileSync(controlPath,JSON.stringify(control));
 const discovery=(s.prerequisites??[]).find(x=>x.stage==='discovery');
 research={action:'need_research',question:control.foreign?q.id+':foreign':q.id,missing:['the tariff table'],...(control.upstream?{upstream:{stage:discovery.ref,field:control.upstream}}:{})};
}
const late=(s.prerequisites??[]).find(x=>x.stage==='discovery')?.unknowns?.items?.some(u=>u.moment!=='discovery');
if(control.refuse===field&&s.role==='assess-answer'&&late){
 control.refuse='';writeFileSync(controlPath,JSON.stringify(control));
 research={verdict:'insufficient',reasons:['The answer assumes the tariff, a Discovery unknown due at a later moment']};
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:null}));`;

const DISCOVERY_UNKNOWN = { id: 'tariff', question: 'Which tariff applies?', consumer: 'concept', blocksCurrentStage: false,
  resolution: 'Read the tariff table', moment: 'om-pass' };

function stageFixture(t: TestContext, gatewayUrl?: string) {
  const root = mkdtempSync(join(tmpdir(), 'unk1-stage-')), path = join(root, 'state.sqlite');
  let store = new Store(path), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project: 'p', title: 'p' });
  const fields = Object.fromEntries(UPSTREAM_STAGES.flatMap(stage => REQUIREMENTS[stage].map(spec => [spec.field,
    spec.field === 'mapDesign' ? designOf(enrichedGraph(exampleGraph('p'), 'p')) : preparedField('p', spec.field)]))) as Record<string, Json>;
  fields['preparation'] = { ...(fields['preparation'] as Record<string, Json>), unknowns: [DISCOVERY_UNKNOWN] };
  const values = join(root, 'values.json'), calls = join(root, 'calls.ndjson'), control = join(root, 'control.json'), adapter = join(root, 'adapter.mjs');
  writeFileSync(values, JSON.stringify(fields)); writeFileSync(adapter, UNK1_ADAPTER);
  const valuesRef = reference(engine.discovery.evidence.document('p', 'values', JSON.stringify(fields), 'application/json', 0));
  const steer = (value: Record<string, Json>) => writeFileSync(control, JSON.stringify({ field: '', remaining: 0, values: valuesRef, ...value }));
  steer({});
  const command = { executable: process.execPath, args: [adapter, values, calls, control] };
  engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command }, fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 4000,
    ...(gatewayUrl ? { webResearch: { enabled: true, gatewayUrl, timeoutMs: 5000,
      limits: { httpAttempts: 20, pages: 10, receivedChars: 1_000_000, responseBytes: 2_000_000 } } } : {}) }, 0);
  return { root, path,
    get store() { return store; }, get engine() { return engine; },
    calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    unknownOn: (field: string, upstream?: string, web = false, foreign = false) => steer({ field, remaining: 1, ...(upstream ? { upstream } : {}),
      ...(web ? { web: field } : {}), ...(foreign ? { foreign } : {}) }),
    refuseLate: (field: string) => steer({ refuse: field }),
    reopen() { store.close(); store = new Store(path); engine = new ProductEngine(store); } };
}
type StageFixture = ReturnType<typeof stageFixture>;
const runOf = (f: StageFixture, draftId: string) => f.store.list<ResearchRun>('research-run').find(row => row.value.draftId === draftId)!;
const unknownTurns = (f: StageFixture) => f.store.list<ResearchTurn>('research-turn')
  .filter(row => (row.value.observation as { contract?: string } | null)?.contract === 'early-research-unknown/v1');
function stopAt(store: Store, match: (write: Write) => boolean, before?: () => void) {
  const original = store.writeMany.bind(store); let hit = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    if (!hit && writes.some(match)) { hit = true; if (before) { before(); return original(writes, guards); } throw new Error('UNK1 deliberate process boundary'); }
    return original(writes, guards);
  }) as typeof store.writeMany;
  return () => { store.writeMany = original; assert.ok(hit, 'The real persistence boundary was reached'); };
}
const isUnknownWrite = (write: Write) => write.kind === 'research-turn'
  && (write.value as { observation?: { contract?: string } | null }).observation?.contract === 'early-research-unknown/v1';

test('UNK1 №4686 §5: a correct need_research on the current question completes the turn with observation.unknown and pauses research_material_missing — not pending, not an owner question, the question stays open', async t => {
  const f = stageFixture(t), draft = f.engine.prepare('p', 'discovery');
  f.unknownOn('researchReport');
  const result = await f.engine.stageResearch.run('p', draft.id, 20);
  assert.equal(result.status, 'paused');
  const run = runOf(f, draft.id);
  assert.deepEqual([run.value.status, run.value.pauseCode, run.value.ownerQuestion], ['paused', 'research_material_missing', null]);
  const [turn] = unknownTurns(f);
  assert.ok(turn); assert.equal(turn.value.status, 'completed'); assert.equal(turn.value.error, null);
  const unknown = (turn.value.observation as { unknown: Record<string, Json> }).unknown;
  const question = f.store.get<Question>(draft.value.questions.find(id => f.store.get<Question>(id)!.value.spec.field === 'researchReport')!)!;
  assert.deepEqual([unknown['field'], unknown['door'], unknown['missing']], ['researchReport', 'research', ['the tariff table']]);
  assert.deepEqual(unknown['question'], reference(question)); assert.equal(question.value.status, 'open');
  assert.equal(f.store.list('research-turn').filter(row => (row.value as { status: string }).status === 'pending').length, 0);
  const call = f.calls().filter(row => row.subject.role === 'research').at(-1)!;
  assert.ok(String(call.instruction ?? JSON.stringify(call)).includes('need_research'), 'The new early call names the unknown door');
});

test('UNK1 №4686 §5: an unchanged repeat makes zero calls; new saved material lets the next entry research the same question again — without a new draft', async t => {
  const f = stageFixture(t), draft = f.engine.prepare('p', 'discovery');
  f.unknownOn('researchReport');
  await f.engine.stageResearch.run('p', draft.id, 20);
  const calls = f.calls().length;
  f.reopen();
  const repeat = await f.engine.stageResearch.run('p', draft.id, 20);
  assert.deepEqual([repeat.status, f.calls().length], ['paused', calls], 'The same request for help is not paid again');
  assert.equal(runOf(f, draft.id).value.pauseCode, 'research_material_missing');
  const tariff = f.engine.discovery.evidence.document('p', 'tariff', 'Tariff table: flat rate', 'text/plain', 0);
  const next = await f.engine.stageResearch.run('p', draft.id, 20);
  assert.ok(f.calls().length > calls, 'New material admits a new call');
  const again = f.calls()[calls]!.subject;
  assert.equal(again.role, 'research');
  assert.deepEqual(again.researchMissing, ['the tariff table'], 'The analyst sees what was missing');
  const table = again.originals.sources as { columns: string[]; rows: { id: string }[][] }, at = table.columns.indexOf('ref');
  assert.ok(table.rows.some(row => row[at]!.id === tariff.id), 'and the new material');
  assert.ok(again.working.sections.some((row: { pointer: string }) => row.pointer === '/body/previousUnknown'), 'The exact addresses stay addressable');
  assert.equal(next.status, 'accepted', JSON.stringify(next));
  assert.equal(f.store.list<DiscoveryDraft>('discovery-draft').filter(row => row.value.stage === 'discovery').length, 1, 'No new draft');
});

test('UNK1 №4686 §5: a paid reply saved before its unknown is written completes the same turn from a new Store without the model', async t => {
  const f = stageFixture(t), draft = f.engine.prepare('p', 'discovery');
  f.unknownOn('researchReport');
  const restore = stopAt(f.store, isUnknownWrite);
  const stopped = await f.engine.stageResearch.run('p', draft.id, 20);
  restore();
  assert.deepEqual([stopped.status, stopped.findings.map(row => row.code)], ['paused', ['research_interrupted']]);
  assert.equal(unknownTurns(f).length, 0, 'The unknown was not written');
  const calls = f.calls().length;
  f.reopen();
  const resumed = await f.engine.stageResearch.run('p', draft.id, 20);
  assert.equal(resumed.status, 'paused');
  assert.equal(f.calls().length, calls, 'The saved paid reply completes the turn — no new call');
  assert.equal(unknownTurns(f).length, 1);
  assert.equal(runOf(f, draft.id).value.pauseCode, 'research_material_missing');
});

test('UNK1 №4686 window: the selected question revised by a second Store between the check and the unknown write refuses the transaction — nothing partial is written', async t => {
  const f = stageFixture(t), draft = f.engine.prepare('p', 'discovery');
  f.unknownOn('researchReport');
  const restore = stopAt(f.store, isUnknownWrite, () => {
    const other = new Store(f.path);
    try {
      const q = other.get<Question>(draft.value.questions.find(id => other.get<Question>(id)!.value.spec.field === 'researchReport')!)!;
      new ProductEngine(other).discovery.reopen(q.id, q.revision);
    } finally { other.close(); }
  });
  const refused = await f.engine.stageResearch.run('p', draft.id, 20);
  restore();
  assert.deepEqual([refused.status, refused.findings.map(row => row.code)], ['paused', ['input_stale']], 'The guarded transaction refuses as a whole');
  assert.equal(unknownTurns(f).length, 0, 'No unknown turn is written');
  assert.ok(f.store.list<ResearchTurn>('research-turn').some(row => row.value.status === 'pending'), 'The paid turn stays pending for its recovery');
});

test('UNK1 №4686 §5: an upstream pause leaves the accepted stage as it is; a repeat — even with new material — makes no call until the stage is revised', async t => {
  const f = stageFixture(t), discovery = f.engine.prepare('p', 'discovery');
  assert.equal((await f.engine.stageResearch.run('p', discovery.id, 20)).status, 'accepted');
  const accepted = f.store.get<StageArtifact>(stageId('p', 'discovery'))!;
  const concept = f.engine.prepare('p', 'concept');
  f.unknownOn('audience', 'preparation');
  const paused = await f.engine.stageResearch.run('p', concept.id, 20);
  assert.equal(paused.status, 'paused');
  assert.equal(runOf(f, concept.id).value.pauseCode, 'research_upstream_return', runOf(f, concept.id).value.error ?? '');
  const unknown = (unknownTurns(f)[0]!.value.observation as { unknown: Record<string, Json> }).unknown;
  assert.deepEqual(unknown['upstream'], { stage: reference(accepted), field: 'preparation' });
  assert.equal(unknown['door'], 'upstream');
  assert.deepEqual(reference(f.store.get<StageArtifact>(stageId('p', 'discovery'))!), reference(accepted), 'The accepted stage is not rewritten');
  const calls = f.calls().length;
  f.engine.discovery.evidence.document('p', 'tariff', 'Tariff table', 'text/plain', 0);
  const repeat = await f.engine.stageResearch.run('p', concept.id, 20);
  assert.deepEqual([repeat.status, f.calls().length, runOf(f, concept.id).value.pauseCode], ['paused', calls, 'research_upstream_return']);
});

test('UNK1 №4686 §5: an upstream naming a field the accepted stage does not have is an addressed correctable refusal; the next entry is corrected', async t => {
  const f = stageFixture(t), discovery = f.engine.prepare('p', 'discovery');
  await f.engine.stageResearch.run('p', discovery.id, 20);
  const concept = f.engine.prepare('p', 'concept');
  f.unknownOn('audience', 'invented');
  const paused = await f.engine.stageResearch.run('p', concept.id, 20);
  assert.equal(paused.status, 'paused');
  assert.equal(runOf(f, concept.id).value.pauseCode, 'research_upstream_invalid', runOf(f, concept.id).value.error ?? '');
  assert.equal(unknownTurns(f).length, 0);
  // Return 1 (P3): the completed turn and every later reader classify in the same era as the run — one code everywhere.
  const { readResearchConsumerTurn } = await import('../src/discovery/response-recovery.js');
  const refused = f.store.list<ResearchTurn>('research-turn').find(row => (row.value.action as { action?: string }).action === 'need_research')!;
  for (const row of f.store.history<ResearchTurn>(refused.id)) readResearchConsumerTurn(f.store, reference(row));
  assert.equal((readResearchConsumerTurn(f.store, reference(refused)).value.observation as { code: string }).code, 'research_upstream_invalid');
  const calls = f.calls().length;
  f.reopen();
  await f.engine.stageResearch.run('p', concept.id, 20);
  const corrected = f.calls()[calls]!.subject;
  assert.ok(corrected.failures?.some((row: { code: string }) => row.code === 'research_upstream_invalid'), JSON.stringify(corrected.failures));
  assert.ok(corrected.failures[0].responseContract.unknownAction, 'The correction of a new unknown-era call names the door');
});

test('UNK1 №4686 §3 п.4: the analyst and the assessor of a concept question receive the accepted Discovery unknowns with their moment and the late-moment rule', async t => {
  const f = stageFixture(t), discovery = f.engine.prepare('p', 'discovery');
  await f.engine.stageResearch.run('p', discovery.id, 20);
  const concept = f.engine.prepare('p', 'concept');
  await f.engine.stageResearch.run('p', concept.id, 20);
  for (const role of ['research', 'assess-answer']) {
    const call = f.calls().find(row => row.subject.role === role && row.subject.question?.field !== undefined
      && ['audience', 'outcome', 'acceptance', 'conceptSections'].includes(row.subject.question?.field ?? row.subject.questions?.[0]?.field))
      ?? f.calls().find(row => row.subject.role === role && (row.subject.prerequisites ?? []).some((p: { stage: string }) => p.stage === 'discovery'));
    assert.ok(call, role);
    const entry = (call.subject.prerequisites as { stage: string; unknowns?: { rule: string; items: { id: string; moment: string }[] } }[])
      .find(row => row.stage === 'discovery')!;
    assert.deepEqual(entry.unknowns!.items.map(row => [row.id, row.moment]), [['tariff', 'om-pass']], role);
    assert.ok(entry.unknowns!.rule.includes('never an assumption'), role);
  }
});

test('UNK1 №4686 §5: after an upstream pause a revised Discovery never resumes the old downstream draft; a new concept draft researches on the new basis', async t => {
  const f = stageFixture(t), discovery = f.engine.prepare('p', 'discovery');
  await f.engine.stageResearch.run('p', discovery.id, 20);
  const before = f.store.get<StageArtifact>(stageId('p', 'discovery'))!;
  const concept = f.engine.prepare('p', 'concept');
  f.unknownOn('audience', 'preparation');
  assert.equal((await f.engine.stageResearch.run('p', concept.id, 20)).status, 'paused');
  const revised = f.engine.prepare('p', 'discovery');
  f.engine.draft('p', 'discovery', revised.id, before.revision);
  assert.equal((await f.engine.stageResearch.run('p', revised.id, 20)).status, 'accepted');
  const after = f.store.get<StageArtifact>(stageId('p', 'discovery'))!;
  assert.notDeepEqual(reference(after), reference(before), 'Discovery was revised through its own door');
  const calls = f.calls().length;
  await assert.rejects(f.engine.stageResearch.run('p', concept.id, 20),
    (error: unknown) => error instanceof EngineError && error.code === 'research_context_stale', 'An addressed refusal: prepare a current draft');
  assert.equal(f.calls().length, calls, 'The old downstream draft is not continued');
  const next = f.engine.prepare('p', 'concept');
  await f.engine.stageResearch.run('p', next.id, 20);
  const fresh = f.calls().slice(calls).find(row => row.subject.role === 'research')!.subject;
  assert.deepEqual(fresh.prerequisites.find((row: { stage: string }) => row.stage === 'discovery').ref, reference(after));
  assert.equal(fresh.previousUnknown, undefined, 'The new draft does not inherit the old unknown');
});

test('UNK1 №4686 §5: a late-moment Discovery unknown gives the assessor no right to accept a claim the stage needs now — its insufficient verdict leaves the question open and the candidate unaccepted', async t => {
  const f = stageFixture(t), discovery = f.engine.prepare('p', 'discovery');
  await f.engine.stageResearch.run('p', discovery.id, 20);
  const concept = f.engine.prepare('p', 'concept');
  f.refuseLate('audience');
  const result = await f.engine.stageResearch.run('p', concept.id, 20);
  const refused = f.store.list<{ verdict: string; question: { id: string } }>('research-assessment')
    .filter(row => row.value.verdict === 'insufficient' && concept.value.questions.includes(row.value.question.id));
  assert.equal(refused.length, 1, 'The assessor judged the candidate against the delivered late unknown');
  for (const answer of f.store.list<{ assessment: { id: string } }>('research-answer'))
    assert.notEqual(answer.value.assessment.id, refused[0]!.id, 'An insufficient candidate is never accepted');
  const call = f.calls().find(row => row.subject.role === 'assess-answer' && (row.subject.question?.field ?? row.subject.questions?.[0]?.field) === 'audience')!;
  const entry = call.subject.prerequisites.find((row: { stage: string }) => row.stage === 'discovery');
  assert.deepEqual(entry.unknowns.items.map((row: { moment: string }) => row.moment), ['om-pass']);
  assert.ok(entry.unknowns.rule.includes('does not support'), 'The rule names the assessor side');
  assert.equal(result.status, 'accepted', 'The next ordinary attempt answers without the assumption');
});

test('UNK1 №4686 §5: an upstream reply saved before its turn admission is admitted by the same era from a new Store — no call — and every turn reads through the common reader', async t => {
  const f = stageFixture(t), discovery = f.engine.prepare('p', 'discovery');
  await f.engine.stageResearch.run('p', discovery.id, 20);
  const concept = f.engine.prepare('p', 'concept');
  f.unknownOn('audience', 'preparation');
  const restore = stopAt(f.store, write => write.kind === 'research-turn' && write.expected === 0
    && (write.value as { action?: { upstream?: unknown } }).action?.upstream !== undefined);
  assert.equal((await f.engine.stageResearch.run('p', concept.id, 20)).status, 'paused');
  restore();
  assert.equal(unknownTurns(f).length, 0, 'Only the paid reply was saved');
  const calls = f.calls().length;
  f.reopen();
  assert.equal((await f.engine.stageResearch.run('p', concept.id, 20)).status, 'paused');
  assert.equal(f.calls().length, calls, 'The saved reply is admitted without the model');
  assert.equal(runOf(f, concept.id).value.pauseCode, 'research_upstream_return', runOf(f, concept.id).value.error ?? '');
  assert.equal(unknownTurns(f).length, 1);
  const { readResearchConsumerTurn } = await import('../src/discovery/response-recovery.js');
  for (const head of f.store.list('research-turn')) for (const row of f.store.history(head.id))
    assert.doesNotThrow(() => readResearchConsumerTurn(f.store, reference(row)), row.id);
});

/** A local gateway: /fetch answers one saved page; every request is counted. */
async function pageGateway(t: TestContext) {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      hits.push(new URL(request.url!, 'http://gateway').pathname);
      const url = (JSON.parse(raw || '{}') as { url?: string }).url ?? '', text = 'Tariff table: not published yet';
      const bytes = Buffer.from(text, 'utf8');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ contract: 'web-document/v2', requested_url: url, selected_url: url,
        redirects: [], attempts: [], final_url: url, fetched_at: '2026-10-14T00:00:01+00:00',
        status: 200, success: true, failure: null,
        raw: { encoding: 'base64', data: bytes.toString('base64'), mediaType: 'text/markdown',
          byteLength: bytes.length, sha256: digest(bytes) },
        clean: { text, mediaType: 'text/markdown', utf16Length: text.length, sha256: digest(text) },
        method: { kind: 'native-markdown', version: 'omg-document/2.0.1' },
        signals: { rawTruncated: false, cleanTruncated: false, completeness: 'unknown' } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits };
}

test('UNK1 №4686 §5: after a saved web capture, a paid unknown interrupted before its write completes from a new Store — no model call, no second fetch — and names the capture as searched', async t => {
  const gateway = await pageGateway(t), f = stageFixture(t, gateway.url), draft = f.engine.prepare('p', 'discovery');
  f.unknownOn('researchReport', undefined, true);
  const restore = stopAt(f.store, isUnknownWrite);
  assert.equal((await f.engine.stageResearch.run('p', draft.id, 20)).status, 'paused');
  restore();
  assert.deepEqual(gateway.hits, ['/fetch'], 'The page was fetched once and saved');
  const calls = f.calls().length;
  f.reopen();
  assert.equal((await f.engine.stageResearch.run('p', draft.id, 20)).status, 'paused');
  assert.deepEqual([f.calls().length, gateway.hits.length], [calls, 1], 'Neither the model nor the gateway is asked again');
  assert.equal(runOf(f, draft.id).value.pauseCode, 'research_material_missing');
  const unknown = (unknownTurns(f)[0]!.value.observation as { unknown: { searched: Json[] } }).unknown;
  const fetched = f.store.list<ResearchTurn>('research-turn').find(row => (row.value.observation as { kind?: string } | null)?.kind === 'web_fetch')!;
  assert.deepEqual(unknown.searched, [(fetched.value.observation as { source: Json }).source], 'The saved page is what was searched');
});

test('UNK1 №4686 §5: a need_research naming a foreign question is an addressed refusal on its own turn — no unknown, no pause — and the next call of the run answers', async t => {
  const f = stageFixture(t), draft = f.engine.prepare('p', 'discovery');
  f.unknownOn('researchReport', undefined, false, true);
  const result = await f.engine.stageResearch.run('p', draft.id, 20);
  const refused = f.store.list<ResearchTurn>('research-turn').filter(row => (row.value.action as { action?: string }).action === 'need_research');
  assert.equal(refused.length, 1);
  assert.deepEqual([refused[0]!.value.status, refused[0]!.value.question, (refused[0]!.value.observation as { code: string }).code],
    ['completed', null, 'research_question_foreign']);
  assert.equal(unknownTurns(f).length, 0, 'A foreign address is never an unknown');
  assert.equal(result.status, 'accepted', 'The run corrects itself on the next call');
});

test('UNK1 №4686 return 1 (P2): a Source a second Store saves after the delivered inventory and before the intent basis is new material — the ordinary repeat researches the same question with it', async t => {
  const f = stageFixture(t), draft = f.engine.prepare('p', 'discovery');
  f.unknownOn('brief');
  const { ResearchSources } = await import('../src/discovery/research-sources.js');
  const inventory = ResearchSources.prototype.inventory;
  let reads = 0, late: { id: string; revision: number; hash: string } | null = null;
  // The second inventory read of the first turn is the one packed into the model request; the intent basis is read later.
  ResearchSources.prototype.inventory = function (this: InstanceType<typeof ResearchSources>) {
    const body = inventory.call(this);
    if (++reads === 2) {
      const other = new Store(f.path);
      try { late = reference(new ProductEngine(other).discovery.evidence.document('p', 'late-material', 'Tariff table: available', 'text/plain', 0)); }
      finally { other.close(); }
    }
    return body;
  };
  try { assert.equal((await f.engine.stageResearch.run('p', draft.id, 20)).status, 'paused'); }
  finally { ResearchSources.prototype.inventory = inventory; }
  assert.ok(late); const added = late as { id: string; revision: number; hash: string };
  const [turn] = unknownTurns(f);
  assert.ok(turn, 'The unknown was written');
  const intent = f.store.get<{ basis: { id: string }[] }>((turn.value as unknown as { consumerIntent: { id: string } }).consumerIntent.id)!;
  assert.ok(intent.value.basis.some(ref => ref.id === added.id), 'The window is real: the later basis holds the Source');
  assert.equal(JSON.stringify(f.calls()[0]!.subject).includes(added.id), false, 'The model was not shown it');
  const calls = f.calls().length;
  f.reopen();
  const next = await f.engine.stageResearch.run('p', draft.id, 20);
  assert.ok(f.calls().length > calls, 'Undelivered material admits the ordinary repeat');
  const again = f.calls()[calls]!.subject;
  assert.deepEqual([again.role, again.researchMissing], ['research', ['the tariff table']]);
  assert.ok(JSON.stringify(again).includes(added.id), 'The late Source is delivered to the model this time');
  assert.equal(next.status, 'accepted', JSON.stringify(next));
});
