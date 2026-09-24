import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hashJson } from '../src/canonical.js';
import { requireCompatibleReceipt, resolveArtifact } from '../src/compiler/inputs.js';
import { nodeSignature, type ArtifactReceipt } from '../src/compiler/model.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { EngineError } from '../src/errors.js';
import { ProductEngine } from '../src/product/engine.js';
import type { Graph } from '../src/graph/model.js';
import { prepareWriterIndex, readWriterIndex, writerIndexId } from '../src/ownership/writer-index.js';
import { Owners, readWriter, selectWriter } from '../src/ownership/owners.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { git } from '../src/runtime/environment.js';
import { Store, type Revision, type Write } from '../src/storage/store.js';
import { checkDeliveries, prepareDeliveries, readDeliveries, type DeliveryBases, type DeliveryCheck, type DeliveryReadRequest } from '../src/om/deliveries.js';
import type { CandidateRequest } from '../src/om/frame-candidate.js';
import { prepareFrame, type FrameRequest } from '../src/om/frame-obligations.js';
import type { LayerProposal, ProposalRequest } from '../src/om/frame-proposals.js';
import { writeGapLines } from '../src/om/gap-lines.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeOmInput } from '../src/om/input.js';
import { writeOmObligations } from '../src/om/obligations.js';
import { writeGuarded } from '../src/om/refs.js';
import type { OmResult, Sealed } from '../src/om/refusal.js';
import { writeWorksFrame } from '../src/om/works-frame.js';
import { createCrossOmFixture } from './om-fixture.js';

const clone = structuredClone;
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const heads = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function denied(result: OmResult<unknown>, code?: string) {
  if (result.ok) assert.fail(`Expected ${code ?? 'a typed refusal'}`);
  if (code) assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target && (result.refusal.at.field || result.refusal.at.ref));
}
function finding(result: Sealed<DeliveryCheck>, code: string, target?: string) {
  const found = result.findings.find(row => row.code === code && (target === undefined || row.target === target));
  assert.ok(found, `Missing ${code} at ${target ?? '*'}: ${canonical(result.findings)}`);
  assert.equal(found.route, 'readiness');
  assert.ok(found.target);
  return found;
}
const engineCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;

