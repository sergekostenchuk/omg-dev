import test, { type TestContext } from 'node:test';
import '../src/om/compiler-readers.js';
import { selectTaskSpecification, hasBasisApplications } from '../src/om/selected-specification.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest, hashJson } from '../src/canonical.js';
import { preplanTaskContext, taskContext, taskContextContent, type PlanTaskContextSources } from '../src/compiler/context.js';
import { deriveTasks } from '../src/compiler/derive.js';
import { TASK_CONTEXT_CONTRACT, BASIS_TASK_CONTEXT_CONTRACT, type CompiledTask, type MachinePlan } from '../src/compiler/model.js';
import type { TaskSpecification, TaskSpecificationSelection, OmReaderResult } from '../src/compiler/om-readers.js';
import type { AtomicGateRequest } from '../src/om/atomic-gate.js';
import { EngineError } from '../src/errors.js';
import { LEVEL, type Command, type Graph, type Node } from '../src/graph/model.js';
import { RefinementRelations } from '../src/graph/relations.js';
import type { BoundTaskObligation } from '../src/graph/task-obligation-model.js';
import { frameObligations, type FrameObligation } from '../src/om/frame-obligations.js';
import { buildPackets, NEIGHBOR_CONTRACT, type NeighborCollection, type NeighborSources } from '../src/om/neighbors.js';
import type { OmResult } from '../src/om/refusal.js';
import { writerIndexId } from '../src/ownership/writer-index.js';
import { reference, type Ref, type StageArtifact } from '../src/pipeline/contracts.js';
import type { Revision } from '../src/storage/store.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';

const project = 'context', producer = `${project}-produce-work`, consumer = `${project}-consume-work`;
const FULL_CHECK: Command = { executable: 'npm', args: ['run', 'check:backend', '--', 'результат'] };
const ref = (id: string): Ref => ({ id, revision: 1, hash: hashJson(id) });
const clone = structuredClone;
const node = (graph: Graph, id: string): Node => graph.nodes.find(item => item.id === id)!;
type PreplanRequest = Parameters<typeof preplanTaskContext>[0];
function ok<T>(value: OmResult<T> | OmReaderResult<T>): T {
  if (!value.ok) assert.fail(`${value.refusal.code}: ${value.refusal.message}`);
  return value.value;
}

/** Pure F4 sources represent the already checked frame fills at this boundary. */
function neighborSources(graph: Graph): NeighborSources {
  const relations = new RefinementRelations(graph);
  function frame(level: 2 | 3): NeighborSources['frames']['works'] {
    const upper = graph.nodes.filter(item => LEVEL[item.kind] === level - 1).map(item => item.id);
    const obligations = clone(ok(frameObligations(graph, { nodes: upper, excluded: [], hash: hashJson(upper) }, level))) as FrameObligation[];
    const fills: NonNullable<NeighborSources['frames']['works']['fills']> = [];
    for (const obligation of obligations) {
      if (obligation.kind !== 'connection-end') {
        for (const lower of graph.nodes.filter(item => LEVEL[item.kind] === level && item.outcome === obligation.artifact
          && relations.refines(item.id, obligation.upper.node))) fills.push({ obligation: obligation.id, node: lower.id, source: 'accepted' });
        continue;
      }
      const connector = graph.connectors.find(item => item.id === obligation.connector)!, seen = new Set<string>();
      for (const flow of connector.bindings.filter(item => item.level === level)) {
        for (const end of obligation.role === 'producer' ? [flow.producer] : flow.consumers) {
          if (!relations.refines(end.node, obligation.upper.node) || end.port !== obligation.upper.port) continue;
          const key = canonical([end.node, end.port]);
          if (seen.has(key)) continue;
          seen.add(key);
          fills.push({ obligation: obligation.id, node: end.node, port: end.port, source: 'accepted',
            ...(level === 3 && end.codeRef ? { codeRef: clone(end.codeRef) } : {}) });
        }
      }
    }
    return { obligations, fills };
  }
  return { identity: [], receipts: {}, frames: { operations: frame(2), works: frame(3) } };
}

function obligations(graph: Graph): Map<string, BoundTaskObligation[]> {
  const scope = ref(`om-obligations:${project}:fixture`), original = ref(`om-gap:${project}:late-confirmation`);
  return new Map(graph.horizon.map(work => [work, (['task-start', 'task-result'] as const).map((moment, index) => ({
    binding: `obligation:${hashJson([work, moment]).slice(0, 40)}`,
    requirement: { scope, obligation: `${project}-late-${index}`, original: { record: original, pointer: '/gap' },
      kind: index === 0 ? 'environment-confirmation' as const : 'post-implementation-proof' as const,
      moment, responsibleNode: node(graph, work).parent!, responsibleConsumer: node(graph, work).parent!,
      neededForR2: false, reason: 'The obligation belongs to this execution moment',
      returnCondition: `Проверяемое условие ${moment} для ${work}`, wake: null },
    tests: [...node(graph, work).tests],
  }))]));
}

function collection(graph: Graph, candidate: Ref): Revision<NeighborCollection> {
  const value: NeighborCollection = { contract: NEIGHBOR_CONTRACT, project,
    source: { project, candidate, ownership: { contract: 'delivery-ownership/v1', root: ref(`execution-root:${project}`),
      indexes: Object.fromEntries([...new Set(graph.nodes.filter(item => graph.horizon.includes(item.id))
        .flatMap(item => item.code.filter(code => code.access === 'write').map(code => code.path)))].sort()
        .map(path => [path, ref(writerIndexId(project, path))])) } },
    packets: clone(ok(buildPackets(graph, neighborSources(graph)))) as NeighborCollection['packets'] };
  return resealCollection({ id: '', kind: 'om-neighbors', revision: 1, hash: '', value });
}
function resealCollection(row: Revision<NeighborCollection>): Revision<NeighborCollection> {
  row.id = `om-neighbors:${row.value.project}:${hashJson({ contract: row.value.contract, source: row.value.source })}`;
  row.hash = hashJson(row.value);
  return row;
}
function resealPackets(row: Revision<NeighborCollection>): void {
  for (const packet of row.value.packets) packet.hash = hashJson(packet.neighbors);
  resealCollection(row);
}

function fixture(change?: (graph: Graph) => void) {
  const graph = enrichedGraph(exampleGraph(project), project);
  for (const kind of ['block', 'operation', 'work'] as const) {
    node(graph, `${project}-produce-${kind}`).ports.push({ id: 'out-alt', direction: 'out', contract: `${project}-contract` });
    node(graph, `${project}-consume-${kind}`).ports.push({ id: 'in-alt', direction: 'in', contract: `${project}-contract` });
  }
  const connector = graph.connectors[0]!;
  for (const binding of [...connector.bindings]) {
    const extra = clone(binding); extra.producer.port = 'out-alt'; extra.consumers[0]!.port = 'in-alt';
    connector.bindings.push(extra);
  }
  graph.edges!.push({ id: 'required-predecessor', source: consumer, target: producer,
    relation: 'requires', condition: 'Use the predecessor result before writing' });
  const transfer = { id: 'shared-owner', from: producer, to: consumer, path: 'src/shared.ts', condition: 'producer_committed' as const };
  for (const work of [producer, consumer]) node(graph, work).code.push({ path: transfer.path, access: 'write', status: 'planned' });
  node(graph, consumer).code.push({ path: 'src/read-only.ts', access: 'read', status: 'existing' });
  graph.transfers!.push(transfer);
  change?.(graph);
  const tasks = deriveTasks(project, hashJson(graph), graph, () => { throw new Error('All fixture producers are in the plan'); },
    { version: 2, owner: () => null, researchObligations: obligations(graph) }).tasks;
  const task = tasks.find(item => item.node === consumer)!;
  const basis = { candidate: ref(`om-candidate:${project}:${hashJson(graph)}`), environment: ref(`environment:${project}`) };
  const request: PreplanRequest = { project, graph, task, fullCheck: clone(FULL_CHECK), basis, neighbors: collection(graph, basis.candidate) };
  return { graph, tasks, task, request };
}

