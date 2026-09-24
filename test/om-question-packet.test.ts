import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import type { Graph, Node } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Write } from '../src/storage/store.js';
import { writeOmInput } from '../src/om/input.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { readAnswerTask, readMc1Question, writeAcceptedAnswer, readAcceptedAnswer, type AnswerTaskBasis } from '../src/om/accepted-answer.js';
import { confirmResults } from '../src/om/achievements.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest, type GapRecord } from '../src/om/gaps.js';
import { gapLineKey, gapLineExpectedResult } from '../src/om/gap-lines.js';
import type { OmResult, Refusal } from '../src/om/refusal.js';
import { prepareRoutes, readRoutes, writeRoutes, type RoutesRequest } from '../src/om/routes.js';
import { prepareQuestionTasks, writeQuestionTasks, prepareQuestionPacket, writeQuestionPacket, readQuestionPacket,
  preparePartResult, readPartResult, partResponseId, type PartResponseRecord,
  normalizePartAnswer, readPacketAnswer, derivePartProposal, packetAnswerSchema, PACKET_ANSWER_PROTOCOL, PART_PROPOSAL_SCHEMA, type QuestionTaskRequest, type QuestionPacketRequest, type QuestionPacketRecord } from '../src/om/question-packet.js';
import { openSeries, beginAttempt, completeAttempt, type AttemptGoal } from '../src/om/series.js';
import { recordCall, settleCall, type CallPurpose, type RecordCallRequest } from '../src/om/call-record.js';
import { recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND } from '../src/om/refusal-journal.js';
import { prepareFrameProposals, type LayerProposal } from '../src/om/frame-proposals.js';
import type { FrameObligation } from '../src/om/frame-obligations.js';
import { writeGuarded } from '../src/om/refs.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures, refinedLayers } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { answerTechnicalFixture } from './technical-research-fixture.js';
import { answerLayerFixture } from './layer-design-fixture.js';

const clone = structuredClone;
const snapshot = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
const ordered = <T>(values: readonly T[]) => [...values].sort((a, b) => canonical(a).localeCompare(canonical(b)));
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function rejected(result: OmResult<unknown>, code: string): Refusal {
  if (result.ok) assert.fail(`Expected ${code}, received a prepared question task`);
  assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target);
  assert.ok(result.refusal.at.field || result.refusal.at.ref);
  return result.refusal;
}
function malformed(error: unknown): boolean {
  assert.ok(error instanceof EngineError);
  assert.equal(error.code, 'question_packet_request_invalid');
  const details = error.details as { target?: unknown; field?: unknown } | null;
  assert.ok(details?.target && details.field);
  return true;
}
function frozen(value: unknown): boolean {
  return value === null || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(frozen);
}

function questionFixture(t: TestContext, desiredGraph = gardenGraph(), addressOwner = true, commonFactConsumer = false) {
  const root = mkdtempSync(join(tmpdir(), 'omg-question-packet-')), database = join(root, 'state.sqlite');
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = 'garden';
  const descriptors = [
    { id: 'output-format', consumer: commonFactConsumer ? 'garden-consume-block' : 'garden-produce-block', kind: 'repository-fact' },
    { id: 'encoding', consumer: 'garden-consume-block', kind: 'repository-fact' },
    { id: 'later-format', consumer: 'garden-later-block', kind: 'repository-fact' },
    { id: 'approval-owner', consumer: 'garden-produce-block', kind: 'owner-decision' },
  ] as const;
  const { level: _level, ...l1 } = projectGraph(desiredGraph, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = descriptors.map(item => ({
      id: item.id, question: `What is the supported ${item.id}?`, consumer: item.consumer,
      blocksCurrentStage: false, resolution: 'Resolve the addressed question during OM',
    }));
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: descriptors.filter(item => addressOwner || item.kind !== 'owner-decision').map(item => ({ pending: clone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: `discovery:${item.id}`, field: 'address', value: { consumer: item.consumer, kind: item.kind } } })) as Write })) }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: 'question-packet-fixture', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(store, sources));
  const active = gaps.records.filter(row => row.value.gap.kind === 'repository-fact' && row.value.gap.code !== 'inventory_missing' && !row.value.gap.deferral);
  assert.deepEqual(active.map(row => row.value.gap.target).sort(), ['discovery:encoding', 'discovery:output-format']);
  assert.ok(gaps.records.find(row => row.value.gap.target === 'discovery:later-format')!.value.gap.deferral);
  const request: QuestionTaskRequest = { project, gaps: { sources, records: gaps.records.map(reference) },
    questions: active.map(gap => ({ gap: reference(gap), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) };
  return { root, database, project, stages, input, graph, horizon, gaps, active, request,
    get store() { return store; }, get engine() { return engine; },
    restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); } };
}

test('E2 prepares every active fact task from D3 and D1 before D4 chooses routes or native MC1 is issued', t => {
  const f = questionFixture(t), before = snapshot(f.store), native = f.store.list('question').map(reference);
  const prepared = ok(prepareQuestionTasks(f.store, f.request));
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(prepared.tasks.length, 2);
  assert.equal(prepared.writes.length, 2);
  assert.ok(prepared.writes.every(write => write.kind === 'answer-task'));
  assert.ok(frozen(prepared));
  assert.equal(new Set(prepared.guards.map(canonical)).size, prepared.guards.length);
  assert.equal(new Set(prepared.references.map(canonical)).size, prepared.references.length);
  for (const task of prepared.tasks) {
    const gap = f.active.find(row => row.value.gap.id === task.gap.id)!;
    assert.ok(gap);
    assert.equal(task.contract.establishes, f.input.value.input.questions.find(question => question.id === gap.value.gap.target)!.question);
    assert.deepEqual(task.contract.consumer, { blocks: gap.value.gap.consumers });
    assert.deepEqual(task.contract.requirements, [f.input.value.input.contracts[0]]);
    assert.deepEqual(task.contract.resultForm, { type: 'string' });
    assert.deepEqual(task.request.input, reference(f.input));
    assert.deepEqual(ordered(task.request.gaps.records), ordered(f.request.gaps.records));
    assert.ok(prepared.references.some(ref => canonical(ref) === canonical(reference(task.record))));
    assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(gap))));
    assert.equal(f.store.get(task.record.id), null);
  }
  const tasks: AnswerTaskBasis[] = prepared.tasks.map(task => ({ pending: clone(task.writes[0]!) as Write }));
  const routeRequest: RoutesRequest = { project: f.project, gaps: f.request.gaps, tasks, catalog: { paths: [], records: [] }, previous: null };
  const routes = ok(prepareRoutes(f.store, routeRequest));
  assert.deepEqual(snapshot(f.store), before);
  assert.deepEqual(ordered(routes.writes.filter(write => write.kind === 'answer-task').map(write => write.id)), ordered(prepared.tasks.map(task => task.record.id)));
  assert.equal(new Set(routes.writes.map(write => write.id)).size, routes.writes.length);
  ok(writeGuarded(f.store, { unit: 'E2-test', target: routes.record.id, writes: routes.writes, guards: routes.guards }));
  const saved = ok(readRoutes(f.store, { project: f.project, record: reference(routes.record) })).record;
  for (const task of prepared.tasks) {
    assert.deepEqual(ok(readAnswerTask(f.store, { project: f.project, record: reference(task.record) })).record, task.record);
    const route = saved.value.routes.find(route => route.gap === task.gap.id)!;
    assert.equal(route.route, 'research'); assert.equal(route.state, 'pending'); assert.equal(route.answer, null);
    assert.deepEqual(route.task, reference(task.record));
  }
  assert.equal(saved.value.routes.find(route => route.target === 'repo-inventory')!.task, null);
  assert.equal(saved.value.routes.find(route => route.target === 'discovery:later-format')!.state, 'deferred');
  assert.deepEqual(f.store.list('question').map(reference), native);
  assert.deepEqual(f.store.list('mc1-question'), []);
});

test('E2 task preparation is deterministic, sealed and idempotent; D5 history survives source drift and restart', t => {
  const f = questionFixture(t), original = clone(f.request);
  const prepared = ok(prepareQuestionTasks(f.store, f.request));
  const reversed = clone(f.request); reversed.questions.reverse(); reversed.gaps.records.reverse();
  assert.deepEqual(ok(prepareQuestionTasks(f.store, reversed)), prepared);
  const saved = ok(writeQuestionTasks(f.store, f.request));
  assert.deepEqual(saved.tasks.map(task => task.record), prepared.tasks.map(task => task.record));
  for (const task of saved.tasks) assert.deepEqual(f.store.get(task.record.id), task.record);
  const after = snapshot(f.store), repeated = ok(writeQuestionTasks(f.store, reversed));
  assert.deepEqual(repeated.tasks.map(task => task.record), saved.tasks.map(task => task.record));
  assert.deepEqual(repeated.writes, []);
  assert.deepEqual(ok(prepareQuestionTasks(f.store, original)).writes, []);
  assert.deepEqual(snapshot(f.store), after);
  for (const task of repeated.tasks) assert.ok(repeated.guards.some(ref => canonical(ref) === canonical(reference(task.record))));
  const history = saved.tasks.map(task => ok(readAnswerTask(f.store, { project: f.project, record: reference(task.record) })));
  f.request.questions[0]!.requirements[0]!.pointer = '/missing';
  (f.request.questions[0]!.resultForm as Record<string, Json>).description = 'caller mutation';
  f.request.gaps.records.pop();
  assert.deepEqual(prepared.tasks.map(task => task.record), saved.tasks.map(task => task.record));
  const source = f.store.get(`source:${f.project}:brief`)!;
  f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  const stale = snapshot(f.store);
  rejected(prepareQuestionTasks(f.store, original), 'stage_not_accepted');
  rejected(writeQuestionTasks(f.store, original), 'stage_not_accepted');
  f.restart();
  for (const item of history) assert.deepEqual(ok(readAnswerTask(f.store, { project: f.project, record: reference(item.record) })), item);
  assert.deepEqual(snapshot(f.store), stale);
});

test('E2 requires exact descriptor coverage and cannot turn inventory, deferred or non-fact gaps into answer tasks', t => {
  const f = questionFixture(t), before = snapshot(f.store), descriptor = f.request.questions[0]!;
  const excluded = f.gaps.records.filter(row => row.value.gap.code === 'inventory_missing' || row.value.gap.deferral
    || row.value.gap.target === 'discovery:approval-owner');
  assert.equal(excluded.length, 3);
  const invalid: QuestionTaskRequest[] = [
    { ...f.request, questions: [] },
    { ...f.request, questions: f.request.questions.slice(1) },
    { ...f.request, questions: [...f.request.questions, clone(descriptor)] },
    ...excluded.map(gap => ({ ...f.request, questions: [...f.request.questions, { ...descriptor, gap: reference(gap) }] })),
    { ...f.request, questions: [{ ...descriptor, gap: { ...descriptor.gap, hash: '0'.repeat(64) } }, ...f.request.questions.slice(1)] },
  ];
  for (const request of invalid) for (const action of [prepareQuestionTasks, writeQuestionTasks]) rejected(action(f.store, request), 'packet_task_set_invalid');
  assert.deepEqual(snapshot(f.store), before);
});

