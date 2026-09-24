import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { Graph, Node } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Write } from '../src/storage/store.js';
import { inputDecisionWrite, writeAddressing, prepareAddressing } from '../src/om/addressing.js';
import { readMc1Question, readAnswerCitations } from '../src/om/accepted-answer.js';
import { checkNodeAnswerForm, checkFactValueForm, checkAnswerForm, prepareAnswerForm, checkInputFieldAnswer, prepareInputFieldAnswer } from '../src/om/answer-form.js';
import { prepareFrameProposals } from '../src/om/frame-proposals.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { gapLineKey, gapLineExpectedResult } from '../src/om/gap-lines.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeOmInput, readOmInput } from '../src/om/input.js';
import { normalizePartAnswer, prepareQuestionTasks, writeQuestionPacket, type PartProposalBody, derivePartProposal, PACKET_ANSWER_PROTOCOL } from '../src/om/question-packet.js';
import { writeRoutes, type RoutedBatch } from '../src/om/routes.js';
import { openSeries, beginAttempt, type AttemptGoal } from '../src/om/series.js';
import { writeGuarded } from '../src/om/refs.js';
import { Evidence } from '../src/evidence/evidence.js';
import type { OmResult, Sealed } from '../src/om/refusal.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

const clone = structuredClone;
const snapshot = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function rejected(result: OmResult<unknown>, code: string) {
  if (result.ok) assert.fail(`Expected ${code}, received a checked answer form`);
  assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target);
  assert.ok(result.refusal.at.field || result.refusal.at.ref);
  return result.refusal;
}
function frozen(value: unknown): boolean {
  return value === null || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(frozen);
}
const valueForm: Json = { type: 'object', additionalProperties: false, required: ['format', 'versions'], properties: {
  format: { type: 'string', enum: ['json', 'xml'] }, versions: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
} };

function fixture(t: TestContext, schema: Json = valueForm, multiple = false) {
  const root = mkdtempSync(join(tmpdir(), 'omg-answer-form-')), database = join(root, 'state.sqlite'), project = 'garden';
  let store = new Store(database);
  const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const { level: _level, ...l1 } = projectGraph(gardenGraph('cross'), 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'output-format',
      question: 'Which output format and versions are supported?', consumer: 'garden-consume-block',
      blocksCurrentStage: false, resolution: 'Resolve this addressed question during OM' },
      { id: 'unaddressed-format', question: 'Which encoding does the output use?', consumer: 'garden-consume-block',
        blocksCurrentStage: false, resolution: 'Address the knowledge kind during OM' },
      ...(multiple ? [{ id: 'other-format', question: 'Which alternate format is supported?', consumer: 'garden-consume-block',
        blocksCurrentStage: false, resolution: 'Resolve the alternate format during OM' },
      { id: 'unaddressed-owner', question: 'Which input needs owner attribution?', consumer: 'garden-consume-block',
        blocksCurrentStage: false, resolution: 'Address this input before research' }] : [])];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: ['output-format', ...(multiple ? ['other-format'] : [])].map(id => ({ pending: clone(inputDecisionWrite({
      project, input: reference(base), graph: reference(graph), layers: [], decision: { target: `discovery:${id}`, field: 'address',
        value: { consumer: 'garden-consume-block', kind: 'repository-fact' } },
    })) as Write })) }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: 'answer-form-fixture', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(store, sources)), gap = gaps.records.find(row => row.value.gap.target === 'discovery:output-format')!;
  assert.equal(gap.value.gap.kind, 'repository-fact');
  const gapSet = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = ok(prepareQuestionTasks(store, { project, gaps: gapSet,
    questions: gaps.records.filter(row => row.value.gap.code === 'predecessor_question' && row.value.gap.kind === 'repository-fact')
      .map(row => ({ gap: reference(row), requirements: [{ pointer: '/contracts/0' }], resultForm: schema })) }));
  const routes = ok(writeRoutes(store, { project, gaps: gapSet, tasks: tasks.tasks.map(task => ({ pending: clone(task.writes[0]!) as Write })),
    catalog: { paths: ['src/format.ts'], records: [] }, previous: null }));
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'form-researcher', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'form-assessor', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000, requestCapacityChars: 100_000 }, 0);
  function issue(batch: Sealed<RoutedBatch>, block: string) {
    const goal: AttemptGoal = { key: `form:${batch.task}`, questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
      result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
    ok(openSeries(store, { project, block, line: 1, slice: `form:${batch.task}`, predecessor: null, basis: null }));
    const series = ok(beginAttempt(store, { project, block, line: 1, attempt: 1, goal }));
    return ok(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id,
      environment: reference(environment), attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  }
  const factBatch = routes.value.batches.find(batch => batch.model === 'MC1')!;
  const factPacket = issue(factBatch, 'garden-consume-block'), question = factPacket.value.native[0]!.question;
  const nodeBatch = routes.value.batches.find(batch => batch.task === 'node-expansion' && batch.node === 'garden-produce-block')!;
  const nodePacket = issue(nodeBatch, nodeBatch.node!);
  const frame = ok(prepareFrameProposals(store, sources.operations)), assigned = nodePacket.value.plan!.assignments[0]!.obligations;
  const obligations = frame.frame.result.obligations.filter(item => assigned.includes(item.id));
  const upper = graph.value.nodes.find(node => node.id === nodeBatch.node)!;
  const node: Node = { ...clone(upper), id: 'garden-form-operation', kind: 'operation', parent: upper.id, title: 'Format output',
    ports: obligations.filter(item => item.kind === 'connection-end').map((item, index) => ({ id: `port-${index}`,
      direction: item.role === 'producer' ? 'out' : 'in', contract: graph.value.artifacts.find(artifact => artifact.id === item.artifact)!.contract })), code: [], tests: [] };
  let port = 0;
  const body: PartProposalBody = { nodes: [node], fills: obligations.map(item => ({ obligation: item.id, node: node.id,
    ...(item.kind === 'connection-end' ? { port: node.ports[port++]!.id } : {}) })), localConnectors: [], artifacts: [], contracts: [], joins: [],
    tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
  const requestId = (nodePacket.value.packet as Record<string, Json>).requestId as string;
  const raw = (proposal: unknown = body) => JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId, action: 'answer', proposal });
  const answerRaw = (packet: typeof nodePacket, answer: object) => JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL,
    requestId: (packet.value.packet as Record<string, Json>).requestId, ...answer });
  const questionIds = (packet: typeof nodePacket) => ((packet.value.packet as Record<string, Json>).questions as unknown as { id: string }[]).map(item => item.id);
  const fieldBatch = routes.value.batches.find(batch => batch.model === 'MC2' && batch.task === 'input-field'
    && batch.items.some(item => item.target === 'discovery:unaddressed-format'))!;
  assert.ok(fieldBatch);
  const fieldRaw = () => JSON.stringify({ results: fieldBatch.items.map(item => ({ target: item.target, field: item.field,
    value: { consumer: 'garden-consume-block', kind: 'repository-fact' }, basis: item.record })) });
  return { project, root, graph, input, sources, gaps, routes, fieldBatch, fieldRaw, nodePacket, factPacket, question, body, requestId, raw,
    answerRaw, questionIds, get store() { return store; },
    restart() { store.close(); store = new Store(database); } };
}

