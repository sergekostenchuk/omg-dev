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
import { preparedField } from './preparation-fixture.js';
import { preparedFeatures } from './product-fixture.js';

const clone = structuredClone;
const adapterFixture = fileURLToPath(new URL('../../test/om-adapter-fixture.mjs', import.meta.url));
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function snapshot(store: Store): Ref[] { return store.list().map(reference); }

type QuestionKind = 'owner-decision' | 'repository-fact' | 'design-decision'
  | 'environment-confirmation' | 'post-implementation-proof' | null;
function fixture(t: TestContext, kind: QuestionKind = null, addressQuestion = true, secondQuestion = false) {
  const root = mkdtempSync(join(tmpdir(), 'omg-answers-gate-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  const engine = new ProductEngine(store), project = 'garden', block = 'garden-produce-block';
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const { level: _level, ...l1 } = projectGraph(gardenGraph(), 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
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
  return { root, path, project, target, block, input, graph, horizon, gaps, blocking, route, request, task,
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
