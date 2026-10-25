import { type BriefReadings, briefReadings, packetPrompt } from '../src/om/packet-brief.js';
import { measureAdapterWire } from '../src/om/capacity-delivery.js';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, existsSync, readFileSync, mkdtempSync, watch, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Json, hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { type AdapterRequestInput, readAdapterResponse, finishModelAttempt, type ModelCallRequest, type ModelTransportRequest, type OmModelCall, readCompletionWorkAt, runModelCall, readModelCallState, runModelCycle as mp2Cycle, runModelCycle } from '../src/om/model-call.js';
import type { OmResult } from '../src/om/refusal.js';
import { type ProcessResult } from '../src/runtime/process.js';
import { Store, type Write, type Revision, storeReads } from '../src/storage/store.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { projectGraph } from '../src/graph/project.js';
import type { Graph, Node } from '../src/graph/model.js';
import { explicitMapping, gardenGraph } from './om-fixture.js';
import { seedCopy } from './om-seed.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { writeOmInput } from '../src/om/input.js';
import { writeAddressing, inputDecisionWrite } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { type GapRequest, writeGaps } from '../src/om/gaps.js';
import { prepareQuestionTasks, writeQuestionPacket, type QuestionPacketRequest, type QuestionPacketRecord, prepareQuestionPacket, type PartProposalBody, readQuestionPacket } from '../src/om/question-packet.js';
import { writeRoutes } from '../src/om/routes.js';
import { openSeries, beginAttempt, completeAttempt, type RepairSeries, readCompletionBinding, completionWorkId, seriesRequestOf, type AnyBeginAttemptRequest, type AnyRepairSeries, type MechanismRepairSeries } from '../src/om/series.js';
import { gapLineKey, gapLineExpectedResult, writeGapLines } from '../src/om/gap-lines.js';
import { prepareFrameProposals, type LayerProposal } from '../src/om/frame-proposals.js';
import { type FrameRequest, prepareFrame, type FrameScope } from '../src/om/frame-obligations.js';
import { writeCandidate } from '../src/om/frame-candidate.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import { normalizeOwnerGapAssignment, OM_OWNER_ASSIGNMENT_CONTRACT, writeOmObligations, OM_OWNER_ASSIGNMENT_KIND } from '../src/om/obligations.js';
import { taskBindingId } from '../src/graph/task-obligations.js';
import type { CarriedObligation } from '../src/graph/obligation-policy.js';
import { recordCall } from '../src/om/call-record.js';
import { openAttempt as managedOpenAttempt, closeAttempt, prepareManagedClaim, type OriginHold } from '../src/om/repeat-gate.js';
import { Environments } from '../src/runtime/environment.js';
import { unitRefusalNamespace, UNIT_REFUSAL_KIND, recordRefusal } from '../src/om/refusal-journal.js';
import { Evidence, Source } from '../src/evidence/evidence.js';
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { setTimeout as fixtureDelay } from 'node:timers/promises';
import { processStart } from '../src/runtime/process-identity.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { createRequire } from 'node:module';
import { runFixture, regatedHold, defectedWork } from './om-run-fixture.js';
import { startRun } from '../src/om/run.js';



export const requestId = "request:om-e4";


export const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };


export const unknownConfirmed = { model: null, effort: null, speed: null };


export const confirmed = { model: "fixture-confirmed", effort: "high", speed: "fast" };


export const fixturePath = fileURLToPath(new URL("../../test/om-adapter-fixture.mjs", import.meta.url));



export function valueOf<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`Unexpected refusal: ${result.refusal.code}: ${result.refusal.message} ${JSON.stringify(result.refusal.at)}`);
  return result.value;
}



export function request(over: Partial<AdapterRequestInput> = {}): AdapterRequestInput {
  return { requestId, packet: { question: "Who produces this contract?" }, model: "fixture", effort: "high", ...over };
}


export function currentPacketWire(packet: unknown, speed: 'fast' | null = 'fast'): number {
  const body = packet as Record<string, unknown>;
  return measureAdapterWire(body, body.requestId as string, 'fixture', 'high', speed ?? undefined);
}



export function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { protocol: "omg-agent/v1", requestId, research: { answer: "producer" }, usage: null,
    confirmed: { ...unknownConfirmed }, ...over };
}



export function processResult(stdout: string, over: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", ...over };
}



export function decode(stdout: string, over: Partial<ProcessResult> = {}) {
  return valueOf(readAdapterResponse({ requestId, process: processResult(stdout, over) }));
}



export function omit(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}



export function deeplyFrozen(value: unknown): boolean {
  return value === null || typeof value !== "object"
    || (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));
}



