import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { Store, type Write, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { Question } from '../src/discovery/discovery.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import { projectGraph } from '../src/graph/project.js';
import type { Graph } from '../src/graph/model.js';
import { historicalTrace, withHistoricalReads, writeOmInput, readOmInput, prepareOmInput, buildOmInput, type InputStages, type InputBuildResult, type OmInputRecord } from '../src/om/input.js';
import { applyAddressing, applyInputDecisions, inputDecisionWrite, prepareAddressing, writeAddressing,
  prepareApplyAnswer, writeApplyAnswer, prepareReopenAnswers, writeReopenAnswers, ADDRESSING_CODES, ADDRESSING_KINDS, normalizeInputDecisionProposal,
  type AddressingRequest, type ApplyAnswerRequest, type InputFieldDecision } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { fillObligations, prepareFrame } from '../src/om/frame-obligations.js';
import { writeGaps, readGaps, type GapRequest } from '../src/om/gaps.js';
import { mc1FieldSpec, writeMc1Question, prepareAcceptedAnswer, writeAcceptedAnswer, readAcceptedAnswer,
  type AnswerQuestionContract, type AnswerRequest, type Mc1QuestionRequest } from '../src/om/accepted-answer.js';
import { prepareGapLines, writeGapLines, readGapLines, gapLineKey, gapLineExpectedResult, type GapLinesRequest } from '../src/om/gap-lines.js';
import { confirmResults } from '../src/om/achievements.js';
import { openSeries } from '../src/om/series.js';
import { openAttempt } from '../src/om/repeat-gate.js';
import { writeGuarded } from '../src/om/refs.js';
import { writeCandidate } from '../src/om/frame-candidate.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import { readLayerAcceptance } from '../src/om/layer-basis.js';
import type { OmResult, Sealed } from '../src/om/refusal.js';
import { createOmFixture, gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

const clone = structuredClone;
const block = 'garden-produce-block', otherBlock = 'garden-consume-block', question = 'discovery:output-format';
const fakeRef: Ref = { id: 'decision:test', revision: 1, hash: '1'.repeat(64) };
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function refused(result: OmResult<unknown>, code?: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) { if (code) assert.equal(result.refusal.code, code); assert.ok(result.refusal.at.target); }
}
function fixture(t: TestContext, unknowns: Json[] = [{ id: 'output-format',
  question: 'Which output format does the repository support?', consumer: block,
  blocksCurrentStage: false, resolution: 'Read repository facts during OM' }]) {
  const root = mkdtempSync(join(tmpdir(), 'omg-addressing-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let engine = new ProductEngine(store);
  const { level: _level, ...l1 } = projectGraph(gardenGraph(), 1), project = 'garden';
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = unknowns;
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const input = ok(writeOmInput(store, { project, expected: 0, stages })) as Revision<OmInputRecord>;
  const graph = store.get<Graph>(`graph:${project}`)!;
  return { get store() { return store; }, get engine() { return engine; }, root, project, input, graph, stages,
    restart() { store.close(); store = new Store(path); engine = new ProductEngine(store); },
    pure(): InputBuildResult { return clone({ input: input.value.input, hash: input.value.hash, gaps: input.value.gaps, refusals: [] }); },
    request(base: Ref = reference(input), field: InputFieldDecision['field'] = 'address', target = question,
      value: Json = { consumer: block, kind: 'repository-fact' }): AddressingRequest {
      return { project, input: base, graph: reference(graph), decisions: [{ pending: clone(inputDecisionWrite({ project,
        input: base, graph: reference(graph), layers: [], decision: { target, field, value } })) as Write }] };
    },
  };
}
function gapRequest(f: ReturnType<typeof fixture>, input: Revision<OmInputRecord> | Sealed<Revision<OmInputRecord>>, version: string): GapRequest {
  const horizon = ok(writeHorizon(f.store, { project: f.project, input: reference(input), graph: reference(f.graph),
    refinement: null, available: {}, choice: { choiceVersion: version, features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame = { project: f.project, level: 2 as const, graph: reference(f.graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null };
  ok(prepareFrame(f.store, frame));
  return { project: f.project, input: reference(input), graph: reference(f.graph), horizon: reference(horizon.gate),
    operations: { frame, proposals: [] }, works: { state: 'upper-not-accepted', layer: reference(f.store.get('graph-layer:garden:2')!) } };
}

function factFixture(t: TestContext) {
  const f = fixture(t), input = ok(writeAddressing(f.store, f.request()));
  function gapsFor(inputRef: Ref) {
    const current = ok(readOmInput(f.store, f.project, inputRef));
    const sources = gapRequest(f, current, `fact-application-${inputRef.revision}`);
    const gaps = ok(writeGaps(f.store, sources));
    return { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference), gap: gaps.records.find(row => row.value.gap.target === question) };
  }
  const gaps = gapsFor(reference(input));
  assert.equal(gaps.gap!.value.gap.code, 'predecessor_question');
  assert.equal(gaps.gap!.value.gap.kind, 'repository-fact');
  assert.deepEqual(gaps.gap!.value.gap.routes, ['code', 'research']);
  const command = { executable: process.execPath, args: ['-e',
    `const req=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{verdict:'supported',reasons:[]}}));`] };
  const environment = f.engine.environments.configure(f.project, { workspace: f.root,
    implementer: { actor: 'fact-researcher', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'fact-assessor', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000 }, 0);
  writeFileSync(join(f.root, 'answer.json'), JSON.stringify({ answer: 'JSON' }));
  const source = f.engine.discovery.evidence.file(f.project, 'answer-source', f.root, 'answer.json', 'application/json', 0);
  function issue(current = gaps, resultForm: Json = { type: 'string' }) {
    const gap = current.gap;
    assert.ok(gap, 'MC1 requires the complete D1 set to contain the addressed question');
    const currentInput = ok(readOmInput(f.store, f.project, current.sources.input));
    const requestContract: AnswerQuestionContract = { establishes: currentInput.value.input.questions.find(row => row.id === question)!.question,
      consumer: { blocks: [...gap.value.gap.consumers] }, requirements: [clone(currentInput.value.input.contracts[0]!) as unknown as Json], resultForm };
    const draft = f.engine.discovery.create(f.project, 'om-g2', 'R1', block,
      [mc1FieldSpec({ input: current.sources.input, gap: reference(gap), contract: requestContract })], [current.sources.input, reference(gap)]);
    const issued = f.store.get<Question>(draft.value.questions[0]!)!;
    const request: Mc1QuestionRequest = { project: f.project, input: current.sources.input,
      gaps: { sources: current.sources, records: current.records }, gap: reference(gap), contract: requestContract,
      requirements: [{ pointer: '/contracts/0' }], engineQuestion: reference(issued), draft: reference(draft) };
    const saved = ok(writeMc1Question(f.store, request));
    return { request, question: saved, issued, draft };
  }
  async function answer(q = issue(), attempt: AnswerRequest['attempt'] = null, value: Json = 'JSON') {
    const assessment = await assessAnswer(f.store, q.issued, { action: 'answer', question: q.issued.id, value,
      citations: [{ source: reference(f.store.get(source.id)!), selector: { kind: 'json-pointer', pointer: '/answer' } }] }, environment, f.root);
    const draft = f.engine.discovery.researched(q.issued.id, q.issued.revision, reference(assessment));
    const answered = f.store.get<Question>(q.issued.id)!;
    const request: AnswerRequest = { project: f.project, question: reference(q.question), answer: answered.value.answer!,
      answeredQuestion: reference(answered), draft: reference(draft), attempt };
    return { ...q, assessment, answered, answeredDraft: draft, request };
  }
  async function accept(q = issue(), attempt: AnswerRequest['attempt'] = null, value: Json = 'JSON') {
    const answered = await answer(q, attempt, value), saved = ok(writeAcceptedAnswer(f.store, answered.request));
    const prepared = ok(prepareAcceptedAnswer(f.store, answered.request));
    return { ...answered, saved, prepared, closure: prepared.closure };
  }
  return { ...f, input, gaps, source, environment, target: question, block,
    get store() { return f.store; }, get engine() { return f.engine; }, gapsFor, issue, answer, accept,
    refreshInventory() {
      const prior = f.store.get('repo-inventory:garden');
      const inventory = f.store.write({ id: 'repo-inventory:garden', kind: 'repo-inventory', expected: prior?.revision ?? 0,
        value: { projectId: f.project, paths: [] } });
      return ok(writeOmInput(f.store, { project: f.project, stages: f.stages,
        expected: f.store.get(input.id)!.revision, inventory: reference(inventory) }));
    },
    changeEvidence(value: Json, advance = true) {
      writeFileSync(join(f.root, 'answer.json'), JSON.stringify({ answer: value }));
      return advance ? f.engine.discovery.evidence.file(f.project, 'answer-source', f.root, 'answer.json', 'application/json',
        f.store.get(source.id)!.revision) : f.store.get(source.id)!;
    },
  };
}

test('D3.1 native fact precondition retains the active D1 gap until application and refuses premature line closure', async t => {
  const f = factFixture(t), accepted = await f.accept();
  const checked = ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(accepted.saved) }));
  assert.equal(checked.record.value.value, 'JSON');
  assert.equal(accepted.closure.reason, 'filled');
  assert.deepEqual(accepted.closure.basis, reference(accepted.saved));
  const linesRequest: GapLinesRequest = { project: f.project, pass: 1, previous: null,
    gaps: { sources: f.gaps.sources, records: f.gaps.records }, closures: [] };
  const lines = ok(writeGapLines(f.store, linesRequest));
  const before = f.store.list().map(reference);
  refused(prepareGapLines(f.store, { ...linesRequest, pass: 2, previous: reference(lines), closures: [accepted.closure] }));
  refused(writeGapLines(f.store, { ...linesRequest, pass: 2, previous: reference(lines), closures: [accepted.closure] }));
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(ok(readGaps(f.store, linesRequest.gaps)).collection.gaps.some(gap => gap.target === question && gap.field === 'answer'), true);
  f.restart();
  assert.deepEqual(ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(accepted.saved) })), checked);
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(f.input))), f.input);
});

