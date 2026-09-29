import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { isRef, reference, uniqueRefs, type Ref } from '../src/pipeline/contracts.js';
import { readEnvironmentAt, type Environment } from '../src/runtime/environment.js';
import { Store, type Revision, type Write } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { projectGraph } from '../src/graph/project.js';
import type { Graph } from '../src/graph/model.js';
import { configureDispatch, readDispatch, DISPATCH_CODES, DISPATCH_PROTOCOL, type OmDispatch } from '../src/om/dispatch.js';
import { readCapacity } from '../src/om/capacity.js';
import type { OmResult, Refusal } from '../src/om/refusal.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { writeOmInput } from '../src/om/input.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeRoutes } from '../src/om/routes.js';
import { prepareQuestionTasks, writeQuestionPacket } from '../src/om/question-packet.js';
import { openSeries, beginAttempt, type AttemptGoal } from '../src/om/series.js';
import { gapLineKey, gapLineExpectedResult } from '../src/om/gap-lines.js';
import { runModelCall, readModelCall } from '../src/om/model-call.js';
import { writeAssessmentIntent, assessFact, readAssessmentTerminalAt } from '../src/om/assessment.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

const adapterFixture = fileURLToPath(new URL('../../test/om-adapter-fixture.mjs', import.meta.url));
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
const ENVIRONMENT = 'environment:garden';
const ADAPTER = 'adapter:garden:codex-stdio';
const COMMAND = { type: 'configure-om-dispatch', project: 'garden', protocol: DISPATCH_PROTOCOL };

function valueOf<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`Unexpected refusal: ${result.refusal.code}: ${result.refusal.message} ${JSON.stringify(result.refusal.at)}`);
  return result.value;
}

function refusalOf(result: OmResult<unknown>): Refusal {
  if (result.ok) assert.fail('A refusal was expected');
  return result.refusal;
}

const heads = (store: Store): Ref[] => store.list().map(reference);

/** The error a rejected execute hands to the HTTP and CLI handlers: its code and the refusal's address as details. */
function rejects(call: () => unknown, code: string, details?: unknown): void {
  assert.throws(call, error => {
    assert.ok(error instanceof EngineError, `${String(error)} is not an EngineError`);
    assert.equal(error.code, code);
    if (details !== undefined) assert.deepEqual(error.details, details);
    return true;
  });
}

