import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Write } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { EngineError } from '../src/errors.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { projectGraph } from '../src/graph/project.js';
import type { Graph } from '../src/graph/model.js';
import { inputDecisionWrite, writeAddressing, writeApplyAnswer } from '../src/om/addressing.js';
import { writeOmInput } from '../src/om/input.js';
import { writeHorizon, writeHorizonIssuance } from '../src/om/horizon.js';
import { writeGaps, type GapRequest, type GapReadRequest } from '../src/om/gaps.js';
import { writeRoutes } from '../src/om/routes.js';
import { prepareQuestionTasks, writeQuestionPacket } from '../src/om/question-packet.js';
import { openSeries, beginAttempt, applySeriesActivation, seriesCurrentId, seriesId,
  type AttemptGoal, type RepairSeries } from '../src/om/series.js';
import { writeSeriesTransition } from '../src/om/series-transition.js';
import { closeAttempt } from '../src/om/repeat-gate.js';
import { gapLineKey, gapLineExpectedResult, prepareGapLines, writeGapLines, GAP_LINE_KIND } from '../src/om/gap-lines.js';
import { recordCall } from '../src/om/call-record.js';
import { runModelCall, runModelTransport } from '../src/om/model-call.js';
import { readAcceptedAnswer, readAnswerSearch, applicableAnswer, prepareE5AcceptedAnswer,
  confirmAnswerGapClosure, answerIndexId, type Mc1QuestionRecord } from '../src/om/accepted-answer.js';
import { prepareAssessmentIntent, writeAssessmentIntent, readAssessmentIntentAt, readAssessmentResultAt, assessmentResultId,
  readAssessmentTerminalAt, readAssessmentSet, applyAssessmentResult, assessFact, ASSESSMENT_INTENT_KIND,
  ASSESSMENT_RESULT_KIND,
  type AssessmentIntentRequest, type AssessmentResultRecord } from '../src/om/assessment.js';
import { writeGuarded } from '../src/om/refs.js';
import { type OmResult } from '../src/om/refusal.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

