import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, type Write, type ReadGuard } from '../src/storage/store.js';
import { hashJson } from '../src/canonical.js';
import { reference, type StageArtifact } from '../src/pipeline/contracts.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ReaderPilot } from '../src/discovery/reader-pilot.js';
import type { Environment } from '../src/runtime/environment.js';
import { contextLookupKey } from '../src/discovery/context-workspace.js';
import { readResearchContext } from '../src/discovery/research-limits.js';
import { recoverContextSession, type RecoverableContextSession } from '../src/discovery/context-recovery.js';
import { Evidence } from '../src/evidence/evidence.js';
import { ProductEngine } from '../src/product/engine.js';

function fixture(t: test.TestContext, kind = 'synthesis-session', matchingCounter = true) {
  const root = mkdtempSync(join(tmpdir(), 'omg-context-recovery-'));
  const store = new Store(join(root, 'test.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const input = store.write<StageArtifact>({ id: 'stage:p:concept', kind: 'stage', expected: 0,
    value: { projectId: 'p', stage: 'concept', status: 'accepted', inputs: [], proofs: [],
      content: { fields: { material: 'ABCDEFGHIJ', other: 'A different required contract' } } } });
  const command = { executable: process.execPath, args: [] };
  const environment = store.write<Environment>({ id: 'environment:p', kind: 'environment', expected: 0,
    value: { projectId: 'p', workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 1000 } });
  const draft = store.write<DiscoveryDraft>({ id: 'discovery:p:recovery', kind: 'discovery-draft', expected: 0,
    value: { projectId: 'p', createdAt: 0, stage: 'om-g2', level: 'R2', consumer: 'compilation', fields: { technical: null },
      questions: ['question:p:recovery'], inputs: [reference(input)] } });
  const question = store.write<Question>({ id: draft.value.questions[0]!, kind: 'question', expected: 0,
    value: { projectId: 'p', draftId: draft.id, stage: draft.value.stage, level: draft.value.level, consumer: draft.value.consumer,
      spec: { field: 'technical', kind: 'design', prompt: 'Resolve the contract', risk: 'Missing contract', schema: {} },
      status: 'open', beforeHash: hashJson(null), answer: null } });
  const pilot = store.write<ReaderPilot>({ id: 'reader-pilot:p', kind: 'reader-pilot', expected: 0,
    value: { projectId: 'p', experimental: true, active: true, stopAfter: 'L2',
      reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
      maxRequestChars: 10000, maxReadChars: 5000, maxReplyChars: 1000, maxCalls: 10, maxReportedTokens: 20000 } });
  const selection = { record: reference(input), pointer: '/content/fields/material', page: { offset: 0, limit: 4 } };
  const original = readResearchContext(store, draft, question.id, pilot, selection.record, selection.pointer, selection.page);
  const session = store.write<RecoverableContextSession>({ id: `${kind}:fixture`, kind, expected: 0,
    value: { projectId: 'p', binding: { draft: reference(draft), question: reference(question), environment: reference(environment), inputs: draft.value.inputs },
      offset: 12, materialOffset: 3, candidateOffset: 8, notes: [{ claim: 'Saved paid work', source: selection.record }], focus: null, result: null,
      workspace: { entries: [{ key: contextLookupKey(original), result: original }], sinceProgress: 3, blocked: 'Too many lookups without progress' },
      recoveries: [{ reason: 'Older operator recovery' }] } });
  const counter = store.write({ id: `question-dispatch:${hashJson(matchingCounter ? question.id : 'another-question')}`, kind: 'question-dispatch', expected: 0,
    value: { projectId: 'p', question: question.id, serial: 3 } });
  const budget = store.write({ id: 'research-budget:p:unchanged', kind: 'research-budget', expected: 0,
    value: { projectId: 'p', limit: 800000, reserved: 2500, measured: 12000 } });
  const call = store.write({ id: 'model-call:paid', kind: 'model-call', expected: 0,
    value: { projectId: 'p', draftId: draft.id, questionId: question.id, status: 'succeeded', usage: { inputTokens: 900, outputTokens: 100 } } });
  const next = { ...selection, page: { offset: 4, limit: 4 } };
  const update = (patch: Partial<RecoverableContextSession>) => store.write<RecoverableContextSession>({ id: session.id, kind,
    expected: store.get(session.id)!.revision, value: { ...store.get<RecoverableContextSession>(session.id)!.value, ...patch } });
  return { store, input, environment, draft, question, pilot, session, counter, budget, call, original, selection, next, update };
}

test('public recovery command uses the exact blocked session and rejects a replay',t=>{
  const f=fixture(t);
  const engine=new ProductEngine(f.store);
  engine.execute({type:'create-project',project:'p',title:'Recovery fixture'});
  const command={type:'recover-context-session',project:'p',session:reference(f.session),selector:f.next};
  engine.execute(command);
  assert.throws(()=>engine.execute(command),{code:'context_session_stale'});
  assert.equal(f.store.list('model-call').length,1);
});