test('D3 native first pass addresses a question through B1, horizon, frame and D1; history and repeat survive restart', t => {
  const f = fixture(t), initial = gapRequest(f, f.input, 'before-addressing');
  const initialGaps = ok(writeGaps(f.store, initial));
  assert.equal(initialGaps.records.find(row => row.value.gap.target === question)!.value.gap.code, 'question_unaddressed');
  const request = f.request(), before = f.store.list().map(reference), prepared = ok(prepareAddressing(f.store, request));
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(prepared.writes.length, 2); // the pending MC2 proposal and its checked derived input commit together
  const addressed = ok(writeAddressing(f.store, request)), q = addressed.value.input.questions[0]!;
  assert.equal(q.kind, 'repository-fact'); assert.equal(q.consumer, block); assert.equal(q.originalConsumer, block);
  assert.equal(q.question, f.input.value.input.questions[0]!.question); assert.deepEqual(q.source, f.input.value.input.questions[0]!.source);
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(addressed))), addressed);
  assert.deepEqual(ok(prepareOmInput(f.store, { project: f.project, stages: f.stages, expected: addressed.revision })).record, addressed.value);
  const sources = gapRequest(f, addressed, 'after-addressing'), gaps = ok(writeGaps(f.store, sources));
  const gap = gaps.records.find(row => row.value.gap.target === question)!.value.gap;
  assert.equal(gap.code, 'predecessor_question'); assert.equal(gap.field, 'answer'); assert.equal(gap.kind, 'repository-fact');
  assert.deepEqual(gap.routes, ['code', 'research']);
  const saved = f.store.list().map(reference); f.restart();
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(addressed))), addressed);
  ok(readGaps(f.store, { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) }));
  assert.deepEqual(ok(writeAddressing(f.store, request)), addressed); assert.deepEqual(f.store.list().map(reference), saved);
  // Historic input remains legal after an upstream proof moves; new preparation may no longer reuse it.
  const source = f.store.get('source:garden:brief')!;
  f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(addressed))), addressed);
  refused(prepareAddressing(f.store, request), 'stage_not_accepted');
});

test('F5.3 fills only absent producer fields, preserves original text, and never answers the question', t => {
  const f = fixture(t), base = f.pure(), original = canonical(base), graph = f.graph.value as Graph;
  const decision = { question, consumer: block, kind: 'repository-fact' as const, basis: fakeRef };
  const accepted = applyAddressing(base, [decision], graph);
  assert.deepEqual(accepted.refusals, []); assert.equal(accepted.result.input!.questions[0]!.kind, 'repository-fact');
  assert.equal(accepted.result.input!.questions.length, 1); assert.equal(canonical(base), original); assert.equal(Object.isFrozen(base), false);
  assert.equal(Object.isFrozen(accepted.result.input!.questions[0]), true);
  assert.deepEqual(applyAddressing(accepted.result as InputBuildResult, [decision], graph), accepted);
  assert.equal(applyAddressing(accepted.result as InputBuildResult, [{ ...decision, kind: 'design-decision' }], graph).refusals[0]!.code, 'addressing_conflict');
  assert.equal(applyAddressing(base, [{ ...decision, consumer: otherBlock }], graph).refusals[0]!.code, 'addressing_overrides_producer');
  const kindKnown = f.pure(); kindKnown.input!.questions[0]!.consumer = 'operator in prose'; kindKnown.input!.questions[0]!.kind = 'environment-confirmation'; kindKnown.hash = hashJson(kindKnown.input);
  assert.equal(applyAddressing(kindKnown, [decision], graph).refusals[0]!.code, 'addressing_overrides_producer');
  const filled = applyAddressing(kindKnown, [{ ...decision, kind: 'environment-confirmation' }], graph);
  assert.deepEqual(filled.refusals, []); assert.equal(filled.result.input!.questions[0]!.originalConsumer, 'operator in prose');
  assert.equal(filled.result.input!.questions[0]!.kind, 'environment-confirmation');
});

test('D3 fills contract blocks, ownership boundaries and criterion kind without rewriting supplied fields', t => {
  const f = fixture(t), base = f.pure(), graph = f.graph.value as Graph;
  const contract = base.input!.contracts[0]!, criterion = base.input!.criteria[0]!;
  const decisions: InputFieldDecision[] = [
    { target: contract.id, field: 'nodes', value: [block], basis: fakeRef },
    { target: contract.id, field: 'state', value: { writer: block, authority: block, rollback: otherBlock }, basis: fakeRef },
    { target: criterion.id, field: 'checkKind', value: 'test', basis: fakeRef },
  ];
  const applied = applyInputDecisions(base, decisions, graph);
  assert.deepEqual(applied.refusals, []);
  assert.ok(!applied.result.gaps.some(gap => ['contract_node_unbound', 'contract_boundary_prose', 'acceptance_kind_missing'].includes(gap.code)));
  assert.deepEqual(applied.result.input!.contracts[0]!.nodes, [block]);
  assert.equal(applied.result.input!.contracts[0]!.state.durability, contract.state.durability);
  assert.equal(applied.result.input!.criteria[0]!.checkKind, 'test');
  assert.deepEqual(applyInputDecisions(applied.result as InputBuildResult, decisions, graph), applied);
  for (const altered of [{ ...decisions[0]!, value: [otherBlock] }, { ...decisions[1]!, value: { writer: otherBlock } },
    { ...decisions[2]!, value: 'full-run' }])
    assert.equal(applyInputDecisions(applied.result as InputBuildResult, [altered], graph).refusals[0]!.code, 'addressing_overrides_producer');
  const request = f.request(reference(f.input), 'nodes', contract.id, [block]);
  request.decisions.push(...f.request(reference(f.input), 'state', contract.id, decisions[1]!.value).decisions,
    ...f.request(reference(f.input), 'checkKind', criterion.id, 'test').decisions);
  const saved = ok(writeAddressing(f.store, request));
  assert.deepEqual(saved.value.input, applied.result.input);
  f.restart(); assert.deepEqual(ok(readOmInput(f.store, f.project, reference(saved))), saved);
});

test('D3 reports every semantic refusal and refuses unknown IDs, enums, duplicate and unsupported fields', t => {
  const f = fixture(t), graph = f.graph.value as Graph, base = f.pure(), seen = new Set<string>();
  const bad: InputFieldDecision[] = [
    { target: question, field: 'address', value: { consumer: 'missing', kind: 'repository-fact' }, basis: fakeRef },
    { target: question, field: 'address', value: { consumer: block, kind: 'fact' }, basis: fakeRef },
    { target: 'absent-question', field: 'address', value: { consumer: block, kind: 'repository-fact' }, basis: fakeRef },
    { target: question, field: 'address', value: { consumer: otherBlock, kind: 'repository-fact' }, basis: fakeRef },
    { target: 'garden-B1', field: 'nodes', value: ['garden-product'], basis: fakeRef },
    { target: 'garden-B1', field: 'nodes', value: [], basis: fakeRef },
    { target: 'garden-B1', field: 'nodes', value: [block, block], basis: fakeRef },
    { target: 'missing', field: 'nodes', value: [block], basis: fakeRef },
    { target: 'garden-B1', field: 'state', value: { writer: 'unknown' }, basis: fakeRef },
    { target: 'garden-B1', field: 'state', value: { durability: block }, basis: fakeRef },
    { target: 'garden-R1#1', field: 'checkKind', value: 'perhaps', basis: fakeRef },
    { target: 'missing', field: 'checkKind', value: 'test', basis: fakeRef },
    { target: question, field: 'answer' as InputFieldDecision['field'], value: 'JSON', basis: fakeRef },
  ];
  for (const decision of bad) {
    const result = applyInputDecisions(base, [decision], graph);
    assert.equal(result.refusals.length, 1); assert.ok(result.refusals[0]!.at.field); seen.add(result.refusals[0]!.code);
    assert.deepEqual(result.result, base);
  }
  const valid: InputFieldDecision = { target: question, field: 'address', value: { consumer: block, kind: 'repository-fact' }, basis: fakeRef };
  assert.equal(applyInputDecisions(base, [valid, valid], graph).refusals[0]!.code, 'addressing_invalid');
  const accepted = applyInputDecisions(base, [valid], graph);
  seen.add(applyInputDecisions(accepted.result as InputBuildResult, [{ ...valid, basis: { ...fakeRef, revision: 2 } }], graph).refusals[0]!.code);
  const wrongBase = f.request(); const pending = wrongBase.decisions[0]! as { pending: Write };
  const body = clone(pending.pending.value) as Record<string, any>; body.input = { ...reference(f.input), revision: 10 };
  pending.pending = inputDecisionWrite(body as any) as Write;
  const failed = prepareAddressing(f.store, wrongBase); refused(failed, 'addressing_source_invalid');
  if (!failed.ok) seen.add(failed.refusal.code);
  assert.deepEqual([...seen].sort(), [...ADDRESSING_CODES].sort());
});

test('D3 rejects missing arguments and malformed complete sets before reading or mutating storage', t => {
  const f = fixture(t), base = f.pure(), graph = f.graph.value as Graph;
  const addressed = (error: unknown) => error instanceof EngineError && error.code === 'addressing_request_invalid';
  for (const value of [undefined, null, {}, 'decisions']) assert.throws(() => applyInputDecisions(base, value as any, graph), addressed);
  for (const field of ['input', 'hash', 'gaps', 'refusals']) {
    const malformed = clone(base) as any; delete malformed[field];
    assert.throws(() => applyInputDecisions(malformed, [], graph), addressed);
  }
  for (const field of ['target', 'field', 'value', 'basis']) {
    const decision: any = { target: question, field: 'address', value: { consumer: block, kind: 'repository-fact' }, basis: fakeRef }; delete decision[field];
    assert.throws(() => applyInputDecisions(base, [decision], graph), addressed);
  }
  for (const field of ['project', 'input', 'graph', 'decisions']) {
    const malformed = f.request() as any; delete malformed[field];
    assert.throws(() => prepareAddressing(f.store, malformed), addressed);
  }
  const rejected = { ...base, input: null, hash: null, refusals: [{ code: 'contract_node_unbound', message: 'Required in this era', route: 'producer' as const, at: { unit: 'G1', target: 'garden-B1' } }] };
  assert.equal(applyInputDecisions(rejected, [], graph).refusals[0]!.code, 'addressing_invalid');
  assert.deepEqual(applyInputDecisions(base, [], graph).result, base);
  assert.equal(Object.isFrozen(ADDRESSING_KINDS), true);
});