const adapterFixture = fileURLToPath(new URL('../../test/om-adapter-fixture.mjs', import.meta.url));
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function denied(result: OmResult<unknown>, code?: string): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  if (code) assert.equal(result.refusal.code, code);
  assert.equal(result.refusal.at.unit, 'E5');
  assert.ok(result.refusal.at.target);
  if (result.refusal.at.unit === 'E5' && result.refusal.code !== 'input_stale') assert.ok(result.refusal.at.field);
}
function fixture(t: TestContext, twoFacts = false, managed = false) {
  const root = mkdtempSync(join(tmpdir(), 'omg-e5-')), path = join(root, 'state.sqlite'), project = 'garden';
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), desired = gardenGraph('cross');
  desired.nodes.find(node => node.id === 'garden-produce-block')!.ports.push({ id: 'out-side', direction: 'out', contract: 'garden-contract' });
  desired.nodes.find(node => node.id === 'garden-consume-block')!.ports.push({ id: 'in-side', direction: 'in', contract: 'garden-contract' });
  desired.connectors.push({ id: 'garden-side-flow', artifact: 'garden-data', returnsTo: 'garden-produce-block', wakeTest: null,
    bindings: [{ level: 1, producer: { node: 'garden-produce-block', port: 'out-side' },
      consumers: [{ node: 'garden-consume-block', port: 'in-side' }], anchor: null }] });
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'encoding',
      question: 'What encoding is supported?', consumer: 'garden-consume-block', moment: 'om-pass',
      blocksCurrentStage: false, resolution: 'Resolve the addressed question during OM' },
      ...(twoFacts ? [{ id: 'transport', question: 'What transport is supported?', consumer: 'garden-consume-block',
        moment: 'om-pass', blocksCurrentStage: false, resolution: 'Resolve the addressed question during OM' }] : [])];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: ['discovery:encoding', ...(twoFacts ? ['discovery:transport'] : [])].map(target => ({ pending:
      structuredClone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
        decision: { target, field: 'address',
          value: { consumer: 'garden-consume-block', kind: 'repository-fact' } } })) as Write })) }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null,
    available: {}, choice: { choiceVersion: 'e5-fact', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(store, sources)), gapRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = ok(prepareQuestionTasks(store, { project, gaps: gapRequest,
    questions: gaps.records.filter(row => row.value.gap.kind === 'repository-fact' && row.value.gap.code !== 'inventory_missing'
      && !row.value.gap.deferral).map(gap => ({ gap: reference(gap), requirements: [{ pointer: '/contracts/0' }],
        resultForm: { type: 'string' } })) }));
  const routes = ok(writeRoutes(store, { project, gaps: gapRequest,
    tasks: tasks.tasks.map(task => ({ pending: structuredClone(task.writes[0]!) as Write })),
    catalog: { paths: ['e5-source.txt'], records: [] }, previous: null }));
  const batch = routes.value.batches.find(item => item.model === 'MC1' && item.items.some(question => question.target === 'discovery:encoding'))!;
  assert.ok(batch);
  const block = 'garden-consume-block', source = store.get<{ content: string }>(`source:${project}:brief`)!;
  const goal: AttemptGoal = { key: 'e5:fact', questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  const opened = ok(openSeries(store, { project, block, line: 1, slice: 'e5-fact', predecessor: null, basis: null }));
  if (managed) {
    const prepared = ok(writeSeriesTransition(store, { project, choiceVersion: 'e5-fact',
      horizon: reference(horizon.gate), series: [reference(opened)] }));
    const issuance = ok(writeHorizonIssuance(store, { project, choiceVersion: 'e5-fact',
      horizon: reference(horizon.gate), transition: reference(prepared) }));
    ok(applySeriesActivation(store, { project, prepared: reference(prepared), issuance: reference(issuance) }));
  }
  const series = ok(beginAttempt(store, { project, block, line: 1, attempt: 1, goal }));
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [adapterFixture, '--scenario', scenario, '--trace', trace] };
  const config = engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'e5-researcher', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'e5-assessor', model: 'fixture-reviewer', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: 100_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:e5`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: project, protocol: 'codex-stdio' } });
  const packet = ok(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id,
    environment: reference(config), attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  const questionId = batch.items[0]!.gap;
  writeFileSync(join(root, 'e5-source.txt'), 'UTF-8 is the supported encoding.');
  const originalStep = { research: { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'answer',
    results: batch.items.map(item => ({ questionId: item.gap, value: 'UTF-8', citations: [{ source: reference(source),
      selector: { kind: 'text-range', start: 0, end: source.value.content.length } }] })) }, usage };
  const dispatch = { adapter: reference(adapter), config: reference(config) };
  writeFileSync(scenario, JSON.stringify({ steps: [originalStep] }));
  async function original(): Promise<AssessmentIntentRequest> {
    const model = ok(await runModelCall(store, { project, packet: reference(packet), dispatch, role: 'implementer' }));
    assert.equal(model.outcome?.kind, 'fact-candidates');
    return { project, modelCall: reference(model.record), questionId, dispatch };
  }
  return { project, path, series, scenario, originalStep, dispatch, original, questionIds: batch.items.map(item => item.gap),
    get store() { return store; },
    assessor(...verdicts: ('supported' | 'insufficient' | 'conflicting')[]) {
      const choices = verdicts.length ? verdicts : ['supported' as const];
      writeFileSync(scenario, JSON.stringify({ steps: [originalStep, ...choices.map(verdict =>
        ({ research: { verdict, reasons: verdict === 'supported' ? [] : ['source not decisive'] }, usage }))] }));
    },
    sent() { return readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean); },
    restart() { store.close(); store = new Store(path); },
  };
}

async function completedFactClosure(f: ReturnType<typeof fixture>) {
  const request = await f.original();
  const intent = ok(writeAssessmentIntent(f.store, request));
  const admission = ok(readAssessmentIntentAt(f.store, f.project, reference(intent)));
  const question = f.store.get<Mc1QuestionRecord>(admission.question.record.id, admission.question.record.revision)!;
  const prior = question.value.request.gaps;
  const initial = ok(writeGapLines(f.store, { project: f.project, previous: null, pass: 1,
    gaps: prior, closures: [] }));
  f.assessor();
  const terminal = ok(await assessFact(f.store, request));
  assert.ok(terminal.value.accepted);
  const accepted = terminal.value.accepted;
  const checked = ok(readAcceptedAnswer(f.store, { project: f.project, record: accepted }));
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome?.reason, 'result');
  const applied = ok(writeApplyAnswer(f.store, { project: f.project, input: question.value.request.input,
    answer: accepted, question: reference(question) }));
  const graph = prior.sources.graph;
  const horizon = ok(writeHorizon(f.store, { project: f.project, input: reference(applied), graph,
    refinement: null, available: {}, choice: { choiceVersion: 'e5-d2-closure',
      features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { ...structuredClone(prior.sources), input: reference(applied), horizon: reference(horizon.gate),
    operations: { ...structuredClone(prior.sources.operations),
      frame: { ...structuredClone(prior.sources.operations.frame), horizon: reference(horizon.gate) } } };
  const gaps = ok(writeGaps(f.store, sources));
  assert.ok(!gaps.records.some(row => row.value.gap.id === checked.gap.id));
  const current: GapReadRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const attempt = { series: checked.attempt!.series, attempt: checked.attempt!.ordinal };
  const closure = { id: checked.gap.id, reason: 'filled' as const, basis: accepted, acceptance: null, attempt,
    answer: { record: accepted } };
  const next = { project: f.project, previous: reference(initial), pass: 2, gaps: current, closures: [closure] };
  const confirmation = { project: f.project, basis: closure.answer, target: checked.gap.target,
    field: checked.gap.field, prior, current, attempt, currentOnly: true };
  return { terminal, accepted, checked, initial, closure, next, confirmation };
}

test('E5 accepted fact closes its D2 line after G7 completed the original attempt, including restart', async t => {
  const f = fixture(t), chain = await completedFactClosure(f);
  assert.equal(ok(confirmAnswerGapClosure(f.store, { ...chain.confirmation, currentOnly: false })).key,
    chain.checked.key);
  assert.equal(ok(confirmAnswerGapClosure(f.store, chain.confirmation)).key, chain.checked.key);
  f.restart();
  const prepared = ok(prepareGapLines(f.store, chain.next));
  assert.ok(prepared.guards.some(ref => ref.id === f.series.id));
  const closed = ok(writeGapLines(f.store, chain.next));
  assert.equal(closed.value.lines.find(line => line.id === chain.closure.id)?.status, 'closed');
  const before = f.store.list().map(reference);
  f.restart();
  assert.deepEqual(ok(writeGapLines(f.store, chain.next)), closed);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, 2);
});

test('E5 D2 closure keeps the original attempt, goal and current line admission', async t => {
  for (const changed of ['foreign series', 'ordinal', 'goal', 'successor'] as const) await t.test(changed, async child => {
    const f = fixture(child), chain = await completedFactClosure(f);
    if (changed === 'foreign series' || changed === 'ordinal') {
      const attempt = changed === 'ordinal'
        ? { ...chain.confirmation.attempt, attempt: chain.confirmation.attempt.attempt + 1 }
        : { ...chain.confirmation.attempt, series: { ...chain.confirmation.attempt.series, id: 'repair-series:foreign' } };
      const result = confirmAnswerGapClosure(f.store, { ...chain.confirmation, attempt });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.refusal.code, 'answer_attempt_invalid');
        assert.equal(result.refusal.at.unit, 'D5');
      }
    } else if (changed === 'goal') {
      const line = f.store.get<RepairSeries>(f.series.id)!;
      const value = structuredClone(line.value);
      const attempts = [...value.attempts];
      attempts[0] = { ...attempts[0]!, goal: { ...attempts[0]!.goal, result: 'another-result' } };
      f.store.write({ id: line.id, kind: line.kind, expected: line.revision, value: { ...value, attempts } });
      assert.equal(confirmAnswerGapClosure(f.store, chain.confirmation).ok, false);
    } else {
      f.store.write({ id: seriesId(f.project, 'garden-consume-block', 2), kind: 'repair-series', expected: 0,
        value: { projectId: f.project, block: 'garden-consume-block', line: 2 } });
      assert.equal(confirmAnswerGapClosure(f.store, chain.confirmation).ok, false);
    }
  });
});

test('E5 D2 closure refuses a second Store changing the admitted line before the pass is written', async t => {
  const f = fixture(t), chain = await completedFactClosure(f), before = f.store.list(GAP_LINE_KIND).map(reference);
  const originalWrite = f.store.writeMany.bind(f.store);
  let raced = false;
  f.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(write => write.kind === GAP_LINE_KIND && write.expected > 0)) {
      raced = true;
      const second = new Store(f.path);
      try {
        const line = second.get<RepairSeries>(f.series.id)!;
        second.write({ id: line.id, kind: line.kind, expected: line.revision, value: line.value });
      } finally { second.close(); }
    }
    return originalWrite(writes, guards);
  }) as Store['writeMany'];
  try {
    const result = writeGapLines(f.store, chain.next);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, 'input_stale');
  } finally { f.store.writeMany = originalWrite; }
  assert.equal(raced, true);
  assert.deepEqual(f.store.list(GAP_LINE_KIND).map(reference), before);
  assert.equal(f.sent().length, 2);
});

test('E5 accepts a supported physical fact with one complete D5 bundle and exact historical result', async t => {
  const f = fixture(t), request = await f.original();
  f.assessor();
  const terminal = ok(await assessFact(f.store, request));
  assert.equal(terminal.value.verdict, 'supported');
  assert.ok(terminal.value.accepted && terminal.value.index);
  const accepted = ok(readAcceptedAnswer(f.store, { project: f.project, record: terminal.value.accepted! }));
  assert.equal(accepted.record.value.target, 'discovery:encoding');
  const index = ok(readAnswerSearch(f.store, { project: f.project, record: terminal.value.index! }));
  assert.ok(index.answers.some(ref => ref.id === terminal.value.accepted!.id));
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome?.reason, 'result');
  assert.equal(f.sent().length, 2);
  const before = f.store.list().map(reference), exact = reference(terminal);
  f.restart();
  assert.deepEqual(ok(readAssessmentTerminalAt(f.store, f.project, exact)), terminal);
  assert.deepEqual(ok(await assessFact(f.store, request)), terminal);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, 2);
});

test('an E5 D5 answer without its terminal result is not readable as accepted', async t => {
  const f = fixture(t), request = await f.original(), intent = ok(writeAssessmentIntent(f.store, request));
  const admission = ok(readAssessmentIntentAt(f.store, f.project, reference(intent)));
  const call = ok(recordCall(f.store, f.project, { call: admission.call, purpose: 'fact-assessment', basis: admission.basis,
    block: admission.block, gaps: admission.gaps, series: admission.series, attempt: admission.attempt,
    goal: admission.goal, dispatch: admission.dispatch, packet: admission.packet as Json }));
  f.assessor();
  const physical = ok(await runModelTransport(f.store, { project: f.project, call: reference(call.call),
    packet: admission.packet as Json, role: 'reviewer' }));
  const prepared = ok(prepareE5AcceptedAnswer(f.store, { project: f.project, intent: reference(intent),
    assessor: reference(physical.record) }));
  ok(writeGuarded(f.store, { unit: 'E5-test', target: prepared.record.id,
    writes: prepared.writes as Write[], guards: prepared.guards }));
  assert.equal(f.store.list(ASSESSMENT_RESULT_KIND).length, 0);
  const accepted = reference(prepared.record);
  const index = reference(f.store.get(answerIndexId(f.project, prepared.record.value.target, prepared.record.value.field))!);
  for (const restart of [false, true]) {
    if (restart) f.restart();
    for (const read of [() => readAcceptedAnswer(f.store, { project: f.project, record: accepted }),
      () => readAnswerSearch(f.store, { project: f.project, record: index }),
      () => applicableAnswer(f.store, { project: f.project, record: accepted, question: admission.question.record })]) {
      const result = read();
      assert.equal(result.ok, false, 'A D5 answer without its E5 terminal cannot be consumed');
    }
  }
  const physicalVerdict = ok(readAssessmentResultAt(f.store, f.project, reference(intent), reference(physical.record)));
  const forgedIndex = { ...index, revision: index.revision + 1 };
  const forgedTerminal: AssessmentResultRecord = { contract: 'om-assessment-result/v1', project: f.project,
    intent: reference(intent), assessor: reference(physical.record), verdict: physicalVerdict.verdict,
    reasons: [...physicalVerdict.reasons], accepted, index: forgedIndex };
  f.store.write({ id: assessmentResultId(f.project, reference(intent)), kind: ASSESSMENT_RESULT_KIND,
    expected: 0, value: forgedTerminal });
  for (const restart of [false, true]) {
    if (restart) f.restart();
    const found = readAnswerSearch(f.store, { project: f.project, record: index });
    assert.equal(found.ok, false, 'An index cannot validate an E5 result naming a missing revision');
    if (!found.ok) assert.equal(found.refusal.code, 'answer_record_invalid');
  }
});

test('E5 closes only a complete fully supported source set; a mixed set remains open for E5.1', async t => {
  const f = fixture(t, true), first = await f.original();
  assert.equal(f.questionIds.length, 2);
  f.assessor('supported', 'insufficient');
  const firstResult = ok(await assessFact(f.store, first));
  const firstIntent = firstResult.value.intent;
  assert.equal(ok(readAssessmentSet(f.store, f.project, firstIntent)).complete, false);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  const second = ok(await assessFact(f.store, { ...first, questionId: f.questionIds[1]! }));
  assert.equal(second.value.verdict, 'insufficient');
  const set = ok(readAssessmentSet(f.store, f.project, firstIntent));
  assert.equal(set.complete, true);
  assert.equal(set.allSupported, false);
  assert.equal(set.accepted.length, 1);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  const count = f.sent().length;
  f.restart();
  assert.deepEqual(ok(await assessFact(f.store, first)), firstResult);
  assert.deepEqual(ok(await assessFact(f.store, { ...first, questionId: f.questionIds[1]! })), second);
  assert.equal(f.sent().length, count);
});

test('a direct G7 close cannot omit an unassessed fact from the original MC1 response', async t => {
  const f = fixture(t, true), request = await f.original();
  f.assessor('supported');
  const first = ok(await assessFact(f.store, request));
  assert.ok(first.value.accepted);
  const closed = closeAttempt(f.store, { project: f.project, block: 'garden-consume-block', line: 1, attempt: 1,
    outcome: { reason: 'result', accepting: [first.value.accepted!], cancelling: [], refusals: [] } });
  assert.equal(closed.ok, false);
  if (!closed.ok) assert.equal(closed.refusal.code, 'achievement_unconfirmed');
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  assert.equal(f.store.list(ASSESSMENT_RESULT_KIND).length, 1);
  assert.equal(f.sent().length, 2);
});

test('a direct G7 close atomically guards the complete assessed source set', async t => {
  const f = fixture(t, true), request = await f.original();
  f.assessor('supported', 'supported');
  ok(await assessFact(f.store, request));
  const originalWrite = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes, guards) => {
    if (writes.some(write => write.kind === 'repair-series' && write.id === f.series.id && write.expected > 0))
      throw new Error('simulated interruption before G7 write');
    return originalWrite(writes, guards);
  }) as Store['writeMany'];
  try {
    await assert.rejects(() => assessFact(f.store, { ...request, questionId: f.questionIds[1]! }),
      /simulated interruption before G7 write/);
  } finally { f.store.writeMany = originalWrite; }
  const results = f.store.list<AssessmentResultRecord>(ASSESSMENT_RESULT_KIND);
  assert.equal(results.length, 2);
  const accepting = results.map(result => result.value.accepted!);
  const before = f.store.get<RepairSeries>(f.series.id)!;
  assert.equal(before.value.attempts[0]!.outcome, null);
  let raced = false;
  f.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(write => write.kind === 'repair-series' && write.id === f.series.id)) {
      raced = true;
      const second = new Store(f.path);
      try {
        const latest = second.get(results[0]!.id)!;
        second.write({ id: latest.id, kind: latest.kind, expected: latest.revision, value: latest.value });
      } finally { second.close(); }
    }
    return originalWrite(writes, guards);
  }) as Store['writeMany'];
  try {
    const closed = closeAttempt(f.store, { project: f.project, block: 'garden-consume-block', line: 1, attempt: 1,
      outcome: { reason: 'result', accepting, cancelling: [], refusals: [] } });
    assert.equal(closed.ok, false);
    if (!closed.ok) assert.equal(closed.refusal.code, 'input_stale');
  } finally { f.store.writeMany = originalWrite; }
  assert.equal(raced, true);
  assert.deepEqual(f.store.get<RepairSeries>(f.series.id), before);
  assert.equal(f.sent().length, 3);
});

test('E5 closes a multi-fact attempt after the final supported result and repeats without a second count', async t => {
  const f = fixture(t, true), first = await f.original();
  f.assessor('supported', 'supported');
  const firstResult = ok(await assessFact(f.store, first));
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  const second = ok(await assessFact(f.store, { ...first, questionId: f.questionIds[1]! }));
  assert.equal(second.value.verdict, 'supported');
  const line = f.store.get<RepairSeries>(f.series.id)!;
  assert.equal(line.value.attempts[0]!.outcome?.reason, 'result');
  assert.equal(line.value.attempts[0]!.outcome?.achieved.length, 2);
  const before = f.store.list().map(reference), count = f.sent().length;
  f.restart();
  assert.deepEqual(ok(await assessFact(f.store, first)), firstResult);
  assert.deepEqual(ok(await assessFact(f.store, { ...first, questionId: f.questionIds[1]! })), second);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.sent().length, count);
});

test('E5 stores an independent insufficient verdict without accepting a fact or ending the attempt early', async t => {
  const f = fixture(t), request = await f.original();
  f.assessor('insufficient');
  const terminal = ok(await assessFact(f.store, request));
  assert.equal(terminal.value.verdict, 'insufficient');
  assert.equal(terminal.value.accepted, null);
  assert.equal(terminal.value.index, null);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  f.restart();
  assert.deepEqual(ok(readAssessmentTerminalAt(f.store, f.project, reference(terminal))), terminal);
  assert.deepEqual(ok(await assessFact(f.store, request)), terminal);
  assert.equal(f.sent().length, 2);
});

test('E5 preserves conflicting and off-form outcomes as their own terminal states without D5 acceptance', async t => {
  for (const variant of ['conflicting', 'off-form'] as const) await t.test(variant, async t => {
    const f = fixture(t), request = await f.original();
    if (variant === 'conflicting') f.assessor('conflicting');
    else writeFileSync(f.scenario, JSON.stringify({ steps: [f.originalStep,
      { research: { answer: 'untyped reviewer reply' }, usage }] }));
    const terminal = ok(await assessFact(f.store, request));
    assert.equal(terminal.value.verdict, variant);
    assert.equal(terminal.value.accepted, null);
    assert.equal(f.store.list('accepted-answer').length, 0);
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
    f.restart();
    assert.deepEqual(ok(readAssessmentTerminalAt(f.store, f.project, reference(terminal))), terminal);
    assert.equal(f.sent().length, 2);
  });
});

test('E5 intent is derived from the full MC1 fact and its original guarded admission', async t => {
  const f = fixture(t), request = await f.original();
  const prepared = ok(prepareAssessmentIntent(f.store, request));
  assert.equal(prepared.writes.length, 1);
  assert.equal(f.store.get(prepared.record.id), null);
  const malicious = structuredClone(prepared.writes[0]!.value) as Record<string, unknown>;
  (malicious['fact'] as Record<string, unknown>)['value'] = 'fabricated';
  const forged = f.store.write({ id: prepared.record.id, kind: ASSESSMENT_INTENT_KIND, expected: 0, value: malicious as Json });
  f.restart();
  denied(readAssessmentIntentAt(f.store, f.project, reference(forged)), 'assessment_intent_invalid');
});

test('E5 historical intent refuses missing mandatory source guards even with a recomputed record hash', async t => {
  for (const omitted of ['dispatch adapter', 'citation source'] as const) await t.test(omitted, async child => {
    const f = fixture(child), request = await f.original(), prepared = ok(prepareAssessmentIntent(f.store, request));
    const citation = prepared.record.value.fact.grounds[0]!.observation.source;
    const missing = omitted === 'dispatch adapter' ? request.dispatch.adapter : citation;
    assert.ok(prepared.record.value.originalGuards.some(ref => ref.id === missing.id));
    const malicious = structuredClone(prepared.writes[0]!.value) as { originalGuards: Ref[] };
    malicious.originalGuards = malicious.originalGuards.filter(ref => ref.id !== missing.id);
    const forged = f.store.write({ id: prepared.record.id, kind: ASSESSMENT_INTENT_KIND,
      expected: 0, value: malicious });
    f.restart();
    denied(readAssessmentIntentAt(f.store, f.project, reference(forged)), 'assessment_intent_invalid');
  });
});

test('E5 managed intent retains its exact series pointer admission after restart', async t => {
  for (const missingPointer of [false, true]) await t.test(missingPointer ? 'missing pointer' : 'exact pointer', async child => {
    const f = fixture(child, false, true), request = await f.original();
    const prepared = ok(prepareAssessmentIntent(f.store, request));
    const pointer = prepared.record.value.originalGuards.find(ref => ref.id === seriesCurrentId(f.project));
    assert.ok(pointer, 'The managed producer guards its exact current pointer');
    const value = { ...structuredClone(prepared.record.value), originalGuards: missingPointer
      ? prepared.record.value.originalGuards.filter(ref => ref.id !== pointer.id)
      : [...prepared.record.value.originalGuards] };
    const saved = f.store.write({ id: prepared.record.id, kind: ASSESSMENT_INTENT_KIND, expected: 0, value });
    f.restart();
    if (missingPointer) denied(readAssessmentIntentAt(f.store, f.project, reference(saved)), 'assessment_intent_invalid');
    else assert.deepEqual(ok(readAssessmentIntentAt(f.store, f.project, reference(saved))).record, saved);
  });
});

test('E5 paid application still holds every exact guard captured by its intent', async t => {
  const f = fixture(t), request = await f.original();
  const held = f.store.write({ id: `e5-held:${f.project}`, kind: 'test-guard', expected: 0, value: { source: 'original' } });
  const prepared = ok(prepareAssessmentIntent(f.store, request));
  const value = { ...structuredClone(prepared.record.value), originalGuards:
    [...prepared.record.value.originalGuards, reference(held)].sort((a, b) => canonical(a) < canonical(b) ? -1 : 1) };
  const intent = f.store.write({ id: prepared.record.id, kind: ASSESSMENT_INTENT_KIND, expected: 0, value });
  const admission = ok(readAssessmentIntentAt(f.store, f.project, reference(intent)));
  const call = ok(recordCall(f.store, f.project, { call: admission.call, purpose: 'fact-assessment', basis: admission.basis,
    block: admission.block, gaps: admission.gaps, series: admission.series, attempt: admission.attempt,
    goal: admission.goal, dispatch: admission.dispatch, packet: admission.packet as Json }));
  f.assessor();
  const physical = ok(await runModelTransport(f.store, { project: f.project, call: reference(call.call),
    packet: admission.packet as Json, role: 'reviewer' }));
  f.store.write({ id: held.id, kind: held.kind, expected: held.revision, value: held.value });
  denied(applyAssessmentResult(f.store, { project: f.project,
    intent: reference(intent), assessor: reference(physical.record) }), 'assessment_source_stale');
  assert.equal(f.store.list(ASSESSMENT_RESULT_KIND).length, 0);
  f.restart();
  denied(applyAssessmentResult(f.store, { project: f.project,
    intent: reference(intent), assessor: reference(physical.record) }), 'assessment_source_stale');
  assert.equal(f.sent().length, 2);
});

test('E5 rejects a reviewer dispatch whose actual actor is the original MC1 actor', async t => {
  const f = fixture(t), request = await f.original();
  const old = f.store.get(request.dispatch.config.id)!;
  const value = structuredClone(old.value) as { implementer: { actor: string }; reviewer: { actor: string } };
  value.reviewer.actor = value.implementer.actor;
  const config = f.store.write({ id: old.id, kind: old.kind, expected: old.revision, value });
  const before = f.store.list(ASSESSMENT_INTENT_KIND).length;
  denied(writeAssessmentIntent(f.store, { ...request, dispatch: { ...request.dispatch, config: reference(config) } }),
    'assessment_independence_invalid');
  assert.equal(f.store.list(ASSESSMENT_INTENT_KIND).length, before);
});

test('E5 reserves one assessor identity for an original fact even when another reviewer adapter is offered', async t => {
  const f = fixture(t), request = await f.original(), first = ok(writeAssessmentIntent(f.store, request));
  const another = f.store.write({ id: `adapter:${f.project}:second-reviewer`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: f.project, protocol: 'codex-stdio' } });
  denied(writeAssessmentIntent(f.store, { ...request, dispatch: { ...request.dispatch, adapter: reference(another) } }),
    'assessment_identity_conflict');
  assert.equal(f.store.list(ASSESSMENT_INTENT_KIND).length, 1);
  assert.deepEqual(ok(readAssessmentIntentAt(f.store, f.project, reference(first))).dispatch, request.dispatch);
});

test('E4 independently refuses changed role and packet before a paid assessor dispatch', async t => {
  const f = fixture(t), request = await f.original(), intent = ok(writeAssessmentIntent(f.store, request));
  const admission = ok(readAssessmentIntentAt(f.store, f.project, reference(intent)));
  const call = ok(recordCall(f.store, f.project, { call: admission.call, purpose: 'fact-assessment', basis: admission.basis,
    block: admission.block, gaps: admission.gaps, series: admission.series, attempt: admission.attempt,
    goal: admission.goal, dispatch: admission.dispatch, packet: admission.packet as Json }));
  const requestCall = { project: f.project, call: reference(call.call), packet: admission.packet as Json };
  const before = f.store.list('model-call').map(reference), sent = f.sent().length;
  const wrongRole = await runModelTransport(f.store, { ...requestCall, role: 'implementer' });
  assert.equal(wrongRole.ok, false);
  const wrongPacket = await runModelTransport(f.store, { ...requestCall, packet: { forged: true }, role: 'reviewer' });
  assert.equal(wrongPacket.ok, false);
  assert.deepEqual(f.store.list('model-call').map(reference), before);
  assert.equal(f.sent().length, sent);
});

test('E4 atomically refuses a changed intent source before reservation and sends no assessor request', async t => {
  const f = fixture(t), request = await f.original(), intent = ok(writeAssessmentIntent(f.store, request));
  const admission = ok(readAssessmentIntentAt(f.store, f.project, reference(intent)));
  const call = ok(recordCall(f.store, f.project, { call: admission.call, purpose: 'fact-assessment', basis: admission.basis,
    block: admission.block, gaps: admission.gaps, series: admission.series, attempt: admission.attempt,
    goal: admission.goal, dispatch: admission.dispatch, packet: admission.packet as Json }));
  f.assessor();
  const before = f.store.list('model-call').map(reference), sent = f.sent().length;
  const originalWrite = f.store.writeMany.bind(f.store);
  let raced = false;
  f.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(write => write.kind === 'model-call'
      && (write.value as { purpose?: string }).purpose === 'fact-assessment')) {
      raced = true;
      const second = new Store(f.path);
      try {
        const adapter = second.get(request.dispatch.adapter.id)!;
        second.write({ id: adapter.id, kind: adapter.kind, expected: adapter.revision, value: adapter.value });
      } finally { second.close(); }
    }
    return originalWrite(writes, guards);
  }) as Store['writeMany'];
  try {
    const refused = await runModelTransport(f.store, { project: f.project, call: reference(call.call),
      packet: admission.packet as Json, role: 'reviewer' });
    assert.equal(refused.ok, false);
  } finally { f.store.writeMany = originalWrite; }
  assert.equal(raced, true);
  assert.deepEqual(f.store.list('model-call').map(reference), before);
  assert.equal(f.sent().length, sent);
});

test('E5 refuses intent creation if a guarded source moves between preparation and the transaction', async t => {
  const f = fixture(t), request = await f.original(), prepared = ok(prepareAssessmentIntent(f.store, request));
  const second = new Store(f.path);
  try {
    const adapter = second.get(request.dispatch.adapter.id)!;
    second.write({ id: adapter.id, kind: adapter.kind, expected: adapter.revision, value: adapter.value });
    denied(writeGuarded(second, { unit: 'E5', target: prepared.record.id, writes: prepared.writes as Write[],
      guards: prepared.guards }), 'input_stale');
    assert.equal(second.get(prepared.record.id), null);
  } finally { second.close(); }
});

test('E5 retains a paid response when a source moves before supported application', async t => {
  const f = fixture(t), request = await f.original(), intent = ok(writeAssessmentIntent(f.store, request));
  const admission = ok(readAssessmentIntentAt(f.store, f.project, reference(intent)));
  const call = ok(recordCall(f.store, f.project, { call: admission.call, purpose: 'fact-assessment', basis: admission.basis,
    block: admission.block, gaps: admission.gaps, series: admission.series, attempt: admission.attempt,
    goal: admission.goal, dispatch: admission.dispatch, packet: admission.packet as Json }));
  f.assessor();
  const physical = ok(await runModelTransport(f.store, { project: f.project, call: reference(call.call),
    packet: admission.packet as Json, role: 'reviewer' }));
  const second = new Store(f.path);
  try {
    const adapter = second.get(request.dispatch.adapter.id)!;
    second.write({ id: adapter.id, kind: adapter.kind, expected: adapter.revision, value: adapter.value });
  } finally { second.close(); }
  denied(applyAssessmentResult(f.store, { project: f.project, intent: reference(intent), assessor: reference(physical.record) }));
  assert.ok(f.store.get(physical.record.id));
  assert.equal(f.store.list('accepted-answer').length, 0);
  assert.equal(f.store.get(`om-assessment-result:${f.project}:${hashJson(intent.id)}`), null);
  f.restart();
  assert.ok(f.store.get(physical.record.id));
  denied(applyAssessmentResult(f.store, { project: f.project, intent: reference(intent), assessor: reference(physical.record) }));
});

test('E5 completion cannot close an obsolete line when a successor appears before its transaction', async t => {
  const f = fixture(t), request = await f.original();
  f.assessor();
  const originalWrite = f.store.writeMany.bind(f.store);
  let raced = false;
  f.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(write => write.kind === 'repair-series'
      && write.id === f.series.id && write.expected > 0)) {
      raced = true;
      const second = new Store(f.path);
      try { second.write({ id: seriesId(f.project, 'garden-consume-block', 2), kind: 'repair-series', expected: 0,
        value: { projectId: f.project, block: 'garden-consume-block', line: 2 } }); }
      finally { second.close(); }
    }
    return originalWrite(writes, guards);
  }) as Store['writeMany'];
  try { denied(await assessFact(f.store, request), 'input_stale'); }
  finally { f.store.writeMany = originalWrite; }
  assert.equal(raced, true);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  assert.equal(f.store.list('accepted-answer').length, 1);
  assert.equal(f.store.list('om-assessment-result').length, 1);
  assert.equal(f.sent().length, 2);
});

test('E5 closure atomically guards every result used to prove the full source set', async t => {
  const f = fixture(t, true), request = await f.original();
  f.assessor('supported', 'supported');
  ok(await assessFact(f.store, request));
  const first = f.store.list(ASSESSMENT_RESULT_KIND)[0]!;
  const originalWrite = f.store.writeMany.bind(f.store);
  let raced = false;
  f.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(write => write.kind === 'repair-series'
      && write.id === f.series.id && write.expected > 0)) {
      raced = true;
      const second = new Store(f.path);
      try {
        const latest = second.get(first.id)!;
        second.write({ id: first.id, kind: latest.kind, expected: latest.revision, value: latest.value });
      } finally { second.close(); }
    }
    return originalWrite(writes, guards);
  }) as Store['writeMany'];
  try { denied(await assessFact(f.store, { ...request, questionId: f.questionIds[1]! }), 'input_stale'); }
  finally { f.store.writeMany = originalWrite; }
  assert.equal(raced, true);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  assert.equal(f.store.list(ASSESSMENT_RESULT_KIND).length, 2);
  assert.equal(f.store.list('accepted-answer').length, 2);
  assert.equal(f.sent().length, 3);
});

test('E5 saved producer addresses retain the B1 era when its first input is missing', async t => {
  for (const kind of ['om-assessment-intent', 'om-assessment-result']) for (const value of [{}, { contract: 'incomplete' }]) {
    await t.test(`${kind} / ${Object.keys(value).length ? 'incomplete' : 'empty'}`, child => {
      const root = mkdtempSync(join(tmpdir(), 'omg-e5-era-')), path = join(root, 'state.sqlite'), project = 'e5-era';
      let store = new Store(path);
      new ProductEngine(store).execute({ type: 'create-project', project, title: 'Before B1' });
      child.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
      store.write({ id: `${kind}:${project}:retained`, kind, expected: 0, value });
      for (const restart of [false, true]) {
        if (restart) { store.close(); store = new Store(path); }
        const before = store.list().map(reference), engine = new ProductEngine(store);
        for (const action of [() => engine.projection(project),
          () => engine.execute({ type: 'assess', project, expected: 0 })]) {
          assert.throws(action, (error: unknown) => error instanceof EngineError && error.code === 'record_missing'
            && (error.details as { target?: string }).target === `om-input:${project}`);
          assert.deepEqual(store.list().map(reference), before);
        }
      }
    });
  }
});