/** A project with its environment set through the command API and an executor that would leave a mark if it ever ran. */
function light(t: TestContext, options: { configured?: boolean; capacity?: number | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'omg-dispatch-')), database = join(root, 'state.sqlite'), project = 'garden';
  const workspace = join(root, 'workspace'), marker = join(root, 'executor-ran'), executor = join(root, 'never-run.mjs');
  mkdirSync(workspace);
  writeFileSync(executor, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  let store = new Store(database), engine = new ProductEngine(store);
  const others: Store[] = [];
  t.after(() => { store.close(); for (const other of others) other.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project, title: project });
  const command = { executable: process.execPath, args: [executor] };
  const environment = (extra: Record<string, unknown> = {}) => ({ workspace,
    implementer: { actor: 'dispatch-implementer', model: 'fixture', effort: 'high', speed: 'fast', command },
    reviewer: { actor: 'dispatch-reviewer', model: 'fixture-reviewer', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, ...extra });
  const configure = (extra: Record<string, unknown> = {}, name = project) => engine.execute({ type: 'configure', project: name,
    expected: store.get(`environment:${name}`)?.revision ?? 0, environment: environment(extra) }) as Revision<Environment>;
  const fixture = {
    root, database, project, environment, configure,
    get store() { return store; }, get engine() { return engine; },
    /** A project of its own in the same store, configured like the first. */
    enroll(name: string, extra: Record<string, unknown> = { requestCapacityChars: 100_000 }) {
      engine.execute({ type: 'create-project', project: name, title: name }); return configure(extra, name);
    },
    other() { const second = new Store(database); others.push(second); return second; },
    reopen() { store.close(); store = new Store(database); engine = new ProductEngine(store); return engine; },
    ran: () => existsSync(marker),
    dispatch: () => engine.execute(COMMAND) as OmDispatch,
  };
  if (options.configured !== false) configure(options.capacity === null ? {} : { requestCapacityChars: options.capacity ?? 100_000 });
  return fixture;
}

test('R1 malformed commands and direct requests are refused before any read or write', t => {
  const f = light(t), before = heads(f.store);
  const bad: unknown[] = [null, 'configure-om-dispatch', [], {}, { type: 'configure-om-dispatch' },
    { type: 'configure-om-dispatch', project: f.project },
    { type: 'configure-om-dispatch', protocol: DISPATCH_PROTOCOL },
    { ...COMMAND, protocol: 'pretend-codex' }, { ...COMMAND, protocol: undefined }, { ...COMMAND, adapter: 'adapter:garden:codex-stdio' },
    { ...COMMAND, project: 'a b' }, { ...COMMAND, project: '' }, { ...COMMAND, project: 'a'.repeat(81) }, { ...COMMAND, project: 7 }];
  for (const command of bad) rejects(() => f.engine.execute(command), 'command_invalid');
  const good = { project: f.project, protocol: DISPATCH_PROTOCOL } as const;
  const direct: [string, () => unknown][] = [
    ['store', () => configureDispatch({} as Store, good)], ['store', () => readDispatch(null as never, { project: f.project })],
    ['request', () => configureDispatch(f.store, null as never)], ['request', () => configureDispatch(f.store, [] as never)],
    ['request', () => configureDispatch(f.store, { ...good, extra: 1 } as never)],
    ['request', () => configureDispatch(f.store, { project: f.project } as never)],
    ['request', () => readDispatch(f.store, undefined as never)], ['request', () => readDispatch(f.store, good as never)],
    ['project', () => configureDispatch(f.store, { ...good, project: '' })], ['project', () => configureDispatch(f.store, { ...good, project: 'a:b' })],
    ['project', () => configureDispatch(f.store, { ...good, project: 'a'.repeat(81) })],
    ['project', () => configureDispatch(f.store, { ...good, project: 7 as never })], ['project', () => readDispatch(f.store, { project: 'a b' })],
    ['protocol', () => configureDispatch(f.store, { ...good, protocol: 'pretend-codex' as never })],
    ['protocol', () => configureDispatch(f.store, { project: f.project, protocol: undefined as never })],
  ];
  for (const [field, call] of direct) rejects(call, 'dispatch_request_invalid', { unit: 'E4.1', target: 'dispatch', field });
  assert.deepEqual(heads(f.store), before);
  assert.equal(f.store.get(ADAPTER), null);
  assert.equal(f.ran(), false);
});

test('R2 configure without capacity keeps its prior outcome and a bad capacity is refused, never rounded or defaulted', t => {
  const f = light(t, { configured: false });
  const plain = f.configure();
  assert.equal(plain.revision, 1);
  assert.equal(Object.hasOwn(plain.value, 'requestCapacityChars'), false);
  // The existing contract of configure is untouched: a repeat with the same expected revision is still a conflict.
  rejects(() => f.engine.execute({ type: 'configure', project: f.project, expected: 0, environment: f.environment() }), 'revision_conflict');
  const before = heads(f.store);
  for (const bad of [0, -5, 1.5, '100000', null, true, [], {}]) rejects(() => f.configure({ requestCapacityChars: bad }), 'command_invalid');
  // The schema counts 2 ** 53 an integer: the saved-environment validator is the one that refuses it.
  rejects(() => f.configure({ requestCapacityChars: 2 ** 53 }), 'environment_invalid',
    { target: ENVIRONMENT, field: 'requestCapacityChars' });
  assert.deepEqual(heads(f.store), before);
  const configured = f.configure({ requestCapacityChars: 123_457 });
  assert.equal(configured.revision, 2);
  assert.equal(configured.value.requestCapacityChars, 123_457);
  const capacity = valueOf(readCapacity(f.store, { project: f.project, environment: reference(configured), current: true }));
  assert.equal(capacity.maxRequestChars, 123_457);
  assert.equal(f.store.get<Environment>(ENVIRONMENT)!.value.requestCapacityChars, 123_457);
});

test('R3 an absent project, environment or capacity keeps its own code and address, and no adapter is written', t => {
  const f = light(t, { configured: false }), before = heads(f.store);
  rejects(() => f.engine.execute({ ...COMMAND, project: 'nowhere' }), 'project_missing');
  const missing = { unit: 'E4.1', target: ENVIRONMENT, field: 'environment' };
  rejects(() => f.engine.execute(COMMAND), 'environment_missing', missing);
  for (const refusal of [refusalOf(configureDispatch(f.store, { project: f.project, protocol: DISPATCH_PROTOCOL })),
    refusalOf(readDispatch(f.store, { project: f.project }))]) {
    assert.equal(refusal.code, 'environment_missing');
    assert.deepEqual(refusal.at, missing);
  }
  assert.deepEqual(heads(f.store), before);
  const noCapacity = f.configure(), afterEnvironment = heads(f.store);
  const capacityAddress = { unit: 'V1', target: ENVIRONMENT, field: 'requestCapacityChars', ref: reference(noCapacity) };
  rejects(() => f.engine.execute(COMMAND), 'capacity_missing', capacityAddress);
  assert.equal(refusalOf(readDispatch(f.store, { project: f.project })).code, 'capacity_missing');
  assert.equal(f.store.get(ADAPTER), null);
  assert.deepEqual(heads(f.store), afterEnvironment);
  // A saved environment the shared reader refuses keeps that reader's code, and is judged before the capacity reader.
  const stored = f.store.write({ id: ENVIRONMENT, kind: 'environment', expected: noCapacity.revision,
    value: { ...noCapacity.value, requestCapacityChars: 0 } });
  const refused = refusalOf(configureDispatch(f.store, { project: f.project, protocol: DISPATCH_PROTOCOL }));
  assert.equal(refused.code, 'environment_invalid');
  assert.deepEqual(refused.at, { unit: 'E4.1', target: ENVIRONMENT, field: 'requestCapacityChars', ref: reference(stored) });
  assert.equal(f.store.get(ADAPTER), null);
});

test('R3 a failure inside the shared environment reader is not mistaken for a refusal and leaves no adapter', t => {
  const f = light(t), before = heads(f.store), get = f.store.get.bind(f.store);
  // Only the exact-revision read of the environment fails, the way a broken storage would.
  f.store.get = ((id: string, revision?: number) => {
    if (id === ENVIRONMENT && revision !== undefined) throw new RangeError('storage failure');
    return get(id, revision);
  }) as Store['get'];
  const calls: (() => unknown)[] = [() => configureDispatch(f.store, { project: f.project, protocol: DISPATCH_PROTOCOL }),
    () => readDispatch(f.store, { project: f.project }), () => f.engine.execute(COMMAND)];
  for (const call of calls) assert.throws(call, error => error instanceof RangeError && error.message === 'storage failure');
  f.store.get = get;
  assert.equal(f.store.get(ADAPTER), null);
  assert.deepEqual(heads(f.store), before);
});

test('R4 a fit environment without an adapter gets exactly one adapter record, and the reader refuses without writing', t => {
  const f = light(t), configured = f.store.get<Environment>(ENVIRONMENT)!, before = heads(f.store);
  const absent = refusalOf(readDispatch(f.store, { project: f.project }));
  assert.equal(absent.code, 'record_missing');
  assert.deepEqual(absent.at, { unit: 'E4.1', target: ADAPTER, field: 'adapter' });
  assert.deepEqual(heads(f.store), before);
  const result = f.dispatch(), saved = f.store.get<{ projectId: string; protocol: string }>(ADAPTER)!;
  assert.deepEqual(heads(f.store).map(ref => ref.id).filter(id => !before.some(known => known.id === id)), [ADAPTER]);
  assert.equal(saved.kind, 'dispatch-adapter');
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.value, { projectId: 'garden', protocol: 'codex-stdio' });
  assert.equal(saved.hash, hashJson(saved.value));
  assert.deepEqual(Object.keys(result).sort(), ['dispatch', 'guards', 'references']);
  assert.deepEqual(Object.keys(result.dispatch).sort(), ['adapter', 'config']);
  for (const ref of [result.dispatch.adapter, result.dispatch.config]) {
    assert.ok(isRef(ref));
    assert.deepEqual(Object.keys(ref).sort(), ['hash', 'id', 'revision']);
  }
  assert.deepEqual(result.dispatch.adapter, reference(saved));
  assert.deepEqual(result.dispatch.config, reference(configured));
  assert.deepEqual(result.guards, uniqueRefs([reference(saved), reference(configured)]));
  assert.deepEqual(result.references, uniqueRefs([reference(saved), reference(configured)]));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.dispatch));
  assert.equal(Reflect.set(result.dispatch, 'config', reference(saved)), false);
  assert.deepEqual(valueOf(readDispatch(f.store, { project: f.project })), result);
  // The setting starts nothing: no executor, no repository (the workspace is not one), and no era evidence.
  assert.equal(f.ran(), false);
  assert.equal(f.store.get(`om-input:${f.project}`), null);
  assert.equal(f.engine.legacyRoute(f.project).om, false);
  assert.doesNotThrow(() => f.engine.projection(f.project));
});

