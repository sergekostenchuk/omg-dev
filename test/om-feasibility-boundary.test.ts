import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { deriveTasks } from '../src/compiler/derive.js';
import { requireBasis } from '../src/compiler/basis.js';
import { resolveArtifact } from '../src/compiler/inputs.js';
import type { MachinePlan } from '../src/compiler/model.js';
import { requirePlanTaskObligations } from '../src/execution/task-obligations.js';
import { EngineError } from '../src/errors.js';
import { ensureWorktree } from '../src/execution/worktree.js';
import { currentBasis } from '../src/execution/basis.js';
import type { TaskRun } from '../src/execution/model.js';
import type { Graph } from '../src/graph/model.js';
import type { Feasibility } from '../src/graph/refinement.js';
import { requireTaskObligations, taskObligationHandoff } from '../src/graph/task-obligations.js';
import { Owners } from '../src/ownership/owners.js';
import { readWriterIndex, type WriterIndex } from '../src/ownership/writer-index.js';
import { reference, uniqueRefs, type GateResult, type Ref, type StageArtifact, type StageProjection } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { Environments, uniqueTransactionGuards, type ExecutionRoot } from '../src/runtime/environment.js';
import { Store, type Revision } from '../src/storage/store.js';
import { gateFeasibility, prepareFeasibility, readFeasibility, writeFeasibility, type FeasibilityRequest, type OmFeasibility } from '../src/om/feasibility.js';
import { type AtomicGateRecord, type AtomicGateRequest } from '../src/om/atomic-gate.js';
import { resolveSnapshot } from '../src/om/impact.js';
import { historicalTrace, withHistoricalReads } from '../src/om/input.js';
import type { OmResult, Sealed } from '../src/om/refusal.js';

interface BoundaryFixture {
  readonly store: Store;
  readonly project: string;
  readonly workspace: string;
  readonly feasibility: FeasibilityRequest;
  readonly request: AtomicGateRequest;
  readonly gate: Revision<AtomicGateRecord>;
  /** The real second-generation works chain ending at settleCandidate — before any M8 (LG08 AT1). */
  nextAcceptance(choice?: string): { request: AtomicGateRequest; gate: Revision<AtomicGateRecord>;
    acceptance: { project: string; level: 3; graph: Ref; layer: Ref; frame: Ref } };
  restart(): void;
}
type FixtureModule = { acceptedWorksFixture(t: TestContext): BoundaryFixture };
let fixtures: Promise<FixtureModule> | undefined;
function loadFixtures(): Promise<FixtureModule> {
  // Reuse the real G1 producer without importing and registering its test suite.
  fixtures ??= (async () => {
    const url = new URL('./om-feasibility.test.js', import.meta.url);
    const source = readFileSync(url, 'utf8');
    const boundary = source.indexOf('const heads =');
    assert.ok(boundary > 0, 'The shared G1 fixture ends before its first test');
    const prefix = source.slice(0, boundary).replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
      (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`);
    assert.ok(!/\btest\(/.test(prefix), 'Loading the fixture never registers the original tests');
    return import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport { acceptedWorksFixture };`).toString('base64')}`) as Promise<FixtureModule>;
  })();
  return fixtures;
}
function fixture(t: TestContext): Promise<BoundaryFixture> {
  return loadFixtures().then(module => module.acceptedWorksFixture(t));
}

let sharedWriterFixtures: Promise<FixtureModule> | undefined;
function loadSharedWriterFixtures(): Promise<FixtureModule> {
  sharedWriterFixtures ??= (async () => {
    const url = new URL('./om-feasibility.test.js', import.meta.url), source = readFileSync(url, 'utf8');
    const boundary = source.indexOf('const heads ='); assert.ok(boundary > 0);
    let prefix = source.slice(0, boundary);
    const once = (needle: string, replacement: string) => {
      assert.equal(prefix.split(needle).length - 1, 1, `One shared-writer fixture seam: ${needle}`);
      prefix = prefix.replace(needle, replacement);
    };
    once("desired.artifacts.find(artifact => artifact.id === 'garden-data').external = true;", `
    desired.artifacts.find(artifact => artifact.id === 'garden-data').external = false;
    for (const node of desired.nodes.filter(node => node.kind === 'work'))
      for (const code of node.code) if (code.access === 'write') code.path = 'shared.txt';
    for (const connector of desired.connectors) for (const binding of connector.bindings)
      if (binding.level === 3) for (const endpoint of [binding.producer, ...binding.consumers]) {
        const node = desired.nodes.find(node => node.id === endpoint.node);
        assert.ok(node && node.code.length === 1); endpoint.codeRef = clone(node.code[0]);
      }
    for (const proof of desired.tests) if (proof.contract) proof.contract.entrypoint.path = 'shared.txt';
    desired.transfers = [{ id: 'garden-shared-transfer', path: 'shared.txt',
      from: 'garden-produce-work', to: 'garden-consume-work', condition: 'producer_committed' }];
    `);
    once('gaps: gapRead, results: [], sources: [reference(source)]', 'gaps: gapRead, results: [], sources: []');
    once("assert.deepEqual(candidate.record.value.graph.horizon, ['garden-consume-work']);",
      "assert.deepEqual([...candidate.record.value.graph.horizon].sort(), ['garden-consume-work', 'garden-produce-work']);");
    prefix = prefix.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
      (_match, _quote: string, path: string) => `from ${JSON.stringify(new URL(path, url).href)}`);
    assert.ok(!/\btest\(/.test(prefix));
    return import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport { acceptedWorksFixture };`).toString('base64')}`) as Promise<FixtureModule>;
  })();
  return sharedWriterFixtures;
}

async function executableFixture(t: TestContext, sharedWriter = false): Promise<BoundaryFixture> {
  const producer = await (sharedWriter ? loadSharedWriterFixtures() : loadFixtures());
  const configure = Environments.prototype.configure;
  const script = String.raw`import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
