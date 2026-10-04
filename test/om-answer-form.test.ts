import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { safeRelativePath } from '../src/graph/topology.js';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { Graph, Node } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { bindTaskObligations, checkTaskObligationBinding, taskBindingId } from '../src/graph/task-obligations.js';
import type { TaskObligationBinding } from '../src/graph/task-obligation-model.js';
import type { ObligationHandoff } from '../src/graph/obligation-handoff.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Write } from '../src/storage/store.js';
import { inputDecisionWrite, writeAddressing, prepareAddressing } from '../src/om/addressing.js';
import { readMc1Question, readAnswerCitations } from '../src/om/accepted-answer.js';
import { checkNodeAnswerForm, checkFactValueForm, checkAnswerForm, prepareAnswerForm, checkInputFieldAnswer, prepareInputFieldAnswer } from '../src/om/answer-form.js';
import { prepareFrameProposals } from '../src/om/frame-proposals.js';
import { WORKS_FRAME_CONTRACT } from '../src/om/frame-obligations.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { gapLineKey, gapLineExpectedResult, writeGapLines } from '../src/om/gap-lines.js';
import { writeHorizon } from '../src/om/horizon.js';
import { OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND, normalizeOwnerGapAssignment, writeOmObligations } from '../src/om/obligations.js';
import { writeOmInput, readOmInput, withHistoricalReads } from '../src/om/input.js';
import { normalizePartAnswer, prepareQuestionTasks, writeQuestionPacket, type PartProposalBody, derivePartProposal, packetReadPath, PACKET_ANSWER_PROTOCOL } from '../src/om/question-packet.js';
import { writeRoutes, type RoutedBatch } from '../src/om/routes.js';
import { openSeries, beginAttempt, type AttemptGoal } from '../src/om/series.js';
import { writeGuarded } from '../src/om/refs.js';
import { Evidence } from '../src/evidence/evidence.js';
import type { OmResult, Sealed } from '../src/om/refusal.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

const { fixtureAnswer }: { fixtureAnswer: (packet: unknown, answer: unknown) => any } = await import(new URL('../../test/om-adapter-fixture.mjs', import.meta.url).href);
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

function fixture(t: TestContext, schema: Json = valueForm, multiple = false, material?: (store: Store, project: string, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'omg-answer-form-')), database = join(root, 'state.sqlite'), project = 'garden';
  let store = new Store(database);
  const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const { level: _level, ...l1 } = projectGraph(gardenGraph('cross'), 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'output-format',
      question: 'Which output format and versions are supported?', consumer: 'garden-consume-block',
      moment: 'om-pass', blocksCurrentStage: false, resolution: 'Resolve this addressed question during OM' },
      { id: 'unaddressed-format', question: 'Which encoding does the output use?', consumer: 'garden-consume-block',
        moment: 'om-pass', blocksCurrentStage: false, resolution: 'Address the knowledge kind during OM' },
      ...(multiple ? [{ id: 'other-format', question: 'Which alternate format is supported?', consumer: 'garden-consume-block',
        moment: 'om-pass', blocksCurrentStage: false, resolution: 'Resolve the alternate format during OM' },
      { id: 'unaddressed-owner', question: 'Which input needs owner attribution?', consumer: 'garden-consume-block',
        moment: 'om-pass', blocksCurrentStage: false, resolution: 'Address this input before research' }] : [])];
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
  material?.(store, project, root);
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
  const raw = (proposal: unknown = body) => JSON.stringify(fixtureAnswer(nodePacket.value.packet, { protocol: PACKET_ANSWER_PROTOCOL, requestId, action: 'answer', proposal }));
  const answerRaw = (packet: typeof nodePacket, answer: object) => JSON.stringify(fixtureAnswer(packet.value.packet, { protocol: PACKET_ANSWER_PROTOCOL,
    requestId: (packet.value.packet as Record<string, Json>).requestId, ...answer }));
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
  const f = fixture(t, valueForm, false, (store, project, root) => {
    const evidence = new Evidence(store);
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/format.ts'), 'export const format = "json";\n');
    evidence.file(project, 'form-code', root, 'src/format.ts', 'text/plain', 0);
    evidence.document(project, 'form-document', JSON.stringify({ format: 'json', versions: [2, 1] }), 'application/json', 0);
  });
  const file = f.store.get<import('../src/evidence/evidence.js').Source>(`source:${f.project}:form-code`)!;
  const document = f.store.get(`source:${f.project}:form-document`)!;
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
  const f = fixture(t, valueForm, false, (store, project) => { new Evidence(store).document(project, 'form-fact', '{"format":"json"}', 'application/json', 0); });
  const source = f.store.get(`source:${f.project}:form-fact`)!;
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
  const f = fixture(t, valueForm, false, (store, project) => { new Evidence(store).document(project, 'form-navigation', '{"format":"json"}', 'application/json', 0); });
  const source = f.store.get(`source:${f.project}:form-navigation`)!;
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
  const f = fixture(t, valueForm, false, (store, project) => { new Evidence(store).document(project, 'form-navigation', '{"format":"json"}', 'application/json', 0); });
  const source = f.store.get(`source:${f.project}:form-navigation`)!;
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
  const f = fixture(t, valueForm, true, (store, project) => { new Evidence(store).document(project, 'partial-evidence', '{"format":"json"}', 'application/json', 0); });
  const source = f.store.get(`source:${f.project}:partial-evidence`)!;
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

