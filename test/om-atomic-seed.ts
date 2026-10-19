import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import type { Graph, Node } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { taskBindingId } from '../src/graph/task-obligations.js';
import type { CarriedObligation } from '../src/graph/obligation-policy.js';
import type { TaskObligationBinding } from '../src/graph/task-obligation-model.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Write } from '../src/storage/store.js';
import { inputDecisionWrite, writeAddressing, type InputDecisionProposal } from '../src/om/addressing.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import { writeCandidate } from '../src/om/frame-candidate.js';
import { fillObligations, prepareFrame, type FrameScope, type FrameRequest } from '../src/om/frame-obligations.js';
import type { LayerProposal } from '../src/om/frame-proposals.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { gapLineKey, gapLineExpectedResult, writeGapLines } from '../src/om/gap-lines.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeOmInput } from '../src/om/input.js';
import { runModelCycle, readPartAssembly, type ModelCallRequest } from '../src/om/model-call.js';
import { normalizeOwnerGapAssignment, OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND, writeOmObligations, readOmObligations, type OmObligationHandoff } from '../src/om/obligations.js';
import { writeQuestionPacket, readPartResult, type PartProposalBody, type QuestionPacketRequest } from '../src/om/question-packet.js';
import type { OmResult } from '../src/om/refusal.js';
import { writeRoutes } from '../src/om/routes.js';
import { beginAttempt, completeAttempt, openSeries, type AttemptGoal } from '../src/om/series.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

/** Atomic seed producer only: no node:test registrations or implicit cleanup.
 * Each caller owns its resource list, including partially prepared seeds on failure. */
export type AtomicSeedResources = { root: string; store: Store }[];

const clone = structuredClone;
const fixturePath = fileURLToPath(new URL('../../test/om-adapter-fixture.mjs', import.meta.url));
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}

export function addressFixtureFields(store: Store, project: string, input: Ref, graph: Ref, layers: Ref[], extra: InputDecisionProposal['decision'][] = []) {
  const decisions: InputDecisionProposal['decision'][] = [
    { target: `${project}-B1`, field: 'nodes', value: [`${project}-produce-block`, `${project}-consume-block`] },
    { target: `${project}-B1`, field: 'state', value: { writer: `${project}-produce-block`, authority: `${project}-consume-block`, rollback: `${project}-consume-block` } },
    { target: `${project}-R1#1`, field: 'checkKind', value: 'test' }, ...extra,
  ];
  return ok(writeAddressing(store, { project, input, graph,
    decisions: decisions.map(decision => ({ pending: inputDecisionWrite({ project, input, graph, layers: decision.field === 'address' ? layers : [], decision }) as Write })) }));
}

/** The product setup uses real C5, D3, D1/D2 and a declared H2 owner command.
 * Every returned works proposal below is produced by the local E4 adapter. */
/**
 * G5 (№3820, №3822): the era seed adds a late question of the environment no H2 assigns, so the D7 rule before OWN1.2
 * (73d95d93: carried to its consumer by default) and today's (not carried) derive two ledgers from one exact request. The
 * prep assignment — of a block the environment question does not reach — is issued, answered and assembled by that older
 * code on its own ledger, binding nothing (as n-research in omg-live); the rest by today's.
 */
/**
 * Runs a producer script with every engine module loaded from one exact commit, in its own process (as in
 * om-answers-gate): the loader serves engine modules from Git and refuses any outside that checkout.
 */