test('E2 rejects missing producer fields and malformed task envelopes before any store I/O', t => {
  const f = questionFixture(t), before = snapshot(f.store);
  const noIo = new Proxy(f.store, { get(target, property) {
    if (['get', 'list', 'history', 'write', 'writeMany'].includes(String(property))) return () => assert.fail('Malformed E2 request reached storage');
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const bad: unknown[] = [undefined, null, [], 'request'];
  for (const field of ['project', 'gaps', 'questions']) { const request = clone(f.request) as unknown as Record<string, unknown>; delete request[field]; bad.push(request); }
  for (const field of ['gap', 'requirements', 'resultForm']) {
    const request = clone(f.request) as unknown as { questions: Record<string, unknown>[] }; delete request.questions[0]![field]; bad.push(request);
  }
  for (const gaps of [null, [], {}, { sources: null, records: [] }, { sources: f.request.gaps.sources },
    { sources: f.request.gaps.sources, records: null }, { sources: f.request.gaps.sources, records: [{}] }]) bad.push({ ...f.request, gaps });
  for (const patch of [
    { gap: null }, { gap: { id: 'gap' } }, { requirements: null }, { requirements: [{}] }, { requirements: [{ pointer: 1 }] },
    { resultForm: undefined }, { resultForm: { type: 'string', invalid: undefined } },
  ]) bad.push({ ...f.request, questions: [{ ...f.request.questions[0], ...patch }, ...f.request.questions.slice(1)] });
  bad.push({ ...f.request, project: '' }, { ...f.request, questions: null }, { ...f.request, questions: [null] });
  for (const action of [prepareQuestionTasks, writeQuestionTasks]) {
    assert.throws(() => action(undefined as unknown as Store, f.request), malformed);
    for (const request of bad) assert.throws(() => action(noIo, request as QuestionTaskRequest), malformed);
  }
  assert.deepEqual(snapshot(f.store), before);
});

test('E2 preserves D1 and D5 refusals for incomplete sources, forged records and impossible producer contracts', t => {
  const f = questionFixture(t), before = snapshot(f.store), victim = f.active[0]!;
  for (const action of [prepareQuestionTasks, writeQuestionTasks]) {
    rejected(action(f.store, { ...f.request, gaps: { ...f.request.gaps, records: f.request.gaps.records.slice(1) } }), 'gap_missing');
    rejected(action(f.store, { ...f.request, gaps: { ...f.request.gaps, records: [...f.request.gaps.records, f.request.gaps.records[0]!] } }), 'gap_duplicate');
    rejected(action(f.store, { ...f.request, gaps: { ...f.request.gaps,
      records: f.request.gaps.records.map(ref => ref.id === victim.id ? { ...ref, hash: '0'.repeat(64) } : ref) } }), 'record_forged');
    for (const patch of [{ requirements: [{ pointer: '/missing' }] }, { resultForm: { type: 'not-a-json-type' } }, { resultForm: null }])
      rejected(action(f.store, { ...f.request, questions: [{ ...f.request.questions[0]!, ...patch }, ...f.request.questions.slice(1)] }), 'answer_question_invalid');
    const noWorks = clone(f.request) as unknown as { gaps: { sources: Record<string, unknown> } }; delete noWorks.gaps.sources.works;
    assert.throws(() => action(f.store, noWorks as unknown as QuestionTaskRequest), error => error instanceof EngineError && error.code === 'gap_request_invalid');
  }
  assert.deepEqual(snapshot(f.store), before);
  const counterfeit = clone(victim.value) as GapRecord; counterfeit.gap.kind = 'owner-decision'; counterfeit.gap.routes = ['owner'];
  const forged = f.store.write({ id: victim.id, kind: victim.kind, expected: victim.revision, value: counterfeit });
  const request = clone(f.request);
  request.gaps.records = request.gaps.records.map(ref => ref.id === forged.id ? reference(forged) : ref);
  request.questions = request.questions.map(item => item.gap.id === forged.id ? { ...item, gap: reference(forged) } : item);
  const afterForgery = snapshot(f.store);
  rejected(prepareQuestionTasks(f.store, request), 'gap_record_forged');
  rejected(writeQuestionTasks(f.store, request), 'gap_record_forged');
  assert.deepEqual(snapshot(f.store), afterForgery);
});

test('E2 input and D1 guards stop both a pending neighbor transaction and a write-time source race', async t => {
  const f = questionFixture(t), prepared = ok(prepareQuestionTasks(f.store, f.request));
  const saved = await f.store.snapshot(join(f.root, 'task-source-snapshot'));
  for (const [index, dependency] of [reference(f.input), reference(f.active[0]!)].entries()) {
    assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(dependency)));
    const database = join(f.root, `guard-${index}.sqlite`); copyFileSync(saved.path, database);
    const store = new Store(database);
    try {
      const old = store.get(dependency.id)!;
      store.write({ id: old.id, kind: old.kind, expected: old.revision, value: old.value });
      const before = snapshot(store);
      rejected(writeGuarded(store, { unit: 'E2-test', target: 'question-neighbor:garden', guards: prepared.guards,
        writes: [...prepared.writes, { id: 'question-neighbor:garden', kind: 'question-neighbor', expected: 0, value: { state: 'accepted' } }] }), 'input_stale');
      assert.equal(store.get('question-neighbor:garden'), null);
      for (const task of prepared.tasks) assert.equal(store.get(task.record.id), null);
      assert.deepEqual(snapshot(store), before);
    } finally { store.close(); }
  }
  const writeMany = f.store.writeMany.bind(f.store);
  let injected = false;
  f.store.writeMany = ((writes, guards) => {
    if (!injected) {
      injected = true;
      const input = f.store.get(f.input.id)!;
      writeMany([{ id: input.id, kind: input.kind, expected: input.revision, value: input.value }]);
    }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  try {
    rejected(writeQuestionTasks(f.store, f.request), 'input_stale');
    assert.equal(injected, true);
    assert.deepEqual(f.store.list('answer-task'), []);
  } finally { f.store.writeMany = writeMany; }
});

test('E2 does not disguise storage execution faults as a producer refusal', t => {
  const f = questionFixture(t), before = snapshot(f.store);
  for (const failure of [new TypeError('question-task-read-fault'), new EngineError('record_corrupt', 'The exact input is corrupt', { target: f.input.id })]) {
    const broken = new Proxy(f.store, { get(target, property) {
      if (property === 'get') return () => { throw failure; };
      const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    for (const action of [prepareQuestionTasks, writeQuestionTasks]) assert.throws(() => action(broken, f.request), error => error === failure);
  }
  assert.deepEqual(snapshot(f.store), before);
});

function packetFixture(t: TestContext, capacity: number | null = 100_000, desiredGraph = gardenGraph(), addressOwner = true, commonFactConsumer = false,
  resultForm: Json = { type: 'string' }) {
  const f = questionFixture(t, desiredGraph, addressOwner, commonFactConsumer);
  for (const question of f.request.questions) question.resultForm = resultForm;
  const tasks = ok(prepareQuestionTasks(f.store, f.request));
  const routes = ok(writeRoutes(f.store, { project: f.project, gaps: f.request.gaps,
    tasks: tasks.tasks.map(task => ({ pending: clone(task.writes[0]!) as Write })), catalog: { paths: ['src/format.ts'], records: [] }, previous: null }));
  const batch = routes.value.batches.find(batch => batch.model === 'MC1'
    && batch.items.some(item => item.target === 'discovery:encoding'))!;
  assert.ok(batch);
  const command = { executable: process.execPath, args: ['--version'] };
  function environment(amount: number | null) {
    return f.engine.environments.configure(f.project, { workspace: f.root,
      implementer: { actor: 'packet-researcher', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'packet-assessor', model: 'fixture', effort: 'high', command },
      fullCheck: command, timeoutMs: 5000, ...(amount === null ? {} : { requestCapacityChars: amount }) },
    f.store.get(`environment:${f.project}`)?.revision ?? 0);
  }
  const configured = environment(capacity), block = 'garden-consume-block';
  const goal: AttemptGoal = { key: 'packet:repository-facts',
    questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  ok(openSeries(f.store, { project: f.project, block, line: 1, slice: 'packet-facts', predecessor: null, basis: null }));
  const series = ok(beginAttempt(f.store, { project: f.project, block, line: 1, attempt: 1, goal }));
  const request: QuestionPacketRequest = { project: f.project, routes: reference(routes), batch: batch.id,
    environment: reference(configured), attempt: { series: reference(series), ordinal: 1 }, previous: [] };
  return { f, tasks, routes, batch, configured, block, goal, series, request, environment };
}

test('E2 issues native MC1 only after M6 and atomically saves the complete selected payload, tasks and exact question contracts', t => {
  const p = packetFixture(t), { f } = p, before = snapshot(f.store), nativeBefore = f.store.list('question').length;
  assert.deepEqual(f.store.list('mc1-question'), []);
  const prepared = ok(prepareQuestionPacket(f.store, p.request));
  assert.deepEqual(snapshot(f.store), before, 'Preparing native issuance captures writes without publishing them');
  assert.ok(frozen(prepared));
  assert.equal(prepared.existing, false);
  const value = prepared.record.value;
  assert.equal(value.state, 'ready'); assert.equal(value.refusal, null); assert.ok(value.packet); assert.ok(value.fingerprint);
  assert.equal((value.packet as Record<string, Json>).purpose, 'model-research');
  assert.equal(value.native.length, p.batch.items.length);
  const payload = canonical(value.packet);
  assert.deepEqual(value.fingerprint, { hash: hashJson(value.packet), chars: payload.length, utf8Bytes: Buffer.byteLength(payload, 'utf8') });
  assert.equal(value.fullChars, payload.length);
  for (const task of p.tasks.tasks.filter(task => p.batch.items.some(item => item.task?.id === task.record.id))) {
    assert.ok(payload.includes(task.contract.establishes));
    assert.ok(payload.includes(canonical(task.contract.requirements[0])));
    assert.ok(payload.includes('src/format.ts'));
  }
  for (const question of f.input.value.input.questions.filter(question => !f.active.some(gap => gap.value.gap.target === question.id)))
    assert.equal(payload.includes(question.question), false, question.question);
  assert.equal(payload.includes(canonical(f.input.value.input)), false);
  assert.equal(payload.includes(canonical(f.input.value.input.requirements)), false);
  for (const field of ['conceptSections', 'featurePreparation', 'operationRequirements', 'mapDesign'])
    assert.equal(payload.includes(`"${field}"`), false, field);
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(p.request.environment)));
  for (const search of p.routes.value.searches) assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(search.index)));
  assert.equal(prepared.writes.filter(write => write.kind === 'question').length, p.batch.items.length);
  assert.equal(prepared.writes.filter(write => write.kind === 'discovery-draft').length, p.batch.items.length);
  assert.equal(prepared.writes.filter(write => write.kind === 'mc1-question').length, p.batch.items.length);
  assert.equal(new Set(prepared.writes.map(write => write.id)).size, prepared.writes.length);
  ok(writeGuarded(f.store, { unit: 'E2-test', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
  const saved = ok(readQuestionPacket(f.store, { project: f.project, record: reference(prepared.record) }));
  assert.deepEqual(saved, prepared.record);
  for (const issued of saved.value.native) {
    const wrapper = ok(readMc1Question(f.store, { project: f.project, record: issued.question }));
    const task = p.tasks.tasks.find(task => canonical(task.request.gap) === canonical(issued.gap))!;
    assert.ok(task);
    assert.deepEqual(wrapper.record.value.request.task, reference(task.record));
    assert.deepEqual(wrapper.record.value.request.contract, task.contract);
    assert.deepEqual(wrapper.record.value.request.engineQuestion, issued.engineQuestion);
    assert.deepEqual(wrapper.record.value.request.draft, issued.draft);
    const engineQuestion = f.store.get<Question>(issued.engineQuestion.id)!;
    const draft = f.store.get<DiscoveryDraft>(issued.draft.id)!;
    assert.equal(engineQuestion.value.status, 'open'); assert.equal(engineQuestion.value.answer, null);
    assert.equal(engineQuestion.value.draftId, draft.id);
    assert.deepEqual(draft.value.questions, [engineQuestion.id]);
    assert.ok(draft.value.inputs.some(ref => canonical(ref) === canonical(reference(task.record))));
  }
  assert.equal(f.store.list('question').length, nativeBefore + p.batch.items.length);
  assert.deepEqual(f.store.list('call-record'), []);
  const after = snapshot(f.store), repeated = ok(writeQuestionPacket(f.store, p.request));
  assert.equal(repeated.existing, true); assert.deepEqual(repeated.record, saved); assert.deepEqual(repeated.writes, []);
  assert.deepEqual(snapshot(f.store), after);
});

test('E2 uses the whole canonical payload at the exact configured capacity and persists oversized MC1 as blocked without issuance', t => {
  const p = packetFixture(t), { f } = p;
  const full = ok(prepareQuestionPacket(f.store, p.request)).record.value;
  assert.ok(full.packet && full.fingerprint);
  const exact = p.environment(full.fingerprint.chars);
  const atLimit = { ...p.request, environment: reference(exact) };
  const fitting = ok(prepareQuestionPacket(f.store, atLimit));
  assert.equal(fitting.record.value.state, 'ready'); assert.equal(fitting.record.value.fingerprint!.chars, full.fingerprint.chars);
  const tooSmall = p.environment(full.fingerprint.chars - 1), request = { ...p.request, environment: reference(tooSmall) };
  const nativeBefore = f.store.list('question').map(reference), before = snapshot(f.store);
  const prepared = ok(prepareQuestionPacket(f.store, request));
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(prepared.record.value.state, 'blocked'); assert.equal(prepared.record.value.refusal?.code, 'packet_too_large');
  assert.ok(prepared.record.value.fullChars! > tooSmall.value.requestCapacityChars!);
  assert.deepEqual(prepared.record.value.native, []);
  assert.ok(prepared.writes.every(write => !['question', 'discovery-draft', 'mc1-question'].includes(write.kind)));
  const saved = ok(writeQuestionPacket(f.store, request));
  assert.equal(saved.record.value.state, 'blocked'); assert.equal(saved.record.value.refusal?.code, 'packet_too_large');
  assert.deepEqual(f.store.list('question').map(reference), nativeBefore);
  assert.deepEqual(f.store.list('mc1-question'), []);
  assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(saved.record) })), saved.record);
  const after = snapshot(f.store);
  assert.deepEqual(ok(writeQuestionPacket(f.store, request)).record, saved.record);
  assert.deepEqual(snapshot(f.store), after);
});

test('E2 does not invent a capacity or accept a request override and requires the declared active attempt', t => {
  const p = packetFixture(t, null), { f } = p, before = snapshot(f.store);
  for (const action of [prepareQuestionPacket, writeQuestionPacket]) rejected(action(f.store, p.request), 'capacity_missing');
  assert.deepEqual(snapshot(f.store), before);
  const configured = p.environment(100_000), request = { ...p.request, environment: reference(configured) };
  const noIo = new Proxy(f.store, { get(target, property) {
    if (['get', 'list', 'history', 'write', 'writeMany'].includes(String(property))) return () => assert.fail('Malformed packet request reached storage');
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  for (const action of [prepareQuestionPacket, writeQuestionPacket]) {
    for (const field of Object.keys(request)) {
      const missing = clone(request) as unknown as Record<string, unknown>; delete missing[field];
      assert.throws(() => action(noIo, missing as unknown as QuestionPacketRequest), malformed);
    }
    for (const extra of [{ maxRequestChars: 1 }, { requestCapacityChars: 1 }, { budget: 100_000 }])
      assert.throws(() => action(noIo, { ...request, ...extra }), malformed);
    assert.throws(() => action(noIo, { ...request, previous: [{ packet: request.routes, proposal: request.routes }] } as unknown as QuestionPacketRequest), malformed);
    const absentAttempt = action(f.store, { ...request, attempt: null });
    assert.equal(absentAttempt.ok, false);
    if (absentAttempt.ok) assert.fail('An active batch must name a running attempt');
    assert.ok(absentAttempt.refusal.at.field || absentAttempt.refusal.at.ref);
    const foreignAttempt = action(f.store, { ...request, attempt: { series: reference(p.series), ordinal: 2 } });
    assert.equal(foreignAttempt.ok, false);
    rejected(action(f.store, { ...request, batch: 'not-a-routed-batch' }), 'packet_batch_invalid');
    rejected(action(f.store, { ...request, batch: null, attempt: null }), 'packet_batch_invalid');
  }
  assert.deepEqual(f.store.list('mc1-question'), []);
});

test('E2 refuses a D5 requirement selector that would copy the whole input or a whole requirement section', t => {
  const p = packetFixture(t), { f } = p;
  let previous = p.routes;
  for (const pointer of ['', '/requirements']) {
    const request = clone(f.request);
    request.questions = request.questions.map(item => ({ ...item, requirements: [{ pointer }] }));
    const tasks = ok(prepareQuestionTasks(f.store, request));
    const routes = ok(writeRoutes(f.store, { project: f.project, gaps: request.gaps,
      tasks: tasks.tasks.map(task => ({ pending: clone(task.writes[0]!) as Write })),
      catalog: { paths: ['src/format.ts'], records: [] }, previous: reference(previous) }));
    const batch = routes.value.batches.find(batch => batch.model === 'MC1'
      && batch.items.some(item => item.target === 'discovery:encoding'))!;
    assert.ok(batch);
    const before = snapshot(f.store), packetRequest = { ...p.request, routes: reference(routes), batch: batch.id };
    rejected(prepareQuestionPacket(f.store, packetRequest), 'packet_context_unbounded');
    rejected(writeQuestionPacket(f.store, packetRequest), 'packet_context_unbounded');
    assert.deepEqual(snapshot(f.store), before);
    previous = routes;
  }
});

test('E2 environment and answer-index races roll back native issuance together with the packet', async t => {
  const p = packetFixture(t), { f } = p;
  const prepared = ok(prepareQuestionPacket(f.store, p.request));
  const saved = await f.store.snapshot(join(f.root, 'packet-guard-snapshot'));
  for (const [index, dependency] of [p.request.environment, p.routes.value.searches[0]!.index].entries()) {
    assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(dependency)));
    const database = join(f.root, `packet-race-${index}.sqlite`); copyFileSync(saved.path, database);
    const store = new Store(database), writeMany = store.writeMany.bind(store);
    let injected = false;
    try {
      const nativeBefore = store.list('question').map(reference);
      store.writeMany = ((writes, guards) => {
        if (!injected) {
          injected = true;
          const old = store.get(dependency.id)!;
          writeMany([{ id: old.id, kind: old.kind, expected: old.revision, value: old.value }]);
        }
        return writeMany(writes, guards);
      }) as Store['writeMany'];
      rejected(writeQuestionPacket(store, p.request), 'input_stale');
      assert.equal(injected, true);
      assert.deepEqual(store.list('question').map(reference), nativeBefore);
      assert.deepEqual(store.list('mc1-question'), []);
      assert.equal(store.get(prepared.record.id), null);
    } finally { store.writeMany = writeMany; store.close(); }
  }
});

test('E2 packet history and native task binding survive environment and source changes across restart', t => {
  const p = packetFixture(t), { f } = p, saved = ok(writeQuestionPacket(f.store, p.request)).record;
  const history = ok(readQuestionPacket(f.store, { project: f.project, record: reference(saved) }));
  p.environment(1);
  const source = f.store.get(`source:${f.project}:brief`)!;
  f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  f.restart();
  const before = snapshot(f.store);
  assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(saved) })), history);
  for (const native of history.value.native) assert.ok(ok(readMc1Question(f.store, { project: f.project, record: native.question })).record.value.request.task);
  assert.deepEqual(snapshot(f.store), before);
});

