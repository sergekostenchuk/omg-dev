import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { answerContractFingerprint, mc1FieldSpec, prepareMc1Question, readMc1Question, writeMc1Question,
  prepareAcceptedAnswer, writeAcceptedAnswer, readAcceptedAnswer, applicableAnswer, confirmAnswerGapClosure,
  confirmAcceptedAnswerResult, ANSWER_REFUSAL_CODES, type AnswerQuestionContract, type Mc1QuestionRequest, type AnswerRequest } from '../src/om/accepted-answer.js';
import { Store, type Write } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { Question } from '../src/discovery/discovery.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { writeOmInput } from '../src/om/input.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import type { ResearchAnswer, ResearchAssessment } from '../src/discovery/research-model.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { gapLineKey, gapLineExpectedResult, writeGapLines, prepareGapLines, type GapLinesRequest } from '../src/om/gap-lines.js';
import { writeGuarded } from '../src/om/refs.js';
import { openSeries, readSeries } from '../src/om/series.js';
import { openAttempt, closeAttempt } from '../src/om/repeat-gate.js';
import { confirmResults } from '../src/om/achievements.js';
import type { OmResult } from '../src/om/refusal.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

const clone = structuredClone;
function contract(): AnswerQuestionContract {
  return {
    establishes: 'The repository supports JSON output',
    consumer: { node: 'garden-produce', field: 'output' },
    requirements: [{ id: 'output', statement: 'Return valid JSON' }, { id: 'transport', mode: 'buffered' }],
    resultForm: { type: 'object', properties: { supported: { type: 'boolean' } }, required: ['supported'] },
  };
}
function invalid(value: unknown, field: string): void {
  assert.throws(() => answerContractFingerprint(value as AnswerQuestionContract), (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'answer_contract_invalid');
    assert.deepEqual(error.details, { unit: 'D5', target: 'question-contract', field });
    return true;
  });
}

test('D5 fingerprints all four parts of the question contract, including JSON versus streaming JSON', () => {
  const original = contract(), fingerprint = answerContractFingerprint(original);
  const changes: ((value: AnswerQuestionContract) => void)[] = [
    value => { value.establishes = 'The repository supports streaming JSON output'; },
    value => { value.consumer = { node: 'garden-consume', field: 'output' }; },
    value => { value.requirements[1] = { id: 'transport', mode: 'streaming' }; },
    value => { value.resultForm = { type: 'string' }; },
  ];
  for (const change of changes) {
    const changed = clone(original); change(changed);
    assert.notEqual(answerContractFingerprint(changed), fingerprint);
  }
  assert.equal(answerContractFingerprint(clone(original)), fingerprint);
});

test('D5 contract normalization preserves multiplicity and nested array order without mutating its caller', () => {
  const original = contract(), before = canonical(original), changed = clone(original);
  changed.requirements.reverse();
  assert.equal(answerContractFingerprint(changed), answerContractFingerprint(original));
  changed.requirements.push(clone(original.requirements[0]!));
  assert.notEqual(answerContractFingerprint(changed), answerContractFingerprint(original));
  const ordered = contract(); ordered.resultForm = { type: 'array', examples: [['first', 'second']] };
  const reversed = clone(ordered); reversed.resultForm = { type: 'array', examples: [['second', 'first']] };
  assert.notEqual(answerContractFingerprint(ordered), answerContractFingerprint(reversed));
  const paths = contract(); paths.requirements = [{ path: ['first', 'second'] }];
  const swapped = clone(paths); swapped.requirements = [{ path: ['second', 'first'] }];
  assert.notEqual(answerContractFingerprint(paths), answerContractFingerprint(swapped));
  assert.equal(canonical(original), before);
  assert.equal(Object.isFrozen(original), false);
  assert.equal(Object.isFrozen(original.requirements), false);
});