test('D3 accepts no status, foreign graph, unaccepted lower consumer, or substituted proposal in place of checked sources', t => {
  const f = fixture(t), before = f.store.list().map(reference);
  const cases: AddressingRequest[] = [];
  const statusOnly = f.request();
  (statusOnly.decisions[0] as { pending: Write }).pending.value = { status: 'accepted', project: f.project };
  cases.push(statusOnly);
  const foreign = f.request(); foreign.graph = { ...foreign.graph, id: 'graph:garden-other' }; cases.push(foreign);
  const lower = f.request(reference(f.input), 'address', question, { consumer: 'garden-produce-operation', kind: 'repository-fact' }); cases.push(lower);
  const wrongHash = f.request(); const write = (wrongHash.decisions[0] as { pending: Write }).pending;
  write.id = write.id.replace(/.$/, write.id.endsWith('0') ? '1' : '0'); cases.push(wrongHash);
  for (const request of cases) {
    refused(prepareAddressing(f.store, request)); refused(writeAddressing(f.store, request));
    assert.deepEqual(f.store.list().map(reference), before);
  }
});

test('D3 guard closure aborts every pending record and a neighbour when a prerequisite changes', t => {
  const f = fixture(t), request = f.request(), prepared = ok(prepareAddressing(f.store, request));
  const proof = f.store.get('source:garden:brief')!;
  assert.ok(prepared.guards.some(ref => ref.id === proof.id));
  f.store.write({ id: proof.id, kind: proof.kind, expected: proof.revision, value: proof.value });
  const before = f.store.list().map(reference);
  refused(writeGuarded(f.store, { unit: 'D3-neighbour', target: 'neighbour', guards: prepared.guards,
    writes: [...prepared.writes, { id: 'neighbour', kind: 'test', expected: 0, value: {} }] }), 'input_stale');
  assert.deepEqual(f.store.list().map(reference), before);
  refused(prepareAddressing(f.store, request), 'stage_not_accepted');
});

test('D3 saved proposal guards reject a newer proposal revision before writing the input', t => {
  const f = fixture(t), request = f.request(), pending = (request.decisions[0] as { pending: Write }).pending;
  const proposal = f.store.write(pending); request.decisions = [{ record: reference(proposal) }];
  const prepared = ok(prepareAddressing(f.store, request));
  f.store.write({ id: proposal.id, kind: proposal.kind, expected: proposal.revision, value: proposal.value });
  refused(writeGuarded(f.store, { unit: 'F5.3', target: f.input.id, writes: prepared.writes, guards: prepared.guards }), 'input_stale');
  assert.equal(f.store.get(f.input.id)!.revision, 1);
});

test('D3 exact replay has complete current guards and late delivery preserves a later decision', t => {
  const f = fixture(t), request = f.request(), addressed = ok(writeAddressing(f.store, request));
  const nextRequest = f.request(reference(addressed), 'checkKind', 'garden-R1#1', 'test'), later = ok(writeAddressing(f.store, nextRequest));
  const before = f.store.list().map(reference);
  assert.deepEqual(ok(writeAddressing(f.store, request)), addressed);
  assert.deepEqual(f.store.get(later.id), later); assert.deepEqual(f.store.list().map(reference), before);
  const replay = ok(prepareAddressing(f.store, request)); assert.deepEqual(replay.writes, []);
  const proof = f.store.get('source:garden:brief')!;
  assert.ok(replay.guards.some(ref => ref.id === proof.id));
  f.store.write({ id: proof.id, kind: proof.kind, expected: proof.revision, value: proof.value });
  refused(writeGuarded(f.store, { unit: 'replay-neighbour', target: 'neighbour', guards: replay.guards,
    writes: [{ id: 'neighbour', kind: 'test', expected: 0, value: {} }] }), 'input_stale');
  f.restart(); assert.deepEqual(ok(readOmInput(f.store, f.project, reference(later))), later);
});


test('D3 cannot address a required field rejected by the real G1 era contract', t => {
  const f = fixture(t);
  const sources = Object.fromEntries(UPSTREAM_STAGES.map(stage => {
    const row = f.store.get<any>(f.stages[stage].id)!;
    const draft = f.store.get<any>(row.value.content.draft.id, row.value.content.draft.revision)!;
    return [stage, { ref: reference(row), contractVersion: draft.value.contractVersion, fields: row.value.content.fields }];
  })) as InputStages;
  const rejected = buildOmInput(sources, { nodesRequiredSince: 3 });
  assert.equal(rejected.input, null); assert.ok(rejected.refusals.some(r => r.code === 'contract_node_unbound'));
  const decision: InputFieldDecision = { target: 'garden-B1', field: 'nodes', value: [block], basis: fakeRef };
  const result = applyInputDecisions(rejected as InputBuildResult, [decision], f.graph.value as Graph);
  assert.equal(result.refusals[0]!.code, 'addressing_invalid'); assert.deepEqual(result.result, rejected);
});

test('D3 environment addressing stays an open task-start obligation and preserves own JSON keys', t => {
  const f = fixture(t), request = f.request(reference(f.input), 'address', question, { consumer: block, kind: 'environment-confirmation' });
  const addressed = ok(writeAddressing(f.store, request));
  const gaps = ok(writeGaps(f.store, gapRequest(f, addressed, 'environment-addressed')));
  const gap = gaps.records.find(row => row.value.gap.target === question)!.value.gap;
  assert.equal(gap.code, 'predecessor_question'); assert.equal(gap.kind, 'environment-confirmation');
  assert.equal(gap.moment, 'task-start'); assert.equal(gap.blocking, false);
  const pure = f.pure();
  Object.defineProperty(pure.input!.contracts[0]!.state, '__proto__', { value: { sensitive: true }, enumerable: true });
  pure.hash = hashJson(pure.input);
  const result = applyAddressing(pure, [{ question, consumer: block, kind: 'repository-fact', basis: fakeRef }], f.graph.value as Graph);
  assert.deepEqual(result.refusals, []);
  assert.equal(Object.hasOwn(result.result.input!.contracts[0]!.state, '__proto__'), true);
  assert.deepEqual(result.result.input!.contracts[0]!.state['__proto__'], { sensitive: true });
});


test('D3 canonical nodes proposals retain one identity across permutations, late delivery and restart', t => {
  const f = fixture(t), target = f.input.value.input.contracts[0]!.id;
  const first = f.request(reference(f.input), 'nodes', target, [block, otherBlock]);
  const reverse = f.request(reference(f.input), 'nodes', target, [otherBlock, block]);
  assert.deepEqual(first, reverse);
  const accepted = ok(writeAddressing(f.store, first));
  const after = f.store.list().map(reference);
  assert.deepEqual(ok(writeAddressing(f.store, reverse)), accepted);
  assert.deepEqual(f.store.list().map(reference), after);
  const later = ok(writeAddressing(f.store, f.request(reference(accepted), 'checkKind', 'garden-R1#1', 'test')));
  f.restart();
  const latest = f.store.list().map(reference);
  assert.deepEqual(ok(writeAddressing(f.store, reverse)), accepted);
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(later))), later);
  assert.deepEqual(f.store.list().map(reference), latest);
  const duplicate = f.request(reference(later), 'nodes', target, [block, otherBlock, block]);
  const offered = (duplicate.decisions[0] as { pending: Write }).pending.value as any;
  assert.equal(normalizeInputDecisionProposal(offered).decision.value instanceof Array, true);
  assert.equal((normalizeInputDecisionProposal(offered).decision.value as readonly Json[]).length, 3);
  refused(writeAddressing(f.store, duplicate), 'addressing_invalid');
  assert.deepEqual(f.store.list().map(reference), latest);
  const layers = [{ id: 'graph-layer:garden:2', revision: 1, hash: '2'.repeat(64) },
    { id: 'graph-layer:garden:3', revision: 1, hash: '3'.repeat(64) }];
  const shape = { ...offered, layers };
  assert.deepEqual(inputDecisionWrite(shape), inputDecisionWrite({ ...shape, layers: [...layers].reverse() }));
  assert.equal(normalizeInputDecisionProposal({ ...shape, layers: [...layers, layers[0]!] }).layers.length, 3);
});

for (const level of [2, 3] as const) test(`D3 research lower admission L${level} rejects stale assessments before preparation and atomically at write while accepted history survives`, async t => {
  const f = await createOmFixture(t), input = ok(writeOmInput(f.store, { project: f.project, expected: 0,
    stages: Object.fromEntries(Object.entries(f.stages).map(([stage, row]) => [stage, reference(row)])) as Record<UpstreamStage, Ref> }));
  const layer = f.layers[level], consumer = level === 2 ? 'garden-produce-operation' : 'garden-produce-work';
  const basis = { project: f.project, graph: reference(f.graphRevision), layers: [reference(layer)] };
  const request = (base: Ref, role: string): AddressingRequest => ({ project: f.project, input: base, graph: basis.graph,
    decisions: [{ pending: inputDecisionWrite({ ...basis, input: base, decision: {
      target: input.value.input.contracts[0]!.id, field: 'state', value: { [role]: consumer } } }) as Write }] });
  const accepted = ok(writeAddressing(f.store, request(reference(input), 'writer')));
  const next = request(reference(accepted), 'authority'), prepared = ok(prepareAddressing(f.store, next));
  const phase = level === 2 ? 'R1' : 'R2', gate = f.engine.refinement.gate(f.project, phase);
  assert.deepEqual(gate.findings, []);
  const milestone = f.store.get<{ draft: Ref }>(`phase:${f.project}:${phase}`)!;
  const draft = f.store.get<{ questions: string[] }>(milestone.value.draft.id, milestone.value.draft.revision)!;
  const questions = new Set(draft.value.questions);
  const assessment = gate.guards.map(ref => f.store.get<{ question: Ref }>(ref.id, ref.revision))
    .find(row => row?.kind === 'research-assessment' && questions.has(row.value.question.id))!;
  assert.ok(assessment);
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(assessment))));
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(layer))));
  f.store.write({ id: assessment.id, kind: assessment.kind, expected: assessment.revision, value: assessment.value });
  assert.ok(f.engine.refinement.gate(f.project, phase).findings.some(finding => finding.code === 'phase_stale'));
  const before = f.store.list().map(reference);
  refused(prepareAddressing(f.store, next)); refused(writeAddressing(f.store, next));
  refused(writeGuarded(f.store, { unit: 'D3', target: input.id, guards: prepared.guards,
    writes: [...prepared.writes, { id: 'neighbor:research', kind: 'test', expected: 0, value: {} }] }), 'input_stale');
  assert.deepEqual(f.store.list().map(reference), before);
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(accepted))), accepted);
  f.reopen(); assert.deepEqual(ok(readOmInput(f.store, f.project, reference(accepted))), accepted);
  refused(prepareAddressing(f.store, next));
});

