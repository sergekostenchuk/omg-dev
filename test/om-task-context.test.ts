import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, digest, hashJson } from '../src/canonical.js';
import { preplanTaskContext, taskContext, taskContextContent, type ContextText } from '../src/compiler/context.js';
import { deriveTasks } from '../src/compiler/derive.js';
import type { CompiledTask, MachinePlan } from '../src/compiler/model.js';
import { EngineError } from '../src/errors.js';
import { LEVEL, type Command, type Graph, type Node } from '../src/graph/model.js';
import { RefinementRelations } from '../src/graph/relations.js';
import type { BoundTaskObligation } from '../src/graph/task-obligation-model.js';
import { frameObligations, type FrameObligation } from '../src/om/frame-obligations.js';
import { buildPackets, NEIGHBOR_CONTRACT, type NeighborCollection, type NeighborSources } from '../src/om/neighbors.js';
import type { OmResult } from '../src/om/refusal.js';
import { writerIndexId } from '../src/ownership/writer-index.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import type { Revision } from '../src/storage/store.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';

const project = 'context', producer = `${project}-produce-work`, consumer = `${project}-consume-work`;
const FULL_CHECK: Command = { executable: 'npm', args: ['run', 'check:backend', '--', 'результат'] };
const ref = (id: string): Ref => ({ id, revision: 1, hash: hashJson(id) });
const clone = structuredClone;
const node = (graph: Graph, id: string): Node => graph.nodes.find(item => item.id === id)!;
type PreplanRequest = Parameters<typeof preplanTaskContext>[0];
function ok<T>(value: OmResult<T>): T {
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

function legacyContexts(t: TestContext, entries: { plan: Revision<MachinePlan>; fullCheck: Command; task: string }[]): ContextText[] {
  const root = mkdtempSync(join(tmpdir(), 'omg-v2-context-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url)), repositoryUrl = pathToFileURL(repository).href;
  const loader = join(root, 'legacy-source-loader.mjs'), typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from ${JSON.stringify(typescript)};
let root;
export function initialize(data) { root = data.root; }
export async function load(url, context, next) {
  const prefix = new URL('dist/src/', root).href;
  if (url.startsWith(prefix) && /\\.js$/.test(url)) {
    const relative = 'src/' + url.slice(prefix.length).replace(/\\.js$/, '.ts');
    const source = execFileSync('git', ['show', 'aa8eb1d4f49c48b1ff3f67234eb1a8e429fa76d8:' + relative],
      { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return next(url, context);
}
`);
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, { data: { root: ${JSON.stringify(repositoryUrl)} } });`;
  const output = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, '--input-type=module', '--eval',
    `import { readFileSync } from 'node:fs'; import { taskContext } from ${JSON.stringify(new URL('dist/src/compiler/context.js', repositoryUrl).href)};
const cases = JSON.parse(readFileSync(0, 'utf8')); process.stdout.write(JSON.stringify(cases.map(c => taskContext(c.plan, c.fullCheck, c.task, 1000000))));`],
  { cwd: repository, encoding: 'utf8', input: JSON.stringify(entries), maxBuffer: 10_000_000 });
  return JSON.parse(output) as ContextText[];
}

test('V2 unchanged legacy bytes and hashes match the complete aa8eb1d source graph in a fresh process', t => {
  const c = fixture(), entries: Parameters<typeof legacyContexts>[1] = [];
  for (const mode of ['absent', 'empty', 'assigned'] as const) {
    const tasks = clone(c.tasks);
    for (const task of tasks) {
      if (mode === 'absent') delete task.researchObligations;
      if (mode === 'empty') task.researchObligations = [];
    }
    const record = plan(clone(c.graph), tasks);
    for (const task of tasks) entries.push({ plan: record, fullCheck: clone(FULL_CHECK), task: task.id });
  }
  const historical = legacyContexts(t, entries);
  assert.equal(historical.length, entries.length);
  for (const [index, entry] of entries.entries())
    assert.deepEqual(taskContext(entry.plan, entry.fullCheck, entry.task, 1_000_000), historical[index], `legacy case ${index}`);
  assert.notEqual(historical[0]!.text, historical[2]!.text, 'Missing and explicit empty D7 remain different legacy payloads');
});
