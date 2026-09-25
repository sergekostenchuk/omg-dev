import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { canonical, hashJson } from '../src/canonical.js';
import { Evidence } from '../src/evidence/evidence.js';
import { EngineError } from '../src/errors.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { ensureWorktree } from '../src/execution/worktree.js';
import type { MachinePlan } from '../src/compiler/model.js';
import { requirePlanTaskObligations, requireTaskObligationProofs } from '../src/execution/task-obligations.js';
import type { Graph } from '../src/graph/model.js';
import type { CarriedObligation } from '../src/graph/obligation-policy.js';
import { taskBindingId } from '../src/graph/task-obligations.js';
import { isRef, reference, type Ref, type StageArtifact } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { git, Environments } from '../src/runtime/environment.js';
import { runtimeObligationId, type RuntimeObservationResult } from '../src/runtime/runtime-observation.js';
import { Store, type Revision } from '../src/storage/store.js';
import { writeWorksAcceptance } from '../src/om/atomic-gate.js';
import { readAcceptedFrame } from '../src/om/frame-accept.js';
import type { FrameRead, FrameRequest } from '../src/om/frame-obligations.js';
import type { ProposalRequest } from '../src/om/frame-proposals.js';
import { writeFeasibility, readFeasibility, type FeasibilityRequest } from '../src/om/feasibility.js';
import { prepareHandoff, readHandoff, writeHandoff, type HandoffRequest } from '../src/om/handoff.js';
import { writeGuarded } from '../src/om/refs.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { gapLineKey, gapLineExpectedResult, writeGapLines } from '../src/om/gap-lines.js';
import type { HorizonRecords } from '../src/om/horizon.js';
import type { OmInputRecord } from '../src/om/input.js';
import { runModelCycle, readPartAssembly } from '../src/om/model-call.js';
import { normalizeOwnerGapAssignment, OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND,
  readOmObligations, writeOmObligations } from '../src/om/obligations.js';
import { writeQuestionPacket, type PartProposalBody } from '../src/om/question-packet.js';
import type { OmResult } from '../src/om/refusal.js';
import { writeRoutes } from '../src/om/routes.js';
import { openSeries, beginAttempt } from '../src/om/series.js';
import { readWorksFrame } from '../src/om/works-frame.js';

const clone = structuredClone;
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message} ${canonical(result.refusal.at)}`);
  return result.value;
}

interface OperationsFixture {
  root: string; workspace: string; database: string; project: string; desired: Graph;
  basis: FrameRead; frame2: FrameRequest; graph: Ref; layer: Ref; upperFrame: Ref;
  input: Revision<OmInputRecord>; horizon: HorizonRecords;
  readonly store: Store; readonly engine: ProductEngine;
  restart(): void;
}
interface M8Fixture {
  root: string; workspace: string; database: string; project: string; readonly store: Store;
  feasibility: FeasibilityRequest; restart(): void;
}
type OperationsModule = {
  acceptedOperationsFixture(t: TestContext, status: 'planned', count: number): OperationsFixture;
  acceptedWorksFixture(t: TestContext): M8Fixture;
};
let operationsModule: Promise<OperationsModule> | undefined;
function loadOperationsFixture(): Promise<OperationsModule> {
  // Reuse the actual upstream producer, without importing its test suite or changing saved records.
  operationsModule ??= (async () => {
    const url = new URL('./om-feasibility.test.js', import.meta.url), source = readFileSync(url, 'utf8');
    const end = source.indexOf('const heads =');
    assert.ok(end > 0);
    let prefix = source.slice(0, end);
    const moment = "moment: 'feasibility', blocksCurrentStage: false";
    assert.equal(prefix.split(moment).length - 1, 1, 'One explicit upstream question deadline seam');
    prefix = prefix.replace(moment, "moment: ['task-start', 'task-result'][index], blocksCurrentStage: false");
    prefix = prefix.replace('ready before planning?', 'ready at its declared task moment?')
      .replace('Observe the declared local runtime predicate before M8', 'Observe the declared predicate at the exact task moment');
    prefix = prefix.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
      (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`);
    assert.ok(!/\btest\(/.test(prefix), 'Fixture loading does not register a neighboring test suite');
    return import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport { acceptedOperationsFixture, acceptedWorksFixture };`).toString('base64')}`) as Promise<OperationsModule>;
  })();
  return operationsModule;
}

