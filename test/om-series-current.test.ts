import { runIntegrityCheck, integrityGate } from "../src/om/integrity.js";
import { openAttempt as managedOpenAttempt } from '../src/om/repeat-gate.js';
import { readCompletionBinding, completionWorkId } from '../src/om/series.js';
import { readCompletionWorkAt, writeCompletionCessation, readCompletionCessationAt } from '../src/om/model-call.js';
import { writeAssessmentIntent, prepareAssessmentSeriesTerminationCause, readAssessmentSeriesTerminationCause } from '../src/om/assessment.js';
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
import { Store, observeStore, type Revision, type StoreObserver, type TransactionGuard, type Write } from '../src/storage/store.js';
import { captureView } from '../src/storage/store-view.js';
import { writeOmInput } from '../src/om/input.js';
import { inputDecisionWrite, writeAddressing, writeApplyAnswer, type InputDecisionProposal } from '../src/om/addressing.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeHorizon, writeHorizonIssuance, readHorizonIssuance, type HorizonRequest } from '../src/om/horizon.js';
import { beginAttempt, completeAttempt, openSeries, prepareOpenSeries, readSeriesAt,
  readSeries, seriesEraId, readSeriesWorkAdmission, prepareBeginAttempt, readStopHistory, readStopHistoryAt, readCurrentSeriesPointer, readAppliedSeriesTransition, prepareSeriesActivation, applySeriesActivation, prepareSeriesParticipantAdmission,
  prepareSeriesLineAdmission, readSeriesMembership, seriesCurrentId, seriesMembershipId, type RepairSeries } from '../src/om/series.js';
import { prepareSeriesDiscard, writeSeriesDiscard, readDiscardedSeriesTransition } from '../src/om/series.js';
import { closeAttempt } from '../src/om/repeat-gate.js';
import type { FrameAttemptBinding, OmAcceptedFrame } from '../src/om/layer-basis.js';
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
import { prepareFrame, fillObligations, type FrameRead, type FrameRequest, type FrameScope } from '../src/om/frame-obligations.js';
import type { LayerProposal, ProposalRequest } from '../src/om/frame-proposals.js';
import { writeCandidate } from '../src/om/frame-candidate.js';
import { settleCandidate, type AcceptedFrameRequest } from '../src/om/frame-accept.js';
import { writeGuarded } from '../src/om/refs.js';
import type { OmResult } from '../src/om/refusal.js';
import { receiptId, type ArtifactReceipt } from '../src/compiler/model.js';
import { createOmFixture, gardenGraph, refusedWith, acceptNativeWorks, type OmPreparedFixture } from './om-fixture.js';
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
function fixture(t: TestContext, includeLater = true, questions = 1) {
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
    if (field === "preparation") (value as Record<string, Json>).unknowns = Array.from({ length: questions }, (_, i) => ({ id: i ? `encoding-${i}` : "encoding",
      question: questions === 1 ? "What encoding is supported?" : `What encoding is supported for channel ${i}?`, consumer: block, moment: "om-pass", blocksCurrentStage: false,
      resolution: "Read repository facts during OM" }));
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
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph), decisions: Array.from({ length: questions }, (_, i) => ({ pending:
    clone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: i ? `discovery:encoding-${i}` : 'discovery:encoding', field: 'address', value: { consumer: block, kind: 'repository-fact' } } })) as Write })) }));
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
function roots(f: Pick<Fixture, 'store'>) {
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
    scenario, trace, steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ database: f.store.path, steps })); },
    sent() { return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; } };
}
function ready(f: ReturnType<typeof product>) {
  const packet = ok(writeQuestionPacket(f.store, f.packetRequest)).record;
  const request: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(f.adapter), config: reference(f.environment) }, role: 'implementer' };
  return { packet, request };
}
function fact(f: ReturnType<typeof product>) {
  return { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer', results: [{ questionId: f.batch.items[0]!.gap, value: 'UTF-8',
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
  refusedWith(prepareSeriesLineAdmission(f.store, project, reference(excluded)), 'series_invalid');
  refusedWith(beginAttempt(f.store, { project, block, line: 1, attempt: 4, goal: workGoal }), 'series_invalid');
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
    if (first === 'root') { ok(commit(other, root)); refusedWith(commit(f.store, activation), 'input_stale'); assert.equal(f.store.get(activation.record.id), null); }
    else { ok(commit(f.store, activation)); refusedWith(commit(other, root), 'input_stale'); assert.equal(f.store.get(root.writes[0]!.id), null); }
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
    if (first === 'successor') { ok(commit(other, successor)); refusedWith(commit(f.store, activation), 'input_stale'); assert.equal(f.store.get(activation.record.id), null); }
    else { ok(commit(f.store, activation)); refusedWith(commit(other, successor), 'input_stale'); assert.equal(f.store.get(successor.writes[0]!.id), null); }
  }
});

test('B3.0b managed root must be registered unactivated then included in a new full P G pair', t => {
  const f = fixture(t); f.series(); activate(f);
  const stale = transition(f, 'before-new-root');
  const added = f.series(independent);
  assert.equal(added.value.activation?.state, 'unactivated');
  assert.equal(ok(prepareSeriesParticipantAdmission(f.store, project, reference(added))).participation, 'unactivated');
  refusedWith(prepareSeriesLineAdmission(f.store, project, reference(added)), 'series_invalid');
  refusedWith(beginAttempt(f.store, { project, block: independent, line: 1, attempt: 1, goal: workGoal }), 'series_invalid');
  refusedWith(applySeriesActivation(f.store, stale.request), 'series_invalid');
  const fresh = transition(f, 'include-new-root', { features: [{ outcome: 'garden-result' }, { outcome: 'garden-later' }] });
  const applied = ok(applySeriesActivation(f.store, fresh.request));
  assert.equal(applied.record.value.decisions.find(row => row.block === independent)!.outcome, 'establish-basis');
  ok(prepareSeriesLineAdmission(f.store, project, reference(head(f, independent))));
  refusedWith(openSeries(f.store, { project, block: independent, line: 2, slice: 'unproved-string', predecessor: reference(head(f, independent)),
    basis: { ground: 'inputs-changed', text: 'A caller cannot manufacture managed succession' } }), 'series_conflict');
});

test('B3.0b participant membership changes invalidate an already prepared managed activation', t => {
  const f = fixture(t); f.series(); activate(f);
  const next = ok(prepareSeriesActivation(f.store, transition(f, 'complete-at-prepare').request));
  const other = new Store(f.path);
  try { ok(openSeries(other, { project, block: independent, line: 1, slice: opaqueSlice, predecessor: null, basis: null })); }
  finally { other.close(); }
  refusedWith(commit(f.store, next), 'input_stale'); assert.equal(f.store.get(next.record.id), null);
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
  refusedWith(prepareSeriesLineAdmission(f.store, project, reference(running)), 'series_invalid');
  refusedWith(prepareSeriesParticipantAdmission(f.store, project, reference(running)), 'series_invalid');
  refusedWith(beginAttempt(f.store, { project, block, line: 1, attempt: 2, goal: workGoal }), 'series_invalid');
  assert.deepEqual(ok(readSeriesAt(f.store, project, reference(active))), active);
});

test('B3.0b managed series cannot masquerade as legacy by dropping activation contract or basis', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
  // The era witness pins the first managed revision by hash, and `rewrite` changes that very revision in place. So the
  // dropped activation basis fields and the registered root are refused by the PINNED CONTENT (record_forged on hash):
  // that proves a pinned revision cannot be substituted, not that the check of the missing field is reached. Only the
  // dropped contract or activation section meets the FORM check of the series (series_invalid on value).
  for (const [field, code, at] of [['contract', 'series_invalid', 'value'], ['activation', 'series_invalid', 'value'],
    ['applied', 'record_forged', 'hash'], ['activeBasis', 'record_forged', 'hash'], ['registered', 'record_forged', 'hash']] as const) {
    const f = fixture(t); f.series(); activate(f);
    const original = field === 'registered' ? f.series(independent) : head(f);
    const value = clone(original.value) as unknown as Record<string, Json>;
    if (field === 'contract' || field === 'activation') delete value[field];
    else delete (value['activation'] as Record<string, Json>)[field];
    const forged = rewrite(f.store, original, value as unknown as RepairSeries);
    assert.equal(refusedWith(readSeriesAt(f.store, project, reference(forged)), code).at.field, at, field);
    assert.equal(refusedWith(prepareSeriesLineAdmission(f.store, project, reference(forged)), code).at.field, at, field);
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
  refusedWith(commit(f.store, { ...q, writes: [{ id: 'stale-e2-write', kind: 'test', expected: 0, value: {} }] }), 'input_stale');
  refusedWith(commit(f.store, { writes: [{ id: 'stale-e1-write', kind: 'test', expected: 0, value: {} }], guards: launch.guards }), 'input_stale');
  refusedWith(prepareCallDispatch(f.store, project, reference(call.call)), 'call_series_unresolved');
  refusedWith(recordCall(f.store, project, { ...callRequest, call: 'fresh-after-bootstrap' }), 'call_series_unresolved');
  assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(q.record) })), q.record);
  assert.deepEqual(ok(readCall(f.store, project, reference(call.call))), call.call);
  assert.deepEqual(ok(recordCall(f.store, project, callRequest)).call, call.call);
  assert.equal(f.store.get('stale-e1-write'), null); assert.equal(f.store.get('stale-e2-write'), null);
});

test('B3.0b E2 new packet transaction guards the active pointer and cannot commit after exclusion', t => {
  const f = product(fixture(t)), prepared = ok(prepareQuestionPacket(f.store, f.packetRequest));
  assert.ok(prepared.guards.some(guard => guard.id === seriesCurrentId(project)));
  exclude(f);
  refusedWith(commit(f.store, prepared), 'input_stale'); assert.equal(f.store.get(prepared.record.id), null);
  refusedWith(prepareQuestionPacket(f.store, f.packetRequest), 'series_conflict');
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
  refusedWith(beginAttempt(f.store, { project, block, line: 1, attempt: 2, goal: f.goal }), 'series_invalid');
  activate(f, 'return-after-close');
  const next = ok(beginAttempt(f.store, { project, block, line: 1, attempt: 2, goal: f.goal }));
  assert.equal(next.value.attempts.length, 2); assert.deepEqual(next.value.attempts[0], closed.value.attempts[0]);
  assert.equal(f.store.history(call.id).length, 2); assert.equal(f.sent().length, 1);
  assert.deepEqual(ok(readModelCall(f.store, { project, record: reference(runtime) })), { ...actual, repeated: true });
});

test('B3.0b missing or foreign E4 terminal proof cannot authorize explicit completion or historical readers', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const f = product(fixture(t)), { request } = ready(f); await received(f, request); exclude(f);
  const terminal = ok(await runModelCall(f.store, request)).record;
  for (const variant of ['missing', 'foreign-series', 'foreign-pointer', 'wrong-ordinal'] as const) {
    // A pointer of another project is refused as a foreign record; the other variants fail the terminal evidence itself.
    const code = variant === 'foreign-pointer' ? 'record_foreign' : 'model_call_record_invalid';
    const value = clone(terminal.value) as OmModelCall;
    if (variant === 'missing') delete value.om.terminal;
    else if (variant === 'foreign-series') value.om.terminal!.series = { ...value.om.terminal!.series, id: 'repair-series:other:foreign:1' };
    else if (variant === 'foreign-pointer') value.om.terminal!.change.currentPointer = { ...value.om.terminal!.change.currentPointer, id: 'om-series-current:other' };
    else value.om.terminal!.attempt++;
    const forged = f.store.write({ id: terminal.id, kind: terminal.kind, expected: f.store.get(terminal.id)!.revision, value: value as unknown as Json });
    refusedWith(readModelTerminalWitness(f.store, { project, record: reference(forged) }), code);
    refusedWith(readModelCall(f.store, { project, record: reference(forged) }), code);
    refusedWith(completeAttempt(f.store, { project, block, line: 1, attempt: 1, terminal: reference(forged),
      outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } }), code);
  }
  const rejection = f.store.get<Record<string, unknown>>(terminal.value.om.rejection!.id, terminal.value.om.rejection!.revision)!;
  const missingRejection = clone(rejection.value); delete missingRejection['terminal'];
  const noBasis = rewrite(f.store, rejection, missingRejection);
  const noTerminal = clone(terminal.value) as OmModelCall; delete noTerminal.om.terminal; noTerminal.om.rejection = reference(noBasis);
  const forgedRuntime = rewrite(f.store, terminal, noTerminal);
  refusedWith(readModelCallPhysical(f.store, { project, record: reference(forgedRuntime) }), 'model_call_record_invalid');
  refusedWith(readModelCall(f.store, { project, record: reference(forgedRuntime) }), 'model_call_record_invalid');
  rewrite(f.store, noBasis, rejection.value); rewrite(f.store, forgedRuntime, terminal.value as OmModelCall);
  refusedWith(completeAttempt(f.store, { project, block, line: 1, attempt: 1, outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } }), 'series_invalid');
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

