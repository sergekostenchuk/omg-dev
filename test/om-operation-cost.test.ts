import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Observe the actual compiled producer and proof bodies without changing a production module or the accepted fixture.
const loader = String.raw`
import ts from TYPESCRIPT;
import { execFileSync } from 'node:child_process';
let root, repository, baseline;
export function initialize(data) { root = data.root; repository = data.repository; baseline = data.baseline; }
const bodies = {
  'src/om/layer-basis.js': { verifyHistoricalBasis: ["C5", "request"] },
  'src/om/frame-obligations.js': { frameSources: ["C2.basis", "request"], frameDerive: ["C2.derive", "request"] },
  'src/om/frame-candidate.js': { verifyRecordSources: ["C4", "{ id: row.id, revision: row.revision, hash: row.hash, request: row.value.request }"] },
  'src/om/gap-lines.js': { deriveHistory: ["D2", "{project, ref}"] },
  'src/om/gaps.js': { deriveMaterialized: ["D1", "request", "!current"], deriveGapRecords: ["D1.records", "request"] },
  'src/om/atomic-gate.js': { deriveGate: ["G5", "request", "!current"] },
};
export async function load(url, context, nextLoad) {
  let result;
  if (baseline && url.startsWith(root) && url.endsWith('.js')) {
    const path = decodeURIComponent(url.slice(root.length)).replace(/\.js$/, '.ts');
    const body = execFileSync('git', ['show', baseline + ':' + path], { cwd: repository, encoding: 'utf8', maxBuffer: 10_000_000 });
    result = { format: 'module', shortCircuit: true, source: ts.transpileModule(body,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  } else result = await nextLoad(url, context);
  if (!url.startsWith(root) || result.format !== 'module') return result;
  const file = decodeURIComponent(url.slice(root.length));
  if (baseline && file !== 'test/om-atomic-gate.test.js') return result;
  if (!bodies[file] && !['src/om/input.js', 'test/om-atomic-gate.test.js'].includes(file)) return result;
  let source = String(result.source);
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file === 'test/om-atomic-gate.test.js') {
    const removed = new Set();
    source = tree.statements.filter(statement => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return true;
      const name = statement.expression.expression.getText(tree);
      if (name === 'test' || name === 'after') { removed.add(name); return false; }
      return true;
    }).map(statement => source.slice(statement.pos, statement.end)).join('\n');
    if (!removed.has('test') || !removed.has('after')) throw new Error('The accepted fixture registrations were not identified');
    source += '\nexport { produceAtomicSeed, seedResources };\n';
  } else {
    const edits = [], found = new Set();
    function visit(node) {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const name = node.name.getText(tree), entry = bodies[file]?.[name];
        if (entry) {
          found.add(name);
          const [family, key, condition = 'true'] = entry;
          edits.push({ pos: node.body.getStart(tree) + 1,
            text: '\nif (' + condition + ') globalThis.__operationCost.hit(' + JSON.stringify(family) + ', store, ' + key + ');\n' });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    for (const name of Object.keys(bodies[file] ?? {})) if (!found.has(name)) throw new Error('Uncached proof body missing: ' + file + ':' + name);
    for (const edit of edits.sort((left, right) => right.pos - left.pos)) source = source.slice(0, edit.pos) + edit.text + source.slice(edit.pos);
    if (file === 'src/om/input.js') {
      const miss = 'const result = synchronous(() => action(traced ? historicalTrace(store) : store));';
      if (source.split(miss).length !== 2) throw new Error('The common historical proof action was not identified');
      source = source.replace(miss, 'const costAttempt = globalThis.__operationCost.miss(key, sourceView(store), traced);\n'
        + 'const result = globalThis.__operationCost.action(costAttempt, () => synchronous(() => action(traced ? historicalTrace(store) : store)));');
      const replayable = 'const replayable = !isProxy(source) || [...events.sources].every(observed => observed === source);';
      if (source.split(replayable).length !== 2) throw new Error('The common historical proof replay decision was not identified');
      source = source.replace(replayable, replayable + '\nglobalThis.__operationCost.replayability(costAttempt, replayable);');
      source += '\nglobalThis.__operationCost.sourceView = sourceView;\n';
    }
  }
  return { ...result, source };
}
`;