test('D5 contract fingerprint rejects absent parts and non-JSON data with an addressed module error', () => {
  for (const malformed of [undefined, null, [], true, 42, 'contract']) invalid(malformed, 'contract');
  for (const field of ['establishes', 'consumer', 'requirements', 'resultForm'] as const) {
    const missing = clone(contract()) as unknown as Record<string, unknown>; delete missing[field];
    invalid(missing, field);
    for (const value of [undefined, NaN, () => null, new Date(), { nested: undefined }])
      invalid({ ...contract(), [field]: value }, field);
  }
  invalid({ ...contract(), establishes: ' ' }, 'establishes');
  for (const requirements of [null, {}, 'requirements']) invalid({ ...contract(), requirements }, 'requirements');
  invalid({ ...contract(), unrelatedInput: 'ignored' }, 'contract');
  const cycle: Record<string, unknown> = {}; cycle['self'] = cycle;
  invalid({ ...contract(), consumer: cycle }, 'consumer');
  invalid({ ...contract(), requirements: new Array(1) }, 'requirements');
  invalid(Object.create(contract()), 'establishes');
});

test('D5 contract fingerprint retains own __proto__ keys and explicit empty values', () => {
  const original = contract();
  original.resultForm = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}') as Json;
  const empty = clone(original); empty.resultForm = { type: 'object', properties: {} };
  assert.notEqual(answerContractFingerprint(original), answerContractFingerprint(empty));
  const nullValue = contract(); nullValue.consumer = { extra: null };
  const absent = clone(nullValue); absent.consumer = {};
  assert.notEqual(answerContractFingerprint(nullValue), answerContractFingerprint(absent));
  assert.equal(answerContractFingerprint(JSON.parse(canonical(original)) as AnswerQuestionContract), answerContractFingerprint(original));
});

function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}

function rejected(result: OmResult<unknown>, code?: string): string {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('Expected an addressed refusal');
  if (code) assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target);
  if ((ANSWER_REFUSAL_CODES as readonly string[]).includes(result.refusal.code) && result.refusal.at.unit === 'D5') assert.ok(result.refusal.at.field);
  return result.refusal.code;
}

function factFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-accepted-fact-')), path = join(root, 'state.sqlite');
  let store = new Store(path), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = 'garden', block = 'garden-produce-block', target = 'discovery:output-format';
  const { level: _level, ...l1 } = projectGraph(gardenGraph(), 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'output-format',
      question: 'Which output format does the repository support?', consumer: block,
      blocksCurrentStage: false, resolution: 'Read repository facts during OM' }];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph), decisions: [{ pending:
    clone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target, field: 'address', value: { consumer: block, kind: 'repository-fact' } } })) as Write }] }));
  function gapsFor(inputRef: Ref) {
    const horizon = ok(writeHorizon(store, { project, input: inputRef, graph: reference(graph), refinement: null, available: {},
      choice: { choiceVersion: `fact-fixture-${inputRef.revision}`, features: [{ outcome: 'garden-result' }], excluded: [] } }));
    const sources: GapRequest = { project, input: inputRef, graph: reference(graph), horizon: reference(horizon.gate),
      operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
      works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
    const gaps = ok(writeGaps(store, sources)), gap = gaps.records.find(row => row.value.gap.target === target)!;
    assert.equal(gap.value.gap.code, 'predecessor_question'); assert.equal(gap.value.gap.kind, 'repository-fact');
    assert.deepEqual(gap.value.gap.routes, ['code', 'research']);
    return { sources, records: gaps.records.map(reference), gap };
  }
  const gaps = gapsFor(reference(input));
  const command = { executable: process.execPath, args: ['-e',
    `const req=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{verdict:'supported',reasons:[]}}));`] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'fact-researcher', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'fact-assessor', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000 }, 0);
  writeFileSync(join(root, 'answer.json'), JSON.stringify({ answer: 'JSON' }));
  const source = engine.discovery.evidence.file(project, 'answer-source', root, 'answer.json', 'application/json', 0);
  function issue(current = gaps, resultForm: Json = { type: 'string' }) {
    const requestContract: AnswerQuestionContract = { establishes: input.value.input.questions[0]!.question,
      consumer: { blocks: [...current.gap.value.gap.consumers] }, requirements: [clone(input.value.input.contracts[0]!) as unknown as Json], resultForm };
    const draft = engine.discovery.create(project, 'om-g2', 'R1', block,
      [mc1FieldSpec({ input: current.sources.input, gap: reference(current.gap), contract: requestContract })], [current.sources.input, reference(current.gap)]);
    const issued = store.get<Question>(draft.value.questions[0]!)!;
    const request: Mc1QuestionRequest = { project, input: current.sources.input, gaps: { sources: current.sources, records: current.records },
      gap: reference(current.gap), contract: requestContract, requirements: [{ pointer: '/contracts/0' }], engineQuestion: reference(issued), draft: reference(draft) };
    const question = ok(writeMc1Question(store, request));
    return { request, question, issued, draft };
  }
  async function answer(q = issue(), attempt: AnswerRequest['attempt'] = null, value: Json = 'JSON') {
    const assessment = await assessAnswer(store, q.issued, { action: 'answer', question: q.issued.id, value,
      citations: [{ source: reference(store.get(source.id)!), selector: { kind: 'json-pointer', pointer: '/answer' } }] }, environment, root);
    const draft = engine.discovery.researched(q.issued.id, q.issued.revision, reference(assessment)), answered = store.get<Question>(q.issued.id)!;
    const request: AnswerRequest = { project, question: reference(q.question), answer: answered.value.answer!,
      answeredQuestion: reference(answered), draft: reference(draft), attempt };
    return { ...q, assessment, answered, answeredDraft: draft, request };
  }
  return { root, project, block, target, stages, input, graph, gaps, source, environment,
    get store() { return store; }, get engine() { return engine; }, issue, answer, gapsFor,
    restart() { store.close(); store = new Store(path); engine = new ProductEngine(store); } };
}

