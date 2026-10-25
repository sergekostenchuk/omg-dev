import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { canonical, digest, hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision, type Write } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { projectGraph } from '../src/graph/project.js';
import type { Graph } from '../src/graph/model.js';
import { git } from '../src/runtime/environment.js';
import { explicitMapping, gardenGraph, prepareOmFixtureStages } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { writeOmInput } from '../src/om/input.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { prepareQuestionTasks, writeQuestionPacket, type PartProposalBody, type QuestionPacketRecord, type QuestionPacketRequest } from '../src/om/question-packet.js';
import { writeRoutes } from '../src/om/routes.js';
import { beginAttempt, completeAttempt, openSeries } from '../src/om/series.js';
import { gapLineExpectedResult, gapLineKey, writeGapLines } from '../src/om/gap-lines.js';
import { prepareFrameProposals, type LayerProposal } from '../src/om/frame-proposals.js';
import { prepareFrame, type FrameRequest, type FrameScope } from '../src/om/frame-obligations.js';
import { writeCandidate } from '../src/om/frame-candidate.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import { normalizeOwnerGapAssignment, OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND, writeOmObligations } from '../src/om/obligations.js';
import { taskBindingId } from '../src/graph/task-obligations.js';
import type { CarriedObligation } from '../src/graph/obligation-policy.js';
import { adapterRequest, runModelCycle, type ModelCallRequest } from '../src/om/model-call.js';
import { advanceRun, startRun, type RunRequest } from '../src/om/run.js';
import { writeRunBases } from '../src/om/run-bases.js';
import type { OmResult } from '../src/om/refusal.js';
import { parseProbeArgs, probeCommand, replayVerdict, runProbe, wireDifference, PROBE_CODES, PROBE_REPORT_FORMAT, PROBE_USAGE,
  type PointReport, type ProbeOptions, type ProbeReport } from '../src/om/probe.js';

// PR1 (№2943). Every fixture below is made by the engine's own producers; the probe only ever reads a copy of it.

const { fixtureAnswer } = await import(new URL('../../test/om-adapter-fixture.mjs', import.meta.url).href);
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const PROJECT = 'garden';
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
// The probe copies its source into the OS temp directory. This file's process and every probe it starts get a temp directory
// of their own: a probe of another process is never counted here, and the copy of a probe killed on purpose goes with it.
const PRIVATE_TMP = realpathSync(mkdtempSync(join(tmpdir(), 'omg-pr1-tmp-')));
process.env.TMPDIR = PRIVATE_TMP;

/** The adapter stand-in: it records the exact stdin, directory and arguments, then answers by its scripted cursor. */
const STUB = String.raw`import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureResearch } from ${JSON.stringify(new URL('../../test/om-adapter-fixture.mjs', import.meta.url).href)};
const dir = process.argv[2];
const stdin = readFileSync(0, 'utf8');
mkdirSync(join(dir, 'records'), { recursive: true });
const sequence = readdirSync(join(dir, 'records')).length;
const pending = join(dir, 'records', String(sequence).padStart(5, '0') + '-' + process.pid + '.tmp');
writeFileSync(pending, JSON.stringify({ stdin, cwd: process.cwd(), argv: process.argv.slice(2), pid: process.pid }));
const { renameSync } = await import('node:fs');
renameSync(pending, pending.replace(/\.tmp$/, '.json'));
const scenario = existsSync(join(dir, 'scenario.json')) ? JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')) : { steps: [] };
const cursor = existsSync(join(dir, 'cursor')) ? Number(readFileSync(join(dir, 'cursor'), 'utf8')) : 0;
writeFileSync(join(dir, 'cursor'), String(cursor + 1));
const step = scenario.steps[cursor];
if (!step) { process.stderr.write('Missing scenario step ' + cursor + '\n'); process.exit(2); }
let request = null; try { request = JSON.parse(stdin); } catch { request = null; }
const requestId = request && typeof request.requestId === 'string' ? request.requestId : null;
if (step.delayMs) await new Promise(resolve => setTimeout(resolve, step.delayMs));
if (step.stderr) process.stderr.write(step.stderr);
if (Object.hasOwn(step, 'rawStdout')) process.stdout.write(step.rawStdout);
else process.stdout.write(JSON.stringify({ protocol: 'omg-agent/v1', requestId, research: fixtureResearch(request, step.research, scenario.database), usage: step.usage ?? null,
  confirmed: step.confirmed ?? { model: null, effort: null, speed: null } }) + '\n');
process.exitCode = step.exitCode ?? 0;
`;
interface StubRecord { stdin: string; cwd: string; argv: string[]; pid: number }
function stubRecords(stubDir: string): StubRecord[] {
  const folder = join(stubDir, 'records');
  return existsSync(folder) ? readdirSync(folder).filter(name => name.endsWith('.json')).sort()
    .map(name => JSON.parse(readFileSync(join(folder, name), 'utf8')) as StubRecord) : [];
}
function script(stubDir: string, steps: Record<string, unknown>[], database: string): void {
  writeFileSync(join(stubDir, 'scenario.json'), JSON.stringify({ steps, database })); writeFileSync(join(stubDir, 'cursor'), '0');
}

/** The engine modules the garden recipe uses. */
const RECIPE = { Store, ProductEngine, reference, gardenGraph, preparedFeatures, preparedField, UPSTREAM_STAGES, projectGraph, writeOmInput,
  writeAddressing, inputDecisionWrite, writeHorizon, writeGaps, prepareQuestionTasks, writeRoutes, openSeries, beginAttempt, completeAttempt,
  gapLineKey, gapLineExpectedResult, writeQuestionPacket, runModelCycle, prepareFrameProposals, writeFileSync, mkdirSync, symlinkSync, mkdtempSync,
  join, tmpdir, execPath: process.execPath, STUB };
type RecipeModules = typeof RECIPE;
interface GardenData {
  root: string; database: string; stubDir: string; outside: string; environment: Ref; adapter: Ref;
  packets: Record<string, Ref>; calls: Record<string, string[]>; answers: Record<string, Json>; batches: Record<string, string>;
  questions: Record<string, string[]>;
}

/**
 * The garden fixture through the engine's own producers. Self-contained on purpose: it touches only `m` and its arguments.
 *  facts: MC1 with a call refused for a read path that leaves the workspace (attempt 1) and an answered call (attempt 2),
 *         an L2 node call through a source continuation, and a blocked packet of a later, too small environment.
 *  fields: an M5 input-field call and L2 node packets of both blocks, one more of the producer under a relative-path adapter.
 */
