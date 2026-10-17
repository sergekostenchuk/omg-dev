import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/storage/store.js';
import { storeView } from '../src/storage/store-view.js';
import { ProductEngine } from '../src/product/engine.js';
import { git } from '../src/runtime/environment.js';
import { reference } from '../src/pipeline/contracts.js';
import type { Question } from '../src/discovery/discovery.js';
import { assessmentSession, readAssessmentSessionOutcomeAt, runAssessmentRefusalDoor } from '../src/discovery/assessment-session.js';
import { assessmentReadView, type AssessmentReadProof } from '../src/discovery/response-recovery.js';

const fixtures = fileURLToPath(new URL('../../test/fixtures/assessment-read-era/', import.meta.url));
const cases = [
  { name: 'assessor-read-large-value', sha256: '07d49e83c12880936b40891e67770960bd11793b7f9d66b9cdeabaacd902548f',
    sources: 1, reads: 6, state: 'applied', door: false },
  { name: 'assessor-evidence-large', sha256: '3e447ec22279db31907c589377efe8cb1d4bc9b32824d852a9590da3783eeddd',
    sources: 1500, reads: 1505, state: 'refused', door: true },
] as const;

// Unmodified SQLite bytes captured by STRESS1 at 295b21fc, before RD2.
// These two forms represent all nine affected after-snapshots; no synthetic
// application, selector, Ref, wire response or proof is written to either DB.
for (const sample of cases) test(`RD2e historical ${sample.name}: exact proof survives first read and cold repeat`, t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-assessment-era-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = gunzipSync(readFileSync(join(fixtures, `discovery--${sample.name}--after.sqlite.gz`)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sample.sha256);
  const database = join(root, 'state.sqlite');
  writeFileSync(database, bytes);
  let originalProof: AssessmentReadProof | undefined;
  for (const phase of ['first', 'cold-repeat']) {
    const store = new Store(database);
    try {
      const application = store.list<any>('assessment-application').find(app => app.value.resolution !== null)!;
      const proof: AssessmentReadProof = application.value.resolution;
      assert.equal(proof.contract, 'assessment-read/v1');
      assert.equal(application.value.state, sample.state);
      assert.equal(proof.reads.length, sample.reads);
      assert.equal(proof.reads.filter(entry => entry.id.startsWith('source:')).length, sample.sources);
      if (originalProof) assert.deepEqual(proof, originalProof);
      else originalProof = structuredClone(proof);
      const before = store.list();
      const run = store.list<any>('research-run').find(record => record.value.status === 'paused')!;
      assert.ok(run);
      const door = runAssessmentRefusalDoor(store, 'stress1', run);
      if (sample.door) {
        assert.equal(door?.contract, 'assessment-refusal-door/v1');
        assert.equal(door.code, 'research_context_application_refused');
        assert.deepEqual(door.application, reference(application));
        assert.equal(door.command.type, 'reopen-question');
      } else assert.equal(door, null);
      assert.deepEqual(store.list(), before, `${phase} must only read saved proof`);
      assert.deepEqual(store.get<any>(application.id)!.value.resolution, originalProof);
    } finally { store.close(); }
  }
});

// REVIEW5636's unmodified transition: 295b21fc saves the paid markerless
// response before application; 0a4aeb73 applies it with seven captured reads.
// The third step reads that genuine application through both current APIs.
test('RD2e markerless response applied in the transitional era retains its seven-read proof', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-assessment-transition-era-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = gunzipSync(readFileSync(join(fixtures, 'transitional--markerless-applied.sqlite.gz')));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    'cd0747c7ee319704511ac42ac922349e7049cd237e322f003179baf2d72399f6');
  const database = join(root, 'state.sqlite');
  writeFileSync(database, bytes);
  for (const phase of ['first', 'cold-repeat']) {
    const store = new Store(database);
    try {
      const before = store.list();
      const first = store.list<any>('assessment-application').find(app => app.value.previous === null)!;
      const proof: AssessmentReadProof = first.value.resolution;
      assert.equal(proof.reads.length, 7);
      const archiveRef = proof.reads[1]!.ref!;
      const archive = store.get<any>(archiveRef.id, archiveRef.revision)!;
      assert.equal(archive.value.body.contextReadContract, undefined);
      assert.equal(proof.reads.filter(entry => entry.id === archive.id).length, 4);
      const session = store.list<any>('assessment-session').find(row => row.value.result)!;
      const applied = store.get<any>(session.value.application)!;
      const binding = session.value.binding;
      const draft = store.get<any>(binding.draft.id, binding.draft.revision)!;
      const question = store.get<Question>(binding.question.id, binding.question.revision)!;
      const environment = store.get<any>(binding.environment.id, binding.environment.revision)!;
      assert.equal(store.list('model-call').length, 2);
      // Any attempted repeat would first have to write its claim; forbid it.
      const view = storeView(store, { write: () => { throw new Error('Historical terminal must not write or dispatch'); } });
      const verdict = { verdict: 'supported', reasons: [] };
      assert.deepEqual(await assessmentSession(view, draft, question, environment, first.value.dispatch,
        undefined, first.value.context, first.value.prompt), verdict, phase);
      assert.deepEqual(readAssessmentSessionOutcomeAt(view, 'p', reference(session), reference(applied)).result, verdict);
      assert.deepEqual(store.list(), before);
      assert.deepEqual(store.get<any>(first.id)!.value.resolution, proof);
    } finally { store.close(); }
  }
});

