import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Json } from '../src/canonical.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { Question } from '../src/discovery/discovery.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import { assessFact } from '../src/om/assessment.js';
import { EngineError } from '../src/errors.js';
import { type Graph, type Node } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import type { Environment } from '../src/runtime/environment.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Write } from '../src/storage/store.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { mc1FieldSpec, prepareAnswerTask, readAcceptedAnswer, writeAcceptedAnswer, writeMc1Question,
  type AnswerQuestionContract, type AnswerRequest, type Mc1QuestionRequest } from '../src/om/accepted-answer.js';
import { prepareAnswersGate, readAnswersGate, writeAnswersGate, type AnswersGateRequest } from '../src/om/answers-gate.js';
import { readCall, recordCall } from '../src/om/call-record.js';
import { gateCandidate, writeCandidate } from '../src/om/frame-candidate.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import { prepareFrameProposals, type LayerProposal } from '../src/om/frame-proposals.js';
import { writeGaps, type GapReadRequest, type GapRequest } from '../src/om/gaps.js';
import { gapLineExpectedResult, gapLineKey, writeGapLines } from '../src/om/gap-lines.js';
import { writeHorizon } from '../src/om/horizon.js';
import { readOmInput, writeOmInput } from '../src/om/input.js';
import { assembleModelParts, readModelCallState, readPartAssembly, runModelCall } from '../src/om/model-call.js';
import { writeOmObligations } from '../src/om/obligations.js';
import { PACKET_ANSWER_PROTOCOL, partResponseId, preparePartResult, readPartResult, writeQuestionPacket } from '../src/om/question-packet.js';
import { writeGuarded } from '../src/om/refs.js';
import { writeRoutes } from '../src/om/routes.js';
import { beginAttempt, completeAttempt, openSeries, type AttemptGoal } from '../src/om/series.js';
import type { OmResult } from '../src/om/refusal.js';
import { createOmFixture, gardenGraph } from './om-fixture.js';
import { seedCopy } from './om-seed.js';
import { canonical, hashJson } from '../src/canonical.js';
import { isRef } from '../src/pipeline/contracts.js';
import type { Revision } from '../src/storage/store.js';
import type { Sealed } from '../src/om/refusal.js';
import { applyAssessmentResult, readAssessmentIntentAt, writeAssessmentIntent } from '../src/om/assessment.js';
import { ANSWERS_GATE_EMISSIONS, ANSWERS_GATE_MISMATCHES, ANSWERS_GATE_SOURCE_ROLES, prepareAnswersGateTrace,
  readAnswersGateTrace, type AnswerRouteResult, type AnswersGateRecord, type AnswersGateTraceEntry } from '../src/om/answers-gate.js';
import { readFileSync } from 'node:fs';
import { readMc1Question } from '../src/om/accepted-answer.js';
import { runModelTransport } from '../src/om/model-call.js';
import { openAttempt as managedOpenAttempt } from '../src/om/repeat-gate.js';
import { preparedField } from './preparation-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { ANSWERS_GATE_CODES, answersRegistrationId, prepareAnswersRegistration, readAnswersRegistrationAt,
  writeAnswersRegistration } from '../src/om/answers-gate.js';
import { answersGateAssignment, completionAssignmentId, completionCloseId, completionRootAssignments, completionWorkId,
  readAnswersGateAssignmentAt, readCompletionBinding, type CompletionWork } from '../src/om/series.js';
import { readCompletionAssignmentAt, readCompletionWorkAt } from '../src/om/model-call.js';
import { closeAttempt, prepareManagedClaim } from '../src/om/repeat-gate.js';
import { runModelCycle } from '../src/om/model-call.js';
import { ANSWERS_EVALUATION_KIND, ANSWERS_FINDING_KIND, answersEvaluationId, answersRefusalId,
  prepareAnswersDelivery, prepareAnswersEvaluation, readAnswersEvaluationAt, readAnswersFindingAt, readAnswersGateRefusalAt,
  writeAnswersDelivery, writeAnswersEvaluation } from '../src/om/answers-gate.js';
import { classifyRefusal, journalId, readJournal, readJournalAt } from '../src/om/refusal-journal.js';
import { prepareCompletionProducts, writeCompletionCessation } from '../src/om/model-call.js';

const clone = structuredClone;
const adapterFixture = fileURLToPath(new URL('../../test/om-adapter-fixture.mjs', import.meta.url));
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function snapshot(store: Store): Ref[] { return store.list().map(reference); }

type QuestionKind = 'owner-decision' | 'repository-fact' | 'design-decision'
  | 'environment-confirmation' | 'post-implementation-proof' | null;
/**
 * H1.0c S6 options: the consuming block of the fixture question, and the later feature of the garden (as in
 * om-series-current), so that a horizon may select only the later result and exclude that block's line.
 */
interface FixtureOptions { block?: string; later?: boolean }
function laterField(field: string, value: Json): void {
  if (field === 'preparation') {
    const rows = (value as Record<string, Json>).outcomes as Record<string, Json>[];
    rows.push({ ...clone(rows[0]!), id: 'garden-later', result: 'The later result' });
  }
  if (field === 'conceptSections') {
    const rows = (value as unknown as { requirements: Record<string, Json>[] }[])[0]!.requirements;
    rows.push({ ...clone(rows[0]!), id: 'garden-R2', outcome: 'garden-later', statement: 'Deliver the later result' });
  }
  if (field === 'operationRequirements') {
    const body = value as Record<string, Json>, rows = body.outcomes as Record<string, Json>[];
    rows.push({ ...clone(rows[0]!), outcome: 'garden-later' });
    (body.conceptCoverage as Json[]).push({ requirement: 'garden-R2', outcome: 'garden-later' });
  }
  if (field === 'behaviorContracts') {
    const rows = value as unknown as Record<string, Json>[];
    rows.push({ ...clone(rows[0]!), id: 'garden-B2', requirements: ['garden-R2'], outcome: 'garden-later' });
  }
  if (field === 'features' || field === 'featurePreparation') {
    const rows = value as unknown as Record<string, Json>[];
    rows.push({ ...clone(rows[0]!), [field === 'features' ? 'title' : 'featureTitle']: 'Deliver later result', outcome: 'garden-later',
      ...(field === 'featurePreparation' ? { requirements: ['garden-R2'], behaviorContracts: ['garden-B2'] } : {}) });
  }
}
/** The whole fixture names no directory, so each variant is one seed (om-seed.ts); every test works on its own copy. */
function gatePrefix(store: Store, kind: QuestionKind, addressQuestion: boolean, secondQuestion: boolean, options: FixtureOptions) {
  const engine = new ProductEngine(store), project = 'garden', block = options.block ?? 'garden-produce-block';
  const { level: _level, ...l1 } = projectGraph(gardenGraph(), 1);
  if (options.later) {
    l1.requirements!.push({ ...clone(l1.requirements![0]!), id: 'garden-R2', outcome: 'garden-later', statement: 'Deliver the later result' });
    l1.nodes.find(node => node.id === 'garden-later-block')!.implements!.push('garden-R2');
  }
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (options.later) laterField(field, value as Json);
    if (field === 'preparation' && kind) (value as Record<string, Json>).unknowns = [
      { id: 'owner-choice', question: 'Which output should this project use?', consumer: block, moment: 'om-pass',
        blocksCurrentStage: false, resolution: 'Resolve the named decision before assembling work' },
      ...(secondQuestion ? [{ id: 'other-choice', question: 'Which second output should this project use?', consumer: block,
        moment: 'om-pass', blocksCurrentStage: false, resolution: 'Resolve the named decision before assembling work' }] : []),
    ];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage,
    reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const first = ok(writeOmInput(store, { project, expected: 0, stages }));
  const graph = store.get<Graph>(`graph:${project}`)!;
  const target = 'discovery:owner-choice';
  const input = kind && addressQuestion ? ok(writeAddressing(store, { project, input: reference(first), graph: reference(graph),
    decisions: (secondQuestion ? [target, 'discovery:other-choice'] : [target]).map(address => ({ pending: clone(inputDecisionWrite({
      project, input: reference(first), graph: reference(graph), layers: [],
      decision: { target: address, field: 'address', value: { consumer: block, kind } },
    })) as Write })) })) : first;
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null,
    available: {}, choice: { choiceVersion: 'answers-gate-fixture', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(store, sources));
  const gapRead: GapReadRequest = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const blocking = gaps.records.filter(row => row.value.gap.blocking);
  const fact = blocking.find(row => row.value.gap.target === target && row.value.gap.kind === 'repository-fact');
  const task = fact ? ok(prepareAnswerTask(store, { project, input: reference(input), gaps: gapRead,
    gap: reference(fact), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) : null;
  const other = secondQuestion ? blocking.find(row => row.value.gap.target === 'discovery:other-choice'
    && row.value.gap.kind === 'repository-fact') : null;
  const otherTask = other ? ok(prepareAnswerTask(store, { project, input: reference(input), gaps: gapRead,
    gap: reference(other), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) : null;
  const tasks = [task, otherTask].filter((entry): entry is NonNullable<typeof task> => entry !== null)
    .map(entry => entry.writes.length ? { pending: clone(entry.writes[0]!) as Write } : { record: reference(entry.record) });
  const route = ok(writeRoutes(store, { project, gaps: gapRead, tasks, catalog: { paths: [], records: [] }, previous: null }));
  const request: AnswersGateRequest = { project, gaps: gapRead, routes: reference(route), results: [] };
  return { project, target, block, input, graph, horizon, gaps, blocking, route, request, task };
}
function fixture(t: TestContext, kind: QuestionKind = null, addressQuestion = true, secondQuestion = false, options: FixtureOptions = {}) {
  const seeded = seedCopy(`answers-gate:${kind}:${addressQuestion}:${secondQuestion}:${options.block ?? ''}:${options.later ?? false}`,
    store => gatePrefix(store, kind, addressQuestion, secondQuestion, options), 'omg-answers-gate-');
  const { root, database: path } = seeded;
  let store = new Store(path);
  const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, ...seeded.data,
    get engine() { return engine; },
    get store() { return store; }, restart() { store.close(); store = new Store(path); } };
}

async function acceptedFact(f: ReturnType<typeof fixture>, options: { suffix?: string; previous?: Ref } = {}) {
  const fact = f.blocking.find(row => row.value.gap.target === f.target && row.value.gap.kind === 'repository-fact')!;
  assert.ok(fact);
  const currentInput = ok(readOmInput(f.store, f.project, reference(f.input)));
  const contract: AnswerQuestionContract = {
    establishes: currentInput.value.input.questions.find(question => question.id === f.target)!.question,
    consumer: { blocks: [...fact.value.gap.consumers] },
    requirements: [clone(currentInput.value.input.contracts[0]!) as unknown as Json],
    resultForm: { type: 'string' },
  };
  const draft = f.engine.discovery.create(f.project, 'om-g2', 'R1', f.block,
    [mc1FieldSpec({ input: reference(f.input), gap: reference(fact), contract })],
    [reference(f.input), reference(fact)]);
  const issued = f.store.get<Question>(draft.value.questions[0]!)!;
  const questionRequest: Mc1QuestionRequest = { project: f.project, input: reference(f.input),
    gaps: f.request.gaps, gap: reference(fact), contract, requirements: [{ pointer: '/contracts/0' }],
    engineQuestion: reference(issued), draft: reference(draft) };
  const question = ok(writeMc1Question(f.store, questionRequest));
  const command = { executable: process.execPath, args: ['-e',
    "const req=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{verdict:'supported',reasons:[]}}));"] };
  const environment = f.store.get<Environment>(`environment:${f.project}`) ?? f.engine.environments.configure(f.project, { workspace: f.root,
    implementer: { actor: 'answers-researcher', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'answers-assessor', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000 }, 0);
  const filename = options.suffix ? `answer-${options.suffix}.json` : 'answer.json';
  const sourceName = options.suffix ? `answer-source-${options.suffix}` : 'answer-source';
  writeFileSync(join(f.root, filename), JSON.stringify({ answer: 'JSON' }));
  const source = f.engine.discovery.evidence.file(f.project, sourceName, f.root, filename, 'application/json', 0);
  const assessment = await assessAnswer(f.store, issued, { action: 'answer', question: issued.id, value: 'JSON',
    citations: [{ source: reference(f.store.get(source.id)!), selector: { kind: 'json-pointer', pointer: '/answer' } }] },
  environment, f.root);
  const answeredDraft = f.engine.discovery.researched(issued.id, issued.revision, reference(assessment));
  const answered = f.store.get<Question>(issued.id)!;
  const answerRequest: AnswerRequest = { project: f.project, question: reference(question), answer: answered.value.answer!,
    answeredQuestion: reference(answered), draft: reference(answeredDraft), attempt: null };
  const accepted = ok(writeAcceptedAnswer(f.store, answerRequest));
  const task = f.route.value.routes.find(row => row.gap === fact.value.gap.id)!.task!;
  const route = ok(writeRoutes(f.store, { project: f.project, gaps: f.request.gaps,
    tasks: f.route.value.routes.filter(row => row.task).map(row => ({ record: row.task! })),
    catalog: { paths: [], records: [] }, previous: options.previous ?? reference(f.route) }));
  return { fact, assessment, accepted, route, task };
}

async function assessedFact(f: ReturnType<typeof fixture>, verdict: 'supported' | 'insufficient' | 'conflicting' | 'off-form') {
  const batch = f.route.value.batches.find(item => item.model === 'MC1' && item.items.some(question => question.target === f.target))!;
  assert.ok(batch);
  const source = f.store.get<{ content: string }>(`source:${f.project}:brief`)!;
  assert.ok(source?.value.content);
  const goal: AttemptGoal = { key: `answers:e5:${f.target}`,
    questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  ok(openSeries(f.store, { project: f.project, block: f.block, line: 1,
    slice: 'answers:e5', predecessor: null, basis: null }));
  const series = ok(beginAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1, goal }));
  const scenario = join(f.root, 'assessment-scenario.json'), trace = join(f.root, 'assessment-trace.jsonl');
  const command = { executable: process.execPath, args: [adapterFixture, '--scenario', scenario, '--trace', trace] };
  const config = f.engine.environments.configure(f.project, { workspace: f.root,
    implementer: { actor: 'answers-original', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'answers-independent', model: 'fixture', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: 100_000 }, 0);
  const adapter = f.store.write({ id: `adapter:${f.project}:answers:e5`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: f.project, protocol: 'codex-stdio' } });
  const packet = ok(writeQuestionPacket(f.store, { project: f.project, routes: reference(f.route), batch: batch.id,
    environment: reference(config), attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  const originalStep = { research: { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'answer',
    results: batch.items.map(item => ({ questionId: item.gap, value: source.value.content.slice(0, 8),
      citations: [{ source: reference(source), selector: { kind: 'text-range', start: 0, end: source.value.content.length } }] })) },
    usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 } };
  const assessorStep = verdict === 'off-form'
    ? { research: { answer: 'untyped reviewer reply' }, usage: originalStep.usage }
    : { research: { verdict, reasons: verdict === 'supported' ? [] : ['source not decisive'] }, usage: originalStep.usage };
  writeFileSync(scenario, JSON.stringify({ steps: [originalStep, assessorStep] }));
  const dispatch = { adapter: reference(adapter), config: reference(config) };
  const original = ok(await runModelCall(f.store, { project: f.project, packet: reference(packet), dispatch, role: 'implementer' }));
  assert.equal(original.outcome?.kind, 'fact-candidates');
  const terminal = ok(await assessFact(f.store, { project: f.project, modelCall: reference(original.record),
    questionId: batch.items[0]!.gap, dispatch }));
  assert.equal(terminal.value.verdict, verdict);
  return { terminal, original, packet };
}

async function ordinaryOffFormFact(f: ReturnType<typeof fixture>) {
  const batch = f.route.value.batches.find(item => item.model === 'MC1'
    && item.items.some(question => question.target === f.target))!;
  assert.ok(batch);
  const goal: AttemptGoal = { key: `answers:off-form:${f.target}`,
    questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  ok(openSeries(f.store, { project: f.project, block: f.block, line: 1,
    slice: 'answers:off-form', predecessor: null, basis: null }));
  const series = ok(beginAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1, goal }));
  const scenario = join(f.root, 'off-form-scenario.json');
  const command = { executable: process.execPath, args: [adapterFixture, '--scenario', scenario,
    '--trace', join(f.root, 'off-form-trace.jsonl')] };
  const config = f.engine.environments.configure(f.project, { workspace: f.root,
    implementer: { actor: 'answers-original', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'answers-independent', model: 'fixture', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000,
    requestCapacityChars: 100_000 }, 0);
  const adapter = f.store.write({ id: `adapter:${f.project}:answers:off-form`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: f.project, protocol: 'codex-stdio' } });
  const packet = ok(writeQuestionPacket(f.store, { project: f.project, routes: reference(f.route), batch: batch.id,
    environment: reference(config), attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  writeFileSync(scenario, JSON.stringify({ steps: [{ research: { invalid: true },
    usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 } }] }));
  return ok(await runModelCall(f.store, { project: f.project, packet: reference(packet),
    dispatch: { adapter: reference(adapter), config: reference(config) }, role: 'implementer' }));
}

async function originalFactForLegacyAssessor(f: ReturnType<typeof fixture>) {
  const batch = f.route.value.batches.find(item => item.model === 'MC1'
    && item.items.some(question => question.target === f.target))!;
  assert.ok(batch);
  const source = f.store.get<{ content: string }>(`source:${f.project}:brief`)!;
  const goal: AttemptGoal = { key: `answers:legacy-assessor:${f.target}`,
    questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  ok(openSeries(f.store, { project: f.project, block: f.block, line: 1,
    slice: 'answers:legacy-assessor', predecessor: null, basis: null }));
  const series = ok(beginAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1, goal }));
  const scenario = join(f.root, 'assessment-scenario.json');
  const command = { executable: process.execPath, args: [adapterFixture, '--scenario', scenario,
    '--trace', join(f.root, 'assessment-trace.jsonl')] };
  const config = f.engine.environments.configure(f.project, { workspace: f.root,
    implementer: { actor: 'answers-original', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'answers-independent', model: 'fixture', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000,
    requestCapacityChars: 100_000 }, 0);
  const adapter = f.store.write({ id: `adapter:${f.project}:answers:legacy-assessor`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: f.project, protocol: 'codex-stdio' } });
  const packet = ok(writeQuestionPacket(f.store, { project: f.project, routes: reference(f.route), batch: batch.id,
    environment: reference(config), attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  const originalStep = { research: { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'answer',
    results: batch.items.map(item => ({ questionId: item.gap, value: source.value.content.slice(0, 8),
      citations: [{ source: reference(source), selector: { kind: 'text-range', start: 0,
        end: source.value.content.length } }] })) },
    usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 } };
  writeFileSync(scenario, JSON.stringify({ steps: [originalStep, { research: { verdict: 'insufficient',
    reasons: ['The original source does not establish the fact'] }, usage: originalStep.usage }] }));
  const original = ok(await runModelCall(f.store, { project: f.project, packet: reference(packet),
    dispatch: { adapter: reference(adapter), config: reference(config) }, role: 'implementer' }));
  assert.equal(original.outcome?.kind, 'fact-candidates');
  if (original.outcome?.kind !== 'fact-candidates' || !original.response)
    assert.fail('The old assessor needs one complete original MC1 fact');
  return { original, packet, batch, goal, series, config, adapter };
}

function assembledOperation(f: ReturnType<typeof fixture>, block = 'garden-produce-block',
  options: { attempt?: number; variant?: string } = {}) {
  const ordinal = options.attempt ?? 1;
  const batch = f.route.value.batches.find(item => item.model === 'MC2' && item.task === 'node-expansion'
    && item.level === 2 && item.node === block)!;
  assert.ok(batch);
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = f.store.get(`environment:${f.project}`) ?? f.engine.environments.configure(f.project, { workspace: f.root,
    implementer: { actor: 'answers-designer', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'answers-reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000, requestCapacityChars: 200_000 }, 0);
  const goal: AttemptGoal = { key: `answers:operation-node:${block}`,
    questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  if (ordinal === 1) ok(openSeries(f.store, { project: f.project, block, line: 1, slice: `answers:operation:${block}`,
    predecessor: null, basis: null }));
  const series = ok(beginAttempt(f.store, { project: f.project, block, line: 1, attempt: ordinal, goal }));
  const packet = ok(writeQuestionPacket(f.store, { project: f.project, routes: reference(f.route), batch: batch.id,
    environment: reference(environment), attempt: { series: reference(series), ordinal }, previous: [] })).record;
  assert.equal(packet.value.state, 'ready');
  assert.equal(packet.value.plan?.mode, 'whole');
  const plan = packet.value.plan!;
  const ids = plan.assignments[plan.position]!.obligations;
  const source = ok(prepareFrameProposals(f.store, f.request.gaps.sources.operations));
  const assigned = source.frame.result.obligations.filter(obligation => ids.includes(obligation.id));
  assert.equal(assigned.length, ids.length);
  const upper = f.graph.value.nodes.find(node => node.id === block)!;
  const node: Node = { ...clone(upper), id: `garden-answers-operation:${block}${options.variant ? `:${options.variant}` : ''}`,
    kind: 'operation', parent: block,
    title: 'Operation resolving the exact framed obligations',
    ports: assigned.filter(obligation => obligation.kind === 'connection-end').map((obligation, index) => ({
      id: `answer-port-${index}`, direction: obligation.role === 'producer' ? 'out' : 'in',
      contract: f.graph.value.artifacts.find(artifact => artifact.id === obligation.artifact)!.contract,
    })), code: [], tests: [] };
  let port = 0;
  const body: Omit<LayerProposal, 'base' | 'level' | 'source' | 'status'> = { nodes: [node],
    fills: assigned.map(obligation => ({ obligation: obligation.id, node: node.id,
      ...(obligation.kind === 'connection-end' ? { port: node.ports[port++]!.id } : {}) })),
    localConnectors: [], artifacts: [], contracts: [], joins: [], tests: [], edges: [], journeys: [],
    packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
  const adapter = f.store.write({ id: `adapter:${f.project}:answers:${block}:${ordinal}`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: f.project, protocol: 'fixture' } });
  const config = f.store.write({ id: `config:${f.project}:answers:${block}:${ordinal}`, kind: 'dispatch-config', expected: 0,
    value: { projectId: f.project, model: 'fixture' } });
  const payload = packet.value.packet as Record<string, Json>, requestId = payload.requestId as string;
  assert.equal(typeof requestId, 'string');
  const call = ok(recordCall(f.store, f.project, { call: requestId, purpose: 'model-design', basis: null,
    block, gaps: batch.items.filter(item => ids.includes(item.target)).flatMap(item => item.consumers.map(consumer => ({
      id: item.target, goal: item.target, field: item.field, consumer }))),
    series: reference(series), attempt: ordinal, goal,
    dispatch: { adapter: reference(adapter), config: reference(config) },
    packet: clone(packet.value.packet) as Json })).call;
  const responseWrite: Write = { id: partResponseId(f.project, reference(call)), kind: 'part-response', expected: 0,
    value: { project: f.project, packet: reference(packet), call: reference(call), requestId,
      raw: JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId, action: 'answer', proposal: body }) } };
  const prepared = ok(preparePartResult(f.store, { project: f.project, packet: reference(packet), call: reference(call),
    response: { pending: responseWrite } }));
  ok(writeGuarded(f.store, { unit: 'G4b-test', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
  const part = ok(readPartResult(f.store, { project: f.project, record: reference(prepared.record) }));
  const assembly = ok(assembleModelParts(f.store, { project: f.project, results: [reference(part.record)] }));
  assert.deepEqual(ok(readPartAssembly(f.store, { project: f.project, record: reference(assembly.record) })).record, assembly.record);
  const gap = f.blocking.find(row => batch.items.some(item => item.gap === row.value.gap.id))!;
  assert.ok(gap);
  return { batch, packet, part, assembly, gap };
}

test('G4b preserves every real D1 blocker and the code-only inventory gap across restart', t => {
  const f = fixture(t);
  assert.ok(f.blocking.length > 0, 'The real L1 producer leaves open frame and input obligations');
  assert.ok(f.gaps.records.some(row => row.value.gap.code === 'inventory_missing'));
  const before = snapshot(f.store), prepared = ok(prepareAnswersGate(f.store, f.request));
  assert.deepEqual(snapshot(f.store), before, 'Preparation does not write');
  assert.equal(prepared.record.value.result.passed, false);
  const saved = ok(writeAnswersGate(f.store, f.request));
  assert.equal(saved.value.result.passed, false);
  assert.deepEqual(saved.value.result.codes, ['answer_missing_for_blocking_gap']);
  assert.equal(saved.value.result.findings.length, f.blocking.length);
  for (const row of f.blocking) assert.ok(saved.value.result.findings.some(item => item.at.target === row.value.gap.target));
  assert.ok(f.gaps.records.some(row => row.value.gap.code === 'inventory_missing'), 'G4b does not close inventory');
  const after = snapshot(f.store);
  assert.deepEqual(ok(writeAnswersGate(f.store, f.request)), saved, 'The exact repeat performs no write');
  assert.deepEqual(snapshot(f.store), after);
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(snapshot(f.store), after, 'Historical reading and repeat do not write');
});

test('G4b records an addressed missing owner-result and does not treat route state as proof', t => {
  const f = fixture(t, 'owner-decision');
  const owner = f.blocking.find(row => row.value.gap.target === f.target)!;
  assert.ok(owner);
  assert.equal(owner.value.gap.kind, 'owner-decision');
  assert.equal(f.route.value.routes.find(row => row.gap === owner.value.gap.id)?.route, 'owner');
  const request: AnswersGateRequest = { ...f.request, results: [{ gap: reference(owner), result: null, candidate: null }] };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.equal(saved.value.result.passed, false);
  assert.ok(saved.value.result.codes.includes('owner_result_unavailable'));
  assert.ok(saved.value.result.findings.some(finding => finding.at.target === owner.value.gap.target));
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(ok(writeAnswersGate(f.store, request)), saved);
});

test('G4b does not accept an actor owner field or an owner-result-shaped record as owner authority', t => {
  const f = fixture(t, 'owner-decision');
  const owner = f.blocking.find(row => row.value.gap.target === f.target)!;
  assert.ok(owner);
  const lookalikes = [
    f.store.write({ id: `native-answer-decision:${f.project}:owner-lookalike`, kind: 'native-answer-decision', expected: 0,
      value: { project: f.project, actor: 'owner', gap: reference(owner), answer: 'JSON' } }),
    f.store.write({ id: `om-owner-result:${f.project}:lookalike`, kind: 'om-owner-result', expected: 0,
      value: { project: f.project, actor: 'owner', gap: reference(owner), answer: 'JSON' } }),
  ];
  const saved = lookalikes.map(result => ok(writeAnswersGate(f.store, { ...f.request,
    results: [{ gap: reference(owner), result: reference(result), candidate: null }] })));
  for (const record of saved) {
    assert.ok(record.value.result.findings.some(finding => finding.at.target === owner.value.gap.target
      && finding.code === 'owner_result_unavailable' && finding.route === 'owner'));
    assert.equal(record.value.result.passed, false);
  }
  f.restart();
  for (const record of saved)
    assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(record) })), record);
});

test('G4b refuses missing, duplicate and unknown declarations rather than selecting the first result', t => {
  const f = fixture(t, 'owner-decision'), owner = f.blocking.find(item => item.value.gap.target === f.target)!;
  assert.ok(owner);
  const row = { gap: reference(owner), result: null, candidate: null };
  const cases: { name: string; results: AnswersGateRequest['results']; code: string }[] = [
    { name: 'omitted', results: [], code: 'owner_result_unavailable' },
    { name: 'duplicate', results: [row, row], code: 'answer_duplicate' },
    { name: 'unknown', results: [{ ...row, gap: { ...row.gap, id: 'om-gap:garden:unknown' } }], code: 'answer_gap_unknown' },
  ];
  for (const { name, results, code } of cases) {
    const outcome = ok(writeAnswersGate(f.store, { ...f.request, results }));
    assert.equal(outcome.value.result.passed, false, name);
    assert.ok(outcome.value.result.codes.includes(code), `${name}: ${outcome.value.result.codes.join(', ')}`);
    assert.ok(outcome.value.result.findings.every(finding => finding.at.target && (finding.at.field || finding.at.ref)));
  }
});

test('G4b gives typed addresses for an absent result set, foreign project and foreign result', t => {
  const f = fixture(t), first = f.blocking[0]!;
  const absent = writeAnswersGate(f.store, { ...f.request, results: undefined } as unknown as AnswersGateRequest);
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.refusal.code, 'answers_missing');
  for (const wrong of [null, {}, 'not-an-array', [null], [42]]) {
    const failure = writeAnswersGate(f.store, { ...f.request, results: wrong } as unknown as AnswersGateRequest);
    assert.equal(failure.ok, false);
    if (!failure.ok) assert.equal(failure.refusal.code, 'answers_missing');
  }
  const foreign = writeAnswersGate(f.store, { ...f.request, project: 'another-project' });
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.refusal.code, 'gap_source_missing');
  const design = f.blocking.find(row => row.value.gap.kind === 'design-decision' && row.value.gap.code !== 'obligation_open')!;
  assert.ok(design);
  const result = ok(writeAnswersGate(f.store, { ...f.request, results: [{ gap: reference(design),
    result: reference(f.route), candidate: null }] }));
  assert.ok(result.value.result.codes.includes('answer_route_foreign'));
  assert.ok(result.value.result.findings.some(finding => finding.at.target === design.value.gap.target));
  assert.ok(first.value.gap.blocking);
});

test('G4b does not persist an outcome backed by absent D1/M6 or a forged recognizable answer', t => {
  const f = fixture(t, 'owner-decision'), owner = f.blocking.find(row => row.value.gap.target === f.target)!;
  assert.ok(owner);
  const before = snapshot(f.store);
  for (const request of [
    { ...f.request, routes: { ...reference(f.route), id: `om-routes:${f.project}:absent` } },
    { ...f.request, gaps: { ...f.request.gaps,
      records: f.request.gaps.records.map((ref, index) => index ? ref : { ...ref, id: `om-gap:${f.project}:absent` }) } },
    { ...f.request, results: [{ gap: reference(owner),
      result: { ...reference(f.route), id: `om-answer:${f.project}:forged` }, candidate: null }] },
  ]) {
    const denied = writeAnswersGate(f.store, request);
    assert.equal(denied.ok, false);
    assert.deepEqual(snapshot(f.store), before, 'An unproved mandatory source cannot leave a G4b record');
  }
});

test('G4b preserves exact result-reader integrity codes before producing an outcome', t => {
  const f = fixture(t, 'owner-decision'), owner = f.blocking.find(row => row.value.gap.target === f.target)!;
  const before = snapshot(f.store);
  for (const [ref, code] of [
    [{ ...reference(f.route), hash: '0'.repeat(64) }, 'record_forged'],
    [{ ...reference(f.route), id: `om-routes:${f.project}:absent` }, 'record_missing'],
    [{ ...reference(f.route), id: 'om-routes:another-project:foreign' }, 'record_foreign'],
  ] as const) {
    const denied = writeAnswersGate(f.store, { ...f.request, results: [{ gap: reference(owner), result: ref, candidate: null }] });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.refusal.code, code);
    assert.deepEqual(snapshot(f.store), before);
  }
});

test('G4b rejects a forged gap Ref and addresses a stale revision without cascading missing', t => {
  const f = fixture(t), source = f.blocking[0]!, exact = reference(source), before = snapshot(f.store);
  const forged = writeAnswersGate(f.store, { ...f.request, results: [{ gap: { ...exact, hash: '0'.repeat(64) },
    result: null, candidate: null }] });
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.refusal.code, 'record_forged');
  assert.deepEqual(snapshot(f.store), before);
  const stale = ok(writeAnswersGate(f.store, { ...f.request, results: [{ gap: { ...exact, revision: exact.revision + 1 },
    result: null, candidate: null }] }));
  const addressed = stale.value.result.findings.filter(finding => finding.at.target === source.value.gap.target);
  assert.deepEqual(addressed.map(finding => finding.code), ['answer_version_stale']);
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(stale) })), stale);
});

test('G4b rejects malformed public result rows before touching storage', t => {
  const f = fixture(t), before = snapshot(f.store);
  const malformed = { ...f.request, results: [{ gap: null, result: null, candidate: null }] } as unknown as AnswersGateRequest;
  for (const action of [prepareAnswersGate, writeAnswersGate]) {
    assert.throws(() => action(f.store, malformed), (error: unknown) => error instanceof EngineError
      && error.code === 'answers_gate_request_invalid');
  }
  assert.deepEqual(snapshot(f.store), before);
});

test('G4b returns the supported-producer boundary for current unsupported question kinds', t => {
  for (const kind of ['design-decision', 'environment-confirmation', 'post-implementation-proof'] as const) {
    const f = fixture(t, kind), gap = f.blocking.find(row => row.value.gap.target === f.target)!;
    assert.ok(gap, kind);
    assert.equal(gap.value.gap.code, 'predecessor_question');
    const saved = ok(writeAnswersGate(f.store, f.request));
    assert.ok(saved.value.result.codes.includes('route_result_unsupported'), kind);
    assert.ok(saved.value.result.findings.some(finding => finding.at.target === f.target
      && finding.code === 'route_result_unsupported'));
    f.restart();
    assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
  }
});

test('G4b keeps a missing repository fact distinct from unsupported question kinds', t => {
  const f = fixture(t, 'repository-fact');
  const gap = f.blocking.find(row => row.value.gap.target === f.target)!;
  assert.ok(gap);
  assert.equal(gap.value.gap.kind, 'repository-fact');
  const saved = ok(writeAnswersGate(f.store, f.request));
  assert.ok(saved.value.result.findings.some(finding => finding.at.target === f.target
    && finding.code === 'answer_missing_for_blocking_gap'));
  assert.equal(saved.value.result.findings.some(finding => finding.at.target === f.target
    && finding.code === 'route_result_unsupported'), false);
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('G4b proves a real unapplied D3 proposal but does not treat it as an answer to the current input gap', t => {
  const f = fixture(t, 'repository-fact', false);
  const gap = f.blocking.find(row => row.value.gap.target === f.target)!;
  assert.equal(gap.value.gap.code, 'question_unaddressed');
  const decision = f.store.write(inputDecisionWrite({ project: f.project, input: reference(f.input),
    graph: reference(f.graph), layers: [], decision: { target: f.target, field: 'address',
      value: { consumer: f.block, kind: 'repository-fact' } } }));
  const request: AnswersGateRequest = { ...f.request,
    results: [{ gap: reference(gap), result: reference(decision), candidate: null }] };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.ok(saved.value.result.findings.some(finding => finding.at.target === f.target
    && finding.code === 'answer_missing_for_blocking_gap'),
  'An unapplied D3 decision does not remove the extant D1 gap');
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('G4b checks an explicitly offered nonblocking result rather than silently ignoring it', t => {
  const f = fixture(t), inventory = f.gaps.records.find(row => row.value.gap.code === 'inventory_missing')!;
  assert.ok(inventory);
  assert.equal(inventory.value.gap.blocking, false);
  const saved = ok(writeAnswersGate(f.store, { ...f.request, results: [{ gap: reference(inventory),
    result: reference(f.route), candidate: null }] }));
  assert.equal(saved.value.result.passed, false);
  assert.ok(saved.value.result.findings.some(finding => finding.at.target === inventory.value.gap.target
    && ['answer_route_foreign', 'route_result_unsupported'].includes(finding.code)));
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
  const omitted = ok(writeAnswersGate(f.store, f.request));
  const explicitNull = ok(writeAnswersGate(f.store, { ...f.request, results: [{ gap: reference(inventory),
    result: null, candidate: null }] }));
  assert.deepEqual(explicitNull.value.result, omitted.value.result,
    'An explicit null for a nonblocking inventory gap does not claim a completed answer');
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(explicitNull) })), explicitNull);
});

