import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, type Write } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { preparedFeatures } from './product-fixture.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { readBundle, readReaderResultAt, resumeReadBundleIntent, type ReaderResult } from '../src/discovery/reader.js';
import { readResearchConsumerIntent, readResearchConsumerExecution,
  prepareResearchConsumerApplication, refuseResearchConsumerIntent, captureResearchConsumerRetryPermits } from '../src/discovery/response-recovery.js';
import { previewResearch } from '../src/discovery/research-preview.js';
import { ResearchSources } from '../src/discovery/research-sources.js';
import { prepareLateModelReceipt, readLateModelReceipt, readModelCallRecovery,
  type LateModelReceipt } from '../src/discovery/model-call-recovery.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { canonical, hashJson } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import type { Question } from '../src/discovery/discovery.js';
import type { ResearchTurn } from '../src/discovery/research-model.js';

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
