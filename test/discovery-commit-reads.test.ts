import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Json } from '../src/canonical.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { discoveryOutcome, discoveryInspection } from '../src/discovery/discovery-outcome.js';
import { listQuestions } from '../src/discovery/projection-reader.js';
import { LEGACY_REQUIREMENTS, VERSION5_REQUIREMENTS, VERSION6_REQUIREMENTS } from '../src/discovery/requirements.js';
import { createPartialV7Draft } from '../src/discovery/v7-contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { StageChecks } from '../src/product/stage-checks.js';
import { reference } from '../src/pipeline/contracts.js';
import { Store, observeStore, storeReads, type Revision, type StoreReadMethod } from '../src/storage/store.js';
import { storeView } from '../src/storage/store-view.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-g4b-'));
  const store = new Store(join(root, 'state.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project: 'p', title: 'Discovery commit' });
  const source = engine.discovery.evidence.document('p', 'request', 'Exact local product scope', 'text/plain', 0);
  const question = (draft: Revision<DiscoveryDraft>, field: string) => draft.value.questions
    .map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field)!;
  const complete = (era: 5 | 6 = 6, verdict = 'go') => {
    let draft = engine.discovery.create('p', 'discovery', 'R0', 'concept',
      (era === 5 ? VERSION5_REQUIREMENTS : VERSION6_REQUIREMENTS).discovery, [], era);
    for (const id of draft.value.questions) {
      const q = store.get<Question>(id)!, field = q.value.spec.field;
      if (field === 'preparation' && verdict !== 'go') break;
      if (q.value.spec.kind === 'fact') engine.discovery.fact(id, q.revision, reference(source),
        { kind: 'text-range', start: 0, end: source.value.content.length });
      else if (['researchPlan', 'researchReport', 'verdict', 'preparation'].includes(field)) {
        const value = structuredClone(preparedField('p', field));
        if (field === 'verdict') {
          const answer = value as { outcome: string; conditions: Json[] };
          answer.outcome = verdict;
          if (verdict === 'conditional') answer.conditions = [{ id: 'scope', kind: 'owner_choice',
            condition: 'Choose a bounded scope', criterion: 'A new report validates the scope', options: [
              { optionId: 'accept', label: 'Accept', consequences: ['Reassess the scope'], choice: 'accept' },
              { optionId: 'decline', label: 'Decline', consequences: ['Research alternatives'], choice: 'decline' },
            ] }];
        }
        answerDiscoveryFixture(engine, 'p', store.get<DiscoveryDraft>(draft.id)!, q, value, source);
      } else engine.discovery.decision(id, q.revision, 'owner', preparedField('p', field));
    }
    draft = store.get<DiscoveryDraft>(draft.id)!;
    return draft;
  };
  const configure = () => {
    const adapter = join(root, 'adapter.mjs');
    writeFileSync(adapter, `import {readFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'Controlled next step'}}));`);
    const command = { executable: process.execPath, args: [adapter] };
    engine.environments.configure('p', { workspace: root,
      implementer: { actor: 'author', model: 'fixture', effort: 'medium', command },
      reviewer: { actor: 'assessor', model: 'fixture', effort: 'medium', command },
      fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000 }, 0);
  };
  return { root, store, engine, source, complete, question, configure };
}

for (const era of [5, 6] as const) test(`G4b v${era}: one full gate accompanies outcome and stage admission on a cold Store`, t => {
  const f = fixture(t), draft = f.complete(era);
  const cold = new Store(f.store.path); t.after(() => cold.close());
  const expected = new Discovery(cold).gate('p', reference(draft));
  assert.deepEqual(expected.findings, []);
  const gate = t.mock.method(Discovery.prototype, 'gate');
  const outcome = discoveryInspection(cold, draft);
  assert.equal(gate.mock.callCount(), 1);
  assert.equal(outcome.outcome.state, 'go'); assert.deepEqual(outcome.outcome.findings, []);
  assert.deepEqual(outcome.gate, expected);
  const stage = new StageChecks(cold).validateStage('discovery', { projectId: 'p', accepted: true, inputs: [],
    content: { draft: reference(draft), fields: draft.value.fields, graph: null } as unknown as Json });
  assert.equal(gate.mock.callCount(), 2, 'one gate in each independent operation, not two per operation');
  assert.deepEqual(stage.findings, []);
  for (const ref of expected.guards) assert.ok(stage.guards.some(row => row.id === ref.id && row.hash === ref.hash));
});