test('G4b cannot defer a blocking owner gap, even with an explicit deferral result', t => {
  const f = fixture(t, 'owner-decision'), owner = f.blocking.find(row => row.value.gap.target === f.target)!;
  assert.ok(owner);
  const request: AnswersGateRequest = { ...f.request, results: [{ gap: reference(owner), result: null, candidate: null,
    deferral: { reason: 'outside_horizon', until: 'horizon-entry' } }] };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.equal(saved.value.result.passed, false);
  assert.ok(saved.value.result.codes.includes('deferral_not_permitted'));
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('G4b refuses a route from another exact D1 version even when the gap names match', t => {
  const f = fixture(t);
  const nextHorizon = ok(writeHorizon(f.store, { project: f.project, input: reference(f.input), graph: reference(f.graph),
    refinement: null, available: {}, choice: { choiceVersion: 'answers-gate-next', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const changed = clone(f.gaps.sources) as GapRequest;
  changed.horizon = reference(nextHorizon.gate);
  changed.operations.frame.horizon = reference(nextHorizon.gate);
  const gaps = ok(writeGaps(f.store, changed));
  const gapRead: GapReadRequest = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const route = ok(writeRoutes(f.store, { project: f.project, gaps: gapRead, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const mismatched = writeAnswersGate(f.store, { ...f.request, routes: reference(route) });
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.refusal.code, 'input_stale',
    'The old D1/H source first fails its current admission; a result-specific stale code would hide that refusal');
});

test('G4b rejects a stale current D1 source but retains the historical result', t => {
  const f = fixture(t), saved = ok(writeAnswersGate(f.store, f.request));
  const changed = f.store.write({ id: f.input.id, kind: f.input.kind, expected: f.input.revision,
    value: clone(f.input.value) });
  assert.equal(changed.revision, f.input.revision + 1);
  const stale = writeAnswersGate(f.store, { ...f.request, results: [] });
  if (stale.ok) assert.deepEqual(stale.value, saved, 'Only the exact historical repeat may survive changed current heads');
  else assert.equal(stale.refusal.code, 'input_stale');
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('G4b guards the current D1 head atomically after preparation', t => {
  const f = fixture(t), prepared = ok(prepareAnswersGate(f.store, f.request));
  assert.ok(prepared.guards.some(guard => guard.id === f.input.id && 'revision' in guard));
  f.store.write({ id: f.input.id, kind: f.input.kind, expected: f.input.revision, value: clone(f.input.value) });
  const attempt = writeGuarded(f.store, { unit: 'G4b', target: prepared.record.id,
    writes: clone(prepared.writes), guards: clone(prepared.guards) });
  assert.equal(attempt.ok, false);
  if (!attempt.ok) assert.equal(attempt.refusal.code, 'input_stale');
  assert.equal(f.store.get(prepared.record.id), null);
});

test('G4b refuses a second Store racing for the same absent outcome identity', t => {
  const f = fixture(t), prepared = ok(prepareAnswersGate(f.store, f.request));
  const rival = new Store(f.path);
  t.after(() => rival.close());
  const winner = ok(writeAnswersGate(rival, f.request));
  const attempt = writeGuarded(f.store, { unit: 'G4b', target: prepared.record.id,
    writes: clone(prepared.writes), guards: clone(prepared.guards) });
  assert.equal(attempt.ok, false);
  if (!attempt.ok) assert.equal(attempt.refusal.code, 'revision_conflict');
  assert.deepEqual(f.store.get(prepared.record.id), winner);
});

test('G4b rederives a saved negative outcome instead of trusting a self-consistent later revision', t => {
  const f = fixture(t, 'owner-decision'), saved = ok(writeAnswersGate(f.store, f.request));
  assert.equal(saved.value.result.passed, false);
  const forged = f.store.write({ id: saved.id, kind: saved.kind, expected: saved.revision,
    value: { ...clone(saved.value), result: { passed: true, codes: [], findings: [] } } });
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved,
    'The original exact negative revision remains historical evidence');
  const denied = readAnswersGate(f.store, { project: f.project, record: reference(forged) });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.refusal.code, 'answers_gate_record_invalid');
  const repeated = writeAnswersGate(f.store, f.request);
  assert.equal(repeated.ok, false, 'A corrupt head cannot become an idempotent exact repeat');
});

test('a saved G4b outcome, even with an incomplete envelope, proves missing B1 provenance to product projection and assess', t => {
  const f = fixture(t), gate = ok(writeAnswersGate(f.store, f.request));
  for (const value of [gate.value, { project: f.project }]) {
    const root = mkdtempSync(join(tmpdir(), 'omg-answers-gate-origin-'));
    const isolated = new Store(join(root, 'state.sqlite'));
    t.after(() => { isolated.close(); rmSync(root, { recursive: true, force: true }); });
    new ProductEngine(isolated).execute({ type: 'create-project', project: f.project, title: 'G4b origin' });
    isolated.write({ id: gate.id, kind: gate.kind, expected: 0, value });
    const engine = new ProductEngine(isolated);
    for (const action of [() => engine.projection(f.project),
      () => engine.execute({ type: 'assess', project: f.project, expected: 0 })])
      assert.throws(action, (error: unknown) => error instanceof EngineError && error.code === 'record_missing'
        && JSON.stringify(error.details).includes(`om-input:${f.project}`));
  }
});

test('G4b passes a complete accepted graph with no blocking answer and survives restart', async t => {
  const f = await createOmFixture(t);
  const first = ok(writeOmInput(f.store, { project: f.project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage,
      reference(f.stages[stage])])) as Record<UpstreamStage, Ref> }));
  const sourceFor = (input: Ref, horizon: Ref): GapRequest => ({ project: f.project, input,
    graph: reference(f.graphRevision), horizon,
    operations: { proposals: [], frame: { project: f.project, level: 2, graph: reference(f.graphRevision), horizon,
      layer: reference(f.layers[2]), frame: null, upper: null } },
    works: { proposals: [], frame: { project: f.project, level: 3, graph: reference(f.graphRevision), horizon,
      layer: reference(f.layers[3]), frame: null, upper: { horizon, frame: null } } } });
  const priorHorizon = ok(writeHorizon(f.store, { project: f.project, input: reference(first),
    graph: reference(f.graphRevision), refinement: reference(f.store.get(`phase:${f.project}:L2`)!), available: {},
    choice: { choiceVersion: 'answers-gate-before-d3', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const priorGaps = ok(writeGaps(f.store, sourceFor(reference(first), reference(priorHorizon.gate))));
  const priorRead: GapReadRequest = { sources: clone(priorGaps.sources) as GapRequest, records: priorGaps.records.map(reference) };
  assert.deepEqual(priorGaps.records.filter(row => row.value.gap.blocking).map(row => row.value.gap.code).sort(),
    ['acceptance_kind_missing', 'contract_boundary_prose', 'contract_node_unbound']);
  const priorRoute = ok(writeRoutes(f.store, { project: f.project, gaps: priorRead, tasks: [],
    catalog: { paths: [], records: [] }, previous: null }));
  const priorGate = ok(writeAnswersGate(f.store, { project: f.project, gaps: priorRead,
    routes: reference(priorRoute), results: [] }));
  assert.equal(priorGate.value.result.passed, false);
  const decisions = [
    { target: 'garden-B1', field: 'nodes', value: ['garden-produce-block', 'garden-consume-block'] },
    { target: 'garden-B1', field: 'state', value: { writer: 'garden-produce-block', authority: 'garden-consume-block', rollback: 'garden-consume-block' } },
    { target: 'garden-R1#1', field: 'checkKind', value: 'test' },
  ] satisfies { target: string; field: 'nodes' | 'state' | 'checkKind'; value: Json }[];
  const input = ok(writeAddressing(f.store, { project: f.project, input: reference(first), graph: reference(f.graphRevision),
    decisions: decisions.map(decision => ({ pending: clone(inputDecisionWrite({ project: f.project, input: reference(first),
      graph: reference(f.graphRevision), layers: [], decision })) as Write })) }));
  const horizon = ok(writeHorizon(f.store, { project: f.project, input: reference(input),
    graph: reference(f.graphRevision), refinement: reference(f.store.get(`phase:${f.project}:L2`)!), available: {},
    choice: { choiceVersion: 'answers-gate-complete', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const gaps = ok(writeGaps(f.store, sourceFor(reference(input), reference(horizon.gate))));
  assert.deepEqual(gaps.records.filter(row => row.value.gap.blocking).map(row => `${row.value.gap.target}/${row.value.gap.code}`), []);
  assert.ok(priorGaps.records.some(row => f.store.get(row.id) !== null), 'The old physical D1 rows remain in history');
  const gapRead: GapReadRequest = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const route = ok(writeRoutes(f.store, { project: f.project, gaps: gapRead, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const request: AnswersGateRequest = { project: f.project, gaps: gapRead, routes: reference(route), results: [] };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.equal(saved.value.result.passed, true);
  assert.deepEqual(saved.value.result.codes, []);
  const disappeared = priorGaps.records.find(row => row.value.gap.blocking)!;
  const oldClaim = ok(writeAnswersGate(f.store, { ...request, results: [{ gap: reference(disappeared),
    result: null, candidate: null }] }));
  assert.deepEqual(oldClaim.value.result.codes, ['answer_gap_unknown'],
    'A former D1 gap cannot be offered to the newly complete D1 set after D3');
  f.reopen();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(priorGate) })), priorGate);
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(oldClaim) })), oldClaim);
  assert.deepEqual(ok(writeAnswersGate(f.store, request)), saved);
});

test('G4b proves a real selected D5 fact while other live obligations remain incomplete', async t => {
  const f = fixture(t, 'repository-fact'), fact = await acceptedFact(f);
  const selected = fact.route.value.routes.find(row => row.gap === fact.fact.value.gap.id)!;
  assert.equal(selected.route, 'code');
  assert.deepEqual(selected.answer, reference(fact.accepted));
  const request: AnswersGateRequest = { ...f.request, routes: reference(fact.route),
    results: [{ gap: reference(fact.fact), result: reference(fact.accepted), candidate: null }] };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.equal(saved.value.result.passed, false, 'Other real D1 blockers are still outstanding');
  assert.equal(saved.value.result.findings.some(finding => finding.at.target === f.target), false,
    'The accepted, applicable D5 fact covers exactly its current routed gap');
  f.store.write({ id: f.input.id, kind: f.input.kind, expected: f.input.revision, value: clone(f.input.value) });
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(ok(writeAnswersGate(f.store, request)), saved);
});

test('G4b accepts another applicable D5 reconfirmation from the complete M6 search', async t => {
  const f = fixture(t, 'repository-fact');
  const first = await acceptedFact(f);
  const second = await acceptedFact(f, { suffix: 'reconfirmed', previous: reference(first.route) });
  assert.notEqual(first.accepted.id, second.accepted.id);
  const firstFact = ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(first.accepted) }));
  const secondFact = ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(second.accepted) }));
  assert.equal(firstFact.key, secondFact.key, 'Both real D5 writes establish the same fact identity');
  const routed = second.route.value.routes.find(row => row.gap === first.fact.value.gap.id)!;
  const search = second.route.value.searches.find(row => row.gap === first.fact.value.gap.id)!;
  assert.equal(routed.route, 'code');
  assert.equal(search.checks.length, 2);
  assert.ok(search.checks.every(check => check.invalidation === null));
  const offered = routed.answer!.id === first.accepted.id ? second.accepted : first.accepted;
  assert.notDeepEqual(reference(offered), routed.answer,
    'M6 has a stable representative, but the other exact applicable fact is still in its complete search');
  const request: AnswersGateRequest = { ...f.request, routes: reference(second.route),
    results: [{ gap: reference(first.fact), result: reference(offered), candidate: null }] };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.equal(saved.value.result.findings.some(finding => finding.at.target === f.target), false,
    'G4b must not require equality with only the representative route.answer');
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(ok(writeAnswersGate(f.store, request)), saved);
});

test('G4b derives a foreign-question D5 finding identically before and after restart', async t => {
  const f = fixture(t, 'repository-fact', true, true), accepted = await acceptedFact(f);
  const other = f.blocking.find(row => row.value.gap.target === 'discovery:other-choice')!;
  assert.ok(other);
  const search = accepted.route.value.searches.find(row => row.gap === other.value.gap.id)!;
  assert.equal(search.checks.some(check => check.answer.id === accepted.accepted.id), false);
  const request: AnswersGateRequest = { ...f.request, routes: reference(accepted.route),
    results: [{ gap: reference(other), result: reference(accepted.accepted), candidate: null }] };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.ok(saved.value.result.findings.some(item => item.at.target === other.value.gap.target
    && item.code === 'answer_version_stale' && item.at.field === 'search'));
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(ok(writeAnswersGate(f.store, request)), saved);
});

test('G4b distinguishes an accepted D5 fact from applicability to a changed current task', async t => {
  const f = fixture(t, 'repository-fact'), prior = await acceptedFact(f);
  const task = ok(prepareAnswerTask(f.store, { project: f.project, input: reference(f.input),
    gaps: f.request.gaps, gap: reference(prior.fact), requirements: [{ pointer: '/contracts/0' }],
    resultForm: { type: 'string', minLength: 1 } }));
  const route = ok(writeRoutes(f.store, { project: f.project, gaps: f.request.gaps,
    tasks: [task.writes.length ? { pending: clone(task.writes[0]!) as Write } : { record: reference(task.record) }],
    catalog: { paths: [], records: [] }, previous: reference(prior.route) }));
  const selected = route.value.routes.find(row => row.gap === prior.fact.value.gap.id)!;
  assert.equal(selected.answer, null, 'M6 does not select an old D5 fact for a different current contract');
  const request: AnswersGateRequest = { ...f.request, routes: reference(route),
    results: [{ gap: reference(prior.fact), result: reference(prior.accepted), candidate: null }] };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.ok(saved.value.result.findings.some(finding => finding.at.target === f.target
    && finding.code === 'answer_version_stale'));
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('G4b reports an unknown result contract on a real repository fact without treating it as missing', t => {
  const f = fixture(t, 'repository-fact');
  const fact = f.blocking.find(row => row.value.gap.target === f.target)!;
  const unknown = f.store.write({ id: `future-answer:${f.project}:fact`, kind: 'future-answer', expected: 0,
    value: { project: f.project, fact: reference(fact) } });
  const request: AnswersGateRequest = { ...f.request,
    results: [{ gap: reference(fact), result: reference(unknown), candidate: null }] };
  const saved = ok(writeAnswersGate(f.store, request));
  const addressed = saved.value.result.findings.filter(finding => finding.at.target === f.target);
  assert.deepEqual(addressed.map(finding => finding.code), ['route_result_unsupported']);
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('G4b does not mistake a real E5 terminal verdict for its separate accepted D5 answer', async t => {
  for (const verdict of ['supported', 'insufficient', 'conflicting', 'off-form'] as const) await t.test(verdict, async child => {
    const f = fixture(child, 'repository-fact'), assessed = await assessedFact(f, verdict);
    const fact = f.blocking.find(row => row.value.gap.target === f.target)!;
    const task = f.route.value.routes.find(row => row.gap === fact.value.gap.id)!.task!;
    const route = verdict === 'supported' ? ok(writeRoutes(f.store, { project: f.project, gaps: f.request.gaps,
      tasks: [{ record: task }], catalog: { paths: [], records: [] }, previous: reference(f.route) })) : f.route;
    const request: AnswersGateRequest = { ...f.request, routes: reference(route), results: [{ gap: reference(fact),
      result: reference(assessed.terminal), candidate: null }] };
    const saved = ok(writeAnswersGate(f.store, request));
    const code = verdict === 'supported' ? 'route_result_missing' : 'answer_missing_for_blocking_gap';
    assert.ok(saved.value.result.findings.some(finding => finding.at.target === f.target && finding.code === code),
      JSON.stringify(saved.value.result.findings));
    const accepted = verdict === 'supported' ? assessed.terminal.value.accepted : null;
    const positive = accepted ? ok(writeAnswersGate(f.store, { ...request,
      results: [{ gap: reference(fact), result: accepted, candidate: null }] })) : null;
    if (positive) assert.equal(positive.value.result.findings.some(finding => finding.at.target === f.target), false,
      'The terminal E5 Ref is not D5, but its separately accepted D5 Ref covers the selected fact');
    f.restart();
    assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
    if (positive) assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(positive) })), positive);
  });
});

test('G4b reads an ordinary applied MC1 off-form result by its E4 product contract', async t => {
  const f = fixture(t, 'repository-fact'), original = await ordinaryOffFormFact(f);
  const state = ok(readModelCallState(f.store, { project: f.project, record: reference(original.record) }));
  assert.equal(state.state, 'applied');
  assert.equal(original.record.value.om.failure?.code, 'part_answer_invalid');
  const fact = f.blocking.find(row => row.value.gap.target === f.target)!;
  const request: AnswersGateRequest = { ...f.request,
    results: [{ gap: reference(fact), result: reference(original.record), candidate: null }] };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.ok(saved.value.result.findings.some(item => item.at.target === f.target
    && item.code === 'answer_missing_for_blocking_gap'));
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(ok(writeAnswersGate(f.store, request)), saved);
});

test('G4b keeps a direct E5 assessor transport distinct from an ordinary MC1 after restart', async t => {
  const f = fixture(t, 'repository-fact'), assessed = await assessedFact(f, 'off-form');
  const fact = f.blocking.find(row => row.value.gap.target === f.target)!;
  const request: AnswersGateRequest = { ...f.request,
    results: [{ gap: reference(fact), result: assessed.terminal.value.assessor, candidate: null }] };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.ok(saved.value.result.findings.some(item => item.at.target === f.target
    && item.code === 'route_result_missing'), JSON.stringify(saved.value.result.findings));
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('G4b reads a genuine saved E5.0 assessor transport by its historical contract', async t => {
  const f = fixture(t, 'repository-fact'), source = await originalFactForLegacyAssessor(f);
  const original = source.original;
  assert.equal(original.outcome?.kind, 'fact-candidates');
  if (original.outcome?.kind !== 'fact-candidates' || !original.response)
    assert.fail('The source MC1 must have one checked candidate');
  const factSource = original.outcome.facts[0]!;
  const basis = { kind: 'fact-assessment', modelCall: reference(original.record), call: original.call,
    packet: original.packet, response: original.response, question: factSource.question,
    questionId: factSource.questionId };
  const packet = { questionId: factSource.questionId, value: 'legacy-review', evidence: original.response };
  const call = ok(readCall(f.store, f.project, original.call));
  if ('owner' in call.value) assert.fail('The original MC1 must belong to a block attempt');
  const gaps = call.value.gaps.filter(gap => gap.id === f.target && gap.field === 'answer');
  assert.ok(gaps.length > 0);
  const input = { project: f.project, call: { call: 'e50-g4b-historical-review', purpose: 'fact-assessment',
    basis, block: f.block, gaps, series: reference(source.series), attempt: 1,
    goal: source.goal, dispatch: { adapter: reference(source.adapter), config: reference(source.config) }, packet } };
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const loader = join(f.root, 'e50-g4b-loader.mjs'), producer = join(f.root, 'e50-g4b-producer.mjs');
  const argsFile = join(f.root, 'e50-g4b-input.json');
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from ${JSON.stringify(typescript)};
let root;
export function initialize(data) { root = data.root; }
export async function load(url, context, next) {
  const prefix = new URL('dist/src/', root).href;
  if (url.startsWith(prefix) && /\\.js$/.test(url)) {
    const relative = 'src/' + url.slice(prefix.length).replace(/\\.js$/, '.ts');
    const source = execFileSync('git', ['show', '3eb5dac3c790ca988082840693969b06b5d81966:' + relative],
      { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return next(url, context);
}`);
  writeFileSync(producer, `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository, database, input] = process.argv.slice(2);
const src = path => pathToFileURL(join(repository, 'dist/src', path)).href;
const { Store } = await import(src('storage/store.js'));
const { reference } = await import(src('pipeline/contracts.js'));
const { recordCall } = await import(src('om/call-record.js'));
const { runModelTransport } = await import(src('om/model-call.js'));
const args = JSON.parse(readFileSync(input, 'utf8')), store = new Store(database);
const take = result => { if (!result.ok) throw Error(JSON.stringify(result.refusal)); return result.value; };
try {
  const admitted = take(recordCall(store, args.project, args.call));
  const transport = take(await runModelTransport(store,
    { project: args.project, call: reference(admitted.call), packet: args.call.packet, role: 'reviewer' }));
  process.stdout.write(JSON.stringify({ transport: transport.record }));
} finally { store.close(); }`);
  writeFileSync(argsFile, JSON.stringify(input));
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},
    { data: { root: ${JSON.stringify(pathToFileURL(repository).href)} } });`;
  const old = JSON.parse(execFileSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, f.path, argsFile],
    { cwd: repository, encoding: 'utf8', timeout: 30_000, maxBuffer: 10_000_000 })) as { transport: { id: string; revision: number; hash: string } };
  const fact = f.blocking.find(row => row.value.gap.target === f.target)!;
  const request: AnswersGateRequest = { ...f.request,
    results: [{ gap: reference(fact), result: old.transport, candidate: null }] };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.ok(saved.value.result.findings.some(item => item.at.target === f.target
    && item.code === 'answer_missing_for_blocking_gap'), JSON.stringify(saved.value.result.findings));
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('G4b rejects both permutations of duplicate fact claims without selecting a valid winner', async t => {
  const f = fixture(t, 'repository-fact'), fact = await acceptedFact(f);
  const good = { gap: reference(fact.fact), result: reference(fact.accepted), candidate: null };
  const counterfeit = { ...good, result: reference(f.route) };
  const request: AnswersGateRequest = { ...f.request, routes: reference(fact.route), results: [good, counterfeit] };
  const first = ok(writeAnswersGate(f.store, request));
  const reversed = ok(writeAnswersGate(f.store, { ...request, results: [counterfeit, good] }));
  assert.deepEqual(first, reversed);
  assert.ok(first.value.result.codes.includes('answer_duplicate'));
  assert.deepEqual(first.value.result.findings.filter(finding => finding.at.target === f.target).map(finding => finding.code),
    ['answer_duplicate'], 'Neither duplicate is evaluated as the chosen answer');
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(first) })), first);
});

test('G4b groups stale and current gap claims before reading any result', t => {
  const f = fixture(t, 'owner-decision');
  const gap = f.blocking.find(row => row.value.gap.target === f.target)!;
  const exact = { gap: reference(gap), result: null, candidate: null };
  const stale = { ...exact, gap: { ...exact.gap, revision: exact.gap.revision + 1 } };
  const invalidResult = { ...exact, result: { ...reference(f.route), hash: '0'.repeat(64) } };
  for (const rows of [[exact, stale], [stale, exact], [stale, stale], [stale, invalidResult]]) {
    const request: AnswersGateRequest = { ...f.request, results: rows };
    const saved = ok(writeAnswersGate(f.store, request));
    const codes = saved.value.result.findings.filter(item => item.at.target === f.target).map(item => item.code);
    assert.ok(codes.includes('answer_duplicate'), JSON.stringify(codes));
    assert.ok(codes.includes('answer_version_stale'), JSON.stringify(codes));
    assert.equal(codes.includes('record_forged'), false, 'Neither result is selected before the duplicate finding');
    f.restart();
    assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
  }
  const deferred: AnswersGateRequest = { ...f.request, results: [{ ...stale,
    deferral: { reason: 'outside_horizon', until: 'horizon-entry' } }] };
  const saved = ok(writeAnswersGate(f.store, deferred));
  assert.ok(saved.value.result.codes.includes('answer_version_stale'));
  assert.ok(saved.value.result.codes.includes('deferral_not_permitted'));
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('G4b requires complete real MC2 assembly and a live G3 candidate for an N2 gap', t => {
  const f = fixture(t), mc2 = assembledOperation(f), other = assembledOperation(f, 'garden-consume-block');
  const candidate = ok(writeCandidate(f.store, { frame: f.request.gaps.sources.operations.frame,
    proposals: [reference(mc2.assembly.proposal), reference(other.assembly.proposal)] }));
  assert.equal(candidate.state, 'candidate', JSON.stringify(candidate));
  if (candidate.state !== 'candidate') assert.fail('The two real MC2 proposals must fill the current N2 frame');
  const admitted = ok(writeAnswersGate(f.store, { ...f.request, results: [{ gap: reference(mc2.gap),
    result: reference(mc2.assembly.record), candidate: reference(candidate.record) }] }));
  assert.equal(admitted.value.result.findings.some(finding => finding.at.target === mc2.gap.value.gap.target), false,
    'The exact G3 candidate proves this MC2 operation for assembly, without C5 acceptance');
  const complete = ok(writeAnswersGate(f.store, { ...f.request, results: [{ gap: reference(mc2.gap),
    result: reference(mc2.assembly.record), candidate: null }] }));
  assert.ok(complete.value.result.codes.includes('delta_not_verified'),
    'A fully assembled operation still needs its exact successful G3 candidate');
  const partial = ok(writeAnswersGate(f.store, { ...f.request, results: [{ gap: reference(mc2.gap),
    result: reference(mc2.part.record), candidate: null }] }));
  assert.ok(partial.value.result.codes.includes('route_result_missing'),
    'A part is not a complete node result even when the plan contains just one part');
  f.restart();
  for (const saved of [admitted, complete, partial])
    assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('G4b retains a checked MC2 assignment when an unrelated M6 container advances', t => {
  const f = fixture(t), first = assembledOperation(f), other = assembledOperation(f, 'garden-consume-block');
  const candidate = ok(writeCandidate(f.store, { frame: f.request.gaps.sources.operations.frame,
    proposals: [reference(first.assembly.proposal), reference(other.assembly.proposal)] }));
  assert.equal(candidate.state, 'candidate');
  if (candidate.state !== 'candidate') assert.fail('Both MC2 proposals must form the current candidate');
  const results = [{ gap: reference(first.gap), result: reference(first.assembly.record), candidate: reference(candidate.record) }];
  const firstGate = ok(writeAnswersGate(f.store, { ...f.request, results }));
  assert.equal(firstGate.value.result.findings.some(item => item.at.target === first.gap.value.gap.target), false);
  const successor = ok(writeRoutes(f.store, { project: f.project, gaps: f.request.gaps, tasks: [],
    catalog: { paths: [], records: [] }, previous: reference(f.route) }));
  assert.deepEqual(successor.value.batches, f.route.value.batches);
  const request: AnswersGateRequest = { ...f.request, routes: reference(successor), results };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.equal(saved.value.result.findings.some(item => item.at.target === first.gap.value.gap.target), false);
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(ok(writeAnswersGate(f.store, request)), saved);
});

test('G4b rejects a successful G3 candidate for a different real MC2 proposal as delta_stale', t => {
  const f = fixture(t), first = assembledOperation(f), other = assembledOperation(f, 'garden-consume-block');
  ok(completeAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: { reason: 'off-form', achieved: [], cancelled: [], refusals: [] } }));
  const replacement = assembledOperation(f, f.block, { attempt: 2, variant: 'replacement' });
  assert.notDeepEqual(reference(first.assembly.proposal), reference(replacement.assembly.proposal));
  const candidate = ok(writeCandidate(f.store, { frame: f.request.gaps.sources.operations.frame,
    proposals: [reference(replacement.assembly.proposal), reference(other.assembly.proposal)] }));
  assert.equal(candidate.state, 'candidate');
  if (candidate.state !== 'candidate') assert.fail('The replacement must form a complete real candidate');
  const gate = ok(gateCandidate(f.store, { project: f.project, candidate: reference(candidate.record) }));
  assert.equal(gate.passed, true, 'The offered G3 candidate itself is legitimate');
  const request: AnswersGateRequest = { ...f.request, results: [{ gap: reference(first.gap),
    result: reference(first.assembly.record), candidate: reference(candidate.record) }] };
  const saved = ok(writeAnswersGate(f.store, request));
  const addressed = saved.value.result.findings.filter(finding => finding.at.target === first.gap.value.gap.target);
  assert.deepEqual(addressed.map(finding => finding.code), ['delta_stale']);
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
});

test('G4b preserves the exact common G3 refusal for a consistently hashed damaged candidate', t => {
  const f = fixture(t), first = assembledOperation(f), other = assembledOperation(f, 'garden-consume-block');
  const candidate = ok(writeCandidate(f.store, { frame: f.request.gaps.sources.operations.frame,
    proposals: [reference(first.assembly.proposal), reference(other.assembly.proposal)] }));
  assert.equal(candidate.state, 'candidate');
  if (candidate.state !== 'candidate') assert.fail('The complete candidate must be produced before damaging its next revision');
  const broken = f.store.write({ id: candidate.record.id, kind: candidate.record.kind, expected: candidate.record.revision,
    value: { ...clone(candidate.record.value), graphHash: '0'.repeat(64) } });
  const direct = gateCandidate(f.store, { project: f.project, candidate: reference(broken) });
  assert.equal(direct.ok, false);
  if (direct.ok) assert.fail('The common G3 reader must refuse the damaged exact revision');
  const before = snapshot(f.store);
  const result = writeAnswersGate(f.store, { ...f.request, results: [{ gap: reference(first.gap),
    result: reference(first.assembly.record), candidate: reference(broken) }] });
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('G4b must not save a failed G3 candidate as a negative outcome');
  assert.equal(result.refusal.code, direct.refusal.code);
  assert.deepEqual(result.refusal.at, direct.refusal.at);
  assert.deepEqual(snapshot(f.store), before);
  f.restart();
  const repeated = writeAnswersGate(f.store, { ...f.request, results: [{ gap: reference(first.gap),
    result: reference(first.assembly.record), candidate: reference(broken) }] });
  assert.equal(repeated.ok, false);
  if (!repeated.ok) assert.deepEqual(repeated.refusal, direct.refusal);
});

test('G4b discovers an N3 batch only after a real C5 upper-frame acceptance', t => {
  const f = fixture(t), first = assembledOperation(f), second = assembledOperation(f, 'garden-consume-block');
  const candidate = ok(writeCandidate(f.store, { frame: f.request.gaps.sources.operations.frame,
    proposals: [reference(first.assembly.proposal), reference(second.assembly.proposal)] }));
  assert.equal(candidate.state, 'candidate');
  if (candidate.state !== 'candidate') assert.fail('The complete upper candidate must be present');
  const accepted = ok(settleCandidate(f.store, { project: f.project, level: 2, candidate: reference(candidate.record),
    outcome: { gate: 'G3', candidate: reference(candidate.record), graphHash: candidate.record.value.graphHash,
      passed: true, codes: [] } }));
  assert.equal(accepted.state, 'accepted');
  const graph = reference(accepted.graph!), layer = reference(accepted.layer!), upperFrame = reference(accepted.frame!);
  const horizon = ok(writeHorizon(f.store, { project: f.project, input: reference(f.input), graph,
    refinement: layer, available: {}, choice: { choiceVersion: 'answers-gate-works',
      features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project: f.project, input: reference(f.input), graph, horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project: f.project, level: 2, graph, horizon: reference(horizon.gate),
      layer, frame: upperFrame, upper: null } },
    works: { proposals: [], frame: { project: f.project, level: 3, graph, horizon: reference(horizon.gate),
      layer: null, frame: null, upper: { horizon: reference(horizon.gate), frame: upperFrame } } } };
  const gaps = ok(writeGaps(f.store, sources));
  const gapRead: GapReadRequest = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(f.store, { project: f.project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const handoff = ok(writeOmObligations(f.store, { project: f.project, gaps: gapRead,
    lines: reference(lines), assignments: [] }));
  const route = ok(writeRoutes(f.store, { project: f.project, gaps: gapRead, tasks: [],
    catalog: { paths: [], records: [] }, previous: null }));
  const batch = route.value.batches.find(item => item.model === 'MC2' && item.level === 3 && item.task === 'node-expansion');
  assert.ok(batch, 'The accepted upper frame produces an N3 work expansion batch');
  assert.ok(handoff.producer && handoff.record);
  assert.deepEqual(handoff.handoff.obligations, []);
  for (const block of ['garden-produce-block', 'garden-consume-block'])
    ok(completeAttempt(f.store, { project: f.project, block, line: 1, attempt: 1,
      outcome: { reason: 'off-form', achieved: [], cancelled: [], refusals: [] } }));
  const upper = accepted.graph!.value.nodes.find(node => node.id === batch.node)!;
  assert.ok(upper?.parent);
  const goal: AttemptGoal = { key: `answers:works:${batch.node}`,
    questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  const series = ok(beginAttempt(f.store, { project: f.project, block: upper.parent, line: 1,
    attempt: 2, goal }));
  const environment = f.store.get(`environment:${f.project}`)!;
  const packet = ok(writeQuestionPacket(f.store, { project: f.project, routes: reference(route), batch: batch.id,
    environment: reference(environment), attempt: { series: reference(series), ordinal: 2 }, previous: [],
    works: { producer: reference(handoff.producer), ledger: reference(handoff.record) } })).record;
  assert.equal(packet.value.state, 'ready');
  const packetBody = packet.value.packet as Record<string, Json>, requestId = packetBody.requestId as string;
  const ids = packet.value.plan!.assignments[packet.value.plan!.position]!.obligations;
  const framed = ok(prepareFrameProposals(f.store, sources.works as Extract<GapRequest['works'], { frame: unknown }>));
  const assigned = framed.frame.result.obligations.filter(obligation => ids.includes(obligation.id));
  assert.equal(assigned.length, ids.length);
  const work: Node = { ...(clone(upper) as Node), id: 'garden-answers-work', kind: 'work', parent: upper.id,
    title: 'Work resolving the exact N3 frame', code: [{ path: 'answers-work.ts', access: 'write', status: 'planned' }], tests: [] };
  const body = { nodes: [work], fills: assigned.map(obligation => ({ obligation: obligation.id, node: work.id,
    ...(obligation.kind === 'connection-end' ? { port: obligation.upper.port!, codeRef: work.code[0]! } : {}) })),
    tests: [], localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [],
    transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
  const adapter = f.store.write({ id: `adapter:${f.project}:answers:works`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: f.project, protocol: 'fixture' } });
  const config = f.store.write({ id: `config:${f.project}:answers:works`, kind: 'dispatch-config', expected: 0,
    value: { projectId: f.project, model: 'fixture' } });
  const call = ok(recordCall(f.store, f.project, { call: requestId, purpose: 'model-design', basis: null,
    block: upper.parent, gaps: batch.items.filter(item => ids.includes(item.target)).flatMap(item => item.consumers.map(consumer => ({
      id: item.target, goal: item.target, field: item.field, consumer }))),
    series: reference(series), attempt: 2, goal,
    dispatch: { adapter: reference(adapter), config: reference(config) },
    packet: clone(packet.value.packet) as Json })).call;
  const responseWrite: Write = { id: partResponseId(f.project, reference(call)), kind: 'part-response', expected: 0,
    value: { project: f.project, packet: reference(packet), call: reference(call), requestId,
      raw: JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId, action: 'answer', proposal: body, bindings: [] }) } };
  const prepared = ok(preparePartResult(f.store, { project: f.project, packet: reference(packet), call: reference(call),
    response: { pending: responseWrite } }));
  ok(writeGuarded(f.store, { unit: 'G4b-test', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
  const part = ok(readPartResult(f.store, { project: f.project, record: reference(prepared.record) }));
  const assembly = ok(assembleModelParts(f.store, { project: f.project, results: [reference(part.record)] }));
  const gap = gaps.records.find(row => batch.items.some(item => item.gap === row.value.gap.id))!;
  assert.ok(gap);
  const request: AnswersGateRequest = { project: f.project, gaps: gapRead, routes: reference(route),
    results: [{ gap: reference(gap), result: reference(assembly.record), candidate: null }] };
  const saved = ok(writeAnswersGate(f.store, request));
  assert.equal(saved.value.result.findings.some(finding => finding.at.target === gap.value.gap.target), false);
  f.restart();
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(saved) })), saved);
});

const LEGACY_ASSESSOR_COMMIT = '3eb5dac3c790ca988082840693969b06b5d81966';
const same = (a: unknown, b: unknown) => canonical(a as Json) === canonical(b as Json);
const canonicalOrder = <T>(values: readonly T[]): T[] => [...values].sort((a, b) =>
  canonical(a as Json) < canonical(b as Json) ? -1 : canonical(a as Json) > canonical(b as Json) ? 1 : 0);
/**
 * Runs a producer script with every engine module loaded from one exact commit, in its own process. The loader logs
 * each module it serves from Git and refuses an engine module outside the checkout, so a missed prefix cannot fall
 * back to the current build and let an era test pass vacuously.
 */
function atCommit(f: { root: string; path: string }, commit: string, name: string, body: string, input: unknown): unknown {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const loader = join(f.root, `${name}-loader.mjs`), producer = join(f.root, `${name}-producer.mjs`);
  const argsFile = join(f.root, `${name}-input.json`), served = join(f.root, `${name}-served.log`);
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  writeFileSync(served, '');
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from ${JSON.stringify(typescript)};
let root, log, prefixes;
export function initialize(data) {
  root = data.root; log = data.log;
  prefixes = [root, pathToFileURL(realpathSync(fileURLToPath(root)) + '/').href].map(base => new URL('dist/src/', base).href);
}
export async function load(url, context, next) {
  const prefix = prefixes.find(item => url.startsWith(item));
  if (prefix && /\\.js$/.test(url)) {
    const relative = 'src/' + url.slice(prefix.length).replace(/\\.js$/, '.ts');
    appendFileSync(log, relative + '\\n');
    const source = execFileSync('git', ['show', ${JSON.stringify(commit)} + ':' + relative],
      { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  if (url.startsWith('file:') && url.includes('/dist/src/') && !url.includes('/node_modules/'))
    throw new Error('An engine module outside the era checkout: ' + url);
  return next(url, context);
}`);
  writeFileSync(producer, `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository, database, input] = process.argv.slice(2);
const src = path => pathToFileURL(join(repository, 'dist/src', path)).href;
const { Store } = await import(src('storage/store.js'));
const { reference } = await import(src('pipeline/contracts.js'));
const args = JSON.parse(readFileSync(input, 'utf8')), store = new Store(database);
const take = result => { if (!result.ok) throw Error(JSON.stringify(result.refusal)); return result.value; };
const out = value => process.stdout.write(JSON.stringify(value));
try {
${body}
} finally { store.close(); }`);
  writeFileSync(argsFile, JSON.stringify(input));
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},
    { data: { root: ${JSON.stringify(pathToFileURL(repository).href)}, log: ${JSON.stringify(served)} } });`;
  const output: unknown = JSON.parse(execFileSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, f.path, argsFile],
    { cwd: repository, encoding: 'utf8', timeout: 180_000, maxBuffer: 10_000_000 }));
  const loaded = readFileSync(served, 'utf8').split('\n').filter(Boolean);
  assert.ok(loaded.includes('src/storage/store.ts') && loaded.includes('src/pipeline/contracts.ts'),
    `The producer ran on the modules of ${commit}: ${loaded.join(', ')}`);
  return output;
}
/** Reads the trace historically and checks what every trace must satisfy against its saved G4b record. */
type SavedGate = Revision<AnswersGateRecord> | Sealed<Revision<AnswersGateRecord>>;
function traceOf(f: { store: Store; project: string }, saved: SavedGate): readonly AnswersGateTraceEntry[] {
  const read = ok(readAnswersGateTrace(f.store, { project: f.project, record: reference(saved) }));
  assert.deepEqual(read.record, saved);
  assert.equal(hashJson(read.record.value), saved.hash, 'The delivered record hashes to the saved record');
  assert.deepEqual(read.trace.map(entry => entry.finding), saved.value.result.findings,
    'Exactly one trace entry per finding, in the saved order and multiplicity');
  const submitted = saved.value.request.results.map(row => canonical(row as unknown as Json));
  for (const { cause } of read.trace) {
    assert.ok(ANSWERS_GATE_EMISSIONS.includes(cause.emission), cause.emission);
    for (const ref of [cause.gap, cause.route?.routes, cause.route?.task, ...cause.sources.map(item => item.ref)])
      if (ref) assert.ok(isRef(ref) && Object.keys(ref).length === 3, JSON.stringify(ref));
    for (const item of cause.sources) assert.ok(ANSWERS_GATE_SOURCE_ROLES.includes(item.role), item.role);
    for (const item of cause.detail.mismatch ?? []) assert.ok(ANSWERS_GATE_MISMATCHES.includes(item), item);
    // Occurrences are rows of the saved submission as submitted, never beyond their multiplicity there.
    const left = [...submitted];
    for (const row of cause.occurrences) {
      const index = left.indexOf(canonical(row as unknown as Json));
      assert.ok(index >= 0, `An occurrence outside the saved submission: ${JSON.stringify(row)}`);
      left.splice(index, 1);
    }
  }
  return read.trace as readonly AnswersGateTraceEntry[];
}
function traceFor(trace: readonly AnswersGateTraceEntry[], gap: Ref) {
  return trace.filter(entry => entry.cause.gap?.id === gap.id);
}
/** The current preparation derives the same trace as the historical reader, without its guards or writes. */
function sameCurrentTrace(f: { store: Store; project: string }, request: AnswersGateRequest, saved: SavedGate) {
  const current = ok(prepareAnswersGateTrace(f.store, request));
  assert.deepEqual(current.prepared, ok(prepareAnswersGate(f.store, request)), 'The traced preparation is the standalone one');
  assert.deepEqual(current.prepared.record, saved);
  assert.deepEqual(current.trace, traceOf(f, saved));
  assert.ok(current.trace.every(entry => Object.keys(entry).join() === 'finding,cause'
    && Object.keys(entry.cause).join() === 'emission,gap,occurrences,route,sources,detail'));
}

/** Writes one G4b, proves the current trace equals the historical one after restart, and returns one gap's entries. */
function tracedFor(f: ReturnType<typeof fixture>, request: AnswersGateRequest, gap: Ref) {
  const saved = ok(writeAnswersGate(f.store, request));
  sameCurrentTrace(f, request, saved);
  f.restart();
  return traceFor(traceOf(f, saved), gap);
}
function summary(entries: readonly AnswersGateTraceEntry[]) {
  return entries.map(entry => [entry.finding.code, entry.cause.emission, entry.cause.detail,
    entry.cause.sources.map(item => item.role)]);
}
function unknownResult(f: { project: string }): Ref {
  return { id: `unknown-producer:${f.project}:result`, revision: 1, hash: '0'.repeat(64) };
}
const traceUsage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
/** The MC1 batch of the fixture question with its series, environment, adapter and ready packet. */
function mc1Exchange(f: ReturnType<typeof fixture>, slice: string, reviewer = 'answers-independent', completion = false, active = false) {
  const batch = f.route.value.batches.find(item => item.model === 'MC1'
    && item.items.some(question => question.target === f.target))!;
  assert.ok(batch);
  const goal: AttemptGoal = { key: `answers:${slice}:${f.target}`,
    questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  ok(openSeries(f.store, { project: f.project, block: f.block, line: 1, slice: `answers:${slice}`, predecessor: null, basis: null }));
  if (active) activateLines(f, f.horizon);
  const series = ok(completion ? managedOpenAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1, goal,
    completion: { routes: reference(f.route), batches: [batch.id] } })
    : beginAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1, goal }));
  const scenario = join(f.root, `${slice}-scenario.json`);
  const command = { executable: process.execPath, args: [adapterFixture, '--scenario', scenario,
    '--trace', join(f.root, `${slice}-trace.jsonl`)] };
  const configure = (actor: string, expected: number) => f.engine.environments.configure(f.project, { workspace: f.root,
    implementer: { actor: 'answers-original', model: 'fixture', effort: 'high', command },
    reviewer: { actor, model: 'fixture', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: 100_000 }, expected);
  const config = configure(reviewer, 0);
  const adapter = f.store.write({ id: `adapter:${f.project}:answers:${slice}`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: f.project, protocol: 'codex-stdio' } });
  const packet = ok(writeQuestionPacket(f.store, { project: f.project, routes: reference(f.route), batch: batch.id,
    environment: reference(config), attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  const source = f.store.get<{ content: string }>(`source:${f.project}:brief`)!;
  const answer = { research: { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'answer',
    results: batch.items.map(item => ({ questionId: item.gap, value: source.value.content.slice(0, 8),
      citations: [{ source: reference(source), selector: { kind: 'text-range', start: 0, end: source.value.content.length } }] })) },
  usage: traceUsage };
  return { batch, series, scenario, config, configure, packet, answer,
    dispatch: { adapter: reference(adapter), config: reference(config) } };
}
/** Row 9: the process stops right after the durable MC1 receipt, so the call stays unfinished. */
async function receivedMc1(f: ReturnType<typeof fixture>) {
  const exchange = mc1Exchange(f, 'received');
  writeFileSync(exchange.scenario, JSON.stringify({ steps: [exchange.answer] }));
  const writeMany = f.store.writeMany.bind(f.store);
  let stopped = false;
  f.store.writeMany = ((writes, guards) => {
    const committed = writeMany(writes, guards);
    if (!stopped && writes.some(write => write.kind === 'model-call'
      && (write.value as { om?: { application?: string } }).om?.application === 'received')) {
      stopped = true; throw new Error('MC1 simulated stop after its durable receipt');
    }
    return committed;
  }) as Store['writeMany'];
  try {
    await assert.rejects(runModelCall(f.store, { project: f.project, packet: reference(exchange.packet),
      dispatch: exchange.dispatch, role: 'implementer' }), /simulated stop/);
  } finally { f.store.writeMany = writeMany; }
  assert.ok(stopped);
  const [record, ...rest] = f.store.list('model-call');
  assert.ok(record && rest.length === 0);
  assert.equal(ok(readModelCallState(f.store, { project: f.project, record: reference(record) })).state, 'received');
  return record;
}
/**
 * One E5 terminal of the fixture fact. With ended, the assessor binding is lawfully replaced between the paid
 * assessor transport and its application, so H1.0b terminates the application with its checked cause.
 */
async function e5Terminal(f: ReturnType<typeof fixture>, assessor: Json, ended = false) {
  const exchange = mc1Exchange(f, ended ? 'e5-ended' : 'e5-terminal', 'answers-independent', ended);
  writeFileSync(exchange.scenario, JSON.stringify({ steps: [exchange.answer, assessor] }));
  const original = ok(await runModelCall(f.store, { project: f.project, packet: reference(exchange.packet),
    dispatch: exchange.dispatch, role: 'implementer' }));
  assert.equal(original.outcome?.kind, 'fact-candidates');
  const request = { project: f.project, modelCall: reference(original.record), questionId: exchange.batch.items[0]!.gap,
    dispatch: exchange.dispatch };
  if (!ended) return { terminal: ok(await assessFact(f.store, request)), replacement: null };
  const intent = ok(writeAssessmentIntent(f.store, request));
  const admission = ok(readAssessmentIntentAt(f.store, f.project, reference(intent)));
  const admitted = ok(recordCall(f.store, f.project, { call: admission.call, purpose: 'fact-assessment', basis: admission.basis,
    block: admission.block, gaps: admission.gaps, series: admission.series, attempt: admission.attempt, goal: admission.goal,
    dispatch: admission.dispatch, packet: admission.packet as Json }));
  const physical = ok(await runModelTransport(f.store, { project: f.project, call: reference(admitted.call),
    packet: admission.packet as Json, role: 'reviewer' }));
  const replacement = exchange.configure('answers-replacement-assessor', exchange.config.revision);
  const terminal = ok(applyAssessmentResult(f.store, { project: f.project, intent: reference(intent),
    assessor: reference(physical.record) }));
  return { terminal, replacement };
}
/** A real E4 stop-analysis transport of this project: a transport of another purpose than fact assessment. */
async function stopAnalysisTransport(f: ReturnType<typeof fixture>) {
  const address = { project: f.project, block: f.block, line: 1 };
  const goal: AttemptGoal = { key: 'answers:stopped-goal', questions: ['Address one contract'], result: 'A supported contract' };
  ok(openSeries(f.store, { ...address, slice: 'answers:stop-analysis', predecessor: null, basis: null }));
  let series: Revision<unknown> | null = null;
  for (const attempt of [1, 2, 3]) {
    ok(beginAttempt(f.store, { ...address, attempt, goal }));
    series = ok(completeAttempt(f.store, { ...address, attempt,
      outcome: { reason: 'result', achieved: [], cancelled: [], refusals: [] } })) as Revision<unknown>;
  }
  const basis = { kind: 'series-stop' as const, series: reference(series!), attempt: 3 };
  const scenario = join(f.root, 'stop-analysis-scenario.json');
  const command = { executable: process.execPath, args: [adapterFixture, '--scenario', scenario,
    '--trace', join(f.root, 'stop-analysis-trace.jsonl')] };
  const environment = f.engine.environments.configure(f.project, { workspace: f.root,
    implementer: { actor: 'analysis-executor', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'analysis-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const adapter = f.store.write({ id: `adapter:${f.project}:answers:stop-analysis`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: f.project, protocol: 'codex-stdio' } });
  const packet = { task: 'Diagnose the named ground', basis } as unknown as Json;
  const admitted = ok(recordCall(f.store, f.project, { call: 'answers:stop-analysis', purpose: 'stop-analysis', basis,
    block: f.block, gaps: [{ id: 'stop-analysis', goal: 'stop-analysis', field: 'cause-and-change', consumer: 'A6:stop-analysis' }],
    series: reference(series!), attempt: 3,
    goal: { key: 'stop-analysis', questions: ['What caused this ground?'], result: 'A cause with an addressed change' },
    dispatch: { adapter: reference(adapter), config: reference(environment) }, packet }));
  writeFileSync(scenario, JSON.stringify({ steps: [{ research: { cause: 'fixture observation', hypothesis: true },
    usage: traceUsage }] }));
  return ok(await runModelTransport(f.store, { project: f.project, call: reference(admitted.call), packet, role: 'reviewer' }));
}
/** A genuine E5.0 assessor transport of the fixture fact, recorded by the code of the legacy commit. */
async function legacyTransport(f: ReturnType<typeof fixture>, name: string) {
  const source = await originalFactForLegacyAssessor(f), original = source.original;
  if (original.outcome?.kind !== 'fact-candidates' || !original.response) assert.fail('The source MC1 needs one checked candidate');
  const fact = f.blocking.find(row => row.value.gap.target === f.target)!;
  const factSource = original.outcome.facts.find(item => item.questionId === fact.value.gap.id)!;
  assert.ok(factSource);
  const basis = { kind: 'fact-assessment', modelCall: reference(original.record), call: original.call,
    packet: original.packet, response: original.response, question: factSource.question, questionId: factSource.questionId };
  const call = ok(readCall(f.store, f.project, original.call));
  if ('owner' in call.value) assert.fail('The original MC1 must belong to a block attempt');
  const input = { project: f.project, call: { call: `${name}-review`, purpose: 'fact-assessment', basis, block: f.block,
    gaps: call.value.gaps.filter(gap => gap.id === f.target && gap.field === 'answer'), series: reference(source.series),
    attempt: 1, goal: source.goal, dispatch: { adapter: reference(source.adapter), config: reference(source.config) },
    packet: { questionId: factSource.questionId, value: 'legacy-review', evidence: original.response } } };
  const old = atCommit(f, LEGACY_ASSESSOR_COMMIT, name, `const { recordCall } = await import(src('om/call-record.js'));
const { runModelTransport } = await import(src('om/model-call.js'));
const admitted = take(recordCall(store, args.project, args.call));
const transport = take(await runModelTransport(store,
  { project: args.project, call: reference(admitted.call), packet: args.call.packet, role: 'reviewer' }));
out({ transport: transport.record, call: reference(admitted.call) });`, input) as { transport: Revision<unknown>; call: Ref };
  f.restart();
  return { ...old, fact, original, factSource };
}

test('26 H1.0c duplicate submissions of one gap keep one finding with every occurrence and no winner', t => {
  const f = fixture(t, 'owner-decision'), owner = f.blocking.find(row => row.value.gap.target === f.target)!;
  assert.ok(owner);
  const exact: AnswerRouteResult = { gap: reference(owner), result: null, candidate: null };
  const offeredRoute: AnswerRouteResult = { ...exact, result: reference(f.route) };
  const stale: AnswerRouteResult = { ...exact, gap: { ...exact.gap, revision: exact.gap.revision + 1 } };
  const routed = f.route.value.routes.find(row => row.gap === owner.value.gap.id)!;
  const traces = new Map<string, readonly AnswersGateTraceEntry[]>();
  for (const rows of [[exact, exact], [exact, offeredRoute], [offeredRoute, exact], [stale, exact], [exact, exact, offeredRoute]]) {
    const request: AnswersGateRequest = { ...f.request, results: rows };
    const saved = ok(writeAnswersGate(f.store, request));
    const addressed = saved.value.result.findings.filter(item => item.at.target === owner.value.gap.target);
    assert.equal(addressed.filter(item => item.code === 'answer_duplicate').length, 1, 'One G4b finding for the whole duplicate');
    const trace = traceFor(traceOf(f, saved), reference(owner));
    const duplicate = trace.filter(entry => entry.cause.emission === 'duplicate');
    assert.equal(duplicate.length, 1);
    assert.deepEqual(duplicate[0]!.cause.occurrences, canonicalOrder(rows), 'Every row, with its multiplicity');
    assert.deepEqual(duplicate[0]!.cause.gap, reference(owner));
    assert.deepEqual(duplicate[0]!.cause.route, { routes: reference(f.route), route: routed.route, task: routed.task });
    assert.equal(trace.some(entry => ['owner-offered', 'owner-absent', 'blocking-null', 'blocking-absent']
      .includes(entry.cause.emission)), false, 'No occurrence is evaluated as the selected answer');
    if (rows.includes(stale)) assert.deepEqual(trace.filter(entry => entry.cause.emission === 'gap-revision-stale')
      .map(entry => entry.cause.occurrences), [[stale]]);
    sameCurrentTrace(f, request, saved);
    traces.set(saved.id, trace);
  }
  assert.equal(traces.size, 4, 'The two permutations of one set of rows are one G4b and one trace');
  f.restart();
  for (const [id, trace] of traces) {
    const saved = ok(readAnswersGate(f.store, { project: f.project, record: reference(f.store.get(id)!) }));
    assert.deepEqual(traceFor(traceOf(f, saved), reference(owner)), trace);
  }
});

test('C58 H1.0c one answer_missing_for_blocking_gap code keeps absent, null, D3, technical MC1, E5 N, T and cessation causes apart', async t => {
  const collected: { name: string; entry: AnswersGateTraceEntry }[] = [];
  const factOf = (f: ReturnType<typeof fixture>) => f.blocking.find(row => row.value.gap.target === f.target)!;
  const trailOf = (f: ReturnType<typeof fixture>, gap: Revision<unknown>) => {
    const routed = f.route.value.routes.find(row => row.gap === (gap.value as { gap: { id: string } }).gap.id)!;
    return { routes: reference(f.route), route: routed.route, task: routed.task };
  };
  async function covered(f: ReturnType<typeof fixture>, name: string, rows: AnswerRouteResult[]) {
    const fact = factOf(f), request: AnswersGateRequest = { ...f.request, results: rows };
    const saved = ok(writeAnswersGate(f.store, request));
    sameCurrentTrace(f, request, saved);
    f.restart();
    const trace = traceFor(traceOf(f, saved), reference(fact));
    assert.equal(trace.length, 1, `${name}: ${JSON.stringify(trace)}`);
    const entry = trace[0]!;
    assert.deepEqual(entry.cause.gap, reference(fact));
    assert.deepEqual(entry.cause.occurrences, rows);
    assert.deepEqual(entry.cause.route, trailOf(f, fact));
    if (entry.finding.code === 'answer_missing_for_blocking_gap') collected.push({ name, entry });
    return entry;
  }
  await t.test('8 H1.0c absent row and explicit null result are different causes', async child => {
    const f = fixture(child, 'repository-fact'), fact = factOf(f);
    assert.ok(fact);
    const absent = await covered(f, 'absent', []);
    assert.deepEqual([absent.cause.emission, absent.cause.sources], ['blocking-absent', []]);
    const empty = await covered(f, 'null', [{ gap: reference(fact), result: null, candidate: null }]);
    assert.deepEqual([empty.cause.emission, empty.cause.sources], ['blocking-null', []]);
  });
  await t.test('19 H1.0c a D3 proposal carries its exact D3 record', async child => {
    const f = fixture(child, 'repository-fact', false), fact = factOf(f);
    const decision = f.store.write(inputDecisionWrite({ project: f.project, input: reference(f.input),
      graph: reference(f.graph), layers: [], decision: { target: f.target, field: 'address',
        value: { consumer: f.block, kind: 'repository-fact' } } }));
    const entry = await covered(f, 'D3', [{ gap: reference(fact), result: reference(decision), candidate: null }]);
    assert.equal(entry.cause.emission, 'decision-unapplied');
    assert.deepEqual(entry.cause.sources, [{ role: 'decision', ref: reference(decision) }]);
  });
  await t.test('9 H1.0c an MC1 stopped after its durable receipt is unfinished, not missing', async child => {
    const f = fixture(child, 'repository-fact'), fact = factOf(f), record = await receivedMc1(f);
    const entry = await covered(f, 'unfinished MC1', [{ gap: reference(fact), result: reference(record), candidate: null }]);
    assert.deepEqual([entry.finding.code, entry.cause.emission, entry.cause.detail, entry.cause.sources],
      ['route_result_missing', 'mc1-unfinished', { state: 'received' }, [{ role: 'model-call', ref: reference(record) }]]);
  });
  await t.test('14 H1.0c a technical MC1 carries its exact E4 exchange and application state', async child => {
    const f = fixture(child, 'repository-fact'), original = await ordinaryOffFormFact(f), fact = factOf(f);
    const entry = await covered(f, 'technical MC1', [{ gap: reference(fact), result: reference(original.record), candidate: null }]);
    assert.equal(entry.cause.emission, 'mc1-technical');
    assert.deepEqual(entry.cause.sources.slice(0, 4), [{ role: 'model-call', ref: reference(original.record) },
      { role: 'call', ref: original.call }, { role: 'packet', ref: original.packet }, { role: 'packet-routes', ref: reference(f.route) }]);
    assert.deepEqual(entry.cause.sources.slice(4), [...(original.response ? [{ role: 'response', ref: original.response }] : []),
      ...(original.diagnostic ? [{ role: 'diagnostic', ref: original.diagnostic }] : [])]);
    assert.deepEqual(entry.cause.detail, { state: 'applied', outcome: original.outcome?.kind ?? null });
    const withCandidate = await covered(f, 'fact candidate', [{ gap: reference(fact), result: reference(original.record),
      candidate: reference(f.route) }]);
    assert.deepEqual(summary([withCandidate]), [['answer_route_foreign', 'fact-candidate', {}, ['offered', 'candidate']]]);
  });
  for (const verdict of ['insufficient', 'conflicting', 'off-form'] as const)
    await t.test(`${verdict === 'off-form' ? '14' : '13'} H1.0c an E5 ${verdict} terminal carries its exact terminal and verdict`, async child => {
      const f = fixture(child, 'repository-fact'), assessed = await assessedFact(f, verdict), fact = factOf(f);
      const intent = ok(readAssessmentIntentAt(f.store, f.project, assessed.terminal.value.intent));
      const entry = await covered(f, verdict, [{ gap: reference(fact), result: reference(assessed.terminal), candidate: null }]);
      assert.equal(entry.cause.emission, `assessment-${verdict}`);
      assert.deepEqual(entry.cause.sources, [{ role: 'terminal', ref: reference(assessed.terminal) },
        { role: 'intent', ref: assessed.terminal.value.intent }, { role: 'question', ref: intent.question.record }]);
      assert.deepEqual(entry.cause.detail, { verdict });
      assert.deepEqual(entry.finding.at.ref, reference(assessed.terminal));
      if (verdict === 'insufficient') {
        const candidates = await covered(f, 'fact candidates', [{ gap: reference(fact), result: reference(assessed.original.record),
          candidate: null }]);
        assert.deepEqual([candidates.finding.code, candidates.cause.emission, candidates.cause.detail],
          ['route_result_missing', 'mc1-fact-candidates', { state: 'applied', outcome: 'fact-candidates' }], '10 H1.0c');
        assert.deepEqual(candidates.cause.sources.map(item => item.role), ['model-call', 'call', 'packet', 'packet-routes', 'response']);
      }
      if (verdict !== 'off-form') return;
      const transport = await covered(f, 'managed transport', [{ gap: reference(fact), result: assessed.terminal.value.assessor,
        candidate: null }]);
      assert.equal(transport.finding.code, 'route_result_missing');
      assert.equal(transport.cause.emission, 'assessment-transport-managed');
      assert.deepEqual(transport.cause.sources.map(item => item.role),
        ['transport', 'call', 'intent', 'model-call', 'packet', 'response', 'question']);
      assert.deepEqual(transport.cause.sources[0]!.ref, assessed.terminal.value.assessor);
      assert.deepEqual(transport.cause.sources[2]!.ref, assessed.terminal.value.intent);
    });
  await t.test('11 H1.0c a supported E5 terminal is not its separately accepted D5', async child => {
    const f = fixture(child, 'repository-fact'), assessed = await assessedFact(f, 'supported'), fact = factOf(f);
    const task = f.route.value.routes.find(row => row.gap === fact.value.gap.id)!.task!;
    const route = ok(writeRoutes(f.store, { project: f.project, gaps: f.request.gaps, tasks: [{ record: task }],
      catalog: { paths: [], records: [] }, previous: reference(f.route) }));
    const entries = tracedFor(f, { ...f.request, routes: reference(route), results: [{ gap: reference(fact),
      result: reference(assessed.terminal), candidate: null }] }, reference(fact));
    assert.deepEqual(summary(entries), [['route_result_missing', 'assessment-supported', { verdict: 'supported' },
      ['terminal', 'intent', 'accepted', 'question']]]);
    assert.deepEqual(entries[0]!.cause.sources[2]!.ref, assessed.terminal.value.accepted);
  });
  await t.test('14 H1.0c an interrupted E5 terminal is T with its exact terminal', async child => {
    const f = fixture(child, 'repository-fact'), fact = factOf(f);
    const { terminal } = await e5Terminal(f, { rawStdout: '{broken', exitCode: 7, stderr: 'intentional assessor failure' });
    assert.equal(terminal.value.verdict, 'interrupted');
    const entry = await covered(f, 'interrupted', [{ gap: reference(fact), result: reference(terminal), candidate: null }]);
    assert.deepEqual(summary([entry]), [['answer_missing_for_blocking_gap', 'assessment-interrupted', { verdict: 'interrupted' },
      ['terminal', 'intent', 'question']]]);
    assert.deepEqual(entry.cause.sources[0]!.ref, reference(terminal));
  });
  await t.test('14 H1.0c an E5 application ended by H1.0b carries its checked cessation cause', async child => {
    const f = fixture(child, 'repository-fact'), fact = factOf(f);
    const { terminal, replacement } = await e5Terminal(f, { research: { verdict: 'supported', reasons: [] }, usage: traceUsage }, true);
    const ended = terminal.value;
    if (ended.verdict !== 'application-terminated') assert.fail('A replaced assessor binding terminates the application');
    const cause = ended.cause;
    if (cause.kind !== 'required-record-replaced') assert.fail('The termination names the replaced required record');
    assert.deepEqual(cause.replacement, reference(replacement!));
    const entry = await covered(f, 'terminated', [{ gap: reference(fact), result: reference(terminal), candidate: null }]);
    assert.equal(entry.cause.emission, 'assessment-terminated');
    assert.deepEqual(entry.cause.detail, { verdict: 'application-terminated', cessation: 'required-record-replaced',
      prerequisite: cause.prerequisite.kind });
    const intent = ok(readAssessmentIntentAt(f.store, f.project, ended.intent));
    assert.deepEqual(entry.cause.sources, [{ role: 'terminal', ref: reference(terminal) }, { role: 'intent', ref: ended.intent },
      { role: 'binding', ref: ended.binding }, { role: 'assignment', ref: ended.assignment }, { role: 'work', ref: ended.work },
      { role: 'call', ref: ended.call }, { role: 'receipt', ref: ended.receipt },
      { role: 'prerequisite', ref: cause.prerequisite.source }, { role: 'replacement', ref: reference(replacement!) },
      ...(cause.proof ? [{ role: 'replacement-proof', ref: cause.proof }] : []), { role: 'question', ref: intent.question.record }]);
  });
  const emissions = collected.map(item => item.entry.cause.emission);
  assert.deepEqual(emissions, ['blocking-absent', 'blocking-null', 'decision-unapplied', 'mc1-technical',
    'assessment-insufficient', 'assessment-conflicting', 'assessment-off-form', 'assessment-interrupted', 'assessment-terminated']);
  assert.equal(new Set(collected.map(item => `${item.entry.finding.code}/${item.entry.finding.at.target}/${item.entry.finding.at.field}`)).size, 1,
    'One code, target and field; only the traced cause tells N, T, cessation, D3, absence and a technical MC1 apart');
  assert.equal(new Set(collected.map(item => canonical(item.entry.cause as unknown as Json))).size, collected.length);
});

test('16 H1.0c a legacy E5.0 transport keeps its own traced cause, not an E5 N of the current attempt', async t => {
  const f = fixture(t, 'repository-fact'), old = await legacyTransport(f, 'e50-g4b-trace');
  const { fact, original, factSource } = old;
  const request: AnswersGateRequest = { ...f.request, results: [{ gap: reference(fact), result: reference(old.transport), candidate: null }] };
  const saved = ok(writeAnswersGate(f.store, request));
  sameCurrentTrace(f, request, saved);
  f.restart();
  const trace = traceFor(traceOf(f, saved), reference(fact));
  assert.deepEqual(trace.map(entry => [entry.finding.code, entry.cause.emission]),
    [['answer_missing_for_blocking_gap', 'assessment-legacy-transport']]);
  assert.deepEqual(trace[0]!.cause.sources, [{ role: 'transport', ref: reference(old.transport) }, { role: 'call', ref: old.call },
    { role: 'model-call', ref: reference(original.record) }, { role: 'packet', ref: original.packet },
    { role: 'response', ref: original.response }, { role: 'question', ref: factSource.question }]);
  assert.deepEqual(trace[0]!.cause.detail, {}, 'No verdict or intent is invented for the legacy era');
});

test('16 H1.0c a legacy E5.0 transport of another question or a superseded task keeps its exact foreign cause', async t => {
  const f = fixture(t, 'repository-fact', true, true), old = await legacyTransport(f, 'e50-g4b-foreign');
  const other = f.blocking.find(row => row.value.gap.target === 'discovery:other-choice')!;
  assert.ok(other);
  const chain = ['transport', 'call', 'model-call', 'packet', 'response', 'question'];
  assert.deepEqual(summary(tracedFor(f, { ...f.request, results: [{ gap: reference(other), result: reference(old.transport),
    candidate: null }] }, reference(other))), [['answer_version_stale', 'legacy-question-foreign', {}, chain]]);
  const task = ok(prepareAnswerTask(f.store, { project: f.project, input: reference(f.input), gaps: f.request.gaps,
    gap: reference(old.fact), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string', minLength: 1 } }));
  const kept = f.route.value.routes.filter(row => row.task && row.gap !== old.fact.value.gap.id).map(row => ({ record: row.task! }));
  const route = ok(writeRoutes(f.store, { project: f.project, gaps: f.request.gaps,
    tasks: [task.writes.length ? { pending: clone(task.writes[0]!) as Write } : { record: reference(task.record) }, ...kept],
    catalog: { paths: [], records: [] }, previous: reference(f.route) }));
  const changed = tracedFor(f, { ...f.request, routes: reference(route), results: [{ gap: reference(old.fact),
    result: reference(old.transport), candidate: null }] }, reference(old.fact));
  assert.deepEqual(summary(changed), [['answer_version_stale', 'assessment-question-foreign', { mismatch: ['question-task'] }, chain]],
    'The legacy question names its original task; only that condition differs');
});

test('C57 H1.0c answer_version_stale and record_foreign carry their exact distinct causes', async t => {
  await t.test('18 H1.0c a D5 outside the exact search, a stale gap revision and a foreign design record', async child => {
    const f = fixture(child, 'repository-fact', true, true), accepted = await acceptedFact(f);
    const other = f.blocking.find(row => row.value.gap.target === 'discovery:other-choice')!;
    const batch = accepted.route.value.batches.find(item => item.model === 'MC2' && item.task === 'node-expansion' && item.level === 2)!;
    const design = f.blocking.find(row => batch.items.some(item => item.gap === row.value.gap.id))!;
    const stale = f.blocking.find(row => row.id !== other.id && row.id !== design.id && row.id !== accepted.fact.id)!;
    assert.ok(other && design && stale);
    const staleRow: AnswerRouteResult = { gap: { ...reference(stale), revision: stale.revision + 1 }, result: null, candidate: null };
    const rows: AnswerRouteResult[] = [{ gap: reference(other), result: reference(accepted.accepted), candidate: null },
      { gap: reference(design), result: reference(f.route), candidate: null }, staleRow];
    const request: AnswersGateRequest = { ...f.request, routes: reference(accepted.route), results: rows };
    const saved = ok(writeAnswersGate(f.store, request));
    sameCurrentTrace(f, request, saved);
    f.restart();
    const trace = traceOf(f, saved);
    const search = accepted.route.value.searches.find(row => row.gap === other.value.gap.id)!;
    const routedOther = accepted.route.value.routes.find(row => row.gap === other.value.gap.id)!;
    assert.deepEqual(traceFor(trace, reference(other)).map(entry => [entry.finding.code, entry.finding.at.field, entry.cause]),
      [['answer_version_stale', 'search', { emission: 'answer-outside-search', gap: reference(other), occurrences: [rows[0]],
        route: { routes: reference(accepted.route), route: routedOther.route, task: routedOther.task },
        sources: [{ role: 'answer', ref: reference(accepted.accepted) }, { role: 'search-index', ref: search.index }], detail: {} }]]);
    const foreign = traceFor(trace, reference(design));
    assert.deepEqual(foreign.map(entry => [entry.finding.code, entry.cause.emission, entry.cause.sources]),
      [['record_foreign', 'design-known-foreign', [{ role: 'offered', ref: reference(f.route) }]]]);
    assert.deepEqual(traceFor(trace, reference(stale)).map(entry => [entry.finding.code, entry.cause.emission, entry.cause.occurrences]),
      [['answer_version_stale', 'gap-revision-stale', [staleRow]]]);
  });
  await t.test('18 H1.0c a D5 of a changed current task is traced with its search and answer', async child => {
    const f = fixture(child, 'repository-fact'), prior = await acceptedFact(f);
    const task = ok(prepareAnswerTask(f.store, { project: f.project, input: reference(f.input),
      gaps: f.request.gaps, gap: reference(prior.fact), requirements: [{ pointer: '/contracts/0' }],
      resultForm: { type: 'string', minLength: 1 } }));
    const route = ok(writeRoutes(f.store, { project: f.project, gaps: f.request.gaps,
      tasks: [task.writes.length ? { pending: clone(task.writes[0]!) as Write } : { record: reference(task.record) }],
      catalog: { paths: [], records: [] }, previous: reference(prior.route) }));
    const request: AnswersGateRequest = { ...f.request, routes: reference(route),
      results: [{ gap: reference(prior.fact), result: reference(prior.accepted), candidate: null }] };
    const saved = ok(writeAnswersGate(f.store, request));
    sameCurrentTrace(f, request, saved);
    f.restart();
    const [entry, ...rest] = traceFor(traceOf(f, saved), reference(prior.fact));
    assert.equal(rest.length, 0);
    assert.deepEqual([entry!.finding.code, entry!.finding.at.field], ['answer_version_stale', 'answer']);
    const search = route.value.searches.find(row => row.gap === prior.fact.value.gap.id)!;
    assert.ok(search.checks.some(check => same(check.answer, reference(prior.accepted))),
      'The answer is in the exact search; only its applicability to the changed task fails');
    assert.equal(entry!.cause.emission, 'answer-inapplicable', JSON.stringify(entry));
    assert.deepEqual(entry!.cause.sources, [{ role: 'answer', ref: reference(prior.accepted) },
      { role: 'search-index', ref: search.index }]);
  });
  await t.test('18 H1.0c an ordinary MC1 of a superseded fact task is foreign to the current M6 task', async child => {
    const f = fixture(child, 'repository-fact'), original = await ordinaryOffFormFact(f);
    const fact = f.blocking.find(row => row.value.gap.target === f.target)!;
    const task = ok(prepareAnswerTask(f.store, { project: f.project, input: reference(f.input), gaps: f.request.gaps,
      gap: reference(fact), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string', minLength: 1 } }));
    const route = ok(writeRoutes(f.store, { project: f.project, gaps: f.request.gaps,
      tasks: [task.writes.length ? { pending: clone(task.writes[0]!) as Write } : { record: reference(task.record) }],
      catalog: { paths: [], records: [] }, previous: reference(f.route) }));
    const entries = tracedFor(f, { ...f.request, routes: reference(route), results: [{ gap: reference(fact),
      result: reference(original.record), candidate: null }] }, reference(fact));
    assert.deepEqual(summary(entries), [['answer_version_stale', 'mc1-foreign-task',
      { purpose: 'model-research', mismatch: ['current-batch-absent', 'item-absent'] }, ['model-call', 'call', 'packet', 'packet-routes']]]);
    assert.deepEqual(entries[0]!.cause.sources.map(item => item.ref), [reference(original.record), original.call, original.packet,
      reference(f.route)]);
  });
  await t.test('18 H1.0c an E5 terminal of another question keeps every foreign condition', async child => {
    const f = fixture(child, 'repository-fact', true, true), assessed = await assessedFact(f, 'insufficient');
    const intent = ok(readAssessmentIntentAt(f.store, f.project, assessed.terminal.value.intent));
    const question = ok(readMc1Question(f.store, { project: f.project, record: intent.question.record }));
    const foreign = f.blocking.find(row => row.value.gap.kind === 'repository-fact' && row.id !== question.record.value.request.gap.id
      && f.route.value.routes.some(item => item.gap === row.value.gap.id && item.task))!;
    assert.ok(foreign);
    assert.deepEqual(summary(tracedFor(f, { ...f.request, results: [{ gap: reference(foreign), result: reference(assessed.terminal),
      candidate: null }] }, reference(foreign))), [['answer_version_stale', 'assessment-question-foreign',
      { mismatch: ['question-gap', 'question-task', 'question-address'] }, ['terminal', 'intent', 'question']]]);
  });
  await t.test('28 H1.0c a transport of another purpose is record_foreign with its exact call', async child => {
    const f = fixture(child, 'repository-fact'), fact = f.blocking.find(row => row.value.gap.target === f.target)!;
    const transport = await stopAnalysisTransport(f);
    const entries = tracedFor(f, { ...f.request, results: [{ gap: reference(fact), result: reference(transport.record),
      candidate: null }] }, reference(fact));
    assert.deepEqual(summary(entries), [['record_foreign', 'transport-foreign',
      { purpose: 'stop-analysis', mismatch: ['call-purpose', 'call-basis'] }, ['transport', 'call']]]);
    assert.deepEqual(entries[0]!.cause.sources.map(item => item.ref), [reference(transport.record), transport.call]);
  });
});

test('C05 H1.0c every reachable cause of one emission point keeps its own kind and checked detail', async t => {
  const at = (f: ReturnType<typeof fixture>, gap: Revision<unknown>, row: Omit<AnswerRouteResult, 'gap'> | null,
    routes: Ref = reference(f.route)) => tracedFor(f, { ...f.request, routes,
    results: row ? [{ gap: reference(gap), ...row }] : [] }, reference(gap));
  await t.test('31 H1.0c an owner gap absent, offered a recognized or an unknown record, deferred, or named inexactly', async child => {
    const f = fixture(child, 'owner-decision'), owner = f.blocking.find(row => row.value.gap.target === f.target)!;
    assert.equal(owner.value.gap.kind, 'owner-decision');
    assert.deepEqual(summary(at(f, owner, null)), [['owner_result_unavailable', 'owner-absent', {}, []]]);
    assert.deepEqual(summary(at(f, owner, { result: reference(f.route), candidate: null })),
      [['owner_result_unavailable', 'owner-offered', { recognized: true }, ['offered']]]);
    assert.deepEqual(summary(at(f, owner, { result: unknownResult(f), candidate: null })),
      [['owner_result_unavailable', 'owner-offered', { recognized: false }, ['offered']]]);
    assert.deepEqual(summary(at(f, owner, { result: null, candidate: null,
      deferral: { reason: 'outside_horizon', until: 'horizon-entry' } })),
    [['deferral_not_permitted', 'deferral-declared', { declared: true, inherited: false }, []]]);
    const exact = reference(owner);
    const inexact: AnswerRouteResult = { gap: { ...exact, note: 'extra key' } as Ref, result: null, candidate: null };
    const stale: AnswerRouteResult = { gap: { ...exact, revision: exact.revision + 1 }, result: null, candidate: null };
    for (const [row, emission] of [[inexact, 'gap-ref-inexact'], [stale, 'gap-revision-stale']] as const) {
      const entries = tracedFor(f, { ...f.request, results: [row] }, exact);
      assert.deepEqual(entries.map(entry => [entry.finding.code, entry.cause.emission, entry.cause.gap, entry.cause.occurrences,
        entry.cause.route]), [['answer_version_stale', emission, exact, [row], null]],
      'The same revision with an extra key is an inexact Ref, not another revision');
    }
    const outside: AnswersGateRequest = { ...f.request, results: [{ gap: { ...exact, id: `om-gap:${f.project}:unknown` }, result: null, candidate: null }] };
    const unknown = ok(writeAnswersGate(f.store, outside));
    sameCurrentTrace(f, outside, unknown); f.restart();
    assert.deepEqual(traceOf(f, unknown).filter(entry => entry.cause.gap === null).map(entry => entry.cause.emission), ['gap-unknown'],
      'A result outside the exact complete D1 set has no gap and is traced as unknown');
  });
  await t.test('32 H1.0c an unsupported predecessor question absent and offered', async child => {
    const f = fixture(child, 'design-decision'), gap = f.blocking.find(row => row.value.gap.target === f.target)!;
    assert.equal(gap.value.gap.code, 'predecessor_question');
    assert.deepEqual(summary(at(f, gap, null)), [['route_result_unsupported', 'unsupported-absent', {}, []]]);
    assert.deepEqual(summary(at(f, gap, { result: reference(f.route), candidate: null })),
      [['route_result_unsupported', 'unsupported-offered', { recognized: true }, ['offered']]]);
  });
  await t.test('28 H1.0c a fact and a design gap keep a known, an unknown, a candidate and a wrong-kind answer apart', async child => {
    const f = fixture(child, 'repository-fact', true, true), accepted = await acceptedFact(f);
    const other = f.blocking.find(row => row.value.gap.target === 'discovery:other-choice')!;
    const batch = accepted.route.value.batches.find(item => item.model === 'MC2' && item.task === 'node-expansion' && item.level === 2)!;
    const design = f.blocking.find(row => batch.items.some(item => item.gap === row.value.gap.id))!;
    assert.ok(other && design);
    const routes = reference(accepted.route);
    assert.deepEqual(summary(at(f, other, { result: reference(f.route), candidate: null }, routes)),
      [['answer_route_foreign', 'offered-known-foreign', {}, ['offered']]]);
    assert.deepEqual(summary(at(f, other, { result: unknownResult(f), candidate: null }, routes)),
      [['route_result_unsupported', 'offered-unrecognized', {}, ['offered']]]);
    assert.deepEqual(summary(at(f, accepted.fact, { result: reference(accepted.accepted), candidate: reference(f.route) }, routes)),
      [['answer_route_foreign', 'answer-candidate', {}, ['answer', 'search-index', 'candidate']]]);
    assert.deepEqual(summary(at(f, design, { result: reference(accepted.accepted), candidate: null }, routes)),
      [['answer_route_foreign', 'answer-without-fact-task', { mismatch: ['gap-kind', 'route-task-absent'] }, ['answer']]]);
    assert.deepEqual(summary(at(f, design, { result: unknownResult(f), candidate: null }, routes)),
      [['route_result_unsupported', 'design-unrecognized', {}, ['offered']]]);
  });
  await t.test('19 H1.0c a D3 proposal offered for a frame gap is foreign, not an unapplied input decision', async child => {
    const f = fixture(child, 'repository-fact', false);
    const decision = f.store.write(inputDecisionWrite({ project: f.project, input: reference(f.input),
      graph: reference(f.graph), layers: [], decision: { target: f.target, field: 'address',
        value: { consumer: f.block, kind: 'repository-fact' } } }));
    const design = f.blocking.find(row => row.value.gap.kind === 'design-decision' && row.value.gap.code === 'obligation_open')!;
    assert.ok(design);
    assert.deepEqual(summary(at(f, design, { result: reference(decision), candidate: null })),
      [['answer_route_foreign', 'decision-foreign', {}, ['decision']]]);
  });
  await t.test('23 H1.0c an MC2 candidate of another proposal and an assembly of another assignment', async child => {
    const f = fixture(child), first = assembledOperation(f), other = assembledOperation(f, 'garden-consume-block');
    ok(completeAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1,
      outcome: { reason: 'off-form', achieved: [], cancelled: [], refusals: [] } }));
    const replacement = assembledOperation(f, f.block, { attempt: 2, variant: 'replacement' });
    const candidate = ok(writeCandidate(f.store, { frame: f.request.gaps.sources.operations.frame,
      proposals: [reference(replacement.assembly.proposal), reference(other.assembly.proposal)] }));
    if (candidate.state !== 'candidate') assert.fail('The replacement must form a complete real candidate');
    assert.deepEqual(summary(at(f, first.gap, { result: reference(first.assembly.record), candidate: reference(candidate.record) })),
      [['delta_stale', 'candidate-stale', { level: 2, mismatch: ['proposal'] }, ['assembly', 'proposal', 'packet', 'part', 'candidate']]]);
    assert.deepEqual(summary(at(f, first.gap, { result: reference(other.assembly.record), candidate: null })),
      [['answer_route_foreign', 'assembly-assignment-foreign', { mismatch: ['gap-unassigned', 'item-absent'] },
        ['assembly', 'proposal', 'packet', 'part', 'packet-routes']]]);
  });
});

/** The real N3 works assembly of the base N3 test, with its accepted upper frame and the G3 candidate that led to it. */
function worksAssembly(t: TestContext) {
  const f = fixture(t), first = assembledOperation(f), second = assembledOperation(f, 'garden-consume-block');
  const candidate = ok(writeCandidate(f.store, { frame: f.request.gaps.sources.operations.frame,
    proposals: [reference(first.assembly.proposal), reference(second.assembly.proposal)] }));
  assert.equal(candidate.state, 'candidate');
  if (candidate.state !== 'candidate') assert.fail('The complete upper candidate must be present');
  const accepted = ok(settleCandidate(f.store, { project: f.project, level: 2, candidate: reference(candidate.record),
    outcome: { gate: 'G3', candidate: reference(candidate.record), graphHash: candidate.record.value.graphHash,
      passed: true, codes: [] } }));
  assert.equal(accepted.state, 'accepted');
  const graph = reference(accepted.graph!), layer = reference(accepted.layer!), upperFrame = reference(accepted.frame!);
  const horizon = ok(writeHorizon(f.store, { project: f.project, input: reference(f.input), graph,
    refinement: layer, available: {}, choice: { choiceVersion: 'answers-gate-works',
      features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project: f.project, input: reference(f.input), graph, horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project: f.project, level: 2, graph, horizon: reference(horizon.gate),
      layer, frame: upperFrame, upper: null } },
    works: { proposals: [], frame: { project: f.project, level: 3, graph, horizon: reference(horizon.gate),
      layer: null, frame: null, upper: { horizon: reference(horizon.gate), frame: upperFrame } } } };
  const gaps = ok(writeGaps(f.store, sources));
  const gapRead: GapReadRequest = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(f.store, { project: f.project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const handoff = ok(writeOmObligations(f.store, { project: f.project, gaps: gapRead,
    lines: reference(lines), assignments: [] }));
  const route = ok(writeRoutes(f.store, { project: f.project, gaps: gapRead, tasks: [],
    catalog: { paths: [], records: [] }, previous: null }));
  const batch = route.value.batches.find(item => item.model === 'MC2' && item.level === 3 && item.task === 'node-expansion');
  assert.ok(batch, 'The accepted upper frame produces an N3 work expansion batch');
  assert.ok(handoff.producer && handoff.record);
  assert.deepEqual(handoff.handoff.obligations, []);
  for (const block of ['garden-produce-block', 'garden-consume-block'])
    ok(completeAttempt(f.store, { project: f.project, block, line: 1, attempt: 1,
      outcome: { reason: 'off-form', achieved: [], cancelled: [], refusals: [] } }));
  const upper = accepted.graph!.value.nodes.find(node => node.id === batch.node)!;
  assert.ok(upper?.parent);
  const goal: AttemptGoal = { key: `answers:works:${batch.node}`,
    questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  const series = ok(beginAttempt(f.store, { project: f.project, block: upper.parent, line: 1,
    attempt: 2, goal }));
  const environment = f.store.get(`environment:${f.project}`)!;
  const packet = ok(writeQuestionPacket(f.store, { project: f.project, routes: reference(route), batch: batch.id,
    environment: reference(environment), attempt: { series: reference(series), ordinal: 2 }, previous: [],
    works: { producer: reference(handoff.producer), ledger: reference(handoff.record) } })).record;
  assert.equal(packet.value.state, 'ready');
  const packetBody = packet.value.packet as Record<string, Json>, requestId = packetBody.requestId as string;
  const ids = packet.value.plan!.assignments[packet.value.plan!.position]!.obligations;
  const framed = ok(prepareFrameProposals(f.store, sources.works as Extract<GapRequest['works'], { frame: unknown }>));
  const assigned = framed.frame.result.obligations.filter(obligation => ids.includes(obligation.id));
  assert.equal(assigned.length, ids.length);
  const work: Node = { ...(clone(upper) as Node), id: 'garden-answers-work', kind: 'work', parent: upper.id,
    title: 'Work resolving the exact N3 frame', code: [{ path: 'answers-work.ts', access: 'write', status: 'planned' }], tests: [] };
  const body = { nodes: [work], fills: assigned.map(obligation => ({ obligation: obligation.id, node: work.id,
    ...(obligation.kind === 'connection-end' ? { port: obligation.upper.port!, codeRef: work.code[0]! } : {}) })),
    tests: [], localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [],
    transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
  const adapter = f.store.write({ id: `adapter:${f.project}:answers:works`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: f.project, protocol: 'fixture' } });
  const config = f.store.write({ id: `config:${f.project}:answers:works`, kind: 'dispatch-config', expected: 0,
    value: { projectId: f.project, model: 'fixture' } });
  const call = ok(recordCall(f.store, f.project, { call: requestId, purpose: 'model-design', basis: null,
    block: upper.parent, gaps: batch.items.filter(item => ids.includes(item.target)).flatMap(item => item.consumers.map(consumer => ({
      id: item.target, goal: item.target, field: item.field, consumer }))),
    series: reference(series), attempt: 2, goal,
    dispatch: { adapter: reference(adapter), config: reference(config) },
    packet: clone(packet.value.packet) as Json })).call;
  const responseWrite: Write = { id: partResponseId(f.project, reference(call)), kind: 'part-response', expected: 0,
    value: { project: f.project, packet: reference(packet), call: reference(call), requestId,
      raw: JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId, action: 'answer', proposal: body, bindings: [] }) } };
  const prepared = ok(preparePartResult(f.store, { project: f.project, packet: reference(packet), call: reference(call),
    response: { pending: responseWrite } }));
  ok(writeGuarded(f.store, { unit: 'G4b-test', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
  const part = ok(readPartResult(f.store, { project: f.project, record: reference(prepared.record) }));
  const assembly = ok(assembleModelParts(f.store, { project: f.project, results: [reference(part.record)] }));
  const gap = gaps.records.find(row => batch.items.some(item => item.gap === row.value.gap.id))!;
  assert.ok(gap);
  return { f, gapRead, route, gap, assembly, candidate: reference(candidate.record) };
}

test('C05 H1.0c an N3 works assembly offered with a layer candidate keeps its own traced cause', t => {
  const works = worksAssembly(t), f = works.f;
  const request: AnswersGateRequest = { project: f.project, gaps: works.gapRead, routes: reference(works.route),
    results: [{ gap: reference(works.gap), result: reference(works.assembly.record), candidate: works.candidate }] };
  const entries = tracedFor(f, request, reference(works.gap));
  assert.deepEqual(summary(entries), [['answer_route_foreign', 'works-candidate', { level: 3 },
    ['assembly', 'proposal', 'packet', 'part', 'candidate']]]);
  assert.deepEqual(entries[0]!.cause.sources.at(-1)!.ref, works.candidate);
});

test('C59 H1.0c the current MC2 preparation and the historical reader derive the same trace', t => {
  const f = fixture(t), mc2 = assembledOperation(f), other = assembledOperation(f, 'garden-consume-block');
  const candidate = ok(writeCandidate(f.store, { frame: f.request.gaps.sources.operations.frame,
    proposals: [reference(mc2.assembly.proposal), reference(other.assembly.proposal)] }));
  if (candidate.state !== 'candidate') assert.fail('The two real MC2 proposals must fill the current N2 frame');
  const cases: [AnswerRouteResult, string | null, string[]][] = [
    [{ gap: reference(mc2.gap), result: reference(mc2.assembly.record), candidate: reference(candidate.record) }, null, []],
    [{ gap: reference(mc2.gap), result: reference(mc2.assembly.record), candidate: null }, 'candidate-absent',
      ['assembly', 'proposal', 'packet', 'part']],
    [{ gap: reference(mc2.gap), result: reference(mc2.part.record), candidate: null }, 'part-not-assembly', ['part']],
    [{ gap: reference(mc2.gap), result: null, candidate: reference(candidate.record) }, 'candidate-without-result', ['candidate']],
  ];
  for (const [row, emission, roles] of cases) {
    const request: AnswersGateRequest = { ...f.request, results: [row] };
    const current = ok(prepareAnswersGateTrace(f.store, request));
    if (emission === null) assert.ok(current.prepared.guards.some(guard => 'id' in guard && guard.id === candidate.record.id),
      'The current preparation guards the live G3 candidate; the trace does not carry that guard');
    const saved = ok(writeAnswersGate(f.store, request));
    f.restart();
    assert.deepEqual(current.trace, traceOf(f, saved));
    const addressed = traceFor(current.trace, reference(mc2.gap));
    assert.deepEqual(addressed.map(entry => entry.cause.emission), emission ? [emission] : []);
    if (emission) assert.deepEqual(addressed[0]!.cause.sources.map(item => item.role), roles);
    sameCurrentTrace(f, request, saved);
  }
});

test('1 H1.0c readAnswersGateTrace checks the shape of every argument before storage, like readAnswersGate', t => {
  const f = fixture(t, 'owner-decision'), saved = ok(writeAnswersGate(f.store, f.request)), before = snapshot(f.store);
  const record = reference(saved);
  const cases: [unknown, unknown][] = [[undefined, { project: f.project, record }], [null, { project: f.project, record }],
    [{}, { project: f.project, record }], [f.store, undefined], [f.store, null], [f.store, 'request'], [f.store, [record]],
    [f.store, { record }], [f.store, { project: '', record }], [f.store, { project: 42, record }],
    [f.store, { project: f.project }], [f.store, { project: f.project, record: null }],
    [f.store, { project: f.project, record: { id: saved.id } }], [f.store, { project: f.project, record: saved.id }]];
  for (const [store, request] of cases)
    for (const action of [readAnswersGateTrace, readAnswersGate])
      assert.throws(() => action(store as Store, request as { project: string; record: Ref }), (error: unknown) =>
        error instanceof EngineError && error.code === 'answers_gate_request_invalid', `${action.name} ${JSON.stringify(request)}`);
  for (const request of [undefined, null, { ...f.request, results: [{ gap: null, result: null, candidate: null }] }])
    assert.throws(() => prepareAnswersGateTrace(f.store, request as unknown as AnswersGateRequest), (error: unknown) =>
      error instanceof EngineError && error.code === 'answers_gate_request_invalid');
  assert.deepEqual(snapshot(f.store), before);
  const foreign = readAnswersGateTrace(f.store, { project: 'another-project', record });
  const direct = readAnswersGate(f.store, { project: 'another-project', record });
  assert.equal(foreign.ok, false);
  if (!foreign.ok && !direct.ok) assert.deepEqual(foreign.refusal, direct.refusal);
});

// ---- H1.0c S2: registration of the managed check (№1616 п.1, №1628 Q2) ----
/** A managed block attempt of the fixture fact, opened by the real G7 opening with its materialized MC1 packet. */
function managedAttempt(f: ReturnType<typeof fixture>, slice: string, active = false) {
  const exchange = mc1Exchange(f, slice, 'answers-independent', true, active);
  const binding = ok(readCompletionBinding(f.store, f.project, reference(exchange.series), 1));
  if (!binding) assert.fail('The managed opening writes its binding');
  const head = () => f.store.get<CompletionWork>(completionWorkId(f.project, binding.id))!;
  const work = (ref: Ref = reference(head())) => ok(readCompletionWorkAt(f.store, f.project, ref));
  return { ...exchange, binding, head, work };
}
/** Pays MC1 and its supported E5 through the real producers, so every root of the managed work is complete. */
async function supportedManaged(f: ReturnType<typeof fixture>, m: ReturnType<typeof managedAttempt>) {
  writeFileSync(m.scenario, JSON.stringify({ steps: [m.answer,
    { research: { verdict: 'supported', reasons: [] }, usage: traceUsage }] }));
  const original = ok(await runModelCall(f.store, { project: f.project, packet: reference(m.packet),
    dispatch: m.dispatch, role: 'implementer' }));
  assert.equal(original.outcome?.kind, 'fact-candidates');
  const terminal = ok(await assessFact(f.store, { project: f.project, modelCall: reference(original.record),
    questionId: m.batch.items[0]!.gap, dispatch: m.dispatch }));
  assert.equal(terminal.value.verdict, 'supported');
  return terminal;
}
const closing = (f: ReturnType<typeof fixture>, accepted: Ref) => ({ project: f.project, block: f.block, line: 1, attempt: 1,
  outcome: { reason: 'result' as const, accepting: [accepted], cancelling: [], refusals: [] } });

test('C11 H1.0c registration and its answers-gate assignment enter work in one transition; a repeat adds nothing', t => {
  const f = fixture(t, 'repository-fact'), m = managedAttempt(f, 'c11');
  const before = m.head(), prior = m.work();
  assert.equal(prior.answers, null);
  const saved = ok(writeAnswersRegistration(f.store, { project: f.project, binding: reference(m.binding) }));
  const assignment = answersGateAssignment(m.binding);
  assert.equal(assignment.id, completionAssignmentId(f.project, m.binding.id, 'answers-gate'));
  assert.deepEqual(saved.value, { contract: 'om-answers-registration/v1', project: f.project,
    binding: reference(m.binding), assignment: reference(assignment), work: reference(before) });
  assert.equal(saved.id, answersRegistrationId(f.project, reference(assignment)));
  const after = m.head();
  assert.equal(after.revision, before.revision + 1, 'One work transition carries the registration and its assignment');
  assert.deepEqual(after.value.previous, reference(before));
  assert.deepEqual(after.value.products.filter(ref => !before.value.products.some(old => canonical(old) === canonical(ref))),
    [reference(saved)]);
  assert.deepEqual([...after.value.assignments].sort((a, b) => canonical(a) < canonical(b) ? -1 : 1),
    [...before.value.assignments, reference(assignment)].sort((a, b) => canonical(a) < canonical(b) ? -1 : 1));
  assert.deepEqual(f.store.get(assignment.id), assignment, 'The stored assignment is its exact derivation from the binding');
  const snapshotAfter = m.work();
  assert.deepEqual(snapshotAfter.answers, { assignment: reference(assignment), registration: reference(saved), evaluation: null, ceased: null,
    complete: false, existing: [], waiting: [{ reason: 'unevaluated', ref: reference(saved), code: null }] });
  assert.equal(snapshotAfter.complete, false);
  assert.deepEqual(snapshotAfter.assignments.map(reference), prior.assignments.map(reference),
    'The physical assignment set stays physical; the check is a separate participant');
  const stored = snapshot(f.store);
  assert.deepEqual(ok(writeAnswersRegistration(f.store, { project: f.project, binding: reference(m.binding) })), saved);
  const repeat = ok(prepareAnswersRegistration(f.store, { project: f.project, binding: reference(m.binding) }));
  assert.deepEqual([repeat.record, repeat.writes, repeat.guards], [saved, [], []]);
  assert.deepEqual(snapshot(f.store), stored, 'A second registration of the same assignment is a repeat, not a new obligation');
  f.restart();
  const read = ok(readAnswersRegistrationAt(f.store, f.project, reference(saved)));
  assert.deepEqual([read.record, read.assignment, reference(read.binding)], [saved, assignment, reference(m.binding)]);
  assert.deepEqual(m.work(), snapshotAfter);
  assert.equal(m.work(reference(before)).answers, null, 'The predecessor work reads by its own composition');
  assert.deepEqual(ok(readAnswersGateAssignmentAt(f.store, f.project, reference(assignment))), assignment);
  const physical = readCompletionAssignmentAt(f.store, f.project, reference(assignment));
  assert.equal(physical.ok ? 'accepted' : physical.refusal.code, 'completion_invalid', 'The physical reader rejects the check');
  const root = completionRootAssignments(m.binding)[0]!;
  const masked = readAnswersGateAssignmentAt(f.store, f.project, reference(root));
  assert.equal(masked.ok ? 'accepted' : masked.refusal.code, 'completion_invalid', 'The check reader rejects a physical root');
  const foreign = readAnswersRegistrationAt(f.store, f.project, reference(after));
  assert.equal(foreign.ok ? 'accepted' : foreign.refusal.code, 'record_foreign');
});

test('C11 H1.0c two stores racing to register leave one registration and one work transition', t => {
  const f = fixture(t, 'repository-fact'), m = managedAttempt(f, 'c11-race');
  const before = m.head(), prepared = ok(prepareAnswersRegistration(f.store, { project: f.project, binding: reference(m.binding) }));
  assert.ok(prepared.writes.length >= 3, 'registration, assignment and work are one bundle');
  const rival = new Store(f.path);
  try {
    const won = ok(writeAnswersRegistration(rival, { project: f.project, binding: reference(m.binding) }));
    assert.deepEqual(won, prepared.record);
  } finally { rival.close(); }
  const stored = snapshot(f.store);
  const lost = writeGuarded(f.store, { unit: 'G4b', target: prepared.record.id, writes: [...prepared.writes], guards: [...prepared.guards] });
  assert.equal(lost.ok, false, 'The prepared bundle is refused by its CAS on the moved work');
  assert.deepEqual(snapshot(f.store), stored);
  assert.equal(m.head().revision, before.revision + 1);
  assert.deepEqual(ok(writeAnswersRegistration(f.store, { project: f.project, binding: reference(m.binding) })), prepared.record);
  assert.deepEqual(snapshot(f.store), stored);
});

test('36 H1.0c a registered check holds the close of an otherwise complete managed work with completion_incomplete', async t => {
  const f = fixture(t, 'repository-fact'), m = managedAttempt(f, 'row36');
  const registration = ok(writeAnswersRegistration(f.store, { project: f.project, binding: reference(m.binding) }));
  const terminal = await supportedManaged(f, m);
  const work = m.work();
  assert.ok(completionRootAssignments(m.binding).every(root => work.resolved.some(ref => ref.id === root.id)),
    'Every physical root is resolved after the supported E5');
  assert.equal(work.complete, false);
  assert.deepEqual(work.answers?.waiting, [{ reason: 'unevaluated', ref: reference(registration), code: null }]);
  const stored = snapshot(f.store);
  const held = closeAttempt(f.store, closing(f, terminal.value.accepted!));
  assert.equal(held.ok ? 'closed' : held.refusal.code, 'completion_incomplete');
  f.restart();
  const again = closeAttempt(f.store, closing(f, terminal.value.accepted!));
  assert.equal(again.ok ? 'closed' : again.refusal.code, 'completion_incomplete');
  assert.deepEqual(snapshot(f.store), stored, 'Neither the close nor the series moved');
  assert.equal(m.head().value.closed, null);
  // Masquerade: the same registration moved one transition later, over a rehashed predecessor without it.
  const at = registration.value.work.revision, id = registration.value.work.id;
  const successor = f.store.get<CompletionWork>(id, at + 1)!, later = f.store.get<CompletionWork>(id, at + 2)!;
  assert.ok(successor.value.products.some(ref => ref.id === registration.id) && later);
  const bare = { ...successor.value, products: successor.value.products.filter(ref => ref.id !== registration.id),
    assignments: successor.value.assignments.filter(ref => ref.id !== answersGateAssignment(m.binding).id) };
  const fake3 = { ...successor, value: bare, hash: hashJson(bare as unknown as Json) };
  const moved = { ...later.value, previous: reference(fake3) };
  const fake4 = { ...later, value: moved, hash: hashJson(moved as unknown as Json) };
  const view = new Proxy(f.store, { get(target, property) {
    if (property === 'get') return (key: string, revision?: number) => key === id && revision === at + 1 ? fake3
      : key === id && revision === at + 2 ? fake4 : target.get(key, revision);
    const value: unknown = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.equal(ok(readCompletionWorkAt(view, f.project, reference(fake3))).answers, null);
  const planted = readCompletionWorkAt(view, f.project, reference(fake4));
  assert.deepEqual(planted.ok ? 'accepted' : [planted.refusal.code, planted.refusal.at.target, planted.refusal.at.field],
    ['completion_invalid', registration.id, 'work'], 'A registration is atomic with its immediate successor work');
});

test('C11 H1.0c closed work accepts no registration; saved work@1 and the v1 close keep their own contract', async t => {
  const f = fixture(t, 'repository-fact'), m = managedAttempt(f, 'c11-closed');
  const first = f.store.get<CompletionWork>(completionWorkId(f.project, m.binding.id), 1)!;
  const terminal = await supportedManaged(f, m);
  const closed = ok(closeAttempt(f.store, closing(f, terminal.value.accepted!)));
  const head = m.head();
  assert.ok(head.value.closed);
  const stored = snapshot(f.store);
  const refused = writeAnswersRegistration(f.store, { project: f.project, binding: reference(m.binding) });
  assert.equal(refused.ok ? 'registered' : refused.refusal.code, 'completion_closed');
  if (!refused.ok) assert.deepEqual(refused.refusal.at.ref, reference(head));
  assert.deepEqual(snapshot(f.store), stored);
  f.restart();
  const initial = m.work(reference(first));
  assert.equal(initial.answers, null);
  assert.deepEqual(first.value.assignments, completionRootAssignments(m.binding).map(reference));
  const final = m.work();
  assert.equal(final.answers, null);
  assert.equal(final.complete, true);
  assert.equal(final.work.value.assignments.some(ref => ref.id === answersGateAssignment(m.binding).id), false);
  assert.equal(f.store.get<{ contract: string }>(completionCloseId(f.project, m.binding.id))!.value.contract, 'om-completion-close/v1');
  assert.deepEqual(ok(closeAttempt(f.store, closing(f, terminal.value.accepted!))), closed);
  assert.deepEqual(snapshot(f.store), stored);
  // A planted registration standing on the closed work is refused by the reader itself.
  const assignment = reference(answersGateAssignment(m.binding));
  const value = { contract: 'om-answers-registration/v1', project: f.project, binding: reference(m.binding), assignment,
    work: reference(m.head()) };
  const fake = { id: answersRegistrationId(f.project, assignment), kind: 'om-answers-registration', revision: 1,
    hash: hashJson(value as unknown as Json), value };
  const view = new Proxy(f.store, { get(target, property) {
    if (property === 'get') return (key: string, revision?: number) => key === fake.id ? fake : target.get(key, revision);
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const planted = readAnswersRegistrationAt(view, f.project, reference(fake));
  assert.deepEqual(planted.ok ? 'accepted' : [planted.refusal.code, planted.refusal.at.field], ['completion_invalid', 'work']);
});

test('C11 H1.0c a mechanism binding has no check: answers_evaluation_owner_unsupported before any record', t => {
  const f = fixture(t, 'repository-fact', false);
  const batch = f.route.value.batches.find(row => row.model === 'MC2' && row.task === 'input-field'
    && row.items.some(item => item.target === f.target))!;
  assert.ok(batch);
  const owner = { kind: 'mechanism' as const, mechanism: 'M5:addressing' as const };
  const goal: AttemptGoal = { key: 'answers:mechanism', questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  ok(openSeries(f.store, { project: f.project, owner, line: 1, scope: f.request.gaps, predecessor: null, basis: null } as never));
  const series = ok(managedOpenAttempt(f.store, { project: f.project, owner, line: 1, attempt: 1, goal,
    admission: { gaps: f.request.gaps, routes: reference(f.route), batch: batch.id },
    completion: { routes: reference(f.route), batches: [batch.id] } } as never));
  const binding = ok(readCompletionBinding(f.store, f.project, reference(series), 1));
  if (!binding) assert.fail('The managed mechanism opening writes its binding');
  assert.equal(binding.value.owner.kind, 'mechanism');
  const stored = snapshot(f.store);
  for (const action of [prepareAnswersRegistration, writeAnswersRegistration]) {
    const denied: OmResult<unknown> = action(f.store, { project: f.project, binding: reference(binding) });
    assert.equal(denied.ok ? 'registered' : denied.refusal.code, 'answers_evaluation_owner_unsupported');
    if (!denied.ok) assert.deepEqual([denied.refusal.at.unit, denied.refusal.at.target, denied.refusal.at.field, denied.refusal.at.ref],
      ['G4b', binding.id, 'owner', reference(binding)], 'Refused right after the binding read, before the work is read');
  }
  assert.deepEqual(snapshot(f.store), stored, 'No registration, assignment, work or A2 record');
  const assignment = reference(answersGateAssignment(binding)), head = f.store.get(completionWorkId(f.project, binding.id))!;
  const value = { contract: 'om-answers-registration/v1', project: f.project, binding: reference(binding), assignment,
    work: reference(head) };
  const fake = { id: answersRegistrationId(f.project, assignment), kind: 'om-answers-registration', revision: 1,
    hash: hashJson(value as unknown as Json), value };
  const view = new Proxy(f.store, { get(target, property) {
    if (property === 'get') return (key: string, revision?: number) => key === fake.id ? fake : target.get(key, revision);
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const planted = readAnswersRegistrationAt(view, f.project, reference(fake));
  assert.deepEqual(planted.ok ? 'accepted' : [planted.refusal.code, planted.refusal.at.target],
    ['answers_evaluation_owner_unsupported', fake.id], 'A planted mechanism registration is not read as a block check');
  const work = ok(readCompletionWorkAt(f.store, f.project, reference(f.store.get(completionWorkId(f.project, binding.id))!)));
  assert.equal(work.answers, null);
});

test('C11 H1.0c registration arguments are EngineError before the store; a missing binding is answers_binding_invalid', t => {
  const f = fixture(t, 'repository-fact');
  assert.ok(ANSWERS_GATE_CODES.includes('answers_binding_invalid'));
  assert.ok(ANSWERS_GATE_CODES.includes('answers_evaluation_owner_unsupported'));
  const binding: Ref = { id: `om-completion-owner:${f.project}:${'0'.repeat(64)}`, revision: 1, hash: '0'.repeat(64) };
  const stored = snapshot(f.store);
  const shapes: [string, () => unknown][] = [
    ['store', () => prepareAnswersRegistration({} as Store, { project: f.project, binding })],
    ['request', () => prepareAnswersRegistration(f.store, null as never)],
    ['extra key', () => writeAnswersRegistration(f.store, { project: f.project, binding, work: binding } as never)],
    ['binding', () => writeAnswersRegistration(f.store, { project: f.project, binding: 'binding' as never })],
    ['project', () => prepareAnswersRegistration(f.store, { project: '', binding })],
    ['read ref', () => readAnswersRegistrationAt(f.store, f.project, null as never)],
    ['read store', () => readAnswersRegistrationAt(null as never, f.project, binding)],
    ['assignment ref', () => readAnswersGateAssignmentAt(f.store, f.project, 'ref' as never)],
  ];
  for (const [name, action] of shapes) assert.throws(action, (error: unknown) => error instanceof EngineError, name);
  const missing = writeAnswersRegistration(f.store, { project: f.project, binding });
  assert.equal(missing.ok ? 'registered' : missing.refusal.code, 'answers_binding_invalid');
  if (!missing.ok) assert.deepEqual([missing.refusal.at.field, missing.refusal.at.ref], ['binding', binding]);
  assert.deepEqual(snapshot(f.store), stored);
});

// ---- H1.0c S3: evaluation, finding groups, A2 sources and delivery (№1446 rows, №1616, №1628) ----
/** A managed block attempt of the fixture fact with its registered check. */
function registered(f: ReturnType<typeof fixture>, slice: string, active = false) {
  const m = managedAttempt(f, slice, active);
  const registration = ok(writeAnswersRegistration(f.store, { project: f.project, binding: reference(m.binding) }));
  return { ...m, registration };
}
function evaluate(f: ReturnType<typeof fixture>, m: { binding: Ref | Revision<unknown> }, results: AnswerRouteResult[],
  extra: { routes?: Ref; deliver?: 'all' | 'none'; request?: AnswersGateRequest } = {}) {
  return writeAnswersEvaluation(f.store, { project: f.project, binding: reference(m.binding as Revision<unknown>),
    request: extra.request ?? { ...f.request, routes: extra.routes ?? f.request.routes, results },
    ...(extra.deliver ? { deliver: extra.deliver } : {}) });
}
const factGap = (f: ReturnType<typeof fixture>) => f.blocking.find(row => row.value.gap.target === f.target)!;
/** Every group of a saved evaluation, as emission, code and contribution. */
function contributions(f: { store: Store; project: string }, evaluation: Ref) {
  return ok(readAnswersEvaluationAt(f.store, f.project, evaluation)).groups
    .map(group => [group.proof.value.cause.emission, group.proof.value.finding.code, group.proof.value.contribution]);
}
const added = (before: Revision<CompletionWork>, after: Revision<CompletionWork>) =>
  after.value.products.filter(ref => !before.value.products.some(old => same(old, ref)));
/** A managed MC1 answer and its E5 terminal of the given verdict, paid through the real producers of this attempt. */
async function managedFact(f: ReturnType<typeof fixture>, m: ReturnType<typeof managedAttempt>,
  verdict: 'supported' | 'insufficient' | 'conflicting' | 'off-form') {
  const assessor = verdict === 'off-form' ? { research: { answer: 'untyped reviewer reply' }, usage: traceUsage }
    : { research: { verdict, reasons: verdict === 'supported' ? [] : ['source not decisive'] }, usage: traceUsage };
  writeFileSync(m.scenario, JSON.stringify({ steps: [m.answer, assessor] }));
  const original = ok(await runModelCall(f.store, { project: f.project, packet: reference(m.packet),
    dispatch: m.dispatch, role: 'implementer' }));
  assert.equal(original.outcome?.kind, 'fact-candidates');
  const terminal = ok(await assessFact(f.store, { project: f.project, modelCall: reference(original.record),
    questionId: m.batch.items[0]!.gap, dispatch: m.dispatch }));
  assert.equal(terminal.value.verdict, verdict);
  return { original, terminal };
}

test('8 C39 C59 H1.0c a blocking gap without submission is a journal-only barrier: the check waits and nothing is counted', t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row8'), fact = factGap(f);
  const before = m.head();
  const saved = ok(evaluate(f, m, []));
  assert.equal(saved.repeated, false);
  const read = ok(readAnswersEvaluationAt(f.store, f.project, reference(saved.evaluation)));
  assert.deepEqual(read.record.value.scope.items.map(item => item.gap), [reference(fact)], 'The area is the planned fact gap only');
  assert.ok(read.gate.value.result.findings.length > 1, 'The full G4b keeps every finding of the whole D1 (row 4)');
  assert.deepEqual(contributions(f, reference(saved.evaluation)), [['blocking-absent', 'answer_missing_for_blocking_gap',
    { kind: 'journal-only', wait: 'submission', barrier: true }]]);
  const [group] = read.groups;
  assert.equal(group!.source.id, answersRefusalId(f.project, reference(group!.proof)));
  assert.deepEqual(group!.source.value, { gate: 'G4b', refusals: [{ code: 'answer_missing_for_blocking_gap',
    goal: m.binding.value.goal.result, remedy: group!.proof.value.finding.message, origin: { name: 'answer_missing_for_blocking_gap',
      stage: 'answers-gate/v1', subject: f.target, sources: [{ role: 'answers-finding', ref: reference(group!.proof) }] } }] });
  const after = m.head();
  assert.equal(after.revision, before.revision + 1, 'Evaluation, A2 source and journal cut enter work in one transition (C39)');
  assert.deepEqual(added(before, after).map(ref => ref.id).sort(), [saved.evaluation.id, group!.source.id].sort());
  const journal = ok(readJournal(f.store, { project: f.project }));
  assert.deepEqual(after.value.journal, reference(journal));
  assert.equal(journal.value.rows.filter(row => same(row.source, reference(group!.source))).length, 1);
  assert.equal(journal.value.classifications.length, 0, 'A journal-only row is never classified');
  const work = m.work();
  assert.deepEqual(work.answers, { assignment: reference(answersGateAssignment(m.binding)), registration: reference(m.registration),
    evaluation: reference(saved.evaluation), ceased: null, complete: false, existing: [],
    waiting: [{ reason: 'submission', ref: reference(group!.proof), code: 'answer_missing_for_blocking_gap' }] });
  assert.equal(work.complete, false);
  assert.equal(work.refusals.length, 0, 'The G4b observation is not a counted refusal');
  const stored = snapshot(f.store);
  f.restart();
  const repeat = ok(evaluate(f, m, []));
  assert.deepEqual([repeat.repeated, repeat.evaluation, repeat.groups], [true, saved.evaluation, saved.groups]);
  assert.deepEqual(snapshot(f.store), stored);
  assert.deepEqual(m.work(), work);
});

test('13 H1.0c own E5 N is one existing contribution with its canonical source; its G4b row is not a second N', async t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row13'), fact = factGap(f);
  const { terminal } = await managedFact(f, m, 'insufficient');
  const prior = m.work();
  const canonicalSource = prior.products.find(ref => ref.id.includes(':e5:'))!;
  assert.ok(canonicalSource, 'The managed E5 producer adds its canonical source');
  const saved = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(terminal), candidate: null }]));
  assert.deepEqual(contributions(f, reference(saved.evaluation)), [['assessment-insufficient', 'answer_missing_for_blocking_gap',
    { kind: 'existing', producer: 'E5-N', basis: [reference(terminal), canonicalSource] }]]);
  const work = m.work();
  assert.equal(work.answers?.complete, true);
  assert.deepEqual(work.answers?.existing, [reference(terminal), canonicalSource].sort((a, b) => canonical(a) < canonical(b) ? -1 : 1));
  assert.deepEqual(work.refusals, prior.refusals, 'One N: the counted refusal stays the canonical E5 row alone');
  assert.equal(work.complete, true);
});
const mc1Batch = (f: ReturnType<typeof fixture>) => f.route.value.batches.find(item => item.model === 'MC1'
  && item.items.some(question => question.target === f.target))!;
const nodeBatch = (f: ReturnType<typeof fixture>, block: string) => f.route.value.batches.find(item => item.model === 'MC2'
  && item.task === 'node-expansion' && item.level === 2 && item.node === block)!;
const fieldBatch = (f: ReturnType<typeof fixture>, target: string, field: string) => f.route.value.batches.find(item =>
  item.task === 'input-field' && item.items.some(row => row.target === target && row.field === field))!;
/** A managed block attempt on the given original batches through the real G7 opening, with its registered check. */
function managedOn(f: ReturnType<typeof fixture>, block: string, batches: string[], attempt = 1, slice = 'managed') {
  const items = batches.flatMap(id => f.route.value.batches.find(item => item.id === id)!.items);
  const goal: AttemptGoal = { key: `answers:${slice}:${block}`, questions: items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, items[0]!.target, items[0]!.field) };
  if (attempt === 1) ok(openSeries(f.store, { project: f.project, block, line: 1, slice: `answers:${slice}`, predecessor: null, basis: null }));
  const series = ok(managedOpenAttempt(f.store, { project: f.project, block, line: 1, attempt, goal,
    completion: { routes: reference(f.route), batches } }));
  const binding = ok(readCompletionBinding(f.store, f.project, reference(series), attempt));
  if (!binding) assert.fail('The managed opening writes its binding');
  const registration = ok(writeAnswersRegistration(f.store, { project: f.project, binding: reference(binding) }));
  const head = () => f.store.get<CompletionWork>(completionWorkId(f.project, binding.id))!;
  const work = (ref: Ref = reference(head())) => ok(readCompletionWorkAt(f.store, f.project, ref));
  return { binding, registration, head, work, series, goal };
}
/** Two real MC2 operations of attempt 1 (no managed owner) and then the managed attempt 2 of the same N2 batch. */
function managedDesign(f: ReturnType<typeof fixture>, withReplacement = false) {
  const first = assembledOperation(f), other = assembledOperation(f, 'garden-consume-block');
  const end = (attempt: number) => ok(completeAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt,
    outcome: { reason: 'off-form', achieved: [], cancelled: [], refusals: [] } }));
  end(1);
  const replacement = withReplacement ? assembledOperation(f, f.block, { attempt: 2, variant: 'replacement' }) : null;
  if (replacement) end(2);
  return { first, other, replacement, m: managedOn(f, f.block, [nodeBatch(f, f.block).id], replacement ? 3 : 2, 'design') };
}
/** The next managed attempt of the fact line, after a non-managed attempt 1 of the same series ended. */
function managedAfter(f: ReturnType<typeof fixture>, slice: string, end = true) {
  if (end) ok(completeAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: { reason: 'off-form', achieved: [], cancelled: [], refusals: [] } }));
  return managedOn(f, f.block, [mc1Batch(f).id], 2, slice);
}
const refused = (result: OmResult<unknown>) => result.ok ? 'accepted' : [result.refusal.code, result.refusal.at.field];

test('1 H1.0c a G4b preparation refusal is returned as is and writes no evaluation, proof or A2', t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row1'), fact = factGap(f);
  const forged = { ...f.request, results: [{ gap: { ...reference(fact), hash: '0'.repeat(64) }, result: null, candidate: null }] };
  const moved = f.store.write({ id: f.input.id, kind: f.input.kind, expected: f.input.revision, value: clone(f.input.value) });
  assert.equal(moved.revision, f.input.revision + 1);
  const stored = snapshot(f.store);
  for (const request of [{ ...f.request, results: [] }, forged]) {
    const direct = prepareAnswersGate(f.store, request);
    assert.equal(direct.ok, false);
    for (const action of [prepareAnswersEvaluation, writeAnswersEvaluation]) {
      const denied = action(f.store, { project: f.project, binding: reference(m.binding), request });
      assert.equal(denied.ok, false);
      if (!denied.ok && !direct.ok) assert.deepEqual(denied.refusal, direct.refusal, 'The typed preparation refusal is passed on as it is');
    }
  }
  assert.deepEqual(snapshot(f.store), stored, 'No passed:false, evaluation, finding-proof or A2 source is made from a refusal');
  assert.equal(f.store.list(ANSWERS_EVALUATION_KIND).length + f.store.list(ANSWERS_FINDING_KIND).length, 0);
});

test('24 H1.0c a real G3 refusal or a forged assembly stays the preparation refusal of the evaluation: no evaluation or A2', t => {
  const f = fixture(t), { first, other, m } = managedDesign(f);
  const candidate = ok(writeCandidate(f.store, { frame: f.request.gaps.sources.operations.frame,
    proposals: [reference(first.assembly.proposal), reference(other.assembly.proposal)] }));
  if (candidate.state !== 'candidate') assert.fail('The complete candidate is produced before its next revision is damaged');
  const broken = f.store.write({ id: candidate.record.id, kind: candidate.record.kind, expected: candidate.record.revision,
    value: { ...clone(candidate.record.value), graphHash: '0'.repeat(64) } });
  const direct = gateCandidate(f.store, { project: f.project, candidate: reference(broken) });
  assert.equal(direct.ok, false);
  const stored = snapshot(f.store);
  const results = [{ gap: reference(first.gap), result: reference(first.assembly.record), candidate: reference(broken) }];
  const denied = evaluate(f, m, results);
  assert.equal(denied.ok, false);
  if (!denied.ok && !direct.ok) assert.deepEqual([denied.refusal.code, denied.refusal.at], [direct.refusal.code, direct.refusal.at]);
  assert.deepEqual(snapshot(f.store), stored, 'A G3 refusal is not a saved negative G4b, evaluation or A2 source');
  assert.equal(m.work().answers?.evaluation, null);
  const assembly = first.assembly.record;
  const forged = f.store.write({ id: assembly.id, kind: assembly.kind, expected: assembly.revision,
    value: { ...clone(assembly.value), results: [...clone(assembly.value.results), reference(other.part.record)] } });
  const offered = { ...f.request, results: [{ gap: reference(first.gap), result: reference(forged), candidate: null }] };
  const common = prepareAnswersGate(f.store, offered), damaged = evaluate(f, m, [], { request: offered });
  assert.equal(common.ok, false, 'The common assembly reader refuses the forged assembly');
  if (!common.ok && !damaged.ok) assert.deepEqual(damaged.refusal, common.refusal, 'The forged assembly stays the reader refusal');
  else assert.fail('A forged assembly is never evaluated');
  assert.equal(f.store.list(ANSWERS_EVALUATION_KIND).length, 0);
});

test('2 X4 H1.0c a racing second store rolls back the whole evaluation bundle and leaves one chain', t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row2'), fact = factGap(f);
  const before = m.head();
  const mine = ok(prepareAnswersEvaluation(f.store, { project: f.project, binding: reference(m.binding),
    request: { ...f.request, results: [] } }));
  assert.ok(mine.writes.some(write => write.id === journalId(f.project)), 'The bundle carries its one journal write');
  const rival = new Store(f.path);
  let won: Ref;
  try {
    won = reference(ok(writeAnswersEvaluation(rival, { project: f.project, binding: reference(m.binding),
      request: { ...f.request, results: [{ gap: reference(fact), result: null, candidate: null }] } })).evaluation);
  } finally { rival.close(); }
  const stored = snapshot(f.store);
  const lost = writeGuarded(f.store, { unit: 'G4b', target: mine.evaluation.id, writes: [...mine.writes], guards: [...mine.guards] });
  assert.equal(lost.ok, false, 'Work, journal and evaluation guards refuse the whole prepared bundle');
  assert.deepEqual(snapshot(f.store), stored, 'No part of the losing bundle is written');
  assert.equal(m.head().revision, before.revision + 1);
  const next = ok(evaluate(f, m, []));
  assert.equal(next.repeated, false);
  assert.deepEqual(next.evaluation.value.previous, won!, 'The later evaluation follows the winner: one chain');
  assert.deepEqual(m.work().answers?.evaluation, reference(next.evaluation));
  assert.equal(f.store.list(ANSWERS_EVALUATION_KIND).length, 2);
});

test('3 17 X2 H1.0c an applicable D5 on a later M6 completes the check without A2, achievement or A3', async t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row3');
  writeFileSync(m.scenario, JSON.stringify({ steps: [{ research: { verdict: 'supported', reasons: [] }, usage: traceUsage }] }));
  const fact = await acceptedFact(f);
  const journal = f.store.get(journalId(f.project)), series = f.store.get(m.binding.value.series.id)!;
  const before = m.head();
  const saved = ok(evaluate(f, m, [{ gap: reference(fact.fact), result: reference(fact.accepted), candidate: null }],
    { routes: reference(fact.route) }));
  assert.deepEqual(saved.groups, [], 'The applicable D5 answers the whole area of the check');
  assert.deepEqual(saved.evaluation.value.gate.id.startsWith(`om-answers-gate:${f.project}:`), true);
  const gate = ok(readAnswersGate(f.store, { project: f.project, record: saved.evaluation.value.gate }));
  assert.deepEqual(gate.value.request.routes, reference(fact.route), 'The gate names the later current M6');
  assert.deepEqual(m.binding.value.plan.routes, reference(f.route), 'The binding keeps its original plan');
  assert.deepEqual(added(before, m.head()), [reference(saved.evaluation)]);
  assert.deepEqual(f.store.get(journalId(f.project)), journal, 'No A2 source or row');
  const work = m.work();
  assert.deepEqual([work.answers?.complete, work.answers?.waiting, work.answers?.existing], [true, [], []]);
  assert.equal(work.complete, false, 'The unpaid MC1 root still holds the whole work: the check is not an achievement');
  assert.deepEqual(f.store.get(m.binding.value.series.id), series, 'No A3 or series change');
});

test('4 45 H1.0c one full G4b in two bindings yields two evaluations with their own scopes and no transfer', t => {
  const f = fixture(t, 'repository-fact'), a = registered(f, 'row45-a');
  const b = managedOn(f, 'garden-consume-block', [nodeBatch(f, 'garden-consume-block').id], 1, 'row45-b');
  const first = ok(evaluate(f, a, [])), second = ok(evaluate(f, b, []));
  assert.deepEqual(first.evaluation.value.gate, second.evaluation.value.gate, 'One exact G4b Ref for both');
  assert.notEqual(first.evaluation.id, second.evaluation.id);
  assert.equal(second.evaluation.id, answersEvaluationId(f.project, reference(answersGateAssignment(b.binding)), second.evaluation.value.gate));
  const scopeOf = (saved: typeof first) => saved.evaluation.value.scope.items.map(item => item.target).sort();
  assert.deepEqual(scopeOf(first), [f.target]);
  assert.deepEqual(scopeOf(second), nodeBatch(f, 'garden-consume-block').items.map(item => item.target).sort());
  const gate = ok(readAnswersGate(f.store, { project: f.project, record: first.evaluation.value.gate }));
  const attributed = [...first.groups, ...second.groups].map(group => group.proof.id);
  assert.equal(new Set(attributed).size, attributed.length, 'No group is shared or transferred');
  assert.ok(gate.value.result.findings.length > attributed.length, 'Findings outside both scopes stay only in the full G4b');
  assert.ok(gate.value.result.findings.some(item => item.at.target === 'garden-B1'), 'garden-B1 is in no selected batch');
  for (const saved of [first, second]) for (const group of saved.groups)
    assert.deepEqual(ok(readAnswersFindingAt(f.store, f.project, group.proof)).evaluation, saved.evaluation);
});

test('5 H1.0c a missing binding, an unregistered check or a mechanism binding is refused before any record', t => {
  const f = fixture(t, 'repository-fact'), m = managedAttempt(f, 'row5');
  const stored = snapshot(f.store);
  assert.deepEqual(refused(evaluate(f, m, [])), ['answers_binding_invalid', 'registration']);
  const missing: Ref = { id: `om-completion-owner:${f.project}:${'0'.repeat(64)}`, revision: 1, hash: '0'.repeat(64) };
  assert.deepEqual(refused(evaluate(f, { binding: missing } as never, [])), ['answers_binding_invalid', 'binding']);
  assert.deepEqual(snapshot(f.store), stored);
  const shapes: [string, () => unknown][] = [
    ['store', () => prepareAnswersEvaluation({} as Store, { project: f.project, binding: reference(m.binding), request: f.request })],
    ['extra', () => writeAnswersEvaluation(f.store, { project: f.project, binding: reference(m.binding), request: f.request, close: true } as never)],
    ['project', () => writeAnswersEvaluation(f.store, { project: 'other', binding: reference(m.binding), request: f.request })],
    ['deliver', () => writeAnswersEvaluation(f.store, { project: f.project, binding: reference(m.binding), request: f.request, deliver: 'some' as never })],
    ['binding', () => prepareAnswersEvaluation(f.store, { project: f.project, binding: 'x' as never, request: f.request })],
    ['request', () => writeAnswersEvaluation(f.store, { project: f.project, binding: reference(m.binding), request: { ...f.request, extra: 1 } as never })],
    ['read evaluation', () => readAnswersEvaluationAt(f.store, f.project, null as never)],
    ['read finding', () => readAnswersFindingAt(f.store, '', missing)],
    ['read source', () => readAnswersGateRefusalAt(null as never, f.project, missing)],
    ['delivery', () => prepareAnswersDelivery(f.store, { project: f.project, evaluation: missing, group: 7 as never })],
    ['delivery key', () => writeAnswersDelivery(f.store, { project: f.project, evaluation: missing, all: true } as never)],
  ];
  for (const [name, action] of shapes) assert.throws(action, (error: unknown) => error instanceof EngineError, name);
  assert.deepEqual(snapshot(f.store), stored);
  assert.ok(ANSWERS_GATE_CODES.includes('answers_evaluation_invalid'));
});

test('Q2 H1.0c a mechanism binding is answers_evaluation_owner_unsupported for its evaluation too', t => {
  const f = fixture(t, 'repository-fact', false);
  const batch = f.route.value.batches.find(row => row.model === 'MC2' && row.task === 'input-field'
    && row.items.some(item => item.target === f.target))!;
  const owner = { kind: 'mechanism' as const, mechanism: 'M5:addressing' as const };
  const goal: AttemptGoal = { key: 'answers:mechanism', questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
    result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
  ok(openSeries(f.store, { project: f.project, owner, line: 1, scope: f.request.gaps, predecessor: null, basis: null } as never));
  const series = ok(managedOpenAttempt(f.store, { project: f.project, owner, line: 1, attempt: 1, goal,
    admission: { gaps: f.request.gaps, routes: reference(f.route), batch: batch.id },
    completion: { routes: reference(f.route), batches: [batch.id] } } as never));
  const binding = ok(readCompletionBinding(f.store, f.project, reference(series), 1))!;
  const stored = snapshot(f.store);
  for (const action of [prepareAnswersEvaluation, writeAnswersEvaluation]) {
    const denied = action(f.store, { project: f.project, binding: reference(binding), request: { ...f.request, results: [] } });
    assert.deepEqual(denied.ok ? 'accepted' : [denied.refusal.code, denied.refusal.at.field, denied.refusal.at.ref],
      ['answers_evaluation_owner_unsupported', 'owner', reference(binding)]);
  }
  assert.deepEqual(snapshot(f.store), stored, 'No gate, evaluation, A2 or work record for a mechanism');
});

test('6 7 H1.0c a standing gate enters only through full current preparation; an exact repeat is historical after heads move', t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row6'), fact = factGap(f);
  const request = { ...f.request, results: [] }, other = { ...f.request, results: [{ gap: reference(fact), result: null, candidate: null }] };
  const standalone = ok(writeAnswersGate(f.store, request)), standing = ok(writeAnswersGate(f.store, other));
  const prepared = ok(prepareAnswersEvaluation(f.store, { project: f.project, binding: reference(m.binding), request }));
  const gate = ok(prepareAnswersGate(f.store, request));
  assert.equal(prepared.writes.some(write => write.id === standalone.id), false, 'The standing gate is not rewritten');
  for (const guard of gate.guards) assert.ok(prepared.guards.some(item => same(item, guard)), 'Every current G4b guard stays in the bundle');
  const current = ok(evaluate(f, m, []));
  assert.deepEqual(current.evaluation.value.gate, reference(standalone));
  f.store.write({ id: f.input.id, kind: f.input.kind, expected: f.input.revision, value: clone(f.input.value) });
  f.restart();
  const moved = snapshot(f.store);
  assert.deepEqual(ok(readAnswersGate(f.store, { project: f.project, record: reference(standing) })), standing);
  assert.equal(refused(evaluate(f, m, other.results))[0], 'input_stale', 'A historical read of a standing gate admits no new evaluation');
  assert.equal(prepareAnswersGate(f.store, request).ok, false, 'Today the old D1 is stale');
  const repeat = ok(evaluate(f, m, []));
  assert.deepEqual([repeat.repeated, repeat.evaluation, repeat.groups], [true, current.evaluation, current.groups]);
  assert.deepEqual(snapshot(f.store), moved, 'The exact repeat reads history only, without today\'s heads');
});

test('9 H1.0c an unfinished managed MC1 is a journal-only wait for work and dispatches nothing', async t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row9'), fact = factGap(f);
  writeFileSync(m.scenario, JSON.stringify({ steps: [m.answer] }));
  const writeMany = f.store.writeMany.bind(f.store);
  let stopped = false;
  f.store.writeMany = ((writes, guards) => {
    const committed = writeMany(writes, guards);
    if (!stopped && writes.some(write => write.kind === 'model-call'
      && (write.value as { om?: { application?: string } }).om?.application === 'received')) {
      stopped = true; throw new Error('MC1 simulated stop after its durable receipt');
    }
    return committed;
  }) as Store['writeMany'];
  try {
    await assert.rejects(runModelCall(f.store, { project: f.project, packet: reference(m.packet), dispatch: m.dispatch, role: 'implementer' }),
      /simulated stop/);
  } finally { f.store.writeMany = writeMany; }
  const [call] = f.store.list('model-call');
  assert.equal(ok(readModelCallState(f.store, { project: f.project, record: reference(call!) })).state, 'received');
  const calls = f.store.list('model-call').length + f.store.list('call-record').length;
  const saved = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(call!), candidate: null }]));
  assert.deepEqual(contributions(f, reference(saved.evaluation)), [['mc1-unfinished', 'route_result_missing',
    { kind: 'journal-only', wait: 'work', barrier: true }]]);
  assert.equal(f.store.list('model-call').length + f.store.list('call-record').length, calls, 'G4b dispatches nothing');
  const work = m.work();
  assert.deepEqual(work.answers?.waiting.map(item => item.reason), ['work']);
  assert.equal(work.complete, false);
});

test('10 H1.0c MC1 fact candidates keep every child assessment mandatory', async t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row10'), fact = factGap(f);
  writeFileSync(m.scenario, JSON.stringify({ steps: [m.answer] }));
  const original = ok(await runModelCall(f.store, { project: f.project, packet: reference(m.packet), dispatch: m.dispatch, role: 'implementer' }));
  assert.equal(original.outcome?.kind, 'fact-candidates');
  const saved = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(original.record), candidate: null }]));
  assert.deepEqual(contributions(f, reference(saved.evaluation)), [['mc1-fact-candidates', 'route_result_missing',
    { kind: 'journal-only', wait: 'work', barrier: true }]]);
  const work = m.work(), facts = work.assignments.filter(row => row.value.kind === 'fact');
  assert.ok(facts.length > 0 && facts.every(row => !work.resolved.some(ref => ref.id === row.id)),
    'The finding closes no fact child and hides no missing intent');
  assert.equal(work.complete, false);
});

test('11 X3 H1.0c a supported E5 offered for its D5 is journal-only and unpaid; the later D5 evaluation supersedes it', async t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row11'), fact = factGap(f);
  const { terminal } = await managedFact(f, m, 'supported');
  const route = ok(writeRoutes(f.store, { project: f.project, gaps: f.request.gaps, tasks: f.route.value.routes.filter(row => row.task)
    .map(row => ({ record: row.task! })), catalog: { paths: [], records: [] }, previous: reference(f.route) }));
  const calls = f.store.list('model-call').length;
  const first = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(terminal), candidate: null }], { routes: reference(route) }));
  assert.deepEqual(contributions(f, reference(first.evaluation)), [['assessment-supported', 'route_result_missing',
    { kind: 'journal-only', wait: 'submission', barrier: true }]]);
  assert.equal(m.work().complete, false, 'Every physical root is resolved, and the check still waits');
  const second = ok(evaluate(f, m, [{ gap: reference(fact), result: terminal.value.accepted!, candidate: null }],
    { routes: reference(route) }));
  assert.deepEqual(second.groups, []);
  assert.deepEqual(second.evaluation.value.previous, reference(first.evaluation));
  const work = m.work();
  assert.deepEqual([work.answers?.evaluation, work.answers?.complete, work.complete], [reference(second.evaluation), true, true]);
  assert.ok(work.products.some(ref => same(ref, reference(first.evaluation))) && work.products.some(ref => same(ref, first.groups[0]!.source)),
    'The superseded evaluation and its A2 source stay in history');
  assert.equal(f.store.list('model-call').length, calls, 'No new E5 or model call is paid');
  assert.deepEqual(ok(readAnswersEvaluationAt(f.store, f.project, reference(first.evaluation))).groups.map(group => reference(group.proof)),
    first.groups.map(group => group.proof), 'The old evaluation still reads by its own work');
});