function acceptOperations(f: ReturnType<typeof fixture>) {
  const sources = gapRequest(f, f.input, 'lower-admission'), frame = sources.operations.frame;
  const initial = ok(prepareFrame(f.store, frame)), graph = gardenGraph(), projected = projectGraph(graph, 2);
  const fills = ok(fillObligations(initial.upper as Graph, initial.scope as any, {
    graph, reference: { ...frame.graph, hash: hashJson(graph) }, frame: null }, initial.upperRef, 2));
  const proposal = {
    base: { graph: frame.graph, frame: null }, level: 2, source: 'decision', status: 'proposed',
    nodes: projected.nodes.filter(node => node.kind === 'operation'),
    fills: fills.fills.map(fill => ({ obligation: fill.obligation, node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) })).filter(connector => connector.bindings.length),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors,
    tests: projected.tests, edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [],
    transfers: projected.transfers ?? [], removes: [], replaces: [], redefines: [],
  };
  const offered = f.store.write({ id: 'om-proposal:garden:address-lower', kind: 'layer-proposal', expected: 0, value: proposal });
  const candidate = ok(writeCandidate(f.store, { frame, proposals: [reference(offered)] }));
  if (candidate.state !== 'candidate') assert.fail('An explicit complete operations candidate is required');
  const ref = reference(candidate.record);
  return ok(settleCandidate(f.store, { project: f.project, level: 2, candidate: ref,
    outcome: { gate: 'G3', candidate: ref, graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
}

test('D3 OM lower admission guards its own layer and current producer closure while retaining historical bases', t => {
  const f = fixture(t), operations = acceptOperations(f);
  assert.ok(operations.graph && operations.layer);
  const graph = reference(operations.graph), layer = reference(operations.layer);
  const request = (input: Ref, role: string): AddressingRequest => ({ project: f.project, input, graph,
    decisions: [{ pending: inputDecisionWrite({ project: f.project, input, graph, layers: [layer], decision: {
      target: f.input.value.input.contracts[0]!.id, field: 'state', value: { [role]: 'garden-produce-operation' } } }) as Write }] });
  const firstRequest = request(reference(f.input), 'writer'), accepted = ok(writeAddressing(f.store, firstRequest));
  const next = request(reference(accepted), 'authority'), prepared = ok(prepareAddressing(f.store, next));
  const basis = ok(readLayerAcceptance(f.store, { project: f.project, level: 2, graph, layer }));
  assert.equal(basis.producer, 'om');
  for (const ref of [graph, layer, ...basis.currentReferences]) assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)), ref.id);
  f.store.write({ id: layer.id, kind: operations.layer.kind, expected: layer.revision, value: operations.layer.value });
  const before = f.store.list().map(reference);
  refused(prepareAddressing(f.store, next), 'input_stale'); refused(writeAddressing(f.store, next), 'input_stale');
  refused(writeGuarded(f.store, { unit: 'D3', target: f.input.id, guards: prepared.guards,
    writes: [...prepared.writes, { id: 'neighbor:om', kind: 'test', expected: 0, value: {} }] }), 'input_stale');
  assert.deepEqual(f.store.list().map(reference), before);
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(accepted))), accepted);
  f.restart(); assert.deepEqual(ok(readOmInput(f.store, f.project, reference(accepted))), accepted);
  assert.deepEqual(ok(writeAddressing(f.store, firstRequest)), accepted);
  refused(prepareAddressing(f.store, next), 'input_stale');
});

test('D3.1 native fact application rederives B1, complete D1 and closed D2 with the same achievement after restart', async t => {
  const f = factFixture(t), address = { project: f.project, block, line: 1 };
  const goal = { key: 'answer-output-format', questions: [gapLineKey(f.project, question, 'answer')], result: gapLineExpectedResult(f.project, question, 'answer') };
  ok(openSeries(f.store, { ...address, slice: 'fact-application', predecessor: null, basis: null }));
  const series = ok(openAttempt(f.store, { ...address, attempt: 1, goal }));
  const accepted = await f.accept(undefined, { series: reference(series), attempt: 1 });
  const opened = ok(writeGapLines(f.store, { project: f.project, pass: 1, previous: null, gaps: f.gaps, closures: [] }));
  const request: ApplyAnswerRequest = { project: f.project, input: reference(f.input), answer: reference(accepted.saved), question: reference(accepted.question) };
  const before = f.store.list().map(reference), prepared = ok(prepareApplyAnswer(f.store, request));
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(prepared.writes.length, 1);
  const applied = ok(writeApplyAnswer(f.store, request));
  assert.equal(applied.revision, f.input.revision + 1);
  assert.equal(applied.value.input.questions.some(q => q.id === question), false);
  assert.deepEqual(applied.value.input.facts, [{ question: f.input.value.input.questions[0], value: 'JSON',
    answer: reference(accepted.saved), mc1Question: reference(accepted.question) }]);
  assert.equal(applied.value.hash, hashJson(applied.value.input));
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(applied))), applied);
  assert.deepEqual(ok(prepareApplyAnswer(f.store, request)).writes, []);
  assert.deepEqual(ok(writeApplyAnswer(f.store, { ...request, input: reference(applied) })), applied);
  const current = f.gapsFor(reference(applied));
  assert.equal(current.gap, undefined);
  assert.ok(current.records.length > 0, 'Other gaps remain in the full D1 set');
  const close: GapLinesRequest = { project: f.project, pass: 2, previous: reference(opened), gaps: current, closures: [accepted.closure] };
  const closure = ok(prepareGapLines(f.store, close));
  assert.equal(f.store.get(opened.id)!.revision, opened.revision);
  assert.equal(closure.record.lines.find(line => line.target === question)!.status, 'closed');
  const closed = ok(writeGapLines(f.store, close));
  const line = closed.value.lines.find(line => line.target === question)!;
  assert.equal(line.status, 'closed'); assert.deepEqual(line.basis, reference(accepted.saved));
  const confirm = { project: f.project, block, target: series.id, goal, cancelling: [] };
  const answerKey = ok(confirmResults(f.store, { ...confirm, accepting: [reference(accepted.saved)] })).achieved[0]!.key;
  assert.equal(ok(confirmResults(f.store, { ...confirm, accepting: [reference(closed)] })).achieved[0]!.key, answerKey);
  const completed = f.store.list().map(reference);
  assert.deepEqual(ok(writeApplyAnswer(f.store, request)), applied);
  assert.deepEqual(ok(writeGapLines(f.store, close)), closed);
  assert.deepEqual(f.store.list().map(reference), completed);
  f.changeEvidence('XML'); f.restart();
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(applied))), applied);
  assert.deepEqual(ok(readGapLines(f.store, { project: f.project, record: reference(closed) })), closed);
  assert.equal(ok(confirmResults(f.store, { ...confirm, accepting: [reference(closed)] })).achieved[0]!.key, answerKey);
  refused(prepareApplyAnswer(f.store, request), 'answer_inapplicable');
  refused(prepareOmInput(f.store, { project: f.project, stages: f.stages, expected: applied.revision }), 'answer_inapplicable');
});

test('D3.1 independent inventory refresh preserves the fact contract, addressing and late delivery identity', async t => {
  const f = factFixture(t), accepted = await f.accept(), refreshed = f.refreshInventory();
  const request: ApplyAnswerRequest = { project: f.project, input: reference(refreshed), answer: reference(accepted.saved), question: reference(accepted.question) };
  const applied = ok(writeApplyAnswer(f.store, request));
  assert.deepEqual(applied.value.input.inventory, refreshed.value.input.inventory);
  assert.deepEqual(applied.value.input.facts![0]!.question.addressedBy, f.input.value.input.questions[0]!.addressedBy);
  const refreshedAgain = f.refreshInventory(), before = f.store.list().map(reference);
  assert.deepEqual(refreshedAgain.value.input.facts, applied.value.input.facts);
  assert.deepEqual(ok(writeApplyAnswer(f.store, request)), applied);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.equal(f.store.get(applied.id)!.revision, refreshedAgain.revision);
  f.restart();
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(refreshedAgain))), refreshedAgain);
  assert.deepEqual(ok(writeApplyAnswer(f.store, request)), applied);
});

test('D3.1 different contract and changed evidence refuse application without writing', async t => {
  const f = factFixture(t), accepted = await f.accept(), changed = f.issue(f.gaps, { type: 'string', enum: ['JSON'] });
  const request: ApplyAnswerRequest = { project: f.project, input: reference(f.input), answer: reference(accepted.saved), question: reference(accepted.question) };
  let before = f.store.list().map(reference);
  refused(prepareApplyAnswer(f.store, { ...request, question: reference(changed.question) }), 'answer_inapplicable');
  refused(writeApplyAnswer(f.store, { ...request, question: reference(changed.question) }), 'answer_inapplicable');
  assert.deepEqual(f.store.list().map(reference), before);
  for (const advance of [false, true]) {
    f.changeEvidence('XML', advance); before = f.store.list().map(reference);
    refused(prepareApplyAnswer(f.store, request), 'answer_inapplicable');
    refused(writeApplyAnswer(f.store, request), 'answer_inapplicable');
    assert.deepEqual(f.store.list().map(reference), before);
  }
  f.restart();
  ok(readAcceptedAnswer(f.store, { project: f.project, record: reference(accepted.saved) }));
  refused(writeApplyAnswer(f.store, request), 'answer_inapplicable');
});