test('E3 checks a native node packet through the shared E2 normalizer without claiming a call or layer acceptance', t => {
  const f = fixture(t), before = snapshot(f.store), body = clone(f.body);
  body.nodes[0]!.ports.reverse(); body.fills.reverse();
  body.contracts.push({ id: 'schema-order', schema: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] } });
  const original = clone(body), result = ok(checkNodeAnswerForm(f.store, { project: f.project, packet: reference(f.nodePacket), raw: f.raw(body) }));
  assert.equal(result.kind, 'node-form');
  assert.deepEqual(result.task, { project: f.project, kind: 'node-expansion', packet: reference(f.nodePacket) });
  assert.deepEqual(result.proposal, ok(normalizePartAnswer(body)));
  assert.deepEqual(result.proposal.contracts[0]!.schema, original.contracts[0]!.schema);
  assert.deepEqual(body, original);
  assert.ok(result.references.some(ref => canonical(ref) === canonical(reference(f.nodePacket))));
  assert.ok(frozen(result));
  body.nodes[0]!.title = 'caller mutation';
  assert.notEqual(result.proposal.nodes[0]!.title, body.nodes[0]!.title);
  assert.deepEqual(ok(checkNodeAnswerForm(f.store, { project: f.project, packet: reference(f.nodePacket), raw: f.raw(original) })), result);
  for (const kind of ['call-record', 'part-response', 'part-result', 'layer-proposal', 'accepted-answer']) assert.deepEqual(f.store.list(kind), []);
  assert.deepEqual(snapshot(f.store), before);
});

test('E3 rejects every missing node section and service fields instead of silently constructing an empty proposal', t => {
  const f = fixture(t), before = snapshot(f.store);
  for (const section of Object.keys(f.body)) {
    const missing = clone(f.body) as unknown as Record<string, unknown>; delete missing[section];
    rejected(checkNodeAnswerForm(f.store, { project: f.project, packet: reference(f.nodePacket), raw: f.raw(missing) }), 'part_answer_invalid');
    for (const value of [null, {}, 'not-a-set']) rejected(checkNodeAnswerForm(f.store,
      { project: f.project, packet: reference(f.nodePacket), raw: f.raw({ ...f.body, [section]: value }) }), 'part_answer_invalid');
  }
  for (const extra of [{ status: 'accepted' }, { accepted: true }, { base: { graph: reference(f.nodePacket), frame: null } },
    { source: 'decision' }, { level: 2 }, { candidateHash: '0'.repeat(64) }, { verdict: { passed: true } }]) {
    rejected(checkNodeAnswerForm(f.store, { project: f.project, packet: reference(f.nodePacket), raw: f.raw({ ...f.body, ...extra }) }), 'part_answer_invalid');
  }
  const nested = clone(f.body) as unknown as { nodes: Record<string, unknown>[] };
  nested.nodes[0]!.accepted = true;
  rejected(checkNodeAnswerForm(f.store, { project: f.project, packet: reference(f.nodePacket), raw: f.raw(nested) }), 'part_answer_invalid');
  const wrongPort = clone(f.body); wrongPort.nodes[0]!.ports[0]!.direction = 'sideways' as 'in';
  rejected(checkNodeAnswerForm(f.store, { project: f.project, packet: reference(f.nodePacket), raw: f.raw(wrongPort) }), 'part_answer_invalid');
  assert.deepEqual(snapshot(f.store), before);
});