test('E1 records the actual E2 purpose and whole packet fingerprint in its durable ledger before any dispatch', t => {
  const p = packetFixture(t), { f } = p, packet = ok(writeQuestionPacket(f.store, p.request)).record.value;
  assert.ok(packet.packet && packet.fingerprint);
  const adapter = f.store.write({ id: `adapter:${f.project}`, kind: 'dispatch-adapter', expected: 0, value: { projectId: f.project, protocol: 'fixture' } });
  const config = f.store.write({ id: `config:${f.project}`, kind: 'dispatch-config', expected: 0, value: { projectId: f.project, model: 'fixture' } });
  const purpose = (packet.packet as Record<string, Json>).purpose as CallPurpose;
  const admitted = ok(recordCall(f.store, f.project, { call: 'packet-facts-1', purpose, basis: null, block: p.block,
    gaps: p.batch.items.flatMap(item => item.consumers.map(consumer => ({ id: item.target, goal: item.target, field: item.field, consumer }))),
    series: reference(p.series), attempt: 1, goal: p.goal, dispatch: { adapter: reference(adapter), config: reference(config) }, packet: clone(packet.packet) as Json }));
  assert.equal(admitted.call.value.status, 'open'); assert.equal(admitted.call.value.purpose, 'model-research');
  assert.deepEqual(admitted.call.value.packet, { hash: packet.fingerprint.hash, chars: packet.fingerprint.chars, bytes: packet.fingerprint.utf8Bytes });
  assert.equal(admitted.ledger.value.calls.length, 1);
  assert.deepEqual(admitted.ledger.value.calls[0]!.call, reference(admitted.call));
  assert.equal(admitted.ledger.value.calls[0]!.purpose, purpose);
});

