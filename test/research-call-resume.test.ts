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

/* ==== D8.4b — synthesis/consolidation family (contract №1499) ====
 * Tests are named by the rows of the approved outcome table. */

import { synthesisSession, readSynthesisSession } from '../src/discovery/synthesis-session.js';
import { projectPaidSynthesisTransition } from '../src/discovery/response-recovery.js';
import { recoverContextSession } from '../src/discovery/context-recovery.js';
import { CONTEXT_RECOVERY_SUPERSEDE_REASON } from '../src/discovery/research-consumer-transition.js';
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
  assert.equal(f.session().value.notes.length, 3, 'the page and both fragment steps each saved their own note');
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
if(c.synthesisPage.complete&&(c.conclusions??[]).length===0)research={action:'checkpoint',question:c.question.id,value:{note:'F'.repeat(20000)},citations:[%CITE%],unresolved:['Keep the exception open']};
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
    `research={action:'checkpoint',question:c.question.id,value:{summaries:[{notes:c.consolidation.notes.map((_,i)=>i),text:'Tightened finding keeps every distinction'+('x'.repeat(c.consolidation.tightening?2000:16000))}],citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:[]};`);
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
    `research={action:'checkpoint',question:c.question.id,value:{summaries:[{notes:c.consolidation.notes.map((_,i)=>i),text:'Tightened finding keeps every distinction'+('x'.repeat(16000))}],citationIds:c.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:[]};`);
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
  assert.ok(superseded, 'the capacity-failed synthesis step was prepared before the consolidation');
  assert.equal(superseded.value.call, null, 'the unsent synthesis step has no physical attempt');
  assert.equal(superseded.value.outputs, null);
  const applied = intents.filter(intent => intent.value.state === 'applied');
  assert.ok(applied.every(intent => intent.value.owner.revision !== superseded.value.owner.revision
    || intent.value.kind === 'consolidation' || intent.id !== superseded.id));
  const head = f.session();
  assert.notEqual(head.revision, superseded.value.owner.revision,
    'the winning continuation derived the new synthesis from the new session state');
  const calls = f.store.list('model-call').length;
  assert.deepEqual(await f.invoke(f.open()), result);
  assert.equal(f.store.list('model-call').length, calls);
  assert.equal(f.store.get<any>(superseded.id)!.value.state, 'prepared', 'the superseded step never became a continuer');
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