test('D3.1 application guards include evidence, the exact fact, contract, base and stage proof; no partial neighbor write', async t => {
  for (const dependency of ['source', 'answer', 'question', 'input', 'stage-proof'] as const) await t.test(dependency, async child => {
    const f = factFixture(child), accepted = await f.accept();
    const request: ApplyAnswerRequest = { project: f.project, input: reference(f.input), answer: reference(accepted.saved), question: reference(accepted.question) };
    const prepared = ok(prepareApplyAnswer(f.store, request));
    const id = dependency === 'source' ? f.source.id : dependency === 'answer' ? accepted.saved.id : dependency === 'question'
      ? accepted.question.id : dependency === 'input' ? f.input.id : 'source:garden:brief';
    assert.ok(prepared.guards.some(ref => ref.id === id), `${dependency} must be guarded`);
    const old = f.store.get(id)!;
    f.store.write({ id, kind: old.kind, expected: old.revision, value: old.value });
    const before = f.store.list().map(reference);
    refused(writeGuarded(f.store, { unit: 'D3.1-test', target: f.input.id, guards: prepared.guards,
      writes: [...prepared.writes, { id: 'neighbor:application', kind: 'neighbor', expected: 0, value: {} }] }), 'input_stale');
    assert.deepEqual(f.store.list().map(reference), before);
    assert.equal(f.store.get('neighbor:application'), null);
  });
});

test('D3.1 forged applied values and altered answer references cannot survive historical B1 rederivation', async t => {
  for (const fault of ['value', 'question', 'basis'] as const) await t.test(fault, async child => {
    const f = factFixture(child), accepted = await f.accept();
    const request = { project: f.project, input: reference(f.input), answer: reference(accepted.saved), question: reference(accepted.question) };
    const prepared = ok(prepareApplyAnswer(f.store, request)), body = clone(prepared.record.value) as OmInputRecord;
    if (fault === 'value') body.input.facts![0]!.value = 'counterfeit';
    else if (fault === 'question') body.input.facts![0]!.question.consumer = otherBlock;
    else body.input.facts![0]!.answer.hash = 'f'.repeat(64);
    body.hash = hashJson(body.input);
    const forged = f.store.write({ id: f.input.id, kind: 'om-input', expected: f.input.revision, value: body });
    refused(readOmInput(f.store, f.project, reference(forged)), 'record_forged');
    f.restart(); refused(readOmInput(f.store, f.project, reference(forged)), 'record_forged');
  });
});