test('G4b stage checks the requested draft Ref even if a newer draft has identical fields', t => {
  const f = fixture(t), draft = f.complete();
  const second = new Store(f.store.path); t.after(() => second.close());
  second.write({ id: draft.id, kind: draft.kind, expected: draft.revision, value: draft.value });
  const gate = t.mock.method(Discovery.prototype, 'gate');
  const result = new StageChecks(f.store).validateStage('discovery', { projectId: 'p', inputs: [],
    content: { draft: reference(draft), fields: draft.value.fields, graph: null } as unknown as Json });
  assert.equal(gate.mock.callCount(), 1);
  assert.deepEqual(gate.mock.calls[0]!.arguments[1], reference(draft));
  assert.ok(result.findings.some(finding => finding.code === 'discovery_stale'));
});

for (const era of [5, 6] as const) test(`G4b v${era}: reopen keeps old fields but stops the accepted prefix; a new answer gets a new gate`, t => {
  const f = fixture(t), draft = f.complete(era), q = f.question(draft, 'objective');
  const old = discoveryInspection(f.store, draft);
  const reopened = f.engine.discovery.reopen(q.id, q.revision);
  assert.deepEqual(f.store.get<DiscoveryDraft>(draft.id)!.value.fields, draft.value.fields);
  const partial = discoveryInspection(f.store, draft);
  assert.equal(partial.outcome.state, 'researching'); assert.deepEqual(partial.outcome.findings, []);
  assert.ok(partial.gate.findings.some(finding => finding.code === 'question_unresolved' && finding.target === q.id));
  assert.deepEqual(old.gate.findings, [], 'a returned snapshot is not mutated by a later check');
  const changed = f.engine.discovery.decision(q.id, reopened.revision, 'owner', draft.value.fields.objective!);
  const next = discoveryInspection(f.store, changed);
  assert.equal(next.outcome.state, 'go'); assert.deepEqual(next.gate.findings, []);
  assert.ok(next.gate.guards.some(ref => ref.id === q.id && ref.revision === reopened.revision + 1));
  assert.notDeepEqual(next.gate.guards, old.gate.guards);
});

test('G4b legacy and partial v7 expose the full unresolved gate independently of business outcome', t => {
  const f = fixture(t);
  const drafts = [f.engine.discovery.create('p', 'discovery', 'R0', 'concept', LEGACY_REQUIREMENTS.discovery),
    createPartialV7Draft(f.engine.discovery, 'p', 'concept')];
  for (const draft of drafts) {
    const expected = f.engine.discovery.gate('p', reference(draft));
    const outcome = discoveryInspection(f.store, draft);
    assert.equal(outcome.outcome.state, 'legacy'); assert.deepEqual(outcome.outcome.findings, []);
    assert.deepEqual(outcome.gate, expected);
    assert.equal(outcome.gate.findings.length, draft.value.questions.length);
    assert.ok(outcome.gate.findings.every(row => row.code === 'question_unresolved'));
  }
});

test('G4b a new v7 accepted fact keeps the remaining questions unresolved on a cold Store without decoding the prefix', t => {
  const f = fixture(t), draft = createPartialV7Draft(f.engine.discovery, 'p', 'concept');
  const question = f.question(draft, 'brief');
  const accepted = f.engine.discovery.fact(question.id, question.revision, reference(f.source),
    { kind: 'text-range', start: 0, end: f.source.value.content.length });
  const cold = new Store(f.store.path); t.after(() => cold.close());
  const originalGet = Store.prototype.get;
  let oldBodies = 0;
  t.mock.method(Store.prototype, 'get', function (this: Store, id: string, revision?: number) {
    const row = originalGet.call(this, id, revision);
    if (row && ['question', 'fact', 'research-answer', 'research-assessment', 'discovery-acceptance-act'].includes(row.kind)) oldBodies++;
    return row;
  });
  const before = storeReads(), outcome = discoveryInspection(cold, accepted);
  assert.equal(storeReads() - before, 3);
  assert.equal(oldBodies, 0);
  assert.ok(outcome.gate.prefix);
  assert.equal(outcome.outcome.state, 'legacy'); assert.deepEqual(outcome.outcome.findings, []);
  assert.equal(outcome.gate.findings.length, 3);
  assert.ok(outcome.gate.findings.every(row => row.code === 'question_unresolved' && row.target !== question.id));
});

