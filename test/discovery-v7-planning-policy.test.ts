import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../src/canonical.js';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference } from '../src/pipeline/contracts.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from '../src/discovery/v7-managed-attempt.js';
import { configureReaderPilot, prepareReaderPilot, readerPilot, type ReaderPilotSettings,
  type V7PlanningSettings } from '../src/discovery/reader-pilot.js';
import { planningForPlanSubject, planningForQuestion } from '../src/discovery/research-routing.js';
import { layerDesignSpec, LAYER_DESIGN_VERSION } from '../src/graph/layer-design.js';
import type { Graph } from '../src/graph/model.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { createOmFixture } from './om-fixture.js';

const planning: V7PlanningSettings = { contract: 'v7-plan-planning/v1', maxRequestChars: 17321, maxRounds: 4 };
const policy = { discovery: 7 } as const;
const command = { executable: process.execPath, args: ['--version'] };
const settings: ReaderPilotSettings = {
  experimental: true, active: true, stopAfter: 'L2',
  reader: { actor: 'reader', model: 'fixture-reader', effort: 'high', speed: 'fast', command },
  agentCommand: command, maxRequestChars: 100000, maxReadChars: 20000, maxReplyChars: 10000,
  maxCalls: 20, maxReportedTokens: 100000,
  planning: { fields: ['plan'], maxRequestChars: 71234, maxRounds: 9 },
};

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-v7-planning-')), path = join(root, 'state.sqlite');
  const stores: Store[] = [], open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  function project(id: string) {
    engine.execute({ type: 'create-project', project: id, title: id });
    engine.environments.configure(id, { workspace: root,
      implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 1000 }, 0);
  }
  function accept(id: string) {
    project(id);
    const draft = createPartialV7Draft(engine.discovery, id, 'concept');
    const source = engine.discovery.evidence.document(id, 'basis', 'The exact basis for this test plan', 'text/plain', 0);
    const question = (field: string) => draft.value.questions.map(q => store.get<Question>(q)!).find(q => q.value.spec.field === field)!;
    answerDiscoveryFixture(engine, id, draft, question('frame'), {
      productType: 'internal', scale: '30 users across 10 sites', industries: ['construction'], domains: ['supply'],
      axes: Object.fromEntries(V7_AXES.map(axis => [axis, { depth: 'deep' }])),
      budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 },
    }, source);
    const frame = question('frame').value.answer!;
    const questions = ['a', 'b'].map((key, index) => ({ id: key, axis: index ? 'market' : 'industry', domain: 'construction',
      text: `What proves ${key}?`, class: index ? 'supporting' : 'blocking', criterion: 'An exact document',
      requiredDepth: 'deep', roles: ['domain expert'], searchPlaces: ['domain documents'] }));
    answerDiscoveryFixture(engine, id, store.get<DiscoveryDraft>(draft.id)!, question('plan'),
      { edition: 1, previous: null, frame, questions } as unknown as Json, source);
    const anchor = question('plan');
    const subject = (key = 'a'): V7PlanSubject => ({ contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: anchor.value.answer!, planQuestionId: key });
    return { draft: store.get<DiscoveryDraft>(draft.id)!, anchor, frame, questions, source, subject };
  }
  const v = accept('p');
  const configure = (value: unknown = { ...settings, v7Planning: planning }) => configureReaderPilot(store, engine.environments, 'p', value,
    store.get('reader-pilot:p')?.revision ?? 0);
  const select = (subject = v.subject(), producerPolicy: { discovery?: number } | undefined = policy, db = store, draft = reference(v.draft)) =>
    planningForPlanSubject(db, 'p', draft, subject, producerPolicy);
  const history = () => store.list().flatMap(record => store.history(record.id));
  return { root, store, engine, open, project, accept, v, configure, select, history };
}

test('S3-route: exact accepted plan subjects select only their explicit v7 limits without writes or payment', t => {
  const f = fixture(t), pilot = f.configure(), before = f.history();
  assert.equal(f.v.anchor.value.status, 'answered');
  for (const key of ['a', 'b']) assert.deepEqual(f.select(f.v.subject(key)), planning);
  const result = f.select()!; result.maxRounds = 999;
  assert.deepEqual(f.select(f.v.subject(), policy, f.open()), planning);
  assert.deepEqual(f.store.get(pilot.id), pilot);
  assert.equal(planningForQuestion(f.store, f.v.draft, f.v.anchor, pilot), null);
  assert.deepEqual(f.history(), before);
});