test('D5 accepts a native D3-addressed MC1 fact, rederives history and issues a closure without closing an active D1 gap', async t => {
  const f = factFixture(t), a = await f.answer(), before = f.store.list().map(reference);
  const prepared = ok(prepareAcceptedAnswer(f.store, a.request));
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(prepared.writes.length, 1); assert.ok('pending' in prepared.closure.answer);
  const lineRequest: GapLinesRequest = { project: f.project, pass: 1, previous: null,
    gaps: { sources: f.gaps.sources, records: f.gaps.records }, closures: [] };
  const line = ok(writeGapLines(f.store, lineRequest));
  const next = { ...lineRequest, pass: 2, previous: reference(line), closures: [prepared.closure] };
  rejected(prepareGapLines(f.store, next));
  assert.equal(f.store.get(prepared.record.id), null);
  const saved = ok(writeAcceptedAnswer(f.store, a.request)), checked = ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(saved) }));
  assert.equal(checked.record.value.value, 'JSON'); assert.equal(checked.record.value.grounds[0]!.proofLimit, 'repository-observation');
  assert.equal(saved.hash, hashJson(saved.value)); assert.equal(Object.isFrozen(saved.value.grounds), true);
  assert.deepEqual(ok(writeAcceptedAnswer(f.store, a.request)), saved);
  assert.equal(ok(prepareAcceptedAnswer(f.store, a.request)).writes.length, 0);
  rejected(prepareGapLines(f.store, { ...next, closures: [{ ...prepared.closure, answer: { record: reference(saved) } }] }));
  assert.equal(ok(applicableAnswer(f.store, { project: f.project, record: reference(saved), question: reference(a.question) })).applicable, true);
  const final = f.store.list().map(reference); f.restart();
  assert.deepEqual(ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(saved) })), checked);
  assert.deepEqual(ok(writeAcceptedAnswer(f.store, a.request)), saved); assert.deepEqual(f.store.list().map(reference), final);
});