async function gardenRecipe(m: RecipeModules, root: string, plan: 'facts' | 'fields'): Promise<GardenData> {
  const ok = <T>(result: OmResult<T>): T => {
    if (!result.ok) throw new Error(`${result.refusal.code} ${result.refusal.at.target}.${result.refusal.at.field ?? ''}: ${result.refusal.message}`);
    return result.value;
  };
  const project = 'garden', database = m.join(root, 'state.sqlite'), store = new m.Store(database), engine = new m.ProductEngine(store);
  const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
  try {
    const graphData = m.gardenGraph('cross');
    graphData.nodes.find(node => node.id === 'garden-produce-block')!.ports.push({ id: 'out-side', direction: 'out', contract: 'garden-contract' });
    graphData.nodes.find(node => node.id === 'garden-consume-block')!.ports.push({ id: 'in-side', direction: 'in', contract: 'garden-contract' });
    graphData.connectors.push({ id: 'garden-side-flow', artifact: 'garden-data', returnsTo: 'garden-produce-block', wakeTest: null,
      bindings: [{ level: 1, producer: { node: 'garden-produce-block', port: 'out-side' }, consumers: [{ node: 'garden-consume-block', port: 'in-side' }], anchor: null }] });
    const { level: _level, ...l1 } = m.projectGraph(graphData, 1);
    m.preparedFeatures(engine, project, l1 as never, field => {
      const value = m.preparedField(project, field) as Record<string, unknown>;
      if (field === 'preparation') value.unknowns = [{ id: 'encoding', question: 'What encoding is supported?', consumer: 'garden-consume-block',
        moment: 'om-pass', blocksCurrentStage: false, resolution: 'Resolve the addressed question during OM' }];
      return value as never;
    });
    const stages = Object.fromEntries(m.UPSTREAM_STAGES.map(stage => [stage, m.reference(store.get(`stage:${project}:${stage}`)!)]));
    const base = ok(m.writeOmInput(store, { project, expected: 0, stages: stages as never })), graph = store.get<Record<string, any>>(`graph:${project}`)!; // eslint-disable-line @typescript-eslint/no-explicit-any
    const input = plan === 'fields' ? base : ok(m.writeAddressing(store, { project, input: m.reference(base), graph: m.reference(graph),
      decisions: [{ pending: structuredClone(m.inputDecisionWrite({ project, input: m.reference(base), graph: m.reference(graph), layers: [],
        decision: { target: 'discovery:encoding', field: 'address', value: { consumer: 'garden-consume-block', kind: 'repository-fact' } } })) as never }] }));
    const horizon = ok(m.writeHorizon(store, { project, input: m.reference(input), graph: m.reference(graph), refinement: null, available: {},
      choice: { choiceVersion: 'pr1-fixture', features: [{ outcome: 'garden-result' }], excluded: [] } }));
    const sources = { project, input: m.reference(input), graph: m.reference(graph), horizon: m.reference(horizon.gate),
      operations: { proposals: [], frame: { project, level: 2, graph: m.reference(graph), horizon: m.reference(horizon.gate), layer: null, frame: null, upper: null } },
      works: { state: 'upper-not-accepted', layer: m.reference(store.get(`graph-layer:${project}:2`)!) } };
    const gaps = ok(m.writeGaps(store, sources as never));
    const gapRequest = { sources: structuredClone(gaps.sources), records: gaps.records.map(row => m.reference(row)) };
    const tasks = ok(m.prepareQuestionTasks(store, { project, gaps: gapRequest as never,
      questions: gaps.records.filter(row => row.value.gap.kind === 'repository-fact' && row.value.gap.code !== 'inventory_missing' && !row.value.gap.deferral)
        .map(gap => ({ gap: m.reference(gap), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) }));
    const source = store.get<{ content: string }>(`source:${project}:brief`)!;
    const routes = ok(m.writeRoutes(store, { project, gaps: gapRequest as never, tasks: tasks.tasks.map(task => ({ pending: structuredClone(task.writes[0]!) })),
      catalog: { paths: ['e4-source.txt'], records: [] }, previous: null }));
    m.writeFileSync(m.join(root, 'e4-source.txt'), 'UTF-8 is the supported encoding.');
    const outside = m.mkdtempSync(m.join(m.tmpdir(), 'omg-pr1-outside-'));
    m.writeFileSync(m.join(outside, 'x.txt'), 'outside the workspace');
    m.symlinkSync(outside, m.join(root, 'outside'));
    const stubPath = m.join(root, 'stub.mjs'), stubDir = m.join(root, 'stub');
    m.mkdirSync(stubDir); m.writeFileSync(stubPath, m.STUB);
    const steps = (list: unknown[]) => { m.writeFileSync(m.join(stubDir, 'scenario.json'), JSON.stringify({ steps: list, database })); m.writeFileSync(m.join(stubDir, 'cursor'), '0'); };
    const environment = (args: string[], capacity: number) => engine.environments.configure(project, { workspace: root,
      implementer: { actor: 'pr1-implementer', model: 'fixture', effort: 'high', speed: 'fast', command: { executable: m.execPath, args } },
      reviewer: { actor: 'pr1-reviewer', model: 'fixture-reviewer', effort: 'medium', command: { executable: m.execPath, args } },
      fullCheck: { executable: m.execPath, args: ['--version'] }, timeoutMs: 4000, requestCapacityChars: capacity },
    store.get(`environment:${project}`)?.revision ?? 0);
    const configured = environment([stubPath, stubDir], 100_000);
    const adapter = store.write({ id: `adapter:${project}:pr1`, kind: 'dispatch-adapter', expected: 0, value: { projectId: project, protocol: 'codex-stdio' } });
    const batches = routes.value.batches;
    const omCalls = () => store.list<Record<string, unknown>>('model-call').filter(row => row.id.startsWith(`model-call:${project}:om:`) && 'om' in row.value)
      .sort((a, b) => (a.value.startedAt as number) - (b.value.startedAt as number)).map(row => row.id);
    const goalOf = (batch: (typeof batches)[number]) => ({ key: `pr1:${batch.id}`, questions: batch.items.map(item => m.gapLineKey(project, item.target, item.field)),
      result: m.gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) });
    const packetOf = (batch: (typeof batches)[number], series: Ref, ordinal: number, config: Ref = m.reference(configured)) =>
      ok(m.writeQuestionPacket(store, { project, routes: m.reference(routes), batch: batch.id, environment: config, attempt: { series, ordinal }, previous: [] })).record;
    const callOf = (packet: Ref, config: Ref = m.reference(configured)) => ({ project, packet, dispatch: { adapter: m.reference(adapter), config }, role: 'implementer' as const });
    const frame = ok(m.prepareFrameProposals(store, sources.operations as never));
    const nodeAnswer = (batch: (typeof batches)[number], suffix: string, extraInput: boolean, from = frame) => {
      const obligations = from.frame.result.obligations.filter(item => item.upper.node === batch.node);
      const upper = graph.value.nodes.find((node: { id: string }) => node.id === batch.node);
      const ports = obligations.filter(item => item.kind === 'connection-end').map((item, index) => ({ id: `part-port-${index}`,
        direction: item.role === 'producer' ? 'out' : 'in', contract: graph.value.artifacts.find((artifact: { id: string }) => artifact.id === item.artifact).contract }));
      // A port no connector binds passes every slot check and fails only the late check of a complete assembly.
      if (extraInput) ports.push({ id: 'part-port-unbound', direction: 'in', contract: ports[0]!.contract });
      const node = { ...structuredClone(upper), id: `${batch.node}-${suffix}`, kind: 'operation', parent: upper.id, title: `Expansion ${suffix}`, ports, code: [], tests: [] };
      let port = 0;
      return { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer', proposal: { nodes: [node],
        fills: obligations.map(item => ({ obligation: item.id, node: node.id, ...(item.kind === 'connection-end' ? { port: node.ports[port++]!.id } : {}) })),
        localConnectors: [], artifacts: [], contracts: [], joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
        removes: [], replaces: [], redefines: [] } };
    };
    const blockSeries = (block: string, batch: (typeof batches)[number]) => {
      m.openSeries(store, { project, block, line: 1, slice: `pr1-${block}`, predecessor: null, basis: null } as never);
      return ok(m.beginAttempt(store, { project, block, line: 1, attempt: 1, goal: goalOf(batch) } as never));
    };
    const data: GardenData = { root, database, stubDir, outside, environment: m.reference(configured), adapter: m.reference(adapter), packets: {}, calls: {}, answers: {},
      batches: {}, questions: {} };
    const node = (name: string) => batches.find(batch => batch.task === 'node-expansion' && batch.node === name)!;
    if (plan === 'facts') {
      const fact = batches.find(batch => batch.model === 'MC1' && batch.items.some(item => item.target === 'discovery:encoding'))!, produce = node('garden-produce-block');
      data.batches = { fact: fact.id, produce: produce.id };
      const factSeries = blockSeries('garden-consume-block', fact);
      const refusedPacket = packetOf(fact, m.reference(factSeries), 1);
      steps([{ research: { protocol: '$answerProtocol', requestId: '$requestId', action: 'need_source', questionIds: fact.items.map(item => item.gap),
        missing: 'The encoding table', reads: [{ action: 'read', path: 'outside/x.txt', media: 'text/plain' }] }, usage }]);
      await m.runModelCycle(store, callOf(m.reference(refusedPacket)));
      data.packets.factRefused = m.reference(refusedPacket); data.calls.factRefused = omCalls();
      const series = store.get<{ attempts: { ordinal: number; outcome: unknown }[] }>(factSeries.id)!;
      if (series.value.attempts.find(item => item.ordinal === 1)!.outcome === null)
        ok(m.completeAttempt(store, { project, block: 'garden-consume-block', line: 1, attempt: 1, outcome: { reason: 'result', achieved: [], cancelled: [], refusals: [] } } as never));
      const second = ok(m.beginAttempt(store, { project, block: 'garden-consume-block', line: 1, attempt: 2, goal: goalOf(fact) } as never));
      const factPacket = packetOf(fact, m.reference(second), 2);
      const factAnswer = { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer', results: [{ questionId: fact.items[0]!.gap, value: 'UTF-8',
        citations: [{ source: m.reference(source), selector: { kind: 'text-range', start: 0, end: source.value.content.length } }] }] };
      steps([{ research: factAnswer, usage }]);
      ok(await m.runModelCycle(store, callOf(m.reference(factPacket))));
      data.questions.fact = fact.items.map(item => item.gap);
      data.packets.fact = m.reference(factPacket); data.calls.fact = omCalls().filter(id => !data.calls.factRefused!.includes(id));
      const produceSeries = blockSeries('garden-produce-block', produce);
      const nodePacket = packetOf(produce, m.reference(produceSeries), 1);
      steps([{ research: { protocol: '$answerProtocol', requestId: '$requestId', action: 'need_source', questionIds: produce.items.map(item => item.gap),
        missing: 'The supported encoding', reads: [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }] }, usage },
      { research: nodeAnswer(produce, 'probe', false), usage }]);
      ok(await m.runModelCycle(store, callOf(m.reference(nodePacket))));
      data.packets.node = m.reference(nodePacket);
      data.calls.node = omCalls().filter(id => !data.calls.factRefused!.includes(id) && !data.calls.fact!.includes(id));
      const continuation = store.list<{ request: { continuation?: unknown } }>('question-packet').find(row => row.value.request.continuation);
      if (!continuation) throw new Error('The node cycle left no continuation packet');
      data.packets.nodeContinuation = m.reference(continuation);
      const small = environment([stubPath, stubDir], 50);
      data.packets.blocked = m.reference(packetOf(fact, m.reference(second), 2, m.reference(small)));
      data.answers = { node: nodeAnswer(produce, 'answer', false), fact: factAnswer } as unknown as Record<string, Json>;
    } else {
      const field = batches.find(batch => batch.model === 'MC2' && batch.task === 'input-field' && batch.items.some(item => item.target === 'discovery:encoding'))!;
      const produce = node('garden-produce-block'), consume = node('garden-consume-block');
      data.batches = { field: field.id, produce: produce.id, consume: consume.id };
      const produceSeries = blockSeries('garden-produce-block', produce), consumeSeries = blockSeries('garden-consume-block', consume);
      data.packets.produce = m.reference(packetOf(produce, m.reference(produceSeries), 1));
      data.packets.consume = m.reference(packetOf(consume, m.reference(consumeSeries), 1));
      // The same producer assignment under a later environment whose adapter path is relative: one more point of one frame.
      const relative = m.reference(environment(['stub.mjs', stubDir], 100_000));
      data.packets.produceRelative = m.reference(packetOf(produce, m.reference(produceSeries), 1, relative));
      const owner = { project, owner: { kind: 'mechanism', mechanism: 'M5:addressing' }, line: 1 };
      m.openSeries(store, { ...owner, scope: gapRequest, predecessor: null, basis: null } as never);
      const mechanism = ok(m.beginAttempt(store, { ...owner, attempt: 1, goal: goalOf(field),
        admission: { gaps: gapRequest, routes: m.reference(routes), batch: field.id } } as never));
      // The field call runs under that later environment: the engine starts the relative adapter in its workspace.
      const fieldPacket = packetOf(field, m.reference(mechanism), 1, relative);
      const fieldAnswer = { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer', results: field.items.map(item => ({ target: item.target, field: item.field,
        basis: item.record, value: { consumer: 'garden-consume-block', kind: 'repository-fact' } })) };
      steps([{ research: fieldAnswer, usage }]);
      ok(await m.runModelCycle(store, callOf(m.reference(fieldPacket), relative)));
      data.packets.field = m.reference(fieldPacket); data.calls.field = omCalls();
      // The same consumer routed again under a later horizon: its packet names other D1 sources, so it stands in another frame.
      const now = m.reference(store.get(input.id)!);
      const later = ok(m.writeHorizon(store, { project, input: now, graph: m.reference(graph), refinement: null, available: {},
        choice: { choiceVersion: 'pr1-fixture-later', features: [{ outcome: 'garden-result' }], excluded: [] } }));
      const laterSources = { ...sources, input: now, horizon: m.reference(later.gate),
        operations: { proposals: [], frame: { ...sources.operations.frame, horizon: m.reference(later.gate) } } };
      const laterGaps = ok(m.writeGaps(store, laterSources as never));
      const laterRequest = { sources: structuredClone(laterGaps.sources), records: laterGaps.records.map(row => m.reference(row)) };
      const laterTasks = ok(m.prepareQuestionTasks(store, { project, gaps: laterRequest as never,
        questions: laterGaps.records.filter(row => row.value.gap.kind === 'repository-fact' && row.value.gap.code !== 'inventory_missing' && !row.value.gap.deferral)
          .map(gap => ({ gap: m.reference(gap), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) }));
      const laterRoutes = ok(m.writeRoutes(store, { project, gaps: laterRequest as never, tasks: laterTasks.tasks.map(task => ({ pending: structuredClone(task.writes[0]!) })),
        catalog: { paths: ['e4-source.txt'], records: [] }, previous: null }));
      const consumeLater = laterRoutes.value.batches.find(batch => batch.task === 'node-expansion' && batch.node === 'garden-consume-block')!;
      data.packets.consumeLater = m.reference(ok(m.writeQuestionPacket(store, { project, routes: m.reference(laterRoutes), batch: consumeLater.id, environment: relative,
        attempt: { series: m.reference(consumeSeries), ordinal: 1 }, previous: [] })).record);
      const laterFrame = ok(m.prepareFrameProposals(store, laterSources.operations as never));
      data.answers = { produce: nodeAnswer(produce, 'answer', false), produceOther: nodeAnswer(produce, 'other', false),
        produceUnbound: nodeAnswer(produce, 'unbound', true), consume: nodeAnswer(consume, 'answer', false),
        consumeLater: nodeAnswer(consumeLater, 'answer', false, laterFrame), field: fieldAnswer } as unknown as Record<string, Json>;
    }
    return data;
  } finally { store.close(); }
}

/** One fixture per kind for the whole file: the probe never writes its source, so every test reads the same files. */
const built = new Map<string, Promise<unknown>>();
process.once('exit', () => { for (const directory of cleanup) rmSync(directory, { recursive: true, force: true }); });
const cleanup: string[] = [PRIVATE_TMP];
function once<T>(key: string, build: () => Promise<T>): Promise<T> {
  if (!built.has(key)) built.set(key, build());
  return built.get(key) as Promise<T>;
}
function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix)); cleanup.push(path); return realpathSync(path);
}
const facts = () => once('facts', async () => { const root = directory('omg-pr1-facts-'); const data = await gardenRecipe(RECIPE, root, 'facts'); cleanup.push(data.outside); return data; });
const fields = () => once('fields', async () => { const root = directory('omg-pr1-fields-'); const data = await gardenRecipe(RECIPE, root, 'fields'); cleanup.push(data.outside); return data; });