function plan(graph: Graph, tasks: CompiledTask[]): Revision<MachinePlan> {
  const body: MachinePlan = { version: 2, projectId: project, graph: ref(`graph:${project}`), environment: ref(`environment:${project}`),
    stage: ref(`stage:${project}:om-g2`), feasibility: ref(`feasibility:${project}`), guards: [],
    base: { root: '/fixture', head: 'a'.repeat(40), tree: 'b'.repeat(40), files: [] }, tasks, graphSnapshot: graph, hash: 'fixture' };
  return { id: `plan:${project}:fixture`, kind: 'plan', revision: 1, hash: hashJson(body), value: body };
}

function sourceError(action: () => unknown, message?: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof EngineError, message);
    assert.equal(error.code, 'context_source_invalid', message);
    const details = error.details as { unit?: string; target?: string; field?: string };
    assert.equal(details?.unit, 'V2', message);
    assert.equal(typeof details.target, 'string', message); assert.ok(details.target, message);
    assert.equal(typeof details.field, 'string', message); assert.ok(details.field, message);
    return true;
  }, message);
}
function checkError(action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof EngineError && error.code === 'context_check_missing');
}

test('V2 common content preserves all substantive v1 fields while pre-plan adds exact source and neighbor data', () => {
  const c = fixture(), legacy = JSON.parse(taskContext(plan(c.graph, c.tasks), FULL_CHECK, c.task.id, 1_000_000).text);
  const content = taskContextContent({ graph: c.graph, task: c.task, fullCheck: FULL_CHECK });
  const { version: _version, binding: _binding, details: _details, ...substantive } = legacy;
  assert.deepEqual(content, substantive);
  assert.deepEqual(Object.keys(content).sort(), ['action', 'scope', 'requirements', 'actor', 'inputs', 'produces', 'artifacts', 'contracts',
    'criteria', 'connections', 'controls', 'anchors', 'transfers', 'correction'].sort());
  const output = preplanTaskContext(c.request, 1_000_000), payload = JSON.parse(output.text);
  assert.equal(payload.version, 'omg-task-context/preplan-v1');
  assert.deepEqual(payload.binding, { ...c.request.basis, neighbors: reference(c.request.neighbors), task: c.task.id });
  assert.deepEqual(payload.scope, { ...content.scope, readPaths: c.task.readPaths, writePaths: c.task.writePaths });
  for (const key of Object.keys(content).filter(key => key !== 'scope'))
    assert.deepEqual(payload[key], content[key as keyof typeof content], key);
  assert.deepEqual(payload.neighbors, c.request.neighbors.value.packets.find(packet => packet.work === c.task.node));
  assert.deepEqual(payload.deliveryOwnership, c.request.neighbors.value.source.ownership);
  assert.equal(payload.details.source, 'works-candidate'); assert.equal(payload.details.project, project);
  assert.deepEqual(payload.details.candidate, c.request.basis.candidate); assert.equal(payload.details.task, c.task.id);
  assert.deepEqual(payload.details.selectors, legacy.details.selectors);
  assert.equal(Object.hasOwn(payload.binding, 'plan'), false); assert.equal(Object.hasOwn(payload.details, 'plan'), false);
  assert.equal(Object.hasOwn(payload.binding, 'base'), false);
  assert.equal(payload.inputs.filter((input: { connector: string }) => input.connector === `${project}-flow`).length, 2,
    'Two exact flows retain two compiler inputs even when artifact and producer match');
  assert.equal(payload.neighbors.neighbors.filter((neighbor: { connector?: string }) => neighbor.connector === `${project}-flow`).length, 2);
  assert.ok(payload.neighbors.neighbors.some((neighbor: { direction: string }) => neighbor.direction === 'requires'));
  assert.ok(payload.neighbors.neighbors.some((neighbor: { direction: string }) => neighbor.direction === 'receives'));
  assert.deepEqual(payload.criteria.researchObligations, c.task.researchObligations);
  assert.equal(payload.criteria.researchObligations.length, 2);
  assert.equal(payload.criteria.fullCheck.args.at(-1), 'результат');
});

test('V2 measures the entire canonical preliminary context with string length and no truncation', () => {
  const c = fixture(), full = preplanTaskContext(c.request, 1_000_000);
  assert.equal(full.chars, full.text.length); assert.equal(full.utf8Bytes, Buffer.byteLength(full.text, 'utf8'));
  assert.equal(full.hash, digest(full.text)); assert.ok(full.utf8Bytes > full.chars);
  assert.deepEqual(preplanTaskContext(c.request, full.chars), full);
  assert.throws(() => preplanTaskContext(c.request, full.chars - 1), (error: unknown) => error instanceof EngineError
    && error.code === 'context_budget_exceeded'
    && canonical(error.details) === canonical({ requiredChars: full.chars, maxChars: full.chars - 1 }));
  const content = taskContextContent({ graph: c.graph, task: c.task, fullCheck: FULL_CHECK });
  assert.ok(canonical(content).length < full.chars);
  assert.throws(() => preplanTaskContext(c.request, canonical(content).length), (error: unknown) => error instanceof EngineError
    && error.code === 'context_budget_exceeded', 'The source envelope and all neighbors must also fit');
  for (const limit of [0, -1, 1.5, NaN, Infinity, undefined])
    assert.throws(() => preplanTaskContext(c.request, limit as number), (error: unknown) => error instanceof EngineError
      && error.code === 'context_budget_invalid');
});