function atCommit(f: { root: string; path: string }, commit: string, name: string, body: string, input: unknown): unknown {
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
    ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, f.path, argsFile],
    { cwd: repository, encoding: 'utf8', timeout: 180_000, maxBuffer: 10_000_000 }));
  const loaded = readFileSync(served, 'utf8').split('\n').filter(Boolean);
  assert.ok(loaded.includes('src/storage/store.ts') && loaded.includes('src/pipeline/contracts.ts'),
    `The producer ran on the modules of ${commit}: ${loaded.join(', ')}`);
  return output;
}
const ERA_D7_COMMIT = '73d95d936ba7e3135eb898d783ee3c3a99c67719';
export async function produceAtomicSeed(seedResources: AtomicSeedResources, era = false, withForeign = false) {
  const root = mkdtempSync(join(tmpdir(), 'omg-f5-atomic-seed-')), database = join(root, 'state.sqlite'), project = 'garden';
  const store = new Store(database), engine = new ProductEngine(store);
  seedResources.push({ root, store });
  const desired = gardenGraph('cross');
  desired.edges!.push({ id: 'atomic-second-consumer', relation: 'realizes', source: 'garden-produce-operation',
    target: 'garden-consume-block', condition: 'This accepted operation also implements the second consumer' });
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'atomic-proof',
      question: 'Which result proof must both retained consumers receive?', consumer: 'garden-produce-operation',
      moment: 'task-result', blocksCurrentStage: false, resolution: 'Carry the proof until execution of the concrete work' },
    ...(era ? [{ id: 'atomic-env', question: 'Which runtime does the consuming work start on?', consumer: 'garden-consume-operation',
      moment: 'task-start', blocksCurrentStage: false, resolution: 'Confirm it when the task starts' }] : [])];
    return value;
  }, era ? ERA_D7_COMMIT : undefined);
  let input = ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const initial = ok(writeHorizon(store, { project, input: reference(input), graph: reference(store.get(`graph:${project}`)!),
    refinement: null, available: {}, choice: { choiceVersion: 'atomic-upper', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame2: FrameRequest = { project, level: 2, graph: reference(store.get(`graph:${project}`)!), horizon: reference(initial.gate),
    layer: null, frame: null, upper: null };
  const prepared = ok(prepareFrame(store, frame2)), projected = projectGraph(desired, 2);
  const mapped = ok(fillObligations(prepared.upper as Graph, prepared.scope as FrameScope, { graph: desired,
    reference: { ...prepared.request.graph, hash: hashJson(desired) }, frame: null }, prepared.upperRef, 2));
  const nodes = projected.nodes.filter(node => node.kind === 'operation'), nodeIds = new Set(nodes.map(node => node.id));
  const proposalValue: LayerProposal = { base: { graph: prepared.request.graph, frame: null }, level: 2, source: 'decision', status: 'proposed', nodes,
    fills: mapped.fills.filter(fill => nodeIds.has(fill.node)).map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: projected.connectors.map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 2) }))
      .filter(connector => connector.bindings.length), artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
    tests: projected.tests, edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [],
    transfers: projected.transfers ?? [], anchors: projected.anchors, removes: [], replaces: [], redefines: [] };
  const proposal = store.write({ id: `om-proposal:${project}:atomic-upper`, kind: 'layer-proposal', expected: 0, value: proposalValue });
  const candidate = ok(writeCandidate(store, { frame: frame2, proposals: [reference(proposal)] }));
  assert.equal(candidate.state, 'candidate'); if (candidate.state !== 'candidate') throw new Error('Missing upper candidate');
  const accepted = ok(settleCandidate(store, { project, level: 2, candidate: reference(candidate.record), outcome: {
    gate: 'G3', candidate: reference(candidate.record), graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  const graph = reference(accepted.graph!), layer2 = reference(accepted.layer!), upperFrame = reference(accepted.frame!);
  input = addressFixtureFields(store, project, reference(input), graph, [layer2], [{ target: 'discovery:atomic-proof', field: 'address',
    value: { consumer: 'garden-produce-operation', kind: 'post-implementation-proof' } },
    ...(era ? [{ target: 'discovery:atomic-env', field: 'address' as const,
      value: { consumer: 'garden-consume-operation', kind: 'environment-confirmation' } }] : [])]);
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph, refinement: layer2, available: {},
    choice: { choiceVersion: 'atomic-works', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { ...frame2, graph, horizon: reference(horizon.gate), layer: layer2, frame: upperFrame } },
    works: { proposals: [], frame: { project, level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
      upper: { horizon: reference(horizon.gate), frame: upperFrame } } } };
  const gaps = ok(writeGaps(store, sources)), gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const late = gaps.records.find(row => row.value.gap.target === 'discovery:atomic-proof')!;
  assert.ok(late); assert.equal(late.value.gap.consumers.length, 2);
  const assignment = normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project, context: { gaps: gapRead, lines: reference(lines) },
    gap: reference(late), assignments: late.value.gap.consumers.map(consumer => ({ responsibleNode: 'garden-produce-operation',
      responsibleConsumer: consumer, reason: 'The concrete producer owes this proof to this consumer', returnCondition: `Prove result for ${consumer}`, wake: null })) });
  const ledger = ok(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [{ pending: {
    id: `om-owner-gap-assignment:${project}:${hashJson(assignment)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value: assignment } }] }));
  assert.equal(ledger.handoff.obligations.length, 2);
  // The ledger the older rule derives from this exact request: the environment question carried to its consumer.
  const older = era ? atCommit({ root, path: database }, ERA_D7_COMMIT, 'era-d7', `const { writeOmObligations } = await import(src('om/obligations.js'));
const written = take(writeOmObligations(store, args));
out({ producer: reference(written.producer), ledger: reference(written.record) });`, ledger.record.value.request) as { producer: Ref; ledger: Ref } : null;
  if (older) {
    const read = ok(readOmObligations(store, { project, producer: older.producer }));
    assert.equal(canonical(read.record.value.request as unknown as Json), canonical(ledger.record.value.request as unknown as Json), 'One exact request');
    assert.notDeepEqual(older.ledger, reference(ledger.record), 'Two rules, two ledgers');
    assert.equal(read.handoff.obligations.length, 3, 'The older rule carries the environment question too');
  }
  const routes = ok(writeRoutes(store, { project, gaps: gapRead, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [fixturePath, '--scenario', scenario, '--trace', trace] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'atomic-producer', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'atomic-reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: 200_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:atomic`, kind: 'dispatch-adapter', expected: 0, value: { projectId: project, protocol: 'codex-stdio' } });
  const opened = new Map<string, number>(), steps: { research: unknown; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number } }[] = [];
  const results: { kind: 'assembly'; record: Ref }[] = [], cycles: Ref[] = [], proposals: Ref[] = [], transfers: TaskObligationBinding[] = [];
  let openGoal: { block: string; ordinal: number; series: Ref; goal: AttemptGoal } | null = null;
  /** One work assignment issued, answered by the local E4 adapter and assembled — by today's code or by the older one. */
  async function issue(batch: (typeof routes.value.batches)[number], block: string, ordinal: number, goal: AttemptGoal,
    works: { producer: Ref; ledger: Ref }, handoff: OmObligationHandoff, eraBatch: boolean) {
    const series = ok(beginAttempt(store, { project, block, line: 1, attempt: ordinal, goal }));
    const packetRequest: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(environment),
      attempt: { series: reference(series), ordinal }, previous: [], works };
    const packet = eraBatch ? store.get<import('../src/om/question-packet.js').QuestionPacketRecord>((atCommit({ root, path: database }, ERA_D7_COMMIT,
      `era-packet-${ordinal}`, `const { writeQuestionPacket } = await import(src('om/question-packet.js'));
out(reference(take(writeQuestionPacket(store, args)).record));`, packetRequest) as Ref).id)!
      : ok(writeQuestionPacket(store, packetRequest)).record;
    assert.equal(packet.value.state, 'ready'); assert.equal(packet.value.plan!.mode, 'whole');
    const payload = packet.value.packet as unknown as { expansion: { assigned: string[];
      obligations: { id: string; kind: string; upper: { port?: string } }[] }; works: { assigned: string[] } };
    const desiredWork = desired.nodes.find(node => node.kind === 'work' && node.parent === batch.node)!;
    assert.ok(desiredWork, batch.node ?? 'node'); const work: Node = clone(desiredWork);
    const tests = clone(desired.tests.filter(item => work.tests.includes(item.id)));
    // A scoped operation requiring expansion must receive a real work, including a refusal operation.
    if (!work.code.length) {
      work.code = [{ path: `${work.id}.ts`, access: 'write', status: 'planned' }]; work.tests = [`${work.id}-test`];
      const proof = clone(desired.tests.find(item => item.node === 'garden-consume-work')!);
      proof.id = work.tests[0]!; proof.node = work.id; proof.covers = [];
      proof.contract!.entrypoint.path = work.code[0]!.path; proof.contract!.counterfactuals = [];
      tests.push(proof);
    }
    const body: PartProposalBody = { nodes: [work], tests, fills: payload.expansion.obligations
      .filter(item => payload.expansion.assigned.includes(item.id)).map(item => ({ obligation: item.id, node: work.id,
        ...(item.kind === 'connection-end' ? { port: item.upper.port!, codeRef: work.code[0]! } : {}) })),
      localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
      removes: [], replaces: [], redefines: [] };
    const bindings: TaskObligationBinding[] = handoff.obligations.filter(item => payload.works.assigned.includes(taskBindingId(item as CarriedObligation)))
      .map(item => ({ id: taskBindingId(item as CarriedObligation), scope: item.scope, obligation: item.obligation,
        consumers: [{ node: work.id, tests: [...work.tests] }] }));
    steps.push({ research: { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer', proposal: body, bindings },
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0, reasoningOutputTokens: 1 } });
    writeFileSync(scenario, JSON.stringify({ database: store.path, steps }));
    const call: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(environment) }, role: 'implementer' };
    const cycle = eraBatch ? (() => {
      const ran = atCommit({ root, path: database }, ERA_D7_COMMIT, `era-cycle-${ordinal}`, `const { runModelCycle } = await import(src('om/model-call.js'));
const cycle = take(await runModelCycle(store, args));
out({ record: reference(cycle.record), assembly: cycle.assembly });`, call) as { record: Ref; assembly: Ref };
      return { record: store.get<import('../src/om/model-call.js').ModelCycleRecord>(ran.record.id)!, assembly: ran.assembly };
    })() : ok(await runModelCycle(store, call));
    if (cycle.record.value.terminal !== 'assembled') {
      const refusals = store.list('om-unit-refusal').map(row => JSON.stringify(row.value).slice(0, 1500));
      assert.fail(`${batch.node}: ${JSON.stringify(cycle.record.value).slice(0, 1500)} ${refusals.join(' | ')}`);
    }
    assert.ok(cycle.assembly);
    const assembly = ok(readPartAssembly(store, { project, record: cycle.assembly! }));
    assert.deepEqual(assembly.record.value.works!.bindings.map(canonical).sort(), bindings.map(canonical).sort());
    assert.equal(cycle.record.value.results.length, 1);
    const part = ok(readPartResult(store, { project, record: cycle.record.value.results[0]! }));
    assert.deepEqual(part.record.value.works, assembly.record.value.works);
    return { series, cycle, assembly, bindings };
  }
  for (const batch of routes.value.batches.filter(item => item.level === 3 && item.task === 'node-expansion')) {
    const upper = accepted.graph!.value.nodes.find(node => node.id === batch.node)!;
    const block = upper.parent!; assert.ok(batch.items.every(item => item.consumers.includes(block)));
    const ordinal = (opened.get(block) ?? 0) + 1;
    if (ordinal === 1) ok(openSeries(store, { project, block, line: 1, slice: `atomic:${block}`, predecessor: null, basis: null }));
    const goal: AttemptGoal = { key: `atomic:${batch.node}`, questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
      result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
    const eraBatch = !!older && batch.node === 'garden-prep-operation';
    const { series, cycle, assembly, bindings } = await issue(batch, block, ordinal, goal,
      eraBatch ? older! : { producer: reference(ledger.producer), ledger: reference(ledger.record) },
      eraBatch ? ok(readOmObligations(store, { project, producer: older!.producer })).handoff as OmObligationHandoff : ledger.handoff as OmObligationHandoff, eraBatch);
    results.push({ kind: 'assembly', record: cycle.assembly! }); cycles.push(reference(cycle.record));
    proposals.push(reference(assembly.proposal)); transfers.push(...bindings);
    // Keep this declared assignment open through F5→D2→G7. Other deliveries permit the next distinct assignment of their block.
    if (batch.node === 'garden-consume-operation') {
      assert.equal(openGoal, null); openGoal = { block, ordinal, series: reference(series), goal };
    } else ok(completeAttempt(store, { project, block, line: 1, attempt: ordinal,
      outcome: { reason: 'result', achieved: [], cancelled: [], refusals: [] } }));
    opened.set(block, ordinal);
  }
  // G5: a D7 of ANOTHER request — the same D1 and D2 without the owner's assignment — and the produce answer issued on it.
  let foreign: { kind: 'assembly'; record: Ref } | null = null;
  if (withForeign || older) {
    const alt = ok(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [] }));
    const batch = routes.value.batches.find(item => item.level === 3 && item.task === 'node-expansion' && item.node === 'garden-produce-operation')!;
    const block = accepted.graph!.value.nodes.find(node => node.id === batch.node)!.parent!, ordinal = opened.get(block)! + 1;
    const goal: AttemptGoal = { key: `atomic:${batch.node}:foreign`, questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
      result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
    const issued = await issue(batch, block, ordinal, goal, { producer: reference(alt.producer), ledger: reference(alt.record) },
      alt.handoff as OmObligationHandoff, false);
    ok(completeAttempt(store, { project, block, line: 1, attempt: ordinal, outcome: { reason: 'result', achieved: [], cancelled: [], refusals: [] } }));
    opened.set(block, ordinal); foreign = { kind: 'assembly', record: issued.cycle.assembly! };
  }
  assert.ok(openGoal); assert.ok(results.length > 1); assert.equal(transfers.length, 2); assert.equal(new Set(transfers.map(item => item.id)).size, 2);
  const request = { project, results, environment: reference(environment), sources: [] as Ref[] };
  store.close();
  return { root, database, trace, scenario, traceBytes: readFileSync(trace, 'utf8'), data: {
    project, desired, environment, adapter, graph, layer2, upperFrame, input, gaps, gapRead, lines, ledger,
    routes, results, proposals, cycles, transfers, openGoal, request, older, foreign } };
}