test('S3-route: missing settings, inactive pilot and absent v7 policy leave analyst; fields plan never opts v7 in', t => {
  const f = fixture(t);
  assert.equal(f.select(), null);
  const old = f.configure(settings);
  assert.equal(f.select(), null);
  assert.equal(planningForQuestion(f.store, f.v.draft, f.v.anchor, old), null);
  f.configure();
  for (const p of [undefined, {}, { discovery: 6 }, { discovery: 8 }, Object.create({ discovery: 7 })])
    assert.equal(planningForPlanSubject(f.store, 'p', reference(f.v.draft), f.v.subject(), p), null);
  f.configure({ ...settings, active: false, v7Planning: planning });
  assert.equal(f.select(), null);
});

const invalidSettings: unknown[] = [undefined, null, false, [], {},
  { ...planning, contract: 'v7-plan-planning/v2' },
  { maxRequestChars: 1, maxRounds: 1 }, { contract: planning.contract, maxRounds: 1 },
  { contract: planning.contract, maxRequestChars: 1 }, { ...planning, fields: ['plan'] },
  ...[0, -1, 1.5, '12', null, Infinity, NaN].flatMap(value =>
    [{ ...planning, maxRequestChars: value }, { ...planning, maxRounds: value }])];
test('S3-route: malformed explicit settings refuse during preparation with no partial pilot write', t => {
  const f = fixture(t), before = f.history();
  for (const value of invalidSettings) assert.throws(() => prepareReaderPilot(f.store, f.engine.environments,
    'p', { ...settings, v7Planning: value }, 0), { code: 'reader_pilot_invalid' }, String(value));
  assert.deepEqual(f.history(), before);
});

test('S3-route: corrupted saved settings refuse on cold reads and cannot masquerade as inactive or disabled', t => {
  const f = fixture(t); f.configure();
  for (const value of [null, {}, { ...planning, maxRounds: 0 }, { ...planning, contract: 'foreign' }]) {
    const previous = f.store.get<any>('reader-pilot:p')!;
    f.store.write({ id: previous.id, kind: previous.kind, expected: previous.revision,
      value: { ...previous.value, active: false, v7Planning: value } });
    const cold = f.open(), before = f.history();
    assert.throws(() => readerPilot(cold, 'p'), { code: 'reader_pilot_invalid' });
    assert.throws(() => planningForPlanSubject(cold, 'p', reference(f.v.draft), f.v.subject()), { code: 'reader_pilot_invalid' });
    assert.deepEqual(f.history(), before);
  }
});

test('S3-route: foreign, missing and substituted plan subjects cannot choose planning', t => {
  const f = fixture(t), other = f.accept('other'); f.configure();
  const subject = f.v.subject(), before = f.history();
  for (const bad of [null, undefined, {}, [], { ...subject, contract: 'unknown' },
    { ...subject, extra: true }, { ...subject, planQuestionId: 'missing' },
    { ...subject, planAnswer: { ...subject.planAnswer, hash: '0'.repeat(64) } },
    { ...subject, planAnswer: { ...subject.planAnswer, revision: 99 } },
    { ...subject, planAnswer: f.v.frame }, other.subject()]) {
    assert.throws(() => planningForPlanSubject(f.store, 'p', reference(f.v.draft), bad as V7PlanSubject, policy),
      { code: 'research_plan_subject_invalid' });
  }
  for (const draft of [reference(other.draft), { ...reference(f.v.draft), hash: '0'.repeat(64) },
    { ...reference(f.v.draft), revision: f.v.draft.revision + 1 }, { id: 'missing', revision: 1, hash: '0'.repeat(64) }])
    assert.throws(() => f.select(subject, policy, f.store, draft), { code: 'research_plan_subject_invalid' });
  assert.deepEqual(f.history(), before);
});

test('S3-route: an answer-shaped record without the real acceptance chain cannot select a subject', t => {
  const f = fixture(t); f.configure();
  const answer = f.store.get<any>(f.v.subject().planAnswer.id)!;
  const forged = f.store.write({ id: 'research-answer:forged-plan', kind: answer.kind, expected: 0, value: answer.value });
  const anchor = f.store.get<Question>(f.v.anchor.id)!;
  f.store.write({ id: anchor.id, kind: anchor.kind, expected: anchor.revision, value: { ...anchor.value, answer: reference(forged) } });
  assert.throws(() => f.select({ ...f.v.subject(), planAnswer: reference(forged) }), { code: 'research_plan_subject_invalid' });
});

