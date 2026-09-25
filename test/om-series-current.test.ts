import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, watch, mkdirSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { ProductEngine } from '../src/product/engine.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../src/storage/store.js';
import { writeOmInput } from '../src/om/input.js';
import { inputDecisionWrite, writeAddressing, writeApplyAnswer } from '../src/om/addressing.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeHorizon, writeHorizonIssuance, readHorizonIssuance, type HorizonRequest } from '../src/om/horizon.js';
import { beginAttempt, completeAttempt, openSeries, prepareOpenSeries, readSeriesAt,
  readSeries, seriesEraId, readSeriesWorkAdmission, prepareBeginAttempt, readStopHistory, readStopHistoryAt, readCurrentSeriesPointer, readAppliedSeriesTransition, prepareSeriesActivation, applySeriesActivation, prepareSeriesParticipantAdmission,
  prepareSeriesLineAdmission, seriesCurrentId, seriesMembershipId, type RepairSeries } from '../src/om/series.js';
import { writeSeriesTransition, readPreparedSeriesTransition } from '../src/om/series-transition.js';
import { prepareQuestionTasks, prepareQuestionPacket, writeQuestionPacket, readQuestionPacket, type QuestionPacketRequest } from '../src/om/question-packet.js';
import { writeRoutes } from '../src/om/routes.js';
import { gapLineKey, gapLineExpectedResult, writeGapLines, prepareGapLines, readGapLines, type GapLinesRequest } from '../src/om/gap-lines.js';
import { recordCall, prepareCallDispatch, readCall, type RecordCallRequest } from '../src/om/call-record.js';
import { runModelCall, readModelCall, readModelCallPhysical, readModelCallState, readModelApplicationRejection, readModelTerminalWitness, type ModelCallRequest, type OmModelCall } from '../src/om/model-call.js';
import { prepareStopAnalysis, runStopAnalysis } from '../src/om/stop-analysis.js';
import { readModelCallRecovery } from '../src/discovery/model-call-recovery.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import type { Question } from '../src/discovery/discovery.js';
import { prepareAcceptedAnswer, writeAcceptedAnswer, readAcceptedAnswer, readAnswerForInput, answerSourceGuards,
  applicableAnswerTask, confirmAnswerGapClosure, answerIndexId, type AnswerRequest, type Mc1QuestionRecord } from '../src/om/accepted-answer.js';
import { prepareFrame, fillObligations, type FrameRequest, type FrameScope } from '../src/om/frame-obligations.js';
import type { LayerProposal } from '../src/om/frame-proposals.js';
import { writeCandidate } from '../src/om/frame-candidate.js';
import { settleCandidate, type AcceptedFrameRequest } from '../src/om/frame-accept.js';
import { writeGuarded } from '../src/om/refs.js';
import type { OmResult } from '../src/om/refusal.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

const project = 'garden', block = 'garden-consume-block', independent = 'garden-later-block';
const opaqueSlice = 'legacy:opaque-subject', clone = structuredClone;
const fixturePath = fileURLToPath(new URL('../../test/om-adapter-fixture.mjs', import.meta.url));
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function rejected(result: OmResult<unknown>, code?: string) {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('Expected an addressed refusal');
  if (code) assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target); assert.ok(result.refusal.message);
  return result.refusal;
}
const snapshot = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function commit(store: Store, prepared: { readonly writes: readonly Write[]; readonly guards: readonly TransactionGuard[] }) {
  return writeGuarded(store, { unit: 'B3.0b-test', target: project, writes: prepared.writes, guards: prepared.guards });
}
function erase(store: Store, id: string) {
  const database = new DatabaseSync(store.path);
  try {
    database.exec('PRAGMA foreign_keys = OFF; DROP TRIGGER IF EXISTS revisions_no_delete; DROP TRIGGER IF EXISTS entities_no_delete');
    database.prepare('DELETE FROM revisions WHERE entity_id=?').run(id);
    database.prepare('DELETE FROM heads WHERE entity_id=?').run(id);
  } finally { database.close(); }
}
function rewrite<T>(store: Store, record: Revision<T>, value: T): Revision<T> {
  const database = new DatabaseSync(store.path), hash = hashJson(value);
  try { database.exec('DROP TRIGGER IF EXISTS revisions_no_update');
    database.prepare('UPDATE revisions SET body=?,sha256=? WHERE entity_id=? AND revision=?').run(canonical(value), hash, record.id, record.revision);
  } finally { database.close(); }
  return { ...record, hash, value };
}
function fixture(t: TestContext, includeLater = true) {
  const root = mkdtempSync(join(tmpdir(), "omg-series-transition-")), path = join(root, "state.sqlite");
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), source = gardenGraph();
  const { level: _level, ...upper } = projectGraph(source, 1);
  if (includeLater) {
    upper.requirements!.push({ ...clone(upper.requirements![0]!), id: "garden-R2", outcome: "garden-later", statement: "Deliver the later result" });
    upper.nodes.find(node => node.id === independent)!.implements!.push("garden-R2");
  }
  preparedFeatures(engine, project, upper as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>).unknowns = [{ id: "encoding",
      question: "What encoding is supported?", consumer: block, moment: "om-pass", blocksCurrentStage: false,
      resolution: "Read repository facts during OM" }];
    if (includeLater && field === "preparation") {
      const rows = (value as Record<string, Json>).outcomes as Record<string, Json>[];
      rows.push({ ...clone(rows[0]!), id: "garden-later", result: "The later result" });
    }
    if (includeLater && field === "conceptSections") {
      const rows = (value as { requirements: Record<string, Json>[] }[])[0]!.requirements;
      rows.push({ ...clone(rows[0]!), id: "garden-R2", outcome: "garden-later", statement: "Deliver the later result" });
    }
    if (includeLater && field === "operationRequirements") {
      const body = value as Record<string, Json>, rows = body.outcomes as Record<string, Json>[];
      rows.push({ ...clone(rows[0]!), outcome: "garden-later" });
      (body.conceptCoverage as Json[]).push({ requirement: "garden-R2", outcome: "garden-later" });
    }
    if (includeLater && field === "behaviorContracts") {
      const rows = value as Record<string, Json>[];
      rows.push({ ...clone(rows[0]!), id: "garden-B2", requirements: ["garden-R2"], outcome: "garden-later" });
    }
    if (includeLater && (field === "features" || field === "featurePreparation")) {
      const rows = value as Record<string, Json>[];
      rows.push({ ...clone(rows[0]!), [field === "features" ? "title" : "featureTitle"]: "Deliver later result", outcome: "garden-later",
        ...(field === "featurePreparation" ? { requirements: ["garden-R2"], behaviorContracts: ["garden-B2"] } : {}) });
    }
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage,
    reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph), decisions: [{ pending:
    clone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: 'discovery:encoding', field: 'address', value: { consumer: block, kind: 'repository-fact' } } })) as Write }] }));
  const horizon = (version: string, extra: Partial<HorizonRequest['choice']> = {}) => ok(writeHorizon(store, {
    project, input: reference(store.get(input.id)!), graph: reference(store.get(graph.id)!), refinement: null, available: {},
    choice: { choiceVersion: version, features: [{ outcome: "garden-result" }], excluded: [], ...extra },
  }));
  const series = (owner = block) => ok(openSeries(store, { project, block: owner, line: 1,
    slice: opaqueSlice, predecessor: null, basis: null }));
  return { root, path, input, graph, stages, get engine() { return new ProductEngine(store); }, get store() { return store; }, horizon, series,
    restart() { store.close(); store = new Store(path); } };
}

type Fixture = ReturnType<typeof fixture>;
const workGoal = { key: 'encoding', questions: [gapLineKey(project, 'discovery:encoding', 'answer')],
  result: gapLineExpectedResult(project, 'discovery:encoding', 'answer') };