test('E3 requires the exact response envelope and request identity of a saved node-expansion task', t => {
  const f = fixture(t), before = snapshot(f.store);
  for (const raw of ['not-json', '```json\n{}\n```', 'null', '[]', '{}', JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId: f.requestId, action: 'answer' }),
    JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId: f.requestId, action: 'answer', proposal: f.body, status: 'succeeded' }),
    f.raw().replace('\"nodes\":[', '\"nodes\":[1e999,')])
    rejected(checkNodeAnswerForm(f.store, { project: f.project, packet: reference(f.nodePacket), raw }), 'part_answer_invalid');
  rejected(checkNodeAnswerForm(f.store, { project: f.project, packet: reference(f.nodePacket),
    raw: JSON.stringify({ protocol: PACKET_ANSWER_PROTOCOL, requestId: 'another-request', action: 'answer', proposal: f.body }) }), 'part_result_invalid');
  rejected(checkNodeAnswerForm(f.store, { project: f.project, packet: reference(f.nodePacket),
    raw: JSON.stringify({ protocol: 'unknown-protocol', requestId: f.requestId, action: 'answer', proposal: f.body }) }), 'part_answer_invalid');
  rejected(checkNodeAnswerForm(f.store, { project: f.project, packet: reference(f.factPacket),
    raw: f.answerRaw(f.factPacket, { action: 'cannot_answer', questionIds: f.questionIds(f.factPacket), reason: 'No fact found' }) }), 'answer_form_task_invalid');
  rejected(checkNodeAnswerForm(f.store, { project: f.project, packet: reference(f.nodePacket),
    raw: f.answerRaw(f.nodePacket, { action: 'cannot_answer', questionIds: f.questionIds(f.nodePacket), reason: 'No design found' }) }), 'answer_form_invalid');
  assert.deepEqual(snapshot(f.store), before);
});

test('E3 validates MC1 values against the complete saved D5 result form without accepting their grounds', t => {
  const f = fixture(t), before = snapshot(f.store), value = { format: 'json', versions: [2, 1, 2] };
  assert.deepEqual(ok(readMc1Question(f.store, { project: f.project, record: f.question })).record.value.request.contract.resultForm, valueForm);
  const result = ok(checkFactValueForm(f.store, { project: f.project, question: f.question, value }));
  assert.equal(result.kind, 'fact-value-form');
  assert.deepEqual(result.task, { project: f.project, kind: 'fact', question: f.question });
  assert.deepEqual(result.value, value); assert.ok(frozen(result));
  assert.ok(result.references.some(ref => canonical(ref) === canonical(f.question)));
  value.versions.reverse(); value.format = 'xml';
  assert.deepEqual(result.value, { format: 'json', versions: [2, 1, 2] });
  for (const invalid of [null, [], 'json', {}, { format: 'json' }, { format: 'yaml', versions: [1] },
    { format: 'json', versions: [] }, { format: 'json', versions: ['1'] }, { format: 'json', versions: [0] },
    { format: 'json', versions: [1], basis: 'supported' }, { format: 'json', versions: [1], status: 'accepted' }])
    rejected(checkFactValueForm(f.store, { project: f.project, question: f.question, value: invalid }), 'answer_form_value_invalid');
  assert.deepEqual(f.store.list('accepted-answer'), []);
  assert.deepEqual(snapshot(f.store), before);
});