test('B3.0b lost B1 with only P or G retained including partial envelopes refuses fsck and the integrity gate', t => {
  const source = fixture(t); source.series(); const pair = transition(source, 'standalone-provenance');
  for (const saved of [pair.prepared, pair.issuance]) for (const partial of [false, true]) {
    const f = emptyProject(t);
    f.store.write({ id: saved.id, kind: saved.kind, expected: 0, value: partial ? {} : saved.value });
    for (const restart of [false, true]) {
      if (restart) f.restart();
      const retained = () => snapshot(f.store).filter(row => !row.head.id.startsWith('om-integrity:'));
      const before = retained();
      missingB1AtFsck(f.store);
      assert.deepEqual(retained(), before);
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
  for (const [missing, code] of [['proof', 'analysis_invalid'], ['pointer', 'record_missing'], ['foreign-proof', 'record_foreign']] as const) {
    const f = product(fixture(t), true, false), a = analysis(f), prepared = ok(prepareStopAnalysis(f.store, a.request));
    assert.deepEqual(prepared.writes.map(write => write.kind), ['om-analysis-intent', 'om-analysis-admission']);
    assert.ok(prepared.guards.some(guard => guard.id === seriesCurrentId(project)));
    ok(commit(f.store, prepared));
    const proof = f.store.list<{ pointer: Ref; series: Ref }>('om-analysis-admission')[0]!;
    if (missing === 'proof') erase(f.store, proof.id);
    else if (missing === 'pointer') erase(f.store, seriesCurrentId(project));
    else rewrite(f.store, proof, { ...proof.value, pointer: { ...proof.value.pointer, id: 'om-series-current:foreign' } });
    f.restart(); refusedWith(prepareStopAnalysis(f.store, a.request), code); assert.equal(f.sent().length, 0);
  }
});

test('B3.0b old A6 intent cannot reacquire admission after bootstrap or exclusion and never resends', async t => {
  for (const managed of [false, true]) {
    const f = product(fixture(t), managed, false), a = analysis(f), prepared = ok(prepareStopAnalysis(f.store, a.request));
    ok(commit(f.store, prepared));
    if (managed) exclude(f); else activate(f, 'adopt-stopped-intent');
    f.steps([{ research: a.answer, usage }]); f.restart();
    refusedWith(await runStopAnalysis(f.store, a.request), 'call_series_unresolved'); assert.equal(f.sent().length, 0);
    assert.equal(f.store.list('om-stop-review').length, 0);
    const retry = ok(prepareStopAnalysis(f.store, a.request));
    assert.ok(retry.guards.some(guard => guard.id === a.request.series.id && 'revision' in guard && guard.revision === a.request.series.revision));
    refusedWith(commit(f.store, { writes: [{ id: 'stale-analysis-application', kind: 'test', expected: 0, value: null }], guards: retry.guards }), 'input_stale');
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
      if (first === 'root') { ok(commit(other, opening)); refusedWith(commit(primary, activation), 'input_stale'); assert.equal(primary.get(activation.record.id), null); }
      else { ok(commit(primary, activation)); refusedWith(commit(other, opening), 'revision_conflict'); assert.equal(primary.get(opening.writes[0]!.id), null); }
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
      refusedWith(commit(primary, prepared), 'revision_conflict'); assert.equal(primary.get(prepared.writes[0]!.id), null);
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
      refusedWith(commit(f.store, prepared), 'input_stale'); assert.equal(f.store.get(prepared.record.id), null);
      refusedWith(prepareAcceptedAnswer(f.store, answer.request), 'input_stale');
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
      // The same call on the plain store is accepted while the block still participates; see the refusal below.
      ok(confirmAnswerGapClosure(f.store, supplied));
    }
    const saved = pending ? null : ok(writeGapLines(f.store, request));
    exclude(f, 'after-answer-application');
    if (!saved) {
      refusedWith(commit(f.store, prepared), 'input_stale'); refusedWith(prepareGapLines(f.store, request), 'series_invalid');
      // The hiding view above would be refused for the record it hides, not for the exclusion: ask the plain store.
      const unchanged = snapshot(f.store);
      assert.equal(refusedWith(confirmAnswerGapClosure(f.store, supplied), 'series_invalid').at.field, 'participation');
      assert.deepEqual(snapshot(f.store), unchanged);
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

function appliedPair(f: Pick<Fixture, 'store'>, horizon: Ref, choiceVersion: string) {
  const prepared = ok(writeSeriesTransition(f.store, { project, choiceVersion, horizon, series: roots(f) }));
  const issuance = ok(writeHorizonIssuance(f.store, { project, choiceVersion, horizon, transition: reference(prepared) }));
  return { project, prepared: reference(prepared), issuance: reference(issuance) };
}

function acceptMappedFrame(f: Pick<Fixture, 'store'>, frame: FrameRequest): AcceptedFrameRequest {
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
    if (!saved) { refusedWith(commit(f.store, prepared), 'input_stale'); refusedWith(prepareGapLines(f.store, frame.request), 'input_stale'); }
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

test('B3.0b era witness rejects paired field loss at first later and unactivated series revisions', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
  // Same split as above: the first managed revision and the unactivated registration are pinned by the era witness, so
  // dropping their fields is refused as a substituted pinned content (record_forged on hash); only a later revision, which
  // no witness pins, meets the check of the activation form (series_invalid on activation).
  for (const [stage, code, at] of [['first', 'record_forged', 'hash'], ['later', 'series_invalid', 'activation'],
    ['unactivated', 'record_forged', 'hash']] as const) {
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
    f.restart(); assert.equal(refusedWith(readSeriesAt(f.store, project, reference(forged)), code).at.field, at, stage);
    assert.equal(refusedWith(prepareSeriesParticipantAdmission(f.store, project, reference(forged)), code).at.field, at, stage);
    assert.deepEqual(ok(readSeriesAt(f.store, project, reference(legacy))), legacy);
  }
});

test('B3.0b era proof rejects absent foreign or incomplete threshold and producer sources', { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, t => {
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
      refusedWith(readSeriesAt(view, project, reference(later)), 'record_missing'); continue;
    } else {
      const value = clone(witness.value) as unknown as Record<string, Json>;
      if (variant === 'foreign-first') value['firstManaged'] = { ...reference(first), id: 'repair-series:foreign:block:1' };
      if (variant === 'missing-origin') delete value['origin'];
      if (variant === 'foreign-origin') value['origin'] = { kind: 'activation', applied: { ...reference(f.store.list('om-series-applied')[0]!), id: 'om-series-applied:foreign:proof' } };
      if (variant === 'missing-field') delete value['firstManaged'];
      rewrite(f.store, witness, value as unknown as EraWitness);
    }
    refusedWith(readSeriesAt(f.store, project, reference(later)), 'series_invalid');
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
      ok(commit(other, operation)); refusedWith(commit(f.store, activation), 'input_stale');
      assert.equal(f.store.get(seriesEraId(project, source.id)), null);
    } else {
      ok(commit(f.store, activation)); refusedWith(commit(other, operation), 'input_stale');
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
  refusedWith(prepareSeriesActivation(f.store, changed('changed-while-running')), 'attempt_running');
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
  refusedWith(commit(f.store, { writes: [{ id: 'old-work-proof', kind: 'test', expected: 0, value: null }], guards: restored.guards }), 'input_stale');
  assert.equal(f.store.get('old-work-proof'), null);
});

function missingB1AtFsck(store: Store) {
  const report = runIntegrityCheck(store, { project }); assert.ok(report.ok);
  assert.ok(report.value.value.findings.some(f => f.code === 'record_missing' && f.id === `om-input:${project}` && f.revision === 1));
  assert.equal(integrityGate(store, project)?.ok, false);
}

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
    const before = snapshot(alone.store);
    missingB1AtFsck(alone.store);
    assert.deepEqual(snapshot(alone.store).filter(row => !row.head.id.startsWith('om-integrity:')), before);
  }
  const onlyActivation = emptyProject(t);
  onlyActivation.store.write({ id: head(f).id, kind: 'repair-series', expected: 0, value: { activation: { contract: 'om-series-activation/v1' } } });
  missingB1AtFsck(onlyActivation.store);
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

test('B3.0b exact running and received E4 records reject absent null and foreign original admission', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const f = product(fixture(t)), { request } = ready(f), receipt = await received(f, request);
  const running = f.store.history<OmModelCall>(receipt.id).find(row => row.value.om.application === 'running')!;
  assert.ok(running);
  for (const source of [running, receipt]) for (const [variant, code] of [['missing', 'series_invalid'],
    ['null', 'model_call_record_invalid'], ['foreign', 'record_foreign']] as const) {
    const value = clone(source.value) as unknown as { om: Record<string, Json> };
    if (variant === 'missing') delete value.om['admission'];
    else if (variant === 'null') value.om['admission'] = null;
    else value.om['admission'] = { contract: 'om-model-admission/v1', series: { ...reference(f.running) },
      pointer: { ...reference(f.store.get(seriesCurrentId(project))!), id: 'om-series-current:foreign' } };
    const forged = rewrite(f.store, source, value as unknown as OmModelCall);
    refusedWith(readModelCallPhysical(f.store, { project, record: reference(forged) }), code);
    rewrite(f.store, forged, source.value as OmModelCall);
  }
  assert.equal(f.sent().length, 1); ok(readModelCallPhysical(f.store, { project, record: reference(receipt) }));
  erase(f.store, seriesCurrentId(project));
  const before = snapshot(f.store);
  refusedWith(await runModelCall(f.store, request), 'record_missing');
  assert.deepEqual(snapshot(f.store), before); assert.equal(f.sent().length, 1);
  assert.deepEqual(f.store.get(receipt.id), receipt, 'Lost proof preserves the physical receipt without manufacturing a terminal outcome');
});

test('B3.0b old legacy E4 packet cannot gain a new physical launch after bootstrap', async t => {
  const f = product(fixture(t), false), { packet, request } = ready(f);
  f.steps([{ research: fact(f), usage }]);
  activate(f, 'bootstrap-before-first-send'); f.restart();
  const before = snapshot(f.store);
  refusedWith(await runModelCall(f.store, request), 'series_conflict'); assert.equal(f.sent().length, 0);
  assert.equal(f.store.list('model-call').length, 0);
  assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(packet) })), packet);
  assert.deepEqual(snapshot(f.store), before);
});

test('B3.0b an unactivated registration cannot acquire later history or return after activation', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
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
    refusedWith(readSeriesAt(f.store, project, reference(forged)), 'series_invalid');
    refusedWith(prepareSeriesParticipantAdmission(f.store, project, reference(forged)), 'series_invalid');
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
    f.restart(); refusedWith(await runStopAnalysis(f.store, a.request), 'input_stale');
    assert.deepEqual(f.store.get(receipt.id), receipt); assert.equal(f.sent().length, 1);
    assert.equal(f.store.list('om-stop-review').length, 0);
    const call = f.store.list('call-record')[0]!;
    assert.equal(f.store.history(call.id).length, 2);
    const before = snapshot(f.store); f.restart();
    refusedWith(await runStopAnalysis(f.store, a.request), 'input_stale'); assert.deepEqual(snapshot(f.store), before); assert.equal(f.sent().length, 1);
  }
});

function refusedPair(f: Fixture, choiceVersion = 'discarded-choice') {
  const horizon = f.horizon(choiceVersion, { excluded: [{ block: 'garden-produce-block',
    reason: 'The required provider is excluded', returnCondition: 'Select the provider again' }] });
  assert.equal(horizon.gate.value.state, 'refused');
  assert.ok(horizon.gate.value.codes.length > 0);
  const request = appliedPair(f, reference(horizon.gate), choiceVersion);
  const prepared = ok(readPreparedSeriesTransition(f.store, { project, record: request.prepared })).record;
  const issuance = ok(readHorizonIssuance(f.store, { project, record: request.issuance })).record;
  assert.equal(issuance.value.state, 'refused');
  return { horizon, prepared, issuance, request };
}