function roots(f: Fixture) {
  return f.store.list<RepairSeries>('repair-series').filter(row => row.value.projectId === project && 'block' in row.value)
    .filter(row => !f.store.list<RepairSeries>('repair-series').some(other => other.value.predecessor?.id === row.id)).map(reference);
}
function transition(f: Fixture, version: string, extra: Partial<HorizonRequest['choice']> = {}) {
  const horizon = f.horizon(version, extra);
  assert.equal(horizon.gate.value.state, 'accepted');
  const prepared = ok(writeSeriesTransition(f.store, { project, choiceVersion: version, horizon: reference(horizon.gate), series: roots(f) }));
  const issuance = ok(writeHorizonIssuance(f.store, { project, choiceVersion: version, horizon: reference(horizon.gate), transition: reference(prepared) }));
  return { horizon, prepared, issuance, request: { project, prepared: reference(prepared), issuance: reference(issuance) } };
}
function activate(f: Fixture, version = 'active') {
  return ok(applySeriesActivation(f.store, transition(f, version).request));
}
function exclude(f: Fixture, version = 'excluded') {
  const prepared = transition(f, version, { features: [{ outcome: 'garden-later' }],
    excluded: [{ block, reason: 'Keep the independent result only', returnCondition: 'Select the original feature again' }] });
  return ok(applySeriesActivation(f.store, prepared.request));
}
function head(f: Fixture, owner = block, line = 1) {
  return ok(readSeries(f.store, { project, block: owner, line }));
}
function stop(f: Fixture, count = 3) {
  for (let attempt = 1; attempt <= count; attempt++) {
    ok(beginAttempt(f.store, { project, block, line: 1, attempt, goal: workGoal }));
    ok(completeAttempt(f.store, { project, block, line: 1, attempt, outcome: { reason: 'off-form', achieved: [], cancelled: [], refusals: [] } }));
  }
  return head(f);
}
function product(f: Fixture, managed = true, begin = true, priorNoProgress = 0) {
  f.series();
  const first = transition(f, 'initial');
  if (managed) ok(applySeriesActivation(f.store, first.request));
  const sources: GapRequest = { project, input: reference(f.input), graph: reference(f.graph), horizon: reference(first.horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(f.graph), horizon: reference(first.horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(f.store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(f.store, sources)), gapRequest = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = ok(prepareQuestionTasks(f.store, { project, gaps: gapRequest,
    questions: gaps.records.filter(row => row.value.gap.kind === 'repository-fact' && row.value.gap.code !== 'inventory_missing' && !row.value.gap.deferral)
      .map(gap => ({ gap: reference(gap), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) }));
  const routes = ok(writeRoutes(f.store, { project, gaps: gapRequest, tasks: tasks.tasks.map(task => ({ pending: clone(task.writes[0]!) as Write })),
    catalog: { paths: ['e4-source.txt'], records: [] }, previous: null }));
  writeFileSync(join(f.root, 'e4-source.txt'), 'UTF-8 is supported.');
  const batch = routes.value.batches.find(row => row.model === 'MC1' && row.items.some(item => item.target === 'discovery:encoding'))!;
  assert.ok(batch);
  const scenario = join(f.root, 'scenario.json'), trace = join(f.root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [fixturePath, '--scenario', scenario, '--trace', trace] };
  const environment = f.engine.environments.configure(project, { workspace: f.root,
    implementer: { actor: 'current-worker', model: 'fixture', effort: 'high', speed: 'fast', command },
    reviewer: { actor: 'current-reviewer', model: 'fixture-reviewer', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: 100000 }, 0);
  const adapter = f.store.write({ id: `adapter:${project}:current`, kind: 'dispatch-adapter', expected: 0, value: { projectId: project, protocol: 'codex-stdio' } });
  const goal = { key: 'current:fact', questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  for (let attempt = 1; attempt <= priorNoProgress; attempt++) {
    ok(beginAttempt(f.store, { project, block, line: 1, attempt, goal }));
    ok(completeAttempt(f.store, { project, block, line: 1, attempt, outcome: { reason: 'off-form', achieved: [], cancelled: [], refusals: [] } }));
  }
  const ordinal = priorNoProgress + 1;
  const series = begin ? ok(beginAttempt(f.store, { project, block, line: 1, attempt: ordinal, goal })) : head(f);
  const packetRequest: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(environment),
    attempt: { series: reference(series), ordinal }, previous: [] };
  const source = f.store.get<{ content: string }>(`source:${project}:brief`)!;
  return { ...f, get store() { return f.store; }, get engine() { return f.engine; }, first, running: series, goal, packetRequest, environment, adapter, source, batch, gapRequest, gaps, routes,
    scenario, trace, steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ steps })); },
    sent() { return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; } };
}
function ready(f: ReturnType<typeof product>) {
  const packet = ok(writeQuestionPacket(f.store, f.packetRequest)).record;
  const request: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(f.adapter), config: reference(f.environment) }, role: 'implementer' };
  return { packet, request };
}
function fact(f: ReturnType<typeof product>) {
  return { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'answer', results: [{ questionId: f.batch.items[0]!.gap, value: 'UTF-8',
    citations: [{ source: reference(f.source), selector: { kind: 'text-range', start: 0, end: f.source.value.content.length } }] }] };
}

test('B3.0b real P G activation preserves legacy attempts stops and ladder across continue exclusion and return', t => {
  const f = fixture(t), original = f.series(), stopped = stop(f), saved = ok(readStopHistory(f.store, { project, block, line: 1 }));
  const first = activate(f), active = head(f);
  assert.equal(first.record.value.decisions[0]!.outcome, 'establish-basis');
  assert.equal(active.value.slice, opaqueSlice);
  assert.deepEqual(active.value.attempts, stopped.value.attempts);
  assert.deepEqual(active.value.stop, stopped.value.stop); assert.deepEqual(active.value.ladder, stopped.value.ladder);
  assert.deepEqual(ok(readSeriesAt(f.store, project, reference(original))), original);
  const continued = activate(f, 'same-local-slice');
  assert.equal(continued.record.value.decisions[0]!.outcome, 'continue');
  const inactive = exclude(f), excluded = head(f);
  assert.equal(inactive.record.value.decisions[0]!.participation, 'excluded');
  assert.equal(ok(prepareSeriesParticipantAdmission(f.store, project, reference(excluded))).participation, 'excluded');
  rejected(prepareSeriesLineAdmission(f.store, project, reference(excluded)));
  rejected(beginAttempt(f.store, { project, block, line: 1, attempt: 4, goal: workGoal }));
  const returned = activate(f, 'return-original');
  assert.equal(returned.record.value.decisions[0]!.outcome, 'continue');
  assert.deepEqual(head(f).value.attempts, stopped.value.attempts);
  assert.deepEqual(ok(readStopHistory(f.store, { project, block, line: 1 })), saved);
  const pointer = returned.pointer, record = returned.record, before = snapshot(f.store); f.restart();
  assert.deepEqual(ok(readCurrentSeriesPointer(f.store, { project, record: reference(pointer) })), pointer);
  assert.deepEqual(ok(readAppliedSeriesTransition(f.store, { project, record: reference(record) })), record);
  assert.deepEqual(ok(readStopHistoryAt(f.store, project, reference(stopped))), saved);
  assert.deepEqual(ok(applySeriesActivation(f.store, { project, prepared: record.value.prepared, issuance: record.value.issuance })).writes, []);
  assert.deepEqual(snapshot(f.store), before);
});

test('B3.0b first root and bootstrap serialize in both orders with no partial neighbor', t => {
  for (const first of ['root', 'bootstrap'] as const) {
    const f = fixture(t); f.series();
    const other = new Store(f.path); t.after(() => other.close());
    const pair = transition(f, `race-${first}`), activation = ok(prepareSeriesActivation(f.store, pair.request));
    const root = ok(prepareOpenSeries(other, { project, block: independent, line: 1, slice: 'legacy:new-root', predecessor: null, basis: null }));
    assert.ok(root.guards.some(guard => guard.id === seriesMembershipId(project)));
    assert.ok(activation.guards.some(guard => guard.id === seriesMembershipId(project)));
    if (first === 'root') { ok(commit(other, root)); rejected(commit(f.store, activation)); assert.equal(f.store.get(activation.record.id), null); }
    else { ok(commit(f.store, activation)); rejected(commit(other, root)); assert.equal(f.store.get(root.writes[0]!.id), null); }
    assert.equal(f.store.list('om-series-applied').length, first === 'root' ? 0 : 1);
  }
});

test('B3.0b successor and bootstrap CAS the predecessor in both orders', t => {
  for (const first of ['successor', 'bootstrap'] as const) {
    const f = fixture(t), source = f.series(), pair = transition(f, `successor-${first}`);
    const other = new Store(f.path); t.after(() => other.close());
    const activation = ok(prepareSeriesActivation(f.store, pair.request));
    const successor = ok(prepareOpenSeries(other, { project, block, line: 2, slice: 'legacy:another-subject', predecessor: reference(source),
      basis: { ground: 'inputs-changed', text: 'The source changed before adoption' } }));
    assert.ok(successor.writes.some(write => write.id === source.id));
    if (first === 'successor') { ok(commit(other, successor)); rejected(commit(f.store, activation)); assert.equal(f.store.get(activation.record.id), null); }
    else { ok(commit(f.store, activation)); rejected(commit(other, successor)); assert.equal(f.store.get(successor.writes[0]!.id), null); }
  }
});

test('B3.0b managed root must be registered unactivated then included in a new full P G pair', t => {
  const f = fixture(t); f.series(); activate(f);
  const stale = transition(f, 'before-new-root');
  const added = f.series(independent);
  assert.equal(added.value.activation?.state, 'unactivated');
  assert.equal(ok(prepareSeriesParticipantAdmission(f.store, project, reference(added))).participation, 'unactivated');
  rejected(prepareSeriesLineAdmission(f.store, project, reference(added)));
  rejected(beginAttempt(f.store, { project, block: independent, line: 1, attempt: 1, goal: workGoal }));
  rejected(applySeriesActivation(f.store, stale.request));
  const fresh = transition(f, 'include-new-root', { features: [{ outcome: 'garden-result' }, { outcome: 'garden-later' }] });
  const applied = ok(applySeriesActivation(f.store, fresh.request));
  assert.equal(applied.record.value.decisions.find(row => row.block === independent)!.outcome, 'establish-basis');
  ok(prepareSeriesLineAdmission(f.store, project, reference(head(f, independent))));
  rejected(openSeries(f.store, { project, block: independent, line: 2, slice: 'unproved-string', predecessor: reference(head(f, independent)),
    basis: { ground: 'inputs-changed', text: 'A caller cannot manufacture managed succession' } }));
});

test('B3.0b participant membership changes invalidate an already prepared managed activation', t => {
  const f = fixture(t); f.series(); activate(f);
  const next = ok(prepareSeriesActivation(f.store, transition(f, 'complete-at-prepare').request));
  const other = new Store(f.path);
  try { ok(openSeries(other, { project, block: independent, line: 1, slice: opaqueSlice, predecessor: null, basis: null })); }
  finally { other.close(); }
  rejected(commit(f.store, next)); assert.equal(f.store.get(next.record.id), null);
  assert.equal(f.store.get(seriesCurrentId(project))!.revision, 1);
});

test('B3.0b current admission preserves immutable pointer refs while attempt heads advance and rejects pointer loss', t => {
  const f = fixture(t); f.series(); const applied = activate(f);
  const active = head(f), admitted = ok(prepareSeriesLineAdmission(f.store, project, reference(active)));
  assert.deepEqual(admitted.pointer, reference(applied.pointer));
  assert.ok(admitted.guards.some(guard => canonical(guard) === canonical(reference(applied.pointer))));
  const running = ok(beginAttempt(f.store, { project, block, line: 1, attempt: 1, goal: workGoal }));
  assert.deepEqual(f.store.get(seriesCurrentId(project)), applied.pointer);
  assert.deepEqual(ok(prepareSeriesLineAdmission(f.store, project, reference(running))).pointer, reference(applied.pointer));
  erase(f.store, seriesCurrentId(project));
  rejected(prepareSeriesLineAdmission(f.store, project, reference(running)));
  rejected(prepareSeriesParticipantAdmission(f.store, project, reference(running)));
  rejected(beginAttempt(f.store, { project, block, line: 1, attempt: 2, goal: workGoal }));
  assert.deepEqual(ok(readSeriesAt(f.store, project, reference(active))), active);
});