const request=JSON.parse(readFileSync(0,'utf8'));
const response={protocol:request.protocol,requestId:request.requestId};
if(request.mode==='implement') {
  const context=request.subject.context;
  for(const code of context.scope.code.filter(item=>item.access==='write')) {
    mkdirSync(dirname(code.path),{recursive:true}); writeFileSync(code.path,'Native OM execution result for '+context.binding.task+'\n');
  }
  response.text='Implemented the declared local work';
  response.artifacts=context.produces.map(id=>({id}));
} else if(request.mode==='review') response.review={verdict:'pass',kind:'none',findings:[]};
else throw new Error('Unexpected adapter mode');
process.stdout.write(JSON.stringify(response));`;
  const command = { executable: process.execPath, args: ['--input-type=module', '-e', script] };
  let configured = 0;
  Environments.prototype.configure = function(project, value, expected) {
    assert.equal(value.implementer.actor, 'external-producer'); configured += 1;
    return configure.call(this, project, { ...value,
      implementer: { ...value.implementer, command }, reviewer: { ...value.reviewer, command } }, expected);
  };
  try {
    const result = producer.acceptedWorksFixture(t);
    assert.equal(configured, 1, 'The local executor is selected by the real configuration before G5');
    return result;
  } finally { Environments.prototype.configure = configure; }
}

function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function admission(result: GateResult) {
  return uniqueTransactionGuards([...result.guards, ...(result.admissionGuards ?? [])]);
}
function refused(result: GateResult, code: string, target: string): void {
  assert.ok(result.findings.some(item => item.code === code && item.target === target), canonical(result.findings));
}
const errorCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
const heads = (store: Store) => store.list().map(reference);
function tracedM8(store: Store, project: string, record: Ref) {
  const references: Ref[] = [];
  const result = withHistoricalReads(() => readFeasibility(historicalTrace(store, ref => { references.push(ref); }, 'distinct'), { project, record }));
  return { saved: ok(result), references: uniqueRefs(references) };
}
function assertExplicitEmptyReadinessInputs(value: Sealed<OmFeasibility>): void {
  const producer = value.producer, ownership = producer.deliveries.ownership;
  assert.equal(producer.contract, 'om-m8/v2');
  assert.deepEqual(producer.readiness.confirmations, []);
  assert.deepEqual(producer.readiness.handoff.obligations, []);
  assert.ok(ownership);
  const deliveryInputs = uniqueRefs([
    ...(ownership.root ? [ownership.root] : []), ...Object.values(ownership.indexes),
    ...producer.deliveries.resolved.flatMap(input => [...(input.source ? [input.source] : []), ...(input.receipt ? [input.receipt] : [])]),
  ]);
  assert.deepEqual(producer.deliveries.inputs, deliveryInputs, 'Delivery inputs are exact explicit producing bases');
  assert.deepEqual(value.inputs, uniqueRefs([value.graph, value.environment, producer.layer, producer.frame,
    producer.candidate, producer.horizon, producer.obligations.producer, producer.obligations.ledger,
    ...(producer.inspection.executionRoot ? [producer.inspection.executionRoot] : []),
    ...(producer.inspection.workspace ? [producer.inspection.workspace] : []), ...deliveryInputs]),
  'Saved M8 inputs are independently derived explicit bases, not a reader journal');
}
type Alteration = { name: string; field?: string; change(value: Record<string, unknown>): void };
const omissions: Alteration[] = [
  { name: 'one explicit M8 input', field: 'result', change(value) {
    const producer = value['producer'] as { candidate: Ref };
    const inputs = value['inputs'] as Ref[];
    assert.ok(inputs.some(ref => canonical(ref) === canonical(producer.candidate)));
    value['inputs'] = inputs.filter(ref => canonical(ref) !== canonical(producer.candidate));
  } },
  { name: 'one explicit delivery input', field: 'deliveries', change(value) {
    const producer = value['producer'] as { deliveries: { inputs: Ref[]; ownership: { indexes: Record<string, Ref> } } };
    const index = Object.values(producer.deliveries.ownership.indexes)[0]!;
    assert.ok(producer.deliveries.inputs.some(ref => canonical(ref) === canonical(index)));
    producer.deliveries.inputs = producer.deliveries.inputs.filter(ref => canonical(ref) !== canonical(index));
  } },
  { name: 'both D7 references and saved obligations', change(value) {
    const producer = value['producer'] as Record<string, unknown>;
    const pair = producer['obligations'] as { producer: Ref; ledger: Ref };
    value['inputs'] = (value['inputs'] as Ref[]).filter(ref => ref.id !== pair.producer.id && ref.id !== pair.ledger.id);
    delete value['obligations']; delete producer['obligations']; delete producer['readiness'];
  } },
  { name: 'producer', change(value) { delete value['producer']; } },
  { name: 'producer contract', change(value) { delete (value['producer'] as Record<string, unknown>)['contract']; } },
  { name: 'null producer contract', change(value) { (value['producer'] as Record<string, unknown>)['contract'] = null; } },
  { name: 'unknown producer contract', change(value) { (value['producer'] as Record<string, unknown>)['contract'] = 'om-m8/unknown'; } },
];

test('G1.1 current Refinement gate accepts the genuine M8 producer with its complete G6 admission after restart', async t => {
  const f = await fixture(t);
  const saved = ok(writeFeasibility(f.store, f.feasibility)), ref = reference(saved);
  assert.equal(saved.value.ready, true);
  assert.equal(f.store.get(`feasibility:${f.project}`), null);
  assertExplicitEmptyReadinessInputs(saved.value);
  const inputRevisions = new Map<string, Set<number>>();
  for (const input of tracedM8(f.store, f.project, ref).references) {
    const revisions = inputRevisions.get(input.id) ?? new Set<number>();
    revisions.add(input.revision); inputRevisions.set(input.id, revisions);
  }
  // NR1 (№3591): the saved sources of M8 are read as written — no traversal of their history is read again.
  void inputRevisions;
  for (const restart of [false, true]) {
    if (restart) f.restart();
    const before = heads(f.store), engine = new ProductEngine(f.store);
    const shared = ok(gateFeasibility(f.store, { project: f.project, record: ref }));
    for (const allowHistorical of [false, true]) {
      const checked = engine.refinement.feasibilityGate(f.project, ref, allowHistorical);
      assert.deepEqual(checked.findings, []);
      assert.deepEqual(admission(checked), uniqueTransactionGuards(shared.guards));
      assert.ok(admission(checked).some(guard => guard.id === `execution-root:${f.project}` && 'absent' in guard));
      for (const basis of Object.values(saved.value.producer.obligations))
        assert.ok(admission(checked).some(guard => canonical(guard) === canonical(basis)), `The current gate guards ${basis.id}`);
    }
    assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: ref })), saved);
    assert.deepEqual(heads(f.store), before, 'The current gate is read-only');
  }
  const dependency = tracedM8(f.store, f.project, ref).references.find(item => item.id.startsWith('om-input:')
    && !saved.value.inputs.some(input => canonical(input) === canonical(item)));
  assert.ok(dependency, 'B1 is a proved transitive dependency rather than a materialized M8 input');
  const original = f.store.get(dependency.id, dependency.revision)!;
  const value = { ...(original.value as Record<string, unknown>), altered: true };
  const changed = { ...original, value, hash: hashJson(value) }, get = f.store.get.bind(f.store);
  const view = new Proxy(f.store, { get(target, property) {
    if (property === 'get') return (id: string, revision?: number) => id === dependency.id && revision === dependency.revision ? changed : get(id, revision);
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const rejected = readFeasibility(view, { project: f.project, record: ref });
  assert.equal(rejected.ok, false);
  if (rejected.ok) throw new Error('A v2 explicit-input list does not excuse a changed transitive record');
  // NR1 (№3591): the trusted read compares the named hash with the record it gets — a changed record is refused there.
  assert.equal(rejected.refusal.code, 'record_forged');
  for (const historical of [false, true])
    refused(new ProductEngine(view).refinement.feasibilityGate(f.project, ref, historical), rejected.refusal.code, rejected.refusal.at.target);
  assert.deepEqual(f.store.get(dependency.id, dependency.revision), original);
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: ref })), saved);
});

test('G1.1 current Refinement gate preserves the M8 era when required producer and D7 fields are removed', async t => {
  const f = await fixture(t);
  const saved = ok(writeFeasibility(f.store, f.feasibility));
  for (const alteration of omissions) await t.test(alteration.name, () => {
    const value = structuredClone(saved.value) as unknown as Record<string, unknown>;
    alteration.change(value);
    const changed = f.store.write({ id: saved.id, kind: saved.kind, expected: f.store.get(saved.id)!.revision, value });
    assert.notEqual(changed.hash, saved.hash, 'The modified record has its own correct storage hash');
    for (const restart of [false, true]) {
      if (restart) f.restart();
      const before = heads(f.store), engine = new ProductEngine(f.store);
      for (const allowHistorical of [false, true]) {
        const checked = engine.refinement.feasibilityGate(f.project, reference(changed), allowHistorical);
        refused(checked, 'feasibility_record_invalid', changed.id);
        if (alteration.field) assert.ok(checked.findings.some(finding => finding.field === alteration.field), canonical(checked.findings));
      }
      assert.deepEqual(heads(f.store), before);
    }
  });
  const restored = f.store.write<OmFeasibility>({ id: saved.id, kind: saved.kind,
    expected: f.store.get(saved.id)!.revision, value: structuredClone(saved.value) });
  assert.deepEqual(new ProductEngine(f.store).refinement.feasibilityGate(f.project, reference(restored)).findings, []);
});

test('G1.1 allowHistorical never bypasses the current M8 repository inspection', async t => {
  const f = await fixture(t), saved = ok(writeFeasibility(f.store, f.feasibility)), ref = reference(saved);
  const path = join(f.workspace, 'untracked-after-m8.txt');
  writeFileSync(path, 'The unchanged saved graph and repository head do not prove a clean working tree.\n');
  f.restart();
  const before = heads(f.store), engine = new ProductEngine(f.store);
  const shared = gateFeasibility(f.store, { project: f.project, record: ref });
  assert.equal(shared.ok, false);
  if (shared.ok) throw new Error('A dirty working tree cannot pass G6');
  assert.equal(shared.refusal.code, 'feasibility_stale');
  for (const allowHistorical of [false, true])
    refused(engine.refinement.feasibilityGate(f.project, ref, allowHistorical), shared.refusal.code, saved.id);
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: ref })), saved,
    'Historical provenance remains valid while current admission fails');
  assert.deepEqual(heads(f.store), before);
  rmSync(path);
  const sharedCurrent = ok(gateFeasibility(f.store, { project: f.project, record: ref }));
  const current = engine.refinement.feasibilityGate(f.project, ref);
  assert.deepEqual(current.findings, []);
  assert.deepEqual(admission(current), uniqueTransactionGuards(sharedCurrent.guards));
});

function planWithIncompleteProvenance(store: Store, feasibility: Revision<OmFeasibility>): Revision<MachinePlan> {
  const project = feasibility.value.projectId, graphRef = feasibility.value.graph;
  const graph = store.get<Graph>(graphRef.id, graphRef.revision)!;
  const base = feasibility.value.repository;
  assert.ok(base);
  const owners = new Owners(store, project, base);
  const handoff = taskObligationHandoff(store, project, feasibility.value.inputs);
  const researchObligations = handoff ? requireTaskObligations(store, project, graph.value, handoff) : undefined;
  const derived = deriveTasks(project, graph.hash, graph.value,
    (producer, artifact) => resolveArtifact(store, project, graph.value, base, producer, artifact),
    { version: 2, owner: path => owners.latest(path), ...(researchObligations ? { researchObligations } : {}) });
  const stageId = `stage:${project}:om-g2`;
  // This is the malformed-input boundary: consistent checksums do not establish M8 provenance.
  // No validator or reader is replaced, and these writes do not claim public stage acceptance.
  const stage = store.write<StageArtifact>({ id: stageId, kind: 'stage', expected: store.get(stageId)?.revision ?? 0,
    value: { projectId: project, stage: 'om-g2', status: 'accepted',
      content: { feasibility: reference(feasibility) } as unknown as Json, inputs: [], proofs: [] } });
  const guards = uniqueRefs([reference(stage), reference(feasibility), graphRef, feasibility.value.environment,
    ...feasibility.value.inputs, ...derived.guards]);
  const body = { version: 2 as const, projectId: project, graph: graphRef, environment: feasibility.value.environment,
    stage: reference(stage), feasibility: reference(feasibility), base, guards, tasks: derived.tasks, graphSnapshot: graph.value };
  const value: MachinePlan = { ...body, hash: hashJson(body) };
  return store.write<MachinePlan>({ id: `plan:${project}:${value.hash}`, kind: 'plan', expected: 0, value });
}

test('G1.1 Compiler read and current gate reject incomplete M8 provenance by the shared historical reader', async t => {
  const f = await fixture(t), saved = ok(writeFeasibility(f.store, f.feasibility));
  for (const alteration of omissions.filter(item => ['both D7 references and saved obligations', 'producer', 'producer contract'].includes(item.name)))
    await t.test(alteration.name, () => {
      const value = structuredClone(saved.value) as unknown as Record<string, unknown>;
      alteration.change(value);
      const changed = f.store.write<OmFeasibility>({ id: saved.id, kind: saved.kind,
        expected: f.store.get(saved.id)!.revision, value: value as unknown as OmFeasibility });
      const plan = planWithIncompleteProvenance(f.store, changed);
      for (const restart of [false, true]) {
        if (restart) f.restart();
        const before = heads(f.store), engine = new ProductEngine(f.store);
        assert.throws(() => requireBasis(f.store, plan.value), errorCode('feasibility_record_invalid'));
        assert.throws(() => requirePlanTaskObligations(f.store, plan.value), errorCode('feasibility_record_invalid'));
        assert.throws(() => engine.compiler.read(plan.id), errorCode('feasibility_record_invalid'));
        for (const allowHistorical of [false, true])
          assert.throws(() => engine.compiler.gate(f.project, reference(plan), allowHistorical), errorCode('feasibility_record_invalid'));
        assert.deepEqual(heads(f.store), before);
      }
    });
});

function acceptM8(f: BoundaryFixture) {
  const saved = ok(writeFeasibility(f.store, f.feasibility)), engine = new ProductEngine(f.store);
  const draft = engine.refinement.publish(f.project, reference(saved), 0);
  const stage = engine.pipeline.accept(f.project, 'om-g2', draft.revision);
  assert.equal(stage.value.status, 'accepted');
  return { saved, engine, stage };
}

test('G1.1 genuine M8 reads multiple historical revisions and compiles explicit inputs with only current positive guards', async t => {
  const f = await fixture(t), { saved, engine, stage } = acceptM8(f);
  const history = tracedM8(f.store, f.project, reference(saved)).references;
  const historicalIds = new Set(history.filter(input => history.some(other =>
    other.id === input.id && other.revision !== input.revision)).map(input => input.id));
  void historicalIds; // NR1 (№3591): the saved sources are read as written, without their earlier revisions.
  assertExplicitEmptyReadinessInputs(saved.value);
  const plan = engine.compiler.compile(f.project);
  assert.equal(plan.value.version, 2);
  assert.deepEqual(plan.value.feasibility, reference(saved));
  assert.deepEqual(plan.value.stage, reference(stage));
  for (const guard of plan.value.guards) assert.deepEqual(reference(f.store.get(guard.id)!), guard);
  for (const proof of stage.value.proofs) assert.ok(plan.value.guards.some(guard => canonical(guard) === canonical(proof)));
  // NR1: every guard is a current head (above); the saved sources are named as written, no historic closure is read.
  assert.deepEqual(engine.compiler.read(plan.id), plan);
  assert.deepEqual(engine.compiler.compile(f.project), plan);
  const selector = { id: '', pointer: '', start: null, end: null };
  const task = plan.value.tasks[0]!.id;
  const details = JSON.parse(engine.compiler.detail(f.project, reference(plan), task, 'evidence-index', selector, 100_000).text) as {
    value: { ref: Ref; kind: string }[] };
  const expectedEvidence = uniqueRefs([...plan.value.guards, ...saved.value.inputs, ...history]).flatMap(ref => {
    const record = f.store.get<{ projectId?: string }>(ref.id, ref.revision)!;
    return record.value.projectId === f.project && ['source', 'stage', 'discovery-draft', 'research-assessment', 'task-run'].includes(record.kind)
      ? [{ ref, kind: record.kind }] : [];
  });
  assert.deepEqual(details.value, expectedEvidence, 'Detail exposes exact historical evidence separately from current guards');
  const ambiguous = details.value.find(item => details.value.some(other => other.ref.id === item.ref.id && other.ref.revision !== item.ref.revision));
  if (ambiguous) assert.throws(() => engine.compiler.detail(f.project, reference(plan), task, 'evidence',
    { ...selector, id: ambiguous.ref.id }, 100_000), errorCode('context_evidence_ambiguous'));
  const bytes = canonical(plan);
  f.restart();
  const restarted = new ProductEngine(f.store);
  assert.equal(canonical(restarted.compiler.read(plan.id)), bytes);
  assert.deepEqual(restarted.compiler.compile(f.project), plan);
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.equal(f.store.history(plan.id).length, 1);
  assert.equal(f.store.history(`current-plan:${f.project}`).length, 1);
});

for (const dependency of ['positive environment', 'absent execution-root'] as const) {
  for (const repeat of [false, true]) test(`G1.1 ${repeat ? 'exact compile repeat' : 'new compile'} rejects a native ${dependency} race atomically`, async t => {
    const f = await fixture(t), { engine } = acceptM8(f);
    const existing = repeat ? engine.compiler.compile(f.project) : null;
    const pointer = f.store.get(`current-plan:${f.project}`), priorPlans = f.store.list('plan');
    const second = new Store(f.store.path); t.after(() => second.close());
    let raced = false;
    function change(plan: MachinePlan) {
      assert.equal(raced, false); raced = true;
      if (dependency === 'positive environment') {
        const environments = new Environments(second), previous = environments.get(f.project);
        environments.configure(f.project, previous.value, previous.revision);
      } else {
        assert.equal(second.get(`execution-root:${f.project}`), null);
        const root = ensureWorktree(second, new Environments(second), plan);
        assert.equal(root.value.state, 'ready');
      }
    }
    const get = f.store.get.bind(f.store), writeMany = f.store.writeMany.bind(f.store);
    if (existing) {
      f.store.get = ((id: string, revision?: number) => {
        const record = get(id, revision);
        if (!raced && id === existing.id && revision === undefined) change(existing.value);
        return record;
      }) as typeof f.store.get;
    } else {
      f.store.writeMany = ((writes, guards) => {
        const planned = writes.find(write => write.kind === 'plan');
        if (!raced && planned) {
          assert.ok(guards?.some(guard => dependency === 'positive environment'
            ? guard.id === `environment:${f.project}` && !('absent' in guard)
            : guard.id === `execution-root:${f.project}` && 'absent' in guard));
          change(planned.value as MachinePlan);
        }
        return writeMany(writes, guards);
      }) as typeof f.store.writeMany;
    }
    try { assert.throws(() => engine.compiler.compile(f.project), errorCode(repeat ? 'plan_stale' : 'input_stale')); }
    finally { f.store.get = get; f.store.writeMany = writeMany; }
    assert.equal(raced, true, 'The mutation occurred at the actual final compile boundary');
    assert.deepEqual(f.store.get(`current-plan:${f.project}`), pointer);
    assert.deepEqual(f.store.list('plan'), priorPlans, 'Neither neighboring plan nor current-plan was partially saved');
    if (existing) assert.deepEqual(f.store.get(existing.id), existing);
  });
}

test('G1.1 M8 and its compiled plan survive their own first native execution commit and retain writer interval validation', async t => {
  const f = await executableFixture(t), { saved, engine } = acceptM8(f);
  const plan = engine.compiler.compile(f.project);
  assert.equal(plan.value.tasks.length, 1);
  const compilation = engine.compiler.publish(f.project, reference(plan), 0);
  engine.pipeline.accept(f.project, 'compilation', compilation.revision);
  const ownership = saved.value.producer.deliveries.ownership;
  assert.ok(ownership); assert.equal(ownership.root, null);
  const path = plan.value.tasks[0]!.writePaths[0]!;
  const oldIndexRef = ownership.indexes[path]!;
  const oldIndex = readWriterIndex(f.store, f.project, path, oldIndexRef, null);
  assert.deepEqual(oldIndex.value.writers, []);
  const savedBytes = canonical(saved), planBytes = canonical(plan);
  const inputsBytes = canonical(saved.value.inputs), deliveryInputsBytes = canonical(saved.value.producer.deliveries.inputs);
  const runs = await engine.executor.run(f.project, reference(plan), { retry: false, maxContextChars: 200_000, maxCorrections: 0 });
  assert.equal(runs.length, 1); assert.equal(runs[0]!.value.state, 'committed', canonical(runs[0]!.value));
  const run = runs[0]!;
  assert.equal(run.value.parent, plan.value.base.head);
  assert.deepEqual(run.value.usage.map(item => item.mode), ['implement', 'review']);
  const root = f.store.get(`execution-root:${f.project}`)!;
  const next = f.store.get<WriterIndex>(oldIndexRef.id, oldIndexRef.revision + 1)!;
  assert.ok(next);
  assert.equal(next.value.contract, 'writer-index/om-m8-v1');
  assert.deepEqual(next.value.previous, oldIndexRef);
  assert.deepEqual(next.value.writers, [reference(run)]);
  assert.deepEqual(next.value.root, reference(root));
  f.restart();
  // AT1 split: the saved G5 snapshot is the tree the works were checked against, and the first execution commit
  // advanced the effective root — so an M8 derived again on the old frame is exactly feasibility_stale at the gate's
  // snapshot field, and the refusal writes nothing.
  const snapshot0 = f.request.snapshot;
  assert.ok(snapshot0, 'The saved gate names the tree its works were checked against');
  const snapshot1 = resolveSnapshot(new ProductEngine(f.store).environments.effective(f.project).root);
  assert.notEqual(snapshot0.tree, snapshot1.tree, 'The first execution commit advanced the effective tree');
  const beforePreview = heads(f.store);
  const stale = prepareFeasibility(f.store, { ...f.feasibility, expected: saved.revision });
  assert.ok(!stale.ok);
  assert.equal(stale.refusal.code, 'feasibility_stale');
  assert.deepEqual(stale.refusal.at, { unit: 'M8', target: f.gate.id, field: 'snapshot' });
  assert.deepEqual(heads(f.store), beforePreview, 'The stale-snapshot refusal writes nothing');
  // A second works generation is genuinely checked by G5 against the new tree and settles before M8; its fresh
  // preview keeps the exact nonempty writer index for the same path without rewriting the original M8.
  const second = f.nextAcceptance();
  assert.equal(second.gate.value.request.snapshot!.tree, snapshot1.tree, 'The second gate names the effective tree');
  const beforeSecondPreview = heads(f.store);
  const preview = ok(prepareFeasibility(f.store, { ...f.feasibility, graph: second.acceptance.graph,
    layer: second.acceptance.layer, frame: second.acceptance.frame, expected: saved.revision }));
  assert.equal(preview.record.value.ready, true);
  assert.deepEqual(preview.record.value.producer.deliveries.ownership!.indexes[path], reference(next));
  assertExplicitEmptyReadinessInputs(preview.record.value);
  assert.deepEqual(heads(f.store), beforeSecondPreview, 'A new preview with a nonempty selected writer does not rewrite the original M8');
  const replay = tracedM8(f.store, f.project, reference(saved));
  assert.equal(canonical(replay.saved), savedBytes);
  assert.equal(replay.saved.hash, saved.hash);
  assert.equal(canonical(replay.saved.value.inputs), inputsBytes);
  assert.equal(canonical(replay.saved.value.producer.deliveries.inputs), deliveryInputsBytes);
  for (const observed of [reference(next), reference(run), reference(root)])
    assert.ok(replay.references.some(ref => canonical(ref) === canonical(observed)), `The outside S1 collector sees ${observed.id}@${observed.revision}`);
  for (const observed of [reference(next), reference(run), reference(root)])
    assert.ok(!replay.saved.value.inputs.some(ref => canonical(ref) === canonical(observed))
      && !replay.saved.value.producer.deliveries.inputs.some(ref => canonical(ref) === canonical(observed)),
    'Late interval proof dependencies do not become new producing inputs');
  assert.equal(canonical(new ProductEngine(f.store).compiler.read(plan.id)), planBytes);
  assert.deepEqual(readWriterIndex(f.store, f.project, path, oldIndexRef, null), oldIndex);
  assert.deepEqual(readWriterIndex(f.store, f.project, path, reference(next), reference(root)), next);
  assert.throws(() => readWriterIndex(f.store, f.project, path, oldIndexRef, reference(root)), errorCode('writer_index_invalid'));

  const originalHeads = heads(f.store), get = f.store.get.bind(f.store);
  const damages: { name: string; change(index: WriterIndex): void }[] = [
    { name: 'previous', change(index) { index.previous = { ...oldIndexRef, hash: hashJson('foreign previous') }; } },
    { name: 'origin', change(index) { index.origin = { kind: 'commit', run: reference(plan) }; } },
    { name: 'root', change(index) { index.root = { ...reference(root), hash: hashJson('foreign root') }; } },
    { name: 'missing era marker', change(index) { delete (index as unknown as Record<string, unknown>)['contract']; } },
    { name: 'unknown era marker', change(index) { (index as unknown as Record<string, unknown>)['contract'] = 'writer-index/unknown'; } },
    { name: 'legacy marker over OM origin', change(index) { index.contract = 'writer-index/v1'; } },
  ];
  for (const damage of damages) await t.test(`right boundary ${damage.name} remains checked`, () => {
    const value = structuredClone(next.value); damage.change(value);
    const altered = { ...next, value, hash: hashJson(value) };
    f.store.get = ((id: string, revision?: number) => id === next.id && revision === next.revision ? altered : get(id, revision)) as typeof f.store.get;
    try {
      assert.throws(() => readWriterIndex(f.store, f.project, path, oldIndexRef, null), errorCode('writer_index_invalid'));
    } finally { f.store.get = get; }
  });

  await t.test('a selected writer still requires its complete successful gates', () => {
    const pending = get<TaskRun>(run.id, run.revision - 1)!;
    assert.equal(pending.value.state, 'commit_pending');
    const value = { ...structuredClone(run.value), checks: [] };
    const brokenRun = { ...run, value, hash: hashJson(value) };
    const pendingValue = { ...structuredClone(pending.value), checks: [] };
    const brokenPending = { ...pending, value: pendingValue, hash: hashJson(pendingValue) };
    const indexValue = { ...structuredClone(next.value), writers: [reference(brokenRun)],
      origin: { kind: 'commit' as const, run: reference(brokenRun) } };
    const brokenIndex = { ...next, value: indexValue, hash: hashJson(indexValue) };
    f.store.get = ((id: string, revision?: number) => {
      if (id === next.id && revision === next.revision) return brokenIndex;
      if (id === run.id && revision === run.revision) return brokenRun;
      if (id === pending.id && revision === pending.revision) return brokenPending;
      return get(id, revision);
    }) as typeof f.store.get;
    try {
      assert.throws(() => readWriterIndex(f.store, f.project, path, reference(brokenIndex), reference(root)), errorCode('checks_not_passed'));
    } finally { f.store.get = get; }
  });
  assert.deepEqual(heads(f.store), originalHeads, 'Boundary counterexamples do not rewrite genuine saved history');
  assert.equal(canonical(ok(readFeasibility(f.store, { project: f.project, record: reference(saved) }))), savedBytes);
  assert.equal(canonical(new ProductEngine(f.store).compiler.read(plan.id)), planBytes);
});

test('G1.1 two native tasks extend one writer index across restart and reject a second-Store race after captured admission', async t => {
  const f = await executableFixture(t, true), { saved, engine } = acceptM8(f);
  const plan = engine.compiler.compile(f.project), tasks = plan.value.tasks;
  assert.deepEqual(tasks.map(task => task.node), ['garden-produce-work', 'garden-consume-work']);
  assert.deepEqual(tasks.map(task => task.writePaths), [['shared.txt'], ['shared.txt']]);
  assert.equal(tasks[1]!.ownership![0]!.producerTask, tasks[0]!.id);
  const stage = engine.compiler.publish(f.project, reference(plan), 0);
  engine.pipeline.accept(f.project, 'compilation', stage.revision);
  const originalIndexRef = saved.value.producer.deliveries.ownership!.indexes['shared.txt']!;
  const options = { retry: false, maxContextChars: 200_000, maxCorrections: 0 };
  const writeMany = f.store.writeMany.bind(f.store);
  let stopped = false;
  f.store.writeMany = ((writes, guards) => {
    const result = writeMany(writes, guards);
    if (!stopped && writes.some(write => write.kind === 'task-run' && (write.value as TaskRun).state === 'committed')) {
      stopped = true; throw new EngineError('fixture_after_first_commit', 'Stop after the complete native commit transaction');
    }
    return result;
  }) as typeof f.store.writeMany;
  try { await assert.rejects(engine.executor.run(f.project, reference(plan), options), errorCode('fixture_after_first_commit')); }
  finally { f.store.writeMany = writeMany; }
  assert.equal(stopped, true);
  const first = f.store.list<TaskRun>('task-run').find(record => record.value.taskId === tasks[0]!.id)!;
  assert.equal(first.value.state, 'committed');
  assert.equal(f.store.list<TaskRun>('task-run').filter(record => record.value.taskId === tasks[1]!.id).length, 0);
  f.restart();
  const firstRoot = f.store.get<ExecutionRoot>(`execution-root:${f.project}`)!;
  const firstIndex = f.store.get<WriterIndex>(originalIndexRef.id)!;
  const captured = currentBasis(f.store, plan, firstRoot.value);
  for (const guard of [reference(firstRoot), reference(firstIndex), reference(first)])
    assert.ok(captured.some(ref => canonical(ref) === canonical(guard)));
  assert.ok(!captured.some(ref => canonical(ref) === canonical(originalIndexRef)));
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(saved) })), saved);
  const other = new Store(f.store.path);
  let runs: Revision<TaskRun>[];
  try { runs = await new ProductEngine(other).executor.run(f.project, reference(plan), { ...options, retry: true }); }
  finally { other.close(); }
  assert.deepEqual(runs.map(record => record.value.state), ['committed', 'committed']);
  assert.deepEqual(runs[0], first, 'Restart reuses the first committed result without another physical call');
  assert.equal(runs[1]!.value.parent, first.value.commit);
  assert.notEqual(runs[1]!.value.tree, first.value.tree);
  assert.deepEqual(runs.flatMap(record => record.value.usage.map(usage => usage.mode)), ['implement', 'review', 'implement', 'review']);
  const neighbors = ['a', 'b'].map(suffix => ({ id: `g11-captured-neighbor:${suffix}`, kind: 'boundary-probe', expected: 0, value: {} }));
  assert.throws(() => f.store.writeMany(neighbors, captured), errorCode('input_stale'));
  for (const neighbor of neighbors) assert.equal(f.store.get(neighbor.id), null);
  const root = f.store.get<ExecutionRoot>(firstRoot.id)!;
  const index = f.store.get<WriterIndex>(firstIndex.id)!;
  assert.equal(index.revision, originalIndexRef.revision + 2);
  assert.deepEqual(index.value.previous, reference(firstIndex));
  assert.deepEqual(index.value.writers, uniqueRefs(runs.map(reference)));
  const progressed = currentBasis(f.store, plan, root.value);
  for (const guard of [reference(root), reference(index), ...runs.map(reference)])
    assert.ok(progressed.some(ref => canonical(ref) === canonical(guard)), `Own progress guards ${guard.id}@${guard.revision}`);
  for (const prior of [originalIndexRef, reference(firstIndex), reference(firstRoot)])
    assert.ok(!progressed.some(ref => canonical(ref) === canonical(prior)));
  f.restart();
  assert.deepEqual(new ProductEngine(f.store).compiler.read(plan.id), plan);
  assert.deepEqual(ok(readFeasibility(f.store, { project: f.project, record: reference(saved) })), saved);
  assert.deepEqual(await new ProductEngine(f.store).executor.run(f.project, reference(plan), { ...options, retry: true }), runs);
  const outside = tracedM8(f.store, f.project, reference(saved));
  assert.deepEqual(outside.saved, saved);
  for (const ref of [reference(firstIndex), reference(first), reference(firstRoot)])
    assert.ok(outside.references.some(item => canonical(item) === canonical(ref)));

  await t.test('a foreign intermediate writer is rejected even when the last writer belongs to the requested plan', () => {
    const get = f.store.get.bind(f.store), firstPending = get<TaskRun>(first.id, first.revision - 1)!;
    const { hash: _hash, ...body } = plan.value;
    const foreignBody = { ...structuredClone(body), guards: [...body.guards].reverse() };
    const foreignValue = { ...foreignBody, hash: hashJson(foreignBody) };
    const foreignPlan: Revision<MachinePlan> = { id: `plan:${f.project}:${foreignValue.hash}`, kind: 'plan', revision: 1,
      value: foreignValue, hash: hashJson(foreignValue) };
    assert.notEqual(foreignPlan.id, plan.id);
    const reviewSubject = hashJson({ plan: reference(foreignPlan), task: first.value.taskId, parent: first.value.parent, tree: first.value.tree });
    const firstValue = { ...structuredClone(first.value), plan: reference(foreignPlan), reviewSubject };
    const foreignFirst = { ...first, value: firstValue, hash: hashJson(firstValue) };
    const pendingValue = { ...structuredClone(firstPending.value), plan: reference(foreignPlan), reviewSubject };
    const foreignPending = { ...firstPending, value: pendingValue, hash: hashJson(pendingValue) };
    const middleValue: WriterIndex = { ...structuredClone(firstIndex.value), writers: [reference(foreignFirst)],
      origin: { kind: 'commit', run: reference(foreignFirst) } };
    const middle = { ...firstIndex, value: middleValue, hash: hashJson(middleValue) };
    const lastValue: WriterIndex = { ...structuredClone(index.value), previous: reference(middle),
      writers: uniqueRefs([reference(foreignFirst), reference(runs[1]!)]) };
    const last = { ...index, value: lastValue, hash: hashJson(lastValue) };
    const view = new Proxy(f.store, { get(target, property) {
      if (property === 'get') return (id: string, revision?: number) => {
        if (id === foreignPlan.id && (revision === undefined || revision === 1)) return foreignPlan;
        if (id === first.id && (revision === undefined || revision === first.revision)) return foreignFirst;
        if (id === firstPending.id && revision === firstPending.revision) return foreignPending;
        if (id === index.id && (revision === undefined || revision === index.revision)) return last;
        if (id === middle.id && revision === middle.revision) return middle;
        return get(id, revision);
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.deepEqual(readWriterIndex(view, f.project, 'shared.txt', reference(last), reference(root)), last,
      'The whole source chain has valid commit roots and complete writer gates');
    assert.throws(() => currentBasis(view, plan, root.value), errorCode('plan_stale'));
  });
});

const HISTORY_LOADER = String.raw`import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let root,ts;
export async function initialize(data){root=data.root;ts=(await import(data.typescript)).default;}
export async function load(url,context,next){
 const prefix=new URL('dist/',root).href;
 if(url.startsWith(prefix)&&/\.js$/.test(url)){
  const relative=url.slice(prefix.length).replace(/\.js$/,'.ts');
  if(relative.startsWith('src/')||relative.startsWith('test/')){
   let source=execFileSync('git',['show','3e495b1c0cf7:'+relative],
    {cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
   if(relative==='test/om-feasibility.test.ts'){
    const boundary=source.indexOf('const heads =');if(boundary<0)throw new Error('Missing old native M8 fixture');
    source=source.slice(0,boundary)+'\nexport {acceptedWorksFixture};';
   }
   return {format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};
  }
 }
 return next(url,context);
}`;

test('G1.1 complete 3e495b1 producer preserves legacy feasibility and plans while M8 v1 is explicitly superseded without rewriting history', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'omg-g11-era-producer-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const loader = join(directory, 'old-loader.mjs'), script = join(directory, 'old-producer.mjs');
  writeFileSync(loader, HISTORY_LOADER);
  writeFileSync(script, `import assert from 'node:assert/strict';
import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const repository=process.argv[2],src=path=>pathToFileURL(join(repository,'dist/src',path)).href,
 helpers=path=>pathToFileURL(join(repository,'dist/test',path)).href;
const {executionFixture}=await import(helpers('execution-fixture.js'));
const {acceptedWorksFixture}=await import(helpers('om-feasibility.test.js'));
const {writeFeasibility}=await import(src('om/feasibility.js'));
const {reference,uniqueRefs}=await import(src('pipeline/contracts.js'));
const {canonical,hashJson}=await import(src('canonical.js'));
const {Owners}=await import(src('ownership/owners.js'));
const {taskObligationHandoff,requireTaskObligations}=await import(src('graph/task-obligations.js'));
const {deriveTasks}=await import(src('compiler/derive.js'));
const {resolveArtifact}=await import(src('compiler/inputs.js'));
${planWithIncompleteProvenance.toString()}
const cleanup=[];
try {
 const l=executionFixture({after:fn=>cleanup.push(fn)}),ready=l.store.get('feasibility:p');
 const checks={feasibility:l.engine.refinement.feasibilityGate('p',reference(ready)),
  om:l.engine.pipeline.inspect('p','om-g2'),compilation:l.engine.pipeline.inspect('p','compilation'),
  plan:l.engine.compiler.gate('p',reference(l.plan))};
 assert.equal(checks.feasibility.findings.length,0);assert.equal(checks.plan.findings.length,0);
 assert.equal(checks.om.state,'accepted');assert.equal(checks.compilation.state,'accepted');
 const legacy={directory:l.directory,database:l.store.path,project:'p',ready,plan:l.plan,checks,
  history:canonical(l.store.list().flatMap(row=>l.store.history(row.id)))};
 l.store.close();
 const f=acceptedWorksFixture({after:fn=>cleanup.push(fn)}),m8=writeFeasibility(f.store,f.feasibility);
 assert.equal(m8.ok,true);assert.equal(m8.value.value.producer.contract,'om-m8/v1');
 const plan=planWithIncompleteProvenance(f.store,m8.value);
 const om={directory:f.root,database:f.store.path,project:f.project,ready:m8.value,plan,request:f.feasibility,
  history:canonical(f.store.list().flatMap(row=>f.store.history(row.id)))};
 f.store.close();process.stdout.write(JSON.stringify({legacy,om}));
} catch(error){for(const fn of cleanup)try{fn();}catch{}throw error;}
`);
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const bootstrap = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},
{data:{root:${JSON.stringify(pathToFileURL(repository).href)},typescript:${JSON.stringify(typescript)}}});`;
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const raw = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, script, repository],
    { cwd: repository, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 40_000_000 });
  const old = JSON.parse(raw) as {
    legacy: { directory: string; database: string; project: string; ready: Revision<Feasibility>; plan: Revision<MachinePlan>; history: string;
      checks: { feasibility: GateResult; om: StageProjection; compilation: StageProjection; plan: GateResult } };
    om: { directory: string; database: string; project: string; ready: Revision<OmFeasibility>; plan: Revision<MachinePlan>;
      request: FeasibilityRequest; history: string };
  };
  t.after(() => { rmSync(old.legacy.directory, { recursive: true, force: true }); rmSync(old.om.directory, { recursive: true, force: true }); });
  for (const restart of [0, 1]) {
    const legacy = new Store(old.legacy.database), engine = new ProductEngine(legacy);
    try {
      assert.equal(canonical(legacy.list().flatMap(row => legacy.history(row.id))), old.legacy.history);
      assert.deepEqual(engine.compiler.read(old.legacy.plan.id), old.legacy.plan);
      assert.deepEqual(engine.compiler.compile(old.legacy.project), old.legacy.plan);
      assert.deepEqual({ feasibility: engine.refinement.feasibilityGate(old.legacy.project, reference(old.legacy.ready)),
        om: engine.pipeline.inspect(old.legacy.project, 'om-g2'), compilation: engine.pipeline.inspect(old.legacy.project, 'compilation'),
        plan: engine.compiler.gate(old.legacy.project, reference(old.legacy.plan)) }, old.legacy.checks);
      assert.equal(canonical(legacy.list().flatMap(row => legacy.history(row.id))), old.legacy.history);
    } finally { legacy.close(); }
    const store = new Store(old.om.database), current = new ProductEngine(store), request = { project: old.om.project, record: reference(old.om.ready) };
    try {
      for (const result of [readFeasibility(store, request), gateFeasibility(store, request), writeFeasibility(store, old.om.request)]) {
        assert.equal(result.ok, false, `The unreleased v1 producer remains explicitly superseded after restart ${restart}`);
        if (result.ok) throw new Error('M8 v1 cannot silently adopt the v2 formula');
        assert.equal(result.refusal.code, 'feasibility_contract_superseded');
        assert.equal(result.refusal.at.target, old.om.ready.id); assert.equal(result.refusal.at.field, 'producer.contract');
      }
      for (const historical of [false, true]) {
        refused(current.refinement.feasibilityGate(old.om.project, reference(old.om.ready), historical), 'feasibility_contract_superseded', old.om.ready.id);
        assert.throws(() => current.compiler.gate(old.om.project, reference(old.om.plan), historical), errorCode('feasibility_contract_superseded'));
      }
      assert.throws(() => requireBasis(store, old.om.plan.value), errorCode('feasibility_contract_superseded'));
      assert.throws(() => requirePlanTaskObligations(store, old.om.plan.value), errorCode('feasibility_contract_superseded'));
      assert.throws(() => current.compiler.read(old.om.plan.id), errorCode('feasibility_contract_superseded'));
      assert.deepEqual(store.get(old.om.ready.id, old.om.ready.revision), old.om.ready);
      assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), old.om.history,
        'Typed refusal never rewrites v1 records, their hashes, or either saved inputs set');
    } finally { store.close(); }
  }
});