/** The paid managed assessor transport of the fixture fact, not yet applied to its E5 terminal. */
async function managedTransport(f: ReturnType<typeof fixture>, m: ReturnType<typeof managedAttempt>) {
  writeFileSync(m.scenario, JSON.stringify({ steps: [m.answer, { research: { verdict: 'insufficient', reasons: ['x'] }, usage: traceUsage }] }));
  const original = ok(await runModelCall(f.store, { project: f.project, packet: reference(m.packet), dispatch: m.dispatch, role: 'implementer' }));
  const intent = ok(writeAssessmentIntent(f.store, { project: f.project, modelCall: reference(original.record),
    questionId: m.batch.items[0]!.gap, dispatch: m.dispatch }));
  const admission = ok(readAssessmentIntentAt(f.store, f.project, reference(intent)));
  const admitted = ok(recordCall(f.store, f.project, { call: admission.call, purpose: 'fact-assessment', basis: admission.basis,
    block: admission.block, gaps: admission.gaps, series: admission.series, attempt: admission.attempt, goal: admission.goal,
    dispatch: admission.dispatch, packet: admission.packet as Json }));
  const physical = ok(await runModelTransport(f.store, { project: f.project, call: reference(admitted.call),
    packet: admission.packet as Json, role: 'reviewer' }));
  return { original, intent, transport: physical.record };
}