test('B3.0b managed series cannot masquerade as legacy by dropping activation contract or basis', t => {
  for (const field of ['contract', 'activation', 'applied', 'activeBasis', 'registered'] as const) {
    const f = fixture(t); f.series(); activate(f);
    const original = field === 'registered' ? f.series(independent) : head(f);
    const value = clone(original.value) as unknown as Record<string, Json>;
    if (field === 'contract' || field === 'activation') delete value[field];
    else delete (value['activation'] as Record<string, Json>)[field];
    const forged = rewrite(f.store, original, value as unknown as RepairSeries);
    rejected(readSeriesAt(f.store, project, reference(forged)));
    rejected(prepareSeriesLineAdmission(f.store, project, reference(forged)));
  }
});

function e1Request(f: ReturnType<typeof product>, id: string): RecordCallRequest {
  return { call: id, purpose: 'model-research', basis: null, block, series: reference(f.running), attempt: 1, goal: f.goal,
    gaps: f.batch.items.map(item => ({ id: item.target, goal: item.target, field: item.field, consumer: block })),
    dispatch: { adapter: reference(f.adapter), config: reference(f.environment) }, packet: { purpose: 'B3.0b exact E1 proof' } };
}

test('B3.0b E1 and E2 prepared before bootstrap refuse new dispatch while exact saved history remains readable', t => {
  const f = product(fixture(t), false), q = ok(prepareQuestionPacket(f.store, f.packetRequest));
  const callRequest = e1Request(f, 'before-bootstrap'), call = ok(recordCall(f.store, project, callRequest));
  const launch = ok(prepareCallDispatch(f.store, project, reference(call.call)));
  ok(commit(f.store, q));
  activate(f, 'adopt-running');
  rejected(commit(f.store, { ...q, writes: [{ id: 'stale-e2-write', kind: 'test', expected: 0, value: {} }] }));
  rejected(commit(f.store, { writes: [{ id: 'stale-e1-write', kind: 'test', expected: 0, value: {} }], guards: launch.guards }));
  rejected(prepareCallDispatch(f.store, project, reference(call.call)));
  rejected(recordCall(f.store, project, { ...callRequest, call: 'fresh-after-bootstrap' }));
  assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(q.record) })), q.record);
  assert.deepEqual(ok(readCall(f.store, project, reference(call.call))), call.call);
  assert.deepEqual(ok(recordCall(f.store, project, callRequest)).call, call.call);
  assert.equal(f.store.get('stale-e1-write'), null); assert.equal(f.store.get('stale-e2-write'), null);
});

test('B3.0b E2 new packet transaction guards the active pointer and cannot commit after exclusion', t => {
  const f = product(fixture(t)), prepared = ok(prepareQuestionPacket(f.store, f.packetRequest));
  assert.ok(prepared.guards.some(guard => guard.id === seriesCurrentId(project)));
  exclude(f);
  rejected(commit(f.store, prepared)); assert.equal(f.store.get(prepared.record.id), null);
  rejected(prepareQuestionPacket(f.store, f.packetRequest));
});

async function received(f: ReturnType<typeof product>, request: ModelCallRequest) {
  f.steps([{ research: fact(f), usage }]);
  const writeMany = f.store.writeMany.bind(f.store); let paused = false;
  f.store.writeMany = ((writes, guards) => {
    const result = writeMany(writes, guards);
    if (!paused && writes.some(write => write.kind === 'model-call' && (write.value as unknown as OmModelCall).om.application === 'received')) {
      paused = true; throw new Error('B3.0b pause after durable receipt');
    }
    return result;
  }) as Store['writeMany'];
  try { await assert.rejects(runModelCall(f.store, request), /B3.0b pause after durable receipt/); }
  finally { f.store.writeMany = writeMany; }
  const record = f.store.list<OmModelCall>('model-call')[0]!;
  assert.equal(ok(readModelCallState(f.store, { project, record: reference(record) })).state, 'received');
  return record;
}

test('B3.0b E4 exclusion keeps physical response and single settlement after restart until explicit proof close', async t => {
  const f = product(fixture(t)), { request } = ready(f), receipt = await received(f, request);
  const prior = head(f); const changed = exclude(f); f.restart();
  const actual = ok(await runModelCall(f.store, request)), runtime = actual.record;
  assert.equal(runtime.value.om.version, 'om-model-call/v1');
  assert.equal(runtime.value.om.application, 'application-refused'); assert.ok(runtime.value.om.terminal);
  assert.equal(runtime.value.om.completion, null); assert.equal(runtime.value.om.diagnostic, null);
  assert.equal(actual.outcome, null); assert.equal(actual.part, null);
  assert.deepEqual(runtime.value.usage, usage); assert.deepEqual(runtime.value.response, receipt.value.response);
  assert.equal(head(f).value.attempts[0]!.outcome, null);
  assert.deepEqual(head(f).value.attempts, prior.value.attempts);
  const proof = ok(readModelTerminalWitness(f.store, { project, record: reference(runtime) }));
  assert.deepEqual(proof.series, reference(f.running)); assert.equal(proof.attempt, 1); assert.deepEqual(proof.goal, f.goal);
  assert.deepEqual(proof.change.currentPointer, reference(changed.pointer));
  ok(readModelCallPhysical(f.store, { project, record: reference(runtime) }));
  ok(readModelCallState(f.store, { project, record: reference(runtime) }));
  ok(readModelCall(f.store, { project, record: reference(runtime) }));
  assert.ok(runtime.value.om.rejection); ok(readModelApplicationRejection(f.store, { project, record: runtime.value.om.rejection! }));
  const call = f.store.get(runtime.value.om.call.id)!;
  assert.equal(f.store.history(call.id).length, 2); assert.equal(f.sent().length, 1);
  const unchanged = snapshot(f.store); f.restart();
  assert.deepEqual(ok(await runModelCall(f.store, request)), { ...actual, repeated: true }); assert.deepEqual(snapshot(f.store), unchanged);
  const close = { project, block, line: 1, attempt: 1, terminal: reference(runtime),
    outcome: { reason: 'interrupted' as const, achieved: [], cancelled: [], refusals: [] } };
  const closed = ok(completeAttempt(f.store, close));
  assert.equal(closed.value.attempts[0]!.outcome?.reason, 'interrupted'); assert.equal(closed.value.withoutProgress, 1);
  assert.deepEqual(ok(completeAttempt(f.store, close)), closed);
  rejected(beginAttempt(f.store, { project, block, line: 1, attempt: 2, goal: f.goal }));
  activate(f, 'return-after-close');
  const next = ok(beginAttempt(f.store, { project, block, line: 1, attempt: 2, goal: f.goal }));
  assert.equal(next.value.attempts.length, 2); assert.deepEqual(next.value.attempts[0], closed.value.attempts[0]);
  assert.equal(f.store.history(call.id).length, 2); assert.equal(f.sent().length, 1);
  assert.deepEqual(ok(readModelCall(f.store, { project, record: reference(runtime) })), { ...actual, repeated: true });
});

test('B3.0b missing or foreign E4 terminal proof cannot authorize explicit completion or historical readers', async t => {
  const f = product(fixture(t)), { request } = ready(f); await received(f, request); exclude(f);
  const terminal = ok(await runModelCall(f.store, request)).record;
  for (const variant of ['missing', 'foreign-series', 'foreign-pointer', 'wrong-ordinal'] as const) {
    const value = clone(terminal.value) as OmModelCall;
    if (variant === 'missing') delete value.om.terminal;
    else if (variant === 'foreign-series') value.om.terminal!.series = { ...value.om.terminal!.series, id: 'repair-series:other:foreign:1' };
    else if (variant === 'foreign-pointer') value.om.terminal!.change.currentPointer = { ...value.om.terminal!.change.currentPointer, id: 'om-series-current:other' };
    else value.om.terminal!.attempt++;
    const forged = f.store.write({ id: terminal.id, kind: terminal.kind, expected: f.store.get(terminal.id)!.revision, value: value as unknown as Json });
    rejected(readModelTerminalWitness(f.store, { project, record: reference(forged) }));
    rejected(readModelCall(f.store, { project, record: reference(forged) }));
    rejected(completeAttempt(f.store, { project, block, line: 1, attempt: 1, terminal: reference(forged),
      outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } }));
  }
  const rejection = f.store.get<Record<string, unknown>>(terminal.value.om.rejection!.id, terminal.value.om.rejection!.revision)!;
  const missingRejection = clone(rejection.value); delete missingRejection['terminal'];
  const noBasis = rewrite(f.store, rejection, missingRejection);
  const noTerminal = clone(terminal.value) as OmModelCall; delete noTerminal.om.terminal; noTerminal.om.rejection = reference(noBasis);
  const forgedRuntime = rewrite(f.store, terminal, noTerminal);
  rejected(readModelCallPhysical(f.store, { project, record: reference(forgedRuntime) }));
  rejected(readModelCall(f.store, { project, record: reference(forgedRuntime) }));
  rewrite(f.store, noBasis, rejection.value); rewrite(f.store, forgedRuntime, terminal.value as OmModelCall);
  rejected(completeAttempt(f.store, { project, block, line: 1, attempt: 1, outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } }));
  assert.equal(head(f).value.attempts[0]!.outcome, null); assert.equal(f.sent().length, 1);
  ok(readModelCall(f.store, { project, record: reference(terminal) }));
});