interface WorksData { root: string; database: string; stubDir: string; packet: Ref; calls: string[]; answers: Record<string, Json> }
/** A first works pass (C2/C4/C5 of L2, a D7 owner assignment) and one answered L3 call, as in the E4 works fixture. */
const works = () => once('works', async (): Promise<WorksData> => {
  const ok = <T>(result: OmResult<T>): T => { if (!result.ok) throw new Error(`${result.refusal.code}: ${result.refusal.message}`); return result.value; };
  const root = directory('omg-pr1-works-'), database = join(root, 'state.sqlite'), project = PROJECT;
  const store = new Store(database), engine = new ProductEngine(store);
  try {
    const desired = gardenGraph('cross'), { level: _level, ...l1 } = projectGraph(desired, 1);
    preparedFeatures(engine, project, l1 as Graph, field => {
      const value = preparedField(project, field);
      if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'late-proof', question: 'Which result proof must the concrete producer provide?',
        consumer: 'garden-produce-operation', moment: 'task-result', blocksCurrentStage: false, resolution: 'Retain the result proof for the concrete work' }];
      return value;
    });
    let input = ok(writeOmInput(store, { project, expected: 0,
      stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
    const initial = ok(writeHorizon(store, { project, input: reference(input), graph: reference(store.get(`graph:${project}`)!), refinement: null, available: {},
      choice: { choiceVersion: 'pr1-work-upper', features: [{ outcome: 'garden-result' }], excluded: [] } }));
    const frame2: FrameRequest = { project, level: 2, graph: reference(store.get(`graph:${project}`)!), horizon: reference(initial.gate), layer: null, frame: null, upper: null };
    const frame = ok(prepareFrame(store, frame2)), projected = projectGraph(desired, 2);
    const fills = explicitMapping(desired, frame.upper as Graph, frame.scope as FrameScope, 2);
    const nodes = projected.nodes.filter(node => node.kind === 'operation'), nodeIds = new Set(nodes.map(node => node.id));
    const proposalValue: LayerProposal = { base: { graph: frame.request.graph, frame: null }, level: 2, source: 'decision', status: 'proposed', nodes,
      fills: fills.fills.filter(fill => nodeIds.has(fill.node)).map(fill => ({ obligation: fill.obligation, node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }) })),
      localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
        .filter(connector => connector.bindings.length), artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, tests: projected.tests,
      edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [], anchors: projected.anchors,
      removes: [], replaces: [], redefines: [] };
    const proposal = store.write({ id: `om-proposal:${project}:pr1-work-upper`, kind: 'layer-proposal', expected: 0, value: proposalValue as unknown as Json });
    const candidate = ok(writeCandidate(store, { frame: frame2, proposals: [reference(proposal)] }));
    if (candidate.state !== 'candidate') throw new Error('Missing upper candidate');
    const accepted = ok(settleCandidate(store, { project, level: 2, candidate: reference(candidate.record), outcome: {
      gate: 'G3', candidate: reference(candidate.record), graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
    const graph = reference(accepted.graph!), layer2 = reference(accepted.layer!), upperFrame = reference(accepted.frame!);
    input = ok(writeAddressing(store, { project, input: reference(input), graph, decisions: [{ pending: inputDecisionWrite({ project, input: reference(input), graph,
      layers: [layer2], decision: { target: 'discovery:late-proof', field: 'address', value: { consumer: 'garden-produce-operation', kind: 'post-implementation-proof' } } }) as Write }] }));
    const horizon = ok(writeHorizon(store, { project, input: reference(input), graph, refinement: layer2, available: {},
      choice: { choiceVersion: 'pr1-work-pass', features: [{ outcome: 'garden-result' }], excluded: [] } }));
    const sources: GapRequest = { project, input: reference(input), graph, horizon: reference(horizon.gate),
      operations: { proposals: [], frame: { ...frame2, graph, horizon: reference(horizon.gate), layer: layer2, frame: upperFrame } },
      works: { proposals: [], frame: { project, level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null, upper: { horizon: reference(horizon.gate), frame: upperFrame } } } };
    const gaps = ok(writeGaps(store, sources)), gapRead = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
    const lines = ok(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
    const late = gaps.records.find(row => row.value.gap.target === 'discovery:late-proof')!;
    const assignment = normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project, context: { gaps: gapRead, lines: reference(lines) }, gap: reference(late),
      assignments: late.value.gap.consumers.map(consumer => ({ responsibleNode: 'garden-produce-operation', responsibleConsumer: consumer, reason: 'Retain the concrete result test',
        returnCondition: `Prove result for ${consumer}`, wake: null })) });
    const ledger = ok(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [{ pending: {
      id: `om-owner-gap-assignment:${project}:${hashJson(assignment)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value: assignment as unknown as Json } }] }));
    const routes = ok(writeRoutes(store, { project, gaps: gapRead, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
    const batch = routes.value.batches.find(item => item.level === 3 && item.node === 'garden-produce-operation')!;
    const address = { project, block: 'garden-produce-block', line: 1 };
    ok(openSeries(store, { ...address, slice: 'pr1-work', predecessor: null, basis: null }));
    const series = ok(beginAttempt(store, { ...address, attempt: 1, goal: { key: 'pr1-work', questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
      result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) } }));
    const stubPath = join(root, 'stub.mjs'), stubDir = join(root, 'stub');
    mkdirSync(stubDir); writeFileSync(stubPath, STUB);
    const command = { executable: process.execPath, args: [stubPath, stubDir] };
    const configured = engine.environments.configure(project, { workspace: root, implementer: { actor: 'pr1-work-producer', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'pr1-work-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: { executable: process.execPath, args: ['--version'] },
      timeoutMs: 4000, requestCapacityChars: 100_000 }, 0);
    const adapter = store.write({ id: `adapter:${project}:pr1-work`, kind: 'dispatch-adapter', expected: 0, value: { projectId: project, protocol: 'codex-stdio' } });
    const packetRequest: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(configured),
      attempt: { series: reference(series), ordinal: 1 }, previous: [], works: { producer: reference(ledger.producer), ledger: reference(ledger.record) } };
    const packet = ok(writeQuestionPacket(store, packetRequest)).record as Revision<QuestionPacketRecord>;
    const work = structuredClone(desired.nodes.find(node => node.id === 'garden-produce-work')!);
    const tests = structuredClone(desired.tests.filter(item => work.tests.includes(item.id)));
    const worksSource = gapRead.sources.works; if ('state' in worksSource) throw new Error('No works frame');
    const obligations = ok(prepareFrameProposals(store, worksSource)).frame.result.obligations.filter(item => item.upper.node === batch.node);
    const bindings = ledger.handoff.obligations.map(obligation => ({ id: taskBindingId(obligation as CarriedObligation), scope: obligation.scope,
      obligation: obligation.obligation, consumers: [{ node: work.id, tests: work.tests }] }));
    const answer = (withCodeRef: boolean) => {
      const proposal: PartProposalBody = { nodes: [work], tests, fills: obligations.map(item => ({ obligation: item.id, node: work.id,
        ...(item.kind === 'connection-end' ? { port: item.upper.port!, ...(withCodeRef ? { codeRef: work.code[0]! } : {}) } : {}) })),
      localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
      return { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer', proposal, bindings } as unknown as Json;
    };
    script(stubDir, [{ research: answer(true), usage }], database);
    ok(await runModelCycle(store, { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(configured) }, role: 'implementer' } as ModelCallRequest));
    const calls = store.list<Record<string, unknown>>('model-call').filter(row => row.id.startsWith(`model-call:${project}:om:`) && 'om' in row.value).map(row => row.id);
    return { root, database, stubDir, packet: reference(packet), calls, answers: { complete: answer(true), noCodeRef: answer(false) } };
  } finally { store.close(); }
});

interface RunData { root: string; database: string; packet: Ref }
/** A real pass (H1) driven by its own producer until it has saved its next cycle, which nobody has performed yet. */
const passed = () => once('run', async (): Promise<RunData> => {
  const ok = <T>(result: OmResult<T>): T => { if (!result.ok) throw new Error(`${result.refusal.code}: ${result.refusal.message}`); return result.value; };
  const root = directory('omg-pr1-run-'), database = join(root, 'state.sqlite'), workspace = join(root, 'repo'), project = PROJECT;
  mkdirSync(workspace); git(workspace, ['init', '-b', 'main']); writeFileSync(join(workspace, 'README.md'), 'PR1 pass repository\n');
  git(workspace, ['add', 'README.md']); git(workspace, ['-c', 'user.name=OMG Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  const store = new Store(database), engine = new ProductEngine(store);
  try {
    // LG13-pre2: current upstream stages only (L1, era ''); the pass's next cycle is its B1 input field, no layer is prebuilt.
    prepareOmFixtureStages(engine, project, gardenGraph(), field => {
      const value = preparedField(project, field);
      if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'encoding', question: 'Which encoding is supported?',
        consumer: 'garden-consume-block', moment: 'om-pass', blocksCurrentStage: false, resolution: 'Address this question during OM' }];
      return value;
    });
    const stubPath = join(root, 'stub.mjs'), stubDir = join(root, 'stub');
    mkdirSync(stubDir); writeFileSync(stubPath, STUB);
    const command = { executable: process.execPath, args: [stubPath, stubDir] };
    engine.environments.configure(project, { workspace, implementer: { actor: 'run-implementer', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'run-reviewer', model: 'fixture-reviewer', effort: 'medium', command }, fullCheck: { executable: process.execPath, args: ['--version'] },
      timeoutMs: 10_000, requestCapacityChars: 100_000 }, 0);
    const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
    const graph = reference(store.get(`graph:${project}`)!);
    const base = ok(writeOmInput(store, { project, expected: 0, stages }));
    const decisions = base.value.gaps.filter(gap => gap.code !== 'inventory_missing' && gap.code !== 'question_unaddressed').map(gap => {
      const field = gap.code === 'contract_node_unbound' ? 'nodes' : gap.code === 'acceptance_kind_missing' ? 'checkKind' : 'state';
      const value: Json = field === 'nodes' ? ['garden-produce-block', 'garden-consume-block'] : field === 'checkKind' ? 'test'
        : { writer: 'garden-produce-block', authority: 'garden-user', rollback: 'garden-produce-block' };
      return { pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph, layers: [], decision: { target: gap.target, field, value } })) as Write };
    });
    if (decisions.length) ok(writeAddressing(store, { project, input: reference(base), graph, decisions }));
    const adapter = store.write({ id: `adapter:${project}:run`, kind: 'dispatch-adapter', expected: 0, value: { projectId: project, protocol: 'codex-stdio' } });
    const request: RunRequest = { project, dispatch: { adapter: reference(adapter), config: reference(store.get(`environment:${project}`)!) } };
    ok(writeRunBases(store, { project })); ok(startRun(store, { project }));
    for (let index = 0; index < 20; index++) {
      const advanced = ok(await advanceRun(store, request));
      const state = advanced.record.value.state;
      if (state.phase === 'step' && state.step.action === 'cycle') return { root, database, packet: (state.step.request as unknown as { packet: Ref }).packet };
      if (state.phase === 'waiting') throw new Error(`The pass waited: ${state.wait.code}`);
    }
    throw new Error('The pass did not choose a cycle');
  } finally { store.close(); }
});

// ---- Helpers of the tests ----

async function probe(options: Partial<ProbeOptions> & { source: string }): Promise<ProbeReport> {
  return (await runProbe({ project: PROJECT, ...options })).report;
}
const pointOf = (report: ProbeReport, packet: Ref): PointReport => {
  const found = report.points.find(point => point.packet && point.packet.id === packet.id && point.packet.revision === packet.revision);
  assert.ok(found, `No point for ${packet.id}`); return found;
};
function snapshotOf(path: string): { sha256: string; listing: string[] } {
  const folder = join(path, '..');
  return { sha256: digest(readFileSync(path)), listing: readdirSync(folder).filter(name => name !== 'stub' && name !== 'outside').sort()
    .map(name => { const stat = lstatSync(join(folder, name)); return `${name}:${stat.size}:${stat.mtimeMs}`; }) };
}

const answerFile = (body: Json, requestId: string, packet: QuestionPacketRecord): string => {
  const path = join(directory('omg-pr1-answer-'), 'answer.json');
  assert.ok(packet.answerProtocol);
  writeFileSync(path, JSON.stringify(fixtureAnswer(packet.packet, body)).split('"$requestId"').join(JSON.stringify(requestId))
    .split('"$answerProtocol"').join(JSON.stringify(packet.answerProtocol)));
  return path;
};
const requestIdOf = (report: ProbeReport, packet: Ref): string => { const wire = pointOf(report, packet).wire; assert.ok(wire); return wire.requestId; };
/** Both answer era and address labels come from the exact saved packet. */
const answerPacketOf = (database: string, packet: Ref): QuestionPacketRecord => rawRecord<QuestionPacketRecord>(database, packet);
const refusalCode = (report: ProbeReport): string | null => report.refusal?.code ?? null;
const newWorkspace = (): string => directory('omg-pr1-ws-');
const newReport = (): string => join(directory('omg-pr1-report-'), 'report');
/** Only explicit points: a group filter that names a group absent from the snapshot. */
const ONLY = (absent: string) => ({ kinds: [absent] });
interface Paid { report: ProbeReport; sent: StubRecord[]; reportDir: string; workspace: string }
async function paidRun(source: string, stubDir: string, steps: Record<string, unknown>[], options: Partial<ProbeOptions> = {}, limits = { maxCalls: 10, maxChars: 10_000_000 },
  reuse?: { reportDir: string; workspace: string }): Promise<Paid> {
  const before = stubRecords(stubDir).length;
  if (steps.length) script(stubDir, steps, source);
  const workspace = reuse?.workspace ?? newWorkspace(), reportDir = reuse?.reportDir ?? newReport();
  const report = await probe({ source, paid: { ...limits, workspace }, reportDir, ...options });
  return { report, sent: stubRecords(stubDir).slice(before), reportDir, workspace };
}
function rawRecord<T>(database: string, ref: Ref): T {
  const db = new DatabaseSync(`${pathToFileURL(database).href}?mode=ro&immutable=1`, { readOnly: true });
  try { return JSON.parse(String(db.prepare('SELECT body FROM revisions WHERE entity_id=? AND revision=?').get(ref.id, ref.revision)!['body'])) as T; }
  finally { db.close(); }
}
const leftovers = (): string[] => readdirSync(tmpdir()).filter(name => name.startsWith('omg-probe-'));
/** Every entry under a directory with its size, bytes and time: a run refused there must leave it exactly as it was. */
function treeOf(root: string): string[] {
  const entries: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name), stat = lstatSync(path);
      if (stat.isDirectory()) { entries.push(`${relative(root, path)}/:${stat.mtimeMs}`); walk(path); }
      else entries.push(`${relative(root, path)}:${stat.size}:${stat.mtimeMs}:${digest(readFileSync(path))}`);
    }
  };
  walk(root); return entries;
}

test('PR1 O1 arguments and options are refused with their field before any copy, Store or adapter, by the CLI and the function alike', async () => {
  const cases: [string[], string][] = [[['--source'], '--source'], [['--bogus', 'x'], '--bogus'], [['--source', 'a', '--source', 'b'], '--source'],
    [['--points', '0'], '--points'], [['--points', 'x'], '--points'], [['--max-calls', '1'], '--max-calls'], [['--answer', 'nofile'], '--answer'],
    [['--paid', '--paid'], '--paid'], [['--kind'], '--kind']];
  for (const [argv, field] of cases) {
    const parsed = parseProbeArgs(argv);
    assert.equal(parsed.ok, false, argv.join(' '));
    if (!parsed.ok) { assert.equal(parsed.refusal.code, 'probe_request_invalid'); assert.equal(parsed.refusal.at.field, field); assert.equal(parsed.refusal.at.unit, 'PR1'); }
  }
  assert.deepEqual(parseProbeArgs(['--source', 's', '--project', 'p']), { ok: true, value: { source: 's', project: 'p', select: [], replay: false, answers: [], paid: null, reportDir: null } });
  const before = leftovers();
  const garden = await facts();
  for (const [options, field] of [[{ source: '' }, 'source'], [{ source: garden.database, project: '' }, 'project'], [{ source: garden.database, kinds: ['bogus'] }, 'kind'],
    [{ source: garden.database, points: 0 }, 'points'], [{ source: garden.database, select: [''] }, 'point'], [{ source: garden.database, extra: 1 }, 'extra']] as [Record<string, unknown>, string][]) {
    const report = (await runProbe({ project: PROJECT, ...options } as unknown as ProbeOptions)).report;
    assert.equal(report.exit, 1); assert.equal(refusalCode(report), 'probe_request_invalid', field); assert.equal(report.refusal!.at.field, field);
    assert.equal(report.source, null, 'nothing was copied');
  }
  assert.deepEqual(leftovers(), before);
  // The CLI branch stands before any Store: a refused or helped probe creates no default database in its directory.
  const cwd = directory('omg-pr1-cli-');
  const help = spawnSync(process.execPath, [CLI, 'probe', '--help'], { cwd, encoding: 'utf8' });
  assert.equal(help.status, 0); assert.equal(help.stdout.trim(), PROBE_USAGE); assert.match(help.stdout, /frozen snapshot/);
  const bad = spawnSync(process.execPath, [CLI, 'probe', '--bogus', 'x'], { cwd, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  const report = JSON.parse(bad.stdout) as ProbeReport;
  assert.equal(report.format, PROBE_REPORT_FORMAT); assert.equal(report.refusal!.code, 'probe_request_invalid'); assert.equal(report.exit, 1);
  const none = spawnSync(process.execPath, [CLI, 'probe'], { cwd, encoding: 'utf8' });
  assert.equal(none.status, 1); assert.equal((JSON.parse(none.stdout) as ProbeReport).refusal!.at.field, 'source');
  assert.equal(existsSync(join(cwd, '.omg')), false, 'the default database is never opened');
  // The product's own commands do not know the probe: neither command nor HTTP can reach a paid send.
  const product = new Store(join(directory('omg-pr1-product-'), 'state.sqlite'));
  try { assert.throws(() => new ProductEngine(product).execute({ type: 'probe', source: garden.database, project: PROJECT } as never), /command_invalid|Unknown|invalid/i); }
  finally { product.close(); }
  let written = '';
  assert.equal(await probeCommand(['--help'], text => { written += text; }), 0); assert.equal(written.trim(), PROBE_USAGE);
  written = '';
  assert.equal(await probeCommand(['--points', '1'], text => { written += text; }), 1);
  assert.equal((JSON.parse(written) as ProbeReport).refusal!.code, 'probe_request_invalid');
});

test('PR1 O14 a paid probe without every limit, with an invalid limit, with --answer or with a disallowed directory or adapter is refused before any launch', async () => {
  const garden = await facts(), field = await fields(), sentBefore = stubRecords(garden.stubDir).length + stubRecords(field.stubDir).length;
  const workspace = newWorkspace();
  for (const [paid, reportDir, code, target] of [
    [{ maxChars: 10, workspace }, newReport(), 'probe_paid_not_confirmed', 'max-calls'], [{ maxCalls: 1, workspace }, newReport(), 'probe_paid_not_confirmed', 'max-chars'],
    [{ maxCalls: 1, maxChars: 10 }, newReport(), 'probe_paid_not_confirmed', 'workspace'], [{ maxCalls: 1, maxChars: 10, workspace }, null, 'probe_paid_not_confirmed', 'report-dir'],
    [{ maxCalls: 0, maxChars: 10, workspace }, newReport(), 'probe_request_invalid', 'max-calls'], [{ maxCalls: 1, maxChars: 1.5, workspace }, newReport(), 'probe_request_invalid', 'max-chars'],
  ] as [Record<string, unknown>, string | null, string, string][]) {
    const report = await probe({ source: garden.database, paid: paid as never, reportDir });
    assert.equal(report.exit, 1); assert.equal(report.refusal!.code, code, target); assert.equal(report.refusal!.at.field, target);
  }
  const answered = await probe({ source: garden.database, paid: { maxCalls: 1, maxChars: 10, workspace }, reportDir: newReport(),
    answers: [{ point: garden.packets.fact!.id, file: '/nonexistent' }] });
  assert.equal(answered.refusal!.code, 'probe_request_invalid'); assert.equal(answered.refusal!.at.field, 'answer');
  const cli = spawnSync(process.execPath, [CLI, 'probe', '--source', garden.database, '--project', PROJECT, '--paid', '--max-calls', '1', '--max-chars', '10',
    '--report-dir', newReport()], { encoding: 'utf8' });
  assert.equal(cli.status, 1); assert.equal((JSON.parse(cli.stdout) as ProbeReport).refusal!.code, 'probe_paid_not_confirmed');
  assert.equal((JSON.parse(cli.stdout) as ProbeReport).refusal!.at.field, 'workspace');
  // A working directory inside the project's workspace, holding the snapshot or touching the report is never used.
  const holder = directory('omg-pr1-holder-'); copyFileSync(garden.database, join(holder, 'state.sqlite'));
  const nested = newWorkspace(), inner = join(nested, 'report');
  for (const [source, chosen, reportDir] of [[garden.database, garden.root, newReport()], [garden.database, join(garden.root, 'stub'), newReport()],
    [join(holder, 'state.sqlite'), holder, newReport()], [garden.database, nested, inner], [garden.database, join(workspace, 'missing'), newReport()]] as [string, string, string][]) {
    const report = await probe({ source, select: [garden.packets.fact!.id], ...ONLY('node-l3'), paid: { maxCalls: 1, maxChars: 10_000_000, workspace: chosen }, reportDir });
    assert.equal(report.exit, 1, chosen); assert.equal(report.refusal!.code, 'probe_workspace_invalid', chosen);
  }
  // The same point under an adapter whose module path is relative cannot be fixed in another directory.
  const relative = await probe({ source: field.database, select: [field.packets.produceRelative!.id], ...ONLY('node-l3'),
    paid: { maxCalls: 1, maxChars: 10_000_000, workspace }, reportDir: newReport() });
  assert.equal(relative.refusal!.code, 'probe_adapter_unresolved'); assert.equal(relative.refusal!.at.field, 'args');
  assert.equal(stubRecords(garden.stubDir).length + stubRecords(field.stubDir).length, sentBefore, 'no refused probe started the adapter');
});

test('PR1 O2 O3 O4 the source must be an existing, readable, quiet and unchanged regular SQLite file; a refused copy leaves no private directory', async () => {
  const garden = await facts(), before = leftovers();
  const holder = directory('omg-pr1-source-'), link = join(holder, 'link.sqlite');
  symlinkSync(garden.database, link);
  const unreadable = join(holder, 'unreadable.sqlite'); copyFileSync(garden.database, unreadable); chmodSync(unreadable, 0o000);
  const cases: [string, string][] = [[join(holder, 'missing.sqlite'), 'probe_source_unavailable'], [holder, 'probe_source_unavailable'], [link, 'probe_source_unavailable']];
  if (process.getuid?.() !== 0) cases.push([unreadable, 'probe_source_unavailable']);
  for (const [source, code] of cases) assert.equal(refusalCode(await probe({ source })), code, source);
  chmodSync(unreadable, 0o600);
  // A writer that holds unflushed WAL frames, and a journal with a live header, mean the file is not at rest.
  const wal = join(directory('omg-pr1-wal-'), 'state.sqlite'); copyFileSync(garden.database, wal);
  const writer = new DatabaseSync(wal);
  try {
    writer.exec('PRAGMA journal_mode=WAL'); writer.exec('PRAGMA wal_autocheckpoint=0'); writer.exec('CREATE TABLE pending_write (value TEXT)');
    writer.exec("INSERT INTO pending_write VALUES ('not checkpointed')");
    assert.ok(statSync(`${wal}-wal`).size > 0);
    const report = await probe({ source: wal });
    assert.equal(refusalCode(report), 'probe_source_not_quiescent'); assert.equal(report.refusal!.at.field, 'wal');
  } finally { writer.close(); }
  const journaled = join(directory('omg-pr1-journal-'), 'state.sqlite'); copyFileSync(garden.database, journaled);
  writeFileSync(`${journaled}-journal`, Buffer.concat([Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]), Buffer.alloc(504)]));
  const hot = await probe({ source: journaled });
  assert.equal(refusalCode(hot), 'probe_source_not_quiescent'); assert.equal(hot.refusal!.at.field, 'journal');
  // A change or a substitution during the copy is seen by the identity and hash taken after it.
  const changing = join(directory('omg-pr1-change-'), 'state.sqlite'); copyFileSync(garden.database, changing);
  const changed = await probe({ source: changing, testHooks: { afterCopy: () => writeFileSync(changing, readFileSync(changing).subarray(0, statSync(changing).size)) } });
  assert.equal(refusalCode(changed), 'probe_source_not_quiescent');
  const other = join(directory('omg-pr1-swap-'), 'other.sqlite'); copyFileSync(garden.database, other);
  const swapped = await probe({ source: changing, testHooks: { afterCopy: () => renameSync(other, changing) } });
  assert.equal(refusalCode(swapped), 'probe_source_not_quiescent');
  const text = join(directory('omg-pr1-text-'), 'state.sqlite'); writeFileSync(text, 'not a database');
  assert.equal(refusalCode(await probe({ source: text })), 'probe_copy_failed');
  assert.deepEqual(leftovers(), before, 'every private copy directory was removed');
});

test('PR1 the snapshot and its directory are unchanged by a probe; the Store opens only the private copy', async () => {
  const garden = await facts(), holder = directory('omg-pr1-quiet-'), source = join(holder, 'state.sqlite');
  copyFileSync(garden.database, source);
  const before = snapshotOf(source), copies = leftovers();
  const report = await probe({ source, replay: true, points: 9 });
  assert.equal(report.refusal, null); assert.equal(report.source!.sha256, before.sha256); assert.ok(report.source!.databaseId);
  assert.deepEqual(snapshotOf(source), before);
  assert.equal(existsSync(`${source}-wal`) || existsSync(`${source}-shm`) || existsSync(`${source}-journal`), false);
  assert.deepEqual(leftovers(), copies);
  assert.equal(report.engine.package?.startsWith('omg-product-engine@'), true); assert.ok(report.engine.probe);
});

test('PR1 O5 O6 a missing project and a project without a point of the requested groups are addressed refusals', async () => {
  const garden = await facts();
  const missing = await probe({ source: garden.database, project: 'orchard' });
  assert.equal(refusalCode(missing), 'probe_project_missing'); assert.equal(missing.refusal!.at.target, 'orchard');
  const empty = join(directory('omg-pr1-empty-'), 'state.sqlite'), store = new Store(empty);
  try { new ProductEngine(store).execute({ type: 'create-project', project: PROJECT, title: 'Empty garden' }); } finally { store.close(); }
  assert.equal(refusalCode(await probe({ source: empty })), 'probe_no_points');
  const filtered = await probe({ source: garden.database, kinds: ['node-l3'] });
  assert.equal(refusalCode(filtered), 'probe_no_points');
  assert.deepEqual(filtered.selection!.coverage.find(item => item.group === 'node-l3'), { group: 'node-l3', candidates: 0, selected: 0, status: 'absent' });
  assert.equal(filtered.selection!.coverage.find(item => item.group === 'fact')!.status, 'filtered');
});

test('PR1 D1 O8 O9 O11 every kind, a continuation and a blocked packet: saved exchanges equal, packets without a call sized, a blocked packet without a wire', async () => {
  const garden = await facts(), field = await fields(), work = await works(), run = await passed();
  const coverage = (report: ProbeReport) => Object.fromEntries(report.selection!.coverage.map(item => [item.group, item.status]));
  const facts1 = await probe({ source: garden.database, points: 9 });
  assert.deepEqual(coverage(facts1), { 'fact': 'covered', 'input-field': 'absent', 'node-l2': 'covered', 'node-l3': 'absent', 'fact+continuation': 'absent',
    'input-field+continuation': 'absent', 'node-l2+continuation': 'covered', 'node-l3+continuation': 'absent' });
  for (const name of ['factRefused', 'fact', 'node', 'nodeContinuation']) {
    const point = pointOf(facts1, garden.packets[name]!);
    assert.equal(point.verdict, 'equal', name); assert.ok(point.calls.length >= 1); assert.ok(point.calls.every(call => call.readable && call.wire === 'equal' && call.exchange));
  }
  assert.equal(pointOf(facts1, garden.packets.node!).group, 'node-l2'); assert.equal(pointOf(facts1, garden.packets.nodeContinuation!).group, 'node-l2+continuation');
  const blocked = pointOf(facts1, garden.packets.blocked!);
  assert.equal(blocked.verdict, 'no_wire'); assert.equal(blocked.wire, null); assert.equal(blocked.calls.length, 0);
  assert.ok(blocked.readable?.ok && blocked.readable.state === 'blocked' && blocked.readable.refusal);
  assert.equal(facts1.exit, 2, 'a point without a wire is a finding');
  const fields1 = await probe({ source: field.database, points: 9 });
  assert.equal(coverage(fields1)['input-field'], 'covered'); assert.equal(coverage(fields1)['fact'], 'absent');
  assert.equal(pointOf(fields1, field.packets.field!).verdict, 'equal');
  for (const name of ['produce', 'consume', 'produceRelative']) {
    const point = pointOf(fields1, field.packets[name]!);
    assert.equal(point.verdict, 'sized', name); assert.equal(point.calls.length, 0); assert.ok(point.wire && point.wire.chars > point.wire.promptChars);
  }
  assert.equal(fields1.exit, 0);
  const works1 = await probe({ source: work.database });
  assert.equal(coverage(works1)['node-l3'], 'covered'); assert.equal(coverage(works1)['fact'], 'absent'); assert.equal(coverage(works1)['node-l2'], 'absent');
  assert.equal(pointOf(works1, work.packet).verdict, 'equal');
  const run1 = await probe({ source: run.database });
  const next = pointOf(run1, run.packet);
  assert.deepEqual(next.origins, ['packet', 'run']); assert.equal(next.verdict, 'sized'); assert.equal(next.group, 'input-field');
  assert.equal(run1.selection!.run.action, 'cycle'); assert.deepEqual(run1.selection!.run.packet, run.packet);
});

test('PR1 D3 the choice is deterministic: first, largest and last of a group, then the order; equal points are one point; explicit points always count', async () => {
  const garden = await facts();
  const all = await probe({ source: garden.database, kinds: ['fact'] });
  const factPoints = all.points.filter(point => point.group === 'fact');
  assert.equal(factPoints.length, 3);
  const [first, second, third] = factPoints;
  assert.deepEqual(first!.packet, garden.packets.factRefused); assert.ok(first!.chosen.includes('first'));
  assert.ok(factPoints.some(point => point.chosen.includes('largest'))); assert.ok(factPoints.some(point => point.chosen.includes('last')));
  assert.deepEqual(third!.chosen, ['order']); assert.ok(second!.chosen.includes('last'));
  const again = await probe({ source: garden.database, kinds: ['fact'] });
  assert.deepEqual(again.points.map(point => [point.key, point.chosen]), all.points.map(point => [point.key, point.chosen]));
  assert.match(all.selection!.rule, /the first, the largest saved request \(ties: the earlier\) and the last are chosen/);
  const one = await probe({ source: garden.database, kinds: ['fact'], points: 1 });
  assert.deepEqual(one.points.map(point => point.packet), [garden.packets.factRefused]);
  assert.deepEqual(one.selection!.coverage.find(item => item.group === 'fact'), { group: 'fact', candidates: 3, selected: 1, status: 'covered' });
  // A saved call and its packet, named twice, are still one point.
  const explicit = await probe({ source: garden.database, ...ONLY('node-l3'), select: [garden.calls.fact![0]!, garden.packets.fact!.id] });
  assert.equal(explicit.points.length, 1);
  const named = explicit.points[0]!;
  assert.deepEqual(named.origins, ['call', 'explicit', 'packet']); assert.deepEqual(named.specs, [garden.calls.fact![0]!, garden.packets.fact!.id]);
  assert.deepEqual(named.chosen, ['explicit']);
});

test('PR1 explicit points: foreign, unknown, malformed and non-point specs are refused; a substituted hash is the reader\'s own refusal and is never paid', async () => {
  const garden = await facts(), sent = stubRecords(garden.stubDir).length;
  for (const spec of ['model-call:orchard:om:abc', 'om-question-packet:garden:missing', 'graph:garden', 'run', `${garden.packets.fact!.id}@0`, 'om-question-packet:garden:@1']) {
    const report = await probe({ source: garden.database, select: [spec] });
    assert.equal(refusalCode(report), 'probe_point_invalid', spec); assert.equal(report.refusal!.at.target, spec); assert.equal(report.points.length, 0);
  }
  const forged = `${garden.packets.fact!.id}@1#${'0'.repeat(64)}`;
  const free = await probe({ source: garden.database, ...ONLY('node-l3'), select: [forged] });
  const point = free.points[0]!;
  assert.equal(point.verdict, 'unreadable'); assert.ok(point.readable && !point.readable.ok);
  if (point.readable && !point.readable.ok) { assert.equal(point.readable.refusal.code, 'record_forged'); assert.equal(point.readable.refusal.at.field, 'hash'); }
  assert.equal(free.exit, 2);
  const paid = await paidRun(garden.database, garden.stubDir, [], { ...ONLY('node-l3'), select: [forged] });
  assert.equal(paid.report.points[0]!.paid!.state, 'not-sent'); assert.equal(paid.report.points[0]!.paid!.reason, 'unreadable');
  assert.equal(stubRecords(garden.stubDir).length, sent);
});

test('PR1 O7 O12 history: historical and current derivations are separate; a refused current admission does not make a lawful history a finding', async () => {
  const garden = await facts(), run = await passed();
  const report = await probe({ source: garden.database, kinds: ['node-l2', 'node-l2+continuation'] });
  assert.equal(report.exit, 0);
  for (const point of report.points) {
    assert.ok(point.readable?.ok); assert.equal(point.verdict, 'equal');
    assert.ok(point.admission && !point.admission.ok, 'the attempt has moved on since these packets');
  }
  // History stays on the exact environment of the packet, never today's head (a later, smaller one exists here).
  const fact = (await probe({ source: garden.database, ...ONLY('node-l3'), select: [garden.packets.fact!.id, garden.packets.blocked!.id] }));
  assert.deepEqual(pointOf(fact, garden.packets.fact!).environment, garden.environment);
  assert.notDeepEqual(pointOf(fact, garden.packets.blocked!).environment, garden.environment);
  assert.equal(pointOf(fact, garden.packets.fact!).verdict, 'equal');
  const current = pointOf(await probe({ source: run.database }), run.packet);
  assert.ok(current.admission?.ok && current.admission.equalsHistorical && current.admission.writes >= 0);
});

test('PR1 O13 replay: every saved answer is checked again by E3 without the adapter, against the outcome its call actually saved', async () => {
  const garden = await facts(), sent = stubRecords(garden.stubDir).length;
  const report = await probe({ source: garden.database, replay: true, ...ONLY('node-l3'),
    select: [garden.packets.factRefused!.id, garden.packets.fact!.id, garden.packets.node!.id, garden.packets.nodeContinuation!.id] });
  // Only today's workspace refused this read path (it leaves the workspace through a link), so E4 kept the call received:
  // nothing was decided there, and the historical E3 of the replay reads the request for more source.
  const refused = pointOf(report, garden.packets.factRefused!).calls[0]!.replay!;
  assert.equal(refused.saved.application, 'received'); assert.equal(refused.saved.error, null);
  assert.ok(refused.acceptance?.ok && refused.acceptance.kind === 'need-source'); assert.equal(refused.verdict, 'unsettled');
  for (const name of ['fact', 'node', 'nodeContinuation']) for (const call of pointOf(report, garden.packets[name]!).calls) {
    assert.equal(call.replay!.saved.application, 'applied', name); assert.equal(call.replay!.verdict, 'same', name);
  }
  assert.equal(report.exit, 0);
  assert.equal(stubRecords(garden.stubDir).length, sent, 'a replay never starts the adapter');
});

test('PR1 O13 the replay verdict: an applied outcome is the same or changed; any other application has decided nothing', () => {
  assert.equal(replayVerdict('applied', null, null), 'same');
  assert.equal(replayVerdict('applied', 'answer_form_address_invalid', 'answer_form_address_invalid'), 'same');
  assert.equal(replayVerdict('applied', 'answer_form_address_invalid', null), 'changed');
  assert.equal(replayVerdict('applied', null, 'slot_fill_foreign'), 'changed');
  for (const application of ['received', 'running', 'recovered', 'application-refused']) assert.equal(replayVerdict(application, null, null), 'unsettled', application);
});

test('PR1 D7 joint assembly of E3-accepted answers: a complete candidate, partial coverage, a conflict in one frame, separate frames, a late refusal and nothing to assemble', async () => {
  const field = await fields(), base = await probe({ source: field.database, points: 9 });
  const id = (name: string) => requestIdOf(base, field.packets[name]!);
  const answer = (point: string, body: string) => ({ point: field.packets[point]!.id, file: answerFile(field.answers[body]!, id(point), answerPacketOf(field.database, field.packets[point]!)) });
  const run = (answers: { point: string; file: string }[]) => probe({ source: field.database, ...ONLY('node-l3'), answers });
  const complete = await run([answer('produce', 'produce'), answer('consume', 'consume')]);
  assert.equal(complete.joint.state, 'assembled'); assert.equal(complete.joint.groups.length, 1);
  const group = complete.joint.groups[0]!;
  assert.equal(group.level, 2); assert.equal(group.outcome.state, 'candidate'); assert.equal(group.proposals.length, 2);
  assert.ok(complete.points.every(point => point.answer?.acceptance.ok && point.answer.acceptance.kind === 'node-proposal'));
  assert.equal(complete.exit, 0); assert.equal(complete.complete, false, 'a free run is never complete');
  const partial = await run([answer('produce', 'produce')]);
  const outcome = partial.joint.groups[0]!.outcome;
  assert.equal(outcome.state, 'not-assembled'); assert.equal(partial.exit, 0, 'partial coverage is incomplete, not a finding'); assert.equal(partial.complete, false);
  if (outcome.state === 'not-assembled') {
    assert.deepEqual(outcome.operations, { covered: 1, total: 2 });
    assert.ok(outcome.remaining.length && outcome.remaining.every(item => item.node === 'garden-consume-block'));
  }
  const conflict = await run([answer('produce', 'produce'), answer('produceRelative', 'produceOther')]);
  assert.equal(conflict.joint.groups.length, 1, 'one frame, one group: answers are not split to dodge a conflict');
  const conflicted = conflict.joint.groups[0]!.outcome;
  assert.equal(conflicted.state, 'refused');
  if (conflicted.state === 'refused') {
    assert.equal(conflicted.refusal.code, 'slot_fill_conflict'); assert.equal(conflicted.refusal.at.unit, 'F4.3'); assert.equal(conflicted.stage, 'readFrameProposals');
  }
  assert.equal(conflict.exit, 2, 'a refusal of the proposals read together is a finding');
  // The pair that is a candidate in one frame: with the consumer answered on its packet of a later horizon it is two halves of two frames.
  const frames = await run([answer('produce', 'produce'), answer('consumeLater', 'consumeLater')]);
  assert.ok(frames.points.every(point => point.answer?.acceptance.ok && point.answer.acceptance.kind === 'node-proposal'));
  assert.equal(frames.joint.groups.length, 2, 'answers of different frames are never assembled together');
  assert.notDeepEqual(frames.joint.groups[0]!.frame, frames.joint.groups[1]!.frame);
  for (const separate of frames.joint.groups) assert.deepEqual(separate.outcome.state === 'not-assembled' && separate.outcome.operations, { covered: 1, total: 2 });
  assert.equal(frames.exit, 0);
  const late = await run([answer('produce', 'produceUnbound'), answer('consume', 'consume')]);
  const lateOutcome = late.joint.groups[0]!.outcome;
  assert.equal(lateOutcome.state, 'refused');
  if (lateOutcome.state === 'refused') { assert.equal(lateOutcome.stage, 'assembleCandidate'); assert.equal(lateOutcome.refusal.code, 'operation_port_unbound'); }
  assert.ok(late.points.every(point => point.answer?.acceptance.ok), 'every part was accepted alone; only the complete assembly refuses');
  assert.equal(late.exit, 2, 'a refusal of assembleCandidate is a finding'); assert.equal(late.complete, false);
  const none = await probe({ source: field.database, ...ONLY('node-l3'), select: [field.packets.produce!.id] });
  assert.deepEqual(none.joint, { state: 'nothing-to-assemble', groups: [] }); assert.equal(none.exit, 0);
});

test('PR1 calibration on own fixtures: an L3 answer without the end code reference is refused by the brief schema, the corrected one is accepted; a field answer is accepted', async () => {
  const work = await works(), field = await fields();
  const base = await probe({ source: work.database }), requestId = requestIdOf(base, work.packet), packet = answerPacketOf(work.database, work.packet);
  const missing = await probe({ source: work.database, answers: [{ point: work.packet.id, file: answerFile(work.answers.noCodeRef!, requestId, packet) }] });
  const refused = pointOf(missing, work.packet).answer!.acceptance;
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.deepEqual([refused.refusal.code, refused.refusal.at.unit, refused.refusal.at.field],
      ['part_answer_invalid', 'E2', '/proposal/fills/0'], JSON.stringify(refused));
    assert.equal(refused.rule, null, 'No native rules/refusals row names this earlier schema refusal');
  }
  assert.equal(missing.exit, 2);
  const corrected = await probe({ source: work.database, answers: [{ point: work.packet.id, file: answerFile(work.answers.complete!, requestId, packet) }] });
  const accepted = pointOf(corrected, work.packet).answer!.acceptance;
  assert.ok(accepted.ok && accepted.kind === 'node-proposal' && (accepted.detail as { bindings: number }).bindings > 0);
  assert.equal(corrected.joint.groups[0]!.level, 3); assert.ok(corrected.joint.groups[0]!.works);
  const foreign = await probe({ source: work.database, answers: [{ point: work.packet.id, file: answerFile(work.answers.complete!, 'another-request', packet) }] });
  const unmatched = pointOf(foreign, work.packet).answer!.acceptance;
  assert.ok(!unmatched.ok && unmatched.refusal.code === 'part_result_invalid' && unmatched.rule === null, 'no rule is named without an exact match');
  const fieldBase = await probe({ source: field.database, points: 9 });
  const fieldAccepted = await probe({ source: field.database, ...ONLY('node-l3'), answers: [{ point: field.packets.field!.id,
    file: answerFile(field.answers.field!, requestIdOf(fieldBase, field.packets.field!), answerPacketOf(field.database, field.packets.field!)) }] });
  const fieldOutcome = pointOf(fieldAccepted, field.packets.field!).answer!.acceptance;
  assert.ok(fieldOutcome.ok && fieldOutcome.kind === 'input-decisions' && fieldOutcome.unanswered.length === 0);
});

// ---- Paid sends: the stand-in adapter counts every request that crossed into it. ----

async function until(condition: () => boolean, label: string, limit = 15_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > limit) assert.fail(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const control = (questions: string[], action: string, extra: Record<string, unknown>) =>
  ({ protocol: '$answerProtocol', requestId: '$requestId', action, questionIds: questions, ...extra });
const receiptOf = (reportDir: string, folder: 'sends' | 'results', key: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(reportDir, folder, `${key}.json`), 'utf8')) as Record<string, unknown>;

test('PR1 D5 the paid probe hands the adapter exactly the canonical engine wire, with its environment\'s model, effort and speed, in the isolated directory', async () => {
  const garden = await facts(), select = { ...ONLY('node-l3'), select: [garden.packets.fact!.id] };
  const before = stubRecords(garden.stubDir).length;
  const free = await probe({ source: garden.database, ...select });
  assert.equal(stubRecords(garden.stubDir).length, before, 'a free probe never starts the adapter');
  const run = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }], select);
  assert.equal(run.report.refusal, null); assert.equal(run.sent.length, 1);
  const packet = rawRecord<QuestionPacketRecord>(garden.database, garden.packets.fact!), payload = packet.packet as Record<string, Json>;
  const built = adapterRequest({ requestId: String(payload.requestId), packet: payload, model: 'fixture', effort: 'high', speed: 'fast' });
  assert.ok(built.ok);
  const expected = canonical(built.value);
  const sent = run.sent[0]!;
  assert.equal(sent.stdin, expected); assert.equal(sent.cwd, run.workspace); assert.deepEqual(sent.argv, [garden.stubDir]);
  const point = run.report.points[0]!;
  assert.equal(sent.stdin, canonical(rawRecord<{ wire: Json }>(garden.database, point.calls[0]!.exchange!).wire), 'the same body the pass once sent');
  assert.deepEqual(point.wire, pointOf(free, garden.packets.fact!).wire);
  assert.equal(point.paid!.state, 'sent'); assert.equal(point.paid!.transport!.kind, 'answered'); assert.deepEqual(point.paid!.transport!.usage, usage);
  assert.equal(point.paid!.receipt, `sends/${point.key}.json`);
  assert.ok(point.paid!.acceptance?.ok && point.paid!.acceptance.kind === 'fact-candidates');
  assert.equal(point.complete, true); assert.equal(run.report.complete, true); assert.equal(run.report.exit, 0);
  assert.deepEqual({ sent: run.report.totals.sent, chars: run.report.totals.sentChars, bytes: run.report.totals.sentBytes, usage: run.report.totals.usage },
    { sent: 1, chars: expected.length, bytes: Buffer.byteLength(expected), usage });
  const send = receiptOf(run.reportDir, 'sends', point.key) as { binding: { cwd: string; command: { executable: string }; modules: { path: string; sha256: string }[];
    wire: { sha256: string } }; reservation: { calls: number; chars: number } };
  assert.equal(send.binding.cwd, run.workspace); assert.equal(send.binding.command.executable, realpathSync(process.execPath));
  assert.deepEqual(send.binding.modules, [{ path: join(garden.root, 'stub.mjs'), sha256: digest(readFileSync(join(garden.root, 'stub.mjs'))) }]);
  assert.equal(send.binding.wire.sha256, digest(expected)); assert.deepEqual(send.reservation, { calls: 1, chars: expected.length });
  assert.equal(statSync(run.reportDir).mode & 0o777, 0o700); assert.equal(statSync(join(run.reportDir, 'sends', `${point.key}.json`)).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(join(run.reportDir, 'report.json'), 'utf8')) as ProbeReport;
  assert.equal(saved.format, PROBE_REPORT_FORMAT); assert.equal(saved.exit, 0);
});

test('PR1 D6 O15 limits are checked before every send, at the exact boundary and after resuming; a repeat never resets what was reserved', async () => {
  const garden = await facts(), select = { ...ONLY('node-l3'), select: [garden.packets.fact!.id, garden.packets.factRefused!.id] };
  const steps = [{ research: garden.answers.fact!, usage }, { research: garden.answers.fact!, usage }];
  const calls = await paidRun(garden.database, garden.stubDir, steps, select, { maxCalls: 1, maxChars: 10_000_000 });
  assert.equal(calls.sent.length, 1); assert.equal(calls.report.exit, 2);
  const [first, second] = calls.report.points;
  assert.equal(first!.paid!.state, 'sent');
  assert.equal(second!.paid!.state, 'not-sent'); assert.equal(second!.paid!.refusal!.code, 'probe_paid_limit_exceeded'); assert.equal(second!.paid!.refusal!.at.field, 'max-calls');
  const exact = first!.wire!.chars;
  const chars = await paidRun(garden.database, garden.stubDir, steps, select, { maxCalls: 5, maxChars: exact });
  assert.equal(chars.sent.length, 1, 'the exact boundary admits the send');
  assert.equal(chars.report.points[1]!.paid!.refusal!.at.field, 'max-chars');
  const again = await paidRun(garden.database, garden.stubDir, [], select, { maxCalls: 1, maxChars: 10_000_000 }, calls);
  assert.equal(again.sent.length, 0); assert.equal(again.report.points[0]!.paid!.state, 'reused');
  assert.equal(again.report.points[1]!.paid!.refusal!.code, 'probe_paid_limit_exceeded'); assert.deepEqual(again.report.totals.reserved, { calls: 1, chars: exact });
  const raised = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }], select, { maxCalls: 2, maxChars: 10_000_000 }, calls);
  assert.equal(raised.sent.length, 1); assert.deepEqual(raised.report.points.map(point => point.paid!.state), ['reused', 'sent']);
  assert.equal(raised.report.totals.reserved!.calls, 2);
});