const baselineScenario = String.raw`
import assert from 'node:assert/strict';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from 'node:module';
const config = CONFIG;
register(config.loader, { data: { root: config.dist, repository: config.repository, baseline: '24a7aff15ef0' } });
const imports = name => import(config.dist + 'src/' + name + '.js');
const { Store } = await imports('storage/store');
const { reference } = await imports('pipeline/contracts');
const { writeWorksAcceptance } = await imports('om/atomic-gate');
const { readAcceptedFrame } = await imports('om/frame-accept');
const { writeGaps, readGaps } = await imports('om/gaps');
const { gapLineKey, prepareGapLines, writeGapLines } = await imports('om/gap-lines');
const { confirmResults } = await imports('om/achievements');
const { produceAtomicSeed, seedResources } = await import(config.dist + 'test/om-atomic-gate.test.js');
function ok(result) { if (!result.ok) assert.fail(result.refusal.code + ': ' + result.refusal.message); return result.value; }
let store, complete = false;
try {
  const seed = await produceAtomicSeed(), f = seed.data, database = join(config.directory, 'accepted-baseline.sqlite');
  copyFileSync(seed.database, database); store = new Store(database);
  const accepted = ok(writeWorksAcceptance(store, f.request)); assert.equal(accepted.state, 'accepted');
  const acceptance = accepted.acceptance, frame = ok(readAcceptedFrame(store, acceptance));
  const previous = store.get(f.lines.id), source = structuredClone(f.gapRead.sources);
  source.graph = acceptance.graph; source.operations.frame.graph = acceptance.graph;
  source.works = { frame: { ...source.works.frame, graph: acceptance.graph, layer: acceptance.layer, frame: acceptance.frame }, proposals: [] };
  const current = ok(writeGaps(store, source)), gaps = { sources: current.sources, records: current.records.map(reference) };
  const gapHistory = ok(readGaps(store, gaps));
  const declared = f.openGoal, goal = declared.goal;
  const targets = f.gaps.records.map(row => row.value.gap).filter(gap => gap.code === 'obligation_open'
    && gap.evidence.some(evidence => evidence.origin === 'works') && goal.questions.includes(gapLineKey(f.project, gap.target, gap.field)));
  assert.equal(targets.length, 4);
  const request = { project: f.project, previous: reference(previous), pass: previous.value.request.pass + 1, gaps,
    closures: targets.map(target => ({ id: target.id, reason: 'filled', basis: acceptance.frame, acceptance,
      attempt: { series: declared.series, attempt: declared.ordinal } })) };
  const prepared = ok(prepareGapLines(store, request)), lines = ok(writeGapLines(store, request));
  const confirmation = { project: f.project, block: declared.block, target: declared.series.id, goal, accepting: [reference(lines)], cancelling: [] };
  const confirmed = ok(confirmResults(store, confirmation));
  store.close();
  writeFileSync(config.checkpoint, JSON.stringify({ seed, database, accepted, frame, current, gapHistory, gaps, request, prepared, lines, confirmation, confirmed }));
  complete = true;
} finally {
  store?.close();
  for (const resource of seedResources) { resource.store.close(); if (!complete) rmSync(resource.root, { recursive: true, force: true }); }
}
`;