function emptyProject(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-current-era-')), path = join(root, 'state.sqlite');
  let store = new Store(path); new ProductEngine(store).execute({ type: 'create-project', project, title: 'Era boundary' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { get store() { return store; }, restart() { store.close(); store = new Store(path); } };
}
function assessmentError(engine: ProductEngine) {
  try { engine.execute({ type: 'assess', project, expected: 0 }); }
  catch (error) { assert.ok(error instanceof EngineError); return { code: error.code, details: error.details }; }
  assert.fail('An empty native project requires upstream work');
}

test('B3.0b real legacy membership before B1 remains native for projection and assess', t => {
  const f = emptyProject(t), engine = new ProductEngine(f.store), projection = engine.projection(project), failure = assessmentError(engine);
  const series = ok(openSeries(f.store, { project, block, line: 1, slice: opaqueSlice, predecessor: null, basis: null }));
  const member = f.store.get<{ mode: string; activation: Ref | null; roots: { block: string; root: Ref }[] }>(seriesMembershipId(project))!;
  assert.equal(member.value.mode, 'legacy'); assert.equal(member.value.activation, null);
  assert.deepEqual(member.value.roots, [{ block, root: reference(series) }]);
  for (const restart of [false, true]) {
    if (restart) f.restart();
    const current = new ProductEngine(f.store), before = snapshot(f.store);
    assert.deepEqual(current.projection(project), projection); assert.deepEqual(assessmentError(current), failure);
    assert.deepEqual(snapshot(f.store), before);
  }
});

test('B3.0b lost B1 with only P or G retained including partial envelopes refuses projection and assess', t => {
  const source = fixture(t); source.series(); const pair = transition(source, 'standalone-provenance');
  for (const saved of [pair.prepared, pair.issuance]) for (const partial of [false, true]) {
    const f = emptyProject(t);
    f.store.write({ id: saved.id, kind: saved.kind, expected: 0, value: partial ? {} : saved.value });
    for (const restart of [false, true]) {
      if (restart) f.restart();
      const engine = new ProductEngine(f.store), before = snapshot(f.store);
      for (const operation of [() => engine.projection(project), () => engine.execute({ type: 'assess', project, expected: 0 })]) {
        assert.throws(operation, (error: unknown) => error instanceof EngineError && error.code === 'record_missing'
          && (error.details as { target?: string }).target === `om-input:${project}`);
        assert.deepEqual(snapshot(f.store), before);
      }
    }
  }
});

function analysis(f: ReturnType<typeof product>) {
  const stopped = stop(f);
  const request = { project, series: reference(stopped), hold: null,
    dispatch: { config: reference(f.environment), adapter: reference(f.adapter) } };
  return { request, answer: { protocol: 'omg-stop-analysis/v1',
    cause: { kind: 'hypothesis', text: 'Repeated off-form answers have supplied no accepted result.', sources: [] },
    change: { text: 'Check the expected form before repeating the question.', addresses: [{ ref: request.series, field: 'attempts' }] }, origin: null } };
}

test('B3.0b A6 saved managed intent restores original exact admission and refuses missing or foreign proof', t => {
  for (const missing of ['proof', 'pointer', 'foreign-proof'] as const) {
    const f = product(fixture(t), true, false), a = analysis(f), prepared = ok(prepareStopAnalysis(f.store, a.request));
    assert.deepEqual(prepared.writes.map(write => write.kind), ['om-analysis-intent', 'om-analysis-admission']);
    assert.ok(prepared.guards.some(guard => guard.id === seriesCurrentId(project)));
    ok(commit(f.store, prepared));
    const proof = f.store.list<{ pointer: Ref; series: Ref }>('om-analysis-admission')[0]!;
    if (missing === 'proof') erase(f.store, proof.id);
    else if (missing === 'pointer') erase(f.store, seriesCurrentId(project));
    else rewrite(f.store, proof, { ...proof.value, pointer: { ...proof.value.pointer, id: 'om-series-current:foreign' } });
    f.restart(); rejected(prepareStopAnalysis(f.store, a.request)); assert.equal(f.sent().length, 0);
  }
});

test('B3.0b old A6 intent cannot reacquire admission after bootstrap or exclusion and never resends', async t => {
  for (const managed of [false, true]) {
    const f = product(fixture(t), managed, false), a = analysis(f), prepared = ok(prepareStopAnalysis(f.store, a.request));
    ok(commit(f.store, prepared));
    if (managed) exclude(f); else activate(f, 'adopt-stopped-intent');
    f.steps([{ research: a.answer, usage }]); f.restart();
    rejected(await runStopAnalysis(f.store, a.request)); assert.equal(f.sent().length, 0);
    assert.equal(f.store.list('om-stop-review').length, 0);
    const retry = ok(prepareStopAnalysis(f.store, a.request));
    assert.ok(retry.guards.some(guard => guard.id === a.request.series.id && 'revision' in guard && guard.revision === a.request.series.revision));
    rejected(commit(f.store, { writes: [{ id: 'stale-analysis-application', kind: 'test', expected: 0, value: null }], guards: retry.guards }));
  }
});

async function driverCheckpoint(path: string, child: ChildProcess): Promise<void> {
  if (existsSync(path)) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timeout); watcher.close(); child.off('exit', ended); error ? reject(error) : resolve(); };
    const ended = () => finish(new Error('B3.0b driver exited before physical claim'));
    const watcher = watch(dirname(path), () => { if (existsSync(path)) finish(); });
    const timeout = setTimeout(() => finish(new Error('B3.0b physical checkpoint timed out')), 20000);
    child.once('exit', ended); if (existsSync(path)) finish();
  });
}