test('12 H1.0c a managed assessor transport waits for its application, or points at its H1.0b cessation', async t => {
  await t.test('without cessation: journal-only work', async child => {
    const f = fixture(child, 'repository-fact'), m = registered(f, 'row12'), fact = factGap(f);
    const { transport } = await managedTransport(f, m);
    const saved = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(transport), candidate: null }]));
    assert.deepEqual(contributions(f, reference(saved.evaluation)), [['assessment-transport-managed', 'route_result_missing',
      { kind: 'journal-only', wait: 'work', barrier: true }]]);
    assert.equal(f.store.list('om-assessment-result').length, 0, 'The raw transport is not applied by G4b');
  });
  await t.test('with the application ended by H1.0b: the terminal is the existing T ground', async child => {
    const f = fixture(child, 'repository-fact'), m = registered(f, 'row12-ended'), fact = factGap(f);
    const { intent, transport } = await managedTransport(f, m);
    m.configure('answers-replacement-assessor', m.config.revision);
    const terminal = ok(applyAssessmentResult(f.store, { project: f.project, intent: reference(intent), assessor: reference(transport) }));
    assert.equal(terminal.value.verdict, 'application-terminated');
    const stale = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(transport), candidate: null }]));
    assert.deepEqual(contributions(f, reference(stale.evaluation)).map(row => row[2]), [{ kind: 'journal-only', wait: 'work', barrier: true }],
      'The raw transport never becomes a result: its application ended with its own terminal');
    const saved = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(terminal), candidate: null }]));
    assert.deepEqual(contributions(f, reference(saved.evaluation)), [['assessment-terminated', 'answer_missing_for_blocking_gap',
      { kind: 'existing', producer: 'E5-T', basis: [reference(terminal)] }]]);
    assert.deepEqual([m.work().answers?.complete, m.work().technical.map(row => row.reason)], [true, ['interrupted']]);
  });
});