/** The directory-independent prefix of e4Fixture — upstream stages, B1, M5 address, G2, D1 and routes — one seed per variant. */
export function e4Prefix(store: Store, kind: 'fact' | 'node' | 'field' | 'design', extraQuestion: boolean) {
  const engine = new ProductEngine(store);
  const project = 'garden', graphData = gardenGraph('cross');
  graphData.nodes.find(node => node.id === 'garden-produce-block')!.ports.push({ id: 'out-side', direction: 'out', contract: 'garden-contract' });
  graphData.nodes.find(node => node.id === 'garden-consume-block')!.ports.push({ id: 'in-side', direction: 'in', contract: 'garden-contract' });
  graphData.connectors.push({ id: 'garden-side-flow', artifact: 'garden-data', returnsTo: 'garden-produce-block', wakeTest: null,
    bindings: [{ level: 1, producer: { node: 'garden-produce-block', port: 'out-side' },
      consumers: [{ node: 'garden-consume-block', port: 'in-side' }], anchor: null }] });
  const { level: _level, ...l1 } = projectGraph(graphData, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'encoding', question: 'What encoding is supported?',
      consumer: 'garden-consume-block', moment: 'om-pass', blocksCurrentStage: false, resolution: 'Resolve the addressed question during OM' }, ...(extraQuestion ? [{ id: 'spare', question: 'Which optional format?', consumer: 'garden-consume-block',
        // OWN1 (№3711): a design question of the pass is the model's; the one no producer of the pass serves is a later one.
        moment: kind === 'design' ? 'task-start' : 'om-pass', blocksCurrentStage: false, resolution: 'Address during OM' }] : [])];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = valueOf(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  // 'design' also addresses the spare question as a design decision of task start: no producer of the pass answers it (H1.5, OWN1).
  const input = kind === 'field' ? base : valueOf(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: [{ pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: 'discovery:encoding', field: 'address', value: { consumer: 'garden-consume-block', kind: 'repository-fact' } } })) as Write },
    ...(kind === 'design' ? [{ pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: 'discovery:spare', field: 'address', value: { consumer: 'garden-consume-block', kind: 'design-decision' } } })) as Write }] : [])] }));
  const horizon = valueOf(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: 'e4-fixture', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = valueOf(writeGaps(store, sources));
  const gapRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = valueOf(prepareQuestionTasks(store, { project, gaps: gapRequest,
    questions: gaps.records.filter(row => row.value.gap.kind === 'repository-fact' && row.value.gap.code !== 'inventory_missing' && !row.value.gap.deferral)
      .map(gap => ({ gap: reference(gap), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) }));
  const source = store.get<{content: string}>(`source:${project}:brief`)!;
  // This open prefix is built once per variant by current producers, then copied for each test.
  // Live workspace, pending calls and race participants are created only after the copy.
  const routes = valueOf(writeRoutes(store, { project, gaps: gapRequest,
    tasks: tasks.tasks.map(task => ({ pending: structuredClone(task.writes[0]!) as Write })),
    catalog: { paths: ['e4-source.txt'], records: [] }, previous: null }));
  return { graphData, graph, input, sources, gaps, gapRequest, source, routes };
}



export function e4Fixture(t: TestContext, kind: 'fact' | 'node' | 'field' | 'design' = 'fact', capacity = 100_000, priorNoProgress = 0, timeoutMs = 1000, managed = false, materialize = true, extraQuestion = false,
  seriesCommit?: string, material?: (store: Store, project: string, root: string) => void, priorRefused = false) {
  // M5 addresses the fact for 'fact' and 'node' alike; 'field' leaves it unaddressed.
  const extra = extraQuestion || kind === 'design';
  const seeded = seedCopy(`e4:${kind === 'field' ? 'field' : kind === 'design' ? 'design' : 'addressed'}:${extra}`,
    store => e4Prefix(store, kind, extra), 'omg-e4-dispatch-');
  const { root, database } = seeded, { graphData, graph, input, sources, gaps, gapRequest, source, routes } = seeded.data;
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = 'garden';
  writeFileSync(join(root, 'e4-source.txt'), 'UTF-8 is the supported encoding.');
  const batch = routes.value.batches.find(batch => kind === 'node' ? batch.task === 'node-expansion' && batch.node === 'garden-produce-block'
    : kind === 'design' ? batch.model === 'MC2' && batch.task === 'input-field' && batch.items.some(item => item.target === 'discovery:spare' && item.field === 'answer')
    : kind === 'field' ? batch.model === 'MC2' && batch.task === 'input-field' && batch.items.some(item => item.target === 'discovery:encoding')
    : batch.model === 'MC1' && batch.items.some(item => item.target === 'discovery:encoding'))!;
  assert.ok(batch);
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [fixturePath, '--scenario', scenario, '--trace', trace] };
  function environment(amount = capacity) {
    return engine.environments.configure(project, { workspace: root,
      implementer: { actor: 'e4-implementer', model: 'fixture', effort: 'high', speed: 'fast', command },
      reviewer: { actor: 'e4-reviewer', model: 'fixture-reviewer', effort: 'medium', command },
      fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs, requestCapacityChars: amount },
    store.get(`environment:${project}`)?.revision ?? 0);
  }
  const configured = environment(), adapter = store.write({ id: `adapter:${project}:e4`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: project, protocol: 'codex-stdio' } });
  const goal = { key: `e4:${kind}`, questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  const address = kind === 'field' ? { project, owner: { kind: 'mechanism' as const, mechanism: 'M5:addressing' as const }, line: 1 }
    : { project, block: kind === 'node' ? batch.node! : 'garden-consume-block', line: 1 };
  const admission = { gaps: gapRequest, routes: reference(routes), batch: batch.id };
  const firstLine = kind === 'field' ? { ...address, scope: gapRequest, predecessor: null, basis: null }
    : { ...address, slice: 'e4-fixture', predecessor: null, basis: null };
  // Q3 (№2573-1): a historical producer continues a line of its own form, opened by its own commit when a test names one.
  if (seriesCommit) h15AtCommit({ root, database }, seriesCommit, 'era-series', `const { openSeries } = await import(src('om/series.js'));
out(reference(take(openSeries(store, args))));`, firstLine);
  else valueOf(openSeries(store, firstLine as never));
  for (let attempt = 1; attempt <= priorNoProgress; attempt++) {
    valueOf(beginAttempt(store, kind === 'field' ? { ...address, attempt, goal, admission } as never : { ...address, attempt, goal } as never));
    valueOf(completeAttempt(store, { ...address, attempt, outcome: { reason: 'result', achieved: [], cancelled: [], refusals: [] } } as never));
  }
  // MP2 (№3153): the preceding attempt refused by the model itself (its E2 packet, E1 and the common E4 finish), so the
  // packets of the next attempt stand on a non-empty refusal journal.
  if (priorRefused) {
    assert.equal(kind, 'node');
    const attempt = priorNoProgress + 1, refused = valueOf(beginAttempt(store, { ...address, attempt, goal } as never));
    const packet = valueOf(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id, environment: reference(configured),
      attempt: { series: reference(refused), ordinal: attempt }, previous: [] })).record;
    const payload = packet.value.packet as Record<string, Json>, assigned = new Set((payload.questions as { id: string }[]).map(item => item.id));
    const call = valueOf(recordCall(store, project, { call: payload.requestId as string, purpose: payload.purpose as never, basis: null, block: batch.node!,
      series: reference(refused), attempt, goal, gaps: batch.items.filter(item => assigned.has(item.gap)).flatMap(item => item.consumers
        .map(consumer => ({ id: item.target, goal: item.target, field: item.field, consumer }))),
      dispatch: { adapter: reference(adapter), config: reference(configured) }, packet: structuredClone(payload) })).call;
    valueOf(finishModelAttempt(store, { project, packet: reference(packet), call: reference(call), response: null,
      code: 'cannot_answer', message: 'The node needs another design', reason: 'refused' }));
  }
  const ordinal = priorNoProgress + (priorRefused ? 2 : 1);
  const opening = { ...address, attempt: ordinal, goal, ...(kind === 'field' ? { admission } : {}),
    ...(managed ? { completion: { routes: reference(routes), batches: [batch.id] } } : {}) };
  const series = valueOf((managed ? managedOpenAttempt : beginAttempt)(store, opening as never));
  material?.(store, project, root);
  const packetRequest: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(configured),
    attempt: { series: reference(series), ordinal }, previous: [] };
  // LP1: historical consumers receive the packet their producer issues, including its exact v2 candidate address.
  const packet = seriesCommit ? h15AtCommit({ root, database }, seriesCommit, 'era-packet',
    `const { ${materialize ? 'writeQuestionPacket' : 'prepareQuestionPacket'} } = await import(src('om/question-packet.js'));
out(take(${materialize ? 'writeQuestionPacket' : 'prepareQuestionPacket'}(store, args)).record);`, packetRequest) as Revision<QuestionPacketRecord>
    : valueOf((materialize ? writeQuestionPacket : prepareQuestionPacket)(store, packetRequest)).record;
  if (seriesCommit) assert.equal(packet.value.answerProtocol, 'omg-answer/v2');
  const request: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(configured) }, role: 'implementer' };
  const frame = valueOf(prepareFrameProposals(store, sources.operations));
  const obligations = frame.frame.result.obligations.filter(item => item.upper.node === batch.node);
  return { root, database, project, graph, fullGraph: graphData, input, source, routes, gaps, gapRequest, batch, packet, request, packetRequest,
    configured, adapter, series, obligations, scenario, trace, environment,
    get store() { return store; }, get engine() { return engine; },
    restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); },
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ database, steps })); },
    sent() { return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; },
  };
}