test('B3.0b actual lost E4 owner recovers exclusion without auto-close resend or invented usage', async t => {
  const f = product(fixture(t)), { request } = ready(f), checkpoint = join(f.root, 'claimed.json');
  f.steps([{ research: fact(f), usage }]);
  const spec = join(f.root, 'driver.json');
  writeFileSync(spec, JSON.stringify({ database: f.path, output: join(f.root, 'driver-out.json'), operation: 'call', request,
    checkpoint: { path: checkpoint, kind: 'model-call', matches: [{ path: ['execution', 'phase'], value: 'claimed' }] } }));
  const child = spawn(process.execPath, [fixturePath, '--driver', spec], { cwd: f.root, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr!.on('data', data => { stderr += data.toString(); });
  const exit = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  await driverCheckpoint(checkpoint, child); assert.equal(f.sent().length, 0, stderr);
  const claimed = f.store.list<OmModelCall>('model-call')[0]!;
  exclude(f); assert.equal(child.kill('SIGKILL'), true); await exit; f.restart();
  const recovered = f.engine.execute({ type: 'recover-model-call', project, call: reference(claimed) }) as Revision<ModelCall>;
  assert.equal(recovered.value.status, 'failed'); assert.equal(recovered.value.usage, null); assert.equal(recovered.value.response, null);
  const runtime = recovered as Revision<OmModelCall>;
  assert.equal(runtime.value.om.application, 'recovered'); assert.ok(runtime.value.om.terminal);
  assert.equal(runtime.value.om.completion, null); assert.equal(head(f).value.attempts[0]!.outcome, null);
  assert.equal(readModelCallRecovery(f.store, project, reference(recovered)).proof!.physical, 'unknown');
  ok(readModelTerminalWitness(f.store, { project, record: reference(runtime) }));
  const before = snapshot(f.store); f.restart();
  ok(await runModelCall(f.store, request)); assert.deepEqual(snapshot(f.store), before); assert.equal(f.sent().length, 0);
  const closed = ok(completeAttempt(f.store, { project, block, line: 1, attempt: 1, terminal: reference(runtime),
    outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } }));
  assert.equal(closed.value.withoutProgress, 1);
});

test('B3.0b whole 8be4a5d producer history keeps old bytes across activation and restart', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-current-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const run = (executable: string, args: string[], cwd: string) => {
    const child = spawnSync(executable, args, { cwd, env: environment, encoding: 'utf8', timeout: 90000, maxBuffer: 20000000 });
    assert.equal(child.error, undefined, child.error?.message); assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`); return child.stdout;
  };
  const repository = run('git', ['rev-parse', '--show-toplevel'], dirname(fileURLToPath(import.meta.url))).trim();
  const legacy = join(root, 'base'), archive = join(root, 'base.tar'); mkdirSync(legacy);
  run('git', ['archive', '--format=tar', '--output', archive, '8be4a5db48bd5de234ddaed90c947c9fb7d78efe'], repository);
  run('tar', ['-xf', archive, '-C', legacy], root); symlinkSync(join(repository, 'node_modules'), join(legacy, 'node_modules'), 'dir');
  writeFileSync(join(legacy, 'tsconfig.current-history.json'), JSON.stringify({ extends: './tsconfig.json',
    include: ['src/**/*.ts', 'test/om-fixture.ts', 'test/product-fixture.ts'], exclude: [] }));
  run(process.execPath, [join(legacy, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.current-history.json'], legacy);
  const database = join(root, 'old.sqlite'), output = join(root, 'old.json'), producerFile = join(legacy, 'old-producer.mjs');
  writeFileSync(producerFile, `
import assert from 'node:assert/strict'; import {writeFileSync} from 'node:fs';
import {Store} from './dist/src/storage/store.js'; import {canonical} from './dist/src/canonical.js';
import {ProductEngine} from './dist/src/product/engine.js'; import {projectGraph} from './dist/src/graph/project.js';
import {reference} from './dist/src/pipeline/contracts.js'; import {UPSTREAM_STAGES} from './dist/src/discovery/requirements.js';
import {writeOmInput} from './dist/src/om/input.js'; import {writeHorizon,writeHorizonIssuance} from './dist/src/om/horizon.js';
import {openSeries,beginAttempt,completeAttempt} from './dist/src/om/series.js';
import {writeSeriesTransition} from './dist/src/om/series-transition.js';
import {preparedFeatures} from './dist/test/product-fixture.js'; import {gardenGraph} from './dist/test/om-fixture.js';
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
const project='garden',block='garden-consume-block',store=new Store(process.argv[2]);
const {level,...upper}=projectGraph(gardenGraph(),1);preparedFeatures(new ProductEngine(store),project,upper);
const stages=Object.fromEntries(UPSTREAM_STAGES.map(stage=>[stage,reference(store.get('stage:'+project+':'+stage))]));
const input=ok(writeOmInput(store,{project,expected:0,stages})),graph=store.get('graph:'+project);
const horizon=ok(writeHorizon(store,{project,input:reference(input),graph:reference(graph),refinement:null,available:{},
choice:{choiceVersion:'old-choice',features:[{outcome:'garden-result'}],excluded:[]}}));
let series=ok(openSeries(store,{project,block,line:1,slice:'legacy:opaque-subject',predecessor:null,basis:null}));
for(let attempt=1;attempt<=3;attempt++){
ok(beginAttempt(store,{project,block,line:1,attempt,goal:{key:'legacy-question',questions:['Which proposal works?'],result:'accepted proposal'}}));
series=ok(completeAttempt(store,{project,block,line:1,attempt,outcome:{reason:'off-form',achieved:[],cancelled:[],refusals:[]}}));}
const p=ok(writeSeriesTransition(store,{project,choiceVersion:'old-choice',horizon:reference(horizon.gate),series:[reference(series)]}));
const g=ok(writeHorizonIssuance(store,{project,choiceVersion:'old-choice',horizon:reference(horizon.gate),transition:reference(p)}));
assert.ok(series.value.stop);assert.equal(store.get('om-series-membership:'+project),null);
const rows=store.list().flatMap(row=>store.history(row.id));
writeFileSync(process.argv[3],JSON.stringify({series,p,g,rows,bytes:canonical(rows)}));store.close();
`);
  run(process.execPath, [producerFile, database, output], legacy);
  const old = JSON.parse(readFileSync(output, 'utf8')) as { series: Revision<RepairSeries>; p: Revision; g: Revision; rows: Revision[]; bytes: string };
  for (const first of ['root', 'activation'] as const) {
    const path = join(root, `race-${first}.sqlite`); copyFileSync(database, path);
    const primary = new Store(path), other = new Store(path);
    try {
      const activation = ok(prepareSeriesActivation(primary, { project, prepared: reference(old.p), issuance: reference(old.g) }));
      const opening = ok(prepareOpenSeries(other, { project, block: independent, line: 1, slice: 'legacy:concurrent-root', predecessor: null, basis: null }));
      for (const prepared of [activation, opening]) assert.equal(prepared.writes.find(write => write.id === seriesMembershipId(project))!.expected, 0);
      if (first === 'root') { ok(commit(other, opening)); rejected(commit(primary, activation)); assert.equal(primary.get(activation.record.id), null); }
      else { ok(commit(primary, activation)); rejected(commit(other, opening)); assert.equal(primary.get(opening.writes[0]!.id), null); }
      assert.deepEqual(ok(readSeriesAt(primary, project, reference(old.series))), old.series);
    } finally { primary.close(); other.close(); }
  }
  {
    const path = join(root, 'capture-before-enumeration.sqlite'); copyFileSync(database, path);
    const primary = new Store(path), other = new Store(path);
    try {
      let captured = false, injected = false;
      const view = new Proxy(primary, { get(target, prop) {
        if (prop === 'get') return (id: string, revision?: number) => {
          const record = target.get(id, revision);
          if (id === seriesMembershipId(project) && revision === undefined && record === null) captured = true;
          return record;
        };
        if (prop === 'list') return (kind?: string) => {
          if (kind === 'repair-series' && !injected) {
            assert.equal(captured, true, 'The absent membership source is captured before enumerating legacy roots'); injected = true;
            ok(openSeries(other, { project, block: 'garden-produce-block', line: 1, slice: 'legacy:window-root', predecessor: null, basis: null }));
          }
          return target.list(kind);
        };
        const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
      } });
      const prepared = ok(prepareOpenSeries(view, { project, block: independent, line: 1, slice: 'legacy:prepared-root', predecessor: null, basis: null }));
      assert.equal(injected, true);
      const membership = prepared.writes.find(write => write.id === seriesMembershipId(project))!;
      assert.deepEqual((membership.value as { roots: { block: string }[] }).roots.map(row => row.block).sort(), [block, independent, 'garden-produce-block'].sort());
      assert.equal(membership.expected, 0, 'The same transaction retains its original absent-membership CAS');
      rejected(commit(primary, prepared)); assert.equal(primary.get(prepared.writes[0]!.id), null);
    } finally { primary.close(); other.close(); }
  }
  let store = new Store(database);
  try {
    assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), old.bytes);
    assert.deepEqual(ok(readSeriesAt(store, project, reference(old.series))), old.series);
    assert.deepEqual(ok(readPreparedSeriesTransition(store, { project, record: reference(old.p) })).record, old.p);
    assert.deepEqual(ok(readHorizonIssuance(store, { project, record: reference(old.g) })).record, old.g);
    const applied = ok(applySeriesActivation(store, { project, prepared: reference(old.p), issuance: reference(old.g) }));
    assert.equal(applied.record.value.decisions[0]!.outcome, 'establish-basis');
    assert.deepEqual(applied.series[0]!.value.stop, old.series.value.stop);
    assert.deepEqual(applied.series[0]!.value.ladder, old.series.value.ladder);
    assert.deepEqual(applied.series[0]!.value.attempts, old.series.value.attempts);
    for (const row of old.rows) assert.deepEqual(store.get(row.id, row.revision), row);
    store.close(); store = new Store(database);
    assert.deepEqual(ok(readSeriesAt(store, project, reference(old.series))), old.series);
    assert.deepEqual(ok(readCurrentSeriesPointer(store, { project, record: reference(applied.pointer) })), applied.pointer);
  } finally { store.close(); }
});

async function nativeAnswer(f: ReturnType<typeof product>) {
  const { packet } = ready(f), native = packet.value.native[0]!;
  assert.ok(native);
  const question = f.store.get<Question>(native.engineQuestion.id, native.engineQuestion.revision)!;
  f.steps([{ research: { verdict: 'supported', reasons: [] }, usage }]);
  const assessment = await assessAnswer(f.store, question, { action: 'answer', question: question.id, value: 'UTF-8',
    citations: [{ source: reference(f.source), selector: { kind: 'text-range', start: 0, end: f.source.value.content.length } }] }, f.environment, f.root);
  const draft = f.engine.discovery.researched(question.id, question.revision, reference(assessment));
  const answered = f.store.get<Question>(question.id)!;
  const request: AnswerRequest = { project, question: native.question, answer: answered.value.answer!,
    answeredQuestion: reference(answered), draft: reference(draft), attempt: { series: reference(f.running), attempt: 1 } };
  const producer = f.store.get<Mc1QuestionRecord>(native.question.id, native.question.revision)!;
  assert.ok(producer.value.request.task);
  return { request, task: producer.value.request.task! };
}

function forbidCurrentPointer(store: Store) {
  return new Proxy(store, { get(target, prop) {
    if (prop === 'get') return (id: string, revision?: number) => {
      assert.ok(id !== seriesCurrentId(project) || revision !== undefined, 'Historical reuse may not select the current series pointer');
      return target.get(id, revision);
    };
    const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
}

test('B3.0b D5 new bound acceptance guards current C while exact repeat and reuse retain the old fact', async t => {
  for (const saveFirst of [false, true]) {
    const f = product(fixture(t)), answer = await nativeAnswer(f), prepared = ok(prepareAcceptedAnswer(f.store, answer.request));
    assert.ok(prepared.guards.some(guard => guard.id === seriesCurrentId(project)));
    const accepted = saveFirst ? ok(writeAcceptedAnswer(f.store, answer.request)) : null;
    const other = new Store(f.path);
    try { const change = transition(f, 'exclude-answer', { features: [{ outcome: 'garden-later' }],
      excluded: [{ block, reason: 'Suspend this result', returnCondition: 'Select it again' }] });
      ok(applySeriesActivation(other, change.request)); }
    finally { other.close(); }
    if (!accepted) {
      rejected(commit(f.store, prepared)); assert.equal(f.store.get(prepared.record.id), null);
      rejected(prepareAcceptedAnswer(f.store, answer.request));
      const independentFact = ok(writeAcceptedAnswer(f.store, { ...answer.request, attempt: null }));
      assert.equal(independentFact.value.request.attempt, null);
    } else {
      const view = forbidCurrentPointer(f.store), snapshotBefore = snapshot(f.store);
      assert.deepEqual(ok(writeAcceptedAnswer(view, answer.request)), accepted);
      assert.deepEqual(ok(readAcceptedAnswer(view, { project, record: reference(accepted) })).record, accepted);
      assert.equal(ok(answerSourceGuards(view, { project, record: reference(accepted) })).applicable, true);
      assert.equal(ok(applicableAnswerTask(view, { project, record: reference(accepted), task: { record: answer.task }, current: true })).applicable, true);
      assert.equal(ok(readAnswerForInput(view, { project, record: reference(accepted), question: answer.request.question,
        input: reference(f.input), current: true })).applicable, true);
      assert.deepEqual(snapshot(f.store), snapshotBefore);
    }
  }
});

async function answerClosure(f: ReturnType<typeof product>) {
  const answer = await nativeAnswer(f), prepared = ok(prepareAcceptedAnswer(f.store, answer.request));
  const accepted = ok(writeAcceptedAnswer(f.store, answer.request));
  const firstRequest: GapLinesRequest = { project, previous: null, pass: 1, gaps: f.gapRequest, closures: [] };
  const first = ok(writeGapLines(f.store, firstRequest));
  const applied = ok(writeApplyAnswer(f.store, { project, input: reference(f.input), answer: reference(accepted), question: answer.request.question }));
  const horizon = f.horizon('answer-applied');
  const sources: GapRequest = { project, input: reference(applied), graph: reference(f.graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(f.graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(f.store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(f.store, sources)), current = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const request: GapLinesRequest = { project, previous: reference(first), pass: 2, gaps: current,
    closures: [{ ...prepared.closure, answer: { record: reference(accepted) } }] };
  return { answer, accepted, prepared, current, request };
}

test('B3.0b F5.2 saved and pending answer closures guard C but exact closure repeats remain historical', async t => {
  for (const pending of [false, true]) {
    const f = product(fixture(t)), close = await answerClosure(f);
    const request: GapLinesRequest = pending ? { ...close.request, closures: [close.prepared.closure] } : close.request;
    const prepared = ok(prepareGapLines(f.store, request));
    assert.ok(prepared.guards.some(guard => guard.id === seriesCurrentId(project)));
    const index = answerIndexId(project, 'discovery:encoding', 'answer');
    const pendingView = new Proxy(f.store, { get(target, prop) {
      if (prop === 'get') return (id: string, revision?: number) => [close.accepted.id, index].includes(id) ? null : target.get(id, revision);
      if (prop === 'list') return (kind?: string) => target.list(kind).filter(row => ![close.accepted.id, index].includes(row.id));
      const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    const supplied = { project, basis: close.prepared.closure.answer, target: 'discovery:encoding', field: 'answer', prior: f.gapRequest,
      current: close.current, attempt: close.answer.request.attempt, currentOnly: true };
    if (pending) {
      const verifiedPending = ok(confirmAnswerGapClosure(pendingView, supplied));
      assert.ok(verifiedPending.writes.some(write => write.id === close.accepted.id));
      assert.ok(verifiedPending.guards.some(guard => guard.id === seriesCurrentId(project)));
    }
    const saved = pending ? null : ok(writeGapLines(f.store, request));
    exclude(f, 'after-answer-application');
    if (!saved) {
      rejected(commit(f.store, prepared)); rejected(prepareGapLines(f.store, request));
      rejected(confirmAnswerGapClosure(pendingView, supplied));
    } else {
      const view = forbidCurrentPointer(f.store), before = snapshot(f.store);
      assert.deepEqual(ok(readGapLines(view, { project, record: reference(saved) })), saved);
      assert.deepEqual(ok(writeGapLines(view, request)), saved); assert.deepEqual(snapshot(f.store), before);
    }
    if (pending) {
      const historical = ok(confirmAnswerGapClosure(pendingView, { ...supplied, currentOnly: false }));
      assert.deepEqual(historical.guards, []); assert.deepEqual(historical.writes, []);
    }
  }
});

function appliedPair(f: Fixture, horizon: Ref, choiceVersion: string) {
  const prepared = ok(writeSeriesTransition(f.store, { project, choiceVersion, horizon, series: roots(f) }));
  const issuance = ok(writeHorizonIssuance(f.store, { project, choiceVersion, horizon, transition: reference(prepared) }));
  return { project, prepared: reference(prepared), issuance: reference(issuance) };
}

function acceptMappedFrame(f: Fixture, frame: FrameRequest): AcceptedFrameRequest {
  const graph = gardenGraph(), current = ok(prepareFrame(f.store, frame));
  const upper = current.upper as Graph;
  graph.nodes = graph.nodes.map(node => clone(upper.nodes.find(row => row.id === node.id) ?? node));
  if (upper.requirements) graph.requirements = clone(upper.requirements);
  for (const node of graph.nodes.filter(node => node.kind === 'operation' || node.kind === 'work'))
    node.implements = [...new Set([...(node.implements ?? []), ...(graph.requirements ?? []).filter(item => item.outcome === node.outcome).map(item => item.id)])];
  assert.deepEqual(projectGraph(graph, 1), projectGraph(upper, 1), 'The proposal template preserves the exact upper of this fixture producer');
  const projected = projectGraph(graph, 2);
  const mapped = ok(fillObligations(current.upper as Graph, current.scope as FrameScope,
    { graph, reference: { ...frame.graph, hash: hashJson(graph) }, frame: null }, current.upperRef, 2));
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: null }, level: 2, source: 'decision', status: 'proposed',
    nodes: projected.nodes.filter(node => node.kind === 'operation'),
    fills: mapped.fills.map(fill => ({ obligation: fill.obligation, node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length > 0),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, anchors: projected.anchors, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    removes: [], replaces: [], redefines: [] };
  const offered = f.store.write({ id: 'om-proposal:garden:current-frame', kind: 'layer-proposal', expected: 0, value: proposal });
  const written = ok(writeCandidate(f.store, { frame, proposals: [reference(offered)] }));
  assert.equal(written.state, 'candidate'); if (written.state !== 'candidate') assert.fail('Expected real operation candidate');
  const candidate = reference(written.record), accepted = ok(settleCandidate(f.store, { project, level: 2, candidate,
    outcome: { gate: 'G3', candidate, graphHash: written.record.value.graphHash, passed: true, codes: [] } }));
  const acceptance: AcceptedFrameRequest = { project, level: 2, graph: reference(accepted.graph!), layer: reference(accepted.layer!), frame: reference(accepted.frame!) };
  return acceptance;
}

function frameClosure(f: Fixture) {
  const horizon = f.horizon('frame-open');
  const frame: FrameRequest = { project, level: 2, graph: reference(f.graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null };
  const sources: GapRequest = { project, input: reference(f.input), graph: frame.graph, horizon: frame.horizon, operations: { frame, proposals: [] },
    works: { state: 'upper-not-accepted', layer: reference(f.store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(f.store, sources)), initial = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const first = ok(writeGapLines(f.store, { project, previous: null, pass: 1, gaps: initial, closures: [] }));
  const line = gaps.collection.gaps.find(item => item.field === 'fill' && item.consumers.includes(block) && item.evidence.some(evidence => evidence.origin === 'operations'))!;
  assert.ok(line);
  f.series();
  const goal = { key: 'frame:accepted-operation', questions: [gapLineKey(project, line.target, line.field)], result: gapLineExpectedResult(project, line.target, line.field) };
  ok(beginAttempt(f.store, { project, block, line: 1, attempt: 1, goal }));
  const acceptance = acceptMappedFrame(f, frame);
  const nextHorizon = (choiceVersion: string) => ok(writeHorizon(f.store, { project, input: reference(f.input), graph: acceptance.graph,
    refinement: acceptance.layer, available: {}, choice: { choiceVersion, features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const next = nextHorizon('frame-accepted');
  ok(applySeriesActivation(f.store, appliedPair(f, reference(next.gate), 'frame-accepted')));
  const attempt = { series: reference(head(f)), attempt: 1 };
  const operations: FrameRequest = { project, level: 2, graph: acceptance.graph, horizon: reference(next.gate), layer: acceptance.layer, frame: acceptance.frame, upper: null };
  const saved = ok(writeGaps(f.store, { project, input: reference(f.input), graph: acceptance.graph, horizon: reference(next.gate),
    operations: { frame: operations, proposals: [] }, works: { proposals: [], frame: { ...operations, level: 3, layer: null, frame: null,
      upper: { horizon: reference(next.gate), frame: acceptance.frame } } } }));
  assert.ok(!saved.collection.gaps.some(item => item.id === line.id));
  const request: GapLinesRequest = { project, previous: reference(first), pass: 2,
    gaps: { sources: clone(saved.sources) as GapRequest, records: saved.records.map(reference) },
    closures: [{ id: line.id, reason: 'filled', basis: acceptance.frame, acceptance, attempt }] };
  return { request, nextHorizon };
}

test('B3.0b F5.2 new frame closure carries C while saved closure remains readable after continue', t => {
  for (const savedFirst of [false, true]) {
    const f = fixture(t, false), frame = frameClosure(f), prepared = ok(prepareGapLines(f.store, frame.request));
    assert.ok(prepared.guards.some(guard => guard.id === seriesCurrentId(project)));
    const saved = savedFirst ? ok(writeGapLines(f.store, frame.request)) : null;
    const horizon = frame.nextHorizon('frame-continue'), request = appliedPair(f, reference(horizon.gate), 'frame-continue');
    const other = new Store(f.path);
    try { assert.equal(ok(applySeriesActivation(other, request)).record.value.decisions[0]!.outcome, 'continue'); }
    finally { other.close(); }
    if (!saved) { rejected(commit(f.store, prepared)); rejected(prepareGapLines(f.store, frame.request)); }
    else {
      const view = forbidCurrentPointer(f.store), before = snapshot(f.store);
      assert.deepEqual(ok(readGapLines(view, { project, record: reference(saved) })), saved);
      assert.deepEqual(ok(writeGapLines(view, frame.request)), saved); assert.deepEqual(snapshot(f.store), before);
    }
  }
});

type EraWitness = { contract: 'om-series-era/v1'; project: string; seriesId: string; firstManaged: Ref;
  origin: { kind: 'activation'; applied: Ref } | { kind: 'registration'; membership: Ref; pointer: Ref; slice: string } };
function era(f: Fixture, series: Ref) {
  const record = f.store.get<EraWitness>(seriesEraId(project, series.id), 1); assert.ok(record); return record;
}
function withoutManagedFields(value: RepairSeries): RepairSeries {
  const body = clone(value) as unknown as Record<string, unknown>; delete body['contract']; delete body['activation'];
  return body as unknown as RepairSeries;
}

test('B3.0b era witness rejects paired field loss at first later and unactivated series revisions', t => {
  for (const stage of ['first', 'later', 'unactivated'] as const) {
    const f = fixture(t), legacy = f.series(); activate(f);
    const first = head(f), witness = era(f, reference(first));
    assert.equal(witness.revision, 1); assert.deepEqual(witness.value.firstManaged, reference(first));
    assert.equal(witness.value.origin.kind, 'activation');
    const row = stage === 'later' ? ok(beginAttempt(f.store, { project, block, line: 1, attempt: 1, goal: workGoal }))
      : stage === 'unactivated' ? f.series(independent) : first;
    if (stage === 'unactivated') {
      const registration = era(f, reference(row)); assert.equal(row.revision, 1);
      assert.equal(registration.value.origin.kind, 'registration'); assert.deepEqual(registration.value.firstManaged, reference(row));
    }
    const forged = rewrite(f.store, row, withoutManagedFields(row.value));
    f.restart(); rejected(readSeriesAt(f.store, project, reference(forged)));
    rejected(prepareSeriesParticipantAdmission(f.store, project, reference(forged)));
    assert.deepEqual(ok(readSeriesAt(f.store, project, reference(legacy))), legacy);
  }
});

test('B3.0b era proof rejects absent foreign or incomplete threshold and producer sources', t => {
  for (const variant of ['missing-witness', 'foreign-first', 'missing-first', 'missing-origin', 'foreign-origin', 'missing-field'] as const) {
    const f = fixture(t); f.series(); activate(f);
    const first = head(f), later = ok(beginAttempt(f.store, { project, block, line: 1, attempt: 1, goal: workGoal }));
    const witness = era(f, reference(first));
    if (variant === 'missing-witness') erase(f.store, witness.id);
    else if (variant === 'missing-first') {
      const view = new Proxy(f.store, { get(target, prop) {
        if (prop === 'get') return (id: string, revision?: number) => id === first.id && revision === first.revision ? null : target.get(id, revision);
        const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
      } });
      rejected(readSeriesAt(view, project, reference(later))); continue;
    } else {
      const value = clone(witness.value) as unknown as Record<string, Json>;
      if (variant === 'foreign-first') value['firstManaged'] = { ...reference(first), id: 'repair-series:foreign:block:1' };
      if (variant === 'missing-origin') delete value['origin'];
      if (variant === 'foreign-origin') value['origin'] = { kind: 'activation', applied: { ...reference(f.store.list('om-series-applied')[0]!), id: 'om-series-applied:foreign:proof' } };
      if (variant === 'missing-field') delete value['firstManaged'];
      rewrite(f.store, witness, value as unknown as EraWitness);
    }
    rejected(readSeriesAt(f.store, project, reference(later)));
  }
});

test('B3.0b earlier legacy revisions read only their era threshold and predecessor uses its own exact Ref', t => {
  const f = fixture(t), root = f.series();
  const successor = ok(openSeries(f.store, { project, block, line: 2, slice: 'legacy:second', predecessor: reference(root),
    basis: { ground: 'inputs-changed', text: 'A legacy successor predates management' } }));
  const applied = activate(f), firstManaged = applied.series[0]!;
  assert.equal(firstManaged.id, successor.id); assert.ok(firstManaged.revision > successor.revision);
  const witness = era(f, reference(firstManaged)), before = snapshot(f.store); f.restart();
  const view = new Proxy(f.store, { get(target, prop) {
    if (prop === 'get') return (id: string, revision?: number) => {
      assert.notEqual(revision, undefined, `Exact historical reading cannot select ${id}'s head`);
      assert.ok(id !== firstManaged.id || revision! < firstManaged.revision, 'The future S must not be traversed for an old revision');
      assert.ok(!id.startsWith('om-series-applied:') && !id.startsWith('series-transition:') && id !== seriesCurrentId(project), 'The threshold lookup must not recurse into future A P C');
      return target.get(id, revision);
    };
    if (prop === 'list') return () => assert.fail('Historical era selection must not enumerate current records');
    const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  assert.deepEqual(ok(readSeriesAt(view, project, reference(root))), root);
  assert.deepEqual(ok(readSeriesAt(view, project, reference(successor))), successor);
  assert.deepEqual(snapshot(f.store), before);
  assert.deepEqual(f.store.get(witness.id, 1), witness);
  assert.deepEqual(ok(readSeriesAt(f.store, project, reference(firstManaged))), firstManaged);
  assert.deepEqual(ok(readSeriesAt(f.store, project, reference(successor))), successor);
});