test('14 H1.0c E5 T, E4 T and an H1.0b root cessation stay their own grounds, never N', async t => {
  await t.test('own E5 off-form: existing E5-T', async child => {
    const f = fixture(child, 'repository-fact'), m = registered(f, 'row14-e5'), fact = factGap(f);
    const { terminal } = await managedFact(f, m, 'off-form');
    const saved = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(terminal), candidate: null }]));
    assert.deepEqual(contributions(f, reference(saved.evaluation)), [['assessment-off-form', 'answer_missing_for_blocking_gap',
      { kind: 'existing', producer: 'E5-T', basis: [reference(terminal)] }]]);
    const work = m.work();
    assert.deepEqual([work.answers?.complete, work.technical.map(row => row.reason)], [true, ['off-form']]);
    assert.equal(work.negative.length, 0, 'T is not renamed N');
  });
  await t.test('own ordinary MC1 off-form: existing E4-T', async child => {
    const f = fixture(child, 'repository-fact'), m = registered(f, 'row14-e4'), fact = factGap(f);
    writeFileSync(m.scenario, JSON.stringify({ steps: [{ research: { invalid: true }, usage: traceUsage }] }));
    const call = ok(await runModelCall(f.store, { project: f.project, packet: reference(m.packet), dispatch: m.dispatch, role: 'implementer' }));
    assert.ok(call.diagnostic);
    const saved = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(call.record), candidate: null }]));
    assert.deepEqual(contributions(f, reference(saved.evaluation)), [['mc1-technical', 'answer_missing_for_blocking_gap',
      { kind: 'existing', producer: 'E4-T', basis: [reference(call.record), call.diagnostic!] }]]);
    assert.equal(m.work().answers?.complete, true);
  });
  await t.test('root ceased by a replaced B1 before dispatch: existing cessation', async child => {
    const f = fixture(child, 'repository-fact'), m = registered(f, 'row14-root');
    const next = redrive(f, { target: 'garden-B1', field: 'nodes', value: ['garden-produce-block', 'garden-consume-block'] }, 'row14');
    const root = completionRootAssignments(m.binding)[0]!;
    const ceased = ok(writeCompletionCessation(f.store, { project: f.project, binding: reference(m.binding), assignment: reference(root) }));
    const saved = ok(evaluate(f, m, [], { request: next.request }));
    assert.deepEqual(contributions(f, reference(saved.evaluation)), [['blocking-absent', 'answer_missing_for_blocking_gap',
      { kind: 'existing', producer: 'cessation', basis: [reference(ceased)] }]]);
    const work = m.work();
    assert.deepEqual([work.answers?.complete, work.complete, work.refusals], [true, true, []], 'Answer-missing does not turn T into refused');
  });
});

