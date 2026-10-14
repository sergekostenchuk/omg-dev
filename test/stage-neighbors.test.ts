import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference } from '../src/pipeline/contracts.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { assessmentReadView } from '../src/discovery/response-recovery.js';
import { stageNeighbors } from '../src/discovery/stage-neighbors.js';
import { preparedField } from './preparation-fixture.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'omg-stage-neighbors-'));
  const store = new Store(join(root, 'state.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project: 'p', title: 'p' });
  return { store, engine };
}

// Native stage producers and answer/reopen commands: no manufactured accepted records.
for (const stage of ['concept', 'operation-map', 'specification', 'features'] as const) {
  test(`ASM1 ${stage}: first question has an explicit empty prefix; last sees exact accepted neighbors`, t => {
    const { store, engine } = fixture(t);
    const draft = engine.discovery.forStage('p', stage, stage);
    const questions = draft.value.questions.map(id => store.get<Question>(id)!);
    const first = stageNeighbors(store, draft, questions[0]!).context!;
    assert.equal(first.contract, 'stage-neighbors/v1');
    assert.equal(first.stage, stage);
    assert.deepEqual(first.fields, []);
    assert.equal(first.pending, null);
    for (const q of questions.slice(0, -1))
      engine.discovery.decision(q.id, q.revision, 'owner', preparedField('p', q.value.spec.field));
    const current = store.get<DiscoveryDraft>(draft.id)!;
    const result = stageNeighbors(store, current, questions.at(-1)!);
    assert.deepEqual(result.context?.draft, reference(current));
    assert.deepEqual(result.context?.question, reference(questions.at(-1)!));
    assert.equal(result.context?.pending, null);
    assert.deepEqual(result.context?.fields, questions.slice(0, -1).map(q => {
      const accepted = store.get<Question>(q.id)!;
      return { field: q.value.spec.field, question: reference(accepted), answer: accepted.value.answer,
        value: preparedField('p', q.value.spec.field) };
    }));
    for (const field of result.context!.fields) {
      assert.ok(result.guards.some(ref => ref.id === field.question.id && ref.revision === field.question.revision));
      assert.ok(result.guards.some(ref => ref.id === field.answer.id && ref.hash === field.answer.hash));
    }
    assert.ok(result.guards.some(ref => ref.id === current.id && ref.hash === current.hash));
    assert.ok(result.guards.some(ref => ref.id === questions.at(-1)!.id));
  });
}

test('ASM1 reopening a middle neighbor hides its old value and later answers until the exact question is answered', t => {
  const { store, engine } = fixture(t);
  const draft = engine.discovery.forStage('p', 'concept', 'concept');
  const [audience, outcome, acceptance, chosen] = draft.value.questions.map(id => store.get<Question>(id)!);
  for (const q of [audience!, outcome!, acceptance!])
    engine.discovery.decision(q.id, q.revision, 'owner', preparedField('p', q.value.spec.field));
  const reopened = engine.discovery.reopen(outcome!.id, store.get(outcome!.id)!.revision);
  const current = store.get<DiscoveryDraft>(draft.id)!;
  assert.equal(current.value.fields['outcome'], preparedField('p', 'outcome'));
  const pending = stageNeighbors(store, current, chosen!);
  assert.deepEqual(pending.context!.fields.map(field => field.field), ['audience']);
  assert.deepEqual(pending.context!.pending, { field: 'outcome', question: reference(reopened) });
  assert.ok(!pending.guards.some(ref => ref.id === acceptance!.id));
  engine.discovery.decision(reopened.id, reopened.revision, 'owner', 'Revised outcome');
  const restored = stageNeighbors(store, store.get<DiscoveryDraft>(draft.id)!, chosen!).context!;
  assert.equal(restored.pending, null);
  assert.deepEqual(restored.fields.map(field => field.field), ['audience', 'outcome', 'acceptance']);
  assert.equal(restored.fields[1]!.value, 'Revised outcome');
  (restored.fields[2]!.value as string[]).push('Changed local projection');
  assert.deepEqual(stageNeighbors(store, store.get<DiscoveryDraft>(draft.id)!, chosen!).context!.fields[2]!.value,
    preparedField('p', 'acceptance'));
});

test('ASM1 unresolved neighbor is pending, and an authentic foreign question cannot borrow accepted values', t => {
  const { store, engine } = fixture(t);
  const draft = engine.discovery.forStage('p', 'concept', 'concept');
  const first = store.get<Question>(draft.value.questions[0]!)!;
  const chosen = store.get<Question>(draft.value.questions.at(-1)!)!;
  engine.discovery.unresolved(first.id, first.revision);
  assert.deepEqual(stageNeighbors(store, draft, chosen).context!.pending,
    { field: first.value.spec.field, question: reference(store.get(first.id)!) });
  engine.execute({ type: 'create-project', project: 'other', title: 'Other' });
  for (const project of ['p', 'other']) {
    const other = engine.discovery.forStage(project, 'concept', 'concept');
    const foreign = store.get<Question>(other.value.questions.at(-1)!)!;
    assert.throws(() => stageNeighbors(store, draft, foreign),
      error => (error as any).code === 'stage_neighbors_binding_invalid' && (error as Error).message.includes(foreign.id));
  }
});

test('ASM1 stale draft/question arguments fail with addresses; Discovery keeps its own existing context', t => {
  const { store, engine } = fixture(t);
  const draft = engine.discovery.forStage('p', 'concept', 'concept');
  const first = store.get<Question>(draft.value.questions[0]!)!;
  const chosen = store.get<Question>(draft.value.questions.at(-1)!)!;
  engine.discovery.decision(first.id, first.revision, 'owner', 'CLI users');
  assert.throws(() => stageNeighbors(store, draft, chosen),
    error => (error as any).code === 'stage_neighbors_binding_invalid' && (error as Error).message.includes(draft.id));
  engine.discovery.reopen(chosen.id, chosen.revision);
  assert.throws(() => stageNeighbors(store, store.get<DiscoveryDraft>(draft.id)!, chosen),
    error => (error as any).code === 'stage_neighbors_binding_invalid' && (error as Error).message.includes(chosen.id));
  const discovery = engine.discovery.forStage('p', 'discovery', 'discovery');
  assert.deepEqual(stageNeighbors(store, discovery, store.get<Question>(discovery.value.questions[0]!)!),
    { context: null, guards: [] });
});

test('ASM1 the same projection replays exact captured neighbors after native changes through another Store', t => {
  const { store, engine } = fixture(t);
  const draft = engine.discovery.forStage('p', 'concept', 'concept');
  const [first, , , chosen] = draft.value.questions.map(id => store.get<Question>(id)!);
  engine.discovery.decision(first!.id, first!.revision, 'owner', 'Original audience');
  const capturedDraft = store.get<DiscoveryDraft>(draft.id)!;
  const capture = assessmentReadView(store);
  const original = stageNeighbors(capture.store, capturedDraft, chosen!);
  const proof = capture.finish();
  const otherStore = new Store(store.path);
  try {
    const other = new ProductEngine(otherStore);
    const reopened = other.discovery.reopen(first!.id, otherStore.get(first!.id)!.revision);
    other.discovery.decision(reopened.id, reopened.revision, 'owner', 'Changed audience');
    const replay = assessmentReadView(otherStore, proof);
    assert.deepEqual(stageNeighbors(replay.store, capturedDraft, chosen!), original);
    assert.deepEqual(replay.finish(), proof);
    assert.equal(stageNeighbors(otherStore, otherStore.get<DiscoveryDraft>(draft.id)!, chosen!).context!.fields[0]!.value,
      'Changed audience');
  } finally { otherStore.close(); }
});
