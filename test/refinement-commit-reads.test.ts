import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, observeStore, storeReads, type Revision } from '../src/storage/store.js';
import { storeView, provenStore } from '../src/storage/store-view.js';
import { ProductEngine } from '../src/product/engine.js';
import { PHASES, withRefinementRead } from '../src/graph/refinement.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { git, type Environment } from '../src/runtime/environment.js';
import type { Graph } from '../src/graph/model.js';
import type { Source } from '../src/evidence/evidence.js';
import { exampleGraph } from './graph-fixture.js';
import { preparedFeatures, refinedLayers } from './product-fixture.js';
import { answerTechnicalFixture } from './technical-research-fixture.js';
import { deriveLayerFixture } from './layer-design-fixture.js';

const phases = PHASES.filter(p => p !== 'R3');
function fixture(t: TestContext, graph = exampleGraph('p'), complete = true) {
  const directory = mkdtempSync(join(tmpdir(), 'omg-g6-')), workspace = join(directory, 'repo'); mkdirSync(workspace);
  const file = join(workspace, 'README.md'); writeFileSync(file, 'A new local stateless CLI transformation product.\n');
  git(workspace, ['init', '-b', 'main']); git(workspace, ['add', 'README.md']);
  git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial']);
  let store = new Store(join(directory, 'state.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  preparedFeatures(engine, 'p', graph);
  const command = { executable: process.execPath, args: ['--version'] };
  engine.environments.configure('p', { workspace, implementer: { actor: 'worker', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 1000 }, 0);
  if (complete) refinedLayers(engine, 'p');
  return { get store() { return store; }, get engine() { return engine; }, directory, workspace, file,
    reopen() { store.close(); store = new Store(join(directory, 'state.sqlite')); engine = new ProductEngine(store); } };
}
function reads<T>(run: () => T) { const before = storeReads(), value = run(); return { value, count: storeReads() - before }; }
test('G6 a current projection skips refinement phases without writes; the next projection retains its read bound', t => {
  const f = fixture(t); f.reopen();
  const gate = t.mock.method(Object.getPrototypeOf(f.engine.refinement), 'gate', () => {
    throw new Error('The current projection must not read Refinement phase gates');
  });
  t.mock.method(Store.prototype, 'writeMany', () => { throw new Error('projection scope must not write'); });
  const first = reads(() => f.engine.projection('p'));
  assert.equal(Object.hasOwn(first.value, 'phases'), false);
  assert.equal(gate.mock.callCount(), 0);
  t.diagnostic(`projection Store reads=${first.count}`);
  assert.ok(first.count <= 2400, `projection budget: ${first.count}`);
  const second = reads(() => f.engine.projection('p'));
  assert.equal(Object.hasOwn(second.value, 'phases'), false);
  assert.equal(gate.mock.callCount(), 0);
  assert.deepEqual(second.value, first.value);
  assert.equal(second.count, first.count);
});

test('G6 the cold multi-phase read has a numeric bound independent of ten times unrelated history', t => {
  const f = fixture(t); f.reopen();
  const run = () => withRefinementRead(() => [...phases].reverse().map(phase => f.engine.refinement.gate('p', phase)));
  const first = reads(run);
  t.diagnostic(`six phases Store reads=${first.count}`);
  assert.ok(first.count <= 150, `six-phase budget: ${first.count}`);
  const history = f.store.identities('list').length;
  for (let i = 0; i < history * 10; i++) f.store.write({ id: 'noise:unrelated', kind: 'noise', expected: i, value: { i } });
  f.reopen();
  const after = reads(run); assert.deepEqual(after.value, first.value); assert.equal(after.count, first.count);
  const isolated = reads(() => [...phases].reverse().map(phase => f.engine.refinement.gate('p', phase)));
  assert.deepEqual(isolated.value, first.value);
  assert.ok(isolated.count > first.count, 'Independent actions do not reuse a previous gate result');
});

test('G6 exact file sources are checked once per read; change, deletion and an exception cannot retain the result', t => {
  const f = fixture(t), body = readFileSync(f.file, 'utf8');
  const source = f.store.get<Source>('source:p:context')!; const sourceHead = reference(source);
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const original = fs.readFileSync; let files = 0;
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === source.value.origin.location) files++;
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const run = () => withRefinementRead(() => phases.map(phase => f.engine.refinement.gate('p', phase)));
  assert.ok(run().every(result => result.findings.length === 0)); assert.equal(files, 1);
  files = 0;
  assert.throws(() => withRefinementRead(() => { run(); throw new Error('read stopped'); }), /read stopped/);
  assert.equal(files, 1);
  writeFileSync(f.file, body + 'changed'); files = 0;
  assert.ok(run().some(result => result.findings.some(finding => finding.code === 'phase_stale' && finding.target === source.id)));
  assert.equal(files, 1); assert.equal(f.store.headsMatch([sourceHead]).ok, true);
  writeFileSync(f.file, body); assert.ok(run().every(result => result.findings.length === 0));
  unlinkSync(f.file);
  assert.ok(run().some(result => result.findings.some(finding => finding.code === 'phase_stale' && finding.target === source.id)));
});

test('G6 a new exact input revision is stale after restart even when its bytes equal the former revision', t => {
  const f = fixture(t);
  assert.deepEqual(f.engine.refinement.gate('p', 'R2').findings, []);
  const source = f.store.get<Source>('source:p:context')!;
  f.engine.discovery.evidence.file('p', 'context', f.workspace, 'README.md', 'text/plain', source.revision);
  f.reopen();
  const result = f.engine.refinement.gate('p', 'R2');
  assert.ok(result.findings.some(item => item.code === 'phase_stale' && item.target === source.id));
});

test('G6 Store views cannot borrow another view result or hide a missing input behind the physical heads', t => {
  const f = fixture(t), milestone = f.store.get<{inputs: Ref[]}>('phase:p:R0')!;
  const target = milestone.value.inputs[0]!;
  const view = storeView(f.store, { get: id => id === target.id ? null : undefined, write: () => { throw new Error('read only'); } });
  const projected = new ProductEngine(view);
  withRefinementRead(() => {
    const good = f.engine.refinement.gate('p', 'R0'); assert.equal(good.findings.length, 0);
    good.findings.push({ code: 'caller-mutation', target: 'R0', message: 'A consumer owns its result' });
    assert.deepEqual(f.engine.refinement.gate('p', 'R0').findings, [], 'Cached results are detached');
    assert.ok(projected.refinement.gate('p', 'R0').findings.some(finding => finding.code === 'phase_stale' && finding.target === target.id));
    assert.deepEqual(f.engine.refinement.gate('p', 'R0').findings, []);
    // An opaque view is not an immutable stored Source merely because it reports the same Ref.
    const source = f.store.get<Source>('source:p:context')!;
    assert.deepEqual(f.engine.refinement.gate('p', 'R1').findings, []);
    const substituted = new ProductEngine(storeView(f.store, { get: id => id === source.id
      ? { ...source, value: { ...source.value, origin: { ...source.value.origin, location: join(f.directory, 'missing-source') } } } as unknown as Revision
      : undefined, write: () => { throw new Error('read only'); } }));
    assert.ok(substituted.refinement.gate('p', 'R1').findings.some(finding => finding.code === 'phase_stale' && finding.target === source.id));
    const absent = new ProductEngine(storeView(f.store, { get: id => id === milestone.id ? null : undefined, write: () => { throw new Error('read only'); } }));
    assert.equal(absent.refinement.gate('p', 'R0').findings[0]!.code, 'phase_missing');
  });
});

test('G6 active application proofs keep their original get sequence and do not consume a memoized result', t => {
  const f = fixture(t); const seen: string[] = [], token = {};
  withRefinementRead(() => {
    const expected = f.engine.refinement.gate('p', 'R0');
    const previous = observeStore({ begin: () => token, end: (_token, _store, method, _mode, id, revision) => seen.push(`${method}:${id}:${revision}`),
      write: () => { throw new Error('proof must be read only'); }, untraced: () => { throw new Error('unexpected view'); } });
    try {
      assert.equal(JSON.stringify(f.engine.refinement.gate('p', 'R0')), JSON.stringify(expected));
      const first = [...seen]; seen.length = 0;
      assert.ok(first.length > 1 && first.every(read => read.startsWith('get:')));
      assert.deepEqual(f.engine.refinement.gate('p', 'R0'), expected); assert.deepEqual(seen, first);
    } finally { observeStore(previous); }
  });
});

test('G6 R2 rechecks the current horizon after a new read, including an unchanged milestone Ref', t => {
  const graph = exampleGraph('p'); graph.horizon = [];
  graph.anchors.push({ id: 'future-input', owner: 'p-produce-work', outcome: 'p-data', test: graph.tests[0]!.id });
  graph.connectors[0]!.bindings[2]!.anchor = 'future-input'; graph.connectors[0]!.wakeTest = graph.tests[0]!.id;
  const f = fixture(t, graph, false), engine = f.engine;
  const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0); engine.refinement.sealLayer('p', 1, 0);
  const r1 = engine.refinement.begin('p', 'R1');
  const gap = { id: 'future', target: 'p-produce-block', field: 'ports', question: 'Which future input contract is required?', consumer: 'p-consume-block', requiredFor: 'next' as const };
  answerTechnicalFixture(engine, 'p', r1, (field, report) => field === 'integrations' ? { ...report, gaps: [gap] } : report);
  engine.refinement.finishResearch('p', 'R1', reference(f.store.get(r1.id)!), 0);
  deriveLayerFixture(engine, 'p', 2); engine.refinement.sealLayer('p', 2, 0);
  const r2 = engine.refinement.begin('p', 'R2'); answerTechnicalFixture(engine, 'p', r2);
  const milestone = engine.refinement.finishResearch('p', 'R2', reference(f.store.get(r2.id)!), 0);
  assert.deepEqual(withRefinementRead(() => engine.refinement.gate('p', 'R2')).findings, []);
  const current = f.store.get<Graph>('graph:p')!, active = structuredClone(current.value);
  active.horizon = ['p-produce-work', 'p-consume-work']; engine.graphs.save('p', active, current.revision, 'owner');
  f.reopen();
  assert.deepEqual(reference(f.store.get(milestone.id)!), reference(milestone));
  assert.ok(f.engine.refinement.gate('p', 'R2').findings.some(item => item.code === 'research_horizon_changed'));
  assert.throws(() => f.engine.refinement.sealLayer('p', 3, 0), /preceding refinement phase/);
});


test('G6 the phase guards still reject a second Store changing Environment before the R3 write', t => {
  const f = fixture(t), second = new Store(f.store.path), other = new ProductEngine(second);
  t.after(() => second.close());
  const original = Store.prototype.writeMany;
  let moved = false;
  t.mock.method(Store.prototype, 'writeMany', function (this: Store, inputs: Parameters<Store['writeMany']>[0], guards: Parameters<Store['writeMany']>[1]) {
    if (this === f.store && !moved && inputs.some(input => input.kind === 'feasibility')) {
      moved = true;
      const environment = second.get<Environment>('environment:p')!;
      other.environments.configure('p', { ...environment.value, timeoutMs: environment.value.timeoutMs + 1 }, environment.revision);
    }
    return original.call(this, inputs, guards);
  });
  assert.throws(() => f.engine.refinement.assess('p', 0), (error: unknown) => (error as {code?: string}).code === 'input_stale');
  assert.equal(moved, true); assert.equal(f.store.get('feasibility:p'), null);
});


test('G6 a closed R0 checks heads and exact kinds without decoding non-Source input bodies', t => {
  const f = fixture(t), decoded: string[] = [];
  const milestone = f.store.get<{inputs: Ref[]}>('phase:p:R0')!;
  const forbidden = new Set(milestone.value.inputs.filter(ref => f.store.identities('get', ref.id, ref.revision)[0]?.kind !== 'source').map(ref => ref.id));
  const original = Store.prototype.get;
  t.mock.method(Store.prototype, 'get', function (this: Store, id: string, revision?: number) {
    if (forbidden.has(id)) decoded.push(id);
    return original.call(this, id, revision);
  });
  assert.deepEqual(f.engine.refinement.gate('p', 'R0').findings, []);
  assert.deepEqual(decoded, []);
});


test('G6 lawful direct and nested write-only views use the physical heads and exact identities', t => {
  const f = fixture(t);
  const direct = storeView(f.store, { write: (writes, guards) => f.store.writeMany(writes, guards) });
  const nested = storeView(direct, { write: (writes, guards) => direct.writeMany(writes, guards) });
  const engines = [f.engine, new ProductEngine(direct), new ProductEngine(nested)];
  for (const view of [direct, nested]) assert.equal(provenStore(view), f.store);
  const results = withRefinementRead(() => engines.map(engine => phases.map(phase => engine.refinement.gate('p', phase))));
  assert.ok(results[0]!.every(result => result.findings.length === 0));
  assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0]);
  const source = f.store.get<Source>('source:p:context')!;
  writeFileSync(f.file, source.value.content + 'changed');
  const stale = withRefinementRead(() => engines.map(engine => engine.refinement.gate('p', 'R2')));
  assert.ok(stale[0]!.findings.some(finding => finding.target === source.id && finding.code === 'phase_stale'));
  assert.deepEqual(stale[1], stale[0]); assert.deepEqual(stale[2], stale[0]);
});