test('E3 preserves allowed MC1 JSON keys, order and multiplicity instead of normalizing value as a set', t => {
  const f = fixture(t, { type: 'object' }), value = JSON.parse('{"__proto__":{"allowed":true},"versions":[2,1,2],"value":null}') as Json;
  const result = ok(checkFactValueForm(f.store, { project: f.project, question: f.question, value }));
  assert.equal(hashJson(result.value), hashJson(value));
  assert.equal(Object.hasOwn(result.value as object, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.deepEqual((result.value as Record<string, Json>).versions, [2, 1, 2]);
  assert.ok(frozen(result));
});

test('E3 validates all required public arguments before Store I/O and preserves unexpected reader errors', t => {
  const f = fixture(t), before = snapshot(f.store);
  const noIo = new Proxy(f.store, { get(target, property) {
    if (['get', 'list', 'history', 'write', 'writeMany'].includes(String(property))) return () => assert.fail('Malformed answer form reached storage');
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const node = { project: f.project, packet: reference(f.nodePacket), raw: f.raw() }, fact = { project: f.project, question: f.question, value: null };
  const invalid = (error: unknown) => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, 'answer_form_request_invalid');
    const details = error.details as { target?: unknown; field?: unknown } | null;
    assert.ok(details?.target && details.field); return true;
  };
  for (const [action, request] of [
    [checkNodeAnswerForm, node], [checkFactValueForm, fact], [checkAnswerForm, node], [prepareAnswerForm, node],
  ] as const) {
    const invoke = action as (store: Store, request: unknown) => unknown;
    const values: unknown[] = [undefined, null, [], 'request', { ...request, project: '' }, { ...request, unexpected: true }];
    for (const field of Object.keys(request)) { const missing = clone(request) as Record<string, unknown>; delete missing[field]; values.push(missing); }
    if ('packet' in request) values.push({ ...request, packet: null }, { ...request, packet: {} }, { ...request, raw: 1 });
    else values.push({ ...request, question: null }, { ...request, question: {} }, { ...request, value: undefined },
      { ...request, value: Number.NaN }, { ...request, value: { nested: Infinity } });
    assert.throws(() => invoke(undefined as unknown as Store, request), invalid);
    for (const value of values) assert.throws(() => invoke(noIo, value), invalid);
    for (const failure of [new TypeError('form-reader-failure'), new EngineError('record_corrupt', 'form reader failed')]) {
      const broken = new Proxy(f.store, { get(target, property) {
        if (property === 'get') return () => { throw failure; };
        const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
      } });
      assert.throws(() => invoke(broken, request), error => error === failure);
    }
  }
  assert.deepEqual(snapshot(f.store), before);
});

test('E3 derives forms from exact saved sources and rereads history after source heads move and Store restarts', t => {
  const f = fixture(t), nodeRequest = { project: f.project, packet: reference(f.nodePacket), raw: f.raw() },
    factRequest = { project: f.project, question: f.question, value: { format: 'json', versions: [1] } };
  const node = ok(checkNodeAnswerForm(f.store, nodeRequest)), fact = ok(checkFactValueForm(f.store, factRequest));
  rejected(checkNodeAnswerForm(f.store, { ...nodeRequest, packet: { ...nodeRequest.packet, hash: '0'.repeat(64) } }), 'record_forged');
  rejected(checkFactValueForm(f.store, { ...factRequest, question: { ...factRequest.question, hash: '0'.repeat(64) } }), 'record_forged');
  assert.equal(checkNodeAnswerForm(f.store, { ...nodeRequest, project: 'another-project' }).ok, false);
  assert.equal(checkFactValueForm(f.store, { ...factRequest, project: 'another-project' }).ok, false);
  const forgedValue = clone(f.nodePacket.value); (forgedValue.packet as Record<string, Json>).requestId = 'forged-request';
  const forged = f.store.write({ id: f.nodePacket.id, kind: f.nodePacket.kind, expected: f.nodePacket.revision, value: forgedValue });
  rejected(checkNodeAnswerForm(f.store, { ...nodeRequest, packet: reference(forged) }), 'packet_record_invalid');
  const source = f.store.get(`source:${f.project}:brief`)!;
  f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  f.restart();
  const before = snapshot(f.store);
  assert.deepEqual(ok(checkNodeAnswerForm(f.store, nodeRequest)), node);
  assert.deepEqual(ok(checkFactValueForm(f.store, factRequest)), fact);
  rejected(checkNodeAnswerForm(f.store, { ...nodeRequest, packet: reference(forged) }), 'packet_record_invalid');
  assert.deepEqual(snapshot(f.store), before);
});

test('E3 derives node proposals with the E2 assignment checks and cannot create provenance by checking form', t => {
  const f = fixture(t), request = { project: f.project, packet: reference(f.nodePacket), raw: f.raw() }, before = snapshot(f.store);
  const checked = ok(checkAnswerForm(f.store, request));
  assert.equal(checked.kind, 'node-proposal'); if (checked.kind !== 'node-proposal') assert.fail('Expected node proposal');
  assert.deepEqual(checked.proposal, ok(derivePartProposal(f.store, request)).proposal);
  assert.equal(checked.proposal.status, 'proposed');
  assert.deepEqual(checked.task, { project: f.project, packet: reference(f.nodePacket) });
  const prepared = ok(prepareAnswerForm(f.store, request));
  assert.equal(prepared.kind, 'node-proposal');
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(f.input))));
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(f.nodePacket.value.request.environment)));
  const badAssignment = clone(f.body); badAssignment.fills[0]!.obligation = 'another-node-obligation';
  for (const action of [checkAnswerForm, prepareAnswerForm]) {
    const refused = action(f.store, { ...request, raw: f.raw(badAssignment) });
    assert.equal(refused.ok, false); if (!refused.ok) assert.ok(refused.refusal.at.target);
    const foreignNode = clone(f.body); foreignNode.nodes[0]!.parent = 'garden-consume-block';
    assert.equal(action(f.store, { ...request, raw: f.raw(foreignNode) }).ok, false);
  }
  for (const kind of ['call-record', 'part-response', 'part-result', 'layer-proposal', 'accepted-answer']) assert.deepEqual(f.store.list(kind), []);
  assert.deepEqual(snapshot(f.store), before);
});