test('R5 an equal saved adapter repeats to the same dispatch with no writes, also after reopening the store', t => {
  const f = light(t), first = f.dispatch(), saved = heads(f.store);
  assert.deepEqual(f.dispatch(), first);
  assert.deepEqual(heads(f.store), saved);
  assert.deepEqual(new ProductEngine(f.store, 'another-operator').execute(COMMAND), first);
  assert.deepEqual(valueOf(configureDispatch(f.store, { project: f.project, protocol: DISPATCH_PROTOCOL })), first);
  assert.deepEqual(heads(f.store), saved);
  const second = f.other();
  assert.deepEqual(valueOf(configureDispatch(second, { project: f.project, protocol: DISPATCH_PROTOCOL })), first);
  assert.deepEqual(heads(second), saved);
  f.reopen();
  assert.deepEqual(f.dispatch(), first);
  assert.deepEqual(valueOf(readDispatch(f.store, { project: f.project })), first);
  assert.deepEqual(heads(f.store), saved);
  assert.equal(f.store.history(ADAPTER).length, 1);
  assert.equal(f.ran(), false);
});

test('R6 a new environment revision gives a new config and the same adapter, and the saved refs stay readable', t => {
  const f = light(t), first = f.dispatch();
  const same = f.configure({ requestCapacityChars: 100_000 }), again = f.dispatch();
  // Equal values do not let the new revision stand for the old reference.
  assert.equal(same.hash, first.dispatch.config.hash);
  assert.equal(again.dispatch.config.revision, first.dispatch.config.revision + 1);
  assert.notDeepEqual(again.dispatch.config, first.dispatch.config);
  assert.deepEqual(again.dispatch.adapter, first.dispatch.adapter);
  assert.deepEqual(again.dispatch.config, reference(same));
  const changed = f.configure({ requestCapacityChars: 250_000 }), latest = f.dispatch();
  assert.notEqual(latest.dispatch.config.hash, first.dispatch.config.hash);
  assert.deepEqual(latest.dispatch.config, reference(changed));
  assert.deepEqual(latest.dispatch.adapter, first.dispatch.adapter);
  assert.equal(f.store.history(ADAPTER).length, 1);
  for (const saved of [first, again]) assert.equal(readEnvironmentAt(f.store, f.project, saved.dispatch.config).value.projectId, f.project);
  assert.equal(valueOf(readCapacity(f.store, { project: f.project, environment: first.dispatch.config, current: false })).maxRequestChars, 100_000);
  assert.equal(valueOf(readCapacity(f.store, { project: f.project, environment: latest.dispatch.config, current: true })).maxRequestChars, 250_000);
});