test('PR1 O16 O17 O18 the outcomes are the engine\'s own: a failed process, a timeout, off-form envelopes and every E3 answer; nothing is retried or read further', async () => {
  const garden = await facts(), select = { ...ONLY('node-l3'), select: [garden.packets.fact!.id] }, questions = garden.questions.fact!;
  const invalid = JSON.parse(JSON.stringify(garden.answers.fact)) as { results: { questionId: string }[] };
  invalid.results[0]!.questionId = 'not-a-question';
  const cases: [string, Record<string, unknown>, 0 | 2, (paid: NonNullable<PointReport['paid']>) => void][] = [
    ['a failed process', { research: garden.answers.fact!, exitCode: 3 }, 2, paid => {
      assert.equal(paid.transport!.kind, 'interrupted'); assert.equal(paid.transport!.error!.code, 'model_adapter_interrupted'); assert.equal(paid.transport!.exitCode, 3); }],
    ['a timeout', { research: garden.answers.fact!, delayMs: 8000 }, 2, paid => {
      assert.equal(paid.transport!.kind, 'interrupted'); assert.equal(paid.transport!.error!.code, 'process_timeout'); }],
    ['an unreadable envelope', { rawStdout: 'not json' }, 2, paid => {
      assert.equal(paid.transport!.kind, 'off-form'); assert.equal(paid.transport!.error!.code, 'model_adapter_response_invalid'); assert.equal(paid.transport!.error!.field, 'stdout'); }],
    ['another request', { rawStdout: JSON.stringify({ protocol: 'omg-agent/v1', requestId: 'another', research: {}, usage: null, confirmed: { model: null, effort: null, speed: null } }) },
      2, paid => { assert.equal(paid.transport!.kind, 'off-form'); assert.equal(paid.transport!.error!.field, 'requestId'); }],
    ['need_source', { research: control(questions, 'need_source', { missing: 'More source', reads: [{ action: 'read', path: 'e4-source.txt', media: 'text/plain' }] }) }, 0,
      paid => { assert.ok(paid.acceptance?.ok && paid.acceptance.kind === 'need-source'); }],
    ['need_owner', { research: control(questions, 'need_owner', { reason: 'Owner choice', decision: 'Which encoding' }) }, 0,
      paid => { assert.ok(paid.acceptance?.ok && paid.acceptance.kind === 'awaiting-owner'); }],
    ['cannot_answer', { research: control(questions, 'cannot_answer', { reason: 'No basis' }) }, 0,
      paid => { assert.ok(paid.acceptance?.ok && paid.acceptance.kind === 'no-result'); }],
    ['an answer E3 refuses', { research: invalid as unknown as Json }, 2, paid => {
      assert.ok(paid.acceptance && !paid.acceptance.ok);
      assert.deepEqual([paid.acceptance.refusal.code, paid.acceptance.refusal.at.unit, paid.acceptance.refusal.at.field],
        ['answer_label_unknown', 'E2', 'results/0/questionId']); }],
  ];
  for (const [name, step, exit, check] of cases) {
    const run = await paidRun(garden.database, garden.stubDir, [step], select);
    assert.equal(run.sent.length, 1, `${name}: one request, no retry and no further read`);
    const point = run.report.points[0]!;
    assert.equal(point.paid!.state, 'sent', name); check(point.paid!);
    assert.equal(run.report.exit, exit, name); assert.equal(run.report.complete, false, name);
    const result = receiptOf(run.reportDir, 'results', point.key);
    assert.deepEqual(Object.keys(result).sort(), ['at', 'format', 'launchError', 'point', 'process', 'send', 'stop'], `${name}: no saved verdict`);
    if (Object.hasOwn(step, 'rawStdout')) assert.equal((result.process as { stdout: string }).stdout, step.rawStdout, `${name}: the raw output was saved`);
  }
});