for (const kind of ['synthesis-session', 'assessment-session']) test(`${kind} recovery adds exact new material without changing history or budget`, t => {
  const f = fixture(t, kind);
  const before = f.store.list().filter(record => record.id !== f.session.id);
  const recovered = recoverContextSession(f.store, 'p', reference(f.session), f.next);
  assert.equal(recovered.revision, f.session.revision + 1);
  assert.deepEqual(f.store.get(f.session.id, f.session.revision), f.session, 'Old session remains immutable');
  assert.deepEqual(f.store.list().filter(record => record.id !== f.session.id), before, 'No calls, sources, counters or budgets changed');
  assert.deepEqual(recovered.value.workspace!.entries[0], f.session.value.workspace!.entries[0]);
  assert.deepEqual(recovered.value.workspace!.entries[1]!.result,
    { record: reference(f.input), pointer: f.next.pointer, value: 'EFGH', page: { offset: 4, end: 8, total: 10, unit: 'utf16', next: 8 } });
  assert.equal(recovered.value.workspace!.sinceProgress, 0);
  assert.equal(Object.hasOwn(recovered.value.workspace!, 'blocked'), false);
  for (const field of ['binding', 'offset', 'materialOffset', 'candidateOffset', 'notes', 'focus', 'result'])
    assert.deepEqual(recovered.value[field], f.session.value[field], field);
  assert.deepEqual(recovered.value.recoveries![0], f.session.value.recoveries![0]);
  assert.deepEqual(recovered.value.recoveries![1], { origin: 'operator', session: reference(f.session), reason: f.session.value.workspace!.blocked,
    selector: f.next, key: contextLookupKey(recovered.value.workspace!.entries[1]!.result) });
});

test('recovery refuses missing, foreign, forged and stale sessions', t => {
  const f = fixture(t);
  assert.throws(() => recoverContextSession(f.store, 'p', { ...reference(f.session), id: 'missing' }, f.next), { code: 'context_session_foreign' });
  assert.throws(() => recoverContextSession(f.store, 'foreign', reference(f.session), f.next), { code: 'context_session_foreign' });
  assert.throws(() => recoverContextSession(f.store, 'p', { ...reference(f.session), hash: '0'.repeat(64) }, f.next), { code: 'context_session_stale' });
  f.update({ notes: ['Another writer advanced this session'] });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), f.next), { code: 'context_session_stale' });
});

test('legacy sessions and absent binding members fail with a typed refusal', t => {
  const f = fixture(t);
  const { binding: _binding, ...legacy } = f.session.value;
  let current = f.store.write<RecoverableContextSession>({ id: f.session.id, kind: f.session.kind, expected: f.session.revision, value: legacy });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(current), f.next), { code: 'context_binding_missing' });
  for (const field of ['draft', 'question', 'environment', 'inputs']) {
    const binding = { ...f.session.value.binding } as Record<string, unknown>;
    delete binding[field];
    current = f.update({ binding } as unknown as Partial<RecoverableContextSession>);
    assert.throws(() => recoverContextSession(f.store, 'p', reference(current), f.next), { code: 'context_binding_missing' });
  }
});

for (const field of ['draft', 'question', 'environment', 'input'] as const) test(`a changed ${field} invalidates the saved recovery binding`, t => {
  const f = fixture(t);
  const record = f[field];
  f.store.write({ id: record.id, kind: record.kind, expected: record.revision, value: record.value });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), f.next), { code: 'context_binding_stale' });
  assert.deepEqual(f.store.get(f.session.id), f.session);
});

test('recovery refuses a current foreign question and mismatched bound inputs', t => {
  const f = fixture(t);
  const foreign = f.store.write<Question>({ id: 'question:foreign', kind: 'question', expected: 0,
    value: { ...f.question.value, projectId: 'foreign' } });
  let current = f.update({ binding: { ...f.session.value.binding!, question: reference(foreign) } });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(current), f.next), { code: 'context_binding_foreign' });
  current = f.update({ binding: { ...f.session.value.binding!, inputs: [] } });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(current), f.next), { code: 'context_binding_stale' });
});

test('recovery requires an active preset and the matching dispatch counter', t => {
  const f = fixture(t);
  f.store.write({ id: f.pilot.id, kind: f.pilot.kind, expected: f.pilot.revision, value: { ...f.pilot.value, active: false } });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), f.next), { code: 'reader_pilot_required' });
  f.store.write({ id: f.pilot.id, kind: f.pilot.kind, expected: f.pilot.revision + 1, value: f.pilot.value });
  f.store.write({ id: f.counter.id, kind: f.counter.kind, expected: f.counter.revision, value: { projectId: 'p', question: 'foreign', serial: 3 } });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), f.next), { code: 'context_recovery_basis_missing' });
});