test('R7 an environment that moves before the adapter write leaves no adapter, and a concurrent equal creation yields one object', t => {
  const f = light(t), request = { project: f.project, protocol: DISPATCH_PROTOCOL } as const, other = f.other();
  const writeMany = f.store.writeMany.bind(f.store);
  let moves = 0;
  // The competing Store moves the environment head between our derivation and our adapter write, twice.
  f.store.writeMany = ((writes, guards) => {
    if (moves < 2 && writes.some(write => write.kind === 'dispatch-adapter')) {
      const head = other.get<Environment>(ENVIRONMENT)!;
      moves += 1;
      other.write({ id: head.id, kind: head.kind, expected: head.revision, value: head.value });
    }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  const original = reference(f.store.get(ENVIRONMENT)!);
  rejects(() => f.engine.execute(COMMAND), 'input_stale', { unit: 'E4.1', target: ENVIRONMENT, ref: original });
  const stale = refusalOf(configureDispatch(f.store, request));
  assert.equal(stale.code, 'input_stale');
  assert.equal(stale.at.target, ENVIRONMENT);
  assert.equal(moves, 2);
  assert.equal(f.store.get(ADAPTER), null);
  f.store.writeMany = writeMany;
  const settled = valueOf(configureDispatch(f.store, request));
  assert.equal(settled.dispatch.config.revision, 3);
  assert.equal(f.store.history(ADAPTER).length, 1);

  // Another Store creates the same adapter first: the loser reads it back after a fresh capture and returns the one object.
  const racer = light(t), contender = racer.other(), raceWrite = racer.store.writeMany.bind(racer.store);
  let raced = 0, winner: unknown = null;
  racer.store.writeMany = ((writes, guards) => {
    if (!raced && writes.some(write => write.kind === 'dispatch-adapter')) {
      raced += 1;
      winner = valueOf(configureDispatch(contender, request));
    }
    return raceWrite(writes, guards);
  }) as Store['writeMany'];
  const loser = racer.dispatch();
  racer.store.writeMany = raceWrite;
  assert.equal(raced, 1);
  assert.deepEqual(loser, winner);
  assert.equal(racer.store.history(ADAPTER).length, 1);
  assert.deepEqual(loser.dispatch.adapter, reference(racer.store.get(ADAPTER)!));
  assert.deepEqual(loser.guards, uniqueRefs([loser.dispatch.adapter, loser.dispatch.config]));
  assert.deepEqual(racer.dispatch(), loser);
  assert.equal(racer.store.history(ADAPTER).length, 1);
});

test('R8 a genuine adapter-lineage or another project\'s adapter is never taken for the project\'s dispatch adapter', t => {
  const f = light(t), old = join(f.root, 'old', 'codex-stdio.js');
  f.store.write({ id: 'lineage-sample', kind: 'model-call', expected: 0,
    value: { projectId: f.project, requested: { command: { executable: process.execPath, args: [old] } } } as Json });
  const lineage = f.engine.execute({ type: 'declare-adapter-lineage', project: f.project, path: old, sha256: digest('lineage bytes'),
    basis: ['Fixture relocation evidence'] }) as Revision;
  assert.equal(lineage.kind, 'adapter-lineage');
  f.enroll('orchard');
  const orchard = f.engine.execute({ ...COMMAND, project: 'orchard' }) as OmDispatch;
  assert.equal(orchard.dispatch.adapter.id, 'adapter:orchard:codex-stdio');
  const before = heads(f.store);
  assert.equal(refusalOf(readDispatch(f.store, { project: f.project })).code, 'record_missing');
  const mine = f.dispatch();
  assert.equal(mine.dispatch.adapter.id, ADAPTER);
  assert.deepEqual(heads(f.store).filter(ref => !before.some(known => known.id === ref.id)).map(ref => ref.id), [ADAPTER]);
  for (const kept of [reference(lineage), orchard.dispatch.adapter]) assert.deepEqual(reference(f.store.get(kept.id)!), kept);
  // The two smallest cases of the canonical address holding something else; not a forgery matrix.
  f.enroll('garden2'); f.enroll('garden3');
  const foreignKind = f.store.write({ id: 'adapter:garden2:codex-stdio', kind: 'adapter-lineage', expected: 0,
    value: { projectId: 'garden2', protocol: 'codex-stdio' } });
  const foreignBody = f.store.write({ id: 'adapter:garden3:codex-stdio', kind: 'dispatch-adapter', expected: 0,
    value: { projectId: 'orchard', protocol: 'codex-stdio' } });
  const settled = heads(f.store);
  const kind = refusalOf(configureDispatch(f.store, { project: 'garden2', protocol: DISPATCH_PROTOCOL }));
  assert.equal(kind.code, 'record_foreign');
  assert.deepEqual(kind.at, { unit: 'E4.1', target: foreignKind.id, field: 'kind', ref: reference(foreignKind) });
  const body = refusalOf(configureDispatch(f.store, { project: 'garden3', protocol: DISPATCH_PROTOCOL }));
  assert.equal(body.code, 'dispatch_adapter_invalid');
  assert.deepEqual(body.at, { unit: 'E4.1', target: foreignBody.id, field: 'projectId', ref: reference(foreignBody) });
  rejects(() => f.engine.execute({ ...COMMAND, project: 'garden3' }), 'dispatch_adapter_invalid', body.at);
  assert.equal(refusalOf(readDispatch(f.store, { project: 'garden3' })).code, 'dispatch_adapter_invalid');
  assert.deepEqual(heads(f.store), settled);
});

test('R1 R3 R8 the catalog names exactly the codes this unit emits, and each has its own path', t => {
  const f = light(t, { configured: false }), seen = new Set<string>();
  try { configureDispatch(f.store, { project: 'a b', protocol: DISPATCH_PROTOCOL }); } catch (error) { seen.add((error as EngineError).code); }
  seen.add(refusalOf(readDispatch(f.store, { project: f.project })).code);
  f.enroll('garden3');
  f.store.write({ id: 'adapter:garden3:codex-stdio', kind: 'dispatch-adapter', expected: 0, value: { projectId: 'orchard', protocol: 'codex-stdio' } });
  seen.add(refusalOf(readDispatch(f.store, { project: 'garden3' })).code);
  assert.deepEqual([...seen].sort(), [...DISPATCH_CODES].sort());
});

function chain(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-dispatch-chain-')), path = join(root, 'state.sqlite'), project = 'garden';
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let engine = new ProductEngine(store);
  const desired = gardenGraph('cross');
  desired.nodes.find(node => node.id === 'garden-produce-block')!.ports.push({ id: 'out-side', direction: 'out', contract: 'garden-contract' });
  desired.nodes.find(node => node.id === 'garden-consume-block')!.ports.push({ id: 'in-side', direction: 'in', contract: 'garden-contract' });
  desired.connectors.push({ id: 'garden-side-flow', artifact: 'garden-data', returnsTo: 'garden-produce-block', wakeTest: null,
    bindings: [{ level: 1, producer: { node: 'garden-produce-block', port: 'out-side' },
      consumers: [{ node: 'garden-consume-block', port: 'in-side' }], anchor: null }] });
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'encoding', question: 'What encoding is supported?',
      consumer: 'garden-consume-block', moment: 'om-pass', blocksCurrentStage: false, resolution: 'Resolve the addressed question during OM' }];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = valueOf(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = valueOf(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: [{ pending: structuredClone(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: 'discovery:encoding', field: 'address', value: { consumer: 'garden-consume-block', kind: 'repository-fact' } } })) as Write }] }));
  const horizon = valueOf(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null,
    available: {}, choice: { choiceVersion: 'dispatch-chain', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = valueOf(writeGaps(store, sources)), gapRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = valueOf(prepareQuestionTasks(store, { project, gaps: gapRequest,
    questions: gaps.records.filter(row => row.value.gap.kind === 'repository-fact' && row.value.gap.code !== 'inventory_missing'
      && !row.value.gap.deferral).map(gap => ({ gap: reference(gap), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) }));
  const routes = valueOf(writeRoutes(store, { project, gaps: gapRequest,
    tasks: tasks.tasks.map(task => ({ pending: structuredClone(task.writes[0]!) as Write })),
    catalog: { paths: ['dispatch-source.txt'], records: [] }, previous: null }));
  const batch = routes.value.batches.find(item => item.model === 'MC1' && item.items.some(question => question.target === 'discovery:encoding'))!;
  assert.ok(batch);
  writeFileSync(join(root, 'dispatch-source.txt'), 'UTF-8 is the supported encoding.');
  const source = store.get<{ content: string }>(`source:${project}:brief`)!, block = 'garden-consume-block';
  const goal: AttemptGoal = { key: 'dispatch:fact', questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  valueOf(openSeries(store, { project, block, line: 1, slice: 'dispatch-fact', predecessor: null, basis: null }));
  const series = valueOf(beginAttempt(store, { project, block, line: 1, attempt: 1, goal }));
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [adapterFixture, '--scenario', scenario, '--trace', trace] };
  const settings = (extra: Record<string, unknown> = {}) => ({ workspace: root,
    implementer: { actor: 'dispatch-implementer', model: 'fixture', effort: 'high', speed: 'fast', command },
    reviewer: { actor: 'dispatch-reviewer', model: 'fixture-reviewer', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: 100_000, ...extra });
  const configure = (extra: Record<string, unknown> = {}) => engine.execute({ type: 'configure', project,
    expected: store.get(ENVIRONMENT)?.revision ?? 0, environment: settings(extra) }) as Revision<Environment>;
  // The settings under test: the environment, then its adapter, both through the command API.
  const configured = configure(), dispatched = engine.execute(COMMAND) as OmDispatch;
  const packet = valueOf(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id,
    environment: dispatched.dispatch.config, attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  const questionId = batch.items[0]!.gap;
  const originalStep = { research: { protocol: 'omg-answer/v2', requestId: '$requestId', action: 'answer',
    results: batch.items.map(item => ({ questionId: item.gap, value: 'UTF-8', citations: [{ source: reference(source),
      selector: { kind: 'text-range', start: 0, end: source.value.content.length } }] })) }, usage };
  writeFileSync(scenario, JSON.stringify({ steps: [originalStep] }));
  return { root, project, configured, dispatched, packet, questionId, configure,
    get store() { return store; }, get engine() { return engine; },
    request: (dispatch = dispatched.dispatch, role: 'implementer' | 'reviewer' = 'implementer') =>
      ({ project, packet: reference(packet), dispatch, role }),
    assessor() {
      writeFileSync(scenario, JSON.stringify({ steps: [originalStep, { research: { verdict: 'supported', reasons: [] }, usage }] }));
    },
    sent: () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean) : [],
    reopen() { store.close(); store = new Store(path); engine = new ProductEngine(store); return engine; },
  };
}

test('R4 the produced dispatch admits the real E2 packet, the E4 implementer and the E5 reviewer with distinct actors', async t => {
  const f = chain(t), { dispatch } = f.dispatched;
  // B1 exists already: the command was legal after it, and it changed nothing of the era.
  assert.ok(f.store.get(`om-input:${f.project}`));
  assert.equal(f.engine.legacyRoute(f.project).om, true);
  assert.deepEqual(f.engine.execute(COMMAND), f.dispatched);
  assert.deepEqual(dispatch.config, reference(f.configured));
  const environment = f.store.get<Environment>(ENVIRONMENT)!.value;
  assert.notEqual(environment.implementer.actor, environment.reviewer.actor);
  const model = valueOf(await runModelCall(f.store, f.request()));
  assert.equal(model.outcome?.kind, 'fact-candidates');
  assert.equal(model.record.value.status, 'succeeded');
  assert.deepEqual(model.record.value.usage, usage);
  const assessment = { project: f.project, modelCall: reference(model.record), questionId: f.questionId, dispatch };
  f.assessor();
  const intent = valueOf(writeAssessmentIntent(f.store, assessment));
  assert.deepEqual(intent.value.dispatch, dispatch);
  assert.equal(intent.value.originalActor, environment.implementer.actor);
  assert.ok(dispatch.adapter.id.startsWith(`adapter:${f.project}:`));
  const terminal = valueOf(await assessFact(f.store, assessment));
  assert.equal(terminal.value.verdict, 'supported');
  // One send for the implementer and one for the reviewer; the setting itself sent nothing.
  assert.equal(f.sent().length, 2);
  assert.equal(f.store.history(ADAPTER).length, 1);
});

test('R9 a saved call and assessment keep their exact refs after configure, and the reader hands the new pair to new work', async t => {
  const f = chain(t), { dispatch } = f.dispatched;
  const request = f.request();
  const model = valueOf(await runModelCall(f.store, request));
  const historical = valueOf(readModelCall(f.store, { project: f.project, record: reference(model.record) }));
  const assessment = { project: f.project, modelCall: reference(model.record), questionId: f.questionId, dispatch };
  f.assessor();
  const terminal = valueOf(await assessFact(f.store, assessment));
  const sent = f.sent().length, kept = heads(f.store);
  const later = f.configure();
  assert.equal(later.revision, f.configured.revision + 1);
  f.reopen();
  assert.deepEqual(valueOf(await runModelCall(f.store, request)), historical);
  assert.deepEqual(valueOf(readAssessmentTerminalAt(f.store, f.project, reference(terminal))), terminal);
  assert.equal(f.sent().length, sent);
  for (const ref of kept.filter(ref => ref.id !== ENVIRONMENT)) assert.deepEqual(reference(f.store.get(ref.id)!), ref);
  const fresh = valueOf(readDispatch(f.store, { project: f.project }));
  assert.deepEqual(fresh.dispatch.config, reference(later));
  assert.deepEqual(fresh.dispatch.adapter, dispatch.adapter);
  assert.deepEqual(f.engine.execute(COMMAND), fresh);
  assert.equal(f.store.history(ADAPTER).length, 1);
});

test('R9 C23 an old E2 packet with the config of a later environment revision is refused before any send', async t => {
  const f = chain(t);
  f.configure();
  const fresh = valueOf(readDispatch(f.store, { project: f.project }));
  assert.equal(fresh.dispatch.config.revision, f.dispatched.dispatch.config.revision + 1);
  const refusal = refusalOf(await runModelCall(f.store, f.request(fresh.dispatch)));
  assert.equal(refusal.code, 'dispatch_contract_invalid');
  assert.equal(f.sent().length, 0);
  assert.equal(f.store.list('call-record').length, 0);
  assert.equal(f.store.list('model-call').length, 0);
  assert.equal(f.store.history(ADAPTER).length, 1);
});