test('PR1 O19 an interruption stops the adapter through the common runner and keeps a partial report; O16 an unproven group stop halts every later send', async () => {
  const garden = await facts(), select = { ...ONLY('node-l3'), select: [garden.packets.fact!.id, garden.packets.node!.id] };
  const controller = new AbortController(), before = stubRecords(garden.stubDir).length;
  script(garden.stubDir, [{ research: garden.answers.fact!, delayMs: 20_000 }, { research: garden.answers.node!, usage }], garden.database);
  const reportDir = newReport(), workspace = newWorkspace();
  const running = probe({ source: garden.database, ...select, paid: { maxCalls: 5, maxChars: 10_000_000, workspace }, reportDir, signal: controller.signal });
  await until(() => stubRecords(garden.stubDir).length > before, 'the request to reach the adapter');
  controller.abort();
  const report = await running;
  assert.equal(stubRecords(garden.stubDir).length, before + 1);
  const [fact, node] = report.points;
  assert.equal(fact!.paid!.state, 'sent'); assert.equal(fact!.paid!.transport!.error!.code, 'process_cancelled');
  assert.equal(report.halted!.code, 'probe_interrupted');
  assert.equal(node!.paid!.state, 'not-sent'); assert.equal(node!.paid!.refusal!.code, 'probe_interrupted');
  assert.equal(report.exit, 2);
  assert.equal((JSON.parse(readFileSync(join(reportDir, 'report.json'), 'utf8')) as ProbeReport).halted!.code, 'probe_interrupted', 'the partial report is saved');
  const stop = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }, { research: garden.answers.node!, usage }], {
    ...select, testHooks: { stop: { signal: () => 'EPERM', probeGroup: () => 'EPERM' } } });
  assert.equal(stop.sent.length, 1, 'no later point after an unproven stop');
  const unproven = stop.report.points[0]!.paid!;
  assert.equal(unproven.transport!.kind, 'stop-unproven'); assert.equal(unproven.transport!.error!.code, 'process_stop_denied');
  assert.equal(stop.report.halted!.code, 'probe_stop_unproven'); assert.equal(stop.report.points[1]!.paid!.refusal!.code, 'probe_stop_unproven');
  const result = receiptOf(stop.reportDir, 'results', stop.report.points[0]!.key) as { stop: { physical: { complete: boolean; stdout: string } } };
  assert.equal(result.stop.physical.complete, true); assert.match(result.stop.physical.stdout, /omg-agent\/v1/);
});