test('E3 derives MC1 grounds from exact citations while reported documents remain below execution proof', t => {
  const f = fixture(t), evidence = new Evidence(f.store);
  mkdirSync(join(f.root, 'src')); writeFileSync(join(f.root, 'src/format.ts'), 'export const format = "json";\n');
  const file = evidence.file(f.project, 'form-code', f.root, 'src/format.ts', 'text/plain', 0);
  const document = evidence.document(f.project, 'form-document', JSON.stringify({ format: 'json', versions: [2, 1] }), 'application/json', 0);
  const citations = [{ source: reference(file), selector: { kind: 'text-range' as const, start: 0, end: file.value.content.length } },
    { source: reference(document), selector: { kind: 'json-pointer' as const, pointer: '/format' } }];
  const results = [{ questionId: f.questionIds(f.factPacket)[0]!, value: { format: 'json', versions: [2, 1] }, citations }];
  const request = { project: f.project, packet: reference(f.factPacket), raw: f.answerRaw(f.factPacket, { action: 'answer', results }) };
  const before = snapshot(f.store), checked = ok(checkAnswerForm(f.store, request));
  assert.equal(checked.kind, 'fact-candidates'); if (checked.kind !== 'fact-candidates') assert.fail('Expected fact candidates');
  assert.equal(checked.facts.length, 1); assert.deepEqual(checked.facts[0]!.question, f.question);
  assert.equal(checked.facts[0]!.questionId, results[0]!.questionId);
  assert.deepEqual(checked.facts[0]!.value, results[0]!.value);
  assert.deepEqual(checked.facts[0]!.grounds, ok(readAnswerCitations(f.store, { project: f.project, citations })).grounds);
  assert.deepEqual(checked.facts[0]!.grounds.map(ground => ground.proofLimit).sort(), ['reported-not-runtime-proof', 'repository-observation']);
  const prepared = ok(prepareAnswerForm(f.store, request));
  for (const source of [file, document]) assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(source))));
  assert.ok(frozen(checked)); assert.deepEqual(snapshot(f.store), before);
  assert.deepEqual(f.store.list('accepted-answer'), []); assert.deepEqual(f.store.list('research-assessment').filter(row => row.id.includes('form-')), []);
  writeFileSync(join(f.root, 'src/format.ts'), 'export const format = "xml";\n');
  assert.equal(prepareAnswerForm(f.store, request).ok, false);
  f.restart();
  assert.deepEqual(ok(checkAnswerForm(f.store, request)), checked);
});

test('E3 rejects fact omissions, duplicate or foreign questions, forged citations and model supplied grounds', t => {
  const f = fixture(t), source = new Evidence(f.store).document(f.project, 'form-fact', '{"format":"json"}', 'application/json', 0);
  const foreign = new Evidence(f.store).document('another-project', 'form-fact', '{"format":"json"}', 'application/json', 0);
  const result = { questionId: f.questionIds(f.factPacket)[0]!, value: { format: 'json', versions: [1] },
    citations: [{ source: reference(source), selector: { kind: 'json-pointer', pointer: '/format' } }] };
  const before = snapshot(f.store);
  const badResults: unknown[] = [[], [result, result], [{ ...result, questionId: 'not-in-this-packet' }], [{ ...result, citations: [] }],
    [{ ...result, value: { format: 'unsupported', versions: [1] } }], [{ ...result, grounds: [{ proofLimit: 'repository-observation', value: 'json' }] }],
    [{ ...result, citations: [{ source: reference(foreign), selector: { kind: 'json-pointer', pointer: '/format' } }] }],
    [{ ...result, citations: [{ source: { ...reference(source), hash: '0'.repeat(64) }, selector: { kind: 'json-pointer', pointer: '/format' } }] }],
    [{ ...result, citations: [{ source: reference(source), selector: { kind: 'json-pointer', pointer: '/absent' } }] }],
    [{ ...result, citations: [{ source: reference(source), selector: { kind: 'json-pointer', pointer: '/bad~2escape' } }] }],
    [{ ...result, citations: [{ source: reference(f.input), selector: { kind: 'json-pointer', pointer: '/input' } }] }]];
  for (const results of badResults) for (const action of [checkAnswerForm, prepareAnswerForm]) {
    const rejected = action(f.store, { project: f.project, packet: reference(f.factPacket), raw: f.answerRaw(f.factPacket, { action: 'answer', results }) });
    assert.equal(rejected.ok, false); if (!rejected.ok) assert.ok(rejected.refusal.at.target);
  }
  assert.deepEqual(snapshot(f.store), before);
});