test('D3.1 rejects missing arguments, foreign or forged bases and status imitations before writing', async t => {
  const f = factFixture(t), accepted = await f.accept();
  const request: ApplyAnswerRequest = { project: f.project, input: reference(f.input), answer: reference(accepted.saved), question: reference(accepted.question) };
  const unreadable = new Proxy(f.store, { get(target, key) {
    if (key === 'get') return () => assert.fail('Malformed arguments must not access storage');
    const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const malformed: unknown[] = [undefined, null, [], {}];
  for (const field of ['project', 'input', 'answer', 'question']) for (const value of [undefined, null, 42]) malformed.push({ ...request, [field]: value });
  for (const fn of [prepareApplyAnswer, writeApplyAnswer]) for (const value of malformed)
    assert.throws(() => fn(unreadable, value as ApplyAnswerRequest), (error: unknown) => error instanceof EngineError
      && error.code === 'addressing_request_invalid' && !!error.details);
  for (const fn of [prepareApplyAnswer, writeApplyAnswer])
    refused(fn(f.store, { ...request, project: 'missing-project' }), 'addressing_source_invalid');
  for (const change of [{ answer: { ...request.answer, id: 'om-answer:other:foreign' } },
    { answer: { ...request.answer, hash: 'f'.repeat(64) } }, { question: { ...request.question, hash: 'e'.repeat(64) } },
    { input: { ...request.input, id: 'om-input:other' } }]) {
    const before = f.store.list().map(reference);
    refused(prepareApplyAnswer(f.store, { ...request, ...change })); refused(writeApplyAnswer(f.store, { ...request, ...change }));
    assert.deepEqual(f.store.list().map(reference), before);
  }
  const fake = f.store.write({ id: 'om-answer:garden:status-only', kind: 'accepted-answer', expected: 0,
    value: { project: f.project, target: question, value: 'JSON', status: 'accepted' } });
  const before = f.store.list().map(reference);
  refused(writeApplyAnswer(f.store, { ...request, answer: reference(fake) }));
  assert.deepEqual(f.store.list().map(reference), before);
});

test('D3.1 preserves literal accepted values and propagates execution exceptions without writes', async t => {
  for (const value of [false, 0, null, [], JSON.parse('{"__proto__":{"kept":true},"values":[2,1,1]}') as Json]) await t.test(canonical(value), async child => {
    const f = factFixture(child); f.changeEvidence(value);
    const accepted = await f.accept(f.issue(f.gaps, {}), null, value);
    const request = { project: f.project, input: reference(f.input), answer: reference(accepted.saved), question: reference(accepted.question) };
    const failure = new EngineError('record_corrupt', 'Injected storage failure'), before = f.store.list().map(reference);
    const broken = new Proxy(f.store, { get(target, key) {
      if (key === 'get') return (id: string, revision?: number) => { if (id === accepted.saved.id) throw failure; return target.get(id, revision); };
      const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    for (const fn of [prepareApplyAnswer, writeApplyAnswer]) assert.throws(() => fn(broken, request), error => error === failure);
    assert.deepEqual(f.store.list().map(reference), before);
    const applied = ok(writeApplyAnswer(f.store, request));
    assert.deepEqual(applied.value.input.facts![0]!.value, value);
    assert.equal(applied.value.hash, hashJson(applied.value.input));
    assert.deepEqual(ok(readOmInput(f.store, f.project, reference(applied))), applied);
  });
});

for (const advance of [true, false]) test(`D3.1 stale applied fact recovery completes D1 reopen and D5 reclosure after restart (source revision=${advance})`, async t => {
  const f = factFixture(t), address = { project: f.project, block, line: 1 };
  const goal = { key: 'recover-output-format', questions: [gapLineKey(f.project, question, 'answer')], result: gapLineExpectedResult(f.project, question, 'answer') };
  ok(openSeries(f.store, { ...address, slice: 'fact-recovery', predecessor: null, basis: null }));
  const series = ok(openAttempt(f.store, { ...address, attempt: 1, goal }));
  const attempt = { series: reference(series), attempt: 1 };
  const first = await f.accept(undefined, attempt);
  const opened = ok(writeGapLines(f.store, { project: f.project, pass: 1, previous: null, gaps: f.gaps, closures: [] }));
  const firstInput = ok(writeApplyAnswer(f.store, {
    project: f.project, input: reference(f.input), answer: reference(first.saved), question: reference(first.question) }));
  const closed = ok(writeGapLines(f.store, { project: f.project, pass: 2, previous: reference(opened),
    gaps: f.gapsFor(reference(firstInput)), closures: [first.closure] }));
  const confirmation = { project: f.project, block, target: series.id, goal, cancelling: [] };
  const originalKey = ok(confirmResults(f.store, { ...confirmation, accepting: [reference(closed)] })).achieved[0]!.key;
  const sourceRevision = f.store.get(f.source.id)!.revision;
  f.changeEvidence('XML', advance); f.restart();
  const request = { project: f.project, input: reference(firstInput) }, before = f.store.list().map(reference);
  refused(prepareOmInput(f.store, { project: f.project, stages: f.stages, expected: firstInput.revision }), 'answer_inapplicable');
  const prepared = ok(prepareReopenAnswers(f.store, request));
  assert.deepEqual(f.store.list().map(reference), before, 'Preparation must not write a Source or input');
  assert.equal(prepared.writes.some(write => write.id === f.source.id), !advance);
  const recovered = ok(writeReopenAnswers(f.store, request));
  assert.equal(f.store.get(f.source.id)!.revision, sourceRevision + 1);
  assert.deepEqual(recovered.value.input.questions.find(row => row.id === question), f.input.value.input.questions.find(row => row.id === question));
  assert.equal(recovered.value.input.facts?.some(fact => fact.question.id === question), false);
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(recovered))), recovered);
  assert.deepEqual(ok(prepareOmInput(f.store, { project: f.project, stages: f.stages, expected: recovered.revision })).record, recovered.value);
  refused(prepareApplyAnswer(f.store, { project: f.project, input: reference(recovered),
    answer: reference(first.saved), question: reference(first.question) }), 'answer_inapplicable');
  const resumed = f.gapsFor(reference(recovered));
  assert.ok(resumed.gap);
  assert.equal(resumed.gap.value.gap.code, 'predecessor_question');
  const reopened = ok(writeGapLines(f.store, { project: f.project, pass: 3, previous: reference(closed), gaps: resumed, closures: [] }));
  const line = reopened.value.lines.find(row => row.target === question)!;
  assert.equal(line.status, 'open'); assert.equal(line.reopened, 1); assert.equal(line.passes, 2);
  assert.equal(Object.hasOwn(line, 'basis'), false);
  assert.equal(ok(confirmResults(f.store, { ...confirmation, accepting: [reference(closed)] })).achieved[0]!.key, originalKey,
    'Reopening does not cancel the previously achieved result');
  f.restart();
  assert.deepEqual(ok(readGapLines(f.store, { project: f.project, record: reference(reopened) })), reopened);
  assert.deepEqual(ok(readGapLines(f.store, { project: f.project, record: reference(closed) })), closed);
  const repeatBefore = f.store.list().map(reference);
  assert.deepEqual(ok(writeReopenAnswers(f.store, request)), recovered);
  assert.deepEqual(f.store.list().map(reference), repeatBefore);
  const second = await f.accept(f.issue(resumed), attempt, 'XML');
  const secondInput = ok(writeApplyAnswer(f.store, { project: f.project, input: reference(recovered),
    answer: reference(second.saved), question: reference(second.question) }));
  const resolved = f.gapsFor(reference(secondInput)); assert.equal(resolved.gap, undefined);
  const closedAgain = ok(writeGapLines(f.store, { project: f.project, pass: 4, previous: reference(reopened),
    gaps: resolved, closures: [second.closure] }));
  const secondLine = closedAgain.value.lines.find(row => row.target === question)!;
  assert.equal(secondLine.status, 'closed'); assert.equal(secondLine.reopened, 1); assert.equal(secondLine.passes, 2);
  assert.deepEqual(secondLine.basis, reference(second.saved));
  const newKey = ok(confirmResults(f.store, { ...confirmation, accepting: [reference(closedAgain)] })).achieved[0]!.key;
  assert.notEqual(newKey, originalKey);
  f.restart();
  for (const row of [firstInput, recovered, secondInput]) assert.deepEqual(ok(readOmInput(f.store, f.project, reference(row))), row);
  for (const row of [closed, reopened, closedAgain]) assert.deepEqual(ok(readGapLines(f.store, { project: f.project, record: reference(row) })), row);
  const after = f.store.list().map(reference);
  assert.deepEqual(ok(writeReopenAnswers(f.store, request)), recovered, 'Late recovery cannot withdraw the new confirmation');
  assert.deepEqual(ok(writeReopenAnswers(f.store, { project: f.project, input: reference(secondInput) })), secondInput);
  assert.deepEqual(f.store.list().map(reference), after);
  assert.equal(f.store.get(firstInput.id)!.revision, secondInput.revision);
  assert.equal(ok(confirmResults(f.store, { ...confirmation, accepting: [reference(closed)] })).achieved[0]!.key, originalKey);
});

test('D3.1 recovery protects source, input and stage dependencies in the shared transaction', async t => {
  for (const dependency of ['source', 'input', 'stage-proof'] as const) await t.test(dependency, async child => {
    const f = factFixture(child), accepted = await f.accept(), applied = ok(writeApplyAnswer(f.store, {
      project: f.project, input: reference(f.input), answer: reference(accepted.saved), question: reference(accepted.question) }));
    f.changeEvidence('XML', false);
    const request = { project: f.project, input: reference(applied) }, prepared = ok(prepareReopenAnswers(f.store, request));
    const id = dependency === 'source' ? f.source.id : dependency === 'input' ? f.input.id : 'source:garden:brief';
    assert.ok(prepared.guards.some(guard => guard.id === id), `${dependency} has a current guard`);
    const old = f.store.get(id)!;
    f.store.write({ id, kind: old.kind, expected: old.revision, value: old.value });
    const before = f.store.list().map(reference);
    refused(writeGuarded(f.store, { unit: 'D3.1', target: applied.id, guards: prepared.guards,
      writes: [...prepared.writes, { id: 'neighbor:recovery', kind: 'test', expected: 0, value: {} }] }), 'input_stale');
    assert.deepEqual(f.store.list().map(reference), before);
    assert.equal(f.store.get('neighbor:recovery'), null);
    assert.equal(f.store.get(applied.id)!.revision, applied.revision + (dependency === 'input' ? 1 : 0));
    if (dependency === 'stage-proof') refused(writeReopenAnswers(f.store, request));
  });
});

test('D3.1 recovery refuses malformed requests before reading and foreign input without writes', async t => {
  const f = factFixture(t);
  const inaccessible = new Proxy(f.store, { get(target, key) {
    if (key === 'get') return () => assert.fail('Malformed requests must not read');
    const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  for (const fn of [prepareReopenAnswers, writeReopenAnswers]) {
    for (const request of [null, {}, { project: f.project }, { project: '', input: reference(f.input) }])
      assert.throws(() => fn(inaccessible, request as any), (error: unknown) => error instanceof EngineError && error.code === 'addressing_request_invalid');
    const before = f.store.list().map(reference);
    refused(fn(f.store, { project: f.project, input: { ...reference(f.input), id: 'om-input:other' } }));
    assert.deepEqual(f.store.list().map(reference), before);
  }
});

test('D3.1 historical recovery cannot be forged by a stale marker or by retaining the withdrawn value', async t => {
  for (const fault of ['unchanged-source', 'foreign-source', 'retained-value'] as const) await t.test(fault, async child => {
    const f = factFixture(child), accepted = await f.accept(), applied = ok(writeApplyAnswer(f.store, {
      project: f.project, input: reference(f.input), answer: reference(accepted.saved), question: reference(accepted.question) }));
    f.changeEvidence('XML');
    const request = { project: f.project, input: reference(applied) }, prepared = ok(prepareReopenAnswers(f.store, request));
    const body = clone(prepared.record.value) as OmInputRecord;
    assert.ok(body.derivation && 'kind' in body.derivation && body.derivation.kind === 'reopen-facts');
    const pair = body.derivation.invalidations[0]!.sources[0]!;
    if (fault === 'unchanged-source') pair.after = pair.before;
    else if (fault === 'foreign-source') pair.after = reference(f.store.get('source:garden:brief')!);
    else body.input.facts = clone(applied.value.input.facts!) as NonNullable<OmInputRecord['input']['facts']>;
    body.hash = hashJson(body.input);
    const forged = f.store.write({ id: applied.id, kind: applied.kind, expected: applied.revision, value: body });
    refused(readOmInput(f.store, f.project, reference(forged)));
    f.restart(); refused(readOmInput(f.store, f.project, reference(forged)));
  });
});

type PhysicalReads = { body: number; footprint: number };
type ProofSample = { bodies: Map<string, number>; physical: Map<string, PhysicalReads>; all: PhysicalReads };
interface AddressingCostMonitor { sample: ProofSample | null }
const addressingCost = () => (globalThis as typeof globalThis & { __addressingCost?: AddressingCostMonitor }).__addressingCost;
// Actual proof entries and physical reads are different counters. The subprocess instruments only
// these bodies in memory; it does not modify the production modules or run another test's fixture.
async function costSubprocess(t: TestContext): Promise<boolean> {
  if (addressingCost()) return false;
  const directory = mkdtempSync(join(tmpdir(), 'omg-addressing-cost-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const loader = join(directory, 'loader.mjs'), preload = join(directory, 'preload.mjs');
  const root = new URL('../', import.meta.url).href;
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  writeFileSync(loader, `import ts from ${JSON.stringify(typescript)};
const root=${JSON.stringify(root)}, monitor='globalThis.__addressingCost';
export async function load(url, context, next) {
 const result=await next(url,context);
 if(!url.startsWith(root)||result.format!=='module')return result;
 const file=url.slice(root.length);
 if(!['src/om/input.js','src/om/accepted-answer.js','src/storage/store.js'].includes(file))return result;
 let source=String(result.source);
 const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS), edits=[], found=new Set();
 function add(body,code){edits.push({pos:body.getStart(tree)+1,text:code});}
 function visit(node){
  if((ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node))&&node.name&&node.body){
   const name=node.name.getText(tree);
   if(file==='src/om/input.js'&&name==='readInputRecord'){add(node.body,monitor+".hit('B1',store,project,ref);");found.add(name);}
   if(file==='src/om/accepted-answer.js'&&name==='checkAcceptedRecord'){add(node.body,monitor+".hit('D5',store,project,{id:record.id,revision:record.revision,hash:record.hash});");found.add(name);}
   if(file==='src/om/accepted-answer.js'&&name==='loadMc1Question'){
    const statement=node.body.statements.find(item=>ts.isReturnStatement(item)), action=statement?.expression?.arguments?.[2];
    if(!action||!ts.isArrowFunction(action)||!ts.isBlock(action.body))throw new Error('The MC1 full verifier is absent');
    add(action.body,monitor+".hit('MC1',store,request.project,request.record);");found.add(name);
   }
   if(file==='src/storage/store.js'&&name==='get'){
    add(node.body,'return '+monitor+'.read(this,id,revision,()=>{');edits.push({pos:node.body.end-1,text:'});'});found.add(name);
   }
  }
  ts.forEachChild(node,visit);
 }
 visit(tree);
 const expected=file==='src/om/input.js'?['readInputRecord']:file==='src/storage/store.js'?['get']:['checkAcceptedRecord','loadMc1Question'];
 for(const name of expected)if(!found.has(name))throw new Error('Full proof body absent: '+name);
 for(const edit of edits.sort((a,b)=>b.pos-a.pos))source=source.slice(0,edit.pos)+edit.text+source.slice(edit.pos);
 if(file==='src/om/input.js')source+='\\n'+monitor+'.view=sourceView;'+monitor+'.footprint=()=>checkingFootprint>0;';
 return {...result,source};
}`);
  writeFileSync(preload, `import {register} from 'node:module';
register(${JSON.stringify(loader)},import.meta.url);
const views=new WeakMap();let nextView=0;
globalThis.__addressingCost={sample:null,view:store=>store,footprint:()=>false,
 hit(reader,store,project,ref){const sample=this.sample;if(!sample)return;const view=this.view(store);
  if(!views.has(view))views.set(view,++nextView);
  const key=JSON.stringify({reader,project,ref,view:views.get(view)});sample.bodies.set(key,(sample.bodies.get(key)||0)+1);},
 read(store,id,revision,action){const sample=this.sample,category=this.footprint()?'footprint':'body';
  if(sample)sample.all[category]++;
  const row=action();
  if(sample&&row&&revision!==undefined&&/^(om-input|om-answer|om-mc1-question):/.test(id)){
   const key=JSON.stringify({id:row.id,revision:row.revision,hash:row.hash}), counts=sample.physical.get(key)||{body:0,footprint:0};
   counts[category]++;sample.physical.set(key,counts);
  }return row;}
};`);
  const name = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = await promisify(execFile)(process.execPath,
    ['--import', preload, '--test', `--test-name-pattern=^${name}$`, fileURLToPath(import.meta.url)],
    { maxBuffer: 4 * 1024 * 1024, env: environment }).catch((error: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`${error.message}\n${error.stdout ?? ''}${error.stderr ?? ''}`, { cause: error });
  });
  assert.match(result.stdout, /# fail 0/);
  return true;
}
function measureProof<T>(action: () => OmResult<T>): { value: T; sample: ProofSample } {
  const monitor = addressingCost()!;
  assert.equal(monitor.sample, null);
  const sample: ProofSample = { bodies: new Map(), physical: new Map(), all: { body: 0, footprint: 0 } };
  monitor.sample = sample;
  try {
    const value = ok(action());
    for (const [key, count] of sample.bodies) assert.equal(count, 1, `A full proof runs once per exact version and semantic view: ${key}`);
    return { value, sample };
  } finally { monitor.sample = null; }
}
function inputPhysical(sample: ProofSample, id: string): [number, number][] {
  return [...sample.physical].flatMap(([key, counts]) => {
    const ref = JSON.parse(key) as Ref;
    return ref.id === id ? [[ref.revision, counts.body + counts.footprint] as [number, number]] : [];
  }).sort(([a], [b]) => a - b);
}

test('D3.1 one historical read checks each exact input once across the repeated fact DAG and releases its cache', async t => {
  if (await costSubprocess(t)) return;
  const f = factFixture(t), accepted = await f.accept(), applied = ok(writeApplyAnswer(f.store, {
    project: f.project, input: reference(f.input), answer: reference(accepted.saved), question: reference(accepted.question) }));
  let failure: Error | null = null;
  const get = f.store.get.bind(f.store);
  f.store.get = <V = Json>(id: string, revision?: number): Revision<V> | null => {
    if (id === applied.id && revision !== undefined && failure) throw failure;
    return get<V>(id, revision);
  };
  const observed = historicalTrace(f.store);
  const read = () => measureProof(() => readOmInput(observed, f.project, reference(applied)));
  const first = read();
  assert.deepEqual(first.value, applied);
  assert.deepEqual(inputPhysical(first.sample, applied.id), [[1, 1], [2, 1], [3, 1]]);
  assert.equal([...first.sample.bodies].filter(([key]) => JSON.parse(key).reader === 'B1').length, 3);
  withHistoricalReads(() => {
    const cold = read(), warm = read();
    assert.deepEqual(warm.value, cold.value);
    assert.equal(warm.sample.bodies.size, 0);
    assert.equal(warm.sample.physical.size, 0, 'Repeated paths to immutable inputs do not add body or footprint reads');
  });
  failure = new EngineError('record_corrupt', 'A later invocation must read again');
  assert.throws(read, error => error === failure);
  failure = null;
  const retried = read();
  assert.deepEqual(retried.value, applied);
  assert.deepEqual(inputPhysical(retried.sample, applied.id), [[1, 1], [2, 1], [3, 1]]);
});

// Four real MC1 facts with literal requirement pointers. Hash buckets keep later insertions from
// moving an already issued pointer; only native, independently assessed answers are used.
async function dependentFacts(t: TestContext) {
  const targets = { A: question, B: 'discovery:dependent-format', C: 'discovery:independent-format', D: 'discovery:downstream-format' };
  type Role = keyof typeof targets;
  const f = fixture(t, Object.values(targets).map(target => ({ id: target.slice('discovery:'.length),
    question: `Which value establishes ${target}?`, consumer: block, blocksCurrentStage: false, resolution: 'Read repository evidence' })));
  let input = ok(writeAddressing(f.store, { ...f.request(), decisions: Object.values(targets).flatMap(target =>
    f.request(reference(f.input), 'address', target).decisions) }));
  const command = { executable: process.execPath, args: ['-e',
    `const r=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{verdict:'supported',reasons:[]}}));`] };
  const environment = f.engine.environments.configure(f.project, { workspace: f.root,
    implementer: { actor: 'dependency-researcher', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'dependency-assessor', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000 }, 0);
  function gaps() {
    const sources = gapRequest(f, input, `dependent-facts-${input.revision}`), saved = ok(writeGaps(f.store, sources));
    return { sources: structuredClone(saved.sources) as GapRequest, records: saved.records.map(reference), rows: saved.records };
  }
  function source(role: Role, value: string) {
    const file = `${role}.json`, id = `source:garden:dependency-${role}`, old = f.store.get(id);
    writeFileSync(join(f.root, file), JSON.stringify({ answer: value }));
    return f.engine.discovery.evidence.file(f.project, `dependency-${role}`, f.root, file, 'application/json', old?.revision ?? 0);
  }
  async function fill(role: Role, value: string, dependency: Role | null) {
    const currentGaps = gaps(), target = targets[role], gap = currentGaps.rows.find(row => row.value.gap.target === target)!;
    assert.ok(gap);
    const index = dependency === null ? -1 : input.value.input.facts!.findIndex(fact => fact.question.id === targets[dependency]);
    if (dependency !== null) assert.ok(index >= 0);
    const pointer = dependency === null ? '/contracts/0' : `/facts/${index}/value`;
    const requirement = dependency === null ? input.value.input.contracts[0]! as unknown as Json : input.value.input.facts![index]!.value as Json;
    const contract: AnswerQuestionContract = { establishes: input.value.input.questions.find(row => row.id === target)!.question,
      consumer: { blocks: [...gap.value.gap.consumers] }, requirements: [requirement], resultForm: { type: 'string' } };
    const evidence = source(role, value), bucket = { A: 0, C: 1, B: 2, D: 3 }[role];
    for (let trial = 0; trial < 128; trial++) {
      const draft = f.engine.discovery.create(f.project, 'om-g2', 'R1', block,
        [mc1FieldSpec({ input: reference(input), gap: reference(gap), contract })], [reference(input), reference(gap)]);
      const issued = f.store.get<Question>(draft.value.questions[0]!)!;
      const mc1 = ok(writeMc1Question(f.store, { project: f.project, input: reference(input),
        gaps: currentGaps, gap: reference(gap), contract, requirements: [{ pointer }], engineQuestion: reference(issued), draft: reference(draft) }));
      const assessment = await assessAnswer(f.store, issued, { action: 'answer', question: issued.id, value,
        citations: [{ source: reference(evidence), selector: { kind: 'json-pointer', pointer: '/answer' } }] }, environment, f.root);
      const answeredDraft = f.engine.discovery.researched(issued.id, issued.revision, reference(assessment)), answered = f.store.get<Question>(issued.id)!;
      const request: AnswerRequest = { project: f.project, question: reference(mc1), answer: answered.value.answer!,
        answeredQuestion: reference(answered), draft: reference(answeredDraft), attempt: null };
      const acceptance = ok(prepareAcceptedAnswer(f.store, request));
      if (Math.floor(parseInt(acceptance.record.hash[0]!, 16) / 4) !== bucket) continue;
      const accepted = ok(writeAcceptedAnswer(f.store, request)), closure = acceptance.closure;
      input = ok(writeApplyAnswer(f.store, { project: f.project, input: reference(input), answer: reference(accepted), question: reference(mc1) }));
      return { accepted, closure, source: evidence, input };
    }
    assert.fail('Could not retain the native literal requirement index within the fixture bound');
  }
  const A = await fill('A', 'JSON', null), C = await fill('C', 'fixed', null), B = await fill('B', 'buffered JSON', 'A');
  // After removing A, /facts/2/value temporarily selects D itself with the same value as B.
  // Only the next round (which removes B) breaks D, distinguishing a fixed point from one pass.
  const D = await fill('D', 'buffered JSON', 'B');
  assert.deepEqual(input.value.input.facts!.map(fact => fact.question.id), [targets.A, targets.C, targets.B, targets.D]);
  return { f, targets, A, B, C, D, source, fill, gaps, get input() { return input; },
    recovered(next: Sealed<Revision<OmInputRecord>>) { input = next; } };
}

test('D3.1 recovery closes A to B to D contracts, preserves C, proves reasons and permits reconfirmation after restart', async t => {
  const x = await dependentFacts(t), { f, targets } = x, original = x.input, independent = clone(original.value.input.facts!.find(fact => fact.question.id === targets.C)!) as NonNullable<OmInputRecord['input']['facts']>[number];
  x.source('A', 'XML'); f.restart();
  const request = { project: f.project, input: reference(original) }, before = f.store.list().map(reference);
  const prepared = ok(prepareReopenAnswers(f.store, request));
  assert.deepEqual(f.store.list().map(reference), before);
  const body = prepared.record.value, derivation = body.derivation;
  assert.ok(derivation && 'kind' in derivation && derivation.kind === 'reopen-facts');
  assert.deepEqual(derivation.invalidations.map(item => item.record), [reference(x.A.accepted)]);
  const b = derivation.dependencies!.find(item => item.record.id === x.B.accepted.id)!;
  const d = derivation.dependencies!.find(item => item.record.id === x.D.accepted.id)!;
  assert.equal(derivation.dependencies!.length, 2);
  assert.deepEqual(b.removed, [reference(x.A.accepted)]);
  assert.deepEqual(b.conditions, [{ pointer: '/facts/0/value', before: 'JSON', after: { present: true, value: 'fixed' } }]);
  assert.deepEqual(d.removed.map(canonical).sort(), [reference(x.A.accepted), reference(x.B.accepted)].map(canonical).sort());
  assert.deepEqual(d.conditions, [{ pointer: '/facts/2/value', before: 'buffered JSON', after: { present: false } }]);
  assert.deepEqual(body.input.facts, [independent]);
  assert.deepEqual(body.input.questions.map(row => row.id).sort(), [targets.A, targets.B, targets.D].sort());
  for (const value of [x.B, x.C, x.D]) for (const ref of [reference(value.accepted), reference(value.source)])
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)), `A dependent or surviving fact needs guard ${ref.id}`);

  // Each counterexample is actually persisted with recomputed hashes in a temporary fork of the
  // full native history, then read again after reopening that database.
  const variants = ['cause', 'condition', 'missing', 'extra-independent'] as const;
  for (const fault of variants) {
    const path = join(f.root, `forged-${fault}.sqlite`); copyFileSync(join(f.root, 'state.sqlite'), path);
    let branch = new Store(path);
    try {
      const forgedBody = clone(body) as OmInputRecord;
      assert.ok(forgedBody.derivation && 'kind' in forgedBody.derivation && forgedBody.derivation.kind === 'reopen-facts');
      const dependencies = forgedBody.derivation.dependencies!;
      if (fault === 'cause') dependencies[0]!.removed = [reference(x.C.accepted)];
      if (fault === 'condition') dependencies[0]!.conditions[0]!.before = 'invented';
      if (fault === 'missing') delete forgedBody.derivation.dependencies;
      if (fault === 'extra-independent') {
        dependencies.push({ ...clone(dependencies[0]!), record: reference(x.C.accepted), question: independent.mc1Question });
        forgedBody.input.facts = []; forgedBody.input.questions.push(independent.question);
      }
      forgedBody.hash = hashJson(forgedBody.input);
      const forged = branch.write({ id: original.id, kind: original.kind, expected: original.revision, value: forgedBody });
      refused(readOmInput(branch, f.project, reference(forged)), 'record_forged');
      branch.close(); branch = new Store(path);
      refused(readOmInput(branch, f.project, reference(forged)), 'record_forged');
    } finally { branch.close(); }
  }
  for (const row of [x.B.source, x.C.source, x.D.source]) {
    const path = join(f.root, `race-${row.id.split(':').at(-1)}.sqlite`); copyFileSync(join(f.root, 'state.sqlite'), path);
    const branch = new Store(path);
    try {
      branch.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
      const beforeRace = branch.list().map(reference);
      refused(writeGuarded(branch, { unit: 'D3.1', target: original.id, guards: prepared.guards,
        writes: [...prepared.writes, { id: 'neighbor:dependency-recovery', kind: 'test', expected: 0, value: {} }] }), 'input_stale');
      assert.deepEqual(branch.list().map(reference), beforeRace);
    } finally { branch.close(); }
  }
  const recovered = ok(writeReopenAnswers(f.store, request)); x.recovered(recovered);
  const gaps = x.gaps(), actualTargets = gaps.rows.map(row => row.value.gap.target);
  for (const target of [targets.A, targets.B, targets.D]) assert.ok(actualTargets.includes(target));
  assert.equal(actualTargets.includes(targets.C), false);
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(original))), original);
  f.restart();
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(recovered))), recovered);
  const stable = f.store.list().map(reference);
  assert.deepEqual(ok(writeReopenAnswers(f.store, request)), recovered);
  assert.deepEqual(f.store.list().map(reference), stable);
  const newA = await x.fill('A', 'XML', null), newB = await x.fill('B', 'buffered XML', 'A'), newD = await x.fill('D', 'buffered XML', 'B');
  const complete = x.gaps();
  for (const target of Object.values(targets)) assert.equal(complete.rows.some(row => row.value.gap.target === target), false);
  assert.deepEqual(x.input.value.input.facts!.find(fact => fact.question.id === targets.C), independent);
  f.restart();
  for (const row of [original, recovered, newA.input, newB.input, newD.input]) assert.deepEqual(ok(readOmInput(f.store, f.project, reference(row))), row);
  const final = f.store.list().map(reference);
  assert.deepEqual(ok(writeReopenAnswers(f.store, request)), recovered);
  assert.deepEqual(f.store.list().map(reference), final);
  assert.deepEqual(reference(f.store.get(original.id)!), reference(newD.input));
});