test('B3.0b legacy operation and era activation serialize in both second Store commit orders', t => {
  for (const first of ['operation', 'activation'] as const) {
    const f = fixture(t), source = f.series(), other = new Store(f.path); t.after(() => other.close());
    const activation = ok(prepareSeriesActivation(f.store, transition(f, `era-race-${first}`).request));
    const operation = ok(prepareBeginAttempt(other, { project, block, line: 1, attempt: 1, goal: workGoal }));
    assert.ok(operation.guards.some(guard => canonical(guard) === canonical(reference(source))));
    if (first === 'operation') {
      ok(commit(other, operation)); rejected(commit(f.store, activation));
      assert.equal(f.store.get(seriesEraId(project, source.id)), null);
    } else {
      ok(commit(f.store, activation)); rejected(commit(other, operation));
      assert.ok(f.store.get(seriesEraId(project, source.id), 1));
      assert.equal(head(f).value.attempts.length, 0);
    }
  }
});

test('B3.0b a legacy label equal to the next proved hash permits new-work and preserves exact history', t => {
  const changedFrame = (f: Fixture, slice: string) => {
    const original = ok(openSeries(f.store, { project, block, line: 1, slice, predecessor: null, basis: null }));
    const prior = stop(f, 1), first = transition(f, 'initial');
    const bootstrap = ok(applySeriesActivation(f.store, first.request));
    const accepted = acceptMappedFrame(f, { project, level: 2, graph: reference(f.graph), horizon: reference(first.horizon.gate),
      layer: null, frame: null, upper: null });
    const next = (choiceVersion: string) => {
      const horizon = ok(writeHorizon(f.store, { project, input: reference(f.input), graph: accepted.graph, refinement: accepted.layer,
        available: {}, choice: { choiceVersion, features: [{ outcome: 'garden-result' }], excluded: [] } }));
      return appliedPair(f, reference(horizon.gate), choiceVersion);
    };
    const request = next('changed-frame');
    const prepared = ok(readPreparedSeriesTransition(f.store, { project, record: request.prepared })).record;
    const proved = prepared.value.decisions.find(row => row.block === block)!.slice!;
    assert.notEqual(first.prepared.value.decisions.find(row => row.block === block)!.slice!.hash, proved.hash);
    assert.equal(bootstrap.series[0]!.value.slice, slice, 'Bootstrap retains the opaque legacy label');
    return { original, prior, bootstrap, request, proved, next };
  };
  // Both databases use the real producers. The first finds the future subject hash before the second
  // legally supplies it as an opaque legacy label; no saved value or reference is rewritten.
  const scout = changedFrame(fixture(t), opaqueSlice);
  const f = fixture(t), changed = changedFrame(f, scout.proved.hash);
  assert.equal(changed.original.value.slice, changed.proved.hash);
  const prepared = ok(prepareSeriesActivation(f.store, changed.request));
  assert.equal(prepared.record.value.decisions.find(row => row.block === block)!.outcome, 'new-work');
  const applied = ok(applySeriesActivation(f.store, changed.request)), successor = applied.series.find(row => row.value.block === block)!;
  assert.equal(successor.value.line, 2); assert.equal(successor.revision, 1);
  assert.equal(successor.value.slice, changed.original.value.slice);
  assert.deepEqual(successor.value.predecessor, reference(changed.bootstrap.series[0]!));
  assert.deepEqual(successor.value.inherited, [...changed.prior.value.inherited, ...changed.prior.value.attempts]);
  assert.equal(successor.value.withoutProgress, changed.prior.value.withoutProgress);
  assert.deepEqual(successor.value.ladder, changed.prior.value.ladder);
  for (const restart of [false, true]) {
    if (restart) f.restart();
    for (const record of [changed.original, changed.prior, changed.bootstrap.series[0]!, successor])
      assert.deepEqual(ok(readSeriesAt(f.store, project, reference(record))), record);
    const admission = ok(prepareSeriesLineAdmission(f.store, project, reference(successor)));
    assert.deepEqual(admission.pointer, reference(applied.pointer));
    assert.ok(admission.guards.some(guard => canonical(guard) === canonical(reference(successor))));
    assert.ok(admission.guards.some(guard => canonical(guard) === canonical(reference(applied.pointer))));
  }
  const unchanged = ok(applySeriesActivation(f.store, changed.next('same-accepted-frame')));
  assert.equal(unchanged.record.value.decisions.find(row => row.block === block)!.outcome, 'continue');
  const continued = unchanged.series.find(row => row.value.block === block)!;
  assert.equal(continued.id, successor.id); assert.equal(continued.value.line, 2);
  assert.equal(f.store.get(`repair-series:${project}:3:${block}`), null, 'An unchanged proved subject creates no successor');
  f.restart();
  assert.deepEqual(ok(readSeriesAt(f.store, project, reference(successor))), successor);
  assert.deepEqual(ok(prepareSeriesLineAdmission(f.store, project, reference(continued))).pointer, reference(unchanged.pointer));
});

