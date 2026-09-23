import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { Store, type Write, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { projectGraph } from '../src/graph/project.js';
import type { Graph } from '../src/graph/model.js';
import { writeOmInput, readOmInput, prepareOmInput, buildOmInput, type InputStages, type InputBuildResult, type OmInputRecord } from '../src/om/input.js';
import { applyAddressing, applyInputDecisions, inputDecisionWrite, prepareAddressing, writeAddressing,
  ADDRESSING_CODES, ADDRESSING_KINDS, normalizeInputDecisionProposal, type AddressingRequest, type InputFieldDecision } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { fillObligations, prepareFrame } from '../src/om/frame-obligations.js';
import { writeGaps, readGaps, type GapRequest } from '../src/om/gaps.js';
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
function refused<T>(result: OmResult<T>, code?: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) { if (code) assert.equal(result.refusal.code, code); assert.ok(result.refusal.at.target); }
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-addressing-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), { level: _level, ...l1 } = projectGraph(gardenGraph(), 1), project = 'garden';
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'output-format',
      question: 'Which output format does the repository support?', consumer: block,
      blocksCurrentStage: false, resolution: 'Read repository facts during OM' }];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const input = ok(writeOmInput(store, { project, expected: 0, stages })) as Revision<OmInputRecord>;
  const graph = store.get<Graph>(`graph:${project}`)!;
  return { get store() { return store; }, project, input, graph, stages,
    restart() { store.close(); store = new Store(path); },
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
  ok(readGaps(f.store, { sources, records: gaps.records.map(reference) }));
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