test('V2 refuses missing or malformed public input and explicit missing D7 instead of leaking property errors', () => {
  const c = fixture();
  for (const value of [undefined, null, false, []]) {
    sourceError(() => preplanTaskContext(value as unknown as PreplanRequest, 1_000_000));
    sourceError(() => taskContextContent(value as unknown as Parameters<typeof taskContextContent>[0]));
  }
  checkError(() => preplanTaskContext({} as PreplanRequest, 1_000_000));
  checkError(() => taskContextContent({} as Parameters<typeof taskContextContent>[0]));
  for (const field of ['project', 'graph', 'task', 'basis', 'neighbors']) {
    const value = clone(c.request) as unknown as Record<string, unknown>; delete value[field];
    sourceError(() => preplanTaskContext(value as unknown as PreplanRequest, 1_000_000), field);
  }
  for (const field of ['candidate', 'environment']) {
    const value = clone(c.request); delete (value.basis as unknown as Record<string, unknown>)[field];
    sourceError(() => preplanTaskContext(value, 1_000_000), `basis.${field}`);
  }
  for (const field of ['nodes', 'horizon', 'contracts', 'artifacts', 'connectors', 'anchors', 'joins', 'tests']) {
    const value = clone(c.request); delete (value.graph as unknown as Record<string, unknown>)[field];
    sourceError(() => preplanTaskContext(value, 1_000_000), `graph.${field}`);
  }
  for (const field of ['researchObligations', 'ownership', 'requirements', 'packets', 'inputs', 'produces', 'readPaths', 'writePaths', 'tests', 'obligations']) {
    const value = clone(c.request); delete (value.task as unknown as Record<string, unknown>)[field];
    sourceError(() => preplanTaskContext(value, 1_000_000), `task.${field}`);
  }
  const empty = clone(c.request); empty.task.researchObligations = [];
  assert.deepEqual(JSON.parse(preplanTaskContext(empty, 1_000_000).text).criteria.researchObligations, []);
  const absentCheck = clone(c.request); delete (absentCheck as unknown as Record<string, unknown>)['fullCheck'];
  checkError(() => preplanTaskContext(absentCheck, 1_000_000));
  for (const malformed of [null, {}, { executable: 'node', args: null }, { executable: ' ', args: [] }]) {
    const value = clone(c.request); value.fullCheck = malformed as Command;
    checkError(() => preplanTaskContext(value, 1_000_000));
  }
  const foreign = clone(c.request); foreign.task.node = 'another-work';
  assert.throws(() => preplanTaskContext(foreign, 1_000_000), (error: unknown) => error instanceof EngineError && error.code === 'task_foreign');
});

test('V2 checks the complete neighbor collection, exact envelope and own hashes before selecting a work', () => {
  const c = fixture();
  const beforeExecution = clone(c.request); beforeExecution.neighbors.value.source.ownership.root = null;
  resealCollection(beforeExecution.neighbors);
  assert.equal(JSON.parse(preplanTaskContext(beforeExecution, 1_000_000).text).deliveryOwnership.root, null,
    'An explicit pre-execution root remains null rather than becoming an invented execution');
  const changes: [string, (value: PreplanRequest) => void][] = [
    ['kind', value => { value.neighbors.kind = 'source'; }],
    ['record hash', value => { value.neighbors.hash = '0'.repeat(64); }],
    ['record revision', value => { value.neighbors.revision = 0; }],
    ['record namespace', value => { value.neighbors.id = 'om-neighbors:foreign:value'; }],
    ['project', value => { value.neighbors.value.project = 'foreign'; resealCollection(value.neighbors); }],
    ['source project', value => { value.neighbors.value.source.project = 'foreign'; resealCollection(value.neighbors); }],
    ['candidate', value => { value.neighbors.value.source.candidate = { ...value.neighbors.value.source.candidate, hash: 'b'.repeat(64) }; resealCollection(value.neighbors); }],
    ['foreign environment', value => { value.basis.environment.id = 'environment:foreign'; }],
    ['foreign candidate', value => { value.basis.candidate.id = 'om-candidate:foreign:fixture'; }],
    ['missing collection member', value => { value.neighbors.value.packets = value.neighbors.value.packets.filter(packet => packet.work === consumer); resealCollection(value.neighbors); }],
    ['duplicate collection member', value => { value.neighbors.value.packets.push(clone(value.neighbors.value.packets[0]!)); resealCollection(value.neighbors); }],
    ['foreign work', value => { value.neighbors.value.packets[0]!.work = 'foreign-work'; resealCollection(value.neighbors); }],
    ['packet hash', value => { value.neighbors.value.packets[0]!.hash = 'c'.repeat(64); resealCollection(value.neighbors); }],
    ['contract', value => { (value.neighbors.value as unknown as Record<string, unknown>)['contract'] = 'neighbor-packets/unknown'; resealCollection(value.neighbors); }],
    ['ownership absent', value => { delete (value.neighbors.value.source as unknown as Record<string, unknown>)['ownership']; resealCollection(value.neighbors); }],
    ['ownership root absent', value => { delete (value.neighbors.value.source.ownership as unknown as Record<string, unknown>)['root']; resealCollection(value.neighbors); }],
    ['ownership index absent', value => { delete (value.neighbors.value.source.ownership as unknown as Record<string, unknown>)['indexes']; resealCollection(value.neighbors); }],
    ['ownership index malformed', value => { value.neighbors.value.source.ownership.indexes['consume.txt'] = { ...ref('writer-index:fixture'), hash: 'wrong' }; resealCollection(value.neighbors); }],
  ];
  for (const [name, change] of changes) { const value = clone(c.request); change(value); sourceError(() => preplanTaskContext(value, 1_000_000), name); }
  for (const [name, direction, change] of [
    ['available without basis', 'reads', (row: Record<string, unknown>) => { row['delivery'] = 'available'; delete row['basis']; }],
    ['data without endpoint code', 'reads', (row: Record<string, unknown>) => { delete row['codeRef']; }],
    ['data without contract', 'reads', (row: Record<string, unknown>) => { delete row['contract']; }],
    ['requires without control', 'requires', (row: Record<string, unknown>) => { delete row['control']; }],
    ['requires without artifact', 'requires', (row: Record<string, unknown>) => { delete row['artifact']; }],
    ['ownership without condition', 'receives', (row: Record<string, unknown>) => { delete row['condition']; }],
    ['ownership with artifact masquerade', 'receives', (row: Record<string, unknown>) => { row['artifact'] = `${project}-data`; }],
  ] as const) {
    const value = clone(c.request), selected = value.neighbors.value.packets.find(packet => packet.work === consumer)!;
    change(selected.neighbors.find(row => row.direction === direction)! as unknown as Record<string, unknown>);
    resealPackets(value.neighbors);
    sourceError(() => preplanTaskContext(value, 1_000_000), name);
  }
});

test('V2 an explicit empty packet requires no data, control or ownership neighbor, while self data does not invent one', () => {
  const variants: [string, (graph: Graph) => void][] = [
    ['data', graph => { graph.edges = []; graph.transfers = []; }],
    ['control', graph => { graph.connectors = []; graph.transfers = []; }],
    ['ownership', graph => { graph.connectors = []; graph.edges = []; }],
  ];
  for (const [name, change] of variants) {
    const c = fixture(change), packet = c.request.neighbors.value.packets.find(item => item.work === consumer)!;
    assert.ok(packet.neighbors.length, name); packet.neighbors = []; resealPackets(c.request.neighbors);
    sourceError(() => preplanTaskContext(c.request, 1_000_000), name);
  }
  const isolated = fixture(graph => { graph.connectors = []; graph.edges = []; graph.transfers = []; });
  assert.deepEqual(JSON.parse(preplanTaskContext(isolated.request, 1_000_000).text).neighbors.neighbors, []);
  const self = fixture(graph => {
    graph.edges = []; graph.transfers = [];
    for (const kind of ['block', 'operation', 'work'] as const)
      node(graph, `${project}-produce-${kind}`).ports.push({ id: 'self', direction: 'in', contract: `${project}-contract` });
    for (const connector of graph.connectors) for (const binding of connector.bindings) binding.consumers = [{
      node: binding.producer.node, port: 'self', ...(binding.level === 3 ? { codeRef: clone(node(graph, producer).code[0]!) } : {}) }];
  });
  self.request.task = self.tasks.find(item => item.node === producer)!;
  assert.deepEqual(JSON.parse(preplanTaskContext(self.request, 1_000_000).text).neighbors.neighbors, []);
});