const scenario = String.raw`
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { register } from 'node:module';
const config = CONFIG;
let active = null;
let ordinal = 0;
const views = new WeakMap();
const actionStack = [];
const monitor = globalThis.__operationCost = {
  sourceView: store => store,
  hit(family, store, key) {
    if (!active) return;
    const view = this.sourceView(store);
    if (!views.has(view)) views.set(view, ++ordinal);
    const identity = JSON.stringify([family, views.get(view), canonical(key)]);
    active.proofs.set(identity, (active.proofs.get(identity) ?? 0) + 1);
    if (!active.bodyAttempts.has(identity)) active.bodyAttempts.set(identity, []);
    active.bodyAttempts.get(identity).push(actionStack.at(-1) ?? null);
  },
  miss(key, store, traced) {
    if (!active) return null;
    if (!views.has(store)) views.set(store, ++ordinal);
    const identity = canonical([key, views.get(store), traced]);
    active.misses.set(identity, (active.misses.get(identity) ?? 0) + 1);
    const attempt = { identity: canonical([key, views.get(store)]), view: views.get(store), reader: key.reader, replayable: null };
    active.attempts.push(attempt);
    return attempt;
  },
  action(attempt, operation) {
    actionStack.push(attempt);
    try { return operation(); } finally { assert.equal(actionStack.pop(), attempt); }
  },
  replayability(attempt, replayable) {
    if (attempt) attempt.replayable = replayable;
  },
};
register(config.loader, { data: { root: config.dist, repository: config.repository } });
const imports = name => import(config.dist + 'src/' + name + '.js');
const { canonical } = await imports('canonical');
const { Store } = await imports('storage/store');
const { reference } = await imports('pipeline/contracts');
const { withHistoricalReads } = await imports('om/input');
const { readAcceptedFrame } = await imports('om/frame-accept');
const { writeWorksAcceptance, prepareWorksAcceptance } = await imports('om/atomic-gate');
const { writeGaps, readGaps } = await imports('om/gaps');
const { gapLineKey, prepareGapLines, writeGapLines, readGapLines } = await imports('om/gap-lines');
const { confirmResults } = await imports('om/achievements');
const originalGet = Store.prototype.get, originalList = Store.prototype.list;
Store.prototype.get = function (...args) { if (active) { active.get++; if (args[1] === undefined) active.heads++; } return originalGet.apply(this, args); };
Store.prototype.list = function (...args) { if (active) active.list++; return originalList.apply(this, args); };
const stores = [], reports = [], paths = new WeakMap();
function ok(result) { if (!result.ok) assert.fail(result.refusal.code + ': ' + result.refusal.message); return result.value; }
function measured(label, operation, unique = true) {
  assert.equal(active, null);
  const sample = { proofs: new Map(), bodyAttempts: new Map(), attempts: [], misses: new Map(), get: 0, heads: 0, list: 0 }; active = sample;
  let result;
  try { result = operation(); } finally { active = null; }
  const repeated = [...sample.proofs].filter(([identity, count]) => {
    if (count <= 1) return false;
    const attempts = sample.bodyAttempts.get(identity), view = JSON.parse(identity)[1];
    // Only the common mechanism's explicit per-attempt refusal to cache permits repeated expansion.
    // A Proxy type alone, another reader's exclusion, or several body calls inside one action do not.
    return !(attempts.length === count && new Set(attempts).size === count
      && attempts.every(attempt => attempt && attempt.view === view && attempt.replayable === false)
      && new Set(attempts.map(attempt => attempt.identity)).size === 1);
  });
  if (unique) assert.equal(repeated.length, 0, label + ': each cacheable exact successful proof expands once per semantic Store view; '
    + JSON.stringify(repeated.slice(0, 3)));
  const families = {}, excludedActions = {}, excludedBodies = {};
  for (const [key, count] of sample.proofs) { const family = JSON.parse(key)[0]; families[family] = (families[family] ?? 0) + count; }
  for (const attempt of sample.attempts) if (attempt.replayable === false)
    excludedActions[attempt.reader] = (excludedActions[attempt.reader] ?? 0) + 1;
  for (const [key, attempts] of sample.bodyAttempts) {
    const count = attempts.filter(attempt => attempt?.replayable === false).length;
    if (count) { const family = JSON.parse(key)[0]; excludedBodies[family] = (excludedBodies[family] ?? 0) + count; }
  }
  reports.push({ label, ...families, actions: [...sample.misses.values()].reduce((sum, count) => sum + count, 0),
    excludedActions, excludedBodies, get: sample.get, heads: sample.heads, list: sample.list });
  return { result, sample, families };
}
function cloneStore(database, label) {
  const copy = join(config.directory, label + '.sqlite'); copyFileSync(database, copy);
  const store = new Store(copy); stores.push(store); paths.set(store, copy); return store;
}
function unchanged(store, before) { assert.deepEqual(store.list().map(reference), before); }
try {
  const legacy = JSON.parse(readFileSync(config.checkpoint, 'utf8')), seed = legacy.seed, f = seed.data;
  const historical = new Store(legacy.database); stores.push(historical);
  assert.deepEqual(ok(readAcceptedFrame(historical, legacy.accepted.acceptance)), legacy.frame);
  assert.deepEqual(ok(readGaps(historical, legacy.gaps)), legacy.gapHistory);
  assert.deepEqual(ok(readGapLines(historical, { project: f.project, record: reference(legacy.lines) })), legacy.lines);
  assert.deepEqual(ok(confirmResults(historical, legacy.confirmation)), legacy.confirmed,
    'A new process reads the complete accepted producer history, including its original result keys');
  const store = cloneStore(seed.database, 'cold-acceptance');
  const accepted = measured('writeWorksAcceptance', () => ok(writeWorksAcceptance(store, f.request))).result;
  assert.equal(accepted.state, 'accepted'); assert.ok(accepted.acceptance);
  const freshAcceptance = ok(readAcceptedFrame(store, accepted.acceptance));
  const { contract, binding, layer, ...originalAcceptance } = freshAcceptance.frame.value.acceptance;
  assert.equal(contract, 'om-frame-acceptance/v1'); assert.equal(binding, null);
  assert.deepEqual(layer, { id: freshAcceptance.layer.id, revision: freshAcceptance.layer.revision });
  assert.deepEqual(originalAcceptance, legacy.frame.frame.value.acceptance);
  assert.deepEqual(freshAcceptance.graph, legacy.frame.graph); assert.deepEqual(freshAcceptance.proposals, legacy.frame.proposals);
  assert.deepEqual({ ...freshAcceptance.frame.value, acceptance: originalAcceptance }, legacy.frame.frame.value,
    'The fresh producer changes the explicit acceptance era while preserving its candidate, gate and filled result');
  const sibling = cloneStore(seed.database, 'warm-acceptance');
  const warmAccepted = withHistoricalReads(() => {
    ok(readAcceptedFrame(sibling, { project: f.project, level: 2, graph: f.graph, layer: f.layer2, frame: f.upperFrame }));
    return measured('writeWorksAcceptance.prewarmed', () => ok(writeWorksAcceptance(sibling, f.request))).result;
  });
  assert.deepEqual(warmAccepted, accepted, 'Prewarmed proofs retain every returned reference, guard, record and write in order');
  const previous = store.get(f.lines.id), source = structuredClone(f.gapRead.sources), acceptance = accepted.acceptance;
  source.graph = acceptance.graph; source.operations.frame.graph = acceptance.graph;
  source.works = { frame: { ...source.works.frame, graph: acceptance.graph, layer: acceptance.layer, frame: acceptance.frame }, proposals: [] };
  const current = ok(writeGaps(store, source));
  assert.deepEqual(current.collection, legacy.current.collection); assert.deepEqual(current.gate, legacy.current.gate);
  assert.deepEqual(current.sources, source);
  assert.deepEqual(current.records.map(row => row.value.gap), legacy.current.records.map(row => row.value.gap),
    'D1 preserves the same gap meanings while its exact sources name the fresh accepted frame and layer');
  const gaps = { sources: current.sources, records: current.records.map(reference) };
  const declared = f.openGoal, goal = declared.goal;
  const targets = f.gaps.records.map(row => row.value.gap).filter(gap => gap.code === 'obligation_open'
    && gap.evidence.some(evidence => evidence.origin === 'works') && goal.questions.includes(gapLineKey(f.project, gap.target, gap.field)));
  assert.equal(targets.length, 4, 'The unchanged producer supplies four genuine obligations of the declared work goal');
  assert.ok(targets.every(target => !current.collection.gaps.some(gap => gap.id === target.id)));
  const afterAcceptance = paths.get(store);
  store.close();
  let preparationFamilies = null, confirmationFamilies = null;
  for (const size of [1, 2, 4]) {
    const copy = cloneStore(afterAcceptance, 'closures-' + size);
    const request = { project: f.project, previous: reference(previous), pass: previous.value.request.pass + 1, gaps,
      closures: targets.slice(0, size).map(target => ({ id: target.id, reason: 'filled', basis: acceptance.frame, acceptance,
        attempt: { series: declared.series, attempt: declared.ordinal } })) };
    const before = copy.list().map(reference);
    const cold = measured('prepareGapLines.' + size, () => ok(prepareGapLines(copy, request)));
    if (size === 4) {
      const oldFrame = legacy.accepted.acceptance.frame;
      const expectedLines = legacy.prepared.record.lines.map(line => line.basis && canonical(line.basis) === canonical(oldFrame)
        ? { ...line, basis: acceptance.frame } : line);
      assert.deepEqual(cold.result.record.lines, expectedLines);
      const byCanonical = (a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0;
      assert.deepEqual(cold.result.record.request, { ...request,
        gaps: { ...request.gaps, records: [...request.gaps.records].sort(byCanonical) },
        closures: [...request.closures].sort(byCanonical) });
      for (const ref of [acceptance.graph, acceptance.layer, acceptance.frame, declared.series])
        assert.ok(cold.result.guards.some(guard => canonical(guard) === canonical(ref)), 'Fresh preparation guards ' + ref.id);
      assert.ok(!cold.result.references.some(ref => canonical(ref) === canonical(oldFrame)),
        'The newly closed lines retain the exact current acceptance rather than the old producer hash');
    }
    if (preparationFamilies === null) preparationFamilies = cold.families;
    else assert.deepEqual(cold.families, preparationFamilies, 'More closures of the same frame do not create additional historical foundations');
    const next = measured('prepareGapLines.external.' + size, () => ok(prepareGapLines(copy, request)));
    assert.deepEqual(next.result, cold.result);
    assert.ok(next.sample.proofs.size > 0, 'The next external preparation proves history again');
    const warm = withHistoricalReads(() => {
      ok(prepareGapLines(copy, request));
      return measured('prepareGapLines.warm.' + size, () => ok(prepareGapLines(copy, request)));
    });
    assert.deepEqual(warm.result, cold.result, 'Warm preparation retains the complete ordered references and guards');
    assert.ok(warm.sample.proofs.size < cold.sample.proofs.size, 'Completed histories are reused inside the outer operation');
    assert.ok(warm.sample.heads > 0, 'Warm preparation still checks current heads');
    unchanged(copy, before);
    const saved = ok(writeGapLines(copy, request));
    const confirmation = { project: f.project, block: declared.block, target: declared.series.id, goal, accepting: [reference(saved)], cancelling: [] };
    const confirmed = measured('confirmResults.' + size, () => ok(confirmResults(copy, confirmation)));
    if (size === 4) {
      assert.deepEqual(confirmed.result.achieved.map(item => item.key), legacy.confirmed.achieved.map(item => item.key));
      assert.deepEqual(confirmed.result.cancelled, legacy.confirmed.cancelled);
      assert.ok(confirmed.result.achieved.every(item => canonical(item.basis) === canonical(reference(saved))),
        'Stable result keys use the exact fresh D2 acceptance as their basis');
    }
    if (confirmationFamilies === null) confirmationFamilies = confirmed.families;
    else assert.deepEqual(confirmed.families, confirmationFamilies, 'Distinct result keys share the same exact accepted frame and prior D2 history');
    assert.equal(confirmed.result.achieved.length, size);
    const repeated = measured('confirmResults.external.' + size, () => ok(confirmResults(copy, confirmation)));
    assert.deepEqual(repeated.result, confirmed.result); assert.ok(repeated.sample.proofs.size > 0);
    const warmed = withHistoricalReads(() => {
      ok(confirmResults(copy, confirmation));
      return measured('confirmResults.warm.' + size, () => ok(confirmResults(copy, confirmation)));
    });
    assert.deepEqual(warmed.result, confirmed.result, 'Warm confirmation preserves all exact achievement keys and bases');
    assert.ok(warmed.sample.proofs.size < confirmed.sample.proofs.size);
    if (size === 4) {
      const other = new Store(paths.get(copy)); stores.push(other);
      withHistoricalReads(() => {
        ok(confirmResults(copy, confirmation));
        const separate = measured('confirmResults.separate-store', () => ok(confirmResults(other, confirmation)));
        assert.deepEqual(separate.result, confirmed.result); assert.ok(separate.sample.proofs.size > 0, 'The same database does not merge distinct Stores');
      });
    }
  }
  const pendingStore = cloneStore(afterAcceptance, 'pending-view');
  let hidden = null;
  const pending = new Proxy(pendingStore, { get(target, property) {
    if (property === 'get') return (id, revision) => hidden && id === hidden.id && (revision === undefined || revision === hidden.revision)
      ? null : target.get(id, revision);
    const member = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const witness = accepted.record.value.gate;
  withHistoricalReads(() => {
    const original = ok(readAcceptedFrame(pendingStore, acceptance));
    hidden = witness;
    const absent = readAcceptedFrame(pending, acceptance);
    assert.equal(absent.ok, false, 'A separate pending view cannot borrow the source Store proof when its gate is missing');
    assert.ok(absent.refusal.at.target && absent.refusal.at.field);
    hidden = null;
    assert.deepEqual(ok(readAcceptedFrame(pending, acceptance)), original);
    hidden = witness;
    const changed = readAcceptedFrame(pending, acceptance);
    assert.equal(changed.ok, false, 'Changing a visible pending dependency invalidates its successful proof inside the same scope');
    assert.ok(changed.refusal.at.target && changed.refusal.at.field);
    hidden = null;
    assert.deepEqual(ok(readAcceptedFrame(pending, acceptance)), original, 'A refused proof is not cached and its restored source can be checked again');
  });
  const currentStore = cloneStore(seed.database, 'current-admission');
  ok(prepareWorksAcceptance(currentStore, f.request));
  const environment = currentStore.get(f.environment.id);
  currentStore.write({ id: environment.id, kind: environment.kind, expected: environment.revision, value: environment.value });
  const stale = prepareWorksAcceptance(currentStore, f.request);
  assert.equal(stale.ok, false, 'The next public preparation observes a moved current prerequisite');
  assert.equal(stale.refusal.code, 'input_stale');
  for (const family of ['C5', 'C2.basis', 'C2.derive', 'C4', 'D1', 'D1.records', 'D2', 'G5'])
    assert.ok(reports.some(report => report[family] > 0), 'The genuine scenario reached ' + family);
  assert.equal(readFileSync(seed.trace, 'utf8'), seed.traceBytes, 'Proof operations do not send another adapter request');
  console.log(JSON.stringify({ reports }));
} finally {
  active = null;
  for (const store of stores) store.close();
}
`;

