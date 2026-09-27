import { openAttempt as managedOpenAttempt, closeAttempt as managedCloseAttempt } from '../src/om/repeat-gate.js';
import { readCompletionBinding, completionWorkId } from '../src/om/series.js';
import { readCompletionWorkAt } from '../src/om/model-call.js';
import { spendReport, readSpendReport } from '../src/om/spend-report.js';
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
import { prepareManagedRouteBatch, writeRoutes } from '../src/om/routes.js';
import { prepareQuestionTasks, prepareQuestionPacket, writeQuestionPacket } from '../src/om/question-packet.js';
import { openSeries, beginAttempt, applySeriesActivation, seriesCurrentId, seriesId,
  type AttemptGoal, type RepairSeries } from '../src/om/series.js';
import { writeSeriesTransition } from '../src/om/series-transition.js';
import { closeAttempt } from '../src/om/repeat-gate.js';
import { readJournal, UNIT_REFUSAL_KIND } from '../src/om/refusal-journal.js';
import { gapLineKey, gapLineExpectedResult, prepareGapLines, writeGapLines, GAP_LINE_KIND } from '../src/om/gap-lines.js';
import { recordCall } from '../src/om/call-record.js';
import { runModelCall, runModelCycle, runModelTransport } from '../src/om/model-call.js';
import { readAcceptedAnswer, readAnswerSearch, applicableAnswer, prepareE5AcceptedAnswer,
  confirmAnswerGapClosure, answerIndexId, type Mc1QuestionRecord } from '../src/om/accepted-answer.js';
import { prepareAssessmentIntent, writeAssessmentIntent, readAssessmentIntentAt, readAssessmentResultAt, assessmentResultId,
  assessmentRefusalId, finishAssessmentAttempt, readAssessmentTerminalAt, readAssessmentSet, applyAssessmentResult,
  assessFact, ASSESSMENT_INTENT_KIND,
  ASSESSMENT_RESULT_KIND,
  type AssessmentIntentRequest, type AssessmentResultRecord } from '../src/om/assessment.js';