test('V2 owns its output, leaves all caller data mutable and preserves own __proto__ JSON keys', () => {
  const c = fixture(graph => { graph.contracts[0]!.schema = JSON.parse('{"type":"string","__proto__":{"polluted":"contract-data"}}'); });
  const before = canonical(c.request), content = taskContextContent({ graph: c.graph, task: c.task, fullCheck: FULL_CHECK });
  const output = preplanTaskContext(c.request, 1_000_000), originalContent = canonical(content);
  assert.equal(canonical(c.request), before); assert.ok(Object.isFrozen(content)); assert.ok(Object.isFrozen(content.scope));
  assert.ok(Object.isFrozen(content.criteria.tests));
  assert.equal(Object.isFrozen(c.graph), false); assert.equal(Object.isFrozen(c.task), false);
  assert.equal(Object.isFrozen(c.request.neighbors.value), false);
  assert.throws(() => { (content.scope.code as unknown as { path: string }[])[0]!.path = 'mutated'; }, TypeError);
  c.task.title = 'changed after rendering'; c.graph.contracts[0]!.schema = { type: 'number' };
  c.request.neighbors.value.packets[0]!.neighbors.length = 0;
  assert.equal(canonical(content), originalContent); assert.equal(output.hash, digest(output.text));
  const schema = JSON.parse(output.text).contracts.find((contract: { id: string }) => contract.id === `${project}-contract`).schema;
  assert.equal(Object.hasOwn(schema, '__proto__'), true); assert.deepEqual(schema['__proto__'], { polluted: 'contract-data' });
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

function sp1ContextFixture() {
  const f = fixture(), saved = plan(f.graph, f.tasks);
  saved.value.feasibility = ref(`om-feasibility:${project}`);
  saved.value.taskContextContract = TASK_CONTEXT_CONTRACT;
  saved.hash = hashJson(saved.value);
  const input = ref(`om-input:${project}`), specificationRef = ref(`stage:${project}:specification`), features = ref(`stage:${project}:features`);
  const specification: TaskSpecification = { contract: 'selected-specification/v1',
    contracts: [{ source: specificationRef, index: 3, pointer: '/content/fields/behaviorContracts/3',
      value: { id: 'B1', entry: 'Begin the bounded operation', inputs: ['external input'], compatibility: ['retain v1 clients'],
        state: { writer: 'the responsible component' }, mentionedFile: 'do-not-authorize.txt' },
      effective: { source: input, pointer: '/contracts/3', value: { id: 'B1', nodes: [f.task.node], state: { writer: f.task.node } } } }],
    preparations: [{ source: features, index: 2, featureIndex: 1, pointer: '/content/fields/featurePreparation/2',
      value: { featureTitle: 'Bounded behavior', outcome: f.task.outcome, beneficiary: 'operator', benefit: 'stable result',
        success: ['consumer sees result'], failures: ['missing input refused'], interactions: ['another contract B2 is context only'] } }],
    constraints: { source: specificationRef, pointer: '/content/fields/constraints', value: ['No silent loss of material'] } };
  const sources: PlanTaskContextSources = { plan: reference(saved), graph: saved.value.graph, candidate: f.request.basis.candidate,
    references: [saved.value.graph, saved.value.environment, saved.value.feasibility, f.request.basis.candidate],
    neighbors: neighborSources(f.graph), deliveryOwnership: f.request.neighbors.value.source.ownership,
    specification: { basis: { contract: TASK_CONTEXT_CONTRACT, gate: ref(`om-atomic-gate:${project}:gate`),
      horizon: ref(`om-horizon:${project}:horizon`), input }, tasks: { [f.task.id]: specification } } };
  return { ...f, saved, sources, specification, request: { ...f.request, taskContextContract: TASK_CONTEXT_CONTRACT, specification } };
}

test('SP1b the preliminary and saved-plan contexts retain the same complete original and effective specification without granting extra paths', () => {
  const f = sp1ContextFixture(), before = clone(f.task);
  const pre = JSON.parse(preplanTaskContext(f.request, 1_000_000).text);
  const actual = JSON.parse(taskContext(f.saved, FULL_CHECK, f.task.id, 1_000_000, f.sources).text);
  assert.equal(pre.version, 'omg-task-context/preplan-v2'); assert.equal(actual.version, TASK_CONTEXT_CONTRACT);
  assert.deepEqual(pre.selectedSpecification, f.specification); assert.deepEqual(actual.selectedSpecification, f.specification);
  assert.equal(actual.selectedSpecification.contracts[0].pointer, '/content/fields/behaviorContracts/3');
  assert.equal(actual.selectedSpecification.contracts[0].effective.pointer, '/contracts/3');
  assert.notEqual(actual.selectedSpecification.contracts[0].value.state.writer, actual.selectedSpecification.contracts[0].effective.value.state.writer);
  for (const context of [pre, actual]) {
    assert.deepEqual(context.scope.writePaths, f.task.writePaths);
    assert.equal(context.scope.writePaths.includes('do-not-authorize.txt'), false);
    assert.deepEqual(context.contracts, taskContextContent({ graph: f.graph, task: f.task, fullCheck: FULL_CHECK }).contracts,
      'Graph schemas retain their distinct meaning');
  }
  assert.deepEqual(f.task, before);
});

test('SP1b mandatory specification is measured whole at the exact limit and an overflow names the task and source before sending', () => {
  const f = sp1ContextFixture(), legacy = fixture();
  const prior = preplanTaskContext(legacy.request, 1_000_000), full = preplanTaskContext(f.request, 1_000_000);
  assert.ok(full.chars > prior.chars); assert.deepEqual(preplanTaskContext(f.request, full.chars), full);
  for (const capacity of [prior.chars, full.chars - 1]) assert.throws(() => preplanTaskContext(f.request, capacity), (error: unknown) => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, 'context_budget_exceeded');
    const details = error.details as { requiredChars: number; maxChars: number; target: string; field: string; sources: Ref[] };
    assert.equal(details.requiredChars, full.chars); assert.equal(details.maxChars, capacity); assert.equal(details.target, f.task.id);
    assert.equal(details.field, 'selectedSpecification');
    for (const source of [f.specification.constraints.source, f.specification.contracts[0]!.effective.source, f.specification.preparations[0]!.source])
      assert.ok(details.sources.some(ref => canonical(ref) === canonical(source)));
    return true;
  });
  const actual = taskContext(f.saved, FULL_CHECK, f.task.id, 1_000_000, f.sources);
  assert.deepEqual(taskContext(f.saved, FULL_CHECK, f.task.id, actual.chars, f.sources), actual);
  assert.throws(() => taskContext(f.saved, FULL_CHECK, f.task.id, actual.chars - 1, f.sources),
    (error: unknown) => error instanceof EngineError && error.code === 'context_budget_exceeded');
});