test('S1 real F5 proof operations scale by exact histories and preserve references across warm, fresh and pending views', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'omg-operation-cost-'));
  const checkpoint = join(directory, 'baseline.json');
  t.after(() => {
    if (existsSync(checkpoint)) {
      const saved = JSON.parse(readFileSync(checkpoint, 'utf8')) as { seed: { root: string } };
      rmSync(saved.seed.root, { recursive: true, force: true });
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const loaderFile = join(directory, 'proof-loader.mjs'), script = join(directory, 'scenario.mjs'), oldScript = join(directory, 'baseline.mjs');
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const dist = pathToFileURL(fileURLToPath(new URL('../', import.meta.url))).href;
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const configuration = JSON.stringify({ directory, checkpoint, repository, dist, loader: pathToFileURL(loaderFile).href });
  writeFileSync(loaderFile, loader.replace('TYPESCRIPT', JSON.stringify(typescript)));
  writeFileSync(oldScript, baselineScenario.replace('CONFIG', configuration));
  writeFileSync(script, scenario.replace('CONFIG', configuration));
  await promisify(execFile)(process.execPath, [oldScript], { maxBuffer: 16 * 1024 * 1024 });
  const result = await promisify(execFile)(process.execPath, [script], { maxBuffer: 16 * 1024 * 1024 });
  const output = result.stdout.trim().split('\n').at(-1);
  assert.ok(output); const report = JSON.parse(output) as { reports: { label: string }[] };
  assert.ok(report.reports.length >= 20);
  for (const row of report.reports) t.diagnostic(JSON.stringify(row));
});