// One local adapter is selected before G5 and handles both the real E4 proposal and later execution.
const localAdapter = String.raw`import{readFileSync,writeFileSync,appendFileSync,mkdirSync}from'node:fs';
import{dirname}from'node:path';
const [scenario,trace]=process.argv.slice(1), request=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(trace,JSON.stringify({mode:request.mode,requestId:request.requestId})+'\n');
const response={protocol:request.protocol,requestId:request.requestId,
usage:{inputTokens:12,outputTokens:3,cachedInputTokens:0,reasoningOutputTokens:1}};
if(request.mode==='research') {
  const replace=value=>value==='$requestId'?request.requestId:Array.isArray(value)?value.map(replace):
    value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)])):value;
  response.research=replace(JSON.parse(readFileSync(scenario,'utf8')));
  response.confirmed={model:null,effort:null,speed:null};
} else if(request.mode==='implement') {
  const context=request.subject.context;
  for(const code of context.scope.code.filter(item=>item.access==='write')) {
    mkdirSync(dirname(code.path),{recursive:true});writeFileSync(code.path,'Native OM result for '+context.binding.task+'\n');
  }
  response.text='Implemented the declared local work';response.artifacts=context.produces.map(id=>({id}));
} else if(request.mode==='review') response.review={verdict:'pass',kind:'none',findings:[]};
else throw new Error('Unexpected local adapter mode');
process.stdout.write(JSON.stringify(response));`;