test('SP1b declared context with missing material refuses at the pure boundary while an unmarked legacy route stays byte exact', () => {
  const f = sp1ContextFixture(), { specification: _specification, ...missing } = f.request;
  sourceError(() => preplanTaskContext(missing, 1_000_000));
  const { specification: _sources, ...sources } = f.sources;
  sourceError(() => taskContext(f.saved, FULL_CHECK, f.task.id, 1_000_000, sources));
  const legacy = fixture(), saved = plan(legacy.graph, legacy.tasks), before = taskContext(saved, FULL_CHECK, legacy.task.id, 1_000_000);
  const payload = JSON.parse(before.text);
  assert.equal(payload.version, 'omg-task-context/v1'); assert.equal(Object.hasOwn(payload, 'selectedSpecification'), false);
  assert.deepEqual(taskContext(saved, FULL_CHECK, legacy.task.id, before.chars), before);
  const unmarked = { ...legacy.request, specification: f.specification };
  sourceError(() => preplanTaskContext(unmarked, 1_000_000));
});

// A real live snapshot is supplied by the operator; the test never manufactures an old-era database.
test('SP1b actual saved v1 plan and G5 keep their exact era after a native stage change and restart; the lower selector reads original stage refs',
  { skip: !process.env['OMG_SP1_HISTORY_SNAPSHOT'], timeout: 300_000 }, async t => {
  const { DatabaseSync, backup } = await import('node:sqlite');
  const { Store } = await import('../src/storage/store.js');
  const { loadTaskContextSources } = await import('../src/compiler/context.js');
  const { readAtomicGate, writeAtomicGate } = await import('../src/om/atomic-gate.js');
  const { readTaskContextBasis } = await import('../src/compiler/om-readers.js');
  const { ProductEngine } = await import('../src/product/engine.js');
  const { taskSpecificationReader } = await import('../src/om/compiler-readers.js');
  const root = mkdtempSync(join(tmpdir(), 'omg-sp1-history-')), path = join(root, 'history.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = new DatabaseSync(process.env['OMG_SP1_HISTORY_SNAPSHOT']!, { readOnly: true });
  try { await backup(original, path); } finally { original.close(); }
  let store = new Store(path);
  t.after(() => store.close());
  const saved = store.list<MachinePlan>('plan').find(row => row.value.feasibility.id.startsWith('om-feasibility:')
    && !Object.hasOwn(row.value, 'taskContextContract'))!;
  assert.ok(saved, 'The supplied live snapshot contains an authentic old plan');
  const engine = new ProductEngine(store);
  assert.deepEqual(engine.compiler.read(saved.id), saved);
  const basis = readTaskContextBasis(store, { project: saved.value.projectId, record: saved.value.feasibility });
  assert.equal(basis.ok, true); if (!basis.ok) return;
  assert.equal(basis.value.contract, 'omg-task-context/v1');
  const gate = ok(readAtomicGate(store, { project: saved.value.projectId, record: basis.value.gate }));
  assert.equal(Object.hasOwn(gate.value.request, 'taskContextContract'), false);
  assert.deepEqual(ok(writeAtomicGate(store, clone(gate.value.request) as AtomicGateRequest)), gate, 'A late exact repeat never upgrades the saved gate');
  const environment = store.get<{ fullCheck: Command }>(saved.value.environment.id, saved.value.environment.revision)!;
  const contexts = () => {
    const sources = loadTaskContextSources(store, saved);
    assert.equal(sources?.specification, undefined);
    return saved.value.tasks.map(task => taskContext(saved, environment.value.fullCheck, task.id, 1_000_000, sources));
  };
  const before = contexts();
  assert.ok(before.length > 0);
  const inputRef = gate.value.request.gaps.sources.input;
  let selected: TaskSpecificationSelection | undefined;
  const reader = taskSpecificationReader(selection => {
    selected = selection;
    const specification = selection.accepted.find(stage => stage.stage === 'specification')!;
    assert.ok(specification); assert.ok(Array.isArray(specification.fields['constraints']));
    return { contract: 'selected-specification/v1', contracts: [], preparations: [], constraints: {
      source: specification.ref, pointer: '/content/fields/constraints', value: specification.fields['constraints']! } };
  });
  const request = { project: saved.value.projectId, input: inputRef, requirements: ['fixture-requirement'], nodes: ['fixture-work', 'fixture-operation'] };
  const originalSelection = ok(reader(store, request));
  assert.ok(selected); assert.deepEqual(selected.inputRef, inputRef);
  assert.deepEqual(selected.requirements, request.requirements); assert.deepEqual(selected.nodes, request.nodes);
  for (const source of selected.input.sources) {
    const delivered: TaskSpecificationSelection['accepted'][number] = selected.accepted.find(stage => stage.stage === source.stage)!;
    const exact = store.get<StageArtifact>(source.id, source.revision)!;
    assert.deepEqual(delivered.ref, reference(exact));
    assert.deepEqual(delivered.fields, (exact.value.content as { fields: unknown }).fields, 'Full original fields reach the shared selector');
  }
  const oldSpecification = store.get<StageArtifact>(originalSelection.constraints.source.id)!;
  const content = clone(oldSpecification.value.content) as { fields: Record<string, import('../src/canonical.js').Json> };
  content.fields['constraints'] = ['A later draft must not replace material bound by the old plan'];
  const changed = engine.pipeline.draft(saved.value.projectId, 'specification', content, oldSpecification.revision);
  assert.ok(changed.revision > oldSpecification.revision);
  assert.deepEqual(ok(reader(store, request)), originalSelection);
  assert.deepEqual(contexts(), before);

  for (const result of before) {
    const body = JSON.parse(result.text);
    assert.equal(body.version, 'omg-task-context/v1'); assert.equal(Object.hasOwn(body, 'selectedSpecification'), false);
  }
  store.close(); store = new Store(path);
  assert.deepEqual(contexts(), before);
  assert.deepEqual(ok(reader(store, request)), originalSelection);
  assert.deepEqual(new ProductEngine(store).compiler.read(saved.id), saved);
});


function sp1Selection(): TaskSpecificationSelection {
  const specification = ref(`stage:${project}:specification`), features = ref(`stage:${project}:features`);
  const originals = ['unrelated', 'required', 'node', 'ancestor'].map(id => ({ id,
    entry: `entry ${id}`, inputs: [`input ${id}`], compatibility: `compatibility ${id}`,
    state: { writer: `original writer ${id}` } }));
  return { project, inputRef: ref(`om-input:${project}`), requirements: [], nodes: [],
    input: { sources: [{ ...specification, stage: 'specification' }, { ...features, stage: 'features' }],
      contracts: [
        { ...originals[0]!, id: 'unrelated', nodes: ['elsewhere'], requirements: ['elsewhere'] },
        { ...originals[3]!, id: 'ancestor', nodes: ['parent'], requirements: [] },
        { ...originals[1]!, id: 'required', nodes: null, requirements: ['R'] },
        { ...originals[2]!, id: 'node', nodes: ['work'], requirements: [], state: { writer: 'resolved-work' } },
      ], features: [
        { index: 0, title: 'same title', outcome: 'other outcome', requirementIds: [], contracts: ['unrelated'] },
        { index: 1, title: 'same title', outcome: 'chosen outcome', requirementIds: [], contracts: ['required', 'unrelated'] },
        { index: 2, title: 'by requirement', outcome: 'requirement outcome', requirementIds: ['F'], contracts: ['unrelated'] },
      ] }, accepted: [
      { stage: 'specification', ref: specification, fields: { behaviorContracts: originals, constraints: ['global constraint'] } },
      { stage: 'features', ref: features, fields: { featurePreparation: [
        { featureTitle: 'by requirement', outcome: 'requirement outcome', beneficiary: 'F user', interactions: ['extra action is context'] },
        { featureTitle: 'same title', outcome: 'other outcome', beneficiary: 'unrelated user' },
        { featureTitle: 'same title', outcome: 'chosen outcome', beneficiary: 'chosen user', benefit: 'useful result',
          success: ['success'], failures: ['failure'], interactions: ['do not grant extra.txt'], contracts: ['required', 'unrelated'] },
      ] } },
    ] };
}
for (const mode of ['requirement', 'node', 'ancestor'] as const)
test(`SP1b task selection by ${mode} keeps exact original indices and resolved B1 values`, () => {
  const request = sp1Selection();
  if (mode === 'requirement') request.requirements = ['R']; else request.nodes = mode === 'node' ? ['work'] : ['child', 'parent'];
  const before = canonical(request), selected = selectTaskSpecification(request);
  assert.equal(selected.contracts.length, 1);
  const row = selected.contracts[0]!;
  const id = mode === 'requirement' ? 'required' : mode;
  assert.equal((row.value as any).id, id);
  const originalIndex = ['unrelated', 'required', 'node', 'ancestor'].indexOf(id);
  const effectiveIndex = request.input.contracts.findIndex(value => value.id === id);
  assert.equal(row.pointer, `/content/fields/behaviorContracts/${originalIndex}`);
  assert.deepEqual(row.effective, { source: request.inputRef, pointer: `/contracts/${effectiveIndex}`, value: request.input.contracts[effectiveIndex] });
  assert.deepEqual(row.source, request.accepted[0]!.ref);
  assert.deepEqual(selected.constraints.value, ['global constraint']);
  assert.equal(canonical(request), before);
  if (mode === 'node') assert.notDeepEqual((row.value as any).state, (row.effective.value as any).state);
});

test('SP1b features use requirement or exact selected contract without title matching or recursive contract expansion', () => {
  const request = sp1Selection(); request.requirements = ['R', 'F'];
  const selected = selectTaskSpecification(request);
  assert.deepEqual(selected.contracts.map(row => (row.value as any).id), ['required']);
  assert.deepEqual(selected.preparations.map(row => row.featureIndex), [2, 1]);
  assert.deepEqual(selected.preparations.map(row => row.pointer), ['/content/fields/featurePreparation/0', '/content/fields/featurePreparation/2']);
  assert.equal((selected.preparations[1]!.value as any).beneficiary, 'chosen user');
  (selected.preparations[1]!.value as any).beneficiary = 'caller edit';
  assert.equal((selectTaskSpecification(request).preparations[1]!.value as any).beneficiary, 'chosen user');
});

test('SP1b pure selection refuses a foreign basis and missing or ambiguous selected preparation with addresses', () => {
  const request = sp1Selection(); request.requirements = ['R'];
  for (const kind of ['input', 'stage', 'missing', 'ambiguous'] as const) {
    const changed = clone(request);
    if (kind === 'input') changed.inputRef = ref('om-input:other');
    if (kind === 'stage') changed.accepted[0]!.ref = ref('stage:other:specification');
    if (kind === 'missing') changed.accepted[1]!.fields['featurePreparation'] = [];
    if (kind === 'ambiguous') (changed.accepted[1]!.fields['featurePreparation'] as any[]).push(clone((changed.accepted[1]!.fields['featurePreparation'] as any[])[2]));
    assert.throws(() => selectTaskSpecification(changed), (error: unknown) => error instanceof EngineError
      && error.code === (kind === 'input' || kind === 'stage' ? 'selected_specification_basis_invalid' : 'selected_specification_unresolved')
      && !!(error.details as any).target && !!(error.details as any).field, kind);
  }
});

/** Reuse the current legal C3/C4/C5→G5 fixture, without importing its test registrations or a historical producer. */
async function sp1CurrentWorks(t: TestContext) {
  const url = new URL('./om-feasibility.test.js', import.meta.url);
  const compiled = readFileSync(url, 'utf8'), end = compiled.indexOf('const heads =');
  assert.ok(end > 0);
  const source = compiled.slice(0, end).replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
    (_match, _quote, path) => 'from ' + JSON.stringify(new URL(path, url).href));
  assert.equal(/\btest\(/.test(source), false);
  const fixture = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { acceptedWorksFixture };').toString('base64'));
  return fixture.acceptedWorksFixture(t);
}

test('SP1b current G5 and compiled v3 plan deliver the same full material and later stages cannot replace its exact sources', async t => {
  const f = await sp1CurrentWorks(t);
  const { ProductEngine } = await import('../src/product/engine.js');
  const { writeFeasibility } = await import('../src/om/feasibility.js');
  const { writeHandoff } = await import('../src/om/handoff.js');
  const { readNeighbors } = await import('../src/om/neighbors.js');
  const { loadTaskContextSources } = await import('../src/compiler/context.js');
  const engine = new ProductEngine(f.store), m8 = ok(writeFeasibility(f.store, f.feasibility));
  ok(writeHandoff(f.store, { project: f.project, feasibility: reference(m8), expected: 0 }));
  const plan = engine.compiler.compile(f.project);
  assert.equal(plan.value.taskContextContract, BASIS_TASK_CONTEXT_CONTRACT);
  assert.equal(plan.value.derivation, 'external-inputs/v1');
  assert.equal(f.gate.value.request.taskContextContract, BASIS_TASK_CONTEXT_CONTRACT);
  assert.deepEqual(engine.compiler.compile(f.project), plan);
  const sources = loadTaskContextSources(f.store, plan)!;
  const task = plan.value.tasks[0]!, neighbors = ok(readNeighbors(f.store, { project: f.project, neighbors: f.gate.value.request.neighbors }));
  const actual = engine.compiler.context(f.project, reference(plan), task.id, 1_000_000);
  const selected = JSON.parse(actual.text).selectedSpecification;
  assert.equal(JSON.parse(actual.text).version, BASIS_TASK_CONTEXT_CONTRACT);
  assert.equal(selected.contract, 'selected-specification/v2');
  assert.ok(selected.contracts.length > 0); assert.ok(selected.preparations.length > 0);
  const preplan = preplanTaskContext({ project: f.project, graph: plan.value.graphSnapshot, task,
    fullCheck: f.environment.value.fullCheck, basis: { candidate: f.gate.value.request.candidate, environment: plan.value.environment },
    neighbors: neighbors as Revision<NeighborCollection>, taskContextContract: BASIS_TASK_CONTEXT_CONTRACT, specification: selected }, 1_000_000);
  assert.equal(JSON.parse(preplan.text).version, 'omg-task-context/preplan-v3');
  assert.deepEqual(JSON.parse(preplan.text).selectedSpecification, selected);
  assert.deepEqual(sources.specification!.tasks[task.id], selected);
  const raw = f.store.get(selected.contracts[0].source.id, selected.contracts[0].source.revision)!;
  assert.deepEqual(selected.contracts[0].value, raw.value.content.fields.behaviorContracts[selected.contracts[0].index]);
  assert.ok(sources.references.some(item => canonical(item) === canonical(selected.contracts[0].source)));
  assert.ok(sources.references.some(item => canonical(item) === canonical(selected.contracts[0].effective.source)));
  assert.equal(selected.contracts[0].effective.source.id, `om-input:${f.project}`);
  const beforeTask = canonical(task), oldStage = f.store.get(selected.constraints.source.id)!;
  const changed = clone(oldStage.value.content); changed.fields.constraints = ['A later stage is not this plan material'];
  engine.pipeline.draft(f.project, 'specification', changed, oldStage.revision);
  f.restart(); const restarted = new ProductEngine(f.store);
  assert.deepEqual(taskContext(plan, f.environment.value.fullCheck, task.id, 1_000_000,
    loadTaskContextSources(f.store, plan)), actual);
  assert.throws(() => restarted.compiler.context(f.project, reference(plan), task.id, 1_000_000), { code: 'plan_stale' });
  assert.deepEqual(restarted.compiler.read(plan.id), plan);
  assert.equal(canonical(restarted.compiler.read(plan.id).value.tasks[0]), beforeTask);
  assert.throws(() => restarted.compiler.compile(f.project), EngineError);
});


for (const changedBasis of ['discovery', 'concept', 'specification', 'environment'] as const)
test(`SP1b compile guards ${changedBasis} changed by another Store before publishing the v2 plan`, async t => {
  const f = await sp1CurrentWorks(t);
  const { Store } = await import('../src/storage/store.js');
  const { ProductEngine } = await import('../src/product/engine.js');
  const { writeFeasibility } = await import('../src/om/feasibility.js');
  const { writeHandoff } = await import('../src/om/handoff.js');
  const engine = new ProductEngine(f.store), m8 = ok(writeFeasibility(f.store, f.feasibility));
  ok(writeHandoff(f.store, { project: f.project, feasibility: reference(m8), expected: 0 }));
  const otherStore = new Store(f.database), other = new ProductEngine(otherStore); t.after(() => otherStore.close());
  const write = f.store.writeMany.bind(f.store); let shifted = false;
  f.store.writeMany = ((writes: import('../src/storage/store.js').Write[], guards = []) => {
    if (!shifted && writes.some(row => row.kind === 'plan')) {
      shifted = true;
      if (changedBasis !== 'environment') {
        const stage = otherStore.get<StageArtifact>(`stage:${f.project}:${changedBasis}`)!;
        other.pipeline.draft(f.project, changedBasis, stage.value.content, stage.revision);
      } else {
        const environment = other.environments.get(f.project), { projectId: _project, ...value } = environment.value;
        other.environments.configure(f.project, { ...value, requestCapacityChars: 250_000 }, environment.revision);
      }
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  assert.throws(() => engine.compiler.compile(f.project), { code: 'input_stale' });
  f.store.writeMany = write;
  assert.ok(shifted); assert.equal(f.store.list('plan').length, 0); assert.equal(f.store.get(`current-plan:${f.project}`), null);
});


test('SP1b exact plan repeat guards the current stage before returning an existing plan', async t => {
  const f = await sp1CurrentWorks(t);
  const { Store } = await import('../src/storage/store.js');
  const { ProductEngine } = await import('../src/product/engine.js');
  const { writeFeasibility } = await import('../src/om/feasibility.js');
  const { writeHandoff } = await import('../src/om/handoff.js');
  const engine = new ProductEngine(f.store), m8 = ok(writeFeasibility(f.store, f.feasibility));
  ok(writeHandoff(f.store, { project: f.project, feasibility: reference(m8), expected: 0 }));
  const plan = engine.compiler.compile(f.project);
  const otherStore = new Store(f.database), other = new ProductEngine(otherStore); t.after(() => otherStore.close());
  const get = f.store.get.bind(f.store); let shifted = false;
  f.store.get = ((id: string, revision?: number) => {
    const result = get(id, revision);
    if (!shifted && id === plan.id && revision === undefined) {
      shifted = true;
      const stage = otherStore.get<StageArtifact>(`stage:${f.project}:features`)!;
      other.pipeline.draft(f.project, 'features', stage.value.content, stage.revision);
    }
    return result;
  }) as typeof f.store.get;
  assert.throws(() => engine.compiler.compile(f.project), { code: 'plan_stale' });
  f.store.get = get;
  assert.ok(shifted); assert.equal(f.store.list('plan').length, 1); assert.deepEqual(f.store.get(plan.id), plan);
});


// These are pure accepted-field projections, not hand-written Store records or a substitute v6 producer.
function ds12Selection(): TaskSpecificationSelection {
  const request = sp1Selection(), discovery = ref(`stage:${project}:discovery`), concept = ref(`stage:${project}:concept`);
  const basis = (index: number) => ({ record: discovery, pointer: `/content/fields/preparation/constraints/${index}` });
  const variant = { record: discovery, pointer: '/content/fields/verdict/variant' };
  const report = ref(`research-answer:${project}:report`);
  const application = (address: typeof variant, pointer: string) => ({ contract: 'basis-application/v1', basis: { record: { ...address.record }, pointer: address.pointer }, appliedAt: [pointer] });
  request.contract = 'selected-specification/v2'; request.requirements = ['R'];
  request.input.sources.forEach(source => { source.contractVersion = 6; });
  request.input.sources.push({ ...discovery, stage: 'discovery', contractVersion: 6 }, { ...concept, stage: 'concept', contractVersion: 6 });
  request.accepted.push({ stage: 'discovery', ref: discovery, fields: {
    preparation: { constraints: [
      { id: 'no-export', rule: 'The selected vendor session stays local; do not export its credentials.', basis: canonical({ report, pointer: '/constraints/0' }) },
      { id: 'no-extra-rights', rule: 'A separate maintenance task does not widen this task.', basis: 'owner requirement' },
    ] }, researchReport: { constraints: ['The selected vendor session stays local; do not export its credentials.'] },
    verdict: { outcome: 'go', variant: 'one vendor with separate API credentials', researchReport: { ...report } },
  } }, { stage: 'concept', ref: concept, fields: { conceptSections: [{ id: 'section', requirements: ['R', 'F', 'elsewhere'].map((id, index) => ({
    id, statement: `statement ${id}`, benefit: 'bounded behavior', acceptance: ['no credential export'],
    applications: [application(basis(index === 0 ? 0 : 1), `/0/requirements/${index}/statement`), application(variant, `/0/requirements/${index}/acceptance/0`)],
  })) }] } });
  const specification = request.accepted.find(row => row.stage === 'specification')!;
  (specification.fields['behaviorContracts'] as any[]).forEach((row, index) => {
    row.applications = [application(basis(row.id === 'unrelated' ? 1 : 0), `/${index}/entry`)];
  });
  const features = request.accepted.find(row => row.stage === 'features')!;
  (features.fields['featurePreparation'] as any[]).forEach((row, index) => {
    row.requirements = index === 0 ? ['F'] : index === 1 ? ['elsewhere'] : ['R'];
    row.behaviorContracts = index === 2 ? ['required'] : ['unrelated'];
  });
  return request;
}

test('DS1.2m v2 resolves selected bases and carries the complete project catalogue without expanding the task', () => {
  const request = ds12Selection(), original = canonical(request), selected = selectTaskSpecification(request);
  assert.equal(selected.contract, 'selected-specification/v2'); if (selected.contract !== 'selected-specification/v2') return;
  assert.deepEqual(selected.contracts.map(row => (row.value as any).id), ['required']);
  assert.deepEqual(selected.bases.catalogue.constraints.map(row => (row.value as any).id), ['no-export', 'no-extra-rights']);
  assert.equal(selected.bases.catalogue.variant.value, 'one vendor with separate API credentials');
  assert.deepEqual(selected.bases.selected[0]!.bases, [selected.bases.catalogue.constraints[0]]);
  assert.deepEqual(selected.bases.selected[1]!.bases.map(row => row.address),
    [selected.bases.catalogue.constraints[0]!.address, selected.bases.catalogue.variant.address]);
  assert.equal(selected.bases.selected.some(row => row.bases.some(entry => (entry.value as any)?.id === 'no-extra-rights')), false,
    'Global catalogue context does not assign every constraint to every selected task');
  assert.equal(canonical(request), original);
  (selected.bases.catalogue.constraints[0]!.value as any).rule = 'caller edit';
  const again = selectTaskSpecification(request); assert.equal(again.contract, 'selected-specification/v2');
  if (again.contract === 'selected-specification/v2') assert.notEqual((again.bases.catalogue.constraints[0]!.value as any).rule, 'caller edit');
});

test('DS1.2m selection era is explicit for all catalogue/application producers; mixed sources retain the old contract', () => {
  const request = ds12Selection(); assert.equal(hasBasisApplications(request.input.sources), true);
  for (const stage of ['discovery', 'concept', 'specification']) {
    for (const version of [null, 4, 5]) {
      const sources = clone(request.input.sources); sources.find(row => row.stage === stage)!.contractVersion = version;
      assert.equal(hasBasisApplications(sources), false, `${stage} ${version}`);
    }
  }
  const sources = clone(request.input.sources); sources.find(row => row.stage === 'features')!.contractVersion = 5;
  assert.equal(hasBasisApplications(sources), true, 'Features inherit the selected applications, not a second author-written list');
  request.contract = 'selected-specification/v1'; const old = selectTaskSpecification(request);
  assert.equal(old.contract, 'selected-specification/v1'); assert.equal(Object.hasOwn(old, 'bases'), false,
    'A saved old selection is not expanded by fields present in the source');
});

for (const defect of ['missing-variant', 'missing-constraints', 'missing-applications', 'foreign-basis', 'missing-source', 'mixed-era'] as const)
test(`DS1.2m declared v2 refuses ${defect} with an address instead of dropping mandatory material`, () => {
  const request = ds12Selection(), discovery = request.accepted.find(row => row.stage === 'discovery')!;
  const contracts = request.accepted.find(row => row.stage === 'specification')!.fields['behaviorContracts'] as any[];
  if (defect === 'missing-variant') delete (discovery.fields['verdict'] as any).variant;
  if (defect === 'missing-constraints') delete (discovery.fields['preparation'] as any).constraints;
  if (defect === 'missing-applications') delete contracts[1].applications;
  if (defect === 'foreign-basis') contracts[1].applications[0].basis.record = ref('stage:another:discovery');
  if (defect === 'missing-source') request.accepted = request.accepted.filter(row => row.stage !== 'discovery');
  if (defect === 'mixed-era') request.input.sources.find(row => row.stage === 'concept')!.contractVersion = 5;
  assert.throws(() => selectTaskSpecification(request), (error: unknown) => error instanceof EngineError
    && !!(error.details as any)?.field && !!((error.details as any)?.target || (error.details as any)?.pointer));
});

function ds12ContextFixture() {
  const f = sp1ContextFixture(), specification = selectTaskSpecification(ds12Selection());
  f.saved.value.taskContextContract = BASIS_TASK_CONTEXT_CONTRACT;
  f.saved.hash = hashJson(f.saved.value); f.sources.plan = reference(f.saved);
  f.sources.specification = { ...f.sources.specification!, basis: { ...f.sources.specification!.basis, contract: BASIS_TASK_CONTEXT_CONTRACT },
    tasks: { [f.task.id]: specification } };
  return { ...f, specification, request: { ...f.request, taskContextContract: BASIS_TASK_CONTEXT_CONTRACT, specification } };
}

test('DS1.2m preplan/v3 and task/v3 carry identical bases at the exact capacity boundary without new authority', () => {
  const f = ds12ContextFixture(), pre = preplanTaskContext(f.request, 1_000_000);
  const actual = taskContext(f.saved, FULL_CHECK, f.task.id, 1_000_000, f.sources);
  const before = canonical(f.task), payload = JSON.parse(pre.text), task = JSON.parse(actual.text);
  assert.equal(payload.version, 'omg-task-context/preplan-v3'); assert.equal(task.version, BASIS_TASK_CONTEXT_CONTRACT);
  assert.deepEqual(payload.selectedSpecification, f.specification); assert.deepEqual(task.selectedSpecification, f.specification);
  for (const result of [payload, task]) {
    assert.deepEqual(result.scope.writePaths, f.task.writePaths);
    assert.deepEqual(result.deliveryOwnership, JSON.parse(preplanTaskContext(fixture().request, 1_000_000).text).deliveryOwnership);
  }
  assert.equal(canonical(f.task), before);
  assert.deepEqual(preplanTaskContext(f.request, pre.chars), pre);
  assert.deepEqual(taskContext(f.saved, FULL_CHECK, f.task.id, actual.chars, f.sources), actual);
  assert.throws(() => preplanTaskContext(f.request, pre.chars - 1), (error: unknown) => error instanceof EngineError
    && error.code === 'context_budget_exceeded' && (error.details as any).requiredChars === pre.chars
    && (error.details as any).sources.some((source: Ref) => source.id === `stage:${project}:discovery`));
  assert.throws(() => taskContext(f.saved, FULL_CHECK, f.task.id, actual.chars - 1, f.sources), (error: unknown) => error instanceof EngineError
    && error.code === 'context_budget_exceeded' && (error.details as any).requiredChars === actual.chars);
});

test('DS1.2m v3 refuses omitted basis material and a v1 selection while saved v2 still has its exact old shape', () => {
  const f = ds12ContextFixture(), missing = clone(f.request) as any;
  delete missing.specification.bases; sourceError(() => preplanTaskContext(missing, 1_000_000), 'selectedSpecification.bases');
  const old = sp1ContextFixture();
  sourceError(() => preplanTaskContext({ ...f.request, specification: old.specification }, 1_000_000), 'selectedSpecification');
  assert.equal(JSON.parse(preplanTaskContext(old.request, 1_000_000).text).version, 'omg-task-context/preplan-v2');
  assert.equal(Object.hasOwn(JSON.parse(taskContext(old.saved, FULL_CHECK, old.task.id, 1_000_000, old.sources).text).selectedSpecification, 'bases'), false);
});