test('RD2e current paid context read keeps its declared era and exact selector order after restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-assessment-current-era-'));
  const database = join(root, 'state.sqlite'), workspace = join(root, 'repo');
  mkdirSync(workspace);
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base']);
  const opened: Store[] = [];
  t.after(() => { for (const store of opened) store.close(); rmSync(root, { recursive: true, force: true }); });
  const fresh = () => { const store = new Store(database); opened.push(store); return store; };
  const store = fresh(), engine = new ProductEngine(store);
  const adapter = join(root, 'provider.mjs'), wire = join(root, 'calls.jsonl');
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
const research=s.contextWorkspace.length?{verdict:'supported',reasons:[]}:
{action:'read_context',record:s.working.archive,pointer:'/body/resources/a',page:{offset:0,limit:1000000}};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,
usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  engine.execute({ type: 'create-project', project: 'p', title: 'Current read era' });
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const source = engine.discovery.evidence.document('p', 'basis', 'AB', 'text/plain', 0);
  const observation = engine.discovery.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: 2 });
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation', [{ field: 'combine', kind: 'design',
    prompt: 'Combine both operands', risk: 'Omitting an operand', schema: { type: 'object', required: ['result'],
      properties: { result: { type: 'string' } }, additionalProperties: false } }]);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const context = { role: 'assess-answer', question: { id: question.id, ...question.value.spec }, resources: { a: 'A', b: 'B' },
    workingSelections: [], readings: [], value: { result: 'AB' }, observations: [observation] };
  const invoke = (db: Store) => assessmentSession(db, draft, question, environment, environment.value, undefined, context, 'Assess both operands');
  const verdict = { verdict: 'supported', reasons: [] };
  assert.deepEqual(await invoke(store), verdict);
  const calls = readFileSync(wire, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2);
  const application = store.list<any>('assessment-application').find(app => app.value.previous === null)!;
  const proof: AssessmentReadProof = application.value.resolution;
  const archive = calls[0].subject.working.archive;
  assert.equal(store.get<any>(archive.id, archive.revision)!.value.body.contextReadContract, 'research-context-read/v2');
  assert.equal(proof.reads.filter(entry => entry.id === archive.id).length, 4);
  assert.equal(proof.reads.length, 7);
  const session = store.list<any>('assessment-session')[0]!;
  const applied = store.get(session.value.application)!;
  for (const restarted of [fresh(), fresh()]) {
    const heads = restarted.list();
    assert.deepEqual(await invoke(restarted), verdict);
    assert.deepEqual(readAssessmentSessionOutcomeAt(restarted, 'p', reference(session), reference(applied)).result, verdict);
    assert.deepEqual(restarted.list(), heads);
    assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 2);
  }
  const exactArchive = store.get<any>(archive.id, archive.revision)!;
  const beforeMutations = store.list();
  for (const mutation of ['remove-marker', 'unknown-marker', 'foreign-archive']) {
    let intercepted = 0;
    const view = storeView(store, { write: () => { throw new Error('Historical proof must not write'); },
      get: (id, revision) => {
        if (id !== archive.id || revision !== archive.revision) return undefined;
        intercepted++;
        const row = structuredClone(exactArchive);
        if (mutation === 'remove-marker') delete row.value.body.contextReadContract;
        else if (mutation === 'unknown-marker') row.value.body.contextReadContract = 'research-context-read/unknown';
        else row.id = 'research-context:foreign';
        return row;
      } });
    assert.throws(() => readAssessmentSessionOutcomeAt(view, 'p', reference(session), reference(applied)),
      { code: 'research_context_read_proof_invalid' });
    assert.ok(intercepted > 0);
    assert.deepEqual(store.list(), beforeMutations);
    assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 2);
  }
  const later = structuredClone(exactArchive.value);
  delete later.body.contextReadContract;
  store.write({ id: archive.id, kind: exactArchive.kind, expected: archive.revision, value: later });
  const shifted = fresh();
  assert.equal(shifted.get(archive.id)!.revision, archive.revision + 1);
  assert.deepEqual(readAssessmentSessionOutcomeAt(shifted, 'p', reference(session), reference(applied)).result, verdict);
  assert.equal(readFileSync(wire, 'utf8').trim().split('\n').length, 2);

  // An altered sequence is rejected as an input proof, without forging a DB.
  const reordered = structuredClone(proof);
  [reordered.reads[0], reordered.reads[1]] = [reordered.reads[1]!, reordered.reads[0]!];
  const replay = assessmentReadView(store, reordered);
  const first = proof.reads[0]!;
  assert.throws(() => replay.store.get(first.id, first.revision ?? undefined), { code: 'research_context_read_proof_invalid' });
  assert.throws(() => replay.finish(), { code: 'research_context_read_proof_invalid' });
});