async function independentFactPrefixes(t: TestContext) {
  const targets = Array.from({ length: 4 }, (_, index) => `discovery:cost-${index + 1}`);
  const f = fixture(t, targets.map(target => ({ id: target.slice('discovery:'.length), question: `Which value establishes ${target}?`,
    consumer: block, blocksCurrentStage: false, resolution: 'Read repository evidence' })));
  let input = ok(writeAddressing(f.store, { ...f.request(), decisions: targets.flatMap(target =>
    f.request(reference(f.input), 'address', target).decisions) }));
  const command = { executable: process.execPath, args: ['-e',
    `const r=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{verdict:'supported',reasons:[]}}));`] };
  const environment = f.engine.environments.configure(f.project, { workspace: f.root,
    implementer: { actor: 'cost-researcher', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'cost-assessor', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000 }, 0);
  const prefixes: { count: number; path: string; input: Ref }[] = [];
  for (const [index, target] of targets.entries()) {
    const sources = gapRequest(f, input, `cost-${input.revision}`), gaps = ok(writeGaps(f.store, sources));
    const gap = gaps.records.find(row => row.value.gap.target === target)!;
    const contract: AnswerQuestionContract = { establishes: input.value.input.questions.find(row => row.id === target)!.question,
      consumer: { blocks: [...gap.value.gap.consumers] }, requirements: [clone(input.value.input.contracts[0]!) as unknown as Json],
      resultForm: { type: 'string' } };
    const value = `value-${index}`, file = `cost-${index}.json`;
    writeFileSync(join(f.root, file), JSON.stringify({ answer: value }));
    const source = f.engine.discovery.evidence.file(f.project, `cost-${index}`, f.root, file, 'application/json', 0);
    const draft = f.engine.discovery.create(f.project, 'om-g2', 'R1', block,
      [mc1FieldSpec({ input: reference(input), gap: reference(gap), contract })], [reference(input), reference(gap)]);
    const issued = f.store.get<Question>(draft.value.questions[0]!)!;
    const question = ok(writeMc1Question(f.store, { project: f.project, input: reference(input),
      gaps: { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) }, gap: reference(gap), contract,
      requirements: [{ pointer: '/contracts/0' }], engineQuestion: reference(issued), draft: reference(draft) }));
    const assessment = await assessAnswer(f.store, issued, { action: 'answer', question: issued.id, value,
      citations: [{ source: reference(source), selector: { kind: 'json-pointer', pointer: '/answer' } }] }, environment, f.root);
    const answeredDraft = f.engine.discovery.researched(issued.id, issued.revision, reference(assessment)), answered = f.store.get<Question>(issued.id)!;
    const accepted = ok(writeAcceptedAnswer(f.store, { project: f.project, question: reference(question), answer: answered.value.answer!,
      answeredQuestion: reference(answered), draft: reference(answeredDraft), attempt: null }));
    input = ok(writeApplyAnswer(f.store, { project: f.project, input: reference(input), answer: reference(accepted), question: reference(question) }));
    if ([1, 2, 4].includes(index + 1)) {
      f.restart();
      const path = join(f.root, `prefix-${index + 1}.sqlite`); copyFileSync(join(f.root, 'state.sqlite'), path);
      prefixes.push({ count: index + 1, path, input: reference(input) });
    }
  }
  return { f, prefixes };
}

