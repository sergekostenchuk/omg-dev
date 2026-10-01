import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { preparedFeatures } from './product-fixture.js';
import { reference } from '../src/pipeline/contracts.js';
import { configureResearchScope } from '../src/graph/research-scope.js';
import { carriedObligations, type ObligationPolicy } from '../src/graph/obligation-policy.js';
import { bindTaskObligations, requireTaskObligations, taskBindingId, taskObligationHandoff, TASK_OBLIGATION_CONTRACT,
  type GapDeferralSlice } from '../src/graph/task-obligations.js';
import type { GapRecord } from '../src/om/gaps.js';
import { obligationHandoff } from '../src/graph/obligation-handoff.js';
import { layerDesignSpec, layerDesignOf } from '../src/graph/layer-design.js';
import { projectGraph } from '../src/graph/project.js';
import { layerDeltaCandidate, expandLayerDelta } from '../src/discovery/layer-delta.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import { nodeSignature } from '../src/compiler/model.js';
import type { Graph } from '../src/graph/model.js';
import type { Question } from '../src/discovery/discovery.js';
import { planningForQuestion } from '../src/discovery/research-routing.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';

// R6 (№2484): the structural slice stays honest — a real OM GapRecord is
// assignable to it, so the deferral read sees the actual stored field.
const gapRecordFitsSlice: GapRecord extends GapDeferralSlice ? true : never = true;
void gapRecordFitsSlice;

function fixture(t: test.TestContext, responsible = 'p-produce-block') {
  const root = mkdtempSync(join(tmpdir(), 'omg-task-obligations-')), store = new Store(join(root, 'db.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  preparedFeatures(engine, 'p'); const graph = store.get<Graph>('graph:p')!;
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 1000 }, 0);
  const gaps = [
    { id: 'result', target: responsible, field: 'tests', consumer: 'compilation', question: 'Prove the implemented result', requiredFor: 'next' as const },
    { id: 'environment', target: responsible, field: 'tests', consumer: 'compilation', question: 'Confirm the runtime before starting work', requiredFor: 'next' as const },
    { id: 'ui', target: 'p-consume-block', field: 'tests', consumer: 'compilation', question: 'UI proof when the UI path is included', requiredFor: 'next' as const },
  ];
  const draft = store.write({ id: 'fixture-r1', kind: 'discovery-draft', expected: 0, value: { projectId: 'p', fields: { technical: { gaps } } } });
  const r1 = store.write({ id: 'phase:p:R1', kind: 'phase', expected: 0, value: { projectId: 'p', draft: reference(draft) } });
  const original = configureResearchScope(store, { projectId: 'p', layer: reference(store.get('graph-layer:p:2')!), r1: reference(r1),
    outcome: 'Bound future proofs', nodes: ['p-produce-block'], boundaries: [], expansions: [], changedPaths: [], uiRequired: false,
    obligations: gaps.map(gap => ({ gap, state: gap.id === 'ui' ? 'deferred' : 'active', reason: 'Fixture assignment',
      wake: gap.id === 'ui' ? { nodes: [], paths: ['ui'], uiRequired: true } : null })) }, 0);
  const code = engine.discovery.evidence.document('p', 'check', 'export {};', 'text/plain', 0);
  const policy: ObligationPolicy = { version: 1, sourceScope: reference(original), assignments: gaps.map((gap, index) => ({
    obligation: gap.id, original: { record: reference(original), pointer: `/obligations/${index}/gap` },
    kind: index === 1 ? 'environment-confirmation' : 'post-implementation-proof', moment: index === 1 ? 'task-start' : 'task-result',
    responsibleNode: gap.target, responsibleConsumer: gap.consumer, neededForR2: false, reason: 'Not needed to decide R2', returnCondition: gap.question,
    ...(index === 1 ? { runtimeCheck: { script: reference(code), dependencies: [], subjects: [], executables: [], args: [], timeoutMs: 1000,
      purpose: gap.question, satisfies: gap.question } } : {}) })) };
  const scope = configureResearchScope(store, { ...original.value, policy }, 1);
  const r2Draft = engine.discovery.create('p', 'om-g2', 'R2', 'compilation', [{
    field: 'taskBindings', kind: 'design', prompt: 'Assign carried obligations to concrete task consumers',
    risk: 'A carried obligation could be left without an owning task', schema: { type: 'object' },
  }], [reference(scope)]);
  const r2 = store.write({ id: 'phase:p:R2', kind: 'phase', expected: 0, value: { projectId: 'p', phase: 'R2', draft: reference(r2Draft),
    inputs: [reference(scope)], carried: carriedObligations(scope), carriedContract: 'r3-v1' } });
  const handoff = obligationHandoff(store, 'p', [reference(r2)])!;
  const bound = structuredClone(graph.value); bound.researchObligations = handoff.obligations.filter(item => item.obligation !== 'ui').map(item => ({
    id: taskBindingId(item), scope: item.scope, obligation: item.obligation,
    consumers: [{ node: 'p-produce-work', tests: item.kind === 'post-implementation-proof' ? ['p-produce-work-test'] : [] }] }));
  const source = engine.discovery.evidence.document('p', 'basis', 'Fixture source for assessed layer proposal tests', 'text/plain', 0);
  return { root, store, engine, environment, graph, scope, original, handoff, bound, r2, source };
}

