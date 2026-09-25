import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Environments } from '../src/runtime/environment.js';
import { Store, type TransactionGuard, type Write } from '../src/storage/store.js';
import { writeOmInput } from '../src/om/input.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeRoutes } from '../src/om/routes.js';
import { recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND, type OriginSource } from '../src/om/refusal-journal.js';
import { closeAttempt, type AnyOriginHold } from '../src/om/repeat-gate.js';
import { beginAttempt, openSeries, resumeSeries, escalateSeries, prepareSeriesAdmission, seriesAddress,
  type AnySeriesRequest, type AnyRepairSeries, type AttemptGoal, type MechanismAdmission } from '../src/om/series.js';
import { prepareStopAnalysis, runStopAnalysis, readStopAnalysis } from '../src/om/stop-analysis.js';
import { readStopReport } from '../src/om/stop-report.js';
import { recordCall, type AnyRecordCallRequest } from '../src/om/call-record.js';
import { runModelTransport } from '../src/om/model-call.js';
import type { OmResult } from '../src/om/refusal.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

type AnalysisRequest = Parameters<typeof prepareStopAnalysis>[1];
const providerPath = fileURLToPath(new URL('../../test/om-adapter-fixture.mjs', import.meta.url));
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
const owner = { kind: 'mechanism', mechanism: 'M5:addressing' } as const;
const ok = <T>(result: OmResult<T>): T => {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message} ${canonical(result.refusal.at)}`);
  return result.value;
};
function refusal(result: OmResult<unknown>, code?: string) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected an addressed refusal');
  if (code) assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target);
  return result.refusal;
}

function fixture(t: TestContext, mode: 'block' | 'mechanism' = 'block', origin = false, capacity = 200_000) {
  const root = mkdtempSync(join(tmpdir(), 'omg-a6-')), database = join(root, 'state.sqlite');
  let store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = 'analysis', scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [providerPath, '--scenario', scenario, '--trace', trace] };
  const environment = new Environments(store).configure(project, { workspace: root,
    implementer: { actor: 'analysis-author', model: 'local-author', effort: 'high', command },
    reviewer: { actor: 'independent-reviewer', model: 'local-reviewer', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: capacity }, 0);
  const adapter = store.write({ id: `adapter:${project}:analysis`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: project, protocol: 'codex-stdio' } });
  const address: AnySeriesRequest = mode === 'mechanism' ? { project, owner, line: 1 } : { project, block: 'analysis-block', line: 1 };
  let admission: MechanismAdmission | undefined;
  let goal: AttemptGoal = { key: 'prove-workspace', questions: ['Which declared workspace condition prevents this work?'],
    result: 'A checked workspace condition allowing the declared work' };
  if (mode === 'mechanism') {
    const engine = new ProductEngine(store), { level: _level, ...l1 } = projectGraph(gardenGraph('cross', project), 1);
    preparedFeatures(engine, project, l1 as Graph, field => {
      const value = preparedField(project, field);
      if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'encoding',
        question: 'Which output encoding is supported?', consumer: `${project}-consume-block`, moment: 'om-pass',
        blocksCurrentStage: false, resolution: 'Address this question before research' }];
      return value;
    });
    const input = ok(writeOmInput(store, { project, expected: 0,
      stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
    const graph = reference(store.get(`graph:${project}`)!);
    const horizon = ok(writeHorizon(store, { project, input: reference(input), graph, refinement: null, available: {},
      choice: { choiceVersion: 'analysis-fixture', features: [{ outcome: `${project}-result` }], excluded: [] } }));
    const sources: GapRequest = { project, input: reference(input), graph, horizon: reference(horizon.gate),
      operations: { proposals: [], frame: { project, level: 2, graph, horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
      works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
    const gaps = ok(writeGaps(store, sources)), scope = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
    const routes = ok(writeRoutes(store, { project, gaps: scope, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
    const batch = routes.value.batches.find(item => item.task === 'input-field'
      && item.items.some(member => member.target === 'discovery:encoding') && item.items.every(member => member.consumers.length === 0));
    assert.ok(batch);
    admission = { gaps: scope, routes: reference(routes), batch: batch.id };
    ok(openSeries(store, { project, owner, line: 1, scope, predecessor: null, basis: null }));
    goal = { key: 'address-encoding', ...ok(prepareSeriesAdmission(store, { project, owner, line: 1 }, admission)).goal };
  } else ok(openSeries(store, { project, block: 'analysis-block', line: 1, slice: 'workspace-v1', predecessor: null, basis: null }));
  const originSources: OriginSource[] = [{ role: 'environment', ref: reference(environment) }];
  const source = store.write({ id: `${unitRefusalNamespace(project)}workspace`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: { gate: 'G6', refusals: [{ code: 'workspace_unavailable', goal: goal.key, remedy: 'Observe the declared workspace condition',
      origin: { name: 'workspace_unavailable', stage: 'feasibility', subject: 'workspace', sources: origin ? [] : originSources } }] } });
  const journal = ok(recordRefusal(store, { project, source: reference(source) })), row = journal.value.rows[0]!;
  let hold: Ref | null = null;
  for (let attempt = 1; attempt <= (origin ? 1 : 3); attempt++) {
    if (mode === 'mechanism') ok(beginAttempt(store, { project, owner, line: 1, attempt, goal, admission: admission! }));
    else ok(beginAttempt(store, { project, block: 'analysis-block', line: 1, attempt, goal }));
    const closed = ok(closeAttempt(store, { ...address, attempt,
      outcome: { reason: 'refused', accepting: [], cancelling: [], refusals: [{ row: row.id, name: row.code, goal: row.goal }] } }));
    if (origin) { assert.equal(closed.holds.length, 1); hold = closed.holds[0]!; }
  }
  const series = store.get<AnyRepairSeries>(seriesAddress(address).id)!;
  assert.equal(series.value.stop?.attempt ?? null, origin ? null : 3);
  const request: AnalysisRequest = { project, series: reference(series), hold,
    dispatch: { config: reference(environment), adapter: reference(adapter) } };
  return { root, database, project, address, goal, admission, environment, adapter, series, request, originSources, journal: reference(journal),
    get store() { return store; },
    restart() { store.close(); store = new Store(database); },
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ steps })); },
    sent(): Array<{ model: string; prompt: string }> {
      return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    } };
}
type Fixture = ReturnType<typeof fixture>;
function answer(f: Fixture, over: Record<string, unknown> = {}) {
  return { protocol: 'omg-stop-analysis/v1',
    cause: { kind: 'hypothesis', text: 'The same unanswered workspace question is repeated without new observations.', sources: [] },
    change: { text: 'Obtain the addressed workspace observation before repeating this goal.', addresses: [{ ref: f.request.series, field: 'attempts' }] },
    origin: null, ...over };
}
function scenario(f: Fixture, research = answer(f)) { f.steps([{ research, usage }]); }
function seriesNow(f: Fixture) { return f.store.get<AnyRepairSeries>(f.series.id)!; }
function preserved(f: Fixture) {
  return canonical(f.store.list().filter(record => ['graph', 'environment', 'repair-series', 'om-refusal-journal', 'om-origin-hold'].includes(record.kind)));
}
function observeWrites(f: Fixture, observe: (writes: Write[], guards: TransactionGuard[]) => void) {
  const original = f.store.writeMany.bind(f.store);
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    observe(writes, guards); return original(writes, guards);
  }) as Store['writeMany'];
  return () => { f.store.writeMany = original; };
}
function forbidSourceHeads(f: Fixture, refs: readonly Ref[]) {
  const original = f.store.get.bind(f.store), fixed = new Set(refs.map(ref => ref.id));
  f.store.get = ((id: string, revision?: number) => {
    assert.ok(!fixed.has(id) || revision !== undefined, `Historical reading requested mutable head ${id}`);
    return original(id, revision);
  }) as Store['get'];
  return () => { f.store.get = original; };
}

test('A6 block analysis sends its bounded stop, records actual usage and replays historical success after resume and restart', async t => {
  const f = fixture(t);
  const foreign = 'unrelated-series-secret-that-must-not-be-sent';
  ok(openSeries(f.store, { project: f.project, block: foreign, line: 1, slice: foreign, predecessor: null, basis: null }));
  const beforePrepare = canonical(f.store.list()), prepared = ok(prepareStopAnalysis(f.store, f.request));
  assert.equal(canonical(f.store.list()), beforePrepare, 'Preparing the packet writes nothing');
  const packet = prepared.intent.packet as unknown as { sources: readonly Ref[]; report: unknown; goal: unknown; basis: unknown; form: unknown };
  assert.ok(packet.sources.some(ref => canonical(ref) === canonical(f.request.series)));
  assert.ok(packet.report && packet.goal && packet.basis && packet.form);
  assert.equal(canonical(packet).includes(foreign), false);
  const before = preserved(f); scenario(f);
  const result = ok(await runStopAnalysis(f.store, f.request));
  assert.equal(result.kind, 'om-stop-review'); assert.equal(result.value.state, 'decided'); assert.equal(result.value.error, null);
  assert.equal(preserved(f), before, 'A decided analysis changes no graph, environment, refusal, hold or series');
  assert.equal(f.sent().length, 1); assert.equal(f.sent()[0]!.model, 'local-reviewer');
  assert.deepEqual(JSON.parse(f.sent()[0]!.prompt), packet);
  assert.deepEqual(f.store.get<{ usage: unknown }>(result.value.transport.id, result.value.transport.revision)!.value.usage, usage);
  const continued = ok(resumeSeries(f.store, { ...f.address, stop: 3, ground: 'review-record', text: 'Apply this exact reviewed change', review: { ref: reference(result) } }));
  assert.equal(continued.value.stop, null);
  for (let attempt = 4; attempt <= 6; attempt++) {
    ok(beginAttempt(f.store, { project: f.project, block: 'analysis-block', line: 1, attempt, goal: f.goal }));
    ok(closeAttempt(f.store, { ...f.address, attempt, outcome: { reason: 'off-form', accepting: [], cancelling: [], refusals: [] } }));
  }
  assert.equal(seriesNow(f).value.stop!.attempt, 6);
  f.restart(); const later = canonical(f.store.list());
  const restore = forbidSourceHeads(f, prepared.intent.report.guards);
  try {
    assert.deepEqual(ok(readStopReport(f.store, { project: f.project, sources: prepared.intent.sources })), prepared.intent.report);
    assert.deepEqual(ok(readStopAnalysis(f.store, { project: f.project, record: reference(result) })), result);
    assert.deepEqual(ok(await runStopAnalysis(f.store, f.request)), result);
  } finally { restore(); }
  assert.equal(canonical(f.store.list()), later); assert.equal(f.sent().length, 1);
});

test('A6 mechanism stop uses its real saved admission and an independent reviewer without another attempt', async t => {
  const f = fixture(t, 'mechanism'), before = preserved(f); scenario(f);
  const result = ok(await runStopAnalysis(f.store, f.request));
  assert.equal(result.value.state, 'decided'); assert.equal(preserved(f), before);
  const call = f.store.list<{ owner: unknown; purpose: string; attempt: number }>('call-record')[0]!;
  assert.deepEqual(call.value.owner, owner); assert.equal(call.value.purpose, 'stop-analysis'); assert.equal(call.value.attempt, 3);
  assert.equal(f.sent().length, 1);
  const resumed = ok(resumeSeries(f.store, { ...f.address, stop: 3, ground: 'review-record', text: 'Change the mechanism question', review: { ref: reference(result) } }));
  assert.equal(resumed.value.stop, null);
  f.restart(); assert.deepEqual(ok(await runStopAnalysis(f.store, f.request)), result); assert.equal(f.sent().length, 1);
});

test('A6 explicit undecided review and its owner escalation are saved in one transaction', async t => {
  const f = fixture(t); scenario(f, answer(f, { cause: null }));
  let atomic = false;
  const restore = observeWrites(f, writes => {
    if (writes.some(write => write.kind === 'om-stop-review')) {
      assert.ok(writes.some(write => write.id === f.series.id), 'The undecided review and escalation share one writeMany'); atomic = true;
    }
  });
  let result;
  try { result = ok(await runStopAnalysis(f.store, f.request)); } finally { restore(); }
  assert.equal(result.value.state, 'undecided'); assert.equal(atomic, true);
  assert.equal(seriesNow(f).value.stop!.attempt, 3); assert.equal(seriesNow(f).value.ladder.rung, 2);
  assert.deepEqual(seriesNow(f).value.escalations.map(item => item.review), [reference(result)]);
  f.restart(); const before = canonical(f.store.list());
  assert.deepEqual(ok(await runStopAnalysis(f.store, f.request)), result);
  assert.equal(canonical(f.store.list()), before); assert.equal(f.sent().length, 1);
});

for (const failure of ['off-form', 'transport'] as const) test(`A6 ${failure} preserves the stop and actual usage without a usable review or another send`, async t => {
  const f = fixture(t), before = preserved(f);
  f.steps([failure === 'off-form' ? { research: { protocol: 'omg-stop-analysis/v1', cause: null }, usage }
    : { research: answer(f), usage, exitCode: 7, stderr: 'The local fixture stopped before completing the analysis.' }]);
  const result = ok(await runStopAnalysis(f.store, f.request));
  assert.equal(result.kind, 'om-stop-analysis-failure'); assert.equal(result.value.state, 'failed'); assert.ok(result.value.error);
  if (failure === 'off-form') assert.equal(result.value.error.code, 'analysis_response_invalid');
  assert.equal(preserved(f), before); assert.equal(f.sent().length, 1);
  assert.deepEqual(f.store.get<{ usage: unknown }>(result.value.transport.id, result.value.transport.revision)!.value.usage, usage);
  refusal(resumeSeries(f.store, { ...f.address, stop: 3, ground: 'review-record', text: 'A failure is not a reviewed change', review: { ref: reference(result) } }));
  refusal(escalateSeries(f.store, { ...f.address, stop: 3, review: { ref: reference(result) } }));
  f.restart(); const saved = canonical(f.store.list());
  assert.deepEqual(ok(await runStopAnalysis(f.store, f.request)), result);
  assert.equal(canonical(f.store.list()), saved); assert.equal(f.sent().length, 1);
  if (failure === 'off-form') {
    const changed = new Environments(f.store).configure(f.project, { ...f.environment.value,
      reviewer: { ...f.environment.value.reviewer, model: 'another-local-reviewer' } }, f.environment.revision);
    const current = canonical(f.store.list());
    refusal(await runStopAnalysis(f.store, { ...f.request, dispatch: { ...f.request.dispatch, config: reference(changed) } }), 'analysis_conflict');
    assert.equal(canonical(f.store.list()), current); assert.equal(f.sent().length, 1);
  }
});

for (const part of ['evidence', 'change'] as const) test(`A6 a ${part} outside the bounded packet is recorded as failure, never a usable ground`, async t => {
  const f = fixture(t);
  const foreign = ok(openSeries(f.store, { project: f.project, block: 'outside-the-stop', line: 1,
    slice: 'unrelated-slice', predecessor: null, basis: null }));
  const outside = reference(foreign), before = preserved(f);
  scenario(f, answer(f, part === 'evidence'
    ? { cause: { kind: 'evidence', text: 'This unrelated series allegedly explains the refusal.', sources: [outside] } }
    : { change: { text: 'Change this unrelated series.', addresses: [{ ref: outside, field: 'attempts' }] } }));
  const result = ok(await runStopAnalysis(f.store, f.request));
  assert.equal(result.kind, 'om-stop-analysis-failure'); assert.equal(result.value.error?.code, 'analysis_response_invalid');
  assert.equal(preserved(f), before); assert.equal(f.sent().length, 1);
  refusal(resumeSeries(f.store, { ...f.address, stop: 3, ground: 'review-record', text: 'An unrelated claim cannot resume this stop',
    review: { ref: reference(result) } }));
});

test('A6 rejects identical reviewer and implementer identities before E1 or sending', async t => {
  const f = fixture(t), value = f.environment.value;
  const imitation = f.store.write({ id: f.environment.id, kind: f.environment.kind, expected: f.environment.revision,
    value: { ...value, reviewer: { ...value.reviewer, actor: value.implementer.actor } } });
  const request = { ...f.request, dispatch: { ...f.request.dispatch, config: reference(imitation) } };
  const before = canonical(f.store.list());
  refusal(await runStopAnalysis(f.store, request), 'assessor_not_independent');
  assert.equal(canonical(f.store.list()), before); assert.equal(f.sent().length, 0);
});

test('A6 checks the actual reviewer wire against V1 before recording or sending a call', async t => {
  const f = fixture(t, 'block', false, 200_000), value = f.environment.value;
  const large = new Environments(f.store).configure(f.project, { ...value,
    reviewer: { ...value.reviewer, model: 'm'.repeat(200_000) } }, f.environment.revision);
  const request = { ...f.request, dispatch: { ...f.request.dispatch, config: reference(large) } };
  const before = canonical(f.store.list());
  refusal(await runStopAnalysis(f.store, request), 'context_too_large');
  assert.equal(canonical(f.store.list()), before); assert.equal(f.sent().length, 0);
});

test('A6 an environment without its required request capacity fails before E1 or provider dispatch', async t => {
  const f = fixture(t), { requestCapacityChars: _capacity, ...legacy } = f.environment.value;
  const missing = new Environments(f.store).configure(f.project, legacy, f.environment.revision);
  const before = canonical(f.store.list());
  refusal(await runStopAnalysis(f.store, { ...f.request, dispatch: { ...f.request.dispatch, config: reference(missing) } }));
  assert.equal(canonical(f.store.list()), before); assert.equal(f.sent().length, 0);
});

for (const mode of ['block', 'mechanism'] as const) test(`A6 ${mode} origin analysis atomically records its grounds and lets G7 establish and lift the held class`, async t => {
  const f = fixture(t, mode, true), before = reference(seriesNow(f));
  const prepared = ok(prepareStopAnalysis(f.store, f.request));
  const journal = f.store.list('om-refusal-journal');
  scenario(f, answer(f, { cause: { kind: 'evidence', text: 'This refusal concerns the saved environment.', sources: [reference(f.environment)] },
    origin: { class: 'conditions', basis: f.originSources } }));
  let atomic = false;
  const restore = observeWrites(f, writes => {
    if (writes.some(write => write.kind === 'om-origin-analysis')) {
      assert.ok(writes.some(write => write.id === f.request.hold!.id));
      atomic = true;
    }
  });
  let result;
  try { result = ok(await runStopAnalysis(f.store, f.request)); } finally { restore(); }
  assert.equal(result.value.state, 'origin-established'); assert.equal(atomic, true);
  const hold = f.store.get<AnyOriginHold>(f.request.hold!.id)!;
  assert.equal(hold.value.lift!.class, 'conditions'); assert.deepEqual(hold.value.lift!.record, reference(result));
  assert.deepEqual(reference(seriesNow(f)), before);
  assert.deepEqual(f.store.list('om-refusal-journal'), journal);
  f.restart(); const restoreHeads = forbidSourceHeads(f, prepared.intent.report.guards);
  try {
    assert.deepEqual(ok(readStopReport(f.store, { project: f.project, sources: prepared.intent.sources })), prepared.intent.report);
    assert.deepEqual(ok(readStopAnalysis(f.store, { project: f.project, record: reference(result) })), result);
    assert.deepEqual(ok(await runStopAnalysis(f.store, f.request)), result);
  } finally { restoreHeads(); }
  assert.equal(f.sent().length, 1);
});

test('A6 unestablished origin records the known outcome without lifting a hold or inventing a series stop', async t => {
  const f = fixture(t, 'block', true), before = preserved(f); scenario(f, answer(f, { cause: null, change: null, origin: null }));
  const result = ok(await runStopAnalysis(f.store, f.request));
  assert.equal(result.value.state, 'origin-unestablished'); assert.equal(preserved(f), before);
  assert.equal(seriesNow(f).value.stop, null); assert.equal(f.store.get<AnyOriginHold>(f.request.hold!.id)!.value.lift, null);
  f.restart(); assert.deepEqual(ok(await runStopAnalysis(f.store, f.request)), result); assert.equal(f.sent().length, 1);
});

test('A6 a claimed origin class unsupported by its exact grounds preserves the raw call and never lifts the hold', async t => {
  const f = fixture(t, 'block', true), before = preserved(f);
  scenario(f, answer(f, { origin: { class: 'derivation', basis: f.originSources } }));
  refusal(await runStopAnalysis(f.store, f.request));
  assert.equal(preserved(f), before); assert.equal(f.store.list('om-origin-analysis').length, 0);
  assert.equal(f.store.list('model-call').length, 1); assert.equal(f.sent().length, 1);
  f.restart(); refusal(await runStopAnalysis(f.store, f.request)); assert.equal(f.sent().length, 1);
});

for (const boundary of ['admission', 'physical'] as const) test(`A6 changed report guard loses the ${boundary} transaction before provider dispatch`, async t => {
  const f = fixture(t); scenario(f);
  const other = new Store(f.database); t.after(() => other.close());
  let raced = false;
  const restore = observeWrites(f, (writes, guards) => {
    const target = boundary === 'admission' ? writes.some(write => write.kind === 'call-record')
      : writes.some(write => write.kind === 'model-call' && (write.value as { status?: string }).status === 'running');
    if (!raced && target) {
      assert.ok(guards.some(guard => guard.id === f.journal.id), 'The complete A5 report guard reaches the actual transaction');
      raced = true; const journal = other.get(f.journal.id)!;
      other.write({ id: journal.id, kind: journal.kind, expected: journal.revision, value: journal.value });
    }
  });
  try { refusal(await runStopAnalysis(f.store, f.request)); } finally { restore(); }
  assert.equal(raced, true); assert.equal(f.sent().length, 0); assert.equal(f.store.list('model-call').length, 0);
  assert.equal(f.store.list('om-stop-review').length, 0); assert.equal(seriesNow(f).value.stop!.attempt, 3);
  assert.equal(f.store.list('call-record').length, boundary === 'admission' ? 0 : 1);
});

test('A6 malformed request and foreign exact series fail with addressed typed errors before writing', async t => {
  const f = fixture(t), before = canonical(f.store.list());
  for (const request of [undefined, null, {}, { ...f.request, hold: undefined }, { ...f.request, dispatch: null }]) {
    assert.throws(() => prepareStopAnalysis(f.store, request as AnalysisRequest), (error: unknown) =>
      error instanceof EngineError && typeof error.code === 'string' && Boolean(error.details));
  }
  const foreign: Ref = { ...f.request.series, hash: '0'.repeat(64) };
  refusal(await runStopAnalysis(f.store, { ...f.request, series: foreign }));
  assert.equal(canonical(f.store.list()), before); assert.equal(f.sent().length, 0);
});

test('A6 the saved A5 source set requires its exact journal and every held origin', t => {
  const f = fixture(t, 'block', true), prepared = ok(prepareStopAnalysis(f.store, f.request));
  const sources = prepared.intent.sources;
  assert.deepEqual(sources.series, f.request.series); assert.ok(sources.journal);
  assert.deepEqual(sources.holds, [f.request.hold]);
  const before = canonical(f.store.list()), restore = forbidSourceHeads(f, prepared.intent.report.guards);
  try {
    assert.deepEqual(ok(readStopReport(f.store, { project: f.project, sources })), prepared.intent.report);
    refusal(readStopReport(f.store, { project: f.project, sources: { ...sources, journal: null } }));
    refusal(readStopReport(f.store, { project: f.project, sources: { ...sources, holds: [] } }));
    refusal(readStopReport(f.store, { project: f.project, sources: { ...sources, holds: [...sources.holds, ...sources.holds] } }));
    const { journal: _journal, ...missing } = sources;
    assert.throws(() => readStopReport(f.store, { project: f.project, sources: missing as typeof sources }), EngineError);
  } finally { restore(); }
  assert.equal(canonical(f.store.list()), before); assert.equal(f.sent().length, 0);
});

test('A6 a source moving at answer application preserves raw usage and refuses a stale review without resending', async t => {
  const f = fixture(t), before = reference(seriesNow(f)); scenario(f);
  const other = new Store(f.database); t.after(() => other.close());
  let raced = false;
  const restore = observeWrites(f, (writes, guards) => {
    if (!raced && writes.some(write => write.kind === 'om-stop-review')) {
      assert.ok(guards.some(guard => guard.id === f.journal.id));
      raced = true; const journal = other.get(f.journal.id)!;
      other.write({ id: journal.id, kind: journal.kind, expected: journal.revision, value: journal.value });
    }
  });
  try { refusal(await runStopAnalysis(f.store, f.request)); } finally { restore(); }
  assert.equal(raced, true); assert.deepEqual(reference(seriesNow(f)), before);
  assert.equal(f.store.list('om-stop-review').length, 0); assert.equal(f.sent().length, 1);
  assert.deepEqual(f.store.list<{ usage: unknown }>('model-call').map(record => record.value.usage), [usage]);
  f.restart(); const saved = canonical(f.store.list());
  refusal(await runStopAnalysis(f.store, f.request));
  assert.equal(f.sent().length, 1); assert.equal(canonical(f.store.list()), saved);
});

test('A6 sorting exact evidence preserves multiplicity of the reviewer claim', async t => {
  const f = fixture(t), source = reference(f.environment);
  scenario(f, answer(f, { cause: { kind: 'evidence', text: 'The saved workspace condition is the evidence.', sources: [source, source] } }));
  const result = ok(await runStopAnalysis(f.store, f.request));
  assert.equal(result.value.state, 'decided'); assert.deepEqual(result.value.cause!.sources, [source, source]);
  assert.deepEqual(ok(readStopAnalysis(f.store, { project: f.project, record: reference(result) })), result);
  assert.equal(f.sent().length, 1);
});

test('A6 malformed response parts become failed analysis without implying an undecided escalation', async t => {
  const responses: Array<(f: Fixture) => unknown> = [
    f => ({ ...answer(f), protocol: 'another-protocol' }),
    f => ({ ...answer(f), cause: { kind: 'evidence', text: 'No reference backs this evidence.', sources: [] } }),
    f => ({ ...answer(f), change: { text: 'No changed address is named.', addresses: [] } }),
    f => ({ ...answer(f), cause: { kind: 'hypothesis', text: '   ', sources: [] } }),
    f => ({ ...answer(f), change: { text: 'No field is named.', addresses: [{ ref: f.request.series, field: '' }] } }),
    f => ({ ...answer(f), origin: { class: 'conditions', basis: f.originSources } }),
    f => ({ ...answer(f), accepted: true }),
  ];
  for (const response of responses) {
    const f = fixture(t), before = preserved(f); f.steps([{ research: response(f), usage }]);
    const result = ok(await runStopAnalysis(f.store, f.request));
    assert.equal(result.value.state, 'failed'); assert.equal(result.value.error?.code, 'analysis_response_invalid');
    assert.equal(preserved(f), before); assert.equal(seriesNow(f).value.ladder.rung, 1); assert.equal(f.sent().length, 1);
  }
});

test('A6 missing mandatory intent fields refuse before E1 and physical dispatch', async t => {
  for (const field of ['contract', 'request', 'sources', 'report', 'packet', 'call']) {
    const f = fixture(t), prepared = ok(prepareStopAnalysis(f.store, f.request)), write = prepared.writes[0]!;
    const value = structuredClone(write.value) as Record<string, unknown>; delete value[field];
    f.store.write({ ...write, value });
    const before = canonical(f.store.list());
    refusal(await runStopAnalysis(f.store, f.request), 'analysis_invalid');
    assert.equal(canonical(f.store.list()), before); assert.equal(f.sent().length, 0);
  }
});

test('A6 missing saved result fields cannot be read as a producer-checked analysis', async t => {
  for (const field of ['contract', 'intent', 'transport', 'state', 'cause', 'error', 'goals', 'basis']) {
    const f = fixture(t), before = preserved(f); scenario(f);
    const restore = observeWrites(f, writes => {
      for (const write of writes) if (write.kind === 'om-stop-review') delete (write.value as Record<string, unknown>)[field];
    });
    try { refusal(await runStopAnalysis(f.store, f.request), 'analysis_invalid'); } finally { restore(); }
    const saved = f.store.list('om-stop-review')[0]!;
    refusal(readStopAnalysis(f.store, { project: f.project, record: reference(saved) }), 'analysis_invalid');
    assert.equal(preserved(f), before); assert.equal(f.sent().length, 1);
  }
});

test('A6 history rejects a real E1 and physical response bound to a different actual dispatch', async t => {
  const f = fixture(t), prepared = ok(prepareStopAnalysis(f.store, f.request));
  const intent = f.store.write(prepared.writes[0]!);
  const alternative = new Environments(f.store).configure(f.project, { ...f.environment.value,
    reviewer: { ...f.environment.value.reviewer, actor: 'substituted-reviewer', model: 'substituted-model' } }, f.environment.revision);
  const call = JSON.parse(canonical({ ...prepared.intent.call,
    dispatch: { ...f.request.dispatch, config: reference(alternative) } })) as AnyRecordCallRequest;
  const admitted = ok(recordCall(f.store, f.project, call));
  scenario(f);
  const transport = ok(await runModelTransport(f.store, { project: f.project,
    call: reference(f.store.get(admitted.call.id, 1)!), packet: JSON.parse(canonical(prepared.intent.packet)) as Json, role: 'reviewer' }));
  assert.equal(transport.result.kind, 'answered'); assert.equal(f.sent()[0]!.model, 'substituted-model');
  const returned = answer(f), id = intent.id.replace('om-analysis-intent:', 'om-stop-review:');
  const imitation = f.store.write({ id, kind: 'om-stop-review', expected: 0, value: {
    contract: 'om-stop-analysis/v1', projectId: f.project, intent: reference(intent), transport: reference(transport.record),
    state: 'decided', cause: returned.cause, change: returned.change, error: null, block: 'analysis-block',
    stop: 3, goals: [...f.series.value.stop!.goals].sort(), attempt: 3, row: null, class: null, basis: [],
  } });
  const before = canonical(f.store.list());
  const denied = refusal(readStopAnalysis(f.store, { project: f.project, record: reference(imitation) }), 'analysis_invalid');
  assert.equal(denied.at.field, 'transport');
  refusal(await runStopAnalysis(f.store, f.request), 'analysis_invalid');
  assert.equal(canonical(f.store.list()), before); assert.equal(f.sent().length, 1);
});

test('A6 an inherited saved stop cannot acquire a second reviewer call through a successor line', async t => {
  const f = fixture(t); scenario(f);
  const original = ok(await runStopAnalysis(f.store, f.request));
  const successor = ok(openSeries(f.store, { project: f.project, block: 'analysis-block', line: 2,
    slice: 'workspace-v2', predecessor: reference(seriesNow(f)),
    basis: { ground: 'inputs-changed', text: 'The next input slice retains the unaddressed stop.' } }));
  assert.deepEqual(successor.value.stop, f.series.value.stop);
  const before = canonical(f.store.list());
  refusal(await runStopAnalysis(f.store, { ...f.request, series: reference(successor) }), 'analysis_conflict');
  assert.equal(canonical(f.store.list()), before); assert.equal(f.store.list('call-record').length, 1);
  f.restart();
  assert.deepEqual(ok(await runStopAnalysis(f.store, f.request)), original);
  refusal(await runStopAnalysis(f.store, { ...f.request, series: reference(successor) }), 'analysis_conflict');
  assert.equal(f.sent().length, 1);
});

test('A6 the exact checked intent cannot change between preparation and E1 admission', async t => {
  const f = fixture(t), prepared = ok(prepareStopAnalysis(f.store, f.request));
  const intent = f.store.write(prepared.writes[0]!), other = new Store(f.database); t.after(() => other.close());
  const original = f.store.get.bind(f.store); let raced = false;
  f.store.get = ((id: string, revision?: number) => {
    const found = original(id, revision);
    if (!raced && id === intent.id && revision === undefined) {
      raced = true;
      other.write({ id: intent.id, kind: intent.kind, expected: intent.revision, value: intent.value });
    }
    return found;
  }) as Store['get'];
  try { refusal(await runStopAnalysis(f.store, f.request)); } finally { f.store.get = original; }
  assert.equal(raced, true); assert.equal(f.store.get(intent.id)!.revision, intent.revision + 1);
  assert.equal(f.store.list('call-record').length, 0); assert.equal(f.store.list('model-call').length, 0);
  assert.equal(f.store.list('om-stop-review').length, 0); assert.equal(f.sent().length, 0);
});

for (const prefix of ['intent', 'E1', 'response', 'result'] as const) test(`A6 restart after the durable ${prefix} prefix completes one physical call and one result`, async t => {
  const f = fixture(t); scenario(f);
  const original = f.store.writeMany.bind(f.store); let stopped = false;
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    const records = original(writes, guards);
    const selected = writes.some(write => prefix === 'intent' ? write.kind === 'om-analysis-intent'
      : prefix === 'E1' ? write.kind === 'call-record' && write.expected === 0
      : prefix === 'result' ? write.kind === 'om-stop-review'
      : write.kind === 'model-call' && (write.value as { status?: string }).status === 'succeeded');
    if (!stopped && selected) { stopped = true; throw new Error('fixture stopped after durable prefix'); }
    return records;
  }) as Store['writeMany'];
  try { await assert.rejects(runStopAnalysis(f.store, f.request), /fixture stopped after durable prefix/); }
  finally { f.store.writeMany = original; }
  assert.equal(stopped, true); assert.equal(f.store.list('om-stop-review').length, prefix === 'result' ? 1 : 0);
  assert.equal(f.sent().length, prefix === 'response' || prefix === 'result' ? 1 : 0);
  f.restart();
  const result = ok(await runStopAnalysis(f.store, f.request));
  assert.equal(result.value.state, 'decided'); assert.equal(f.sent().length, 1);
  assert.equal(f.store.list('call-record').length, 1); assert.equal(f.store.list('model-call').length, 1);
  assert.equal(f.store.list('om-stop-review').length, 1);
  assert.deepEqual(f.store.list<{ usage: unknown }>('model-call').map(record => record.value.usage), [usage]);
  assert.deepEqual(f.store.list<{ calls: Array<{ usage: unknown }> }>('om-call-ledger')
    .flatMap(record => record.value.calls.map(call => call.usage)), [usage]);
  const saved = canonical(f.store.list());
  assert.deepEqual(ok(await runStopAnalysis(f.store, f.request)), result);
  assert.equal(canonical(f.store.list()), saved); assert.equal(f.sent().length, 1);
});

test('A6 a durable running claim before spawn retains its reservation through restart and cannot resend', async t => {
  const f = fixture(t); scenario(f);
  const original = f.store.writeMany.bind(f.store); let stopped = false;
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    const records = original(writes, guards);
    if (!stopped && writes.some(write => write.kind === 'model-call' && write.expected === 0
      && (write.value as { status?: string }).status === 'running')) {
      stopped = true; throw new Error('fixture stopped after durable running claim');
    }
    return records;
  }) as Store['writeMany'];
  try { await assert.rejects(runStopAnalysis(f.store, f.request), /fixture stopped after durable running claim/); }
  finally { f.store.writeMany = original; }
  assert.equal(stopped, true); assert.equal(f.sent().length, 0);
  const physical = f.store.list<{ status: string; usage: unknown }>('model-call');
  assert.equal(physical.length, 1); assert.equal(physical[0]!.value.status, 'running'); assert.equal(physical[0]!.value.usage, null);
  f.restart(); const saved = canonical(f.store.list());
  for (let repeat = 0; repeat < 2; repeat++) refusal(await runStopAnalysis(f.store, f.request), 'model_call_in_progress');
  assert.equal(canonical(f.store.list()), saved); assert.equal(f.store.list('call-record').length, 1);
  assert.equal(f.store.list('model-call').length, 1); assert.equal(f.store.list('om-stop-review').length, 0); assert.equal(f.sent().length, 0);
});

for (const boundary of ['E1', 'E4'] as const) for (const mode of ['absent', 'contradiction'] as const)
  test(`A6 ${boundary} preserves ${mode} transaction guards without partial records`, async t => {
    const f = fixture(t); scenario(f);
    const prepared = ok(prepareStopAnalysis(f.store, f.request));
    const call = JSON.parse(canonical(prepared.intent.call)) as AnyRecordCallRequest;
    const id = 'analysis-dependency';
    const extra: TransactionGuard[] = [{ id, absent: true }];
    if (mode === 'contradiction') extra.push(reference(f.store.write({ id, kind: 'fixture-dependency', expected: 0, value: {} })));
    let admitted: ReturnType<typeof recordCall> | null = null;
    if (boundary === 'E4') admitted = recordCall(f.store, f.project, call);
    const other = new Store(f.database); t.after(() => other.close());
    let raced = false;
    const restore = observeWrites(f, (writes, guards) => {
      if (!raced && writes.some(write => write.kind === (boundary === 'E1' ? 'call-record' : 'model-call'))) {
        raced = true; assert.ok(guards.some(guard => guard.id === id && 'absent' in guard));
        if (mode === 'contradiction') assert.ok(guards.some(guard => guard.id === id && 'revision' in guard));
        else other.write({ id, kind: 'fixture-dependency', expected: 0, value: {} });
      }
    });
    try {
      const outcome = boundary === 'E1' ? recordCall(f.store, f.project, call, extra)
        : await runModelTransport(f.store, { project: f.project, call: reference(ok(admitted!).call),
          packet: JSON.parse(canonical(prepared.intent.packet)) as Json, role: 'reviewer' }, undefined, extra);
      const denied = refusal(outcome, 'input_stale'); assert.equal(denied.at.target, id);
      assert.equal(denied.at.ref, undefined);
    } finally { restore(); }
    assert.equal(raced, true); assert.equal(f.sent().length, 0);
    assert.equal(f.store.list('model-call').length, 0); assert.equal(f.store.list('project-dispatch').length, 0);
    if (boundary === 'E1') { assert.equal(f.store.list('call-record').length, 0); assert.equal(f.store.list('om-call-ledger').length, 0); }
  });

test('A6 two Stores resume one saved intent without a second physical request or charge', async t => {
  const f = fixture(t); scenario(f);
  const prepared = ok(prepareStopAnalysis(f.store, f.request)); f.store.writeMany([...prepared.writes], [...prepared.guards]);
  const other = new Store(f.database); t.after(() => other.close());
  const first = runStopAnalysis(f.store, f.request);
  const second = await runStopAnalysis(other, f.request);
  if (!second.ok) assert.equal(second.refusal.code, 'model_call_in_progress');
  const result = ok(await first);
  assert.deepEqual(ok(await runStopAnalysis(other, f.request)), result);
  assert.equal(f.sent().length, 1); assert.equal(f.store.list('model-call').length, 1);
  assert.deepEqual(f.store.list<{ calls: Array<{ usage: unknown }> }>('om-call-ledger')
    .flatMap(record => record.value.calls.map(call => call.usage)), [usage]);
});