test('B3.0b new-work waits for explicit terminal close then preserves stop history and creates its own era witness', async t => {
  const f = product(fixture(t), true, true, 2), { request } = ready(f);
  await received(f, request); exclude(f);
  const terminal = ok(await runModelCall(f.store, request)).record;
  const acceptance = acceptMappedFrame(f, f.gapRequest.sources.operations.frame);
  const changed = (choiceVersion: string) => {
    const horizon = ok(writeHorizon(f.store, { project, input: reference(f.input), graph: acceptance.graph, refinement: acceptance.layer,
      available: {}, choice: { choiceVersion, features: [{ outcome: 'garden-result' }], excluded: [] } }));
    return appliedPair(f, reference(horizon.gate), choiceVersion);
  };
  rejected(prepareSeriesActivation(f.store, changed('changed-while-running')), 'attempt_running');
  const closeRequest = { project, block, line: 1, attempt: 3, terminal: reference(terminal),
    outcome: { reason: 'interrupted' as const, achieved: [], cancelled: [], refusals: [] } };
  const closed = ok(completeAttempt(f.store, closeRequest));
  assert.equal(closed.value.withoutProgress, 3); assert.ok(closed.value.stop);
  const history = ok(readStopHistory(f.store, { project, block, line: 1 }));
  const next = ok(applySeriesActivation(f.store, changed('changed-after-close')));
  assert.equal(next.record.value.decisions[0]!.outcome, 'new-work');
  const successor = next.series[0]!, witness = era(f, reference(successor));
  assert.equal(successor.value.line, 2); assert.equal(successor.revision, 1);
  assert.deepEqual(witness.value.firstManaged, reference(successor));
  assert.notEqual(witness.id, seriesEraId(project, closed.id));
  assert.deepEqual(successor.value.inherited, [...closed.value.inherited, ...closed.value.attempts]);
  assert.deepEqual(successor.value.stop, closed.value.stop); assert.deepEqual(successor.value.ladder, closed.value.ladder);
  assert.deepEqual(ok(readStopHistory(f.store, { project, block, line: 2 })), history);
  const predecessor = f.store.get<RepairSeries>(closed.id)!;
  assert.equal(predecessor.revision, closed.revision + 1, 'Successor creation CAS-advances its predecessor');
  assert.equal(predecessor.hash, closed.hash); assert.deepEqual(predecessor.value, closed.value);
  const before = snapshot(f.store);
  assert.deepEqual(ok(completeAttempt(f.store, closeRequest)), predecessor);
  assert.deepEqual(snapshot(f.store), before, 'The terminal repeat creates no revision or second count');
  assert.deepEqual(ok(readSeriesAt(f.store, project, reference(closed))), closed);
  f.restart();
  assert.deepEqual(ok(readSeriesAt(f.store, project, reference(successor))), successor);
  assert.deepEqual(ok(readSeriesAt(f.store, project, reference(f.running))), f.running);
  assert.deepEqual(snapshot(f.store), before); assert.equal(f.sent().length, 1);
});