test('L3 names concrete consumers and carries exact owner assignments without changing the scope', t => {
  const f = fixture(t), result = requireTaskObligations(f.store, 'p', f.bound, f.handoff), values = result.get('p-produce-work')!;
  assert.equal(values.length, 2);
  assert.deepEqual(values.find(value => value.requirement.obligation === 'result')!.requirement, f.handoff.obligations[0]);
  assert.deepEqual(values.find(value => value.requirement.obligation === 'environment')!.tests, []);
  assert.deepEqual(f.store.get(f.scope.id), f.scope); assert.deepEqual(f.store.get(f.scope.id, 1), f.original);
  assert.equal(f.store.list('task-run').length, 0); assert.equal(f.store.list('model-call').length, 0);
});

test('active late obligations without detailed work stay in R2; a later concrete consumer makes their exact binding mandatory', t => {
  const f = fixture(t);
  const earlier = structuredClone(f.bound);
  earlier.nodes = earlier.nodes.filter(node => node.kind !== 'work'); earlier.horizon = []; earlier.researchObligations = [];
  const retained = structuredClone(f.handoff);
  const waiting = bindTaskObligations(f.store, 'p', earlier, f.handoff);
  assert.deepEqual(waiting.findings, []); assert.equal(waiting.byNode.size, 0);
  assert.deepEqual(obligationHandoff(f.store, 'p', [reference(f.r2)]), retained);
  assert.deepEqual(f.store.get(f.scope.id), f.scope);
  const later = structuredClone(f.bound); later.researchObligations = [];
  assert.deepEqual(bindTaskObligations(f.store, 'p', later, f.handoff).findings.map(item => [item.code, item.target]),
    [['task_obligation_consumer_missing', 'result'], ['task_obligation_consumer_missing', 'environment']]);
  assert.equal(requireTaskObligations(f.store, 'p', f.bound, f.handoff).get('p-produce-work')!.length, 2);
  assert.deepEqual(f.handoff, retained);
});

test('work below a product ancestor wakes its obligation even without a direct realizes edge to that product', t => {
  const f = fixture(t, 'p-product');
  assert.equal(f.bound.nodes.find(node => node.id === 'p-produce-block')!.parent, 'p-product');
  assert.deepEqual(bindTaskObligations(f.store, 'p', f.bound, f.handoff).findings, []);
  assert.equal(requireTaskObligations(f.store, 'p', f.bound, f.handoff).get('p-produce-work')!.length, 2);
  const omitted = structuredClone(f.bound); omitted.researchObligations = [];
  assert.ok(bindTaskObligations(f.store, 'p', omitted, f.handoff).findings.some(item => item.code === 'task_obligation_consumer_missing'));
});