test('G6 an active proof on the physical Store also disables fast reads and memo for its write-only views', t => {
  const f = fixture(t), token = {};
  const direct = storeView(f.store, { write: (writes, guards) => f.store.writeMany(writes, guards) });
  const nested = storeView(direct, { write: (writes, guards) => direct.writeMany(writes, guards) });
  const engines = [f.engine, new ProductEngine(direct), new ProductEngine(nested)];
  withRefinementRead(() => {
    const expected = engines.map(engine => engine.refinement.gate('p', 'R0'));
    const seen: string[] = [];
    const prior = observeStore({ begin: store => store === f.store ? token : undefined,
      end: (_token, _store, method, _mode, id, revision) => seen.push(`${method}:${id}:${revision}`),
      write: () => { throw new Error('read-only proof'); }, untraced: () => { throw new Error('write-only reads must be traced'); } });
    try {
      const sequences = engines.map((engine, index) => {
        seen.length = 0;
        assert.deepEqual(engine.refinement.gate('p', 'R0'), expected[index]);
        assert.ok(seen.length > 1 && seen.every(read => read.startsWith('get:')));
        return [...seen];
      });
      assert.deepEqual(sequences[1], sequences[0]); assert.deepEqual(sequences[2], sequences[0]);
    } finally { observeStore(prior); }
  });
});
