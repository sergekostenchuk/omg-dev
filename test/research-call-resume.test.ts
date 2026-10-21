import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, type Write, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { preparedFeatures } from './product-fixture.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { readBundle, readReaderResultAt, resumeReadBundleIntent, type ReaderResult } from '../src/discovery/reader.js';
import { readResearchConsumerIntent, readResearchConsumerExecution, readResearchConsumerTurn,
  prepareResearchConsumerApplication, refuseResearchConsumerIntent, captureResearchConsumerRetryPermits,
  assessmentReadView, readResearchAcceptanceBinding, readContextTurnHistoryAt, prepareResearchConsumerReservation,
  type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { ATTEMPT_BINDING_CONTRACT, V7_PLAN_SUBJECT_CONTRACT, callAddressesSubject,
  planSubjectOf } from '../src/discovery/v7-managed-attempt.js';
import { readResearchAssessmentAt, assessmentBindingId } from '../src/discovery/research-assessment.js';
import { readAssessmentPaidOrigin } from '../src/discovery/assessment-session.js';
import { processStart } from '../src/runtime/process-identity.js';
import { Evidence , type Source, type Observation } from '../src/evidence/evidence.js';
import { withTypedBasis } from '../src/graph/research-basis.js';
import { technicalProposalFindings, type LegacyPathResolution } from '../src/graph/research-evidence.js';
import { TECHNICAL_RESEARCH, type TechnicalReport } from '../src/graph/research-contracts.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { layerDesignOf } from '../src/graph/layer-design.js';
import { layerDeltaView } from '../src/discovery/layer-delta.js';
import { configureResearchScope } from '../src/graph/research-scope.js';
import { configurePhasePolicy } from '../src/discovery/phase-policy.js';
import { answerTechnicalFixture } from './technical-research-fixture.js';
import { answerLayerFixture } from './layer-design-fixture.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';
import { previewResearch } from '../src/discovery/research-preview.js';
import { ResearchSources } from '../src/discovery/research-sources.js';
import { prepareLateModelReceipt, readLateModelReceipt, readModelCallRecovery,
  type LateModelReceipt } from '../src/discovery/model-call-recovery.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { canonical, digest, hashJson } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import type { Question } from '../src/discovery/discovery.js';
import type { ResearchTurn, ResearchAssessment } from '../src/discovery/research-model.js';

for (const planning of [false, true]) for (const afterApplied of [false, true])
test(`reader consumer ${planning ? 'planned' : 'ordinary'} resumes ${afterApplied ? 'completed R before current files' : 'paid stale child twice'} by exact membership`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84-first-child-'));
  const database = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  preparedFeatures(engine, 'p');
  for (const name of ['a', 'b']) writeFileSync(join(root, `${name}.txt`), 'Header\nScoped condition\nException\n');
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
const research=s.role==='reader'?{selections:[{sourceIndex:0,firstLine:2,lastLine:3}],unresolved:[]}
 :s.dispatchMode==='planning'?{action:'read_plan',question:s.question.id,reads:['a','b'].map(n=>({action:'read_bundle',purpose:n,inputs:[{path:n+'.txt',media:'text/plain'}]}))}
 :${planning}?{action:'pause',reason:'Done'}:{action:'read_bundle',purpose:'a',inputs:[{path:'a.txt',media:'text/plain'}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
  engine.refinement.sealLayer('p', 1, 0);
  const draft = engine.refinement.begin('p', 'R1'), question = store.get<Question>(draft.value.questions[0]!)!;
  configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxCalls: 10, maxReportedTokens: 100000, maxRequestChars: 50000, maxReadChars: 20000, maxReplyChars: 10000,
    ...(planning ? { planning: { fields: [question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } } : {}) }, 0);
  const original = store.writeMany.bind(store); let interrupted = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    if (afterApplied && !interrupted && writes.some(write => write.kind === 'research-turn'
      && (write.value as ResearchTurn).status === 'completed'
      && ((write.value as ResearchTurn).action as any).action === 'read_bundle')) {
      interrupted = true;
      throw new EngineError('input_stale', 'The result is durable; the turn completion was lost');
    }
    const rows = original(writes, guards);
    if (!afterApplied && !interrupted && writes.some(write => write.kind === 'model-response'
      && String((write.value as { text?: string }).text).includes('"selections"'))) {
      interrupted = true;
      throw new EngineError('input_stale', 'The first child response was saved before application');
    }
    return rows;
  }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 4);
  store.writeMany = original;
  assert.equal(interrupted, true);
  const children = store.list<ResearchTurn>('research-turn').filter(turn => (turn.value.action as any).action === 'read_bundle');
  assert.equal(children.length, planning ? 2 : 1);
  const paid = store.list<any>('research-consumer-intent');
  const claim = paid.find(intent => intent.value.kind === 'reader' && intent.value.state === (afterApplied ? 'applied' : 'running'));
  assert.ok(claim);
  const first = children.find(turn => turn.id === claim.value.owner.id);
  assert.ok(first, 'the paid claim selects the first child by exact owner');
  assert.equal(first.value.status, 'pending');
  const callCount = store.list('model-call').length;
  if (afterApplied) writeFileSync(join(root, 'a.txt'), 'Changed after saved R');
  else {
    const latestQuestion = store.get<Question>(question.id)!;
    engine.discovery.reopen(latestQuestion.id, latestQuestion.revision);
  }
  const restarted = open();
  for (let entry = 0; entry < (afterApplied ? 1 : 2); entry++) {
    const resumed = await new ProductEngine(restarted).researcher.run('p', draft.id, 1);
    assert.equal(restarted.list('model-call').length, callCount, 'recovery never buys a replacement P');
    assert.equal(restarted.get<ResearchTurn>(first.id)?.value.status, afterApplied ? 'completed' : 'pending');
    if (afterApplied) {
      const observation = restarted.get<ResearchTurn>(first.id)!.value.observation as { ref: Ref };
      assert.deepEqual(observation.ref, claim.value.outputs[0]);
      assert.deepEqual(readReaderResultAt(restarted, 'p', observation.ref).value.observations
        .map(value => value.value), ['Scoped condition\nException\n']);
    } else assert.equal(resumed.value.pauseCode, 'question_stale');
  }
});


// DR3a3-S3 (№7690 §3 S3, №8173): the field-path planned queue is a neighbour of the v7 planner queue — an explicit
// v7Planning beside planning.fields changes nothing on it, its paid planner and children carry no subject, and a
// subject forged onto one of its children is refused by the turn reader.
test('S3 v6 neighbour: explicit v7Planning beside planning.fields leaves the field-path planned queue unchanged; its children carry no subject and a forged subject is refused', async t => {
  const summaries: unknown[] = [];
  for (const v7 of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'omg-s3-v6-plan-'));
    const store = new Store(join(root, 'state.sqlite')), engine = new ProductEngine(store);
    t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
    preparedFeatures(engine, 'p');
    for (const name of ['a', 'b']) writeFileSync(join(root, `${name}.txt`), 'Header\nScoped condition\nException\n');
    const adapter = join(root, 'adapter.mjs');
    writeFileSync(adapter, `import{readFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
const research=s.role==='reader'?{selections:[{sourceIndex:0,firstLine:2,lastLine:3}],unresolved:[]}
 :s.dispatchMode==='planning'?{action:'read_plan',question:s.question.id,reads:['a','b'].map(n=>({action:'read_bundle',purpose:n,inputs:[{path:n+'.txt',media:'text/plain'}]}))}
 :{action:'pause',reason:'Done'};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
    const command = { executable: process.execPath, args: [adapter] };
    engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
    const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
    engine.refinement.sealLayer('p', 1, 0);
    const draft = engine.refinement.begin('p', 'R1'), question = store.get<Question>(draft.value.questions[0]!)!;
    configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
      reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
      maxCalls: 10, maxReportedTokens: 100000, maxRequestChars: 50000, maxReadChars: 20000, maxReplyChars: 10000,
      planning: { fields: [question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 },
      ...(v7 ? { v7Planning: { contract: 'v7-plan-planning/v1' as const, maxRequestChars: 17321, maxRounds: 1 } } : {}) }, 0);
    const run = await engine.researcher.run('p', draft.id, 4);
    const turns = store.list<ResearchTurn>('research-turn');
    const planner = turns.find(turn => turn.id.startsWith('research-turn:v1:') && turn.value.dispatchMode === 'planning');
    assert.ok(planner, JSON.stringify(run.value));
    const children = turns.filter(turn => turn.value.plannedBy).sort((a, b) => a.value.number - b.value.number);
    assert.equal(children.length, 2);
    assert.equal((planner.value.action as { question?: string }).question, question.id, 'the field plan addresses its Question id');
    for (const turn of [planner, ...children]) {
      for (const field of ['subject', 'attemptContract']) assert.equal(Object.hasOwn(turn.value, field), false, field);
      readResearchConsumerTurn(store, reference(turn));
    }
    assert.ok(children.every(child => canonical(child.value.plannedBy) === canonical(reference(store.get(planner.id, 1)!))));
    // Fixture addresses (Question UUIDs, call ids) differ between the two stores; the compared outcome does not.
    summaries.push({ status: run.value.status, pauseCode: run.value.pauseCode ?? null,
      planner: { ...(planner.value.action as object), question: '<own question>' },
      children: children.map(child => [child.value.number, child.value.action, child.value.status, child.value.error]),
      calls: store.list<ModelCall>('model-call').map(call => `${call.value.purpose}:${call.value.status}`).sort() });
    if (v7) {
      const child = children[0]!;
      const subject = { contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: reference(planner), planQuestionId: 'q-forged' };
      const forged = store.write<ResearchTurn>({ id: child.id, kind: child.kind, expected: child.revision,
        value: { ...child.value, subject } as ResearchTurn });
      assert.throws(() => readResearchConsumerTurn(store, reference(forged)), { code: 'research_consumer_intent_invalid' });
    }
  }
  assert.deepEqual(summaries[1], summaries[0], 'an explicit v7Planning does not change the field path');
});

test('reader reuses exact paid coordinates after restart without a second physical call', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84-reader-')), database = join(root, 'db.sqlite');
  const stores: Store[] = [], open = () => { const db = new Store(database); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project: 'p', title: 'Reader continuation' });
  const wire = join(root, 'wire.ndjson'), adapter = join(root, 'adapter.mjs');
  writeFileSync(join(root, 'source.txt'), 'Condition before result\nExact result\nException after result\n');
  writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
const research={selections:[{sourceIndex:0,firstLine:s.sources[0].lines[0][0],lastLine:s.sources[0].lines.at(-1)[0]}],unresolved:[]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:7,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxCalls: 10, maxReportedTokens: 100000, maxRequestChars: 30000, maxReadChars: 20000,
    maxReplyChars: 5000, maxExtractedChars: 1200 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation', [{ field: 'result', kind: 'design',
    prompt: 'Read the original', risk: 'Missing exception', schema: { type: 'object' } }]);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const invoke = (db: Store) => readBundle(db, environment.value, pilot, reference(question),
    'Read the condition and exception', [{ path: 'source.txt', media: 'text/plain' }]);
  const preview = await previewResearch(() => invoke(store));
  assert.equal(preview.purpose, 'reader');
  assert.equal(store.list('research-consumer-intent').length, 0);
  assert.equal(store.list('model-call').length, 0);
  const original = store.writeMany.bind(store); let interrupted = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const rows = original(writes, guards);
    if (!interrupted && writes.some(write => write.kind === 'model-response')) {
      interrupted = true; throw new EngineError('fixture_reader_after_receipt', 'Paid coordinates persisted before extraction');
    }
    return rows;
  }) as typeof store.writeMany;
  await assert.rejects(invoke(store), { code: 'fixture_reader_after_receipt' });
  store.writeMany = original;
  assert.ok(interrupted);
  assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 1);
  assert.equal(store.list('reader-result').length, 0);
  const db = open(), result = await invoke(db);
  assert.equal(result.id, `reader-result:v2:${hashJson(result.value)}`);
  assert.deepEqual(readReaderResultAt(db, 'p', reference(result)), result);
  assert.equal(result.value.observations.map(o => o.value).join(''), readFileSync(join(root, 'source.txt'), 'utf8'));
  assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 1);
  assert.equal(db.list('reader-result').length, 1);
  for (const mutate of [
    (value: ReaderResult) => { value.coverage[0]!.totalChars++; },
    (value: ReaderResult) => { value.unresolved.push('A later invented uncertainty'); },
    (value: ReaderResult) => { delete value.contract; },
    (value: ReaderResult) => { delete value.producer; },
    (value: ReaderResult) => { value.coverage[0]!.visibleRange.end--; }
  ]) {
    const value = structuredClone(result.value); mutate(value);
    const changed = db.write<ReaderResult>({ id: `reader-result:v2:${hashJson(value)}`,
      kind: 'reader-result', expected: 0, value });
    assert.throws(() => readReaderResultAt(db, 'p', reference(changed)), { code: 'reader_result_invalid' });
  }
  assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 1);
});

test('an unsent reader may reprepare its profile, and its call names the final prepared revision', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84a-reprepare-'));
  const database = join(root, 'db.sqlite'), store = new Store(database), competitor = new Store(database);
  t.after(() => { competitor.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Reader reprepare' });
  writeFileSync(join(root, 'source.txt'), 'Condition\nException\n');
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,
research:{selections:[{sourceIndex:0,firstLine:s.sources[0].lines[0][0],lastLine:s.sources[0].lines.at(-1)[0]}],unresolved:[]},
usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const settings = { experimental: true as const, active: true, stopAfter: 'L2' as const,
    reader: { actor: 'reader', model: 'fixture', effort: 'high' as const, speed: 'inherited' as const, command },
    agentCommand: command, maxCalls: 10, maxReportedTokens: 100000,
    maxRequestChars: 30000, maxReadChars: 20000, maxReplyChars: 5000 };
  const firstPilot = configureReaderPilot(store, engine.environments, 'p', settings, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation', [{ field: 'result', kind: 'design',
    prompt: 'Read exact original', risk: 'Missing exception', schema: { type: 'object' } },
    { field: 'sibling', kind: 'decision', prompt: 'Choose independently', risk: 'Wrong choice',
      schema: { type: 'string' } }]);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  let currentEnvironment = environment.value;
  const invoke = (pilot: typeof firstPilot) => readBundle(store, currentEnvironment, pilot, reference(question),
    'Read both lines', [{ path: 'source.txt', media: 'text/plain' }]);
  const original = store.writeMany.bind(store); let stopped = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const saved = original(writes, guards);
    if (!stopped && writes.some(write => write.kind === 'research-consumer-intent' && write.expected === 0)) {
      stopped = true; throw new EngineError('fixture_prepared', 'Unsent preparation is durable');
    }
    return saved;
  }) as typeof store.writeMany;
  await assert.rejects(invoke(firstPilot), { code: 'fixture_prepared' });
  store.writeMany = original;
  assert.equal(store.list('model-call').length, 0);
  const prepared = store.list<any>('research-consumer-intent')[0]!;
  assert.equal(prepared.value.state, 'prepared');
  const beforePreview = store.list<any>('research-consumer-intent');
  const preparedPreview = await previewResearch(() => invoke(firstPilot));
  assert.equal(preparedPreview.purpose, 'reader');
  assert.deepEqual(store.list('research-consumer-intent'), beforePreview);
  assert.equal(store.list('model-call').length, 0);
  const refreshedEnvironment = engine.environments.configure('p', { ...environment.value }, environment.revision);
  currentEnvironment = refreshedEnvironment.value;
  assert.equal(canonical(currentEnvironment), canonical(environment.value),
    'a new revision of the same environment still needs fresh transactional guards');
  const sibling = store.get<Question>(draft.value.questions[1]!)!;
  engine.discovery.decision(sibling.id, sibling.revision, 'owner', 'chosen');
  const laterPilot = configureReaderPilot(store, engine.environments, 'p',
    { ...settings, maxReadChars: 19999 }, firstPilot.revision);
  const raced = await Promise.allSettled([invoke(laterPilot),
    readBundle(competitor, currentEnvironment, laterPilot, reference(question), 'Read both lines',
      [{ path: 'source.txt', media: 'text/plain' }])]);
  const winner = raced.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof invoke>>> =>
    outcome.status === 'fulfilled');
  assert.ok(winner, 'one Store must complete the exact prepared operation');
  for (const outcome of raced) if (outcome.status === 'rejected')
    assert.equal(outcome.reason?.code, 'research_consumer_execution_running');
  const result = await invoke(laterPilot);
  assert.deepEqual(result, winner.value);
  const latest = store.get<any>(prepared.id)!;
  assert.equal(latest.value.state, 'applied');
  const second = store.get<any>(prepared.id, 2)!;
  assert.equal(second.value.state, 'prepared');
  assert.ok(second.value.guards.some((guard: Ref) => guard.id === refreshedEnvironment.id
    && guard.revision === refreshedEnvironment.revision));
  assert.equal(second.value.guards.some((guard: Ref) => guard.id === environment.id
    && guard.revision === environment.revision), false);
  assert.deepEqual(readResearchConsumerIntent(store, reference(second)), second);
  const call = store.list<any>('model-call')[0]!;
  assert.equal(canonical(call.value.consumerIntent), canonical(reference(second)));
  assert.equal(result.id.startsWith('reader-result:v2:'), true);
  assert.equal(result.value.observations.map(observation => observation.value).join(''), 'Condition\nException\n');
  assert.equal(store.list('model-call').length, 1);
  assert.equal(store.list('model-response').length, 1);
});

test('a sibling answer advances the draft without repaying an exact reader answer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84a-draft-'));
  const store = new Store(join(root, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Reader draft dependency' });
  writeFileSync(join(root, 'source.txt'), 'Original fact\n');
  const wire = join(root, 'wire.ndjson'), adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,
research:{selections:[{sourceIndex:0,firstLine:s.sources[0].lines[0][0],lastLine:s.sources[0].lines.at(-1)[0]}],unresolved:[]},
usage:{inputTokens:4,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true,
    active: true, stopAfter: 'L2', reader: { actor: 'reader', model: 'fixture', effort: 'high',
      speed: 'inherited', command }, agentCommand: command, maxCalls: 10,
    maxReportedTokens: 100000, maxRequestChars: 30000, maxReadChars: 20000,
    maxReplyChars: 5000 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation', [
    { field: 'fact', kind: 'design', prompt: 'Read fact', risk: 'Missing', schema: { type: 'string' } },
    { field: 'sibling', kind: 'decision', prompt: 'Choose sibling', risk: 'Wrong', schema: { type: 'string' } }
  ]);
  const selected = store.get<Question>(draft.value.questions[0]!)!;
  const invoke = () => readBundle(store, environment.value, pilot, reference(selected), 'Read fact',
    [{ path: 'source.txt', media: 'text/plain' }]);
  const original = store.writeMany.bind(store); let stopped = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const rows = original(writes, guards);
    if (!stopped && writes.some(write => write.kind === 'model-response')) {
      stopped = true; throw new EngineError('fixture_after_response', 'The paid response is durable');
    }
    return rows;
  }) as typeof store.writeMany;
  await assert.rejects(invoke(), { code: 'fixture_after_response' });
  store.writeMany = original;
  const sibling = store.get<Question>(draft.value.questions[1]!)!;
  engine.discovery.decision(sibling.id, sibling.revision, 'owner', 'chosen');
  const moved = store.get<any>(draft.id)!;
  store.write({ id: draft.id, kind: moved.kind, expected: moved.revision,
    value: { ...moved.value, fields: { ...moved.value.fields, fact: 'changed task' } } });
  await assert.rejects(invoke(), { code: 'reader_draft_stale' });
  const restored = store.get<any>(draft.id)!;
  store.write({ id: draft.id, kind: restored.kind, expected: restored.revision,
    value: { ...restored.value, fields: { ...restored.value.fields, fact: null } } });
  const result = await invoke();
  assert.equal(result.value.observations[0]?.value, 'Original fact\n');
  assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 1);
  assert.equal(store.list('model-call').length, 1);
  assert.deepEqual(readReaderResultAt(store, 'p', reference(result)), result);
  const revised = store.write<Question>({ id: selected.id, kind: selected.kind,
    expected: selected.revision, value: selected.value });
  await assert.rejects(readBundle(store, environment.value, pilot, reference(revised), 'Read fact',
    [{ path: 'source.txt', media: 'text/plain' }]), { code: 'question_stale' });
  assert.equal(store.list('model-call').length, 1, 'a revision number alone cannot buy a second call');
});

test('an invalid paid reader selection is a durable refusal, never a new purchase', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84a-invalid-'));
  const database = join(root, 'db.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Reader invalid selection' });
  writeFileSync(join(root, 'source.txt'), 'Exact source\n');
  const wire = join(root, 'wire.ndjson'), adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,
research:{selections:[],unresolved:[]},
usage:{inputTokens:4,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true,
    active: true, stopAfter: 'L2', reader: { actor: 'reader', model: 'fixture', effort: 'high',
      speed: 'inherited', command }, agentCommand: command, maxCalls: 10,
    maxReportedTokens: 100000, maxRequestChars: 30000, maxReadChars: 20000,
    maxReplyChars: 5000 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
    [{ field: 'fact', kind: 'design', prompt: 'Read', risk: 'Missing', schema: { type: 'string' } }]);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const invoke = (db: Store) => readBundle(db, environment.value, pilot, reference(question),
    'Read exact source', [{ path: 'source.txt', media: 'text/plain' }]);
  await assert.rejects(invoke(store), { code: 'reader_response_empty' });
  const refused = store.list<any>('research-consumer-intent')[0]!;
  assert.equal(readResearchConsumerIntent(store, reference(refused)).value.refusal?.kind, 'reader-invalid');
  assert.equal(refused.value.refusal.code, 'reader_response_empty');
  assert.equal(store.list('reader-result').length, 0);
  const reopened = open();
  await assert.rejects(invoke(reopened), { code: 'reader_response_empty' });
  assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 1);
  assert.equal(reopened.list('model-call').length, 1);
  assert.deepEqual(reopened.get(refused.id), refused);
});

test('changed source, including an unresolved-only reply, and dispatch refuse application after exact paid recovery', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84a-stale-'));
  const database = join(root, 'db.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Paid reader admission' });
  writeFileSync(join(root, 'source.txt'), 'Original source\n');
  const wire = join(root, 'wire.ndjson'), adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,
research:{selections:[],unresolved:['The source needs an independent follow-up']},
usage:{inputTokens:4,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const settings = { experimental: true as const, active: true, stopAfter: 'L2' as const,
    reader: { actor: 'reader', model: 'fixture', effort: 'high' as const,
      speed: 'inherited' as const, command }, agentCommand: command,
    maxCalls: 10, maxReportedTokens: 100000, maxRequestChars: 30000,
    maxReadChars: 20000, maxReplyChars: 5000 };
  const pilot = configureReaderPilot(store, engine.environments, 'p', settings, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
    [{ field: 'fact', kind: 'design', prompt: 'Read', risk: 'Missing', schema: { type: 'string' } }]);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const invoke = (db: Store, selected: typeof pilot) => readBundle(db, environment.value, selected,
    reference(question), 'Read exact source', [{ path: 'source.txt', media: 'text/plain' }]);
  const original = store.writeMany.bind(store); let stopped = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const rows = original(writes, guards);
    if (!stopped && writes.some(write => write.kind === 'model-response')) {
      stopped = true; throw new EngineError('fixture_after_response', 'The paid answer is saved');
    }
    return rows;
  }) as typeof store.writeMany;
  await assert.rejects(invoke(store, pilot), { code: 'fixture_after_response' });
  store.writeMany = original;
  const exact = store.list<any>('research-consumer-intent')[0]!;
  const responseCount = store.list('model-response').length;
  writeFileSync(join(root, 'source.txt'), 'Changed source\n');
  new ResearchSources(store, 'p', root).read('source.txt', 'text/plain');
  const reopened = open();
  await assert.rejects(invoke(reopened, pilot), { code: 'reader_intent_source_stale' });
  const newerPilot = configureReaderPilot(store, engine.environments, 'p',
    { ...settings, maxReadChars: 19999 }, pilot.revision);
  await assert.rejects(invoke(reopened, newerPilot), { code: 'reader_intent_dispatch_stale' });
  assert.equal(readResearchConsumerIntent(reopened, reference(exact)).value.state, 'running');
  assert.equal(reopened.list('reader-result').length, 0);
  assert.equal(reopened.list('model-response').length, responseCount);
  assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 1);
});

test('a changed workspace after a paid reply refuses fresh reader application', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84a-workspace-'));
  const database = join(root, 'db.sqlite'), store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Workspace admission' });
  writeFileSync(join(root, 'source.txt'), 'Original source\n');
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{selections:[],unresolved:['Need follow-up']},usage:{inputTokens:4,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true,
    stopAfter: 'L2', reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command },
    agentCommand: command, maxCalls: 10, maxReportedTokens: 100000, maxRequestChars: 30000,
    maxReadChars: 20000, maxReplyChars: 5000 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
    [{ field: 'fact', kind: 'design', prompt: 'Read', risk: 'Missing', schema: { type: 'string' } }]);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const original = store.writeMany.bind(store); let changed = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const rows = original(writes, guards);
    if (!changed && writes.some(write => write.kind === 'model-response')) {
      changed = true;
      const replacement = mkdtempSync(join(root, 'replacement-'));
      writeFileSync(join(replacement, 'source.txt'), 'Changed current workspace\n');
      engine.environments.configure('p', { ...environment.value, workspace: replacement }, environment.revision);
    }
    return rows;
  }) as typeof store.writeMany;
  await assert.rejects(readBundle(store, environment.value, pilot, reference(question),
    'Read exact source', [{ path: 'source.txt', media: 'text/plain' }]),
    (error: unknown) => error instanceof EngineError && ['reader_intent_dispatch_stale', 'input_stale'].includes(error.code));
  store.writeMany = original;
  assert.equal(changed, true);
  assert.equal(store.list('reader-result').length, 0);
  assert.equal(store.list('model-call').length, 1);
  assert.equal(store.list<any>('research-consumer-intent')[0]!.value.state, 'running');
});

async function receivedReaderFixture(t: import('node:test').TestContext, invalid = false) {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84a-paid-proof-'));
  const database = join(root, 'db.sqlite'), store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Paid proof' });
  writeFileSync(join(root, 'source.txt'), 'Exact source line\n');
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{selections:[{sourceIndex:0,firstLine:${invalid ? 99999 : 1},lastLine:${invalid ? 99999 : 1}}],unresolved:[]},usage:{inputTokens:4,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true,
    stopAfter: 'L2', reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command },
    agentCommand: command, maxCalls: 5, maxReportedTokens: 100000, maxRequestChars: 30000,
    maxReadChars: 20000, maxReplyChars: 5000 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
    [{ field: 'fact', kind: 'design', prompt: 'Read', risk: 'Missing', schema: { type: 'string' } }]);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const original = store.writeMany.bind(store); let interrupted = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const rows = original(writes, guards);
    if (!interrupted && writes.some(write => write.kind === 'model-response')) {
      interrupted = true; throw new EngineError('fixture_after_paid_response', 'The paid response is saved');
    }
    return rows;
  }) as typeof store.writeMany;
  await assert.rejects(readBundle(store, environment.value, pilot, reference(question),
    'Read source', [{ path: 'source.txt', media: 'text/plain' }]), { code: 'fixture_after_paid_response' });
  store.writeMany = original;
  const intent = store.list<any>('research-consumer-intent')[0]!;
  const call = store.get<ModelCall>(intent.value.call.id)!;
  assert.equal(call.value.status, 'succeeded');
  return { store, database, intent, call, environment, pilot, question, root };
}

test('a forged failed status cannot turn a successful physical reader call into refused', async t => {
  const { store, intent, call } = await receivedReaderFixture(t);
  store.write<ModelCall>({ id: call.id, kind: call.kind, expected: call.revision,
    value: { ...call.value, status: 'failed', error: 'research_provider_failed' } });
  assert.throws(() => readResearchConsumerExecution(store, 'p', reference(intent)),
    { code: 'response_recovery_execution_invalid' });
  assert.equal(store.list<any>('research-consumer-intent').at(-1)!.value.state, 'running');
});

test('paid reader application and refusal use the full historical result derivation', async t => {
  const { store, database, intent, call } = await receivedReaderFixture(t);
  const input = intent.value;
  const incomplete = { projectId: 'p', question: input.question, pilot: input.profile,
    purpose: input.cursor.purpose, sources: input.cursor.sourceOrder.map((source: any) => source.source) };
  const write: Write = { id: `reader-result:v2:${hashJson(incomplete)}`,
    kind: 'reader-result', expected: 0, value: incomplete };
  assert.throws(() => prepareResearchConsumerApplication(store, reference(intent), reference(call),
    [write], input.guards), { code: 'research_consumer_intent_invalid' });
  assert.throws(() => refuseResearchConsumerIntent(store, reference(intent), 'reader_selection_foreign'),
    { code: 'research_consumer_intent_invalid' });
  const reopened = new Store(database);t.after(() => reopened.close());
  assert.equal(readResearchConsumerIntent(reopened, reference(intent)).value.state, 'running');
  assert.equal(reopened.list('reader-result').length, 0);
});

test('a second Store changing environment at result commit loses the guarded race', async t => {
  const { store, database, environment, pilot, question, root } = await receivedReaderFixture(t);
  const competitor = new Store(database);t.after(() => competitor.close());
  const original = store.writeMany.bind(store);let raced = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    if (!raced && writes.some(write => write.kind === 'reader-result')) {
      raced = true;
      const replacement = mkdtempSync(join(root, 'replacement-'));
      writeFileSync(join(replacement, 'source.txt'), 'Different current workspace\n');
      new ProductEngine(competitor).environments.configure('p',
        { ...environment.value, workspace: replacement }, environment.revision);
    }
    return original(writes, guards);
  }) as typeof store.writeMany;
  await assert.rejects(readBundle(store, environment.value, pilot, reference(question),
    'Read source', [{ path: 'source.txt', media: 'text/plain' }]), { code: 'input_stale' });
  store.writeMany = original;
  assert.equal(raced, true);
  assert.equal(store.list('reader-result').length, 0);
  assert.equal(store.list<any>('research-consumer-intent').at(-1)!.value.state, 'running');
  assert.equal(store.list('model-call').length, 1);
});

test('an empty proved provider failure needs the next public reader entry before one new generation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84a-generation-'));
  const database = join(root, 'db.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Reader generation' });
  writeFileSync(join(root, 'source.txt'), 'Original condition\n');
  const marker = join(root, 'fail-once'), wire = join(root, 'wire.ndjson'), adapter = join(root, 'adapter.mjs');
  writeFileSync(marker, 'fail');
  writeFileSync(adapter, `import{readFileSync,appendFileSync,existsSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
if(existsSync(${JSON.stringify(marker)}))process.exit(1);
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,
research:{selections:[{sourceIndex:0,firstLine:s.sources[0].lines[0][0],lastLine:s.sources[0].lines.at(-1)[0]}],unresolved:[]},
usage:{inputTokens:4,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const settings = { experimental: true as const, active: true, stopAfter: 'L2' as const,
    reader: { actor: 'reader', model: 'fixture', effort: 'high' as const,
      speed: 'inherited' as const, command }, agentCommand: command,
    maxCalls: 10, maxReportedTokens: 100000, maxRequestChars: 30000,
    maxReadChars: 20000, maxReplyChars: 5000 };
  const pilot = configureReaderPilot(store, engine.environments, 'p', settings, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
    [{ field: 'fact', kind: 'design', prompt: 'Read', risk: 'Missing', schema: { type: 'string' } }]);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const invoke = (db: Store, selected: typeof pilot) => readBundle(db, environment.value, selected,
    reference(question), 'Read the source', [{ path: 'source.txt', media: 'text/plain' }]);
  const original = store.writeMany.bind(store); let lostRefusal = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    if (!lostRefusal && writes.some(write => write.kind === 'research-consumer-intent'
      && (write.value as any).state === 'refused')) {
      lostRefusal = true; throw new EngineError('fixture_before_refused', 'Physical failure saved, intent terminal lost');
    }
    return original(writes, guards);
  }) as typeof store.writeMany;
  await assert.rejects(invoke(store, pilot), { code: 'fixture_before_refused' });
  store.writeMany = original;
  assert.equal(store.list<any>('research-consumer-intent')[0]!.value.state, 'running');
  assert.deepEqual(captureResearchConsumerRetryPermits(store, 'p'), []);
  await assert.rejects(invoke(open(), pilot), { code: 'research_consumer_execution_refused' });
  assert.equal(store.list('model-call').length, 1, 'the first recovery only terminalizes; it has no entry permit');
  const first = store.list<any>('research-consumer-intent')[0]!;
  assert.equal(readResearchConsumerIntent(store, reference(first)).value.refusal?.kind, 'provider-failed');
  assert.equal(store.list('model-call').length, 1);
  assert.equal(store.list('reader-result').length, 0);
  rmSync(marker);
  const failed = store.list<any>('model-call')[0]!;
  const later = store.write({ id: failed.id, kind: failed.kind, expected: failed.revision,
    value: failed.value });
  assert.equal(readResearchConsumerIntent(open(), reference(first)).value.refusal?.call.revision,
    failed.revision, 'a later call revision cannot rewrite the saved terminal receipt');
  const resumedPilot = configureReaderPilot(store, engine.environments, 'p',
    { ...settings, unknownReserves: [{ call: reference(later), tokens: 100 }] }, pilot.revision);
  const competitor = open();
  const raced = await Promise.allSettled([invoke(store, resumedPilot), invoke(competitor, resumedPilot)]);
  const winner = raced.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof invoke>>> =>
    outcome.status === 'fulfilled');
  assert.ok(winner, 'one public invocation must complete the new generation');
  for (const outcome of raced) if (outcome.status === 'rejected')
    assert.ok(['research_consumer_execution_running', 'reader_intent_claim_conflict'].includes(outcome.reason?.code),
      `unexpected competing outcome: ${String(outcome.reason)}`);
  assert.equal(store.list('research-consumer-intent').length, 2);
  assert.equal(store.list('model-call').length, 2);
  assert.equal(store.list('reader-result').length, 1);
  assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 2);
  const reopened = open();
  assert.deepEqual(await invoke(reopened, resumedPilot), winner.value);
  assert.equal(reopened.list('model-call').length, 2);
});

test('received but unusable physical replies remain distinct terminal evidence without a retry permit', async t => {
  for (const variant of [
    { name: 'nonempty-failed', code: 'research_provider_failed', reply: `console.log('provider rejected');process.exit(1);` },
    { name: 'empty-success', code: 'research_response_invalid', reply: '' },
    { name: 'signal', code: 'research_provider_failed', reply: `process.kill(process.pid,'SIGTERM');` },
    { name: 'timeout', code: 'process_timeout', reply: `await new Promise(resolve=>setTimeout(resolve,10000));` },
    { name: 'usage-invalid', code: 'usage_invalid', reply: `console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{selections:[],unresolved:['Nothing']},usage:{inputTokens:-1}}));` },
    { name: 'output-limit', code: 'budget_transport_limit', reply: `console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{selections:[],unresolved:['X'.repeat(6000)]}}));` },
    { name: 'invalid-json', code: 'research_response_invalid', reply: `console.log('{not json');` },
    { name: 'foreign-envelope', code: 'research_response_foreign',
      reply: `console.log(JSON.stringify({protocol:r.protocol,requestId:'another-request',research:{selections:[],unresolved:[]}}));` }
  ]) await t.test(variant.name, async caseTest => {
    const root = mkdtempSync(join(tmpdir(), `omg-d84a-${variant.name}-`));
    const database = join(root, 'db.sqlite'), stores: Store[] = [];
    const open = () => { const db = new Store(database); stores.push(db); return db; };
    caseTest.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
    const store = open(), engine = new ProductEngine(store);
    engine.execute({ type: 'create-project', project: 'p', title: variant.name });
    writeFileSync(join(root, 'source.txt'), 'One exact line\n');
    const wire = join(root, 'wire.ndjson'), adapter = join(root, 'adapter.mjs');
    writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
${variant.reply}`);
    const command = { executable: process.execPath, args: [adapter] };
    const environment = engine.environments.configure('p', { workspace: root,
      implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
      fullCheck: command, timeoutMs: variant.name === 'timeout' ? 1000 : 5000 }, 0);
    const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true,
      stopAfter: 'L2', reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command },
      agentCommand: command, maxCalls: 5, maxReportedTokens: 100000, maxRequestChars: 30000,
      maxReadChars: 20000, maxReplyChars: 5000,
      ...(variant.name === 'output-limit' ? {physicalLimits:{maxRequestChars:100000,maxReplyChars:1000,basis:'Fixture transport limit'}} : {}) }, 0);
    const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
      [{ field: 'fact', kind: 'design', prompt: 'Read', risk: 'Missing', schema: { type: 'string' } }]);
    const question = store.get<Question>(draft.value.questions[0]!)!;
    const invoke = (db: Store) => readBundle(db, environment.value, pilot, reference(question),
      'Read the source', [{ path: 'source.txt', media: 'text/plain' }]);
    await assert.rejects(invoke(store), { code: variant.code });
    const intent = store.list<any>('research-consumer-intent')[0]!;
    assert.equal(readResearchConsumerIntent(store, reference(intent)).value.refusal?.kind, 'terminal');
    assert.equal(readResearchConsumerIntent(open(), reference(intent)).value.refusal?.code, variant.code);
    assert.equal(store.list('model-call').length, 1);
    assert.equal(store.list('model-response').length, variant.name === 'timeout' ? 0 : 1);
    await assert.rejects(invoke(open()), { code: 'research_consumer_execution_refused' });
    assert.equal(store.list('research-consumer-intent').length, 1);
    assert.equal(store.list('model-call').length, 1);
    assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 1);
  });
});

test('a real pre-intent Git producer remains readable as paid, reused and combined history', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84a-legacy-'));
  const database = join(root, 'db.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const repositoryUrl = pathToFileURL(repository).href;
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const loader = join(root, 'old-reader-loader.mjs');
  writeFileSync(loader, `import{execFileSync}from'node:child_process';
import{fileURLToPath}from'node:url';import ts from ${JSON.stringify(typescript)};
let root;export function initialize(data){root=data.root}
export async function load(url,context,next){const prefix=new URL('dist/',root).href;
if(url.startsWith(prefix)&&/\\.js$/.test(url)){const relative=url.slice(prefix.length).replace(/\\.js$/,'.ts');
const source=execFileSync('git',['show','a4b6f57:'+relative],{cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
return{format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText}}
return next(url,context)};`);
  writeFileSync(join(root, 'a.txt'), 'A condition\nA exception\n');
  writeFileSync(join(root, 'big.txt'), '0123456789'.repeat(6000));
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{
selections:s.sources.map((x,i)=>({sourceIndex:i,firstLine:x.lines[0][0],lastLine:x.lines.at(-1)[0]})),unresolved:[]},
usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const source = `const base=${JSON.stringify(repositoryUrl)}, src=p=>new URL('dist/src/'+p,base).href;
const {Store}=await import(src('storage/store.js'));
const {ProductEngine}=await import(src('product/engine.js'));
const {configureReaderPilot}=await import(src('discovery/reader-pilot.js'));
const {readBundle}=await import(src('discovery/reader.js'));
const {ResearchSources}=await import(src('discovery/research-sources.js'));
const {reference}=await import(src('pipeline/contracts.js'));
const store=new Store(${JSON.stringify(database)}),engine=new ProductEngine(store);
engine.execute({type:'create-project',project:'p',title:'Old reader producer'});
const command={executable:process.execPath,args:[${JSON.stringify(adapter)}]};
const environment=engine.environments.configure('p',{workspace:${JSON.stringify(root)},
implementer:{actor:'author',model:'fixture',effort:'high',command},
reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:5000},0);
const settings={experimental:true,active:true,stopAfter:'L2',
reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command},agentCommand:command,
maxCalls:20,maxReportedTokens:100000,maxRequestChars:30000,maxReadChars:20000,maxReplyChars:5000};
let pilot=configureReaderPilot(store,engine.environments,'p',settings,0);
const question=()=>{const draft=engine.discovery.create('p','discovery','R0','compilation',
[{field:'fact',kind:'design',prompt:'Read',risk:'Missing',schema:{type:'string'}}]);
return store.get(draft.value.questions[0])};
let q=question();const paid=await readBundle(store,environment.value,pilot,reference(q),'Read',
[{path:'a.txt',media:'text/plain'}]);
q=question();const reused=await readBundle(store,environment.value,pilot,reference(q),'Read',
[{path:'a.txt',media:'text/plain'}]);
pilot=configureReaderPilot(store,engine.environments,'p',{...settings,maxRequestChars:100000},pilot.revision);
q=question();const big=new ResearchSources(store,'p',${JSON.stringify(root)}).read('big.txt','text/plain');
const priorHalf=await readBundle(store,environment.value,pilot,reference(q),'Read',
[{source:reference(big),range:{start:0,end:30000}}]);
pilot=configureReaderPilot(store,engine.environments,'p',settings,pilot.revision);
const combined=await readBundle(store,environment.value,pilot,reference(q),'Read',
[{path:'big.txt',media:'text/plain'}]);
process.stdout.write(JSON.stringify({paid:reference(paid),reused:reference(reused),
priorHalf:reference(priorHalf),combined:reference(combined)}));
store.close();`;
  const bootstrap = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},
{data:{root:${JSON.stringify(repositoryUrl)}}});`;
  const output = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`,
    '--input-type=module', '--eval', source], { cwd: repository, encoding: 'utf8', maxBuffer: 10_000_000 });
  const refs = JSON.parse(output) as { paid: ReturnType<typeof reference>; reused: ReturnType<typeof reference>;
    priorHalf: ReturnType<typeof reference>; combined: ReturnType<typeof reference> };
  const reopened = new Store(database); t.after(() => reopened.close());
  assert.equal(reopened.list('research-consumer-intent').length, 0);
  const paid = readReaderResultAt(reopened, 'p', refs.paid);
  const reused = readReaderResultAt(reopened, 'p', refs.reused);
  const combined = readReaderResultAt(reopened, 'p', refs.combined);
  assert.equal(paid.value.reusedFrom, undefined);
  assert.deepEqual(reused.value.reusedFrom, [refs.paid]);
  assert.equal(combined.value.parts?.length, 2);
  assert.ok(combined.value.observations.length > 1);
  const firstChild = readReaderResultAt(reopened, 'p', combined.value.parts![0]!);
  assert.deepEqual(reference(firstChild), refs.priorHalf);
  assert.notDeepEqual(firstChild.value.pilot, combined.value.pilot,
    'the old producer legitimately combined children made under different pilot revisions');
  writeFileSync(join(root, 'new.txt'), 'New sibling original\n');
  const currentEnvironment = reopened.get<any>('environment:p')!;
  const currentPilot = reopened.list<any>('reader-pilot')[0]!;
  const oldCalls = reopened.list('model-call').length;
  const mixed = await readBundle(reopened, currentEnvironment.value, currentPilot, combined.value.question, 'Read',
    [{ path: 'big.txt', media: 'text/plain' }, { path: 'new.txt', media: 'text/plain' }]);
  assert.equal(mixed.value.producer, 'combined');
  assert.deepEqual(mixed.value.parts![0], reference(combined), 'new parent borrows the exact legacy subtree');
  assert.equal(reopened.list('model-call').length, oldCalls + 1);
  const mixedChild = reopened.list<any>('research-consumer-intent')[0]!;
  writeFileSync(join(root, 'big.txt'), 'Changed only after mixed parent');
  const restarted = new Store(database);t.after(() => restarted.close());
  assert.deepEqual(await resumeReadBundleIntent(restarted, reference(mixedChild), currentEnvironment.value,
    currentPilot, undefined, []), mixed);
  assert.equal(restarted.list('model-call').length, oldCalls + 1);
  writeFileSync(join(root, 'a.txt'), 'Changed current source\n');
  new ResearchSources(reopened, 'p', root).read('a.txt', 'text/plain');
  assert.deepEqual(readReaderResultAt(reopened, 'p', refs.paid), paid);
  assert.deepEqual(readReaderResultAt(reopened, 'p', refs.reused), reused);
});

test('a process-lost reader keeps its one physical call and exact late stdout without applying it',
  { skip: process.platform === 'win32' }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'omg-d84a-late-'));
    const database = join(root, 'db.sqlite'), wire = join(root, 'wire.ndjson');
    const adapter = join(root, 'adapter.mjs'), driver = join(root, 'driver.mjs');
    const input = join(root, 'input.json'), late = join(root, 'late.json');
    const stores: Store[] = [], open = () => { const db = new Store(database); stores.push(db); return db; };
    let child: ChildProcess | null = null;
    t.after(() => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      for (const db of stores) db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const store = open(), engine = new ProductEngine(store);
    engine.execute({ type: 'create-project', project: 'p', title: 'Reader late physical reply' });
    writeFileSync(join(root, 'source.txt'), 'Condition\nException\n');
    writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,
research:{selections:[{sourceIndex:0,firstLine:s.sources[0].lines[0][0],lastLine:s.sources[0].lines.at(-1)[0]}],unresolved:[]},
usage:{inputTokens:4,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
    const command = { executable: process.execPath, args: [adapter] };
    const environment = engine.environments.configure('p', { workspace: root,
      implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
      fullCheck: command, timeoutMs: 5000 }, 0);
    const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true,
      active: true, stopAfter: 'L2', reader: { actor: 'reader', model: 'fixture',
        effort: 'high', speed: 'inherited', command }, agentCommand: command,
      maxCalls: 10, maxReportedTokens: 100000, maxRequestChars: 30000,
      maxReadChars: 20000, maxReplyChars: 5000 }, 0);
    const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
      [{ field: 'fact', kind: 'design', prompt: 'Read', risk: 'Missing', schema: { type: 'string' } }]);
    const question = store.get<Question>(draft.value.questions[0]!)!;
    writeFileSync(input, JSON.stringify({ database, environmentId: environment.id,
      pilotId: pilot.id, question: reference(question), late }));
    writeFileSync(driver, `import{readFileSync,writeFileSync}from'node:fs';
import{Store}from${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import{readBundle}from${JSON.stringify(new URL('../src/discovery/reader.js', import.meta.url).href)};
const spec=JSON.parse(readFileSync(process.argv[2],'utf8')),store=new Store(spec.database);
const original=store.writeMany.bind(store);
store.writeMany=(writes,guards=[])=>{const receipt=writes.find(w=>w.kind==='model-response'&&w.value.consumerExecution);
if(receipt){writeFileSync(spec.late,JSON.stringify({process:{...receipt.value.consumerExecution.process,stdout:receipt.value.text},launchError:null}));
process.exit(73)}return original(writes,guards)};
try{const environment=store.get(spec.environmentId),pilot=store.get(spec.pilotId);
await readBundle(store,environment.value,pilot,spec.question,'Read original',[{path:'source.txt',media:'text/plain'}]);
throw Error('The physical response was not intercepted')}
catch(error){console.error(error?.stack??String(error));process.exitCode=72}
finally{store.close()}`);
    child = spawn(process.execPath, [driver, input], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', buffer => { stderr += buffer.toString(); });
    child.stdout!.resume();
    const exit = await new Promise<number | null>((resolve, reject) => {
      child!.once('error', reject); child!.once('close', resolve);
    });
    assert.equal(exit, 73, stderr);
    const dispatched = store.list<ModelCall>('model-call')[0]!;
    assert.equal(dispatched.value.status, 'running');
    assert.equal(dispatched.value.response, null);
    const evidence = JSON.parse(readFileSync(late, 'utf8')) as LateModelReceipt['evidence'];
    const invoke = (db: Store) => readBundle(db, environment.value, pilot, reference(question),
      'Read original', [{ path: 'source.txt', media: 'text/plain' }]);
    const reopened = open();
    await assert.rejects(invoke(reopened), { code: 'research_consumer_execution_refused' });
    const recovered = reopened.get<ModelCall>(dispatched.id)!;
    assert.equal(recovered.value.error, 'process_lost');
    assert.equal(recovered.value.usage, null);
    const proof = readModelCallRecovery(reopened, 'p', reference(recovered));
    assert.deepEqual(reference(proof.original), reference(dispatched));
    const prepared = prepareLateModelReceipt(reopened, 'p', reference(dispatched), evidence);
    const receipt = reopened.writeMany<LateModelReceipt>(prepared.writes, prepared.guards)[0]!;
    assert.deepEqual(readLateModelReceipt(reopened, 'p', reference(recovered)), receipt);
    const before = { calls: reopened.history(dispatched.id), intent: reopened.list('research-consumer-intent'),
      late: reopened.history(receipt.id), responses: reopened.list('model-response') };
    for (let index = 0; index < 2; index++) {
      const db = open();
      await assert.rejects(invoke(db), { code: 'research_consumer_execution_refused' });
      assert.deepEqual(db.history(dispatched.id), before.calls);
      assert.deepEqual(db.list('research-consumer-intent'), before.intent);
      assert.deepEqual(db.history(receipt.id), before.late);
      assert.deepEqual(db.list('model-response'), before.responses);
      assert.equal(db.list('reader-result').length, 0);
    }
    assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 1);
  });

for (const entry of ['bundle', 'intent'] as const) test(`paid application refreshes equivalent environment guards through ${entry}`, async t => {
  const f = await receivedReaderFixture(t), engine = new ProductEngine(f.store);
  const originalIntent = f.intent, calls = f.store.list('model-call');
  const current = engine.environments.configure('p', { ...f.environment.value }, f.environment.revision);
  const db = new Store(f.database); t.after(() => db.close());
  const original = db.writeMany.bind(db); let appliedGuards: any[] = [];
  db.writeMany = ((writes: Write[], guards = []) => {
    if (writes.some(write => write.kind === 'reader-result')) appliedGuards = guards;
    return original(writes, guards);
  }) as typeof db.writeMany;
  const result = entry === 'bundle'
    ? await readBundle(db, current.value, f.pilot, reference(f.question), 'Read source', [{ path: 'source.txt', media: 'text/plain' }])
    : await resumeReadBundleIntent(db, reference(originalIntent), current.value, f.pilot, undefined, []);
  assert.deepEqual(result.value.observations.map(row => row.value), ['Exact source line\n']);
  assert.deepEqual(appliedGuards.filter(guard => guard.id === current.id), [reference(current)]);
  assert.deepEqual(db.get<any>(originalIntent.id)!.value.guards, originalIntent.value.guards,
    'the dispatch basis is immutable; only the application transaction takes today’s heads');
  assert.deepEqual(db.list('model-call'), calls);
  const reopened = new Store(f.database); t.after(() => reopened.close());
  writeFileSync(join(f.root, 'source.txt'), 'Changed only after application');
  assert.deepEqual(await resumeReadBundleIntent(reopened, reference(originalIntent), current.value, f.pilot, undefined, []), result);
  assert.deepEqual(reopened.list('model-call'), calls);
});

test('a paid invalid selection is classified from its original source before current admission', async t => {
  const f = await receivedReaderFixture(t, true), calls = f.store.list('model-call');
  writeFileSync(join(f.root, 'source.txt'), 'Changed after the invalid paid response');
  const db = new Store(f.database); t.after(() => db.close());
  await assert.rejects(resumeReadBundleIntent(db, reference(f.intent), f.environment.value, f.pilot, undefined, []),
    { code: 'reader_selection_foreign' });
  const refused = readResearchConsumerIntent(db, reference(db.get(f.intent.id)!));
  assert.equal(refused.value.refusal?.kind, 'reader-invalid');
  const reopened = new Store(f.database); t.after(() => reopened.close());
  await assert.rejects(resumeReadBundleIntent(reopened, reference(f.intent), f.environment.value, f.pilot, undefined, []),
    { code: 'reader_selection_foreign' });
  assert.deepEqual(reopened.list('model-call'), calls);
  assert.equal(reopened.list('reader-result').length, 0);
});

test('split children fold two refused generations each before resuming the exact root', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84a-fold-')), database = join(root, 'db.sqlite');
  const stores: Store[] = [], open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Split generations' });
  const text = 'Z'.repeat(60000); writeFileSync(join(root, 'source.txt'), text);
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync,writeFileSync,existsSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject,start=c.sources[0].visibleRange.start;
appendFileSync('wire.ndjson',JSON.stringify({start})+'\\n');
if(start===0||start===30000){const marker='attempts-'+start,n=existsSync(marker)?Number(readFileSync(marker,'utf8')):0;
writeFileSync(marker,String(n+1));if(n<2)process.exit(1);}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{selections:c.sources.map((s,i)=>({sourceIndex:i,firstLine:s.lines[0][0],lastLine:s.lines.at(-1)[0]})),unresolved:[]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const settings = { experimental: true as const, active: true, stopAfter: 'L2' as const,
    reader: { actor: 'reader', model: 'fixture', effort: 'high' as const, speed: 'inherited' as const, command },
    agentCommand: command, maxCalls: 200, maxReportedTokens: 100000, maxRequestChars: 30000,
    maxContinuationChars: 30000, maxReadChars: 20000, maxReplyChars: 5000 };
  let pilot = configureReaderPilot(store, engine.environments, 'p', settings, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
    [{ field: 'fact', kind: 'design', prompt: 'Read', risk: 'Missing', schema: { type: 'string' } }]);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const inputs = [{ path: 'source.txt', media: 'text/plain' as const }], purpose = 'Read all windows';
  const invoke = (db: Store, permits?: Ref[]) => readBundle(db, environment.value, pilot, reference(question), purpose, inputs,
    undefined, null, permits);
  let firstPermit: Ref[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    await assert.rejects(invoke(open()), { code: 'research_provider_failed' });
    const intents = store.list<any>('research-consumer-intent');
    assert.equal(store.list('model-call').length, attempt < 2 ? attempt + 1 : attempt + 3);
    const latest = intents.filter(row => row.value.state === 'refused')
      .sort((a, b) => b.value.generation - a.value.generation)[0]!;
    assert.equal(readResearchConsumerIntent(open(), reference(latest)).value.refusal?.kind, 'provider-failed');
    const failed = store.list<any>('model-call').filter(row => row.value.usage === null && row.value.status === 'failed');
    pilot = configureReaderPilot(store, engine.environments, 'p', { ...settings,
      unknownReserves: failed.map(call => ({ call: reference(call), tokens: 100 })) }, pilot.revision);
    if (attempt === 0) {
      firstPermit = captureResearchConsumerRetryPermits(store, 'p');
      const before = store.list('research-consumer-intent');
      assert.equal((await previewResearch(() => invoke(store, firstPermit))).purpose, 'reader');
      assert.deepEqual(store.list('research-consumer-intent'), before, 'preview g+1 is virtual');
      assert.equal(store.list('model-call').length, 1);
    }
    if (attempt === 1) {
      await assert.rejects(invoke(open(), firstPermit), { code: 'reader_intent_refused' });
      assert.equal(store.list('model-call').length, 2, 'a permit on g0 cannot buy g2');
    }
  }
  const result = await invoke(open());
  assert.equal(result.value.observations.map(row => row.value).join(''), text);
  assert.equal(store.list('model-call').length, 8);
  const intents = store.list<any>('research-consumer-intent');
  for (const path of [[0, 0], [1, 0]]) {
    const children = intents.filter(row => canonical(row.value.cursor.child) === canonical(path))
      .sort((a, b) => a.value.generation - b.value.generation);
    assert.deepEqual(children.map(row => [row.value.generation, row.value.state]),
      [[0, 'refused'], [1, 'refused'], [2, 'applied']]);
    assert.deepEqual(children[2]!.value.previous, reference(children[1]!));
    assert.notEqual(children[2]!.value.rootKey, children[2]!.value.cursor.rootKey);
  }
  const calls = store.list('model-call'); writeFileSync(join(root, 'source.txt'), 'Changed after completion');
  for (const selected of [intents[0]!, intents.at(-1)!, ...intents.filter(row => row.value.generation === 0)]) {
    const db = open();
    assert.deepEqual(await resumeReadBundleIntent(db, reference(selected), environment.value, pilot, undefined, []), result);
    assert.deepEqual(db.list('model-call'), calls);
  }
  const oldGeneration = intents.find(row => row.value.generation === 0)!;
  const sql = new DatabaseSync(database);t.after(() => sql.close());
  sql.prepare('DELETE FROM heads WHERE entity_id=?').run(oldGeneration.id);
  await assert.rejects(invoke(open()), { code: 'research_consumer_intent_invalid' });
  sql.prepare('INSERT INTO heads(entity_id,revision) VALUES(?,?)').run(oldGeneration.id, oldGeneration.revision);
  sql.prepare('INSERT INTO revisions(entity_id,revision,kind,body,sha256) SELECT entity_id,revision+1,?,body,sha256 FROM revisions WHERE entity_id=? AND revision=?')
    .run('foreign-intent', oldGeneration.id, oldGeneration.revision);
  sql.prepare('UPDATE heads SET revision=? WHERE entity_id=?').run(oldGeneration.revision + 1, oldGeneration.id);
  await assert.rejects(invoke(open()), { code: 'research_consumer_intent_invalid' });
  sql.prepare('UPDATE heads SET revision=? WHERE entity_id=?').run(oldGeneration.revision, oldGeneration.id);
  assert.deepEqual(store.list('model-call'), calls, 'broken generation history cannot authorize new work');
  assert.equal(readFileSync(join(root, 'wire.ndjson'), 'utf8').trim().split('\n').length, 8);
});

test('paid preview recovers only its isolated copy and completed preview does not invent an envelope', async t => {
  const f = await receivedReaderFixture(t), before = f.store.list();
  const snapshot = await f.store.snapshot(join(f.root, 'preview'));
  const isolated = new Store(snapshot.path); t.after(() => isolated.close());
  const invoke = () => resumeReadBundleIntent(isolated, reference(f.intent), f.environment.value, f.pilot, undefined, []);
  await assert.rejects(previewResearch(invoke), { code: 'research_preview_missing' });
  assert.equal(isolated.get<any>(f.intent.id)!.value.state, 'applied');
  assert.equal(isolated.list('model-call').length, 1);
  assert.equal(isolated.list('reader-result').length, 1);
  const completed = isolated.list();
  await assert.rejects(previewResearch(invoke), { code: 'research_preview_missing' });
  assert.deepEqual(isolated.list(), completed);
  assert.deepEqual(f.store.list(), before);
});

/* ==== D8.4b — synthesis/consolidation family (contract №1499) ====
 * Tests are named by the rows of the approved outcome table. */

import { synthesisSession, readSynthesisSession } from '../src/discovery/synthesis-session.js';
import { projectPaidSynthesisTransition } from '../src/discovery/response-recovery.js';
import { recoverContextSession } from '../src/discovery/context-recovery.js';
import { CONTEXT_RECOVERY_SUPERSEDE_REASON, acceptanceBindingId, acceptanceEraOf, projectAcceptanceBinding, attemptEraOf,
  projectSynthesisHandoffTurn, ACCEPTANCE_BINDING_CONTRACT,
  type ManagedResearchTurn, type ResearchAcceptanceBinding } from '../src/discovery/research-consumer-transition.js';
import { pilotContext } from '../src/discovery/pilot-context.js';
import { pilotEnvironment } from '../src/discovery/reader-pilot.js';
import { readResearchContext } from '../src/discovery/research-limits.js';

const DEFAULT_CONSOLIDATION_BODY = `research={action:'checkpoint',question:c.question.id,value:{summaries:c.consolidation.notes.map((n,i)=>({notes:[i],text:'Compact finding '+i+' keeps its condition'})),citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:['New conflict remains open']};`;

async function synthesisV2Fixture(t: test.TestContext, scriptBody: string,
  tune: { maxRequestChars?: number; timeoutMs?: number; padding?: number } = {},
  consolidationBody?: string, assessorBody?: string) {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84b-synthesis-'));
  const database = join(root, 'db.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store, 'codex');
  preparedFeatures(engine, 'p');
  const basisSource = engine.discovery.evidence.document('p', 'synthesis-basis', 'A precise basis condition', 'text/plain', 0);
  const citation = { source: reference(basisSource), selector: { kind: 'text-range' as const, start: 0, end: 24 } };
  const wire = join(root, 'wire.ndjson'), adapter = join(root, 'adapter.mjs');
  const template = `import{readFileSync,appendFileSync,existsSync,writeFileSync,rmSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify({mode:c.dispatchMode??c.role??null,page:c.synthesisPage??null,fragment:c.materialPage??null})+'\\n');
let research;
if(c.role==='assess-answer'){${ assessorBody ?? `research={verdict:'supported',reasons:[]};` }}
else if(c.dispatchMode==='consolidation'){${consolidationBody ?? DEFAULT_CONSOLIDATION_BODY}}
else{${scriptBody}}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`;
  writeFileSync(adapter, template.replaceAll('%CITE%', JSON.stringify(citation))
    .replaceAll('%ROOT%', JSON.stringify(root)));
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command,
    timeoutMs: tune.timeoutMs ?? 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxRequestChars: tune.maxRequestChars ?? 100000, maxReadChars: 60000, maxReplyChars: 10000, maxCalls: 20,
    maxReportedTokens: 100000 }, 0);
  const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
  engine.refinement.sealLayer('p', 1, 0);
  const draft = engine.refinement.begin('p', 'R1'), question = store.get<Question>(draft.value.questions[0]!)!;
  const material = readResearchContext(store, draft, question.id, pilot, reference(store.get('graph-layer:p:1')!), '/projection/title');
  const context: Record<string, any> = { ...pilotContext(store, draft, question),
    workingSelections: [{ kind: 'context', value: material }],
    ...(tune.padding ? { request: { immutableCondition: 'x'.repeat(tune.padding) } } : {}) };
  const dispatch = pilotEnvironment(environment.value, pilot.value);
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const invoke = (db: Store = store, over: Record<string, any> = {}, retryPermits?: Ref[]) => synthesisSession(db,
    db.get<any>(draft.id)!, db.get<Question>(question.id)!, db.get<any>(environment.id)!, dispatch, db.get<any>(pilot.id)!,
    { ...context, ...over }, 'Return the declared research action', undefined,
    { delivery: null, ...(retryPermits ? { retryPermits } : {}) });
  const interruptAfter = (db: Store, predicate: (writes: Write[]) => boolean, code = 'fixture_write_crash') => {
    const original = db.writeMany.bind(db); let hit = false;
    db.writeMany = ((writes: Write[], guards: any = []) => {
      const rows = original(writes, guards);
      if (!hit && predicate(writes)) { hit = true; throw new EngineError(code, 'Fixture interrupted after the durable write'); }
      return rows;
    }) as typeof db.writeMany;
    return () => { db.writeMany = original; assert.ok(hit, 'the fixture interruption fired'); };
  };
  const session = () => store.get<any>(store.list<any>('synthesis-session')[0]!.id)!;
  return { root, database, store, engine, draft, question, pilot, environment, context, dispatch, invoke, wires,
    citation, basisSource, open, interruptAfter, adapter, wire, session };
}

const ANSWER_SCRIPT = `research={action:'answer',question:c.question.id,value:{note:'Grounded answer'},citations:[%CITE%]};`;

test('1 synthesis v2 saves its exact materials and intent before the single claim, then pays once', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const result = await f.invoke();
  assert.equal(result.action, 'answer');
  const session = f.session();
  assert.ok(session.id.startsWith('synthesis-session:v2:'));
  assert.equal(session.value.contract, 'synthesis-session/v2');
  assert.equal(session.value.result!.action, 'answer');
  const intents = f.store.list<any>('research-consumer-intent');
  assert.equal(intents.length, 1);
  assert.equal(intents[0]!.value.kind, 'synthesis');
  assert.equal(intents[0]!.value.state, 'applied');
  assert.equal(intents[0]!.value.owner.id, session.id);
  const calls = f.store.list<ModelCall>('model-call');
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.id.startsWith('model-call:consumer:v1:'));
  assert.equal((calls[0]!.value as ModelCall & { consumerIntent?: Ref }).consumerIntent!.id, intents[0]!.id);
  const prepared = f.store.get<any>(intents[0]!.id, 1)!;
  assert.equal(prepared.value.state, 'prepared');
  assert.equal(prepared.value.call, null);
  assert.ok(intents[0]!.value.outputs.some((output: Ref) => output.id === session.id));
  const reopened = f.open();
  const head = readSynthesisSession(reopened, reference(reopened.get<any>(session.id)!));
  assert.equal(head.value.result!.action, 'answer');
});

test('2 an unfinished synthesis resumes the original session before any new basis is computed', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'model-response'));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const session = f.session();
  assert.equal(session.value.offset, 0);
  const calls = f.store.list('model-call').length;
  const result = await f.invoke(f.open(), { previousProposal: { action: 'answer', question: f.question.id,
    value: { note: 'A rejected earlier proposal' }, citations: [f.citation] } });
  assert.equal(result.action, 'answer');
  assert.equal(f.store.list('model-call').length, calls);
  assert.equal(f.store.list('synthesis-session').length, 1);
  assert.equal(f.session().value.result.action, 'answer');
});

test('3 several unfinished synthesis operations of one task are an addressed conflict', async t => {
  const f = await synthesisV2Fixture(t, `research={action:'pause',reason:'hold'};`);
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'synthesis-session' && write.expected === 0));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const first = f.session();
  assert.equal(first.value.result, null);
  const twin = structuredClone(first.value);
  twin.basis = { ...twin.basis, previousProposal: { action: 'answer', question: f.question.id, value: { note: 'other basis' } } };
  const twinId = `synthesis-session:v2:${hashJson([twin.binding.draft.id, { id: twin.binding.question.id, hash: twin.binding.question.hash },
    twin.binding.inputs, twin.basis.materials, twin.basis.previousProposal, twin.basis.previousProposalRef])}`;
  f.store.write({ id: twinId, kind: 'synthesis-session', expected: 0, value: twin });
  await assert.rejects(f.invoke(), { code: 'research_synthesis_ambiguous' });
});

test('4 a prepared synthesis step claims once, binding intent, request and archive in one transaction', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'research-consumer-intent' && write.expected === 0));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(intent.value.state, 'prepared');
  assert.equal(f.store.list('model-call').length, 0);
  const result = await f.invoke();
  assert.equal(result.action, 'answer');
  const calls = f.store.list<ModelCall>('model-call');
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.value.request.record && calls[0]!.value.packet?.archive);
  assert.equal((calls[0]!.value as ModelCall & { consumerIntent?: Ref }).consumerIntent!.id, intent.id);
  assert.equal((calls[0]!.value as ModelCall & { consumerIntent?: Ref }).consumerIntent!.revision, 1);
  assert.equal(f.store.get<any>(intent.id)!.value.state, 'applied');
});

test('5 an unsent synthesis step re-prepares under a compatible new environment revision and profile before one claim', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'research-consumer-intent' && write.expected === 0));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const prepared = f.store.list<any>('research-consumer-intent')[0]!;
  f.engine.environments.configure('p', { ...f.environment.value }, f.environment.revision);
  const { projectId: _projectId, ...settings } = f.pilot.value;
  configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings, maxReadChars: 59999 }, f.pilot.revision);
  const result = await f.invoke();
  assert.equal(result.action, 'answer');
  assert.equal(f.store.list('model-call').length, 1);
  const second = f.store.get<any>(prepared.id, 2)!;
  assert.equal(second.value.state, 'prepared');
  const call = f.store.list<ModelCall>('model-call')[0]!;
  assert.equal((call.value as ModelCall & { consumerIntent?: Ref }).consumerIntent!.revision, 2, 'the claim names the final prepared revision');
  assert.equal(f.store.get<any>(prepared.id)!.value.state, 'applied');
});

test('6 a prepared synthesis step whose subject grounds changed is an addressed stale, never a new send', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'research-consumer-intent' && write.expected === 0));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  const question = f.store.get<Question>(f.question.id)!;
  f.store.write({ id: question.id, kind: question.kind, expected: question.revision,
    value: { ...question.value, spec: { ...question.value.spec, prompt: 'A changed question contract' } } });
  await assert.rejects(f.invoke(), { code: 'question_stale' });
  assert.equal(f.store.list('model-call').length, 0);
  assert.equal(f.store.get<any>(intent.id)!.value.state, 'prepared');
});

test('7 a running synthesis step is held: no application, no new generation, no resend', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'model-call' && write.expected === 0));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(f.store.get<any>(intent.id)!.value.state, 'running');
  const calls = f.store.list('model-call').length;
  await assert.rejects(f.invoke(f.open()), { code: 'research_consumer_execution_running' });
  assert.equal(f.store.list('model-call').length, calls);
  assert.equal(f.store.get<any>(intent.id)!.value.state, 'running');
  assert.equal(f.session().value.offset, 0);
});

test('8 a saved paid synthesis response is proven from exact bytes and applied once, without a second call', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'model-response'));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  assert.equal(f.session().value.offset, 0);
  const calls = f.store.list('model-call').length;
  const result = await f.invoke(f.open());
  assert.equal(result.action, 'answer');
  assert.equal(f.store.list('model-call').length, calls);
  assert.equal(f.session().value.result.action, 'answer');
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(readResearchConsumerIntent(f.store, reference(f.store.get<any>(intent.id)!)).value.state, 'applied');
});

test('9 a paid synthesis response applies under a compatible new environment revision, keeping historical refs', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'model-response'));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  f.engine.environments.configure('p', { ...f.environment.value }, f.environment.revision);
  const result = await f.invoke(f.open());
  assert.equal(result.action, 'answer');
  assert.equal(f.store.list('model-call').length, 1);
  assert.deepEqual(f.store.get<any>(intent.id)!.value.dispatch, intent.value.dispatch,
    'the dispatch basis is immutable once the step is paid');
});

test('10 a paid response whose current admission was lost keeps P readable and refuses application', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  writeFileSync(join(f.root, 'notes.txt'), 'Original scoped condition\n');
  const source = f.engine.discovery.evidence.file('p', 'synthesis-file', f.root, 'notes.txt', 'text/plain', 0);
  const observation = f.engine.discovery.evidence.observe('p', reference(source),
    { kind: 'text-range', start: 0, end: source.value.content.length });
  const invoke = (db: Store = f.store) => synthesisSession(db, db.get<any>(f.draft.id)!, db.get<Question>(f.question.id)!,
    db.get<any>(f.environment.id)!, f.dispatch, db.get<any>(f.pilot.id)!,
    { ...f.context, workingSelections: [{ kind: 'context', value: observation }] },
    'Return the declared research action', undefined, { delivery: null });
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'model-response'));
  await assert.rejects(invoke(), { code: 'fixture_write_crash' });
  restore();
  writeFileSync(join(f.root, 'notes.txt'), 'Changed after the paid response\n');
  await assert.rejects(invoke(f.open()), { code: 'synthesis_evidence_stale' });
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(f.store.get<any>(intent.id)!.value.state, 'running');
  assert.equal(f.session().value.result, null);
  assert.equal(f.store.list('model-call').length, 1);
  const call = f.store.get<ModelCall>(intent.value.call.id)!;
  assert.ok(call.value.response?.record && f.store.get(call.value.response.record.id));
});

test('11 a received invalid synthesis payload is a saved unresumable refusal that repeats as itself', async t => {
  const f = await synthesisV2Fixture(t, `research={action:'nonsense'};`);
  await assert.rejects(f.invoke(), { code: 'research_response_invalid' });
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  const refused = readResearchConsumerIntent(f.store, reference(f.store.get<any>(intent.id)!));
  assert.equal(refused.value.state, 'refused');
  assert.equal(refused.value.refusal?.kind, 'consumer-invalid');
  assert.equal(refused.value.refusal?.code, 'research_response_invalid');
  assert.equal(f.store.list('model-call').length, 1);
  await assert.rejects(f.invoke(f.open()), { code: 'research_response_invalid' });
  assert.equal(f.store.list('model-call').length, 1);
  assert.equal(f.store.list('research-consumer-intent').length, 1);
});

test('12 a proved empty provider failure is saved refused; the next external entry permits exactly one new generation', async t => {
  const f = await synthesisV2Fixture(t, `if(existsSync('fail-once')){rmSync('fail-once');process.exit(1);}else ` + ANSWER_SCRIPT);
  writeFileSync(join(f.root, 'fail-once'), 'once');
  // The adapter path is relative to the workspace root used at dispatch.
  await assert.rejects(f.invoke(), { code: 'research_provider_failed' });
  const refused = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(readResearchConsumerIntent(f.store, reference(refused)).value.refusal?.kind, 'provider-failed');
  assert.equal(f.store.list('model-call').length, 1);
  // The unmeasured failed attempt needs its explicit reserve before the next entry.
  const failed = f.store.list<ModelCall>('model-call')
    .find(call => call.value.status === 'failed' && call.value.usage === null)!;
  const { projectId: _projectId, ...settings } = f.pilot.value;
  configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
    unknownReserves: [{ call: reference(failed), tokens: 100 }] }, f.pilot.revision);
  const result = await f.invoke(f.open());
  assert.equal(result.action, 'answer');
  assert.equal(f.store.list('model-call').length, 2);
  const intents = f.store.list<any>('research-consumer-intent')
    .sort((a, b) => a.value.generation - b.value.generation);
  assert.deepEqual(intents.map(row => [row.value.generation, row.value.state]), [[0, 'refused'], [1, 'applied']]);
  assert.deepEqual(intents[1]!.value.previous, reference(intents[0]!));
});

test('13 a refusal born inside one entry is saved and returned; the internal loop never issues itself a permit', async t => {
  const f = await synthesisV2Fixture(t, `process.exit(1);`);
  await assert.rejects(f.invoke(), { code: 'research_provider_failed' });
  assert.equal(f.store.list('model-call').length, 1);
  assert.equal(f.store.list('research-consumer-intent').length, 1);
  await assert.rejects(f.invoke(f.open(), {}, []), { code: 'research_consumer_execution_refused' });
  assert.equal(f.store.list('model-call').length, 1);
  assert.equal(f.store.list('research-consumer-intent').length, 1);
});

test('14 a nonzero exit with nonempty bytes is a terminal refusal, never the empty-failure row', async t => {
  const f = await synthesisV2Fixture(t, `console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'x'},usage:null}));process.exit(1);`);
  await assert.rejects(f.invoke(), { code: 'research_provider_failed' });
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(readResearchConsumerIntent(f.store, reference(intent)).value.refusal?.kind, 'terminal');
  await assert.rejects(f.invoke(f.open()), { code: 'research_consumer_execution_refused' });
  assert.equal(f.store.list('model-call').length, 1);
  assert.equal(f.store.list('research-consumer-intent').length, 1);
});

test('15 a timeout is its own technical outcome, not the empty provider failure', async t => {
  const f = await synthesisV2Fixture(t, `await new Promise(resolve=>setTimeout(resolve,10000));`, { timeoutMs: 1000 });
  await assert.rejects(f.invoke(), { code: 'process_timeout' });
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(readResearchConsumerIntent(f.store, reference(intent)).value.refusal?.kind, 'terminal');
  assert.equal(readResearchConsumerIntent(f.store, reference(intent)).value.refusal?.code, 'process_timeout');
  await assert.rejects(f.invoke(f.open()), { code: 'research_consumer_execution_refused' });
  assert.equal(f.store.list('model-call').length, 1);
});

test('16 a process_lost synthesis keeps its exact late receipt without automatic application or a new generation', { skip: process.platform === 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-d84b-late-'));
  const database = join(root, 'db.sqlite'), wire = join(root, 'wire.ndjson');
  const adapter = join(root, 'adapter.mjs'), driver = join(root, 'driver.mjs');
  const input = join(root, 'input.json'), late = join(root, 'late.json');
  const stores: Store[] = [], open = () => { const db = new Store(database); stores.push(db); return db; };
  let child: ChildProcess | null = null;
  t.after(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const db of stores) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const store = open(), engine = new ProductEngine(store, 'codex');
  preparedFeatures(engine, 'p');
  const basisSource = engine.discovery.evidence.document('p', 'synthesis-basis', 'A precise basis condition', 'text/plain', 0);
  const citation = { source: reference(basisSource), selector: { kind: 'text-range' as const, start: 0, end: 24 } };
  writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify({mode:c.dispatchMode??null})+'\\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'answer',question:c.question.id,value:{note:'Late bytes'},citations:[${JSON.stringify(citation)}]},usage:{inputTokens:4,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true,
    stopAfter: 'L2', reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command },
    agentCommand: command, maxCalls: 10, maxReportedTokens: 100000, maxRequestChars: 30000,
    maxReadChars: 20000, maxReplyChars: 5000 }, 0);
  const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
  engine.refinement.sealLayer('p', 1, 0);
  const draft = engine.refinement.begin('p', 'R1'), question = store.get<Question>(draft.value.questions[0]!)!;
  const material = readResearchContext(store, draft, question.id, pilot, reference(store.get('graph-layer:p:1')!), '/projection/title');
  const context = { ...pilotContext(store, draft, question), workingSelections: [{ kind: 'context', value: material }] };
  const dispatch = pilotEnvironment(environment.value, pilot.value);
  writeFileSync(input, JSON.stringify({ database, environmentId: environment.id, pilotId: pilot.id,
    draftId: draft.id, questionId: question.id, dispatch, context, late }));
  writeFileSync(driver, `import{readFileSync,writeFileSync}from'node:fs';
import{Store}from${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import{synthesisSession}from${JSON.stringify(new URL('../src/discovery/synthesis-session.js', import.meta.url).href)};
const spec=JSON.parse(readFileSync(process.argv[2],'utf8')),store=new Store(spec.database);
const original=store.writeMany.bind(store);
store.writeMany=(writes,guards=[])=>{const receipt=writes.find(w=>w.kind==='model-response'&&w.value.consumerExecution);
if(receipt){writeFileSync(spec.late,JSON.stringify({process:{...receipt.value.consumerExecution.process,stdout:receipt.value.text},launchError:null}));
process.exit(73)}return original(writes,guards)};
try{const draft=store.get(spec.draftId),question=store.get(spec.questionId),environment=store.get(spec.environmentId),pilot=store.get(spec.pilotId);
await synthesisSession(store,draft,question,environment,spec.dispatch,pilot,spec.context,'Return the declared research action',undefined,{delivery:null});
throw Error('The physical response was not intercepted')}
catch(error){console.error(error?.stack??String(error));process.exitCode=72}
finally{store.close()}`);
  child = spawn(process.execPath, [driver, input], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', buffer => { stderr += buffer.toString(); });
  child.stdout!.resume();
  const exit = await new Promise<number | null>((resolve, reject) => {
    child!.once('error', reject); child!.once('close', resolve);
  });
  assert.equal(exit, 73, stderr);
  const dispatched = store.list<ModelCall>('model-call')[0]!;
  assert.equal(dispatched.value.status, 'running');
  const evidence = JSON.parse(readFileSync(late, 'utf8')) as LateModelReceipt['evidence'];
  const invoke = (db: Store) => synthesisSession(db, db.get<any>(draft.id)!, db.get<Question>(question.id)!,
    db.get<any>(environment.id)!, dispatch, db.get<any>(pilot.id)!, context,
    'Return the declared research action', undefined, { delivery: null });
  const reopened = open();
  await assert.rejects(invoke(reopened), { code: 'research_consumer_execution_refused' });
  const recovered = reopened.get<ModelCall>(dispatched.id)!;
  assert.equal(recovered.value.error, 'process_lost');
  const proof = readModelCallRecovery(reopened, 'p', reference(recovered));
  assert.deepEqual(reference(proof.original), reference(dispatched));
  const prepared = prepareLateModelReceipt(reopened, 'p', reference(dispatched), evidence);
  const receipt = reopened.writeMany<LateModelReceipt>(prepared.writes, prepared.guards)[0]!;
  assert.deepEqual(readLateModelReceipt(reopened, 'p', reference(recovered)), receipt);
  const before = { sessions: reopened.list('synthesis-session'), intents: reopened.list('research-consumer-intent') };
  for (let index = 0; index < 2; index++) {
    const db = open();
    await assert.rejects(invoke(db), { code: 'research_consumer_execution_refused' });
    assert.deepEqual(db.list('synthesis-session').map(record => [record.id, record.revision]),
      before.sessions.map(record => [record.id, record.revision]));
    assert.deepEqual(db.list('research-consumer-intent'), before.intents);
    assert.equal(db.list('model-call').length, 1);
  }
  assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 1);
});

async function pagedSynthesisFixture(t: test.TestContext) {
  const f = await synthesisV2Fixture(t, `research=c.synthesisPage.complete?{action:'answer',question:c.question.id,value:{note:'Complete grounded answer'},citations:[%CITE%]}:{action:'checkpoint',question:c.question.id,value:{note:'Partial page findings'},citations:[%CITE%],unresolved:['The remaining pages must be read']};`,
    { maxRequestChars: 100000 });
  return f;
}

test('17 applied history is proven per exact transition; a late unlinked revision is an integrity refusal', async t => {
  const f = await synthesisV2Fixture(t, `research={action:'answer',question:c.question.id,value:{note:'Grounded answer'},citations:[%CITE%]};`);
  writeFileSync(join(f.root, 'big.txt'), 'Scoped condition\n' + 'filler\n'.repeat(4000));
  const big = f.engine.discovery.evidence.file('p', 'big', f.root, 'big.txt', 'text/plain', 0);
  const bigObservation = f.engine.discovery.evidence.observe('p', reference(big),
    { kind: 'text-range', start: 0, end: big.value.content.length });
  // Two materials, tight packet: one material per page, two paid steps.
  const tight = configureReaderPilot(f.store, f.engine.environments, 'p', { ...((({ projectId: _p, ...rest }) => rest)(f.pilot.value)),
    maxRequestChars: 30000 }, f.pilot.revision);
  const invokeTight = (db: Store = f.store) => synthesisSession(db, db.get<any>(f.draft.id)!, db.get<Question>(f.question.id)!,
    db.get<any>(f.environment.id)!, pilotEnvironment(f.environment.value, tight.value), db.get<any>(tight.id)!,
    { ...f.context, workingSelections: [{ kind: 'context', value: f.context.workingSelections[0]!.value },
      { kind: 'context', value: bigObservation }] },
    'Return the declared research action', undefined, { delivery: null });
  const result = await invokeTight();
  assert.equal(result.action, 'answer');
  const session = f.session();
  assert.ok(session.revision >= 3, 'initial + page + result revisions');
  for (let revision = 1; revision <= session.revision; revision++)
    readSynthesisSession(f.store, reference(f.store.get<any>(session.id, revision)!));
  const calls = f.store.list('model-call').length;
  assert.deepEqual(await invokeTight(f.open()), result, 'an exact repeat returns the saved result without payment');
  assert.equal(f.store.list('model-call').length, calls);
  // A late revision without a lawful transition is an integrity refusal (№1499-45).
  const unlinked = f.store.write({ id: session.id, kind: 'synthesis-session', expected: f.session().revision,
    value: { ...f.session().value, offset: 0 } });
  assert.throws(() => readSynthesisSession(f.store, reference(unlinked)), { code: 'synthesis_session_invalid' });
  readSynthesisSession(f.store, reference(f.store.get<any>(session.id, session.revision)!),
    );
});

test('18 a partial page writes its checkpoint, note, cursors, workspace and applied intent in one transaction', async t => {
  const f = await pagedSynthesisFixture(t);
  writeFileSync(join(f.root, 'big.txt'), 'Scoped condition\n' + 'filler\n'.repeat(4000));
  const big = f.engine.discovery.evidence.file('p', 'big', f.root, 'big.txt', 'text/plain', 0);
  const bigObservation = f.engine.discovery.evidence.observe('p', reference(big),
    { kind: 'text-range', start: 0, end: big.value.content.length });
  const materials = [{ kind: 'context', value: f.context.workingSelections[0]!.value },
    { kind: 'context', value: bigObservation }];
  const { projectId: _p, ...settings } = f.pilot.value;
  const tight = configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings, maxRequestChars: 30000 }, f.pilot.revision);
  const tightDispatch = pilotEnvironment(f.environment.value, tight.value);
  const invoke = (db: Store = f.store) => synthesisSession(db, db.get<any>(f.draft.id)!, db.get<Question>(f.question.id)!,
    db.get<any>(f.environment.id)!, tightDispatch, db.get<any>(tight.id)!,
    { ...f.context, workingSelections: materials }, 'Return the declared research action', undefined, { delivery: null });
  // Interrupted before the commit: no checkpoint record and no cursor move can exist.
  const original = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes: Write[], guards: any = []) => {
    if (writes.some(write => write.kind === 'research-checkpoint'))
      throw new EngineError('fixture_before_commit', 'The application transaction was lost');
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(invoke(), { code: 'fixture_before_commit' });
  f.store.writeMany = original;
  assert.equal(f.store.list('research-checkpoint').length, 0, 'no partial checkpoint commit');
  assert.equal(f.session().value.offset, 0, 'no partial cursor commit');
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(f.store.get<any>(intent.id)!.value.state, 'running');
  const calls = f.store.list('model-call').length;
  const result = await invoke(f.open());
  assert.equal(result.action, 'answer');
  const pageSends = f.wires().filter(line => line.page)
    .map(line => `${line.page.offset}:${line.page.end}:${line.fragment?.offset ?? 0}:${line.fragment?.end ?? 0}`);
  assert.equal(new Set(pageSends).size, pageSends.length, 'no paid page or fragment is ever repeated');
  assert.ok(f.store.list('model-call').length > calls, 'the remaining pages are paid exactly once each');
  const checkpoints = f.store.list<any>('research-checkpoint');
  assert.ok(checkpoints.length >= 1, 'each page checkpoint is saved once');
  assert.ok(checkpoints.every(checkpoint => checkpoint.value.status === 'unassessed'));
  assert.equal(f.session().value.notes.filter((note: any) => !note.consolidated).length, pageSends.length - 1,
    'each delivered nonfinal page saved its own exact note');
  for (const note of f.session().value.notes) {
    const saved = f.store.get<any>(note.checkpoint.id, note.checkpoint.revision);
    assert.ok(saved, 'each note retains its exact checkpoint revision');
    assert.deepEqual(reference(saved), note.checkpoint);
    assert.equal(saved.value.status, 'unassessed');
  }
  const checkpoint = checkpoints[0]!;
  assert.equal(readResearchConsumerIntent(f.store, reference(f.store.get<any>(intent.id)!)).value.state, 'applied');
  assert.ok(f.store.get<any>(intent.id)!.value.outputs.some((output: Ref) => output.id === checkpoint.id));
});

test('19 a material fragment advances materialOffset by delivered bytes and the offset only when the fragment completes', async t => {
  const f = await synthesisV2Fixture(t, `research=c.synthesisPage.complete?{action:'answer',question:c.question.id,value:{note:'Complete'},citations:[%CITE%]}:{action:'checkpoint',question:c.question.id,value:{note:'Partial fragment findings'},citations:[%CITE%],unresolved:['More of this fragment remains']};`);
  writeFileSync(join(f.root, 'huge.txt'), 'Scoped condition '.repeat(4000));
  const huge = f.engine.discovery.evidence.file('p', 'huge', f.root, 'huge.txt', 'text/plain', 0);
  const hugeObservation = f.engine.discovery.evidence.observe('p', reference(huge),
    { kind: 'text-range', start: 0, end: huge.value.content.length });
  const { projectId: _p, ...settings } = f.pilot.value;
  const tight = configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings, maxRequestChars: 40000 }, f.pilot.revision);
  const dispatch = pilotEnvironment(f.environment.value, tight.value);
  const invoke = (db: Store = f.store) => synthesisSession(db, db.get<any>(f.draft.id)!, db.get<Question>(f.question.id)!,
    db.get<any>(f.environment.id)!, dispatch, db.get<any>(tight.id)!,
    { ...f.context, workingSelections: [{ kind: 'context', value: hugeObservation }] },
    'Return the declared research action', undefined, { delivery: null });
  const original = f.store.writeMany.bind(f.store);
  const states: { offset: number; materialOffset: number }[] = [];
  f.store.writeMany = ((writes: Write[], guards: any = []) => {
    const rows = original(writes, guards);
    const sessionWrite = writes.find(write => write.kind === 'synthesis-session' && write.expected > 0);
    if (sessionWrite) {
      const value = sessionWrite.value as { offset: number; materialOffset?: number; notes?: unknown[] };
      if ((value.notes?.length ?? 0) > states.length)
        states.push({ offset: value.offset, materialOffset: value.materialOffset ?? 0 });
    }
    return rows;
  }) as typeof f.store.writeMany;
  const result = await invoke();
  f.store.writeMany = original;
  assert.equal(result.action, 'answer');
  const wire = f.wires();
  const fragmentPages = wire.filter(line => line.fragment);
  assert.ok(fragmentPages.length >= 1, 'the big material was delivered in fragments');
  assert.equal(fragmentPages[0].fragment.encoding, 'json-string-fragment');
  if (states.length > 1) {
    assert.equal(states[0]!.offset, 0, 'the logical offset stays while a fragment is mid-way');
    assert.ok(states[0]!.materialOffset > 0, 'materialOffset advances by delivered bytes');
  }
  const session = f.session();
  assert.equal(session.value.offset, 1);
  assert.equal(session.value.materialOffset ?? 0, 0, 'offset advances only after the fragment completes');
  const intents = f.store.list<any>('research-consumer-intent');
  assert.ok(intents.every(intent => canonical(JSON.parse(intent.value.cursor.materialEncoding)) === canonical(hugeObservation)),
    'the fragment encoding is pinned before any payment');
});


test('20 a checkpoint without cursor movement is lawful progress only through newly delivered context', async t => {
  const f = await synthesisV2Fixture(t, `
const notes=(c.conclusions??c.synthesisNotes??[]).length,ws=(c.contextWorkspace??[]).length;
if(notes===0)research={action:'checkpoint',question:c.question.id,value:{note:'First page findings'},citations:[%CITE%],unresolved:['More remains']};
else if(ws===0)research={action:'read_context',record:%GRAPH%,pointer:'/projection/title',purpose:'Read the exact accepted title for the open question'};
else if(notes===1)research={action:'checkpoint',question:c.question.id,value:{note:'Findings grounded by the delivered original'},citations:[%CITE%],unresolved:['More remains']};
else research={action:'answer',question:c.question.id,value:{note:'Complete grounded answer'},citations:[%CITE%]};`);
  const graphRef = reference(f.store.get<any>('graph-layer:p:1')!);
  writeFileSync(f.adapter, readFileSync(f.adapter, 'utf8').replaceAll('%GRAPH%', JSON.stringify(graphRef)));
  const result = await f.invoke();
  assert.equal(result.action, 'answer');
  const session = f.session();
  assert.equal(session.value.offset, 1, 'the material page moved exactly once');
  assert.equal(session.value.notes.length, 2);
  assert.equal(session.value.workspace.entries.length, 1);
  assert.equal(session.value.workspace.entries[0].result.value, 'p');
  const intents = f.store.list<any>('research-consumer-intent');
  assert.equal(intents.length, 4, 'page checkpoint, lookup, context-only checkpoint and the final answer');
  assert.ok(intents.every(intent => intent.value.state === 'applied'));
  assert.equal(f.store.list('model-call').length, 4);
  readSynthesisSession(f.open(), reference(f.open().get<any>(session.id)!));
});

test('21 a checkpoint without progress and an early need_research are saved addressed refusals without repaying the answer', async t => {
  const f = await synthesisV2Fixture(t, `
const notes=(c.conclusions??c.synthesisNotes??[]).length;
research={action:'checkpoint',question:c.question.id,value:{note:notes?'Repeated findings without new ground':'First page findings'},citations:[%CITE%],unresolved:['More remains']};`);
  await assert.rejects(f.invoke(), { code: 'synthesis_no_progress' });
  const intents = f.store.list<any>('research-consumer-intent');
  assert.equal(intents.length, 2);
  const refused = intents.find(intent => intent.value.state === 'refused')!;
  assert.equal(refused.value.refusal.code, 'synthesis_no_progress');
  assert.equal(refused.value.refusal.kind, 'consumer-invalid');
  const calls = f.store.list('model-call').length;
  await assert.rejects(f.invoke(f.open()), { code: 'synthesis_no_progress' });
  assert.equal(f.store.list('model-call').length, calls, 'the saved refusal is returned without repaying');
  const g = await synthesisV2Fixture(t, `
research=c.synthesisPage.complete?{action:'answer',question:c.question.id,value:{note:'Complete'},citations:[%CITE%]}:{action:'need_research',question:c.question.id,missing:['A missing primary source']};`);
  writeFileSync(join(g.root, 'big.txt'), 'Scoped condition\n' + 'filler\n'.repeat(4000));
  const big = g.engine.discovery.evidence.file('p', 'big', g.root, 'big.txt', 'text/plain', 0);
  const bigObservation = g.engine.discovery.evidence.observe('p', reference(big),
    { kind: 'text-range', start: 0, end: big.value.content.length });
  const { projectId: _p, ...settings } = g.pilot.value;
  const tight = configureReaderPilot(g.store, g.engine.environments, 'p', { ...settings, maxRequestChars: 30000 }, g.pilot.revision);
  const invoke = (db: Store = g.store) => synthesisSession(db, db.get<any>(g.draft.id)!, db.get<Question>(g.question.id)!,
    db.get<any>(g.environment.id)!, pilotEnvironment(g.environment.value, tight.value), db.get<any>(tight.id)!,
    { ...g.context, workingSelections: [{ kind: 'context', value: g.context.workingSelections[0]!.value },
      { kind: 'context', value: bigObservation }] },
    'Return the declared research action', undefined, { delivery: null });
  await assert.rejects(invoke(), { code: 'synthesis_checkpoint_required' });
  const intent = g.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(g.store.get<any>(intent.id)!.value.refusal?.code, 'synthesis_checkpoint_required');
  assert.equal(g.store.list('model-call').length, 1);
  await assert.rejects(invoke(g.open()), { code: 'synthesis_checkpoint_required' });
  assert.equal(g.store.list('model-call').length, 1);
});

test('22 a complete-page answer writes the session result and the applied intent in one transaction and returns the exact action', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const original = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes: Write[], guards: any = []) => {
    if (writes.some(write => write.kind === 'synthesis-session' && (write.value as any).result))
      throw new EngineError('fixture_before_result_commit', 'The result transaction was lost');
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.invoke(), { code: 'fixture_before_result_commit' });
  f.store.writeMany = original;
  assert.equal(f.session().value.result, null, 'no partial result commit');
  assert.equal(f.store.get<any>(f.store.list<any>('research-consumer-intent')[0]!.id)!.value.state, 'running');
  const calls = f.store.list('model-call').length;
  const result = await f.invoke(f.open());
  assert.equal(result.action, 'answer');
  assert.deepEqual(result.value, { note: 'Grounded answer' });
  assert.equal(f.store.list('model-call').length, calls);
  const session = f.session();
  assert.equal(session.value.result!.action, 'answer');
  const intent = f.store.get<any>(f.store.list<any>('research-consumer-intent')[0]!.id)!;
  assert.equal(intent.value.state, 'applied');
  assert.ok(intent.value.outputs.some((output: Ref) => output.id === session.id
    && output.revision === session.revision));
});

test('23 savedOnly turns a complete-page need_research into a saved research_saved_only refusal without a new send', async t => {
  const f = await synthesisV2Fixture(t, `research={action:'need_research',question:c.question.id,missing:['A missing primary source']};`);
  await assert.rejects(f.invoke(f.store, { savedOnly: true }), { code: 'research_saved_only' });
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(f.store.get<any>(intent.id)!.value.refusal?.code, 'research_saved_only');
  assert.equal(f.store.list('model-call').length, 1);
  await assert.rejects(f.invoke(f.open(), { savedOnly: true }), { code: 'research_saved_only' });
  assert.equal(f.store.list('model-call').length, 1);
  const g = await synthesisV2Fixture(t, `research={action:'need_research',question:c.question.id,missing:['A missing primary source']};`);
  const plain = await g.invoke();
  assert.equal(plain.action, 'need_research', 'the same payload is lawful without the savedOnly contract');
  assert.equal(g.store.get<any>(g.store.list<any>('research-consumer-intent')[0]!.id)!.value.state, 'applied');
});

test('24 a session without materials takes the lawful final stage, never a fabricated page', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const result = await f.invoke(f.store, { workingSelections: [] });
  assert.equal(result.action, 'answer');
  const wire = f.wires();
  assert.equal(wire.length, 1);
  assert.equal(wire[0].page.total, 0);
  assert.equal(wire[0].page.complete, true);
  assert.ok(!wire[0].fragment, 'no fabricated material page');
  assert.equal(f.store.list('model-call').length, 1);
});

test('25 a pause is saved once as its own step outcome: the cursor stays and it is never a cached final answer', async t => {
  const f = await synthesisV2Fixture(t, `
if(existsSync(%ROOT%+'/paused-once'))research={action:'answer',question:c.question.id,value:{note:'Grounded after the pause'},citations:[%CITE%]};
else{writeFileSync(%ROOT%+'/paused-once','1');research={action:'pause',reason:'Explicit pause before continuing'};}`);
  const first = await f.invoke();
  assert.equal(first.action, 'pause');
  const session = f.session();
  assert.equal(session.value.result, null, 'a pause is not a cached final answer');
  assert.equal(session.value.pause.action, 'pause');
  assert.equal(session.value.offset, 0, 'a pause never moves the material cursor');
  const intents = f.store.list<any>('research-consumer-intent');
  assert.equal(intents.length, 1);
  assert.equal(intents[0]!.value.state, 'applied', 'the pause step is a saved applied outcome');
  assert.equal(f.store.list('model-call').length, 1);
  const second = await f.invoke(f.open());
  assert.equal(second.action, 'answer');
  assert.equal(f.store.list('model-call').length, 2);
  const all = f.store.list<any>('research-consumer-intent')
    .sort((a, b) => a.value.owner.revision - b.value.owner.revision);
  assert.equal(all.length, 2);
  assert.notEqual(all[0]!.id, all[1]!.id, 'the next step is another L, not a retry of the paused P');
  assert.equal(all[1]!.value.generation, 0);
  assert.equal(all[1]!.value.cursor.offset, all[0]!.value.cursor.offset, 'the next step keeps the saved cursor');
});

test('26 a delivered pause lets the next explicit run open the next step; the saved pause is not reissued', async t => {
  const f = await synthesisV2Fixture(t, `
if(c.dispatchMode==='planning')research={action:'synthesize',question:c.question.id};
else if(existsSync(%ROOT%+'/paused-once'))research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'A scoped local product',facts:[],designs:[{id:'d',decision:'Apply the defined scope',benefit:'Safe local output',consumer:'compilation'}],gaps:[]},citations:[%CITE%]};
else{writeFileSync(%ROOT%+'/paused-once','1');research={action:'pause',reason:'Hold the run'};}`);
  // Keep the run focused on the synthesis question: settle the siblings as owner decisions.
  const siblingValue = { applicability: 'applicable', reason: 'Settled by the owner', facts: [],
    designs: [{ id: 'sibling-design', decision: 'A settled sibling', benefit: 'Focus', consumer: 'compilation' }], gaps: [] };
  for (const id of f.draft.value.questions.slice(1)) {
    const sibling = f.store.get<Question>(id)!;
    f.engine.discovery.decision(sibling.id, sibling.revision, 'owner', siblingValue);
  }
  const { projectId: _p, ...settings } = f.pilot.value;
  configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
    planning: { fields: [f.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, f.pilot.revision);
  const run1 = await f.engine.researcher.run('p', f.draft.id, 4);
  assert.equal(run1.value.status, 'paused');
  const pauseTurn = f.store.list<ResearchTurn>('research-turn')
    .find(turn => (turn.value.action as any).action === 'pause')!;
  assert.equal(pauseTurn.value.status, 'completed');
  const session = f.session();
  assert.ok(session.value.delivered, 'the pause delivery is marked once');
  assert.equal(session.value.pause.action, 'pause');
  assert.equal(session.value.result, null);
  const pausePosition = pauseTurn.value.number;
  const wireBefore = f.wires().length;
  const run2 = await f.engine.researcher.run('p', f.draft.id, 6);
  assert.equal(run2.value.status, 'completed');
  assert.equal(f.store.get<Question>(f.question.id)!.value.status, 'answered');
  const synthesisCalls = f.wires().filter(line => line.mode === 'synthesis').length;
  assert.equal(synthesisCalls, 2, 'the pause step and exactly one new paid step');
  assert.equal(f.wires().length, wireBefore + 2, 'the resumed answer and its assessor');
  const pauseTurns = f.store.list<ResearchTurn>('research-turn')
    .filter(turn => (turn.value.action as any).action === 'pause');
  assert.equal(pauseTurns.length, 1, 'the saved pause is never reissued to a new position');
  assert.ok(f.store.list<ResearchTurn>('research-turn')
    .every(turn => turn.value.number !== pausePosition || turn.id === pauseTurn.id));
  assert.equal(f.session().value.result.action, 'answer');
});

test('27 a lawful read_context writes the workspace and counters in the same atomic transition', async t => {
  const f = await synthesisV2Fixture(t, `
if(!(c.contextWorkspace??[]).length)research={action:'read_context',record:%GRAPH%,pointer:'/projection/title',purpose:'Read the exact accepted title'};
else research={action:'answer',question:c.question.id,value:{note:'Grounded by the delivered original'},citations:[%CITE%]};`);
  const graphRef = reference(f.store.get<any>('graph-layer:p:1')!);
  writeFileSync(f.adapter, readFileSync(f.adapter, 'utf8').replaceAll('%GRAPH%', JSON.stringify(graphRef)));
  const original = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes: Write[], guards: any = []) => {
    if (writes.some(write => write.kind === 'synthesis-session'
      && Array.isArray((write.value as any).workspace?.entries) && (write.value as any).workspace.entries.length > 0))
      throw new EngineError('fixture_lookup_commit_lost', 'The lookup application was lost');
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.invoke(), { code: 'fixture_lookup_commit_lost' });
  f.store.writeMany = original;
  assert.equal(f.session().value.workspace ?? null, null, 'no partial workspace commit');
  const calls = f.store.list('model-call').length;
  const result = await f.invoke(f.open());
  assert.equal(result.action, 'answer');
  assert.equal(f.store.list('model-call').length, calls + 1, 'only the interrupted step is repeated, never repaid');
  const session = f.session();
  assert.equal(session.value.workspace.entries.length, 1);
  assert.equal(session.value.workspace.entries[0].result.value, 'p');
  const intents = f.store.list<any>('research-consumer-intent');
  assert.equal(intents.length, 2);
  assert.ok(intents.every(intent => intent.value.state === 'applied'));
  readSynthesisSession(f.open(), reference(f.open().get<any>(session.id)!));
});

test('28 a lawful refused lookup saves the blocked workspace and the intent outcome as one set', async t => {
  const f = await synthesisV2Fixture(t, `research={action:'read_context',record:%GRAPH%,pointer:'/projection/not-there',purpose:'A missing pointer'};`);
  const graphRef = reference(f.store.get<any>('graph-layer:p:1')!);
  writeFileSync(f.adapter, readFileSync(f.adapter, 'utf8').replaceAll('%GRAPH%', JSON.stringify(graphRef)));
  await assert.rejects(f.invoke(), { code: 'research_no_progress' });
  const session = f.session();
  assert.ok(session.value.workspace.blocked, 'the blocked workspace is saved');
  assert.equal(session.value.blockedCode, 'context_missing');
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(f.store.get<any>(intent.id)!.value.state, 'applied', 'the paid lookup was consumed lawfully');
  const calls = f.store.list('model-call').length;
  await assert.rejects(f.invoke(f.open()), { code: 'research_no_progress' });
  assert.equal(f.store.list('model-call').length, calls, 'a repeat needs neither a successful lookup nor a new payment');
});

test('29 a lookup naming a foreign exact reference is an integrity refusal, not a manufactured block', async t => {
  const f = await synthesisV2Fixture(t, `research={action:'read_context',record:%FORGED%,pointer:'/projection/title',purpose:'Read the exact title'};`);
  const graphRef = reference(f.store.get<any>('graph-layer:p:1')!);
  const forged = { ...graphRef, hash: '0'.repeat(64) };
  writeFileSync(f.adapter, readFileSync(f.adapter, 'utf8').replaceAll('%FORGED%', JSON.stringify(forged)));
  await assert.rejects(f.invoke(), { code: 'context_lookup_integrity' });
  const session = f.session();
  assert.equal(session.value.workspace?.blocked ?? null, null, 'no manufactured blocked outcome');
  assert.equal(session.value.blockedCode ?? null, null);
  assert.equal(session.value.result, null);
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(f.store.get<any>(intent.id)!.value.state, 'running', 'the paid step is preserved, not concluded');
  assert.equal(f.store.list('model-call').length, 1);
  await assert.rejects(f.invoke(f.open()), { code: 'context_lookup_integrity' });
  assert.equal(f.store.list('model-call').length, 1);
});

test('30 a saved checkpoint of the same draft survives a sibling draft revision; a subject change is a stale door', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const checkpointCall = await f.invoke;
  void checkpointCall;
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'model-response'));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const draft = f.store.get<any>(f.draft.id)!;
  f.store.write({ id: draft.id, kind: draft.kind, expected: draft.revision,
    value: { ...draft.value, fields: { ...draft.value.fields, unrelatedSibling: 'a parallel note' } } });
  const result = await f.invoke(f.open());
  assert.equal(result.action, 'answer', 'a proven sibling revision does not cancel the paid step');
  assert.equal(f.store.list('model-call').length, 1);
  const g = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restoreG = g.interruptAfter(g.store, writes => writes.some(write => write.kind === 'model-response'));
  await assert.rejects(g.invoke(), { code: 'fixture_write_crash' });
  restoreG();
  const gDraft = g.store.get<any>(g.draft.id)!;
  g.store.write({ id: gDraft.id, kind: gDraft.kind, expected: gDraft.revision,
    value: { ...gDraft.value, fields: { ...gDraft.value.fields, [g.question.value.spec.field]: 'changed task' } } });
  await assert.rejects(g.invoke(g.open()), { code: 'reader_draft_stale' });
  const intent = g.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(g.store.get<any>(intent.id)!.value.state, 'running');
  assert.equal(g.store.list('model-call').length, 1);
});

/** Consolidation driver: one big first note, then capacity forces compaction. */
async function consolidationV2Fixture(t: test.TestContext, consolidationBody?: string,
  tune: { maxRequestChars?: number; padding?: number } = {}) {
  const f = await synthesisV2Fixture(t, `
if(c.synthesisPage.complete&&(c.conclusions??[]).length===0){
research={action:'checkpoint',question:c.question.id,value:{note:''},citations:[%CITE%],unresolved:['Keep the exception open']};
const allowance=c.resultCapacity.forms.find(f=>f.kind==='checkpoint').maxResultChars;
research.value.note='F'.repeat(Math.max(0,Math.min(20000,allowance-JSON.stringify(research).length)));
}
else research={action:'answer',question:c.question.id,value:{note:'Complete grounded answer'},citations:[%CITE%]};`,
    { maxRequestChars: tune.maxRequestChars ?? 30000, ...(tune.padding !== undefined ? { padding: tune.padding } : {}) }, consolidationBody);
  writeFileSync(join(f.root, 'big.txt'), 'Scoped condition\n' + 'filler\n'.repeat(200));
  const big = f.engine.discovery.evidence.file('p', 'big', f.root, 'big.txt', 'text/plain', 0);
  const bigObservation = f.engine.discovery.evidence.observe('p', reference(big),
    { kind: 'text-range', start: 0, end: big.value.content.length });
  const invoke = (db: Store = f.store) => synthesisSession(db, db.get<any>(f.draft.id)!, db.get<Question>(f.question.id)!,
    db.get<any>(f.environment.id)!, f.dispatch, db.get<any>(f.pilot.id)!,
    { ...f.context, workingSelections: [{ kind: 'context', value: f.context.workingSelections[0]!.value },
      { kind: 'context', value: bigObservation }] },
    'Return the declared research action', undefined, { delivery: null });
  return { ...f, invoke };
}

test('31 a regular consolidation derives its proposal, checkpoint, replaces and notice with the session in one transaction', async t => {
  const f = await consolidationV2Fixture(t);
  const original = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes: Write[], guards: any = []) => {
    if (writes.some(write => write.kind === 'synthesis-session'
      && Array.isArray((write.value as any).notes) && (write.value as any).notes.some((note: any) => note.consolidated)))
      throw new EngineError('fixture_consolidation_commit_lost', 'The consolidation application was lost');
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.invoke(), { code: 'fixture_consolidation_commit_lost' });
  f.store.writeMany = original;
  // The lost commit left nothing behind: the paid consolidation response is
  // still only a physical record, never a partial note.
  assert.equal(f.session().value.notes.length, 1);
  assert.ok(!f.store.list<any>('research-checkpoint').some(c => Array.isArray(c.value.proposal?.summaries)));
  const callsAfterLoss = f.store.list('model-call').length;
  const result = await f.invoke(f.open());
  assert.equal(result.action, 'answer');
  assert.equal(f.store.list('model-call').length, callsAfterLoss + 1,
    'the consolidation response is applied, never repaid; only the final answer is paid');
  const session = f.session();
  assert.equal(session.value.notes.length, 2, 'the original note and its summary');
  const active = session.value.notes.filter((note: any, _index: number, all: any[]) =>
    !all.some(other => other.consolidated?.replaces?.some((ref: Ref) => canonical(ref) === canonical(note.checkpoint))));
  assert.equal(active.length, 1);
  const summary = session.value.notes[1]!;
  assert.equal(summary.consolidated.replaces.length, 1);
  assert.equal(session.value.offset, 2, 'consolidation never moves the material cursor');
  const consolidationCheckpoint = f.store.get<any>(summary.checkpoint.id)!;
  assert.equal(consolidationCheckpoint.value.status, 'unassessed');
  assert.ok(Array.isArray(consolidationCheckpoint.value.proposal.value.summaries));
  assert.deepEqual(consolidationCheckpoint.value.observations.map((o: any) => o.source.id), [f.citation.source.id]);
  const intents = f.store.list<any>('research-consumer-intent');
  const consolidation = intents.find(intent => intent.value.kind === 'consolidation')!;
  assert.equal(consolidation.value.state, 'applied');
  assert.deepEqual(readResearchConsumerIntent(f.open(), reference(f.store.get<any>(consolidation.id)!)).value.state, 'applied');
  readSynthesisSession(f.open(), reference(f.open().get<any>(session.id)!));
});

test('32 a summary above its size goal is saved with its notice; capacity is decided by the next real packet', async t => {
  const f = await consolidationV2Fixture(t,
    `research={action:'checkpoint',question:c.question.id,value:{summaries:c.consolidation.notes.map((n,i)=>({notes:[i],text:'Compact finding '+i+' keeps its condition'+'x'.repeat(5000)})),citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:['Open conflict']};`);
  const result = await f.invoke();
  assert.equal(result.action, 'answer');
  const session = f.session();
  assert.equal(session.value.notices.length, 1);
  assert.equal(session.value.notices[0].code, 'consolidation_target_exceeded');
  assert.equal(session.value.notices[0].checkpoint.id, session.value.notes[1].checkpoint.id);
  const consolidations = f.wires().filter(line => line.mode === 'consolidation').length;
  assert.equal(consolidations, 1, 'the oversized-but-lawful summary is not repurchased');
});

test('33 a lawful tightening keeps the source summary, and its repeat needs no new payment', async t => {
  const f = await consolidationV2Fixture(t,
    `research={action:'checkpoint',question:c.question.id,value:{summaries:[{notes:c.consolidation.notes.map((_,i)=>i),text:'Tightened finding keeps every distinction'+('x'.repeat(c.consolidation.tightening?2000:16000))}],citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:[]};`,
    { maxRequestChars: 40000, padding: 10000 });
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'synthesis-session'
    && Array.isArray((write.value as any).notes)
    && (write.value as any).notes.some((note: any) => note.consolidated?.tightenedFrom)));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const callsAfterLoss = f.store.list('model-call').length;
  const result = await f.invoke(f.open());
  assert.equal(result.action, 'answer');
  assert.equal(f.store.list('model-call').length, callsAfterLoss + 1,
    'the tightening response is applied, never repaid; only the final answer is paid');
  const session = f.session();
  assert.equal(session.value.notes.length, 3, 'the big note, its summary and the tightening');
  const [first, summary, tightened] = session.value.notes;
  assert.equal(tightened.consolidated.tightenedFrom.id, summary.checkpoint.id);
  assert.equal(summary.consolidated.replaces[0].id, first.checkpoint.id, 'the source summary is preserved');
  const kinds = f.store.list<any>('research-consumer-intent').map(intent => intent.value.kind);
  assert.deepEqual(kinds.filter(kind => kind === 'consolidation').length, 2);
});

test('34 an already-tightened summary that still does not fit is an addressed capacity refusal, never an unchanged loop', async t => {
  const f = await consolidationV2Fixture(t,
    `research={action:'checkpoint',question:c.question.id,value:{summaries:[{notes:c.consolidation.notes.map((_,i)=>i),text:'Tightened finding keeps every distinction'+('x'.repeat(16000))}],citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:[]};`,
    { maxRequestChars: 40000, padding: 10000 });
  await assert.rejects(f.invoke(), { code: 'consolidation_capacity_exhausted' });
  const calls = f.store.list('model-call').length;
  const headRevision = f.session().revision;
  const records = f.store.list().length;
  await assert.rejects(f.invoke(f.open()), { code: 'consolidation_capacity_exhausted' });
  assert.equal(f.store.list('model-call').length, calls, 'no unchanged cycle is paid');
  assert.equal(f.session().revision, headRevision, 'the session is not rewritten by the refusal');
  assert.equal(f.store.list().length, records,
    'a repeat against the unchanged obstacle returns the same code without new identical service records');
});

test('35 capacity consolidation before a synthesis send leaves the unsent step without payment and not a second continuer', async t => {
  const f = await consolidationV2Fixture(t);
  const result = await f.invoke();
  assert.equal(result.action, 'answer');
  const intents = f.store.list<any>('research-consumer-intent');
  const superseded = intents.find(intent => intent.value.kind === 'synthesis' && intent.value.state === 'prepared');
  assert.equal(superseded, undefined, 'preflight refuses the unfit unsent step before persisting its intent');
  assert.equal(intents.length, 3, 'only the checkpoint, consolidation and final answer own paid steps');
  assert.ok(intents.every(intent => intent.value.state === 'applied'));
  assert.equal(new Set(intents.map(intent => intent.value.key)).size, intents.length, 'each paid logical step has one continuer');
  for (const intent of intents) readResearchConsumerIntent(f.open(), reference(intent));
  const calls = f.store.list('model-call').length;
  assert.equal(calls, 3, 'preflight never sends the unfit step');
  assert.deepEqual(await f.invoke(f.open()), result);
  assert.equal(f.store.list('model-call').length, calls);
  assert.deepEqual(f.store.list('research-consumer-intent'), intents, 'repeating the saved result creates no second continuer');
});

test('36 one offset across step kinds keeps its order through the session chain and its own provenance', async t => {
  const f = await synthesisV2Fixture(t, `
const notes=(c.conclusions??c.synthesisNotes??[]).length,ws=(c.contextWorkspace??[]).length;
if(notes===0)research={action:'checkpoint',question:c.question.id,value:{note:'First page findings'},citations:[%CITE%],unresolved:['More remains']};
else if(ws===0)research={action:'read_context',record:%GRAPH%,pointer:'/projection/title',purpose:'Read the exact accepted title for the open question'};
else research={action:'answer',question:c.question.id,value:{note:'Complete grounded answer'},citations:[%CITE%]};`);
  const graphRef = reference(f.store.get<any>('graph-layer:p:1')!);
  writeFileSync(f.adapter, readFileSync(f.adapter, 'utf8').replaceAll('%GRAPH%', JSON.stringify(graphRef)));
  const result = await f.invoke();
  assert.equal(result.action, 'answer');
  const session = f.session();
  for (let revision = 1; revision <= session.revision; revision++)
    readSynthesisSession(f.store, reference(f.store.get<any>(session.id, revision)!));
  const intents = f.store.list<any>('research-consumer-intent')
    .sort((a, b) => a.value.owner.revision - b.value.owner.revision);
  const owners = intents.map(intent => intent.value.owner.revision);
  assert.deepEqual(owners, [...owners].sort((a, b) => a - b), 'the chain order is the exact transition order, not an offset or a call number');
  const outputs = intents.flatMap(intent => intent.value.outputs ?? []);
  const checkpoints = f.store.list<any>('research-checkpoint');
  for (const checkpoint of checkpoints)
    assert.ok(outputs.some(output => output.id === checkpoint.id), 'every checkpoint keeps its own paid provenance');
  assert.ok(intents.every(intent => intent.value.state === 'applied'));
});

test('37 two stores racing one application commit one winner set; the loser reads the exact winner', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'model-response'));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const competitor = f.open();
  const raced = await Promise.allSettled([f.invoke(f.store), f.invoke(competitor)]);
  const winner = raced.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof f.invoke>>> =>
    outcome.status === 'fulfilled');
  assert.ok(winner, 'one store completes the exact application');
  for (const outcome of raced) if (outcome.status === 'rejected')
    assert.ok(['research_consumer_execution_running', 'synthesis_intent_claim_conflict',
      'input_stale', 'revision_conflict'].includes(outcome.reason?.code),
      `a conflict never becomes a semantic refusal or a new payment: ${String(outcome.reason)}`);
  assert.equal(f.store.list('model-call').length, 1);
  assert.equal(f.store.list('research-checkpoint').length, 0);
  const session = f.session();
  assert.equal(session.value.result.action, 'answer');
  assert.equal(f.store.list<any>('research-consumer-intent').length, 1);
  readSynthesisSession(f.open(), reference(f.open().get<any>(session.id)!));
});

test('38 an applied synthesis result is delivered to its exact reserved pending turn without a new analyst call', async t => {
  const f = await synthesisV2Fixture(t, `
if(c.dispatchMode==='planning')research={action:'synthesize',question:c.question.id};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'A scoped local product',facts:[],designs:[{id:'d',decision:'Apply the defined scope',benefit:'Safe local output',consumer:'compilation'}],gaps:[]},citations:[%CITE%]};`);
  const siblingValue = { applicability: 'applicable', reason: 'Settled by the owner', facts: [],
    designs: [{ id: 'sibling-design', decision: 'A settled sibling', benefit: 'Focus', consumer: 'compilation' }], gaps: [] };
  for (const id of f.draft.value.questions.slice(1)) {
    const sibling = f.store.get<Question>(id)!;
    f.engine.discovery.decision(sibling.id, sibling.revision, 'owner', siblingValue);
  }
  const { projectId: _p, ...settings } = f.pilot.value;
  configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
    planning: { fields: [f.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, f.pilot.revision);
  const original = f.store.writeMany.bind(f.store); let interrupted = false;
  f.store.writeMany = ((writes: Write[], guards: any = []) => {
    if (!interrupted && writes.some(write => write.kind === 'research-turn'
      && (write.value as ResearchTurn).dispatchMode === 'synthesis')) {
      interrupted = true;
      throw new EngineError('fixture_delivery_lost', 'The result is durable; its delivery was lost');
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  const run1 = await f.engine.researcher.run('p', f.draft.id, 4);
  f.store.writeMany = original;
  assert.equal(run1.value.pauseCode, 'fixture_delivery_lost');
  const countAfterLoss = { turns: run1.value.turns, requestChars: run1.value.requestChars };
  const session = f.session();
  assert.ok(session.value.result, 'the paid result is durable');
  assert.equal(session.value.delivered ?? null, null, 'the lost delivery left no mark');
  const reservedTurn = session.value.delivery.turn;
  assert.ok(!f.store.list<ResearchTurn>('research-turn').some(turn => turn.value.number === reservedTurn
    && (turn.value.action as any).action === 'answer'), 'no turn holds the answer yet');
  const analystCalls = f.wires().filter(line => line.mode === 'synthesis').length;
  const intentsBefore = f.store.list('research-consumer-intent').length;
  const reopened = f.open();
  const run2 = await new ProductEngine(reopened).researcher.run('p', f.draft.id, 6);
  assert.equal(run2.value.status, 'completed');
  assert.equal(f.wires().filter(line => line.mode === 'synthesis').length, analystCalls,
    'the saved action is delivered without a new analyst payment');
  assert.equal(f.store.list('research-consumer-intent').length, intentsBefore, 'no new step is opened for a saved result');
  const finalRun = reopened.get<any>(run1.id)!;
  assert.equal(finalRun.value.turns, countAfterLoss.turns,
    'the repeat of the same task never counts a new turn position (№1555 X32)');
  assert.equal(finalRun.value.requestChars, countAfterLoss.requestChars,
    'the repeat never re-adds its packed context contribution');
  const deliveredTurn = f.store.list<ResearchTurn>('research-turn')
    .find(turn => (turn.value.action as any).action === 'answer')!;
  assert.equal(deliveredTurn.value.number, reservedTurn, 'the original reserved position receives the result once');
  assert.equal(f.store.get<Question>(f.question.id)!.value.status, 'answered');
  assert.ok(reopened.get<any>(session.id)!.value.delivered);
});

test('39 a repeat after delivery returns the proven transition; the saved outcome is not reissued to a new position', async t => {
  const f = await synthesisV2Fixture(t, `
if(c.dispatchMode==='planning')research={action:'synthesize',question:c.question.id};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'A scoped local product',facts:[],designs:[{id:'d',decision:'Apply the defined scope',benefit:'Safe local output',consumer:'compilation'}],gaps:[]},citations:[%CITE%]};`);
  const siblingValue = { applicability: 'applicable', reason: 'Settled by the owner', facts: [],
    designs: [{ id: 'sibling-design', decision: 'A settled sibling', benefit: 'Focus', consumer: 'compilation' }], gaps: [] };
  for (const id of f.draft.value.questions.slice(1)) {
    const sibling = f.store.get<Question>(id)!;
    f.engine.discovery.decision(sibling.id, sibling.revision, 'owner', siblingValue);
  }
  const { projectId: _p, ...settings } = f.pilot.value;
  configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
    planning: { fields: [f.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, f.pilot.revision);
  const run1 = await f.engine.researcher.run('p', f.draft.id, 6);
  assert.equal(run1.value.status, 'completed');
  const before = { turns: f.store.list('research-turn'), calls: f.store.list('model-call'),
    intents: f.store.list('research-consumer-intent') };
  const run2 = await f.engine.researcher.run('p', f.draft.id, 6);
  assert.equal(run2.value.status, 'completed');
  assert.deepEqual(f.store.list('research-turn'), before.turns, 'no new turn is written for a delivered outcome');
  assert.deepEqual(f.store.list('model-call'), before.calls);
  assert.deepEqual(f.store.list('research-consumer-intent'), before.intents);
  const intent = f.store.list<any>('research-consumer-intent')
    .find(row => row.value.kind === 'synthesis')!;
  const transition = projectPaidSynthesisTransition(f.store, readResearchConsumerIntent(f.store, reference(intent)));
  const session = f.session();
  assert.equal(canonical(transition.session.result), canonical(session.value.result),
    'the exact reader returns the step\'s own proven transition');
});

test('40 two stores racing one synthesis claim elect exactly one physical call', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const competitor = f.open();
  const raced = await Promise.allSettled([f.invoke(f.store), f.invoke(competitor)]);
  const winner = raced.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof f.invoke>>> =>
    outcome.status === 'fulfilled');
  assert.ok(winner, 'one store completes the exact claim');
  for (const outcome of raced) if (outcome.status === 'rejected')
    assert.ok(['research_consumer_execution_running', 'synthesis_intent_claim_conflict',
      'input_stale', 'revision_conflict'].includes(outcome.reason?.code),
      `the conflict never becomes a refusal or a second payment: ${String(outcome.reason)}`);
  assert.equal(f.store.list('model-call').length, 1);
  assert.equal(f.store.list('research-consumer-intent').length, 1);
  assert.equal(f.session().value.result.action, 'answer');
});

test('41 two questions with identical answers keep separate sessions, intents and provenance', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const secondId = f.draft.value.questions[1]!;
  const second = f.store.get<Question>(secondId)!;
  const secondContext = { ...pilotContext(f.store, f.draft, second),
    workingSelections: f.context.workingSelections };
  const invokeSecond = (db: Store = f.store) => synthesisSession(db, db.get<any>(f.draft.id)!,
    db.get<Question>(secondId)!, db.get<any>(f.environment.id)!, f.dispatch, db.get<any>(f.pilot.id)!,
    secondContext, 'Return the declared research action', undefined, { delivery: null });
  const first = await f.invoke();
  const other = await invokeSecond();
  assert.equal(first.action, 'answer');
  assert.equal(other.action, 'answer');
  const sessions = f.store.list<any>('synthesis-session');
  assert.equal(sessions.length, 2);
  const intents = f.store.list<any>('research-consumer-intent');
  assert.equal(intents.length, 2);
  for (const session of sessions) {
    const own = intents.filter(intent => intent.value.owner.id === session.id);
    assert.equal(own.length, 1, 'no intent or transition is borrowed between tasks');
    assert.equal(session.value.binding.question.id === f.question.id
      ? own[0]!.value.question.id : session.value.binding.question.id, session.value.binding.question.id);
    readSynthesisSession(f.open(), reference(f.open().get<any>(session.id)!));
  }
  assert.equal(f.store.list('model-call').length, 2);
});

test('42 preview computes the real envelope with a virtual intent and no durable intent, call or payment', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const preview = await previewResearch(() => f.invoke());
  assert.equal(preview.purpose, 'analyst');
  assert.ok(JSON.parse(preview.input).subject.synthesisState.offset === 0);
  assert.equal(f.store.list('research-consumer-intent').length, 0, 'the preview intent is virtual');
  assert.equal(f.store.list('model-call').length, 0);
  assert.equal(f.store.list('synthesis-session').length, 0, 'preview of the new era persists no session (№1555 X29)');
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'research-consumer-intent' && write.expected === 0));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const intents = f.store.list('research-consumer-intent');
  const second = await previewResearch(() => f.invoke());
  assert.equal(JSON.parse(second.input).subject.synthesisSession, JSON.parse(preview.input).subject.synthesisSession);
  assert.deepEqual(f.store.list('research-consumer-intent'), intents, 'a durable prepared step is previewed without change');
  assert.equal(f.store.list('model-call').length, 0);
});

test('43 a paid preview recovers only on its isolated copy; a completed preview invents no envelope', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'model-response'));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const before = f.store.list();
  const snapshot = await f.store.snapshot(join(f.root, 'preview'));
  const isolated = new Store(snapshot.path); t.after(() => isolated.close());
  await assert.rejects(previewResearch(() => f.invoke(isolated)), { code: 'research_preview_missing' });
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(isolated.get<any>(intent.id)!.value.state, 'applied', 'the isolated copy applied the paid response');
  assert.equal(isolated.list<any>('synthesis-session')[0]!.value.result.action, 'answer');
  assert.deepEqual(f.store.list(), before, 'the main database is untouched by the preview');
  // Complete the main session for real; a preview over a completed step has no
  // envelope to capture and writes nothing.
  const result = await f.invoke();
  assert.equal(result.action, 'answer');
  const completed = f.store.list();
  await assert.rejects(previewResearch(() => f.invoke()), { code: 'research_preview_missing' });
  assert.deepEqual(f.store.list(), completed);
});

/* ==== №1555 — регрессии поправок к договору ==== */

test('X04 a prepared step resumes with its saved cursor context; a rebuilt context never replaces the packet', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'research-consumer-intent' && write.expected === 0));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  // A rebuilt today's context (a new previousProposal and different materials
  // catalogue) is not a new task while the prepared step of the proven task
  // exists; the saved packet goes out unchanged.
  const result = await f.invoke(f.open(), { previousProposal: { action: 'answer', question: f.question.id,
    value: { note: 'unrelated old proposal' }, citations: [f.citation] } });
  assert.equal(result.action, 'answer');
  const calls = f.store.list<ModelCall>('model-call');
  assert.equal(calls.length, 1);
  const requestRecord = f.store.get<any>(calls[0]!.value.request.record!.id)!;
  assert.ok(!requestRecord.value.text.includes('unrelated old proposal'),
    'the saved packet was sent, not the rebuilt context');
  const session = f.session();
  assert.equal(session.value.basis.previousProposal, null, 'the proven original task keeps its own basis');
});

test('X45 a proven rejected answer opens a new task with the exact previousProposal; the delivered result stays immutable', async t => {
  const f = await synthesisV2Fixture(t, `
if(c.dispatchMode==='planning')research={action:'synthesize',question:c.question.id};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:existsSync(%ROOT%+'/accepted-once')?'First corrected attempt':'First attempt',facts:[],designs:[{id:'d',decision:'Apply the defined scope',benefit:'Safe local output',consumer:'compilation'}],gaps:[]},citations:[%CITE%]};`,
    {}, undefined, `research=existsSync(%ROOT%+'/accepted-once')?{verdict:'supported',reasons:[]}:(()=>{writeFileSync(%ROOT%+'/accepted-once','1');return{verdict:'insufficient',reasons:['Missing the exception']}})();`);
  const siblingValue = { applicability: 'applicable', reason: 'Settled by the owner', facts: [],
    designs: [{ id: 'sibling-design', decision: 'A settled sibling', benefit: 'Focus', consumer: 'compilation' }], gaps: [] };
  for (const id of f.draft.value.questions.slice(1)) {
    const sibling = f.store.get<Question>(id)!;
    f.engine.discovery.decision(sibling.id, sibling.revision, 'owner', siblingValue);
  }
  const { projectId: _p, ...settings } = f.pilot.value;
  configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
    planning: { fields: [f.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, f.pilot.revision);
  const run = await f.engine.researcher.run('p', f.draft.id, 8);
  assert.equal(run.value.status, 'completed');
  assert.equal(f.store.get<Question>(f.question.id)!.value.status, 'answered');
  const sessions = f.store.list<any>('synthesis-session');
  assert.equal(sessions.length, 2, 'the correction is a new task, not a rewrite of the rejected one');
  const first = sessions.find(session => session.value.result.value.reason === 'First attempt')!;
  const corrected = sessions.find(session => session.value.result.value.reason === 'First corrected attempt')!;
  assert.ok(first.value.result && corrected.value.result);
  assert.equal(f.store.get<any>(first.id)!.value.result.value.reason, 'First attempt',
    'the delivered result of the previous task is immutable');
  assert.equal(f.wires().filter(line => line.mode === 'synthesis').length, 2,
    'the correction paid its own step, not a reissue');
  assert.notEqual(corrected.value.basis.previousProposal, null,
    'the new task carries the exact rejected proposal as its basis');
  // An equivalent configure (same values, a bare new revision) is not a new
  // task basis — before and after completion (№1658 К3/поправка 7).
  f.engine.environments.configure('p', { ...f.environment.value }, f.environment.revision);
  const callsBefore = f.store.list('model-call').length;
  const rerun = await f.engine.researcher.run('p', f.draft.id, 4);
  assert.equal(rerun.value.status, 'completed');
  assert.equal(f.store.list('model-call').length, callsBefore,
    'an equivalent configure of a finished task buys nothing');
  assert.equal(f.store.list<any>('synthesis-session').length, 2, 'no new session for the same finished task');
});

test('X50 a saved synthesis response resumes before any planning or dispatchMode failure can throw', async t => {
  const f = await synthesisV2Fixture(t, `
if(c.role==='reader'){if(c.purpose==='b'&&existsSync('fail-b')){rmSync('fail-b');process.exit(1);}research={selections:[{sourceIndex:0,firstLine:2,lastLine:3}],unresolved:[]};}
else if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:[{action:'read_bundle',purpose:'a',inputs:[{path:'a.txt',media:'text/plain'}]},{action:'read_bundle',purpose:'b',inputs:[{path:'b.txt',media:'text/plain'}]}]};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Recovered synthesis',facts:[],designs:[{id:'d',decision:'Apply the defined scope',benefit:'Safe local output',consumer:'compilation'}],gaps:[]},citations:[%CITE%]};`);
  writeFileSync(join(f.root, 'a.txt'), 'Header\nA condition\nA exception\n');
  writeFileSync(join(f.root, 'b.txt'), 'Header\nB condition\nB exception\n');
  writeFileSync(join(f.root, 'fail-b'), 'once');
  const siblingValue = { applicability: 'applicable', reason: 'Settled by the owner', facts: [],
    designs: [{ id: 'sibling-design', decision: 'A settled sibling', benefit: 'Focus', consumer: 'compilation' }], gaps: [] };
  for (const id of f.draft.value.questions.slice(1)) {
    const sibling = f.store.get<Question>(id)!;
    f.engine.discovery.decision(sibling.id, sibling.revision, 'owner', siblingValue);
  }
  let pilot = configureReaderPilot(f.store, f.engine.environments, 'p', { ...((({ projectId: _p, ...rest }) => rest)(f.pilot.value)),
    planning: { fields: [f.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, f.pilot.revision);
  const run1 = await f.engine.researcher.run('p', f.draft.id, 6);
  assert.equal(run1.value.pauseCode, 'research_provider_failed');
  const failed = f.store.list<ModelCall>('model-call')
    .find(call => call.value.purpose === 'reader' && call.value.status === 'failed' && call.value.usage === null)!;
  pilot = configureReaderPilot(f.store, f.engine.environments, 'p', { ...((({ projectId: _p, ...rest }) => rest)(pilot.value)),
    unknownReserves: [{ call: reference(failed), tokens: 100 }] }, pilot.revision);
  // A paid synthesis response for the same question lands mid-flight.
  const restore = f.interruptAfter(f.store, writes => writes.some(write => write.kind === 'model-response'
    && (write.value as any).consumerExecution));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const synthesisCallsBefore = f.wires().filter(line => line.mode === 'synthesis').length;
  const planningCallsBefore = f.wires().filter(line => line.mode === 'planning').length;
  const run2 = await f.engine.researcher.run('p', f.draft.id, 6);
  assert.equal(run2.value.status, 'completed', 'reading_plan_blocked never shadows the saved response');
  assert.equal(f.store.get<Question>(f.question.id)!.value.status, 'answered');
  assert.equal(f.wires().filter(line => line.mode === 'synthesis').length, synthesisCallsBefore,
    'the saved response was applied; no new synthesis payment');
  assert.equal(f.wires().filter(line => line.mode === 'planning').length, planningCallsBefore,
    'no new planner payment');
});

test('X31 the v2 operator context recovery is a proven transition: blocked outcome admitted, unresolved claim refused, superseded prepared never claims', async t => {
  // (c) after the applied blocked outcome of a paid lookup, recovery is allowed.
  const f = await synthesisV2Fixture(t, `research={action:'read_context',record:%GRAPH%,pointer:'/projection/not-there',purpose:'A missing pointer'};`);
  const graphRef = reference(f.store.get<any>('graph-layer:p:1')!);
  writeFileSync(f.adapter, readFileSync(f.adapter, 'utf8').replaceAll('%GRAPH%', JSON.stringify(graphRef)));
  await assert.rejects(f.invoke(), { code: 'research_no_progress' });
  const session = f.session();
  assert.equal(session.value.blockedCode, 'context_missing');
  const recovered = recoverContextSession(f.store, 'p', reference(f.store.get<any>(session.id)!),
    { record: graphRef, pointer: '/projection/title' });
  assert.ok(!(recovered.value.workspace as any).blocked);
  assert.equal((recovered.value.workspace as any).entries.at(-1).result.value, 'p');
  readSynthesisSession(f.open(), reference(f.open().get<any>(session.id)!));
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.store.get<any>(session.id)!),
    { record: graphRef, pointer: '/projection/title' }), { code: 'context_session_not_blocked' });

  // (b) a claim without its application forbids the operator replacement,
  // including a saved succeeded response before A.
  const g = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restoreG = g.interruptAfter(g.store, writes => writes.some(write => write.kind === 'model-response'));
  await assert.rejects(g.invoke(), { code: 'fixture_write_crash' });
  restoreG();
  assert.throws(() => recoverContextSession(g.store, 'p', reference(g.session()),
    { record: reference(g.store.get<any>('graph-layer:p:1')!), pointer: '/projection/title' }),
    { code: 'context_recovery_claim_pending' });

  // (a) a merely-prepared step is superseded: the proven transition moves the
  // head, and the old prepared step can never claim (row-35 mechanics).
  const h = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restoreH = h.interruptAfter(h.store, writes => writes.some(write => write.kind === 'research-consumer-intent' && write.expected === 0));
  await assert.rejects(h.invoke(), { code: 'fixture_write_crash' });
  restoreH();
  const prepared = h.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(prepared.value.state, 'prepared');
  const recoveredH = recoverContextSession(h.store, 'p', reference(h.session()),
    { record: reference(h.store.get<any>('graph-layer:p:1')!), pointer: '/projection/title' });
  assert.equal((recoveredH.value.recoveries as any)?.at(-1)?.reason, CONTEXT_RECOVERY_SUPERSEDE_REASON);
  const result = await h.invoke(h.open());
  assert.equal(result.action, 'answer');
  assert.equal(h.store.get<any>(prepared.id)!.value.state, 'prepared', 'the superseded step never claimed');
  assert.equal(h.store.get<any>(prepared.id)!.value.call, null);
  const intents = h.store.list<any>('research-consumer-intent');
  assert.equal(intents.length, 2, 'a new step at the new head, not a new generation');
  assert.equal(intents.find(intent => intent.id !== prepared.id)!.value.generation, 0);
  readSynthesisSession(h.open(), reference(h.open().get<any>(h.session().id)!));
});

test('X22 the consumer wrapper returns control on a saved refusal and never buys a second physical attempt', async t => {
  const f = await synthesisV2Fixture(t, `
if(c.dispatchMode==='planning')research={action:'synthesize',question:c.question.id};
else process.exit(1);`);
  const { projectId: _p, ...settings } = f.pilot.value;
  configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
    planning: { fields: [f.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, f.pilot.revision);
  const { researchForConsumer } = await import('../src/discovery/consumer-research.js');
  const calls = () => f.store.list('model-call').length;
  const first = await researchForConsumer(f.store, f.engine.researcher, 'p', f.draft.id, 4,
    () => () => ({ artifact: null, findings: [], guards: [] }));
  assert.equal(first.status, 'paused', 'the wrapper returns control on the refusal');
  const afterFirst = calls();
  const intents = f.store.list<any>('research-consumer-intent')
    .filter(intent => intent.value.kind === 'synthesis');
  assert.equal(intents.length, 1);
  assert.equal(intents[0]!.value.state, 'refused');
  assert.equal(intents[0]!.value.refusal?.kind, 'provider-failed');
  // Neither the run loop nor the wrapper issued itself a permit: no g+1, no
  // second physical attempt appeared inside the same external entry.
  const failedCall = f.store.list<ModelCall>('model-call')
    .find(call => call.value.status === 'failed' && call.value.usage === null)!;
  const pilotHead = f.store.get<any>(f.pilot.id)!;
  const { projectId: _p2, ...restSettings } = pilotHead.value;
  configureReaderPilot(f.store, f.engine.environments, 'p', { ...restSettings,
    unknownReserves: [{ call: reference(failedCall), tokens: 100 }] }, pilotHead.revision);
  const second = await researchForConsumer(f.store, f.engine.researcher, 'p', f.draft.id, 4,
    () => () => ({ artifact: null, findings: [], guards: [] }));
  assert.equal(second.status, 'paused', 'the wrapper returns control on the refusal again');
  assert.equal(calls(), afterFirst + 1, 'only the next explicit entry permitted one new generation');
  const generations = f.store.list<any>('research-consumer-intent')
    .filter(intent => intent.value.kind === 'synthesis')
    .sort((a, b) => a.value.generation - b.value.generation)
    .map(intent => [intent.value.generation, intent.value.state]);
  assert.deepEqual(generations, [[0, 'refused'], [1, 'refused']],
    'the new generation was saved refused; no internal loop paid another');
});

test('X09 a received response is applied only after a fresh current admission, even without a restart', async t => {
  const f = await synthesisV2Fixture(t, `writeFileSync(%ROOT%+'/notes.txt','Changed while provider was running');` + ANSWER_SCRIPT);
  writeFileSync(join(f.root, 'notes.txt'), 'Original scoped condition\n');
  const source = f.engine.discovery.evidence.file('p', 'synthesis-file', f.root, 'notes.txt', 'text/plain', 0);
  const observation = f.engine.discovery.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: source.value.content.length });
  await assert.rejects(f.invoke(f.store, { workingSelections: [{ kind: 'context', value: observation }] }),
    { code: 'synthesis_evidence_stale' });
  const session = f.session();
  assert.equal(session.value.result, null, 'the paid response is saved but never applied over stale materials');
  assert.deepEqual(f.store.list<any>('research-consumer-intent').map(x => x.value.state), ['running']);
});

test('X10 a lookup material that fails its own reader is refused before any subject write, then repeats as itself', async t => {
  // №1658 К1: the origin proof precedes the subject write at the paid entry —
  // the prior session and the physical response survive; the intent keeps a
  // saved terminal refusal; no session revision ever carries the bad material.
  const f = await synthesisV2Fixture(t, `research={action:'read_context',record:%BAD%,pointer:'/observations/0/value',purpose:'Inspect the original reader observation'};`);
  const body = { projectId: 'p', question: reference(f.question), pilot: reference(f.pilot), purpose: 'no producer',
    contract: 'reader-result/v2', producer: 'paid', intent: { id: 'absent-intent', revision: 1, hash: '0'.repeat(64) },
    sources: [reference(f.basisSource)], coverage: [],
    observations: [{ projectId: 'p', source: reference(f.basisSource), selector: { kind: 'text-range', start: 0, end: 24 },
      value: 'Not the recorded Source bytes' }], unresolved: [] };
  const bad = f.store.write({ id: 'reader-result:v2:' + hashJson(body), kind: 'reader-result', expected: 0, value: body });
  assert.throws(() => readReaderResultAt(f.store, 'p', reference(bad)), { code: 'reader_result_invalid' });
  writeFileSync(f.adapter, readFileSync(f.adapter, 'utf8').replaceAll('%BAD%', JSON.stringify(reference(bad))));
  await assert.rejects(f.invoke(), { code: 'reader_result_invalid' });
  const session = f.session();
  assert.equal(session.revision, 1, 'no session revision was written on the unproven material');
  assert.equal(session.value.workspace ?? null, null, 'no workspace entry committed');
  const intent = f.store.list<any>('research-consumer-intent')[0]!;
  assert.equal(intent.value.state, 'running', 'the intent keeps its proven paid claim; the refusal is not manufactured');
  const paidCalls = f.store.list('model-call').length;
  await assert.rejects(f.invoke(), { code: 'reader_result_invalid' });
  assert.equal(f.store.list('model-call').length, paidCalls, 'the repeat re-derives the same refusal from the proven execution, without a new payment');
  readSynthesisSession(f.open(), reference(session));
});

test('X29c a direct entry of a brand-new task produces the v2 era; its exact repeat applies the saved response without repaying', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const direct = () => synthesisSession(f.store, f.store.get<any>(f.draft.id)!, f.store.get<Question>(f.question.id)!,
    f.store.get<any>(f.environment.id)!, f.dispatch, f.store.get<any>(f.pilot.id)!, f.context, 'Return the declared research action');
  const restore = f.interruptAfter(f.store, writes => writes.some(w => w.kind === 'model-response'));
  await assert.rejects(direct(), { code: 'fixture_write_crash' });
  restore();
  assert.ok(f.session().id.startsWith('synthesis-session:v2:'), 'a new direct entry is the new era');
  const before = f.store.list('model-call').length;
  const result = await direct();
  assert.equal(result.action, 'answer');
  assert.equal(f.store.list('model-call').length, before, 'the exact repeat applies the saved response');
});

test('X04 an unfinished session of a compatible previous basis is resumed by its era — never silently repaid', async t => {
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const restore = f.interruptAfter(f.store, writes => writes.some(w => w.kind === 'model-response'));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const old = f.session().id, calls = f.store.list('model-call').length;
  f.engine.environments.configure('p', { ...f.environment.value }, f.environment.revision);
  const result = await f.invoke(f.open());
  assert.equal(result.action, 'answer');
  assert.equal(f.store.list('model-call').length, calls, 'the saved response of the previous basis revision is applied, not repaid');
  assert.equal(f.session().id, old, 'the same session owns the task');

  // A genuine previous-era (v1) unfinished session of the same task keeps its
  // own lawful recovery path: the new-era entry refuses with its address
  // instead of paying over it.
  const f2 = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  const materials = [...(f2.context.workingSelections ?? [])];
  const legacyId = `synthesis-session:${hashJson([reference(f2.question), reference(f2.environment),
    f2.draft.value.inputs, materials, null, null])}`;
  f2.store.write({ id: legacyId, kind: 'synthesis-session', expected: 0, value: { projectId: 'p', offset: 0, notes: [], result: null,
    binding: { draft: reference(f2.draft), question: reference(f2.question), environment: reference(f2.environment), inputs: f2.draft.value.inputs } } });
  // A compatible reconfiguration moves the basis; the new-era entry must not
  // pay over the previous-era unfinished session of the same task.
  f2.engine.environments.configure('p', { ...f2.environment.value }, f2.environment.revision);
  const calls2 = f2.store.list('model-call').length;
  await assert.rejects(f2.invoke(), { code: 'synthesis_legacy_pending' });
  assert.equal(f2.store.list('model-call').length, calls2, 'the addressed refusal never buys over the previous-era session');
  assert.equal(f2.store.list<any>('synthesis-session').length, 1, 'no new session was created');
});

test('X32 a received response keeps the reserved run position and budget across a restart', async t => {
  const f = await synthesisV2Fixture(t, `if(c.dispatchMode==='planning')research={action:'synthesize',question:c.question.id};else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'A scoped local product',facts:[],designs:[{id:'d',decision:'Apply the defined scope',benefit:'Safe local output',consumer:'compilation'}],gaps:[]},citations:[%CITE%]};`);
  const siblingValue = { applicability: 'applicable', reason: 'Settled by the owner', facts: [],
    designs: [{ id: 'sibling-design', decision: 'A settled sibling', benefit: 'Focus', consumer: 'compilation' }], gaps: [] };
  for (const id of f.draft.value.questions.slice(1)) {
    const sibling = f.store.get<Question>(id)!;
    f.engine.discovery.decision(sibling.id, sibling.revision, 'owner', siblingValue);
  }
  const { projectId: _p, ...settings } = f.pilot.value;
  configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
    planning: { fields: [f.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, f.pilot.revision);
  // The synthesis step is the managed intent under test: the planner is now a
  // managed intent too, so the interruption targets the running synthesis one.
  const restore = f.interruptAfter(f.store, writes => writes.some(w => w.kind === 'model-response')
    && f.store.list<any>('research-consumer-intent').some(x => x.value.kind === 'synthesis' && x.value.state === 'running'));
  const first = await f.engine.researcher.run('p', f.draft.id, 4);
  restore();
  const intent = f.store.list<any>('research-consumer-intent').find(x => x.value.kind === 'synthesis')!;
  assert.equal(intent.value.cursor.delivery?.turn, first.value.turns, 'the reserved position survives the interruption');
  const second = await new ProductEngine(f.open()).researcher.run('p', f.draft.id, 6);
  assert.equal(second.value.status, 'completed');
  assert.equal(second.value.turns, first.value.turns, 'the same logical action keeps its reserved position');
  assert.equal(second.value.requestChars, first.value.requestChars, 'no logical budget is spent twice');

  // №1658-3, окно session→первый intent: разрыв сразу после первой записи
  // session (резерв уже в ней) — повтор со второго Store без нового начисления.
  const fa = await synthesisV2Fixture(t, `if(c.dispatchMode==='planning')research={action:'synthesize',question:c.question.id};else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'A scoped local product',facts:[],designs:[{id:'d',decision:'Apply the defined scope',benefit:'Safe local output',consumer:'compilation'}],gaps:[]},citations:[%CITE%]};`);
  for (const id of fa.draft.value.questions.slice(1)) {
    const sibling = fa.store.get<Question>(id)!;
    fa.engine.discovery.decision(sibling.id, sibling.revision, 'owner', siblingValue);
  }
  const { projectId: _pa, ...settingsA } = fa.pilot.value;
  configureReaderPilot(fa.store, fa.engine.environments, 'p', { ...settingsA,
    planning: { fields: [fa.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, fa.pilot.revision);
  const restoreA = fa.interruptAfter(fa.store, writes => writes.some(w => w.kind === 'synthesis-session' && w.expected === 0));
  const firstA = await fa.engine.researcher.run('p', fa.draft.id, 4);
  restoreA();
  assert.equal(fa.store.list<any>('research-consumer-intent').filter(x => x.value.kind === 'synthesis').length, 0,
    'the crash preceded the first synthesis intent');
  const secondA = await new ProductEngine(fa.open()).researcher.run('p', fa.draft.id, 6);
  assert.equal(secondA.value.status, 'completed');
  assert.equal(secondA.value.turns, firstA.value.turns, 'the first session record already proves the reservation');
  assert.equal(secondA.value.requestChars, firstA.value.requestChars, 'the reservation window never double-charges');
  const answerTurnA = fa.store.list<ResearchTurn>('research-turn').find(turn => (turn.value.action as any).action === 'answer')!;
  assert.equal(answerTurnA.value.number, firstA.value.turns, 'the answer lands in the turn reserved by the first record');
  assert.equal(fa.store.list<ModelCall>('model-call').filter(c => c.value.purpose === 'analyst').length, 1, 'one P total');

  // №1658-3, окно переданная pause→новый intent: новый явный запуск получает
  // НОВЫЙ резерв до его intent; прежняя передача остаётся в истории.
  const fc = await synthesisV2Fixture(t, `if(c.dispatchMode==='planning')research={action:'synthesize',question:c.question.id};else research=existsSync('held-once')?{action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Released after the held decision',facts:[],designs:[{id:'d',decision:'Apply the defined scope',benefit:'Safe local output',consumer:'compilation'}],gaps:[]},citations:[%CITE%]}:(()=>{writeFileSync('held-once','1');return{action:'pause',reason:'Hold for an operator decision'}})();`);
  for (const id of fc.draft.value.questions.slice(1)) {
    const sibling = fc.store.get<Question>(id)!;
    fc.engine.discovery.decision(sibling.id, sibling.revision, 'owner', siblingValue);
  }
  const { projectId: _pc, ...settingsC } = fc.pilot.value;
  configureReaderPilot(fc.store, fc.engine.environments, 'p', { ...settingsC,
    planning: { fields: [fc.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, fc.pilot.revision);
  const runC1 = await fc.engine.researcher.run('p', fc.draft.id, 4);
  assert.equal(runC1.value.status, 'paused', 'the delivered pause stops the current run');
  const pauseTurns = fc.store.list<ResearchTurn>('research-turn').filter(turn => (turn.value.action as any).action === 'pause');
  assert.equal(pauseTurns.length, 1);
  const pauseTurn = pauseTurns[0]!.value.number;
  // №1658-3 + №1676, обязательная регрессия (ровно проба reviewer-pause.mjs):
  // новый явный запуск получает НОВЫЙ резерв одним переходом до intent; разрыв
  // ровно ПОСЛЕ него; сохранённый резерв находится и без intent, потреблённым
  // он становится только собственной доставкой, старый delivered — история.
  const synthesisWiresC = fc.wires().filter(line => line.mode === 'synthesis').length;
  const restore2 = fc.interruptAfter(fc.store, writes => writes.some(w => w.kind === 'synthesis-session'
    && (w.value as any).delivery?.turn > pauseTurn && (w.value as any).delivered != null));
  const interrupted = await fc.engine.researcher.run('p', fc.draft.id, 6);
  restore2();
  const beforeTurns = interrupted.value.turns, beforeChars = interrupted.value.requestChars;
  const resumed = await new ProductEngine(fc.open()).researcher.run('p', fc.draft.id, 6);
  assert.equal(resumed.value.status, 'completed');
  assert.equal(resumed.value.turns, beforeTurns, 'the new reservation survives the interruption before its intent (№1676)');
  assert.equal(resumed.value.requestChars, beforeChars, 'no second budget for the same next step');
  const turnsC = fc.store.list<ResearchTurn>('research-turn').sort((a, b) => a.value.number - b.value.number);
  assert.deepEqual(turnsC.map(turn => turn.value.number), [1, 2, 3], 'no position of another question or the planner is taken');
  assert.equal((turnsC[2]!.value.action as any).action, 'answer');
  assert.equal(turnsC.filter(turn => (turn.value.action as any).action === 'pause').length, 1,
    'the delivered pause is never reissued into the new position');
  assert.ok(turnsC[2]!.value.number > pauseTurn, 'the answer lands in the newly reserved turn');
  assert.equal(fc.wires().filter(line => line.mode === 'synthesis').length, synthesisWiresC + 1,
    'exactly one new P for the genuinely next step (the assessor is a separate consumer)');
  const headC = fc.store.list<any>('synthesis-session')[0]!;
  for (let revision = 1; revision <= headC.revision; revision += 1)
    readSynthesisSession(fc.open(), reference(fc.open().get<any>(headC.id, revision)!));
});

test('X06 the delivered synthesis outcome moves the question past a stale blocked plan', async t => {
  const f = await synthesisV2Fixture(t, `if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:[{action:'read_context',record:%GRAPH%,pointer:'/missing-key'}]};else ` + ANSWER_SCRIPT);
  const siblingValue = { applicability: 'applicable', reason: 'Settled by the owner', facts: [],
    designs: [{ id: 'sibling-design', decision: 'A settled sibling', benefit: 'Focus', consumer: 'compilation' }], gaps: [] };
  for (const id of f.draft.value.questions.slice(1)) {
    const sibling = f.store.get<Question>(id)!;
    f.engine.discovery.decision(sibling.id, sibling.revision, 'owner', siblingValue);
  }
  writeFileSync(f.adapter, readFileSync(f.adapter, 'utf8').replaceAll('%GRAPH%', JSON.stringify(reference(f.store.get<any>('graph-layer:p:1')!))));
  const { projectId: _p, ...settings } = f.pilot.value;
  configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
    planning: { fields: [f.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, f.pilot.revision);
  const first = await f.engine.researcher.run('p', f.draft.id, 4);
  assert.equal(first.value.pauseCode, 'reading_plan_blocked', 'the genuinely blocked plan pauses the first run');
  const restore = f.interruptAfter(f.store, writes => writes.some(w => w.kind === 'model-response'));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const resumed = await new ProductEngine(f.open()).researcher.run('p', f.draft.id, 4);
  assert.notEqual(resumed.value.pauseCode, 'reading_plan_blocked',
    'the saved response is applied and delivered before any new-plan check can shadow it');
  assert.equal(f.store.list<any>('research-consumer-intent')
    .find(x => x.value.kind === 'synthesis')!.value.state, 'applied');
  const answerTurn = f.store.list<ResearchTurn>('research-turn')
    .find(turn => (turn.value.action as any).action === 'answer' && turn.value.run === resumed.id);
  assert.ok(answerTurn, 'the applied answer was delivered to a run turn');
});

test('R4-8 the operator context recovery proves the material before writing; an unproven record is refused without a write', async t => {
  // №1658 поправка 8 + К1: recover-context-session меняет workspace только после
  // законного blocked и только с доказанным материалом; отказ не пишет recovery.
  const f = await synthesisV2Fixture(t, `research={action:'read_context',record:%GRAPH%,pointer:'/missing-key',purpose:'Inspect the graph context'};`);
  const graph = reference(f.store.get<any>('graph-layer:p:1')!);
  writeFileSync(f.adapter, readFileSync(f.adapter, 'utf8').replaceAll('%GRAPH%', JSON.stringify(graph)));
  await assert.rejects(f.invoke(), { code: 'research_no_progress' });
  const blocked = reference(f.session());
  const forged = { projectId: 'p', question: reference(f.question), pilot: reference(f.pilot), purpose: 'no producer',
    contract: 'reader-result/v2', producer: 'paid', intent: { id: 'absent-intent', revision: 1, hash: '0'.repeat(64) },
    sources: [reference(f.basisSource)], coverage: [],
    observations: [{ projectId: 'p', source: reference(f.basisSource), selector: { kind: 'text-range', start: 0, end: 24 },
      value: f.basisSource.value.content.slice(0, 24) }], unresolved: [] };
  const bad = f.store.write({ id: 'reader-result:v2:' + hashJson(forged), kind: 'reader-result', expected: 0, value: forged });
  assert.throws(() => f.engine.execute({ type: 'recover-context-session', project: 'p', session: blocked,
    selector: { record: reference(bad), pointer: '/observations/0/value' } }), { code: 'reader_result_invalid' });
  assert.equal(f.session().revision, blocked.revision, 'no recovery revision was written on the unproven record');
  readSynthesisSession(f.open(), reference(f.session()));
  // The lawful recovery of the same blocked session is still admitted.
  const recovered = await f.engine.execute({ type: 'recover-context-session', project: 'p', session: reference(f.session()),
    selector: { record: graph, pointer: '/projection/title' } }) as any;
  assert.ok(recovered.value.workspace.entries.length === 1);
  readSynthesisSession(f.open(), reference(f.session()));
});

test('R4-1 every successful writing entry produces a chain the historical reader accepts', async t => {
  // №1658 К1 круговой тест: прямой вход (page → lookup → answer), разрыв с
  // операторским replay, и операторское восстановление контекста — после каждой
  // записи readSynthesisSession принимает цепочку по каждой ревизии.
  const f = await synthesisV2Fixture(t, `
if(!existsSync('step1')){writeFileSync('step1','1');research={action:'read_context',record:%GRAPH%,pointer:'/projection/title',purpose:'Read the exact graph title'};}
else if(!existsSync('step2')){writeFileSync('step2','1');research={action:'checkpoint',question:c.question.id,value:{note:'Findings from the exact graph title'},citations:[%CITE%],unresolved:['One condition remains']};}
else research={action:'answer',question:c.question.id,value:{note:'Grounded final answer'},citations:[%CITE%]};`);
  writeFileSync(f.adapter, readFileSync(f.adapter, 'utf8').replaceAll('%GRAPH%', JSON.stringify(reference(f.store.get<any>('graph-layer:p:1')!))));
  const proveAll = (db: Store) => {
    const head = f.session();
    for (let revision = 1; revision <= head.revision; revision += 1)
      readSynthesisSession(db, reference(db.get<any>(head.id, revision)!));
    return head;
  };
  const result = await f.invoke();
  assert.equal(result.action, 'answer');
  const head = proveAll(f.open());
  assert.ok(head.revision >= 4, 'initial + lookup + page + result revisions all proven');
  assert.deepEqual(f.session().value.workspace?.entries?.length, 1);
});

test('R4-6 a completed direct task replays its saved result after a file change or an equivalent configure, without new payment', async t => {
  // №1658 К4 + К3: the finished repeat is historical — by the saved bases,
  // without the current file and without P/A; the task identity ignores the
  // environment Ref. History accepts the whole chain throughout.
  const f = await synthesisV2Fixture(t, ANSWER_SCRIPT);
  writeFileSync(join(f.root, 'notes.txt'), 'Original scoped condition\n');
  const source = f.engine.discovery.evidence.file('p', 'repeat-file', f.root, 'notes.txt', 'text/plain', 0);
  const obs = f.engine.discovery.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: source.value.content.length });
  const over = { workingSelections: [{ kind: 'context', value: obs }] };
  const first = await f.invoke(f.store, over);
  assert.equal(first.action, 'answer');
  const saved = reference(f.session());
  const before = f.store.list('model-call').length;
  writeFileSync(join(f.root, 'notes.txt'), 'Changed after successful application\n');
  const afterFile = await f.invoke(f.open(), over);
  assert.deepEqual(afterFile, first);
  assert.equal(f.store.list('model-call').length, before, 'no payment for the historical repeat');
  assert.equal(f.store.list<any>('synthesis-session').length, 1, 'no new session');
  readSynthesisSession(f.open(), saved);
  f.engine.environments.configure('p', { ...f.environment.value }, f.environment.revision);
  const afterConfigure = await f.invoke(f.open(), over);
  assert.deepEqual(afterConfigure, first);
  assert.equal(f.store.list('model-call').length, before, 'an equivalent configure never repays the finished task');
  assert.equal(f.store.list<any>('synthesis-session').length, 1, 'the same session is found by the task identity');
  readSynthesisSession(f.open(), saved);
});

test('R4-10 a new failed plan keeps reading_plan_blocked after an old recovery; no call is repeated', async t => {
  // №1658 поправка 10: the resume priority never cancels the admission of a
  // NEW plan; a genuinely failed new plan blocks, repeatedly, without payment.
  const f = await synthesisV2Fixture(t, `if(c.dispatchMode==='planning')research={action:'read_plan',question:c.question.id,reads:[{action:'read_context',record:%GRAPH%,pointer:'/missing-key'}]};else ` + ANSWER_SCRIPT);
  const siblingValue = { applicability: 'applicable', reason: 'Settled by the owner', facts: [],
    designs: [{ id: 'sibling-design', decision: 'A settled sibling', benefit: 'Focus', consumer: 'compilation' }], gaps: [] };
  for (const id of f.draft.value.questions.slice(1)) {
    const sibling = f.store.get<Question>(id)!;
    f.engine.discovery.decision(sibling.id, sibling.revision, 'owner', siblingValue);
  }
  writeFileSync(f.adapter, readFileSync(f.adapter, 'utf8').replaceAll('%GRAPH%', JSON.stringify(reference(f.store.get<any>('graph-layer:p:1')!))));
  const { projectId: _p, ...settings } = f.pilot.value;
  configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
    planning: { fields: [f.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, f.pilot.revision);
  const first = await f.engine.researcher.run('p', f.draft.id, 4);
  assert.equal(first.value.pauseCode, 'reading_plan_blocked');
  const restore = f.interruptAfter(f.store, writes => writes.some(w => w.kind === 'model-response'));
  await assert.rejects(f.invoke(), { code: 'fixture_write_crash' });
  restore();
  const resumed = await new ProductEngine(f.open()).researcher.run('p', f.draft.id, 4);
  assert.notEqual(resumed.value.pauseCode, 'reading_plan_blocked', 'the saved response is never shadowed by the old plan');
  writeFileSync(f.adapter, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;const research=c.dispatchMode==='planning'?{action:'read_plan',question:c.question.id,reads:[{action:'read_context',record:${JSON.stringify(reference(f.store.get<any>('graph-layer:p:1')!))},pointer:'/missing-new-plan'}]}:{action:'need_research',question:c.question.id,missing:['Need exact original']};console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const fresh = await new ProductEngine(f.open()).researcher.run('p', f.draft.id, 4);
  const calls = f.store.list('model-call').length;
  const retry = await new ProductEngine(f.open()).researcher.run('p', f.draft.id, 4);
  assert.equal(fresh.value.pauseCode, 'reading_plan_blocked', 'the NEW failed plan blocks');
  assert.equal(retry.value.pauseCode, 'reading_plan_blocked', 'the block repeats as itself');
  assert.equal(f.store.list('model-call').length, calls, 'the blocked plan never pays again');
});

for (const verdict of ['insufficient', 'conflicting'] as const) {
  test(`a paid ${verdict} assessment keeps its exact terminal proof after later session heads`, async t => {
    const root = mkdtempSync(join(tmpdir(), `omg-d84-${verdict}-`));
    const database = join(root, 'state.sqlite'), stores: Store[] = [];
    const open = () => { const db = new Store(database); stores.push(db); return db; };
    t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
    const store = open(), engine = new ProductEngine(store);
    engine.execute({ type: 'create-project', project: 'p', title: `Assessment ${verdict}` });
    const source = engine.discovery.evidence.document('p', 'proof', 'One exact documentary observation', 'text/plain', 0);
    const adapter = join(root, 'adapter.mjs');
    writeFileSync(adapter, `import{readFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
const research=s.role==='assess-answer'?{verdict:${JSON.stringify(verdict)},reasons:['The fixture did not support acceptance']}
 :{action:'answer',question:s.questions[0].id,value:{ok:true},citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'text-range',start:0,end:12}}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
    const command = { executable: process.execPath, args: [adapter] };
    engine.environments.configure('p', { workspace: root,
      implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
      fullCheck: command, timeoutMs: 5000 }, 0);
    const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
      [{ field: 'result', kind: 'design', prompt: 'Resolve result', risk: 'Missing source', schema: { type: 'object' } }]);
    await engine.researcher.run('p', draft.id, 1);
    const assessment = store.list<any>('research-assessment')[0]!, turn = store.list<ResearchTurn>('research-turn')[0]!;
    assert.equal(assessment.value.verdict, verdict);
    const proved = readResearchAssessmentAt(open(), 'p', turn.id, reference(assessment));
    assert.deepEqual(proved.value, assessment.value);
    const proof = store.get<any>(`research-assessment-binding:v1:${hashJson({ projectId: 'p', turnId: turn.id })}`)!;
    assert.ok(proof);
    const terminal = store.get<any>(proof.value.session.id, proof.value.session.revision)!;
    store.write({ id: terminal.id, kind: terminal.kind, expected: terminal.revision,
      value: { ...terminal.value, notes: [...terminal.value.notes, { later: true }] } });
    assert.deepEqual(readResearchAssessmentAt(open(), 'p', turn.id, reference(assessment)).value,
      assessment.value, 'the later session head does not reinterpret the terminal verdict');
  });
}

function graphPrecheckFixture(t: test.TestContext, typed: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-graph-history-')));
  const database = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const store = new Store(database); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), evidence = new Evidence(store);
  const spec = typed ? withTypedBasis(TECHNICAL_RESEARCH.R1[0]!) : TECHNICAL_RESEARCH.R1[0]!;
  const draft = store.write({ id: 'd84-graph-draft', kind: 'discovery-draft', expected: 0,
    value: { projectId: 'p', stage: 'om-g2', level: 'R1', consumer: 'compilation',
      ...(typed ? { basisContract: 'typed-v1' } : {}), questions: ['d84-graph-question'], inputs: [], fields: {} } });
  const question = store.write<Question>({ id: 'd84-graph-question', kind: 'question', expected: 0,
    value: { projectId: 'p', draftId: draft.id, stage: 'om-g2', level: 'R1', consumer: 'compilation',
      status: 'open', answer: null, spec } as Question });
  const graph = { nodes: [{ id: 'node', code: [], tests: [] }], horizon: [], connectors: [], tests: [], anchors: [] } as unknown as Graph;
  const report = (path: string): TechnicalReport => ({ applicability: 'applicable', reason: 'A precise captured file',
    facts: [{ id: 'file-fact', claim: 'The file contains its recorded condition',
      ...(typed ? { evidence: { kind: 'repository-file' as const, citation: 0 } } : { path }) }],
    designs: [{ id: 'design', decision: 'Use the recorded condition', benefit: 'A checked result', consumer: 'compilation' }],
    gaps: [], ...(typed ? { documents: [] } : {}) });
  const check = (db: Store, value: TechnicalReport, observations: ReturnType<Evidence['observe']>[],
    mode: 'current' | 'historical', legacyPaths: LegacyPathResolution[] = []) => {
    const view = assessmentReadView(db);
    const findings = technicalProposalFindings(view.store, 'p', 'R1', question.id, spec.field,
      value, observations, graph, root, { proofs: [] }, { mode, legacyPaths });
    return { findings, proof: view.finish(), legacyPaths };
  };
  const replay = (db: Store, proof: ReturnType<typeof assessmentReadView>['proof'], value: TechnicalReport,
    observations: ReturnType<Evidence['observe']>[], legacyPaths: LegacyPathResolution[] = []) => {
    const view = assessmentReadView(db, proof);
    const findings = technicalProposalFindings(view.store, 'p', 'R1', question.id, spec.field,
      value, observations, graph, root, { proofs: [] }, { mode: 'historical', legacyPaths });
    view.finish();
    return findings;
  };
  return { root, store, open, evidence, report, check, replay };
}

test('historical typed precheck keeps exact file origin after its source file disappears', t => {
  const f = graphPrecheckFixture(t, true), path = join(f.root, 'condition.txt');
  writeFileSync(path, 'The exact condition is retained.');
  const source = f.evidence.file('p', 'condition', f.root, 'condition.txt', 'text/plain', 0);
  const observations = [f.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: source.value.content.length })];
  const report = f.report('condition.txt');
  const captured = f.check(f.store, report, observations, 'current');
  assert.deepEqual(captured.findings, []);
  unlinkSync(path);
  const reopened = f.open();
  assert.deepEqual(f.replay(reopened, captured.proof, report, observations), [],
    'historical source membership uses captured bytes and canonical origin, not the present filesystem');
  assert.throws(() => f.check(reopened, report, observations, 'current'), { code: 'source_stale' },
    'new precheck must still reject a missing current file');
});

test('historical legacy path resolution survives changed symlink while current admission rejects the escape', t => {
  const f = graphPrecheckFixture(t, false), target = join(f.root, 'target.txt');
  writeFileSync(target, 'Original canonical target');
  symlinkSync('target.txt', join(f.root, 'alias.txt'));
  const source = f.evidence.file('p', 'alias', f.root, 'alias.txt', 'text/plain', 0);
  const observations = [f.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: source.value.content.length })];
  const report = f.report('alias.txt');
  const captured = f.check(f.store, report, observations, 'current');
  assert.deepEqual(captured.findings, []);
  assert.deepEqual(captured.legacyPaths, [{ path: 'alias.txt', resolved: target }]);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-escaped-target-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'outside.txt'), 'A different file');
  unlinkSync(join(f.root, 'alias.txt'));
  symlinkSync(join(outside, 'outside.txt'), join(f.root, 'alias.txt'));
  const reopened = f.open();
  assert.deepEqual(f.replay(reopened, captured.proof, report, observations, captured.legacyPaths), []);
  assert.ok(f.check(reopened, report, observations, 'current').findings.some(item => item.code === 'repository_evidence_required'));
  assert.ok(f.replay(reopened, captured.proof, report, observations,
    [{ path: 'alias.txt', resolved: join(outside, 'outside.txt') }]).some(item => item.code === 'repository_evidence_required'),
  'a forged historical resolution cannot make an outside target into the captured file');
});

test('a file citation outside the workspace fails even when no fact selects it', t => {
  const f = graphPrecheckFixture(t, true), path = join(f.root, 'inside.txt');
  writeFileSync(path, 'Inside fact');
  const inside = f.evidence.file('p', 'inside', f.root, 'inside.txt', 'text/plain', 0);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-foreign-citation-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'foreign.txt'), 'Unused foreign citation');
  const foreign = f.evidence.file('p', 'foreign', outside, 'foreign.txt', 'text/plain', 0);
  const observations = [inside, foreign].map(source => f.evidence.observe('p', reference(source),
    { kind: 'text-range', start: 0, end: source.value.content.length }));
  const report = f.report('inside.txt');
  const captured = f.check(f.store, report, observations, 'current');
  assert.ok(captured.findings.some(item => item.code === 'research_source_foreign'));
  assert.ok(f.replay(f.open(), captured.proof, report, observations).some(item => item.code === 'research_source_foreign'));
});

test('historical technical findings keep an absent actor, incomplete coverage and an unresolved current gap', t => {
  const f = graphPrecheckFixture(t, true), path = join(f.root, 'condition.txt');
  writeFileSync(path, 'The recorded local condition.');
  const source = f.evidence.file('p', 'condition', f.root, 'condition.txt', 'text/plain', 0);
  const observations = [f.evidence.observe('p', reference(source),
    { kind: 'text-range', start: 0, end: source.value.content.length })];
  const draft = f.store.get<any>('d84-graph-draft')!, question = f.store.get<Question>('d84-graph-question')!;
  f.store.write({ id: draft.id, kind: draft.kind, expected: draft.revision,
    value: { ...draft.value, obligationContract: 'evidence-v1' } });
  f.store.write<Question>({ id: question.id, kind: question.kind, expected: question.revision,
    value: { ...question.value, spec: { ...question.value.spec, obligationContract: 'evidence-v1',
      obligations: [{ id: 'required', target: 'node', field: 'tests', consumer: 'compilation' }] } } });
  const report: TechnicalReport = { ...f.report('condition.txt'),
    designs: [{ id: 'later-design', decision: 'Use the local result', benefit: 'A recorded output', consumer: 'later-actor' }],
    gaps: [{ id: 'still-open', target: 'node', field: 'tests', question: 'Prove the current condition',
      consumer: 'compilation', requiredFor: 'current' }], coverage: [] };
  const captured = f.check(f.store, report, observations, 'current');
  const codes = (findings: typeof captured.findings) => new Set(findings.map(item => item.code));
  assert.ok(codes(captured.findings).has('research_consumer_missing'));
  assert.ok(codes(captured.findings).has('research_group_coverage_missing'));
  assert.ok(codes(captured.findings).has('research_gap_unresolved'));
  f.store.write({ id: 'stage:p:discovery', kind: 'stage', expected: 0,
    value: { content: { fields: { preparation: { actors: [{ id: 'later-actor' }] } } } } });
  assert.equal(codes(f.check(f.store, report, observations, 'current').findings).has('research_consumer_missing'), false,
    'a new admission sees the newly added actor');
  const historical = codes(f.replay(f.open(), captured.proof, report, observations));
  for (const code of ['research_consumer_missing', 'research_group_coverage_missing', 'research_gap_unresolved'])
    assert.ok(historical.has(code), `the saved paid-era precheck retains ${code}`);
});

test('a paid assessor resumes its frozen origin after terminal application and a removed source file', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-assessor-origin-')));
  const database = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Frozen assessor origin' });
  const file = join(root, 'source.txt');
  writeFileSync(file, 'This exact local condition supports the proposed result.');
  const source = engine.discovery.evidence.file('p', 'source', root, 'source.txt', 'text/plain', 0);
  const wire = join(root, 'calls.ndjson'), adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),subject=request.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify({role:subject.role,requestId:request.requestId})+'\\n');
const research=subject.role==='assess-answer'?{verdict:'supported',reasons:[]}
 :{action:'answer',question:subject.questions[0].id,value:{ok:true},citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'text-range',start:0,end:${source.value.content.length}}}]};
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research,
 usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
    [{ field: 'result', kind: 'design', prompt: 'Resolve result', risk: 'Missing source', schema: { type: 'object' } }]);
  const original = store.writeMany.bind(store); let interrupted = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const rows = original(writes, guards);
    if (!interrupted && writes.some(write => write.kind === 'assessment-application'
      && (write.value as { state?: string }).state === 'applied')
      && writes.some(write => write.kind === 'assessment-session'
        && (write.value as { result?: unknown }).result !== null)) {
      interrupted = true;
      throw new EngineError('fixture_after_paid_assessor', 'The paid verdict was applied before its assessment binding');
    }
    return rows;
  }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 1);
  store.writeMany = original;
  assert.equal(interrupted, true);
  assert.equal(store.list('research-assessment-binding').length, 0);
  const pending = store.list<ResearchTurn>('research-turn')[0]!;
  const origin = readAssessmentPaidOrigin(store, 'p', reference(pending));
  assert.ok(origin);
  assert.equal(origin.value.root, root);
  assert.equal(origin.value.dispatch.workspace, root);
  const paidBefore = store.list<ModelCall>('model-call').filter(call => call.value.purpose === 'assessor').length;
  assert.equal(paidBefore, 1);
  unlinkSync(file);
  configureReaderPilot(store, engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command },
    agentCommand: command, maxCalls: 10, maxReportedTokens: 100000,
    maxRequestChars: 100000, maxReadChars: 60000, maxReplyChars: 10000 }, 0);
  const restarted = open();
  const resumed = await new ProductEngine(restarted).researcher.run('p', draft.id, 1);
  assert.equal(resumed.value.status, 'paused', JSON.stringify(resumed.value));
  assert.equal(resumed.value.pauseCode, 'research_not_supported',
    'the historical paid result survives, while new acceptance still checks present file support');
  const binding = restarted.list<any>('research-assessment-binding')[0]!;
  assert.ok(binding, 'the exact paid assessment is bound before current acceptance refuses');
  assert.deepEqual(readResearchAssessmentAt(restarted, 'p', pending.id, binding.value.assessment).value,
    restarted.get(binding.value.assessment.id, binding.value.assessment.revision)?.value);
  assert.equal(restarted.list<ModelCall>('model-call').filter(call => call.value.purpose === 'assessor').length, paidBefore,
    'the public retry reuses the exact paid application without rebuilding a new assessor request');
  assert.deepEqual(readAssessmentPaidOrigin(restarted, 'p', reference(pending))?.value, origin.value);
  const rewrite = (id: string, revision: number, value: unknown) => {
    const db = new DatabaseSync(database);
    try {
      db.exec('DROP TRIGGER IF EXISTS revisions_no_update');
      db.prepare('UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?')
        .run(canonical(value), hashJson(value), id, revision);
    } finally { db.close(); }
  };
  for (const altered of [
    { ...origin.value, root: join(root, 'other-root') },
    { ...origin.value, dispatch: { ...origin.value.dispatch, workspace: join(root, 'other-root') } },
    { ...origin.value, prompt: `${origin.value.prompt} changed` },
    { ...origin.value, profile: { id: 'reader-pilot:p', revision: 1, hash: '0'.repeat(64) } },
    { ...origin.value, reads: { ...origin.value.reads, files: [] } }
  ]) {
    rewrite(origin.id, origin.revision, altered);
    assert.throws(() => readResearchAssessmentAt(open(), 'p', pending.id, binding.value.assessment),
      { code: 'research_context_application_invalid' },
      'a rehashed final origin cannot rewrite the root, source view, reviewer packet or profile of the paid application');
    rewrite(origin.id, origin.revision, origin.value);
  }
});

for (const level of ['R1', 'R2'] as const) {
  test(`managed technical ${level} binds its paid assessor after graph, scope, draft and file heads change`, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `omg-d84-technical-${level.toLowerCase()}-`)));
    const database = join(root, 'state.sqlite'), stores: Store[] = [];
    const open = () => { const db = new Store(database); stores.push(db); return db; };
    t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
    const store = open(), engine = new ProductEngine(store);
    preparedFeatures(engine, 'p');
    writeFileSync(join(root, 'README.md'), 'The fixture product transforms local input into a validated output.\n');
    const sourcePath = join(root, 'condition.txt');
    writeFileSync(sourcePath, 'The original technical condition is retained in a file.\n');
    const source = engine.discovery.evidence.file('p', 'paid-technical-condition', root,
      'condition.txt', 'text/plain', 0);
    const report: TechnicalReport = {
      applicability: 'applicable', reason: 'The local file gives a bounded technical condition',
      facts: [{ id: 'condition', claim: 'The file records the original technical condition',
        ...(level === 'R2' ? { evidence: { kind: 'repository-file' as const, citation: 0 } }
          : { path: 'condition.txt' }) }],
      designs: [{ id: 'local-result', decision: 'Preserve the validated local result',
        benefit: 'Compilation consumes one recorded result', consumer: 'compilation' }],
      gaps: [], ...(level === 'R2' ? { documents: [] } : {})
    };
    const wire = join(root, 'calls.ndjson'), adapter = join(root, 'adapter.mjs');
    writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),subject=request.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify({role:subject.role,requestId:request.requestId})+'\\n');
const research=subject.role==='assess-answer'?{verdict:'supported',reasons:[]}
 :{action:'answer',question:subject.questions[0].id,value:${JSON.stringify(report)},
 citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'text-range',start:0,end:${source.value.content.length}}}]};
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research,
 usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
    const command = { executable: process.execPath, args: [adapter] };
    engine.environments.configure('p', { workspace: root,
      implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command },
      fullCheck: command, timeoutMs: 5000 }, 0);
    const r0 = engine.refinement.begin('p', 'R0');
    engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
    engine.refinement.sealLayer('p', 1, 0);
    let scope: ReturnType<typeof import('../src/graph/research-scope.js').configureResearchScope> | null = null;
    if (level === 'R2') {
      const { answerTechnicalFixture } = await import('./technical-research-fixture.js');
      const { deriveLayerFixture } = await import('./layer-design-fixture.js');
      const { configureResearchScope } = await import('../src/graph/research-scope.js');
      const r1 = engine.refinement.begin('p', 'R1');
      answerTechnicalFixture(engine, 'p', r1);
      engine.refinement.finishResearch('p', 'R1', reference(store.get(r1.id)!), 0);
      deriveLayerFixture(engine, 'p', 2);
      engine.refinement.sealLayer('p', 2, 0);
      scope = configureResearchScope(store, { projectId: 'p', layer: reference(store.get('graph-layer:p:2')!),
        r1: reference(store.get('phase:p:R1')!), outcome: 'Preserve a validated local result',
        nodes: [store.get<Graph>('graph:p')!.value.nodes.find(node => node.kind === 'product')!.id],
        boundaries: [], expansions: [], obligations: [], changedPaths: [], uiRequired: false }, 0);
    }
    const draft = engine.refinement.begin('p', level);
    const question = store.get<Question>(draft.value.questions[0]!)!;
    assert.equal(question.value.spec.field, level === 'R1' ? 'productDomain' : 'contractsAndConsumers');
    const original = store.writeMany.bind(store); let interrupted = false;
    store.writeMany = ((writes: Write[], guards = []) => {
      const rows = original(writes, guards);
      if (!interrupted && writes.some(write => write.kind === 'assessment-application'
        && (write.value as { state?: string }).state === 'applied')
        && writes.some(write => write.kind === 'assessment-session'
          && (write.value as { result?: unknown }).result !== null)) {
        interrupted = true;
        throw new EngineError('fixture_after_technical_assessor', 'The paid terminal result was saved before binding');
      }
      return rows;
    }) as typeof store.writeMany;
    try { await engine.researcher.run('p', draft.id, 1); }
    finally { store.writeMany = original; }
    assert.equal(interrupted, true, 'the real adapter reached terminal assessor application');
    assert.equal(store.list('research-assessment-binding').length, 0);
    const pending = store.list<ResearchTurn>('research-turn').find(turn => turn.value.question?.id === question.id)!;
    assert.equal(pending.value.status, 'pending');
    const paidOrigin = readAssessmentPaidOrigin(store, 'p', reference(pending));
    assert.ok(paidOrigin);
    const originalGraph = paidOrigin.value.graph;
    assert.deepEqual(originalGraph, reference(store.get('graph:p')!));
    const originalScope = scope && reference(scope);
    const calls = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { role: string; requestId: string });
    assert.deepEqual(calls().map(call => call.role), ['research', 'assess-answer']);
    const assessorCalls = () => store.list<ModelCall>('model-call').filter(call => call.value.purpose === 'assessor');
    assert.equal(assessorCalls().length, 1);
    assert.equal(assessorCalls()[0]!.value.status, 'succeeded');

    const sibling = store.get<Question>(draft.value.questions[1]!)!;
    engine.discovery.decision(sibling.id, sibling.revision, 'owner', report as unknown as import('../src/canonical.js').Json);
    assert.ok(store.get(draft.id)!.revision > draft.revision, 'the discovery head advanced independently');
    const graph = store.get<Graph>('graph:p')!;
    engine.graphs.save('p', { ...graph.value, title: `${graph.value.title} after paid assessment` },
      graph.revision, 'fixture-author');
    assert.notDeepEqual(reference(store.get('graph:p')!), originalGraph);
    if (scope) {
      const { configureResearchScope } = await import('../src/graph/research-scope.js');
      const advanced = configureResearchScope(store, { ...scope.value,
        layer: reference(store.get('graph-layer:p:2')!), changedPaths: ['after-paid.txt'] }, scope.revision);
      assert.notDeepEqual(reference(advanced), originalScope);
    }
    unlinkSync(sourcePath);
    const restarted = open();
    const resumed = await new ProductEngine(restarted).researcher.run('p', draft.id, 1);
    assert.equal(resumed.value.status, 'paused', JSON.stringify(resumed.value));
    assert.equal(resumed.value.pauseCode, 'research_not_supported',
      'the historical paid result binds, while current acceptance rejects the missing file');
    const binding = restarted.list<any>('research-assessment-binding')[0]!;
    assert.ok(binding);
    const assessment = readResearchAssessmentAt(open(), 'p', pending.id, binding.value.assessment);
    assert.equal(assessment.value.verdict, 'supported');
    assert.deepEqual(assessment.value.value, report);
    assert.deepEqual(reference(assessment), binding.value.assessment);
    assert.deepEqual(readAssessmentPaidOrigin(open(), 'p', reference(pending))?.value, paidOrigin.value);
    assert.deepEqual(calls().map(call => call.role), ['research', 'assess-answer'],
      'cold retry must neither repeat the analyst nor pay the assessor again');
    assert.equal(assessorCalls().length, 1);

    // A rehashed saved origin must not substitute the newer graph for the paid proposal's graph.
    const forgedOrigin = { ...paidOrigin.value, graph: reference(store.get('graph:p')!) };
    const rewriteOrigin = (value: unknown) => {
      const db = new DatabaseSync(database);
      try {
        db.exec('DROP TRIGGER IF EXISTS revisions_no_update');
        db.prepare('UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?')
          .run(canonical(value), hashJson(value), paidOrigin.id, paidOrigin.revision);
      } finally { db.close(); }
    };
    rewriteOrigin(forgedOrigin);
    try {
      assert.throws(() => readResearchAssessmentAt(open(), 'p', pending.id, binding.value.assessment),
        (error: unknown) => error instanceof EngineError
          && ['research_context_application_invalid', 'research_assessment_binding_invalid'].includes(error.code),
        'a current graph with a valid hash cannot masquerade as the original paid technical graph');
    } finally { rewriteOrigin(paidOrigin.value); }
  });
}

test('saved runtime proof derives from exact observation, declaration, code and paid citation after heads move', async t => {
  const { configureResearchScope, scopedQuestions } = await import('../src/graph/research-scope.js');
  const { withObligationEvidence } = await import('../src/graph/obligation-evidence.js');
  const { collectRuntimeEvidence, collectRuntimeSelection, readRuntimeEvidenceAt, projectRuntimeSupportAt } = await import('../src/graph/runtime-evidence.js');
  const { uniqueRefs } = await import('../src/pipeline/contracts.js');
  const { assessmentSessionWithProof, checkAssessmentRuntimeMaterials } = await import('../src/discovery/assessment-session.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-runtime-proof-')));
  const store = new Store(join(root, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Pinned runtime proof' });
  const graph = { nodes: [{ id: 'n', code: [] }], horizon: [], connectors: [], tests: [], anchors: [] } as unknown as Graph;
  store.write({ id: 'graph:p', kind: 'graph', expected: 0, value: graph });
  const layer = store.write({ id: 'graph-layer:p:2', kind: 'graph-layer', expected: 0, value: { projection: graph } });
  const gap = { id: 'boundary', target: 'n', field: 'code', consumer: 'compilation', requiredFor: 'next' as const,
    question: 'Record the actual fixture invocation' };
  const r1 = store.write({ id: 'runtime-r1', kind: 'discovery-draft', expected: 0,
    value: { projectId: 'p', fields: { technical: { gaps: [gap] } } } });
  const phase = store.write({ id: 'phase:p:R1', kind: 'phase', expected: 0, value: { draft: reference(r1) } });
  const original = configureResearchScope(store, { projectId: 'p', layer: reference(layer), r1: reference(phase),
    outcome: 'Keep the exact observed result', nodes: ['n'], boundaries: [], expansions: [], changedPaths: [], uiRequired: false,
    obligations: [{ gap, state: 'active', reason: 'Original requirement', wake: null }] }, 0);
  writeFileSync(join(root, 'check.mjs'), "console.log('observed fixture result')\n");
  const code = engine.discovery.evidence.file('p', 'runtime-check', root, 'check.mjs', 'text/plain', 0);
  const check = { script: reference(code), dependencies: [], subjects: [], executables: [], args: [], timeoutMs: 4000,
    purpose: 'Observe the exact fixture invocation' };
  const scope = configureResearchScope(store, { ...original.value, policy: { version: 1, sourceScope: reference(original),
    assignments: [{ obligation: gap.id, original: { record: reference(original), pointer: '/obligations/0/gap' },
      kind: 'environment-confirmation' as const, moment: 'R2' as const, responsibleNode: 'n',
      responsibleConsumer: 'compilation', neededForR2: true, reason: 'Observe actual execution', returnCondition: null,
      runtimeCheck: check }] } }, 1);
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const spec = withObligationEvidence(withTypedBasis(scopedQuestions(scope.value).find(item => item.obligations)!));
  const draft = engine.discovery.create('p', 'om-g2', 'R2', 'compilation', [spec], [reference(scope)], 2);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const observed = await engine.execute({ type: 'observe-runtime', project: 'p', scope: reference(scope),
    obligation: 'boundary', key: 'proof' }) as import('../src/runtime/runtime-observation.js').RuntimeObservationResult;
  assert.ok(observed.source);
  const cited = new Evidence(store).observe('p', reference(observed.source), { kind: 'json-pointer', pointer: '/result/stdout' });
  const report: TechnicalReport = { applicability: 'applicable', reason: 'The command completed', facts: [],
    designs: [{ id: 'd', decision: 'Use the observed result', benefit: 'An exact fixture result exists', consumer: 'compilation' }],
    gaps: [], documents: [{ id: 'runtime', claim: 'The command emitted its result', kind: 'document-observation',
      citation: 0, quote: String(cited.value).trim(), designs: ['d'], gaps: [] }],
    coverage: [{ obligation: 'boundary', facts: [], designs: ['d'], gaps: [] }] };
  const savedSelection = collectRuntimeSelection(store, 'p', spec, report, [cited]), saved = savedSelection.runtime;
  assert.deepEqual(saved, collectRuntimeEvidence(store, 'p', spec, report, [cited]), 'the D8.4c result is the selection\'s runtime');
  assert.equal(saved.proofs.length, 1);
  assert.equal(saved.supporting.length, 2);
  assert.deepEqual(readRuntimeEvidenceAt(store, 'p', spec, report, [cited], saved), saved);
  assert.deepEqual(readRuntimeEvidenceAt(store, 'p', spec, report, [cited], saved, savedSelection.admission), saved);
  const context = { role: 'assess-answer', question: spec, value: report, runtimeProofs: saved.proofs,
    observations: [cited, ...saved.supporting] };
  const pending = store.write({ id: 'research-turn:runtime-proof-fixture', kind: 'research-turn', expected: 0,
    value: { action: { action: 'answer', question: question.id, value: report,
      citations: [{ source: cited.source, selector: cited.selector }] }, status: 'pending', question: reference(question) } });
  const paidInput = { pending: reference(pending), root, graph: null, legacyPaths: [],
    reads: { contract: 'assessment-read/v1', reads: [], files: [] } as any, runtime: saved, runtimeAdmission: savedSelection.admission };
  const originalWriteMany = store.writeMany.bind(store);
  store.writeMany = ((writes: Write[], guards = []) => {
    const rows = originalWriteMany(writes, guards);
    if (writes.some(write => write.kind === 'assessment-paid-origin'))
      throw new EngineError('fixture_after_runtime_origin', 'The exact origin was saved before dispatch');
    return rows;
  }) as typeof store.writeMany;
  try {
    await assert.rejects(assessmentSessionWithProof(store, draft, question, environment, environment.value, undefined,
      context, 'Assess the exact saved runtime result', undefined, [], paidInput),
    { code: 'fixture_after_runtime_origin' });
  } finally { store.writeMany = originalWriteMany; }
  const originalOrigin = readAssessmentPaidOrigin(store, 'p', reference(pending));
  assert.ok(originalOrigin, 'the valid shared projection permits the origin write before dispatch');
  assert.equal(store.list('model-call').length, 0);
  const fullCitation = new Evidence(store).observe('p', reference(observed.source), { kind: 'json-pointer', pointer: '' });
  const extraCitations = [cited, fullCitation];
  const extraSelection = collectRuntimeSelection(store, 'p', spec, report, extraCitations), extraRuntime = extraSelection.runtime;
  assert.equal(extraRuntime.supporting.length, 1, 'a genuine full citation suppresses only the duplicate supporting quote');
  const extraPending = store.write({ id: 'research-turn:runtime-extra-citation', kind: 'research-turn', expected: 0,
    value: { action: { action: 'answer', question: question.id, value: report,
      citations: extraCitations.map(item => ({ source: item.source, selector: item.selector })) },
      status: 'pending', question: reference(question) } });
  const extraContext = { ...context, observations: [...extraCitations, ...extraRuntime.supporting],
    runtimeProofs: extraRuntime.proofs };
  store.writeMany = ((writes: Write[], guards = []) => {
    const rows = originalWriteMany(writes, guards);
    if (writes.some(write => write.kind === 'assessment-paid-origin'))
      throw new EngineError('fixture_after_runtime_origin', 'The exact origin was saved before dispatch');
    return rows;
  }) as typeof store.writeMany;
  try {
    await assert.rejects(assessmentSessionWithProof(store, draft, question, environment, environment.value, undefined,
      extraContext, 'Assess the exact saved runtime result', undefined, [],
      { ...paidInput, pending: reference(extraPending), runtime: extraRuntime, runtimeAdmission: extraSelection.admission }),
    { code: 'fixture_after_runtime_origin' });
  } finally { store.writeMany = originalWriteMany; }
  const extraOrigin = readAssessmentPaidOrigin(store, 'p', reference(extraPending));
  assert.ok(extraOrigin);
  const oldTmpdir = process.env.TMPDIR;
  t.after(() => { if (oldTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmpdir; });
  process.env.TMPDIR = root;
  const laterObserved = await engine.execute({ type: 'observe-runtime', project: 'p', scope: reference(scope),
    obligation: 'boundary', key: 'other-runtime-binding' }) as import('../src/runtime/runtime-observation.js').RuntimeObservationResult;
  assert.ok(laterObserved.source);
  const laterCitation = new Evidence(store).observe('p', reference(laterObserved.source),
    { kind: 'json-pointer', pointer: '/result/stdout' });
  const mixedReport: TechnicalReport = { ...report, documents: [report.documents![0]!,
    { ...report.documents![0]!, id: 'runtime-second', citation: 1 }] };
  const firstSupport = projectRuntimeSupportAt(store, 'p', spec.obligations![0]!.assignment!, cited.source);
  const secondSupport = projectRuntimeSupportAt(store, 'p', spec.obligations![0]!.assignment!, laterCitation.source);
  assert.ok(firstSupport && secondSupport);
  assert.notDeepEqual(firstSupport.record.value.runtimeBinding, secondSupport.record.value.runtimeBinding);
  assert.equal(collectRuntimeEvidence(store, 'p', spec, mixedReport, [cited, laterCitation]).proofs.length, 1,
    'the current collector admits only the observation matching its entire runtime binding');
  const mixedRuntime = { ...saved,
    proofs: [saved.proofs[0]!, { ...saved.proofs[0]!, document: 'runtime-second',
      observation: reference(secondSupport.record), source: laterCitation.source }],
    supporting: [...saved.supporting, secondSupport.full],
    guards: uniqueRefs([...saved.guards, ...secondSupport.guards]) };
  assert.throws(() => readRuntimeEvidenceAt(store, 'p', spec, mixedReport, [cited, laterCitation], mixedRuntime),
    { code: 'runtime_evidence_invalid' },
    'two observed results with different saved process environments cannot form one paid runtime result');
  if (oldTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmpdir;
  const { projectId: _projectId, ...settings } = environment.value;
  engine.environments.configure('p', { ...settings, implementer: { ...settings.implementer, model: 'later' } }, 1);
  engine.discovery.evidence.file('p', 'runtime-check', root, 'check.mjs', 'text/plain', code.revision);
  unlinkSync(join(root, 'check.mjs'));
  // After the environment, Source heads and files moved the current derivation lawfully differs; the historical replay
  // derives the original selection from the saved admission material alone (№2141).
  assert.throws(() => readRuntimeEvidenceAt(store, 'p', spec, report, [cited], saved), { code: 'runtime_evidence_invalid' },
    'without the material a replay is only the current derivation, and today\'s admission moved');
  assert.deepEqual(readRuntimeEvidenceAt(store, 'p', spec, report, [cited], saved, savedSelection.admission), saved,
    'historical projection reads exact old Sources after their heads and files change');
  assert.deepEqual(readAssessmentPaidOrigin(store, 'p', reference(pending))?.value, originalOrigin.value,
    'the paid origin stays readable after environment, Source and filesystem changes');
  assert.deepEqual(readAssessmentPaidOrigin(store, 'p', reference(extraPending))?.value, extraOrigin.value);

  const fakeSource = reference(code);
  const mutations: [string, (value: typeof saved) => typeof saved][] = [
    ['source', value => ({ ...value, proofs: [{ ...value.proofs[0]!, source: fakeSource }] })],
    ['authorization', value => ({ ...value, proofs: [{ ...value.proofs[0]!, authorization: reference(environment) }] })],
    ['obligation', value => ({ ...value, proofs: [{ ...value.proofs[0]!, obligation: 'other' }] })],
    ['document', value => ({ ...value, proofs: [{ ...value.proofs[0]!, document: 'other' }] })],
    ['code', value => ({ ...value, proofs: [{ ...value.proofs[0]!, code: [reference(observed.source!)] }] })],
    ['supporting', value => ({ ...value, supporting: [{ ...value.supporting[0]!, source: fakeSource }, ...value.supporting.slice(1)] })],
    ['guards', value => ({ ...value, guards: value.guards.filter(guard => guard.id !== observed.source!.id) })],
  ];
  for (const [name, mutate] of mutations) {
    const changed = mutate(saved);
    const rehashed = store.write<typeof saved>({ id: `runtime-proof-forgery:${name}`, kind: 'runtime-proof-forgery',
      expected: 0, value: changed });
    assert.equal(rehashed.hash, hashJson(changed));
    assert.throws(() => readRuntimeEvidenceAt(store, 'p', spec, report, [cited], rehashed.value, savedSelection.admission),
      { code: 'runtime_evidence_invalid' }, `${name} must not gain authority through a consistent Store hash`);
  }

  const rewriteOrigin = (origin: typeof originalOrigin, value: unknown) => {
    const db = new DatabaseSync(store.path);
    try {
      db.exec('DROP TRIGGER IF EXISTS revisions_no_update');
      db.prepare('UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?')
        .run(canonical(value), hashJson(value), origin.id, origin.revision);
    } finally { db.close(); }
  };
  for (const [name, value] of [
    ['runtime source', { ...originalOrigin.value, runtime: mutations[0]![1](saved) }],
    ['report', { ...originalOrigin.value, context: { ...context, value: { ...report, reason: 'Other report' } } }],
    ['question', { ...originalOrigin.value, context: { ...context, question: { ...spec, field: 'other' } } }],
    ['packet proof', { ...originalOrigin.value, context: { ...context, runtimeProofs: [] } }],
  ] as const) {
    rewriteOrigin(originalOrigin, value);
    try {
      assert.throws(() => readAssessmentPaidOrigin(store, 'p', reference(pending)),
        { code: 'research_context_application_invalid' }, `the historical reader rejects rehashed ${name} substitution`);
    } finally { rewriteOrigin(originalOrigin, originalOrigin.value); }
  }
  const forgedFullCitation = { ...fullCitation, value: { forged: true } };
  const forgedExtraContext = { ...extraContext,
    observations: [cited, forgedFullCitation, ...extraRuntime.supporting] };
  rewriteOrigin(extraOrigin, { ...extraOrigin.value, context: forgedExtraContext });
  try {
    assert.throws(() => readAssessmentPaidOrigin(store, 'p', reference(extraPending)),
      { code: 'research_context_application_invalid' },
      'a rehashed unused full citation cannot suppress the authentic supporting quote after restart');
  } finally { rewriteOrigin(extraOrigin, extraOrigin.value); }

  const badPending = store.write({ id: 'research-turn:runtime-proof-forgery', kind: 'research-turn', expected: 0,
    value: { action: { action: 'answer', question: question.id, value: report,
      citations: [{ source: cited.source, selector: cited.selector }] }, status: 'pending', question: reference(question) } });
  const malformed = { ...saved, proofs: [{ ...saved.proofs[0]!, authorization: reference(environment) }] };
  await assert.rejects(assessmentSessionWithProof(store, draft, question, environment, environment.value, undefined,
    context,
    'Assess the exact saved runtime result', undefined, [], {
      pending: reference(badPending), root, graph: null, legacyPaths: [],
      reads: { contract: 'assessment-read/v1', reads: [], files: [] } as any, runtime: malformed, runtimeAdmission: savedSelection.admission }),
  { code: 'research_context_application_invalid' }, 'the paid-origin producer must refuse before assessor dispatch');
  for (const [name, altered] of [
    ['report', { ...context, value: { ...report, reason: 'Other report' } }],
    ['question', { ...context, question: { ...spec, field: 'other' } }],
    ['packet proof', { ...context, runtimeProofs: [] }],
  ] as const) {
    await assert.rejects(assessmentSessionWithProof(store, draft, question, environment, environment.value, undefined,
      altered, 'Assess the exact saved runtime result', undefined, [], { ...paidInput, pending: reference(badPending) }),
    { code: 'research_context_application_invalid' }, `${name} substitution is rejected before dispatch`);
  }
  const extraBadPending = store.write({ id: 'research-turn:runtime-extra-forgery', kind: 'research-turn', expected: 0,
    value: { action: { action: 'answer', question: question.id, value: report,
      citations: extraCitations.map(item => ({ source: item.source, selector: item.selector })) },
      status: 'pending', question: reference(question) } });
  await assert.rejects(assessmentSessionWithProof(store, draft, question, environment, environment.value, undefined,
    forgedExtraContext, 'Assess the exact saved runtime result', undefined, [],
    { ...paidInput, pending: reference(extraBadPending), runtime: extraRuntime, runtimeAdmission: extraSelection.admission }),
  { code: 'research_context_application_invalid' },
  'an unused full citation with forged value is rejected before assessor dispatch');
  assert.equal(store.list('model-call').length, 0);
  assert.deepEqual(store.list('assessment-paid-origin').map(record => record.id).sort(),
    [originalOrigin.id, extraOrigin.id].sort(),
    'the forged paid turn creates no origin');
  assert.throws(() => checkAssessmentRuntimeMaterials(store, 'p',
    { ...saved, admissionGuards: [null] } as any, 'malformed-runtime'),
  { code: 'research_context_application_invalid' }, 'malformed admission guards receive a typed refusal');
});

test('a paid L3 layer drift becomes an exact correctable refusal across restart', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-layer-refusal-')));
  const database = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  const full = enrichedGraph(exampleGraph('p'), 'p');
  preparedFeatures(engine, 'p', full);
  const { level: _level, ...initial } = projectGraph(full, 1);
  engine.graphs.save('p', initial, store.get('graph:p')!.revision, 'fixture');
  writeFileSync(join(root, 'README.md'), 'A local scoped transformation with an atomic result and recovery.\n');
  const adapter = join(root, 'adapter.mjs'), replies = join(root, 'replies.json'), wire = join(root, 'wire.ndjson');
  writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,f=JSON.parse(readFileSync(${JSON.stringify(replies)},'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify({role:s.role,mode:s.dispatchMode,previous:s.previousProposalRef??null})+'\\n');
const research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}
 :s.dispatchMode==='planning'?{action:'synthesize',question:s.question.id}
 :{action:'answer_delta',question:s.question.id,base:s.graphBase,
   ...(s.previousProposalRef?{...f.correction,revises:s.previousProposalRef}:f.first),citations:f.citations};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,
 usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', {
    experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command },
    agentCommand: command, maxRequestChars: 100000, maxReadChars: 60000,
    maxReplyChars: 100000, maxCalls: 12, maxReportedTokens: 100000,
    planning: { fields: ['layerDesign'], maxRequestChars: 100000, maxRounds: 3 } }, 0);
  configurePhasePolicy(store, 'p', 'L3', 'layer-refusal', 0);
  const calibrated = pilotEnvironment(engine.environments.get('p').value, pilot.value);
  for (const [purpose, role] of [['reading-planner', calibrated.implementer],
    ['analyst', calibrated.implementer],
    ['assessor', calibrated.reviewer]] as const) {
    store.write<ModelCall>({ id: `model-call:layer-calibration-${purpose}`, kind: 'model-call', expected: 0,
      value: { projectId: 'p', draftId: 'fixture', purpose, requestId: `layer-calibration-${purpose}`,
        startedAt: 0, finishedAt: 1, status: 'succeeded', requested: role,
        confirmed: { model: null, effort: null, speed: null },
        request: { chars: 1000, bytes: 1000, hash: hashJson(purpose) }, response: null,
        usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 0, reasoningOutputTokens: 0 },
        usageSource: 'adapter', error: null } });
  }
  const r0 = engine.refinement.begin('p', 'R0');
  engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
  engine.refinement.sealLayer('p', 1, 0);
  const r1 = engine.refinement.begin('p', 'R1');
  answerTechnicalFixture(engine, 'p', r1);
  engine.refinement.finishResearch('p', 'R1', reference(store.get(r1.id)!), 0);
  const l2 = engine.refinement.prepareLayer('p', 2);
  const ready2 = answerLayerFixture(engine, 'p', l2, 2, full);
  engine.refinement.buildLayer('p', 2, reference(ready2), store.get('graph:p')!.revision, 'fixture');
  engine.refinement.sealLayer('p', 2, 0);
  configureResearchScope(store, { projectId: 'p', layer: reference(store.get('graph-layer:p:2')!),
    r1: reference(store.get('phase:p:R1')!), outcome: 'Validated local output',
    nodes: full.nodes.filter(node => node.kind === 'operation').map(node => node.id),
    boundaries: [], expansions: [], obligations: [], changedPaths: [], uiRequired: false }, 0);
  const r2 = engine.refinement.begin('p', 'R2');
  answerTechnicalFixture(engine, 'p', r2);
  engine.refinement.finishResearch('p', 'R2', reference(store.get(r2.id)!), 0);
  const draft = engine.refinement.prepareLayer('p', 3);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const source = engine.discovery.evidence.document('p', 'design-source',
    'The accepted layer and proposed atomic work share the same product scope.', 'text/plain', 0);
  const citations = [{ source: reference(source), selector: { kind: 'text-range', start: 0, end: source.value.content.length } }];
  const delta = layerDeltaView(store, 'p', layerDesignOf(full, 3, question.value.spec.layerAssembly),
    3, question.value.spec.layerAssembly);
  const block = full.nodes.find(node => node.kind === 'block')!;
  const first = { horizon: delta.horizon,
    upserts: { ...delta.upserts, nodes: [...(delta.upserts.nodes ?? []),
      { id: block.id, purpose: 'Silent rewrite of accepted upper meaning' }] },
    removes: delta.removes };
  const correction = { upserts: { nodes: [{ id: block.id, purpose: block.purpose }] }, removes: {} };
  writeFileSync(replies, JSON.stringify({ first, correction, citations }));

  const result = await engine.researcher.run('p', draft.id, 4);
  assert.equal(result.value.status, 'completed', JSON.stringify(store.list<ResearchTurn>('research-turn')
    .filter(turn => turn.value.run === result.id).map(turn => ({ number: turn.value.number,
      action: turn.value.action, error: turn.value.error, status: turn.value.status,
      observation: turn.value.observation }))));
  const drift = store.list<ResearchTurn>('research-turn').find(turn =>
    (turn.value.observation as {code?: string} | null)?.code === 'upper_layer_drift');
  assert.ok(drift, 'the first paid answer has a deterministic completed refusal');
  assert.equal(drift.value.status, 'completed');
  const corrected = store.list<ResearchTurn>('research-turn').find(turn =>
    (turn.value.action as {revises?: unknown}).revises
      && canonical((turn.value.action as {revises: unknown}).revises) === canonical(reference(drift)));
  assert.ok(corrected, 'the second answer corrects the exact refused proposal');
  assert.equal(corrected.value.error, null);
  const sent = readFileSync(wire, 'utf8').trim().split('\n').length;
  const cold = open();
  assert.deepEqual(readResearchConsumerTurn(cold, reference(drift)), drift);
  assert.equal((await new ProductEngine(cold).researcher.run('p', draft.id, 4)).value.status, 'completed');
  assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, sent,
    're-reading the accepted result sends no new model request');

  const altered = { ...drift.value, error: 'Invented design rejection',
    observation: { code: 'upper_layer_drift', details: { invented: true } } };
  const db = new DatabaseSync(database);
  try {
    db.exec('DROP TRIGGER IF EXISTS revisions_no_update');
    db.prepare('UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?')
      .run(canonical(altered), hashJson(altered), drift.id, drift.revision);
  } finally { db.close(); }
  assert.throws(() => readResearchConsumerTurn(open(), { ...reference(drift), hash: hashJson(altered) }),
    { code: 'research_consumer_intent_invalid' },
    'a rehashed saved error cannot impersonate the refusal derived from the paid delta');
});

test('a paid full L3 answer is corrected from its exact graph and rejects a forged refusal', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-full-layer-refusal-')));
  const database = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  const full = enrichedGraph(exampleGraph('p'), 'p');
  preparedFeatures(engine, 'p', full);
  const { level: _level, ...initial } = projectGraph(full, 1);
  engine.graphs.save('p', initial, store.get('graph:p')!.revision, 'fixture');
  writeFileSync(join(root, 'README.md'), 'An accepted scoped transformation with an atomic result.\n');
  const adapter = join(root, 'adapter.mjs'), replies = join(root, 'replies.json'), wire = join(root, 'wire.ndjson');
  writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,f=JSON.parse(readFileSync(${JSON.stringify(replies)},'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify({role:s.role,history:s.history?.length??0})+'\\n');
const q=s.questions?.[0],failed=(s.corrections??[]).some(t=>t.error&&t.question===q?.id);
const research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}
 :{action:'answer',question:q.id,value:failed?f.corrected:f.first,citations:f.citations};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,
 usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const r0 = engine.refinement.begin('p', 'R0');
  engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
  engine.refinement.sealLayer('p', 1, 0);
  const r1 = engine.refinement.begin('p', 'R1');
  answerTechnicalFixture(engine, 'p', r1);
  engine.refinement.finishResearch('p', 'R1', reference(store.get(r1.id)!), 0);
  const l2 = engine.refinement.prepareLayer('p', 2);
  const ready2 = answerLayerFixture(engine, 'p', l2, 2, full);
  engine.refinement.buildLayer('p', 2, reference(ready2), store.get('graph:p')!.revision, 'fixture');
  engine.refinement.sealLayer('p', 2, 0);
  configureResearchScope(store, { projectId: 'p', layer: reference(store.get('graph-layer:p:2')!),
    r1: reference(store.get('phase:p:R1')!), outcome: 'Validated local output',
    nodes: full.nodes.filter(node => node.kind === 'operation').map(node => node.id),
    boundaries: [], expansions: [], obligations: [], changedPaths: [], uiRequired: false }, 0);
  const r2 = engine.refinement.begin('p', 'R2');
  answerTechnicalFixture(engine, 'p', r2);
  engine.refinement.finishResearch('p', 'R2', reference(store.get(r2.id)!), 0);
  const draft = engine.refinement.prepareLayer('p', 3);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const source = engine.discovery.evidence.document('p', 'design-source',
    'The accepted layer and proposed atomic work share the same product scope.', 'text/plain', 0);
  const citations = [{ source: reference(source), selector: { kind: 'text-range', start: 0, end: source.value.content.length } }];
  const corrected = layerDesignOf(full, 3, question.value.spec.layerAssembly) as Record<string, any>;
  const first = structuredClone(corrected);
  first.nodes.find((node: {kind:string}) => node.kind === 'block').purpose = 'Silent rewrite of accepted upper meaning';
  writeFileSync(replies, JSON.stringify({ first, corrected, citations }));

  const result = await engine.researcher.run('p', draft.id, 4);
  assert.equal(result.value.status, 'completed', JSON.stringify(store.list<ResearchTurn>('research-turn')
    .filter(turn => turn.value.run === result.id).map(turn => ({ number: turn.value.number,
      action: (turn.value.action as {action?:string}).action, error: turn.value.error,
      observation: turn.value.observation }))));
  const drift = store.list<ResearchTurn>('research-turn').find(turn => turn.value.run === result.id
    && (turn.value.observation as {code?:string} | null)?.code === 'upper_layer_drift');
  assert.ok(drift, 'the first full answer has a deterministic completed refusal');
  assert.equal(drift.value.status, 'completed');
  const correction = store.list<ResearchTurn>('research-turn').find(turn => turn.value.run === result.id
    && turn.value.number > drift.value.number && turn.value.error === null
    && (turn.value.action as {action?:string}).action === 'answer');
  assert.ok(correction, 'the second full answer corrects the refused design');
  const sent = readFileSync(wire, 'utf8').trim().split('\n').length;
  const cold = open();
  assert.deepEqual(readResearchConsumerTurn(cold, reference(drift)), drift);
  assert.equal((await new ProductEngine(cold).researcher.run('p', draft.id, 4)).value.status, 'completed');
  assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, sent,
    're-reading the accepted result sends no new model request');

  const altered = { ...drift.value, error: 'Invented design rejection',
    observation: { code: 'upper_layer_drift', details: { invented: true } } };
  const db = new DatabaseSync(database);
  try {
    db.exec('DROP TRIGGER IF EXISTS revisions_no_update');
    db.prepare('UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?')
      .run(canonical(altered), hashJson(altered), drift.id, drift.revision);
  } finally { db.close(); }
  assert.throws(() => readResearchConsumerTurn(open(), { ...reference(drift), hash: hashJson(altered) }),
    { code: 'research_consumer_intent_invalid' },
    'a rehashed error cannot impersonate the refusal derived from the paid full answer');
});

// ═══ Возврат №1 вердикта №2059: один класс — история/восстановление не должны
// читать сегодняшние головы, а отсутствие части не выбирает другую эру.

test('historical runtime replay reproduces a lawful one-of-two selection', async t => {
  // reviewer-runtime-choice.mjs (R5/№1318-1)
  const { configureResearchScope, scopedQuestions } = await import('../src/graph/research-scope.js');
  const { withObligationEvidence } = await import('../src/graph/obligation-evidence.js');
  const { collectRuntimeEvidence, readRuntimeEvidenceAt } = await import('../src/graph/runtime-evidence.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-runtime-choice-')));
  const store = new Store(join(root, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Pinned runtime proof' });
  const graph = { nodes: [{ id: 'n', code: [] }], horizon: [], connectors: [], tests: [], anchors: [] } as unknown as Graph;
  store.write({ id: 'graph:p', kind: 'graph', expected: 0, value: graph });
  const layer = store.write({ id: 'graph-layer:p:2', kind: 'graph-layer', expected: 0, value: { projection: graph } });
  const gap = { id: 'boundary', target: 'n', field: 'code', consumer: 'compilation', requiredFor: 'next' as const,
    question: 'Record the actual fixture invocation' };
  const r1 = store.write({ id: 'runtime-r1', kind: 'discovery-draft', expected: 0,
    value: { projectId: 'p', fields: { technical: { gaps: [gap] } } } });
  const phase = store.write({ id: 'phase:p:R1', kind: 'phase', expected: 0, value: { draft: reference(r1) } });
  const original = configureResearchScope(store, { projectId: 'p', layer: reference(layer), r1: reference(phase),
    outcome: 'Keep the exact observed result', nodes: ['n'], boundaries: [], expansions: [], changedPaths: [], uiRequired: false,
    obligations: [{ gap, state: 'active', reason: 'Original requirement', wake: null }] }, 0);
  writeFileSync(join(root, 'check.mjs'), "console.log('observed fixture result')\n");
  const code = engine.discovery.evidence.file('p', 'runtime-check', root, 'check.mjs', 'text/plain', 0);
  const check = { script: reference(code), dependencies: [], subjects: [] as string[], executables: [] as string[],
    args: [], timeoutMs: 4000, purpose: 'Observe the exact fixture invocation' };
  const scope = configureResearchScope(store, { ...original.value, policy: { version: 1 as const, sourceScope: reference(original),
    assignments: [{ obligation: gap.id, original: { record: reference(original), pointer: '/obligations/0/gap' },
      kind: 'environment-confirmation' as const, moment: 'R2' as const, responsibleNode: 'n',
      responsibleConsumer: 'compilation', neededForR2: true, reason: 'Observe actual execution', returnCondition: null,
      runtimeCheck: check }] } }, 1);
  const command = { executable: process.execPath, args: ['--version'] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const spec = withObligationEvidence(withTypedBasis(scopedQuestions(scope.value).find(item => item.obligations)!));
  engine.discovery.create('p', 'om-g2', 'R2', 'compilation', [spec], [reference(scope)], 2);
  const observed = await engine.execute({ type: 'observe-runtime', project: 'p', scope: reference(scope),
    obligation: 'boundary', key: 'proof' }) as import('../src/runtime/runtime-observation.js').RuntimeObservationResult;
  assert.ok(observed.source);
  const cited = new Evidence(store).observe('p', reference(observed.source), { kind: 'json-pointer', pointer: '/result/stdout' });
  const report: TechnicalReport = { applicability: 'applicable', reason: 'The command completed', facts: [],
    designs: [{ id: 'd', decision: 'Use the observed result', benefit: 'An exact fixture result exists', consumer: 'compilation' }],
    gaps: [], documents: [{ id: 'runtime', claim: 'The command emitted its result', kind: 'document-observation',
      citation: 0, quote: String(cited.value).trim(), designs: ['d'], gaps: [] }],
    coverage: [{ obligation: 'boundary', facts: [], designs: ['d'], gaps: [] }] };
  const saved = collectRuntimeEvidence(store, 'p', spec, report, [cited]);
  assert.equal(saved.proofs.length, 1);
  assert.deepEqual(readRuntimeEvidenceAt(store, 'p', spec, report, [cited], saved), saved);
  // A second lawful observation under a moved TMPDIR carries a different
  // runtimeBinding; the collector selects only the one matching its own.
  const oldTmpdir = process.env.TMPDIR;
  t.after(() => { if (oldTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmpdir; });
  process.env.TMPDIR = root;
  const later = await engine.execute({ type: 'observe-runtime', project: 'p', scope: reference(scope),
    obligation: 'boundary', key: 'second-legal-runtime' }) as import('../src/runtime/runtime-observation.js').RuntimeObservationResult;
  const laterCitation = new Evidence(store).observe('p', reference(later.source!), { kind: 'json-pointer', pointer: '/result/stdout' });
  const mixedReport: TechnicalReport = { ...report,
    documents: [report.documents![0]!, { ...report.documents![0]!, id: 'runtime-second', citation: 1 }] };
  const legal = collectRuntimeEvidence(store, 'p', spec, mixedReport, [cited, laterCitation]);
  assert.equal(legal.proofs.length, 1, 'admission selects only the observation of its own binding');
  assert.deepEqual(readRuntimeEvidenceAt(store, 'p', spec, mixedReport, [cited, laterCitation], legal), legal,
    'history reproduces the lawful one-of-two selection instead of demanding both');
});

test('historical runtime proof rejects subjects inconsistent with the declared check', async t => {
  // reviewer-runtime-subjects.mjs (R6/№1318-5)
  const { configureResearchScope, scopedQuestions } = await import('../src/graph/research-scope.js');
  const { withObligationEvidence } = await import('../src/graph/obligation-evidence.js');
  const { collectRuntimeEvidence, readRuntimeEvidenceAt, projectRuntimeSupportAt } = await import('../src/graph/runtime-evidence.js');
  const { uniqueRefs } = await import('../src/pipeline/contracts.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-runtime-subjects-')));
  const store = new Store(join(root, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Pinned runtime proof' });
  const graph = { nodes: [{ id: 'n', code: [] }], horizon: [], connectors: [], tests: [], anchors: [] } as unknown as Graph;
  store.write({ id: 'graph:p', kind: 'graph', expected: 0, value: graph });
  const layer = store.write({ id: 'graph-layer:p:2', kind: 'graph-layer', expected: 0, value: { projection: graph } });
  const gap = { id: 'boundary', target: 'n', field: 'code', consumer: 'compilation', requiredFor: 'next' as const,
    question: 'Record the actual fixture invocation' };
  const r1 = store.write({ id: 'runtime-r1', kind: 'discovery-draft', expected: 0,
    value: { projectId: 'p', fields: { technical: { gaps: [gap] } } } });
  const phase = store.write({ id: 'phase:p:R1', kind: 'phase', expected: 0, value: { draft: reference(r1) } });
  const original = configureResearchScope(store, { projectId: 'p', layer: reference(layer), r1: reference(phase),
    outcome: 'Keep the exact observed result', nodes: ['n'], boundaries: [], expansions: [], changedPaths: [], uiRequired: false,
    obligations: [{ gap, state: 'active', reason: 'Original requirement', wake: null }] }, 0);
  writeFileSync(join(root, 'check.mjs'), "console.log('observed fixture result')\n");
  const code = engine.discovery.evidence.file('p', 'runtime-check', root, 'check.mjs', 'text/plain', 0);
  const check = { script: reference(code), dependencies: [], subjects: ['check.mjs'], executables: [] as string[],
    args: [], timeoutMs: 4000, purpose: 'Observe the exact fixture invocation' };
  const scope = configureResearchScope(store, { ...original.value, policy: { version: 1 as const, sourceScope: reference(original),
    assignments: [{ obligation: gap.id, original: { record: reference(original), pointer: '/obligations/0/gap' },
      kind: 'environment-confirmation' as const, moment: 'R2' as const, responsibleNode: 'n',
      responsibleConsumer: 'compilation', neededForR2: true, reason: 'Observe actual execution', returnCondition: null,
      runtimeCheck: check }] } }, 1);
  const command = { executable: process.execPath, args: ['--version'] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const spec = withObligationEvidence(withTypedBasis(scopedQuestions(scope.value).find(item => item.obligations)!));
  engine.discovery.create('p', 'om-g2', 'R2', 'compilation', [spec], [reference(scope)], 2);
  const observed = await engine.execute({ type: 'observe-runtime', project: 'p', scope: reference(scope),
    obligation: 'boundary', key: 'proof' }) as import('../src/runtime/runtime-observation.js').RuntimeObservationResult;
  assert.ok(observed.source);
  const cited = new Evidence(store).observe('p', reference(observed.source), { kind: 'json-pointer', pointer: '/result/stdout' });
  const report: TechnicalReport = { applicability: 'applicable', reason: 'The command completed', facts: [],
    designs: [{ id: 'd', decision: 'Use the observed result', benefit: 'An exact fixture result exists', consumer: 'compilation' }],
    gaps: [], documents: [{ id: 'runtime', claim: 'The command emitted its result', kind: 'document-observation',
      citation: 0, quote: String(cited.value).trim(), designs: ['d'], gaps: [] }],
    coverage: [{ obligation: 'boundary', facts: [], designs: ['d'], gaps: [] }] };
  const saved = collectRuntimeEvidence(store, 'p', spec, report, [cited]);
  assert.equal(saved.proofs.length, 1);
  assert.deepEqual(readRuntimeEvidenceAt(store, 'p', spec, report, [cited], saved), saved);
  // A historically consistent record whose subjects were emptied still fails:
  // subject count/order/requested/kind is a subject-matter check, not storage.
  const { runtimeSource } = await import('../src/runtime/runtime-observation-model.js');
  const value = { ...observed.observation.value, subjects: [] };
  const altered = { ...observed.observation, value, hash: hashJson(value) };
  const projected = runtimeSource(altered as any);
  const source = { id: projected.id, kind: 'source', revision: 1, value: projected.value, hash: hashJson(projected.value) };
  const view = new Proxy(store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) =>
      id === altered.id ? altered as any : id === source.id ? source as any : target.get(id, revision as any);
    const member = Reflect.get(target, key, target);
    return typeof member === 'function' ? member.bind(target) : member;
  } }) as unknown as Store;
  const citation = new Evidence(view).observe('p', reference(source as any), cited.selector);
  const support = projectRuntimeSupportAt(view, 'p', (spec.obligations![0] as any).assignment, reference(source as any));
  const replaced = { ...saved,
    proofs: saved.proofs.map(proof => ({ ...proof, source: reference(source as any), observation: reference(altered as any) })),
    supporting: [support!.full, ...support!.code],
    guards: uniqueRefs(saved.guards.map(ref => ref.id === observed.observation.id ? reference(altered as any)
      : ref.id === observed.source!.id ? reference(source as any) : ref)) };
  assert.throws(() => readRuntimeEvidenceAt(view, 'p', spec, report, [citation], replaced as any),
    { code: 'runtime_evidence_invalid' },
    'historical runtime must enforce declared subject count/order/kind');
});

test('a paid L3 terminal binds from its exact original graph after the head moved', async t => {
  // reviewer-l3-graph.mjs (R11/№1318-2)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-layer-graph-')));
  const database = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  const full = enrichedGraph(exampleGraph('p'), 'p');
  preparedFeatures(engine, 'p', full);
  const { level: _level, ...initial } = projectGraph(full, 1);
  engine.graphs.save('p', initial, store.get('graph:p')!.revision, 'fixture');
  writeFileSync(join(root, 'README.md'), 'A local scoped transformation with an atomic result and recovery.\n');
  const adapter = join(root, 'adapter.mjs'), replies = join(root, 'replies.json'), wire = join(root, 'wire.ndjson');
  writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,f=JSON.parse(readFileSync(${JSON.stringify(replies)},'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify({role:s.role,mode:s.dispatchMode,previous:s.previousProposalRef??null})+'\\n');
const research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}
 :s.dispatchMode==='planning'?{action:'synthesize',question:s.question.id}
 :{action:'answer_delta',question:s.question.id,base:s.graphBase,
   ...(s.previousProposalRef?{...f.correction,revises:s.previousProposalRef}:f.first),citations:f.citations};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,
 usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', {
    experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command },
    agentCommand: command, maxRequestChars: 100000, maxReadChars: 60000,
    maxReplyChars: 100000, maxCalls: 12, maxReportedTokens: 100000,
    planning: { fields: ['layerDesign'], maxRequestChars: 100000, maxRounds: 3 } }, 0);
  configurePhasePolicy(store, 'p', 'L3', 'layer-refusal', 0);
  const calibrated = pilotEnvironment(engine.environments.get('p').value, pilot.value);
  for (const [purpose, role] of [['reading-planner', calibrated.implementer],
    ['analyst', calibrated.implementer], ['assessor', calibrated.reviewer]] as const) {
    store.write({ id: `model-call:layer-calibration-${purpose}`, kind: 'model-call', expected: 0,
      value: { projectId: 'p', draftId: 'fixture', purpose, requestId: `layer-calibration-${purpose}`,
        startedAt: 0, finishedAt: 1, status: 'succeeded', requested: role,
        confirmed: { model: null, effort: null, speed: null },
        request: { chars: 1000, bytes: 1000, hash: hashJson(purpose) }, response: null,
        usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 0, reasoningOutputTokens: 0 },
        usageSource: 'adapter', error: null } });
  }
  const r0 = engine.refinement.begin('p', 'R0');
  engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
  engine.refinement.sealLayer('p', 1, 0);
  const r1 = engine.refinement.begin('p', 'R1');
  answerTechnicalFixture(engine, 'p', r1);
  engine.refinement.finishResearch('p', 'R1', reference(store.get(r1.id)!), 0);
  const l2 = engine.refinement.prepareLayer('p', 2);
  const ready2 = answerLayerFixture(engine, 'p', l2, 2, full);
  engine.refinement.buildLayer('p', 2, reference(ready2), store.get('graph:p')!.revision, 'fixture');
  engine.refinement.sealLayer('p', 2, 0);
  configureResearchScope(store, { projectId: 'p', layer: reference(store.get('graph-layer:p:2')!),
    r1: reference(store.get('phase:p:R1')!), outcome: 'Validated local output',
    nodes: full.nodes.filter(node => node.kind === 'operation').map(node => node.id),
    boundaries: [], expansions: [], obligations: [], changedPaths: [], uiRequired: false }, 0);
  const r2 = engine.refinement.begin('p', 'R2');
  answerTechnicalFixture(engine, 'p', r2);
  engine.refinement.finishResearch('p', 'R2', reference(store.get(r2.id)!), 0);
  const draft = engine.refinement.prepareLayer('p', 3);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const source = engine.discovery.evidence.document('p', 'design-source',
    'The accepted layer and proposed atomic work share the same product scope.', 'text/plain', 0);
  const citations = [{ source: reference(source), selector: { kind: 'text-range' as const, start: 0, end: source.value.content.length } }];
  const delta = layerDeltaView(store, 'p', layerDesignOf(full, 3, question.value.spec.layerAssembly), 3,
    question.value.spec.layerAssembly);
  writeFileSync(replies, JSON.stringify({ first: { horizon: delta.horizon, upserts: delta.upserts, removes: delta.removes },
    correction: { upserts: {}, removes: {} }, citations }));
  const originalWriteMany = store.writeMany.bind(store);
  let interrupted = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const rows = originalWriteMany(writes, guards);
    if (!interrupted && writes.some(w => w.kind === 'assessment-application' && (w.value as {state?:string}).state === 'applied')
      && writes.some(w => w.kind === 'assessment-session' && (w.value as {result?:unknown}).result !== null)) {
      interrupted = true;
      throw new EngineError('fixture_after_paid_assessor', 'terminal saved before binding');
    }
    return rows;
  }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 4);
  store.writeMany = originalWriteMany;
  assert.equal(interrupted, true, 'legitimate L3 must reach paid terminal');
  const pending = store.list<ResearchTurn>('research-turn')
    .find(turn => turn.value.status === 'pending' && (turn.value.action as any)?.action === 'answer_delta');
  assert.ok(pending);
  assert.equal(store.list('research-assessment-binding').length, 0);
  const graph2 = store.get<Graph>('graph:p')!, block = graph2.value.nodes.find(n => n.kind === 'block')!;
  engine.graphs.save('p', { ...graph2.value,
    nodes: graph2.value.nodes.map(n => n.id === block.id ? { ...n, purpose: `${n.purpose} independently revised` } : n) },
    graph2.revision, 'fixture');
  await new ProductEngine(open()).researcher.run('p', draft.id, 1);
  assert.equal(store.list('research-assessment-binding').length, 1,
    'L3 terminal must bind using its original upper graph');
});

test('a moved question head binds the paid terminal before lawful retirement', async t => {
  // reviewer-question-head.mjs (№2000-8)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-question-head-')));
  const database = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Assessment head drift' });
  const source = engine.discovery.evidence.document('p', 'proof', 'One exact documentary observation', 'text/plain', 0);
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
const research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}
 :{action:'answer',question:s.questions[0].id,value:{ok:true},
   citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'text-range',start:0,end:12}}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,
 usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
    [{ field: 'result', kind: 'design', prompt: 'Resolve result', risk: 'Missing source', schema: { type: 'object' } }]);
  const originalWriteMany = store.writeMany.bind(store);
  let interrupted = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const rows = originalWriteMany(writes, guards);
    if (!interrupted && writes.some(w => w.kind === 'assessment-application' && (w.value as {state?:string}).state === 'applied')
      && writes.some(w => w.kind === 'assessment-session' && (w.value as {result?:unknown}).result !== null)) {
      interrupted = true;
      throw new EngineError('fixture_after_paid_assessor', 'The paid verdict was applied before its assessment binding');
    }
    return rows;
  }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 1);
  store.writeMany = originalWriteMany;
  assert.equal(interrupted, true);
  assert.equal(store.list('research-assessment-binding').length, 0);
  const pending = store.list<ResearchTurn>('research-turn')[0]!;
  const origin = readAssessmentPaidOrigin(store, 'p', reference(pending));
  assert.ok(origin);
  assert.equal(origin.value.root, root);
  assert.equal(origin.value.dispatch.workspace, root);
  assert.equal(store.list<ModelCall>('model-call').filter(call => call.value.purpose === 'assessor').length, 1);
  // A lawful owner decision moves the question head after the paid terminal.
  engine.discovery.decision((pending.value.question as Ref).id, (pending.value.question as Ref).revision, 'owner', { ok: true });
  await new ProductEngine(open()).researcher.run('p', draft.id, 1);
  assert.equal(store.list('research-assessment-binding').length, 1,
    'paid terminal must bind before retiring a question that moved');
});

test('a deactivated pilot binds the applied paid terminal before refusing new work', async t => {
  // reviewer-pilot-head.mjs (№2000-8)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-pilot-head-')));
  const database = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  const full = enrichedGraph(exampleGraph('p'), 'p');
  preparedFeatures(engine, 'p', full);
  const { level: _level, ...initial } = projectGraph(full, 1);
  engine.graphs.save('p', initial, store.get('graph:p')!.revision, 'fixture');
  writeFileSync(join(root, 'README.md'), 'A local scoped transformation with an atomic result and recovery.\n');
  const adapter = join(root, 'adapter.mjs'), replies = join(root, 'replies.json'), wire = join(root, 'wire.ndjson');
  writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,f=JSON.parse(readFileSync(${JSON.stringify(replies)},'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify({role:s.role,mode:s.dispatchMode,previous:s.previousProposalRef??null})+'\\n');
const research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}
 :s.dispatchMode==='planning'?{action:'synthesize',question:s.question.id}
 :{action:'answer_delta',question:s.question.id,base:s.graphBase,
   ...(s.previousProposalRef?{...f.correction,revises:s.previousProposalRef}:f.first),citations:f.citations};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,
 usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', {
    experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command },
    agentCommand: command, maxRequestChars: 100000, maxReadChars: 60000,
    maxReplyChars: 100000, maxCalls: 12, maxReportedTokens: 100000,
    planning: { fields: ['layerDesign'], maxRequestChars: 100000, maxRounds: 3 } }, 0);
  configurePhasePolicy(store, 'p', 'L3', 'layer-refusal', 0);
  const calibrated = pilotEnvironment(engine.environments.get('p').value, pilot.value);
  for (const [purpose, role] of [['reading-planner', calibrated.implementer],
    ['analyst', calibrated.implementer], ['assessor', calibrated.reviewer]] as const) {
    store.write({ id: `model-call:layer-calibration-${purpose}`, kind: 'model-call', expected: 0,
      value: { projectId: 'p', draftId: 'fixture', purpose, requestId: `layer-calibration-${purpose}`,
        startedAt: 0, finishedAt: 1, status: 'succeeded', requested: role,
        confirmed: { model: null, effort: null, speed: null },
        request: { chars: 1000, bytes: 1000, hash: hashJson(purpose) }, response: null,
        usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 0, reasoningOutputTokens: 0 },
        usageSource: 'adapter', error: null } });
  }
  const r0 = engine.refinement.begin('p', 'R0');
  engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
  engine.refinement.sealLayer('p', 1, 0);
  const r1 = engine.refinement.begin('p', 'R1');
  answerTechnicalFixture(engine, 'p', r1);
  engine.refinement.finishResearch('p', 'R1', reference(store.get(r1.id)!), 0);
  const l2 = engine.refinement.prepareLayer('p', 2);
  const ready2 = answerLayerFixture(engine, 'p', l2, 2, full);
  engine.refinement.buildLayer('p', 2, reference(ready2), store.get('graph:p')!.revision, 'fixture');
  engine.refinement.sealLayer('p', 2, 0);
  configureResearchScope(store, { projectId: 'p', layer: reference(store.get('graph-layer:p:2')!),
    r1: reference(store.get('phase:p:R1')!), outcome: 'Validated local output',
    nodes: full.nodes.filter(node => node.kind === 'operation').map(node => node.id),
    boundaries: [], expansions: [], obligations: [], changedPaths: [], uiRequired: false }, 0);
  const r2 = engine.refinement.begin('p', 'R2');
  answerTechnicalFixture(engine, 'p', r2);
  engine.refinement.finishResearch('p', 'R2', reference(store.get(r2.id)!), 0);
  const draft = engine.refinement.prepareLayer('p', 3);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const source = engine.discovery.evidence.document('p', 'design-source',
    'The accepted layer and proposed atomic work share the same product scope.', 'text/plain', 0);
  const citations = [{ source: reference(source), selector: { kind: 'text-range' as const, start: 0, end: source.value.content.length } }];
  const delta = layerDeltaView(store, 'p', layerDesignOf(full, 3, question.value.spec.layerAssembly), 3,
    question.value.spec.layerAssembly);
  writeFileSync(replies, JSON.stringify({ first: { horizon: delta.horizon, upserts: delta.upserts, removes: delta.removes },
    correction: { upserts: {}, removes: {} }, citations }));
  const originalWriteMany = store.writeMany.bind(store);
  let interrupted = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const rows = originalWriteMany(writes, guards);
    if (!interrupted && writes.some(w => w.kind === 'assessment-application' && (w.value as {state?:string}).state === 'applied')
      && writes.some(w => w.kind === 'assessment-session' && (w.value as {result?:unknown}).result !== null)) {
      interrupted = true;
      throw new EngineError('fixture_after_paid_assessor', 'terminal saved before binding');
    }
    return rows;
  }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 4);
  store.writeMany = originalWriteMany;
  assert.equal(interrupted, true, 'legitimate L3 must reach paid terminal');
  const pending = store.list<ResearchTurn>('research-turn')
    .find(turn => turn.value.status === 'pending' && (turn.value.action as any)?.action === 'answer_delta');
  assert.ok(pending);
  assert.equal(store.list('research-assessment-binding').length, 0);
  // Deactivating today's pilot admits no NEW work, but the applied paid
  // terminal must still bind first.
  const { projectId: _projectId, ...settings } = pilot.value as any;
  configureReaderPilot(store, engine.environments, 'p', { ...settings, active: false }, pilot.revision);
  try { await new ProductEngine(open()).researcher.run('p', draft.id, 1); }
  catch { /* the deactivated pilot still refuses NEW work after the bind */ }
  assert.equal(store.list('research-assessment-binding').length, 1,
    'a current pilot restriction must not discard an applied terminal assessment');
});

test('a managed paid turn with a missing origin refuses instead of choosing a legacy era', async t => {
  // reviewer-missing-origin.mjs (R19/№2000-12)
  const root = mkdtempSync(join(tmpdir(), 'omg-d84-missing-origin-'));
  const database = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Assessment missing origin' });
  const source = engine.discovery.evidence.document('p', 'proof', 'One exact documentary observation', 'text/plain', 0);
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
const research=s.role==='assess-answer'?{verdict:'insufficient',reasons:['The fixture did not support acceptance']}
 :{action:'answer',question:s.questions[0].id,value:{ok:true},
   citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'text-range',start:0,end:12}}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,
 usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
    [{ field: 'result', kind: 'design', prompt: 'Resolve result', risk: 'Missing source', schema: { type: 'object' } }]);
  await engine.researcher.run('p', draft.id, 1);
  const assessment = store.list<import('../src/discovery/research-model.js').ResearchAssessment>('research-assessment')[0]!, turn = store.list<ResearchTurn>('research-turn')[0]!;
  assert.equal(assessment.value.verdict, 'insufficient');
  const proved = readResearchAssessmentAt(open(), 'p', turn.id, reference(assessment));
  assert.deepEqual(proved.value, assessment.value);
  const proof = store.get(`research-assessment-binding:v1:${hashJson({ projectId: 'p', turnId: turn.id })}`)!;
  assert.ok(proof);
  // Losing M must not silently pick the legacy era: the turn's stable links
  // (session, binding) still prove the managed paid era → typed refusal.
  const mid = store.list('assessment-paid-origin')[0]!.id;
  const hidden = new Proxy(store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) => id === mid ? null : target.get(id, revision as any);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as unknown as Store;
  assert.throws(() => readResearchConsumerTurn(hidden, reference(turn)),
    { code: 'research_context_application_invalid' },
    'v2 completed turn must not fall back when its mandatory M is missing');
});

test('historical runtime replay reproduces selection when a declared subject changed under one binding', async t => {
  // reviewer-runtime-subject-selection.mjs (№1971-4/№2000-5): two lawful
  // observations share one runtimeBinding but differ in subject.txt content —
  // the collector keeps only the one matching the admission snapshot, and the
  // historical replay must derive that same selection from saved material.
  const { configureResearchScope, scopedQuestions } = await import('../src/graph/research-scope.js');
  const { withObligationEvidence } = await import('../src/graph/obligation-evidence.js');
  const { collectRuntimeEvidence, readRuntimeEvidenceAt } = await import('../src/graph/runtime-evidence.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-runtime-subject-')));
  const store = new Store(join(root, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Pinned runtime proof' });
  const graph = { nodes: [{ id: 'n', code: [] }], horizon: [], connectors: [], tests: [], anchors: [] } as unknown as Graph;
  store.write({ id: 'graph:p', kind: 'graph', expected: 0, value: graph });
  const layer = store.write({ id: 'graph-layer:p:2', kind: 'graph-layer', expected: 0, value: { projection: graph } });
  const gap = { id: 'boundary', target: 'n', field: 'code', consumer: 'compilation', requiredFor: 'next' as const,
    question: 'Record the actual fixture invocation' };
  const r1 = store.write({ id: 'runtime-r1', kind: 'discovery-draft', expected: 0,
    value: { projectId: 'p', fields: { technical: { gaps: [gap] } } } });
  const phase = store.write({ id: 'phase:p:R1', kind: 'phase', expected: 0, value: { draft: reference(r1) } });
  const original = configureResearchScope(store, { projectId: 'p', layer: reference(layer), r1: reference(phase),
    outcome: 'Keep the exact observed result', nodes: ['n'], boundaries: [], expansions: [], changedPaths: [], uiRequired: false,
    obligations: [{ gap, state: 'active', reason: 'Original requirement', wake: null }] }, 0);
  writeFileSync(join(root, 'check.mjs'), "console.log('observed fixture result')\n");
  const code = engine.discovery.evidence.file('p', 'runtime-check', root, 'check.mjs', 'text/plain', 0);
  const check = { script: reference(code), dependencies: [], subjects: ['subject.txt'], executables: [] as string[],
    args: [], timeoutMs: 4000, purpose: 'Observe the exact fixture invocation' };
  const scope = configureResearchScope(store, { ...original.value, policy: { version: 1 as const, sourceScope: reference(original),
    assignments: [{ obligation: gap.id, original: { record: reference(original), pointer: '/obligations/0/gap' },
      kind: 'environment-confirmation' as const, moment: 'R2' as const, responsibleNode: 'n',
      responsibleConsumer: 'compilation', neededForR2: true, reason: 'Observe actual execution', returnCondition: null,
      runtimeCheck: check }] } }, 1);
  const command = { executable: process.execPath, args: ['--version'] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const spec = withObligationEvidence(withTypedBasis(scopedQuestions(scope.value).find(item => item.obligations)!));
  engine.discovery.create('p', 'om-g2', 'R2', 'compilation', [spec], [reference(scope)], 2);
  writeFileSync(join(root, 'subject.txt'), 'first subject bytes');
  const observed = await engine.execute({ type: 'observe-runtime', project: 'p', scope: reference(scope),
    obligation: 'boundary', key: 'proof' }) as import('../src/runtime/runtime-observation.js').RuntimeObservationResult;
  assert.ok(observed.source);
  const cited = new Evidence(store).observe('p', reference(observed.source), { kind: 'json-pointer', pointer: '/result/stdout' });
  const report: TechnicalReport = { applicability: 'applicable', reason: 'The command completed', facts: [],
    designs: [{ id: 'd', decision: 'Use the observed result', benefit: 'An exact fixture result exists', consumer: 'compilation' }],
    gaps: [], documents: [{ id: 'runtime', claim: 'The command emitted its result', kind: 'document-observation',
      citation: 0, quote: String(cited.value).trim(), designs: ['d'], gaps: [] }],
    coverage: [{ obligation: 'boundary', facts: [], designs: ['d'], gaps: [] }] };
  const saved = collectRuntimeEvidence(store, 'p', spec, report, [cited]);
  assert.equal(saved.proofs.length, 1);
  assert.deepEqual(readRuntimeEvidenceAt(store, 'p', spec, report, [cited], saved), saved);
  // The declared subject's content moves under the SAME runtimeBinding —
  // the original admission snapshot distinguishes what the binding cannot.
  writeFileSync(join(root, 'subject.txt'), 'second changed subject bytes');
  const later = await engine.execute({ type: 'observe-runtime', project: 'p', scope: reference(scope),
    obligation: 'boundary', key: 'second-legal-runtime' }) as import('../src/runtime/runtime-observation.js').RuntimeObservationResult;
  assert.equal(canonical(observed.observation.value.runtimeBinding), canonical(later.observation.value.runtimeBinding),
    'both observations share one binding — the difference is the subject identity');
  const laterCitation = new Evidence(store).observe('p', reference(later.source!), { kind: 'json-pointer', pointer: '/result/stdout' });
  const mixedReport: TechnicalReport = { ...report,
    documents: [report.documents![0]!, { ...report.documents![0]!, id: 'runtime-second', citation: 1 }] };
  const legal = collectRuntimeEvidence(store, 'p', spec, mixedReport, [cited, laterCitation]);
  assert.equal(legal.proofs.length, 1, 'admission keeps only the observation matching the subject identity');
  assert.deepEqual(readRuntimeEvidenceAt(store, 'p', spec, mixedReport, [cited, laterCitation], legal), legal,
    'history derives the lawful exclusion from the saved admission basis, not the binding alone');
});

test('a paid terminal binds before the moved execution root refuses new work', async t => {
  // reviewer-execution-root.mjs (№2000-8): after terminal S/applied A with no
  // R/B, a new commit inside the execution worktree must not prevent binding —
  // the proven paid terminal restores before any current environment check.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-exec-root-')));
  const database = join(root, 'state.sqlite');
  const stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Frozen assessor origin' });
  const workspace = join(root, 'repo'); mkdirSync(workspace);
  const file = join(workspace, 'source.txt');
  writeFileSync(file, 'This exact local condition supports the proposed result.');
  const source = engine.discovery.evidence.file('p', 'source', workspace, 'source.txt', 'text/plain', 0);
  const wire = join(root, 'calls.ndjson'), adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),subject=request.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify({role:subject.role,requestId:request.requestId})+'\\n');
const research=subject.role==='assess-answer'?{verdict:'supported',reasons:[]}
 :{action:'answer',question:subject.questions[0].id,value:{ok:true},citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'text-range',start:0,end:${source.value.content.length}}}]};
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research,
 usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const { ensureWorktree } = await import('../src/execution/worktree.js');
  const { git } = await import('../src/runtime/environment.js');
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['add', 'source.txt']);
  git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const execution = ensureWorktree(store, engine.environments,
    { projectId: 'p', base: { root: workspace, head: git(workspace, ['rev-parse', 'HEAD']) } } as Parameters<typeof ensureWorktree>[2]);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
    [{ field: 'result', kind: 'design', prompt: 'Resolve result', risk: 'Missing source', schema: { type: 'object' } }]);
  const original = store.writeMany.bind(store);
  let interrupted = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const rows = original(writes, guards);
    if (!interrupted && writes.some(write => write.kind === 'assessment-application'
      && (write.value as { state?: string }).state === 'applied')
      && writes.some(write => write.kind === 'assessment-session'
        && (write.value as { result?: unknown }).result !== null)) {
      interrupted = true;
      throw new EngineError('fixture_after_paid_assessor', 'The paid verdict was applied before its assessment binding');
    }
    return rows;
  }) as typeof store.writeMany;
  await engine.researcher.run('p', draft.id, 1);
  store.writeMany = original;
  assert.equal(interrupted, true);
  assert.equal(store.list('research-assessment-binding').length, 0);
  const pending = store.list('research-turn')[0]!;
  const origin = readAssessmentPaidOrigin(store, 'p', reference(pending));
  assert.ok(origin);
  assert.equal(origin.value.root, execution.value.path);
  assert.equal(origin.value.dispatch.workspace, execution.value.path);
  assert.equal(store.list<ModelCall>('model-call').filter(call => call.value.purpose === 'assessor').length, 1);
  git(execution.value.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-m', 'move-after-terminal']);
  let result: unknown;
  try { result = await new ProductEngine(open()).researcher.run('p', draft.id, 1); }
  catch (error) { result = { code: (error as EngineError).code, message: (error as EngineError).message }; }
  assert.equal(store.list('research-assessment-binding').length, 1,
    'paid terminal must bind before current execution-root admission refuses');
  assert.equal(store.list<ModelCall>('model-call').filter(call => call.value.purpose === 'assessor').length, 1,
    'the bound terminal is the saved paid call, not a new dispatch');
  const outcome = result as { code?: string };
  assert.equal(outcome.code, 'execution_root_recovery',
    'new work still refuses on the moved execution root — admission is not weakened');
});

// ---- D8.4d fourth round (№2141): the admission material at the moment of assessment, one derivation of the selected and
// the excluded candidates for the current and the historical mode, the proof before the first write of M, the addressed
// refusal on loss, and the lawful zero selection only on a proved exclusion. Reviewer probes №2140 — permanent regressions.
async function runtimeSelectionFixture(t: import('node:test').TestContext, subjects: string[] = ['subject.txt']) {
  const { configureResearchScope, scopedQuestions } = await import('../src/graph/research-scope.js');
  const { withObligationEvidence } = await import('../src/graph/obligation-evidence.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84d-runtime-admission-')));
  const database = join(root, 'db.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  const store = open();
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Pinned runtime proof' });
  const graph = { nodes: [{ id: 'n', code: [] }], horizon: [], connectors: [], tests: [], anchors: [] } as unknown as Graph;
  store.write({ id: 'graph:p', kind: 'graph', expected: 0, value: graph });
  const layer = store.write({ id: 'graph-layer:p:2', kind: 'graph-layer', expected: 0, value: { projection: graph } });
  const gap = { id: 'boundary', target: 'n', field: 'code', consumer: 'compilation', requiredFor: 'next' as const,
    question: 'Record the actual fixture invocation' };
  const r1 = store.write({ id: 'runtime-r1', kind: 'discovery-draft', expected: 0,
    value: { projectId: 'p', fields: { technical: { gaps: [gap] } } } });
  const phase = store.write({ id: 'phase:p:R1', kind: 'phase', expected: 0, value: { draft: reference(r1) } });
  const original = configureResearchScope(store, { projectId: 'p', layer: reference(layer), r1: reference(phase),
    outcome: 'Keep the exact observed result', nodes: ['n'], boundaries: [], expansions: [], changedPaths: [], uiRequired: false,
    obligations: [{ gap, state: 'active', reason: 'Original requirement', wake: null }] }, 0);
  writeFileSync(join(root, 'check.mjs'), "console.log('observed fixture result')\n");
  const code = engine.discovery.evidence.file('p', 'runtime-check', root, 'check.mjs', 'text/plain', 0);
  const check = { script: reference(code), dependencies: [], subjects, executables: [] as string[],
    args: [], timeoutMs: 4000, purpose: 'Observe the exact fixture invocation' };
  const scope = configureResearchScope(store, { ...original.value, policy: { version: 1 as const, sourceScope: reference(original),
    assignments: [{ obligation: gap.id, original: { record: reference(original), pointer: '/obligations/0/gap' },
      kind: 'environment-confirmation' as const, moment: 'R2' as const, responsibleNode: 'n',
      responsibleConsumer: 'compilation', neededForR2: true, reason: 'Observe actual execution', returnCondition: null,
      runtimeCheck: check }] } }, 1);
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const spec = withObligationEvidence(withTypedBasis(scopedQuestions(scope.value).find(item => item.obligations)!));
  const draft = engine.discovery.create('p', 'om-g2', 'R2', 'compilation', [spec], [reference(scope)], 2);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  for (const subject of subjects) writeFileSync(join(root, subject), 'first subject bytes');
  const observe = async (key: string) => await engine.execute({ type: 'observe-runtime', project: 'p', scope: reference(scope),
    obligation: 'boundary', key }) as import('../src/runtime/runtime-observation.js').RuntimeObservationResult;
  const cite = (source: Revision<Source>) => new Evidence(store).observe('p', reference(source), { kind: 'json-pointer', pointer: '/result/stdout' });
  const report = (first: Observation, others: Observation[] = []): TechnicalReport => ({ applicability: 'applicable', reason: 'The command completed', facts: [],
    designs: [{ id: 'd', decision: 'Use the observed result', benefit: 'An exact fixture result exists', consumer: 'compilation' }],
    gaps: [], documents: [{ id: 'runtime', claim: 'The command emitted its result', kind: 'document-observation',
      citation: 0, quote: String(first.value).trim(), designs: ['d'], gaps: [] },
      ...others.map((_item, index) => ({ id: `runtime-${index + 2}`, claim: 'The command emitted its result', kind: 'document-observation' as const,
        citation: index + 1, quote: String(first.value).trim(), designs: ['d'], gaps: [] }))],
    coverage: [{ obligation: 'boundary', facts: [], designs: ['d'], gaps: [] }] });
  const empty = { proofs: [], supporting: [], guards: [], admissionGuards: [] };
  const hiding = (db: Store, id: string): Store => new Proxy(db, { get(target, key) {
    if (key === 'get') return (record: string, revision?: number) => record === id ? undefined : target.get(record, revision);
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  /** The direct session entry stopped right after M (before any model call), as the reviewer's probe drives it. */
  const sessionUntilOrigin = async (db: Store, context: Record<string, unknown>, input: Record<string, unknown>) => {
    const { assessmentSessionWithProof } = await import('../src/discovery/assessment-session.js');
    const baseWriteMany = db.writeMany.bind(db);
    db.writeMany = ((writes: Write[], guards = []) => {
      const rows = baseWriteMany(writes, guards);
      if (writes.some(write => write.kind === 'assessment-paid-origin')) throw new EngineError('fixture_after_runtime_origin', 'Stop after M before any model call');
      return rows;
    }) as typeof db.writeMany;
    try { await assessmentSessionWithProof(db, draft, question, environment, environment.value, undefined, context as any,
      'Assess the exact saved runtime result', undefined, [], input as any); return null; }
    catch (error) { return error instanceof EngineError ? error.code : String(error); }
    finally { db.writeMany = baseWriteMany; }
  };
  const pendingTurn = (key: string, citations: Observation[], value: TechnicalReport) => store.write({ id: `research-turn:${key}`, kind: 'research-turn', expected: 0,
    value: { action: { action: 'answer', question: question.id, value, citations: citations.map(item => ({ source: item.source, selector: item.selector })) },
      status: 'pending', question: reference(question) } });
  const input = (pending: Revision<unknown>, runtime: unknown, runtimeAdmission?: unknown) => ({ pending: reference(pending), root, graph: null, legacyPaths: [],
    reads: { contract: 'assessment-read/v1', reads: [], files: [] }, runtime, ...(runtimeAdmission === undefined ? {} : { runtimeAdmission }) });
  return { root, store, open, engine, scope, spec, draft, question, environment, check, observe, cite, report, empty, hiding, sessionUntilOrigin, pendingTurn, input };
}
const withTmpdir = (t: import('node:test').TestContext, value: string) => {
  const old = process.env.TMPDIR;
  t.after(() => { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; });
  process.env.TMPDIR = value;
};

test('D8.4d-4 A2/A5: an empty selection must not erase an admitted runtime candidate — the material records the admitted candidate and the replay, current or historical, derives it back (reviewer probe №2140-1)', async t => {
  const f = await runtimeSelectionFixture(t);
  const { collectRuntimeSelection, readRuntimeEvidenceAt } = await import('../src/graph/runtime-evidence.js');
  const observed = await f.observe('proof');
  const cited = f.cite(observed.source!), report = f.report(cited);
  const selection = collectRuntimeSelection(f.store, 'p', f.spec, report, [cited]);
  assert.equal(selection.runtime.proofs.length, 1); assert.equal(selection.runtime.supporting.length, 2);
  assert.equal(selection.admission.contract, 'runtime-admission/v1');
  assert.deepEqual(selection.admission.references.map(item => [item.basis !== null, item.unresolved]), [[true, null]], 'one live reference for the declared check');
  assert.deepEqual(selection.admission.candidates.map(item => [item.admitted, item.mismatch, item.observation]), [[true, [], reference(observed.observation)]]);
  assert.deepEqual(readRuntimeEvidenceAt(f.store, 'p', f.spec, report, [cited], selection.runtime), selection.runtime, 'the current replay');
  assert.deepEqual(readRuntimeEvidenceAt(f.store, 'p', f.spec, report, [cited], selection.runtime, selection.admission), selection.runtime, 'the historical replay from the material');
  assert.throws(() => readRuntimeEvidenceAt(f.store, 'p', f.spec, report, [cited], f.empty), { code: 'runtime_evidence_invalid' }, 'an empty result is not the current derivation');
  assert.throws(() => readRuntimeEvidenceAt(f.store, 'p', f.spec, report, [cited], f.empty, selection.admission), { code: 'runtime_evidence_invalid' }, 'an empty result contradicts the admitted candidate of the material');
  const forged = { ...selection.admission, candidates: selection.admission.candidates.map(item => ({ ...item, admitted: false, mismatch: ['binding'] })) };
  assert.throws(() => readRuntimeEvidenceAt(f.store, 'p', f.spec, report, [cited], f.empty, forged), { code: 'runtime_evidence_invalid' }, 'a claimed exclusion re-derives from the exact record, never from the claim');
});

test('D8.4d-4 A2/A5: a lawfully excluded candidate whose exact observation is lost is an addressed refusal, never a proved exclusion (reviewer probe №2140-2)', async t => {
  const f = await runtimeSelectionFixture(t);
  const { collectRuntimeSelection, readRuntimeEvidenceAt } = await import('../src/graph/runtime-evidence.js');
  const first = await f.observe('proof');
  const cited = f.cite(first.source!);
  writeFileSync(join(f.root, 'subject.txt'), 'second changed subject bytes');
  const later = await f.observe('second-legal-runtime');
  const laterCitation = f.cite(later.source!), mixed = f.report(cited, [laterCitation]);
  const legal = collectRuntimeSelection(f.store, 'p', f.spec, mixed, [cited, laterCitation]);
  assert.equal(legal.runtime.proofs.length, 1);
  assert.deepEqual(legal.admission.candidates.map(item => [item.citation, item.admitted, item.mismatch]), [[0, false, ['subjects/0']], [1, true, []]],
    'the material records the excluded candidate with the component that excluded it');
  assert.deepEqual(readRuntimeEvidenceAt(f.store, 'p', f.spec, mixed, [cited, laterCitation], legal.runtime), legal.runtime);
  assert.deepEqual(readRuntimeEvidenceAt(f.store, 'p', f.spec, mixed, [cited, laterCitation], legal.runtime, legal.admission), legal.runtime);
  const unavailable = f.hiding(f.store, first.observation.id);
  assert.throws(() => readRuntimeEvidenceAt(unavailable, 'p', f.spec, mixed, [cited, laterCitation], legal.runtime), { code: 'runtime_evidence_invalid' },
    'current replay: a cited runtime Source whose exact record is lost is not a silent exclusion');
  assert.throws(() => readRuntimeEvidenceAt(unavailable, 'p', f.spec, mixed, [cited, laterCitation], legal.runtime, legal.admission), { code: 'runtime_evidence_invalid' },
    'historical replay: the recorded candidate lost its exact observation');
  const dropped = { ...legal.admission, candidates: legal.admission.candidates.filter(item => item.admitted) };
  assert.throws(() => readRuntimeEvidenceAt(f.store, 'p', f.spec, mixed, [cited, laterCitation], legal.runtime, dropped), { code: 'runtime_evidence_invalid' },
    'a material that forgets a cited candidate is not the material of this report');
});

test('D8.4d-4 A6: the direct session entry proves the runtime input by its admission material before saving M — no material, an empty caller-supplied result or a stale material writes nothing (reviewer probe №2140-3, R6)', async t => {
  const f = await runtimeSelectionFixture(t);
  const { collectRuntimeSelection } = await import('../src/graph/runtime-evidence.js');
  const observed = await f.observe('proof');
  const cited = f.cite(observed.source!), report = f.report(cited);
  const selection = collectRuntimeSelection(f.store, 'p', f.spec, report, [cited]);
  const emptyContext = { role: 'assess-answer', question: f.spec, value: report, observations: [cited] };
  const pending = f.pendingTurn('reviewer-empty-runtime', [cited], report);
  const noMaterial = await f.sessionUntilOrigin(f.store, emptyContext, f.input(pending, f.empty));
  assert.equal(noMaterial, 'research_context_application_invalid', 'no admission material: refused before M');
  const emptyResult = await f.sessionUntilOrigin(f.store, emptyContext, f.input(pending, f.empty, selection.admission));
  assert.equal(emptyResult, 'research_context_application_invalid', 'an empty result contradicts its own material: refused before M');
  const forged = { ...selection.admission, candidates: selection.admission.candidates.map(item => ({ ...item, admitted: false, mismatch: ['binding'] })) };
  assert.equal(await f.sessionUntilOrigin(f.store, emptyContext, f.input(pending, f.empty, forged)), 'research_context_application_invalid', 'a claimed exclusion is not the current admission');
  assert.equal(f.store.list('assessment-paid-origin').length, 0, 'unproved caller-supplied results must not create M');
  assert.equal(f.store.list('model-call').length, 0);
  // The genuine pair passes the proof and M carries the material; it reads back exactly, also after a restart.
  const context = { role: 'assess-answer', question: f.spec, value: report, runtimeProofs: selection.runtime.proofs, observations: [cited, ...selection.runtime.supporting] };
  assert.equal(await f.sessionUntilOrigin(f.store, context, f.input(pending, selection.runtime, selection.admission)), 'fixture_after_runtime_origin');
  const origin = readAssessmentPaidOrigin(f.store, 'p', reference(pending));
  assert.ok(origin); assert.deepEqual(origin.value.runtimeAdmission, selection.admission); assert.deepEqual(origin.value.runtime, selection.runtime);
  assert.equal(f.store.list('model-call').length, 0);
  assert.deepEqual(readAssessmentPaidOrigin(f.open(), 'p', reference(pending))?.value, origin.value);
  // A material that was today's admission when collected but is not any more (the binding moved) does not write M either.
  const stalePending = f.pendingTurn('reviewer-stale-material', [cited], report);
  withTmpdir(t, f.root);
  assert.equal(await f.sessionUntilOrigin(f.store, context, f.input(stalePending, selection.runtime, selection.admission)), 'research_context_application_invalid',
    'the material must be the current admission at the first write');
  assert.equal(f.store.list('assessment-paid-origin').length, 1);
});

test('D8.4d-4 A5/A7 (R4): a lawful zero selection is saved with its proved exclusion and reads back after a restart; the loss of the excluded candidate\'s record is an addressed refusal of M, not a proved exclusion', async t => {
  const f = await runtimeSelectionFixture(t);
  const { collectRuntimeSelection, readRuntimeEvidenceAt } = await import('../src/graph/runtime-evidence.js');
  const observed = await f.observe('proof');
  const cited = f.cite(observed.source!), report = f.report(cited);
  withTmpdir(t, f.root);
  const selection = collectRuntimeSelection(f.store, 'p', f.spec, report, [cited]);
  assert.deepEqual(selection.runtime, f.empty, 'the moved binding admits nothing');
  assert.deepEqual(selection.admission.candidates.map(item => [item.admitted, item.mismatch]), [[false, ['binding']]], 'the exclusion is recorded with its component');
  assert.deepEqual(readRuntimeEvidenceAt(f.store, 'p', f.spec, report, [cited], selection.runtime, selection.admission), selection.runtime, 'zero is lawful on a proved exclusion');
  const pending = f.pendingTurn('lawful-zero', [cited], report);
  const context = { role: 'assess-answer', question: f.spec, value: report, observations: [cited] };
  assert.equal(await f.sessionUntilOrigin(f.store, context, f.input(pending, selection.runtime, selection.admission)), 'fixture_after_runtime_origin');
  const origin = readAssessmentPaidOrigin(f.store, 'p', reference(pending));
  assert.ok(origin); assert.deepEqual(origin.value.runtime, f.empty); assert.deepEqual(origin.value.runtimeAdmission, selection.admission);
  assert.deepEqual(readAssessmentPaidOrigin(f.open(), 'p', reference(pending))?.value, origin.value, 'the zero selection reads back after a restart');
  assert.throws(() => readAssessmentPaidOrigin(f.hiding(f.open(), observed.observation.id), 'p', reference(pending)), { code: 'research_context_application_invalid' },
    'the excluded candidate lost its exact observation: the origin no longer proves its zero selection');
});

test('D8.4d-4 A4 (R6): observed subjects inconsistent with the declared check are a subject-matter refusal of both the current and the historical derivation', async t => {
  const f = await runtimeSelectionFixture(t);
  const { collectRuntimeSelection, readRuntimeEvidenceAt } = await import('../src/graph/runtime-evidence.js');
  const observed = await f.observe('proof');
  const cited = f.cite(observed.source!), report = f.report(cited);
  const selection = collectRuntimeSelection(f.store, 'p', f.spec, report, [cited]);
  assert.equal(selection.runtime.proofs.length, 1);
  const record = f.store.get<Record<string, any>>(observed.observation.id)!;
  const replaced = { ...record, value: { ...record.value, subjects: [] } };
  const view: Store = new Proxy(f.store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) => id === observed.observation.id ? replaced : target.get(id, revision);
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => readRuntimeEvidenceAt(view, 'p', f.spec, report, [cited], selection.runtime), { code: 'runtime_evidence_invalid' });
  assert.throws(() => readRuntimeEvidenceAt(view, 'p', f.spec, report, [cited], selection.runtime, selection.admission), { code: 'runtime_evidence_invalid' });
});

// ---- D8.4d fifth round (№2173): three outcomes of the projection — support, a subject-matter exclusion that re-derives, and a
// lost mandatory basis that is an addressed refusal of the collector, of the session before M and of the historical read.
// Reviewer probes №2172 (two negatives, one positive control) — permanent regressions.
test('D8.4d-5 three outcomes: a missing declared check code Source is a lost mandatory basis — the collector, the session before M and the historical read refuse with the exact Ref; never a proved exclusion (reviewer probes №2172-1/3)', async t => {
  const f = await runtimeSelectionFixture(t);
  const { collectRuntimeSelection, readRuntimeEvidenceAt, projectRuntimeCandidate } = await import('../src/graph/runtime-evidence.js');
  const observed = await f.observe('proof');
  const cited = f.cite(observed.source!), report = f.report(cited), assignment = f.spec.obligations![0]!.assignment!;
  const live = collectRuntimeSelection(f.store, 'p', f.spec, report, [cited]);
  assert.equal(live.runtime.proofs.length, 1);
  const hidden = f.hiding(f.store, f.check.script.id);
  const projection = projectRuntimeCandidate(hidden, 'p', assignment, cited.source);
  assert.equal(projection.kind, 'lost');
  if (projection.kind === 'lost') { assert.equal(projection.reason, 'check-code-missing'); assert.deepEqual(projection.ref, f.check.script); }
  assert.throws(() => collectRuntimeSelection(hidden, 'p', f.spec, report, [cited]), { code: 'runtime_evidence_invalid' }, 'the collector refuses instead of excluding');
  assert.throws(() => readRuntimeEvidenceAt(hidden, 'p', f.spec, report, [cited], live.runtime, live.admission), { code: 'runtime_evidence_invalid' }, 'the historical read of the genuine material refuses on the lost code');
  assert.throws(() => readRuntimeEvidenceAt(hidden, 'p', f.spec, report, [cited], live.runtime), { code: 'runtime_evidence_invalid' }, 'the current replay refuses too');
  const pending = f.pendingTurn('missing-code', [cited], report);
  const claimed = { ...live.admission, candidates: live.admission.candidates.map(item => ({ ...item, admitted: false, mismatch: ['projection:check-code-missing'] })) };
  const emptyContext = { role: 'assess-answer', question: f.spec, value: report, observations: [cited] };
  assert.equal(await f.sessionUntilOrigin(hidden, emptyContext, f.input(pending, f.empty, claimed)), 'research_context_application_invalid', 'a claimed exclusion on a lost basis does not write M');
  const context = { role: 'assess-answer', question: f.spec, value: report, runtimeProofs: live.runtime.proofs, observations: [cited, ...live.runtime.supporting] };
  assert.equal(await f.sessionUntilOrigin(hidden, context, f.input(pending, live.runtime, live.admission)), 'research_context_application_invalid', 'the genuine pair cannot be proved without the code');
  assert.equal(f.store.list('assessment-paid-origin').length, 0, 'no zero-runtime paid origin');
  assert.equal(f.store.list('model-call').length, 0);
  // The real Store still proves the genuine pair: M is written and read back with the material.
  assert.equal(await f.sessionUntilOrigin(f.store, context, f.input(pending, live.runtime, live.admission)), 'fixture_after_runtime_origin');
  assert.ok(readAssessmentPaidOrigin(f.store, 'p', reference(pending)));
  assert.throws(() => readAssessmentPaidOrigin(f.hiding(f.open(), f.check.script.id), 'p', reference(pending)), { code: 'research_context_application_invalid' },
    'the saved origin does not read once the declared code Source is unavailable');
});

test('D8.4d-5 three outcomes (positive control, reviewer probe №2172-2): a changed code FILE with the exact Sources intact is a lawful current exclusion, and that exclusion reads historically after the file is deleted', async t => {
  const f = await runtimeSelectionFixture(t);
  const { collectRuntimeSelection, readRuntimeEvidenceAt } = await import('../src/graph/runtime-evidence.js');
  const observed = await f.observe('proof');
  const cited = f.cite(observed.source!), report = f.report(cited);
  writeFileSync(join(f.root, 'check.mjs'), "console.log('changed code')\n");
  const selection = collectRuntimeSelection(f.store, 'p', f.spec, report, [cited]);
  assert.equal(selection.runtime.proofs.length, 0);
  assert.ok(selection.admission.candidates[0]!.mismatch.some(part => part.startsWith('current:')), 'today\'s file differs: a current-admission exclusion, recorded as such');
  unlinkSync(join(f.root, 'check.mjs'));
  assert.deepEqual(readRuntimeEvidenceAt(f.open(), 'p', f.spec, report, [cited], selection.runtime, selection.admission), selection.runtime,
    'history reads the recorded exclusion without today\'s file');
});

test('D8.4d-5 three outcomes: the authorization and the environment of an observation are mandatory bases — each hidden is an addressed refusal; an observation of another check declaration is a lawful, re-derivable exclusion', async t => {
  const f = await runtimeSelectionFixture(t);
  const { configureResearchScope } = await import('../src/graph/research-scope.js');
  const { collectRuntimeSelection, readRuntimeEvidenceAt, projectRuntimeCandidate } = await import('../src/graph/runtime-evidence.js');
  const observed = await f.observe('proof');
  const cited = f.cite(observed.source!), report = f.report(cited), assignment = f.spec.obligations![0]!.assignment!;
  const live = collectRuntimeSelection(f.store, 'p', f.spec, report, [cited]);
  assert.equal(live.runtime.proofs.length, 1);
  for (const [name, id, reason] of [['authorization', observed.observation.value.scope.id, 'authorization-missing'],
    ['environment', observed.observation.value.environment.id, 'environment-missing']] as const) {
    const hidden = f.hiding(f.store, id);
    const projection = projectRuntimeCandidate(hidden, 'p', assignment, cited.source);
    assert.equal(projection.kind, 'lost', name);
    if (projection.kind === 'lost') { assert.equal(projection.reason, reason); assert.equal(projection.ref.id, id); }
    assert.throws(() => collectRuntimeSelection(hidden, 'p', f.spec, report, [cited]), { code: 'runtime_evidence_invalid' }, name);
    assert.throws(() => readRuntimeEvidenceAt(hidden, 'p', f.spec, report, [cited], live.runtime, live.admission), { code: 'runtime_evidence_invalid' }, name);
  }
  // Another declaration of the same obligation (a changed check purpose) authorizes a second observation; cited for the
  // original question it is a candidate of another check: excluded on subject-matter grounds, and history re-derives it.
  const policy = f.scope.value.policy!;
  const other = configureResearchScope(f.store, { ...f.scope.value, policy: { ...policy,
    assignments: [{ ...policy.assignments[0]!, runtimeCheck: { ...f.check, purpose: 'Observe the same script for another purpose' } }] } }, f.scope.revision);
  const foreign = await f.engine.execute({ type: 'observe-runtime', project: 'p', scope: reference(other), obligation: 'boundary', key: 'other-check' }) as import('../src/runtime/runtime-observation.js').RuntimeObservationResult;
  const foreignCitation = f.cite(foreign.source!), mixed = f.report(cited, [foreignCitation]);
  const projection = projectRuntimeCandidate(f.store, 'p', assignment, foreignCitation.source);
  assert.equal(projection.kind, 'excluded'); if (projection.kind === 'excluded') assert.equal(projection.reason, 'another-check');
  const selection = collectRuntimeSelection(f.store, 'p', f.spec, mixed, [cited, foreignCitation]);
  assert.deepEqual(selection.admission.candidates.map(item => [item.citation, item.admitted, item.mismatch]), [[0, true, []], [1, false, ['projection:another-check']]]);
  assert.equal(selection.runtime.proofs.length, 1);
  assert.deepEqual(readRuntimeEvidenceAt(f.open(), 'p', f.spec, mixed, [cited, foreignCitation], selection.runtime, selection.admission), selection.runtime);
  assert.throws(() => readRuntimeEvidenceAt(f.hiding(f.open(), foreign.observation.id), 'p', f.spec, mixed, [cited, foreignCitation], selection.runtime, selection.admission),
    { code: 'runtime_evidence_invalid' }, 'the excluded candidate\'s lost record is still a lost basis');
});

/** D8.4e R2: the L3 answer_delta setup of 'a paid L3 terminal binds from its exact original graph after the head moved', up to the scripted replies — the run itself is the test's. */
function l3DeltaFixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84-layer-graph-')));
  const database = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  const full = enrichedGraph(exampleGraph('p'), 'p');
  preparedFeatures(engine, 'p', full);
  const { level: _level, ...initial } = projectGraph(full, 1);
  engine.graphs.save('p', initial, store.get('graph:p')!.revision, 'fixture');
  writeFileSync(join(root, 'README.md'), 'A local scoped transformation with an atomic result and recovery.\n');
  const adapter = join(root, 'adapter.mjs'), replies = join(root, 'replies.json'), wire = join(root, 'wire.ndjson');
  writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,f=JSON.parse(readFileSync(${JSON.stringify(replies)},'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify({role:s.role,mode:s.dispatchMode,previous:s.previousProposalRef??null})+'\\n');
const research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}
 :s.dispatchMode==='planning'?{action:'synthesize',question:s.question.id}
 :{action:'answer_delta',question:s.question.id,base:s.graphBase,
   ...(s.previousProposalRef?{...f.correction,revises:s.previousProposalRef}:f.first),citations:f.citations};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,
 usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const pilot = configureReaderPilot(store, engine.environments, 'p', {
    experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command },
    agentCommand: command, maxRequestChars: 100000, maxReadChars: 60000,
    maxReplyChars: 100000, maxCalls: 12, maxReportedTokens: 100000,
    planning: { fields: ['layerDesign'], maxRequestChars: 100000, maxRounds: 3 } }, 0);
  configurePhasePolicy(store, 'p', 'L3', 'layer-refusal', 0);
  const calibrated = pilotEnvironment(engine.environments.get('p').value, pilot.value);
  for (const [purpose, role] of [['reading-planner', calibrated.implementer],
    ['analyst', calibrated.implementer], ['assessor', calibrated.reviewer]] as const) {
    store.write({ id: `model-call:layer-calibration-${purpose}`, kind: 'model-call', expected: 0,
      value: { projectId: 'p', draftId: 'fixture', purpose, requestId: `layer-calibration-${purpose}`,
        startedAt: 0, finishedAt: 1, status: 'succeeded', requested: role,
        confirmed: { model: null, effort: null, speed: null },
        request: { chars: 1000, bytes: 1000, hash: hashJson(purpose) }, response: null,
        usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 0, reasoningOutputTokens: 0 },
        usageSource: 'adapter', error: null } });
  }
  const r0 = engine.refinement.begin('p', 'R0');
  engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
  engine.refinement.sealLayer('p', 1, 0);
  const r1 = engine.refinement.begin('p', 'R1');
  answerTechnicalFixture(engine, 'p', r1);
  engine.refinement.finishResearch('p', 'R1', reference(store.get(r1.id)!), 0);
  const l2 = engine.refinement.prepareLayer('p', 2);
  const ready2 = answerLayerFixture(engine, 'p', l2, 2, full);
  engine.refinement.buildLayer('p', 2, reference(ready2), store.get('graph:p')!.revision, 'fixture');
  engine.refinement.sealLayer('p', 2, 0);
  configureResearchScope(store, { projectId: 'p', layer: reference(store.get('graph-layer:p:2')!),
    r1: reference(store.get('phase:p:R1')!), outcome: 'Validated local output',
    nodes: full.nodes.filter(node => node.kind === 'operation').map(node => node.id),
    boundaries: [], expansions: [], obligations: [], changedPaths: [], uiRequired: false }, 0);
  const r2 = engine.refinement.begin('p', 'R2');
  answerTechnicalFixture(engine, 'p', r2);
  engine.refinement.finishResearch('p', 'R2', reference(store.get(r2.id)!), 0);
  const draft = engine.refinement.prepareLayer('p', 3);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const source = engine.discovery.evidence.document('p', 'design-source',
    'The accepted layer and proposed atomic work share the same product scope.', 'text/plain', 0);
  const citations = [{ source: reference(source), selector: { kind: 'text-range' as const, start: 0, end: source.value.content.length } }];
  const delta = layerDeltaView(store, 'p', layerDesignOf(full, 3, question.value.spec.layerAssembly), 3,
    question.value.spec.layerAssembly);
  writeFileSync(replies, JSON.stringify({ first: { horizon: delta.horizon, upserts: delta.upserts, removes: delta.removes },
    correction: { upserts: {}, removes: {} }, citations }));
  return { root, database, store, engine, draft, question, open, replies, wire, full };
}

// ===========================================================================
// D8.4e (№2211): the acceptance record K, the era marker of §4 and the
// completion of the original paid turn — rows R1–R17 of the reviewer's table.
// Every fixture drives the real producers (runner, assessor, Discovery) with
// a scripted adapter; interruptions are the fixture's own thrown errors after
// (or before) a named durable write, never edited records — except where a
// row is about damaged or substituted records, which are rewritten in place
// with recalculated hashes and restored afterwards.
// ===========================================================================
function acceptanceFixture(t: test.TestContext, options: { neighbor?: boolean; second?: boolean; prefix?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), `omg-d84e-${options.prefix ?? 'acceptance'}-`));
  const database = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(database); stores.push(db); return db; };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Acceptance record' });
  const source = engine.discovery.evidence.document('p', 'proof', 'Grounded local condition', 'text/plain', 0);
  const wire = join(root, 'wire.ndjson'), adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify({role:s.role??null})+'\\n');
const research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}
 :{action:'answer',question:s.questions[0].id,value:{ok:true},citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'text-range',start:0,end:24}}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation', [
    { field: 'result', kind: 'design', prompt: 'Resolve result', risk: 'Missing source', schema: { type: 'object' } },
    ...(options.second ? [{ field: 'second', kind: 'design' as const, prompt: 'Resolve second', risk: 'Missing second', schema: { type: 'object' } }] : []),
    ...(options.neighbor === false ? [] : [{ field: 'neighbor', kind: 'decision' as const, prompt: 'Owner chooses neighbor',
      risk: 'Undecided neighbor', schema: { type: 'object' } }])]);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const calls = (db: Store = store) => db.list('model-call').length;
  const counts = (db: Store = store) => ({ calls: db.list('model-call').length, answers: db.list('research-answer').length,
    assessments: db.list('research-assessment').length, bindings: db.list('research-acceptance-binding').length,
    turns: db.list('research-turn').length });
  const paidTurn = (db: Store = store) => db.list<ResearchTurn>('research-turn')
    .filter(turn => turn.id.startsWith('research-turn:v1:')).sort((a, b) => a.value.number - b.value.number)[0]!;
  const binding = (db: Store = store) => db.get<ResearchAcceptanceBinding>(acceptanceBindingId('p', paidTurn(db).id));
  const hook = (db: Store, predicate: (writes: Write[]) => boolean, act: (writes: Write[]) => void,
    label: string, when: 'before' | 'after' = 'after') => {
    const original = db.writeMany.bind(db); let hit = false;
    db.writeMany = ((writes: Write[], guards: any = []) => {
      if (when === 'before' && !hit && predicate(writes)) { hit = true; act(writes); }
      const rows = original(writes, guards);
      if (when === 'after' && !hit && predicate(writes)) { hit = true; act(writes); }
      return rows;
    }) as typeof db.writeMany;
    return () => { db.writeMany = original; assert.ok(hit, `the fixture hook fired (${label})`); };
  };
  // A typed interruption stands for a refusal of the path; a CRASH after a
  // durable write (the process dying) is a plain Error — D8.4e-3 W5: never a
  // typed refusal that the managed wrapper could resolve into the own record.
  const interruptAfter = (db: Store, predicate: (writes: Write[]) => boolean, code: string, crash = false) =>
    hook(db, predicate, () => {
      if (crash) throw Object.assign(new Error(`Fixture crashed after the durable write (${code})`), { code });
      throw new EngineError(code, 'Fixture interrupted after the durable write');
    }, code, 'after');
  const rewrite = (id: string, revision: number, value: unknown) => {
    const raw = new DatabaseSync(database);
    try {
      raw.exec('DROP TRIGGER IF EXISTS revisions_no_update');
      raw.prepare('UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?')
        .run(canonical(value), hashJson(value), id, revision);
    } finally { raw.close(); }
  };
  const decideNeighbor = (db: Store = store) => {
    const neighbor = db.get<Question>(draft.value.questions.at(-1)!)!;
    return new ProductEngine(db).discovery.decision(neighbor.id, neighbor.revision, 'owner', { ready: true });
  };
  return { root, database, store, engine, source, environment, draft, question, adapter, wire, open, calls, counts,
    paidTurn, binding, hook, interruptAfter, rewrite, decideNeighbor };
}
type AcceptanceFixture = ReturnType<typeof acceptanceFixture>;
const K_WRITE = (writes: Write[]) => writes.some(write => write.kind === 'research-acceptance-binding');
const B_WRITE = (writes: Write[]) => writes.some(write => write.kind === 'research-assessment-binding');
const T_WRITE = (writes: Write[]) => writes.some(write => write.kind === 'research-turn'
  && (write.value as ResearchTurn).status === 'completed'
  && (write.value as { acceptanceBinding?: unknown }).acceptanceBinding !== undefined);
const managedOf = (turn: Revision<ResearchTurn>) => turn.value as ManagedResearchTurn;

test('D8.4e §4 era: the runner application fixes the acceptance contract on O@1; the validator refuses a turn write without it or with another; readers keep it immutable', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'era' });
  const outcomes: string[] = [];
  const restore = f.hook(f.store, writes => writes.some(write => write.kind === 'research-turn' && write.expected === 0
    && (write.value as Partial<ManagedResearchTurn>).contract === 'research-consumer-turn/v1'), writes => {
    const turnWrite = writes.find(write => write.kind === 'research-turn')!;
    const runWrite = writes.find(write => write.kind === 'research-run')!;
    const intent = f.store.list<ResearchConsumerIntent>('research-consumer-intent')
      .find(item => item.value.kind === 'analyst' && item.value.state === 'running')!;
    const paid = readResearchConsumerExecution(f.store, 'p', reference(intent));
    const guards = [reference(f.store.get(runWrite.id)!), { id: turnWrite.id, absent: true as const },
      reference(f.store.get('environment:p')!)];
    const attempt = (turn: unknown) => {
      try {
        prepareResearchConsumerApplication(f.store, reference(intent), reference(paid.call),
          [runWrite, { ...turnWrite, value: turn }], guards);
        return 'accepted';
      } catch (error) { return error instanceof EngineError ? error.code : 'other'; }
    };
    const { acceptanceContract, ...without } = turnWrite.value as ManagedResearchTurn;
    outcomes.push(String(acceptanceContract), attempt(turnWrite.value), attempt(without),
      attempt({ ...without, acceptanceContract: 'research-acceptance-binding/v0' }));
  }, 'era-application', 'before');
  const run = await f.engine.researcher.run('p', f.draft.id, 1);
  restore();
  assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
  assert.deepEqual(outcomes, [ACCEPTANCE_BINDING_CONTRACT, 'accepted',
    'research_consumer_intent_invalid', 'research_consumer_intent_invalid']);
  const turn = f.paidTurn(), original = f.store.get<ManagedResearchTurn>(turn.id, 1)!;
  assert.equal(original.value.acceptanceContract, ACCEPTANCE_BINDING_CONTRACT);
  assert.equal(acceptanceEraOf(original.value), 'binding');
  assert.equal(managedOf(turn).acceptanceContract, ACCEPTANCE_BINDING_CONTRACT,
    'the completed revision carries the producer marker unchanged');
  // A later revision that drops or rewrites the marker is refused like a rewritten paid action.
  const { acceptanceContract: _dropped, ...stripped } = managedOf(turn);
  f.rewrite(turn.id, turn.revision, stripped);
  assert.throws(() => readResearchConsumerTurn(f.open(), { id: turn.id, revision: turn.revision, hash: hashJson(stripped) }),
    { code: 'research_consumer_intent_invalid' });
  f.rewrite(turn.id, turn.revision, turn.value);
  // An unknown contract on the original is a refusal, not another era.
  f.rewrite(turn.id, 1, { ...original.value, acceptanceContract: 'research-acceptance-binding/v0' });
  assert.throws(() => readResearchConsumerTurn(f.open(), reference(turn)), { code: 'research_consumer_intent_invalid' });
  f.rewrite(turn.id, 1, original.value);
  // A legacy-address turn cannot claim the marker or a binding link.
  for (const claim of [{ acceptanceContract: ACCEPTANCE_BINDING_CONTRACT }, { acceptanceBinding: reference(f.binding()!) }]) {
    const legacy = f.store.write<ResearchTurn>({ id: `research-turn:${hashJson(['legacy', Object.keys(claim)[0]])}`,
      kind: 'research-turn', expected: 0,
      value: { run: 'research-run:legacy', number: 1, action: { action: 'pause', reason: 'legacy' }, assessment: null,
        observation: null, error: null, status: 'pending', question: null, ...claim } as ResearchTurn });
    assert.throws(() => readResearchConsumerTurn(f.store, reference(legacy)), { code: 'research_consumer_intent_invalid' });
  }
  readResearchConsumerTurn(f.open(), reference(turn));
});

test('D8.4e §4 era: the synthesis handoff fixes the same acceptance contract on its original turn through the shared projection', async t => {
  const f = await synthesisV2Fixture(t, `
if(c.dispatchMode==='planning')research={action:'synthesize',question:c.question.id};
else research={action:'pause',reason:'Hold the run'};`);
  const siblingValue = { applicability: 'applicable', reason: 'Settled by the owner', facts: [],
    designs: [{ id: 'sibling-design', decision: 'A settled sibling', benefit: 'Focus', consumer: 'compilation' }], gaps: [] };
  for (const id of f.draft.value.questions.slice(1)) {
    const sibling = f.store.get<Question>(id)!;
    f.engine.discovery.decision(sibling.id, sibling.revision, 'owner', siblingValue);
  }
  const { projectId: _p, ...settings } = f.pilot.value;
  configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
    planning: { fields: [f.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, f.pilot.revision);
  const run = await f.engine.researcher.run('p', f.draft.id, 4);
  assert.equal(run.value.status, 'paused', JSON.stringify(run.value));
  const handoff = f.store.list<ResearchTurn>('research-turn')
    .find(turn => turn.id.startsWith('research-turn:v1:') && turn.value.dispatchMode === 'synthesis')!;
  assert.ok(handoff, 'the synthesis outcome was handed off to a managed turn');
  const original = f.store.get<ManagedResearchTurn>(handoff.id, 1)!;
  assert.equal(original.value.acceptanceContract, ACCEPTANCE_BINDING_CONTRACT);
  assert.equal(acceptanceEraOf(original.value), 'binding');
  assert.deepEqual(original.value, projectSynthesisHandoffTurn({ intent: original.value.consumerIntent,
    runId: original.value.run, number: original.value.number, action: original.value.action, question: original.value.question }));
  readResearchConsumerTurn(f.open(), reference(handoff));
});

test('DR3a3-K regression: the v6 field path keeps its era — O@1 without attemptContract or subject; a call carrying a plan answer is not the field intent\'s call; an attempt claim on a v6 turn is refused', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'v6-attempt' });
  const outcomes: string[] = [];
  const restore = f.hook(f.store, writes => writes.some(write => write.kind === 'model-call' && write.expected === 0
    && write.id.startsWith('model-call:consumer:v1:')), writes => {
    const callWrite = writes.find(write => write.kind === 'model-call')!;
    const call = callWrite.value as Record<string, any>;
    const intent = readResearchConsumerIntent(f.store, call.consumerIntent);
    const reserve = (value: Record<string, unknown>) => {
      try {
        prepareResearchConsumerReservation(f.store, reference(intent), { ...callWrite, value: value as never },
          call.request.record, call.packet.archive);
        return 'accepted';
      } catch (error) { return error instanceof EngineError ? error.code : 'other'; }
    };
    const planAnswer = { id: 'research-answer:p:plan', revision: 1, hash: hashJson('plan') };
    outcomes.push(String(intent.value.kind), String(planSubjectOf(intent.value.cursor)), reserve(call),
      reserve({ ...call, planAnswer }), reserve({ ...call, questionId: 'q-industry', planAnswer }));
  }, 'v6-reservation', 'before');
  const run = await f.engine.researcher.run('p', f.draft.id, 1);
  restore();
  assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
  // The real field intent has no subject; its own call reserves; the same call with a plan answer, or
  // addressed to a plan-question, is not this intent's call.
  assert.deepEqual(outcomes, ['analyst', 'null', 'accepted', 'research_consumer_intent_invalid',
    'research_consumer_intent_invalid']);
  const turn = f.paidTurn(), original = f.store.get<ManagedResearchTurn>(turn.id, 1)!;
  for (const field of ['attemptContract', 'subject', 'attempt', 'attemptBinding'])
    assert.equal(Object.hasOwn(managedOf(turn), field) || Object.hasOwn(original.value, field), false, field);
  assert.equal(attemptEraOf(original.value), 'answer');
  assert.equal(original.value.acceptanceContract, ACCEPTANCE_BINDING_CONTRACT);
  assert.ok(f.binding(), 'the v6 answer still completes through its acceptance binding');
  const paid = f.store.list<ModelCall>('model-call').find(item => canonical((item.value as { consumerIntent?: unknown }).consumerIntent ?? null)
    === canonical(original.value.consumerIntent))!;
  assert.equal(Object.hasOwn(paid.value, 'planAnswer'), false, 'a v6 call gets no new fields');
  assert.equal(callAddressesSubject(paid.value as unknown as Record<string, unknown>, reference(f.question), null), true);
  // An attempt-era claim on the v6 original (marker and subject the intent never fixed) is refused.
  const subject = { contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: { id: 'research-answer:p:plan', revision: 1,
    hash: hashJson('plan') }, planQuestionId: 'q-industry' };
  f.rewrite(turn.id, 1, { ...original.value, attemptContract: ATTEMPT_BINDING_CONTRACT, subject });
  assert.throws(() => readResearchConsumerTurn(f.open(), reference(turn)), { code: 'research_consumer_intent_invalid' });
  f.rewrite(turn.id, 1, original.value);
  // A completed v6 turn cannot acquire an attempt link.
  const linked = { ...managedOf(turn), attemptBinding: reference(f.binding()!) };
  f.rewrite(turn.id, turn.revision, linked);
  assert.throws(() => readResearchConsumerTurn(f.open(), { id: turn.id, revision: turn.revision, hash: hashJson(linked) }),
    { code: 'research_consumer_intent_invalid' });
  f.rewrite(turn.id, turn.revision, turn.value);
  readResearchConsumerTurn(f.open(), reference(turn));
});

test('D8.4e R1: a supported managed answer writes draft, answer, question and K in one transaction and completes the turn from K', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'r1' });
  const transactions: string[][] = [];
  const original = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes: Write[], guards: any = []) => {
    transactions.push(writes.map(write => write.kind).sort()); return original(writes, guards);
  }) as typeof f.store.writeMany;
  const run = await f.engine.researcher.run('p', f.draft.id, 1);
  f.store.writeMany = original;
  assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
  assert.deepEqual(transactions.find(kinds => kinds.includes('research-acceptance-binding')),
    ['discovery-draft', 'discovery-prefix-closure', 'question', 'research-acceptance-binding', 'research-answer']);
  const turn = f.paidTurn(), k = f.binding()!;
  assert.ok(k); assert.equal(k.revision, 1); assert.equal(k.kind, 'research-acceptance-binding');
  assert.equal(turn.value.status, 'completed'); assert.equal(turn.revision, 2);
  assert.deepEqual(managedOf(turn).acceptanceBinding, reference(k));
  assert.equal(managedOf(turn).acceptanceContract, ACCEPTANCE_BINDING_CONTRACT);
  const chain = managedOf(turn).acceptance!;
  assert.deepEqual([chain.draftBefore, chain.draftAfter, chain.questionBefore, chain.questionAfter, chain.answer, chain.assessment],
    [k.value.draftBefore, k.value.draftAfter, k.value.questionBefore, k.value.questionAfter, k.value.answer, k.value.assessment]);
  assert.deepEqual(k.value.turn, reference(f.store.get(turn.id, 1)!));
  assert.deepEqual(k.value.pending, k.value.turn, 'P is O@1: no pending revision followed the original');
  assert.deepEqual(k.value.intent, managedOf(turn).consumerIntent);
  assert.deepEqual(k.value.assessmentProof, reference(f.store.get(assessmentBindingId('p', turn.id))!));
  assert.deepEqual(Object.keys(k.value).sort(), ['answer', 'assessment', 'assessmentProof', 'contract', 'draftAfter',
    'draftBefore', 'intent', 'pending', 'projectId', 'questionAfter', 'questionBefore', 'turn']);
  const proven = readResearchAcceptanceBinding(f.open(), 'p', turn.id)!;
  assert.deepEqual(reference(proven.pending), k.value.pending);
  assert.deepEqual(reference(proven.assessment), k.value.assessment);
  assert.deepEqual(Object.keys(proven.inputs.answer.value).sort(), ['assessment', 'projectId', 'question', 'value']);
  assert.deepEqual(readResearchConsumerTurn(f.open(), reference(turn)).value, turn.value);
  const counts = f.counts();
  assert.deepEqual([counts.answers, counts.assessments, counts.bindings, counts.turns], [1, 1, 1, 1]);
  assert.equal(f.store.get<Question>(f.question.id)!.revision, 2);
});

test('D8.4e R2: an accepted answer_delta records K with the exact original proposal bases; the history stays readable after the graph head moved', async t => {
  const f = l3DeltaFixture(t);
  const run = await f.engine.researcher.run('p', f.draft.id, 4);
  const turn = f.store.list<ResearchTurn>('research-turn')
    .find(item => item.id.startsWith('research-turn:v1:') && (item.value.action as { action?: string })?.action === 'answer_delta')!;
  assert.ok(turn, JSON.stringify(run.value));
  assert.equal(turn.value.status, 'completed', JSON.stringify({ run: run.value, turn: turn.value }));
  const k = f.store.get<ResearchAcceptanceBinding>(acceptanceBindingId('p', turn.id))!;
  assert.ok(k, 'the delta acceptance wrote its record');
  assert.deepEqual(managedOf(turn).acceptanceBinding, reference(k));
  const proven = readResearchAcceptanceBinding(f.open(), 'p', turn.id)!;
  assert.notEqual(proven.inputs.expandedProposal, undefined);
  assert.deepEqual(proven.inputs.expandedProposal, proven.assessment.value.value);
  const graph = f.store.get<Graph>('graph:p')!, block = graph.value.nodes.find(node => node.kind === 'block')!;
  f.engine.graphs.save('p', { ...graph.value,
    nodes: graph.value.nodes.map(node => node.id === block.id ? { ...node, purpose: `${node.purpose} moved after acceptance` } : node) },
    graph.revision, 'fixture');
  const again = readResearchAcceptanceBinding(f.open(), 'p', turn.id)!;
  assert.deepEqual(again.inputs.expandedProposal, proven.inputs.expandedProposal,
    'the delta expands against its exact original bases, not today\'s graph');
  readResearchConsumerTurn(f.open(), reference(turn));
});

test('D8.4e R3: the shared projection accepts a lawful later pending revision of the same turn and refuses foreign or later original links', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'r3' });
  await f.engine.researcher.run('p', f.draft.id, 1);
  const turn = f.paidTurn(), k = f.binding()!, proven = readResearchAcceptanceBinding(f.open(), 'p', turn.id)!;
  const links = { turn: k.value.turn, pending: k.value.pending, intent: k.value.intent, assessmentProof: k.value.assessmentProof };
  assert.deepEqual(projectAcceptanceBinding(proven.inputs, links), k.value, 'the producer projection re-derives the saved record');
  const later = projectAcceptanceBinding(proven.inputs, { ...links, pending: { ...k.value.pending, revision: 3, hash: hashJson({ later: true }) } });
  assert.deepEqual([later.turn, later.intent, later.pending.revision], [k.value.turn, k.value.intent, 3],
    'O and I are preserved while P is the consumed later revision');
  for (const [name, bad] of [
    ['a pending of another turn', { ...links, pending: { ...k.value.pending, id: 'research-turn:v1:other' } }],
    ['an original beyond revision 1', { ...links, turn: { ...k.value.turn, revision: 2 } }],
    ['an intent beyond revision 1', { ...links, intent: { ...k.value.intent, revision: 2 } }],
  ] as const) assert.throws(() => projectAcceptanceBinding(proven.inputs, bad), { code: 'research_acceptance_binding_invalid' }, name);
});

test('D8.4e R4: a failure after the paid assessment and before the acceptance reuses the same assessment; a stale target refuses without the four writes or new payment', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'r4' });
  const restore = f.interruptAfter(f.store, B_WRITE, 'fixture_after_assessment');
  const first = await f.engine.researcher.run('p', f.draft.id, 1);
  restore();
  assert.equal(first.value.pauseCode, 'fixture_after_assessment');
  const before = f.counts();
  assert.deepEqual([before.answers, before.bindings, before.assessments], [0, 0, 1]);
  const db = f.open(), resumed = await new ProductEngine(db).researcher.run('p', f.draft.id, 1);
  assert.equal(resumed.value.status, 'completed', JSON.stringify(resumed.value));
  assert.deepEqual(f.counts(db), { ...before, answers: 1, bindings: 1 }, 'the same paid assessment is accepted without a new call');
  assert.equal(f.paidTurn(db).value.status, 'completed');
  const g = acceptanceFixture(t, { neighbor: false, prefix: 'r4-stale' });
  const restoreG = g.interruptAfter(g.store, B_WRITE, 'fixture_after_assessment');
  await g.engine.researcher.run('p', g.draft.id, 1);
  restoreG();
  const draft = g.store.get<any>(g.draft.id)!;
  g.store.write({ id: draft.id, kind: draft.kind, expected: draft.revision,
    value: { ...draft.value, fields: { ...draft.value.fields, result: { moved: true } } } });
  const beforeG = g.counts();
  const stale = await new ProductEngine(g.open()).researcher.run('p', g.draft.id, 1);
  assert.equal(stale.value.status, 'paused', JSON.stringify(stale.value));
  assert.equal(stale.value.pauseCode, 'target_stale');
  assert.deepEqual(g.counts(), beforeG, 'no acceptance write, no new payment');
  assert.equal(g.paidTurn().value.status, 'pending');
});

test('D8.4e R5: a crash after the atomic acceptance and before the completed turn is finished by a new Store from K without new work', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'r5' });
  const restore = f.interruptAfter(f.store, K_WRITE, 'fixture_after_acceptance', true);
  const first = await f.engine.researcher.run('p', f.draft.id, 1);
  restore();
  assert.equal(first.value.pauseCode, 'research_interrupted', 'a crash after the durable acceptance');
  const before = f.counts();
  assert.deepEqual([before.answers, before.bindings, before.assessments], [1, 1, 1]);
  assert.equal(f.paidTurn().value.status, 'pending');
  const db = f.open(), resumed = await new ProductEngine(db).researcher.run('p', f.draft.id, 1);
  assert.equal(resumed.value.status, 'completed', JSON.stringify(resumed.value));
  const turn = f.paidTurn(db);
  assert.equal(turn.value.status, 'completed'); assert.equal(turn.revision, 2);
  assert.deepEqual(managedOf(turn).acceptanceBinding, reference(f.binding(db)!));
  assert.deepEqual(f.counts(db), before, 'answer, K, assessment and model-call counts do not grow');
  readResearchConsumerTurn(f.open(), reference(turn));
});

test('D8.4e R6: an independent neighbour accepted before our acceptance stays in our own adjacent pair; the assessment draft is not imposed as the head', async t => {
  const f = acceptanceFixture(t, { neighbor: true, prefix: 'r6' });
  const restore = f.interruptAfter(f.store, B_WRITE, 'fixture_after_assessment');
  await f.engine.researcher.run('p', f.draft.id, 1);
  restore();
  const assessed = f.store.get<any>(f.draft.id)!;
  const advanced = f.decideNeighbor();
  assert.equal(advanced.revision, assessed.revision + 1);
  const calls = f.calls();
  const db = f.open(), resumed = await new ProductEngine(db).researcher.run('p', f.draft.id, 1);
  assert.equal(resumed.value.status, 'completed', JSON.stringify(resumed.value));
  assert.equal(f.calls(db), calls);
  const k = f.binding(db)!, turn = f.paidTurn(db);
  assert.equal(k.value.draftBefore.revision, advanced.revision);
  assert.equal(k.value.draftAfter.revision, advanced.revision + 1);
  const proven = readResearchAcceptanceBinding(f.open(), 'p', turn.id)!;
  assert.deepEqual(proven.inputs.draftBefore.value.fields['neighbor'], { ready: true });
  assert.deepEqual(proven.inputs.draftAfter.value.fields['neighbor'], { ready: true });
  const proof = db.get<Record<string, any>>(assessmentBindingId('p', turn.id))!;
  assert.equal(proof.value.draft.revision, assessed.revision, 'the assessment keeps its own captured draft');
  assert.equal(turn.value.status, 'completed');
  readResearchConsumerTurn(f.open(), reference(turn));
});

test('D8.4e R7: after K a neighbour decision, a re-configured environment or a moved Source head leave the history readable by its exact sources; the turn completes without new work and the new admission is separate', async t => {
  const f = acceptanceFixture(t, { neighbor: true, prefix: 'r7' });
  const restore = f.interruptAfter(f.store, K_WRITE, 'fixture_after_acceptance', true);
  await f.engine.researcher.run('p', f.draft.id, 1);
  restore();
  const before = f.counts();
  f.decideNeighbor();
  const environment = f.store.get<any>('environment:p')!;
  f.engine.environments.configure('p', { ...environment.value, timeoutMs: 6000 }, environment.revision);
  const db = f.open(), resumed = await new ProductEngine(db).researcher.run('p', f.draft.id, 1);
  assert.equal(resumed.value.status, 'completed', JSON.stringify(resumed.value));
  assert.deepEqual(f.counts(db), before, 'no repeated researched, assessment or dispatch');
  const turn = f.paidTurn(db);
  assert.equal(turn.value.status, 'completed');
  readResearchConsumerTurn(f.open(), reference(turn));
  // A moved head of the cited Source after K: the turn still completes from K on the restart and the history reads by
  // its exact captured source. The new admission is separate: the gate finds the accepted evidence stale, reopens the
  // question and the new research refuses on the moved head — without touching the completed turn or its record.
  const g = acceptanceFixture(t, { neighbor: false, prefix: 'r7-source' });
  const restoreG = g.interruptAfter(g.store, K_WRITE, 'fixture_after_acceptance', true);
  await g.engine.researcher.run('p', g.draft.id, 1);
  restoreG();
  const pending = g.paidTurn(), beforeG = g.counts();
  const source = g.store.get<any>(g.source.id)!;
  g.store.write({ id: source.id, kind: source.kind, expected: source.revision,
    value: { ...source.value, content: 'Later unrelated source head', sha256: digest('Later unrelated source head') } });
  const dbG = g.open(), resumedG = await new ProductEngine(dbG).researcher.run('p', g.draft.id, 1);
  const completed = dbG.get<ResearchTurn>(pending.id)!;
  assert.equal(completed.revision, pending.revision + 1);
  assert.equal(completed.value.status, 'completed');
  assert.deepEqual(managedOf(completed).acceptanceBinding, reference(g.binding(dbG)!));
  const after = g.counts(dbG);
  assert.deepEqual([after.answers, after.bindings, after.assessments], [beforeG.answers, beforeG.bindings, beforeG.assessments],
    'the completed acceptance is not repeated');
  assert.equal(resumedG.value.status, 'paused', JSON.stringify(resumedG.value));
  assert.equal(resumedG.value.pauseCode, 'source_stale', 'the new admission on the moved head is a separate typed outcome');
  const proven = readResearchAcceptanceBinding(g.open(), 'p', pending.id)!;
  assert.deepEqual(proven.inputs.answer.value.value, { ok: true });
  readResearchConsumerTurn(g.open(), reference(completed));
  // The accepted question reopened after K and before T: the completion still derives from K on the restart (the
  // question head is not a condition of it); the reopened question is then new work of the run, counted apart.
  const r = acceptanceFixture(t, { neighbor: false, prefix: 'r7-reopen' });
  const restoreR = r.interruptAfter(r.store, K_WRITE, 'fixture_after_acceptance', true);
  await r.engine.researcher.run('p', r.draft.id, 1);
  restoreR();
  const pendingR = r.paidTurn(), k1 = r.binding()!, answered = r.store.get<Question>(r.question.id)!;
  assert.equal(answered.value.status, 'answered');
  r.engine.discovery.reopen(answered.id, answered.revision);
  const dbR = r.open(), resumedR = await new ProductEngine(dbR).researcher.run('p', r.draft.id, 1);
  const completedR = dbR.get<ResearchTurn>(pendingR.id, pendingR.revision + 1)!;
  assert.ok(completedR, JSON.stringify(resumedR.value));
  assert.equal(completedR.value.status, 'completed');
  assert.deepEqual(managedOf(completedR).acceptanceBinding, reference(k1));
  assert.deepEqual(readResearchConsumerTurn(r.open(), reference(completedR)).value, completedR.value);
  assert.deepEqual(dbR.get(k1.id)!.value, k1.value, 'K of the first acceptance is untouched by the reopened question');
});

test('D8.4e R8: a repeat after the completed turn, on the same and on new Stores, returns the same proven completion without new revisions or spend', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'r8' });
  const first = await f.engine.researcher.run('p', f.draft.id, 1);
  assert.equal(first.value.status, 'completed', JSON.stringify(first.value));
  const turn = f.paidTurn(), before = f.counts();
  for (const db of [f.store, f.open(), f.open()]) {
    const again = await new ProductEngine(db).researcher.run('p', f.draft.id, 1);
    assert.equal(again.value.status, 'completed');
    assert.deepEqual(f.paidTurn(db), turn);
    assert.deepEqual(f.counts(db), before);
  }
});

test('D8.4e R9: two Stores accepting one paid turn write one K and one answer; the loser proves the winner and completes the same turn once', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'r9-accept' });
  const rival = f.open();
  let rivalAccepted: Revision<unknown> | null = null;
  const restore = f.hook(f.store, K_WRITE, writes => {
    const k = writes.find(write => write.kind === 'research-acceptance-binding')!.value as ResearchAcceptanceBinding;
    const question = rival.get<Question>(k.questionBefore.id)!;
    rivalAccepted = new ProductEngine(rival).discovery.researched(question.id, question.revision, k.assessment, k.pending);
  }, 'rival-acceptance', 'before');
  const run = await f.engine.researcher.run('p', f.draft.id, 1);
  restore();
  assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
  assert.ok(rivalAccepted, 'the rival Store accepted first');
  const counts = f.counts();
  assert.deepEqual([counts.answers, counts.bindings, f.store.get<Question>(f.question.id)!.revision], [1, 1, 2]);
  const turn = f.paidTurn();
  assert.equal(turn.revision, 2); assert.equal(turn.value.status, 'completed');
  assert.deepEqual(managedOf(turn).acceptanceBinding, reference(f.binding()!));
  readResearchConsumerTurn(f.open(), reference(turn));
});

test('D8.4e R9: two Stores completing one accepted turn keep one completed revision; a different completion is the conflict as thrown', async t => {
  for (const forged of [false, true]) {
    const f = acceptanceFixture(t, { neighbor: false, prefix: forged ? 'r9-forged' : 'r9-complete' });
    const rival = f.open();
    const restore = f.hook(f.store, T_WRITE, writes => {
      const turnWrite = writes.find(write => write.kind === 'research-turn')!;
      const pending = rival.get<ResearchTurn>(turnWrite.id)!;
      const value = forged
        ? { ...(turnWrite.value as object), observation: { verdict: 'supported', reasons: ['forged by the rival'] } }
        : turnWrite.value;
      rival.writeMany([{ id: turnWrite.id, kind: 'research-turn', expected: pending.revision, value }], [reference(pending)]);
    }, 'rival-completion', 'before');
    const run = await f.engine.researcher.run('p', f.draft.id, 1);
    restore();
    const turn = f.paidTurn();
    assert.equal(turn.revision, 2, 'one completed revision');
    if (forged) {
      assert.equal(run.value.status, 'paused');
      assert.ok(['input_stale', 'revision_conflict'].includes(run.value.pauseCode ?? ''), String(run.value.pauseCode));
    } else {
      assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
      readResearchConsumerTurn(f.open(), reference(turn));
    }
    const counts = f.counts();
    assert.deepEqual([counts.answers, counts.bindings], [1, 1]);
  }
});

test('D8.4e R10: every guarded basis of the acceptance moving between the check and the write is a CAS refusal without a partial acceptance', async t => {
  const probes: [string, (f: AcceptanceFixture) => void][] = [
    ['question head', f => { const q = f.store.get<Question>(f.question.id)!;
      f.store.write({ id: q.id, kind: 'question', expected: q.revision, value: q.value }); }],
    ['draft head (neighbour decision)', f => { f.decideNeighbor(); }],
    ['pending turn P', f => { const p = f.paidTurn();
      f.store.write({ id: p.id, kind: 'research-turn', expected: p.revision, value: p.value }); }],
    ['environment head', f => { const e = f.store.get<any>('environment:p')!;
      f.engine.environments.configure('p', { ...e.value, timeoutMs: 6000 }, e.revision); }],
    ['observation source head', f => { const s = f.store.get<any>(f.source.id)!;
      f.store.write({ id: s.id, kind: s.kind, expected: s.revision,
        value: { ...s.value, content: 'Grounded local condition moved', sha256: digest('Grounded local condition moved') } }); }],
  ];
  for (const [name, move] of probes) {
    const f = acceptanceFixture(t, { neighbor: name.includes('neighbour'), prefix: 'r10' });
    let calls = -1;
    const restore = f.hook(f.store, K_WRITE, () => { calls = f.calls(); move(f); }, `r10 ${name}`, 'before');
    const run = await f.engine.researcher.run('p', f.draft.id, 1);
    restore();
    assert.equal(run.value.status, 'paused', name);
    assert.ok(['input_stale', 'revision_conflict'].includes(run.value.pauseCode ?? ''), `${name}: ${run.value.pauseCode}`);
    const counts = f.counts();
    assert.deepEqual([counts.answers, counts.bindings, counts.calls], [0, 0, calls], name);
    assert.equal(f.store.get<Question>(f.question.id)!.value.status, 'open', name);
    assert.equal(f.paidTurn().value.status, 'pending', name);
  }
});

test('D8.4e R11: in the binding era a research answer on the question without K is a refusal, never a scan; a damaged K is a refusal, never the legacy chain', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'r11-missing' });
  const restore = f.interruptAfter(f.store, B_WRITE, 'fixture_after_assessment');
  await f.engine.researcher.run('p', f.draft.id, 1);
  restore();
  assert.equal(f.paidTurn().value.status, 'pending');
  const assessment = f.store.list<ResearchAssessment>('research-assessment')[0]!;
  const question = f.store.get<Question>(f.question.id)!;
  // The same paid answer accepted by the standalone route: a similar pair exists, no K.
  f.engine.discovery.researched(question.id, question.revision, reference(assessment));
  assert.deepEqual([f.counts().answers, f.counts().bindings], [1, 0]);
  const calls = f.calls();
  for (const db of [f.open(), f.open()]) {
    const resumed = await new ProductEngine(db).researcher.run('p', f.draft.id, 1);
    assert.equal(resumed.value.status, 'paused', JSON.stringify(resumed.value));
    assert.equal(resumed.value.pauseCode, 'research_acceptance_binding_invalid');
    assert.equal(f.paidTurn(db).value.status, 'pending');
    assert.equal(f.calls(db), calls);
    assert.equal(db.list('research-acceptance-binding').length, 0, 'no fictitious K');
  }
  // A K planted at the address of a pending turn that names no real acceptance is a damaged mandatory source of a
  // claimed acceptance — an addressed refusal, never a completion and never a new acceptance under it.
  const h = acceptanceFixture(t, { neighbor: false, prefix: 'r11-planted' });
  const restoreH = h.interruptAfter(h.store, B_WRITE, 'fixture_after_assessment');
  await h.engine.researcher.run('p', h.draft.id, 1);
  restoreH();
  const pendingH = h.paidTurn(), proofH = h.store.get<Record<string, any>>(assessmentBindingId('p', pendingH.id))!;
  const assessmentH = h.store.list<ResearchAssessment>('research-assessment')[0]!;
  const questionH = h.store.get<Question>(h.question.id)!, draftH = h.store.get<any>(h.draft.id)!;
  h.store.write({ id: acceptanceBindingId('p', pendingH.id), kind: 'research-acceptance-binding', expected: 0,
    value: { contract: ACCEPTANCE_BINDING_CONTRACT, projectId: 'p', turn: reference(pendingH), pending: reference(pendingH),
      intent: managedOf(pendingH).consumerIntent, draftBefore: reference(draftH),
      draftAfter: { id: draftH.id, revision: draftH.revision + 1, hash: hashJson({ planted: true }) },
      questionBefore: reference(questionH), questionAfter: { id: questionH.id, revision: questionH.revision + 1, hash: hashJson({ planted: 2 }) },
      answer: { id: 'research-answer:p:planted', revision: 1, hash: hashJson({ planted: 3 }) },
      assessment: reference(assessmentH), assessmentProof: reference(proofH) } });
  const beforeH = h.counts();
  const plantedRun = await new ProductEngine(h.open()).researcher.run('p', h.draft.id, 1);
  assert.equal(plantedRun.value.pauseCode, 'research_acceptance_binding_invalid', JSON.stringify(plantedRun.value));
  assert.equal(h.paidTurn().value.status, 'pending');
  assert.deepEqual(h.counts(), beforeH, 'no completion and no new acceptance under a planted record');
  const g = acceptanceFixture(t, { neighbor: false, prefix: 'r11-damaged' });
  await g.engine.researcher.run('p', g.draft.id, 1);
  const turn = g.paidTurn(), k = g.binding()!;
  assert.ok(managedOf(turn).acceptance, 'the completed turn also persists its chain');
  g.rewrite(k.id, 1, { ...k.value, turn: { ...k.value.turn, revision: 2 } });
  assert.throws(() => readResearchConsumerTurn(g.open(), reference(turn)), { code: 'research_acceptance_binding_invalid' });
  assert.throws(() => readResearchAcceptanceBinding(g.open(), 'p', turn.id), { code: 'research_acceptance_binding_invalid' });
  await assert.rejects(new ProductEngine(g.open()).researcher.run('p', g.draft.id, 1), { code: 'research_acceptance_binding_invalid' });
  g.rewrite(k.id, 1, k.value);
  readResearchConsumerTurn(g.open(), reference(turn));
  // A completed turn of the binding era that lost its link to K is refused although its stored chain is intact.
  const { acceptanceBinding: _link, ...unlinked } = managedOf(turn);
  g.rewrite(turn.id, turn.revision, unlinked);
  assert.throws(() => readResearchConsumerTurn(g.open(), { id: turn.id, revision: turn.revision, hash: hashJson(unlinked) }),
    { code: 'research_acceptance_binding_invalid' });
  g.rewrite(turn.id, turn.revision, turn.value);
  readResearchConsumerTurn(g.open(), reference(turn));
});

test('D8.4e R12: a K naming other records of the same values — another turn, pending, intent, proof, assessment, question, answer or draft pair — is refused by belonging', async t => {
  const f = acceptanceFixture(t, { neighbor: false, second: true, prefix: 'r12' });
  const run = await f.engine.researcher.run('p', f.draft.id, 2);
  assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
  const turns = f.store.list<ResearchTurn>('research-turn').filter(turn => turn.id.startsWith('research-turn:v1:'))
    .sort((a, b) => a.value.number - b.value.number);
  assert.equal(turns.length, 2);
  const [first, second] = turns as [Revision<ResearchTurn>, Revision<ResearchTurn>];
  const k1 = f.store.get<ResearchAcceptanceBinding>(acceptanceBindingId('p', first.id))!;
  const k2 = f.store.get<ResearchAcceptanceBinding>(acceptanceBindingId('p', second.id))!;
  assert.ok(k1 && k2);
  const substitutions: [string, Partial<ResearchAcceptanceBinding>, string][] = [
    ['pending of the other turn', { pending: k2.value.pending }, 'research_acceptance_binding_invalid'],
    ['intent of the other turn', { intent: k2.value.intent }, 'research_acceptance_binding_invalid'],
    ['a later revision of the own intent', { intent: { ...k1.value.intent, revision: 3, hash: f.store.get(k1.value.intent.id, 3)!.hash } },
      'research_acceptance_binding_invalid'],
    ['proof B of the other turn', { assessmentProof: k2.value.assessmentProof }, 'research_acceptance_binding_invalid'],
    ['assessment R of the other turn', { assessment: k2.value.assessment }, 'research_assessment_binding_invalid'],
    ['question pair of the other turn', { questionBefore: k2.value.questionBefore, questionAfter: k2.value.questionAfter },
      'research_acceptance_binding_invalid'],
    ['answer of the other turn', { answer: k2.value.answer }, 'research_acceptance_binding_invalid'],
    ['draft pair of the other turn', { draftBefore: k2.value.draftBefore, draftAfter: k2.value.draftAfter },
      'research_acceptance_binding_invalid'],
    ['a pending revision beyond the pending chain', { pending: { ...k1.value.pending, revision: 2, hash: first.hash } },
      'research_acceptance_binding_invalid'],
  ];
  for (const [name, patch, code] of substitutions) {
    f.rewrite(k1.id, 1, { ...k1.value, ...patch });
    assert.throws(() => readResearchAcceptanceBinding(f.open(), 'p', first.id),
      (error: unknown) => error instanceof EngineError && error.code === code, name);
    assert.throws(() => readResearchConsumerTurn(f.open(), reference(first)), (error: unknown) => error instanceof EngineError
      && ['research_acceptance_binding_invalid', 'research_assessment_binding_invalid'].includes(error.code), name);
    f.rewrite(k1.id, 1, k1.value);
  }
  readResearchAcceptanceBinding(f.open(), 'p', first.id);
  readResearchConsumerTurn(f.open(), reference(first));
});

test('D8.4e R13: a neighbouring draft field, a question field or an answer body changed inside the own pair is refused by the shared projection on production and on reading', async t => {
  const f = acceptanceFixture(t, { neighbor: true, prefix: 'r13' });
  f.decideNeighbor();
  await f.engine.researcher.run('p', f.draft.id, 1);
  const turn = f.paidTurn(), k = f.binding()!;
  const proven = readResearchAcceptanceBinding(f.open(), 'p', turn.id)!;
  const links = { turn: k.value.turn, pending: k.value.pending, intent: k.value.intent, assessmentProof: k.value.assessmentProof };
  assert.deepEqual(projectAcceptanceBinding(proven.inputs, links), k.value);
  const revised = <T extends Record<string, any>>(record: Revision<T>, value: T): Revision<T> => ({ ...record, value, hash: hashJson(value) });
  const alteredDraft = revised(proven.inputs.draftAfter, { ...proven.inputs.draftAfter.value,
    fields: { ...proven.inputs.draftAfter.value.fields, neighbor: { forged: true } } });
  assert.throws(() => projectAcceptanceBinding({ ...proven.inputs, draftAfter: alteredDraft }, links),
    { code: 'research_acceptance_binding_invalid' }, 'neighbour field on production');
  const alteredQuestion = revised(proven.inputs.questionAfter, { ...proven.inputs.questionAfter.value,
    spec: { ...proven.inputs.questionAfter.value.spec, prompt: 'Rewritten prompt' } });
  assert.throws(() => projectAcceptanceBinding({ ...proven.inputs, questionAfter: alteredQuestion }, links),
    { code: 'research_acceptance_binding_invalid' }, 'question field on production');
  const extraAnswer = revised(proven.inputs.answer, { ...proven.inputs.answer.value, extra: true } as any);
  const answeredWithExtra = revised(proven.inputs.questionAfter, { ...proven.inputs.questionAfter.value, answer: reference(extraAnswer) });
  assert.throws(() => projectAcceptanceBinding({ ...proven.inputs, answer: extraAnswer, questionAfter: answeredWithExtra }, links),
    { code: 'research_acceptance_binding_invalid' }, 'answer body on production');
  f.rewrite(alteredDraft.id, alteredDraft.revision, alteredDraft.value);
  f.rewrite(k.id, 1, { ...k.value, draftAfter: reference(alteredDraft) });
  assert.throws(() => readResearchAcceptanceBinding(f.open(), 'p', turn.id), { code: 'research_acceptance_binding_invalid' },
    'neighbour field on reading');
  f.rewrite(alteredDraft.id, alteredDraft.revision, proven.inputs.draftAfter.value);
  f.rewrite(k.id, 1, k.value);
  f.rewrite(extraAnswer.id, 1, extraAnswer.value);
  f.rewrite(answeredWithExtra.id, answeredWithExtra.revision, answeredWithExtra.value);
  f.rewrite(k.id, 1, { ...k.value, answer: reference(extraAnswer), questionAfter: reference(answeredWithExtra) });
  assert.throws(() => readResearchAcceptanceBinding(f.open(), 'p', turn.id), { code: 'research_acceptance_binding_invalid' },
    'answer body on reading');
  f.rewrite(extraAnswer.id, 1, proven.inputs.answer.value);
  f.rewrite(answeredWithExtra.id, answeredWithExtra.revision, proven.inputs.questionAfter.value);
  f.rewrite(k.id, 1, k.value);
  readResearchAcceptanceBinding(f.open(), 'p', turn.id);
});

test('D8.4e R14: a lost mandatory exact source — B, M — is a typed addressed refusal on the pending and on the completed turn; no new acceptance is written', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'r14' });
  const restore = f.interruptAfter(f.store, K_WRITE, 'fixture_after_acceptance', true);
  await f.engine.researcher.run('p', f.draft.id, 1);
  restore();
  const turn = f.paidTurn();
  assert.equal(turn.value.status, 'pending');
  const proof = f.store.get<Record<string, any>>(assessmentBindingId('p', turn.id))!;
  const origin = readAssessmentPaidOrigin(f.store, 'p', reference(turn))!;
  const before = f.counts();
  for (const [name, record, altered, code] of [
    ['assessment proof B (session)', proof, { ...proof.value, session: null }, 'research_assessment_binding_invalid'],
    ['assessment proof B (reads)', proof, { ...proof.value, reads: null }, 'research_assessment_binding_invalid'],
    ['paid origin M', origin, { ...origin.value, application: 'foreign-assessment-application' }, 'research_context_application_invalid'],
  ] as const) {
    f.rewrite(record.id, record.revision, altered);
    assert.throws(() => readResearchAcceptanceBinding(f.open(), 'p', turn.id),
      (error: unknown) => error instanceof EngineError && error.code === code, name);
    const resumed = await new ProductEngine(f.open()).researcher.run('p', f.draft.id, 1);
    assert.equal(resumed.value.pauseCode, code, `${name}: ${JSON.stringify(resumed.value)}`);
    assert.equal(f.paidTurn().value.status, 'pending', name);
    assert.deepEqual(f.counts(), before, name);
    f.rewrite(record.id, record.revision, record.value);
  }
  const db = f.open(), resumed = await new ProductEngine(db).researcher.run('p', f.draft.id, 1);
  assert.equal(resumed.value.status, 'completed', JSON.stringify(resumed.value));
  const completed = f.paidTurn(db);
  f.rewrite(proof.id, proof.revision, { ...proof.value, session: null });
  assert.throws(() => readResearchConsumerTurn(f.open(), reference(completed)), { code: 'research_assessment_binding_invalid' },
    'the completed turn keeps the common reader refusal');
  f.rewrite(proof.id, proof.revision, proof.value);
  readResearchConsumerTurn(f.open(), reference(completed));
});

test('D8.4e R15: insufficient and conflicting assessments and the standalone acceptance keep their previous outcomes without a fictitious K', async t => {
  for (const verdict of ['insufficient', 'conflicting'] as const) {
    const f = acceptanceFixture(t, { neighbor: false, prefix: `r15-${verdict}` });
    writeFileSync(f.adapter, readFileSync(f.adapter, 'utf8').replace("{verdict:'supported',reasons:[]}",
      `{verdict:'${verdict}',reasons:['The fixture did not support acceptance']}`));
    await f.engine.researcher.run('p', f.draft.id, 1);
    const turn = f.paidTurn();
    assert.equal(turn.value.status, 'completed');
    assert.equal((turn.value.observation as { verdict?: string }).verdict, verdict);
    assert.deepEqual([f.counts().bindings, f.counts().answers], [0, 0]);
    assert.equal(managedOf(turn).acceptanceBinding, undefined);
    readResearchConsumerTurn(f.open(), reference(turn));
  }
  const g = acceptanceFixture(t, { neighbor: false, prefix: 'r15-standalone' });
  const restore = g.interruptAfter(g.store, B_WRITE, 'fixture_after_assessment');
  await g.engine.researcher.run('p', g.draft.id, 1);
  restore();
  const assessment = g.store.list<ResearchAssessment>('research-assessment')[0]!, question = g.store.get<Question>(g.question.id)!;
  g.engine.discovery.researched(question.id, question.revision, reference(assessment));
  assert.deepEqual([g.counts().answers, g.counts().bindings], [1, 0], 'the standalone route writes no K');
});

const OLD_PRODUCER_LOADER = String.raw`
import ts from TYPESCRIPT;
import { execFileSync } from 'node:child_process';
let root, repository, baseline;
export function initialize(data) { root = data.root; repository = data.repository; baseline = data.baseline; }
export async function load(url, context, nextLoad) {
  if (url.startsWith(root) && url.endsWith('.js')) {
    const path = decodeURIComponent(url.slice(root.length)).replace(/\.js$/, '.ts');
    const body = execFileSync('git', ['show', baseline + ':' + path], { cwd: repository, encoding: 'utf8', maxBuffer: 10_000_000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(body,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return nextLoad(url, context);
}
`;
const OLD_PRODUCER_SCENARIO = String.raw`
import { register } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const config = CONFIG;
register(config.loader, { data: { root: config.dist, repository: config.repository, baseline: config.baseline } });
const { Store } = await import(config.dist + 'src/storage/store.js');
const { ProductEngine } = await import(config.dist + 'src/product/engine.js');
const { EngineError } = await import(config.dist + 'src/errors.js');
const results = [];
for (const [name, stop] of config.scenarios) {
  const root = join(config.directory, name); mkdirSync(root, { recursive: true });
  const database = join(root, 'state.sqlite');
  const store = new Store(database), engine = new ProductEngine(store);
  engine.execute({ type: 'create-project', project: 'p', title: 'Old producer ' + name });
  const source = engine.discovery.evidence.document('p', 'proof', 'Grounded local condition', 'text/plain', 0);
  const sourceRef = { id: source.id, revision: source.revision, hash: source.hash };
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, "import{readFileSync}from'node:fs';\nconst r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;\n"
    + "const research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}:{action:'answer',question:s.questions[0].id,value:{ok:true},citations:[{source:"
    + JSON.stringify(sourceRef) + ",selector:{kind:'text-range',start:0,end:24}}]};\n"
    + "console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));\n");
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
    [{ field: 'result', kind: 'design', prompt: 'Resolve result', risk: 'Missing source', schema: { type: 'object' } }]);
  const original = store.writeMany.bind(store); let hit = false;
  store.writeMany = (writes, guards = []) => {
    const rows = original(writes, guards);
    if (!hit && stop && writes.some(write => write.kind === stop)) {
      hit = true; throw new EngineError('fixture_old_' + name, 'The old producer stopped after ' + stop);
    }
    return rows;
  };
  const run = await engine.researcher.run('p', draft.id, 1);
  store.writeMany = original;
  const turn = store.list('research-turn')[0] ?? null;
  results.push({ name, root, database, draft: draft.id, status: run.value.status, pauseCode: run.value.pauseCode, hit,
    turn: turn && { id: turn.id, revision: turn.revision, status: turn.value.status, keys: Object.keys(turn.value).sort() },
    calls: store.list('model-call').length, answers: store.list('research-answer').length,
    bindings: store.list('research-acceptance-binding').length });
  store.close();
}
console.log(JSON.stringify(results));
`;

test('D8.4e R16: records of the previous producer (479b307) are read and restored by the old contract without a retroactive K; an old un-accepted pending turn is accepted by new code with K', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d84e-r16-')));
  const stores: Store[] = [];
  t.after(() => { for (const db of stores) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const loaderFile = join(directory, 'old-loader.mjs'), script = join(directory, 'old-producer.mjs');
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const dist = pathToFileURL(fileURLToPath(new URL('../', import.meta.url))).href;
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  writeFileSync(loaderFile, OLD_PRODUCER_LOADER.replace('TYPESCRIPT', JSON.stringify(typescript)));
  writeFileSync(script, OLD_PRODUCER_SCENARIO.replace('CONFIG', JSON.stringify({ directory, repository, dist,
    loader: pathToFileURL(loaderFile).href, baseline: '479b307f8aa3d43745f5313c1f5c8a712bd7d55a',
    scenarios: [['completed', null], ['accepted-not-completed', 'research-answer'], ['assessed-not-accepted', 'research-assessment-binding']] })));
  const output = execFileSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n').at(-1)!;
  type Produced = { name: string; root: string; database: string; draft: string; status: string; pauseCode: string | null; hit: boolean;
    turn: { id: string; revision: number; status: string; keys: string[] } | null; calls: number; answers: number; bindings: number };
  const produced = Object.fromEntries((JSON.parse(output) as Produced[]).map(row => [row.name, row]));
  const open = (database: string) => { const db = new Store(database); stores.push(db); return db; };
  const rewrite = (database: string, id: string, revision: number, value: unknown) => {
    const raw = new DatabaseSync(database);
    try {
      raw.exec('DROP TRIGGER IF EXISTS revisions_no_update');
      raw.prepare('UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?').run(canonical(value), hashJson(value), id, revision);
    } finally { raw.close(); }
  };
  // (a) completed by the old producer: legacy era, stored chain, no K; read and repeated by the old contract.
  const completed = produced['completed']!;
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(completed.turn!.status, 'completed');
  assert.ok(completed.turn!.keys.includes('acceptance') && !completed.turn!.keys.includes('acceptanceContract')
    && !completed.turn!.keys.includes('acceptanceBinding'), JSON.stringify(completed.turn));
  assert.equal(completed.bindings, 0);
  {
    const db = open(completed.database), turn = db.get<ResearchTurn>(completed.turn!.id)!;
    assert.equal(acceptanceEraOf(managedOf(turn)), 'legacy');
    assert.deepEqual(readResearchConsumerTurn(db, reference(turn)).value, turn.value);
    assert.equal(readResearchAcceptanceBinding(db, 'p', turn.id), null);
    const again = await new ProductEngine(open(completed.database)).researcher.run('p', completed.draft, 1);
    assert.equal(again.value.status, 'completed', JSON.stringify(again.value));
    assert.equal(db.get<ResearchTurn>(turn.id)!.revision, turn.revision);
    assert.equal(db.list('research-acceptance-binding').length, 0, 'no retroactive K');
    assert.equal(db.list('model-call').length, completed.calls);
  }
  // (b) accepted by the old producer, turn still pending: the old contract (bounded scan) completes it; no retroactive K.
  const window = produced['accepted-not-completed']!;
  assert.ok(window.hit, JSON.stringify(window));
  assert.equal(window.turn!.status, 'pending'); assert.equal(window.answers, 1);
  {
    const db = open(window.database);
    const resumed = await new ProductEngine(db).researcher.run('p', window.draft, 1);
    assert.equal(resumed.value.status, 'completed', JSON.stringify(resumed.value));
    const turn = db.get<ResearchTurn>(window.turn!.id)!;
    assert.equal(turn.value.status, 'completed');
    assert.ok(managedOf(turn).acceptance);
    assert.equal(managedOf(turn).acceptanceBinding, undefined);
    assert.equal(acceptanceEraOf(managedOf(turn)), 'legacy');
    assert.equal(db.list('research-acceptance-binding').length, 0);
    assert.equal(db.list('model-call').length, window.calls);
    readResearchConsumerTurn(open(window.database), reference(turn));
  }
  // (c) assessed by the old producer, not accepted: new code accepts it with K; the completed turn links K although O has no marker.
  const pendingOld = produced['assessed-not-accepted']!;
  assert.ok(pendingOld.hit, JSON.stringify(pendingOld));
  assert.equal(pendingOld.turn!.status, 'pending'); assert.equal(pendingOld.answers, 0);
  {
    const db = open(pendingOld.database);
    const resumed = await new ProductEngine(db).researcher.run('p', pendingOld.draft, 1);
    assert.equal(resumed.value.status, 'completed', JSON.stringify(resumed.value));
    const turn = db.get<ResearchTurn>(pendingOld.turn!.id)!;
    const k = db.get<ResearchAcceptanceBinding>(acceptanceBindingId('p', turn.id))!;
    assert.ok(k, 'the old pending turn was accepted with K');
    assert.equal(acceptanceEraOf(managedOf(turn)), 'legacy');
    assert.deepEqual(managedOf(turn).acceptanceBinding, reference(k));
    assert.deepEqual(k.value.turn, reference(db.get(turn.id, 1)!));
    assert.equal(db.list('model-call').length, pendingOld.calls, 'the old paid assessment is reused');
    assert.ok(readResearchAcceptanceBinding(open(pendingOld.database), 'p', turn.id));
    readResearchConsumerTurn(open(pendingOld.database), reference(turn));
    // A K on an old turn is checked, not silenced: damaged, it refuses the completed turn although the stored chain is intact.
    rewrite(pendingOld.database, k.id, 1, { ...k.value, turn: { ...k.value.turn, revision: 2 } });
    assert.throws(() => readResearchConsumerTurn(open(pendingOld.database), reference(turn)), { code: 'research_acceptance_binding_invalid' });
    rewrite(pendingOld.database, k.id, 1, k.value);
    readResearchConsumerTurn(open(pendingOld.database), reference(turn));
  }
});

test('D8.4e R17: the next turn and the context history reader consume the completed turn through K without a cycle', async t => {
  const f = acceptanceFixture(t, { neighbor: false, second: true, prefix: 'r17' });
  const run = await f.engine.researcher.run('p', f.draft.id, 2);
  assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
  const turns = f.store.list<ResearchTurn>('research-turn').filter(turn => turn.id.startsWith('research-turn:v1:'))
    .sort((a, b) => a.value.number - b.value.number);
  assert.equal(turns.length, 2);
  for (const turn of turns) { assert.equal(turn.value.status, 'completed'); assert.ok(managedOf(turn).acceptanceBinding); }
  const db = f.open(), draft = db.get<any>(f.draft.id)!;
  const history = readContextTurnHistoryAt(db, 'p', draft, turns[1]!.value.question!,
    turns.map(turn => readResearchConsumerTurn(db, reference(turn)) as Revision<ResearchTurn>), 2);
  assert.equal(history.length, 1);
  assert.deepEqual(reference(history[0]!.turn), reference(turns[0]!));
  const again = await new ProductEngine(f.open()).researcher.run('p', f.draft.id, 1);
  assert.equal(again.value.status, 'completed');
  assert.equal(f.counts().bindings, 2);
});

// ---------------------------------------------------------------------------
// D8.4e круг 2 (№2242): окна конкуренции — владение и актуальный run при
// завершении через K на обоих участках записи; победивший K на каждом
// участке managed-принятия. Пробы ревьюера перенесены постоянными.
// ---------------------------------------------------------------------------
test('D8.4e-2 (№2242-1): K-first never completes the turn of a live foreign owner — the contender refuses research_busy without a write, the owner finishes its own turn', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'r2-live-owner' });
  type Rival = { code: string | null; before: { revision: number; status: string }; after: { revision: number; status: string }; bindings: number };
  let rival: Rival | null = null;
  const restore = f.hook(f.store, K_WRITE, () => {
    const turn = f.paidTurn();
    const script = `import { Store } from ${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import { ProductEngine } from ${JSON.stringify(new URL('../src/product/engine.js', import.meta.url).href)};
const db = new Store(${JSON.stringify(f.database)}); let code = null;
const before = db.get(${JSON.stringify(turn.id)});
try { await new ProductEngine(db).researcher.run('p', ${JSON.stringify(f.draft.id)}, 1); } catch (error) { code = error.code ?? String(error); }
const after = db.get(${JSON.stringify(turn.id)});
process.stdout.write(JSON.stringify({ code, before: { revision: before.revision, status: before.value.status },
  after: { revision: after.revision, status: after.value.status }, bindings: db.list('research-acceptance-binding').length })); db.close();`;
    rival = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60000 })) as Rival;
  }, 'rival-live-owner', 'after');
  const run = await f.engine.researcher.run('p', f.draft.id, 1);
  restore();
  const contender = rival as Rival | null;
  assert.ok(contender, 'the contender ran');
  assert.equal(contender.code, 'research_busy');
  assert.deepEqual(contender.before, { revision: 1, status: 'pending' });
  assert.deepEqual(contender.after, contender.before, 'the contender must not change the live owner turn before reporting busy');
  assert.equal(contender.bindings, 1);
  assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
  const turn = f.paidTurn();
  assert.equal(turn.revision, 2); assert.equal(turn.value.status, 'completed');
  assert.deepEqual(managedOf(turn).acceptanceBinding, reference(f.binding()!));
  assert.equal(f.counts().bindings, 1);
  readResearchConsumerTurn(f.open(), reference(turn));
});

test('D8.4e-2 (№2242-1): the completion through K keeps the current run in its own transaction — a run taken over or moved between the admission and the write refuses on both sites; the next lawful entry completes the same turn', async t => {
  // (a) the loop-end site: the run is taken over by a live foreign owner after our K and before our T.
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'r2-loop-owner' });
  const foreign = { pid: process.ppid, started: processStart(process.ppid) };
  assert.ok(foreign.started, 'the parent process identifies a live foreign owner');
  const restore = f.hook(f.store, T_WRITE, () => {
    const run = f.store.list<any>('research-run')[0]!;
    f.store.write({ id: run.id, kind: run.kind, expected: run.revision, value: { ...run.value, owner: foreign } });
  }, 'takeover-before-completion', 'before');
  await assert.rejects(f.engine.researcher.run('p', f.draft.id, 1), { code: 'research_busy' });
  restore();
  assert.equal(f.paidTurn().value.status, 'pending', 'the taken-over run keeps its turn pending');
  assert.equal(f.paidTurn().revision, 1);
  assert.equal(f.counts().bindings, 1);
  const taken = f.store.list<any>('research-run')[0]!;
  f.store.write({ id: taken.id, kind: taken.kind, expected: taken.revision, value: { ...taken.value, status: 'paused' } });
  const resumed = await new ProductEngine(f.open()).researcher.run('p', f.draft.id, 1);
  assert.equal(resumed.value.status, 'completed', JSON.stringify(resumed.value));
  assert.deepEqual(managedOf(f.paidTurn()).acceptanceBinding, reference(f.binding()!));
  readResearchConsumerTurn(f.open(), reference(f.paidTurn()));
  // (b) both sites: the run moved (same owner) between the admission read and the write — the transaction refuses
  // by the run guard, nothing is completed, and the next entry completes the turn from K.
  for (const site of ['loop', 'prologue'] as const) {
    const g = acceptanceFixture(t, { neighbor: false, prefix: `r2-moved-${site}` });
    let engine = g.engine, db = g.store;
    if (site === 'prologue') {
      const stop = g.interruptAfter(g.store, K_WRITE, 'fixture_after_acceptance', true);
      await g.engine.researcher.run('p', g.draft.id, 1);
      stop();
      db = g.open(); engine = new ProductEngine(db);
    }
    const restoreG = g.hook(db, T_WRITE, () => {
      const run = db.list<any>('research-run')[0]!;
      db.write({ id: run.id, kind: run.kind, expected: run.revision, value: { ...run.value, limit: run.value.limit + 1 } });
    }, `moved-run-${site}`, 'before');
    const first = await engine.researcher.run('p', g.draft.id, 1);
    restoreG();
    assert.equal(first.value.status, 'paused', `${site}: ${JSON.stringify(first.value)}`);
    assert.equal(first.value.pauseCode, 'input_stale', site);
    assert.equal(g.paidTurn(db).value.status, 'pending', site);
    assert.equal(g.counts(db).bindings, 1, site);
    const again = await new ProductEngine(g.open()).researcher.run('p', g.draft.id, 1);
    assert.equal(again.value.status, 'completed', `${site}: ${JSON.stringify(again.value)}`);
    assert.deepEqual(managedOf(g.paidTurn()).acceptanceBinding, reference(g.binding()!), site);
    readResearchConsumerTurn(g.open(), reference(g.paidTurn()));
  }
});

test('D8.4e-2 (№2242-2): a winning K that appears at the first read of the managed entry is proven and its result returned — the run completes with one K and one answer', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'r2-early-winner' });
  let armed = false, hit = false;
  const restore = f.hook(f.store, B_WRITE, () => { armed = true; }, 'arm-after-assessment', 'after');
  const original = f.store.get.bind(f.store);
  f.store.get = ((id: string, revision?: number) => {
    if (armed && !hit && id.startsWith('research-acceptance-binding:')) {
      hit = true;
      const db = f.open(), p = f.paidTurn(db), b = db.get<Record<string, any>>(assessmentBindingId('p', p.id))!;
      const q = db.get<Question>(p.value.question!.id, p.value.question!.revision)!;
      new ProductEngine(db).discovery.researched(q.id, q.revision, b.value.assessment, reference(p));
    }
    return original(id, revision);
  }) as typeof f.store.get;
  const run = await f.engine.researcher.run('p', f.draft.id, 1);
  f.store.get = original;
  restore();
  assert.equal(hit, true, 'the rival accepted at the first read of the record address');
  assert.equal(run.value.status, 'completed', 'an exact winning acceptance is not an integrity failure: ' + JSON.stringify(run.value));
  const counts = f.counts();
  assert.deepEqual([counts.answers, counts.bindings, counts.assessments], [1, 1, 1]);
  const turn = f.paidTurn();
  assert.equal(turn.revision, 2); assert.equal(turn.value.status, 'completed');
  assert.deepEqual(managedOf(turn).acceptanceBinding, reference(f.binding()!));
  assert.equal(f.store.get<Question>(f.question.id)!.revision, 2);
  readResearchConsumerTurn(f.open(), reference(turn));
});

test('D8.4e-2 (№2242-2): an acceptance already made before the managed entry returns the saved result without writes; another assessment claimed for the same turn is an addressed refusal', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'r2-entry-winner' });
  const restore = f.interruptAfter(f.store, B_WRITE, 'fixture_after_assessment');
  await f.engine.researcher.run('p', f.draft.id, 1);
  restore();
  const pending = f.paidTurn(), proof = f.store.get<Record<string, any>>(assessmentBindingId('p', pending.id))!;
  const question = f.store.get<Question>(f.question.id)!;
  const won = new ProductEngine(f.open()).discovery.researched(question.id, question.revision, proof.value.assessment, reference(pending));
  const before = f.counts();
  assert.deepEqual([before.answers, before.bindings], [1, 1]);
  const same = f.engine.discovery.researched(question.id, question.revision, proof.value.assessment, reference(pending));
  assert.deepEqual(same, won, 'the whole managed entry returns the winner\'s saved result');
  assert.deepEqual(f.counts(), before, 'no new revision, answer or record');
  const other = { id: 'research-assessment:other', revision: 1, hash: hashJson({ other: true }) };
  assert.throws(() => f.engine.discovery.researched(question.id, question.revision, other, reference(pending)),
    { code: 'research_acceptance_binding_invalid' }, 'another assessment on the same paid turn is not the winner');
  assert.deepEqual(f.counts(), before);
  const resumed = await new ProductEngine(f.open()).researcher.run('p', f.draft.id, 1);
  assert.equal(resumed.value.status, 'completed', JSON.stringify(resumed.value));
  const turn = f.paidTurn();
  assert.equal(turn.value.status, 'completed');
  assert.deepEqual(managedOf(turn).acceptanceBinding, reference(f.binding()!));
  assert.deepEqual(f.counts(), { ...before, turns: before.turns });
  readResearchConsumerTurn(f.open(), reference(turn));
});

// ---------------------------------------------------------------------------
// D8.4e круг 3 (№2259): ОДНА обёртка на всю managed-попытку нового принятия —
// таблица исхода W1–W6, по строке тест; пробы ревьюера — постоянные регрессии.
// ---------------------------------------------------------------------------
/** A managed acceptance fixture stopped right after the paid assessment (R and B written, no acceptance yet). */
async function assessedFixture(t: test.TestContext, prefix: string) {
  const f = acceptanceFixture(t, { neighbor: false, prefix });
  const restore = f.interruptAfter(f.store, B_WRITE, 'fixture_after_assessment');
  await f.engine.researcher.run('p', f.draft.id, 1);
  restore();
  const pending = f.paidTurn(), proof = f.store.get<Record<string, any>>(assessmentBindingId('p', pending.id))!;
  const question = f.store.get<Question>(f.question.id)!;
  const assessment = proof.value.assessment as Ref;
  const attempt = (db: Store = f.store, ref: Ref = assessment) =>
    new ProductEngine(db).discovery.researched(question.id, question.revision, ref, reference(pending));
  return { ...f, pending, question, assessment, attempt };
}

test('D8.4e-3 W1 (№2259): a typed refusal of the managed attempt with no record at the address is the original refusal as is', async t => {
  const f = await assessedFixture(t, 'w1-target');
  const draft = f.store.get<any>(f.draft.id)!;
  f.store.write({ id: draft.id, kind: draft.kind, expected: draft.revision,
    value: { ...draft.value, fields: { ...draft.value.fields, result: { moved: true } } } });
  const before = f.counts();
  assert.throws(() => f.attempt(), { code: 'target_stale' }, 'the target moved without any acceptance');
  assert.deepEqual(f.counts(), before);
  const g = await assessedFixture(t, 'w1-source');
  g.engine.discovery.evidence.document('p', 'proof', 'Changed without any acceptance', 'text/plain', g.source.revision);
  assert.throws(() => g.attempt(), { code: 'research_not_supported' }, 'a moved Source without any acceptance is the current-admission refusal');
  assert.equal(g.counts().bindings, 0);
  const h = await assessedFixture(t, 'w1-question');
  h.store.write({ id: h.question.id, kind: 'question', expected: h.question.revision, value: h.question.value });
  assert.throws(() => h.attempt(), { code: 'question_stale' }, 'a moved question without any acceptance');
  assert.equal(h.counts().bindings, 0);
});

test('D8.4e-3 W2 (№2259-1, reviewer probe): the winner accepts after the last absence read and before the write — the target moved by the winner is not a refusal but the winner\'s saved result; the run completes', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'w2-late-preparation' });
  let inAcceptance = false, hit = false;
  const researched = f.engine.discovery.researched.bind(f.engine.discovery), get = f.store.get.bind(f.store);
  f.engine.discovery.researched = ((...args: Parameters<typeof researched>) => {
    inAcceptance = true;
    try { return researched(...args); } finally { inAcceptance = false; }
  }) as typeof researched;
  f.store.get = ((id: string, revision?: number) => {
    const value = get(id, revision);
    if (inAcceptance && !hit && id === f.draft.id && revision === undefined) {
      // The attempt has passed its initial record check and read the question; the winner accepts now.
      hit = true;
      const db = f.open(), p = f.paidTurn(db), b = db.get<Record<string, any>>(assessmentBindingId('p', p.id))!;
      const q = db.get<Question>(p.value.question!.id, p.value.question!.revision)!;
      new ProductEngine(db).discovery.researched(q.id, q.revision, b.value.assessment, reference(p));
    }
    return value;
  }) as typeof f.store.get;
  const run = await f.engine.researcher.run('p', f.draft.id, 1);
  f.store.get = get; f.engine.discovery.researched = researched;
  assert.equal(hit, true, 'the winner accepted inside the attempt');
  assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
  const turn = f.paidTurn();
  assert.equal(turn.value.status, 'completed');
  assert.deepEqual(managedOf(turn).acceptanceBinding, reference(f.binding()!));
  const counts = f.counts();
  assert.deepEqual([counts.answers, counts.bindings, counts.assessments], [1, 1, 1]);
  readResearchConsumerTurn(f.open(), reference(turn));
});

test('D8.4e-3 W2 (№2259-2, reviewer probe): the winner accepts during the current admission and the cited Source then moves — the stale-source refusal is not passed on, the made acceptance completes historically', async t => {
  const f = acceptanceFixture(t, { neighbor: false, prefix: 'w2-current-admission' });
  let inAcceptance = false, hit = false;
  const researched = f.engine.discovery.researched.bind(f.engine.discovery), get = f.store.get.bind(f.store);
  f.engine.discovery.researched = ((...args: Parameters<typeof researched>) => {
    inAcceptance = true;
    try { return researched(...args); } finally { inAcceptance = false; }
  }) as typeof researched;
  f.store.get = ((id: string, revision?: number) => {
    const value = get(id, revision);
    if (inAcceptance && !hit && id.startsWith('research-assessment:')) {
      hit = true;
      const db = f.open(), engine = new ProductEngine(db), p = f.paidTurn(db), b = db.get<Record<string, any>>(assessmentBindingId('p', p.id))!;
      const q = db.get<Question>(p.value.question!.id, p.value.question!.revision)!;
      engine.discovery.researched(q.id, q.revision, b.value.assessment, reference(p));
      engine.discovery.evidence.document('p', 'proof', 'Changed after valid acceptance', 'text/plain', f.source.revision);
    }
    return value;
  }) as typeof f.store.get;
  const run = await f.engine.researcher.run('p', f.draft.id, 1);
  f.store.get = get; f.engine.discovery.researched = researched;
  assert.equal(hit, true);
  const turn = f.paidTurn(), proven = readResearchAcceptanceBinding(f.open(), 'p', turn.id);
  assert.ok(proven, 'the winner\'s record proves wholly by its exact captured sources');
  assert.equal(turn.value.status, 'completed', 'K completion is historical; any later stale-source pause belongs to new admission: ' + JSON.stringify(run.value));
  assert.deepEqual(managedOf(turn).acceptanceBinding, reference(f.binding()!));
  const counts = f.counts();
  assert.deepEqual([counts.answers, counts.bindings, counts.assessments], [1, 1, 1]);
  readResearchConsumerTurn(f.open(), reference(turn));
});

test('D8.4e-3 W2/W3 (№2259): a direct managed attempt after the winner returns the saved result at every window; another assessment claimed for the same turn is the addressed refusal', async t => {
  const f = await assessedFixture(t, 'w2-w3-direct');
  const won = f.attempt(f.open());
  const before = f.counts();
  assert.deepEqual([before.answers, before.bindings], [1, 1]);
  assert.deepEqual(f.attempt(), won, 'W2 at the initial check: the winner\'s saved draft, no write');
  // W2 inside the attempt: the initial check sees no record, the winner accepts during the attempt, the attempt's
  // typed refusal (target_stale) is replaced by the proven winner.
  const g = await assessedFixture(t, 'w2-inside');
  const get = g.store.get.bind(g.store); let hit = false;
  g.store.get = ((id: string, revision?: number) => {
    const value = get(id, revision);
    if (!hit && id === g.draft.id && revision === undefined) { hit = true; g.attempt(g.open()); }
    return value;
  }) as typeof g.store.get;
  const inside = g.attempt();
  g.store.get = get;
  assert.equal(hit, true);
  assert.deepEqual(inside, g.store.get<any>(g.draft.id, g.store.get<any>(g.draft.id)!.revision));
  assert.deepEqual([g.counts().answers, g.counts().bindings], [1, 1]);
  // W3: a proven record of the same turn with another assessment is not this attempt's winner.
  const other = { id: 'research-assessment:other', revision: 1, hash: hashJson({ other: true }) };
  assert.throws(() => f.attempt(f.store, other), { code: 'research_acceptance_binding_invalid' });
  assert.deepEqual(f.counts(), before);
});

test('D8.4e-3 W4 (№2259): a damaged record at the address is the common reader\'s refusal as is — at the initial check and after a typed refusal of the attempt', async t => {
  const plant = (f: Awaited<ReturnType<typeof assessedFixture>>) => f.store.write({
    id: acceptanceBindingId('p', f.pending.id), kind: 'research-acceptance-binding', expected: 0,
    value: { contract: ACCEPTANCE_BINDING_CONTRACT, projectId: 'p', turn: { ...reference(f.pending), revision: 2 }, pending: reference(f.pending),
      intent: managedOf(f.pending).consumerIntent, draftBefore: reference(f.store.get<any>(f.draft.id)!),
      draftAfter: { id: f.draft.id, revision: 99, hash: hashJson({ planted: 1 }) }, questionBefore: reference(f.question),
      questionAfter: { id: f.question.id, revision: 99, hash: hashJson({ planted: 2 }) },
      answer: { id: 'research-answer:p:planted', revision: 1, hash: hashJson({ planted: 3 }) },
      assessment: f.assessment, assessmentProof: { id: assessmentBindingId('p', f.pending.id), revision: 1, hash: hashJson({ planted: 4 }) } } });
  const f = await assessedFixture(t, 'w4-initial');
  plant(f);
  const before = f.counts();
  assert.throws(() => f.attempt(), (error: unknown) => error instanceof EngineError && error.code === 'research_acceptance_binding_invalid'
    && (error.details as { reason?: string })?.reason === 'form', 'the reader\'s addressed refusal, not a completion');
  assert.deepEqual(f.counts(), before);
  const g = await assessedFixture(t, 'w4-after-refusal');
  const get = g.store.get.bind(g.store); let hit = false;
  g.store.get = ((id: string, revision?: number) => {
    const value = get(id, revision);
    if (!hit && id === g.draft.id && revision === undefined) { hit = true; plant(g); }
    return value;
  }) as typeof g.store.get;
  assert.throws(() => g.attempt(), (error: unknown) => error instanceof EngineError && error.code === 'research_acceptance_binding_invalid'
    && (error.details as { reason?: string })?.reason === 'form', 'the write refused by expected:0, then the damaged record is the reader\'s refusal');
  g.store.get = get;
  assert.equal(hit, true);
  assert.equal(g.counts().answers, 0);
});

test('D8.4e-3 W5 (№2259): a non-typed exception inside the attempt is thrown as is and the record is not read', async t => {
  const f = await assessedFixture(t, 'w5');
  const get = f.store.get.bind(f.store); let thrown = false, readsAfter = 0;
  f.store.get = ((id: string, revision?: number) => {
    if (thrown && id.startsWith('research-acceptance-binding:')) readsAfter += 1;
    if (!thrown && id === f.question.id) { thrown = true; throw new TypeError('fixture programmatic failure'); }
    return get(id, revision);
  }) as typeof f.store.get;
  assert.throws(() => f.attempt(), (error: unknown) => error instanceof TypeError && !(error instanceof EngineError)
    && error.message === 'fixture programmatic failure');
  f.store.get = get;
  assert.equal(thrown, true); assert.equal(readsAfter, 0, 'no record read masks a programmatic failure');
  assert.deepEqual([f.counts().answers, f.counts().bindings], [0, 0]);
});

test('D8.4e-3 W6 (№2259): the successful attempt writes the four records once; expected:0 is the final protection of the record', async t => {
  const f = await assessedFixture(t, 'w6');
  const accepted = f.attempt();
  assert.equal(accepted.revision, 2);
  const k = f.binding()!;
  assert.ok(k); assert.deepEqual(k.value.pending, reference(f.pending));
  assert.deepEqual([f.counts().answers, f.counts().bindings], [1, 1]);
  assert.equal(f.store.get<Question>(f.question.id)!.value.status, 'answered');
  assert.throws(() => f.store.write({ id: k.id, kind: k.kind, expected: 0, value: k.value }), { code: 'revision_conflict' },
    'a second record at the address is refused by expected:0');
  assert.deepEqual(f.attempt(), accepted, 'the repeated attempt is the saved result (W2)');
});


/**
 * RS3 (№4414): a synthesis step on a repeat research-stage. Its saved refusal is either a provider failure without a
 * response — the adapter's own envelope, as codex-stdio and devin-stdio print it — answered by one new generation at the
 * next explicit entry, or any other refusal, restored as the run's typed pause: never a missing permit or a different
 * saved admission.
 */
for (const [name, line, retryable] of [
  ['its own envelope (codex-stdio / devin-stdio)', `console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,usage:null}));console.error(JSON.stringify({error:'provider_failed',message:'426 Upgrade Required'}));process.exit(1);`, true],
  ['a foreign request envelope', `console.log(JSON.stringify({protocol:r.protocol,requestId:'another-request',usage:null}));process.exit(1);`, false],
] as const)
  test(`RS3 №4414: a synthesis step failing with ${name} — ${retryable ? 'the next entry pays one new generation' : 'every repeat entry restores the saved refusal as a typed pause'}`, async t => {
    const f = await synthesisV2Fixture(t, `
if(c.dispatchMode==='planning')research={action:'synthesize',question:c.question.id};
else{${line}}`);
    const { projectId: _p, ...settings } = f.pilot.value;
    configureReaderPilot(f.store, f.engine.environments, 'p', { ...settings,
      planning: { fields: [f.question.value.spec.field], maxRequestChars: 50000, maxRounds: 3 } }, f.pilot.revision);
    const first = await f.engine.researcher.run('p', f.draft.id, 4);
    assert.equal(first.value.status, 'paused');
    const synthesis = () => f.store.list<any>('research-consumer-intent').filter(intent => intent.value.kind === 'synthesis')
      .sort((a, b) => a.value.generation - b.value.generation);
    const [refused] = synthesis();
    assert.deepEqual([refused!.value.state, refused!.value.refusal?.kind], ['refused', retryable ? 'provider-failed' : 'terminal']);
    const calls = () => f.store.list('model-call').length, before = calls();
    if (retryable) {
      const failed = f.store.list<ModelCall>('model-call').find(call => call.value.status === 'failed' && call.value.usage === null)!;
      const head = f.store.get<any>(f.pilot.id)!, { projectId: _q, ...rest } = head.value;
      configureReaderPilot(f.store, f.engine.environments, 'p', { ...rest, unknownReserves: [{ call: reference(failed), tokens: 100 }] }, head.revision);
      const second = await f.engine.researcher.run('p', f.draft.id, 4);
      assert.equal(second.value.status, 'paused');
      assert.equal(calls(), before + 1, 'One new generation of the same step');
      assert.deepEqual(synthesis().map(intent => [intent.value.generation, intent.value.refusal?.kind ?? null]), [[0, 'provider-failed'], [1, 'provider-failed']]);
      assert.deepEqual(synthesis()[1]!.value.previous, reference(refused!));
    } else {
      for (const attempt of [1, 2]) {
        const again = await f.engine.researcher.run('p', f.draft.id, 4);
        assert.deepEqual([again.value.status, again.value.pauseCode], ['paused', refused!.value.refusal!.code], `attempt ${attempt}: ${again.value.error}`);
        assert.doesNotMatch(again.value.error ?? '', /different saved admission|cannot be retried inside/);
      }
      assert.equal(calls(), before, 'The saved outcome is restored; nothing is sent again');
      assert.equal(synthesis().length, 1);
    }
  });

import { readResearchExecution as rs3ReadExecution } from '../src/discovery/response-recovery.js';
/** RS3 (№4433): rewrite exact saved revisions of a disposable store — a forged sibling receipt under recomputed hashes. */
function rs3Forge(database: string, records: { id: string; revision: number; value: unknown }[]) {
  const db = new DatabaseSync(database);
  const trigger = (db.prepare("SELECT sql FROM sqlite_master WHERE name='revisions_no_update'").get() as { sql: string }).sql;
  db.exec('DROP TRIGGER revisions_no_update');
  for (const record of records) db.prepare('UPDATE revisions SET body=?,sha256=? WHERE entity_id=? AND revision=?')
    .run(canonical(record.value), hashJson(record.value as never), record.id, record.revision);
  db.exec(trigger); db.close();
}
for (const [name, code, retryable] of [['adapter_failed (the model may have answered)', 'adapter_failed', false], ['provider_failed (no response)', 'provider_failed', true]] as const)
  test(`RS3 №4433: a failed consumer call's own envelope under ${name} — both readers of the one physical result agree (${retryable ? 'retryable' : 'never retryable'}), and an unproved sibling assessmentExecution with provider_failed changes neither`, async t => {
    const f = await synthesisV2Fixture(t, `console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,usage:null}));console.error(JSON.stringify({error:${JSON.stringify(code)},message:'x'}));process.exit(1);`);
    await assert.rejects(f.invoke(), { code: 'research_provider_failed' });
    const intent = f.store.list<any>('research-consumer-intent').find(row => row.value.kind === 'synthesis')!;
    const call = f.store.get<any>(intent.value.refusal.call.id, intent.value.refusal.call.revision)!;
    const raw = f.store.get<any>(call.value.response.record.id, call.value.response.record.revision)!;
    const session = f.store.get<any>(intent.value.owner.id, intent.value.owner.revision)!;
    const outcome = (read: () => { kind: string }) => { try { return read().kind; } catch (error) { return (error as EngineError).code; } };
    const readers = (store: Store, intentRef: Ref, callRef: Ref) => [
      outcome(() => readResearchConsumerExecution(store, 'p', intentRef)),
      outcome(() => rs3ReadExecution(store, 'p', callRef, session, f.draft, f.question, f.dispatch.implementer, reference(f.pilot)))];
    const expected = retryable ? ['provider-failed', 'provider-failed'] : ['terminal', 'response_recovery_wire_foreign'];
    assert.deepEqual(readers(f.store, reference(intent), reference(call)), expected);
    assert.equal(intent.value.refusal.kind, retryable ? 'provider-failed' : 'terminal');
    // A sibling receipt of the other era, with no contract, call, dispatch, exit or signal, saying provider_failed.
    const value = { ...structuredClone(raw.value), assessmentExecution: { process: { stderr: JSON.stringify({ error: 'provider_failed', message: 'counterfeit sibling' }) + '\n' } } };
    const raw2 = { id: raw.id, revision: raw.revision, value };
    const callValue = structuredClone(call.value); callValue.response.record = { id: raw.id, revision: raw.revision, hash: hashJson(value) };
    const intentValue = structuredClone(intent.value);
    intentValue.refusal.call = { id: call.id, revision: call.revision, hash: hashJson(callValue) }; intentValue.refusal.response = callValue.response.record;
    rs3Forge(f.database, [raw2, { id: call.id, revision: call.revision, value: callValue }, { id: intent.id, revision: intent.revision, value: intentValue }]);
    const reopened = f.open();
    const intent2 = reopened.get<any>(intent.id, intent.revision)!, call2 = reopened.get<any>(call.id, call.revision)!;
    assert.ok(reopened.get<any>(raw.id, raw.revision)!.value.assessmentExecution, 'The forged sibling is in the store');
    assert.deepEqual(readers(reopened, reference(intent2), reference(call2)), expected, 'The sibling receipt is never read');
    assert.equal(captureResearchConsumerRetryPermits(reopened, 'p').some(permit => permit.id === intent.id), retryable);
  });

function dry5EscalationFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-dry5-escalation-')), database = join(root, 'state.sqlite');
  const stores: Store[] = [], open = () => { const db = new Store(database); stores.push(db); return new ProductEngine(db); };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = open(), wire = join(root, 'wire.ndjson'), mode = join(root, 'mode'); writeFileSync(mode, 'escalation');
  engine.execute({ type: 'create-project', project: 'p', title: 'Early escalation retry' });
  const source = engine.discovery.evidence.document('p', 'basis', 'Evidence exists, but the owner has not chosen the private account.', 'text/plain', 0);
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{readFileSync,appendFileSync,existsSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,path=${JSON.stringify(wire)};
const prior=existsSync(path)?readFileSync(path,'utf8').trim().split('\\n').filter(Boolean).length:0;
appendFileSync(path,JSON.stringify(r)+'\\n');
const q=s.questions?.[0]??s.question,source=${JSON.stringify(reference(source))};
let research;
if(s.role==='assess-answer')research={verdict:'supported',reasons:[]};
else if(s.role==='assess-escalation')research=prior===2?{necessary:'yes'}:{necessary:true,reason:'The owner must choose their private account'};
else if(readFileSync(${JSON.stringify(mode)},'utf8')==='answer')research={action:'answer',question:q.id,value:{result:'Documented choice'},citations:[{source,selector:{kind:'text-range',start:0,end:8}}]};
else research=prior===0?{action:'read_source',source,start:0,end:8}:{action:'need_owner',question:q.id,reason:'Choose the private account',searched:[source]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:null}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'discovery', [{ field: 'result', kind: 'design',
    prompt: 'Resolve the account choice', risk: 'No account selected', schema: { type: 'object', required: ['result'],
      properties: { result: { type: 'string' } }, additionalProperties: false } }]);
  const calls = () => readFileSync(wire, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { engine, open, draft, calls, mode };
}
test('DRY5FIX M10: restart retries only the malformed escalation assessor with its contract', async t => {
  const f = dry5EscalationFixture(t);
  const first = await f.engine.researcher.run('p', f.draft.id, 8);
  assert.equal(first.value.pauseCode, 'escalation_assessment_invalid'); assert.equal(f.calls().length, 3);
  const result = await f.open().researcher.run('p', f.draft.id, 8);
  assert.equal(result.value.status, 'needs_owner'); assert.equal(f.calls().length, 4);
  assert.equal(f.calls()[3].subject.role, 'assess-escalation');
  assert.equal(f.calls()[3].subject.failures[0].code, 'escalation_assessment_invalid');
  assert.ok(f.calls()[3].subject.failures[0].responseContract);
});
test('DRY5FIX C several native reopens retire the old candidate without transferring it', async t => {
  const f = dry5EscalationFixture(t);
  await f.engine.researcher.run('p', f.draft.id, 8); assert.equal(f.calls().length, 3);
  const question = f.engine.store.get<Question>(f.draft.value.questions[0]!)!;
  const reopened = f.engine.discovery.reopen(question.id, question.revision);
  f.engine.discovery.reopen(reopened.id, reopened.revision);
  writeFileSync(f.mode, 'answer');
  const engine = f.open(), result = await engine.researcher.run('p', f.draft.id, 8);
  assert.equal(result.value.status, 'completed', result.value.error ?? '');
  assert.equal(f.calls().length, 5);
  for (const turn of engine.store.list<ResearchTurn>('research-turn').filter(row => row.value.run === result.id))
    assert.doesNotThrow(() => readResearchConsumerTurn(engine.store, reference(turn)));
});

for (const boundary of ['receipt', 'before-outcome', 'after-outcome'])
test(`DRY5FIX C ${boundary}: recovery closes only the received erroneous assessment`, async t => {
  const f = dry5EscalationFixture(t), store = f.engine.store;
  const original = store.writeMany.bind(store); let hit = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    const match = writes.some(write => boundary === 'receipt'
      ? write.kind === 'model-response' && (write.value as any).text?.includes('"necessary":"yes"')
      : write.kind === 'research-consumer-intent' && (write.value as any).kind === 'escalation-assessor'
        && (write.value as any).state === 'refused');
    if (!hit && match) {
      hit = true; if (boundary !== 'before-outcome') original(writes, guards);
      throw new Error('DRY5FIX interrupted escalation persistence');
    }
    return original(writes, guards);
  }) as typeof store.writeMany;
  await f.engine.researcher.run('p', f.draft.id, 8);
  store.writeMany = original; assert.ok(hit); assert.equal(f.calls().length, 3);
  if (boundary !== 'after-outcome') {
    const resumed = await f.open().researcher.run('p', f.draft.id, 8);
    assert.equal(resumed.value.pauseCode, 'escalation_assessment_invalid'); assert.equal(f.calls().length, 3);
  }
  assert.equal((await f.open().researcher.run('p', f.draft.id, 8)).value.status, 'needs_owner');
  assert.equal(f.calls().length, 4); assert.equal(f.calls()[3].subject.role, 'assess-escalation');
});
test('DRY5FIX C concurrent resumes dispatch only one correction for the saved need_owner', async t => {
  const f = dry5EscalationFixture(t);
  await f.engine.researcher.run('p', f.draft.id, 8); assert.equal(f.calls().length, 3);
  const results = await Promise.allSettled([f.open().researcher.run('p', f.draft.id, 8), f.open().researcher.run('p', f.draft.id, 8)]);
  assert.ok(results.some(result => result.status === 'fulfilled' && result.value.value.status === 'needs_owner'));
  assert.equal(f.calls().length, 4);
});


import { preparedField as asm1Prepared } from './preparation-fixture.js';
import { answerDiscoveryFixture as asm1AnswerDiscovery, currentUpstreamFixtureValue } from './product-fixture.js';
import { stageNeighbors as asm1Neighbors, STAGE_NEIGHBOR_CONTEXT as ASM1_CONTEXT } from '../src/discovery/stage-neighbors.js';
import type { DiscoveryDraft as Asm1Draft } from '../src/discovery/discovery.js';

function asm1Escalation(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-asm1-c-')), database = join(root, 'state.sqlite');
  const stores: Store[] = [], open = () => { const db = new Store(database); stores.push(db); return new ProductEngine(db); };
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = open(), wire = join(root, 'wire.ndjson');
  engine.execute({ type: 'create-project', project: 'p', title: 'Accepted neighbors before owner escalation' });
  const source = engine.discovery.evidence.document('p', 'basis', 'The owner must select a private account.', 'text/plain', 0);
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, String.raw`import{readFileSync,appendFileSync,existsSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,path=${JSON.stringify(wire)};
const prior=existsSync(path)?readFileSync(path,'utf8').trim().split('\n').filter(Boolean).length:0;
appendFileSync(path,JSON.stringify(r)+'\n');
const q=s.questions?.[0]??s.question,source=${JSON.stringify(reference(source))};
const research=s.role==='assess-escalation'?{necessary:true,reason:'A private account has not been selected'}
 :prior===0?{action:'read_source',source,start:0,end:8}:{action:'need_owner',question:q.id,reason:'Choose the private account',searched:[source]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:null}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  const discovery = engine.prepare('p', 'discovery');
  for (const id of discovery.value.questions) {
    const question = engine.store.get<Question>(id)!;
    if (question.value.spec.kind === 'fact') engine.discovery.fact(id, question.revision, reference(source),
      { kind: 'text-range', start: 0, end: source.value.content.length });
    else if (['researchPlan', 'researchReport', 'verdict', 'preparation'].includes(question.value.spec.field))
      asm1AnswerDiscovery(engine, 'p', engine.store.get<Asm1Draft>(discovery.id)!, question,
        asm1Prepared('p', question.value.spec.field), source);
    else engine.discovery.decision(id, question.revision, 'owner', asm1Prepared('p', question.value.spec.field));
  }
  const discoveryArtifact = engine.draft('p', 'discovery', discovery.id, 0);
  engine.pipeline.accept('p', 'discovery', discoveryArtifact.revision);
  const draft = engine.prepare('p', 'concept');
  for (const id of draft.value.questions.slice(0, -1)) {
    const q = engine.store.get<Question>(id)!;
    engine.discovery.decision(id, q.revision, 'owner', asm1Prepared('p', q.value.spec.field));
  }
  const current = engine.store.get<Asm1Draft>(draft.id)!, chosen = engine.store.get<Question>(draft.value.questions.at(-1)!)!;
  const neighbors = asm1Neighbors(engine.store, current, chosen).context!;
  const calls = () => readFileSync(wire, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const run = (e = engine) => e.researcher.run('p', draft.id, 4);
  return { engine, open, current, chosen, neighbors, calls, run };
}

test('ASM1 C receives accepted neighbors with an explicit saved era and preserves the owner-assessment instruction', async t => {
  const f = asm1Escalation(t);
  const result = await f.run();
  assert.equal(result.value.status, 'needs_owner', result.value.error ?? 'Owner review should finish');
  assert.equal(f.calls().length, 3);
  const call = f.calls()[2];
  assert.equal(call.subject.role, 'assess-escalation');
  assert.deepEqual(call.subject.stageNeighbors, f.neighbors);
  assert.equal(call.subject.assessmentContextContract, ASM1_CONTEXT);
  assert.match(call.prompt, /user question is unavoidable/);
  assert.match(call.prompt, /stageNeighbors/);
  assert.equal(call.subject.request.action, 'need_owner');
  const intent = f.engine.store.list<ResearchConsumerIntent>('research-consumer-intent').find(row => row.value.kind === 'escalation-assessor')!;
  assert.equal(intent.value.cursor.contextContract, ASM1_CONTEXT);
  assert.ok(intent.value.cursor.neighborReads.reads.length > 0);
  assert.equal(readResearchConsumerIntent(f.open().store, reference(intent)).value.state, 'applied');
  const q = f.engine.store.get<Question>(f.neighbors.fields[0]!.question.id)!;
  f.engine.discovery.reopen(q.id, q.revision);
  assert.deepEqual(readResearchConsumerIntent(f.open().store, reference(intent)).value.cursor.context.stageNeighbors, f.neighbors);
  assert.equal(f.calls().length, 3);
});

test('ASM1 C resumes its paid receipt after a new Store without another model call', async t => {
  const f = asm1Escalation(t), db = f.engine.store, original = db.writeMany.bind(db); let stopped = false;
  db.writeMany = ((writes: Write[], guards: any = []) => {
    const result = original(writes, guards);
    if (!stopped && writes.some(w => w.kind === 'model-response') && db.list('model-call').length === 3) {
      stopped = true; throw new Error('ASM1 paid C crash');
    }
    return result;
  }) as typeof db.writeMany;
  const interrupted = await f.run(); db.writeMany = original;
  assert.equal(interrupted.value.status, 'paused');
  assert.match(interrupted.value.error ?? '', /ASM1 paid C crash/);
  assert.ok(stopped); assert.equal(f.calls().length, 3);
  const result = await f.run(f.open());
  assert.equal(result.value.status, 'needs_owner', result.value.error ?? 'The same paid C should apply');
  assert.equal(f.calls().length, 3);
  assert.deepEqual(f.calls()[2].subject.stageNeighbors, f.neighbors);
});

test('ASM1 C guards an accepted neighbor against native reopen during publication', async t => {
  const f = asm1Escalation(t), db = f.engine.store, other = f.open(), original = db.writeMany.bind(db); let changed = false;
  db.writeMany = ((writes: Write[], guards: any = []) => {
    if (!changed && writes.some(w => w.kind === 'research-consumer-intent'
      && (w.value as any).kind === 'escalation-assessor' && (w.value as any).state === 'applied')) {
      changed = true;
      const q = other.store.get<Question>(f.neighbors.fields[0]!.question.id)!;
      other.discovery.reopen(q.id, q.revision);
    }
    return original(writes, guards);
  }) as typeof db.writeMany;
  const result = await f.run(); db.writeMany = original;
  assert.ok(changed); assert.equal(result.value.status, 'paused');
  assert.equal(f.calls().length, 3);
  const intent = db.list<ResearchConsumerIntent>('research-consumer-intent').find(row => row.value.kind === 'escalation-assessor')!;
  assert.notEqual(intent.value.state, 'applied');
  assert.equal(db.get<Question>(f.chosen.id)!.value.status, 'open');
  assert.deepEqual(readResearchConsumerIntent(f.open().store, reference(intent)).value.cursor.context.stageNeighbors, f.neighbors);
});


test('ASM1 round3 current C after native reopens receives new neighbor refs while its completed old intent remains historical', async t => {
  const f = asm1Escalation(t); await f.run();
  const before = f.engine.store.list<ResearchConsumerIntent>('research-consumer-intent')
    .find(row => row.value.kind === 'escalation-assessor')!;
  const other = f.open(), selectedBefore = other.store.get<Question>(f.chosen.id)!;
  // A completed C is an owner-choice gate, not a model answer. Close that gate
  // through the product before starting another current evaluation.
  other.discovery.decision(selectedBefore.id, selectedBefore.revision, 'owner',
    currentUpstreamFixtureValue(other, 'p', selectedBefore.value.spec.field, asm1Prepared('p', selectedBefore.value.spec.field)));
  assert.equal((await f.run(other)).value.status, 'completed');
  const q = other.store.get<Question>(f.neighbors.fields[0]!.question.id)!;
  const opened = other.discovery.reopen(q.id, q.revision);
  other.discovery.decision(opened.id, opened.revision, 'owner', 'Changed audience');
  const selected = other.store.get<Question>(f.chosen.id)!; other.discovery.reopen(selected.id, selected.revision);
  const result = await f.run(f.open());
  assert.equal(result.value.status, 'needs_owner', result.value.error ?? 'A new current C must finish');
  const calls = f.calls().filter(row => row.subject.role === 'assess-escalation');
  assert.equal(calls.length, 2); assert.equal(calls[1].subject.stageNeighbors.fields[0].value, 'Changed audience');
  assert.notDeepEqual(calls[1].subject.stageNeighbors.fields[0].question, calls[0].subject.stageNeighbors.fields[0].question);
  assert.deepEqual(readResearchConsumerIntent(f.open().store, reference(before)), before);
});