for (const foreign of ['another prepared transition', 'another horizon and choice', 'another project namespace'] as const)
  test(`B3 application rejects G for ${foreign} without changing any record`, t => {
    const f = fixture(t); f.series();
    const pair = transition(f, 'foreign-G-base');
    let issuance: Ref;
    if (foreign === 'another prepared transition') {
      const other = ok(writeSeriesTransition(f.store, { project, choiceVersion: 'foreign-G-base', horizon: reference(pair.horizon.gate), series: [] }));
      issuance = reference(ok(writeHorizonIssuance(f.store, { project, choiceVersion: 'foreign-G-base',
        horizon: reference(pair.horizon.gate), transition: reference(other) })));
    } else if (foreign === 'another horizon and choice') issuance = transition(f, 'foreign-G-other-choice').request.issuance;
    else issuance = { ...pair.request.issuance, id: pair.request.issuance.id.replace(`:${project}:`, ':foreign-project:') };
    const request = { ...pair.request, issuance }, before = snapshot(f.store);
    // A reference into another namespace is a foreign record; a real but unrelated P or G fails the exact binding instead.
    const code = foreign === 'another project namespace' ? 'record_foreign' : 'series_invalid';
    for (const operation of [prepareSeriesActivation, applySeriesActivation]) {
      refusedWith(operation(f.store, request), code);
      assert.deepEqual(snapshot(f.store), before);
    }
    for (const kind of ['om-series-applied', 'om-series-current', 'om-series-era', 'om-series-discarded'])
      assert.deepEqual(f.store.list(kind), []);
  });

test('B3 applied and pointer history rederive the exact G binding after a self-consistent substitution', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, t => {
  const f = fixture(t); f.series();
  const pair = transition(f, 'historical-G-base');
  const other = ok(writeSeriesTransition(f.store, { project, choiceVersion: 'historical-G-base', horizon: reference(pair.horizon.gate), series: [] }));
  const issuance = reference(ok(writeHorizonIssuance(f.store, { project, choiceVersion: 'historical-G-base',
    horizon: reference(pair.horizon.gate), transition: reference(other) })));
  const applied = ok(applySeriesActivation(f.store, pair.request));
  const value = { ...clone(applied.record.value), issuance };
  const forged = f.store.write({ id: `om-series-applied:${project}:${hashJson({ prepared: value.prepared, issuance })}`,
    kind: applied.record.kind, expected: 0, value });
  const pointer = rewrite(f.store, applied.pointer, { ...clone(applied.pointer.value), applied: reference(forged) });
  const before = snapshot(f.store); f.restart();
  refusedWith(readAppliedSeriesTransition(f.store, { project, record: reference(forged) }), 'series_invalid');
  refusedWith(readCurrentSeriesPointer(f.store, { project, record: reference(pointer) }), 'series_invalid');
  refusedWith(readCurrentSeriesPointer(f.store, { project }), 'series_invalid');
  assert.deepEqual(snapshot(f.store), before);
});