test('E3 checks every declared control outcome against its exact task without delivering reads or changing attempt state', t => {
  const f = fixture(t), source = new Evidence(f.store).document(f.project, 'form-navigation', '{"format":"json"}', 'application/json', 0);
  mkdirSync(join(f.root, 'src')); writeFileSync(join(f.root, 'src/format.ts'), 'export const format = "json";\n');
  const questions = f.questionIds(f.factPacket), reads = [
    { action: 'read', path: 'src/format.ts', media: 'text/plain' },
    { action: 'read_source', source: reference(source), selector: { kind: 'json-pointer', pointer: '/format' } },
    { action: 'read_context', record: reference(f.input), pointer: '/input/questions/0' },
    { action: 'search', within: 'src/format.ts', query: 'format' },
    { action: 'search', within: reference(source), query: 'format' },
  ];
  const branches = [
    { action: 'need_source', questionIds: questions, missing: 'Read the current producer contract', reads },
    { action: 'need_owner', questionIds: questions, reason: 'Missing ownership policy', decision: 'Who may choose the output format?' },
    { action: 'cannot_answer', questionIds: questions, reason: 'The supplied source contains no encoding fact' },
    { action: 'pause', questionIds: questions, reason: 'Source service is unavailable' },
  ];
  const expected = ['need-source', 'awaiting-owner', 'no-result', 'no-result'];
  const before = snapshot(f.store);
  for (const [index, branch] of branches.entries()) {
    const request = { project: f.project, packet: reference(f.factPacket), raw: f.answerRaw(f.factPacket, branch) };
    for (const action of [checkAnswerForm, prepareAnswerForm]) {
      const result = ok(action(f.store, request)); assert.equal(result.kind, expected[index]);
      assert.deepEqual(result.task, { project: f.project, packet: reference(f.factPacket) });
      assert.ok(['need-source', 'awaiting-owner', 'no-result'].includes(result.kind));
      if (result.kind === 'need-source' || result.kind === 'awaiting-owner' || result.kind === 'no-result') assert.deepEqual(result.questionIds, questions);
      if (result.kind === 'need-source') assert.equal(result.reads.length, reads.length);
      if (result.kind === 'awaiting-owner') { assert.equal(result.recipient, 'owner'); assert.equal(result.decision, branch.decision); }
      if (result.kind === 'no-result') { assert.equal(result.action, branch.action); assert.equal(result.reason, branch.reason); }
      assert.ok(frozen(result));
    }
  }
  assert.deepEqual(snapshot(f.store), before, 'No source capture, delivery, call, owner wait or attempt completion is performed by E3');
  f.restart();
  for (const [index, branch] of branches.entries()) assert.equal(ok(checkAnswerForm(f.store,
    { project: f.project, packet: reference(f.factPacket), raw: f.answerRaw(f.factPacket, branch) })).kind, expected[index]);
});

test('E3 refuses unaddressed, foreign, malformed and executable control requests', t => {
  const f = fixture(t), source = new Evidence(f.store).document(f.project, 'form-navigation', '{"format":"json"}', 'application/json', 0);
  const questionIds = f.questionIds(f.factPacket), base = { action: 'need_source', questionIds, missing: 'Need format evidence' };
  const foreign = new Evidence(f.store).document('foreign', 'form-navigation', '{"format":"json"}', 'application/json', 0);
  const badReads: object[] = [
    { action: 'read', path: '../secret', media: 'text/plain' }, { action: 'read', path: '/etc/passwd', media: 'text/plain' },
    { action: 'read', path: '.git/config', media: 'text/plain' }, { action: 'read', path: 'src/*.ts', media: 'text/plain' },
    { action: 'read_source', source: reference(source), selector: { kind: 'text-range', start: 5, end: 1 } },
    { action: 'read_source', source: reference(source), selector: { kind: 'json-pointer', pointer: '/bad~2escape' } },
    { action: 'read_source', source: reference(foreign), selector: { kind: 'json-pointer', pointer: '/format' } },
    { action: 'read_context', record: reference(f.input), pointer: '/missing' },
    { action: 'read_context', record: { ...reference(f.input), hash: '0'.repeat(64) }, pointer: '/input' },
    { action: 'search', query: 'format' }, { action: 'search', within: '../', query: 'format' },
    { action: 'search', within: reference(foreign), query: 'format' },
    { action: 'execute', command: 'cat src/format.ts' },
  ];
  const invalid: object[] = badReads.map(read => ({ ...base, reads: [read] }));
  invalid.push({ ...base, reads: [] }, { ...base, questionIds: [], reads: [{ action: 'search', within: 'src/format.ts', query: 'format' }] },
    { ...base, questionIds: ['foreign-question'], reads: [{ action: 'search', within: 'src/format.ts', query: 'format' }] },
    { action: 'need_owner', questionIds, reason: 'Need owner' }, { action: 'cannot_answer', questionIds, reason: ' ' },
    { action: 'pause', questionIds, reason: 'wait', status: 'completed' }, { action: 'need_source', questionIds, missing: 'Read something' },
    { action: 'answer', proposal: f.body, reason: 'also pause' });
  const before = snapshot(f.store);
  for (const branch of invalid) for (const action of [checkAnswerForm, prepareAnswerForm]) {
    const rejected = action(f.store, { project: f.project, packet: reference(f.factPacket), raw: f.answerRaw(f.factPacket, branch) });
    assert.equal(rejected.ok, false, canonical(branch)); if (!rejected.ok) assert.ok(rejected.refusal.at.target);
  }
  assert.deepEqual(snapshot(f.store), before);
});