test('PR1 O16 a saved unproven stop keeps the directory stopped on every resume: the same points, reversed, without the stopped one, or free', async () => {
  const garden = await facts(), fact = garden.packets.fact!.id, node = garden.packets.node!.id;
  const first = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }, { research: garden.answers.node!, usage }], {
    ...ONLY('node-l3'), select: [fact, node], testHooks: { stop: { signal: () => 'EPERM', probeGroup: () => 'EPERM' } } });
  assert.equal(first.sent.length, 1); assert.equal(first.report.halted!.code, 'probe_stop_unproven');
  const stopped = first.report.points[0]!.key;
  for (const select of [[fact, node], [node, fact], [node]]) {
    const again = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.node!, usage }], { ...ONLY('node-l3'), select }, undefined, first);
    assert.equal(again.sent.length, 0, `nothing is sent: ${select.length} points`); assert.equal(again.report.exit, 2);
    assert.equal(again.report.halted!.code, 'probe_stop_unproven'); assert.equal(again.report.halted!.at.target, stopped);
    const waiting = pointOf(again.report, garden.packets.node!).paid!;
    assert.equal(waiting.state, 'not-sent'); assert.equal(waiting.refusal!.code, 'probe_stop_unproven');
    const saved = again.report.points.find(point => point.key === stopped);
    if (saved) { assert.equal(saved.paid!.state, 'reused'); assert.equal(saved.paid!.transport!.kind, 'stop-unproven'); }
  }
  const free = await probe({ source: garden.database, ...ONLY('node-l3'), select: [node], reportDir: first.reportDir });
  assert.equal(free.halted!.code, 'probe_stop_unproven'); assert.equal(free.exit, 2);
});

test('PR1 O20 O25 a saved result is decided again without a send; a send whose result was never saved is unknown, reserved and never sent again', async () => {
  const garden = await facts(), select = { ...ONLY('node-l3'), select: [garden.packets.fact!.id] };
  const first = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }], select);
  const again = await paidRun(garden.database, garden.stubDir, [], select, undefined, first);
  assert.equal(again.sent.length, 0);
  const reused = again.report.points[0]!.paid!;
  assert.equal(reused.state, 'reused'); assert.ok(reused.acceptance?.ok && reused.acceptance.kind === 'fact-candidates'); assert.deepEqual(reused.transport!.usage, usage);
  assert.equal(again.report.totals.reused, 1); assert.equal(again.report.totals.sent, 0);
  if (process.getuid?.() === 0) return;
  const reportDir = newReport(), workspace = newWorkspace();
  await probe({ source: garden.database, ...select, reportDir });
  chmodSync(join(reportDir, 'results'), 0o500);
  let lost: Paid;
  try { lost = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }], select, undefined, { reportDir, workspace }); }
  finally { chmodSync(join(reportDir, 'results'), 0o700); }
  assert.equal(lost.sent.length, 1); assert.equal(lost.report.exit, 1);
  assert.equal(lost.report.refusal!.code, 'probe_report_unwritable'); assert.equal(lost.report.refusal!.at.field, 'result');
  const resumed = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }], select, undefined, { reportDir, workspace });
  assert.equal(resumed.sent.length, 0, 'an unknown send is never repeated');
  const unknown = resumed.report.points[0]!.paid!;
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.refusal!.code, 'probe_send_unknown');
  assert.equal(resumed.report.totals.unknown, 1); assert.equal(resumed.report.totals.reserved!.calls, 1); assert.equal(resumed.report.exit, 2);
});