test('S3-route: new selection refuses a reopened or superseded plan while the next accepted edition works', t => {
  const f = fixture(t); f.configure();
  f.engine.discovery.reopen(f.v.anchor.id, f.v.anchor.revision);
  const reopened = f.store.get<Question>(f.v.anchor.id)!;
  assert.throws(() => f.select(), { code: 'research_plan_subject_invalid' });
  answerDiscoveryFixture(f.engine, 'p', f.store.get<DiscoveryDraft>(f.v.draft.id)!, reopened,
    { edition: 2, previous: f.v.subject().planAnswer, frame: f.v.frame, questions: f.v.questions } as unknown as Json, f.v.source);
  const draft = reference(f.store.get(f.v.draft.id)!), subject = { ...f.v.subject(), planAnswer: f.store.get<Question>(f.v.anchor.id)!.value.answer! };
  assert.throws(() => f.select(f.v.subject(), policy, f.store, draft), { code: 'research_plan_subject_invalid' });
  assert.throws(() => f.select(subject), { code: 'research_plan_subject_invalid' });
  assert.deepEqual(f.select(subject, policy, f.store, draft), planning);
});

test('S3-route: v6 field routing retains its settings and ignores the v7 opt-in', t => {
  const f = fixture(t), draft = f.engine.discovery.create('p', 'discovery', 'R0', 'concept', [
    { field: 'plan', kind: 'fact', prompt: 'A field question', risk: 'Missing context', schema: { type: 'string' } },
    { field: 'other', kind: 'fact', prompt: 'Another field', risk: 'Missing context', schema: { type: 'string' } },
  ], [], 6), [question, other] = draft.value.questions.map(id => f.store.get<Question>(id)!);
  const old = f.configure(settings), configured = f.configure();
  assert.deepEqual(planningForQuestion(f.store, draft, question!, configured), planningForQuestion(f.store, draft, question!, old));
  assert.deepEqual(planningForQuestion(f.store, draft, question!, configured), settings.planning);
  assert.equal(planningForQuestion(f.store, draft, other!, configured), null);
  const { planning: _old, ...onlyV7 } = settings;
  assert.equal(planningForQuestion(f.store, draft, question!, f.configure({ ...onlyV7, v7Planning: planning })), null);
  assert.throws(() => planningForPlanSubject(f.store, 'p', reference(draft), f.v.subject(), policy), { code: 'research_plan_subject_invalid' });
});

test('S3-route: current OM R2 layer-design routing retains its generated contract and original planning limits', async t => {
  const f = await createOmFixture(t, 'standard', 'garden', { mode: 'n2' });
  const consumer = f.store.get<Graph>('graph:garden')!.value.nodes.find(n => n.kind === 'product')!.id;
  const draft = f.engine.discovery.create('garden', 'om-g2', 'R2', consumer, [layerDesignSpec(3)], [], LAYER_DESIGN_VERSION);
  const question = f.store.get<Question>(draft.value.questions[0]!)!;
  const old = configureReaderPilot(f.store, f.engine.environments, 'garden', settings, 0);
  const configured = configureReaderPilot(f.store, f.engine.environments, 'garden', { ...settings, v7Planning: planning }, old.revision);
  assert.deepEqual(planningForQuestion(f.store, draft, question, configured), settings.planning);
  assert.deepEqual(planningForQuestion(f.store, draft, question, configured), planningForQuestion(f.store, draft, question, old));
  assert.throws(() => planningForQuestion(f.store, draft, { ...question, value: { ...question.value,
    spec: { ...question.value.spec, prompt: 'forged' } } }, configured), { code: 'research_contract_mismatch' });
  const { planning: _old, ...onlyV7 } = settings;
  const missing = configureReaderPilot(f.store, f.engine.environments, 'garden', { ...onlyV7, v7Planning: planning }, configured.revision);
  assert.throws(() => planningForQuestion(f.store, draft, question, missing), { code: 'planning_settings_missing' });
});


test('S3-route: damaged saved draft membership and physical plan address refuse with a typed error', t => {
  const f = fixture(t); f.configure();
  const original = f.store.get<DiscoveryDraft>(f.v.draft.id)!;
  const damaged = f.store.write({ id: original.id, kind: original.kind, expected: original.revision,
    value: { ...original.value, questions: null } });
  assert.throws(() => f.select(f.v.subject(), policy, f.store, reference(damaged)), { code: 'research_plan_subject_invalid' });
  const restored = f.store.write({ id: original.id, kind: original.kind, expected: damaged.revision, value: original.value });
  for (const value of [null, { ...f.v.anchor.value, spec: null }, { ...f.v.anchor.value, answer: {} }]) {
    const head = f.store.get(f.v.anchor.id)!;
    f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value });
    assert.throws(() => f.select(f.v.subject(), policy, f.store, reference(restored)), { code: 'research_plan_subject_invalid' });
  }
});