/** One D3 decision applied to the current B1 and the whole D1/M6 derived again from that input. */
function redrive(f: ReturnType<typeof fixture>, decision: { target: string; field: string; value: Json }, choice: string) {
  const head = f.store.get(f.input.id)!;
  const input = ok(writeAddressing(f.store, { project: f.project, input: reference(head), graph: reference(f.graph),
    decisions: [{ pending: clone(inputDecisionWrite({ project: f.project, input: reference(head), graph: reference(f.graph), layers: [],
      decision: decision as never })) as Write }] }));
  const horizon = ok(writeHorizon(f.store, { project: f.project, input: reference(input), graph: reference(f.graph), refinement: null,
    available: {}, choice: { choiceVersion: `answers-gate-${choice}`, features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const old = f.request.gaps.sources;
  const sources: GapRequest = { ...clone(old) as GapRequest, input: reference(input), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { ...clone(old.operations.frame) as GapRequest['operations']['frame'], horizon: reference(horizon.gate) } } };
  const gaps = ok(writeGaps(f.store, sources));
  const gapRead: GapReadRequest = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const fact = gaps.records.find(row => row.value.gap.target === f.target && row.value.gap.kind === 'repository-fact');
  const task = fact ? ok(prepareAnswerTask(f.store, { project: f.project, input: reference(input), gaps: gapRead,
    gap: reference(fact), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) : null;
  const route = ok(writeRoutes(f.store, { project: f.project, gaps: gapRead, catalog: { paths: [], records: [] }, previous: null,
    tasks: task ? [task.writes.length ? { pending: clone(task.writes[0]!) as Write } : { record: reference(task.record) }] : [] }));
  const request: AnswersGateRequest = { project: f.project, gaps: gapRead, routes: reference(route), results: [] };
  return { input, gaps, route, request };
}
/** A view in which each planted revision stands at its own id; every other read goes to the real Store. */
function plantedView(store: Store, ...planted: Revision<unknown>[]): Store {
  return new Proxy(store, { get(target, property) {
    if (property === 'get') return (key: string, revision?: number) => planted.find(item => item.id === key
      && (revision === undefined || revision === item.revision)) ?? target.get(key, revision);
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
}
const reHashed = <T>(record: Revision<T>, value: T): Revision<T> => ({ ...record, value, hash: hashJson(value as unknown as Json) });

test('15 H1.0c another attempt\'s N explains the gap but is journal-only for this attempt', async t => {
  const f = fixture(t, 'repository-fact'), foreign = await assessedFact(f, 'insufficient'), m = managedAfter(f, 'row15', false);
  const saved = ok(evaluate(f, m, [{ gap: reference(factGap(f)), result: reference(foreign.terminal), candidate: null }]));
  assert.deepEqual(contributions(f, reference(saved.evaluation)), [['assessment-insufficient', 'answer_missing_for_blocking_gap',
    { kind: 'journal-only', wait: 'submission', barrier: true }]], 'No N or T of another attempt is carried over');
  assert.deepEqual([m.work().negative, m.work().refusals], [[], []]);
});

test('16 H1.0c a legacy E5.0 transport of an earlier attempt stays journal-only', async t => {
  const f = fixture(t, 'repository-fact'), legacy = await legacyTransport(f, 'row16'), m = managedAfter(f, 'row16');
  const saved = ok(evaluate(f, m, [{ gap: reference(legacy.fact), result: reference(legacy.transport), candidate: null }]));
  assert.deepEqual(contributions(f, reference(saved.evaluation)), [['assessment-legacy-transport', 'answer_missing_for_blocking_gap',
    { kind: 'journal-only', wait: 'submission', barrier: true }]]);
  assert.equal(f.store.list('om-assessment-intent').length, 0, 'No intent is made after the fact');
});

test('18 19 H1.0c an inapplicable D5 or a D3 decision offered as an answer keeps its addressed journal-only finding', async t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row18'), fact = factGap(f);
  writeFileSync(m.scenario, JSON.stringify({ steps: [{ research: { verdict: 'supported', reasons: [] }, usage: traceUsage }] }));
  const prior = await acceptedFact(f);
  const task = ok(prepareAnswerTask(f.store, { project: f.project, input: reference(f.input), gaps: f.request.gaps,
    gap: reference(prior.fact), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string', minLength: 1 } }));
  const route = ok(writeRoutes(f.store, { project: f.project, gaps: f.request.gaps,
    tasks: [task.writes.length ? { pending: clone(task.writes[0]!) as Write } : { record: reference(task.record) }],
    catalog: { paths: [], records: [] }, previous: reference(prior.route) }));
  const stale = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(prior.accepted), candidate: null }], { routes: reference(route) }));
  const [emission, code, contribution] = (contributions(f, reference(stale.evaluation)) as [string, string, unknown][])[0]!;
  assert.ok(['answer-outside-search', 'answer-inapplicable'].includes(emission!));
  assert.deepEqual([code, contribution], ['answer_version_stale', { kind: 'journal-only', wait: 'submission', barrier: true }]);
  const decision = f.store.write(inputDecisionWrite({ project: f.project, input: reference(f.input), graph: reference(f.graph), layers: [],
    decision: { target: 'garden-B1', field: 'nodes', value: ['garden-produce-block', 'garden-consume-block'] } }));
  const offered = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(decision), candidate: null }], { routes: reference(route) }));
  const [kind, , journalOnly] = (contributions(f, reference(offered.evaluation)) as [string, string, unknown][])[0]!;
  assert.ok(['decision-unapplied', 'decision-foreign'].includes(kind!));
  assert.deepEqual(journalOnly, { kind: 'journal-only', wait: 'submission', barrier: true }, 'A D3 decision is no semantic N');
});

test('20 26 27 H1.0c after D3 the vanished gap needs no answer; an old submission is attributed only through a plan record', t => {
  const f = fixture(t, 'repository-fact'), batch = fieldBatch(f, 'garden-B1', 'nodes');
  const m = managedOn(f, 'garden-consume-block', [batch.id], 1, 'row20');
  const planned = f.gaps.records.find(row => row.value.gap.target === 'garden-B1' && row.value.gap.field === 'nodes')!;
  const foreign: Ref = { id: `${planned.id.slice(0, planned.id.lastIndexOf(':'))}:${'f'.repeat(64)}`, revision: 1, hash: 'f'.repeat(64) };
  const next = redrive(f, { target: 'garden-B1', field: 'nodes', value: ['garden-produce-block', 'garden-consume-block'] }, 'row20');
  assert.equal(next.gaps.records.some(row => row.value.gap.target === 'garden-B1' && row.value.gap.field === 'nodes'), false);
  const old = { gap: reference(planned), result: null, candidate: null };
  const saved = ok(evaluate(f, m, [], { request: { ...next.request, results: [old, old,
    { gap: foreign, result: null, candidate: null }] } }));
  assert.deepEqual(saved.evaluation.value.scope.items, [], 'The vanished gap is no longer an obligation');
  assert.deepEqual(saved.evaluation.value.scope.absent.map(item => item.record), [reference(planned)]);
  const read = ok(readAnswersEvaluationAt(f.store, f.project, reference(saved.evaluation)));
  assert.deepEqual(read.gate.value.result.codes.includes('answer_gap_unknown'), true);
  assert.deepEqual(read.groups.map(group => [group.proof.value.scope, group.proof.value.occurrences.length, group.proof.value.contribution]),
    [[{ kind: 'submission', gap: reference(planned) }, 2, { kind: 'journal-only', wait: 'submission', barrier: false }]],
    'Both identical occurrences form one group; the foreign old record is not attributed');
  assert.deepEqual([m.work().answers?.complete, m.work().answers?.waiting], [true, []]);
});

test('21 22 C57 H1.0c a part, a candidate without result, an assembly without candidate or a known foreign record is journal-only', t => {
  const f = fixture(t), { first, other, m } = managedDesign(f);
  const candidate = ok(writeCandidate(f.store, { frame: f.request.gaps.sources.operations.frame,
    proposals: [reference(first.assembly.proposal), reference(other.assembly.proposal)] }));
  if (candidate.state !== 'candidate') assert.fail('A real candidate');
  const cases: [AnswerRouteResult, string, string, string][] = [
    [{ gap: reference(first.gap), result: reference(first.part.record), candidate: null }, 'part-not-assembly', 'route_result_missing', 'work'],
    [{ gap: reference(first.gap), result: null, candidate: reference(candidate.record) }, 'candidate-without-result', 'route_result_missing', 'submission'],
    [{ gap: reference(first.gap), result: reference(first.assembly.record), candidate: null }, 'candidate-absent', 'delta_not_verified', 'work'],
    [{ gap: reference(first.gap), result: reference(f.route), candidate: null }, 'design-known-foreign', 'record_foreign', 'submission'],
  ];
  let previous: Ref | null = null;
  for (const [row, emission, code, wait] of cases) {
    const saved = ok(evaluate(f, m, [row]));
    const own = contributions(f, reference(saved.evaluation)).filter(item => item[0] === emission);
    assert.deepEqual(own, [[emission, code, { kind: 'journal-only', wait, barrier: true }]], emission);
    assert.deepEqual(saved.evaluation.value.previous, previous);
    previous = reference(saved.evaluation);
  }
  assert.equal(m.work().complete, false);
});

test('23 H1.0c a candidate of another proposal is journal-only delta_stale', t => {
  const f = fixture(t), { first, other, replacement, m } = managedDesign(f, true);
  const candidate = ok(writeCandidate(f.store, { frame: f.request.gaps.sources.operations.frame,
    proposals: [reference(replacement!.assembly.proposal), reference(other.assembly.proposal)] }));
  if (candidate.state !== 'candidate') assert.fail('The replacement forms a complete real candidate');
  const saved = ok(evaluate(f, m, [{ gap: reference(first.gap), result: reference(first.assembly.record), candidate: reference(candidate.record) }]));
  assert.deepEqual(contributions(f, reference(saved.evaluation)).filter(item => item[0] === 'candidate-stale'),
    [['candidate-stale', 'delta_stale', { kind: 'journal-only', wait: 'submission', barrier: true }]]);
});

test('26 28 X3 H1.0c duplicates form one group; deferral, candidate and unrecognized results keep their true cause', t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row26'), fact = factGap(f);
  const row = { gap: reference(fact), result: null, candidate: null };
  const duplicate = ok(evaluate(f, m, [row, row]));
  const read = ok(readAnswersEvaluationAt(f.store, f.project, reference(duplicate.evaluation)));
  assert.deepEqual(read.groups.map(group => [group.proof.value.cause.emission, group.proof.value.cause.occurrences.length]),
    [['duplicate', 2]], 'One group keeps every occurrence; no winner is chosen');
  const cases: [AnswerRouteResult, string, string][] = [
    [{ ...row, deferral: { reason: 'outside_horizon', until: 'horizon-entry' } }, 'deferral-declared', 'deferral_not_permitted'],
    [{ gap: reference(fact), result: { id: `om-assessment-result:${f.project}:${'1'.repeat(64)}`, revision: 1, hash: '1'.repeat(64) },
      candidate: reference(f.route) }, 'fact-candidate', 'answer_route_foreign'],
    [{ gap: reference(fact), result: unknownResult(f), candidate: null }, 'offered-unrecognized', 'route_result_unsupported'],
  ];
  let previous = reference(duplicate.evaluation);
  for (const [offered, emission, code] of cases) {
    const saved = ok(evaluate(f, m, [offered]));
    assert.deepEqual(contributions(f, reference(saved.evaluation)), [[emission, code, { kind: 'journal-only', wait: 'submission', barrier: true }]]);
    assert.deepEqual(saved.evaluation.value.previous, previous, 'Each later evaluation supersedes the previous one without deleting it');
    previous = reference(saved.evaluation);
  }
  assert.equal(m.work().products.filter(ref => ref.id.startsWith(`om-answers-gate:${f.project}:evaluation:`)).length, 4);
});

test('29 30 H1.0c a non-blocking gap outside the area creates nothing, and its bad result stays only in the full G4b', t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row29'), fact = factGap(f);
  const inventory = f.gaps.records.find(row => row.value.gap.code === 'inventory_missing')!;
  assert.equal(inventory.value.gap.blocking, false);
  const quiet = ok(evaluate(f, m, [{ gap: reference(fact), result: null, candidate: null }]));
  const gate = ok(readAnswersGate(f.store, { project: f.project, record: quiet.evaluation.value.gate }));
  assert.equal(gate.value.result.findings.some(item => item.at.target === inventory.value.gap.target), false);
  const bad = ok(evaluate(f, m, [{ gap: reference(fact), result: null, candidate: null },
    { gap: reference(inventory), result: reference(f.route), candidate: null }]));
  const full = ok(readAnswersGate(f.store, { project: f.project, record: bad.evaluation.value.gate }));
  assert.ok(full.value.result.findings.some(item => item.at.target === inventory.value.gap.target), 'The D6 finding is kept and checked');
  assert.deepEqual(contributions(f, reference(bad.evaluation)).map(item => item[0]), ['blocking-null'],
    'The non-blocking gap is not made blocking and not attributed');
});

test('31 H1.0c owner_result_unavailable is never attributed and never awaiting-owner', t => {
  const f = fixture(t, 'owner-decision'), m = managedOn(f, f.block, [nodeBatch(f, f.block).id], 1, 'row31');
  const owner = f.blocking.find(row => row.value.gap.kind === 'owner-decision')!;
  assert.ok(owner.value.gap.consumers.includes(f.block), 'The owner gap shares the consumer block; that is not enough');
  const saved = ok(evaluate(f, m, []));
  const gate = ok(readAnswersGate(f.store, { project: f.project, record: saved.evaluation.value.gate }));
  assert.ok(gate.value.result.codes.includes('owner_result_unavailable'), 'The full G4b keeps the owner finding and stays negative');
  assert.equal(contributions(f, reference(saved.evaluation)).some(item => item[1] === 'owner_result_unavailable'), false);
  const work = m.work();
  assert.deepEqual(work.waiting, [], 'No awaiting-owner is made');
  assert.equal(work.answers?.waiting.some(item => item.reason === 'producer'), false);
  assert.equal(f.store.list().some(row => row.id.startsWith(`om-owner-result:${f.project}:`)), false);
});

test('32 H1.0c an unsupported predecessor question waits for its producer', t => {
  const f = fixture(t, 'design-decision'), m = managedOn(f, f.block, [fieldBatch(f, f.target, 'answer').id], 1, 'row32');
  const absent = ok(evaluate(f, m, []));
  assert.deepEqual(contributions(f, reference(absent.evaluation)), [['unsupported-absent', 'route_result_unsupported',
    { kind: 'journal-only', wait: 'producer', barrier: true }]]);
  const gap = f.blocking.find(row => row.value.gap.target === f.target)!;
  const offered = ok(evaluate(f, m, [{ gap: reference(gap), result: unknownResult(f), candidate: null }]));
  assert.deepEqual(contributions(f, reference(offered.evaluation)), [['unsupported-offered', 'route_result_unsupported',
    { kind: 'journal-only', wait: 'producer', barrier: true }]]);
  assert.deepEqual(m.work().answers?.waiting.map(item => [item.reason, item.code]), [['producer', 'route_result_unsupported']]);
  assert.equal(offered.evaluation.value.scope.items[0]!.kind, 'design-decision', 'The kind is not changed to fit a producer');
});

test('34 35 44 H1.0c an undelivered evaluation is delivered by the same addresses in one bundle; repeats add nothing', t => {
  const f = fixture(t, 'repository-fact'), batch = nodeBatch(f, 'garden-consume-block');
  const m = managedOn(f, 'garden-consume-block', [batch.id], 1, 'row34');
  const before = m.head();
  const saved = ok(evaluate(f, m, [], { deliver: 'none' }));
  assert.equal(saved.groups.length, 2);
  assert.deepEqual(added(before, m.head()), [reference(saved.evaluation)], 'Only the evaluation enters the work');
  for (const group of saved.groups) assert.equal(f.store.get(group.proof.id) ?? f.store.get(group.source.id), null);
  assert.equal(f.store.get(journalId(f.project)), null);
  assert.deepEqual(m.work().answers?.waiting.map(item => item.ref), saved.groups.map(group => group.proof),
    'The undelivered groups still hold the check by their derived proof addresses');
  const [one, two] = saved.groups;
  const partial = ok(prepareAnswersDelivery(f.store, { project: f.project, evaluation: reference(saved.evaluation), group: one!.proof.id }));
  assert.deepEqual(partial.writes.map(write => write.id), [one!.proof.id, one!.source.id, journalId(f.project), m.head().id],
    'The same derived addresses, the batch copy of the source, one journal write and one work transition');
  const calls = f.store.list('model-call').length, first = m.head();
  ok(writeAnswersDelivery(f.store, { project: f.project, evaluation: reference(saved.evaluation), group: one!.proof.id }));
  assert.deepEqual(added(first, m.head()), [one!.source]);
  assert.equal(m.work().answers?.complete, false, 'A partial delivery is no completeness');
  const rows = () => ok(readJournal(f.store, { project: f.project })).value.rows.map(row => row.source);
  assert.deepEqual(rows(), [one!.source]);
  const repeat = ok(prepareAnswersDelivery(f.store, { project: f.project, evaluation: reference(saved.evaluation), group: one!.proof.id }));
  assert.deepEqual([repeat.writes, repeat.guards], [[], []], 'A delivered group repeats without a second row');
  const read = ok(readAnswersEvaluationAt(f.store, f.project, reference(saved.evaluation))).groups[1]!;
  const bare = snapshot(f.store);
  const view = plantedView(f.store, read.proof, read.source);
  const unjournalled = prepareCompletionProducts(view, reference(m.binding), [two!.source]);
  assert.deepEqual(refused(unjournalled), ['completion_invalid', 'journal'], 'A G4b source enters work only with its A2 row');
  assert.deepEqual(snapshot(f.store), bare);
  ok(writeAnswersDelivery(f.store, { project: f.project, evaluation: reference(saved.evaluation) }));
  assert.deepEqual(rows(), [one!.source, two!.source]);
  f.restart();
  const settled = snapshot(f.store);
  for (const group of [one!.proof.id, two!.proof.id, undefined]) {
    const again = ok(writeAnswersDelivery(f.store, { project: f.project, evaluation: reference(saved.evaluation), ...(group ? { group } : {}) }));
    assert.deepEqual(again.groups.map(item => item.source),
      (group ? saved.groups.filter(item => item.proof.id === group) : saved.groups).map(item => item.source));
  }
  assert.deepEqual(snapshot(f.store), settled, 'Group repeats read history only');
  assert.equal(f.store.list('model-call').length, calls, 'Delivery pays no model');
  assert.deepEqual(refused(prepareAnswersDelivery(f.store, { project: f.project, evaluation: reference(saved.evaluation),
    group: `om-answers-gate:${f.project}:finding:${'0'.repeat(64)}` })), ['answers_evaluation_invalid', 'group']);
  const gapOf = (index: number) => reference(f.gaps.records.find(row => row.value.gap.target === batch.items[index]!.target)!);
  const later = ok(evaluate(f, m, [{ gap: gapOf(0), result: null, candidate: null }], { deliver: 'none' }));
  const latest = ok(evaluate(f, m, [{ gap: gapOf(1), result: null, candidate: null }], { deliver: 'none' }));
  assert.deepEqual(latest.evaluation.value.previous, reference(later.evaluation));
  assert.equal(ok(prepareAnswersDelivery(f.store, { project: f.project, evaluation: reference(saved.evaluation) })).writes.length, 0,
    'A delivered superseded group still repeats');
  assert.deepEqual(refused(prepareAnswersDelivery(f.store, { project: f.project, evaluation: reference(later.evaluation) })),
    ['completion_conflict', 'evaluation'], 'Only the latest evaluation is delivered');
  assert.equal(ok(prepareAnswersDelivery(f.store, { project: f.project, evaluation: reference(latest.evaluation) })).writes.length > 0, true);
});

test('X1 H1.0c two selected batches register one check of the whole goal', t => {
  const f = fixture(t, 'repository-fact'), m = managedOn(f, f.block, [mc1Batch(f).id, nodeBatch(f, f.block).id], 1, 'x1');
  const work = m.work();
  assert.equal(work.work.value.assignments.filter(ref => ref.id === answersGateAssignment(m.binding).id).length, 1);
  assert.equal(completionRootAssignments(m.binding).length, 2);
  const saved = ok(evaluate(f, m, []));
  assert.deepEqual(saved.evaluation.value.scope.items.map(item => item.target).sort(),
    [f.target, ...nodeBatch(f, f.block).items.map(item => item.target)].sort());
  assert.deepEqual(contributions(f, reference(saved.evaluation)).map(item => item[0]), ['blocking-absent', 'blocking-absent', 'blocking-absent']);
});

test('Q3 H1.0c exact repeat, unresolved, resolved and closed evaluations follow one table', async t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'q3'), fact = factGap(f);
  const { terminal } = await managedFact(f, m, 'insufficient');
  const waiting = ok(evaluate(f, m, []));
  assert.equal(m.work().answers?.complete, false);
  const resolved = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(terminal), candidate: null }]));
  assert.deepEqual([resolved.evaluation.value.previous, m.work().answers?.complete], [reference(waiting.evaluation), true]);
  const stored = snapshot(f.store);
  const repeat = ok(evaluate(f, m, []));
  assert.deepEqual([repeat.repeated, repeat.evaluation], [true, waiting.evaluation]);
  assert.deepEqual(m.work().answers?.evaluation, reference(resolved.evaluation), 'A repeat does not make an old evaluation the latest');
  assert.deepEqual(refused(evaluate(f, m, [{ gap: reference(fact), result: null, candidate: null }])), ['completion_resolved', 'assignment']);
  assert.deepEqual(snapshot(f.store), stored, 'Resolved: no product, completeness or result changes');
  const work = m.work();
  assert.equal(work.complete, true);
  ok(closeAttempt(f.store, { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: { reason: 'refused', accepting: [], cancelling: [], refusals: work.refusals } }));
  assert.ok(m.head().value.closed, 'The complete check lets the direct G7 close the work');
  const history = snapshot(f.store);
  assert.deepEqual(refused(evaluate(f, m, [{ gap: reference(fact), result: null, candidate: null },
    { gap: reference(fact), result: null, candidate: null }])), ['completion_closed', 'work']);
  const again = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(terminal), candidate: null }]));
  assert.deepEqual([again.repeated, again.evaluation], [true, resolved.evaluation], 'Closed: the exact repeat is historical');
  const group = ok(writeAnswersDelivery(f.store, { project: f.project, evaluation: reference(resolved.evaluation) }));
  assert.equal(group.groups.length, 1);
  assert.deepEqual(snapshot(f.store), history, '44: a group repeat after close reads history only');
});

test('37 H1.0c a G4b row cannot be classified', t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'row37');
  const saved = ok(evaluate(f, m, []));
  const row = ok(readJournal(f.store, { project: f.project })).value.rows.find(item => same(item.source, saved.groups[0]!.source))!;
  const stored = snapshot(f.store);
  for (const decision of [{ class: 'proposal', addressee: `node:${f.target}` }, { class: 'unknown', addressee: 'origin' }]) {
    const denied = classifyRefusal(f.store, { project: f.project, row: row.id, ...decision,
      basis: [{ role: 'answers-finding', ref: saved.groups[0]!.proof }] });
    assert.deepEqual(refused(denied), ['classification_invalid', 'row'], decision.class);
  }
  assert.deepEqual(snapshot(f.store), stored);
  f.restart();
  assert.deepEqual(ok(readJournalAt(f.store, f.project, reference(f.store.get(journalId(f.project))!))).value.classifications, []);
});

// ---------------------------------------------------------------------------
// S4: G7 over the rows of the check (repeat-gate). These live beside the managed fixtures of this file: the repeat-gate
// suite has no registered-check fixture, and test helpers cannot be shared between suites (test/om-fixture.ts is
// outside the paths of H1.0c).
import { confirmResults } from '../src/om/achievements.js';
import { callLedgerId } from '../src/om/call-record.js';
import { pendingCallStore, readCompletionEffectiveAt } from '../src/om/model-call.js';
import { checkManagedCompletionClaims, prepareCloseAttempt,
  readCompletionCloseAt, ORIGIN_HOLD_KIND } from '../src/om/repeat-gate.js';
import type { ClaimedRefusal, RepairSeries } from '../src/om/series.js';

/** The A2 row of one delivered G4b source, named exactly as a close would claim it. */
function claimOf(f: { store: Store; project: string }, source: Ref): ClaimedRefusal {
  const row = ok(readJournal(f.store, { project: f.project })).value.rows.find(item => same(item.source, source));
  if (!row) assert.fail('A delivered G4b source keeps its A2 row');
  return { row: row.id, name: row.code, goal: row.goal };
}
type Reason = 'result' | 'refused' | 'off-form' | 'interrupted' | 'awaiting-owner';
const closeWith = (f: ReturnType<typeof fixture>, reason: Reason, refusals: readonly ClaimedRefusal[], accepting: Ref[] = [],
  close: typeof closeAttempt = closeAttempt) =>
  close(f.store, { project: f.project, block: f.block, line: 1, attempt: 1,
    outcome: { reason, accepting, cancelling: [], refusals: [...refusals] } });
const outcomeOf = (f: ReturnType<typeof fixture>, m: { binding: Revision<{ series: Ref }> }) =>
  f.store.get<RepairSeries>(m.binding.value.series.id)!.value.attempts[0]!.outcome!;
const refusedAt = (result: OmResult<unknown>) => result.ok ? 'accepted'
  : [result.refusal.code, result.refusal.at.field, result.refusal.at.ref ?? null];
/** The D5 supplier asked directly, with the exact pre-close registry a direct close would hand it (S5: one close form). */
function supplierOf(f: ReturnType<typeof fixture>, m: ReturnType<typeof registered>, accepting: Ref[],
  refusals: readonly ClaimedRefusal[], closure: Record<string, unknown> = {}) {
  const series = f.store.get(m.binding.value.series.id)!, journal = f.store.get(journalId(f.project));
  return confirmResults(f.store, { project: f.project, block: f.block, target: series.id, goal: m.binding.value.goal,
    attempt: { series: reference(series), ordinal: 1 }, accepting, cancelling: [], refusals: [...refusals],
    managedClosure: { binding: reference(m.binding), work: reference(m.head()), additions: [],
      journal: journal ? reference(journal) : null, ...closure } as never });
}
const laterRoute = (f: ReturnType<typeof fixture>) => ok(writeRoutes(f.store, { project: f.project, gaps: f.request.gaps,
  tasks: f.route.value.routes.filter(row => row.task).map(row => ({ record: row.task! })), catalog: { paths: [], records: [] },
  previous: reference(f.route) }));

test('C22 H1.0c a non-managed close claiming a real G4b row is origin_unreadable, without unknown, class or hold', t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'c22');
  const saved = ok(evaluate(f, m, [])), source = saved.groups[0]!.source, g4b = claimOf(f, source);
  const block = 'garden-consume-block';
  ok(openSeries(f.store, { project: f.project, block, line: 1, slice: 'answers:c22-plain', predecessor: null, basis: null }));
  ok(beginAttempt(f.store, { project: f.project, block, line: 1, attempt: 1, goal: { ...m.binding.value.goal, key: 'answers:c22-plain' } }));
  const request = { project: f.project, block, line: 1, attempt: 1,
    outcome: { reason: 'refused' as const, accepting: [], cancelling: [], refusals: [g4b] } };
  const stored = snapshot(f.store);
  for (const close of [prepareCloseAttempt, closeAttempt])
    assert.deepEqual(refusedAt(close(f.store, request)), ['origin_unreadable', 'outcome.refusals.0.origin.completion', source]);
  assert.deepEqual(snapshot(f.store), stored, 'No class, no hold, no A2 change and no A3');
  assert.equal(f.store.list(ORIGIN_HOLD_KIND).length, 0);
  f.restart();
  assert.deepEqual(refusedAt(closeAttempt(f.store, request)), ['origin_unreadable', 'outcome.refusals.0.origin.completion', source]);
  assert.ok(ok(readAnswersGate(f.store, { project: f.project, record: saved.evaluation.value.gate })), 'The standalone G4b stays lawful');
});

test('13 36 H1.0c own E5 N closes as one N; its existing G4b row claimed as counted is completion_refusal_uncounted', async t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'rg13'), fact = factGap(f);
  const { terminal } = await managedFact(f, m, 'insufficient');
  const saved = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(terminal), candidate: null }]));
  assert.equal(saved.groups[0]!.contribution.kind, 'existing');
  const source = saved.groups[0]!.source, g4b = claimOf(f, source), work = m.work();
  assert.deepEqual([work.complete, work.refusals.length], [true, 1], 'The canonical E5 row is the one required refusal');
  assert.notEqual(work.refusals[0]!.row, g4b.row);
  const stored = snapshot(f.store);
  for (const refusals of [[...work.refusals, g4b], [g4b]])
    assert.deepEqual(refusedAt(closeWith(f, 'refused', refusals)), ['completion_refusal_uncounted', 'refusals', source]);
  assert.deepEqual(refusedAt(closeWith(f, 'refused', [])), ['completion_invalid', 'refusals', null],
    '36: the canonical ground of an existing contribution is never skipped');
  assert.deepEqual(snapshot(f.store), stored, 'No close, class, hold or A3');
  const closed = ok(closeWith(f, 'refused', work.refusals));
  assert.deepEqual(closed.routed.map(item => [item.row, item.class]), [[work.refusals[0]!.row, 'proposal']], 'One N, from E5');
  assert.deepEqual(ok(readJournal(f.store, { project: f.project })).value.classifications.map(item => item.row),
    [work.refusals[0]!.row], 'The G4b row stays an unclassified observation');
  assert.equal(f.store.list(ORIGIN_HOLD_KIND).length, 0);
  const history = snapshot(f.store);
  f.restart();
  assert.deepEqual(ok(closeWith(f, 'refused', work.refusals)).routed, closed.routed, 'The exact repeat is historical');
  assert.deepEqual(snapshot(f.store), history);
});

test('37 C63 H1.0c a journal-only G4b row claimed as counted is refused alike by direct G7 and by the D5 supplier, with additions too', async t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'rg37'), fact = factGap(f);
  const other = managedOn(f, 'garden-consume-block', [nodeBatch(f, 'garden-consume-block').id], 1, 'rg37-other');
  const terminal = await supportedManaged(f, m), accepted = terminal.value.accepted!, route = laterRoute(f);
  const waiting = ok(evaluate(f, m, [], { routes: reference(route) }));
  assert.deepEqual(waiting.groups.map(group => group.contribution), [{ kind: 'journal-only', wait: 'submission', barrier: true }]);
  const source = waiting.groups[0]!.source, g4b = claimOf(f, source), before = m.head();
  // C63 with additions: the next evaluation is prepared, not written; its records stand only in the pending view.
  const next = ok(prepareAnswersEvaluation(f.store, { project: f.project, binding: reference(m.binding),
    request: { ...f.request, routes: reference(route), results: [{ gap: reference(fact), result: accepted, candidate: null }] } }));
  assert.deepEqual(next.groups, []);
  const view = pendingCallStore(f.store, next.writes.filter(write => write.id !== before.id));
  const journal = reference(f.store.get(journalId(f.project))!);
  const effective = { binding: reference(m.binding), work: reference(before), additions: [reference(next.evaluation)], journal };
  assert.deepEqual(refusedAt(checkManagedCompletionClaims(view, f.project, { ...effective, additions: [] },
    [accepted], [])), ['completion_incomplete', 'work', null], 'Without its additions the check still waits');
  const snap = ok(checkManagedCompletionClaims(view, f.project, effective, [accepted], []));
  assert.deepEqual([snap.complete, snap.answers?.evaluation, reference(snap.work), snap.guards[0]],
    [true, reference(next.evaluation), reference(before), reference(before)], 'S5: the snapshot names only the real work it stands on');
  assert.deepEqual(snap, ok(readCompletionEffectiveAt(view, f.project, { work: reference(before), additions: [reference(next.evaluation)], journal })));
  assert.deepEqual(refusedAt(checkManagedCompletionClaims(view, f.project, effective, [accepted], [g4b])),
    ['completion_refusal_uncounted', 'refusals', source]);
  assert.deepEqual(refusedAt(checkManagedCompletionClaims(view, f.project, { ...effective, additions: [reference(next.evaluation), reference(next.evaluation)] },
    [accepted], [])), ['completion_invalid', 'additions', null]);
  assert.throws(() => checkManagedCompletionClaims(view, f.project, { binding: reference(m.binding), work: reference(before),
    additions: [] } as never, [accepted], []), (error: unknown) => error instanceof EngineError && error.code === 'repeat_request_invalid',
  'Additions come with their final journal');
  // The evaluation is written; direct G7 and the D5 supplier then refuse the same claim over the same work.
  ok(evaluate(f, m, [{ gap: reference(fact), result: accepted, candidate: null }], { routes: reference(route) }));
  assert.equal(m.work().complete, true);
  // C24: a real G4b row of another binding, which only the journal of the close names, is refused the same way.
  const foreign = ok(evaluate(f, other, [], { routes: reference(route) })).groups[0]!.source, alien = claimOf(f, foreign);
  assert.ok(!ok(readJournalAt(f.store, f.project, m.head().value.journal!)).value.rows.some(row => row.id === alien.row));
  const stored = snapshot(f.store), head = { journal: reference(f.store.get(journalId(f.project))!) }, cut = { journal: m.head().value.journal };
  assert.deepEqual(refusedAt(closeWith(f, 'result', [g4b], [accepted])), ['completion_refusal_uncounted', 'refusals', source]);
  assert.deepEqual(refusedAt(closeWith(f, 'result', [alien], [accepted])), ['completion_refusal_uncounted', 'refusals', foreign]);
  for (const [closure, row] of [[cut, g4b], [head, g4b], [head, alien]] as const) {
    const supplied = supplierOf(f, m, [accepted], [row], closure);
    assert.equal(supplied.ok ? 'accepted' : supplied.refusal.code, 'achievement_unconfirmed');
    if (!supplied.ok) assert.match(supplied.refusal.message, /^completion_refusal_uncounted:/);
  }
  assert.equal(ok(supplierOf(f, m, [accepted], [])).achieved.length, 1, 'Without the masquerade the supplier confirms the D5');
  assert.deepEqual(snapshot(f.store), stored);
  const closed = ok(closeWith(f, 'result', [], [accepted]));
  assert.deepEqual([closed.routed, outcomeOf(f, m).reason], [[], 'result']);
});