async function lateObligationsFixture(t: TestContext) {
  const f = (await loadOperationsFixture()).acceptedOperationsFixture(t, 'planned', 2);
  const { store, project, root, workspace, graph, input, layer, upperFrame, frame2, horizon, basis } = f;
  const works: ProposalRequest = { frame: clone(basis.request), proposals: [] };
  const gaps = ok(writeGaps(store, { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { frame: { ...frame2, graph, layer, frame: upperFrame, horizon: reference(horizon.gate) }, proposals: [] }, works }));
  const gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const runtimeGaps = gaps.records.filter(row => row.value.gap.target.startsWith('discovery:runtime-ready') && row.value.gap.field === 'answer');
  assert.equal(runtimeGaps.length, 2);
  assert.deepEqual(runtimeGaps.map(row => row.value.gap.moment).sort(), ['task-result', 'task-start']);
  assert.ok(runtimeGaps.every(row => row.value.gap.kind === 'environment-confirmation'));
  const condition = join(root, 'condition.txt'); writeFileSync(condition, 'ready');
  const script = new Evidence(store).document(project, 'g2-runtime-check',
    "import{readFileSync}from'node:fs';process.exitCode=readFileSync(process.argv.at(-1),'utf8')==='ready'?0:7;", 'text/plain', 0);
  const assignments = runtimeGaps.map(row => normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project,
    context: { gaps: gapRead, lines: reference(lines) }, gap: reference(row),
    assignments: row.value.gap.consumers.map(responsibleConsumer => ({ responsibleNode: 'garden-consume-operation', responsibleConsumer,
      reason: 'The concrete work must prove its own declared execution moment', wake: null,
      returnCondition: `The local condition is ready at ${row.value.gap.moment}`,
      runtimeCheck: { script: reference(script), dependencies: [], subjects: [condition], executables: [process.execPath],
        args: [condition], timeoutMs: 3000, purpose: 'A deterministic local execution predicate',
        satisfies: `The local condition is ready at ${row.value.gap.moment}` } })) }));
  const initialHandoff = ok(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines),
    assignments: assignments.map(assignment => ({ pending: { id: `om-owner-gap-assignment:${project}:${hashJson(assignment)}`,
      kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value: assignment } })) }));
  assert.equal(initialHandoff.handoff.obligations.length, 2);
  const initialObligations = clone(initialHandoff.handoff.obligations) as CarriedObligation[];
  const routes = ok(writeRoutes(store, { project, gaps: gapRead, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const batches = routes.value.batches.filter(batch => batch.level === 3 && batch.task === 'node-expansion');
  assert.equal(batches.length, 1); const batch = batches[0]!;
  assert.equal(batch.node, 'garden-consume-operation');
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: ['--input-type=module', '-e', localAdapter, scenario, trace] };
  const environment = f.engine.environments.configure(project, { workspace,
    implementer: { actor: 'g2-local-producer', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'g2-local-reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: 200_000 }, 0);
  writeFileSync(join(workspace, 'input.txt'), 'A captured external input');
  const source = new Evidence(store).file(project, 'garden-data', workspace, 'input.txt', 'text/plain', 0);
  git(workspace, ['add', 'input.txt']);
  git(workspace, ['-c', 'user.name=OMG Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'capture input']);
  const adapter = store.write({ id: `adapter:${project}:g2`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: project, protocol: 'codex-stdio' } });
  const block = 'garden-consume-block'; assert.ok(batch.items.every(item => item.consumers.includes(block)));
  ok(openSeries(store, { project, block, line: 1, slice: 'g2-work', predecessor: null, basis: null }));
  const series = ok(beginAttempt(store, { project, block, line: 1, attempt: 1,
    goal: { key: 'g2-work', questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
      result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) } }));
  const packet = ok(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id, environment: reference(environment),
    attempt: { series: reference(series), ordinal: 1 }, previous: [],
    works: { producer: reference(initialHandoff.producer), ledger: reference(initialHandoff.record) } })).record;
  assert.equal(packet.value.state, 'ready'); assert.equal(packet.value.plan!.mode, 'whole');
  const payload = packet.value.packet as unknown as { expansion: { assigned: string[];
    obligations: { id: string; kind: string; upper: { port?: string } }[] }; works: { assigned: string[] } };
  assert.deepEqual([...payload.works.assigned].sort(), initialObligations.map(taskBindingId).sort());
  const work = clone(f.desired.nodes.find(node => node.id === 'garden-consume-work')!);
  const body: PartProposalBody = { nodes: [work], tests: clone(f.desired.tests.filter(proof => work.tests.includes(proof.id))),
    fills: payload.expansion.obligations.filter(item => payload.expansion.assigned.includes(item.id))
      .map(item => ({ obligation: item.id, node: work.id,
        ...(item.kind === 'connection-end' ? { port: item.upper.port!, codeRef: work.code[0]! } : {}) })),
    localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [],
    removes: [], replaces: [], redefines: [] };
  const bindings = initialObligations.map(item => ({ id: taskBindingId(item), scope: item.scope,
    obligation: item.obligation, consumers: [{ node: work.id, tests: [] }] }));
  writeFileSync(scenario, JSON.stringify({ protocol: 'omg-answer/v2', requestId: '$requestId', action: 'answer', proposal: body, bindings }));
  const cycle = ok(await runModelCycle(store, { project, packet: reference(packet), role: 'implementer',
    dispatch: { adapter: reference(adapter), config: reference(environment) } }));
  assert.equal(cycle.record.value.terminal, 'assembled', canonical(cycle)); assert.ok(cycle.assembly);
  const assembly = ok(readPartAssembly(store, { project, record: cycle.assembly }));
  assert.deepEqual(assembly.record.value.works!.bindings, bindings);
  const accepted = ok(writeWorksAcceptance(store, { project, results: [{ kind: 'assembly', record: cycle.assembly }],
    environment: reference(environment), sources: [reference(source)] }));
  assert.equal(accepted.state, 'accepted'); assert.ok(accepted.acceptance);
  const settled = ok(readAcceptedFrame(store, accepted.acceptance)); assert.ok(settled.graph && settled.frame);
  assert.deepEqual(settled.graph.value.horizon, [work.id]);
  const candidate = ok(readWorksFrame(store, { project, candidate: settled.frame.value.acceptance.candidate }));
  const handoff = ok(readOmObligations(store, { project, producer: candidate.value.works!.producer }));
  assert.notDeepEqual(reference(handoff.record), reference(initialHandoff.record), 'F5 derives the final ledger from the accepted works');
  assert.equal(handoff.handoff.obligations.length, 2);
  assert.deepEqual(candidate.value.works!.bindings.map(item => item.id).sort(),
    (clone(handoff.handoff.obligations) as CarriedObligation[]).map(taskBindingId).sort());
  assert.equal(store.list('model-call').length, 1, 'E4 produced the actual work and both bindings');
  const modes = () => readFileSync(trace, 'utf8').trim().split('\n').map(line => (JSON.parse(line) as { mode: string }).mode);
  assert.deepEqual(modes(), ['research']);
  return { ...f, get store() { return f.store; }, get engine() { return f.engine; }, handoff, condition, modes,
    feasibility: { project, graph: accepted.acceptance.graph, layer: accepted.acceptance.layer, frame: accepted.acceptance.frame,
      environment: reference(environment), expected: 0 } };
}

test('G2 genuine F5/E4 and nonempty D7 reach M8 compilation and hold native task start and result across restart', async t => {
  const f = await lateObligationsFixture(t), saved = ok(writeFeasibility(f.store, f.feasibility));
  assert.equal(saved.value.producer.contract, 'om-m8/v2'); assert.equal(saved.value.ready, true);
  assert.deepEqual(saved.value.producer.obligations, { producer: reference(f.handoff.producer), ledger: reference(f.handoff.record) });
  assert.deepEqual(saved.value.obligations.handoff.obligations, f.handoff.handoff.obligations);
  assert.deepEqual(saved.value.producer.readiness.confirmations, [], 'Late task evidence is not an R3 prerequisite');
  const handoffRequest = { project: f.project, feasibility: reference(saved), expected: 0 };
  const stage = ok(writeHandoff(f.store, handoffRequest));
  assert.equal(stage.revision, 1); assert.equal(stage.value.status, 'accepted');
  assert.equal(f.store.history(stage.id).length, 1, 'M9 writes no intermediate draft');
  assert.deepEqual(stage.value.content, { feasibility: reference(saved) });
  const plan = f.engine.compiler.compile(f.project);
  assert.deepEqual(plan.value.feasibility, reference(saved)); assert.equal(plan.value.tasks.length, 1);
  const compilation = f.engine.compiler.publish(f.project, reference(plan), 0);
  f.engine.pipeline.accept(f.project, 'compilation', compilation.revision);
  const task = plan.value.tasks[0]!;
  assert.equal(task.researchObligations!.length, 2);
  const start = task.researchObligations!.find(item => item.requirement.moment === 'task-start')!;
  const result = task.researchObligations!.find(item => item.requirement.moment === 'task-result')!;
  assert.ok(start && result); assert.notEqual(start.binding, result.binding);
  for (const bound of [start, result]) {
    assert.deepEqual(bound.requirement.scope, reference(f.handoff.record));
    assert.equal(bound.requirement.kind, 'environment-confirmation');
  }
  requirePlanTaskObligations(f.store, plan.value, task);
  const run = (retry = false) => f.engine.executor.run(f.project, reference(plan), { retry, maxContextChars: 100_000, maxCorrections: 0 });
  const observe = (bound: typeof start, key: string) => f.engine.execute({ type: 'observe-runtime', project: f.project,
    scope: bound.requirement.scope, obligation: runtimeObligationId(bound.requirement), key }) as Promise<RuntimeObservationResult>;
  const planBytes = canonical(plan), m8Bytes = canonical(saved);
  f.restart();
  assert.equal(canonical(f.engine.compiler.read(plan.id)), planBytes);
  await assert.rejects(run(), { code: 'task_obligation_start_required' });
  assert.deepEqual(f.modes(), ['research']); assert.equal(f.store.list('task-run').length, 0);
  const startObservation = await observe(start, 'g2-start');
  assert.equal(startObservation.observation.value.status, 'observed');
  const waiting = (await run())[0]!;
  assert.equal(waiting.value.state, 'awaiting_obligation', canonical(waiting.value));
  assert.match(waiting.value.error!, /task_obligation_result_required/); assert.ok(waiting.value.tree);
  assert.deepEqual(f.modes(), ['research', 'implement', 'review']);
  assert.equal(waiting.value.obligationStartProofs!.length, 1);
  assert.equal(waiting.value.obligationStartProofs![0]!.binding, start.binding);
  f.restart();
  const stillWaiting = (await run(true))[0]!;
  assert.equal(stillWaiting.value.state, 'awaiting_obligation');
  assert.deepEqual(stillWaiting.value.checks, waiting.value.checks);
  assert.deepEqual(f.modes(), ['research', 'implement', 'review'], 'Missing result proof does not repeat paid work');
  const resultObservation = await observe(result, 'g2-result');
  assert.equal(resultObservation.observation.value.status, 'observed');
  const committed = (await run(true))[0]!;
  assert.equal(committed.value.state, 'committed', canonical(committed.value));
  assert.equal(committed.value.attempt, waiting.value.attempt);
  assert.deepEqual(committed.value.checks, waiting.value.checks); assert.deepEqual(committed.value.review, waiting.value.review);
  assert.deepEqual(f.modes(), ['research', 'implement', 'review']);
  assert.equal(committed.value.obligationResultProofs!.length, 1);
  assert.equal(committed.value.obligationResultProofs![0]!.binding, result.binding);
  requireTaskObligationProofs(f.store, committed.value, task);
  f.restart();
  assert.equal(canonical(f.engine.compiler.read(plan.id)), planBytes);
  assert.equal(canonical(ok(readFeasibility(f.store, { project: f.project, record: reference(saved) }))), m8Bytes);
  assert.deepEqual(ok(readHandoff(f.store, { project: f.project, record: reference(stage) })), stage);
  assert.deepEqual(ok(writeHandoff(f.store, handoffRequest)), stage);
  requireTaskObligationProofs(f.store, committed.value, task);
  const repeat = (await run(true))[0]!;
  assert.deepEqual(reference(repeat), reference(committed));
  assert.deepEqual(f.modes(), ['research', 'implement', 'review']);
});

function denied(result: OmResult<unknown>, code: string) {
  assert.equal(result.ok, false); if (result.ok) throw new Error('Expected an addressed refusal');
  assert.equal(result.refusal.code, code, canonical(result.refusal));
  assert.ok(result.refusal.at.target);
  assert.ok(result.refusal.at.field || result.refusal.at.ref || code === 'input_stale',
    'An absent-guard conflict names its ID without representing absence as a Ref');
  return result.refusal;
}
async function m8Fixture(t: TestContext) {
  const f = (await loadOperationsFixture()).acceptedWorksFixture(t);
  const saved = ok(writeFeasibility(f.store, f.feasibility));
  return { ...f, get store() { return f.store; }, saved,
    request: { project: f.project, feasibility: reference(saved), expected: 0 } };
}
function inactivePilot(store: Store, project: string) {
  const command = { executable: process.execPath, args: ['--version'] };
  return configureReaderPilot(store, new Environments(store), project, { experimental: true, active: false, stopAfter: 'L2',
    reader: { actor: 'g2-reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxRequestChars: 300000, maxReadChars: 60000, maxReplyChars: 100000, maxCalls: 100, maxReportedTokens: 20000000 }, 0);
}

test('G2 prepares an immutable exact stage and every changed G6 guard rejects it and its neighbor atomically', async t => {
  const f = await m8Fixture(t), before = f.store.list();
  const request = clone(f.request), prepared = ok(prepareHandoff(f.store, request));
  assert.deepEqual(f.store.list(), before, 'Preparation performs no writes');
  assert.equal(prepared.record.hash, hashJson(prepared.record.value));
  request.feasibility.hash = hashJson('changed caller');
  assert.deepEqual(prepared.record.value.content, { feasibility: reference(f.saved) });
  assert.throws(() => { (prepared.record.value.content as unknown as { feasibility: Ref }).feasibility.hash = '0'.repeat(64); }, TypeError);
  assert.ok(prepared.record.value.proofs.every(isRef));
  assert.ok(prepared.guards.some(guard => guard.id === `execution-root:${f.project}` && 'absent' in guard));
  assert.ok(prepared.guards.some(guard => guard.id === `reader-pilot:${f.project}` && 'absent' in guard));
  assert.ok(prepared.guards.some(guard => guard.id === f.saved.value.producer.obligations.producer.id));
  assert.ok(prepared.guards.some(guard => guard.id === f.saved.value.producer.obligations.ledger.id));
  const snapshot = await f.store.snapshot(join(f.root, 'guard-seed'));
  for (const [index, guard] of prepared.guards.entries()) {
    const path = join(f.root, `guard-${index}.sqlite`); copyFileSync(snapshot.path, path);
    const store = new Store(path), other = new Store(path);
    try {
      if ('absent' in guard) {
        if (guard.id === `reader-pilot:${f.project}`) inactivePilot(other, f.project);
        else if (guard.id === `execution-root:${f.project}`) ensureWorktree(other, new Environments(other),
          { projectId: f.project, base: f.saved.value.repository } as MachinePlan);
        else other.write({ id: guard.id, kind: guard.id.split(':')[0]!, expected: 0, value: { appeared: true } });
      } else {
        const current = other.get(guard.id)!;
        assert.deepEqual(reference(current), guard);
        other.write({ id: current.id, kind: current.kind, expected: current.revision, value: current.value });
      }
      const changedHeads = store.list(), neighbor = { id: `g2-neighbor:${index}`, kind: 'g2-neighbor', expected: 0, value: {} };
      const refusal = denied(writeGuarded(store, { unit: 'M9', target: prepared.record.id,
        writes: [neighbor, ...prepared.writes], guards: prepared.guards }), 'input_stale');
      assert.equal(refusal.at.target, guard.id); assert.deepEqual(store.list(), changedHeads);
      assert.equal(store.get(prepared.record.id), null); assert.equal(store.get(neighbor.id), null);
      if ('absent' in guard) assert.equal(refusal.at.ref, undefined);
    } finally { other.close(); store.close(); }
  }
  const contradictory = denied(writeGuarded(f.store, { unit: 'M9', target: prepared.record.id,
    writes: prepared.writes, guards: [...prepared.guards, { id: f.saved.id, absent: true }] }), 'input_stale');
  assert.equal(contradictory.at.target, f.saved.id); assert.equal(f.store.get(prepared.record.id), null);
  const stage = ok(writeHandoff(f.store, f.request));
  assert.deepEqual(stage, prepared.record); assert.deepEqual(ok(readHandoff(f.store, { project: f.project, record: reference(stage) })), stage);
});

test('G2 late retries preserve the original stage and a new transition requires a new M8', async t => {
  const f = await m8Fixture(t), first = ok(writeHandoff(f.store, f.request));
  assert.deepEqual(ok(writeHandoff(f.store, f.request)), first);
  denied(prepareHandoff(f.store, f.request), 'revision_conflict');
  denied(writeHandoff(f.store, { ...f.request, expected: first.revision }), 'handoff_feasibility_unchanged');
  const environment = f.store.get(f.feasibility.environment.id)!;
  const changed = f.store.write({ id: environment.id, kind: environment.kind, expected: environment.revision, value: environment.value });
  const nextM8 = ok(writeFeasibility(f.store, { ...f.feasibility, environment: reference(changed), expected: f.saved.revision }));
  const secondRequest = { ...f.request, feasibility: reference(nextM8), expected: first.revision };
  const second = ok(writeHandoff(f.store, secondRequest)); assert.equal(second.revision, 2);
  f.restart();
  assert.deepEqual(ok(writeHandoff(f.store, f.request)), first);
  assert.deepEqual(f.store.get(first.id), second, 'A delayed replay never rolls the later stage back');
  denied(writeHandoff(f.store, { ...f.request, expected: second.revision }), 'handoff_feasibility_unchanged');
  inactivePilot(f.store, f.project);
  assert.deepEqual(ok(writeHandoff(f.store, secondRequest)), second, 'Completed history does not acquire a fresh pilot permission');
  const engine = new ProductEngine(f.store), draft = engine.pipeline.draft(f.project, 'om-g2', { feasibility: { ...reference(nextM8) } }, second.revision);
  denied(writeHandoff(f.store, { ...secondRequest, expected: draft.revision }), 'handoff_feasibility_unchanged');
  assert.deepEqual(ok(readHandoff(f.store, { project: f.project, record: reference(first) })), first);
});

test('G2 refuses missing and foreign M8 provenance and the existing stage validator rejects extra content', async t => {
  const f = await m8Fixture(t), engine = new ProductEngine(f.store);
  denied(prepareHandoff(f.store, { ...f.request, feasibility: { ...f.request.feasibility, id: `feasibility:${f.project}` } }), 'record_foreign');
  denied(prepareHandoff(f.store, { ...f.request, feasibility: { ...f.request.feasibility, revision: 999 } }), 'record_missing');
  denied(prepareHandoff(f.store, { ...f.request, feasibility: { ...f.request.feasibility, hash: '0'.repeat(64) } }), 'record_forged');
  assert.throws(() => engine.pipeline.prepareAccepted(f.project, 'om-g2', { feasibility: { ...f.request.feasibility }, extra: true }, 0),
    (error: unknown) => error instanceof EngineError && error.code === 'gate_rejected'
      && canonical(error.details).includes('feasibility_missing'));
  assert.equal(f.store.get(`stage:${f.project}:om-g2`), null);
  const seed = await f.store.snapshot(join(f.root, 'provenance-seed'));
  const mutations: { name: string; change(value: Record<string, unknown>): void }[] = [
    { name: 'producer', change(value) { delete value['producer']; } },
    { name: 'marker', change(value) { delete (value['producer'] as Record<string, unknown>)['contract']; } },
    { name: 'D7 and readiness', change(value) { delete value['obligations'];
      const producer = value['producer'] as Record<string, unknown>; delete producer['obligations']; delete producer['readiness']; } },
  ];
  for (const [index, mutation] of mutations.entries()) {
    const path = join(f.root, `provenance-${index}.sqlite`); copyFileSync(seed.path, path);
    let store = new Store(path);
    try {
      const value = clone(f.saved.value) as unknown as Record<string, unknown>; mutation.change(value);
      const changed = store.write({ id: f.saved.id, kind: f.saved.kind, expected: f.saved.revision, value });
      store.close(); store = new Store(path);
      const result = prepareHandoff(store, { ...f.request, feasibility: reference(changed) });
      assert.equal(result.ok, false, mutation.name);
      if (!result.ok) { assert.ok(result.refusal.at.target); assert.match(result.refusal.code, /feasibility_|record_/); }
      assert.equal(store.get(`stage:${f.project}:om-g2`), null);
    } finally { store.close(); }
  }
  const dirty = join(f.workspace, 'untracked.txt'); writeFileSync(dirty, 'A changed physical repository');
  const blocked = ok(writeFeasibility(f.store, { ...f.feasibility, expected: f.saved.revision }));
  assert.equal(blocked.value.ready, false);
  denied(prepareHandoff(f.store, { ...f.request, feasibility: reference(blocked) }), 'feasibility_not_ready');
  rmSync(dirty);
  inactivePilot(f.store, f.project);
  denied(prepareHandoff(f.store, f.request), 'pilot_boundary_reached');
});

test('G2 historical handoff requires explicit inputs and proofs, with exact source identity after restart', async t => {
  const f = await m8Fixture(t), saved = ok(writeHandoff(f.store, f.request));
  const seed = await f.store.snapshot(join(f.root, 'stage-seed'));
  const mutations: { name: string; change(value: Record<string, unknown>): void; code: string }[] = [
    { name: 'inputs absent', code: 'handoff_record_invalid', change(value) { delete value['inputs']; } },
    { name: 'proofs absent', code: 'handoff_record_invalid', change(value) { delete value['proofs']; } },
    { name: 'proofs empty', code: 'handoff_record_invalid', change(value) { value['proofs'] = []; } },
    { name: 'foreign predecessor', code: 'handoff_record_invalid', change(value) { value['inputs'] = [f.request.feasibility]; } },
    { name: 'extra content', code: 'handoff_record_invalid', change(value) { value['content'] = { feasibility: f.request.feasibility, extra: true }; } },
    { name: 'missing source', code: 'record_missing', change(value) { (value['proofs'] as Ref[]).push({ id: 'missing-proof', revision: 1, hash: '0'.repeat(64) });
      (value['proofs'] as Ref[]).sort((a, b) => `${a.id}:${a.revision}:${a.hash}`.localeCompare(`${b.id}:${b.revision}:${b.hash}`)); } },
  ];
  for (const [index, mutation] of mutations.entries()) {
    const path = join(f.root, `stage-${index}.sqlite`); copyFileSync(seed.path, path);
    let store = new Store(path);
    try {
      const value = clone(saved.value) as unknown as Record<string, unknown>; mutation.change(value);
      const changed = store.write<StageArtifact>({ id: saved.id, kind: saved.kind, expected: saved.revision, value });
      store.close(); store = new Store(path);
      denied(readHandoff(store, { project: f.project, record: reference(changed) }), mutation.code);
      if (mutation.name !== 'extra content') denied(writeHandoff(store, { ...f.request, expected: saved.revision }), mutation.code);
    } finally { store.close(); }
  }
});

test('G2 public requests reject absent fields before reading the store', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-g2-shape-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const valid: HandoffRequest = { project: 'p', feasibility: { id: 'om-feasibility:p', revision: 1, hash: '0'.repeat(64) }, expected: 0 };
  const malformed: unknown[] = [undefined, null, [], {}, { ...valid, project: '' }, { ...valid, feasibility: null },
    { ...valid, feasibility: { id: valid.feasibility.id } }, { ...valid, expected: undefined }, { ...valid, expected: -1 },
    { ...valid, expected: 0.5 }, { ...valid, extra: true }];
  const get = store.get; store.get = () => { throw new Error('Invalid requests must fail before any source read'); };
  try {
    for (const fn of [prepareHandoff, writeHandoff]) for (const request of malformed)
      assert.throws(() => Reflect.apply(fn, null, [store, request]), { code: 'handoff_request_invalid' });
    for (const request of [undefined, null, {}, { project: 'p', record: null }, { project: 'p', record: valid.feasibility, extra: true }])
      assert.throws(() => Reflect.apply(readHandoff, null, [store, request]), { code: 'handoff_request_invalid' });
  } finally { store.get = get; }
});