test('D3.1 operation history proves unique inputs and answers once per view at one, two and four facts', async t => {
  if (await costSubprocess(t)) return;
  const { f, prefixes } = await independentFactPrefixes(t);
  function measured<T>(action: () => OmResult<T>) {
    const result = measureProof(action);
    assert.ok(result.sample.bodies.size > 0, 'Every external operation must prove its exact history again');
    assert.ok(result.sample.physical.size > 0, 'Physical reads remain a checked cost, including footprint');
    return result;
  }
  const previousCommon = new Map<string, { proofs: number; counts: PhysicalReads }>();
  for (const prefix of prefixes) {
    writeFileSync(join(f.root, 'cost-0.json'), JSON.stringify({ answer: 'value-0' }));
    const store = new Store(prefix.path), engine = new ProductEngine(store);
    try {
      const request = { project: f.project, input: prefix.input };
      // Physical instrumentation lives in Store.get, so the ordinary public preparation
      // receives its original semantic Store rather than an artificial overlay.
      const observed = store;
      // Preparation has a base Store and an explicit pending-source overlay; their proofs stay separate.
      const idle = measured(() => prepareReopenAnswers(observed, request));
      assert.equal(idle.value.writes.length, 0);
      assert.equal(idle.value.record.value.input.facts!.length, prefix.count);
      for (const [ref, counts] of idle.sample.physical) {
        const proofs = [...idle.sample.bodies.keys()].filter(key =>
          canonical((JSON.parse(key) as { ref: Ref }).ref) === canonical(JSON.parse(ref))).length;
        assert.ok(proofs > 0, `Every exact physical foundation belongs to its proven history: ${ref}`);
        assert.equal(counts.body + counts.footprint, proofs,
          `An immutable foundation is fetched once for each distinct proof/view, including footprint cost: ${ref}`);
        const previous = previousCommon.get(ref);
        // A later fact may introduce another view of an earlier exact input. Only that new
        // proof/view permits another fetch; more paths within an existing view do not.
        if (previous && previous.proofs === proofs) assert.deepEqual(counts, previous.counts,
          `More fact paths must not multiply physical body/footprint reads of the same exact foundation: ${ref}`);
        previousCommon.set(ref, { proofs, counts });
      }
      const again = measured(() => prepareReopenAnswers(observed, request));
      assert.deepEqual(again.sample.physical, idle.sample.physical);
      assert.deepEqual(again.sample.all, idle.sample.all, 'A repeated external operation has the same total physical cost');
      assert.deepEqual(again.value, idle.value);
      const source = store.get('source:garden:cost-0')!;
      writeFileSync(join(f.root, 'cost-0.json'), JSON.stringify({ answer: 'changed' }));
      engine.discovery.evidence.file(f.project, 'cost-0', f.root, 'cost-0.json', 'application/json', source.revision);
      const prepared = measured(() => prepareReopenAnswers(observed, request));
      assert.equal(prepared.value.writes.length, 1, 'The next operation must observe the changed evidence head');
      assert.equal(prepared.value.record.value.input.facts!.length, prefix.count - 1);
      const saved = measured(() => writeReopenAnswers(observed, request)).value;
      assert.deepEqual(measured(() => readOmInput(observed, f.project, reference(saved))).value, saved);
      assert.deepEqual(measured(() => readOmInput(observed, f.project, reference(saved))).value, saved);
    } finally { store.close(); }
  }
});