test('D5 applicability preserves unrelated input refresh but distinguishes changed contracts and current evidence from history', async t => {
  const f = factFixture(t), a = await f.answer(), saved = ok(writeAcceptedAnswer(f.store, a.request));
  const original = ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(saved) }));
  const inventory = f.store.write({ id: 'repo-inventory:garden', kind: 'repo-inventory', expected: 0, value: { projectId: f.project, paths: [] } });
  const refreshed = ok(writeOmInput(f.store, { project: f.project, stages: f.stages, expected: f.input.revision, inventory: reference(inventory) }));
  const gaps = f.gapsFor(reference(refreshed)), next = f.issue(gaps);
  assert.equal(ok(applicableAnswer(f.store, { project: f.project, record: reference(saved), question: reference(next.question) })).applicable, true);
  const different = f.issue(gaps, { type: 'string', description: 'The supported streaming JSON format' });
  assert.equal(ok(applicableAnswer(f.store, { project: f.project, record: reference(saved), question: reference(different.question) })).applicable, false);
  writeFileSync(join(f.root, 'answer.json'), JSON.stringify({ answer: 'streaming JSON' }));
  assert.equal(ok(applicableAnswer(f.store, { project: f.project, record: reference(saved), question: reference(next.question) })).applicable, false);
  assert.deepEqual(ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(saved) })), original);
  writeFileSync(join(f.root, 'answer.json'), JSON.stringify({ answer: 'JSON' }));
  f.engine.discovery.evidence.file(f.project, 'answer-source', f.root, 'answer.json', 'application/json', f.source.revision);
  assert.equal(ok(applicableAnswer(f.store, { project: f.project, record: reference(saved), question: reference(next.question) })).applicable, false);
  const renewed = await f.answer(next), reaccepted = ok(writeAcceptedAnswer(f.store, renewed.request));
  assert.equal(ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(reaccepted) })).key, original.key);
  f.restart();
  assert.deepEqual(ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(saved) })), original);
  assert.equal(ok(applicableAnswer(f.store, { project: f.project, record: reference(saved), question: reference(next.question) })).applicable, false);
  assert.equal(ok(applicableAnswer(f.store, { project: f.project, record: reference(reaccepted), question: reference(next.question) })).applicable, true);
});

test('D5 provider confirms the recorded attempt and G7 counts new fact content once across reconfirmation and A to B to A', async t => {
  const f = factFixture(t), address = { project: f.project, block: f.block, line: 1 };
  const goal = { key: 'output-fact', questions: [gapLineKey(f.project, f.target, 'answer'), 'other-goal-question'],
    result: gapLineExpectedResult(f.project, f.target, 'answer') };
  ok(openSeries(f.store, { ...address, slice: 'fact-slice', predecessor: null, basis: null }));
  const keys: string[] = [], accepted: Ref[] = [];
  for (const [index, value] of ['JSON', 'JSON', 'streaming JSON', 'JSON'].entries()) {
    const ordinal = index + 1, attempt = ok(openAttempt(f.store, { ...address, attempt: ordinal, goal }));
    if (index) {
      writeFileSync(join(f.root, 'answer.json'), JSON.stringify({ answer: value }));
      const prior = f.store.get(f.source.id)!;
      f.engine.discovery.evidence.file(f.project, 'answer-source', f.root, 'answer.json', 'application/json', prior.revision);
    }
    const a = await f.answer(f.issue(), { series: reference(attempt), attempt: ordinal }, value);
    const saved = ok(writeAcceptedAnswer(f.store, a.request)); accepted.push(reference(saved));
    const request = { project: f.project, block: f.block, target: attempt.id, goal, accepting: [reference(saved)], cancelling: [] };
    const confirmed = ok(confirmResults(f.store, request)); keys.push(confirmed.achieved[0]!.key);
    assert.deepEqual(ok(confirmResults(f.store, { ...request, goal: { ...goal, questions: [...goal.questions].reverse() } })), confirmed);
    for (const changed of [{ ...request, block: 'garden-consume-block' }, { ...request, goal: { ...goal, key: 'another-goal' } }])
      rejected(confirmResults(f.store, changed), 'achievement_unconfirmed');
    rejected(confirmResults(f.store, { ...request, accepting: [a.request.answer] }), 'achievement_unconfirmed');
    rejected(confirmResults(f.store, { ...request, accepting: [], cancelling: [reference(saved)] }), 'cancellation_unconfirmed');
    const closed = ok(closeAttempt(f.store, { ...address, attempt: ordinal, outcome: { reason: 'result', accepting: [reference(saved)], cancelling: [], refusals: [] } }));
    assert.equal(closed.verdict, index === 0 || index === 2 ? 'progress' : 'none');
  }
  assert.equal(keys[0], keys[1]); assert.notEqual(keys[0], keys[2]); assert.equal(keys[0], keys[3]);
  const state = ok(readSeries(f.store, address));
  f.restart();
  for (const [index, record] of accepted.entries()) assert.equal(ok(readAcceptedAnswer(f.store, { project: f.project, record })).key, keys[index]);
  const repeat = ok(closeAttempt(f.store, { ...address, attempt: 1, outcome: { reason: 'result', accepting: [accepted[0]!], cancelling: [], refusals: [] } }));
  assert.equal(repeat.verdict, 'progress'); assert.deepEqual(f.store.get(state.id), state);
});