test('E3 prepares a real unaddressed input decision from M6 and D1 for the common D3 transition without a fake series', t => {
  const f = fixture(t), request = { project: f.project, routes: reference(f.routes), batch: f.fieldBatch.id, raw: f.fieldRaw() };
  assert.deepEqual(f.fieldBatch.items[0]!.consumers, []);
  const gap = f.gaps.records.find(row => row.id === f.fieldBatch.items[0]!.record.id)!;
  assert.equal(gap.value.gap.code, 'question_unaddressed'); assert.equal(gap.value.gap.mechanism, 'M5:addressing');
  const before = snapshot(f.store), checked = ok(checkInputFieldAnswer(f.store, request)), prepared = ok(prepareInputFieldAnswer(f.store, request));
  assert.equal(checked.kind, 'input-decisions'); assert.deepEqual(prepared.writes, checked.writes);
  assert.ok(prepared.writes.length > 0); assert.ok(prepared.writes.every(write => write.kind === 'input-decision'));
  assert.deepEqual(prepared.input, reference(f.input)); assert.deepEqual(prepared.graph, reference(f.graph));
  assert.deepEqual(prepared.decisions, prepared.writes.map(write => ({ id: write.id, revision: 1, hash: hashJson(write.value) })));
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(f.input))));
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(gap))));
  assert.deepEqual(snapshot(f.store), before);
  const addressing = { project: f.project, input: prepared.input, graph: prepared.graph,
    decisions: prepared.writes.map(write => ({ pending: clone(write) as Write })) };
  const native = ok(prepareAddressing(f.store, addressing));
  assert.ok(native.writes.some(write => write.id === f.input.id), 'Only the D3 transition proposes the derivative input');
  const applied = ok(writeAddressing(f.store, addressing));
  const question = applied.value.input.questions.find(item => item.id === 'discovery:unaddressed-format')!;
  assert.equal(question.kind, 'repository-fact'); assert.equal(question.consumer, 'garden-consume-block');
  assert.ok(prepared.decisions.some(ref => canonical(ref) === canonical(question.addressedBy)));
  const oldHistory = ok(checkInputFieldAnswer(f.store, request));
  f.restart();
  assert.deepEqual(ok(checkInputFieldAnswer(f.store, request)), oldHistory);
  assert.deepEqual(ok(readOmInput(f.store, f.project, reference(applied))), applied);
  assert.deepEqual(f.store.list('call-record'), []);
});

test('E3 input-field outcomes require the exact assigned gap and cannot override producer data or smuggle decision status', t => {
  const f = fixture(t), request = { project: f.project, routes: reference(f.routes), batch: f.fieldBatch.id, raw: f.fieldRaw() };
  const parsed = JSON.parse(request.raw) as { results: { target: string; field: string; value: Json; basis: Ref }[] }, row = parsed.results[0]!;
  const invalid = [
    { results: [] }, { results: [row, row] }, { results: [{ ...row, target: 'discovery:output-format' }] },
    { results: [{ ...row, field: 'answer' }] }, { results: [{ ...row, basis: reference(f.input) }] },
    { results: [{ ...row, basis: { ...row.basis, hash: '0'.repeat(64) } }] },
    { results: [{ ...row, value: { consumer: 'nonexistent-block', kind: 'repository-fact' } }] },
    { results: [{ ...row, value: { consumer: 'garden-produce-block', kind: 'repository-fact' } }] },
    { results: [{ ...row, value: { consumer: 'garden-consume-block', kind: 'invented-knowledge' } }] },
    { results: [{ ...row, status: 'accepted' }] }, { results: [{ ...row, value: { consumer: 'garden-consume-block' } }] },
  ];
  const before = snapshot(f.store);
  for (const raw of invalid) for (const action of [checkInputFieldAnswer, prepareInputFieldAnswer]) {
    const result = action(f.store, { ...request, raw: JSON.stringify(raw) });
    assert.equal(result.ok, false, canonical(raw)); if (!result.ok) assert.ok(result.refusal.at.target);
  }
  assert.equal(checkInputFieldAnswer(f.store, { ...request, batch: f.nodePacket.value.request.batch! }).ok, false);
  assert.equal(checkInputFieldAnswer(f.store, { ...request, routes: { ...request.routes, hash: '0'.repeat(64) } }).ok, false);
  assert.deepEqual(snapshot(f.store), before);
});