test('33 H1.0c only journal-only causes close with no reason, directly or through the D5 supplier', async t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'rg33');
  const terminal = await supportedManaged(f, m), accepted = terminal.value.accepted!;
  const waiting = ok(evaluate(f, m, [], { routes: reference(laterRoute(f)) }));
  const g4b = claimOf(f, waiting.groups[0]!.source), work = m.work();
  assert.ok(completionRootAssignments(m.binding).every(root => work.resolved.some(ref => ref.id === root.id)),
    'Every physical root is resolved: only the journal-only barrier of the check remains');
  assert.deepEqual([work.complete, work.answers?.complete, work.refusals], [false, false, []]);
  const stored = snapshot(f.store);
  for (const reason of ['result', 'refused', 'off-form', 'interrupted', 'awaiting-owner'] as const)
    for (const refusals of [[], [g4b]]) {
      const held = closeWith(f, reason, refusals, reason === 'result' ? [accepted] : []);
      assert.deepEqual(refusedAt(held), ['completion_incomplete', 'work', null], `${reason} with ${refusals.length} rows`);
    }
  const supplied = supplierOf(f, m, [accepted], []);
  assert.equal(supplied.ok ? 'accepted' : supplied.refusal.code, 'achievement_unconfirmed');
  if (!supplied.ok) assert.match(supplied.refusal.message, /^completion_incomplete:/);
  f.restart();
  assert.deepEqual(refusedAt(closeWith(f, 'result', [], [accepted])), ['completion_incomplete', 'work', null]);
  assert.deepEqual(snapshot(f.store), stored, 'Nothing closes, pays or counts');
});

test('14 X10 H1.0c T and an H1.0b cessation keep their own reason; a never-dispatched composition closes with ledger null', async t => {
  await t.test('own E5 off-form: off-form, never refused', async child => {
    const f = fixture(child, 'repository-fact'), m = registered(f, 'rg14-e5'), fact = factGap(f);
    const { terminal } = await managedFact(f, m, 'off-form');
    const saved = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(terminal), candidate: null }]));
    const source = saved.groups[0]!.source, g4b = claimOf(f, source);
    assert.deepEqual(m.work().refusals, [], 'T has no counted row');
    assert.deepEqual(refusedAt(closeWith(f, 'refused', [])), ['completion_reason_invalid', 'reason', null]);
    assert.deepEqual(refusedAt(closeWith(f, 'off-form', [g4b])), ['completion_refusal_uncounted', 'refusals', source]);
    ok(closeWith(f, 'off-form', []));
    assert.equal(outcomeOf(f, m).reason, 'off-form');
  });
  await t.test('root ceased by a replaced B1 before any dispatch: interrupted with ledger null', async child => {
    const f = fixture(child, 'repository-fact'), m = registered(f, 'rg14-root');
    const next = redrive(f, { target: 'garden-B1', field: 'nodes', value: ['garden-produce-block', 'garden-consume-block'] }, 'rg14');
    const root = completionRootAssignments(m.binding)[0]!;
    ok(writeCompletionCessation(f.store, { project: f.project, binding: reference(m.binding), assignment: reference(root) }));
    const saved = ok(evaluate(f, m, [], { request: next.request }));
    const source = saved.groups[0]!.source, g4b = claimOf(f, source);
    assert.equal(f.store.get(callLedgerId(f.project)), null, 'Nothing was ever dispatched in this project');
    const products = m.work().products.map(ref => f.store.get(ref.id, ref.revision)!.kind);
    assert.ok(['om-answers-registration', 'om-answers-evaluation', 'om-unit-refusal'].every(kind => products.includes(kind)));
    const stored = snapshot(f.store);
    assert.deepEqual(refusedAt(closeWith(f, 'refused', [])), ['completion_reason_invalid', 'reason', null]);
    assert.deepEqual(refusedAt(closeWith(f, 'interrupted', [g4b])), ['completion_refusal_uncounted', 'refusals', source]);
    assert.deepEqual(snapshot(f.store), stored);
    const closed = ok(closeWith(f, 'interrupted', []));
    const close = ok(readCompletionCloseAt(f.store, f.project, reference(f.store.get(completionCloseId(f.project, m.binding.id))!)));
    assert.deepEqual([close.ledger, close.outcome.reason, closed.routed], [null, 'interrupted', []]);
    const history = snapshot(f.store);
    f.restart();
    ok(closeWith(f, 'interrupted', []));
    assert.deepEqual(snapshot(f.store), history, 'The ledger-null close repeats historically');
  });
});

/** Row 39: one managed MC1 attempt over the two-fact batch, each fact assessed by its own E5 of the given verdict. */
async function twoManagedFacts(f: ReturnType<typeof fixture>, slice: string, verdicts: ['supported' | 'insufficient', 'insufficient' | 'off-form']) {
  const m = registered(f, slice);
  assert.equal(m.batch.items.length, 2, 'Both addressed facts share the one MC1 batch');
  const assessor = (verdict: string) => verdict === 'off-form' ? { research: { answer: 'untyped reviewer reply' }, usage: traceUsage }
    : { research: { verdict, reasons: verdict === 'supported' ? [] : ['source not decisive'] }, usage: traceUsage };
  writeFileSync(m.scenario, JSON.stringify({ steps: [m.answer, ...verdicts.map(assessor)] }));
  const original = ok(await runModelCall(f.store, { project: f.project, packet: reference(m.packet), dispatch: m.dispatch, role: 'implementer' }));
  const terminals = [];
  for (const [index, verdict] of verdicts.entries()) {
    const terminal = ok(await assessFact(f.store, { project: f.project, modelCall: reference(original.record),
      questionId: m.batch.items[index]!.gap, dispatch: m.dispatch }));
    assert.equal(terminal.value.verdict, verdict);
    terminals.push(terminal);
  }
  const gaps = m.batch.items.map(item => f.blocking.find(row => row.value.gap.id === item.gap)!);
  return { m, terminals, gaps };
}

test('39 H1.0c S, E5 N and T under G4b observations keep the reason of the whole composition', async t => {
  await t.test('S and N: result with the whole negative part', async child => {
    const f = fixture(child, 'repository-fact', true, true);
    const { m, terminals: [s, n], gaps } = await twoManagedFacts(f, 'rg39-sn', ['supported', 'insufficient']);
    const route = laterRoute(f), accepted = s!.value.accepted!;
    const early = ok(evaluate(f, m, [], { routes: reference(route) }));
    const saved = ok(evaluate(f, m, [{ gap: reference(gaps[0]!), result: accepted, candidate: null },
      { gap: reference(gaps[1]!), result: reference(n!), candidate: null }], { routes: reference(route) }));
    assert.deepEqual(saved.groups.map(group => group.contribution.kind), ['existing']);
    const work = m.work(), rows = [...early.groups, ...saved.groups].map(group => claimOf(f, group.source));
    assert.deepEqual([work.complete, work.refusals.length, work.accepting], [true, 1, [accepted]]);
    for (const row of rows)
      assert.deepEqual(refusedAt(closeWith(f, 'result', [...work.refusals, row], [accepted]))[0], 'completion_refusal_uncounted');
    assert.deepEqual(refusedAt(closeWith(f, 'refused', work.refusals, [accepted]))[0], 'completion_reason_invalid',
      'G4b does not impose its reason, nor does N hide S');
    const closed = ok(closeWith(f, 'result', work.refusals, [accepted]));
    const outcome = outcomeOf(f, m);
    assert.deepEqual([outcome.reason, outcome.achieved.length, outcome.refusals.map(item => item.row), closed.routed.map(item => item.class)],
      ['result', 1, work.refusals.map(item => item.row), ['proposal']]);
  });
  await t.test('N and T: refused, the T staying technical', async child => {
    const f = fixture(child, 'repository-fact', true, true);
    const { m, terminals: [n, tech], gaps } = await twoManagedFacts(f, 'rg39-nt', ['insufficient', 'off-form']);
    const saved = ok(evaluate(f, m, gaps.map((gap, index) => ({ gap: reference(gap), result: reference([n, tech][index]!), candidate: null }))));
    assert.deepEqual(saved.groups.map(group => group.contribution.kind === 'existing' && group.contribution.producer).sort(), ['E5-N', 'E5-T']);
    const work = m.work(), rows = saved.groups.map(group => claimOf(f, group.source));
    assert.deepEqual([work.complete, work.refusals.length, work.technical.map(row => row.reason)], [true, 1, ['off-form']]);
    for (const row of rows) assert.deepEqual(refusedAt(closeWith(f, 'refused', [...work.refusals, row]))[0], 'completion_refusal_uncounted');
    assert.deepEqual(refusedAt(closeWith(f, 'off-form', work.refusals))[0], 'completion_reason_invalid');
    ok(closeWith(f, 'refused', work.refusals));
    const outcome = outcomeOf(f, m);
    assert.deepEqual([outcome.reason, outcome.refusals.map(item => item.row)], ['refused', work.refusals.map(item => item.row)]);
  });
});

// ---------------------------------------------------------------------------
// S5: one close form (owner decision 28.09, №1637) and the linked evaluation + close bundle (№1616 п.3, rows 41–44).
// Kept beside the managed fixtures of this file for the reason given at S4.
import { checkCompletionLedger, completionClosedWork } from '../src/om/model-call.js';
import { captureManagedCloseHeads, prepareLinkedClose, type CompletionCloseRecord } from '../src/om/repeat-gate.js';
import { readSeries } from '../src/om/series.js';

const closeRequest = (f: ReturnType<typeof fixture>, reason: Reason, refusals: readonly ClaimedRefusal[], accepting: Ref[] = []) =>
  ({ project: f.project, block: f.block, line: 1, attempt: 1, outcome: { reason, accepting, cancelling: [], refusals: [...refusals] } });
const canonicalRefs = (values: readonly Ref[]) => [...values].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
/** Own E5 N of a registered, not yet evaluated check: the evaluation that resolves it and the close of the attempt. */
async function linkedN(f: ReturnType<typeof fixture>, slice: string) {
  const m = registered(f, slice), fact = factGap(f);
  const { terminal } = await managedFact(f, m, 'insufficient');
  const work = m.work();
  const close = closeRequest(f, 'refused', work.refusals);
  const request = { project: f.project, binding: reference(m.binding),
    request: { ...f.request, results: [{ gap: reference(fact), result: reference(terminal), candidate: null }] } };
  return { m, fact, terminal, work, close, request, linked: { ...request, close } };
}
const closeOf = (f: ReturnType<typeof fixture>, m: { binding: Revision<unknown> }) =>
  f.store.get<CompletionCloseRecord>(completionCloseId(f.project, m.binding.id));
/** Every Ref of a bundle stands in the store or is written by the same bundle: no Ref of a revision to be. */
function realRefs(store: Store, writes: readonly Write[], refs: readonly Ref[]) {
  for (const ref of refs) {
    const write = writes.find(item => item.id === ref.id && item.expected + 1 === ref.revision);
    const hash = write ? hashJson(write.value as Json) : store.get(ref.id, ref.revision)?.hash;
    assert.equal(hash, ref.hash, `${ref.id}@${ref.revision} is a real revision`);
  }
}

test('X5 C67 H1.0c linked evaluation, G4b source, A2 rows, classes and close write each id once and cite the final journal', async t => {
  const f = fixture(t, 'repository-fact'), s = await linkedN(f, 'x5'), m = s.m;
  const before = m.head(), journalBefore = f.store.get(journalId(f.project))!, calls = f.store.list('model-call').length;
  assert.deepEqual([s.work.complete, s.work.answers?.evaluation, s.work.refusals.length], [false, null, 1]);
  assert.equal(refusedAt(closeAttempt(f.store, s.close))[0], 'completion_incomplete', 'Alone, G7 waits for the check');
  const stored = snapshot(f.store);
  const prepared = ok(prepareAnswersEvaluation(f.store, s.linked));
  assert.deepEqual(snapshot(f.store), stored, 'Preparation writes nothing');
  const ids = prepared.writes.map(write => write.id), source = prepared.groups[0]!.source;
  assert.equal(new Set(ids).size, ids.length, 'One write per id');
  assert.deepEqual(prepared.groups.map(group => group.contribution.kind), ['existing']);
  const one = (id: string) => { const rows = prepared.writes.filter(write => write.id === id); assert.equal(rows.length, 1, id); return rows[0]!; };
  const journalWrite = one(journalId(f.project)), workWrite = one(before.id), closeWrite = one(completionCloseId(f.project, m.binding.id));
  assert.deepEqual([journalWrite.expected, workWrite.expected], [journalBefore.revision, before.revision], 'No intermediate A2 or work revision');
  for (const id of [prepared.evaluation.id, source.id]) one(id);
  const close = closeWrite.value as CompletionCloseRecord;
  const final = { id: journalId(f.project), revision: journalBefore.revision + 1, hash: hashJson(journalWrite.value as Json) };
  assert.deepEqual([close.work, close.additions, close.journal], [reference(before),
    canonicalRefs([reference(prepared.evaluation), source]), final], 'The real pre-close work, exact additions and the final journal');
  const cut = journalWrite.value as { rows: { id: string; source: Ref }[]; classifications: { row: string; class: string }[] };
  assert.ok(cut.rows.some(row => same(row.source, source)), 'The final journal holds the rows of the additions');
  assert.deepEqual(cut.classifications.map(row => [row.row, row.class]), [[s.work.refusals[0]!.row, 'proposal']],
    '...and the classes of this close, in the same one write');
  const closedWork = workWrite.value as CompletionWork, closeRef = { id: closeWrite.id, revision: 1, hash: hashJson(close as unknown as Json) };
  assert.deepEqual([closedWork.previous, closedWork.journal, closedWork.closed], [reference(before), final, closeRef]);
  assert.deepEqual(closedWork.products, canonicalRefs([...before.value.products, ...close.additions]));
  realRefs(f.store, prepared.writes, [close.work, ...close.additions, close.journal!, close.series, close.ledger!,
    closedWork.previous!, closedWork.closed!, ...closedWork.products]);
  const written = ok(writeAnswersEvaluation(f.store, s.linked));
  assert.deepEqual([written.repeated, written.closed?.routed.map(row => [row.row, row.class])], [false, [[s.work.refusals[0]!.row, 'proposal']]]);
  assert.deepEqual(m.head().value, closedWork);
  assert.equal(m.head().revision, before.revision + 1);
  assert.deepEqual(ok(readCompletionCloseAt(f.store, f.project, reference(closeOf(f, m)!))), close);
  assert.equal(outcomeOf(f, m).reason, 'refused');
  // C67: the ledger of the close is checked in the context of the same final journal, over the same effective view.
  const effective = ok(readCompletionEffectiveAt(f.store, f.project, { work: close.work, additions: close.additions, journal: close.journal }));
  assert.equal(ok(checkCompletionLedger(f.store, effective, close.ledger!, close.journal)), true);
  assert.equal(f.store.list('model-call').length, calls, 'The linked close pays no model');
  const history = snapshot(f.store);
  f.restart();
  const again = ok(writeAnswersEvaluation(f.store, s.linked));
  assert.deepEqual([again.repeated, again.evaluation, again.closed?.routed], [true, written.evaluation, written.closed?.routed]);
  assert.deepEqual(snapshot(f.store), history, 'The exact linked repeat is historical');
});

test('X11 H1.0c one close form: a direct G7 has additions [] and cites its final journal; older journals and formulas are refused', async t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'x11'), fact = factGap(f);
  const { terminal } = await managedFact(f, m, 'insufficient');
  ok(evaluate(f, m, [{ gap: reference(fact), result: reference(terminal), candidate: null }]));
  const prior = m.head(), work = m.work(), cutBefore = f.store.get(journalId(f.project))!;
  ok(closeWith(f, 'refused', work.refusals));
  const saved = closeOf(f, m)!, close = saved.value, closed = m.head();
  assert.deepEqual([close.additions, close.work], [[], reference(prior)]);
  assert.deepEqual(close.journal, reference(f.store.get(journalId(f.project))!), 'The final journal is the revision this close wrote');
  assert.equal(close.journal!.revision, cutBefore.revision + 1);
  assert.deepEqual(ok(readJournalAt(f.store, f.project, close.journal!)).value.classifications.map(row => row.row), [work.refusals[0]!.row]);
  assert.deepEqual([closed.revision, closed.value.previous, closed.value.journal, closed.value.closed],
    [prior.revision + 1, reference(prior), close.journal, reference(saved)]);
  assert.deepEqual(ok(completionClosedWork(f.store, f.project, prior, close, reference(saved))), closed.value, 'One formula');
  // A close citing the journal before its own classes, even rehashed, is not the proof of this close.
  const early = reHashed(saved, { ...close, journal: reference(cutBefore) });
  assert.deepEqual(refusedAt(readCompletionCloseAt(plantedView(f.store, early), f.project, reference(early))),
    ['completion_invalid', 'journal', reference(cutBefore)]);
  const bare = { ...close } as Partial<CompletionCloseRecord>; delete bare.additions;
  const unversioned = reHashed(saved, bare as CompletionCloseRecord);
  assert.deepEqual(refusedAt(readCompletionCloseAt(plantedView(f.store, unversioned), f.project, reference(unversioned))).slice(0, 2),
    ['completion_invalid', 'record'], 'additions is mandatory, explicitly empty');
  // The former closed-work formula (a copy of the predecessor plus closed) no longer reads.
  const copied = reHashed(closed, { ...prior.value, previous: reference(prior), closed: reference(saved) });
  assert.equal(refusedAt(readCompletionWorkAt(plantedView(f.store, copied), f.project, reference(copied)))[0], 'completion_invalid');
  const reversed = [reference(prior), reference(prior)];
  assert.deepEqual(refusedAt(readCompletionEffectiveAt(f.store, f.project, { work: close.work, additions: reversed, journal: close.journal })),
    ['completion_invalid', 'additions', null]);
  assert.deepEqual(refusedAt(readCompletionEffectiveAt(f.store, f.project, { work: close.work, additions: [], journal: null })),
    ['completion_invalid', 'journal', null], 'A final journal is never older than the work cut, nor absent');
  f.restart();
  const history = snapshot(f.store);
  ok(closeWith(f, 'refused', work.refusals));
  assert.deepEqual(snapshot(f.store), history, 'The exact repeat of the one form is historical');
});

test('41 H1.0c a moved journal, work, S, E1 or source between preparation and writing fails the whole linked bundle', async t => {
  const moves = ['journal', 'work', 'S', 'E1', 'source'] as const;
  for (const move of moves) await t.test(move, async child => {
    const f = fixture(child, 'repository-fact');
    const other = move === 'journal' ? managedOn(f, 'garden-consume-block', [nodeBatch(f, 'garden-consume-block').id], 1, 'row41-other') : null;
    const s = await linkedN(f, `row41-${move}`), m = s.m, calls = f.store.list('model-call').length;
    const prepared = ok(prepareAnswersEvaluation(f.store, s.linked));
    const rival = new Store(f.path);
    try {
      const bump = (id: string) => { const head = rival.get(id)!; rival.write({ id, kind: head.kind, expected: head.revision, value: head.value as Json }); };
      if (move === 'journal') ok(writeAnswersEvaluation(rival, { project: f.project, binding: reference(other!.binding), request: { ...f.request, results: [] } }));
      if (move === 'work') ok(writeAnswersEvaluation(rival, { ...s.request, request: { ...f.request, results: [] }, deliver: 'none' }));
      if (move === 'S') bump(m.binding.value.series.id);
      if (move === 'E1') bump(callLedgerId(f.project));
      if (move === 'source') bump(s.terminal.id);
    } finally { rival.close(); }
    const stored = snapshot(f.store);
    const lost = writeGuarded(f.store, { unit: 'G7', target: prepared.evaluation.id, writes: [...prepared.writes], guards: [...prepared.guards] });
    assert.equal(lost.ok, false, `${move}: the bundle is refused by its guards`);
    assert.deepEqual(snapshot(f.store), stored, 'No evaluation, source, row, class, close, A3 or work of it is written');
    assert.equal(closeOf(f, m), null);
    assert.equal(f.store.list('model-call').length, calls);
    if (move === 'journal' || move === 'work') {
      // A refused write is no finding of the cycle: the full bundle is rebuilt over the moved heads, without paying.
      const rebuilt = ok(writeAnswersEvaluation(f.store, s.linked));
      assert.equal(rebuilt.closed?.routed.length, 1);
      assert.ok(m.head().value.closed);
      assert.equal(f.store.list('model-call').length, calls);
    }
  });
  await t.test('journal, when the bundle itself writes no A2', async child => {
    // An applicable D5 answers the check without a group and the result close classifies nothing: only the guard of the
    // captured journal head (or its absence) protects the close that cites it.
    const f = fixture(child, 'repository-fact');
    const other = managedOn(f, 'garden-consume-block', [nodeBatch(f, 'garden-consume-block').id], 1, 'row41-bare-other');
    const m = registered(f, 'row41-bare'), fact = factGap(f), accepted = (await supportedManaged(f, m)).value.accepted!;
    const route = laterRoute(f);
    const linked = { project: f.project, binding: reference(m.binding), close: closeRequest(f, 'result', [], [accepted]),
      request: { ...f.request, routes: reference(route), results: [{ gap: reference(fact), result: accepted, candidate: null }] } };
    const prepared = ok(prepareAnswersEvaluation(f.store, linked));
    assert.deepEqual([prepared.groups, prepared.writes.some(write => write.id === journalId(f.project))], [[], false]);
    const rival = new Store(f.path);
    try { ok(writeAnswersEvaluation(rival, { project: f.project, binding: reference(other.binding),
      request: { ...f.request, routes: reference(route), results: [] } })); }
    finally { rival.close(); }
    const stored = snapshot(f.store);
    const lost = writeGuarded(f.store, { unit: 'G7', target: prepared.evaluation.id, writes: [...prepared.writes], guards: [...prepared.guards] });
    assert.equal(lost.ok, false, 'The captured A2 head guards the close');
    assert.deepEqual(snapshot(f.store), stored);
    const rebuilt = ok(writeAnswersEvaluation(f.store, linked));
    assert.deepEqual([rebuilt.closed?.routed, outcomeOf(f, m).reason], [[], 'result']);
    assert.deepEqual(closeOf(f, m)!.value.additions, [reference(rebuilt.evaluation)]);
  });
});

test('42 H1.0c a winning linked close rejects a later evaluation or delivery; only exact repeats remain', async t => {
  const f = fixture(t, 'repository-fact'), s = await linkedN(f, 'row42');
  const late = ok(prepareAnswersEvaluation(f.store, { ...s.request, request: { ...f.request, results: [] } }));
  assert.ok(late.writes.length > 0);
  const won = ok(writeAnswersEvaluation(f.store, s.linked));
  const history = snapshot(f.store);
  const lost = writeGuarded(f.store, { unit: 'G4b', target: late.evaluation.id, writes: [...late.writes], guards: [...late.guards] });
  assert.equal(lost.ok, false, 'The late evaluation loses the CAS of the work');
  assert.deepEqual(snapshot(f.store), history);
  assert.deepEqual(refused(writeAnswersEvaluation(f.store, { ...s.request, request: { ...f.request, results: [] } })), ['completion_closed', 'work']);
  const repeat = ok(writeAnswersEvaluation(f.store, s.request));
  assert.deepEqual([repeat.repeated, repeat.evaluation], [true, won.evaluation], 'The included evaluation repeats historically');
  assert.deepEqual(ok(writeAnswersDelivery(f.store, { project: f.project, evaluation: reference(won.evaluation) })).groups.map(g => g.source),
    won.groups.map(group => group.source), '44: a delivered group repeats after the linked close');
  assert.deepEqual(snapshot(f.store), history);
});

test('43 H1.0c a winning evaluation of a second store rejects the prepared linked close; it is rebuilt without another paid call', async t => {
  const f = fixture(t, 'repository-fact'), s = await linkedN(f, 'row43'), m = s.m, calls = f.store.list('model-call').length;
  const prepared = ok(prepareAnswersEvaluation(f.store, s.linked));
  const rival = new Store(f.path);
  let first: Ref;
  try { first = reference(ok(writeAnswersEvaluation(rival, s.request)).evaluation); } finally { rival.close(); }
  assert.deepEqual(first!, reference(prepared.evaluation), 'Both stores derive the same evaluation address');
  const stored = snapshot(f.store), evaluated = m.head();
  const lost = writeGuarded(f.store, { unit: 'G7', target: prepared.evaluation.id, writes: [...prepared.writes], guards: [...prepared.guards] });
  assert.equal(lost.ok, false);
  assert.deepEqual(snapshot(f.store), stored);
  // The full outcome is rebuilt: the evaluation is now an exact repeat and the close is the general G7 over its work.
  const rebuilt = ok(writeAnswersEvaluation(f.store, s.linked));
  assert.deepEqual([rebuilt.repeated, rebuilt.closed?.routed.map(row => row.class)], [true, ['proposal']]);
  const close = closeOf(f, m)!.value;
  assert.deepEqual([close.work, close.additions], [reference(evaluated), []]);
  assert.equal(outcomeOf(f, m).reason, 'refused');
  assert.equal(f.store.list('model-call').length, calls, 'Nothing is paid again');
  assert.equal(f.store.list(ANSWERS_EVALUATION_KIND).length, 1, 'One chain, one evaluation');
});

test('X8 C66 44 H1.0c an exact group repeat after the linked close and restart is historical and acyclic', async t => {
  const f = fixture(t, 'repository-fact');
  const other = managedOn(f, 'garden-consume-block', [nodeBatch(f, 'garden-consume-block').id], 1, 'x8-other');
  const s = await linkedN(f, 'x8'), m = s.m;
  const written = ok(writeAnswersEvaluation(f.store, s.linked));
  const closeRef = reference(closeOf(f, m)!), workRef = reference(m.head()), source = written.groups[0]!.source;
  const reads = () => [ok(readCompletionWorkAt(f.store, f.project, workRef)).complete,
    canonical(ok(readCompletionCloseAt(f.store, f.project, closeRef)) as unknown as Json),
    canonical(ok(readAnswersGateRefusalAt(f.store, f.project, source)).record as unknown as Json),
    canonical(ok(readAnswersEvaluationAt(f.store, f.project, reference(written.evaluation))).record as unknown as Json),
    ok(readJournalAt(f.store, f.project, ok(readCompletionCloseAt(f.store, f.project, closeRef)).journal!)).value.rows.length];
  const first = reads();
  f.restart();
  const history = snapshot(f.store);
  const group = ok(writeAnswersDelivery(f.store, { project: f.project, evaluation: reference(written.evaluation), group: written.groups[0]!.proof.id }));
  assert.deepEqual(group.groups.map(item => item.source), [source]);
  assert.deepEqual(snapshot(f.store), history, '44: no new class, row, payment or count');
  assert.deepEqual(reads(), first, 'Every leaf reads back without a cycle through its own close');
  // The heads move on (another binding writes A2, a later M6 stands): the saved revisions read the same.
  ok(evaluate(f, other, []));
  laterRoute(f);
  assert.deepEqual(reads(), first, 'Historical reads use exact revisions, never today\'s heads');
  const series = ok(readSeries(f.store, { project: f.project, block: f.block, line: 1 }));
  assert.equal(series.value.attempts[0]!.outcome?.reason, 'refused');
});

test('X5 H1.0c a linked close names only the attempt of the evaluated binding, with every source delivered', async t => {
  const f = fixture(t, 'repository-fact');
  const other = managedOn(f, 'garden-consume-block', [nodeBatch(f, 'garden-consume-block').id], 1, 'x5-other');
  const s = await linkedN(f, 'x5-foreign');
  const stored = snapshot(f.store);
  const foreign = { ...s.request, close: { ...s.close, block: 'garden-consume-block' } };
  assert.deepEqual(refusedAt(prepareAnswersEvaluation(f.store, foreign)), ['completion_foreign', 'close', reference(other.binding)]);
  for (const shape of [{ ...s.linked, deliver: 'none' }, { ...s.linked, close: { ...s.close, project: 'another' } }, { ...s.linked, close: null }])
    assert.throws(() => prepareAnswersEvaluation(f.store, shape as never), (error: unknown) => error instanceof EngineError
      && error.code === 'answers_gate_request_invalid', 'A linked close delivers every source of the same project');
  // Heads captured for one attempt cannot close another, even when handed straight to the close.
  const heads = ok(captureManagedCloseHeads(f.store, s.close));
  const linked = { heads, writes: [], guards: [], sources: [], pending: [], additions: [] };
  assert.deepEqual(refusedAt(prepareLinkedClose(f.store, { ...s.close, block: 'garden-consume-block' }, linked)).slice(0, 2),
    ['completion_foreign', 'binding']);
  assert.throws(() => prepareLinkedClose(f.store, s.close, { ...linked, additions: [{ id: 'x' }] } as never),
    (error: unknown) => error instanceof EngineError && error.code === 'repeat_request_invalid');
  assert.deepEqual(snapshot(f.store), stored);
});

// ---- H1.0c S6: the H1.0b door of the check after deactivation (№1446 row 40, №1616 п.1 and п.6 X9) ----
import { writeHorizonIssuance } from '../src/om/horizon.js';
import { writeSeriesTransition } from '../src/om/series-transition.js';
import { applySeriesActivation, type CompletionOwner } from '../src/om/series.js';
import type { TransactionGuard } from '../src/storage/store.js';
import { answersCheckCessationValue, prepareAnswersCheckCessation, readAnswersParticipant, writeAnswersCheckCessation } from '../src/om/answers-gate.js';
import { prepareCompletionCause, readCompletionCause, readCompletionCessationAt, completionCessationId } from '../src/om/model-call.js';
import { readStopContext, readStopContextAt } from '../src/om/repeat-gate.js';
import { stopReport } from '../src/om/stop-report.js';

/** B3 activation of every open block line on a horizon (as om-assessment:118-123). */
function activateLines(f: Pick<ReturnType<typeof fixture>, 'store' | 'project'>, horizon: { gate: Revision<{ choiceVersion: string }> }) {
  const version = horizon.gate.value.choiceVersion;
  const lines = f.store.list<RepairSeries>('repair-series').filter(row => row.value.projectId === f.project && 'block' in row.value)
    .filter(row => !f.store.list<RepairSeries>('repair-series').some(other => other.value.predecessor?.id === row.id)).map(reference);
  const prepared = ok(writeSeriesTransition(f.store, { project: f.project, choiceVersion: version, horizon: reference(horizon.gate), series: lines }));
  const issuance = ok(writeHorizonIssuance(f.store, { project: f.project, choiceVersion: version, horizon: reference(horizon.gate),
    transition: reference(prepared) }));
  return ok(applySeriesActivation(f.store, { project: f.project, prepared: reference(prepared), issuance: reference(issuance) }));
}
/** A new horizon over the current input and graph. */
function horizonOf(f: ReturnType<typeof fixture>, version: string, features: string[], excluded: string[] = []) {
  return ok(writeHorizon(f.store, { project: f.project, input: reference(f.store.get(f.input.id)!), graph: reference(f.store.get(f.graph.id)!),
    refinement: null, available: {}, choice: { choiceVersion: version, features: features.map(outcome => ({ outcome })),
      excluded: excluded.map(block => ({ block, reason: 'Keep the later result only', returnCondition: 'Select the original result again' })) } }));
}
/** The owner selects only the later result: the line of the attempt's block is excluded (active-participation change). */
function deactivate(f: ReturnType<typeof fixture>, version = 'h10c-excluded') {
  const horizon = horizonOf(f, version, ['garden-later'], [f.block]);
  return { horizon, applied: activateLines(f, horizon) };
}
const reactivate = (f: ReturnType<typeof fixture>, version = 'h10c-returned') => activateLines(f, horizonOf(f, version, ['garden-result']));
/** The whole current D1 and M6 over a horizon: the full current preparation a new evaluation would need. */
function currentOver(f: ReturnType<typeof fixture>, horizon: { gate: Revision<unknown> }): AnswersGateRequest {
  const old = f.request.gaps.sources;
  const sources: GapRequest = { ...clone(old) as GapRequest, input: reference(f.store.get(f.input.id)!), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { ...clone(old.operations.frame) as GapRequest['operations']['frame'], horizon: reference(horizon.gate) } } };
  const gaps = ok(writeGaps(f.store, sources));
  const gapRead: GapReadRequest = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const route = ok(writeRoutes(f.store, { project: f.project, gaps: gapRead, catalog: { paths: [], records: [] }, previous: null, tasks: [] }));
  return { project: f.project, gaps: gapRead, routes: reference(route), results: [] };
}
/** A managed MC1 attempt of the consuming block, opened on an activated line, with its registered check. */
function excludable(t: TestContext, slice: string) {
  const f = fixture(t, 'repository-fact', true, false, { block: 'garden-consume-block', later: true });
  return { f, m: registered(f, slice, true) };
}
const seriesIdOf = (f: ReturnType<typeof fixture>) => f.store.list<RepairSeries>('repair-series')
  .find(row => row.value.projectId === f.project && 'block' in row.value && row.value.block === f.block)!.id;
const checkOf = (m: { binding: Revision<CompletionOwner> }) => reference(answersGateAssignment(m.binding));
const rootOf = (m: { binding: Revision<CompletionOwner> }) => completionRootAssignments(m.binding)[0]!;
const ceaseRoot = (f: ReturnType<typeof fixture>, m: { binding: Revision<CompletionOwner> }) =>
  ok(writeCompletionCessation(f.store, { project: f.project, binding: reference(m.binding), assignment: reference(rootOf(m)) }));
const ceaseCheck = (f: ReturnType<typeof fixture>, m: { binding: Revision<CompletionOwner> }) =>
  writeAnswersCheckCessation(f.store, { project: f.project, binding: reference(m.binding) });

test('40 X9 H1.0c after deactivation a saved complete evaluation stays history and closes by completion admission; nothing new is admitted', async t => {
  const { f, m } = excludable(t, 'row40-saved'), fact = factGap(f);
  const { terminal } = await managedFact(f, m, 'insufficient');
  const waiting = ok(evaluate(f, m, []));
  const resolved = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(terminal), candidate: null }]));
  assert.deepEqual([m.work().answers?.complete, m.work().answers?.evaluation], [true, reference(resolved.evaluation)]);
  const { horizon } = deactivate(f);
  const current = currentOver(f, horizon);
  const stored = snapshot(f.store);
  // Nothing of the check remains to cease; its saved evaluation is not re-proved and no new one is admitted by it.
  assert.deepEqual(refusedAt(ceaseCheck(f, m)), ['completion_resolved', 'assignment', reference(resolved.evaluation)]);
  assert.deepEqual(refused(evaluate(f, m, [], { request: current })), ['completion_resolved', 'assignment']);
  const repeat = ok(evaluate(f, m, [{ gap: reference(fact), result: reference(terminal), candidate: null }]));
  assert.deepEqual([repeat.repeated, repeat.evaluation], [true, resolved.evaluation], 'The exact repeat is historical after deactivation');
  const older = ok(evaluate(f, m, []));
  assert.deepEqual([older.repeated, older.evaluation], [true, waiting.evaluation]);
  assert.deepEqual(m.work().answers?.evaluation, reference(resolved.evaluation), 'A repeat does not make an older evaluation the latest');
  assert.deepEqual(snapshot(f.store), stored, 'No record, admission or product moved');
  // Completion goes through the completion admission of the original line (H1.0b), with the E5 N as the one counted row.
  const work = m.work();
  assert.deepEqual([work.complete, work.answers?.ceased, work.cessations.length], [true, null, 0]);
  const closed = ok(closeWith(f, 'refused', work.refusals));
  assert.equal(outcomeOf(f, m).reason, 'refused');
  const history = snapshot(f.store);
  f.restart();
  assert.deepEqual(ok(closeWith(f, 'refused', work.refusals)), closed, 'The close repeats historically');
  assert.deepEqual(ok(readAnswersEvaluationAt(f.store, f.project, reference(resolved.evaluation))).record, resolved.evaluation);
  assert.deepEqual(snapshot(f.store), history);
});