/** A content-only form specimen, without a fabricated packet, call or D7 acceptance. */
function worksFormBody(): PartProposalBody {
  const graph = gardenGraph(), work = clone(graph.nodes.find(node => node.id === 'garden-produce-work')!);
  const code = { path: 'src/output.ts', symbol: 'serialize', access: 'write' as const, status: 'planned' as const };
  work.code = [code];
  return { nodes: [work], fills: [{ obligation: hashJson('works-form-connection-end'), node: work.id, port: 'out', codeRef: clone(code) }],
    localConnectors: [], artifacts: [], contracts: [], joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [],
    anchors: [], removes: [], replaces: [], redefines: [] };
}

test('E3 shared L3 form retains the complete code reference while the historical form remains unchanged', () => {
  const body = worksFormBody(), original = clone(body), checked = ok(normalizePartAnswer(body, WORKS_FRAME_CONTRACT));
  assert.deepEqual(checked.fills, original.fills);
  assert.deepEqual(checked.fills[0]!.codeRef, { path: 'src/output.ts', symbol: 'serialize', access: 'write', status: 'planned' });
  assert.deepEqual(body, original); assert.ok(frozen(checked));
  assert.notStrictEqual(checked.fills[0]!.codeRef, body.fills[0]!.codeRef);
  assert.equal(hashJson(checked), hashJson(ok(normalizePartAnswer(clone(original), WORKS_FRAME_CONTRACT))));
  rejected(normalizePartAnswer(original), 'part_answer_invalid');
  const historical = clone(original); delete historical.fills[0]!.codeRef;
  assert.deepEqual(ok(normalizePartAnswer(historical)).fills, historical.fills);
  body.fills[0]!.codeRef!.symbol = 'callerMutation';
  assert.equal(checked.fills[0]!.codeRef!.symbol, 'serialize');
});

test('E3 shared L3 form rejects incomplete malformed or service-bearing code references', () => {
  const body = worksFormBody(), complete = body.fills[0]!.codeRef!;
  const missing = ['path', 'access', 'status'].map(field => {
    const code = clone(complete) as unknown as Record<string, unknown>; delete code[field]; return code;
  });
  const invalid: unknown[] = [null, false, 1, 'src/output.ts', [], {}, ...missing,
    { ...complete, path: '' }, { ...complete, path: 7 }, { ...complete, access: 'execute' },
    { ...complete, access: null }, { ...complete, status: 'accepted' }, { ...complete, status: null },
    { ...complete, symbol: '' }, { ...complete, symbol: null }, { ...complete, symbol: [] },
    { ...complete, accepted: true }, { ...complete, owner: 'model' }, { ...complete, hash: hashJson(complete) }];
  for (const codeRef of invalid) {
    const proposed = { ...clone(body), fills: [{ ...clone(body.fills[0]!), codeRef }] };
    rejected(normalizePartAnswer(proposed, WORKS_FRAME_CONTRACT), 'part_answer_invalid');
  }
  for (const extra of [{ worksContract: WORKS_FRAME_CONTRACT }, { status: 'accepted' }, { source: 'model' },
    { level: 3 }, { producer: { id: 'unproven', revision: 1, hash: hashJson('unproven') } }])
    rejected(normalizePartAnswer({ ...body, ...extra }, WORKS_FRAME_CONTRACT), 'part_answer_invalid');
  assert.deepEqual(body, worksFormBody());
});