test('PR1 O25 O26 a probe killed after its send is unknown on resume; a second probe of the same directory is refused while the first lives and admitted after it dies', async () => {
  const garden = await facts(), reportDir = newReport(), workspace = newWorkspace(), before = stubRecords(garden.stubDir).length;
  script(garden.stubDir, [{ research: garden.answers.fact!, delayMs: 60_000 }], garden.database);
  const args = ['probe', '--source', garden.database, '--project', PROJECT, '--kind', 'node-l3', '--point', garden.packets.fact!.id, '--paid', '--max-calls', '5',
    '--max-chars', '100000000', '--workspace', workspace, '--report-dir', reportDir];
  const environment = { ...process.env }; delete environment['NODE_TEST_CONTEXT'];
  const first = spawn(process.execPath, [CLI, ...args], { stdio: 'ignore', env: environment });
  try {
    await until(() => stubRecords(garden.stubDir).length > before, 'the first probe to send');
    const busy = await probe({ source: garden.database, ...ONLY('node-l3'), select: [garden.packets.fact!.id], paid: { maxCalls: 5, maxChars: 100_000_000, workspace }, reportDir });
    assert.equal(busy.refusal!.code, 'probe_report_busy'); assert.equal(busy.exit, 1);
    assert.equal(stubRecords(garden.stubDir).length, before + 1);
  } finally {
    first.kill('SIGKILL');
    await new Promise(resolve => first.exitCode !== null || first.signalCode !== null ? resolve(null) : first.once('exit', resolve));
    for (const record of stubRecords(garden.stubDir).slice(before)) { try { process.kill(record.pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  script(garden.stubDir, [{ research: garden.answers.fact!, usage }, { research: garden.answers.fact!, usage }], garden.database);
  const resumed = await probe({ source: garden.database, ...ONLY('node-l3'), select: [garden.packets.fact!.id, garden.packets.factRefused!.id],
    paid: { maxCalls: 1, maxChars: 100_000_000, workspace }, reportDir });
  assert.equal(resumed.refusal, null, 'the dead owner left no lock behind');
  assert.equal(resumed.points[0]!.paid!.state, 'unknown'); assert.equal(resumed.points[0]!.paid!.refusal!.code, 'probe_send_unknown');
  assert.equal(resumed.points[1]!.paid!.refusal!.code, 'probe_paid_limit_exceeded', 'the unknown send keeps its reserve');
  assert.equal(stubRecords(garden.stubDir).length, before + 1);
});

test('PR1 O26 a directory whose sends ran elsewhere or bind other adapter bytes is refused before any send, in either order, and kept as it was', async () => {
  const garden = await facts(), fact = garden.packets.fact!.id, node = garden.packets.node!.id;
  const first = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }], { ...ONLY('node-l3'), select: [fact] });
  assert.equal(first.sent.length, 1);
  const found = treeOf(first.reportDir), elsewhere = newWorkspace();
  for (const select of [[fact, node], [node, fact], [node]]) {
    const moved = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.node!, usage }], { ...ONLY('node-l3'), select }, undefined,
      { reportDir: first.reportDir, workspace: elsewhere });
    assert.equal(moved.sent.length, 0, `nothing is paid: ${select.length} points`); assert.equal(moved.report.exit, 1);
    assert.equal(moved.report.refusal!.code, 'probe_receipt_mismatch'); assert.equal(moved.report.refusal!.at.field, 'cwd');
    assert.deepEqual(treeOf(first.reportDir), found, 'no receipt is added and the saved report stays');
  }
  // The same experiment, but its saved send names other adapter bytes: the point's own binding refuses it, whatever comes first.
  const key = first.report.points[0]!.key, send = receiptOf(first.reportDir, 'sends', key) as { binding: { modules: { path: string; sha256: string }[] } };
  send.binding.modules = send.binding.modules.map(item => ({ ...item, sha256: '0'.repeat(64) }));
  const body = `${canonical(send as unknown as Json)}\n`;
  writeFileSync(join(first.reportDir, 'sends', `${key}.json`), body);
  writeFileSync(join(first.reportDir, 'results', `${key}.json`), `${canonical({ ...receiptOf(first.reportDir, 'results', key), send: digest(body) } as Json)}\n`);
  const rebound = treeOf(first.reportDir);
  for (const select of [[fact, node], [node, fact]]) {
    const other = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.node!, usage }], { ...ONLY('node-l3'), select }, undefined, first);
    assert.equal(other.sent.length, 0); assert.equal(other.report.refusal!.code, 'probe_receipt_mismatch'); assert.equal(other.report.refusal!.at.field, 'modules');
    assert.deepEqual(treeOf(first.reportDir), rebound);
  }
});

test('PR1 O24 a foreign, damaged, other-snapshot, symlinked or unwritable report directory is refused before any send', async () => {
  const garden = await facts(), field = await fields(), select = { ...ONLY('node-l3'), select: [garden.packets.fact!.id] };
  const before = stubRecords(garden.stubDir).length;
  const paidIn = (reportDir: string, source = garden.database) => probe({ source, ...select, paid: { maxCalls: 5, maxChars: 100_000_000, workspace: newWorkspace() }, reportDir });
  const foreign = newReport(); mkdirSync(foreign); writeFileSync(join(foreign, 'notes.txt'), 'mine');
  const foreignFound = treeOf(foreign);
  assert.equal(refusalCode(await paidIn(foreign)), 'probe_report_foreign'); assert.deepEqual(treeOf(foreign), foreignFound, 'not even a lock file is added');
  const linked = join(directory('omg-pr1-link-'), 'report'); symlinkSync(directory('omg-pr1-target-'), linked);
  assert.equal(refusalCode(await paidIn(linked)), 'probe_report_foreign');
  const damaged = (await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }], select)).reportDir;
  const other = await probe({ source: field.database, reportDir: damaged });
  assert.equal(refusalCode(other), 'probe_report_foreign'); assert.equal(other.refusal!.at.field, 'snapshot');
  const key = readdirSync(join(damaged, 'results'))[0]!.replace(/\.json$/, '');
  const result = receiptOf(damaged, 'results', key), resultPath = join(damaged, 'results', `${key}.json`);
  const sentBefore = stubRecords(garden.stubDir).length;
  const { at: _at, ...withoutTime } = result;
  for (const [name, body] of [['a substituted send hash', { ...result, send: '0'.repeat(64) }], ['an imitated status field', { ...result, accepted: true }],
    ['two outcomes', { ...result, launchError: { code: 'x', message: 'y' } }], ['a missing mandatory field', withoutTime]] as [string, Record<string, unknown>][]) {
    writeFileSync(resultPath, JSON.stringify(body));
    const kept = treeOf(damaged), report = await paidIn(damaged);
    assert.equal(refusalCode(report), 'probe_report_invalid', name); assert.deepEqual(treeOf(damaged), kept, name);
  }
  writeFileSync(resultPath, `${canonical(result as Json)}\n`);
  writeFileSync(join(damaged, 'sends', 'notes.json'), '{}');
  assert.equal(refusalCode(await paidIn(damaged)), 'probe_report_foreign');
  rmSync(join(damaged, 'sends', 'notes.json'));
  writeFileSync(join(damaged, 'run.json'), 'x');
  assert.equal(refusalCode(await paidIn(damaged)), 'probe_report_invalid');
  assert.equal(stubRecords(garden.stubDir).length, sentBefore, 'no refused directory led to a send');
  if (process.getuid?.() !== 0) {
    const parent = directory('omg-pr1-readonly-'); chmodSync(parent, 0o500);
    try { assert.equal(refusalCode(await paidIn(join(parent, 'report'))), 'probe_report_unwritable'); } finally { chmodSync(parent, 0o700); }
  }
  assert.ok(stubRecords(garden.stubDir).length >= before);
});

test('PR1 O24 a temporary file is this probe\'s only by its own name in its own directory; foreign, damaged and other-snapshot directories stay as found', async () => {
  const garden = await facts(), field = await fields(), select = { ...ONLY('node-l3'), select: [garden.packets.fact!.id] };
  const sent = stubRecords(garden.stubDir).length;
  // A file with the suffix of a temporary copy is not this probe's: the directory is refused as found, without even a lock file.
  const lone = newReport(); mkdirSync(lone); writeFileSync(join(lone, 'notes.tmp'), 'unrelated work');
  const alone = treeOf(lone);
  assert.equal(refusalCode(await probe({ source: garden.database, ...select, reportDir: lone })), 'probe_report_foreign');
  assert.equal(refusalCode(await probe({ source: garden.database, ...select, paid: { maxCalls: 5, maxChars: 100_000_000, workspace: newWorkspace() },
    reportDir: lone })), 'probe_report_foreign');
  assert.deepEqual(treeOf(lone), alone);
  // A directory of this probe that holds its own temporary copy: a foreign name beside it, a damaged or another snapshot's manifest keep both.
  const own = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }], select);
  const resume = () => paidRun(garden.database, garden.stubDir, [], select, undefined, own);
  writeFileSync(join(own.reportDir, `report.json.${process.pid + 1}.tmp`), '{"partial"');
  writeFileSync(join(own.reportDir, 'results', 'notes.tmp'), 'unrelated');
  let kept = treeOf(own.reportDir);
  assert.equal(refusalCode((await resume()).report), 'probe_report_foreign'); assert.deepEqual(treeOf(own.reportDir), kept);
  rmSync(join(own.reportDir, 'results', 'notes.tmp'));
  const manifest = readFileSync(join(own.reportDir, 'run.json'));
  writeFileSync(join(own.reportDir, 'run.json'), '{"format":'); kept = treeOf(own.reportDir);
  assert.equal(refusalCode((await resume()).report), 'probe_report_invalid'); assert.deepEqual(treeOf(own.reportDir), kept);
  writeFileSync(join(own.reportDir, 'run.json'), manifest); kept = treeOf(own.reportDir);
  const other = await probe({ source: field.database, reportDir: own.reportDir });
  assert.equal(refusalCode(other), 'probe_report_foreign'); assert.equal(other.refusal!.at.field, 'snapshot'); assert.deepEqual(treeOf(own.reportDir), kept);
  // The same experiment resumed: its first save removes its predecessor's own copy, and nothing is sent again.
  const resumed = await resume();
  assert.equal(resumed.report.refusal, null); assert.equal(resumed.sent.length, 0); assert.equal(resumed.report.points[0]!.paid!.state, 'reused');
  assert.ok(!readdirSync(own.reportDir).some(name => name.endsWith('.tmp')));
  assert.equal(stubRecords(garden.stubDir).length, sent + 1);
});

test('PR1 O25 a save interrupted before it replaces its file is recovered by the next run of the same experiment and kept by a refused one', async () => {
  const garden = await facts(), select = { ...ONLY('node-l3'), select: [garden.packets.fact!.id] };
  const interrupted = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }],
    { ...select, testHooks: { beforeCommit: path => { if (/[\\/]results[\\/]/.test(path)) throw new Error('interrupted save'); } } });
  assert.equal(interrupted.sent.length, 1); assert.equal(interrupted.report.refusal!.code, 'probe_report_unwritable');
  assert.equal(interrupted.report.refusal!.at.field, 'result');
  assert.match(readdirSync(join(interrupted.reportDir, 'results')).join(), /^[a-f0-9]{64}\.json\.[0-9]+\.tmp$/);
  const found = treeOf(interrupted.reportDir);
  const elsewhere = await paidRun(garden.database, garden.stubDir, [], select, undefined, { reportDir: interrupted.reportDir, workspace: newWorkspace() });
  assert.equal(elsewhere.report.refusal!.code, 'probe_receipt_mismatch'); assert.deepEqual(treeOf(interrupted.reportDir), found);
  const recovered = await paidRun(garden.database, garden.stubDir, [], select, undefined, interrupted);
  assert.equal(recovered.report.refusal, null); assert.equal(recovered.sent.length, 0);
  assert.equal(recovered.report.points[0]!.paid!.state, 'unknown'); assert.deepEqual(readdirSync(join(interrupted.reportDir, 'results')), []);
  // An interrupted start leaves only its lock and the manifest it was saving; the next run sets the directory up.
  const fresh = newReport();
  const start = await probe({ source: garden.database, ...select, reportDir: fresh,
    testHooks: { beforeCommit: path => { if (/[\\/]run\.json$/.test(path)) throw new Error('interrupted save'); } } });
  assert.equal(start.refusal!.code, 'probe_report_unwritable');
  assert.match(readdirSync(fresh).filter(name => !name.startsWith('lock.sqlite')).join(), /^run\.json\.[0-9]+\.tmp$/);
  const begun = await probe({ source: garden.database, ...select, reportDir: fresh });
  assert.equal(begun.refusal, null); assert.ok(existsSync(join(fresh, 'run.json'))); assert.ok(!readdirSync(fresh).some(name => name.endsWith('.tmp')));
});