test('G4b runner continues researching, while a business refusal pauses and a complete draft finishes without a model call', async t => {
  const f = fixture(t); f.configure();
  const open = f.engine.discovery.create('p', 'discovery', 'R0', 'concept', VERSION6_REQUIREMENTS.discovery, [], 6);
  const gate = t.mock.method(Discovery.prototype, 'gate');
  const researching = await f.engine.researcher.run('p', open.id, 1);
  assert.equal(researching.value.status, 'paused'); assert.equal(researching.value.pauseCode, 'research_model_paused');
  assert.equal(f.store.list('model-call').length, 1, 'question_unresolved permits the controlled next action');
  assert.equal(gate.mock.callCount(), 2, 'one prologue gate, one gate for the newly claimed run step');
  const ready = f.complete();
  const done = await f.engine.researcher.run('p', ready.id, 1);
  assert.equal(done.value.status, 'completed'); assert.equal(f.store.list('model-call').length, 1);
  const count = gate.mock.callCount();
  const replay = await f.engine.researcher.run('p', ready.id, 1);
  assert.equal(replay.revision, done.revision);
  assert.equal(gate.mock.callCount() - count, 1, 'completed replay shares its admission with outcome');
  const refused = f.complete(6, 'no_go');
  const blocked = await f.engine.researcher.run('p', refused.id, 1);
  assert.equal(blocked.value.status, 'paused'); assert.equal(blocked.value.pauseCode, 'discovery_no_go');
  assert.equal(f.store.list('model-call').length, 1, 'a business refusal permits no new call');
});

test('G4b listQuestions reads only the literal project prefix, with a fixed budget despite 10x foreign history', t => {
  const f = fixture(t);
  f.engine.discovery.create('p', 'discovery', 'R0', 'concept', LEGACY_REQUIREMENTS.discovery);
  const wanted = f.store.list<Question>('question').filter(q => q.value.projectId === 'p');
  const measure = () => {
    const cold = new Store(f.store.path);
    try {
      const reads = storeReads(), values = listQuestions(cold, 'p');
      return { values, reads: storeReads() - reads };
    } finally { cold.close(); }
  };
  const baseline = measure();
  assert.deepEqual(baseline.values, wanted);
  assert.equal(baseline.reads, 1 + wanted.length, 'one indexed selection and one get per project question');
  const foreign = f.engine.discovery.create('p-other', 'discovery', 'R0', 'concept', LEGACY_REQUIREMENTS.discovery);
  for (let round = 0; round < 10; round++) for (const id of foreign.value.questions) {
    const q = f.store.get<Question>(id)!;
    f.store.write({ id, kind: q.kind, expected: q.revision, value: q.value });
  }
  const db = new DatabaseSync(f.store.path);
  try {
    db.exec('DROP TRIGGER revisions_no_update');
    db.prepare('UPDATE revisions SET body=? WHERE entity_id=?').run('null', foreign.value.questions[0]!);
  } finally { db.close(); }
  assert.deepEqual(measure(), baseline, 'foreign bodies are never decoded, even when corrupted');
  assert.deepEqual(listQuestions(f.store, 'absent'), []);
});