test('40 X9 X10 H1.0c after deactivation an unfinished check ceases through the H1.0b door and closes with ledger null, without E1', async t => {
  for (const saved of [false, true]) await t.test(saved ? 'a saved journal-only evaluation waits' : 'the check was never evaluated', async child => {
    const { f, m } = excludable(child, saved ? 'x9-waiting' : 'x9-unevaluated'), check = checkOf(m);
    const waiting = saved ? ok(evaluate(f, m, [])) : null;
    const barrier = waiting ? waiting.groups.map(group => group.proof) : [];
    assert.ok(!saved || barrier.length > 0, 'The saved evaluation keeps a journal-only barrier');
    // A moved M6 is no cause: before the line changes the check keeps its admission.
    laterRoute(f);
    assert.equal(ok(prepareCompletionCause(f.store, f.project, check)).cause, null);
    assert.deepEqual(refusedAt(ceaseCheck(f, m)), ['completion_cause_unproved', 'cause', check]);
    const { horizon } = deactivate(f);
    const current = currentOver(f, horizon), stored = snapshot(f.store);
    // Row 40: the old proof admits no new gate or work on the deactivated line.
    const fresh = evaluate(f, m, [], { request: current });
    assert.equal(fresh.ok, false, 'A new evaluation needs the new-work admission the line lost');
    if (!fresh.ok) assert.notEqual(fresh.refusal.code, 'completion_resolved');
    // The physical door does not take the check: its reader refuses a non-physical assignment.
    const physical = writeCompletionCessation(f.store, { project: f.project, binding: reference(m.binding), assignment: check });
    assert.equal(physical.ok ? 'ceased' : physical.refusal.code, 'completion_invalid');
    assert.deepEqual(snapshot(f.store), stored);
    const root = ceaseRoot(f, m);
    assert.deepEqual(refusedAt(closeWith(f, 'interrupted', [])), ['completion_incomplete', 'work', null], 'The unfinished check alone holds the close');
    assert.deepEqual(m.work().answers?.waiting.map(row => [row.reason, row.ref]),
      saved ? barrier.map(proof => ['submission', proof]) : [['unevaluated', reference(m.registration)]], 'Its saved addressed cause');
    const cause = ok(prepareCompletionCause(f.store, f.project, check)), before = m.head();
    assert.deepEqual([cause.cause?.kind, cause.cause && 'condition' in cause.cause ? cause.cause.condition : null],
      ['series-admission-change', 'active-participation']);
    const ceased = ok(ceaseCheck(f, m));
    assert.equal(ceased.id, completionCessationId(f.project, m.binding.id, check.id));
    assert.deepEqual(ceased.value, { contract: 'om-completion-cessation/v1', project: f.project, binding: reference(m.binding),
      assignment: check, work: reference(before), cause: cause.cause, disposition: 'check-ceased', remainder: 'answers-gate',
      packet: null, callId: null, physicalId: null, call: null, ledger: null, physical: null, exchange: null, rejection: null });
    const after = m.head();
    assert.deepEqual([after.revision, added(before, after)], [before.revision + 1, [reference(ceased)]], 'One completion-only transition');
    const work = m.work();
    assert.deepEqual(work.answers, { assignment: check, registration: reference(m.registration),
      evaluation: waiting ? reference(waiting.evaluation) : null, ceased: reference(ceased), complete: true, existing: [], waiting: [] });
    assert.deepEqual(work.cessations.map(reference), [reference(root)], 'Physical readers never see the ceased check');
    assert.ok(work.technical.some(row => same(row, { source: reference(ceased), reason: 'interrupted' })));
    assert.equal(work.complete, true);
    for (const group of waiting?.groups ?? []) assert.ok(work.products.some(ref => same(ref, group.source)),
      'The saved journal-only sources stay products; the cessation, not their disappearance, ends the wait');
    assert.deepEqual(ok(prepareAnswersCheckCessation(f.store, { project: f.project, binding: reference(m.binding) })),
      { record: ceased, writes: [], guards: [] }, 'A second cessation is its historical repeat');
    assert.deepEqual(refused(evaluate(f, m, [{ gap: reference(factGap(f)), result: null, candidate: null }])), ['completion_resolved', 'assignment']);
    if (waiting) {
      const again = ok(evaluate(f, m, []));
      assert.deepEqual([again.repeated, again.evaluation], [true, waiting.evaluation]);
      const g4b = claimOf(f, waiting.groups[0]!.source);
      assert.deepEqual(refusedAt(closeWith(f, 'interrupted', [g4b])), ['completion_refusal_uncounted', 'refusals', waiting.groups[0]!.source]);
    }
    // No E1 was ever admitted: the lawful non-physical completion closes with ledger null.
    assert.equal(f.store.get(callLedgerId(f.project)), null);
    const closed = ok(closeWith(f, 'interrupted', []));
    const close = ok(readCompletionCloseAt(f.store, f.project, reference(f.store.get(completionCloseId(f.project, m.binding.id))!)));
    assert.deepEqual([close.ledger, close.outcome.reason, close.additions], [null, 'interrupted', []]);
    assert.equal(outcomeOf(f, m).reason, 'interrupted');
    const history = snapshot(f.store);
    f.restart();
    assert.deepEqual(ok(closeWith(f, 'interrupted', [])), closed);
    assert.deepEqual(ok(readCompletionCessationAt(f.store, f.project, reference(ceased))), ceased);
    assert.deepEqual(ok(writeAnswersCheckCessation(f.store, { project: f.project, binding: reference(m.binding) })), ceased);
    assert.deepEqual(snapshot(f.store), history, 'Close, cessation and check repeat historically');
  });
});

test('X9 H1.0c a ceased check is read only by its own derivation: its participant, cause and value', async t => {
  const { f, m } = excludable(t, 'x9-forged'), check = checkOf(m);
  deactivate(f);
  const root = ceaseRoot(f, m), ceased = ok(ceaseCheck(f, m)), value = ceased.value;
  const read = (planted: Revision<unknown>) => {
    const result = readCompletionCessationAt(plantedView(f.store, planted), f.project, reference(planted));
    return result.ok ? 'accepted' : result.refusal.code;
  };
  const other: Ref = { id: 'x', revision: 1, hash: 'a'.repeat(64) };
  // The participant takes only the check's own cessation, once, after its registration.
  const participant = (products: Ref[]) => {
    const result = readAnswersParticipant(f.store, m.binding, products);
    return result.ok ? 'accepted' : [result.refusal.code, result.refusal.at.field];
  };
  assert.deepEqual(participant([reference(m.registration), reference(root)]), ['completion_invalid', 'cessation']);
  assert.deepEqual(participant([reference(ceased)]), ['completion_invalid', 'registration']);
  assert.equal(participant([reference(m.registration), reference(ceased)]), 'accepted');
  // Only the admission change of its block line ends the check; its value is one shared derivation.
  const file = readCompletionCause(f.store, f.project, check, { kind: 'file-observation', source: other,
    observation: { kind: 'unavailable', code: 'ENOENT' } } as never);
  assert.deepEqual(file.ok ? 'accepted' : [file.refusal.code, file.refusal.at.field], ['completion_cause_invalid', 'cause']);
  assert.deepEqual(ok(answersCheckCessationValue(f.store, f.project, value)), value);
  assert.equal(read(ceased), 'accepted');
  for (const shape of [[null, f.project, value], [f.store, '', value], [f.store, f.project, { ...value, work: null }],
    [f.store, f.project, null]] as const)
    assert.throws(() => answersCheckCessationValue(...(shape as unknown as Parameters<typeof answersCheckCessationValue>)),
      (error: unknown) => error instanceof EngineError && error.code === 'answers_gate_request_invalid');
  for (const request of [null, {}, { project: f.project }, { project: f.project, binding: reference(m.binding), extra: 1 },
    { project: f.project, binding: { id: m.binding.id } }, { project: '', binding: reference(m.binding) }])
    for (const action of [prepareAnswersCheckCessation, writeAnswersCheckCessation])
      assert.throws(() => action(f.store, request as never), (error: unknown) => error instanceof EngineError
        && error.code === 'answers_gate_request_invalid', 'Every argument is checked before the store');
  assert.throws(() => prepareAnswersCheckCessation(null as never, { project: f.project, binding: reference(m.binding) }),
    (error: unknown) => error instanceof EngineError && error.code === 'answers_gate_request_invalid');
});

test('X9 H1.0c the check door needs a registered, unresolved block check: none, a closed work or a mechanism binding is refused', async t => {
  await t.test('no registration or a closed work', async child => {
    const f = fixture(child, 'repository-fact', true, false, { block: 'garden-consume-block', later: true });
    const m = managedAttempt(f, 'x9-bare', true);
    deactivate(f);
    const stored = snapshot(f.store);
    assert.deepEqual(refusedAt(ceaseCheck(f, m)), ['answers_binding_invalid', 'registration', reference(m.binding)]);
    assert.deepEqual(snapshot(f.store), stored, 'No cessation is invented for an unregistered check');
    ceaseRoot(f, m);
    ok(closeWith(f, 'interrupted', []));
    assert.deepEqual(refusedAt(ceaseCheck(f, m)).slice(0, 2), ['completion_closed', 'work']);
  });
  await t.test('a mechanism binding', child => {
    const f = fixture(child, 'repository-fact', false);
    const batch = f.route.value.batches.find(row => row.model === 'MC2' && row.task === 'input-field'
      && row.items.some(item => item.target === f.target))!;
    const owner = { kind: 'mechanism' as const, mechanism: 'M5:addressing' as const };
    const goal: AttemptGoal = { key: 'answers:x9-mechanism', questions: batch.items.map(item => gapLineKey(f.project, item.target, item.field)),
      result: gapLineExpectedResult(f.project, batch.items[0]!.target, batch.items[0]!.field) };
    ok(openSeries(f.store, { project: f.project, owner, line: 1, scope: f.request.gaps, predecessor: null, basis: null } as never));
    const series = ok(managedOpenAttempt(f.store, { project: f.project, owner, line: 1, attempt: 1, goal,
      admission: { gaps: f.request.gaps, routes: reference(f.route), batch: batch.id },
      completion: { routes: reference(f.route), batches: [batch.id] } } as never));
    const binding = ok(readCompletionBinding(f.store, f.project, reference(series), 1))!, stored = snapshot(f.store);
    assert.deepEqual(refusedAt(writeAnswersCheckCessation(f.store, { project: f.project, binding: reference(binding) })),
      ['answers_evaluation_owner_unsupported', 'owner', reference(binding)]);
    assert.deepEqual(snapshot(f.store), stored);
  });
});

test('X9 H1.0c a prepared check cessation fails whole when the line returns, the work moves or a rival ceases first', async t => {
  const commit = (f: ReturnType<typeof fixture>, prepared: { record: Revision<unknown>; writes: readonly Write[]; guards: readonly TransactionGuard[] }) =>
    writeGuarded(f.store, { unit: 'G7', target: prepared.record.id, writes: [...prepared.writes], guards: [...prepared.guards] });
  await t.test('the line is activated again', async child => {
    const { f, m } = excludable(child, 'x9-return');
    deactivate(f);
    const prepared = ok(prepareAnswersCheckCessation(f.store, { project: f.project, binding: reference(m.binding) }));
    assert.ok(prepared.guards.some(guard => isRef(guard) && guard.id.startsWith(`om-series-current:${f.project}`)), 'The pointer is guarded');
    const rival = new Store(f.path);
    try { reactivate({ ...f, get store() { return rival; } } as ReturnType<typeof fixture>); } finally { rival.close(); }
    const stored = snapshot(f.store);
    assert.equal(commit(f, prepared).ok, false, 'The moved pointer refuses the whole bundle');
    assert.deepEqual(snapshot(f.store), stored);
    assert.deepEqual(refusedAt(ceaseCheck(f, m)), ['completion_cause_unproved', 'cause', checkOf(m)], 'The returned line keeps the check');
  });
  await t.test('the work moves or a rival writes the same cessation', async child => {
    const { f, m } = excludable(child, 'x9-rival');
    deactivate(f);
    const prepared = ok(prepareAnswersCheckCessation(f.store, { project: f.project, binding: reference(m.binding) }));
    const rival = new Store(f.path);
    try { ok(writeCompletionCessation(rival, { project: f.project, binding: reference(m.binding), assignment: reference(rootOf(m)) })); }
    finally { rival.close(); }
    let stored = snapshot(f.store);
    assert.equal(commit(f, prepared).ok, false, 'The moved work refuses the whole bundle');
    assert.deepEqual(snapshot(f.store), stored);
    const again = ok(prepareAnswersCheckCessation(f.store, { project: f.project, binding: reference(m.binding) }));
    const second = new Store(f.path);
    let won: Revision<unknown>;
    try { won = ok(writeAnswersCheckCessation(second, { project: f.project, binding: reference(m.binding) })); } finally { second.close(); }
    stored = snapshot(f.store);
    assert.equal(commit(f, again).ok, false, 'A rival cessation first: one write per id, the later bundle is refused');
    assert.deepEqual(snapshot(f.store), stored);
    assert.deepEqual(ok(ceaseCheck(f, m)), won, 'The saved cessation is the one repeated');
  });
});

test('X7 H1.0c a journal-only G4b row of another binding stays readable in the A5 context and the stop report', async t => {
  // A stopped series whose attempt 1 counted its E5 N row, and a real journal-only G4b row of another binding's check.
  const f = fixture(t, 'repository-fact');
  await assessedFact(f, 'insufficient');
  const other = managedOn(f, 'garden-consume-block', [nodeBatch(f, 'garden-consume-block').id], 1, 'x7-other');
  const waiting = ok(evaluate(f, other, []));
  assert.ok(waiting.groups.length > 0);
  const address = { project: f.project, block: f.block, line: 1 };
  const counted = f.store.get<RepairSeries>(seriesIdOf(f))!.value.attempts[0]!.outcome!;
  assert.deepEqual([counted.reason, counted.refusals.length], ['refused', 1], 'Attempt 1 counted its E5 N row');
  const goal = f.store.get<RepairSeries>(seriesIdOf(f))!.value.attempts[0]!.goal;
  // Two more attempts without progress stop the series: its A5 context then weighs the journal of attempt 1's rows.
  for (const attempt of [2, 3]) {
    ok(beginAttempt(f.store, { ...address, attempt, goal }));
    ok(completeAttempt(f.store, { ...address, attempt, outcome: { reason: 'off-form', achieved: [], cancelled: [], refusals: [] } }));
  }
  const context = ok(readStopContext(f.store, address));
  const journal = f.store.get<{ rows: { id: string; source: Ref }[]; classifications: unknown[] }>(journalId(f.project))!;
  assert.ok(context.reads.some(ref => same(ref, reference(journal))), 'The A5 context reads the journal of this series');
  const group = waiting.groups[0]!, row = journal.value.rows.find(item => same(item.source, group.source))!;
  assert.ok(row);
  const series = f.store.get(seriesIdOf(f))!;
  ok(stopReport(f.store, address));
  ok(readStopContextAt(f.store, { project: f.project, sources: { series: reference(series), journal: reference(journal), holds: [] } }));
});

test('X9 H1.0c one transition cannot both cease the check and add its next evaluation', t => {
  const { f, m } = excludable(t, 'x9-both');
  // Both are prepared on the same open work: the evaluation while the line is active, the cessation after its exclusion.
  const evaluation = ok(prepareAnswersEvaluation(f.store, { project: f.project, binding: reference(m.binding), request: f.request, deliver: 'none' }));
  deactivate(f);
  const cessation = ok(prepareAnswersCheckCessation(f.store, { project: f.project, binding: reference(m.binding) }));
  const records = [...evaluation.writes, ...cessation.writes].filter(write => write.kind !== 'om-completion-work');
  const view = pendingCallStore(f.store, records as Write[]);
  const additions = canonicalOrder([reference(evaluation.evaluation), reference(cessation.record)]);
  const both = readCompletionEffectiveAt(view, f.project, { work: reference(m.head()), additions, journal: null });
  assert.deepEqual(both.ok ? 'accepted' : [both.refusal.code, both.refusal.at.field], ['completion_conflict', 'evaluation']);
  for (const one of [[reference(evaluation.evaluation)], [reference(cessation.record)]])
    assert.equal(readCompletionEffectiveAt(view, f.project, { work: reference(m.head()), additions: one, journal: null }).ok, true,
      'Each of them alone is a lawful transition of this work');
});

test('X9 H1.0c a replaced B1, a new D1 or a later M6 ends a physical root but never the check', t => {
  const { f, m } = excludable(t, 'x9-moved'), check = checkOf(m);
  // One D3 decision replaces B1; the whole D1 and M6 are derived again from it.
  redrive(f, { target: 'garden-B1', field: 'nodes', value: ['garden-produce-block', 'garden-consume-block'] }, 'x9-moved');
  const root = ok(prepareCompletionCause(f.store, f.project, reference(rootOf(m))));
  assert.equal(root.cause?.kind, 'required-record-replaced', 'The physical root has its proved cause');
  const own = prepareCompletionCause(f.store, f.project, check);
  assert.deepEqual(own.ok ? own.value : own.refusal.code, { cause: null, guards: [] }, 'The check reads its own current slice instead');
  const stored = snapshot(f.store);
  assert.deepEqual(refusedAt(ceaseCheck(f, m)), ['completion_cause_unproved', 'cause', check]);
  assert.deepEqual(snapshot(f.store), stored);
});

// ---- H1.0c final self-check: form of every argument, windows of the unlinked bundles, the era of the managed work ----
import { answersCheckState, answersProduct, checkAnswersTransition } from '../src/om/answers-gate.js';
import { completionClosedWork as closedWorkOf } from '../src/om/model-call.js';

/** A Store whose reads fail loudly: an EngineError thrown through it proves the form was refused before any read. */
function tripwire(store: Store): Store {
  return new Proxy(store, { get(target, property) {
    if (property === 'get' || property === 'list' || property === 'write') return () => { throw new Error('The store was read'); };
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
}
const engineError = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;

test('X5 5 H1.0c every argument of an evaluation, its linked close and each exported check helper is EngineError before the store', t => {
  const f = fixture(t, 'repository-fact'), m = registered(f, 'shape');
  const wire = tripwire(f.store), stored = snapshot(f.store);
  const close = closeRequest(f, 'refused', []);
  const missing = { id: `om-completion-owner:${f.project}:${'0'.repeat(64)}`, revision: 1, hash: '0'.repeat(64) };
  // A malformed linked close is refused as a form even when the binding is missing: no binding refusal hides it.
  for (const binding of [reference(m.binding), missing]) {
    for (const bad of [{ ...close, attempt: 0 }, { ...close, outcome: { ...close.outcome, refusals: undefined } },
      { ...close, outcome: { ...close.outcome, verdict: 'done' } }, { ...close, line: 'one' }]) {
      const request = { project: f.project, binding, request: { ...f.request, results: [] }, close: bad } as never;
      const code = bad.line === 'one' ? 'series_request_invalid' : 'repeat_request_invalid';
      assert.throws(() => prepareAnswersEvaluation(wire, request), engineError(code));
      assert.throws(() => writeAnswersEvaluation(wire, request), engineError(code));
    }
  }
  const work = m.work(), own = work.products.filter(ref => answersProduct(f.project, ref, f.store.get(ref.id, ref.revision)!));
  const participant = ok(readAnswersParticipant(f.store, m.binding, own));
  const workRevision = work.work as unknown as Revision<CompletionWork>;
  const bindingOf = (value: unknown) => value as Revision<CompletionOwner>;
  const cases: [string, () => unknown][] = [
    ['participant store', () => readAnswersParticipant({} as Store, m.binding, [])],
    ['participant binding', () => readAnswersParticipant(wire, bindingOf(null), [])],
    ['participant binding value', () => readAnswersParticipant(wire, bindingOf({ ...m.binding, value: null }), [])],
    ['participant products', () => readAnswersParticipant(wire, m.binding, null as never)],
    ['participant product', () => readAnswersParticipant(wire, m.binding, [{ id: 'x' } as Ref])],
    ['transition before', () => checkAnswersTransition(wire, null as never, [])],
    ['transition work', () => checkAnswersTransition(wire, { ...work, work: null } as never, [])],
    ['transition answers', () => checkAnswersTransition(wire, { ...work, answers: 'none' } as never, [])],
    ['transition added', () => checkAnswersTransition(wire, work, undefined as never)],
    ['state binding', () => answersCheckState(wire, bindingOf(undefined), workRevision, participant)],
    ['state work', () => answersCheckState(wire, m.binding, { ...work.work, value: null } as never, participant)],
    ['state participant', () => answersCheckState(wire, m.binding, workRevision, null as never)],
    ['state evaluations', () => answersCheckState(wire, m.binding, workRevision, { ...participant, evaluations: undefined } as never)],
    ['product project', () => answersProduct('', reference(m.registration), m.registration)],
    ['product ref', () => answersProduct(f.project, null as never, m.registration)],
    ['product record', () => answersProduct(f.project, reference(m.registration), null as never)],
  ];
  for (const [name, call] of cases) assert.throws(call, engineError('answers_gate_request_invalid'), name);
  assert.throws(() => answersGateAssignment(null as never), engineError('series_request_invalid'));
  assert.throws(() => answersGateAssignment({ ...m.binding, value: undefined } as never), engineError('series_request_invalid'));
  assert.throws(() => closedWorkOf(wire, f.project, { value: work.work.value } as never, { additions: [], journal: null }, reference(m.registration)),
    engineError('model_call_request_invalid'));
  assert.deepEqual(snapshot(f.store), stored, 'Nothing was written');
  // Controls: the lawful arguments are read as before.
  assert.equal(answersProduct(f.project, reference(m.registration), m.registration), true);
  assert.deepEqual(ok(answersCheckState(f.store, m.binding, workRevision, participant)), work.answers);
});

test('2 41 H1.0c a moved journal, work or line between preparation and writing fails a whole unlinked evaluation, delivery or registration', async t => {
  const lost = (f: ReturnType<typeof fixture>, target: string, prepared: { writes: readonly Write[]; guards: readonly TransactionGuard[] }) => {
    const stored = snapshot(f.store), calls = f.store.list('model-call').length;
    const result = writeGuarded(f.store, { unit: 'G4b', target, writes: [...prepared.writes], guards: [...prepared.guards] });
    assert.equal(result.ok, false, 'The guards refuse the whole prepared bundle');
    assert.deepEqual(snapshot(f.store), stored, 'No part of it is written');
    assert.equal(f.store.list('model-call').length, calls, 'Nothing is paid');
  };
  const rivalOf = (f: ReturnType<typeof fixture>, act: (rival: Store) => void) => {
    const rival = new Store(f.path);
    try { act(rival); } finally { rival.close(); }
  };
  for (const move of ['journal', 'work'] as const) await t.test(`evaluation: ${move}`, child => {
    const f = fixture(child, 'repository-fact'), m = registered(f, `win-ev-${move}`);
    const other = move === 'journal' ? managedOn(f, 'garden-consume-block', [nodeBatch(f, 'garden-consume-block').id], 1, 'win-ev-other') : null;
    const request = { project: f.project, binding: reference(m.binding), request: { ...f.request, results: [] } };
    const prepared = ok(prepareAnswersEvaluation(f.store, request)), head = m.head();
    assert.ok(prepared.writes.some(write => write.id === journalId(f.project)) && prepared.groups.length > 0);
    rivalOf(f, rival => {
      if (other) ok(writeAnswersEvaluation(rival, { project: f.project, binding: reference(other.binding), request: { ...f.request, results: [] } }));
      else ok(writeAnswersEvaluation(rival, { ...request, request: { ...f.request, results: [{ gap: reference(factGap(f)), result: null, candidate: null }] },
        deliver: 'none' }));
    });
    if (other) assert.deepEqual(m.head(), head, 'Only the journal moved');
    lost(f, prepared.evaluation.id, prepared);
    const rebuilt = ok(writeAnswersEvaluation(f.store, request));
    assert.equal(rebuilt.repeated, false);
    assert.deepEqual(m.work().answers?.evaluation, reference(rebuilt.evaluation), 'The rebuilt evaluation is the latest of one chain');
  });
  await t.test('evaluation: line', child => {
    const { f, m } = excludable(child, 'win-ev-line');
    const request = { project: f.project, binding: reference(m.binding), request: { ...f.request, results: [] } };
    const prepared = ok(prepareAnswersEvaluation(f.store, request));
    rivalOf(f, rival => { deactivate({ ...f, store: rival } as ReturnType<typeof fixture>); });
    lost(f, prepared.evaluation.id, prepared);
    const fresh = writeAnswersEvaluation(f.store, request);
    assert.equal(fresh.ok, false, 'The deactivated line admits no new evaluation');
  });
  for (const move of ['journal', 'work'] as const) await t.test(`delivery: ${move}`, child => {
    const f = fixture(child, 'repository-fact'), batch = nodeBatch(f, 'garden-consume-block');
    const m = managedOn(f, 'garden-consume-block', [batch.id], 1, `win-dl-${move}`);
    const saved = ok(evaluate(f, m, [], { deliver: 'none' }));
    const other = move === 'journal' ? registered(f, 'win-dl-other') : null;
    const request = { project: f.project, evaluation: reference(saved.evaluation) };
    const prepared = ok(prepareAnswersDelivery(f.store, request)), head = m.head();
    assert.ok(prepared.writes.length > 0);
    rivalOf(f, rival => {
      if (other) ok(writeAnswersEvaluation(rival, { project: f.project, binding: reference(other.binding), request: { ...f.request, results: [] } }));
      else ok(writeAnswersEvaluation(rival, { project: f.project, binding: reference(m.binding),
        request: { ...f.request, results: [{ gap: reference(factGap(f)), result: null, candidate: null }] }, deliver: 'none' }));
    });
    if (other) assert.deepEqual(m.head(), head, 'Only the journal moved');
    lost(f, saved.evaluation.id, prepared);
    if (other) {
      ok(writeAnswersDelivery(f.store, request));
      assert.ok(saved.groups.every(group => m.head().value.products.some(ref => same(ref, group.source))), 'Rebuilt over the moved journal');
    } else assert.deepEqual(refused(prepareAnswersDelivery(f.store, request)), ['completion_conflict', 'evaluation'],
      'A superseded evaluation is no longer delivered');
  });
  await t.test('registration: line', child => {
    const f = fixture(child, 'repository-fact', true, false, { block: 'garden-consume-block', later: true });
    const m = managedAttempt(f, 'win-reg-line', true);
    const request = { project: f.project, binding: reference(m.binding) };
    const prepared = ok(prepareAnswersRegistration(f.store, request));
    rivalOf(f, rival => { deactivate({ ...f, store: rival } as ReturnType<typeof fixture>); });
    lost(f, prepared.record.id, prepared);
    assert.equal(writeAnswersRegistration(f.store, request).ok, false, 'The deactivated line admits no new registration');
    assert.equal(m.work().answers, null);
  });
});

// ---- №1770: the negative terminal of an MC2 root in G4b (a completed cycle without assembly) ----
type NodeEnd = 'cannot_answer' | 'off-form' | 'need_owner' | 'interrupted' | 'research-no-progress';
/** A managed MC2 node root of the block paid through the real producers and ended by the scripted answer. */
async function nodeTerminal(f: ReturnType<typeof fixture>, block: string, end: NodeEnd, slice: string) {
  const batch = nodeBatch(f, block), m = managedOn(f, block, [batch.id], 1, slice);
  const scenario = join(f.root, `${slice}-scenario.json`), trace = join(f.root, `${slice}-trace.jsonl`);
  const command = { executable: process.execPath, args: [adapterFixture, '--scenario', scenario, '--trace', trace] };
  const configure = (capacity: number) => f.engine.environments.configure(f.project, { workspace: f.root,
    implementer: { actor: 'answers-designer', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'answers-reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: capacity },
  f.store.get(`environment:${f.project}`)?.revision ?? 0);
  const environment = configure(200_000);
  const adapter = f.store.write({ id: `adapter:${f.project}:${slice}`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: f.project, protocol: 'codex-stdio' } });
  const request = (config: Ref) => ({ project: f.project, routes: reference(f.route), batch: batch.id, environment: config,
    attempt: { series: reference(m.series), ordinal: 1 }, previous: [] });
  const packet = ok(writeQuestionPacket(f.store, request(reference(environment)))).record;
  const questions = (packet.value.packet as unknown as { questions: { id: string }[] }).questions.map(row => row.id);
  let steps: unknown[];
  if (end === 'research-no-progress') {
    // The model asks twice for the same source: the repeated read adds nothing, so the cycle ends without an answer.
    const source = f.store.get<{ content: string }>(`source:${f.project}:brief`)!;
    const need = { research: { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'need_source', questionIds: questions,
      missing: 'Need the addressed source data', reads: [{ action: 'read_source', source: reference(source),
        selector: { kind: 'text-range', start: 0, end: source.value.content.length } }] }, usage: traceUsage };
    steps = [need, need];
  } else steps = [end === 'off-form' ? { research: { invalid: true }, usage: traceUsage }
    : end === 'interrupted' ? { rawStdout: '{broken', exitCode: 7 }
    : { research: { protocol: 'omg-answer/v2', requestId: '$requestId', questionIds: questions, action: end,
      reason: 'The requested design is not available', ...(end === 'need_owner' ? { decision: 'Name the operation' } : {}) }, usage: traceUsage }];
  writeFileSync(scenario, JSON.stringify({ steps }));
  const cycle = ok(await runModelCycle(f.store, { project: f.project, packet: reference(packet),
    dispatch: { adapter: reference(adapter), config: reference(environment) }, role: 'implementer' }));
  const offers = (ref: Ref) => batch.items.map(item => ({ gap: item.record, result: ref, candidate: null }));
  return { m, batch, cycle, packet, offers };
}
const ownTerminal = (f: ReturnType<typeof fixture>, evaluation: Ref) => ok(readAnswersEvaluationAt(f.store, f.project, evaluation)).groups
  .filter(group => group.proof.value.cause.emission === 'mc2-terminal' && group.proof.value.contribution.kind === 'existing');

test('R2 R6 R7 №1770 H1.0c an own MC2 terminal is the existing E4 ground of the check; the full G4b stays negative; its exact reading holds', async t => {
  for (const [end, reason] of [['cannot_answer', 'refused'], ['off-form', 'off-form'], ['interrupted', 'interrupted'],
    ['need_owner', 'awaiting-owner']] as const) await t.test(end, async child => {
    const f = fixture(child), n = await nodeTerminal(f, f.block, end, `negative-${end}`);
    const cycle = n.cycle.record.value;
    assert.notEqual(cycle.terminal, 'assembled'); assert.ok(cycle.diagnostic);
    const saved = ok(evaluate(f, n.m, n.offers(reference(n.cycle.record))));
    const own = ownTerminal(f, reference(saved.evaluation));
    assert.equal(own.length, n.batch.items.length);
    for (const group of own) {
      assert.deepEqual(group.proof.value.contribution, { kind: 'existing', producer: 'E4-terminal',
        basis: [reference(n.cycle.record), cycle.diagnostic] });
      assert.equal(group.proof.value.finding.code, 'answer_missing_for_blocking_gap');
      assert.equal(group.proof.value.cause.detail.outcome, reason, 'The reason is the E4 diagnostic\'s, not G4b\'s');
    }
    const gate = ok(readAnswersGate(f.store, { project: f.project, record: saved.evaluation.value.gate }));
    assert.equal(gate.value.result.passed, false, 'A negative MC2 never fills the gap: no C5 is admitted');
    const work = n.m.work();
    assert.equal(work.answers?.complete, true, 'The own terminal completes the check');
    assert.deepEqual(work.accepting, []);
    const read = ok(readAnswersEvaluationAt(f.store, f.project, reference(saved.evaluation)));
    f.restart();
    assert.deepEqual(ok(readAnswersEvaluationAt(f.store, f.project, reference(saved.evaluation))), read, 'The saved evaluation reads exactly');
    assert.deepEqual(ok(evaluate(f, n.m, n.offers(reference(n.cycle.record)))).evaluation, saved.evaluation, 'An exact repeat adds nothing');
  });
});

test('R8 №1770 H1.0c a cycle that ends without progress after source reads: the exact completed cycle, not its last call, stands for the root', async t => {
  const f = fixture(t), n = await nodeTerminal(f, f.block, 'research-no-progress', 'negative-reads');
  assert.equal(n.cycle.record.value.terminal, 'research-no-progress');
  assert.equal(n.cycle.record.value.steps.length, 2, 'Both source requests were paid before the root ended');
  const saved = ok(evaluate(f, n.m, n.offers(reference(n.cycle.record))));
  assert.ok(ownTerminal(f, reference(saved.evaluation)).length);
  assert.equal(n.m.work().answers?.complete, true);
});

test('R9 R1 R3 №1770 H1.0c a foreign MC2 terminal or a bare E4 call is no own ground; a neighbour\'s terminal stays the neighbour\'s; each negative attempt closes by its own G7', async t => {
  const f = fixture(t);
  const a = await nodeTerminal(f, 'garden-produce-block', 'cannot_answer', 'negative-a');
  const b = await nodeTerminal(f, 'garden-consume-block', 'cannot_answer', 'negative-b');
  // Another block's genuine terminal offered for this attempt's own gaps: a wrong submission, the check stays open.
  const foreign = ok(evaluate(f, a.m, a.offers(reference(b.cycle.record))));
  const groups = ok(readAnswersEvaluationAt(f.store, f.project, reference(foreign.evaluation))).groups;
  assert.ok(groups.some(group => group.proof.value.cause.emission === 'mc2-terminal-foreign'
    && group.proof.value.finding.code === 'record_foreign'));
  assert.equal(ownTerminal(f, reference(foreign.evaluation)).length, 0);
  assert.equal(a.m.work().answers?.complete, false);
  // The bare physical call is not the terminal of the root: no existing ground by the absence of an assembly (R1).
  const call = a.cycle.record.value.steps[0]!.record;
  const bare = ok(evaluate(f, a.m, a.offers({ id: call.id, revision: call.revision, hash: call.hash })));
  assert.equal(ownTerminal(f, reference(bare.evaluation)).length, 0);
  assert.equal(a.m.work().answers?.complete, false);
  // The neighbour's genuine terminal for its own gaps, with the own one: only the own gaps get the existing ground.
  const both = ok(evaluate(f, a.m, [...a.offers(reference(a.cycle.record)), ...b.offers(reference(b.cycle.record))]));
  const own = ownTerminal(f, reference(both.evaluation));
  assert.equal(own.length, a.batch.items.length);
  assert.ok(own.every(group => a.batch.items.some(item => same(item.record, group.proof.value.cause.gap))));
  assert.equal(a.m.work().answers?.complete, true);
  // R3: with both terminals in the submission, each negative attempt closes by its own G7 as refused, without waiting.
  ok(evaluate(f, b.m, [...a.offers(reference(a.cycle.record)), ...b.offers(reference(b.cycle.record))]));
  for (const [n, block] of [[a, 'garden-produce-block'], [b, 'garden-consume-block']] as const) {
    const address = { project: f.project, block, line: 1, attempt: 1 };
    const claim = ok(prepareManagedClaim(f.store, { ...address, outcome: { reason: 'result', accepting: [], cancelling: [], refusals: [] } }));
    assert.equal(claim.outcome.reason, 'refused', block);
    ok(closeAttempt(f.store, { ...address, outcome: claim.outcome }));
    assert.equal(f.store.get<{ attempts: { outcome: { reason: string } | null }[] }>(n.m.series.id)!.value.attempts[0]!.outcome!.reason, 'refused');
  }
});

