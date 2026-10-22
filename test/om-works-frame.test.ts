import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, canonicalSorted, hashJson, type Json } from '../src/canonical.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { Graph, Node } from '../src/graph/model.js';
import type { CarriedObligation } from '../src/graph/obligation-policy.js';
import { projectGraph } from '../src/graph/project.js';
import { validateGraph } from '../src/graph/validate.js';
import { taskBindingId } from '../src/graph/task-obligations.js';
import type { TaskObligationBinding } from '../src/graph/task-obligation-model.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Write } from '../src/storage/store.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import { assembleCandidate, gateCandidate, prepareCandidate, readCandidate, writeCandidate,
  type CandidateRequest } from '../src/om/frame-candidate.js';
import { fillObligations, flowKey, prepareFrame, workAnchorId, WORKS_FRAME_CONTRACT,
  type FrameFill, type FrameRead, type FrameRequest } from '../src/om/frame-obligations.js';
import { prepareFrameProposals, type LayerProposal, type ProposalRequest } from '../src/om/frame-proposals.js';
import { writeGapLines, gapLinesId } from '../src/om/gap-lines.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeOmInput } from '../src/om/input.js';
import { normalizeOwnerGapAssignment, OM_OWNER_ASSIGNMENT_CONTRACT, OM_OWNER_ASSIGNMENT_KIND,
  writeOmObligations, type OwnerGapAssignment } from '../src/om/obligations.js';
import { writeGuarded } from '../src/om/refs.js';
import type { OmResult, Refusal } from '../src/om/refusal.js';
import { prepareWorksFrame, readWorksFrame, writeWorksFrame } from '../src/om/works-frame.js';
import { createCrossOmFixture, explicitMapping, gardenGraph, refusedWith } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

const clone = structuredClone;
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const heads = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function denied(result: OmResult<unknown>, code: string | readonly string[]): Refusal {
  const refusal = refusedWith(result, code);
  assert.ok(refusal.at.field || refusal.at.ref);
  return refusal;
}
function put(store: Store, id: string, proposal: LayerProposal) {
  return reference(store.write({ id: `om-proposal:garden:${id}`, kind: 'layer-proposal', expected: 0, value: proposal }));
}
function proposalFor(frame: FrameRead, graph: Graph): LayerProposal {
  if (frame.request.level === 3) {
    graph = clone(graph);
    for (const part of ['nodes', 'artifacts', 'contracts', 'anchors', 'joins', 'tests', 'edges', 'journeys', 'packets', 'transfers'] as const) {
      const upper = frame.upper[part] ?? [], ids = new Set(upper.map(item => item.id));
      Object.assign(graph, { [part]: [...clone(upper), ...(graph[part] ?? []).filter(item => !ids.has(item.id))] });
    }
    graph.connectors = frame.upper.connectors.map(upper => {
      const desired = graph.connectors.find(connector => connector.id === upper.id)!;
      return { ...clone(upper), wakeTest: upper.wakeTest ?? desired.wakeTest,
        bindings: [...clone(upper.bindings), ...desired.bindings.filter(binding => binding.level === 3)] };
    });
  }
  const level = frame.request.level, projected = projectGraph(graph, level);
  const mapped = explicitMapping(graph, frame.upper, frame.scope, level);
  const nodes = projected.nodes.filter(node => node.kind === (level === 2 ? 'operation' : 'work')
    && (level === 2 || frame.scope.nodes.includes(node.parent!)));
  const selected = new Set(nodes.map(node => node.id));
  return { base: { graph: frame.request.graph, frame: frame.request.frame }, level,
    ...(level === 3 ? { worksContract: 'works-frame/v1' as const } : {}), source: 'decision', status: 'proposed', nodes,
    fills: mapped.fills.filter(fill => selected.has(fill.node)).map(fill => {
      const obligation = mapped.obligations.find(item => item.id === fill.obligation)!;
      const node = nodes.find(item => item.id === fill.node)!;
      const codeRef = level === 3 && obligation.kind === 'connection-end'
        ? node.code[obligation.upper.port === 'out-alt' ? 1 : 0]! : undefined;
      return { obligation: fill.obligation, node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }),
        ...(codeRef ? { codeRef: clone(codeRef) } : {}) };
    }),
    localConnectors: level === 3 ? [] : projected.connectors.map(connector => ({ ...connector,
      bindings: connector.bindings.filter(binding => binding.level === level) })).filter(connector => connector.bindings.length),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
    tests: projected.tests.filter(item => level === 2 || selected.has(item.node)),
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    anchors: level === 2 ? projected.anchors : [], removes: [], replaces: [], redefines: [] };
}