import { writeGuarded } from '../src/om/refs.js';
import { type OmResult } from '../src/om/refusal.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { prepareFrame, fillObligations } from '../src/om/frame-obligations.js';
import { writeCandidate } from '../src/om/frame-candidate.js';
import { settleCandidate } from '../src/om/frame-accept.js';

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
function fixture(t: TestContext, twoFacts = false, managed = false, completion = false, twoRoots = false) {
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
  const rootBatches = twoRoots ? [batch, routes.value.batches.find(row => row.task === 'node-expansion' && row.node === 'garden-consume-block')!] : [batch];
  if (twoRoots) assert.equal(rootBatches.length, 2);
  const block = 'garden-consume-block', source = store.get<{ content: string }>(`source:${project}:brief`)!;
  const goal: AttemptGoal = { key: 'e5:fact', questions: rootBatches.flatMap(row => row.items.map(item => gapLineKey(project, item.target, item.field))),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  const opened = ok(openSeries(store, { project, block, line: 1, slice: 'e5-fact', predecessor: null, basis: null }));
  if (managed) {
    const prepared = ok(writeSeriesTransition(store, { project, choiceVersion: 'e5-fact',
      horizon: reference(horizon.gate), series: [reference(opened)] }));
    const issuance = ok(writeHorizonIssuance(store, { project, choiceVersion: 'e5-fact',
      horizon: reference(horizon.gate), transition: reference(prepared) }));
    ok(applySeriesActivation(store, { project, prepared: reference(prepared), issuance: reference(issuance) }));
  }
  const series = ok((completion ? managedOpenAttempt : beginAttempt)(store, { project, block, line: 1, attempt: 1, goal,
    ...(completion ? { completion: { routes: reference(routes), batches: rootBatches.map(row => row.id) } } : {}) }));
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
    otherRoot() {
      const other = rootBatches.find(row => row.id !== batch.id)!;
      const next = ok(writeQuestionPacket(store,{project,routes:reference(routes),batch:other.id,environment:reference(config),
        attempt:{series:reference(series),ordinal:1},previous:[]})).record;
      return {request:{project,packet:reference(next),dispatch,role:'implementer' as const},questionId:other.items[0]!.gap,
        step:{research:{protocol:'omg-answer/v2',requestId:'$requestId',action:'answer',results:other.items.map(item=>({questionId:item.gap,
          value:'UTF-8',citations:[{source:reference(source),selector:{kind:'text-range',start:0,end:source.value.content.length}}]}))},usage}};
    },
    get store() { return store; },
    async secondOriginal(): Promise<AssessmentIntentRequest> {
      const prior = routes.value.request;
      const successor = ok(writeRoutes(store, { project, gaps: structuredClone(prior.gaps) as GapReadRequest,
        tasks: prior.tasks.map(record => ({ record })),
        catalog: { paths: [...prior.catalog.paths], records: [...prior.catalog.records] },
        previous: reference(routes) }));
      const nextBatch = successor.value.batches.find(item => item.model === 'MC1'
        && item.items.some(row => row.gap === questionId));
      assert.ok(nextBatch);
      const nextPacket = ok(writeQuestionPacket(store, { project, routes: reference(successor),
        batch: nextBatch.id, environment: reference(config),
        attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
      writeFileSync(scenario, JSON.stringify({ steps: [originalStep, originalStep] }));
      const model = ok(await runModelCall(store, { project, packet: reference(nextPacket), dispatch, role: 'implementer' }));
      assert.equal(model.outcome?.kind, 'fact-candidates');
      return { project, modelCall: reference(model.record), questionId, dispatch };
    },
    assessor(...verdicts: ('supported' | 'insufficient' | 'conflicting')[]) {
      const choices = verdicts.length ? verdicts : ['supported' as const];
      writeFileSync(scenario, JSON.stringify({ steps: [originalStep, ...choices.map(verdict =>
        ({ research: { verdict, reasons: verdict === 'supported' ? [] : ['source not decisive'] }, usage }))] }));
    },
    assessorsForTwoOriginals(...verdicts: ('supported' | 'insufficient' | 'conflicting')[]) {
      writeFileSync(scenario, JSON.stringify({ steps: [originalStep, originalStep, ...verdicts.map(verdict =>
        ({ research: { verdict, reasons: verdict === 'supported' ? [] : ['source not decisive'] }, usage }))] }));
    },
    sent() { return readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean); },
    restart() { store.close(); store = new Store(path); },
  };
}

async function completedFactClosure(f: ReturnType<typeof fixture>, explicitCompletion = false) {
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
  if (explicitCompletion) {
    const binding = ok(readCompletionBinding(f.store, f.project, reference(f.series), 1))!;
    const work = ok(readCompletionWorkAt(f.store, f.project, reference(f.store.get(completionWorkId(f.project, binding.id))!)));
    ok(closeAttempt(f.store, { project: f.project, block: 'garden-consume-block', line: 1, attempt: 1,
      outcome: { reason: 'result', accepting: work.accepting, cancelling: [], refusals: work.refusals } }));
  }
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

test('either proved E5 D5 answer of one semantic achievement can close D2 after the attempt', async t => {
  const f = fixture(t), first = await f.original(), second = await f.secondOriginal();
  const firstIntent = ok(writeAssessmentIntent(f.store, first));
  const question = f.store.get<Mc1QuestionRecord>(
    ok(readAssessmentIntentAt(f.store, f.project, reference(firstIntent))).question.record.id)!;
  const prior = question.value.request.gaps;
  const initial = ok(writeGapLines(f.store, { project: f.project, previous: null, pass: 1,
    gaps: prior, closures: [] }));
  // Both original MC1 calls are admitted before either assessor terminal; the first result
  // cannot finish the attempt while the second original response is still awaiting assessment.
  for (const source of [first, second]) {
    const intent = ok(writeAssessmentIntent(f.store, source));
    const admission = ok(readAssessmentIntentAt(f.store, f.project, reference(intent)));
    ok(recordCall(f.store, f.project, { call: admission.call, purpose: 'fact-assessment', basis: admission.basis,
      block: admission.block, gaps: admission.gaps, series: admission.series, attempt: admission.attempt,
      goal: admission.goal, dispatch: admission.dispatch, packet: admission.packet as Json }));
  }
  f.assessorsForTwoOriginals('supported', 'supported');
  const firstResult = ok(await assessFact(f.store, first));
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  const secondResult = ok(await assessFact(f.store, second));
  const answers = [firstResult.value.accepted!, secondResult.value.accepted!];
  assert.notEqual(answers[0]!.id, answers[1]!.id);
  const saved = f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome!;
  assert.equal(saved.reason, 'result');
  assert.equal(saved.achieved.length, 1);
  const alternate = answers.find(ref => ref.id !== saved.achieved[0]!.basis.id)!;
  const checked = ok(readAcceptedAnswer(f.store, { project: f.project, record: alternate }));
  const applied = ok(writeApplyAnswer(f.store, { project: f.project, input: question.value.request.input,
    answer: alternate, question: reference(question) }));
  const graph = prior.sources.graph;
  const horizon = ok(writeHorizon(f.store, { project: f.project, input: reference(applied), graph,
    refinement: null, available: {}, choice: { choiceVersion: 'e5-equivalent-d2',
      features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { ...structuredClone(prior.sources), input: reference(applied),
    horizon: reference(horizon.gate), operations: { ...structuredClone(prior.sources.operations),
      frame: { ...structuredClone(prior.sources.operations.frame), horizon: reference(horizon.gate) } } };
  const gaps = ok(writeGaps(f.store, sources));
  const current: GapReadRequest = { sources: structuredClone(gaps.sources) as GapRequest,
    records: gaps.records.map(reference) };
  const attempt = { series: checked.attempt!.series, attempt: checked.attempt!.ordinal };
  const closure = { id: checked.gap.id, reason: 'filled' as const, basis: alternate, acceptance: null,
    attempt, answer: { record: alternate } };
  const confirmation = { project: f.project, basis: closure.answer, target: checked.gap.target,
    field: checked.gap.field, prior, current, attempt, currentOnly: true };
  assert.equal(ok(confirmAnswerGapClosure(f.store, confirmation)).key, checked.key);
  f.restart();
  const next = { project: f.project, previous: reference(initial), pass: 2, gaps: current, closures: [closure] };
  assert.equal(ok(writeGapLines(f.store, next)).value.lines.find(line => line.id === closure.id)?.status, 'closed');
  assert.equal(f.sent().length, 4);
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

test('E5.1 closes the complete mixed set with its supported fact and negative refusal', async t => {
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
  const mixed = f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome;
  assert.ok(mixed);
  assert.equal(mixed.reason, 'result');
  assert.equal(mixed.achieved.length, 1);
  assert.equal(mixed.achieved[0]!.basis.id, firstResult.value.accepted!.id);
  assert.equal(mixed.refusals.length, 1);
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

test('E5.1 closes an insufficient fact as one refusal without D5 acceptance', async t => {
  const f = fixture(t), request = await f.original();
  f.assessor('insufficient');
  const terminal = ok(await assessFact(f.store, request));
  assert.equal(terminal.value.verdict, 'insufficient');
  assert.equal(terminal.value.accepted, null);
  assert.equal(terminal.value.index, null);
  const line = f.store.get<RepairSeries>(f.series.id)!.value;
  const closed = line.attempts[0]!.outcome;
  assert.equal(closed?.reason, 'refused');
  assert.equal(closed?.achieved.length, 0);
  assert.equal(closed?.refusals.length, 1);
  assert.equal(line.withoutProgress, 1);
  const row = ok(readJournal(f.store, { project: f.project })).value.rows
    .find(item => item.id === closed!.refusals[0]!.row);
  assert.equal(row?.gate, 'E5');
  assert.equal(row?.code, 'fact_assessment_insufficient');
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
    if (variant === 'off-form') assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
    else {
      const line = f.store.get<RepairSeries>(f.series.id)!.value;
      const closed = line.attempts[0]!.outcome;
      assert.equal(closed?.reason, 'refused');
      assert.equal(closed?.achieved.length, 0);
      assert.equal(closed?.refusals.length, 1);
      assert.equal(line.withoutProgress, 1);
      const row = ok(readJournal(f.store, { project: f.project })).value.rows
        .find(item => item.id === closed!.refusals[0]!.row);
      assert.equal(row?.gate, 'E5');
      assert.equal(row?.code, 'fact_assessment_conflicting');
    }
    f.restart();
    assert.deepEqual(ok(readAssessmentTerminalAt(f.store, f.project, reference(terminal))), terminal);
    assert.equal(f.sent().length, 2);
  });
});

test('real technical E5 terminals permit their own G7 close and exact restart repeat', async t => {
  for (const variant of ['off-form', 'interrupted'] as const) await t.test(variant, async child => {
    const f = fixture(child), request = await f.original();
    const assessorStep = variant === 'off-form'
      ? { research: { answer: 'untyped reviewer reply' }, usage }
      : { rawStdout: '{broken', exitCode: 7, stderr: 'intentional assessor failure' };
    writeFileSync(f.scenario, JSON.stringify({ steps: [f.originalStep, assessorStep] }));
    const terminal = ok(await assessFact(f.store, request));
    assert.equal(terminal.value.verdict, variant);
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
    const closing = { project: f.project, block: 'garden-consume-block', line: 1, attempt: 1,
      outcome: { reason: variant, accepting: [], cancelling: [], refusals: [] } };
    const wrongReason = closeAttempt(f.store, { ...closing, outcome: { ...closing.outcome,
      reason: variant === 'off-form' ? 'interrupted' as const : 'off-form' as const } });
    assert.equal(wrongReason.ok, false);
    if (!wrongReason.ok) assert.equal(wrongReason.refusal.code, 'origin_unreadable');
    const closed = ok(closeAttempt(f.store, closing));
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome?.reason, variant);
    const before = f.store.list().map(reference), sent = f.sent().length;
    f.restart();
    assert.deepEqual(ok(readAssessmentTerminalAt(f.store, f.project, reference(terminal))), terminal);
    assert.deepEqual(ok(closeAttempt(f.store, closing)), closed);
    assert.deepEqual(f.store.list().map(reference), before);
    assert.equal(f.sent().length, sent);
  });
});

test('a technical terminal retains its own verdict when a semantic E5 fact closes the attempt', async t => {
  for (const semantic of ['supported', 'insufficient'] as const) await t.test(semantic, async child => {
    const f = fixture(child, true), request = await f.original();
    writeFileSync(f.scenario, JSON.stringify({ steps: [f.originalStep,
      { research: { verdict: semantic, reasons: semantic === 'supported' ? [] : ['source not decisive'] }, usage },
      { research: { answer: 'untyped reviewer reply' }, usage }] }));
    const first = ok(await assessFact(f.store, request));
    assert.equal(first.value.verdict, semantic);
    const second = ok(await assessFact(f.store, { ...request, questionId: f.questionIds[1]! }));
    assert.equal(second.value.verdict, 'off-form');
    const finalized = ok(finishAssessmentAttempt(f.store, f.project, first.value.intent));
    assert.equal(finalized.complete, true);
    assert.equal(finalized.closed, true);
    const saved = f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome;
    assert.ok(saved);
    assert.equal(saved.reason, semantic === 'supported' ? 'result' : 'refused');
    assert.equal(saved.achieved.length, semantic === 'supported' ? 1 : 0);
    assert.equal(saved.refusals.length, semantic === 'insufficient' ? 1 : 0);
    assert.equal(f.store.list(UNIT_REFUSAL_KIND).length, semantic === 'insufficient' ? 1 : 0);
    if (semantic === 'supported') assert.equal(saved.achieved[0]!.basis.id, first.value.accepted!.id);
    else assert.equal(f.store.get(assessmentRefusalId(f.project, reference(first))) !== null, true);
    const wrong = closeAttempt(f.store, { project: f.project, block: 'garden-consume-block',
      line: 1, attempt: 1, outcome: { reason: 'off-form', accepting: [], cancelling: [], refusals: [] } });
    assert.equal(wrong.ok, false, 'the aggregate cannot erase the semantic terminal');
    const before = f.store.list().map(reference), calls = f.sent().length;
    f.restart();
    assert.deepEqual(ok(readAssessmentTerminalAt(f.store, f.project, reference(first))), first);
    assert.deepEqual(ok(readAssessmentTerminalAt(f.store, f.project, reference(second))), second);
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome?.reason, saved.reason);
    assert.deepEqual(f.store.list().map(reference), before);
    assert.equal(f.sent().length, calls);
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

test('19 H1.0a E5 registers every original fact and atomically retains S plus N until the single explicit G7 close', async t => {
  const f = fixture(t, true, false, true), request = await f.original();
  f.assessor('supported', 'insufficient');
  const first = ok(await assessFact(f.store, request));
  assert.ok(first.value.accepted);
  const binding = ok(readCompletionBinding(f.store, f.project, reference(f.series), 1))!;
  const id = completionWorkId(f.project, binding.id);
  let work = ok(readCompletionWorkAt(f.store, f.project, reference(f.store.get(id)!)));
  assert.equal(work.complete, false);
  assert.equal(work.assignments.filter(row => row.value.kind === 'fact').length, 2);
  const premature = managedCloseAttempt(f.store, { project: f.project, block: 'garden-consume-block', line: 1,
    attempt: 1, outcome: { reason: 'result', accepting: [first.value.accepted], cancelling: [], refusals: [] } });
  assert.equal(premature.ok, false);
  const secondRequest = { ...request, questionId: f.questionIds[1]! };
  const second = ok(await assessFact(f.store, secondRequest));
  assert.equal(second.value.verdict, 'insufficient');
  work = ok(readCompletionWorkAt(f.store, f.project, reference(f.store.get(id)!)));
  assert.equal(work.complete, true);
  assert.equal(work.refusals.length, 1);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
  const claim = { project: f.project, block: 'garden-consume-block', line: 1, attempt: 1,
    outcome: { reason: 'result' as const, accepting: work.accepting, cancelling: [], refusals: work.refusals } };
  ok(managedCloseAttempt(f.store, claim));
  const saved = f.store.get(f.series.id);
  f.restart();
  ok(managedCloseAttempt(f.store, claim));
  assert.deepEqual(f.store.get(f.series.id), saved);
  assert.deepEqual(ok(await assessFact(f.store, request)), first);
  assert.deepEqual(ok(await assessFact(f.store, secondRequest)), second);
  assert.equal(f.sent().length, 3);
});

test('20 H1.0a complete managed S/N/T composition controls G7 and physical E6 counts before and after closing', async t => {
  const combinations = [
    ['supported', 'supported'], ['supported', 'off-form'], ['insufficient', 'conflicting'],
    ['conflicting', 'off-form'], ['off-form', 'interrupted'], ['off-form', 'off-form'],
  ] as const;
  for (const choices of combinations) await t.test(choices.join('+'), async child => {
    const f = fixture(child, true, choices[0] === 'supported', true), request = await f.original();
    const step = (verdict: typeof choices[number]) => verdict === 'interrupted'
      ? { rawStdout: '{broken', exitCode: 7, stderr: 'intentional assessor failure' }
      : { research: verdict === 'off-form' ? { answer: 'no typed verdict' }
        : { verdict, reasons: verdict === 'supported' ? [] : ['source not decisive'] }, usage };
    writeFileSync(f.scenario, JSON.stringify({ steps: [f.originalStep, ...choices.map(step)] }));
    const requests = f.questionIds.map(questionId => ({ ...request, questionId }));
    const first = ok(await assessFact(f.store, requests[0]!));
    const binding = ok(readCompletionBinding(f.store, f.project, reference(f.series), 1))!;
    const snapshot = () => ok(readCompletionWorkAt(f.store, f.project,
      reference(f.store.get(completionWorkId(f.project, binding.id))!)));
    assert.equal(snapshot().complete, false);
    assert.equal(closeAttempt(f.store, { project:f.project, block:'garden-consume-block', line:1, attempt:1,
      outcome:{ reason:'off-form', accepting:[], cancelling:[], refusals:[] } }).ok, false);
    const second = ok(await assessFact(f.store, requests[1]!));
    const work = snapshot(); assert.equal(work.complete, true);
    assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome, null);
    const local = ok(spendReport(f.store, { project:f.project }));
    assert.equal(local.totals.calls, 3);
    assert.equal(local.byPurpose['fact-assessment']!.calls, 2);
    assert.equal(local.byPurpose['model-research'].calls, 1);
    const reason = work.accepting.length ? 'result' : work.negative.length ? 'refused'
      : choices.includes('interrupted' as never) ? 'interrupted' : 'off-form';
    const claim = { project:f.project, block:'garden-consume-block', line:1, attempt:1,
      outcome:{ reason, accepting:work.accepting, cancelling:[], refusals:work.refusals } } as const;
    if (work.accepting.length) assert.equal(closeAttempt(f.store, { ...claim,
      outcome:{...claim.outcome, accepting:[]} }).ok, false, 'A technical terminal cannot conceal S');
    if (work.refusals.length) assert.equal(closeAttempt(f.store, { ...claim,
      outcome:{...claim.outcome, refusals:[]} }).ok, false, 'A neighbouring T cannot conceal N');
    let completed:ReturnType<typeof ok<ReturnType<typeof closeAttempt> extends OmResult<infer T>?T:never>>;
    await child.test('29 complete composition is closed once only by explicit G7',()=>{
      completed=ok(closeAttempt(f.store,claim));
      assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome?.reason,reason);
    });
    const after = ok(spendReport(f.store, { project:f.project }));
    assert.deepEqual(after.totals, local.totals);
    const records = f.store.list().map(reference); f.restart();
    assert.deepEqual(ok(closeAttempt(f.store,claim)),completed!);
    await child.test('31 each local result repeats against the entire saved outcome',async()=>{
      assert.deepEqual(ok(await assessFact(f.store,requests[0]!)),first);
      assert.deepEqual(ok(await assessFact(f.store,requests[1]!)),second);
    });
    assert.deepEqual(ok(readSpendReport(f.store, local.snapshot)), local);
    assert.deepEqual(ok(readSpendReport(f.store, after.snapshot)), after);
    assert.deepEqual(f.store.list().map(reference), records);
    assert.equal(f.sent().length, 3);
  });
});

test('C28 H1.0a managed accepted E5 remains a lawful D2 source after explicit G7 and restart', async t => {
  const f = fixture(t, false, false, true), chain = await completedFactClosure(f, true);
  assert.equal(ok(confirmAnswerGapClosure(f.store, chain.confirmation)).key, chain.checked.key);
  f.restart();
  assert.equal(ok(confirmAnswerGapClosure(f.store, chain.confirmation)).key, chain.checked.key);
  const prepared = ok(prepareGapLines(f.store, chain.next));
  ok(writeGuarded(f.store, {unit:'D2',target:f.project,writes:prepared.writes,guards:prepared.guards}));
  assert.equal(f.sent().length, 2);
});

test('C10 H1.0a G7 carries product-head guards from before the full managed derivation', async t => {
  const f = fixture(t, true, false, true), request = await f.original();
  f.assessor('supported','supported');
  const first = ok(await assessFact(f.store, request));
  ok(await assessFact(f.store, {...request,questionId:f.questionIds[1]!}));
  const binding = ok(readCompletionBinding(f.store,f.project,reference(f.series),1))!;
  const work = ok(readCompletionWorkAt(f.store,f.project,reference(f.store.get(completionWorkId(f.project,binding.id))!)));
  const original = f.store.writeMany.bind(f.store); let raced = false;
  f.store.writeMany = ((writes,guards) => {
    if (!raced && writes.some(row => row.kind === 'om-completion-close')) {
      raced = true; const second = new Store(f.path);
      try { const head=second.get(first.id)!; second.write({id:head.id,kind:head.kind,expected:head.revision,value:head.value}); }
      finally {second.close();}
    }
    return original(writes,guards);
  }) as Store['writeMany'];
  try {
    const result=closeAttempt(f.store,{project:f.project,block:'garden-consume-block',line:1,attempt:1,
      outcome:{reason:'result',accepting:work.accepting,cancelling:[],refusals:work.refusals}});
    assert.equal(result.ok,false); if(!result.ok) assert.equal(result.refusal.code,'input_stale');
  } finally {f.store.writeMany=original;}
  assert.equal(raced,true);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
  assert.equal(f.store.list('om-completion-close').length,0);
  assert.equal(f.sent().length,3);
});

test('24 H1.0a a complete MC1 root cannot hide an unpaid MC2 root in the initial plan', async t => {
  const f=fixture(t,false,false,true,true), firstRequest=await f.original();
  f.assessor(); const first=ok(await assessFact(f.store,firstRequest));
  const binding=ok(readCompletionBinding(f.store,f.project,reference(f.series),1))!;
  const getWork=()=>ok(readCompletionWorkAt(f.store,f.project,reference(f.store.get(completionWorkId(f.project,binding.id))!)));
  assert.equal(getWork().assignments.filter(row=>row.value.kind==='root').length,2);
  assert.equal(getWork().complete,false);
  const firstIntent=ok(writeAssessmentIntent(f.store,firstRequest));
  await t.test('25 H1.0a local finish reports complete but the whole attempt is open',()=>{
    const finish=ok(finishAssessmentAttempt(f.store,f.project,reference(firstIntent)));
    assert.equal(finish.complete,true); assert.equal(finish.closed,false);
    assert.equal(closeAttempt(f.store,{project:f.project,block:'garden-consume-block',line:1,attempt:1,
      outcome:{reason:'result',accepting:[first.value.accepted!],cancelling:[],refusals:[]}}).ok,false);
  });
  const other=f.otherRoot();
  writeFileSync(f.scenario,JSON.stringify({steps:[f.originalStep,{research:{verdict:'supported',reasons:[]},usage},
    {research:{wrong:true},usage}]}));
  const physical=ok(await runModelCycle(f.store,other.request));
  assert.equal(physical.record.value.terminal,'outcome');
  const work=getWork();assert.equal(work.complete,true);assert.equal(work.accepting.length,1);
  const claim={project:f.project,block:'garden-consume-block',line:1,attempt:1,
    outcome:{reason:'result' as const,accepting:work.accepting,cancelling:[],refusals:work.refusals}};
  ok(closeAttempt(f.store,claim));const saved=f.store.list().map(reference); f.restart();
  ok(closeAttempt(f.store,claim));
  assert.deepEqual(ok(await assessFact(f.store,firstRequest)),first);
  assert.deepEqual(ok(await runModelCycle(f.store,other.request)).record,physical.record);
  assert.deepEqual(f.store.list().map(reference),saved);assert.equal(f.sent().length,3);
});

test('18 H1.0a answered assessor transport is still I until its exact E5 application',async t=>{
  const f=fixture(t,false,false,true),request=await f.original(),intent=ok(writeAssessmentIntent(f.store,request));
  const admission=ok(readAssessmentIntentAt(f.store,f.project,reference(intent)));
  const admitted=ok(recordCall(f.store,f.project,{call:admission.call,purpose:'fact-assessment',basis:admission.basis,
    block:admission.block,gaps:admission.gaps,series:admission.series,attempt:admission.attempt,goal:admission.goal,
    dispatch:admission.dispatch,packet:admission.packet as Json}));
  f.assessor();
  const physical=ok(await runModelTransport(f.store,{project:f.project,call:reference(admitted.call),packet:admission.packet as Json,role:'reviewer'}));
  assert.equal(physical.record.value.transport.version,'om-model-transport/managed-v1');
  const binding=ok(readCompletionBinding(f.store,f.project,reference(f.series),1))!;
  const getWork=()=>ok(readCompletionWorkAt(f.store,f.project,reference(f.store.get(completionWorkId(f.project,binding.id))!)));
  assert.equal(getWork().complete,false);
  assert.equal(closeAttempt(f.store,{project:f.project,block:'garden-consume-block',line:1,attempt:1,
    outcome:{reason:'result',accepting:[],cancelling:[],refusals:[]}}).ok,false);
  const result=ok(await assessFact(f.store,request));assert.equal(result.value.verdict,'supported');
  assert.equal(getWork().complete,true);assert.equal(f.sent().length,2);
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
});

test('2 H1.0a standalone E5 keeps its accepted automatic completion and exact historical repeat',async t=>{
  const f=fixture(t),request=await f.original();f.assessor();
  const terminal=ok(await assessFact(f.store,request));
  assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome?.reason,'result');
  assert.equal(f.store.list('om-completion-owner').length,0);
  const saved=f.store.list().map(reference);f.restart();
  assert.deepEqual(ok(await assessFact(f.store,request)),terminal);assert.deepEqual(f.store.list().map(reference),saved);
  assert.equal(f.sent().length,2);
});

/** Two unique input questions share one block through the accepted L2 realizes relation. */
function twoMc1Fixture(t: TestContext, deferredPackets = false) {
  const root=mkdtempSync(join(tmpdir(),'omg-h10a-multi-')), path=join(root,'state.sqlite'), project='garden';
  let store=new Store(path); const engine=new ProductEngine(store);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const block='garden-produce-block', other='garden-consume-block', operation='garden-produce-operation';
  const descriptors=[{id:'shared-format',consumer:operation},{id:'local-encoding',consumer:block}];
  const graph=gardenGraph();
  graph.edges!.push({id:'shared-produce-realizes-consume',relation:'realizes',source:operation,target:other,condition:'shared responsibility'});
  const {level:_level,...l1}=projectGraph(graph,1);
  preparedFeatures(engine,project,{...l1,version:graph.version},field=>{
    const value=preparedField(project,field) as Record<string,Json>;
    if(field==='preparation')value.unknowns=descriptors.map(d=>({id:d.id,question:`Which ${d.id} is supported?`,
      consumer:d.consumer,moment:'om-pass',blocksCurrentStage:false,resolution:'Resolve during OM'}));
    return value;
  });
  const stages=Object.fromEntries(UPSTREAM_STAGES.map(stage=>[stage,reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage,Ref>;
  const input=ok(writeOmInput(store,{project,expected:0,stages})),graph0=reference(store.get('graph:garden')!);
  const horizon0=ok(writeHorizon(store,{project,input:reference(input),graph:graph0,refinement:null,available:{},
    choice:{choiceVersion:'before-l2',features:[{outcome:'garden-result'}],excluded:[]}}));
  const frame={project,level:2 as const,graph:graph0,horizon:reference(horizon0.gate),layer:null,frame:null,upper:null};
  const initial=ok(prepareFrame(store,frame)), projected=projectGraph(graph,2);
  const fills=ok(fillObligations(initial.upper as Graph,structuredClone(initial.scope) as Parameters<typeof fillObligations>[1],
    {graph,reference:{...graph0,hash:hashJson(graph)},frame:null},initial.upperRef,2));
  const offered=store.write({id:'om-proposal:garden:shared-operation',kind:'layer-proposal',expected:0,value:{
    base:{graph:graph0,frame:null},level:2,source:'decision',status:'proposed',nodes:projected.nodes.filter(n=>n.kind==='operation'),
    fills:fills.fills.map(f=>({obligation:f.obligation,node:f.node,...(f.port===undefined?{}:{port:f.port})})),
    localConnectors:projected.connectors.map(c=>({...c,bindings:c.bindings.filter(b=>b.level===2)})).filter(c=>c.bindings.length),
    artifacts:projected.artifacts,contracts:projected.contracts,joins:projected.joins,anchors:projected.anchors,tests:projected.tests,
    edges:projected.edges??[],journeys:projected.journeys??[],packets:projected.packets??[],transfers:projected.transfers??[],
    removes:[],replaces:[],redefines:[]}});
  const candidate=ok(writeCandidate(store,{frame,proposals:[reference(offered)]}));
  assert.equal(candidate.state,'candidate');assert.ok(candidate.record);
  const accepted=ok(settleCandidate(store,{project,level:2,candidate:reference(candidate.record),outcome:{gate:'G3',
    candidate:reference(candidate.record),graphHash:candidate.record.value.graphHash,passed:true,codes:[]}}));
  assert.equal(accepted.state,'accepted');assert.ok(accepted.graph&&accepted.layer&&accepted.frame);
  const graphRef=reference(accepted.graph),layerRef=reference(accepted.layer),frameRef=reference(accepted.frame);
  const addressed=ok(writeAddressing(store,{project,input:reference(input),graph:graphRef,decisions:descriptors.map(d=>({pending:
    structuredClone(inputDecisionWrite({project,input:reference(input),graph:graphRef,layers:d.consumer===operation?[layerRef]:[],
      decision:{target:`discovery:${d.id}`,field:'address',value:{consumer:d.consumer,kind:'repository-fact'}}})) as Write}))}));
  const horizon=ok(writeHorizon(store,{project,input:reference(addressed),graph:graphRef,refinement:layerRef,available:{},
    choice:{choiceVersion:'shared-operation',features:[{outcome:'garden-result'}],excluded:[]}}));
  const sources:GapRequest={project,input:reference(addressed),graph:graphRef,horizon:reference(horizon.gate),
    operations:{proposals:[],frame:{project,level:2,graph:graphRef,horizon:reference(horizon.gate),layer:layerRef,frame:frameRef,upper:null}},
    works:{proposals:[],frame:{project,level:3,graph:graphRef,horizon:reference(horizon.gate),layer:null,frame:null,
      upper:{horizon:reference(horizon.gate),frame:frameRef}}}};
  const gaps=ok(writeGaps(store,sources));
  const facts=gaps.records.filter(r=>r.value.gap.kind==='repository-fact'&&r.value.gap.code==='predecessor_question'&&!r.value.gap.deferral);
  assert.equal(facts.length,2);
  assert.deepEqual(facts.find(r=>r.value.gap.target==='discovery:shared-format')!.value.gap.consumers,[other,block].sort());
  assert.deepEqual(facts.find(r=>r.value.gap.target==='discovery:local-encoding')!.value.gap.consumers,[block]);
  const gapRequest:GapReadRequest={sources:structuredClone(gaps.sources) as GapRequest,records:gaps.records.map(reference)};
  const tasks=ok(prepareQuestionTasks(store,{project,gaps:gapRequest,questions:facts.map(gap=>({gap:reference(gap),
    requirements:[{pointer:'/contracts/0'}],resultForm:{type:'string'}}))}));
  const routes=ok(writeRoutes(store,{project,gaps:gapRequest,tasks:tasks.tasks.map(task=>({pending:structuredClone(task.writes[0]!) as Write})),
    catalog:{paths:[],records:[]},previous:null}));
  const batches=routes.value.batches.filter(b=>b.model==='MC1');
  assert.equal(batches.length,2);assert.ok(batches.every(b=>b.items.every(item=>item.consumers.includes(block))));
  ok(openSeries(store,{project,block,line:1,slice:'two-mc1',predecessor:null,basis:null}));
  const goal={key:'two-mc1',questions:batches.flatMap(b=>b.items.map(item=>gapLineKey(project,item.target,item.field))),
    result:gapLineExpectedResult(project,batches[0]!.items[0]!.target,batches[0]!.items[0]!.field)};
  const opening={project,block,line:1,attempt:1,goal,completion:{routes:reference(routes),batches:batches.map(b=>b.id)}};
  const series=ok(managedOpenAttempt(store,opening)),scenario=join(root,'scenario.json'),trace=join(root,'trace.jsonl');
  const command={executable:process.execPath,args:[adapterFixture,'--scenario',scenario,'--trace',trace]};
  const config=engine.environments.configure(project,{workspace:root,implementer:{actor:'multi-researcher',model:'fixture',effort:'high',command},
    reviewer:{actor:'multi-assessor',model:'fixture-reviewer',effort:'high',command},fullCheck:{executable:process.execPath,args:['--version']},
    timeoutMs:5000,requestCapacityChars:100_000},0);
  const adapter=store.write({id:`adapter:${project}:multi`,kind:'dispatch-adapter',expected:0,value:{projectId:project,protocol:'codex-stdio'}});
  const dispatch={config:reference(config),adapter:reference(adapter)},source=store.get<{content:string}>(`source:${project}:brief`)!;
  const packetRequests=batches.map(batch=>({project,routes:reference(routes),batch:batch.id,environment:reference(config),
    attempt:{series:reference(series),ordinal:1},previous:[]}));
  const requests:{project:string;dispatch:typeof dispatch;role:'implementer';packet:Ref}[]=[];
  function requestFor(index:number){return requests[index]??=(
    {project,dispatch,role:'implementer',packet:reference(ok(writeQuestionPacket(store,packetRequests[index]!)).record)});}
  if(!deferredPackets)batches.forEach((_,index)=>requestFor(index));
  const steps=batches.map(batch=>({research:{protocol:'omg-answer/v2',requestId:'$requestId',action:'answer',results:batch.items.map(item=>({
    questionId:item.gap,value:'UTF-8',citations:[{source:reference(source),selector:{kind:'text-range',start:0,end:source.value.content.length}}]}))},usage}));
  return {project,block,series,dispatch,requests,packetRequests,requestFor,batches,steps,scenario,opening,path,get store(){return store;},
    sent(){return readFileSync(trace,'utf8').trim().split('\n').filter(Boolean);},restart(){store.close();store=new Store(path);}};
}

test('24 H1.0a two genuine MC1 roots share a block through realizes and retain both mandatory fact sets',async t=>{
  for(const deferredPackets of [false,true])for(const order of [[0,1],[1,0]])await t.test(`C38 root order ${order.join(',')}; E2 ${deferredPackets?'after':'before'} neighbouring S`,async child=>{
    const f=twoMc1Fixture(child,deferredPackets),results:ReturnType<typeof reference>[]=[];
    writeFileSync(f.scenario,JSON.stringify({steps:order.flatMap(i=>[f.steps[i],{research:{verdict:'supported',reasons:[]},usage}])}));
    const intents:Ref[]=[],assessments:AssessmentIntentRequest[]=[];
    for(const [position,i] of order.entries()){
      const model=ok(await runModelCall(f.store,f.requestFor(i)));assert.equal(model.outcome?.kind,'fact-candidates');
      const request={project:f.project,modelCall:reference(model.record),questionId:f.batches[i]!.items[0]!.gap,dispatch:f.dispatch};
      const terminal=ok(await assessFact(f.store,request));results.push(reference(terminal));assessments.push(request);intents.push(terminal.value.intent);
      const binding=ok(readCompletionBinding(f.store,f.project,reference(f.series),1))!;
      const work=ok(readCompletionWorkAt(f.store,f.project,reference(f.store.get(completionWorkId(f.project,binding.id))!)));
      assert.equal(work.complete,position===1);
      assert.equal(f.store.get<RepairSeries>(f.series.id)!.value.attempts[0]!.outcome,null);
      assert.deepEqual(ok(finishAssessmentAttempt(f.store,f.project,terminal.value.intent)),{complete:true,closed:false,results:[reference(terminal)]});
      if(position===0){
        const denied=prepareQuestionPacket(f.store,f.packetRequests[i]!);
        assert.equal(denied.ok,false);if(!denied.ok)assert.equal(denied.refusal.code,'route_stale','An applicable target D5 forbids another send');
        const before=f.store.list().map(reference);
        assert.equal(closeAttempt(f.store,{project:f.project,block:f.block,line:1,attempt:1,
          outcome:{reason:'result',accepting:work.accepting,cancelling:[],refusals:work.refusals}}).ok,false);
        assert.deepEqual(f.store.list().map(reference),before);
      }
    }
    const binding=ok(readCompletionBinding(f.store,f.project,reference(f.series),1))!;
    const work=ok(readCompletionWorkAt(f.store,f.project,reference(f.store.get(completionWorkId(f.project,binding.id))!)));
    assert.equal(work.accepting.length,2);assert.equal(work.assignments.filter(row=>row.value.kind==='fact').length,2);
    const claim={project:f.project,block:f.block,line:1,attempt:1,
      outcome:{reason:'result' as const,accepting:work.accepting,cancelling:[],refusals:work.refusals}};
    const closed=ok(closeAttempt(f.store,claim)),saved=f.store.list().map(reference);f.restart();
    assert.deepEqual(ok(closeAttempt(f.store,claim)),closed);
    for(const [i,request]of assessments.entries()){
      assert.deepEqual(reference(ok(await assessFact(f.store,request))),results[i]);
      assert.deepEqual(ok(finishAssessmentAttempt(f.store,f.project,intents[i]!)),{complete:true,closed:true,results:[results[i]!]});
    }
    for(const request of f.requests)assert.equal(ok(await runModelCall(f.store,request)).repeated,true);
    assert.deepEqual(f.store.list().map(reference),saved);assert.equal(f.sent().length,4);
    assert.equal(ok(spendReport(f.store,{project:f.project})).totals.calls,4);
  });
});

test('C38 H1.0a neighbouring S during receipt preserves target admission while target and common changes remain guarded',async t=>{
  const f=twoMc1Fixture(t,true);
  writeFileSync(f.scenario,JSON.stringify({steps:[f.steps[0],{research:{verdict:'supported',reasons:[]},usage},
    f.steps[1],{research:{verdict:'supported',reasons:[]},usage}]}));
  const original=ok(await runModelCall(f.store,f.requestFor(0)));
  const intent=ok(writeAssessmentIntent(f.store,{project:f.project,modelCall:reference(original.record),
    questionId:f.batches[0]!.items[0]!.gap,dispatch:f.dispatch}));
  const assessment=ok(readAssessmentIntentAt(f.store,f.project,reference(intent)));
  const admitted=ok(recordCall(f.store,f.project,{call:assessment.call,purpose:'fact-assessment',basis:assessment.basis,
    block:assessment.block,gaps:assessment.gaps,series:assessment.series,attempt:assessment.attempt,goal:assessment.goal,
    dispatch:assessment.dispatch,packet:assessment.packet as Json}));
  const transport=ok(await runModelTransport(f.store,{project:f.project,call:reference(admitted.call),packet:assessment.packet as Json,role:'reviewer'}));
  const before=(index:number)=>ok(prepareManagedRouteBatch(f.store,{project:f.project,series:reference(f.series),attempt:1,
    routes:f.opening.completion.routes,batch:f.batches[index]!.id}));
  const own=before(0),target=before(1),request=f.requestFor(1);
  assert.ok(target.guards.some(ref=>canonical(ref)===canonical(reference(f.series))));
  const get=f.store.get.bind(f.store);
  f.store.get=((id:string,revision?:number)=>id===f.series.id&&revision===undefined?null:get(id,revision)) as Store['get'];
  try {
    const missingLine=prepareManagedRouteBatch(f.store,{project:f.project,series:reference(f.series),attempt:1,
      routes:f.opening.completion.routes,batch:f.batches[1]!.id});
    assert.equal(missingLine.ok,false);
    if(!missingLine.ok)assert.equal(missingLine.refusal.code,'series_conflict');
  } finally { f.store.get=get; }
  const ownIndex=answerIndexId(f.project,f.batches[0]!.items[0]!.target,f.batches[0]!.items[0]!.field);
  assert.ok(own.guards.some(ref=>ref.id===ownIndex));assert.ok(!target.guards.some(ref=>ref.id===ownIndex));
  const writeMany=f.store.writeMany.bind(f.store);let raced=false;
  f.store.writeMany=((writes,guards)=>{
    const saved=writeMany(writes,guards);
    if(!raced&&writes.some(row=>row.kind==='model-call'&&(row.value as {om?:{application:string;request:{packet:Ref}}}).om?.application==='received')){
      raced=true;const second=new Store(f.path);
      try{ok(applyAssessmentResult(second,{project:f.project,intent:reference(intent),assessor:reference(transport.record)}));}
      finally{second.close();}
    }
    return saved;
  }) as Store['writeMany'];
  let received:ReturnType<typeof ok<Awaited<ReturnType<typeof runModelCall>> extends OmResult<infer T>?T:never>>;
  try{received=ok(await runModelCall(f.store,request));}finally{f.store.writeMany=writeMany;}
  assert.equal(raced,true);assert.equal(received.outcome?.kind,'fact-candidates');
  assert.equal(received.record.value.om.application,'applied');assert.equal(f.sent().length,3);
  const stale=writeGuarded(f.store,{unit:'test',target:'target-search',writes:[{id:'test:target-search',kind:'test',expected:0,value:{}}],guards:own.guards});
  assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.refusal.code,'input_stale');
  assert.equal(f.store.get('test:target-search'),null);
  const answer=ok(await assessFact(f.store,{project:f.project,modelCall:reference(received.record),
    questionId:f.batches[1]!.items[0]!.gap,dispatch:f.dispatch}));assert.equal(answer.value.verdict,'supported');
  const saved=f.store.list().map(reference);f.restart();
  assert.equal(ok(await runModelCall(f.store,request)).repeated,true);assert.deepEqual(f.store.list().map(reference),saved);
  const graph=f.store.get<Graph>(`graph:${f.project}`)!;
  new ProductEngine(f.store).graphs.save(f.project,graph.value,graph.revision,'change a shared source');
  const common=writeGuarded(f.store,{unit:'test',target:'common-source',writes:[{id:'test:common-source',kind:'test',expected:0,value:{}}],guards:target.guards});
  assert.equal(common.ok,false);if(!common.ok)assert.equal(common.refusal.code,'input_stale');
  assert.equal(prepareQuestionPacket(f.store,f.packetRequests[1]!).ok,false);
});