test('B3 discarded records only the proved negative pair after heads move and repeats exactly after restart', t => {
  const f = fixture(t); f.series(); stop(f); activate(f, 'before-negative');
  const pair = refusedPair(f), historicalP = f.store.history(pair.prepared.id);
  const afterNegative = snapshot(f.store);
  const refused = refusedWith(applySeriesActivation(f.store, pair.request), 'series_transition_refused');
  assert.deepEqual(refused.at.ref, pair.request.issuance);
  assert.deepEqual(snapshot(f.store), afterNegative);
  const first = ok(prepareSeriesDiscard(f.store, pair.request));
  assert.deepEqual(snapshot(f.store), afterNegative);
  assert.deepEqual(first.record.value, { contract: 'om-series-discarded/v1', project, prepared: pair.request.prepared,
    issuance: pair.request.issuance, state: 'discarded', codes: pair.issuance.value.codes });
  assert.equal(first.record.id, `om-series-discarded:${project}:${hashJson({ prepared: pair.request.prepared, issuance: pair.request.issuance })}`);
  assert.equal(first.record.kind, 'om-series-discarded'); assert.equal(first.record.revision, 1);
  assert.equal(first.record.hash, hashJson(first.record.value));
  assert.deepEqual(first.writes.map(row => ({ id: row.id, expected: row.expected })), [{ id: first.record.id, expected: 0 }]);
  assert.ok(first.guards.every(guard => guard.id === first.record.id), 'A historical negative outcome takes no current admission guards');
  activate(f, 'after-negative'); f.series(independent);
  const beforeWrite = snapshot(f.store), writeMany = f.store.writeMany.bind(f.store); let transactions = 0;
  f.store.writeMany = ((writes, guards) => {
    transactions++;
    assert.deepEqual(writes.map(row => row.id), [first.record.id]);
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  let saved: typeof first.record;
  try { saved = ok(writeSeriesDiscard(f.store, pair.request)).record; }
  finally { f.store.writeMany = writeMany; }
  assert.equal(transactions, 1); assert.deepEqual(saved, first.record);
  assert.deepEqual(snapshot(f.store).filter(row => row.head.id !== saved.id), beforeWrite);
  assert.deepEqual(f.store.history(pair.prepared.id), historicalP);
  f.restart(); const beforeRepeat = snapshot(f.store);
  const exact = new Proxy(f.store, { get(target, prop) {
    if (prop === 'get') return (id: string, revision?: number) => {
      assert.notEqual(revision, undefined, `Discarded history cannot select the head of ${id}`); return target.get(id, revision);
    };
    if (prop === 'list') return () => assert.fail('Discarded history does not enumerate current membership');
    if (prop === 'writeMany') return () => assert.fail('An exact discarded repeat performs no transaction');
    const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  assert.deepEqual(ok(readDiscardedSeriesTransition(exact, { project, record: reference(saved) })), saved);
  assert.deepEqual(ok(prepareSeriesDiscard(exact, pair.request)), { record: saved, writes: [], guards: [] });
  assert.deepEqual(ok(writeSeriesDiscard(exact, pair.request)), { record: saved, writes: [], guards: [] });
  assert.deepEqual(snapshot(f.store), beforeRepeat);
});

test('B3 discarded refuses accepted foreign and corrupt G and every absent saved field or source', { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, t => {
  const f = fixture(t); f.series();
  const accepted = transition(f, 'discard-accepted'), pair = refusedPair(f), other = refusedPair(f, 'discard-other-horizon');
  const empty = ok(writeSeriesTransition(f.store, { project, choiceVersion: pair.issuance.value.choiceVersion,
    horizon: pair.issuance.value.horizon, series: [] }));
  const wrongP = reference(ok(writeHorizonIssuance(f.store, { project, choiceVersion: pair.issuance.value.choiceVersion,
    horizon: pair.issuance.value.horizon, transition: reference(empty) })));
  const discards: [Parameters<typeof prepareSeriesDiscard>[1], string][] = [[accepted.request, 'series_invalid'],
    [{ ...pair.request, issuance: wrongP }, 'series_invalid'], [{ ...pair.request, issuance: other.request.issuance }, 'series_invalid'],
    [{ ...pair.request, issuance: { ...pair.request.issuance, hash: '0'.repeat(64) } }, 'record_forged'],
    [{ ...pair.request, issuance: { ...pair.request.issuance, id: pair.request.issuance.id.replace(`:${project}:`, ':foreign:') } }, 'record_foreign']];
  for (const [request, code] of discards) {
    const before = snapshot(f.store);
    refusedWith(prepareSeriesDiscard(f.store, request), code); refusedWith(writeSeriesDiscard(f.store, request), code);
    assert.deepEqual(snapshot(f.store), before);
  }
  const forgedG = rewrite(f.store, accepted.issuance, { ...accepted.issuance.value, state: 'refused', codes: pair.issuance.value.codes });
  const masquerade = { ...accepted.request, issuance: reference(forgedG) }, beforeMasquerade = snapshot(f.store);
  refusedWith(readHorizonIssuance(f.store, { project, record: reference(forgedG) }), 'horizon_issuance_record_invalid');
  for (const operation of [prepareSeriesActivation, applySeriesActivation, prepareSeriesDiscard, writeSeriesDiscard])
    refusedWith(operation(f.store, masquerade), 'horizon_issuance_record_invalid');
  assert.deepEqual(snapshot(f.store), beforeMasquerade);
  rewrite(f.store, forgedG, accepted.issuance.value);
  const saved = ok(writeSeriesDiscard(f.store, pair.request)).record;
  for (const field of Object.keys(saved.value)) {
    const value = clone(saved.value) as unknown as Record<string, Json>; delete value[field];
    const forged = rewrite(f.store, saved, value as unknown as typeof saved.value), before = snapshot(f.store); f.restart();
    refusedWith(readDiscardedSeriesTransition(f.store, { project, record: reference(forged) }), 'series_invalid');
    refusedWith(prepareSeriesDiscard(f.store, pair.request), 'series_invalid'); refusedWith(writeSeriesDiscard(f.store, pair.request), 'series_invalid');
    assert.deepEqual(snapshot(f.store), before);
    rewrite(f.store, forged, saved.value);
  }
  for (const value of [{ ...saved.value, codes: [] }, { ...saved.value, state: 'accepted' },
    { ...saved.value, prepared: other.request.prepared }, { ...saved.value, issuance: other.request.issuance }]) {
    const forged = rewrite(f.store, saved, value as typeof saved.value); f.restart();
    refusedWith(readDiscardedSeriesTransition(f.store, { project, record: reference(forged) }), 'series_invalid');
    rewrite(f.store, forged, saved.value);
  }
  for (const source of [pair.prepared, pair.issuance]) {
    const view = new Proxy(f.store, { get(target, prop) {
      if (prop === 'get') return (id: string, revision?: number) => id === source.id ? null : target.get(id, revision);
      const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    refusedWith(readDiscardedSeriesTransition(view, { project, record: reference(saved) }), 'record_missing');
    refusedWith(writeSeriesDiscard(view, pair.request), 'record_missing');
  }
  assert.deepEqual(ok(readDiscardedSeriesTransition(f.store, { project, record: reference(saved) })), saved);
});

test('B3 discarded provenance alone detects lost B1 even when its body is incomplete', t => {
  const f = fixture(t); f.series(); const saved = ok(writeSeriesDiscard(f.store, refusedPair(f).request)).record;
  for (const value of [saved.value, {}]) {
    const alone = emptyProject(t); alone.store.write({ id: saved.id, kind: saved.kind, expected: 0, value });
    alone.restart(); const before = snapshot(alone.store);
    missingB1AtFsck(alone.store);
    assert.deepEqual(snapshot(alone.store).filter(row => !row.head.id.startsWith('om-integrity:')), before);
  }
});

test('B3 removing another block retains the stopped active series and the inactive last active basis', t => {
  const f = fixture(t); f.series(); const stopped = stop(f), history = ok(readStopHistory(f.store, { project, block, line: 1 }));
  activate(f, 'stopped-active'); f.series(independent);
  const both = ok(applySeriesActivation(f.store, transition(f, 'both-active', {
    features: [{ outcome: 'garden-result' }, { outcome: 'garden-later' }] }).request));
  const independentBasis = both.record.value.decisions.find(row => row.block === independent)!.activeBasis;
  assert.ok(independentBasis);
  const pair = transition(f, 'remove-other', { excluded: [{ block: independent,
    reason: 'The independent result is deferred', returnCondition: 'Select it again' }] });
  const applied = ok(applySeriesActivation(f.store, pair.request)), retained = head(f), removed = head(f, independent);
  assert.equal(applied.record.value.decisions.find(row => row.block === block)!.outcome, 'continue');
  assert.equal(retained.id, stopped.id); assert.equal(retained.value.line, 1);
  assert.equal(f.store.get(`repair-series:${project}:2:${block}`), null);
  for (const field of ['stop', 'ladder', 'withoutProgress', 'attempts'] as const) assert.deepEqual(retained.value[field], stopped.value[field]);
  assert.deepEqual(ok(readStopHistory(f.store, { project, block, line: 1 })), history);
  refusedWith(beginAttempt(f.store, { project, block, line: 1, attempt: 4, goal: workGoal }), 'series_stopped');
  const decision = applied.record.value.decisions.find(row => row.block === independent)!;
  assert.equal(decision.outcome, 'inactive'); assert.equal(decision.participation, 'excluded');
  assert.deepEqual(decision.activeBasis, independentBasis);
  assert.equal(removed.value.activation?.state, 'activated');
  assert.ok(removed.value.activation?.state === 'activated');
  assert.deepEqual(removed.value.activation.activeBasis, independentBasis);
  f.restart(); const before = snapshot(f.store);
  assert.deepEqual(ok(applySeriesActivation(f.store, pair.request)).writes, []);
  assert.deepEqual(ok(readStopHistory(f.store, { project, block, line: 1 })), history);
  assert.deepEqual(snapshot(f.store), before);
});

function changedPair(f: Fixture, acceptance: AcceptedFrameRequest, choiceVersion: string) {
  const horizon = ok(writeHorizon(f.store, { project, input: reference(f.input), graph: acceptance.graph, refinement: acceptance.layer,
    available: {}, choice: { choiceVersion, features: [{ outcome: 'garden-result' }, { outcome: 'garden-later' }], excluded: [] } }));
  assert.equal(horizon.gate.value.state, 'accepted');
  return appliedPair(f, reference(horizon.gate), choiceVersion);
}

test('B3 one running participant refuses the whole new-work application and only a fresh pair proceeds', t => {
  const f = fixture(t); f.series(); f.series(independent);
  const first = transition(f, 'multi-base', { features: [{ outcome: 'garden-result' }, { outcome: 'garden-later' }] });
  ok(applySeriesActivation(f.store, first.request));
  ok(beginAttempt(f.store, { project, block: independent, line: 1, attempt: 1, goal: workGoal }));
  const accepted = acceptMappedFrame(f, { project, level: 2, graph: reference(f.graph), horizon: reference(first.horizon.gate), layer: null, frame: null, upper: null });
  const pair = changedPair(f, accepted, 'multi-running'), before = snapshot(f.store);
  refusedWith(prepareSeriesActivation(f.store, pair), 'attempt_running');
  refusedWith(applySeriesActivation(f.store, pair), 'attempt_running');
  assert.deepEqual(snapshot(f.store), before); assert.deepEqual(f.store.list('om-series-discarded'), []);
  ok(completeAttempt(f.store, { project, block: independent, line: 1, attempt: 1,
    outcome: { reason: 'off-form', achieved: [], cancelled: [], refusals: [] } }));
  const afterClose = snapshot(f.store); refusedWith(applySeriesActivation(f.store, pair), 'series_invalid'); assert.deepEqual(snapshot(f.store), afterClose);
  const applied = ok(applySeriesActivation(f.store, changedPair(f, accepted, 'multi-closed')));
  assert.equal(applied.series.length, 2); assert.ok(applied.record.value.decisions.every(row => row.outcome === 'new-work'));
  assert.ok(applied.series.every(row => row.value.line === 2)); assert.deepEqual(f.store.list('om-series-discarded'), []);
});

test('B3 a second Store moving one participant defeats all prepared writes with no changes beyond the rival', t => {
  const f = fixture(t); f.series(); f.series(independent);
  const first = transition(f, 'CAS-base', { features: [{ outcome: 'garden-result' }, { outcome: 'garden-later' }] });
  ok(applySeriesActivation(f.store, first.request));
  const accepted = acceptMappedFrame(f, { project, level: 2, graph: reference(f.graph), horizon: reference(first.horizon.gate), layer: null, frame: null, upper: null });
  const pair = changedPair(f, accepted, 'CAS-prepared'), prepared = ok(prepareSeriesActivation(f.store, pair)), other = new Store(f.path);
  t.after(() => other.close());
  assert.equal(prepared.series.length, 2); assert.ok(prepared.series.every(row => row.value.line === 2));
  ok(beginAttempt(other, { project, block: independent, line: 1, attempt: 1, goal: workGoal }));
  const afterRival = snapshot(f.store);
  refusedWith(commit(f.store, prepared), 'input_stale'); assert.deepEqual(snapshot(f.store), afterRival);
  assert.equal(f.store.get(prepared.record.id), null); assert.deepEqual(f.store.list('om-series-discarded'), []);
  for (const owner of [block, independent]) assert.equal(f.store.get(`repair-series:${project}:2:${owner}`), null);
  ok(completeAttempt(other, { project, block: independent, line: 1, attempt: 1,
    outcome: { reason: 'off-form', achieved: [], cancelled: [], refusals: [] } }));
  const applied = ok(applySeriesActivation(f.store, changedPair(f, accepted, 'CAS-fresh')));
  assert.ok(applied.series.every(row => row.value.line === 2)); assert.deepEqual(f.store.list('om-series-discarded'), []);
});

test('B3 accepted new-work blocks old E1 E2 E4 admission while exact call and packet history repeat', async t => {
  const f = product(fixture(t)), q = ok(prepareQuestionPacket(f.store, f.packetRequest));
  const oldRequest = e1Request(f, 'old-line-call'), call = ok(recordCall(f.store, project, oldRequest));
  const launch = ok(prepareCallDispatch(f.store, project, reference(call.call)));
  ok(commit(f.store, q)); const packet = q.record;
  const e4: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(f.adapter), config: reference(f.environment) }, role: 'implementer' };
  ok(completeAttempt(f.store, { project, block, line: 1, attempt: 1,
    outcome: { reason: 'off-form', achieved: [], cancelled: [], refusals: [] } }));
  const closed = head(f), acceptance = acceptMappedFrame(f, f.gapRequest.sources.operations.frame);
  const applied = ok(applySeriesActivation(f.store, changedPair(f, acceptance, 'old-call-new-work')));
  const successor = applied.series.find(row => row.value.block === block)!;
  assert.equal(successor.value.line, 2);
  assert.equal(applied.record.value.decisions.find(row => row.block === block)!.outcome, 'new-work');
  const advanced = f.store.get<RepairSeries>(closed.id)!;
  for (const restart of [false, true]) {
    if (restart) f.restart();
    const before = snapshot(f.store);
    refusedWith(commit(f.store, { writes: [{ id: 'B3-stale-E1', kind: 'test', expected: 0, value: null }], guards: launch.guards }), 'input_stale');
    refusedWith(commit(f.store, { writes: [{ id: 'B3-stale-E2', kind: 'test', expected: 0, value: null }], guards: q.guards }), 'input_stale');
    refusedWith(prepareCallDispatch(f.store, project, reference(call.call)), 'call_series_unresolved');
    for (const series of [reference(f.running), reference(advanced)])
      refusedWith(recordCall(f.store, project, { ...oldRequest, call: `fresh-old-${series.revision}`, series }), 'call_series_unresolved');
    const repeated = ok(recordCall(f.store, project, oldRequest));
    assert.equal(repeated.repeated, true); assert.deepEqual(repeated.call, call.call);
    assert.deepEqual(ok(readCall(f.store, project, reference(call.call))), call.call);
    assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(packet) })), packet);
    refusedWith(await runModelCall(f.store, e4), 'series_conflict'); assert.equal(f.sent().length, 0);
    assert.equal(f.store.list('model-call').length, 0); assert.deepEqual(snapshot(f.store), before);
  }
  const running = ok(beginAttempt(f.store, { project, block, line: 2, attempt: 2, goal: f.goal }));
  const fresh = ok(recordCall(f.store, project, { ...oldRequest, call: 'new-line-call', series: reference(running), attempt: 2 }));
  const dispatch = ok(prepareCallDispatch(f.store, project, reference(fresh.call)));
  assert.ok(dispatch.guards.some(guard => canonical(guard) === canonical(reference(applied.pointer))));
});
const B3_HISTORY_BASE = 'e1e87e9596d1be7fb390564782e5aa60f5431e0b';
const B3_HISTORY_LOADER = String.raw`import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
let root,base,manifest,ts;
export async function initialize(data){root=data.root;base=data.base;manifest=data.manifest;ts=(await import(data.typescript)).default;}
export async function load(url,context,next){
 const prefix=new URL('dist/',root).href;
 if(url.startsWith(prefix)&&/\.js$/.test(url)){
  const relative=url.slice(prefix.length).replace(/\.js$/,'.ts');
  if(relative.startsWith('src/')||relative.startsWith('test/')){
   let source=execFileSync('git',['show',base+':'+relative],{cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
   appendFileSync(manifest,relative+'\n');
   if(relative==='test/om-series-current.test.ts'){
    const firstTest=source.indexOf('\ntest('),registration="import test, { type TestContext } from 'node:test';";
    if(firstTest<0||!source.startsWith(registration))throw new Error('The exact historical fixture prefix was not found');
    source=source.slice(registration.length,firstTest)+'\nexport {fixture,stop,transition};\n';
   }
   return {format:'module',shortCircuit:true,source:ts.transpileModule(source,
    {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};
  }
 }
 return next(url,context);
}`;

interface B3HistoricalSeries {
  managed: {
    directory: string; database: string; rows: Revision[]; bytes: string;
    original: Revision<RepairSeries>; stopped: Revision<RepairSeries>; current: Revision<RepairSeries>;
    stopHistory: unknown; projection: unknown;
    activations: {
      request: { project: string; prepared: Ref; issuance: Ref };
      record: Revision; pointer: Revision; series: Revision<RepairSeries>[]; repeat: unknown;
    }[];
  };
  native: {
    directory: string; database: string; rows: Revision[]; bytes: string;
    series: Revision<RepairSeries>; membership: Revision; projection: unknown;
  };
}

test('B3 whole e1e87e9 producer retains applied series pointers legacy reads and exact repeats', async t => {
  const { createRequire } = await import('node:module'), { pathToFileURL } = await import('node:url');
  const directory = mkdtempSync(join(tmpdir(), 'omg-b3-whole-git-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = new URL('../../', import.meta.url).href, repository = fileURLToPath(root);
  const loader = join(directory, 'loader.mjs'), producer = join(directory, 'producer.mjs'), manifest = join(directory, 'loaded-src.txt');
  writeFileSync(loader, B3_HISTORY_LOADER);
  // Both the fixture and every transitive src module come from the same producer commit.
  writeFileSync(producer, String.raw`import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const root=process.argv[2],from=relative=>import(new URL('dist/'+relative,root).href);
const {fixture,stop,transition}=await from('test/om-series-current.test.js');
const {Store}=await from('src/storage/store.js');
const {ProductEngine}=await from('src/product/engine.js');
const {canonical}=await from('src/canonical.js');
const {reference}=await from('src/pipeline/contracts.js');
const {openSeries,readSeries,readSeriesAt,readStopHistory,readCurrentSeriesPointer,readAppliedSeriesTransition,applySeriesActivation,
 seriesCurrentId,seriesMembershipId}=await from('src/om/series.js');
const project='garden',block='garden-consume-block',cleanup=[],context={after:fn=>cleanup.push(fn)};
const ok=result=>{assert.equal(result.ok,true,JSON.stringify(result));return result.value;};
const rows=store=>store.list().flatMap(row=>store.history(row.id));
const noneDiscarded=store=>assert.equal(store.list().some(row=>row.kind==='om-series-discarded'||row.id.startsWith('om-series-discarded:'+project+':')),false);
try{
 const f=fixture(context),original=f.series(),stopped=stop(f),stopHistory=ok(readStopHistory(f.store,{project,block,line:1}));
 assert.equal(original.value.contract,undefined);assert.equal(original.value.activation,undefined);assert.ok(stopped.value.stop);
 const first=transition(f,'b3-history-bootstrap'),initial=ok(applySeriesActivation(f.store,first.request));
 assert.equal(initial.record.value.decisions[0].outcome,'establish-basis');
 const later=transition(f,'b3-history-continue'),continued=ok(applySeriesActivation(f.store,later.request));
 assert.equal(continued.record.value.decisions[0].outcome,'continue');
 assert.ok(continued.pointer.revision>initial.pointer.revision);
 assert.deepEqual(ok(readSeriesAt(f.store,project,reference(original))),original);
 assert.deepEqual(ok(readSeriesAt(f.store,project,reference(stopped))),stopped);
 const current=ok(readSeries(f.store,{project,block,line:1}));
 assert.equal(current.value.contract,'om-repair-series/v2');assert.equal(current.value.activation.state,'activated');
 assert.deepEqual(current.value.attempts,stopped.value.attempts);assert.deepEqual(current.value.stop,stopped.value.stop);
 const activations=[{pair:first,applied:initial},{pair:later,applied:continued}].map(({pair,applied})=>{
  const before=canonical(rows(f.store)),repeat=ok(applySeriesActivation(f.store,pair.request));
  assert.deepEqual(repeat.writes,[]);assert.deepEqual(repeat.guards,[]);assert.equal(canonical(rows(f.store)),before);
  return {request:pair.request,record:ok(readAppliedSeriesTransition(f.store,{project,record:reference(applied.record)})),
   pointer:ok(readCurrentSeriesPointer(f.store,{project,record:reference(applied.pointer)})),
   series:applied.series.map(row=>ok(readSeriesAt(f.store,project,reference(row)))),repeat};
 });
 assert.deepEqual(ok(readCurrentSeriesPointer(f.store,{project})),continued.pointer);
 assert.equal(f.store.get(seriesCurrentId(project)).revision,continued.pointer.revision);
 noneDiscarded(f.store);
 const saved=rows(f.store),managed={directory:f.root,database:f.path,rows:saved,bytes:canonical(saved),original,stopped,current,stopHistory,
  projection:f.engine.projection(project),activations};
 f.store.close();
 const nativeDirectory=mkdtempSync(join(tmpdir(),'omg-b3-native-history-')),database=join(nativeDirectory,'state.sqlite'),store=new Store(database);
 cleanup.push(()=>{store.close();rmSync(nativeDirectory,{recursive:true,force:true});});
 const engine=new ProductEngine(store);engine.execute({type:'create-project',project,title:'Historical native series'});
 const projection=engine.projection(project);
 const series=ok(openSeries(store,{project,block,line:1,slice:'legacy:native-before-b1',predecessor:null,basis:null}));
 const membership=store.get(seriesMembershipId(project));
 assert.equal(membership.value.mode,'legacy');assert.equal(membership.value.activation,null);
 assert.equal(store.get('om-input:'+project),null);assert.equal(store.get(seriesCurrentId(project)),null);
 assert.deepEqual(ok(readSeriesAt(store,project,reference(series))),series);
 assert.deepEqual(ok(readSeries(store,{project,block,line:1})),series);
 assert.deepEqual(engine.projection(project),projection);noneDiscarded(store);
 const nativeRows=rows(store),native={directory:nativeDirectory,database,rows:nativeRows,bytes:canonical(nativeRows),series,membership,projection};
 store.close();process.stdout.write(JSON.stringify({managed,native}));
}catch(error){for(const close of cleanup)try{close();}catch{}throw error;}
`);
  const bootstrap = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},
{data:{root:${JSON.stringify(root)},base:${JSON.stringify(B3_HISTORY_BASE)},manifest:${JSON.stringify(manifest)},
typescript:${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href)}}});`;
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, root],
    { cwd: repository, env: environment, encoding: 'utf8', timeout: 120000, maxBuffer: 40000000 });
  assert.equal(child.error, undefined, child.error?.message); assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const old = JSON.parse(child.stdout) as B3HistoricalSeries;
  for (const source of [old.managed, old.native]) t.after(() => rmSync(source.directory, { recursive: true, force: true }));
  const loaded = new Set(readFileSync(manifest, 'utf8').trim().split('\n'));
  for (const path of ['test/om-series-current.test.ts', 'test/product-fixture.ts', 'test/om-fixture.ts', 'src/storage/store.ts',
    'src/product/engine.ts', 'src/om/series.ts', 'src/om/series-transition.ts', 'src/om/horizon.ts', 'src/om/input.ts'])
    assert.ok(loaded.has(path), `Historical ${path} must be loaded from the same Git producer`);
  const unchanged = (store: Store, saved: { rows: Revision[]; bytes: string }) => {
    assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), saved.bytes);
    for (const row of saved.rows) assert.deepEqual(store.get(row.id, row.revision), row);
    assert.equal(store.list().some(row => row.kind === 'om-series-discarded' || row.id.startsWith(`om-series-discarded:${project}:`)), false);
  };
  let managed = new Store(old.managed.database), native = new Store(old.native.database);
  try {
    for (const restart of [false, true]) {
      if (restart) { managed.close(); native.close(); managed = new Store(old.managed.database); native = new Store(old.native.database); }
      unchanged(managed, old.managed); unchanged(native, old.native);
      for (const row of [old.managed.original, old.managed.stopped, old.managed.current])
        assert.deepEqual(ok(readSeriesAt(managed, project, reference(row))), row);
      assert.deepEqual(ok(readSeries(managed, { project, block, line: 1 })), old.managed.current);
      assert.deepEqual(ok(readStopHistory(managed, { project, block, line: 1 })), old.managed.stopHistory);
      assert.deepEqual(new ProductEngine(managed).projection(project), old.managed.projection);
      for (const entry of old.managed.activations) {
        assert.deepEqual(ok(readAppliedSeriesTransition(managed, { project, record: reference(entry.record) })), entry.record);
        assert.deepEqual(ok(readCurrentSeriesPointer(managed, { project, record: reference(entry.pointer) })), entry.pointer);
        for (const row of entry.series) assert.deepEqual(ok(readSeriesAt(managed, project, reference(row))), row);
        assert.deepEqual(ok(prepareSeriesActivation(managed, entry.request)), entry.repeat);
        assert.deepEqual(ok(applySeriesActivation(managed, entry.request)), entry.repeat);
      }
      assert.deepEqual(ok(readCurrentSeriesPointer(managed, { project })), old.managed.activations.at(-1)!.pointer);
      assert.deepEqual(ok(readSeriesAt(native, project, reference(old.native.series))), old.native.series);
      assert.deepEqual(ok(readSeries(native, { project, block, line: 1 })), old.native.series);
      assert.deepEqual(native.get(seriesMembershipId(project)), old.native.membership);
      assert.deepEqual(new ProductEngine(native).projection(project), old.native.projection);
      assert.equal(native.get(seriesCurrentId(project)), null);
      unchanged(managed, old.managed); unchanged(native, old.native);
    }
  } finally { managed.close(); native.close(); }
});

test('B3 discarded rejects malformed public arguments before reading the store', t => {
  const f = fixture(t), ref = { id: 'absent', revision: 1, hash: '0'.repeat(64) };
  const view = new Proxy(f.store, { get(target, prop) {
    if (prop === 'get' || prop === 'list' || prop === 'writeMany') return () => assert.fail('Malformed arguments are rejected before storage');
    const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const invalid = (run: () => unknown) => assert.throws(run, (error: unknown) => error instanceof EngineError && error.code === 'series_request_invalid');
  for (const request of [undefined, null, [], {}, { prepared: ref, issuance: ref }, { project, prepared: ref }, { project, issuance: ref },
    { project, prepared: null, issuance: ref }, { project, prepared: ref, issuance: [] },
    { project, prepared: { id: ref.id, revision: 1 }, issuance: ref },
    { project, prepared: ref, issuance: { ...ref, revision: 0 } }, { project, prepared: ref, issuance: ref, state: 'discarded' }])
    for (const operation of [prepareSeriesDiscard, writeSeriesDiscard]) invalid(() => operation(view, request as never));
  for (const request of [undefined, null, [], {}, { record: ref }, { project }, { project, record: null }, { project, record: [] },
    { project, record: { id: ref.id, revision: 1 } }, { project, record: ref, codes: [] }])
    invalid(() => readDiscardedSeriesTransition(view, request as never));
});

test('B3 discarded exact reading rejects wrong address revision hash kind and extra body fields after restart', t => {
  const f = fixture(t); f.series(); const pair = refusedPair(f), saved = ok(writeSeriesDiscard(f.store, pair.request)).record;
  const wrongAddress = f.store.write({ id: `om-series-discarded:${project}:${'0'.repeat(64)}`, kind: saved.kind, expected: 0, value: saved.value });
  const wrongRevision = f.store.write({ id: saved.id, kind: saved.kind, expected: 1, value: saved.value });
  const extra = rewrite(f.store, saved, { ...saved.value, extra: null } as typeof saved.value);
  f.restart();
  for (const record of [wrongAddress, wrongRevision, extra]) refusedWith(readDiscardedSeriesTransition(f.store, { project, record: reference(record) }), 'series_invalid');
  rewrite(f.store, extra, saved.value);
  refusedWith(readDiscardedSeriesTransition(f.store, { project, record: { ...reference(saved), hash: 'f'.repeat(64) } }), 'record_forged');
  refusedWith(readDiscardedSeriesTransition(f.store, { project, record: { ...reference(saved), id: saved.id.replace(`:${project}:`, ':foreign:') } }), 'record_foreign');
  const alone = emptyProject(t); alone.store.write({ id: saved.id, kind: 'om-series-applied', expected: 0, value: saved.value }); alone.restart();
  refusedWith(readDiscardedSeriesTransition(alone.store, { project, record: reference(saved) }), 'record_foreign');
  assert.deepEqual(ok(readDiscardedSeriesTransition(f.store, { project, record: reference(saved) })), saved);
});

test('B3 two Stores race the same discarded address without another write or series mutation', t => {
  const f = fixture(t); f.series(); const pair = refusedPair(f), other = new Store(f.path); t.after(() => other.close());
  const prepared = ok(prepareSeriesDiscard(f.store, pair.request)), before = snapshot(f.store);
  assert.deepEqual(snapshot(f.store), before);
  const won = ok(writeSeriesDiscard(other, pair.request)), afterRival = snapshot(f.store);
  assert.deepEqual(afterRival.filter(row => row.head.id !== won.record.id), before);
  refusedWith(commit(f.store, prepared), 'revision_conflict');
  assert.deepEqual(snapshot(f.store), afterRival); assert.equal(f.store.history(won.record.id).length, 1);
  f.restart();
  assert.deepEqual(ok(writeSeriesDiscard(f.store, pair.request)), won);
  assert.deepEqual(snapshot(f.store), afterRival);
});

function acceptBoundB3Frame(store: Store, frame: FrameRequest, binding: FrameAttemptBinding): AcceptedFrameRequest {
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: frame.frame }, level: 2,
    source: 'decision', status: 'proposed', nodes: [], fills: [], localConnectors: [], artifacts: [], contracts: [],
    joins: [], anchors: [], tests: [], edges: [], journeys: [], packets: [], transfers: [],
    removes: [], replaces: [], redefines: [] };
  const offered = store.write({ id: `om-proposal:${project}:B3-bound-return`, kind: 'layer-proposal', expected: 0, value: proposal });
  const produced = ok(writeCandidate(store, { frame, proposals: [reference(offered)] }));
  assert.equal(produced.state, 'candidate');
  if (produced.state !== 'candidate') assert.fail('A real C3 candidate is required');
  const candidate = reference(produced.record), accepted = ok(settleCandidate(store, { project, level: 2, candidate, binding,
    outcome: { gate: 'G3', candidate, graphHash: produced.record.value.graphHash, passed: true, codes: [] } }));
  assert.ok(accepted.graph && accepted.layer && accepted.frame);
  return { project, level: 2, graph: reference(accepted.graph), layer: reference(accepted.layer), frame: reference(accepted.frame) };
}

/** Run the genuine L3→M8 route on top of the fixture's accepted L2 so real artifact receipts exist. */
async function executeForReceipts(f: OmPreparedFixture, upperFrame: Ref): Promise<void> {
  const store = f.store, engine = f.engine;
  const head = () => reference(store.get<Graph>(`graph:${project}`)!);
  const desired = gardenGraph(), proposal = (frame: FrameRead): Ref => {
    const graph = structuredClone(desired), level = frame.request.level;
    if (level === 3) {
      for (const field of ["nodes", "artifacts", "contracts", "anchors", "joins", "tests", "edges", "journeys", "packets", "transfers"] as const) {
        const upper = frame.upper[field] ?? [], ids = new Set(upper.map((item: { id: string }) => item.id));
        Object.assign(graph, { [field]: [...structuredClone(upper), ...(graph[field] ?? []).filter(item => !ids.has(item.id))] });
      }
      graph.connectors = frame.upper.connectors.map((upper: Graph["connectors"][number]) => ({ ...structuredClone(upper),
        wakeTest: desired.connectors.find(connector => connector.id === upper.id)?.wakeTest ?? upper.wakeTest, bindings: [...structuredClone(upper.bindings),
        ...(desired.connectors.find(connector => connector.id === upper.id)?.bindings ?? []).filter(binding => binding.level === 3)] }));
    }
    const projected = projectGraph(graph, level);
    const mapped = ok(fillObligations(frame.upper, frame.scope,
      { graph, reference: { ...frame.request.graph, hash: hashJson(graph) }, frame: null }, frame.upperRef, level));
    const nodes = projected.nodes.filter(node => node.kind === (level === 2 ? "operation" : "work")
      && (level === 2 || frame.scope.nodes.includes(node.parent!))), selected = new Set(nodes.map(node => node.id));
    const value: LayerProposal = { base: { graph: frame.request.graph, frame: null }, level,
      ...(level === 3 ? { worksContract: "works-frame/v1" as const } : {}), source: "decision", status: "proposed", nodes,
      fills: mapped.fills.filter(fill => selected.has(fill.node)).map(fill => ({ obligation: fill.obligation, node: fill.node,
        ...(fill.port === undefined ? {} : { port: fill.port,
          ...(level === 3 ? { codeRef: structuredClone(nodes.find(node => node.id === fill.node)!.code[0]!) } : {}) }) })),
      localConnectors: level === 3 ? [] : projected.connectors.map(connector => ({ ...connector,
        bindings: connector.bindings.filter(binding => binding.level === 2) })).filter(connector => connector.bindings.length),
      artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
      tests: projected.tests.filter(test => level === 2 || selected.has(test.node)), edges: projected.edges ?? [],
      journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
      anchors: level === 2 ? projected.anchors : [], removes: [], replaces: [], redefines: [] };
    return reference(store.write({ id: `om-proposal:${project}:B3-executed-${level}`, kind: "layer-proposal", expected: 0, value }));
  };
  const input0 = store.get(`om-input:${project}`)!;
  const decisions: InputDecisionProposal["decision"][] = [
    { target: `${project}-B1`, field: "nodes", value: [`${project}-produce-block`, `${project}-consume-block`] },
    { target: `${project}-B1`, field: "state", value: { writer: `${project}-produce-block`, authority: `${project}-consume-block`, rollback: `${project}-consume-block` } },
    { target: `${project}-R1#1`, field: "checkKind", value: "test" },
  ];
  const input = ok(writeAddressing(store, { project, input: reference(input0), graph: head(),
    decisions: decisions.map(decision => ({ pending: inputDecisionWrite({ project, input: reference(input0), graph: head(), layers: [], decision }) as Write })) }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: head(),
    refinement: reference(store.get(`graph-layer:${project}:2`)!), available: {},
    choice: { choiceVersion: "B3-executed-works", features: [{ outcome: `${project}-result` }], excluded: [] } }));
  const frame3: FrameRequest = { project, level: 3, graph: head(), horizon: reference(horizon.gate), layer: null, frame: null,
    upper: { horizon: reference(horizon.gate), frame: upperFrame } };
  const works: ProposalRequest = { frame: frame3, proposals: [proposal(structuredClone(ok(prepareFrame(store, frame3))) as unknown as FrameRead)] };
  const operations: ProposalRequest = { frame: { project, level: 2, graph: frame3.graph, horizon: reference(horizon.gate),
      layer: reference(store.get(`graph-layer:${project}:2`)!), frame: upperFrame, upper: null }, proposals: [] };
  acceptNativeWorks(engine, project, operations, works);
  const plan = engine.compiler.compile(project);
  const compilation = engine.compiler.publish(project, reference(plan), 0);
  engine.pipeline.accept(project, "compilation", compilation.revision);
  const runs = await engine.executor.run(project, reference(plan), { retry: false, maxContextChars: 200_000, maxCorrections: 0 });
  assert.equal(runs.length, plan.value.tasks.length);
  assert.ok(plan.value.tasks.every(task => runs.some(run => run.value.taskId === task.id && run.value.state === "committed")));
}

test('B3 real managed A to B to A creates successors but never rediscovers the original accepted result', async t => {
  const f = await createOmFixture(t, 'standard', project, { mode: 'n2' }); let store = f.store;
  const input = store.get(`om-input:${project}`)!;
  ok(openSeries(store, { project, block, line: 1, slice: opaqueSlice, predecessor: null, basis: null }));
  const frame2 = store.get<OmAcceptedFrame>(`om-frame:${project}:2`)!;
  const l2Graph = reference(f.graphRevision);
  const firstHorizon = ok(writeHorizon(store, { project, input: reference(input), graph: l2Graph,
    refinement: reference(f.layers[2]), available: {}, choice: { choiceVersion: 'return-bootstrap', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const bootstrapPair = appliedPair(f, reference(firstHorizon.gate), 'return-bootstrap');
  const bootstrap = ok(applySeriesActivation(store, bootstrapPair));
  const standing = bootstrap.series.find(row => row.value.block === block)!;
  const frame: FrameRequest = { project, level: 2, graph: l2Graph, horizon: reference(firstHorizon.gate),
    layer: reference(f.layers[2]), frame: reference(frame2), upper: null };
  const frameRead = ok(prepareFrame(store, frame));
  const obligations = frameRead.result.obligations.filter(row => row.upper.node === block).map(row => row.id).sort();
  assert.ok(obligations.length);
  const goal = { key: 'B3-return-original-accepted-frame', questions: obligations.map(id => gapLineKey(project, id, 'fill')),
    result: 'accepted-gap-fill' };
  const begun = ok(beginAttempt(store, { project, block, line: standing.value.line, attempt: 1, goal }));
  const binding: FrameAttemptBinding = { series: reference(begun), ordinal: 1, obligations };
  const acceptance = acceptBoundB3Frame(store, frame, binding);
  assert.equal(ok(closeAttempt(store, { project, block, line: standing.value.line, attempt: 1,
    outcome: { reason: 'result', accepting: [acceptance.frame], cancelling: [], refusals: [] } })).verdict, 'progress');
  const achieved = store.get<RepairSeries>(standing.id)!;
  const achievedKeys = achieved.value.attempts[0]!.outcome!.achieved.map(item => item.key).sort();
  assert.ok(achievedKeys.length);

  await executeForReceipts(f, acceptance.frame);
  const graphHead = () => reference(store.get<Graph>(`graph:${project}`)!);
  const layer2 = () => reference(store.get<OmAcceptedFrame>(`graph-layer:${project}:2`)!);
  const producer = 'garden-produce-block',
    data = reference(store.get<ArtifactReceipt>(receiptId(project, 'garden-data'))!);
  const horizonFor = (name: string, ready: boolean) => ok(writeHorizon(store, { project, input: reference(store.get(`om-input:${project}`)!),
    graph: graphHead(), refinement: layer2(),
    available: ready ? { [producer]: { 'garden-data': data } } : {},
    choice: { choiceVersion: name, features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const a = horizonFor('return-A', false), pairA = appliedPair(f, reference(a.gate), 'return-A');
  const appliedA = ok(applySeriesActivation(store, pairA));
  const activeA = appliedA.series.find(row => row.value.block === block)!;
  const sliceA = ok(readPreparedSeriesTransition(store, { project, record: pairA.prepared })).record.value.decisions
    .find(row => row.block === block)!.slice!;
  assert.ok([...activeA.value.inherited, ...activeA.value.attempts]
    .some(item => item.outcome?.achieved.some(result => achievedKeys.includes(result.key))));

  const b = horizonFor('return-B', true), pairB = appliedPair(f, reference(b.gate), 'return-B');
  const appliedB = ok(applySeriesActivation(store, pairB));
  assert.equal(appliedB.record.value.decisions.find(row => row.block === block)!.outcome, 'new-work');
  const activeB = appliedB.series.find(row => row.value.block === block)!;
  assert.equal(activeB.value.line, activeA.value.line + 1);
  assert.deepEqual(activeB.value.predecessor, reference(activeA));
  assert.deepEqual(activeB.value.inherited, [...activeA.value.inherited, ...activeA.value.attempts]);
  const sliceB = ok(readPreparedSeriesTransition(store, { project, record: pairB.prepared })).record.value.decisions
    .find(row => row.block === block)!.slice!;
  assert.notDeepEqual(sliceB, sliceA);

  const returnedHorizon = horizonFor('return-A-again', false), pairReturn = appliedPair(f, reference(returnedHorizon.gate), 'return-A-again');
  const sliceReturn = ok(readPreparedSeriesTransition(store, { project, record: pairReturn.prepared })).record.value.decisions
    .find(row => row.block === block)!.slice!;
  assert.deepEqual(sliceReturn, sliceA, 'The same accepted graph and local readiness reconstruct A exactly');
  const appliedReturn = ok(applySeriesActivation(store, pairReturn));
  assert.equal(appliedReturn.record.value.decisions.find(row => row.block === block)!.outcome, 'new-work');
  const returned = appliedReturn.series.find(row => row.value.block === block)!;
  assert.equal(returned.value.line, activeA.value.line + 2);
  assert.equal(returned.value.slice, sliceA.hash);
  assert.deepEqual(returned.value.predecessor, reference(activeB));
  assert.deepEqual(returned.value.inherited, [...activeB.value.inherited, ...activeB.value.attempts]);
  assert.ok(returned.value.inherited.some(item => item.outcome?.achieved.some(result => achievedKeys.includes(result.key))));
  assert.equal(returned.value.withoutProgress, activeB.value.withoutProgress);
  assert.deepEqual(returned.value.ladder, activeB.value.ladder);
  assert.deepEqual(returned.value.stop, activeB.value.stop);
  const beforeRestart = snapshot(store); f.reopen(); store = f.store;
  for (const record of [activeA, activeB, returned]) assert.deepEqual(ok(readSeriesAt(store, project, reference(record))), record);
  assert.deepEqual(ok(prepareSeriesLineAdmission(store, project, reference(returned))).pointer, reference(appliedReturn.pointer));
  assert.deepEqual(ok(applySeriesActivation(store, pairReturn)).writes, []);
  assert.deepEqual(snapshot(store), beforeRestart);
});


test('29 H1.0b another block participation change is not a cause; the own exclusion is proved historically', async t => {
  const original = fixture(t); original.series(independent);
  const f = product(original), { request } = ready(f);
  f.steps([{ research: fact(f), usage }]);
  const model = ok(await runModelCall(f.store, request));
  assert.equal(model.outcome?.kind, 'fact-candidates');
  const intent = ok(writeAssessmentIntent(f.store, { project, modelCall: reference(model.record),
    questionId: f.batch.items[0]!.gap, dispatch: request.dispatch }));
  const input = { project, intent: reference(intent) };
  assert.equal(ok(prepareAssessmentSeriesTerminationCause(f.store, input)).cause, null);
  const continued = ok(applySeriesActivation(f.store, transition(f, 'h10b-neighbour-admitted',
    { features: [{ outcome: 'garden-result' }, { outcome: 'garden-later' }] }).request));
  assert.equal(continued.pointer.value.series.find(row => row.block === independent)!.participation, 'active');
  assert.equal(continued.pointer.value.series.find(row => row.block === block)!.participation, 'active');
  assert.equal(ok(prepareAssessmentSeriesTerminationCause(f.store, input)).cause, null);
  const excluded = exclude(f, 'h10b-exclusion');
  const checked = ok(prepareAssessmentSeriesTerminationCause(f.store, input));
  assert.ok(checked.cause); assert.equal(checked.cause.condition, 'active-participation');
  assert.deepEqual(checked.cause.change.currentPointer, reference(excluded.pointer));
  assert.deepEqual(ok(readAssessmentSeriesTerminationCause(f.store, { ...input, cause: checked.cause })), checked);
  refusedWith(readAssessmentSeriesTerminationCause(f.store, { ...input, cause: { ...checked.cause,
    change: { ...checked.cause.change, currentPointer: reference(continued.pointer) } } }), 'assessment_cause_unproved');
  activate(f, 'h10b-reactivation'); f.restart();
  assert.deepEqual(ok(readAssessmentSeriesTerminationCause(f.store, { ...input, cause: checked.cause })), checked);
  assert.equal(ok(prepareAssessmentSeriesTerminationCause(f.store, input)).cause, null);
  assert.equal(f.sent().length, 1);
});


test('25 H1.0b an excluded managed root closes before any E1, with historical null-ledger proof', async t => {
  const f = product(fixture(t), true, false);
  const series = ok(managedOpenAttempt(f.store, { project, block, line: 1, attempt: 1, goal: f.goal,
    completion: { routes: reference(f.routes), batches: [f.batch.id] } }));
  const binding = ok(readCompletionBinding(f.store, project, reference(series), 1))!;
  const work = ok(readCompletionWorkAt(f.store, project, reference(f.store.get(completionWorkId(project, binding.id))!)));
  const root = work.assignments.find(row => row.value.kind === 'root')!;
  exclude(f, 'h10b-root-excluded');
  const cessation = ok(writeCompletionCessation(f.store, { project, binding: reference(binding), assignment: reference(root) }));
  assert.equal(cessation.value.disposition, 'branch-ceased'); assert.equal(cessation.value.remainder, 'expansion');
  assert.equal(cessation.value.ledger, null); assert.equal(cessation.value.physicalId, null);
  const claim = { project, block, line: 1, attempt: 1, outcome: { reason: 'interrupted' as const, accepting: [], cancelling: [], refusals: [] } };
  await t.test('45 complete managed work does not authorize raw A3 or a caller force flag', () => {
    refusedWith(completeAttempt(f.store, { project, block, line: 1, attempt: 1,
      outcome: { reason: 'interrupted', achieved: [], cancelled: [], refusals: [] } }), 'completion_required');
  });
  const closed = ok(closeAttempt(f.store, claim));
  assert.equal(head(f).value.attempts[0]!.outcome!.reason, 'interrupted');
  const saved = snapshot(f.store); f.restart();
  await t.test('40 saved cessation close repeats after restart', () => { assert.deepEqual(ok(closeAttempt(f.store, claim)), closed); });
  assert.deepEqual(ok(readCompletionCessationAt(f.store, project, reference(cessation))), cessation);
  assert.deepEqual(snapshot(f.store), saved); assert.equal(f.sent().length, 0);
});

function managedProduct(t: TestContext, count = 1) {
  const f = product(fixture(t, true, count), true, false);
  const series = ok(managedOpenAttempt(f.store, { project, block, line: 1, attempt: 1, goal: f.goal,
    completion: { routes: reference(f.routes), batches: [f.batch.id] } }));
  f.running = series;
  f.packetRequest.attempt = { series: reference(series), ordinal: 1 };
  return f;
}
test('23 H1.0b standalone physical terminal passes through G7 without weakening raw A3 history', async t => {
  const f = product(fixture(t)), { request } = ready(f);
  await received(f, request); exclude(f);
  const runtime = ok(await runModelCall(f.store, request)).record;
  const claim = { project, block, line: 1, attempt: 1, terminal: reference(runtime),
    outcome: { reason: 'interrupted' as const, accepting: [], cancelling: [], refusals: [] } };
  const closed = ok(closeAttempt(f.store, claim));
  assert.deepEqual(head(f).value.attempts[0]!.terminal, reference(runtime));
  assert.equal(head(f).value.withoutProgress, 1);
  refusedWith(closeAttempt(f.store, { ...claim, outcome: { ...claim.outcome, reason: 'off-form' } }), 'outcome_conflict');
  f.restart(); const prior = snapshot(f.store);
  assert.deepEqual(ok(closeAttempt(f.store, claim)), closed);
  assert.deepEqual(snapshot(f.store), prior); assert.equal(f.sent().length, 1);
});
test('19 H1.0b paid ordinary receipt ceases application on exclusion without rewriting its physical evidence', async t => {
  const { runModelCycle } = await import('../src/om/model-call.js');
  const f = managedProduct(t), { request } = ready(f), receipt = await received(f, request);
  const before = f.store.history(receipt.id); exclude(f); f.restart();
  const denied = await runModelCall(f.store, request); assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.refusal.code, 'completion_ceased');
  const cessation = f.store.list('om-completion-cessation')[0]!;
  const checked = ok(readCompletionCessationAt(f.store, project, reference(cessation)));
  assert.equal(checked.value.remainder, 'application'); assert.deepEqual(checked.value.physical, reference(receipt));
  assert.deepEqual(checked.value.exchange, receipt.value.om.exchange); assert.equal(checked.value.rejection, null);
  assert.deepEqual(f.store.history(receipt.id), before);
  const binding = ok(readCompletionBinding(f.store, project, reference(f.running), 1))!;
  assert.equal(ok(readCompletionWorkAt(f.store, project, reference(f.store.get(completionWorkId(project, binding.id))!))).complete, true);
  const close = { project, block, line: 1, attempt: 1,
    outcome: { reason: 'interrupted' as const, accepting: [], cancelling: [], refusals: [] } };
  const closed = ok(closeAttempt(f.store, close));
  activate(f, 'restored-after-cessation'); f.restart(); const prior = snapshot(f.store);
  await t.test('27 reactivation retains the terminal application cessation', () => {
    assert.deepEqual(ok(readCompletionCessationAt(f.store, project, reference(cessation))).value, checked.value);
  });
  for (const result of [await runModelCall(f.store, request), await runModelCycle(f.store, request)]) {
    assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.refusal.code, 'completion_ceased'); assert.deepEqual(result.refusal.at.ref, reference(cessation)); }
  }
  assert.deepEqual(ok(closeAttempt(f.store, close)), closed);
  assert.deepEqual(snapshot(f.store), prior); assert.equal(f.store.list('om-model-cycle').length, 0); assert.equal(f.sent().length, 1);
});
test('14 H1.0b inactive composition preserves S N and a stopped application in one complete G7 result', async t => {
  const { assessFact, applyAssessmentResult, readAssessmentIntentAt, readAssessmentTerminalAt } = await import('../src/om/assessment.js');
  const { runModelTransport } = await import('../src/om/model-call.js');
  const f = managedProduct(t, 3), { request } = ready(f); assert.equal(f.batch.items.length, 3);
  const answer = { ...fact(f), results: f.batch.items.map(item => ({ ...fact(f).results[0]!, questionId: item.gap })) };
  f.steps([{ research: answer, usage }, { research: { verdict: 'supported', reasons: [] }, usage },
    { research: { verdict: 'conflicting', reasons: ['Contradictory original evidence'] }, usage },
    { research: { verdict: 'supported', reasons: [] }, usage }]);
  const model = ok(await runModelCall(f.store, request));
  const requests = f.batch.items.map(item => ({ project, modelCall: reference(model.record), questionId: item.gap, dispatch: request.dispatch }));
  const accepted = ok(await assessFact(f.store, requests[0]!)), negative = ok(await assessFact(f.store, requests[1]!));
  const intent = ok(writeAssessmentIntent(f.store, requests[2]!)), admission = ok(readAssessmentIntentAt(f.store, project, reference(intent)));
  const e1 = ok(recordCall(f.store, project, { call: admission.call, purpose: 'fact-assessment', basis: admission.basis, block: admission.block,
    gaps: admission.gaps, series: admission.series, attempt: admission.attempt, goal: admission.goal, dispatch: admission.dispatch, packet: admission.packet as Json }));
  const physical = ok(await runModelTransport(f.store, { project, call: reference(e1.call), packet: admission.packet as Json, role: 'reviewer' }));
  exclude(f, 'inactive-mixed');
  const stopped = ok(applyAssessmentResult(f.store, { project, intent: reference(intent), assessor: reference(physical.record) }));
  assert.equal(stopped.value.verdict, 'application-terminated');
  const binding = ok(readCompletionBinding(f.store, project, reference(f.running), 1))!;
  const work = ok(readCompletionWorkAt(f.store, project, reference(f.store.get(completionWorkId(project, binding.id))!)));
  assert.equal(work.complete, true); assert.equal(work.accepting.length, 1); assert.equal(work.refusals.length, 1);
  const claim = { project, block, line: 1, attempt: 1,
    outcome: { reason: 'result' as const, accepting: work.accepting, cancelling: [], refusals: work.refusals } };
  await t.test('15 existing N retains its exact A2 row in an inactive mixed outcome', () => {
    assert.ok(work.negative.some(ref => ref.id === negative.id)); assert.equal(work.refusals.length, 1);
  });
  await t.test('24 a technical contribution cannot erase neighbouring S and N', () => {
    refusedWith(closeAttempt(f.store, { ...claim, outcome: { reason: 'interrupted', accepting: [], cancelling: [], refusals: [] } }), 'completion_invalid');
  });
  await t.test('44 direct G7 cannot hide saved products behind empty claims', () => {
    refusedWith(closeAttempt(f.store, { ...claim, outcome: { ...claim.outcome, accepting: [], refusals: [] } }), 'completion_invalid');
  });
  const closed = ok(closeAttempt(f.store, claim)); const rows = [accepted, negative, stopped];
  assert.deepEqual(head(f).value.attempts[0]!.outcome!.achieved.map(x => x.basis), [accepted.value.accepted]);
  f.restart(); const prior = snapshot(f.store);
  for (const [i, row] of rows.entries()) await t.test(`41 local ${i} repeats the whole mixed outcome`, async () => {
    assert.deepEqual(ok(readAssessmentTerminalAt(f.store, project, reference(row))), row);
    assert.deepEqual(ok(await assessFact(f.store, requests[i]!)), row);
  });
  assert.deepEqual(ok(closeAttempt(f.store, claim)), closed);
  assert.deepEqual(snapshot(f.store), prior); assert.equal(f.sent().length, 4);
});

test('12 H1.0b physical assessor T is recorded on an inactive line by its own contract', async t => {
  const { applyAssessmentResult, readAssessmentIntentAt, assessFact } = await import('../src/om/assessment.js');
  const { runModelTransport } = await import('../src/om/model-call.js');
  for (const mode of ['off-form', 'interrupted', 'awaiting-owner'] as const) await t.test(mode === 'awaiting-owner' ? '13 awaiting-owner remains off-form' : `12 ${mode}`, async child => {
    const f = managedProduct(child), { request } = ready(f);
    f.steps([{ research: fact(f), usage }, { research: { verdict: mode, reasons: [] }, usage,
      ...(mode === 'interrupted' ? { exitCode: 1 } : {}) }]);
    const model = ok(await runModelCall(f.store, request));
    const asked = { project, modelCall: reference(model.record), questionId: f.batch.items[0]!.gap, dispatch: request.dispatch };
    const intent = ok(writeAssessmentIntent(f.store, asked)), admission = ok(readAssessmentIntentAt(f.store, project, reference(intent)));
    const e1 = ok(recordCall(f.store, project, { call: admission.call, purpose: 'fact-assessment', basis: admission.basis, block: admission.block,
      gaps: admission.gaps, series: admission.series, attempt: admission.attempt, goal: admission.goal, dispatch: admission.dispatch, packet: admission.packet as Json }));
    const physical = ok(await runModelTransport(f.store, { project, call: reference(e1.call), packet: admission.packet as Json, role: 'reviewer' }));
    exclude(f);
    const terminal = ok(applyAssessmentResult(f.store, { project, intent: reference(intent), assessor: reference(physical.record) }));
    const reason = mode === 'interrupted' ? 'interrupted' : 'off-form';
    assert.equal(terminal.value.verdict, reason); assert.equal(terminal.value.contract, 'om-assessment-result/v1');
    assert.equal(head(f).value.attempts[0]!.outcome, null);
    const close = { project, block, line: 1, attempt: 1, outcome: { reason, accepting: [], cancelling: [], refusals: [] } } as const;
    const closed = ok(closeAttempt(f.store, close)); f.restart(); const prior = snapshot(f.store);
    assert.deepEqual(ok(await assessFact(f.store, asked)), terminal); assert.deepEqual(ok(closeAttempt(f.store, close)), closed);
    assert.deepEqual(snapshot(f.store), prior); assert.equal(f.sent().length, 2);
  });
});

async function inactivePhysicalRecovery(t: TestContext, paid: boolean) {
  const { prepareCompletionCessation } = await import('../src/om/model-call.js');
  const f = managedProduct(t), { request } = ready(f), checkpoint = join(f.root, 'managed-claimed.json');
  f.steps([{ research: fact(f), usage }]);
  const spec = join(f.root, 'managed-driver.json');
  writeFileSync(spec, JSON.stringify({ database: f.path, output: join(f.root, 'driver-out.json'), operation: 'call', request,
    checkpoint: paid ? { path: checkpoint, kind: 'om-model-exchange', matches: [], when: 'before' }
      : { path: checkpoint, kind: 'model-call', matches: [{ path: ['execution', 'phase'], value: 'claimed' }] } }));
  const child = spawn(process.execPath, [fixturePath, '--driver', spec], { cwd: f.root, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await driverCheckpoint(checkpoint, child);
  const checkpointData = JSON.parse(readFileSync(checkpoint, 'utf8')) as { writes: Write[] };
  const claimed = f.store.list<OmModelCall>('model-call')[0]!, owner = claimed.value.om.completionOwner!;
  exclude(f);
  await t.test('7 a claim keeps its assignment open while its owner is still alive', () => {
    assert.equal(f.store.list('om-completion-cessation').length, 0);
    assert.equal(ok(readCompletionWorkAt(f.store, project, reference(f.store.get(completionWorkId(project, owner.binding.id))!))).complete, false);
  });
  const cannot = prepareCompletionCessation(f.store, { project, binding: owner.binding, assignment: owner.assignment });
  assert.equal(cannot.ok, false); if (!cannot.ok) assert.equal(cannot.refusal.code, 'completion_claim_exists');
  assert.equal(ok(readCompletionWorkAt(f.store, project, reference(f.store.get(completionWorkId(project, owner.binding.id))!))).complete, false);
  await t.test('26 inactive I cannot be closed by G7', () => {
    refusedWith(closeAttempt(f.store, { project, block, line: 1, attempt: 1,
      outcome: { reason: 'interrupted', accepting: [], cancelling: [], refusals: [] } }), 'completion_incomplete');
  });
  assert.equal(child.kill('SIGKILL'), true); await exited; f.restart();
  const recovered = f.engine.execute({ type: 'recover-model-call', project, call: reference(claimed) }) as Revision<OmModelCall>;
  await t.test('9 recovery preserves interrupted with unmeasured expenditure', () => {
    assert.equal(recovered.value.usage, null); assert.ok(recovered.value.recovery);
  });
  assert.equal(recovered.value.om.application, 'recovered'); assert.equal(recovered.value.usage, null);
  const work = ok(readCompletionWorkAt(f.store, project, reference(f.store.get(completionWorkId(project, owner.binding.id))!)));
  assert.equal(work.complete, true); assert.ok(work.products.some(ref => canonical(ref) === canonical(reference(recovered))));
  const close = { project, block, line: 1, attempt: 1,
    outcome: { reason: 'interrupted' as const, accepting: [], cancelling: [], refusals: work.refusals } };
  const closed = ok(closeAttempt(f.store, close));
  if (paid) {
    const { prepareLateModelReceipt } = await import('../src/discovery/model-call-recovery.js');
    const evidence = checkpointData.writes.find(row => row.kind === 'om-model-exchange')!.value as unknown as
      { process: import('../src/runtime/process.js').ProcessResult; launchError: null };
    const priorSeries = f.store.get(f.running.id), priorWork = f.store.get(work.work.id);
    const late = prepareLateModelReceipt(f.store, project, reference(claimed), { process: evidence.process, launchError: evidence.launchError });
    ok(writeGuarded(f.store, { unit: 'E4', target: late.record.id, writes: late.writes, guards: late.guards }));
    f.restart(); ok(await runModelCall(f.store, request));
    assert.deepEqual(f.store.get(f.running.id), priorSeries); assert.deepEqual(f.store.get(work.work.id), priorWork);
    assert.deepEqual(f.store.get(recovered.id), recovered);
    const e1 = ok(readCall(f.store, project, reference(f.store.get(recovered.value.om.call.id)!)));
    assert.deepEqual(e1.value.usage, usage); assert.equal(f.store.list('model-late-receipt').length, 1);
  }
  f.restart(); const before = snapshot(f.store);
  assert.deepEqual((ok(await runModelCall(f.store, request))).record, recovered);
  assert.deepEqual(ok(closeAttempt(f.store, close)), closed); assert.deepEqual(snapshot(f.store), before);
  assert.equal(f.sent().length, paid ? 1 : 0);
}

test('8 H1.0b real unreceived claim survives exclusion as I until atomic physical recovery and completion', t => inactivePhysicalRecovery(t, false));
test('38 H1.0b exact late paid receipt after inactive recovery and G7 never reopens work', t => inactivePhysicalRecovery(t, true));

test('28 H1.0b completion-only rejects missing current admission and altered attempt membership', { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const { prepareCompletionAdmission } = await import('../src/om/series.js');
  const f = managedProduct(t), binding = ok(readCompletionBinding(f.store, project, reference(f.running), 1))!;
  exclude(f);
  assert.equal(prepareCompletionAdmission(f.store, project, reference(binding)).ok, true);
  for (const field of ['pointer', 'ordinal', 'goal', 'kind']) await t.test(field, () => {
    const original = f.store.get(f.running.id)!;
    const body = structuredClone(original.value) as unknown as { attempts: { ordinal: number; goal: { key: string } }[] };
    if (field === 'ordinal') body.attempts[0]!.ordinal++;
    if (field === 'goal') body.attempts[0]!.goal.key = 'foreign';
    const altered = { ...original, value: body, hash: hashJson(body), ...(field === 'kind' ? { kind: 'foreign' } : {}) };
    const view = new Proxy(f.store, { get(target, property) {
      if (property === 'get') return (id: string, revision?: number) => {
        if (field === 'pointer' && id === seriesCurrentId(project) && !revision) return null;
        if (field !== 'pointer' && id === original.id && (!revision || revision === original.revision)) return altered;
        return target.get(id, revision);
      };
      const v: unknown = Reflect.get(target, property, target); return typeof v === 'function' ? v.bind(target) : v;
    } });
    refusedWith(prepareCompletionAdmission(view, project, reference(binding)), field === 'kind' ? 'record_foreign' : 'series_invalid');
  });
  assert.equal(f.sent().length, 0);
});


test('35 H1.0b root cessation retains all unchosen E2 candidates and defeats a pending materialization', async t => {
  const f = managedProduct(t), first = ready(f);
  const { projectId: _project, ...config } = structuredClone(f.environment.value);
  const changed = f.engine.environments.configure(project, { ...config, requestCapacityChars: 90_000 }, f.environment.revision);
  const alternate = { ...f.packetRequest, environment: reference(changed) };
  const second = ok(writeQuestionPacket(f.store, alternate)).record;
  const anotherConfig = f.engine.environments.configure(project, { ...config, requestCapacityChars: 80_000 }, changed.revision);
  const pending = ok(prepareQuestionPacket(f.store, { ...alternate, environment: reference(anotherConfig) }));
  const binding = ok(readCompletionBinding(f.store, project, reference(f.running), 1))!;
  const before = ok(readCompletionWorkAt(f.store, project, reference(f.store.get(completionWorkId(project, binding.id))!)));
  assert.equal(before.assignments.length, 1); assert.equal(before.complete, false);
  exclude(f, 'root-with-candidates');
  const root = before.assignments[0]!;
  const ceased = ok(writeCompletionCessation(f.store, { project, binding: reference(binding), assignment: reference(root) }));
  assert.equal(ceased.value.remainder, 'expansion'); assert.equal(ceased.value.ledger, null);
  refusedWith(commit(f.store, pending), 'input_stale');
  assert.equal(f.store.list('om-completion-packet').length, 2); assert.equal(f.store.list('call-record').length, 0);
  const after = ok(readCompletionWorkAt(f.store, project, reference(f.store.get(completionWorkId(project, binding.id))!)));
  assert.equal(after.complete, true); assert.equal(after.assignments.length, 1);
  ok(closeAttempt(f.store, { project, block, line: 1, attempt: 1,
    outcome: { reason: 'interrupted', accepting: [], cancelling: [], refusals: [] } }));
  f.restart(); const history = snapshot(f.store);
  assert.deepEqual(ok(writeQuestionPacket(f.store, f.packetRequest)).record, first.packet);
  assert.deepEqual(ok(writeQuestionPacket(f.store, alternate)).record, second);
  refusedWith(await runModelCall(f.store, first.request), 'series_conflict');
  assert.deepEqual(ok(readCompletionCessationAt(f.store, project, reference(ceased))), ceased);
  assert.deepEqual(snapshot(f.store), history); assert.equal(f.sent().length, 0);
});

test("Q4 №2563-1/-3: membership capture and current admission select the project's own series by a prefix identity read — a foreign project's corrupt line is never decoded; an opaque view keeps its own complete walk", t => {
  const f = product(fixture(t));
  const admitted = head(f);
  const reads: [string, string, string | null][] = [];
  const watcher: StoreObserver = { begin: () => ({}), write: () => {}, untraced: () => {},
    end: (_token, _source, method, mode, id) => { reads.push([method, mode, id ?? null]); } };
  // First through an opaque view: the membership capture keeps its complete traversal — a capture's list reaches the Store as a list.
  const view = captureView(f.store, { rows: new Map() }).view;
  const previous = observeStore(watcher);
  try {
    ok(readSeriesMembership(view, { project }));
    assert.ok(reads.some(row => row[0] === 'list' && row[2] === 'repair-series'), "An opaque view keeps the whole-kind walk");
    assert.ok(!reads.some(row => row[0] === 'identities'), "No identity selection runs under an unproven view");
    ok(prepareSeriesLineAdmission(view, project, reference(admitted)));
    reads.length = 0;
    // On the genuine Store the same admission and the membership read are prefix-selected.
    ok(prepareSeriesLineAdmission(f.store, project, reference(admitted)));
    ok(readSeriesMembership(f.store, { project }));
    assert.ok(reads.some(row => row[0] === 'identities' && row[1] === 'prefix' && row[2] === `repair-series:${project}:`),
      "The project's own lines come from the indexed prefix range");
    assert.ok(!reads.some(row => row[0] === 'list'), "No kind list is read on the proven Store");
  } finally { observeStore(previous); }
  // A foreign project's corrupt line is outside the prefix: it is never decoded and never blocks admission.
  f.store.write({ id: 'repair-series:foreign:masquerade', kind: 'repair-series', expected: 0, value: { projectId: 'foreign' } });
  const database = new DatabaseSync(f.store.path);
  try {
    database.exec('DROP TRIGGER IF EXISTS revisions_no_update');
    database.prepare('UPDATE revisions SET body=? WHERE entity_id=?').run('null', 'repair-series:foreign:masquerade');
  } finally { database.close(); }
  ok(prepareSeriesLineAdmission(f.store, project, reference(admitted)));
  const membership = readSeriesMembership(f.store, { project });
  assert.ok(membership.ok, `Foreign corruption stays unread: ${membership.ok ? 'ok' : membership.refusal.code}`);
});

test("Q4-F1 (поправка к таблице C, решение оркестратора): on the legacy/absent-membership branch admission keeps captureMembership — a nonzero walk that never leaves repair-series:<project>:, so a foreign project's corrupt line cannot interfere", t => {
  const f = fixture(t);
  f.series();
  const admitted = head(f);
  // A foreign project's corrupt line waits outside the project's range before the admission runs.
  f.store.write({ id: 'repair-series:foreign:f1', kind: 'repair-series', expected: 0, value: { projectId: 'foreign' } });
  const database = new DatabaseSync(f.store.path);
  try {
    database.exec('DROP TRIGGER IF EXISTS revisions_no_update');
    database.prepare('UPDATE revisions SET body=? WHERE entity_id=?').run('null', 'repair-series:foreign:f1');
  } finally { database.close(); }
  const reads: [string, string, string | null][] = [];
  const watcher: StoreObserver = { begin: () => ({}), write: () => {}, untraced: () => {},
    end: (_token, _source, method, mode, id) => { reads.push([method, mode, id ?? null]); } };
  const previous = observeStore(watcher);
  try {
    const admission = ok(prepareSeriesLineAdmission(f.store, project, reference(admitted)));
    assert.equal(admission.participation, 'legacy', 'No membership and no managed marks admit the legacy line');
    const prefix = `repair-series:${project}:`;
    assert.ok(reads.length > 0, 'Table C as amended: legacy absence is decided BY the bounded walk, not without one');
    assert.ok(reads.some(row => row[0] === 'identities' && row[1] === 'prefix' && row[2] === prefix),
      "The project's own lines are enumerated through the indexed prefix range");
    for (const [method, , id] of reads)
      assert.ok(id === null || !id.startsWith('repair-series:') || id.startsWith(prefix),
        `${method} ${id}: no series read leaves the project's own range`);
    assert.ok(!reads.some(row => row[0] === 'get' && row[2] === 'repair-series:foreign:f1'),
      'The corrupt foreign line is never decoded');
    assert.ok(!reads.some(row => row[0] === 'list'), 'No whole-kind list is read on the proven Store');
  } finally { observeStore(previous); }
});

test("Q4-F1 (таблица C): a managed line whose project lost its membership record keeps the previous refusal on the same entrance", t => {
  const f = product(fixture(t));
  const admitted = head(f);
  erase(f.store, seriesMembershipId(project));
  // The exact basis walks before the capture: the activation's applied record names the lost membership,
  // so the same entrance answers with the same previous refusal as on the base.
  // NR1: the activation is read as written; the admission itself finds the managed project without its membership source.
  refusedWith(prepareSeriesLineAdmission(f.store, project, reference(admitted)), 'series_invalid');
});

test("Q4-F5 (№2568-2): a late corrupt revision named by the exact basis refuses admission; the same revision left unnamed is never read", { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, t => {
  const f = product(fixture(t));
  const admitted = head(f);
  const pointer = f.store.get(seriesCurrentId(project))!;
  const applied = (pointer.value as unknown as { applied: Ref }).applied;
  const appliedHead = f.store.get(applied.id)!;
  // A later revision of the applied record: written lawfully, then corrupted in place — the pointer still names rev 1.
  const late = f.store.write({ id: applied.id, kind: appliedHead.kind, expected: appliedHead.revision,
    value: { ...appliedHead.value as object } });
  const database = new DatabaseSync(f.store.path);
  try {
    database.exec('DROP TRIGGER IF EXISTS revisions_no_update');
    database.prepare('UPDATE revisions SET body=? WHERE entity_id=? AND revision=?').run('null', applied.id, late.revision);
  } finally { database.close(); }
  ok(prepareSeriesLineAdmission(f.store, project, reference(admitted)));
  assert.ok('participation' in ok(prepareSeriesLineAdmission(f.store, project, reference(admitted))),
    'The unnamed late revision is outside the exact proof spine — it is never read');
  // Now the pointer names the corrupt revision: the same bytes, this time inside the proof basis.
  f.store.write({ id: pointer.id, kind: pointer.kind, expected: pointer.revision,
    value: { ...pointer.value as object, applied: { id: applied.id, revision: late.revision, hash: late.hash } } });
  const corrupt = (error: unknown) => error instanceof EngineError && error.code === 'record_corrupt';
  assert.throws(() => prepareSeriesLineAdmission(f.store, project, reference(admitted)), corrupt,
    'A basis naming the corrupt revision reads it and refuses');
});