test('D5 current guards abort new acceptance and existing reuse atomically with a neighbour', async t => {
  const f = factFixture(t), a = await f.answer(), prepared = ok(prepareAcceptedAnswer(f.store, a.request));
  const row = f.store.get(a.assessment.id)!;
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(row))));
  f.store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
  const before = f.store.list().map(reference);
  rejected(writeGuarded(f.store, { unit: 'D5-test', target: f.target, guards: prepared.guards,
    writes: [...prepared.writes, { id: 'neighbour:fact:first', kind: 'test-neighbour', expected: 0, value: {} }] }), 'input_stale');
  rejected(prepareAcceptedAnswer(f.store, a.request), 'input_stale'); rejected(writeAcceptedAnswer(f.store, a.request), 'input_stale');
  assert.deepEqual(f.store.list().map(reference), before);
  const b = await f.answer(), saved = ok(writeAcceptedAnswer(f.store, b.request)), existing = ok(prepareAcceptedAnswer(f.store, b.request));
  assert.deepEqual(existing.writes, []);
  const source = f.store.get(f.source.id)!;
  assert.ok(existing.guards.some(ref => canonical(ref) === canonical(reference(source))));
  f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  rejected(writeGuarded(f.store, { unit: 'D5-test', target: f.target, guards: existing.guards,
    writes: [{ id: 'neighbour:fact:existing', kind: 'test-neighbour', expected: 0, value: {} }] }), 'input_stale');
  assert.equal(f.store.get('neighbour:fact:existing'), null);
  f.restart(); ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(saved) }));
});