/** Every persisted source is produced by its native writer, including the empty D1→D2→D7 handoff. */
async function readyCandidate(t: TestContext, fixture?: Awaited<ReturnType<typeof createCrossOmFixture>>, available = true) {
  const preExecution: Revision[] = [];
  let f = fixture;
  if (!f) {
    const writeMany = Store.prototype.writeMany;
    Store.prototype.writeMany = function(this: Store, inputs, guards) {
      if (!preExecution.length && inputs.some(write => write.kind === 'execution-lock'))
        for (const head of this.list()) preExecution.push(...this.history(head.id));
      return writeMany.call(this, inputs, guards);
    } as typeof writeMany;
    try { f = await createCrossOmFixture(t); } finally { Store.prototype.writeMany = writeMany; }
  }
  const store = f.store;
  const input = ok(writeOmInput(store, { project: 'garden', expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> }));
  const receipt = f.receipts['garden-data']!;
  const bases: DeliveryBases = available ? { 'garden-produce-block': { 'garden-data': reference(receipt) } } : {};
  const horizon = ok(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(f.graphRevision),
    refinement: reference(store.get('phase:garden:L2')!), available: bases,
    choice: { choiceVersion: 'deliveries-ready', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame: FrameRequest = { project: 'garden', level: 3, graph: reference(f.graphRevision), horizon: reference(horizon.gate),
    layer: reference(f.layers[3]), frame: null, upper: { horizon: reference(horizon.gate), frame: null } };
  const current = ok(prepareFrame(store, frame));
  const proposal: LayerProposal = { base: { graph: frame.graph, frame: null }, level: 3, worksContract: 'works-frame/v1',
    source: 'decision', status: 'proposed', nodes: [], fills: [], localConnectors: [], artifacts: [], contracts: [], joins: [],
    tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] };
  // This legacy accepted consumer has no code. Its explicit replacement preserves the outside work.
  const outside = clone(f.graph.nodes.find(node => node.id === 'w-garden-later-operation')!);
  outside.code = [{ path: 'future/garden-later.ts', access: 'write', status: 'planned', symbol: 'consume' }];
  proposal.nodes.push(outside); proposal.removes.push(outside.id);
  for (const fill of current.result.fills.filter(item => item.node === outside.id)) {
    proposal.fills.push({ obligation: fill.obligation, node: outside.id,
      ...(fill.port === undefined ? {} : { port: fill.port, codeRef: clone(outside.code[0]!) }) });
    proposal.replaces.push({ obligation: fill.obligation, base: { node: outside.id, graph: frame.graph },
      with: { node: outside.id, port: fill.port ?? null }, basis: 'Retain the accepted consumer with an explicit planned code address' });
  }
  const proposalRef = reference(store.write({ id: 'om-proposal:garden:deliveries-carry', kind: 'layer-proposal', expected: 0, value: proposal }));
  const works: ProposalRequest = { frame: current.request as FrameRequest, proposals: [proposalRef] };
  const gaps = ok(writeGaps(store, { project: 'garden', input: reference(input), graph: frame.graph, horizon: frame.horizon,
    operations: { frame: { ...frame, level: 2, layer: reference(f.layers[2]), upper: null }, proposals: [] }, works }));
  const gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = ok(writeGapLines(store, { project: 'garden', previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const ledger = ok(writeOmObligations(store, { project: 'garden', gaps: gapRead, lines: reference(lines), assignments: [] }));
  const request: CandidateRequest = { ...works, works: { contract: 'works-frame/v1',
    producer: reference(ledger.producer), ledger: reference(ledger.record), bindings: [] } };
  const written = ok(writeWorksFrame(store, request));
  assert.equal(written.state, 'candidate'); if (written.state !== 'candidate') throw new Error('Missing works candidate');
  const graph = clone(written.record.value.graph) as Graph;
  assert.deepEqual([...graph.horizon].sort(), available ? ['garden-consume-work'] : ['garden-consume-work', 'garden-prep-work', 'garden-produce-work']);
  assert.equal(nodeSignature(graph, graph.nodes.find(node => node.id === 'garden-produce-work')!), receipt.value.signature);
  const owners = new Owners(store, 'garden', f.repository);
  const owner = (path: string) => owners.latest(path);
  return { f, preExecution, graph, bases, receipt, owner, input, horizon, ledger, lines, proposalRef,
    request: { project: 'garden', candidate: reference(written.record) },
    identities: [...new Set(written.record.value.fills.filter(fill => fill.source === 'identity').map(fill => fill.node))] };
}

test('F3 proves saved ready-producer deliveries and preserves the separate M8 execution boundary', async t => {
  const c = await readyCandidate(t), { f } = c;
  const options = { owner: c.owner, identities: c.identities };
  const check = (store = f.store, graph = c.graph, bases = c.bases) => ok(checkDeliveries(store, 'garden', graph, bases, options));
  const baseline = await f.store.snapshot(join(f.root, 'deliveries-baseline'));
  let branchNumber = 0;
  function branch(action: (store: Store) => void) {
    const path = join(f.root, `delivery-case-${branchNumber++}.sqlite`); copyFileSync(baseline.path, path);
    const store = new Store(path); try { action(store); } finally { store.close(); }
  }
  function receiptWith(store: Store, value: ArtifactReceipt): Ref {
    const previous = store.get(c.receipt.id)!;
    return reference(store.write({ id: previous.id, kind: 'artifact', expected: previous.revision, value }));
  }
  const basis = (ref: Ref): DeliveryBases => ({ 'garden-produce-block': { 'garden-data': ref } });

  await t.test('public receipt compatibility rejects malformed and unresolved addresses before dereferencing', () => {
    type Args = Parameters<typeof requireCompatibleReceipt>;
    const args: Args = [c.receipt, 'garden', c.graph, 'garden-produce-work', 'garden-data'];
    const invalid = (values: unknown[], field: string) => assert.throws(() => requireCompatibleReceipt(...values as Args), (error: unknown) => {
      assert.ok(error instanceof EngineError); assert.equal(error.code, 'receipt_compatibility_invalid');
      const details = error.details as { unit: string; target: string; field: string };
      assert.equal(details.unit, 'compiler/inputs'); assert.ok(details.target); assert.equal(details.field, field); return true;
    });
    assert.strictEqual(requireCompatibleReceipt(...args), c.receipt);
    for (const [index, field] of [[1, 'project'], [3, 'producerId'], [4, 'artifactId']] as const)
      for (const value of [undefined, null, '', 0, {}]) { const values = [...args]; values[index] = value as never; invalid(values, field); }
    invalid([c.receipt, 'garden', c.graph, 'unknown-work', 'garden-data'], 'producerId');
    invalid([c.receipt, 'garden', c.graph, 'garden-produce-work', 'unknown-artifact'], 'artifactId');
    for (const value of [undefined, null, {}, []]) invalid([c.receipt, 'garden', value, args[3], args[4]], 'graph');
    for (const field of ['nodes', 'artifacts', 'contracts', 'tests', 'connectors', 'edges', 'requirements']) {
      for (const value of [undefined, null, {}]) invalid([c.receipt, 'garden', { ...clone(c.graph), [field]: value }, args[3], args[4]], 'graph');
    }
    invalid([c.receipt, 'garden', { ...clone(c.graph), researchObligations: [{ consumers: null }] }, args[3], args[4]], 'graph');
    const noContract = clone(c.graph), contract = noContract.artifacts.find(row => row.id === args[4])!.contract;
    noContract.contracts = noContract.contracts.filter(row => row.id !== contract);
    invalid([c.receipt, 'garden', noContract, args[3], args[4]], `graph.artifacts.${args[4]}.contract`);
    const noOutcome = clone(c.graph); noOutcome.nodes.find(row => row.id === args[3])!.outcome = 'unknown-outcome';
    invalid([c.receipt, 'garden', noOutcome, args[3], args[4]], `graph.nodes.${args[3]}.outcome`);
    const otherOutput = clone(c.graph);
    otherOutput.artifacts.push({ ...clone(otherOutput.artifacts[0]!), id: 'other-output', contract: 'unknown-contract' });
    invalid([c.receipt, 'garden', otherOutput, args[3], args[4]], 'graph.artifacts.other-output.contract');
    for (const value of [undefined, {}, { ...c.receipt, value: null }, { ...c.receipt, revision: null }, { ...c.receipt, hash: 'bad' }])
      invalid([value, ...args.slice(1)], 'receipt');
    assert.throws(() => requireCompatibleReceipt(null, ...args.slice(1) as [string, Graph, string, string]), engineCode('producer_not_ready'));
    for (const field of ['signature', 'contractHash']) assert.throws(() => requireCompatibleReceipt(
      { ...c.receipt, value: { ...c.receipt.value, [field]: hashJson('wrong') } }, 'garden', c.graph, args[3], args[4]), engineCode('producer_not_ready'));
  });

  await t.test('writer and index readers reject malformed public addresses and exact foreign sources', () => {
    const path = c.graph.nodes.find(node => node.id === 'garden-consume-work')!.code.find(code => code.access === 'write')!.path;
    const proof = c.owner(path)!;
    assert.deepEqual(readWriter(f.store, 'garden', f.repository, proof.ref, path), proof);
    assert.deepEqual(selectWriter(f.store, 'garden', f.repository, [proof.ref], path), proof);
    type Args = Parameters<typeof readWriter>;
    const args: Args = [f.store, 'garden', f.repository, proof.ref, path];
    for (const [at, bad] of [[0, null], [1, ''], [2, {}], [3, {}], [4, undefined], [4, null]] as const) {
      const values = [...args]; values[at] = bad as never;
      assert.throws(() => readWriter(...values as Args), engineCode('ownership_proof_foreign'));
    }
    assert.throws(() => readWriter(f.store, 'garden', f.repository, reference(c.receipt), path), engineCode('ownership_proof_foreign'));
    assert.throws(() => readWriter(f.store, 'garden', f.repository, { ...proof.ref, hash: hashJson('forged-writer') }, path), engineCode('ownership_proof_foreign'));
    assert.throws(() => readWriter(f.store, 'other', f.repository, proof.ref, path), engineCode('ownership_proof_foreign'));
    assert.throws(() => readWriter(f.store, 'garden', f.repository, proof.ref, 'unowned-path'), engineCode('ownership_proof_foreign'));
    for (const refs of [undefined, null, {}, [{}]])
      assert.throws(() => selectWriter(f.store, 'garden', f.repository, refs as Ref[], path), engineCode('ownership_proof_foreign'));
    assert.throws(() => writerIndexId('', path), engineCode('writer_index_invalid'));
    assert.throws(() => writerIndexId('garden', undefined as unknown as string), engineCode('writer_index_invalid'));
    assert.throws(() => readWriterIndex(null as unknown as Store, 'garden', path, proof.ref, null), engineCode('writer_index_invalid'));
    assert.throws(() => prepareWriterIndex(null as unknown as Store, 'garden', path, null), engineCode('writer_index_invalid'));
    const root = reference(f.store.get('execution-root:garden')!);
    const index = reference(f.store.get(writerIndexId('garden', path))!);
    for (const bad of [undefined, null, {}, reference(c.receipt), { ...root, hash: hashJson('forged-root') }]) {
      assert.throws(() => readWriterIndex(f.store, 'garden', path, index, bad as Ref), engineCode('writer_index_invalid'));
      assert.throws(() => prepareWriterIndex(f.store, 'garden', path, bad as Ref), engineCode('writer_index_invalid'));
    }
    branch(store => {
      const row = store.get(proof.ref.id)!;
      const malformed = store.write({ id: row.id, kind: row.kind, expected: row.revision, value: { ...row.value as object, artifacts: null } });
      assert.throws(() => readWriter(store, 'garden', f.repository, reference(malformed), path), engineCode('ownership_proof_foreign'));
    });
  });

  await t.test('persisted C4/B2 sources produce one exact receipt for all cross-flow ports, without writes', () => {
    const before = heads(f.store), prepared = ok(prepareDeliveries(f.store, c.request));
    assert.deepEqual(prepared.findings, []);
    assert.deepEqual(prepared.receipts, { '["garden-flow","garden-produce-work"]': reference(c.receipt) });
    assert.deepEqual(check().receipts, prepared.receipts);
    const writerPaths = [...new Set(c.graph.nodes.filter(node => c.graph.horizon.includes(node.id))
      .flatMap(node => node.code.filter(code => code.access === 'write').map(code => code.path)))];
    const writers = Object.fromEntries(writerPaths.flatMap(path => {
      const writer = c.owner(path); return writer ? [[path, writer.ref]] : [];
    }));
    assert.ok(Object.keys(writers).length); assert.deepEqual(prepared.writers, writers);
    assert.ok(Object.isFrozen(prepared.writers));
    for (const ref of Object.values(writers)) {
      assert.ok(prepared.references.some(item => same(item, ref)));
      assert.ok(prepared.guards.some(item => same(item, ref)));
    }
    assert.deepEqual(resolveArtifact(f.store, 'garden', c.graph, f.repository, 'garden-produce-work', 'garden-data'),
      { receipt: reference(c.receipt), source: null });
    for (const ref of [reference(c.receipt), c.request.candidate, reference(c.horizon.horizon), reference(c.horizon.gate)])
      assert.ok(prepared.references.some(item => same(item, ref)), `Missing reference ${ref.id}`);
    const historical = ok(readDeliveries(f.store, prepared.request as DeliveryReadRequest));
    assert.deepEqual(historical.guards, []); assert.deepEqual(historical.receipts, prepared.receipts);
    assert.deepEqual(heads(f.store), before);
  });

  await t.test('missing, foreign, forged and unresolved named bases never fall back to current artifact heads', () => {
    const absent = finding(check(f.store, c.graph, {}), 'available_basis_missing', 'garden-flow');
    assert.deepEqual([absent.producer, absent.block, absent.artifact], ['garden-produce-work', 'garden-produce-block', 'garden-data']);
    const ref = reference(c.receipt);
    for (const bad of [{ ...ref, hash: hashJson('forged') }, { ...ref, revision: ref.revision + 100 },
      reference(f.receipts['garden-result']!)]) {
      const result = check(f.store, c.graph, basis(bad));
      finding(result, 'available_basis_unresolved'); assert.deepEqual(result.receipts, {});
    }
    const foreign = check(f.store, c.graph, { 'garden-later-block': { 'garden-data': ref } });
    finding(foreign, 'available_basis_foreign', 'garden-later-block');
    finding(foreign, 'available_basis_missing', 'garden-flow');
    const identity = ok(checkDeliveries(f.store, 'garden', c.graph, c.bases,
      { ...options, identities: ['garden-produce-work'] }));
    finding(identity, 'available_basis_foreign'); assert.deepEqual(identity.receipts, {});
  });

  await t.test('status claims and altered project, producer, artifact, signature or contract do not prove compatibility', () => {
    const changes: [string, Partial<ArtifactReceipt>][] = [
      ['project', { projectId: 'other' }], ['producer', { node: 'garden-prep-work' }],
      ['artifact', { artifact: 'garden-result' }], ['signature', { signature: hashJson('wrong-signature') }],
      ['contract', { contractHash: hashJson('wrong-contract') }],
    ];
    for (const [label, change] of changes) branch(store => {
      const ref = receiptWith(store, { ...clone(c.receipt.value), ...change });
      const result = check(store, c.graph, basis(ref));
      assert.ok(result.findings.length, label); assert.deepEqual(result.receipts, {});
      if (label === 'signature' || label === 'contract') {
        finding(result, 'available_basis_mismatch');
        assert.throws(() => resolveArtifact(store, 'garden', c.graph, f.repository, 'garden-produce-work', 'garden-data'), engineCode('producer_not_ready'));
      }
    });
    branch(store => {
      const ref = receiptWith(store, { state: 'available', status: 'accepted', projectId: 'garden', artifact: 'garden-data', node: 'garden-produce-work' } as unknown as ArtifactReceipt);
      finding(check(store, c.graph, basis(ref)), 'available_basis_mismatch');
    });
  });

  await t.test('all unused bases are checked, including foreign and incompatible results', () => {
    const unused = { ...clone(c.bases), 'garden-later-block': { 'garden-result': reference(f.receipts['garden-result']!) } };
    finding(check(f.store, c.graph, unused), 'available_basis_foreign', 'garden-later-block');
    branch(store => {
      const original = f.receipts['garden-prep']!;
      const bad = store.write({ id: original.id, kind: original.kind, expected: original.revision,
        value: { ...clone(original.value), contractHash: hashJson('unused-incompatible') } });
      const bases = clone(c.bases); bases['garden-produce-block']!['garden-prep'] = reference(bad);
      finding(check(store, c.graph, bases), 'available_basis_mismatch', 'garden-produce-block');
    });
  });

  await t.test('data and requires use semantic block ancestry and reject distinct competing bases', () => branch(store => {
    const graph = clone(c.graph);
    graph.edges!.push({ id: 'requires-ready-data', relation: 'requires', source: 'garden-consume-work', target: 'garden-produce-work', condition: 'Reuse the exact ready result' });
    graph.edges!.push({ id: 'producer-realizes-later', relation: 'realizes', source: 'garden-produce-operation', target: 'garden-later-operation', condition: 'The producer also realizes this block role' });
    // The pure boundary supplies its own checked graph; save a matching structural receipt for that graph.
    const value = { ...clone(c.receipt.value), signature: nodeSignature(graph, graph.nodes.find(node => node.id === 'garden-produce-work')!) };
    const ref = receiptWith(store, value), bases = { 'garden-later-block': { 'garden-data': ref } };
    const checked = check(store, graph, bases);
    assert.deepEqual(checked.findings, []);
    assert.deepEqual(checked.receipts, { '["garden-flow","garden-produce-work"]': ref, '["requires-ready-data","garden-produce-work"]': ref });
    const duplicate = { ...bases, 'garden-produce-block': { 'garden-data': ref } };
    assert.deepEqual(check(store, graph, duplicate).findings, []);
    const later = receiptWith(store, value);
    const ambiguous = ok(checkDeliveries(store, 'garden', graph,
      { ...bases, 'garden-produce-block': { 'garden-data': later } }, { ...options, current: false }));
    finding(ambiguous, 'available_basis_ambiguous', 'garden-flow');
    finding(ambiguous, 'available_basis_ambiguous', 'requires-ready-data'); assert.deepEqual(ambiguous.receipts, {});
  }));

  await t.test('write ownership uses a confirmed accepted writer, never a data receipt', () => {
    const graph = clone(c.graph), producer = graph.nodes.find(node => node.id === 'garden-produce-work')!;
    const consumer = graph.nodes.find(node => node.id === 'garden-consume-work')!, path = producer.code[0]!.path;
    consumer.code.push(clone(producer.code[0]!));
    graph.transfers!.push({ id: 'reuse-produced-file', from: producer.id, to: consumer.id, path, condition: 'producer_committed' });
    const proof = c.owner(path); assert.ok(proof); assert.equal(proof.node, producer.id);
    const checked = check(f.store, graph);
    assert.deepEqual(checked.findings, []);
    assert.deepEqual(checked.receipts[canonical(['reuse-produced-file', producer.id])], proof.ref);
    assert.ok(checked.guards.some(ref => same(ref, proof.ref)));
    const missing = ok(checkDeliveries(f.store, 'garden', graph, c.bases, { ...options, owner: () => null }));
    finding(missing, 'ownership_predecessor_missing', 'reuse-produced-file');
    const prep = graph.nodes.find(node => node.id === 'garden-prep-work')!, missingPath = prep.code[0]!.path;
    consumer.code.push(clone(prep.code[0]!));
    graph.transfers!.push({ id: 'missing-prep-writer', from: prep.id, to: consumer.id, path: missingPath, condition: 'producer_committed' });
    const separate = ok(checkDeliveries(f.store, 'garden', graph, c.bases,
      { ...options, owner: address => address === missingPath ? null : c.owner(address) }));
    assert.deepEqual(separate.findings.map(item => item.target), ['missing-prep-writer']);
    assert.deepEqual(separate.receipts[canonical(['reuse-produced-file', producer.id])], proof.ref);
    graph.transfers = [];
    finding(check(f.store, graph), 'ownership_predecessor_missing', consumer.id);
    branch(store => {
      const continuing = c.owner(consumer.code[0]!.path)!;
      const row = store.get<Record<string, unknown>>(continuing.ref.id)!;
      store.write({ id: row.id, kind: row.kind, expected: row.revision, value: { ...row.value, checks: [] } });
      const owners = new Owners(store, 'garden', f.repository);
      const result = ok(checkDeliveries(store, 'garden', c.graph, c.bases,
        { ...options, owner: path => owners.latest(path) }));
      finding(result, 'ownership_predecessor_missing', consumer.id);
    });
    const infrastructure = new Error('unexpected writer store failure');
    assert.throws(() => checkDeliveries(f.store, 'garden', c.graph, c.bases,
      { ...options, owner: () => { throw infrastructure; } }), error => error === infrastructure);
  });

  await t.test('F3 compatibility leaves invalid plan/run and changed files to the genuine M8 resolver', () => {
    for (const field of ['plan', 'run'] as const) branch(store => {
      const ref = receiptWith(store, { ...clone(c.receipt.value), [field]: { id: `absent:${field}`, revision: 1, hash: hashJson(field) } });
      assert.deepEqual(check(store, c.graph, basis(ref)).findings, []);
      assert.throws(() => resolveArtifact(store, 'garden', c.graph, f.repository, 'garden-produce-work', 'garden-data'), engineCode('implementation_proof_foreign'));
    });
    const path = c.receipt.value.value.files[0]!.path;
    writeFileSync(join(f.repository.root, path), 'changed after the accepted implementation\n');
    git(f.repository.root, ['add', path]);
    git(f.repository.root, ['-c', 'user.name=OMG Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'change delivered fixture file']);
    const repository = { ...f.repository, head: git(f.repository.root, ['rev-parse', 'HEAD']), tree: git(f.repository.root, ['rev-parse', 'HEAD^{tree}']) };
    assert.deepEqual(check().findings, []);
    assert.throws(() => resolveArtifact(f.store, 'garden', c.graph, repository, 'garden-produce-work', 'garden-data'), engineCode('artifact_stale'));
  });

  await t.test('current guards cover receipt, candidate, C2/B2, D7 and writer proof; stale transactions write nothing', () => {
    const prepared = ok(prepareDeliveries(f.store, c.request));
    const owner = c.owner(c.graph.nodes.find(node => node.id === 'garden-consume-work')!.code[0]!.path)!;
    const refs = [reference(c.receipt), c.request.candidate, reference(f.graphRevision), reference(f.layers[3]),
      reference(c.input), reference(c.horizon.horizon), reference(c.horizon.gate), c.proposalRef,
      reference(c.ledger.producer), reference(c.ledger.record), reference(c.lines), owner.ref];
    for (const ref of refs) {
      assert.ok(prepared.guards.some(item => same(item, ref)), `Missing guard ${ref.id}`);
      branch(store => {
        const row = store.get(ref.id)!; store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
        const before = heads(store);
        denied(writeGuarded(store, { unit: 'F3', target: 'delivery-consumer', guards: prepared.guards,
          writes: [{ id: 'delivery-consumer:test', kind: 'test', expected: 0, value: { admitted: true } }] }), 'input_stale');
        assert.deepEqual(heads(store), before);
      });
    }
  });

  await t.test('arbitrary absent or malformed arguments and unproven candidate aliases are typed refusals', () => {
    for (const graph of [undefined, null, {}, { ...clone(c.graph), horizon: ['garden-produce-block'] }])
      denied(checkDeliveries(f.store, 'garden', graph as Graph, c.bases, options), 'delivery_request_invalid');
    for (const bases of [undefined, null, [], { 'garden-produce-block': { 'garden-data': null } }])
      denied(checkDeliveries(f.store, 'garden', c.graph, bases as unknown as DeliveryBases, options), 'delivery_request_invalid');
    for (const bad of [undefined, null, {}, { owner: c.owner }, { ...options, current: null }, { ...options, identities: ['absent-work'] }])
      denied(checkDeliveries(f.store, 'garden', c.graph, c.bases, bad as typeof options), 'delivery_request_invalid');
    for (const proof of [undefined, { status: 'accepted' }, reference(c.receipt)])
      denied(checkDeliveries(f.store, 'garden', c.graph, c.bases,
        { ...options, owner: (() => proof) as unknown as typeof c.owner }), 'delivery_request_invalid');
    denied(checkDeliveries(null as unknown as Store, 'garden', c.graph, c.bases, options), 'delivery_request_invalid');
    denied(checkDeliveries(f.store, '', c.graph, c.bases, options), 'delivery_request_invalid');
    for (const request of [null, {}, { ...c.request, candidate: reference(c.receipt) },
      { ...c.request, candidate: { ...c.request.candidate, hash: hashJson('forged-candidate') } }]) {
      denied(prepareDeliveries(f.store, request as typeof c.request));
      denied(readDeliveries(f.store, request as DeliveryReadRequest));
    }
    denied(readDeliveries(f.store, c.request as DeliveryReadRequest), 'delivery_basis_unproven');
  });

  await t.test('empty first-writer admission survives native execution, negative-to-positive index history and a cold restart', async t => {
    const database = join(f.root, 'before-execution.sqlite'), store = new Store(database);
    try {
      assert.ok(c.preExecution.length);
      for (const row of c.preExecution) store.write({ id: row.id, kind: row.kind, expected: row.revision - 1, value: row.value });
      assert.equal(store.get('execution-root:garden'), null); assert.deepEqual(store.list('task-run'), []);
      const first = await readyCandidate(t, { ...f, store }, false);
      const before = heads(store), prepared = ok(prepareDeliveries(store, first.request));
      assert.deepEqual(heads(store), before); assert.equal(prepared.request.ownership.root, null);
      assert.deepEqual(prepared.writers, {}); assert.deepEqual(prepared.findings, []);
      assert.ok(prepared.writes.length);
      for (const [path, ref] of Object.entries(prepared.request.ownership.indexes)) assert.equal(ref.id, writerIndexId('garden', path));
      for (const write of prepared.writes) { assert.equal(write.expected, 0); assert.deepEqual((write.value as {writers: Ref[]}).writers, []); }
      denied(readDeliveries(store, clone(prepared.request) as DeliveryReadRequest), 'writer_index_invalid');
      ok(writeGuarded(store, { unit: 'F3', target: 'first-admission', guards: prepared.guards,
        writes: [...prepared.writes, { id: 'fixture:first-admission', kind: 'fixture', expected: 0, value: prepared.request }] }));
      assert.equal(store.get('execution-root:garden'), null);
      const historical = ok(readDeliveries(store, clone(prepared.request) as DeliveryReadRequest));
      const racing = ok(prepareDeliveries(store, first.request)); assert.deepEqual(racing.writes, []);
      // Capture the real acceptance transaction and its immediately preceding database for an interleaved reader.
      let acceptance: { database: string; writes: Write[]; guards: Ref[] } | undefined;
      const writeMany = store.writeMany.bind(store);
      store.writeMany = ((writes: Write[], guards: Ref[] = []) => {
        if (!acceptance && writes.some(write => write.kind === 'task-run' && (write.value as {state?: string}).state === 'committed')) {
          const database = join(f.root, 'root-index-read-race.sqlite'), snapshot = new Store(database);
          try { for (const head of store.list()) for (const row of store.history(head.id))
            snapshot.write({ id: row.id, kind: row.kind, expected: row.revision - 1, value: row.value }); }
          finally { snapshot.close(); }
          acceptance = { database, writes: clone(writes), guards: clone(guards) };
        }
        return writeMany(writes, guards);
      }) as typeof store.writeMany;
      let runs;
      try { runs = await new ProductEngine(store).executor.run('garden', reference(f.plan),
        { retry: false, maxContextChars: 100_000, maxCorrections: 0 }); }
      finally { store.writeMany = writeMany; }
      assert.equal(runs.length, f.plan.value.tasks.length); assert.ok(runs.every(run => run.value.state === 'committed'));
      const after = heads(store);
      denied(writeGuarded(store, { unit: 'F3', target: 'lost-admission', guards: racing.guards,
        writes: [{ id: 'fixture:lost-admission', kind: 'fixture', expected: 0, value: racing.request }] }), 'input_stale');
      assert.deepEqual(heads(store), after);
      const fresh = new Store(database);
      try {
        const root = fresh.get<{path: string; head: string}>('execution-root:garden')!.value;
        const owners = new Owners(fresh, 'garden', { root: root.path, head: root.head });
        for (const [path, ref] of Object.entries(prepared.request.ownership.indexes)) {
          assert.ok(owners.latest(path));
          assert.deepEqual(readWriterIndex(fresh, 'garden', path, ref, null).value.writers, []);
          assert.ok(readWriterIndex(fresh, 'garden', path, reference(fresh.get(ref.id)!), reference(fresh.get('execution-root:garden')!)).value.writers.length);
        }
        assert.deepEqual(ok(readDeliveries(fresh, clone(prepared.request) as DeliveryReadRequest)), historical);
        const current = ok(prepareDeliveries(fresh, first.request));
        assert.ok(Object.keys(current.writers).length); assert.ok(current.request.ownership.root);
        const mixed = clone(current.request) as DeliveryReadRequest;
        mixed.ownership.indexes = clone(prepared.request.ownership.indexes);
        denied(readDeliveries(fresh, mixed), 'writer_index_invalid');
        // The original null-root slice still names the state before any execution; a newer root cannot borrow it.
        assert.deepEqual(ok(readDeliveries(fresh, clone(prepared.request) as DeliveryReadRequest)), historical);
      } finally { fresh.close(); }
      assert.ok(acceptance);
      const racingReader = new Store(acceptance.database), concurrentWriter = new Store(acceptance.database);
      try {
        const get = racingReader.get.bind(racingReader);
        let captured = false, committed = false, acceptedHeads: ReturnType<typeof heads> | undefined;
        racingReader.get = ((id: string, revision?: number) => {
          const result = get(id, revision);
          if (!captured && id === 'execution-root:garden' && revision === undefined) {
            captured = true;
            concurrentWriter.writeMany(acceptance!.writes, acceptance!.guards); committed = true;
            acceptedHeads = heads(concurrentWriter);
          }
          return result;
        }) as typeof racingReader.get;
        const result = prepareDeliveries(racingReader, first.request);
        assert.ok(captured && committed, 'Acceptance must happen after the reader captured root and before it reads the index');
        denied(result, 'writer_index_invalid');
        assert.deepEqual(heads(racingReader), acceptedHeads, 'The refused preparation must not add any partial admission');
      } finally { concurrentWriter.close(); racingReader.close(); }
    } finally { store.close(); }
  });

  await t.test('saved writer selection survives a new Store and Owners after writer and root heads change', () => {
    branch(store => {
      const prepared = ok(prepareDeliveries(store, c.request)), request = clone(prepared.request) as DeliveryReadRequest;
      const historical = ok(readDeliveries(store, request));
      const [path, writer] = Object.entries(prepared.writers)[0]!;
      const original = store.get(writer.id, writer.revision)!;
      const next = store.write({ id: writer.id, kind: original.kind, expected: original.revision, value: original.value });
      let fresh = new Store(store.path);
      try {
        const owners = new Owners(fresh, 'garden', f.repository);
        assert.deepEqual(owners.latest(path)!.ref, reference(next));
        assert.deepEqual(ok(readDeliveries(fresh, request)), historical);
        denied(prepareDeliveries(fresh, c.request), 'writer_index_incomplete');
      } finally { fresh.close(); }
      store.write({ id: writer.id, kind: original.kind, expected: next.revision, value: { ...original.value as object, checks: [] } });
      const root = store.get('execution-root:garden')!;
      store.write({ id: root.id, kind: root.kind, expected: root.revision, value: root.value });
      fresh = new Store(store.path);
      try {
        assert.throws(() => new Owners(fresh, 'garden', f.repository).latest(path), engineCode('checks_not_passed'));
        const list = fresh.list.bind(fresh);
        fresh.list = ((kind?: string) => {
          assert.notEqual(kind, 'task-run', 'History must never reselect current writers'); return list(kind);
        }) as typeof fresh.list;
        const before = heads(fresh);
        assert.deepEqual(ok(readDeliveries(fresh, request)), historical);
        assert.deepEqual(heads(fresh), before);
      } finally { fresh.close(); }
    });
  });

  await t.test('historical ownership requires exact complete path indexes and execution root, never a supplied null', () => {
    const request = clone(ok(prepareDeliveries(f.store, c.request)).request) as DeliveryReadRequest;
    const paths = Object.keys(request.ownership.indexes), path = paths[0]!;
    for (const value of [undefined, null, {}, { ...request.ownership, contract: 'unknown' },
      { ...request.ownership, root: undefined }, { ...request.ownership, root: null },
      { ...request.ownership, indexes: {} }, { ...request.ownership, indexes: { [path]: null } }])
      denied(readDeliveries(f.store, { ...request, ownership: value } as DeliveryReadRequest));
    const changed = clone(request);
    changed.ownership.indexes[path] = { ...changed.ownership.indexes[path]!, hash: hashJson('forged-index') };
    denied(readDeliveries(f.store, changed), 'writer_index_invalid');
    changed.ownership.indexes[path] = reference(c.receipt);
    denied(readDeliveries(f.store, changed), 'writer_index_invalid');
    changed.ownership = clone(request.ownership);
    changed.ownership.root = reference(c.receipt);
    denied(readDeliveries(f.store, changed), 'record_foreign');
    branch(store => {
      const index = readWriterIndex(store, 'garden', path, request.ownership.indexes[path]!, request.ownership.root);
      const forged = store.write({ id: index.id, kind: index.kind, expected: index.revision,
        value: { ...index.value, previous: reference(index), writers: [] } });
      const invalid = clone(request); invalid.ownership.indexes[path] = reference(forged);
      denied(readDeliveries(store, invalid), 'writer_index_invalid');
      // A malformed immediate successor is evidence of corruption, never an open interval.
      denied(readDeliveries(store, request), 'writer_index_invalid');
    });
  });

  await t.test('legacy accepted runs initialize missing indexes in the neighbor transaction and competing creation is atomic', () => {
    const path = join(f.root, 'legacy-without-index.sqlite'), legacy = new Store(path);
    try {
      // Replay the same native producer bytes from before the additive index contract; runs are unchanged.
      for (const head of f.store.list()) if (head.kind !== 'writer-index') for (const row of f.store.history(head.id))
        legacy.write({ id: row.id, kind: row.kind, expected: row.revision - 1, value: row.value });
      const before = heads(legacy), prepared = ok(prepareDeliveries(legacy, c.request));
      assert.deepEqual(heads(legacy), before); assert.ok(prepared.writes.length);
      assert.ok(prepared.writes.every(write => write.expected === 0));
      denied(readDeliveries(legacy, clone(prepared.request) as DeliveryReadRequest), 'writer_index_invalid');
      const rival = new Store(path);
      try {
        const selected = Object.keys(prepared.request.ownership.indexes)[0]!;
        const index = prepareWriterIndex(rival, 'garden', selected, prepared.request.ownership.root);
        rival.writeMany(index.writes, index.guards);
      } finally { rival.close(); }
      const captured = heads(legacy);
      denied(writeGuarded(legacy, { unit: 'F3', target: 'legacy-admission', guards: prepared.guards,
        writes: [...prepared.writes, { id: 'fixture:legacy-admission', kind: 'fixture', expected: 0, value: prepared.request }] }), 'revision_conflict');
      assert.deepEqual(heads(legacy), captured);
      const retried = ok(prepareDeliveries(legacy, c.request));
      ok(writeGuarded(legacy, { unit: 'F3', target: 'legacy-admission', guards: retried.guards,
        writes: [...retried.writes, { id: 'fixture:legacy-admission', kind: 'fixture', expected: 0, value: retried.request }] }));
      const historical = ok(readDeliveries(legacy, clone(retried.request) as DeliveryReadRequest));
      assert.deepEqual(historical.writers, retried.writers);
      const restarted = new Store(path);
      try { assert.deepEqual(ok(readDeliveries(restarted, clone(retried.request) as DeliveryReadRequest)), historical); }
      finally { restarted.close(); }
    } finally { legacy.close(); }
  });

  await t.test('history replays exact receipt revisions after heads advance and restart; new preparation refuses them', () => {
    const prepared = ok(prepareDeliveries(f.store, c.request));
    const historical = ok(readDeliveries(f.store, prepared.request as DeliveryReadRequest));
    const row = f.store.get(c.receipt.id)!;
    f.store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
    finding(check(), 'available_basis_stale');
    assert.deepEqual(ok(checkDeliveries(f.store, 'garden', c.graph, c.bases, { ...options, current: false })).receipts, historical.receipts);
    f.reopen();
    const before = heads(f.store);
    assert.deepEqual(ok(readDeliveries(f.store, prepared.request as DeliveryReadRequest)), historical);
    denied(prepareDeliveries(f.store, c.request), 'available_basis_stale');
    assert.deepEqual(heads(f.store), before);
  });
});
