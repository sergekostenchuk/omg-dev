import type { Environment } from '../src/runtime/environment.js';
import type { OmInputRecord } from '../src/om/input.js';
import type { SettleCandidateRequest } from '../src/om/frame-accept.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import type { Graph, Node } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { taskBindingId } from '../src/graph/task-obligations.js';
import type { CarriedObligation } from '../src/graph/obligation-policy.js';
import type { TaskObligationBinding } from '../src/graph/task-obligation-model.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Revision, type Write } from '../src/storage/store.js';
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
import { normalizeOwnerGapAssignment, OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND, writeOmObligations, type OmObligationHandoff } from '../src/om/obligations.js';
import { writeQuestionPacket, readPartResult, type PartProposalBody, type QuestionPacketRequest } from '../src/om/question-packet.js';
import type { OmResult, Sealed } from '../src/om/refusal.js';
import { writeRoutes } from '../src/om/routes.js';
import { openSeries, type AttemptGoal } from '../src/om/series.js';
import { closeAttempt, openAttempt, prepareManagedClaim } from '../src/om/repeat-gate.js';
import { gardenGraph, storedAccepted } from './om-fixture.js';
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
export async function produceAtomicSeed(seedResources: AtomicSeedResources, withForeign = false) {
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
      moment: 'task-result', blocksCurrentStage: false, resolution: 'Carry the proof until execution of the concrete work' }];
    return value;
  });
  let input = ok(writeOmInput(store, { project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const result = await produceAtomicWorks({ root, database, store, project, input, desired, withForeign });
  store.close();
  return result;
}

/** Shared real E4 producer after upstream preparation. A supplied v7 input retains its own
 * accepted stages and spending contracts; only the ordinary L2 accepting door is asynchronous. */
export interface AtomicWorksInput {
  root: string; database: string; store: Store; project: string; input: Sealed<Revision<OmInputRecord>>; desired: Graph;
  withForeign?: boolean; outcome?: string; lateProof?: string | null;
  settle?: (store: Store, request: SettleCandidateRequest) => ReturnType<typeof settleCandidate> | Promise<ReturnType<typeof settleCandidate>>;
  environment?: (command: { executable: string; args: string[] }) => Revision<Environment>;
}
export async function produceAtomicWorks(options: AtomicWorksInput) {
  const { root, database, store, project, desired } = options;
  const engine = new ProductEngine(store), withForeign = options.withForeign ?? false;
  const outcome = options.outcome ?? `${project}-result`, lateProof = options.lateProof === undefined ? 'atomic-proof' : options.lateProof;
  let input = options.input;
  const initial = ok(writeHorizon(store, { project, input: reference(input), graph: reference(store.get(`graph:${project}`)!),
    refinement: null, available: {}, choice: { choiceVersion: 'atomic-upper', features: [{ outcome }], excluded: [] } }));
  const frame2: FrameRequest = { project, level: 2, graph: reference(store.get(`graph:${project}`)!), horizon: reference(initial.gate),
    layer: null, frame: null, upper: null };
  const prepared = ok(prepareFrame(store, frame2)), projected = projectGraph(desired, 2);
  const mapped = ok(fillObligations(prepared.upper as Graph, prepared.scope as FrameScope,
    storedAccepted(desired, prepared.upper as Graph, prepared.scope as FrameScope, project, 2), prepared.upperRef, 2));
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
  const accepted = ok(await (options.settle ?? settleCandidate)(store, { project, level: 2, candidate: reference(candidate.record), outcome: {
    gate: 'G3', candidate: reference(candidate.record), graphHash: candidate.record.value.graphHash, passed: true, codes: [] } }));
  const graph = reference(accepted.graph!), layer2 = reference(accepted.layer!), upperFrame = reference(accepted.frame!);
  input = addressFixtureFields(store, project, reference(input), graph, [layer2], lateProof ? [{ target: `discovery:${lateProof}`, field: 'address',
    value: { consumer: `${project}-produce-operation`, kind: 'post-implementation-proof' } }] : []);
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph, refinement: layer2, available: {},
    choice: { choiceVersion: 'atomic-works', features: [{ outcome }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph, horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { ...frame2, graph, horizon: reference(horizon.gate), layer: layer2, frame: upperFrame } },
    works: { proposals: [], frame: { project, level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
      upper: { horizon: reference(horizon.gate), frame: upperFrame }, workZoneContract: "accepted-l2-v1" } } };
  const gaps = ok(writeGaps(store, sources)), gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project, previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const late = gaps.records.find(row => row.value.gap.target === `discovery:${lateProof}`)!;
  if (lateProof) { assert.ok(late); assert.equal(late.value.gap.consumers.length, 2); }
  const assignment = lateProof ? normalizeOwnerGapAssignment({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project, context: { gaps: gapRead, lines: reference(lines) },
    gap: reference(late), assignments: late.value.gap.consumers.map(consumer => ({ responsibleNode: `${project}-produce-operation`,
      responsibleConsumer: consumer, reason: 'The concrete producer owes this proof to this consumer', returnCondition: `Prove result for ${consumer}`, wake: null })) }) : null;
  const ledger = ok(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: assignment ? [{ pending: {
    id: `om-owner-gap-assignment:${project}:${hashJson(assignment)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value: assignment } }] : [] }));
  assert.equal(ledger.handoff.obligations.length, lateProof ? 2 : 0);
  const routes = ok(writeRoutes(store, { project, gaps: gapRead, tasks: [], catalog: { paths: [], records: [] }, previous: null }));
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [fixturePath, '--scenario', scenario, '--trace', trace] };
  const environment = options.environment ? options.environment(command) : engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'atomic-producer', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'atomic-reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: 200_000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:atomic`, kind: 'dispatch-adapter', expected: 0, value: { projectId: project, protocol: 'codex-stdio' } });
  const steps: { research: unknown; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number } }[] = [];
  const results: { kind: 'assembly'; record: Ref }[] = [], cycles: Ref[] = [], proposals: Ref[] = [], transfers = new Map<string, TaskObligationBinding>();
  let openGoal: { block: string; ordinal: number; series: Ref; goal: AttemptGoal } | null = null;
  let foreign: { kind: 'assembly'; record: Ref } | null = null;
  /** One work assignment issued on a declared running attempt, answered by the local E4 adapter and assembled. */
  async function issue(batch: (typeof routes.value.batches)[number], attempt: { series: Ref; ordinal: number },
    works: { producer: Ref; ledger: Ref }, handoff: OmObligationHandoff) {
    const packetRequest: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(environment),
      attempt, previous: [], works };
    const packet = ok(writeQuestionPacket(store, packetRequest)).record;
    assert.equal(packet.value.state, 'ready'); assert.equal(packet.value.plan!.mode, 'whole');
    const payload = packet.value.packet as unknown as { expansion: { assigned: string[];
      obligations: { id: string; kind: string; upper: { port?: string } }[] }; works: { assigned: string[] } };
    const desiredWork = desired.nodes.find(node => node.kind === 'work' && node.parent === batch.node)!;
    assert.ok(desiredWork, batch.node ?? 'node'); const work: Node = clone(desiredWork);
    const tests = clone(desired.tests.filter(item => work.tests.includes(item.id)));
    // A scoped operation requiring expansion must receive a real work, including a refusal operation.
    if (!work.code.length) {
      work.code = [{ path: `${work.id}.ts`, access: 'write', status: 'planned' }]; work.tests = [`${work.id}-test`];
      const proof = clone(desired.tests.find(item => item.node === `${project}-consume-work`)!);
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
    const cycle = ok(await runModelCycle(store, call));
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
    return { cycle, assembly, bindings };
  }
  /** Every block opens managed attempts — as the engine does until G7 closes them; the accepting consume
   * assignment is a managed attempt that stays open through F5→D2→G7. */
  const expansions = routes.value.batches.filter(item => item.level === 3 && item.task === 'node-expansion');
  const byBlock = new Map<string, typeof expansions>();
  for (const batch of expansions) {
    const block = accepted.graph!.value.nodes.find(node => node.id === batch.node)!.parent!;
    assert.ok(batch.items.every(item => item.consumers.includes(block)));
    const list = byBlock.get(block) ?? []; list.push(batch); byBlock.set(block, list);
  }
  for (const [block, batches] of byBlock) {
    ok(openSeries(store, { project, block, line: 1, slice: `atomic:${block}`, predecessor: null, basis: null }));
    // LG08-03: the consume series' first attempt selects every expansion wholly consumed by the block. The
    // produce-operation batch feeds it through the realizes edge — item.consumers, not the parent, decides the
    // selection — so the cross-block obligations lawfully enter this attempt's original completion and bind to it.
    // A batch is paid once: the producer's own attempts declare only what the consume series does not claim.
    const claimed = expansions.filter(batch => batch.items.every(item => item.consumers.includes(`${project}-consume-block`)));
    const selected = block === `${project}-consume-block` ? claimed : batches.filter(batch => !claimed.includes(batch));
    const questions = [...new Set(selected.flatMap(batch => batch.items.map(item => gapLineKey(project, item.target, item.field))))].sort();
    const result = gapLineExpectedResult(project, selected[0]!.items[0]!.target, selected[0]!.items[0]!.field);
    const completion = { routes: reference(routes), batches: selected.map(batch => batch.id).sort() };
    let attempt: { series: Ref; ordinal: number };
    if (block === `${project}-consume-block`) {
      const goal: AttemptGoal = { key: `atomic:${batches[0]!.node}`, questions, result };
      const series = ok(openAttempt(store, { project, block, line: 1, attempt: 1, goal, completion }));
      openGoal = { block, ordinal: 1, series: reference(series), goal };
      attempt = { series: openGoal.series, ordinal: 1 };
    } else {
      if (block === `${project}-produce-block` && withForeign) {
        // G5: a D7 of ANOTHER request — the same D1 and D2 without the owner's assignment — issued on this block's
        // earlier managed attempt. The attempt's remaining batch asks the owner for a source, so the derived claim
        // closes the attempt 'awaiting-owner' before the next managed attempt opens. The foreign attempt keeps the
        // block's complete original plan — its own questions and its issued produce batch.
        const foreignBatch = batches.find(batch => batch.node === `${project}-produce-operation`)!;
        const waitingBatch = batches.find(batch => batch !== foreignBatch)!;
        const priorQuestions = [...new Set(batches.flatMap(batch => batch.items.map(item => gapLineKey(project, item.target, item.field))))].sort();
        const prior: AttemptGoal = { key: `atomic:${batches[0]!.node}:foreign`, questions: priorQuestions, result };
        const priorSeries = ok(openAttempt(store, { project, block, line: 1, attempt: 1, goal: prior,
          completion: { routes: reference(routes), batches: batches.map(batch => batch.id).sort() } }));
        const alt = ok(writeOmObligations(store, { project, gaps: gapRead, lines: reference(lines), assignments: [] }));
        const issued = await issue(foreignBatch, { series: reference(priorSeries), ordinal: 1 },
          { producer: reference(alt.producer), ledger: reference(alt.record) }, alt.handoff as OmObligationHandoff);
        foreign = { kind: 'assembly', record: issued.cycle.assembly! };
        const waiting = ok(writeQuestionPacket(store, { project, routes: reference(routes), batch: waitingBatch.id,
          environment: reference(environment), attempt: { series: reference(priorSeries), ordinal: 1 },
          previous: [], works: { producer: reference(alt.producer), ledger: reference(alt.record) } }));
        steps.push({ research: { protocol: '$answerProtocol', requestId: '$requestId', action: 'need_owner',
          questionIds: waitingBatch.items.map(item => item.gap), reason: 'A concrete external source is required',
          decision: 'Choose the source' },
          usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0, reasoningOutputTokens: 1 } });
        writeFileSync(scenario, JSON.stringify({ database: store.path, steps }));
        ok(await runModelCycle(store, { project, packet: reference(waiting.record),
          dispatch: { adapter: reference(adapter), config: reference(environment) }, role: 'implementer' }));
        const claim = ok(prepareManagedClaim(store, { project, block, line: 1, attempt: 1,
          outcome: { reason: 'awaiting-owner', accepting: [], cancelling: [], refusals: [] } }));
        ok(closeAttempt(store, { project, block, line: 1, attempt: 1, outcome: claim.outcome }));
      }
      const goal: AttemptGoal = { key: `managed:${block}`, questions, result };
      const ordinal = block === `${project}-produce-block` && withForeign ? 2 : 1;
      const series = ok(openAttempt(store, { project, block, line: 1, attempt: ordinal, goal, completion }));
      attempt = { series: reference(series), ordinal };
    }
    for (const batch of selected) {
      const { cycle, assembly, bindings } = await issue(batch, attempt,
        { producer: reference(ledger.producer), ledger: reference(ledger.record) }, ledger.handoff as OmObligationHandoff);
      results.push({ kind: 'assembly', record: cycle.assembly! }); cycles.push(reference(cycle.record));
      proposals.push(reference(assembly.proposal)); for (const item of bindings) transfers.set(item.id, item);
    }
  }
  assert.ok(openGoal); assert.ok(results.length > 1); assert.equal(transfers.size, lateProof ? 2 : 0);
  const request = { project, results, environment: reference(environment), sources: [] as Ref[],
    binding: { series: openGoal.series, ordinal: openGoal.ordinal,
      obligations: [...new Set(byBlock.get(openGoal.block)!.flatMap(batch => batch.items.map(item => item.target)))].sort() } };
  return { root, database, trace, scenario, traceBytes: readFileSync(trace, 'utf8'), data: {
    project, desired, environment, adapter, graph, layer2, upperFrame, input, gaps, gapRead, lines, ledger,
    routes, results, proposals, cycles, transfers: [...transfers.values()], openGoal, request, foreign } };
}