test('D5 rejects another coherent answer chain, unsupported assessments, counterfeit citations and altered accepted content', async t => {
  const f = factFixture(t), a = await f.answer(), b = await f.answer();
  rejected(prepareAcceptedAnswer(f.store, { ...b.request, question: a.request.question }), 'answer_unconfirmed');
  const original = f.store.get<ResearchAnswer>(a.request.answer.id, a.request.answer.revision)!;
  const corruptions: [string, (assessment: Record<string, any>, answer: Record<string, any>) => void][] = [
    ['unsupported', assessment => { assessment.verdict = 'insufficient'; }],
    ['roles', assessment => { assessment.assessor = assessment.researcher; }],
    ['environment', assessment => { assessment.researcher = 'unknown-role'; }],
    ['observations', assessment => { delete assessment.observations; }],
    ['empty-observations', assessment => { assessment.observations = []; }],
    ['citation-value', assessment => { assessment.observations[0].value = 'invented'; }],
    ['citation-selector', assessment => { assessment.observations[0].selector.pointer = '/absent'; }],
    ['value', (_assessment, answer) => { answer.value = 'another fact'; }],
    ['schema', (assessment, answer) => { assessment.value = 7; answer.value = 7; }],
    ['answer-project', (_assessment, answer) => { answer.projectId = 'another-project'; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const q = f.issue(), assessment = clone(a.assessment.value) as unknown as Record<string, any>;
    assessment.question = reference(q.issued);
    const answer = { ...clone(original.value), question: q.issued.id } as Record<string, any>;
    corrupt(assessment, answer);
    const assessmentRow = f.store.write<ResearchAssessment>({ id: `research-assessment:counterfeit-${label}`, kind: 'research-assessment', expected: 0, value: assessment });
    answer.assessment = reference(assessmentRow);
    const answerRow = f.store.write<ResearchAnswer>({ id: `research-answer:garden:counterfeit-${label}`, kind: 'research-answer', expected: 0, value: answer });
    const answered = f.store.write({ id: q.issued.id, kind: 'question', expected: q.issued.revision,
      value: { ...q.issued.value, status: 'answered', answer: reference(answerRow) } });
    const draft = f.store.write({ id: q.draft.id, kind: 'discovery-draft', expected: q.draft.revision,
      value: { ...q.draft.value, fields: { answer: answer.value } } });
    const request = { ...a.request, question: reference(q.question), answer: reference(answerRow), answeredQuestion: reference(answered), draft: reference(draft) };
    const before = f.store.list().map(reference);
    rejected(prepareAcceptedAnswer(f.store, request), 'answer_unconfirmed'); rejected(writeAcceptedAnswer(f.store, request), 'answer_unconfirmed');
    assert.deepEqual(f.store.list().map(reference), before);
  }
  const prepared = ok(prepareAcceptedAnswer(f.store, a.request)), forged = { ...clone(prepared.record.value), value: 'invented' };
  const row = f.store.write({ id: prepared.record.id, kind: prepared.record.kind, expected: 0, value: forged });
  const request = { project: f.project, record: reference(row) };
  rejected(readAcceptedAnswer(f.store, request), 'answer_record_invalid');
  rejected(applicableAnswer(f.store, { ...request, question: a.request.question }), 'answer_record_invalid');
  rejected(prepareAcceptedAnswer(f.store, a.request), 'answer_record_invalid');
  f.restart(); rejected(readAcceptedAnswer(f.store, request), 'answer_record_invalid');
});

test('D5 refuses missing or substituted MC1 sources and preserves every module refusal as addressed data', async t => {
  const f = factFixture(t), a = await f.answer(), seen = new Set<string>();
  const collect = (value: OmResult<unknown>, code: string) => seen.add(rejected(value, code));
  const question = clone(a.request), absent = { id: 'om-mc1-question:garden:absent', revision: 1, hash: '0'.repeat(64) };
  rejected(prepareAcceptedAnswer(f.store, { ...question, question: absent }), 'record_missing');
  rejected(readMc1Question(f.store, { project: 'other', record: a.request.question }), 'record_foreign');
  rejected(readMc1Question(f.store, { project: f.project, record: { ...a.request.question, hash: '0'.repeat(64) } }), 'record_forged');
  const incomplete = f.store.write({ id: 'om-mc1-question:garden:incomplete', kind: 'mc1-question', expected: 0, value: { project: f.project, request: {} } });
  collect(readMc1Question(f.store, { project: f.project, record: reference(incomplete) }), 'answer_question_invalid');
  const b = await f.answer(); collect(prepareAcceptedAnswer(f.store, { ...b.request, question: a.request.question }), 'answer_unconfirmed');
  const imitation = f.store.write({ id: 'om-answer:garden:imitation', kind: 'accepted-answer', expected: 0, value: { project: f.project, status: 'accepted' } });
  collect(readAcceptedAnswer(f.store, { project: f.project, record: reference(imitation) }), 'answer_record_invalid');
  const saved = ok(writeAcceptedAnswer(f.store, a.request));
  collect(confirmAnswerGapClosure(f.store, { project: f.project, basis: { record: reference(saved) }, target: f.target, field: 'answer',
    prior: { sources: f.gaps.sources, records: f.gaps.records }, current: { sources: f.gaps.sources, records: f.gaps.records }, attempt: null, currentOnly: false }), 'answer_inapplicable');
  const address = { project: f.project, block: f.block, line: 1 };
  ok(openSeries(f.store, { ...address, slice: 'fact-slice', predecessor: null, basis: null }));
  const attempt = ok(openAttempt(f.store, { ...address, attempt: 1, goal: { key: 'unrelated', questions: ['unrelated'], result: 'unrelated' } }));
  collect(prepareAcceptedAnswer(f.store, { ...a.request, attempt: { series: reference(attempt), attempt: 1 } }), 'answer_attempt_invalid');
  const source = f.store.get(f.source.id)!; f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  collect(prepareAcceptedAnswer(f.store, a.request), 'input_stale');
  assert.deepEqual([...seen].sort(), [...ANSWER_REFUSAL_CODES].sort());
});

test('D5 saved MC1 questions recheck their complete D1 set, consumer, requirements and exact issued question', t => {
  const f = factFixture(t), q = f.issue();
  const permuted = clone(q.request); permuted.gaps.records.reverse();
  const repeated = ok(prepareMc1Question(f.store, permuted));
  assert.deepEqual(repeated.writes, []); assert.deepEqual(repeated.record, q.question);
  const cases: Mc1QuestionRequest[] = [
    { ...q.request, gaps: { ...q.request.gaps, records: [q.request.gap] } },
    { ...q.request, contract: { ...q.request.contract, consumer: { blocks: ['garden-consume-block'] } } },
    { ...q.request, contract: { ...q.request.contract, requirements: ['invented requirement'] } },
    { ...q.request, requirements: [{ pointer: '/absent' }] },
    { ...q.request, engineQuestion: f.issue().request.engineQuestion },
  ];
  for (const request of cases) {
    const before = f.store.list().map(reference);
    rejected(prepareMc1Question(f.store, request)); assert.deepEqual(f.store.list().map(reference), before);
    const value = { project: f.project, request, fingerprint: answerContractFingerprint(request.contract) };
    const row = f.store.write({ id: `om-mc1-question:${f.project}:${hashJson(value)}`, kind: 'mc1-question', expected: 0, value });
    rejected(readMc1Question(f.store, { project: f.project, record: reference(row) }));
  }
  assert.deepEqual(ok(readMc1Question(f.store, { project: f.project, record: reference(q.question) })).record, q.question);
  f.restart(); ok(readMc1Question(f.store, { project: f.project, record: reference(q.question) }));
});

test('D5 public boundaries reject missing arguments and required collections before storage access', t => {
  const f = factFixture(t), q = f.issue(), fake = { id: 'fake:garden:x', revision: 1, hash: '0'.repeat(64) };
  const guarded = new Proxy(f.store, { get(target, key) {
    if (key === 'get' || key === 'write' || key === 'writeMany' || key === 'list') return () => assert.fail('Storage must not be touched');
    const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const typed = (action: () => unknown) => assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof EngineError); assert.match(error.code, /^answer_(request|contract)_invalid$/);
    assert.ok(error.details && typeof error.details === 'object'); return true;
  });
  const request: AnswerRequest = { project: f.project, question: fake, answer: fake, answeredQuestion: fake, draft: fake, attempt: null };
  for (const malformed of [undefined, null, [], 1, 'request', {}]) {
    for (const action of [prepareAcceptedAnswer, writeAcceptedAnswer]) typed(() => action(guarded, malformed as AnswerRequest));
    for (const action of [readAcceptedAnswer, readMc1Question]) typed(() => action(guarded, malformed as { project: string; record: Ref }));
    for (const action of [prepareMc1Question, writeMc1Question]) typed(() => action(guarded, malformed as Mc1QuestionRequest));
    typed(() => applicableAnswer(guarded, malformed as { project: string; record: Ref; question: Ref }));
    typed(() => confirmAnswerGapClosure(guarded, malformed as Parameters<typeof confirmAnswerGapClosure>[1]));
    typed(() => confirmAcceptedAnswerResult(malformed as Parameters<typeof confirmAcceptedAnswerResult>[0],
      { project: f.project, block: f.block, goal: { key: 'g', questions: [], result: 'r' } }, guarded));
  }
  for (const field of Object.keys(request)) {
    const missing = { ...request } as Record<string, unknown>; delete missing[field];
    typed(() => prepareAcceptedAnswer(guarded, missing as unknown as AnswerRequest));
  }
  for (const field of Object.keys(q.request)) {
    const missing = { ...q.request } as Record<string, unknown>; delete missing[field];
    typed(() => prepareMc1Question(guarded, missing as unknown as Mc1QuestionRequest));
  }
  typed(() => prepareMc1Question(guarded, { ...q.request, gaps: { ...q.request.gaps, records: undefined } } as unknown as Mc1QuestionRequest));
  typed(() => confirmAcceptedAnswerResult({ ...fake, kind: 'accepted-answer', value: {} }, undefined as unknown as Parameters<typeof confirmAcceptedAnswerResult>[1], guarded));
});

test('D5 execution exceptions propagate unchanged through saved, current and provider readers', async t => {
  const f = factFixture(t), a = await f.answer(), saved = ok(writeAcceptedAnswer(f.store, a.request)), before = f.store.list().map(reference);
  for (const failure of [new TypeError('injected storage failure'), new EngineError('record_corrupt', 'injected storage failure')]) {
    const broken = new Proxy(f.store, { get(target, key) {
      if (key === 'get') return (id: string, revision?: number) => { if (id === f.graph.id) throw failure; return target.get(id, revision); };
      const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    const read = { project: f.project, record: reference(saved) };
    for (const action of [() => readAcceptedAnswer(broken, read), () => prepareAcceptedAnswer(broken, a.request),
      () => writeAcceptedAnswer(broken, a.request), () => readMc1Question(broken, { project: f.project, record: a.request.question }),
      () => applicableAnswer(broken, { ...read, question: a.request.question }),
      () => confirmAcceptedAnswerResult(saved, { project: f.project, block: f.block, goal: { key: 'g', questions: [], result: 'r' } }, broken)])
      assert.throws(action, error => error === failure);
  }
  assert.deepEqual(f.store.list().map(reference), before);
});

test('D5 preserves own JSON keys from native evidence through accepted value and historical rederivation', async t => {
  const f = factFixture(t), value = JSON.parse('{"__proto__":"kept","items":["a","a","b"]}') as Json;
  writeFileSync(join(f.root, 'answer.json'), canonical({ answer: value }));
  f.engine.discovery.evidence.file(f.project, 'answer-source', f.root, 'answer.json', 'application/json', f.source.revision);
  const q = f.issue(f.gaps, { type: 'object', additionalProperties: true }), a = await f.answer(q, null, value);
  const saved = ok(writeAcceptedAnswer(f.store, a.request));
  assert.equal(saved.hash, hashJson(saved.value)); assert.deepEqual(saved.value.value, value);
  assert.ok(Object.hasOwn(saved.value.value as object, '__proto__'));
  const checked = ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(saved) }));
  f.restart(); assert.deepEqual(ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(saved) })), checked);
});