test('E2 refuses a real unaddressed question without a supported mechanism series and preserves its route', t => {
  const p = packetFixture(t, 100_000, gardenGraph(), false), { f } = p;
  const batch = p.routes.value.batches.find(batch => batch.model === 'MC2' && batch.task === 'input-field'
    && batch.items.some(item => item.target === 'discovery:approval-owner'))!;
  assert.ok(batch);
  const gap = f.gaps.records.find(row => row.value.gap.target === 'discovery:approval-owner')!;
  assert.equal(gap.value.gap.code, 'question_unaddressed');
  assert.deepEqual(gap.value.gap.consumers, []);
  assert.equal(gap.value.gap.mechanism, 'M5:addressing');
  const goal: AttemptGoal = { key: 'packet:input-field',
    questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  for (const block of ['packet-input-field', 'M5:addressing']) {
    ok(openSeries(f.store, { project: f.project, block, line: 1, slice: 'packet-addressing', predecessor: null, basis: null }));
    const series = ok(beginAttempt(f.store, { project: f.project, block, line: 1, attempt: 1, goal }));
    const request: QuestionPacketRequest = { ...p.request, batch: batch.id, attempt: { series: reference(series), ordinal: 1 } };
    const before = snapshot(f.store);
    for (const action of [prepareQuestionPacket, writeQuestionPacket]) {
      const refusal = rejected(action(f.store, request), 'packet_series_unsupported');
      assert.equal(refusal.at.target, gap.value.gap.target);
      assert.equal(refusal.at.field, gap.value.gap.field);
      assert.deepEqual(refusal.at.ref, reference(gap));
      assert.ok(refusal.message.includes('M5:addressing'));
    }
    assert.deepEqual(snapshot(f.store), before);
  }
  f.restart();
  const historical = ok(readRoutes(f.store, { project: f.project, record: reference(p.routes) }));
  assert.deepEqual(historical.record, p.routes);
  assert.equal(historical.record.value.routes.find(row => row.gap === gap.value.gap.id)!.route, 'design');
  assert.deepEqual(f.store.list('question-packet'), []);
});

function crossedPacketGraph(): Graph {
  const graph = gardenGraph('cross');
  graph.nodes.find(node => node.id === 'garden-produce-block')!.ports.push({ id: 'out-side', direction: 'out', contract: 'garden-contract' });
  graph.nodes.find(node => node.id === 'garden-consume-block')!.ports.push({ id: 'in-side', direction: 'in', contract: 'garden-contract' });
  graph.connectors.push({ id: 'garden-side-flow', artifact: 'garden-data', returnsTo: 'garden-produce-block', wakeTest: null,
    bindings: [{ level: 1, producer: { node: 'garden-produce-block', port: 'out-side' },
      consumers: [{ node: 'garden-consume-block', port: 'in-side' }], anchor: null }] });
  return graph;
}

function expansionFixture(t: TestContext, capacity = 100_000) {
  const p = packetFixture(t, capacity, crossedPacketGraph()), { f } = p;
  const batch = p.routes.value.batches.find(batch => batch.task === 'node-expansion' && batch.node === 'garden-produce-block')!;
  assert.ok(batch);
  const source = ok(prepareFrameProposals(f.store, f.request.gaps.sources.operations));
  const obligations = source.frame.result.obligations.filter(obligation => obligation.upper.node === batch.node);
  assert.equal(new Set(obligations.flatMap(obligation => obligation.connector ? [obligation.connector] : [])).size, 2);
  assert.ok(obligations.filter(obligation => obligation.connector === 'garden-flow').length > 1, 'Crossed flows have separate obligations');
  const goal: AttemptGoal = { key: 'packet:expand-produce',
    questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  const block = batch.node!;
  ok(openSeries(f.store, { project: f.project, block, line: 1, slice: 'packet-expansion', predecessor: null, basis: null }));
  const series = ok(beginAttempt(f.store, { project: f.project, block, line: 1, attempt: 1, goal }));
  const request: QuestionPacketRequest = { ...p.request, batch: batch.id, attempt: { series: reference(series), ordinal: 1 } };
  return { ...p, batch, source, obligations, goal, block, series, request };
}

function partResult(p: ReturnType<typeof expansionFixture>, packet: ReturnType<typeof writeQuestionPacket> extends OmResult<infer T> ? T : never,
  modify?: (body: Omit<LayerProposal, 'base' | 'level' | 'source' | 'status'>) => void) {
  const { f } = p, record = packet.record, plan = record.value.plan!;
  const ids = plan.assignments[plan.position]!.obligations;
  const assigned = p.obligations.filter(obligation => ids.includes(obligation.id));
  assert.equal(assigned.length, ids.length);
  const upper = f.graph.value.nodes.find(node => node.id === p.batch.node)!;
  const node: Node = { ...clone(upper), id: `garden-part-${plan.position}`, kind: 'operation', parent: upper.id,
    title: `Expansion part ${plan.position}`, ports: assigned.filter(obligation => obligation.kind === 'connection-end').map((obligation, index) => ({
      id: `part-port-${index}`, direction: obligation.role === 'producer' ? 'out' : 'in',
      contract: f.graph.value.artifacts.find(artifact => artifact.id === obligation.artifact)!.contract,
    })), code: [], tests: [] };
  let port = 0;
  const body: Omit<LayerProposal, 'base' | 'level' | 'source' | 'status'> = { nodes: [node], fills: assigned.map(obligation => ({ obligation: obligation.id, node: node.id,
      ...(obligation.kind === 'connection-end' ? { port: node.ports[port++]!.id } : {}) })), localConnectors: [], artifacts: [], contracts: [],
    joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
  modify?.(body);
  const adapter = f.store.get(`adapter:${f.project}`) ?? f.store.write({ id: `adapter:${f.project}`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: f.project, protocol: 'fixture' } });
  const config = f.store.get(`config:${f.project}`) ?? f.store.write({ id: `config:${f.project}`, kind: 'dispatch-config', expected: 0,
    value: { projectId: f.project, model: 'fixture' } });
  const call = ok(recordCall(f.store, f.project, { call: String((record.value.packet as Record<string, Json>).requestId), purpose: 'model-design', basis: null,
    block: p.block, gaps: p.batch.items.filter(item => ids.includes(item.target)).flatMap(item => item.consumers.map(consumer => ({
      id: item.target, goal: item.target, field: item.field, consumer }))), series: reference(p.series), attempt: 1, goal: p.goal,
    dispatch: { adapter: reference(adapter), config: reference(config) }, packet: clone(record.value.packet) as Json })).call;
  const requestId = (record.value.packet as Record<string, Json>).requestId as string;
  assert.equal(typeof requestId, 'string');
  const responseForm = (record.value.packet as Record<string, any>).responseForm;
  assert.equal(responseForm.protocol, PACKET_ANSWER_PROTOCOL); assert.equal(responseForm.requestId, requestId);
  const shape = responseForm.schema.oneOf[0].properties.proposal;
  assert.deepEqual([...shape.required].sort(), Object.keys(body).sort());
  assert.equal(shape.additionalProperties, false);
  const response = f.store.write<PartResponseRecord>({ id: partResponseId(f.project, reference(call)), kind: 'part-response', expected: 0,
    value: { project: f.project, packet: reference(record), call: reference(call), requestId,
      raw: JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId, action: 'answer', proposal: body }) } });
  const request = { project: f.project, packet: reference(record), call: reference(call), response: reference(response) };
  const before = snapshot(f.store), prepared = ok(preparePartResult(f.store, request));
  assert.deepEqual(snapshot(f.store), before);
  assert.ok(frozen(prepared));
  ok(writeGuarded(f.store, { unit: 'E2-test', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
  assert.deepEqual(ok(readPartResult(f.store, { project: f.project, record: reference(prepared.record) })).proposal, prepared.proposal);
  return { ...prepared, call, response, body, request };
}

test('E2 MC2 whole-node payload retains every crossed flow and the exact upper obligations without native MC1 issuance', t => {
  const p = expansionFixture(t), { f } = p, before = snapshot(f.store);
  const prepared = ok(prepareQuestionPacket(f.store, p.request));
  assert.deepEqual(snapshot(f.store), before);
  const value = prepared.record.value;
  assert.equal(value.state, 'ready'); assert.ok(value.packet); assert.ok(value.plan);
  assert.equal((value.packet as Record<string, Json>).purpose, 'model-design');
  assert.equal(value.plan.mode, 'whole'); assert.equal(value.plan.position, 0);
  assert.deepEqual(ordered(value.plan.assignments.flatMap(part => part.obligations)), ordered(p.obligations.map(obligation => obligation.id)));
  const expansion = (value.packet as Record<string, any>).expansion;
  assert.equal(expansion.upper.id, p.batch.node);
  assert.deepEqual(ordered((expansion.obligations as FrameObligation[]).map(obligation => obligation.id)), ordered(p.obligations.map(obligation => obligation.id)));
  assert.deepEqual(ordered(expansion.assigned), ordered(p.obligations.map(obligation => obligation.id)));
  for (const connector of f.graph.value.connectors.filter(connector => ['garden-flow', 'garden-side-flow'].includes(connector.id))) {
    const connection = (expansion.connections as { id: string; flows: Json[] }[]).find(connection => connection.id === connector.id)!;
    assert.ok(connection, connector.id);
    const carried = canonical(connection.flows);
    for (const binding of connector.bindings.filter(binding => binding.level === 1)) {
      assert.ok(carried.includes(canonical(binding.producer)), `${connector.id}: producer`);
      for (const consumer of binding.consumers) assert.ok(carried.includes(canonical(consumer)), `${connector.id}: consumer`);
    }
  }
  assert.deepEqual(value.native, []);
  const saved = ok(writeQuestionPacket(f.store, p.request)).record;
  assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(f.store.list('mc1-question'), []);
});

test('E2 splits MC2 by indivisible connectors, assigns the outcome to the last part and carries prior node definitions', t => {
  const p = expansionFixture(t), { f } = p;
  const whole = ok(prepareQuestionPacket(f.store, p.request)).record.value;
  assert.ok(whole.fingerprint);
  const environment = p.environment(whole.fingerprint.chars - 1);
  let request = { ...p.request, environment: reference(environment) };
  const first = ok(writeQuestionPacket(f.store, request));
  const plan = first.record.value.plan!;
  assert.equal(first.record.value.state, 'ready'); assert.equal(plan.mode, 'parts'); assert.equal(plan.position, 0);
  assert.equal(plan.assignments.length, 2);
  assert.deepEqual(ordered(((first.record.value.packet as Record<string, any>).questions as { target: string }[]).map(question => question.target)),
    ordered(plan.assignments[0]!.obligations));
  assert.deepEqual(plan.assignments.map(part => part.connector), ['garden-flow', 'garden-side-flow']);
  const assigned = plan.assignments.flatMap(part => part.obligations);
  assert.equal(new Set(assigned).size, assigned.length);
  assert.deepEqual(ordered(assigned), ordered(p.obligations.map(obligation => obligation.id)));
  const outcome = p.obligations.find(obligation => obligation.kind !== 'connection-end')!;
  assert.ok(outcome);
  for (const [index, part] of plan.assignments.entries()) {
    assert.equal(part.obligations.includes(outcome.id), index === plan.assignments.length - 1);
    const connections = p.obligations.filter(obligation => obligation.connector === part.connector).map(obligation => obligation.id);
    assert.ok(connections.every(id => part.obligations.includes(id)));
    assert.ok(part.obligations.every(id => id === outcome.id || connections.includes(id)));
  }
  assert.ok(first.record.value.fingerprint!.chars <= environment.value.requestCapacityChars!);
  const firstResult = partResult(p, first), firstProposal = firstResult.proposal;
  ok(prepareFrameProposals(f.store, { ...f.request.gaps.sources.operations, proposals: [reference(firstProposal)] }));
  request = { ...request, previous: [{ packet: reference(first.record), proposal: reference(firstProposal), result: reference(firstResult.record) }] };
  const second = ok(writeQuestionPacket(f.store, request));
  assert.equal(second.record.value.state, 'ready'); assert.equal(second.record.value.plan!.position, 1);
  assert.deepEqual(second.record.value.plan!.assignments, plan.assignments);
  const expansion = (second.record.value.packet as Record<string, any>).expansion;
  assert.deepEqual(ordered(((second.record.value.packet as Record<string, any>).questions as { target: string }[]).map(question => question.target)),
    ordered(plan.assignments[1]!.obligations));
  assert.deepEqual(expansion.previous, [{ packet: reference(first.record), proposal: reference(firstProposal), result: reference(firstResult.record), nodes: firstProposal.value.nodes }]);
  for (const node of firstProposal.value.nodes) assert.ok(expansion.reserved.includes(node.id));
  const secondResult = partResult(p, second, body => {
    body.fills.find(fill => fill.obligation === outcome.id)!.node = firstProposal.value.nodes[0]!.id;
  }), secondProposal = secondResult.proposal;
  assert.equal(secondProposal.value.fills.find(fill => fill.obligation === outcome.id)!.node, firstProposal.value.nodes[0]!.id);
  // E4 combines parts into one proposal before C3 checks references between their nodes.
  const combined = f.store.write<LayerProposal>({ id: `om-proposal:${f.project}:combined-parts-fixture`, kind: 'layer-proposal', expected: 0,
    value: { ...secondProposal.value, nodes: [...firstProposal.value.nodes, ...secondProposal.value.nodes],
      fills: [...firstProposal.value.fills, ...secondProposal.value.fills] } });
  ok(prepareFrameProposals(f.store, { ...f.request.gaps.sources.operations, proposals: [reference(combined)] }));
  assert.ok(second.record.value.fingerprint!.chars <= environment.value.requestCapacityChars!);
  const nativeBefore = f.store.list('question').map(reference);
  const complete = ok(writeQuestionPacket(f.store, { ...request,
    previous: [...request.previous, { packet: reference(second.record), proposal: reference(secondProposal), result: reference(secondResult.record) }] }));
  assert.equal(complete.record.value.state, 'empty'); assert.equal(complete.record.value.packet, null);
  assert.deepEqual(f.store.list('question').map(reference), nativeBefore);
  const history = [first.record, second.record, complete.record];
  for (const result of [firstResult, secondResult]) {
    ok(settleCall(f.store, reference(result.call), { inputTokens: 10, outputTokens: 3, cachedInputTokens: null, reasoningOutputTokens: null }, 'succeeded'));
    f.store.write({ id: result.proposal.id, kind: result.proposal.kind, expected: result.proposal.revision,
      value: { ...result.proposal.value, status: 'accepted' } });
  }
  f.restart();
  for (const record of history) assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(record) })), record);
  for (const result of [firstResult, secondResult]) assert.deepEqual(ok(readPartResult(f.store, { project: f.project, record: reference(result.record) })).proposal, result.proposal);
});