interface ManagedFixtureOptions {
  capacity?: number;
  timeoutMs?: number;
  priorNoProgress?: number;
  priorRefused?: boolean;
  extraQuestion?: boolean;
  material?: (store: Store, project: string, root: string) => void;
}
type ManagedE4Fixture = Omit<ReturnType<typeof e4Fixture>, 'series'> & { series: Revision<AnyRepairSeries> };
type ManagedPacketFixture = Pick<ManagedE4Fixture, 'store' | 'project' | 'series' | 'packetRequest'>;
type PreparedE4Fixture = ManagedE4Fixture & { prefix: Ref[]; preparationCalls: Ref[] };
type BlockE4Fixture = Omit<PreparedE4Fixture, 'series'> & { series: Revision<RepairSeries> };
type MechanismE4Fixture = Omit<PreparedE4Fixture, 'series'> & { series: Revision<MechanismRepairSeries> };

/** Explicit G7: a paid E4/E5 result alone never closes a managed attempt. */
export function e4ManagedClose(f: ManagedPacketFixture, reason: 'off-form' | 'refused' | 'result' = 'refused') {
  const current = f.store.get<RepairSeries>(f.series.id)!;
  const request = { ...seriesRequestOf(current.value), attempt: f.packetRequest.attempt!.ordinal,
    outcome: { reason, accepting: [], cancelling: [], refusals: [] } };
  const claim = valueOf(prepareManagedClaim(f.store, request)).outcome;
  return valueOf(closeAttempt(f.store, { ...request, outcome: claim }));
}

/** Technical no-progress paid through E2/E4; any correction is real work, never a fabricated completion row. */
async function payNoProgress(f: ManagedE4Fixture, script: Record<string, unknown>[]) {
  const start = script.length;
  script.push({ research: { invalid: 'first untyped reply' }, usage, confirmed },
    { research: { invalid: 'second untyped reply' }, usage, confirmed });
  f.steps(script);
  const cycle = valueOf(await runModelCycle(f.store, f.request));
  assert.equal(cycle.last.outcome, null);
  // Keep only replies actually consumed, so a terminal without correction cannot lend a reply to the next ordinal.
  script.splice(start + cycle.record.value.steps.length); f.steps(script);
  e4ManagedClose(f, 'off-form');
  return reference(cycle.record);
}

/**
 * Opt-in current carrier. The synchronous e4Fixture (including its old prefix flags) retains its era/defaults.
 * Each prior ordinal here owns the complete M6 batch, pays its real E4 work and closes at G7. Prefix calls remain
 * in sent()/the ledger; callers take their baseline after this preparation and attribute their own calls by Ref.
 */
export function e4ManagedFixture(t: TestContext, kind: 'field', options?: ManagedFixtureOptions): Promise<MechanismE4Fixture>;
export function e4ManagedFixture(t: TestContext, kind?: 'fact' | 'node' | 'design', options?: ManagedFixtureOptions): Promise<BlockE4Fixture>;
export function e4ManagedFixture(t: TestContext, kind: Parameters<typeof e4Fixture>[1], options?: ManagedFixtureOptions): Promise<PreparedE4Fixture>;
export async function e4ManagedFixture(t: TestContext, kind: Parameters<typeof e4Fixture>[1] = 'fact', options: ManagedFixtureOptions = {}) {
  const count = options.priorNoProgress ?? 0;
  assert.ok(Number.isSafeInteger(count) && count >= 0 && count + Number(options.priorRefused ?? false) < 3,
    'A current attempt must precede the first-rung stop');
  const f: ManagedE4Fixture = e4Fixture(t, kind, options.capacity ?? 100_000, 0, options.timeoutMs ?? 5000, true, true,
    options.extraQuestion ?? false, undefined, options.material);
  const script: Record<string, unknown>[] = [], prefix: Ref[] = [];
  const next = () => {
    const ordinal = f.packetRequest.attempt!.ordinal + 1;
    const current = f.store.get<RepairSeries>(f.series.id)!;
    const binding = valueOf(readCompletionBinding(f.store, f.project, reference(current), ordinal - 1))!;
    const address = seriesRequestOf(current.value), work = { attempt: ordinal, goal: current.value.attempts[0]!.goal,
      completion: { routes: reference(f.routes), batches: [f.batch.id] } };
    let opening: AnyBeginAttemptRequest;
    if ('owner' in address) {
      assert.ok(binding.value.admission, 'The mechanism keeps its exact D1/M6 admission');
      opening = { ...address, ...work, admission: binding.value.admission };
    } else opening = { ...address, ...work };
    f.series = valueOf(managedOpenAttempt(f.store, opening));
    f.packetRequest = { ...f.packetRequest, attempt: { series: reference(f.series), ordinal } };
    f.packet = valueOf(writeQuestionPacket(f.store, f.packetRequest)).record;
    f.request = { ...f.request, packet: reference(f.packet) };
  };
  for (let index = 0; index < count; index++) { prefix.push(await payNoProgress(f, script)); next(); }
  if (options.priorRefused) {
    const questions = (f.packet.value.packet as { questions: { id: string }[] }).questions;
    script.push({ research: { protocol: '$answerProtocol', requestId: '$requestId', action: 'cannot_answer',
      questionIds: questions.map(row => row.id), reason: 'The complete assigned batch needs another design' }, usage, confirmed });
    f.steps(script);
    const cycle = valueOf(await runModelCycle(f.store, f.request));
    assert.equal(cycle.last.outcome?.kind, 'no-result');
    prefix.push(reference(cycle.record)); e4ManagedClose(f); next();
  }
  const preparationSteps = [...script], writeScenario = f.steps;
  return Object.assign(f, { prefix, preparationCalls: f.store.list<ModelCall>('model-call').map(reference),
    // Like the original helper, steps() names the caller's work; paid setup replies keep their consumed indices.
    steps(steps: Record<string, unknown>[]) { writeScenario([...preparationSteps, ...steps]); } });
}

/** The current works carrier opens only its own M6 batch; callers explicitly execute and G7-close it. */
export function e4ManagedWorksFixture(t: TestContext) { return e4WorksFixture(t, true); }


export function e4Fact(f: ReturnType<typeof e4Fixture>) {
  return { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer',
    results: [{ questionId: f.batch.items[0]!.gap, value: 'UTF-8',
      citations: [{ source: reference(f.source), selector: { kind: 'text-range', start: 0, end: f.source.value.content.length } }] }] };
}