test('E3 input decision preparation guards every shared source while exact history survives a changed head', t => {
  const f = fixture(t), request = { project: f.project, routes: reference(f.routes), batch: f.fieldBatch.id, raw: f.fieldRaw() };
  const prepared = ok(prepareInputFieldAnswer(f.store, request)), history = ok(checkInputFieldAnswer(f.store, request));
  const gap = f.gaps.records.find(row => row.id === f.fieldBatch.items[0]!.record.id)!;
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(gap))));
  f.store.write({ id: gap.id, kind: gap.kind, expected: gap.revision, value: gap.value });
  const before = snapshot(f.store);
  const guarded = writeGuarded(f.store, { unit: 'E3-test', target: gap.id, writes: prepared.writes as Write[], guards: prepared.guards as Ref[] });
  assert.equal(guarded.ok, false); assert.deepEqual(snapshot(f.store), before);
  assert.equal(prepareInputFieldAnswer(f.store, request).ok, false);
  f.restart();
  assert.deepEqual(ok(checkInputFieldAnswer(f.store, request)), history);
  assert.deepEqual(snapshot(f.store), before);
});

test('E3 validates source-only MC2 request envelopes before reading routes and propagates storage faults', t => {
  const f = fixture(t), request = { project: f.project, routes: reference(f.routes), batch: f.fieldBatch.id, raw: f.fieldRaw() };
  const noIo = new Proxy(f.store, { get(target, property) {
    if (['get', 'list', 'history', 'write', 'writeMany'].includes(String(property))) return () => assert.fail('Malformed MC2 request reached storage');
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const values: unknown[] = [undefined, null, [], 'request', { ...request, project: '' }, { ...request, routes: null },
    { ...request, routes: {} }, { ...request, batch: '' }, { ...request, raw: null }, { ...request, status: 'accepted' }];
  for (const field of Object.keys(request)) { const missing = clone(request) as Record<string, unknown>; delete missing[field]; values.push(missing); }
  const invalid = (error: unknown) => error instanceof EngineError && error.code === 'answer_form_request_invalid';
  for (const action of [checkInputFieldAnswer, prepareInputFieldAnswer]) {
    const invoke = action as (store: Store, request: unknown) => unknown;
    for (const value of values) assert.throws(() => invoke(noIo, value), invalid);
    assert.throws(() => action(undefined as unknown as Store, request), invalid);
    const fault = new TypeError('input form reader fault');
    const broken = new Proxy(f.store, { get(target, property) {
      if (property === 'get') return () => { throw fault; };
      const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    assert.throws(() => action(broken, request), error => error === fault);
  }
});

test('E3 partial MC1 and MC2 result sets explicitly retain the unanswered task addresses', t => {
  const f = fixture(t, valueForm, true), source = new Evidence(f.store).document(f.project, 'partial-evidence', '{"format":"json"}', 'application/json', 0);
  const factIds = f.questionIds(f.factPacket);
  assert.equal(factIds.length, 2); assert.equal(f.fieldBatch.items.length, 2);
  const factRequest = { project: f.project, packet: reference(f.factPacket), raw: f.answerRaw(f.factPacket, { action: 'answer',
    results: [{ questionId: factIds[0], value: { format: 'json', versions: [1] },
      citations: [{ source: reference(source), selector: { kind: 'json-pointer', pointer: '/format' } }] }] }) };
  const fieldRows = JSON.parse(f.fieldRaw()) as { results: unknown[] }, fieldRequest = { project: f.project, routes: reference(f.routes),
    batch: f.fieldBatch.id, raw: JSON.stringify({ results: fieldRows.results.slice(0, 1) }) };
  const before = snapshot(f.store);
  for (const action of [checkAnswerForm, prepareAnswerForm]) {
    const checked = ok(action(f.store, factRequest)); assert.equal(checked.kind, 'fact-candidates');
    if (checked.kind !== 'fact-candidates') assert.fail('Expected fact candidates');
    assert.equal(checked.facts.length, 1); assert.deepEqual(checked.unanswered, factIds.slice(1));
  }
  for (const action of [checkInputFieldAnswer, prepareInputFieldAnswer]) {
    const checked = ok(action(f.store, fieldRequest));
    assert.equal(checked.writes.length, 1); assert.deepEqual(checked.unanswered, [f.fieldBatch.items[1]!.gap]);
  }
  assert.deepEqual(snapshot(f.store), before);
  assert.deepEqual(f.store.list('accepted-answer'), []);
  f.restart();
  const historical = ok(checkAnswerForm(f.store, factRequest));
  assert.equal(historical.kind, 'fact-candidates'); if (historical.kind !== 'fact-candidates') assert.fail('Expected fact candidates');
  assert.deepEqual(historical.unanswered, factIds.slice(1));
  assert.deepEqual(ok(checkInputFieldAnswer(f.store, fieldRequest)).unanswered, [f.fieldBatch.items[1]!.gap]);
});