test('E2 refuses a skipped part, a forged previous packet and a duplicated provenance prefix', t => {
  const p = expansionFixture(t), { f } = p;
  const whole = ok(prepareQuestionPacket(f.store, p.request)).record.value;
  const environment = p.environment(whole.fingerprint!.chars - 1), request = { ...p.request, environment: reference(environment) };
  const first = ok(writeQuestionPacket(f.store, request)), firstResult = partResult(p, first), proposal = firstResult.proposal;
  const prefix = { packet: reference(first.record), proposal: reference(proposal), result: reference(firstResult.record) };
  const next = ok(writeQuestionPacket(f.store, { ...request, previous: [prefix] }));
  const nextResult = partResult(p, next);
  const nextProposal = nextResult.proposal;
  const before = snapshot(f.store);
  for (const previous of [
    [{ packet: reference(next.record), proposal: reference(nextProposal), result: reference(nextResult.record) }],
    [{ ...prefix, packet: { ...prefix.packet, hash: '0'.repeat(64) } }],
    [prefix, prefix],
  ]) {
    const refused = prepareQuestionPacket(f.store, { ...request, previous });
    assert.equal(refused.ok, false);
    if (refused.ok) assert.fail('Unproven previous parts must not advance an expansion');
    assert.ok(refused.refusal.at.field || refused.refusal.at.ref);
  }
  assert.deepEqual(snapshot(f.store), before);
});

test('E2 persists an indivisible MC2 overflow and does not issue a smaller arbitrary slice of its connector', t => {
  const p = expansionFixture(t, 1), { f } = p, nativeBefore = f.store.list('question').map(reference);
  const prepared = ok(prepareQuestionPacket(f.store, p.request));
  assert.equal(prepared.record.value.state, 'blocked'); assert.equal(prepared.record.value.refusal?.code, 'node_unexpandable');
  const saved = ok(writeQuestionPacket(f.store, p.request)).record;
  assert.equal(saved.value.state, 'blocked'); assert.equal(saved.value.refusal?.code, 'node_unexpandable');
  assert.deepEqual(saved.value.native, []);
  assert.deepEqual(f.store.list('question').map(reference), nativeBefore);
  assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('E2 part provenance rejects a recomputed revision of adapter raw bytes and a substituted derived proposal', t => {
  const p = expansionFixture(t), { f } = p;
  const whole = ok(prepareQuestionPacket(f.store, p.request)).record.value;
  const environment = p.environment(whole.fingerprint!.chars - 1), request = { ...p.request, environment: reference(environment) };
  const packet = ok(writeQuestionPacket(f.store, request)), result = partResult(p, packet);
  const history = ok(readPartResult(f.store, { project: f.project, record: reference(result.record) }));
  const sameContent = f.store.write<LayerProposal>({ id: `om-proposal:${f.project}:copied-part`, kind: result.proposal.kind, expected: 0, value: result.proposal.value });
  rejected(prepareQuestionPacket(f.store, { ...request, previous: [{ packet: reference(packet.record),
    proposal: reference(sameContent), result: reference(result.record) }] }), 'packet_chain_invalid');
  const changed = JSON.parse(result.response.value.raw) as { proposal: { nodes: Node[] } };
  changed.proposal.nodes[0]!.title = 'A substituted result with a freshly computed hash';
  const forgedResponse = f.store.write<PartResponseRecord>({ id: result.response.id, kind: result.response.kind, expected: result.response.revision,
    value: { ...result.response.value, raw: JSON.stringify(changed) } });
  const before = snapshot(f.store);
  const rejectedRaw = preparePartResult(f.store, { ...result.request, response: reference(forgedResponse) });
  assert.equal(rejectedRaw.ok, false);
  if (rejectedRaw.ok) assert.fail('A replacement raw response must not reuse the immutable part result identity');
  assert.ok(rejectedRaw.refusal.at.field || rejectedRaw.refusal.at.ref);
  assert.deepEqual(snapshot(f.store), before);
  assert.deepEqual(ok(readPartResult(f.store, { project: f.project, record: reference(result.record) })), history);
  const changedProposal = clone(result.proposal.value) as LayerProposal;
  changedProposal.nodes[0]!.title = 'A proposal unrelated to the saved raw result';
  const forgedProposal = f.store.write<LayerProposal>({ id: result.proposal.id, kind: result.proposal.kind, expected: result.proposal.revision, value: changedProposal });
  const afterForgery = snapshot(f.store);
  const rejectedProposal = prepareQuestionPacket(f.store, { ...request,
    previous: [{ packet: reference(packet.record), proposal: reference(forgedProposal), result: reference(result.record) }] });
  assert.equal(rejectedProposal.ok, false);
  assert.deepEqual(snapshot(f.store), afterForgery);
  f.restart();
  assert.deepEqual(ok(readPartResult(f.store, { project: f.project, record: reference(result.record) })), history);
});

test('E2 current MC1 admission rejects a changed native head while its issued packet remains readable history', t => {
  const p = packetFixture(t), { f } = p, packet = ok(writeQuestionPacket(f.store, p.request)).record;
  const native = f.store.get(packet.value.native[0]!.engineQuestion.id)!;
  f.store.write({ id: native.id, kind: native.kind, expected: native.revision, value: native.value });
  const before = snapshot(f.store);
  rejected(prepareQuestionPacket(f.store, p.request), 'input_stale');
  rejected(writeQuestionPacket(f.store, p.request), 'input_stale');
  assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(packet) })), packet);
  assert.deepEqual(snapshot(f.store), before);
});

test('E2 reconstructs packet assignments and native bindings instead of trusting a same-id rehashed packet body', async t => {
  const p = expansionFixture(t), { f } = p, prepared = ok(prepareQuestionPacket(f.store, p.request));
  const pristine = await f.store.snapshot(join(f.root, 'packet-forgery-source'));
  for (const mode of ['missing', 'duplicate'] as const) {
    const database = join(f.root, `packet-${mode}.sqlite`); copyFileSync(pristine.path, database);
    const store = new Store(database);
    try {
      const value = clone(prepared.record.value) as QuestionPacketRecord;
      const expansion = (value.packet as Record<string, any>).expansion as { assigned: string[] };
      if (mode === 'missing') { value.plan!.assignments[0]!.obligations.pop(); expansion.assigned.pop(); }
      else { value.plan!.assignments[0]!.obligations.push(value.plan!.assignments[0]!.obligations[0]!); expansion.assigned.push(expansion.assigned[0]!); }
      const text = canonical(value.packet);
      value.fingerprint = { hash: hashJson(value.packet), chars: text.length, utf8Bytes: Buffer.byteLength(text) };
      value.fullChars = text.length;
      const forged = store.write<QuestionPacketRecord>({ id: prepared.record.id, kind: prepared.record.kind, expected: 0, value });
      assert.equal(forged.hash, hashJson(forged.value));
      const before = snapshot(store);
      rejected(readQuestionPacket(store, { project: f.project, record: reference(forged) }), 'packet_record_invalid');
      rejected(prepareQuestionPacket(store, p.request), 'packet_record_invalid');
      assert.deepEqual(snapshot(store), before);
    } finally { store.close(); }
  }
  const mc1 = packetFixture(t, 100_000, gardenGraph(), true, true), nativePacket = ok(prepareQuestionPacket(mc1.f.store, mc1.request));
  const value = clone(nativePacket.record.value) as QuestionPacketRecord;
  value.native.reverse();
  mc1.f.store.writeMany([...nativePacket.writes.filter(write => write.id !== nativePacket.record.id),
    { id: nativePacket.record.id, kind: nativePacket.record.kind, expected: 0, value }]);
  const forged = mc1.f.store.get(nativePacket.record.id)!;
  assert.equal(forged.hash, hashJson(value));
  rejected(readQuestionPacket(mc1.f.store, { project: mc1.f.project, record: reference(forged) }), 'packet_record_invalid');
});

test('E2 receives no invented connector assignment for a native outcome-only identity', t => {
  const p = packetFixture(t), { f } = p;
  const frame = ok(prepareFrameProposals(f.store, f.request.gaps.sources.operations));
  const outcomeOnly = frame.result.obligations.filter(item => item.kind !== 'connection-end'
    && !frame.result.obligations.some(other => other.upper.node === item.upper.node && other.kind === 'connection-end'));
  assert.ok(outcomeOnly.length > 0);
  for (const outcome of outcomeOnly) {
    assert.ok(frame.result.fills.some(fill => fill.obligation === outcome.id && fill.source === 'identity'));
    assert.equal(frame.gaps.some(gap => gap.target === outcome.id), false);
    assert.equal(p.routes.value.batches.some(batch => batch.items.some(item => item.target === outcome.id)), false);
  }
});

test('E2 counts all prior definitions before admitting the final part and persists a late mandatory-context overflow', t => {
  const p = expansionFixture(t), { f } = p, whole = ok(prepareQuestionPacket(f.store, p.request)).record.value;
  const environment = p.environment(whole.fingerprint!.chars - 1), request = { ...p.request, environment: reference(environment) };
  const first = ok(writeQuestionPacket(f.store, request));
  const firstResult = partResult(p, first, body => {
    for (let index = 0; index < 128; index++) body.nodes.push({ ...clone(body.nodes[0]!), id: `garden-prior-extra-${index}`, title: `Prior node ${index}` });
  });
  const next = ok(writeQuestionPacket(f.store, { ...request,
    previous: [{ packet: reference(first.record), proposal: reference(firstResult.proposal), result: reference(firstResult.record) }] })).record;
  assert.equal(next.value.state, 'blocked'); assert.equal(next.value.refusal?.code, 'node_unexpandable');
  assert.equal(next.value.plan!.position, 1);
  assert.equal(next.value.packet, null);
  assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(next) })), next);
});

test('E2 part-result admission rejects a foreign purpose, another declared attempt and missing or mismatched adapter response', t => {
  const p = expansionFixture(t), { f } = p, whole = ok(prepareQuestionPacket(f.store, p.request)).record.value;
  const environment = p.environment(whole.fingerprint!.chars - 1);
  const packet = ok(writeQuestionPacket(f.store, { ...p.request, environment: reference(environment) })), result = partResult(p, packet);
  const admitted = result.call.value;
  const sourceRequest: RecordCallRequest = { call: 'alternative', purpose: admitted.purpose, basis: admitted.basis, block: admitted.block,
    gaps: clone(admitted.gaps), series: admitted.series, attempt: admitted.attempt, goal: admitted.goal, dispatch: admitted.dispatch,
    packet: clone(packet.record.value.packet) as Json };
  const anotherCall = ok(recordCall(f.store, f.project, sourceRequest)).call;
  const foreignPurpose = ok(recordCall(f.store, f.project, { ...sourceRequest, call: 'foreign-purpose', purpose: 'model-research' })).call;
  const block = 'different-attempt';
  ok(openSeries(f.store, { project: f.project, block, line: 1, slice: 'another-attempt', predecessor: null, basis: null }));
  const series = ok(beginAttempt(f.store, { project: f.project, block, line: 1, attempt: 1, goal: p.goal }));
  const foreignAttempt = ok(recordCall(f.store, f.project, { ...sourceRequest, call: 'foreign-attempt', block, series: reference(series) })).call;
  for (const call of [anotherCall, foreignPurpose, foreignAttempt]) {
    const before = snapshot(f.store);
    rejected(preparePartResult(f.store, { ...result.request, call: reference(call) }), 'part_result_invalid');
    assert.deepEqual(snapshot(f.store), before);
  }
  const badEnvironment = p.environment(environment.value.requestCapacityChars!);
  const badPacket = ok(writeQuestionPacket(f.store, { ...p.request, environment: reference(badEnvironment) })).record;
  const badPayload = badPacket.value.packet as Record<string, Json>;
  const wronglyBound = ok(recordCall(f.store, f.project, { ...sourceRequest, call: String(badPayload.requestId), block,
    series: reference(series), packet: clone(badPayload) })).call;
  rejected(preparePartResult(f.store, { project: f.project, packet: reference(badPacket), call: reference(wronglyBound),
    response: { id: partResponseId(f.project, reference(wronglyBound)), revision: 1, hash: '0'.repeat(64) } }), 'part_result_invalid');
  const nextEnvironment = p.environment(environment.value.requestCapacityChars!);
  const nextPacket = ok(writeQuestionPacket(f.store, { ...p.request, environment: reference(nextEnvironment) }));
  const nextPayload = nextPacket.record.value.packet as Record<string, Json>;
  const unanswered = ok(recordCall(f.store, f.project, { ...sourceRequest, call: String(nextPayload.requestId), packet: clone(nextPayload) })).call;
  const request = { ...result.request, packet: reference(nextPacket.record), call: reference(unanswered),
    response: { id: partResponseId(f.project, reference(unanswered)), revision: 1, hash: '0'.repeat(64) } };
  ok(settleCall(f.store, reference(unanswered), { inputTokens: 10, outputTokens: 3, cachedInputTokens: null, reasoningOutputTokens: null }, 'succeeded'));
  rejected(preparePartResult(f.store, request), 'record_missing');
  const requestId = nextPayload.requestId as string;
  const mismatched = f.store.write<PartResponseRecord>({ id: request.response.id, kind: 'part-response', expected: 0,
    value: { project: f.project, packet: reference(nextPacket.record), call: reference(unanswered), requestId,
      raw: JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId: 'not-the-sent-request', action: 'answer', proposal: result.body }) } });
  rejected(preparePartResult(f.store, { ...request, response: reference(mismatched) }), 'part_result_invalid');
  for (const section of Object.keys(result.body)) {
    const missing = clone(result.body) as unknown as Record<string, unknown>; delete missing[section];
    rejected(normalizePartAnswer(missing), 'part_answer_invalid');
  }
  for (const service of [{ status: 'accepted' }, { source: 'decision' }, { level: 2 }, { base: result.proposal.value.base }])
    rejected(normalizePartAnswer({ ...result.body, ...service }), 'part_answer_invalid');
});