test('missing bindings, forged scope/id, wrong work and borrowed tests cannot drop or reassign a carried obligation', t => {
  const f = fixture(t);
  for (const mutate of [
    (graph: any) => { delete graph.researchObligations; },
    (graph: any) => { graph.researchObligations = []; },
    (graph: any) => { graph.researchObligations[0].scope.hash = '0'.repeat(64); },
    (graph: any) => { graph.researchObligations[0].obligation = 'ui'; },
    (graph: any) => { graph.researchObligations[0].consumers[0].node = 'p-consume-work'; },
    (graph: any) => { graph.researchObligations[0].consumers[0].tests = ['p-consume-work-test']; },
    (graph: any) => { graph.researchObligations[0].consumers[0].tests = []; },
    (graph: any) => { graph.researchObligations.push(graph.researchObligations[0]); },
    (graph: any) => { graph.researchObligations[0].consumers = [null]; },
  ]) {
    const graph = structuredClone(f.bound); mutate(graph);
    assert.ok(bindTaskObligations(f.store, 'p', graph, f.handoff).findings.length);
  }
  const changed = structuredClone(f.handoff); changed.obligations[0]!.moment = 'R3';
  assert.throws(() => bindTaskObligations(f.store, 'p', f.bound, changed), { code: 'task_obligation_scope_foreign' });
});

test('unawakened UI stays explicit in R2, and touching its wake path requires a concrete binding', t => {
  const f = fixture(t); assert.deepEqual(bindTaskObligations(f.store, 'p', f.bound, f.handoff).findings, []);
  assert.ok(f.handoff.obligations.some(item => item.obligation === 'ui'));
  const graph = structuredClone(f.bound); graph.nodes.find(node => node.id === 'p-consume-work')!.code.push({ path: 'ui/component.ts', access: 'write', status: 'planned' });
  assert.ok(bindTaskObligations(f.store, 'p', graph, f.handoff).findings.some(item => item.code === 'task_obligation_consumer_missing' && item.target === 'ui'));
  const ui = f.handoff.obligations.find(item => item.obligation === 'ui')!;
  graph.researchObligations!.push({ id: taskBindingId(ui), scope: ui.scope, obligation: ui.obligation,
    consumers: [{ node: 'p-consume-work', tests: ['p-consume-work-test'] }] });
  assert.ok(requireTaskObligations(f.store, 'p', graph, f.handoff).get('p-consume-work')!.some(item => item.requirement.obligation === 'ui'));
});

test('task bindings affect only L3 and bound task signatures; old L2 and unscoped question contracts stay unchanged', t => {
  const f = fixture(t);
  assert.deepEqual(projectGraph(f.bound, 2), projectGraph(f.graph.value, 2));
  assert.equal((layerDesignSpec(2).schema as any).properties.researchObligations, undefined);
  assert.equal((layerDesignSpec(3).schema as any).properties.researchObligations, undefined);
  const spec = layerDesignSpec(3, f.handoff).schema as any;
  assert.ok(spec.required.includes('researchObligations'));
  assert.equal(spec.properties.researchObligations.items.oneOf[0].properties.id.const, taskBindingId(f.handoff.obligations[0]!));
  const producer = f.graph.value.nodes.find(node => node.id === 'p-produce-work')!, consumer = f.graph.value.nodes.find(node => node.id === 'p-consume-work')!;
  assert.notEqual(nodeSignature(f.bound, producer), nodeSignature(f.graph.value, producer));
  assert.equal(nodeSignature(f.bound, consumer), nodeSignature(f.graph.value, consumer));
});