test('D5 does not turn an unclassified native predecessor question into an MC1 fact', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-answer-predecessor-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = 'garden', engine = new ProductEngine(store), { level: _level, ...l1 } = projectGraph(gardenGraph(), 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>)['unknowns'] = [{ id: 'output-format',
      question: 'Which output format does the repository support?', consumer: 'garden-produce-block',
      blocksCurrentStage: false, resolution: 'Read repository facts during OM' }];
    return value;
  });
  const input = ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  assert.equal(input.value.input.questions[0]!.kind, null);
  const graph = store.get<Graph>(`graph:${project}`)!, horizon = ok(writeHorizon(store, { project, input: reference(input),
    graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: 'answer-first-pass', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(store, sources)), gap = gaps.records.find(row => row.value.gap.target === input.value.input.questions[0]!.id)!;
  assert.equal(gap.value.gap.code, 'question_unaddressed'); assert.equal(gap.value.gap.kind, 'design-decision');
  assert.equal(gap.value.gap.field, 'address');
  const requestContract: AnswerQuestionContract = { establishes: input.value.input.questions[0]!.question,
    consumer: { blocks: [...gap.value.gap.consumers] }, requirements: [], resultForm: { type: 'string' } };
  const draft = engine.discovery.create(project, 'om-g2', 'R1', 'garden-produce-block',
    [mc1FieldSpec({ input: reference(input), gap: reference(gap), contract: requestContract })], [reference(input), reference(gap)]);
  const issued = store.get<Question>(draft.value.questions[0]!)!;
  const request: Mc1QuestionRequest = { project, input: reference(input), gaps: { sources, records: gaps.records.map(reference) },
    gap: reference(gap), contract: requestContract, requirements: [], engineQuestion: reference(issued), draft: reference(draft) };
  const before = store.list().map(reference), prepared = prepareMc1Question(store, request);
  assert.equal(prepared.ok, false);
  if (!prepared.ok) {
    assert.equal(prepared.refusal.code, 'answer_question_invalid');
    assert.equal(prepared.refusal.at.target, gap.value.gap.target); assert.equal(prepared.refusal.at.field, 'route');
  }
  assert.deepEqual(store.list().map(reference), before);
});

test('D5 does not accept a fingerprint or status in place of the complete saved question source', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-answer-incomplete-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  for (const value of [{ project: 'garden', fingerprint: answerContractFingerprint(contract()), status: 'accepted' },
    { project: 'garden', fingerprint: answerContractFingerprint(contract()), request: {} }]) {
    const row = store.write({ id: `om-mc1-question:garden:incomplete-${store.list().length}`, kind: 'mc1-question', expected: 0, value });
    const before = store.list().map(reference), result = readMc1Question(store, { project: 'garden', record: reference(row) });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.refusal.code, 'answer_question_invalid'); assert.ok(result.refusal.at.target && result.refusal.at.field); }
    assert.deepEqual(store.list().map(reference), before);
  }
});