test('E2 retry context contains only addressed refusals from the preceding attempt of the same exact goal', t => {
  const p = packetFixture(t), { f } = p;
  let nextSource = 0;
  function refusal(code: string, goal: string) {
    const source = f.store.write({ id: `${unitRefusalNamespace(f.project)}packet-retry-${++nextSource}`, kind: UNIT_REFUSAL_KIND, expected: 0,
      value: { gate: 'G4', refusals: [{ code, goal, remedy: 'Resolve the addressed question',
        origin: { name: code, stage: 'question-packet', subject: goal, sources: [{ role: 'input', ref: reference(f.input) }] } }] } });
    const journal = ok(recordRefusal(f.store, { project: f.project, source: reference(source) }));
    const row = journal.value.rows.find(row => row.source.id === source.id)!;
    return { row: row.id, name: row.code, goal: row.goal };
  }
  const address = { project: f.project, block: p.block, line: 1 };
  const older = refusal('older-own-refusal', p.batch.items[0]!.target);
  ok(completeAttempt(f.store, { ...address, attempt: 1, outcome: { reason: 'refused', achieved: [], cancelled: [], refusals: [older] } }));
  ok(beginAttempt(f.store, { ...address, attempt: 2, goal: p.goal }));
  const own = refusal('latest-own-refusal', p.batch.items[0]!.target), foreign = refusal('foreign-refusal', 'unrelated-question');
  ok(completeAttempt(f.store, { ...address, attempt: 2, outcome: { reason: 'refused', achieved: [], cancelled: [], refusals: [own, foreign] } }));
  const third = ok(beginAttempt(f.store, { ...address, attempt: 3, goal: p.goal }));
  const packet = ok(writeQuestionPacket(f.store, { ...p.request, attempt: { series: reference(third), ordinal: 3 } })).record;
  assert.deepEqual((packet.value.packet as Record<string, Json>).refusals, [{ code: own.name, target: own.goal }]);
  assert.ok(packet.value.journal);
  const payload = canonical(packet.value.packet);
  assert.equal(payload.includes(older.name), false); assert.equal(payload.includes(foreign.name), false);
  assert.equal(payload.includes('Resolve the addressed question'), false);
  const other = { project: f.project, block: 'packet-new-goal', line: 1 };
  ok(openSeries(f.store, { ...other, slice: 'changed-goal', predecessor: null, basis: null }));
  ok(beginAttempt(f.store, { ...other, attempt: 1, goal: p.goal }));
  ok(completeAttempt(f.store, { ...other, attempt: 1, outcome: { reason: 'refused', achieved: [], cancelled: [], refusals: [own] } }));
  const changed = ok(beginAttempt(f.store, { ...other, attempt: 2, goal: { ...p.goal, result: 'A different agreed result' } }));
  rejected(writeQuestionPacket(f.store, { ...p.request, attempt: { series: reference(changed), ordinal: 2 } }), 'packet_attempt_invalid');
  refusal('later-unrelated-history', p.batch.items[0]!.target);
  f.restart();
  assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(packet) })), packet);
});

test('E2 does not reassign accepted refinements and writes an empty packet when native D1 has no model work', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-packet-accepted-')), database = join(root, 'state.sqlite');
  const store = new Store(database), engine = new ProductEngine(store), project = 'garden';
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'README.md'), 'Native accepted garden layers for empty-packet testing.\n');
  preparedFeatures(engine, project, gardenGraph());
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'accepted-layer-worker', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'accepted-layer-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  refinedLayers(engine, project);
  const graph = store.get<Graph>(`graph:${project}`)!;
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, stages, expected: 0 }));
  const decisions = base.value.gaps.filter(gap => gap.code !== 'inventory_missing').map(gap => {
    assert.ok(['contract_node_unbound', 'acceptance_kind_missing', 'contract_boundary_prose'].includes(gap.code), gap.code);
    const field = gap.code === 'contract_node_unbound' ? 'nodes' : gap.code === 'acceptance_kind_missing' ? 'checkKind' : 'state';
    const value: Json = field === 'nodes' ? ['garden-produce-block', 'garden-consume-block'] : field === 'checkKind' ? 'test'
      : { writer: 'garden-produce-block', authority: 'garden-user', rollback: 'garden-produce-block' };
    return { pending: clone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: gap.target, field, value } })) as Write };
  });
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph), decisions }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph),
    refinement: reference(store.get(`phase:${project}:L2`)!), available: {},
    choice: { choiceVersion: 'all-layers-accepted', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame = (level: 2 | 3) => ({ proposals: [], frame: { project, level, graph: reference(graph), horizon: reference(horizon.gate),
    layer: reference(store.get(`graph-layer:${project}:${level}`)!), frame: null,
    upper: level === 2 ? null : { horizon: reference(horizon.gate), frame: null } } });
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate), operations: frame(2), works: frame(3) };
  const operations = ok(prepareFrameProposals(store, sources.operations)), works = ok(prepareFrameProposals(store, frame(3)));
  assert.deepEqual(operations.gaps, []); assert.deepEqual(works.gaps, []);
  const gaps = ok(writeGaps(store, sources));
  const tasks = ok(prepareQuestionTasks(store, { project, gaps: { sources, records: gaps.records.map(reference) }, questions: [] }));
  assert.deepEqual(tasks.tasks, []);
  const routes = ok(writeRoutes(store, { project, gaps: { sources, records: gaps.records.map(reference) }, tasks: [],
    catalog: { paths: [], records: [] }, previous: null }));
  assert.deepEqual(routes.value.batches, []);
  const request: QuestionPacketRequest = { project, routes: reference(routes), batch: null, environment: reference(environment), attempt: null, previous: [] };
  const nativeBefore = store.list('question').map(reference), prepared = ok(prepareQuestionPacket(store, request));
  assert.equal(prepared.record.value.state, 'empty'); assert.equal(prepared.record.value.packet, null);
  assert.equal(prepared.record.value.fingerprint, null); assert.equal(prepared.record.value.plan, null);
  assert.deepEqual(prepared.record.value.native, []);
  const saved = ok(writeQuestionPacket(store, request)).record;
  assert.deepEqual(ok(readQuestionPacket(store, { project, record: reference(saved) })), saved);
  assert.deepEqual(store.list('question').map(reference), nativeBefore);
});

test('E2 assigns a genuinely open outcome alone after C3 fills every connection of the upper node', t => {
  const p = expansionFixture(t), { f } = p, whole = ok(writeQuestionPacket(f.store, p.request));
  const outcome = p.obligations.find(item => item.kind !== 'connection-end')!;
  const partial = partResult(p, whole, body => { body.fills = body.fills.filter(fill => fill.obligation !== outcome.id); });
  const sources: GapRequest = { ...f.request.gaps.sources,
    operations: { ...f.request.gaps.sources.operations, proposals: [reference(partial.proposal)] } };
  const applied = ok(prepareFrameProposals(f.store, sources.operations));
  assert.deepEqual(applied.gaps.filter(gap => gap.consumer === p.batch.node).map(gap => gap.target), [outcome.id]);
  const gaps = ok(writeGaps(f.store, sources));
  const taskRequest: QuestionTaskRequest = { ...f.request, gaps: { sources, records: gaps.records.map(reference) },
    questions: f.request.questions.map(item => ({ ...item, gap: reference(gaps.records.find(record => record.id === item.gap.id)!) })) };
  const tasks = ok(prepareQuestionTasks(f.store, taskRequest));
  const routes = ok(writeRoutes(f.store, { project: f.project, gaps: taskRequest.gaps,
    tasks: tasks.tasks.map(task => ({ pending: clone(task.writes[0]!) as Write })), catalog: { paths: [], records: [] }, previous: reference(p.routes) }));
  const batch = routes.value.batches.find(batch => batch.node === p.batch.node)!;
  assert.deepEqual(batch.items.map(item => item.target), [outcome.id]);
  const request: QuestionPacketRequest = { ...p.request, routes: reference(routes), batch: batch.id };
  const ready = ok(writeQuestionPacket(f.store, request)).record;
  assert.equal(ready.value.state, 'ready'); assert.deepEqual(ready.value.plan!.assignments, [{ connector: null, obligations: [outcome.id] }]);
  const expansion = (ready.value.packet as Record<string, any>).expansion;
  assert.deepEqual(expansion.assigned, [outcome.id]); assert.deepEqual(expansion.connections, []);
  assert.equal(expansion.obligations.length, p.obligations.length, 'The full upper obligations remain context, including already filled connections');
  const environment = p.environment(ready.value.fingerprint!.chars - 1);
  const blocked = ok(writeQuestionPacket(f.store, { ...request, environment: reference(environment) })).record;
  assert.equal(blocked.value.state, 'blocked'); assert.equal(blocked.value.refusal?.code, 'node_unexpandable');
  assert.deepEqual(blocked.value.plan!.assignments, [{ connector: null, obligations: [outcome.id] }]);
});

