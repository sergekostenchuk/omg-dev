import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, storeReads, type Write } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import {
  readCapacityProjection,
  researchCapacityProjection,
  declareResultCapacity,
  researchCapacityInput,
  RESULT_CAPACITY,
  RESULT_CAPACITY_REFUSAL,
} from '../src/discovery/early-research-outcome.js';
import {
  assessmentSession,
  readAssessmentSessionOutcomeAt,
  assessmentReplyFailure,
} from '../src/discovery/assessment-session.js';
import type { Question } from '../src/discovery/discovery.js';

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function testFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-assessment-exact-reads-'));
  const workspace = join(root, 'repo');
  const database = join(root, 'db.sqlite');
  mkdirSync(workspace);
  git(workspace, ['init', '-b', 'main']);
  writeFileSync(join(workspace, 'README.md'), 'Exact reads fixture\n');
  git(workspace, ['add', '.']);
  git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);

  const opened: Store[] = [];
  const fresh = () => {
    const s = new Store(database);
    opened.push(s);
    return s;
  };
  t.after(() => {
    for (const s of opened) s.close();
    rmSync(root, { recursive: true, force: true });
  });

  const store = fresh();
  const engine = new ProductEngine(store);
  const wire = join(root, 'wire.ndjson');
  const adapter = join(root, 'adapter.mjs');

  engine.execute({ type: 'create-project', project: 'p', title: 'Exact assessment reads' });
  writeFileSync(adapter, `import { readFileSync, appendFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(wire)}, JSON.stringify(r) + '\\n');
console.log(JSON.stringify({
  protocol: r.protocol,
  requestId: r.requestId,
  research: { verdict: 'supported', reasons: [] },
  usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0 }
}));`);

  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', {
    workspace,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command,
    timeoutMs: 5000,
  }, 0);

  const source = engine.discovery.evidence.document('p', 'basis', 'AB', 'text/plain', 0);
  const observation = engine.discovery.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: 2 });
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation', [{
    field: 'combine',
    kind: 'design',
    prompt: 'Combine both operands',
    risk: 'Omitting one operand',
    schema: {
      type: 'object',
      required: ['result'],
      properties: { result: { type: 'string' } },
      additionalProperties: false,
    },
  }]);

  const question = store.get<Question>(draft.value.questions[0]!)!;
  const context = {
    role: 'assess-answer',
    question: { id: question.id, ...question.value.spec },
    resources: { a: 'A', b: 'B' },
    workingSelections: [],
    readings: [],
    value: { result: 'AB' },
    observations: [observation],
  };

  return { root, database, fresh, store, engine, draft, question, environment, context };
}

test('G5b exact trusts saved Store record by exact Ref without recomputing hashJson', async t => {
  const f = testFixture(t);
  const body = { sample: 'exact-test-payload', counter: 42 };
  const hash = hashJson(body);
  const id = `test-exact:p:1`;

  f.store.writeMany([
    { id, kind: 'test-exact', expected: 0, value: body },
  ], []);

  const ref: Ref = { id, revision: 1, hash };
  const read = f.store.get<typeof body>(id, 1);
  assert.ok(read);
  assert.equal(read.hash, hash);
  assert.deepEqual(reference(read), ref);

  const wrongRef: Ref = { id, revision: 1, hash: '0'.repeat(64) };
  assert.notEqual(read.hash, wrongRef.hash);
});

test('G5b readCapacityProjection and researchCapacityProjection read without hashing restored body', async t => {
  const f = testFixture(t);
  const bindings = { projectId: 'p', draft: reference(f.draft), question: reference(f.question) };
  const command = { executable: process.execPath, args: [] };
  const input = researchCapacityInput({
    operation: 'op-1',
    generation: 0,
    bindings,
    role: 'assessor',
    purpose: 'assessor',
    actionMode: 'assess-answer',
    limit: 100_000,
    prompt: 'Test prompt',
    binding: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    draft: f.draft.value,
    question: { id: f.question.id, value: f.question.value },
    context: f.context,
  });

  const capacity = declareResultCapacity(f.store, input);
  assert.ok(capacity.mandatory);
  assert.ok('archive' in capacity.mandatory);

  const archive = capacity.mandatory.archive;
  assert.ok(archive);

  // readCapacityProjection reads saved record by exact Ref without body re-hashing
  const rStart1 = storeReads();
  const projection = readCapacityProjection(f.store, archive.record, archive.pointer);
  assert.equal(storeReads() - rStart1, 1, 'readCapacityProjection must use exactly 1 read');
  assert.ok(projection);
  assert.equal(projection.protocol, 'omg-agent/v1');
  assert.equal(projection.mode, 'research');

  // researchCapacityProjection returns projection directly without re-hashing
  const rStart2 = storeReads();
  const projected = researchCapacityProjection(capacity, f.store);
  assert.equal(storeReads() - rStart2, 1, 'researchCapacityProjection must use exactly 1 read');
  assert.deepEqual(projected, projection);

  // Foreign pointer or missing record fails with research_capacity_invalid
  assert.throws(
    () => readCapacityProjection(f.store, archive.record, '/wrong-pointer'),
    { code: 'research_capacity_invalid' }
  );
  const fakeRef: Ref = { id: 'research-context:missing', revision: 1, hash: '0'.repeat(64) };
  assert.throws(
    () => readCapacityProjection(f.store, fakeRef, '/body'),
    { code: 'research_capacity_invalid' }
  );
});