/** Native D3/D1/D2/D7 authority; works below it are proposed consumers, not an accepted L3. */
function bindingAuthority(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-binding-form-')), database = join(root, 'state.sqlite'), project = 'garden';
  let store = new Store(database);
  const engine = new ProductEngine(store), desired = gardenGraph();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const { level: _level, ...projection } = projectGraph(desired, 1);
  preparedFeatures(engine, project, projection as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [0, 1].map(index => ({ id: `late-${index}`,
      question: `Which post-implementation proof is required for result ${index}?`, consumer: 'garden-produce-block',
      moment: 'task-result', blocksCurrentStage: false, resolution: 'Retain and address this question in OM' }));
    return value;
  });
  const graph = store.get<Graph>(`graph:${project}`)!, base = ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph), decisions: [0, 1].map(index => ({
    pending: clone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: `discovery:late-${index}`, field: 'address', value: { consumer: 'garden-produce-block', kind: 'post-implementation-proof' } } })) as Write,
  })) }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: 'binding-authority', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(store, sources)), gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project, gaps: gapRead, previous: null, pass: 1, closures: [] }));
  const assignments = [0, 1].map(index => {
    const gap = gaps.records.find(row => row.value.gap.target === `discovery:late-${index}`)!;
    const value = normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project,
      context: { gaps: gapRead, lines: reference(lines) }, gap: reference(gap),
      assignments: gap.value.gap.consumers.map(consumer => ({ responsibleNode: consumer, responsibleConsumer: consumer,
        reason: `The owner requires the proof for result ${index}`, returnCondition: `Verify retained result ${index}`, wake: null })) });
    return { pending: { id: `om-owner-gap-assignment:${project}:${hashJson(value)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0,
      value: clone(value) } as Write };
  });
  const saved = ok(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments }));
  const handoff = clone(saved.handoff) as ObligationHandoff, work = desired.nodes.find(node => node.id === 'garden-produce-work')!;
  assert.equal(handoff.obligations.length, 2); assert.ok(work.tests.length);
  const bindings: TaskObligationBinding[] = handoff.obligations.map(obligation => ({ id: taskBindingId(obligation), scope: clone(obligation.scope),
    obligation: obligation.obligation, consumers: [{ node: work.id, tests: [...work.tests] }] }));
  desired.researchObligations = bindings;
  return { project, database, graph: desired, handoff, work, bindings, get store() { return store; },
    restart() { store.close(); store = new Store(database); } };
}

test('E3 shared task binding check uses the complete native D7 authority without claiming set completeness', t => {
  const f = bindingAuthority(t), before = snapshot(f.store), full = bindTaskObligations(f.store, f.project, f.graph, f.handoff);
  assert.deepEqual(full.findings, []);
  const rows = f.bindings.map(binding => checkTaskObligationBinding(f.store, f.project, f.graph, f.handoff, binding));
  assert.ok(rows.every(row => row.findings.length === 0));
  assert.deepEqual(rows.flatMap(row => row.byNode.get(f.work.id) ?? []).sort((a, b) => a.binding.localeCompare(b.binding)), full.byNode.get(f.work.id));
  const partial = { ...clone(f.graph), researchObligations: [clone(f.bindings[0]!)] };
  assert.deepEqual(checkTaskObligationBinding(f.store, f.project, partial, f.handoff, f.bindings[0]!), rows[0]);
  const incomplete = bindTaskObligations(f.store, f.project, partial, f.handoff);
  assert.deepEqual(incomplete.findings.map(finding => finding.code), ['task_obligation_consumer_missing']);
  assert.equal(incomplete.findings[0]!.target, f.bindings[1]!.obligation);
  const sliced = { ...clone(f.handoff), obligations: [clone(f.handoff.obligations[0]!)] };
  assert.throws(() => checkTaskObligationBinding(f.store, f.project, partial, sliced, f.bindings[0]!), error =>
    error instanceof EngineError && error.code === 'task_obligation_scope_foreign');
  assert.deepEqual(snapshot(f.store), before);
  f.restart();
  assert.deepEqual(checkTaskObligationBinding(f.store, f.project, f.graph, f.handoff, f.bindings[0]!), rows[0]);
  assert.deepEqual(bindTaskObligations(f.store, f.project, f.graph, f.handoff), full);
  assert.deepEqual(snapshot(f.store), before);
});

test('E3 one binding and the full binder share identity, concrete work, test and deadline refusals', t => {
  const f = bindingAuthority(t), binding = f.bindings[0]!;
  const candidates: Array<[TaskObligationBinding, string]> = [
    [{ ...clone(binding), id: 'borrowed-binding' }, 'task_obligation_foreign'],
    [{ ...clone(binding), obligation: f.bindings[1]!.obligation }, 'task_obligation_foreign'],
    [{ ...clone(binding), scope: { ...binding.scope, hash: hashJson('foreign-scope') } }, 'task_obligation_foreign'],
    [{ ...clone(binding), consumers: [{ node: 'garden-consume-work', tests: [] }] }, 'task_obligation_consumer_foreign'],
    [{ ...clone(binding), consumers: [{ node: 'garden-produce-operation', tests: [] }] }, 'task_obligation_consumer_foreign'],
    [{ ...clone(binding), consumers: [{ node: f.work.id, tests: ['foreign-test'] }] }, 'task_obligation_test_foreign'],
    [{ ...clone(binding), consumers: [{ node: f.work.id, tests: [] }] }, 'task_obligation_resolution_required'],
    [{ ...clone(binding), consumers: [clone(binding.consumers[0]!), clone(binding.consumers[0]!)] }, 'task_obligation_consumer_missing'],
  ];
  for (const [candidate, code] of candidates) {
    const graph = { ...clone(f.graph), researchObligations: [candidate, clone(f.bindings[1]!)] };
    const single = checkTaskObligationBinding(f.store, f.project, graph, f.handoff, candidate), full = bindTaskObligations(f.store, f.project, graph, f.handoff);
    assert.deepEqual(single.findings.map(finding => finding.code), [code]);
    assert.deepEqual(single.findings, full.findings.filter(finding => finding.target === candidate.id));
    assert.equal(single.byNode.size, 0);
  }
  const duplicate = { ...clone(f.graph), researchObligations: [clone(binding), ...clone(f.bindings)] };
  assert.equal(bindTaskObligations(f.store, f.project, duplicate, f.handoff).findings[0]!.code, 'task_obligation_duplicate');
  const forged = clone(f.handoff); forged.obligations[0]!.moment = 'task-start';
  assert.throws(() => checkTaskObligationBinding(f.store, f.project, f.graph, forged, binding), error =>
    error instanceof EngineError && error.code === 'task_obligation_scope_foreign');
  assert.throws(() => checkTaskObligationBinding(f.store, 'other-project', f.graph, f.handoff, binding), error => error instanceof EngineError);
});

test('E3 public task binding check rejects malformed arguments before Store access and preserves storage faults', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-binding-arguments-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const noIo = new Proxy(store, { get(target, property) {
    if (['get', 'list', 'history', 'write', 'writeMany'].includes(String(property))) return () => assert.fail('Malformed binding arguments reached storage');
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const ref: Ref = { id: 'source:garden', revision: 1, hash: hashJson('exact-source') }, graph = gardenGraph();
  const handoff = { era: 'om-obligations/v1', producer: ref, scope: ref, obligations: [] };
  const binding: TaskObligationBinding = { id: 'binding', scope: ref, obligation: 'gap', consumers: [{ node: 'garden-produce-work', tests: [] }] };
  const invoke = checkTaskObligationBinding as (...args: unknown[]) => unknown;
  const args: unknown[] = [noIo, 'garden', graph, handoff, binding];
  const malformed = (error: unknown) => error instanceof EngineError && error.code === 'task_obligation_request_invalid'
    && Boolean((error.details as { target: string; field: string }).target) && Boolean((error.details as { target: string; field: string }).field);
  for (let index = 0; index < args.length; index++) for (const value of [undefined, null, false, [], '']) {
    const values = [...args]; values[index] = value; assert.throws(() => invoke(...values), malformed);
  }
  for (const [index, value] of [
    [2, { ...graph, nodes: null }], [2, { ...graph, horizon: null }], [2, { ...graph, tests: [null] }],
    [3, { ...handoff, producer: {} }], [3, { ...handoff, obligations: null }], [3, { ...handoff, obligations: [null] }],
    [3, { ...handoff, scope: { ...ref, revision: 0 } }], [3, { ...handoff, scope: { ...ref, hash: '' } }],
    [3, { ...handoff, r2: ref }], [3, { ...handoff, accepted: true }],
    [4, { ...binding, scope: { ...ref, revision: 0 } }], [4, { ...binding, consumers: [] }],
    [4, { ...binding, consumers: [{ node: 'garden-produce-work', tests: null }] }], [4, { ...binding, status: 'accepted' }],
  ] as Array<[number, unknown]>) {
    const values = [...args]; values[index] = value; assert.throws(() => invoke(...values), malformed);
  }
  const fault = new TypeError('native binding reader storage fault'), broken = new Proxy(store, { get(target, property) {
    if (property === 'get') return () => { throw fault; };
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const omRef: Ref = { ...ref, id: 'om-obligation-basis:garden:missing' };
  assert.throws(() => invoke(broken, 'garden', graph, { ...handoff, producer: omRef,
    scope: { ...ref, id: 'om-obligations:garden:missing' } }, binding), error => error === fault);
});

test('E3 binding rows share one exact D7 proof per operation while callers, Store views and failures remain distinct', t => {
  const f = bindingAuthority(t);
  if ('r2' in f.handoff) assert.fail('The fixture must provide native OM authority');
  const handoff = f.handoff, fault = new TypeError('exact D7 proof read failed'), counts = new Map<string, number>();
  let rejectPrimary = false, onPrimaryRead: (() => void) | undefined;
  function counted(store: Store, name: string): Store {
    return new Proxy(store, { get(target, property) {
      if (property === 'get') return (id: string, revision?: number) => {
        if (id === handoff.producer.id && revision === handoff.producer.revision) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
          if (name === 'primary') { onPrimaryRead?.(); if (rejectPrimary) throw fault; }
        }
        return target.get(id, revision);
      };
      const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
  }
  const primary = counted(f.store, 'primary'), anotherProxy = counted(f.store, 'other-proxy'), reopened = new Store(f.database);
  t.after(() => reopened.close());
  const anotherStore = counted(reopened, 'other-store');
  const check = (store = primary, binding = f.bindings[0]!, authority: ObligationHandoff = handoff) =>
    checkTaskObligationBinding(store, f.project, f.graph, authority, binding);
  withHistoricalReads(() => {
    for (const binding of [...f.bindings, ...f.bindings]) assert.deepEqual(check(primary, binding).findings, []);
    assert.equal(counts.get('primary'), 1, 'The complete producer is read once across all binding rows');
    const full = bindTaskObligations(primary, f.project, f.graph, handoff);
    assert.deepEqual(full.findings, []); assert.equal(counts.get('primary'), 1, 'The full binder shares the same historical proof');
    const sliced = { ...clone(handoff), obligations: [clone(handoff.obligations[0]!)] };
    const forged = clone(handoff); forged.obligations[0]!.returnCondition = 'Forged caller condition';
    for (const authority of [sliced, forged]) assert.throws(() => check(primary, f.bindings[0]!, authority), error =>
      error instanceof EngineError && error.code === 'task_obligation_scope_foreign');
    assert.equal(counts.get('primary'), 1, 'Cache hits must still compare every caller against the full proved ledger');
    assert.deepEqual(check(anotherProxy).findings, []);
    assert.deepEqual(check(anotherStore).findings, []);
    assert.equal(counts.get('other-proxy'), 1); assert.equal(counts.get('other-store'), 1);
  });
  withHistoricalReads(() => assert.deepEqual(check().findings, []));
  assert.equal(counts.get('primary'), 2, 'The next external operation must read its source again');
  rejectPrimary = true;
  assert.throws(() => withHistoricalReads(() => check()), error => error === fault);
  assert.equal(counts.get('primary'), 3, 'A failed source read is visible after a prior successful operation');
  withHistoricalReads(() => {
    assert.throws(() => check(), error => error === fault);
    rejectPrimary = false;
    assert.deepEqual(check().findings, []); assert.deepEqual(check().findings, []);
  });
  assert.equal(counts.get('primary'), 5, 'Exceptions leave no active or proved cache entry; a retry then proves the same exact source');
  onPrimaryRead = () => { check(); };
  assert.throws(() => withHistoricalReads(() => check()), error =>
    error instanceof EngineError && error.code === 'task_obligation_scope_foreign');
  assert.equal(counts.get('primary'), 6, 'A recursive proof must be refused before reading the producer again');
  onPrimaryRead = undefined;
  assert.deepEqual(check().findings, []);
  assert.equal(counts.get('primary'), 7, 'Cycle cleanup must not poison the next external operation');
});


test('LP1 v3 table: all 35 paths agree in the actual schema and E3 for read and search', async t => {
  const f = fixture(t), payload = f.factPacket.value.packet as Record<string, any>;
  const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(payload.responseForm.schema);
  assert.equal(f.factPacket.value.answerProtocol, 'omg-answer/v3');
  const forms: [number, string, string, boolean][] = [
    [1, 'relative file', 'package.json', true], [2, 'nested', 'src/om/question-packet.ts', true],
    [3, 'dot prefix', './package.json', false], [4, 'absolute inside', `${f.root}/package.json`, false],
    [5, 'absolute root', f.root, false], [6, 'absolute outside', '/outside/OWNER-POLICY.md', false],
    [7, 'filesystem root', '/', false], [8, 'parent prefix', '../x', false], [9, 'parent segment', 'src/../package.json', false],
    [10, 'dot', '.', false], [11, 'parent', '..', false], [12, 'git prefix', '.git/config', false],
    [13, 'git middle', 'src/.git/x', false], [14, 'git uppercase', '.GIT/config', false], [15, 'git last', 'a/.git', false],
    [16, 'gitignore', '.gitignore', true], [17, 'github', '.github/workflows/ci.yml', true], [18, 'git suffix', 'foo.git/x', true],
    [19, 'empty', '', false], [20, 'blank', '   ', false], [21, 'literal tilde', '~/x', true],
    [22, 'backslash', 'src\\x.ts', false], [23, 'Windows drive', 'C:\\x', false], [24, 'drive relative', 'C:x', false],
    [25, 'file URL', 'file:///x', false], [26, 'colon filename', 'file:x', true], [27, 'trailing slash', 'src/', false],
    [28, 'empty segment', 'a//b', false], [29, 'star', '*.ts', false], [30, 'question mark', 'src/?', false],
    [31, 'newline', 'a\nb', false], [32, 'NUL', 'a\u0000b', false], [33, 'DEL', 'a\u007fb', true],
    [34, 'inner space', 'my file.txt', true], [35, 'Unicode', 'док/файл.md', true],
  ];
  const before = snapshot(f.store);
  for (const [row, label, path, accepted] of forms) await t.test(`LP1 row ${row}: ${label}`, () => {
    assert.equal(path.trim().length > 0 && safeRelativePath(path) && !path.split('/').some(p => p.toLowerCase() === '.git'), accepted);
    assert.equal(packetReadPath(path), accepted);
    for (const read of [{ action: 'read', path, media: 'text/plain' }, { action: 'search', within: path, query: 'format' }]) {
      const raw = f.answerRaw(f.factPacket, { action: 'need_source', questionIds: f.questionIds(f.factPacket), missing: 'Need source', reads: [read] });
      assert.equal(validate(JSON.parse(raw)), accepted);
      for (const check of [checkAnswerForm, prepareAnswerForm]) {
        const result = check(f.store, { project: f.project, packet: reference(f.factPacket), raw });
        if (accepted) {
          const value = ok(result); assert.equal(value.kind, 'need-source');
          if (value.kind === 'need-source') assert.deepEqual(value.reads, [read], 'The literal address is never normalized');
        } else rejected(result, 'part_answer_invalid');
      }
    }
  });
  assert.deepEqual(snapshot(f.store), before);
});

test('MP1 preserves LP1 path refusals and reads saved context through its declared label without writes', t => {
  const f = fixture(t), before = snapshot(f.store), payload = f.factPacket.value.packet as Record<string, any>;
  const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(payload.responseForm.schema);
  const raw = (read: object) => f.answerRaw(f.factPacket, { action: 'need_source', questionIds: f.questionIds(f.factPacket), missing: 'Need source', reads: [read] });
  const request = (body: string) => ({ project: f.project, packet: reference(f.factPacket), raw: body });
  const scoped = raw({ action: 'read_context', record: reference(f.input), pointer: '/input' });
  assert.equal(validate(JSON.parse(scoped)), true);
  for (const check of [checkAnswerForm, prepareAnswerForm]) {
    assert.equal(ok(check(f.store, request(scoped))).kind, 'need-source');
    for (const read of [{ action: 'read', media: 'text/plain' }, { action: 'search', query: 'format' },
      { action: 'search', within: { id: f.input.id, revision: f.input.revision }, query: 'format' }]) {
      const body = raw(read); assert.equal(validate(JSON.parse(body)), false);
      rejected(check(f.store, request(body)), 'within' in read ? 'answer_label_unknown' : 'part_answer_invalid');
    }
    rejected(check(f.store, request(raw({ action: 'search', within: reference(f.input), query: 'format' }))), 'answer_label_unknown');
    const otherEra = JSON.parse(scoped); otherEra.protocol = 'omg-answer/v2';
    rejected(check(f.store, request(JSON.stringify(otherEra))), 'part_answer_invalid');
  }
  const outside = mkdtempSync(join(tmpdir(), 'omg-lp1-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'source.txt'), 'outside project');
  symlinkSync(outside, join(f.root, 'escape'));
  for (const read of [{ action: 'read', path: 'escape/source.txt', media: 'text/plain' }, { action: 'search', within: 'escape', query: 'outside' }]) {
    const body = raw(read); assert.equal(validate(JSON.parse(body)), true);
    assert.equal(ok(checkAnswerForm(f.store, request(body))).kind, 'need-source');
    rejected(prepareAnswerForm(f.store, request(body)), 'answer_form_address_invalid');
  }
  assert.deepEqual(snapshot(f.store), before);
});

test('MP1 MC1 and L2 examples pass the same E3 admission as model content and controls', t => {
  const f = fixture(t, valueForm, false, (store, project) => {
    new Evidence(store).document(project, 'example-evidence', '{"format":"json","versions":[1]}', 'application/json', 0);
  });
  for (const packet of [f.factPacket, f.nodePacket]) {
    const payload = packet.value.packet as Record<string, any>;
    const schema = new Ajv({ strict: true, allowUnionTypes: true }).compile(payload.responseForm.schema);
    assert.ok(payload.brief.examples.some((example: { action: string }) => example.action === 'answer'));
    const before = snapshot(f.store);
    for (const example of payload.brief.examples) {
      assert.equal(schema(example), true, canonical(schema.errors));
      const request = { project: f.project, packet: reference(packet), raw: canonical(example) };
      const actual = ok(checkAnswerForm(f.store, request));
      if (example.action === 'answer' && packet === f.nodePacket) assert.equal(actual.kind, 'node-proposal');
      if (example.action === 'answer' && packet === f.factPacket) assert.equal(actual.kind, 'fact-candidates');
    }
    assert.deepEqual(snapshot(f.store), before);
  }
});