for (const model of ['MC1', 'MC2'] as const) {
  test(`E2 ${model} binds every routed assignment to the declared goal result and consumer before any writes`, async t => {
    for (const defect of ['questions', 'result', 'consumer', 'missing-question'] as const) await t.test(defect, t => {
      const p = model === 'MC1' ? packetFixture(t, 100_000, gardenGraph(), true, true) : expansionFixture(t);
      const { f } = p;
      const block = defect === 'consumer' ? 'garden-later-block' : p.block;
      let ordinal = 1;
      if (block === p.block) {
        ok(completeAttempt(f.store, { project: f.project, block, line: 1, attempt: 1,
          outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } }));
        ordinal = 2;
      } else {
        ok(openSeries(f.store, { project: f.project, block, line: 1, slice: 'other-consumer', predecessor: null, basis: null }));
      }
      const goal: AttemptGoal = { ...p.goal,
        ...(defect === 'questions' ? { questions: ['different-question'] } : {}),
        ...(defect === 'missing-question' ? { questions: p.goal.questions.slice(1) } : {}),
        ...(defect === 'result' ? { result: 'Unrelated result' } : {}) };
      assert.ok(goal.questions.length);
      const series = ok(beginAttempt(f.store, { project: f.project, block, line: 1, attempt: ordinal, goal }));
      const request: QuestionPacketRequest = { ...p.request, attempt: { series: reference(series), ordinal } };
      const before = snapshot(f.store);
      for (const action of [prepareQuestionPacket, writeQuestionPacket])
        rejected(action(f.store, request), 'packet_attempt_invalid');
      assert.deepEqual(snapshot(f.store), before, 'A foreign goal creates neither a packet nor native questions or a result');
    });
  });

  test(`E2 ${model} rechecks the historical goal link after a rehashed packet substitution and restart`, t => {
    const p = model === 'MC1' ? packetFixture(t, 100_000, gardenGraph(), true, true) : expansionFixture(t);
    const { f } = p;
    const saved = ok(writeQuestionPacket(f.store, p.request));
    const part = model === 'MC2' ? partResult(p as ReturnType<typeof expansionFixture>, saved) : null;
    ok(completeAttempt(f.store, { project: f.project, block: p.block, line: 1, attempt: 1,
      outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } }));
    const wrong = ok(beginAttempt(f.store, { project: f.project, block: p.block, line: 1, attempt: 2,
      goal: { ...p.goal, result: 'Unrelated result' } }));
    const request: QuestionPacketRequest = { ...p.request, attempt: { series: reference(wrong), ordinal: 2 } };
    const value = clone(saved.record.value) as QuestionPacketRecord;
    value.request = request;
    const payload = value.packet as Record<string, Json>;
    const requestId = hashJson({ protocol: PACKET_ANSWER_PROTOCOL, request });
    payload.requestId = requestId;
    (payload.responseForm as Record<string, Json>).requestId = requestId;
    value.fingerprint = { hash: hashJson(payload), chars: canonical(payload).length, utf8Bytes: Buffer.byteLength(canonical(payload)) };
    value.fullChars = canonical(payload).length;
    const forged = f.store.write({ id: `om-question-packet:${f.project}:${requestId}`,
      kind: 'question-packet', expected: 0, value: value as unknown as Json });
    const partRequest = part ? { ...part.request, packet: reference(forged) } : null;
    const forgedPart = part && partRequest ? f.store.write({ id: `om-part-result:${f.project}:${hashJson(partRequest)}`,
      kind: 'part-result', expected: 0, value: { ...clone(part.record.value), request: partRequest } }) : null;
    f.restart();
    assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(saved.record) })), saved.record,
      'The exact valid historical attempt remains readable after later attempts');
    const before = snapshot(f.store);
    rejected(readQuestionPacket(f.store, { project: f.project, record: reference(forged) }), 'packet_attempt_invalid');
    if (part && forgedPart) {
      assert.deepEqual(ok(readPartResult(f.store, { project: f.project, record: reference(part.record) })).record, part.record);
      rejected(readPartResult(f.store, { project: f.project, record: reference(forgedPart) }), 'packet_attempt_invalid');
    }
    assert.deepEqual(snapshot(f.store), before);
  });
}

test('E2 native MC1 answers are accepted by D5 for the same declared packet goal and survive restart', async t => {
  const p = packetFixture(t, 100_000, gardenGraph(), true, true), { f } = p;
  const command = { executable: process.execPath, args: ['-e',
    `const req=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{verdict:'supported',reasons:[]}}));`] };
  const environment = f.engine.environments.configure(f.project, { workspace: f.root,
    implementer: { actor: 'packet-researcher', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'packet-assessor', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: 100_000 }, p.configured.revision);
  const packet = ok(writeQuestionPacket(f.store, { ...p.request, environment: reference(environment) })).record;
  const values: Record<string, string> = { encoding: 'UTF-8', 'output-format': 'JSON' };
  writeFileSync(join(f.root, 'facts.json'), JSON.stringify(values));
  const source = f.engine.discovery.evidence.file(f.project, 'packet-facts', f.root, 'facts.json', 'application/json', 0);
  const accepting: Ref[] = [];
  assert.equal(packet.value.native.length, 2, 'Compatible facts share a single packet and one attempt');
  for (const native of packet.value.native) {
    const issued = f.store.get<Question>(native.engineQuestion.id, native.engineQuestion.revision)!;
    const gap = f.store.get<GapRecord>(native.gap.id, native.gap.revision)!.value.gap;
    const key = gap.target.slice('discovery:'.length), value = values[key]!;
    const assessment = await assessAnswer(f.store, issued, { action: 'answer', question: issued.id, value,
      citations: [{ source: reference(source), selector: { kind: 'json-pointer', pointer: `/${key}` } }] }, environment, f.root);
    const draft = f.engine.discovery.researched(issued.id, issued.revision, reference(assessment));
    const answered = f.store.get<Question>(issued.id)!;
    const accepted = ok(writeAcceptedAnswer(f.store, { project: f.project, question: native.question,
      answer: answered.value.answer!, answeredQuestion: reference(answered), draft: reference(draft),
      attempt: { series: reference(p.series), attempt: 1 } }));
    accepting.push(reference(accepted));
    const checked = ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(accepted) }));
    assert.deepEqual(checked.attempt, { series: reference(p.series), ordinal: 1, block: p.block, goal: p.goal });
  }
  const request = { project: f.project, block: p.block, target: p.series.id, goal: p.goal, accepting, cancelling: [] };
  const confirmed = ok(confirmResults(f.store, request));
  assert.equal(confirmed.achieved.length, 2);
  f.restart();
  assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(packet) })), packet);
  for (const record of accepting) {
    const checked = ok(readAcceptedAnswer(f.store, { project: f.project, record }));
    assert.deepEqual(checked.attempt!.series, reference(p.series));
    assert.deepEqual(checked.attempt!.goal, p.goal);
  }
  assert.deepEqual(ok(confirmResults(f.store, request)), confirmed);
});

test('E2 reaches both real fact batches with different consumers using their own declared series', t => {
  const p = packetFixture(t), { f } = p;
  const batches = p.routes.value.batches.filter(batch => batch.model === 'MC1');
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.flatMap(batch => batch.items.map(item => item.target)).sort(), ['discovery:encoding', 'discovery:output-format']);
  const packets: Ref[] = [];
  for (const batch of batches) {
    assert.equal(batch.items.length, 1);
    const item = batch.items[0]!;
    assert.equal(item.consumers.length, 1);
    const block = item.consumers[0]!;
    let series = p.series;
    if (block !== p.block) {
      const goal: AttemptGoal = { key: 'packet:other-consumer', questions: [gapLineKey(f.project, item.target, item.field)],
        result: gapLineExpectedResult(f.project, item.target, item.field) };
      ok(openSeries(f.store, { project: f.project, block, line: 1, slice: 'packet-other-fact', predecessor: null, basis: null }));
      series = ok(beginAttempt(f.store, { project: f.project, block, line: 1, attempt: 1, goal }));
    }
    const request: QuestionPacketRequest = { ...p.request, batch: batch.id, attempt: { series: reference(series), ordinal: 1 } };
    const saved = ok(writeQuestionPacket(f.store, request));
    assert.equal(saved.record.value.state, 'ready');
    assert.equal(saved.record.value.native.length, 1);
    assert.deepEqual((saved.record.value.packet as Record<string, any>).questions.map((q: { target: string }) => q.target), [item.target]);
    packets.push(reference(saved.record));
  }
  f.restart();
  for (const record of packets) assert.deepEqual(reference(ok(readQuestionPacket(f.store, { project: f.project, record }))), record);
});

test('E2 admits an MC2 missing input field with a proven block consumer under the common line-result goal', t => {
  const p = packetFixture(t), { f } = p;
  const batch = p.routes.value.batches.find(batch => batch.task === 'input-field'
    && batch.items.every(item => item.consumers.length > 0))!;
  assert.ok(batch, 'The native first pass contains missing structured fields with block consumers');
  const block = batch.items[0]!.consumers[0]!;
  assert.ok(batch.items.every(item => item.consumers.includes(block)));
  let ordinal = 1;
  if (block === p.block) {
    ok(completeAttempt(f.store, { project: f.project, block, line: 1, attempt: 1,
      outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } }));
    ordinal = 2;
  } else ok(openSeries(f.store, { project: f.project, block, line: 1, slice: 'input-field', predecessor: null, basis: null }));
  const goal: AttemptGoal = { key: 'input-field', questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  const series = ok(beginAttempt(f.store, { project: f.project, block, line: 1, attempt: ordinal, goal }));
  const request: QuestionPacketRequest = { ...p.request, batch: batch.id, attempt: { series: reference(series), ordinal } };
  const ready = ok(writeQuestionPacket(f.store, request)).record;
  assert.equal(ready.value.state, 'ready'); assert.equal(ready.value.plan, null); assert.deepEqual(ready.value.native, []);
  const payload = ready.value.packet as Record<string, Json>;
  assert.equal(payload.task, 'input-field'); assert.equal(Object.hasOwn(payload, 'expansion'), false);
  const environment = p.environment(ready.value.fingerprint!.chars - 1);
  const blocked = ok(writeQuestionPacket(f.store, { ...request, environment: reference(environment) })).record;
  assert.equal(blocked.value.state, 'blocked'); assert.equal(blocked.value.refusal?.code, 'packet_too_large');
  f.restart();
  assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(ready) })), ready);
  assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(blocked) })), blocked);
});

test('E2 work expansion belongs to its proven consumer block rather than the upper operation id', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-e2-work-goal-')), database = join(root, 'state.sqlite'), project = 'garden';
  let store = new Store(database);
  const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'README.md'), 'A deterministic garden product for typed refinement tests.\n');
  const desired = gardenGraph(), { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph);
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const input = ok(writeOmInput(store, { project, expected: 0, stages }));
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'fixture-researcher', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'fixture-assessor', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000, requestCapacityChars: 100_000 }, 0);
  const r0 = engine.refinement.begin(project, 'R0');
  engine.refinement.finishResearch(project, 'R0', reference(r0), 0); engine.refinement.sealLayer(project, 1, 0);
  const r1 = engine.refinement.begin(project, 'R1'); answerTechnicalFixture(engine, project, r1);
  engine.refinement.finishResearch(project, 'R1', reference(store.get(r1.id)!), 0);
  const design = engine.refinement.prepareLayer(project, 2), answered = answerLayerFixture(engine, project, design, 2, desired);
  const graph = engine.refinement.buildLayer(project, 2, reference(answered), store.get(`graph:${project}`)!.revision, 'fixture-researcher');
  const layer = engine.refinement.sealLayer(project, 2, 0);
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: reference(layer), available: {},
    choice: { choiceVersion: 'e2-first-work-pass', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate),
      layer: reference(store.get(`graph-layer:${project}:2`)!), frame: null, upper: null } },
    works: { proposals: [], frame: { project, level: 3, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: { horizon: reference(horizon.gate), frame: null } } } };
  const gaps = ok(writeGaps(store, sources));
  const routes = ok(writeRoutes(store, { project, gaps: { sources, records: gaps.records.map(reference) }, tasks: [],
    catalog: { paths: [], records: [] }, previous: null }));
  const batch = routes.value.batches.find(batch => batch.level === 3 && batch.node === 'garden-produce-operation')!;
  assert.ok(batch);
  assert.ok(batch.items.every(item => canonical(item.consumers) === canonical(['garden-produce-block'])));
  const goal: AttemptGoal = { key: 'e2-work-node-goal', questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  let acceptedPacket: Ref | null = null;
  for (const block of ['garden-produce-block', batch.node!]) {
    ok(openSeries(store, { project, block, line: 1, slice: 'e2-work-node-goal', predecessor: null, basis: null }));
    const series = ok(beginAttempt(store, { project, block, line: 1, attempt: 1, goal }));
    const request: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(environment),
      attempt: { series: reference(series), ordinal: 1 }, previous: [] };
    const before = snapshot(store), prepared = prepareQuestionPacket(store, request);
    assert.deepEqual(snapshot(store), before);
    if (block === 'garden-produce-block') {
      assert.equal(ok(prepared).record.value.state, 'ready');
      acceptedPacket = reference(ok(writeQuestionPacket(store, request)).record);
    } else {
      rejected(prepared, 'packet_attempt_invalid'); rejected(writeQuestionPacket(store, request), 'packet_attempt_invalid');
      assert.deepEqual(snapshot(store), before);
    }
  }
  store.close(); store = new Store(database);
  assert.ok(acceptedPacket);
  assert.equal(ok(readQuestionPacket(store, { project, record: acceptedPacket })).value.state, 'ready');
});