test('B3.0b common historical work admission restores its original pointer guards after heads advance', t => {
  const f = fixture(t); f.series(); const first = activate(f), source = head(f);
  const admitted = ok(prepareSeriesLineAdmission(f.store, project, reference(source)));
  ok(beginAttempt(f.store, { project, block, line: 1, attempt: 1, goal: workGoal })); exclude(f);
  const witness = era(f, reference(source));
  assert.equal(f.store.history(witness.id).length, 1);
  const view = forbidCurrentPointer(f.store);
  const restored = ok(readSeriesWorkAdmission(view, { project, series: reference(source), pointer: reference(first.pointer) }));
  assert.deepEqual(restored.guards, admitted.guards);
  assert.ok(restored.guards.some(guard => canonical(guard) === canonical(reference(source))));
  assert.ok(restored.guards.some(guard => canonical(guard) === canonical(reference(first.pointer))));
  rejected(commit(f.store, { writes: [{ id: 'old-work-proof', kind: 'test', expected: 0, value: null }], guards: restored.guards }));
  assert.equal(f.store.get('old-work-proof'), null);
});

test('B3.0b managed provenance A C era A6 membership and series reject lost B1 with incomplete links', t => {
  const f = product(fixture(t), true, false), a = analysis(f);
  ok(commit(f.store, ok(prepareStopAnalysis(f.store, a.request))));
  const records = [f.store.list('om-series-applied')[0]!, f.store.get(seriesCurrentId(project))!,
    era(f, reference(head(f))), f.store.list('om-analysis-admission')[0]!, f.store.get(seriesMembershipId(project))!, head(f)];
  for (const row of records) for (const partial of [false, true]) {
    const alone = emptyProject(t);
    const value = !partial ? row.value : row.kind === 'om-series-membership' ? { mode: 'transition-managed' }
      : row.kind === 'repair-series' ? { contract: 'om-repair-series/v2' } : {};
    alone.store.write({ id: row.id, kind: row.kind, expected: 0, value });
    const engine = new ProductEngine(alone.store), before = snapshot(alone.store);
    for (const operation of [() => engine.projection(project), () => engine.execute({ type: 'assess', project, expected: 0 })]) {
      assert.throws(operation, (error: unknown) => error instanceof EngineError && error.code === 'record_missing'
        && (error.details as { target?: string }).target === `om-input:${project}`, `${row.kind} partial=${partial}`);
      assert.deepEqual(snapshot(alone.store), before);
    }
  }
  const onlyActivation = emptyProject(t);
  onlyActivation.store.write({ id: head(f).id, kind: 'repair-series', expected: 0, value: { activation: { contract: 'om-series-activation/v1' } } });
  assert.throws(() => new ProductEngine(onlyActivation.store).projection(project), (error: unknown) => error instanceof EngineError && error.code === 'record_missing');
});

test('B3.0b E1 E4 and A6 carry positive pointer guards through their actual write transactions', async t => {
  const f = product(fixture(t)), { request } = ready(f), pointer = reference(f.store.get(seriesCurrentId(project))!);
  const writes = f.store.writeMany.bind(f.store), seen = new Set<string>();
  f.store.writeMany = ((batch, guards = []) => {
    for (const write of batch) {
      const body = write.value as Partial<OmModelCall>;
      const boundary = write.kind === 'call-record' && write.expected === 0 ? 'E1'
        : write.kind === 'model-call' && write.expected === 0 ? 'E4-reservation'
        : write.kind === 'model-call' && body.om?.application === 'applied' ? 'E4-application' : null;
      if (boundary) {
        assert.ok(guards.some(guard => canonical(guard) === canonical(pointer)), `${boundary} must retain the original positive C guard`);
        seen.add(boundary);
      }
    }
    return writes(batch, guards);
  }) as Store['writeMany'];
  f.steps([{ research: fact(f), usage }]);
  try {
    const standalone = ok(recordCall(f.store, project, e1Request(f, 'standalone-current-guards')));
    const dispatch = ok(prepareCallDispatch(f.store, project, reference(standalone.call)));
    assert.ok(dispatch.guards.some(guard => canonical(guard) === canonical(pointer)), 'Standalone E1 dispatch retains the same positive C');
    assert.equal(ok(await runModelCall(f.store, request)).record.value.om.application, 'applied');
  }
  finally { f.store.writeMany = writes; }
  assert.deepEqual([...seen].sort(), ['E1', 'E4-application', 'E4-reservation']);
  const a6 = product(fixture(t), true, false), review = analysis(a6), reviewPointer = reference(a6.store.get(seriesCurrentId(project))!);
  const reviewWrites = a6.store.writeMany.bind(a6.store); let applied = false;
  a6.store.writeMany = ((batch, guards = []) => {
    if (batch.some(write => write.kind === 'om-stop-review')) {
      applied = true;
      assert.ok(guards.some(guard => canonical(guard) === canonical(reviewPointer)), 'A6 application carries the same positive pointer proof');
    }
    return reviewWrites(batch, guards);
  }) as Store['writeMany'];
  a6.steps([{ research: review.answer, usage }]);
  try { assert.equal(ok(await runStopAnalysis(a6.store, review.request)).value.state, 'decided'); }
  finally { a6.store.writeMany = reviewWrites; }
  assert.equal(applied, true);
});

test('B3.0b exact running and received E4 records reject absent null and foreign original admission', async t => {
  const f = product(fixture(t)), { request } = ready(f), receipt = await received(f, request);
  const running = f.store.history<OmModelCall>(receipt.id).find(row => row.value.om.application === 'running')!;
  assert.ok(running);
  for (const source of [running, receipt]) for (const variant of ['missing', 'null', 'foreign'] as const) {
    const value = clone(source.value) as unknown as { om: Record<string, Json> };
    if (variant === 'missing') delete value.om['admission'];
    else if (variant === 'null') value.om['admission'] = null;
    else value.om['admission'] = { contract: 'om-model-admission/v1', series: { ...reference(f.running) },
      pointer: { ...reference(f.store.get(seriesCurrentId(project))!), id: 'om-series-current:foreign' } };
    const forged = rewrite(f.store, source, value as unknown as OmModelCall);
    rejected(readModelCallPhysical(f.store, { project, record: reference(forged) }));
    rewrite(f.store, forged, source.value as OmModelCall);
  }
  assert.equal(f.sent().length, 1); ok(readModelCallPhysical(f.store, { project, record: reference(receipt) }));
  erase(f.store, seriesCurrentId(project));
  const before = snapshot(f.store);
  rejected(await runModelCall(f.store, request));
  assert.deepEqual(snapshot(f.store), before); assert.equal(f.sent().length, 1);
  assert.deepEqual(f.store.get(receipt.id), receipt, 'Lost proof preserves the physical receipt without manufacturing a terminal outcome');
});

test('B3.0b old legacy E4 packet cannot gain a new physical launch after bootstrap', async t => {
  const f = product(fixture(t), false), { packet, request } = ready(f);
  f.steps([{ research: fact(f), usage }]);
  activate(f, 'bootstrap-before-first-send'); f.restart();
  const before = snapshot(f.store);
  rejected(await runModelCall(f.store, request)); assert.equal(f.sent().length, 0);
  assert.equal(f.store.list('model-call').length, 0);
  assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(packet) })), packet);
  assert.deepEqual(snapshot(f.store), before);
});

test('B3.0b an unactivated registration cannot acquire later history or return after activation', t => {
  for (const later of ['changed-slice', 'after-activation'] as const) {
    const f = fixture(t); f.series(); activate(f);
    const registered = f.series(independent);
    if (later === 'after-activation') {
      const pair = transition(f, 'activate-registered', { features: [{ outcome: 'garden-result' }, { outcome: 'garden-later' }] });
      ok(applySeriesActivation(f.store, pair.request));
    }
    const value = clone(registered.value) as RepairSeries;
    const forged = f.store.write({ id: registered.id, kind: registered.kind, expected: f.store.get(registered.id)!.revision,
      value: later === 'changed-slice' ? { ...value, slice: 'forged-later-unactivated-slice' } : value });
    rejected(readSeriesAt(f.store, project, reference(forged)));
    rejected(prepareSeriesParticipantAdmission(f.store, project, reference(forged)));
    assert.deepEqual(ok(readSeriesAt(f.store, project, reference(registered))), registered);
  }
});

test('B3.0b A6 saved physical response survives bootstrap or exclusion and stale application cannot resend', async t => {
  for (const managed of [false, true]) {
    const f = product(fixture(t), managed, false), a = analysis(f);
    f.steps([{ research: a.answer, usage }]);
    const writeMany = f.store.writeMany.bind(f.store); let paused = false;
    f.store.writeMany = ((writes, guards) => {
      const saved = writeMany(writes, guards);
      if (!paused && writes.some(write => write.kind === 'model-call'
        && (write.value as { transport?: { exchange?: Ref | null } }).transport?.exchange)) {
        paused = true; throw new Error('B3.0b pause after A6 physical receipt');
      }
      return saved;
    }) as Store['writeMany'];
    try { await assert.rejects(runStopAnalysis(f.store, a.request), /B3.0b pause after A6 physical receipt/); }
    finally { f.store.writeMany = writeMany; }
    assert.equal(paused, true); assert.equal(f.sent().length, 1);
    const receipt = f.store.list<ModelCall>('model-call')[0]!;
    assert.deepEqual(receipt.value.usage, usage); assert.ok(receipt.value.response);
    if (managed) exclude(f); else activate(f, 'adopt-received-analysis');
    f.restart(); rejected(await runStopAnalysis(f.store, a.request));
    assert.deepEqual(f.store.get(receipt.id), receipt); assert.equal(f.sent().length, 1);
    assert.equal(f.store.list('om-stop-review').length, 0);
    const call = f.store.list('call-record')[0]!;
    assert.equal(f.store.history(call.id).length, 2);
    const before = snapshot(f.store); f.restart();
    rejected(await runStopAnalysis(f.store, a.request)); assert.deepEqual(snapshot(f.store), before); assert.equal(f.sent().length, 1);
  }
});