export function e4Node(f: ReturnType<typeof e4Fixture>, packet: Revision<QuestionPacketRecord> = f.packet as Revision<QuestionPacketRecord>) {
  const plan = packet.value.plan!, ids = plan.assignments[plan.position]!.obligations;
  const assigned = f.obligations.filter(item => ids.includes(item.id));
  const upper = f.graph.value.nodes.find(node => node.id === f.batch.node)!;
  const node: Node = { ...structuredClone(upper), id: `garden-part-${plan.position}`, kind: 'operation', parent: upper.id,
    title: `Expansion part ${plan.position}`, ports: assigned.filter(item => item.kind === 'connection-end').map((item, index) => ({
      id: `part-port-${index}`, direction: item.role === 'producer' ? 'out' : 'in',
      contract: f.graph.value.artifacts.find(artifact => artifact.id === item.artifact)!.contract,
    })), code: [], tests: [] };
  let port = 0;
  const proposal: PartProposalBody = { nodes: [node], fills: assigned.map(item => ({ obligation: item.id, node: node.id,
    ...(item.kind === 'connection-end' ? { port: node.ports[port++]!.id } : {}) })), localConnectors: [], artifacts: [], contracts: [],
    joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
  return { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer', proposal };
}



/** A first works pass through C2/C4/C5, with a genuine owner assignment and no accepted L3. */
export function e4WorksFixture(t: TestContext, managed = false) {
  const root = mkdtempSync(join(tmpdir(), 'omg-e4-works-')), database = join(root, 'state.sqlite'), project = 'garden';
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const desired = gardenGraph('cross'), { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'late-proof',
      question: 'Which result proof must the concrete producer provide?', consumer: 'garden-produce-operation',
      moment: 'task-result', blocksCurrentStage: false, resolution: 'Retain the result proof for the concrete work' }];
    return value;
  });
  let input = valueOf(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const initial = valueOf(writeHorizon(store, { project, input: reference(input), graph: reference(store.get(`graph:${project}`)!),
    refinement: null, available: {}, choice: { choiceVersion: 'e4-work-upper', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame2: FrameRequest = { project, level: 2, graph: reference(store.get(`graph:${project}`)!), horizon: reference(initial.gate),
    layer: null, frame: null, upper: null };
  const frame = valueOf(prepareFrame(store, frame2)), projected = projectGraph(desired, 2);
  const fills = explicitMapping(desired, frame.upper as Graph, frame.scope as FrameScope, 2);
  const nodes = projected.nodes.filter(node => node.kind === 'operation'), nodeIds = new Set(nodes.map(node => node.id));
  const proposalValue: LayerProposal = { base: { graph: frame.request.graph, frame: null }, level: 2, source: 'decision', status: 'proposed', nodes,
    fills: fills.fills.filter(fill => nodeIds.has(fill.node)).map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length), artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
    tests: projected.tests, edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [],
    transfers: projected.transfers ?? [], anchors: projected.anchors, removes: [], replaces: [], redefines: [] };
  const proposal = store.write({ id: `om-proposal:${project}:e4-work-upper`, kind: 'layer-proposal', expected: 0, value: proposalValue });
  const candidate = valueOf(writeCandidate(store, { frame: frame2, proposals: [reference(proposal)] }));
  assert.equal(candidate.state, 'candidate'); if (candidate.state !== 'candidate') throw new Error('Missing upper candidate');
  const accepted = valueOf(settleCandidate(store, { project, level: 2, candidate: reference(candidate.record), outcome: {
    gate: 'G3', candidate: reference(candidate.record), graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  const graph = reference(accepted.graph!), layer2 = reference(accepted.layer!), upperFrame = reference(accepted.frame!);
  input = valueOf(writeAddressing(store, { project, input: reference(input), graph, decisions: [{ pending: inputDecisionWrite({ project,
    input: reference(input), graph, layers: [layer2], decision: { target: 'discovery:late-proof', field: 'address',
      value: { consumer: 'garden-produce-operation', kind: 'post-implementation-proof' } } }) as Write }] }));
  const horizon = valueOf(writeHorizon(store, { project, input: reference(input), graph, refinement: layer2, available: {},
    choice: { choiceVersion: 'e4-work-pass', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { ...frame2, graph, horizon: reference(horizon.gate), layer: layer2, frame: upperFrame } },
    works: { proposals: [], frame: { project, level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
      upper: { horizon: reference(horizon.gate), frame: upperFrame }, workZoneContract: "accepted-l2-v1" } } };
  const gaps = valueOf(writeGaps(store, sources)), gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = valueOf(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const late = gaps.records.find(row => row.value.gap.target === 'discovery:late-proof')!; assert.ok(late);
  const assignment = normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project, context: { gaps: gapRead, lines: reference(lines) },
    gap: reference(late), assignments: late.value.gap.consumers.map(consumer => ({ responsibleNode: 'garden-produce-operation',
      responsibleConsumer: consumer, reason: 'Retain the concrete result test', returnCondition: `Prove result for ${consumer}`, wake: null })) });
  const ledger = valueOf(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [{ pending: {
    id: `om-owner-gap-assignment:${project}:${hashJson(assignment)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value: assignment } }] }));
  const routes = valueOf(writeRoutes(store, { project, gaps: gapRead, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const batch = routes.value.batches.find(batch => batch.level === 3 && batch.node === 'garden-produce-operation')!; assert.ok(batch);
  const address = { project, block: 'garden-produce-block', line: 1 };
  valueOf(openSeries(store, { ...address, slice: 'e4-work', predecessor: null, basis: null }));
  const goal = { key: 'e4-work', questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  // LP5: a managed attempt plans exactly this works batch of the routes (its completion owner and work registry).
  const series = valueOf((managed ? managedOpenAttempt : beginAttempt)(store, { ...address, attempt: 1, goal,
    ...(managed ? { completion: { routes: reference(routes), batches: [batch.id] } } : {}) } as never));
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [fixturePath, '--scenario', scenario, '--trace', trace] };
  function environment(requestCapacityChars = 100_000) {
    return engine.environments.configure(project, { workspace: root,
      implementer: { actor: 'e4-work-producer', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'e4-work-reviewer', model: 'fixture', effort: 'high', command },
      fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars },
    store.get(`environment:${project}`)?.revision ?? 0);
  }
  const configured = environment(), adapter = store.write({ id: `adapter:${project}:e4-work`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: project, protocol: 'codex-stdio' } });
  const packetRequest: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(configured),
    attempt: { series: reference(series), ordinal: 1 }, previous: [], works: { producer: reference(ledger.producer), ledger: reference(ledger.record) } };
  const packet = valueOf(writeQuestionPacket(store, packetRequest)).record;
  const request: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(configured) }, role: 'implementer' };
  const work = structuredClone(desired.nodes.find(node => node.id === 'garden-produce-work')!);
  const tests = structuredClone(desired.tests.filter(test => work.tests.includes(test.id)));
  const worksSource = gapRead.sources.works; assert.ok(!('state' in worksSource));
  const obligations = valueOf(prepareFrameProposals(store, worksSource)).frame.result.obligations.filter(item => item.upper.node === batch.node);
  const bindings = ledger.handoff.obligations.map(obligation => ({ id: taskBindingId(obligation as CarriedObligation),
    scope: obligation.scope, obligation: obligation.obligation, consumers: [{ node: work.id, tests: work.tests }] }));
  assert.ok(bindings.length);
  function answer(current = packet as Revision<QuestionPacketRecord>, position = current.value.plan!.position) {
    const plan = current.value.plan!, assigned = obligations.filter(item => plan.assignments[position]!.obligations.includes(item.id));
    const proposal: PartProposalBody = { nodes: position === 0 ? [work] : [], tests: position === 0 ? tests : [],
      fills: assigned.map(item => ({ obligation: item.id, node: work.id,
        ...(item.kind === 'connection-end' ? { port: item.upper.port!, codeRef: work.code[0]! } : {}) })),
      localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
      removes: [], replaces: [], redefines: [] };
    return { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer', proposal,
      bindings: position === plan.assignments.length - 1 ? bindings : [] };
  }
  return { project, packet, request, packetRequest, series, ledger, bindings, work, answer, environment, configured, address, goal,
    graph, layer2, upperFrame, frame2, lines, gapRead, routes, batch, desired, root,
    get store() { return store; }, restart() { store.close(); store = new Store(database); engine = new ProductEngine(store); },
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ database, steps })); },
    sent() { return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; } };
}


export function e4NeedSource(f: Pick<ReturnType<typeof e4Fixture>, 'batch'>, reads: unknown[]) {
  return { protocol: '$answerProtocol', requestId: '$requestId', action: 'need_source',
    questionIds: f.batch.items.map(item => item.gap), missing: 'Need the addressed source data', reads };
}



export function e4AnalysisFixture(t: TestContext, purpose: 'stop-analysis' | 'origin-analysis', timeoutMs = 1000) {
  const root = mkdtempSync(join(tmpdir(), 'omg-e4-analysis-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = 'analysis', block = 'analyzed-block', address = { project, block, line: 1 };
  const goal = { key: 'analysis-fixture-goal', questions: ['Address one contract'], result: 'A supported contract' };
  valueOf(openSeries(store, { ...address, slice: 'analysis-slice', predecessor: null, basis: null }));
  let series = valueOf(beginAttempt(store, { ...address, attempt: 1, goal })) as Revision<RepairSeries>;
  let basis: {kind: 'series-stop';series: Ref;attempt: number} | {kind: 'origin-hold';hold: Ref};
  if (purpose === 'stop-analysis') {
    for (const attempt of [1, 2, 3]) {
      if (attempt > 1) valueOf(beginAttempt(store, { ...address, attempt, goal }));
      series = valueOf(completeAttempt(store, { ...address, attempt,
        outcome: { reason: 'result', achieved: [], cancelled: [], refusals: [] } })) as Revision<RepairSeries>;
    }
    basis = { kind: 'series-stop', series: reference(series), attempt: 3 };
  } else {
    const refusal = store.write({ id: `${unitRefusalNamespace(project)}analysis-source`, kind: UNIT_REFUSAL_KIND, expected: 0,
      value: { gate: 'G3', refusals: [{ code: 'unrecognized_fixture_refusal', goal: goal.key, remedy: 'Identify the exact origin',
        origin: { name: 'artifact_missing', stage: 'layer-check', subject: 'artifact:fixture', sources: [] } }] } });
    const journal = valueOf(recordRefusal(store, { project, source: reference(refusal) }));
    const row = journal.value.rows[0]!;
    const closed = valueOf(closeAttempt(store, { ...address, attempt: 1,
      outcome: { reason: 'refused', accepting: [], cancelling: [], refusals: [{ row: row.id, name: row.code, goal: row.goal }] } }));
    assert.equal(closed.holds.length, 1);
    series = store.get<RepairSeries>(series.id)!; basis = { kind: 'origin-hold', hold: closed.holds[0]! };
  }
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [fixturePath, '--scenario', scenario, '--trace', trace] };
  const environment = new Environments(store).configure(project, { workspace: root, implementer: { actor: 'analysis-executor', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'analysis-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs }, 0);
  const adapter = store.write({ id: `adapter:${project}`, kind: 'dispatch-adapter', expected: 0, value: { protocol: 'codex-stdio' } });
  const packet = { task: 'Diagnose the named ground', note: 'No fabricated A6 protocol', basis } as unknown as Json;
  const reviewGoal = { key: purpose, questions: ['What caused this ground?'], result: 'A cause or explicit hypothesis with an addressed change' };
  const admitted = valueOf(recordCall(store, project, { call: `e4:${purpose}`, purpose, basis, block,
    gaps: [{ id: purpose, goal: purpose, field: 'cause-and-change', consumer: 'A6:stop-analysis' }], series: reference(series),
    attempt: purpose === 'stop-analysis' ? 3 : 1, goal: reviewGoal,
    dispatch: { adapter: reference(adapter), config: reference(environment) }, packet }));
  const request: ModelTransportRequest = { project, call: reference(admitted.call), packet, role: 'reviewer' };
  writeFileSync(scenario, JSON.stringify({ steps: [{ research: { cause: 'fixture observation', hypothesis: true }, usage, confirmed }] }));
  return { root, database: path, scenario, trace, project, packet, request, series, address, environment,
    get store() { return store; }, restart() { store.close(); store = new Store(path); },
    sent() { return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean) : []; } };
}


/** A6 transport with a genuine paid managed stop, or the block G5 hold produced by a regated works pass. */
export async function e4ManagedAnalysisFixture(t: TestContext, purpose: 'stop-analysis' | 'origin-analysis', timeoutMs = 5000) {
  let base: { root: string; database: string; project: string; store: Store; restart(): void };
  let series: Revision<RepairSeries>;
  let basis: { kind: 'series-stop'; series: Ref; attempt: number } | { kind: 'origin-hold'; hold: Ref };
  if (purpose === 'stop-analysis') {
    const f = await e4ManagedFixture(t, 'fact', { priorNoProgress: 2 });
    await payNoProgress(f, []);
    series = f.store.get<RepairSeries>(f.series.id)!;
    assert.deepEqual(series.value.stop?.attempts, [1, 2, 3]);
    base = f; basis = { kind: 'series-stop', series: reference(series), attempt: 3 };
  } else {
    const f = runFixture(t, [], 'executed');
    valueOf(startRun(f.store, { project: 'garden' }));
    const held = await regatedHold(f, { cycle: (packet, batch) => batch.task === 'node-expansion' && batch.level === 3
      ? defectedWork(f, reference(packet)) : null, pause: { step: 'analyze' } });
    const step = held.second!.step!.request as { hold: Ref };
    const hold = f.store.get<OriginHold>(step.hold.id, step.hold.revision)!;
    assert.equal(hold.value.lift, null);
    series = f.store.get<RepairSeries>(hold.value.series.id, hold.value.series.revision)!;
    base = Object.assign(f, { project: 'garden' }); basis = { kind: 'origin-hold', hold: reference(hold) };
  }
  const { root, database, project } = base, address = seriesRequestOf(series.value);
  const preparationCalls = base.store.list<ModelCall>('model-call').map(reference);
  // The analysis has a separate wire trace/scenario; its assertions cannot count the paid preparation as A6 traffic.
  const scenario = join(root, 'managed-analysis-scenario.json'), trace = join(root, 'managed-analysis-trace.jsonl');
  const command = { executable: process.execPath, args: [fixturePath, '--scenario', scenario, '--trace', trace] };
  const environment = new Environments(base.store).configure(project, { workspace: root,
    implementer: { actor: 'analysis-executor', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'analysis-reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs }, base.store.get(`environment:${project}`)!.revision);
  const adapter = base.store.write({ id: `adapter:${project}:managed-analysis`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: project, protocol: 'codex-stdio' } });
  const packet = { task: 'Diagnose the named ground', note: 'No fabricated A6 protocol', basis } as unknown as Json;
  const goal = { key: purpose, questions: ['What caused this ground?'], result: 'A cause or explicit hypothesis with an addressed change' };
  const attempt = purpose === 'stop-analysis' ? 3 : series.value.attempts.at(-1)!.ordinal;
  const admitted = valueOf(recordCall(base.store, project, { call: `e4:managed:${purpose}`, purpose, basis, block: series.value.block,
    gaps: [{ id: purpose, goal: purpose, field: 'cause-and-change', consumer: 'A6:stop-analysis' }], series: reference(series), attempt, goal,
    dispatch: { adapter: reference(adapter), config: reference(environment) }, packet }));
  const request: ModelTransportRequest = { project, call: reference(admitted.call), packet, role: 'reviewer' };
  writeFileSync(scenario, JSON.stringify({ steps: [{ research: { cause: 'fixture observation', hypothesis: true }, usage, confirmed }] }));
  return { root, database, scenario, trace, project, packet, request, series, address, environment, basis, preparationCalls,
    get store() { return base.store; }, restart() { base.restart(); },
    sent() { return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean) : []; } };
}



// A stopped process can leave any durable prefix of the cycle. The assertions cover every
// writeMany commit, including admission/claim before spawning and accounting after application.
export const cycleCommitPhases = ['admitted', 'running', 'authorized', 'received', 'applied', 'settled', 'cycle'] as const;


export type CycleCommitPhase = typeof cycleCommitPhases[number] | 'source' | 'deliveries' | 'continuation' | 'assembly' | 'application-refused';


export function cycleCommitPhase(writes: Write[]): CycleCommitPhase {
  const runtime = writes.find(write => write.kind === 'model-call');
  if (runtime) {
    const body = runtime.value as unknown as OmModelCall;
    if (body.status === 'running') return body.execution?.phase === 'authorized' ? 'authorized' : 'running';
    assert.ok(body.om.application);
    assert.notEqual(body.om.application, 'running');
    return body.om.application as 'received' | 'applied' | 'application-refused';
  }
  const call = writes.find(write => write.kind === 'call-record');
  if (call) return call.expected === 0 ? 'admitted' : 'settled';
  if (writes.some(write => write.kind === 'om-model-cycle')) return 'cycle';
  if (writes.some(write => write.kind === 'question-packet')) return 'continuation';
  if (writes.some(write => write.kind === 'om-read-delivery-set')) return 'deliveries';
  if (writes.some(write => write.kind === 'om-part-assembly')) return 'assembly';
  if (writes.every(write => write.kind === 'source')) return 'source';
  assert.fail(`Uncovered durable cycle transaction: ${writes.map(write => write.kind).join(', ')}`);
}


export function e4CannotAnswer(f: ReturnType<typeof e4Fixture>) {
  return { protocol: '$answerProtocol', requestId: '$requestId', action: 'cannot_answer',
    questionIds: [f.batch.items[0]!.gap], reason: 'The requested fact is unavailable in the named source' };
}



export type FixtureCheckpoint = { pid: number; parent: number; writes?: Write[] };


export type DriverCheckpoint = { path: string; kind: string; matches: { path: string[]; value: Json }[]; when?: 'before' };


export function fixtureDriver(t: TestContext, database: string, root: string, operation: 'call' | 'transport',
  request: ModelCallRequest | ModelTransportRequest, checkpoint?: DriverCheckpoint) {
  const spec = join(root, 'driver.json'), output = join(root, 'driver-output.json');
  writeFileSync(spec, JSON.stringify({ database, output, operation, request, ...(checkpoint ? { checkpoint } : {}) }));
  const child = spawn(process.execPath, [fixturePath, '--driver', spec], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr!.on('data', data => { stderr += data.toString(); }); child.stdout!.resume();
  const exit = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
  });
  return { child, exit, output, errors: () => stderr };
}


export async function fixtureCheckpoint(path: string, child: ChildProcess): Promise<FixtureCheckpoint> {
  if (!existsSync(path)) await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(deadline); watcher.close(); child.off('exit', ended); };
    const ended = () => { stop(); reject(new Error(`Fixture driver exited before checkpoint ${path}`)); };
    const watcher = watch(dirname(path), () => { if (existsSync(path)) { stop(); resolve(); } });
    const deadline = setTimeout(() => { stop(); reject(new Error(`Fixture checkpoint was not reached: ${path}`)); }, 20_000);
    child.once('exit', ended);
    if (existsSync(path)) { stop(); resolve(); }
  });
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureCheckpoint;
}


export async function killFixtureDriver(driver: ReturnType<typeof fixtureDriver>) {
  assert.equal(driver.child.exitCode, null); assert.equal(driver.child.signalCode, null);
  assert.equal(driver.child.kill('SIGKILL'), true); await driver.exit;
}


export function signalFixtureProvider(pid: number, started: string): boolean {
  // EOF after owner loss may let the supplier exit before cleanup reaches it.
  // A gone/reused PID is never signalled; ESRCH also means it exited in this window.
  if (processStart(pid) !== started) return false;
  try { process.kill(pid, 'SIGKILL'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}


export async function killFixtureProvider(pid: number, started: string) {
  if (!signalFixtureProvider(pid, started)) return;
  const deadline = Date.now() + 10_000;
  while (processStart(pid) === started) {
    assert.ok(Date.now() < deadline, 'The killed fixture provider must terminate');
    await fixtureDelay(10);
  }
}


export function publicRecovery(store: Store, project: string, record: Ref): Revision<ModelCall> {
  return new ProductEngine(store).execute({ type: 'recover-model-call', project, call: record }) as Revision<ModelCall>;
}


export function refusesLiveRecovery(store: Store, project: string, record: Ref) {
  assert.throws(() => publicRecovery(store, project, record),
    (error: unknown) => error instanceof EngineError && error.code === 'model_call_still_running');
}


export function ensureFixtureProject(store: Store, project: string) {
  if (!store.get(`project:${project}`)) store.write({ id: `project:${project}`, kind: 'project', expected: 0,
    value: { id: project, title: 'Local physical recovery fixture' } });
}



export function completionSnapshot(f: ReturnType<typeof e4Fixture>) {
  const binding = valueOf(readCompletionBinding(f.store, f.project, reference(f.series), f.packetRequest.attempt!.ordinal))!;
  return valueOf(readCompletionWorkAt(f.store, f.project, reference(f.store.get(completionWorkId(f.project, binding.id))!)));
}



export function completionE1(f: ReturnType<typeof e4Fixture>, packet = f.packet, config = f.configured) {
  const payload = packet.value.packet as Record<string, Json> & { requestId: string; purpose: 'model-research' | 'model-design' };
  return { call: payload.requestId, purpose: payload.purpose, basis: null, block: f.series.value.block!,
    series: reference(f.series), attempt: 1, goal: f.series.value.attempts[0]!.goal,
    dispatch: { adapter: reference(f.adapter), config: reference(config) }, packet: payload,
    gaps: f.batch.items.flatMap(item => item.consumers.map(consumer => ({ id: item.target, goal: item.target, field: item.field, consumer }))) };
}



export const h15CannotAnswer = { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'cannot_answer', code: 'cannot_answer', message: 'never needed' };


export const h15Heads = (store: Store) => store.list().map(reference);


export function h15Refusal<T>(result: OmResult<T>) { if (result.ok) assert.fail('Expected a typed refusal, not a paid or replayed call'); return result.refusal; }


/** Records every kind written while `action` runs: a refusal before E1, the claim and the authorization writes nothing at all. */
export async function h15Written<T>(store: Store, action: () => Promise<T>): Promise<{ result: T; kinds: string[] }> {
  const kinds: string[] = [], writeMany = store.writeMany.bind(store);
  store.writeMany = ((inputs, guards) => { kinds.push(...inputs.map(input => input.kind)); return writeMany(inputs, guards); }) as Store['writeMany'];
  try { return { result: await action(), kinds }; } finally { store.writeMany = writeMany; }
}


export const h15Unserved = { code: 'route_result_unsupported', unit: 'E4', target: 'discovery:spare', field: 'answer', route: 'producer' };



/**
 * Runs a producer script with every engine module loaded from one exact commit, in its own process (the era check of
 * test/om-answers-gate.test.ts): the loader serves each module from Git and refuses an engine module outside the commit,
 * so a missed prefix cannot fall back to the current build and let the test pass vacuously.
 */
export function h15AtCommit(f: { root: string; database: string }, commit: string, name: string, body: string, input: unknown): unknown {
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
    ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, f.database, argsFile],
    { cwd: repository, encoding: 'utf8', timeout: 180_000, maxBuffer: 10_000_000 }));
  const loaded = readFileSync(served, 'utf8').split('\n').filter(Boolean);
  assert.ok(loaded.includes('src/storage/store.ts') && loaded.includes('src/om/model-call.ts'),
    `The producer ran on the modules of ${commit}: ${loaded.join(', ')}`);
  return output;
}



// ---- LP4 (№2887): the remaining work of a cycle that a proved cessation of its own step forbids ----
/** A need_source of a node packet, for the exact questions of that packet. */
export const lp4Need = (f: ReturnType<typeof e4Fixture>, packet: { value: { packet: unknown } }) => ({
  ...e4NeedSource(f, [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }]),
  questionIds: (packet.value.packet as { questions: { id: string }[] }).questions.map(row => row.id) });


/** The node fixture's own step, paid with an applied need_source, then ceased on the step's own ground (another capacity). */
export async function lp4CeasedStep(f: ReturnType<typeof e4Fixture>, request: ModelCallRequest = f.request) {
  const { writeCompletionCessation } = await import('../src/om/model-call.js');
  const first = valueOf(await runModelCall(f.store, request));
  assert.equal(first.outcome?.kind, 'need-source');
  return { first, owner: first.record.value.om.completionOwner!, cease: () => {
    const owner = first.record.value.om.completionOwner!;
    const step = valueOf(writeCompletionCessation(f.store, { project: f.project, binding: owner.binding, assignment: owner.assignment }));
    assert.deepEqual([step.value.disposition, step.value.remainder, step.value.cause.kind], ['branch-ceased', 'continuation', 'required-record-replaced']);
    return step;
  } };
}


export const lp4Root = (f: ReturnType<typeof e4Fixture>) => completionSnapshot(f).assignments.find(row => row.value.kind === 'root')!;


/** A node answer the engine refuses for one repairable reason: an unissued slot label (answer_label_unknown). */
export function mp2Refused(f: ReturnType<typeof e4Fixture>, packet: Revision<QuestionPacketRecord> = f.packet as Revision<QuestionPacketRecord>) {
  const answer = e4Node(f, packet);
  answer.proposal.fills = answer.proposal.fills.map((fill, index) => index === 0 ? { ...fill, obligation: 'X999' } : fill);
  return answer;
}


/** The applied outcome of one saved step of a cycle. */
export function mp2Step(f: ReturnType<typeof e4Fixture>, step: { record: Ref }) {
  const state = valueOf(readModelCallState(f.store, { project: f.project, record: step.record }));
  if (state.state !== 'applied') assert.fail(`Expected an applied call, got ${state.state}`);
  return state.outcome;
}


export const mp2Managed = (t: TestContext, capacity = 100_000, retry = false) => e4Fixture(t, 'node', capacity, 0, 1000, true, true, false, undefined, undefined, retry);



/** The cycle stops after the correction call's durable boundary: the second of its kind, the first being the refused call's. */
export async function mp2StopAfter(f: ReturnType<typeof e4Fixture>, boundary: 'admitted' | 'running' | 'received' | 'applied') {
  const phaseOf = (writes: Write[]) => {
    const runtime = writes.find(write => write.kind === 'model-call')?.value as unknown as OmModelCall | undefined;
    if (runtime) return runtime.status === 'running' ? runtime.execution?.phase === 'authorized' ? 'authorized' : 'running' : runtime.om.application;
    return writes.some(write => write.kind === 'call-record' && write.expected === 0) ? 'admitted' : null;
  };
  const writeMany = f.store.writeMany.bind(f.store);
  let seen = 0;
  f.store.writeMany = ((writes, guards) => {
    const committed = writeMany(writes, guards);
    if (writes.length && phaseOf(writes) === boundary && ++seen === 2) throw new Error('MP2 stop after the correction boundary');
    return committed;
  }) as Store['writeMany'];
  try { await assert.rejects(mp2Cycle(f.store, f.request), /MP2 stop after the correction boundary/); }
  finally { f.store.writeMany = writeMany; }
}


export const MP3_NOTES = 'Line one: UTF-8 is the encoding.\nLine two: Кириллица 😀 stays.\nLine three: end.';


export const MP3_CONFIG = '{"format":"json","list":[1,2],"nested":{"a":1}}';


export const MP3_LARGE = 'Large carried line.\n'.repeat(3000);


export function mp3Cycle(t: TestContext, kind: 'fact' | 'node' = 'fact', capacity = 100_000, managed = false) {
  const f = e4Fixture(t, kind, capacity, 0, 5000, managed, true, false, undefined, mp3Material);
  return mp3Materials(f);
}

function mp3Material(store: Store, project: string, root: string) {
  writeFileSync(join(root, 'mp3-notes.txt'), MP3_NOTES);
  new Evidence(store).file(project, 'mp3-notes', root, 'mp3-notes.txt', 'text/plain', 0);
  new Evidence(store).document(project, 'mp3-config', MP3_CONFIG, 'application/json', 0);
  writeFileSync(join(root, 'mp3-large.txt'), MP3_LARGE);
  new Evidence(store).file(project, 'mp3-large', root, 'mp3-large.txt', 'text/plain', 0);
  new Evidence(store).document(project, 'mp3-empty', '', 'text/plain', 0);
}

/** MP3 materials on an explicitly managed carrier, including any paid previous ordinals. */
export async function mp3ManagedCycle(t: TestContext, kind: 'fact' | 'node' = 'fact', options: Omit<ManagedFixtureOptions, 'material'> = {}) {
  return mp3Materials(await e4ManagedFixture(t, kind, { ...options, material: mp3Material }));
}

function mp3Materials<F extends ManagedE4Fixture>(f: F) {
  const notes = f.store.get<Source>(`source:${f.project}:mp3-notes`)!, config = f.store.get<Source>(`source:${f.project}:mp3-config`)!;
  const large = f.store.get<Source>(`source:${f.project}:mp3-large`)!, empty = f.store.get<Source>(`source:${f.project}:mp3-empty`)!;
  const range = (start: number, end: number, source: Revision<Source> = notes) => ({ action: 'read_source', source: reference(source), selector: { kind: 'text-range', start, end } });
  const pointer = (value: string) => ({ action: 'read_source', source: reference(config), selector: { kind: 'json-pointer', pointer: value } });
  const packets = () => f.store.list<QuestionPacketRecord>('question-packet');
  const payload = (requestId: string) => packets().find(row => (row.value.packet as { requestId?: string } | null)?.requestId === requestId)!.value.packet as Record<string, any>;
  const need = (reads: unknown[], packet: { value: { packet: unknown } } = f.packet) => ({ ...e4NeedSource(f, reads),
    questionIds: (packet.value.packet as { questions: { id: string }[] }).questions.map(row => row.id) });
  return { f, notes, config, large, empty, range, pointer, packets, payload, need, length: MP3_NOTES.length };
}


export const mp3Readings = (packet: unknown): BriefReadings => { const value = briefReadings(packet); assert.ok(value, 'The packet is of the readings era'); return value; };


export const mp3Decisions = (packet: unknown) => mp3Readings(packet).entries.map(entry => 'reason' in entry.decision ? entry.decision.reason : entry.decision.state);



/** G7 closes a managed attempt of the MP3 fixture on the refusals of its complete registry; the next one keeps the full goal. */
export function mp3Close(f: ReturnType<typeof e4Fixture>, ordinal: number, reason: 'refused' | 'off-form' | 'interrupted' = 'refused') {
  const series = f.store.get<RepairSeries>(f.series.id)!;
  const binding = valueOf(readCompletionBinding(f.store, f.project, reference(series), ordinal))!;
  const work = valueOf(readCompletionWorkAt(f.store, f.project, reference(f.store.get(completionWorkId(f.project, binding.id))!)));
  assert.equal(work.complete, true);
  return valueOf(closeAttempt(f.store, { ...seriesRequestOf(series.value), attempt: ordinal, outcome: { reason, accepting: [], cancelling: [], refusals: work.refusals } }));
}


export function mp3Open(f: ReturnType<typeof e4Fixture>, ordinal: number, environment: Ref = reference(f.configured)) {
  const current = f.store.get<RepairSeries>(f.series.id)!, goal = current.value.attempts[0]!.goal;
  const series = valueOf(managedOpenAttempt(f.store, { ...seriesRequestOf(current.value), attempt: ordinal, goal,
    completion: { routes: reference(f.routes), batches: [f.batch.id] } } as never));
  const request: QuestionPacketRequest = { ...f.packetRequest, environment, attempt: { series: reference(series), ordinal } };
  return { series, request, root: () => valueOf(writeQuestionPacket(f.store, request)).record };
}


export const mp3Carried = (packet: { value: { packet: unknown } }) => {
  const text = packetPrompt(packet.value.packet), at = text.indexOf('\n# Carried reads');
  return at < 0 ? [] : JSON.parse(text.slice(at).split('\n')[3]!) as { origins: unknown[]; read: Record<string, unknown>; data: Record<string, unknown> }[];
};


export const mp3Origins = (packet: { value: { packet: unknown } }) => mp3Readings(packet.value.packet).entries.map(entry => entry.origins.map(origin =>
  origin.kind === 'attempt' ? `attempt ${origin.ordinal}` : `part ${origin.position}`));



/** An attempt 1 of the managed MP3 fixture that delivered the given reads and was refused, then closed by G7. */
export async function mp3Delivered(t: TestContext, reads: (m: ReturnType<typeof mp3Cycle>) => unknown[], capacity = 100_000) {
  const m = mp3Cycle(t, 'fact', capacity, true), { f } = m;
  const script: Record<string, unknown>[] = [{ research: m.need(reads(m)), usage }, { research: e4CannotAnswer(f), usage }];
  f.steps(script);
  valueOf(await runModelCycle(f.store, f.request)); mp3Close(f, 1);
  return { ...m, script, run: (steps: Record<string, unknown>[]) => { script.push(...steps); f.steps(script); } };
}



// MP3 row 18 with the MP2 correction: a correction is a step of its root's chain — the root era and the carried set of the step it
// corrects; the walk back over a part chain passes through a correction to the reads before it.
export function mp3Parts(t: TestContext) {
  const m = mp3Cycle(t, 'node', 100_000, true), { f } = m, config = f.environment(currentPacketWire(f.packet.value.packet) - 1);
  const packet = valueOf(writeQuestionPacket(f.store, { ...f.packetRequest, environment: reference(config) })).record as Revision<QuestionPacketRecord>;
  assert.equal(packet.value.plan!.mode, 'parts'); const total = packet.value.plan!.assignments.length; assert.ok(total >= 2);
  const at = (position: number) => ({ ...packet, value: { ...packet.value, plan: { ...packet.value.plan!, position } } }) as Revision<QuestionPacketRecord>;
  const request = { ...f.request, packet: reference(packet), dispatch: { ...f.request.dispatch, config: reference(config) } };
  const steps = (cycle: { record: { value: { steps: readonly { packet: Ref }[] } } }) => cycle.record.value.steps.map(step => valueOf(readQuestionPacket(f.store, { project: f.project, record: step.packet })));
  return { m, f, packet, total, at, request, steps };
}


export const MP3_EMPTY_SEARCH = { action: 'search', within: 'empty-search', query: 'absent' };


export const mp3SearchDelivery = (f: ReturnType<typeof e4Fixture>) => f.store.list<{ read: { action: string }; sources: unknown[]; data: unknown }>('om-read-delivery')
  .find(row => row.value.read.action === 'search')!;


// MP3 round 3 (Codex-omg №3190): a carried search over a workspace path is current only while the producer's own walk finds
// exactly its delivered files — an empty directory included; before the selection a moved scope omits the whole delivery,
// after it the current admission refuses; history keeps the saved choice without walking the disk.
export async function mp3ScopeAttempt(t: TestContext, files: Record<string, string>) {
  const m = mp3Cycle(t, 'fact', 100_000, true), { f } = m;
  mkdirSync(join(f.root, 'scope'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(f.root, 'scope', name), content);
  f.steps([{ research: m.need([{ action: 'search', within: 'scope', query: 'newneedle' }, m.range(0, 9)]), usage }, { research: e4CannotAnswer(f), usage }]);
  valueOf(await runModelCycle(f.store, f.request));
  const search = mp3SearchDelivery(f);
  assert.equal(search.value.sources.length, Object.keys(files).length); assert.deepEqual(search.value.data, []);
  mp3Close(f, 1);
  return { f, search, second: mp3Open(f, 2) };
}


export const mp3DecisionOf = (packet: { value: { packet: unknown } }, delivery: { id: string }) => {
  const entry = mp3Readings(packet.value.packet).entries.find(row => row.origins.some(origin => origin.delivery.id === delivery.id))!;
  return 'reason' in entry.decision ? entry.decision.reason : entry.decision.state;
};


export const MP3_SCOPES = [['empty directory', {}], ['non-empty directory', { 'a.txt': 'alpha' }]] as const;



export const readsOf = (action: () => unknown): number => { const before = storeReads(); action(); return storeReads() - before; };