/** A process holding a directory's lock as a live probe does; killing it leaves the lock and its journal behind. */
async function holdLock(folder: string): Promise<() => Promise<void>> {
  const script = `const { DatabaseSync } = require('node:sqlite'); const lock = new DatabaseSync(${JSON.stringify(join(folder, 'lock.sqlite'))}, { timeout: 0 });`
    + ` lock.exec('BEGIN EXCLUSIVE'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  await until(() => existsSync(join(folder, 'lock.sqlite-journal')), 'the lock to be held');
  return async () => {
    child.kill('SIGKILL');
    await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve(null) : child.once('exit', resolve));
  };
}

test('PR1 O24 №3019 an unfinished start is this probe\'s only by the bytes of its manifest: each state is begun, recovered or refused as found', async () => {
  const garden = await facts(), field = await fields(), select = { ...ONLY('node-l3'), select: [garden.packets.fact!.id] };
  const otherSelect = { ...ONLY('node-l3'), select: [field.packets.produce!.id] };
  const fresh = newReport(), first = await probe({ source: garden.database, ...select, reportDir: fresh });
  const snapshot = first.source!.sha256, other = (await probe({ source: field.database, ...otherSelect })).source!.sha256;
  const manifest = (of: string, project = PROJECT) => `${canonical({ format: 'omg-probe-run/v1', project, snapshot: of } as Json)}\n`;
  assert.equal(readFileSync(join(fresh, 'run.json'), 'utf8'), manifest(snapshot), 'the bytes this probe writes');
  const launches = () => stubRecords(garden.stubDir).length + stubRecords(field.stubDir).length;
  const folder = () => { const path = newReport(); mkdirSync(path); return path; };
  const tmp = (path: string, body: string, pid = 4242) => writeFileSync(join(path, `run.json.${pid}.tmp`), body);
  const lock = (path: string) => writeFileSync(join(path, 'lock.sqlite'), '');
  /** Free and paid alike: the addressed refusal with its way out, nothing sent, the directory exactly as it was found. */
  const refusedAsFound = async (row: string, path: string, code: string, at: string) => {
    const found = treeOf(path), before = launches();
    for (const mode of ['free', 'paid'] as const) {
      const report = await probe({ source: garden.database, ...select, reportDir: path,
        ...(mode === 'paid' ? { paid: { maxCalls: 5, maxChars: 100_000_000, workspace: newWorkspace() } } : {}) });
      assert.equal(report.refusal?.code, code, `${row} ${mode}`); assert.equal(report.refusal!.at.field, at, `${row} ${mode}`);
      assert.match(report.refusal!.message, /another --report-dir|remove/, `${row}: the refusal names its way out`);
    }
    assert.deepEqual(treeOf(path), found, `${row}: the directory is left as it was found`); assert.equal(launches(), before, `${row}: nothing is sent`);
  };
  /** The run begins or resumes there: its own manifest and folders, no unfinished copy left. */
  const begun = async (row: string, path: string, mode: 'free' | 'paid' = 'free') => {
    const before = launches();
    const report = mode === 'free' ? await probe({ source: garden.database, ...select, reportDir: path })
      : (await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }], select, undefined, { reportDir: path, workspace: newWorkspace() })).report;
    assert.equal(report.refusal, null, row); assert.equal(readFileSync(join(path, 'run.json'), 'utf8'), manifest(snapshot), row);
    assert.ok(existsSync(join(path, 'sends')) && existsSync(join(path, 'results')), row);
    assert.ok(!readdirSync(path).some(name => name.endsWith('.tmp')), `${row}: no unfinished copy is left`);
    assert.equal(launches() - before, mode === 'paid' ? 1 : 0, row);
  };
  // С3, С8: nothing to remove; the start is begun.
  await begun('С3 an empty directory', folder());
  { const path = folder(); lock(path); await begun('С8 only the empty lock', path); }
  { const path = folder(), kill = await holdLock(path); await kill(); assert.ok(existsSync(join(path, 'lock.sqlite-journal')));
    await begun('С8 the lock and journal of a killed holder', path); assert.ok(!existsSync(join(path, 'lock.sqlite-journal'))); }
  // С5, С6: a lock that is not this probe's.
  { const path = folder(); writeFileSync(join(path, 'lock.sqlite'), 'not a lock'); await refusedAsFound('С5', path, 'probe_report_foreign', 'lock'); }
  { const path = folder(); writeFileSync(join(path, 'lock.sqlite-journal'), ''); await refusedAsFound('С6', path, 'probe_report_foreign', 'lock'); }
  // С9, С10: a real interruption once the manifest's copy is durable, before it replaces run.json.
  const interrupted = async (source: string, chosen: Partial<ProbeOptions>) => {
    const path = newReport();
    const report = await probe({ source, ...chosen, reportDir: path, testHooks: { beforeCommit: file => { if (/[\\/]run\.json$/.test(file)) throw new Error('interrupted start'); } } });
    assert.equal(report.refusal!.code, 'probe_report_unwritable');
    assert.match(readdirSync(path).filter(name => !name.startsWith('lock.sqlite')).join(), /^run\.json\.[0-9]+\.tmp$/);
    return path;
  };
  for (const mode of ['free', 'paid'] as const) await begun(`С9 ${mode}: its own start is recovered`, await interrupted(garden.database, select), mode);
  await refusedAsFound('С10 another snapshot\'s start, cut by a real interruption (probe 1 of №3019)', await interrupted(field.database, otherSelect),
    'probe_report_foreign', 'snapshot');
  { const path = folder(); lock(path); tmp(path, manifest(other)); await refusedAsFound('С10 another snapshot', path, 'probe_report_foreign', 'snapshot'); }
  { const path = folder(); lock(path); tmp(path, manifest(snapshot, 'orchard')); await refusedAsFound('С11 another project', path, 'probe_report_foreign', 'project'); }
  // С12, С13: a copy that is not one this probe writes.
  { const path = folder(); tmp(path, 'unrelated data', 12345); await refusedAsFound('С12 unrelated data, no lock (probe 2 of №3019)', path, 'probe_report_invalid', 'run.json'); }
  for (const [row, body] of [['С12 cut while written', manifest(snapshot).slice(0, 40)], ['С12 empty', ''],
    ['С13 an extra key', `${canonical({ format: 'omg-probe-run/v1', project: PROJECT, snapshot, extra: 1 } as Json)}\n`],
    ['С13 a missing key', `${canonical({ format: 'omg-probe-run/v1', snapshot } as Json)}\n`],
    ['С13 another format', `${canonical({ format: 'omg-probe-run/v0', project: PROJECT, snapshot } as Json)}\n`],
    ['С13 other bytes of the same fields', `${JSON.stringify({ format: 'omg-probe-run/v1', project: PROJECT, snapshot }, null, 1)}\n`]] as [string, string][]) {
    const path = folder(); lock(path); tmp(path, body); await refusedAsFound(row, path, 'probe_report_invalid', 'run.json');
  }
  // С14, С15: several starts, or probe files without a manifest.
  { const path = folder(); lock(path); tmp(path, manifest(snapshot)); tmp(path, manifest(snapshot), 4243);
    await refusedAsFound('С14 several unfinished manifests', path, 'probe_report_invalid', 'run.json'); }
  { const path = folder(); lock(path); tmp(path, manifest(snapshot)); writeFileSync(join(path, 'report.json'), '{}');
    await refusedAsFound('С15 a report without a manifest', path, 'probe_report_invalid', 'run.json'); }
  { const path = folder(); lock(path); tmp(path, manifest(snapshot)); mkdirSync(join(path, 'sends'));
    await refusedAsFound('С15 receipts without a manifest', path, 'probe_report_invalid', 'run.json'); }
  // С16–С27 on a copy of a real directory of this probe, with its receipts.
  const own = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }], select);
  const key = readdirSync(join(own.reportDir, 'sends'))[0]!.replace(/\.json$/, '');
  const copyOwn = () => { const path = newReport(); cpSync(own.reportDir, path, { recursive: true }); return path; };
  { const path = copyOwn(); writeFileSync(join(path, 'run.json'), `${JSON.stringify(JSON.parse(manifest(snapshot)), null, 1)}\n`);
    await refusedAsFound('С16 other bytes of the saved manifest', path, 'probe_report_invalid', 'run.json'); }
  { const path = copyOwn(); writeFileSync(join(path, 'run.json'), manifest(snapshot, 'orchard')); await refusedAsFound('С17 another project', path, 'probe_report_foreign', 'project'); }
  { const path = copyOwn(); tmp(path, manifest(snapshot)); await refusedAsFound('С18 a start beside the saved manifest', path, 'probe_report_invalid', 'run.json'); }
  { const path = copyOwn(); for (const pid of [4242, 4243]) writeFileSync(join(path, `report.json.${pid}.tmp`), '{');
    await refusedAsFound('С20 several unfinished reports', path, 'probe_report_invalid', 'report.json'); }
  { const path = newReport(); await probe({ source: garden.database, ...select, reportDir: path });
    for (const name of ['sends', 'results', 'report.json']) rmSync(join(path, name), { recursive: true });
    await begun('С21 the manifest saved, its folders not yet', path); }
  { const path = copyOwn(); rmSync(join(path, 'results'), { recursive: true }); writeFileSync(join(path, 'results'), '');
    await refusedAsFound('С22 receipts in a file', path, 'probe_report_invalid', 'results'); }
  { const path = copyOwn(); writeFileSync(join(path, 'sends', `${key}.json.4242.tmp`), '{}');
    await refusedAsFound('С27 a copy of a send already saved', path, 'probe_report_invalid', 'sends'); }
  { const path = copyOwn(); writeFileSync(join(path, 'results', `${'0'.repeat(64)}.json.4242.tmp`), '{}');
    await refusedAsFound('С27 a result without its send', path, 'probe_report_invalid', 'results'); }
  { const path = copyOwn(); rmSync(join(path, 'results', `${key}.json`)); for (const pid of [4242, 4243]) writeFileSync(join(path, 'results', `${key}.json.${pid}.tmp`), '{}');
    await refusedAsFound('С27 two copies of one result', path, 'probe_report_invalid', 'results'); }
  // С25: a real interruption of an authorization; no request has reached the adapter, so the point may still be sent.
  { const path = newReport(), workspace = newWorkspace(), before = stubRecords(garden.stubDir).length;
    script(garden.stubDir, [{ research: garden.answers.fact!, usage }], garden.database);
    const cutSend = await probe({ source: garden.database, ...select, paid: { maxCalls: 5, maxChars: 100_000_000, workspace }, reportDir: path,
      testHooks: { beforeCommit: file => { if (/[\\/]sends[\\/]/.test(file)) throw new Error('interrupted authorization'); } } });
    assert.equal(cutSend.refusal!.code, 'probe_report_unwritable'); assert.equal(cutSend.refusal!.at.field, 'send');
    assert.ok(stubRecords(garden.stubDir).slice(before).every(record => record.stdin === ''), 'С25: no request reached the adapter');
    assert.match(readdirSync(join(path, 'sends')).join(), /^[a-f0-9]{64}\.json\.[0-9]+\.tmp$/);
    const resumed = await paidRun(garden.database, garden.stubDir, [{ research: garden.answers.fact!, usage }], select, undefined, { reportDir: path, workspace });
    assert.equal(resumed.report.refusal, null); assert.equal(resumed.sent.length, 1, 'С25: the point is sent once, now');
    assert.equal(resumed.report.points[0]!.paid!.state, 'sent'); assert.deepEqual(readdirSync(join(path, 'sends')).filter(name => name.endsWith('.tmp')), []);
  }
  // С29: a probe starting here holds the lock; its copy is never taken for a damaged or an abandoned one while it lives.
  { const path = folder(); tmp(path, manifest(snapshot)); const kill = await holdLock(path);
    try { await refusedAsFound('С29 a probe is starting here', path, 'probe_report_busy', 'report-dir'); } finally { await kill(); }
    await begun('С29 once that probe is gone, its start is recovered', path); }
});

test('PR1 complete: a paid run whose every point is substantively accepted and whose operations form a candidate is complete', async () => {
  const field = await fields();
  const run = await paidRun(field.database, field.stubDir, [{ research: field.answers.produce! }, { research: field.answers.consume! }],
    { ...ONLY('node-l3'), select: [field.packets.produce!.id, field.packets.consume!.id] });
  assert.equal(run.sent.length, 2); assert.equal(run.report.exit, 0);
  assert.equal(run.report.joint.groups[0]!.outcome.state, 'candidate');
  assert.equal(run.report.complete, true);
  assert.equal(run.report.totals.usage, null, 'usage the adapter did not report stays unknown'); assert.equal(run.report.totals.unmeasured, 2);
});

test('PR1 O10 a differing historical wire is reported at its first differing offset and wire field', () => {
  const wire = { protocol: 'omg-agent/v1', requestId: 'request', mode: 'research', model: 'fixture', effort: 'high', prompt: '{"a":1}' };
  const saved = canonical(wire);
  assert.equal(wireDifference(saved, saved), null);
  const prompt = wireDifference(saved, canonical({ ...wire, prompt: '{"a":2}' }))!;
  assert.equal(prompt.field, 'prompt'); assert.equal(saved.slice(0, prompt.offset), canonical({ ...wire, prompt: '{"a":2}' }).slice(0, prompt.offset));
  assert.notEqual(saved[prompt.offset], canonical({ ...wire, prompt: '{"a":2}' })[prompt.offset]);
  assert.equal(wireDifference(saved, canonical({ ...wire, requestId: 'renamed' }))!.field, 'requestId');
  assert.equal(wireDifference(saved, canonical({ ...wire, speed: 'fast' }))!.field, 'speed');
  assert.equal(wireDifference('{', '{"a"')!.field, null);
});

test('PR1 D9 the command line prints omg-probe-report/v1 and exits 0, 2 or 1', async () => {
  const work = await works(), garden = await facts();
  const environment = { ...process.env }; delete environment['NODE_TEST_CONTEXT'];
  const call = (...argv: string[]) => spawnSync(process.execPath, [CLI, 'probe', ...argv], { encoding: 'utf8', env: environment });
  const clean = call('--source', work.database, '--project', PROJECT);
  assert.equal(clean.status, 0, clean.stderr);
  const report = JSON.parse(clean.stdout) as ProbeReport;
  assert.equal(report.format, PROBE_REPORT_FORMAT); assert.equal(report.exit, 0); assert.equal(report.complete, false); assert.equal(report.mode, 'free');
  assert.equal(call('--source', garden.database, '--project', PROJECT).status, 2);
  assert.equal(call('--source', join(work.root, 'missing.sqlite'), '--project', PROJECT).status, 1);
});

test('PR1 every probe refusal code is exercised by the tests above', () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const code of PROBE_CODES) assert.ok(source.split(`'${code}'`).length > 1, `${code} is not tested`);
});