test('E2 declares every new content and control branch before dispatch and shares its exact reply parser', t => {
  const p = expansionFixture(t), { f } = p, packet = ok(writeQuestionPacket(f.store, p.request)).record;
  const payload = packet.value.packet as Record<string, any>, before = snapshot(f.store);
  assert.equal(packet.value.answerProtocol, PACKET_ANSWER_PROTOCOL);
  assert.equal(payload.version, 'om-question-packet/v2');
  const form = payload.responseForm;
  assert.deepEqual(form.schema.oneOf.map((branch: any) => branch.properties.action.const),
    ['answer', 'need_source', 'need_owner', 'cannot_answer', 'pause']);
  assert.equal(packet.id, `om-question-packet:${f.project}:${hashJson({ protocol: PACKET_ANSWER_PROTOCOL, request: p.request })}`);
  assert.equal(payload.requestId, hashJson({ protocol: PACKET_ANSWER_PROTOCOL, request: p.request }));
  const questionIds = [payload.questions[0].id];
  const controls = [
    { action: 'need_source', questionIds, missing: 'Read the addressed source', reads: [
      { action: 'read', path: 'src/format.ts', media: 'text/plain' },
      { action: 'read_source', source: reference(f.store.get(`source:${f.project}:brief`)!), selector: { kind: 'text-range', start: 0, end: 1 } },
      { action: 'read_context', record: reference(f.input), pointer: '/input/contracts/0' },
      { action: 'search', within: 'src', query: 'format' },
    ] },
    { action: 'need_owner', questionIds, reason: 'The choice is not set', decision: 'Which encoding is required?' },
    { action: 'cannot_answer', questionIds, reason: 'No evidence' },
    { action: 'pause', questionIds, reason: 'Stop this attempt' },
  ];
  for (const answer of controls) {
    const raw: string = JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId: payload.requestId, ...answer });
    const actual = ok(readPacketAnswer(f.store, { project: f.project, packet: reference(packet), raw })).answer;
    assert.deepEqual(actual, { ...answer, ...('reads' in answer
      ? { reads: [...answer.reads!].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0) } : {}) });
    rejected(derivePartProposal(f.store, { project: f.project, packet: reference(packet), raw }), 'part_answer_invalid');
  }
  for (const bad of [
    { ...controls[0], questionIds: ['foreign-question'] },
    { ...controls[0], questionIds: [] },
    { ...controls[0], questionIds: [...questionIds, ...questionIds] },
    { ...controls[0], missing: ' ' },
    { ...controls[0], reads: [{ action: 'search', query: 'everything' }] },
    { ...controls[0], reads: [{ action: 'shell', command: 'cat **/*' }] },
    { ...controls[1], proposal: {} },
    { ...controls[2], status: 'accepted' },
    { ...controls[3], action: 'read_plan' },
  ]) rejected(readPacketAnswer(f.store, { project: f.project, packet: reference(packet),
    raw: JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId: payload.requestId, ...bad }) }), 'part_answer_invalid');
  rejected(readPacketAnswer(f.store, { project: f.project, packet: reference(packet),
    raw: JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId: 'foreign-request', ...controls[2] }) }), 'part_result_invalid');
  assert.deepEqual(snapshot(f.store), before, 'Parsing and content derivation create no calls, records or series outcomes');
});

test('E2 counts the added response branches in capacity and never silently emits the former smaller form', t => {
  const p = packetFixture(t), { f } = p, prepared = ok(prepareQuestionPacket(f.store, p.request));
  const payload = clone(prepared.record.value.packet) as Record<string, any>;
  const currentChars = canonical(payload).length;
  const legacy = { ...payload, responseForm: { results: 'One result per question id', value: 'The question contract resultForm',
    citations: 'Exact source reference and text-range or JSON-pointer selector' } };
  assert.ok(canonical(legacy).length < currentChars - 1);
  const environment = p.environment(currentChars - 1), before = snapshot(f.store);
  const blocked = ok(prepareQuestionPacket(f.store, { ...p.request, environment: reference(environment) }));
  assert.equal(blocked.record.value.state, 'blocked');
  assert.equal(blocked.record.value.refusal?.code, 'packet_too_large');
  assert.ok(blocked.record.value.fullChars! > environment.value.requestCapacityChars!);
  assert.deepEqual(blocked.record.value.native, []);
  assert.deepEqual(snapshot(f.store), before);
});

test('E2 common proposal derivation checks assignment without inventing response provenance', t => {
  const p = expansionFixture(t), { f } = p, saved = ok(writeQuestionPacket(f.store, p.request));
  const actual = partResult(p, saved), before = snapshot(f.store);
  const request = { project: f.project, packet: reference(saved.record), raw: actual.response.value.raw };
  const derived = ok(derivePartProposal(f.store, request));
  assert.deepEqual(derived.proposal, actual.proposal.value);
  assert.ok(!Object.hasOwn(derived, 'call') && !Object.hasOwn(derived, 'record'));
  const parsed = JSON.parse(request.raw);
  parsed.proposal.fills[0].obligation = 'foreign-obligation';
  rejected(derivePartProposal(f.store, { ...request, raw: JSON.stringify(parsed) }), 'part_result_invalid');
  const noCall = { id: 'call-record:garden:unissued', revision: 1, hash: '0'.repeat(64) };
  const attempted = preparePartResult(f.store, { ...actual.request, call: noCall });
  assert.equal(attempted.ok, false, 'Well-shaped content cannot substitute for the full admitted-call chain');
  assert.deepEqual(snapshot(f.store), before);
});

test('E2 preserves original packet and part-result history strictly in its old answer era after restart', t => {
  const p = expansionFixture(t), { f } = p;
  const modern = ok(writeQuestionPacket(f.store, p.request)).record;
  const value = clone(modern.value) as QuestionPacketRecord;
  delete value.answerProtocol;
  const payload = value.packet as Record<string, Json>, requestId = hashJson(p.request);
  payload.version = 'om-question-packet/v1'; payload.requestId = requestId;
  payload.responseForm = { protocol: 'omg-part/v1', requestId, proposal: clone(PART_PROPOSAL_SCHEMA) as unknown as Json };
  value.fullChars = canonical(payload).length;
  value.fingerprint = { hash: hashJson(payload), chars: canonical(payload).length, utf8Bytes: Buffer.byteLength(canonical(payload)) };
  const packet = f.store.write<QuestionPacketRecord>({ id: `om-question-packet:${f.project}:${requestId}`, kind: 'question-packet', expected: 0, value });
  assert.notEqual(modern.id, packet.id);
  assert.notEqual((modern.value.packet as Record<string, Json>).requestId, requestId);
  assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(packet) })), packet);
  const modernPart = partResult(p, ok(writeQuestionPacket(f.store, p.request)));
  const raw = JSON.stringify({ protocol: 'omg-part/v1', requestId, proposal: modernPart.body });
  const proposalValue = ok(derivePartProposal(f.store, { project: f.project, packet: reference(packet), raw })).proposal;
  const prior = modernPart.call.value;
  const admission = ok(recordCall(f.store, f.project, { call: requestId, purpose: prior.purpose, basis: prior.basis,
    block: prior.block, gaps: clone(prior.gaps), series: prior.series, attempt: prior.attempt, goal: clone(prior.goal),
    dispatch: clone(prior.dispatch), packet: payload })).call;
  const response = f.store.write<PartResponseRecord>({ id: partResponseId(f.project, reference(admission)), kind: 'part-response', expected: 0,
    value: { project: f.project, packet: reference(packet), call: reference(admission), requestId, raw } });
  const request = { project: f.project, packet: reference(packet), call: reference(admission), response: reference(response) }, key = hashJson(request);
  const proposal = f.store.write<LayerProposal>({ id: `om-proposal:${f.project}:part:${key}`, kind: 'layer-proposal', expected: 0,
    value: proposalValue as LayerProposal });
  const result = f.store.write({ id: `om-part-result:${f.project}:${key}`, kind: 'part-result', expected: 0,
    value: { project: f.project, request, proposal: reference(proposal) } });
  assert.deepEqual(ok(readPartResult(f.store, { project: f.project, record: reference(result) })).proposal, proposal);
  f.restart();
  const before = snapshot(f.store);
  assert.deepEqual(ok(readQuestionPacket(f.store, { project: f.project, record: reference(packet) })), packet);
  assert.deepEqual(ok(readPartResult(f.store, { project: f.project, record: reference(result) })).proposal, proposal);
  rejected(readPacketAnswer(f.store, { project: f.project, packet: reference(packet),
    raw: JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId, action: 'pause',
      questionIds: [(payload.questions as Record<string, Json>[])[0]!.id], reason: 'New control' }) }), 'part_result_invalid');
  const changed = clone(value); changed.answerProtocol = PACKET_ANSWER_PROTOCOL;
  const wrong = f.store.write({ id: `${packet.id}:changed-era`, kind: 'question-packet', expected: 0, value: changed as unknown as Json });
  rejected(readQuestionPacket(f.store, { project: f.project, record: reference(wrong) }), 'packet_record_invalid');
  assert.equal(snapshot(f.store).length, before.length + 1);
});

test('E2 normalizes reply sets while preserving duplicate results citations reads and literal value arrays', t => {
  const p = packetFixture(t, 100_000, gardenGraph(), true, true, { type: 'array', items: { type: 'string' } }), { f } = p;
  const packet = ok(writeQuestionPacket(f.store, p.request)).record, payload = packet.value.packet as Record<string, any>;
  const source = reference(f.store.get(`source:${f.project}:brief`)!);
  const a = { source, selector: { kind: 'text-range', start: 0, end: 1 } };
  const b = { source, selector: { kind: 'text-range', start: 1, end: 2 } };
  const rows = payload.questions.map((question: { id: string }) => ({ questionId: question.id,
    value: ['second', 'first', 'second'], citations: [b, a, b] }));
  const parse = (body: unknown) => ok(readPacketAnswer(f.store, { project: f.project, packet: reference(packet),
    raw: JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId: payload.requestId, ...body as object }) })).answer;
  const initial = parse({ action: 'answer', results: [rows[0], rows[1], rows[0]] });
  const permuted = parse({ action: 'answer', results: [rows[1], rows[0], rows[0]].map(row => ({ ...row, citations: [...row.citations].reverse() })) });
  assert.deepEqual(permuted, initial);
  assert.ok(initial.action === 'answer' && 'results' in initial);
  assert.equal(initial.results.length, 3, 'Repeated results are left for E3 coverage rejection');
  for (const row of initial.results) {
    assert.deepEqual(row.value, ['second', 'first', 'second']);
    assert.ok('citations' in row);
    assert.equal(row.citations.length, 3);
    assert.equal(row.citations.filter(citation => canonical(citation) === canonical(b)).length, 2);
  }
  const questionIds = payload.questions.map((question: { id: string }) => question.id);
  const read = { action: 'read', path: 'src/Second/First.ts', media: 'text/plain' };
  const search = { action: 'search', within: 'src/Two', query: 'b a b' };
  const request = { action: 'need_source', questionIds, missing: 'Need these addressed facts', reads: [search, read, search] };
  const control = parse(request);
  assert.deepEqual(parse({ ...request, questionIds: [...questionIds].reverse(), reads: [...request.reads].reverse() }), control);
  assert.ok(control.action === 'need_source');
  assert.equal(control.reads.length, 3);
  assert.equal(control.reads.filter(item => canonical(item) === canonical(search)).length, 2);
  assert.ok(control.reads.some(item => item.action === 'read' && item.path === read.path));
  rejected(readPacketAnswer(f.store, { project: f.project, packet: reference(packet), raw: JSON.stringify({
    protocol: PACKET_ANSWER_PROTOCOL, requestId: payload.requestId, ...request, questionIds: [questionIds[0], questionIds[0]] }) }), 'part_answer_invalid');
});


test('E2 answer schema selection refuses missing null and unknown runtime kinds', () => {
  for (const kind of [undefined, null, 'unknown', 'toString']) {
    assert.throws(() => packetAnswerSchema(kind as never), error => {
      assert.ok(malformed(error));
      assert.equal(((error as EngineError).details as { field: string }).field, 'answer.schema');
      return true;
    });
  }
  for (const kind of ['node', 'fact', 'field'] as const) assert.ok(packetAnswerSchema(kind));
});