test('G4b question listing supports direct, nested and opaque views and preserves active PF4 observations', t => {
  const f = fixture(t);
  f.engine.discovery.create('p', 'discovery', 'R0', 'concept', LEGACY_REQUIREMENTS.discovery);
  f.engine.discovery.create('other', 'discovery', 'R0', 'concept', LEGACY_REQUIREMENTS.discovery);
  const expected = f.store.list<Question>('question').filter(q => q.value.projectId === 'p');
  const direct = storeView(f.store, { write: (writes, guards) => f.store.writeMany(writes, guards) });
  const nested = storeView(direct, { write: (writes, guards) => direct.writeMany(writes, guards) });
  const opaque = storeView(f.store, { get: () => undefined, write: (writes, guards) => f.store.writeMany(writes, guards) });
  for (const view of [f.store, direct, nested, opaque]) {
    assert.deepEqual(listQuestions(view, 'p'), expected);
    assert.deepEqual(listQuestions(view, 'absent'), []);
    const methods: StoreReadMethod[] = [];
    const previous = observeStore({ begin: store => store === f.store ? {} : undefined,
      end: (_token, _store, method) => { methods.push(method); }, write: () => assert.fail('listing wrote'), untraced: () => {} });
    try {
      assert.deepEqual(listQuestions(view, 'p'), expected);
      assert.deepEqual(methods, ['list'], 'active PF4 observes the original list rather than an unwrapped index');
    } finally { observeStore(previous); }
  }
  // An opaque list projection is the view's truth, even when it exposes an identities method.
  const projected = new Proxy(f.store, { get(target, key) {
    if (key === 'list') return () => expected.slice(1);
    if (key === 'identities') return () => assert.fail('opaque view used the physical index');
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.deepEqual(listQuestions(projected, 'p'), expected.slice(1));
});

for (const state of ['legacy', 'researching', 'go', 'no_go', 'conditional', 'insufficient_evidence'] as const)
test(`G4b ${state}: public outcome never carries the internal gate or prefix`, t => {
  const f = fixture(t);
  const draft = state === 'legacy'
    ? f.engine.discovery.create('p', 'discovery', 'R0', 'concept', LEGACY_REQUIREMENTS.discovery)
    : state === 'researching'
      ? f.engine.discovery.create('p', 'discovery', 'R0', 'concept', VERSION6_REQUIREMENTS.discovery, [], 6)
      : f.complete(6, state);
  const inspected = discoveryInspection(f.store, draft), outcome = discoveryOutcome(f.store, draft);
  assert.equal(outcome.state, state);
  assert.deepEqual(outcome, inspected.outcome);
  assert.deepEqual(Object.keys(outcome).sort(), ['state', 'verdict', 'report', 'conditions', 'ownerChoices', 'reason', 'guards', 'findings'].sort());
  assert.equal('gate' in outcome, false); assert.equal('prefix' in outcome, false);
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), outcome);
  const { guards: _guards, findings: _findings, ...publicResult } = outcome;
  assert.deepEqual(Object.keys(publicResult).sort(), ['state', 'verdict', 'report', 'conditions', 'ownerChoices', 'reason'].sort());
  assert.ok(inspected.gate);
});

for (const era of [5, 6] as const) test(`G4b v${era}: committed outcome is three Store reads and zero old answer bodies on cold/10x-history stores`, t => {
  const f = fixture(t), draft = f.complete(era);
  const originalGet = Store.prototype.get;
  let oldBodies = 0;
  t.mock.method(Store.prototype, 'get', function (this: Store, id: string, revision?: number) {
    const row = originalGet.call(this, id, revision);
    if (row && ['question', 'research-answer', 'decision', 'fact', 'design', 'research-assessment'].includes(row.kind)) oldBodies++;
    return row;
  });
  const measure = () => {
    const cold = new Store(f.store.path);
    try {
      const before = storeReads(); oldBodies = 0;
      const result = discoveryInspection(cold, draft);
      return { result, reads: storeReads() - before, oldBodies };
    } finally { cold.close(); }
  };
  const first = measure();
  assert.ok(first.result.gate.prefix, 'real producer closure, never a fabricated GateResult');
  assert.equal(first.result.outcome.state, 'go'); assert.deepEqual(first.result.gate.findings, []);
  assert.equal(first.reads, 3, 'draft + closure + one chunk of head comparisons');
  assert.equal(first.oldBodies, 0, 'no decoding of prior questions, answers, or assessments');
  for (let i = 0; i < 10; i++) {
    const foreign = f.engine.discovery.create(`other-${i}`, 'discovery', 'R0', 'concept', LEGACY_REQUIREMENTS.discovery);
    for (const id of foreign.value.questions) {
      const q = f.store.get<Question>(id)!;
      for (let revision = q.revision; revision < q.revision + 10; revision++)
        f.store.write({ id, kind: q.kind, expected: revision, value: q.value });
    }
  }
  assert.deepEqual(measure(), first, 'history and other projects do not increase accepted-prefix reads');
});

test('G4b legacy record without closure retains the full reader; an invalid closure is not a successful outcome', t => {
  const f = fixture(t), draft = f.complete();
  // A revision issued without a closure keeps the historical full path, including strict accepted-pair checks.
  const legacy = f.store.write<DiscoveryDraft>({ id: draft.id, kind: draft.kind, expected: draft.revision, value: draft.value });
  const result = discoveryInspection(f.store, legacy);
  assert.equal(result.gate.prefix, undefined); assert.equal(result.outcome.state, 'go');
  f.store.write({ id: `discovery-prefix-closure:${legacy.id}:${legacy.revision}`, kind: 'discovery-prefix-closure', expected: 0,
    value: { contract: 'discovery-prefix-closure/v999' } });
  assert.throws(() => discoveryInspection(f.store, legacy), { code: 'discovery_prefix_closure_invalid' });
});

test('G4b a file source changing without Store writes is still checked on every new outcome', t => {
  const f = fixture(t), file = join(f.root, 'brief.txt'); writeFileSync(file, 'Original exact local scope');
  const source = f.engine.discovery.evidence.file('p', 'file-brief', f.root, 'brief.txt', 'text/plain', 0);
  let draft = f.engine.discovery.create('p', 'discovery', 'R0', 'concept', LEGACY_REQUIREMENTS.discovery);
  for (const id of draft.value.questions) {
    const q = f.store.get<Question>(id)!;
    if (q.value.spec.kind === 'fact') f.engine.discovery.fact(q.id, q.revision, reference(source),
      { kind: 'text-range', start: 0, end: source.value.content.length });
    else f.engine.discovery.decision(q.id, q.revision, 'owner', preparedField('p', q.value.spec.field));
  }
  draft = f.store.get<DiscoveryDraft>(draft.id)!;
  const before = discoveryInspection(f.store, draft);
  assert.deepEqual(before.gate.findings, []);
  const stamp = f.store.changeStamp(); writeFileSync(file, 'Changed exact local scope');
  assert.equal(f.store.changeStamp(), stamp);
  const after = discoveryInspection(f.store, draft);
  assert.ok(after.gate.findings.some(row => row.code === 'evidence_stale'));
  assert.deepEqual(before.gate.findings, [], 'no cross-call memo hides filesystem changes');
});

test('G4b question listing keeps the selected revisions if a second Store writes between prefix selection and body reads', t => {
  const f = fixture(t), draft = f.engine.discovery.create('p', 'discovery', 'R0', 'concept', LEGACY_REQUIREMENTS.discovery);
  const before = listQuestions(f.store, 'p'), target = before[0]!;
  const writer = new Store(f.store.path); t.after(() => writer.close());
  const original = Store.prototype.identities;
  let moved = false;
  t.mock.method(Store.prototype, 'identities', function (this: Store, ...args: Parameters<typeof original>) {
    const found = original.apply(this, args);
    if (!moved && this === f.store && args[0] === 'prefix' && args[1] === 'question:p:') {
      moved = true;
      writer.write({ id: target.id, kind: target.kind, expected: target.revision,
        value: { ...target.value, beforeHash: 'f'.repeat(64) } });
    }
    return found;
  });
  assert.deepEqual(listQuestions(f.store, 'p'), before);
  assert.equal(moved, true); assert.equal(f.store.get(target.id)!.revision, target.revision + 1);
  assert.equal(draft.value.questions.length, before.length);
});

test('G4b runner checks the newly accepted answer at exhaustion instead of reusing its unresolved admission', async t => {
  const f = fixture(t); f.configure();
  const draft = f.complete(), preparation = f.question(draft, 'preparation');
  f.engine.discovery.reopen(preparation.id, preparation.revision);
  const pending = discoveryInspection(f.store, draft);
  assert.equal(pending.outcome.state, 'go'); assert.ok(pending.gate.findings.some(row => row.code === 'question_unresolved'));
  writeFileSync(join(f.root, 'adapter.mjs'), `import {readFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));
const research=r.subject.role==='assess-answer'?{verdict:'supported',reasons:[]}:
 {action:'answer',question:${JSON.stringify(preparation.id)},value:${JSON.stringify(draft.value.fields.preparation)},
  citations:[{source:${JSON.stringify(reference(f.source))},selector:{kind:'text-range',start:0,end:${f.source.value.content.length}}}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research}));`);
  const gate = t.mock.method(Discovery.prototype, 'gate');
  const run = await f.engine.researcher.run('p', draft.id, 1);
  assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
  const accepted = f.store.get<DiscoveryDraft>(draft.id)!;
  assert.ok(accepted.revision > draft.revision);
  const last = gate.mock.calls.at(-1)!;
  assert.deepEqual(last.arguments[1], reference(accepted), 'the final gate was recomputed after acceptance');
  assert.deepEqual(last.result!.findings, []);
  assert.equal(f.store.list('model-call').length, 2, 'exactly one analyst and one assessor');
  const calls = gate.mock.callCount();
  const replay = await f.engine.researcher.run('p', draft.id, 1);
  assert.equal(replay.revision, run.revision); assert.equal(f.store.list('model-call').length, 2);
  assert.equal(gate.mock.callCount() - calls, 1);
});