/** First L3 is genuinely absent: only the native C4/G3/C5 transition accepts L2. */
function firstWorks(t: TestContext, late = false, upperWake = false) {
  const root = mkdtempSync(join(tmpdir(), 'omg-first-works-')), database = join(root, 'state.sqlite');
  const store = new Store(database), engine = new ProductEngine(store), desired = gardenGraph('cross');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const produce = desired.nodes.find(node => node.id === 'garden-produce-work')!;
  produce.code.push({ path: 'src/garden-alternative.ts', access: 'read', status: 'planned', symbol: 'deliverAlternative' });
  if (upperWake) {
    const operation = desired.nodes.find(node => node.id === 'garden-produce-operation')!;
    const wake = clone(desired.tests.find(item => item.node === produce.id)!);
    wake.id = 'garden-operation-wake'; wake.node = operation.id;
    wake.contract!.entrypoint.path = 'README.md'; operation.tests.push(wake.id);
    desired.tests.push(wake);
    desired.connectors.find(item => item.id === 'garden-flow')!.wakeTest = wake.id;
    desired.anchors.push({ id: 'garden-accepted-operation-anchor', owner: operation.id, outcome: operation.outcome, test: wake.id });
  }
  if (late) {
    const operation = desired.nodes.find(node => node.id === 'garden-later-operation')!;
    operation.parent = 'garden-produce-block';
    desired.edges!.push({ id: 'later-realizes-second-consumer', relation: 'realizes', source: operation.id,
      target: 'garden-later-block', condition: 'The operation realizes both retained consumers' });
    const work = desired.nodes.find(node => node.id === 'w-garden-later-operation')!;
    work.id = 'garden-later-work'; work.code = [{ path: 'garden-later-work.txt', access: 'write', status: 'planned' }];
    work.tests = ['garden-later-work-test']; desired.horizon.push(work.id);
    const test = clone(desired.tests.find(item => item.node === 'garden-consume-work')!);
    test.id = work.tests[0]!; test.node = work.id; test.covers = [];
    test.contract!.entrypoint.path = work.code[0]!.path; test.contract!.counterfactuals = [];
    desired.tests.push(test);
    const sleeping = desired.connectors.find(item => item.id === 'garden-flow')!.bindings.find(binding => binding.anchor !== null)!;
    sleeping.anchor = null; sleeping.consumers = [{ node: work.id, port: 'in', codeRef: clone(work.code[0]!) }];
  }
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, 'garden', l1 as Graph, field => {
    const value = preparedField('garden', field);
    if (late && field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'late-proof',
      question: 'Which result proof must each retained consumer provide?', consumer: 'garden-later-operation',
      moment: 'task-result', blocksCurrentStage: false, resolution: 'Retain the result proof for concrete work' }];
    return value;
  });
  let input = ok(writeOmInput(store, { project: 'garden', expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const initial = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(store.get('graph:garden')!),
    refinement: null, available: {}, choice: { choiceVersion: 'first-works-upper', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame2: FrameRequest = { project: 'garden', level: 2, graph: reference(store.get('graph:garden')!),
    horizon: reference(initial.gate), layer: null, frame: null, upper: null };
  const proposal2Value = proposalFor(clone(ok(prepareFrame(store, frame2))) as unknown as FrameRead, desired);
  if (upperWake) proposal2Value.redefines.push('garden-flow');
  const proposal2 = put(store, 'first-works-upper', proposal2Value);
  const candidate2 = ok(writeCandidate(store, { frame: frame2, proposals: [proposal2] }));
  assert.equal(candidate2.state, 'candidate'); if (candidate2.state !== 'candidate') throw new Error('L2 candidate missing');
  const candidateRef = reference(candidate2.record);
  const accepted = ok(settleCandidate(store, { project: 'garden', level: 2, candidate: candidateRef,
    outcome: { gate: 'G3', candidate: candidateRef, graphHash: candidate2.record.value.graphHash, passed: true, codes: [] } }));
  const graph = reference(accepted.graph!), layer2 = reference(accepted.layer!), upperFrame = reference(accepted.frame!);
  if (late) input = ok(writeAddressing(store, { project: 'garden', input: reference(input), graph,
    decisions: [{ pending: inputDecisionWrite({ project: 'garden', input: reference(input), graph, layers: [layer2],
      decision: { target: 'discovery:late-proof', field: 'address', value: { consumer: 'garden-later-operation', kind: 'post-implementation-proof' } } }) as Write }] }));
  const horizon = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph, refinement: layer2,
    available: {}, choice: { choiceVersion: 'first-real-works', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame: FrameRequest = { project: 'garden', level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
    upper: { horizon: reference(horizon.gate), frame: upperFrame } };
  const read = clone(ok(prepareFrame(store, frame))) as unknown as FrameRead;
  const proposal = proposalFor(read, desired), proposalRef = put(store, 'first-real-works', proposal);
  const works: ProposalRequest = { frame: read.request, proposals: [proposalRef] };
  const gaps = ok(writeGaps(store, { project: 'garden', input: reference(input), graph, horizon: frame.horizon,
    operations: { frame: { ...frame2, graph, horizon: frame.horizon, layer: layer2, frame: upperFrame }, proposals: [] }, works }));
  const gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project: 'garden', previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const assignments: { pending: Write }[] = [];
  if (late) {
    const gap = gaps.records.find(row => row.value.gap.target === 'discovery:late-proof')!;
    assert.ok(gap); assert.equal(gap.value.gap.consumers.length, 2);
    const value = clone(okOwner({ contract: OM_OWNER_ASSIGNMENT_CONTRACT, project: 'garden', context: { gaps: gapRead, lines: reference(lines) },
      gap: reference(gap), assignments: gap.value.gap.consumers.map(consumer => ({ responsibleNode: 'garden-later-operation',
        responsibleConsumer: consumer, reason: 'One real work preserves both result duties', returnCondition: `Prove result for ${consumer}`, wake: null })) }));
    assignments.push({ pending: { id: `om-owner-gap-assignment:garden:${hashJson(value)}`, kind: OM_OWNER_ASSIGNMENT_KIND, expected: 0, value } });
  }
  const ledger = ok(writeOmObligations(store, { project: 'garden', gaps: gapRead, lines: reference(lines), assignments }));
  const bindings: TaskObligationBinding[] = ledger.handoff.obligations.map(obligation => ({ id: taskBindingId(clone(obligation) as CarriedObligation),
    scope: obligation.scope, obligation: obligation.obligation, consumers: [{ node: 'garden-later-work', tests: ['garden-later-work-test'] }] }));
  const request: CandidateRequest = { ...works, works: { contract: 'works-frame/v1', producer: reference(ledger.producer), ledger: reference(ledger.record), bindings } };
  return { root, database, store, desired, read, proposal, proposalRef, request, ledger, lines, gaps, graph, layer2, upperFrame };
}
const okOwner = (value: OwnerGapAssignment) => normalizeOwnerGapAssignment(value) as OwnerGapAssignment;

test('F2 stores the first real L3 candidate with distinct local/cross flows, exact code addresses and mechanical sleeping delivery', t => {
  const f = firstWorks(t), before = heads(f.store);
  assert.equal(f.store.get('om-frame:garden:3'), null);
  assert.equal(f.request.frame.layer, null);
  const prepared = ok(prepareWorksFrame(f.store, f.request));
  assert.deepEqual(heads(f.store), before); assert.equal(prepared.state, 'candidate');
  if (prepared.state !== 'candidate') return;
  assert.deepEqual(prepared, ok(prepareCandidate(f.store, f.request)));
  const graph = prepared.candidate.graph as Graph;
  assert.deepEqual(validateGraph(graph).findings, []);
  assert.deepEqual(projectGraph(graph, 2), projectGraph(f.read.upper, 2));
  assert.deepEqual(graph.researchObligations, []);
  assert.deepEqual(prepared.candidate.request.works, f.request.works);
  assert.equal(prepared.candidate.request.frame.workZoneContract, 'accepted-l2-v1');
  const identities = new Set(prepared.candidate.fills.filter(fill => fill.source === 'identity').map(fill => fill.node));
  assert.ok(identities.size > 0); assert.ok(graph.horizon.every(id => !identities.has(id)));
  assert.deepEqual([...graph.horizon].sort(), ['garden-consume-work', 'garden-prep-work', 'garden-produce-work']);
  const local = graph.connectors.find(item => item.id === 'garden-prep-flow')!.bindings.filter(binding => binding.level === 3);
  assert.equal(local.length, 1); assert.equal(local[0]!.producer.node, 'garden-prep-work');
  assert.deepEqual(local[0]!.consumers.map(end => end.node), ['garden-produce-work']);
  const connector = graph.connectors.find(item => item.id === 'garden-flow')!, flows = connector.bindings.filter(binding => binding.level === 3);
  const alternate = flows.find(binding => binding.producer.port === 'out-alt')!;
  assert.deepEqual(alternate.producer.codeRef, f.desired.nodes.find(node => node.id === 'garden-produce-work')!.code[1]);
  assert.deepEqual(alternate.consumers.map(end => end.port), ['in']);
  const active = flows.find(binding => binding.producer.port === 'out' && binding.anchor === null)!;
  assert.deepEqual(active.consumers.map(end => end.port).sort(), ['in', 'in-alt']);
  const sleeping = flows.filter(binding => binding.anchor !== null);
  assert.equal(sleeping.length, 1);
  for (const binding of sleeping) {
    assert.ok(binding.consumers.every(end => !graph.horizon.includes(end.node)));
    const anchor = graph.anchors.find(item => item.id === binding.anchor)!;
    assert.equal(anchor.owner, binding.producer.node); assert.equal(anchor.outcome, connector.artifact);
    assert.ok(graph.tests.some(item => item.id === anchor.test && item.node === binding.producer.node));
    assert.ok(graph.tests.some(item => item.id === connector.wakeTest && item.covers.includes(connector.id)));
  }
  for (const flow of graph.connectors.flatMap(item => item.bindings).filter(binding => binding.level === 3)) {
    for (const end of [flow.producer, ...flow.consumers]) {
      if (identities.has(end.node)) assert.equal(end.codeRef, undefined);
      else assert.ok(graph.nodes.find(node => node.id === end.node)!.code.some(code => same(code, end.codeRef)));
    }
  }
  const written = ok(writeWorksFrame(f.store, f.request)); assert.equal(written.state, 'candidate');
  if (written.state !== 'candidate') return;
  for (const row of before) assert.deepEqual({ head: reference(f.store.get(row.head.id)!), history: f.store.history(row.head.id).map(reference) }, row);
  assert.equal(f.store.list().length, before.length + 1);
  assert.equal(f.store.get<LayerProposal>(f.proposalRef.id)!.value.status, 'proposed');
  const request = { project: 'garden', candidate: reference(written.record) }, saved = heads(f.store);
  assert.deepEqual(ok(readWorksFrame(f.store, request)), ok(readCandidate(f.store, request)));
  assert.deepEqual(ok(writeWorksFrame(f.store, f.request)), written); assert.deepEqual(heads(f.store), saved);
  denied(gateCandidate(f.store, request), 'candidate_level_unsupported');
  for (const gate of ['G3', 'G5'] as const) denied(settleCandidate(f.store, { ...request, level: 3,
    outcome: { gate, candidate: request.candidate, graphHash: written.record.value.graphHash, passed: true, codes: [] } }), 'candidate_level_unsupported');
  assert.deepEqual(heads(f.store), saved);
  const restarted = new Store(f.database);
  try { assert.deepEqual(ok(readWorksFrame(restarted, request)), written.record); assert.deepEqual(ok(writeWorksFrame(restarted, f.request)), written); }
  finally { restarted.close(); }
});

test('F2 requires explicit D7 era, ledger, exact proposal context and bindings even for an empty handoff', t => {
  const f = firstWorks(t), before = heads(f.store), original = f.request;
  for (const [bad, badCode] of [
    [{ ...original, works: undefined }, 'works_contract_invalid'], [{ ...original, works: null }, 'works_contract_invalid'],
    [{ ...original, works: { ...original.works!, contract: 'unknown' } }, 'works_contract_invalid'],
    [{ ...original, works: { ...original.works!, ledger: undefined } }, 'works_contract_invalid'],
    [{ ...original, works: { ...original.works!, bindings: undefined } }, 'works_contract_invalid'],
    [{ ...original, works: { ...original.works!, ledger: original.works!.producer } }, 'works_obligations_invalid'],
    [{ ...original, works: { ...original.works!, producer: { ...original.works!.producer, hash: '0'.repeat(64) } } }, 'record_forged'],
  ] as const) for (const action of [prepareWorksFrame, writeWorksFrame]) denied(action(f.store, bad as CandidateRequest), badCode);
  assert.deepEqual(heads(f.store), before);
  const peer = put(f.store, 'extra-work-context', { ...clone(f.proposal), nodes: [], fills: [], tests: [], artifacts: [], contracts: [], edges: [], journeys: [] });
  const changed = heads(f.store);
  denied(prepareWorksFrame(f.store, { ...original, proposals: [...original.proposals, peer] }), 'works_obligations_invalid');
  assert.deepEqual(heads(f.store), changed);
  const source = ok(prepareFrameProposals(f.store, { frame: original.frame, proposals: original.proposals }));
  for (const field of ['codeRef', 'foreignCode', 'reserved', 'contract', 'wake', 'ambiguousWake', 'anchor',
    'localMissingCode', 'localForeignCode', 'upperDrift'] as const) {
    const proposal = clone(f.proposal);
    if (field === 'codeRef') delete proposal.fills.find(fill => fill.port !== undefined)!.codeRef;
    if (field === 'foreignCode') proposal.fills.find(fill => fill.port !== undefined)!.codeRef = { path: 'foreign.ts', access: 'write', status: 'planned' };
    if (field === 'contract') delete proposal.worksContract;
    if (field === 'reserved') proposal.nodes.push(clone(source.result.representatives[0]!) as Node);
    const producer = proposal.nodes.find(node => node.id === 'garden-produce-work')!;
    if (field === 'wake') producer.tests = [];
    if (field === 'ambiguousWake') {
      const test = clone(proposal.tests.find(item => item.id === producer.tests[0])!);
      test.id += '-ambiguous'; producer.tests.push(test.id); proposal.tests.push(test);
    }
    if (field === 'anchor') proposal.localConnectors.push({ id: 'local-invalid-sleep', artifact: 'garden-prep', returnsTo: 'garden-produce-block', wakeTest: null,
      bindings: [{ level: 3, producer: { node: producer.id, port: 'out', codeRef: clone(producer.code[0]!) },
        consumers: [{ node: source.result.representatives.find(node => node.parent === 'garden-later-operation')!.id, port: 'in' }], anchor: null }] });
    if (field === 'localMissingCode' || field === 'localForeignCode') {
      const prep = proposal.nodes.find(node => node.id === 'garden-prep-work')!;
      proposal.localConnectors.push({ id: 'local-work-code-contract', artifact: 'garden-prep', returnsTo: 'garden-produce-block', wakeTest: null,
        bindings: [{ level: 3, producer: { node: prep.id, port: 'out', codeRef: clone(prep.code[0]!) },
          consumers: [{ node: producer.id, port: 'in', ...(field === 'localForeignCode'
            ? { codeRef: { ...clone(producer.code[0]!), path: 'foreign/local-consumer.ts' } } : {}) }], anchor: null }] });
    }
    if (field === 'upperDrift') {
      const artifact = proposal.artifacts.find(item => item.id === 'garden-data')!;
      artifact.purpose = 'A changed accepted upper artifact'; proposal.redefines.push(artifact.id);
    }
    const observation = { reference: { ...f.proposalRef, hash: hashJson(proposal) }, value: proposal };
    const result = assembleCandidate(clone(source.frame) as unknown as FrameRead, [observation], original.works);
    denied(result, field === 'wake' || field === 'ambiguousWake' ? 'sleeping_wake_test_missing'
      : field === 'anchor' ? 'sleeping_anchor_underivable' : field === 'localMissingCode' ? 'works_code_missing'
      : field === 'localForeignCode' ? 'works_code_foreign' : field === 'upperDrift' ? 'works_upper_drift'
      : field === 'reserved' ? 'proposal_node_reserved' : field === 'contract' ? 'proposal_invalid' : 'slot_fill_foreign');
  }
});

// G5 (№3820, №3822, №3841): the sleeping flow takes the wake test the producer work named for its end among several
// covering tests; without a choice it keeps the rule of its era — exactly one covering test — and never takes the first
// of several; a named test that does not cover the flow, or another work's, is refused by the common E2 rule.
test('G5 a sleeping flow takes the named wake test of its producer end among three covering tests; no choice among several keeps sleeping_wake_test_missing; a test not covering the flow or of another work is refused', t => {
  const f = firstWorks(t);
  const source = ok(prepareFrameProposals(f.store, { frame: f.request.frame, proposals: f.request.proposals }));
  const producer = f.proposal.nodes.find(node => node.id === 'garden-produce-work')!;
  const covering = f.proposal.tests.filter(test => test.node === producer.id && producer.tests.includes(test.id) && test.covers.includes('garden-flow'));
  assert.equal(covering.length, 1, 'The fixture work has one covering test: its sleeping flow needs no choice (F2 above)');
  const ends = source.result.obligations.filter(item => item.connector === 'garden-flow' && item.role === 'producer').map(item => item.id);
  const several = clone(f.proposal), work = several.nodes.find(node => node.id === producer.id)!;
  for (const suffix of ['second', 'third']) {
    several.tests.push({ ...clone(covering[0]!), id: `${covering[0]!.id}-${suffix}` }); work.tests.push(`${covering[0]!.id}-${suffix}`);
  }
  const assemble = (proposal: LayerProposal) => assembleCandidate(clone(source.frame) as unknown as FrameRead,
    [{ reference: { ...f.proposalRef, hash: hashJson(proposal) }, value: proposal }], f.request.works);
  denied(assemble(several), 'sleeping_wake_test_missing');
  const choose = (test: string) => {
    const proposal = clone(several);
    for (const fill of proposal.fills) if (ends.includes(fill.obligation) && fill.node === producer.id) fill.wakeTest = test;
    return proposal;
  };
  const chosen = ok(assemble(choose(`${covering[0]!.id}-third`)));
  assert.equal(chosen.state, 'candidate'); if (chosen.state !== 'candidate') return;
  const graph = chosen.candidate.graph as Graph;
  const sleeping = graph.connectors.find(item => item.id === 'garden-flow')!.bindings.filter(binding => binding.level === 3 && binding.anchor !== null);
  assert.equal(sleeping.length, 1);
  assert.equal(graph.anchors.find(item => item.id === sleeping[0]!.anchor)!.test, `${covering[0]!.id}-third`, 'The named test wakes the sleeping consumers');
  assert.deepEqual(validateGraph(graph).findings, []);
  const narrow = choose('g5-narrow');
  narrow.tests.push({ ...clone(covering[0]!), id: 'g5-narrow', covers: [] }); narrow.nodes.find(node => node.id === producer.id)!.tests.push('g5-narrow');
  denied(assemble(narrow), 'slot_fill_foreign');
  const foreign = f.proposal.tests.find(test => test.node !== producer.id && test.covers.includes('garden-flow'))
    ?? f.proposal.tests.find(test => test.node !== producer.id)!;
  denied(assemble(choose(foreign.id)), 'slot_fill_foreign');
});

test('F2 preserves an accepted operation wake test while deriving a separate work-owned sleeping anchor', t => {
  const f = firstWorks(t, false, true), upper = projectGraph(f.read.upper, 2);
  const upperConnector = upper.connectors.find(item => item.id === 'garden-flow')!;
  assert.equal(upperConnector.wakeTest, 'garden-operation-wake');
  assert.ok(upper.anchors.some(anchor => anchor.id === 'garden-accepted-operation-anchor'));
  const written = ok(writeWorksFrame(f.store, f.request));
  assert.equal(written.state, 'candidate'); if (written.state !== 'candidate') return;
  const graph = written.record.value.graph as Graph;
  assert.deepEqual(projectGraph(graph, 2), upper);
  const connector = graph.connectors.find(item => item.id === upperConnector.id)!;
  assert.equal(connector.wakeTest, upperConnector.wakeTest);
  const sleeping = connector.bindings.filter(binding => binding.level === 3 && binding.anchor !== null);
  assert.equal(sleeping.length, 1);
  const anchor = graph.anchors.find(item => item.id === sleeping[0]!.anchor)!;
  assert.equal(anchor.owner, 'garden-produce-work');
  assert.notEqual(anchor.test, connector.wakeTest);
  assert.ok(graph.tests.some(item => item.id === anchor.test && item.node === anchor.owner && item.covers.includes(connector.id)));
  assert.deepEqual(graph.anchors.find(item => item.id === 'garden-accepted-operation-anchor'),
    upper.anchors.find(item => item.id === 'garden-accepted-operation-anchor'));
  assert.deepEqual(ok(readWorksFrame(f.store, { project: 'garden', candidate: reference(written.record) })), written.record);
});

test('F2 retains distinct D7 assignments of one gap and validates consumers against the assembled new works', t => {
  const f = firstWorks(t, true), works = f.request.works!;
  assert.equal(works.bindings.length, 2); assert.equal(new Set(works.bindings.map(binding => binding.obligation)).size, 1);
  assert.equal(new Set(works.bindings.map(binding => binding.id)).size, 2);
  const prepared = ok(prepareWorksFrame(f.store, f.request)); assert.equal(prepared.state, 'candidate');
  if (prepared.state !== 'candidate') return;
  assert.deepEqual(prepared.candidate.graph.researchObligations!.map(canonical).sort(), works.bindings.map(canonical).sort());
  const before = heads(f.store);
  const first = works.bindings[0]!;
  for (const bindings of [works.bindings.slice(1), [first, first],
    [{ ...first, consumers: [{ node: 'garden-consume-work', tests: [] }] }, works.bindings[1]!],
    [{ ...first, consumers: [{ node: 'garden-later-work', tests: ['garden-produce-work-test'] }] }, works.bindings[1]!]]) {
    denied(prepareWorksFrame(f.store, { ...f.request, works: { ...works, bindings } }), 'works_obligations_invalid');
  }
  assert.deepEqual(heads(f.store), before);
});

test('F2 hands D7 and C2 guards to the candidate transaction without publishing a partial candidate', async t => {
  const f = firstWorks(t), prepared = ok(prepareWorksFrame(f.store, f.request));
  assert.equal(prepared.state, 'candidate'); if (prepared.state !== 'candidate') return;
  const selected = [f.graph, f.layer2, f.upperFrame, f.proposalRef, reference(f.lines), reference(f.ledger.producer), reference(f.ledger.record),
    reference(f.store.get('source:garden:brief')!)];
  const saved = await f.store.snapshot(join(f.root, 'before-candidate'));
  for (const [index, guard] of selected.entries()) {
    assert.ok(prepared.guards.some(ref => same(ref, guard)), `Missing guard ${guard.id}`);
    const path = join(f.root, `guard-${index}.sqlite`); copyFileSync(saved.path, path);
    const branch = new Store(path);
    try {
      const row = branch.get(guard.id)!; branch.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
      const before = heads(branch);
      denied(writeGuarded(branch, { unit: 'F2', target: 'works-candidate', writes: prepared.writes, guards: prepared.guards }), 'input_stale');
      assert.deepEqual(heads(branch), before);
      denied(prepareWorksFrame(branch, f.request), index < 5 ? 'input_stale' : index < 7 ? 'obligation_record_invalid' : 'stage_not_accepted');
      assert.deepEqual(heads(branch), before);
    } finally { branch.close(); }
  }
});

test('F2 carries an actually accepted OM L3 and reads its candidate after source advances and restart', async t => {
  const f = await createCrossOmFixture(t, "garden", { mode: "executed" }), store = f.store;
  const input = store.get("om-input:garden")!;
  const horizon = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(f.graphRevision),
    refinement: reference(f.layers[2]), available: {},
    choice: { choiceVersion: 'accepted-work-carry', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame: FrameRequest = { project: 'garden', level: 3, graph: reference(f.graphRevision), horizon: reference(horizon.gate),
    layer: reference(f.layers[3]), frame: reference(store.get("om-frame:garden:3")!),
    upper: { horizon: reference(horizon.gate), frame: reference(store.get("om-frame:garden:2")!) } };
  const current = ok(prepareFrame(store, frame));
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: frame.frame }, level: 3, worksContract: 'works-frame/v1', source: 'decision', status: 'proposed',
    nodes: [], fills: [], localConnectors: [], artifacts: [], contracts: [], joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
  // Current F5 already saved explicit code/identity fills; an empty proposal carries them unchanged.
  const proposalRef = put(store, 'accepted-work-carry', proposal);
  const readyProducer = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph: frame.graph,
    refinement: reference(f.layers[2]),
    available: { 'garden-produce-block': { 'garden-data': reference(f.receipts['garden-data']!) } },
    choice: { choiceVersion: 'ready-producer-work-carry', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const readyFrame = clone(ok(prepareFrame(store, { ...frame, horizon: reference(readyProducer.gate) }))) as unknown as FrameRead;
  assert.ok(!readyFrame.scope.nodes.includes('garden-produce-operation'));
  const works = { frame: current.request as FrameRequest, proposals: [proposalRef] };
  const gaps = ok(writeGaps(store, { project: 'garden', input: reference(input), graph: frame.graph, horizon: frame.horizon,
    operations: { frame: { ...frame, level: 2, layer: reference(f.layers[2]), frame: reference(store.get("om-frame:garden:2")!), upper: null }, proposals: [] }, works }));
  const read = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const priorLines = store.get<import('../src/om/gap-lines.js').GapLinesRecord>(gapLinesId('garden'));
  const lines = ok(writeGapLines(store, { project: 'garden', previous: priorLines ? reference(priorLines) : null,
    pass: (priorLines?.value.request.pass ?? 0) + 1, gaps: read, closures: [] }));
  const ledger = ok(writeOmObligations(store, { project: 'garden', gaps: read, lines: reference(lines), assignments: [] }));
  const request: CandidateRequest = { ...works, works: { contract: 'works-frame/v1', producer: reference(ledger.producer), ledger: reference(ledger.record), bindings: [] } };
  const ready = ok(assembleCandidate(readyFrame, [{ reference: proposalRef, value: proposal }], request.works));
  assert.equal(ready.state, 'candidate'); if (ready.state !== 'candidate') return;
  assert.ok(!ready.candidate.graph.horizon.includes('garden-produce-work'));
  assert.ok(ready.candidate.graph.horizon.includes('garden-consume-work'));
  const outsideProducerFlows = ready.candidate.graph.connectors.find(item => item.id === 'garden-flow')!.bindings.filter(binding => binding.level === 3);
  assert.ok(outsideProducerFlows.length > 0 && outsideProducerFlows.every(binding => binding.anchor === null));
  assert.deepEqual(ready.candidate.graph.anchors, f.graph.anchors, 'An outside producer must not create a sleeping anchor');
  const written = ok(writeWorksFrame(store, request)); assert.equal(written.state, 'candidate'); if (written.state !== 'candidate') return;
  const candidate = { project: 'garden', candidate: reference(written.record) };
  const historical = ok(readWorksFrame(store, candidate));
  const row = store.get(proposalRef.id)!; store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
  f.reopen();
  assert.deepEqual(ok(readWorksFrame(f.store, candidate)), historical);
  denied(prepareWorksFrame(f.store, request), 'input_stale');
});

test('F2 recorded carry resolves different code addresses of one consumer port by its exact upper flow', () => {
  // This is the pure C2/C4 boundary. The stored D7 admission is exercised by the fixtures above.
  const graph = gardenGraph('cross'), consumer = graph.nodes.find(node => node.id === 'garden-consume-work')!;
  const first = clone(consumer.code[0]!);
  const second = { ...first, path: 'src/garden-second-consumer.ts', symbol: 'consumeAlternative' };
  consumer.code.push(second);
  const outside = graph.nodes.find(node => node.id === 'w-garden-later-operation')!;
  outside.code = [{ path: 'future/garden-consumer.ts', access: 'write', status: 'planned' }];
  const connector = graph.connectors.find(item => item.id === 'garden-flow')!;
  for (const binding of connector.bindings.filter(item => item.level === 3)) for (const endpoint of binding.consumers) {
    if (endpoint.node === outside.id) endpoint.codeRef = clone(outside.code[0]!);
    if (endpoint.node === consumer.id && endpoint.port === 'in') endpoint.codeRef = clone(binding.producer.port === 'out-alt' ? second : first);
  }
  // The recorded works frame keeps the mechanically derived anchor address of the sleeping delivery.
  const { level: _l0, ...preUpper } = projectGraph(graph, 2);
  const upperOut = (preUpper as Graph).connectors.find(item => item.id === 'garden-flow')!.bindings
    .find(item => item.level === 2 && item.producer.port === 'out')!;
  const anchor = workAnchorId('garden-flow', flowKey(upperOut), { node: 'garden-produce-work', port: 'out' });
  graph.anchors.find(item => item.id === 'anchor-garden-flow')!.id = anchor;
  connector.bindings.find(item => item.level === 3 && item.anchor === 'anchor-garden-flow')!.anchor = anchor;
  assert.deepEqual(validateGraph(graph).findings, []);
  const { level: _level, ...projection } = projectGraph(graph, 2), upper = projection as Graph;
  const ref = (id: string): Ref => ({ id, revision: 1, hash: hashJson(id) });
  const graphRef = { ...ref('graph:garden'), hash: hashJson(graph) }, upperRef = ref('graph-layer:garden:2');
  const scope = { nodes: ['garden-consume-operation', 'garden-prep-operation', 'garden-produce-operation'], excluded: [], hash: hashJson('legacy-cross-scope') };
  // Derive the full fill set, then record it in the worksContract ConnectionFrame with the code reference
  // each real end already carries on its exact lower flow. No code is derived from history at assembly.
  const skeleton = explicitMapping(graph, upper, scope, 3);
  const endpointCode = (fill: FrameFill) => {
    const obligation = skeleton.obligations.find(item => item.id === fill.obligation)!;
    if (fill.source !== 'accepted' || obligation.kind !== 'connection-end') return undefined;
    const upperBinding = upper.connectors.find(item => item.id === obligation.connector)!.bindings
      .find(item => item.level === 2 && flowKey(item) === obligation.flow)!;
    const endpoints = graph.connectors.find(item => item.id === obligation.connector)!.bindings
      .filter(item => item.level === 3 && item.producer.port === upperBinding.producer.port)
      .flatMap(item => [item.producer, ...item.consumers]);
    return clone(endpoints.find(item => item.node === fill.node && item.port === fill.port)!.codeRef!);
  };
  const fills = canonicalSorted(skeleton.fills.map(fill => {
    const withSource = { ...fill, source: 'accepted' as const, basis: graphRef } as FrameFill;
    const codeRef = endpointCode(withSource);
    return { ...withSource, ...(codeRef ? { codeRef } : {}) };
  }));
  const frameValue = { project: 'garden', level: 3 as const, candidateHash: '0'.repeat(64),
    layerHash: hashJson(projectGraph(graph, 3)), worksContract: WORKS_FRAME_CONTRACT, fills };
  const frameRef = { ...ref('om-frame:garden:3'), hash: hashJson(frameValue) };
  const accepted = { graph, reference: graphRef, frame: { reference: frameRef, value: frameValue } };
  const result = clone(ok(fillObligations(upper, scope, accepted, upperRef, 3))) as FrameRead['result'];
  const rows = result.fills.filter(fill => fill.node === consumer.id && fill.port === 'in');
  assert.equal(rows.length, 2); assert.ok(rows.every(fill => Object.hasOwn(fill, 'codeRef')));
  const frame: FrameRead = { request: { project: 'garden', level: 3, graph: graphRef, horizon: ref('om-horizon:garden:legacy-cross'),
    layer: ref('graph-layer:garden:3'), frame: frameRef, upper: { horizon: ref('om-horizon:garden:legacy-cross'), frame: ref('om-frame:garden:2') } },
    upper, upperRef, scope, accepted, result, references: [graphRef, upperRef] };
  const works = { contract: 'works-frame/v1' as const, producer: ref('om-obligation-basis:garden:cross'),
    ledger: ref('om-obligations:garden:cross'), bindings: [] };
  const built = ok(assembleCandidate(frame, [], works));
  assert.equal(built.state, 'candidate'); if (built.state !== 'candidate') return;
  const flows = built.candidate.graph.connectors.find(item => item.id === connector.id)!.bindings.filter(binding => binding.level === 3);
  for (const [port, code] of [['out', first], ['out-alt', second]] as const) {
    const flow = flows.find(binding => binding.producer.port === port && binding.anchor === null)!;
    assert.deepEqual(flow.consumers.find(endpoint => endpoint.node === consumer.id && endpoint.port === 'in')!.codeRef, code);
  }
  assert.deepEqual(projectGraph(built.candidate.graph as Graph, 2), projectGraph(upper, 2));
  // An inherited frame recorded before the works contract cannot be revived: the read itself refuses it.
  const legacy = { project: 'garden', level: 3 as const, candidateHash: '0'.repeat(64),
    layerHash: frameValue.layerHash, fills: clone(fills) };
  const legacyRef = { ...frameRef, hash: hashJson(legacy) };
  const legacyAccepted = { graph, reference: graphRef, frame: { reference: legacyRef, value: legacy } };
  denied(fillObligations(upper, scope, legacyAccepted, upperRef, 3), 'frame_record_invalid');
});