test('a session without a saved question dispatch counter cannot be recovered', t => {
  const f = fixture(t, 'synthesis-session', false);
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), f.next), { code: 'context_recovery_basis_missing' });
  assert.deepEqual(f.store.get(f.session.id), f.session);
});

test('a running call on the bound question blocks recovery across sessions and purposes', t => {
  const f = fixture(t);
  f.store.write({ id: 'model-call:running', kind: 'model-call', expected: 0,
    value: { projectId: 'p', draftId: 'another-session', questionId: f.question.id, purpose: 'reader', status: 'running' } });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), f.next), { code: 'context_call_active' });
  assert.deepEqual(f.store.get(f.session.id), f.session);
});

test('identical, empty, foreign and transport-oversized selections cannot clear a block', t => {
  const f = fixture(t);
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), f.selection), { code: 'context_recovery_unchanged' });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), { ...f.next, page: { offset: 10, limit: 4 } }), { code: 'context_recovery_empty' });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), { ...f.next, record: reference(f.environment) }), { code: 'context_reference_foreign' });
  f.store.write({ id: f.pilot.id, kind: f.pilot.kind, expected: f.pilot.revision, value: { ...f.pilot.value, maxRequestChars: 1, maxReadChars: 1 } });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), f.next), { code: 'context_read_limit' });
  assert.deepEqual(f.store.get(f.session.id), f.session);
});

test('moving the same selected material into a new packet archive does not establish recovery progress', t => {
  const f = fixture(t);
  const archives = ['first', 'second'].map(name => f.store.write({ id: `research-context:${name}`, kind: 'research-context', expected: 0,
    value: { projectId: 'p', draft: reference(f.draft), question: reference(f.question), body: { material: 'Already delivered' } } }));
  const original = readResearchContext(f.store, f.draft, f.question.id, f.pilot, reference(archives[0]!), '/body/material');
  const current = f.update({ workspace: { entries: [{ key: contextLookupKey(original), result: original }], sinceProgress: 3, blocked: 'Repeated archive' } });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(current), { record: reference(archives[1]!), pointer: '/body/material' }),
    { code: 'context_recovery_unchanged' });
  assert.deepEqual(f.store.get(current.id), current);
});

test('a selected value retains the source guard carried by its archive parent', t => {
  const f = fixture(t);
  const source = new Evidence(f.store).document('p', 'recovery-source', 'A new sourced contract', 'text/plain', 0);
  const archive = f.store.write({ id: 'research-context:sourced', kind: 'research-context', expected: 0,
    value: { projectId: 'p', draft: reference(f.draft), question: reference(f.question), body: {
      observation: { source: reference(source), selector: { kind: 'text-range', start: 0, end: source.value.content.length }, value: source.value.content } } } });
  const selector = { record: reference(archive), pointer: '/body/observation/value' };
  const original = f.store.writeMany.bind(f.store);
  let raced = false;
  f.store.writeMany = function <T>(writes: Write[], guards: ReadGuard[] = []) {
    if (!raced && writes.some(write => write.id === f.session.id)) {
      raced = true;
      original([{ id: source.id, kind: source.kind, expected: source.revision, value: source.value }]);
    }
    return original<T>(writes, guards);
  };
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), selector), { code: 'input_stale' });
  assert.deepEqual(f.store.get(f.session.id), f.session);
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), selector), { code: 'context_source_stale' });
});

test('completed and unblocked sessions cannot use recovery as a progress reset', t => {
  const f = fixture(t);
  let current = f.update({ result: { verdict: 'supported' } });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(current), f.next), { code: 'context_session_complete' });
  current = f.update({ result: null, workspace: { entries: f.session.value.workspace!.entries, sinceProgress: 3 } });
  assert.throws(() => recoverContextSession(f.store, 'p', reference(current), f.next), { code: 'context_session_not_blocked' });
});

for (const changed of ['session', 'counter', 'input', 'pilot'] as const) test(`atomic recovery refuses a concurrent ${changed} change`, t => {
  const f = fixture(t);
  const original = f.store.writeMany.bind(f.store);
  const concurrent = f[changed];
  let raced = false;
  f.store.writeMany = function <T>(writes: Write[], guards: ReadGuard[] = []) {
    if (!raced && writes.some(write => write.id === f.session.id)) {
      raced = true;
      original([{ id: concurrent.id, kind: concurrent.kind, expected: concurrent.revision, value: concurrent.value }]);
    }
    return original<T>(writes, guards);
  };
  assert.throws(() => recoverContextSession(f.store, 'p', reference(f.session), f.next), { code: 'input_stale' });
  assert.deepEqual(f.store.get<RecoverableContextSession>(f.session.id)!.value, f.session.value, 'The attempted new material was never written');
  assert.deepEqual(f.store.get(f.budget.id), f.budget);
  assert.deepEqual(f.store.get(f.call.id), f.call);
});