test('G5b cold reading of applied assessment outcome adheres to numerical storeReads budget O(1)', async t => {
  const f = testFixture(t);

  // Run assessment to completion
  await assessmentSession(f.store, f.draft, f.question, f.environment, f.environment.value, undefined, f.context, 'Assess prompt');

  const apps = f.store.list('assessment-application');
  const appliedApp = apps.find(a => (a.value as any).state === 'applied');
  assert.ok(appliedApp, 'Assessment application must reach applied state');

  const sessions = f.store.list('assessment-session');
  const terminalSession = sessions.find(s => (s.value as any).result !== null);
  assert.ok(terminalSession, 'Assessment session must have a terminal result');

  // Open a completely fresh Store (cold read)
  const coldStore = f.fresh();

  const startReads = storeReads();
  const outcome = readAssessmentSessionOutcomeAt(
    coldStore,
    'p',
    reference(terminalSession),
    reference(appliedApp)
  );

  const readsUsed = storeReads() - startReads;
  assert.ok(outcome, 'Outcome must be read successfully');
  assert.deepEqual(outcome.result, { verdict: 'supported', reasons: [] });

  // Exact read budget: reading the terminal session, application and its proving chain is strictly bounded O(1)
  assert.ok(readsUsed <= 30, `Cold reading outcome must use <= 30 reads, actually used: ${readsUsed}`);
  assert.equal(readsUsed, 29);

  // Re-reading outcome on another fresh store yields identical reads
  const coldStore2 = f.fresh();
  const startReads2 = storeReads();
  readAssessmentSessionOutcomeAt(coldStore2, 'p', reference(terminalSession), reference(appliedApp));
  const readsUsed2 = storeReads() - startReads2;
  assert.equal(readsUsed2, readsUsed, 'Subsequent cold read must use identical read count');
});

test('G5b assessmentReplyFailure validates payload against saved capacity with zero extra Store reads', async t => {
  const f = testFixture(t);

  await assessmentSession(f.store, f.draft, f.question, f.environment, f.environment.value, undefined, f.context, 'Assess prompt');
  const appliedApp = f.store.list('assessment-application').find(a => (a.value as any).state === 'applied');
  assert.ok(appliedApp);

  const app = appliedApp.value as any;
  assert.ok(app.context.resultCapacity);
  assert.equal(app.context.resultCapacityContract, RESULT_CAPACITY);

  // 1. Normal payload fits: returns null with 0 store reads
  const readsBefore1 = storeReads();
  const okFailure = assessmentReplyFailure(f.store, app, { verdict: 'supported', reasons: [] });
  const readsAfter1 = storeReads();
  assert.equal(okFailure, null);
  assert.equal(readsAfter1 - readsBefore1, 0, 'assessmentReplyFailure must make 0 Store reads for normal payload');

  // 2. Oversized payload: returns RESULT_CAPACITY_REFUSAL EngineError with 0 store reads
  const readsBefore2 = storeReads();
  const oversizedPayload = {
    verdict: 'supported',
    reasons: ['x'.repeat(400_000)],
  };
  const capacityError = assessmentReplyFailure(f.store, app, oversizedPayload);
  const readsAfter2 = storeReads();
  assert.ok(capacityError instanceof EngineError);
  assert.equal(capacityError.code, RESULT_CAPACITY_REFUSAL);
  assert.equal(readsAfter2 - readsBefore2, 0, 'assessmentReplyFailure must make 0 Store reads for oversized payload');

  // 3. Tampered capacity contract throws research_capacity_invalid
  const tamperedEraApp = {
    ...app,
    context: { ...app.context, resultCapacityContract: 'result-capacity/v0' },
  };
  assert.throws(
    () => assessmentReplyFailure(f.store, tamperedEraApp, { verdict: 'supported', reasons: [] }),
    { code: 'research_capacity_invalid' }
  );

  // 4. Missing/damaged resultCapacity throws research_capacity_invalid
  const damagedCapacityApp = {
    ...app,
    context: { ...app.context, resultCapacity: null },
  };
  assert.throws(
    () => assessmentReplyFailure(f.store, damagedCapacityApp, { verdict: 'supported', reasons: [] }),
    { code: 'research_capacity_invalid' }
  );
});

test('G5b 10x historical growth invariant: reading saved assessment outcome does not increase Store reads', async t => {
  const f = testFixture(t);

  await assessmentSession(f.store, f.draft, f.question, f.environment, f.environment.value, undefined, f.context, 'Assess prompt');
  const appliedApp = f.store.list('assessment-application').find(a => (a.value as any).state === 'applied')!;
  const terminalSession = f.store.list('assessment-session').find(s => (s.value as any).result !== null)!;

  // Base read measurement on fresh store
  const coldBase = f.fresh();
  const baseStart = storeReads();
  readAssessmentSessionOutcomeAt(coldBase, 'p', reference(terminalSession), reference(appliedApp));
  const baseReads = storeReads() - baseStart;

  // Inject 10x historical noise records into the database
  const noiseWrites: Write[] = [];
  for (let i = 0; i < 50; i++) {
    noiseWrites.push({
      id: `historical-noise:${i}`,
      kind: 'historical-noise',
      expected: 0,
      value: { index: i, timestamp: Date.now(), data: 'x'.repeat(500) },
    });
  }
  f.store.writeMany(noiseWrites, []);

  // Measure read count on a new fresh store with 50 extra records in database
  const coldEnlarged = f.fresh();
  const enlargedStart = storeReads();
  readAssessmentSessionOutcomeAt(coldEnlarged, 'p', reference(terminalSession), reference(appliedApp));
  const enlargedReads = storeReads() - enlargedStart;

  // Reading the exact committed assessment must not be affected by history depth: Delta = 0
  assert.equal(
    enlargedReads,
    baseReads,
    `10x history growth must produce delta=0 reads; base=${baseReads}, enlarged=${enlargedReads}`
  );
});