test('missing concrete consumers are rejected on full-answer and delta paths before paying an assessor', async t => {
  const f = fixture(t);
  const draft = f.engine.discovery.create('p', 'om-g2', 'R2', 'p-product', [layerDesignSpec(3, f.handoff)], [reference(f.r2), reference(f.scope)], 1);
  const question = f.store.get<Question>(draft.value.questions[0]!)!;
  const graph = { ...f.graph.value, researchObligations: [] };
  await assert.rejects(assessAnswer(f.store, question, { action: 'answer', question: question.id, value: layerDesignOf(graph, 3, question.value.spec.layerAssembly),
    citations: [{ source: reference(f.source), selector: { kind: 'text-range', start: 0, end: f.source.value.content.length } }] }, f.environment, f.root),
  { code: 'task_obligation_bindings_invalid' });
  const delta = { base: reference(f.graph), upserts: {}, removes: {} };
  assert.deepEqual((layerDeltaCandidate(f.store, draft, question, delta) as any).researchObligations, []);
  assert.throws(() => expandLayerDelta(f.store, draft, question, delta), { code: 'task_obligation_bindings_invalid' });
  assert.equal(f.store.list('model-call').length, 0);
});

test('L3 routing uses the actual carried contract and rejects a schema without its obligations before dispatch', t => {
  const f = fixture(t), command = { executable: process.execPath, args: ['--version'] };
  const pilot = configureReaderPilot(f.store, f.engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxRequestChars: 100000, maxReadChars: 20000, maxReplyChars: 30000, maxCalls: 20, maxReportedTokens: 800000,
    planning: { fields: ['old-R1'], maxRequestChars: 90000, maxRounds: 5 } }, 0);
  const draft = f.engine.discovery.create('p', 'om-g2', 'R2', 'p-product', [layerDesignSpec(3, f.handoff)], [reference(f.r2), reference(f.scope)], 1);
  const question = f.store.get<Question>(draft.value.questions[0]!)!;
  assert.equal(planningForQuestion(f.store, draft, question, pilot), pilot.value.planning);
  assert.throws(() => planningForQuestion(f.store, draft, { ...question, value: { ...question.value, spec: layerDesignSpec(3) } }, pilot), { code: 'research_contract_mismatch' });
  assert.equal(f.store.list('model-call').length, 0);
});

test('full L3 answers and deltas reject journey references before invoking a paid assessor', async t => {
  const f = fixture(t);
  const draft = f.engine.discovery.create('p', 'om-g2', 'R2', 'p-product', [layerDesignSpec(3, f.handoff)], [reference(f.r2), reference(f.scope)], 1);
  const question = f.store.get<Question>(draft.value.questions[0]!)!;
  const value = layerDesignOf(f.bound, 3, question.value.spec.layerAssembly) as any;
  const chosen = value.tests.find((item: any) => item.covers.length);
  chosen.covers[0] = { kind: 'journey', id: f.bound.journeys![0]!.id };
  await assert.rejects(assessAnswer(f.store, question, { action: 'answer', question: question.id, value,
    citations: [{ source: reference(f.source), selector: { kind: 'text-range', start: 0, end: f.source.value.content.length } }] }, f.environment, f.root),
  { code: 'answer_invalid' });
  assert.throws(() => expandLayerDelta(f.store, draft, question, { base: reference(f.graph), removes: {},
    upserts: { tests: [{ id: chosen.id, covers: chosen.covers }], researchObligations: value.researchObligations } }), { code: 'answer_invalid' });
  assert.equal(f.store.list('model-call').length, 0);
});

test('the immutable L3 marker controls task-contract admission for historical plans', t => {
  const f = fixture(t);
  const old = f.store.write({ id: 'phase:p:L3', kind: 'phase', expected: 0, value: { projectId: 'p', phase: 'L3', inputs: [reference(f.r2)] } });
  assert.equal(taskObligationHandoff(f.store, 'p', [reference(f.r2), reference(old)]), null);
  const current = f.store.write({ id: old.id, kind: old.kind, expected: old.revision,
    value: { projectId: 'p', phase: 'L3', inputs: [reference(f.r2)], taskObligationContract: TASK_OBLIGATION_CONTRACT } });
  assert.deepEqual(taskObligationHandoff(f.store, 'p', [reference(f.r2), reference(current)]), f.handoff);
  assert.equal(taskObligationHandoff(f.store, 'p', [reference(f.r2), reference(old)]), null);
  assert.throws(() => taskObligationHandoff(f.store, 'p', [reference(f.r2), { ...reference(current), hash: '0'.repeat(64) }]), { code: 'task_obligation_contract_invalid' });
});
