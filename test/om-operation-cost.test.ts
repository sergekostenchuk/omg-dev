import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { hashJson, type Json } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { pendingOverlay } from '../src/storage/store-view.js';
import { historicalProof, withHistoricalReads } from '../src/history/proofs.js';

// Observe the actual compiled producer and proof bodies without changing a production module or the accepted fixture.
const loader = String.raw`
import ts from TYPESCRIPT;
let root;
export function initialize(data) { root = data.root; }
const bodies = {
  'src/om/layer-basis.js': { verifyHistoricalBasis: ["C5", "request"] },
  'src/om/frame-obligations.js': { frameSources: ["C2.basis", "request"], frameDerive: ["C2.derive", "request"] },
  // NR1 (№3600): C4 verifyRecordSources and A2 checkJournal are gone — a saved candidate and journal are read as written.
  'src/om/gap-lines.js': { deriveHistory: ["D2", "{project, ref}"] },
  'src/om/gaps.js': { deriveMaterialized: ["D1", "request", "!current"], deriveGapRecords: ["D1.records", "request"] },
  'src/om/atomic-gate.js': { deriveGate: ["G5", "request", "!current"] },
  // S1.1: the families of the block chain — the historical E2 derivation and its preceding refusals, the A2 journal
  // derivation by the exact revision it checks, the G4b groups of an evaluation and the G7 completion snapshot.
  // E2.2: the key names the whole derivation — the environment bounds the packet and a continuation packet of the same
  // attempt (need_source) is another derivation; without them two packets of one attempt looked like one key twice.
  'src/om/question-packet.js': { derivePacket: ["E2.derive", "[request.routes, request.batch, request.attempt ?? null, request.previous.length, request.environment, request.continuation ?? null]", "!current"],
    previousRefusals: ["E2.refusals", "[batch.id, request.attempt ?? null]", "!current"] },
  'src/om/answers-gate.js': { deriveAnswersGroups: ["G4b.groups", "{ id: evaluation.id, revision: evaluation.revision, hash: evaluation.hash }"] },
  'src/om/model-call.js': { deriveCompletionSnapshot: ["G7.snapshot", "{ id: work.id, revision: work.revision, hash: work.hash }"] },
};
// Accepted fixtures reached without their own test registrations, exactly as the F5 seed is (S1.1 adds the G4b one).
const fixtures = {
  'test/om-atomic-gate.test.js': { registrations: ['test', 'after'], exports: ['produceAtomicSeed', 'seedResources'] },
  // E2.2 (№1801): the real MC2 node root of a block ended by the scripted answer and the G4b evaluation of a managed attempt.
  'test/om-answers-gate.test.js': { registrations: ['test'], exports: ['fixture', 'registered', 'factGap', 'traceUsage', 'nodeTerminal', 'evaluate'] },
  // S1.1 (№1787-3/4): the accepted H1 pass fixture for the mixed N2 and L3 scenarios.
  'test/om-run.test.js': { registrations: ['test'], exports: ['project', 'usage', 'runFixture', 'worksFixture', 'nodeAnswer', 'cannotAnswer',
    'addressAll', 'stopAnswer', 'blockSeries', 'mechanismSeries', 'actions'] },
};
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith(root) || result.format !== 'module') return result;
  const file = decodeURIComponent(url.slice(root.length));
  if (!bodies[file] && !fixtures[file] && file !== 'src/history/proofs.js') return result;
  let source = String(result.source);
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (fixtures[file]) {
    const removed = new Set();
    source = tree.statements.filter(statement => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return true;
      const name = statement.expression.expression.getText(tree);
      if (fixtures[file].registrations.includes(name)) { removed.add(name); return false; }
      return true;
    }).map(statement => source.slice(statement.pos, statement.end)).join('\n');
    if (fixtures[file].registrations.some(name => !removed.has(name))) throw new Error('The accepted fixture registrations were not identified');
    source += '\nexport { ' + fixtures[file].exports.join(', ') + ' };\n';
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
    // R5 (№2451): the common mechanism lives in history/proofs; its anchors stay, each still required exactly once.
    if (file === 'src/history/proofs.js') {
      const miss = 'const result = synchronous(() => action(traced ? historicalTrace(store) : store));';
      if (source.split(miss).length !== 2) throw new Error('The common historical proof action was not identified');
      source = source.replace(miss, 'const costAttempt = globalThis.__operationCost.miss(key, sourceView(store), traced, source);\n'
        + 'const result = globalThis.__operationCost.action(costAttempt, () => synchronous(() => action(traced ? historicalTrace(store) : store)));');
      const replayable = 'const replayable = !isProxy(source) && !tracedChain(source) || [...events.sources].every(observed => observed === source);';
      if (source.split(replayable).length !== 2) throw new Error('The common historical proof replay decision was not identified');
      source = source.replace(replayable, replayable + '\nglobalThis.__operationCost.replayability(costAttempt, replayable);');
      // S1.1 (№1787): a repeated entry into an ACTIVE exact key is a real cycle, not repeated work; the key and the
      // chain of active keys are observed, so the two are told apart by keys and regions, never by function names.
      // S1.1 (№1787): one operation of the common mechanism is one OUTER withHistoricalReads; a transition of the H1 pass
      // runs several producers, each in its own. Proofs are counted per operation, so the outer scopes are numbered.
      const scope = 'historicalViews = new WeakMap();';
      if (source.split(scope).length !== 2) throw new Error('The outer scope of the common proof was not identified');
      source = source.replace(scope, scope + ' globalThis.__operationCost.scope();');
      const cyclic = 'if (view.active.has(exact))';
      if (source.split(cyclic).length !== 2) throw new Error('The cycle decision of the common proof was not identified');
      source = source.replace(cyclic, 'if (view.active.has(exact) && (globalThis.__operationCost.cycle(key, sourceView(store)), true))');
      // S1.1: a kept proof without a complete dependency trace is derived again when a traced caller needs one; and a
      // proof whose dependency footprint moved is derived again by design. Both decisions are observed apart.
      const decision = 'const complete = traced || historicalTraces.has(store), previous = view.proven.get(exact);';
      if (source.split(decision).length !== 2) throw new Error('The completeness decision of the common proof was not identified');
      // S1.3: the region of a decision is the caller's source view, as for a miss — not the shared identity of its Store.
      source = source.replace(decision, decision + ' globalThis.__operationCost.refining(key, sourceView(store), previous !== undefined && complete && !previous.complete);');
      const cleared = 'view.proven.clear();';
      if (source.split(cleared).length !== 2) throw new Error('The footprint invalidation of the common proof was not identified');
      source = source.replace(cleared, cleared + ' globalThis.__operationCost.invalidated(key, sourceView(store));');
      // S1.3: the hook above follows the whole if/else, so a proof dropped from a genuine Store's area is observed as well.
      // S1.1: physical reads made to check a proof's footprint are told apart from reads that unfold a proof.
      const enter = 'checkingFootprint++;', leave = 'checkingFootprint--;';
      if (source.split(enter).length !== 2 || source.split(leave).length !== 2) throw new Error('The footprint check of the common proof was not identified');
      source = source.replace(enter, enter + ' globalThis.__operationCost.footprint(1);').replace(leave, 'globalThis.__operationCost.footprint(-1); ' + leave);
      // S1.3 (№2185-4): a proof kept by an earlier operation serves this one only after its footprint check; whether it
      // served or had moved is observed apart. PF4: the check is the chain and the events after the proof's mark. Absent in
      // builds before PF4 (whose own anchor no longer matched since PF1), so optional.
      // NR1 (№3600): the chains and read functions are not checked again at a reuse — the events after the mark decide.
      const kept = 'if (currentJournal(kept.events)) {';
      if (source.split(kept).length !== 2) throw new Error('The reuse decision of a kept proof was not identified');
      source = source.replace(kept, 'if ((current => globalThis.__operationCost.kept?.(key, source, current) ?? current)(currentJournal(kept.events))) {');
      source += '\nglobalThis.__operationCost.sourceView = sourceView;\n';
    }
  }
  return { ...result, source };
}
`;

const checkpointScenario = String.raw`
import assert from 'node:assert/strict';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from 'node:module';
const config = CONFIG;
register(config.loader, { data: { root: config.dist } });
// The checkpoint is produced by the current code through the instrumented loader: the proof hooks observe, nothing counts.
globalThis.__operationCost = { sourceView: store => store, hit() {}, miss() { return null; },
  action(_attempt, operation) { return operation(); }, replayability() {}, scope() {}, cycle() {},
  refining() {}, invalidated() {}, footprint() {} };
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
  const seed = await produceAtomicSeed(), f = seed.data, database = join(config.directory, 'accepted-checkpoint.sqlite');
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
  footprint() {}, invalidated() {}, refining() {}, cycle() {}, scope() {},
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
// NR1 (№3600): the producer's check of a new combination (reader X.fresh) and the trusted read of the same saved request
// (reader X) are two proofs by design, each expanding once per view.
const freshAndTrusted = (attempts, count, view) => count === 2 && attempts.length === 2 && attempts.every(attempt => attempt && attempt.view === view)
  && new Set(attempts.map(attempt => attempt.reader)).size === 2 && new Set(attempts.map(attempt => attempt.reader.replace(/\.fresh$/, ''))).size === 1;
function measured(label, operation, unique = true) {
  assert.equal(active, null);
  const sample = { proofs: new Map(), bodyAttempts: new Map(), attempts: [], misses: new Map(), get: 0, heads: 0, list: 0 }; active = sample;
  let result;
  try { result = operation(); } finally { active = null; }
  const repeated = [...sample.proofs].filter(([identity, count]) => {
    if (count <= 1) return false;
    const attempts = sample.bodyAttempts.get(identity), view = JSON.parse(identity)[1];
    if (freshAndTrusted(attempts, count, view)) return false;
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
  const checkpoint = JSON.parse(readFileSync(config.checkpoint, 'utf8')), seed = checkpoint.seed, f = seed.data;
  const historical = new Store(checkpoint.database); stores.push(historical);
  assert.deepEqual(ok(readAcceptedFrame(historical, checkpoint.accepted.acceptance)), checkpoint.frame);
  assert.deepEqual(ok(readGaps(historical, checkpoint.gaps)), checkpoint.gapHistory);
  assert.deepEqual(ok(readGapLines(historical, { project: f.project, record: reference(checkpoint.lines) })), checkpoint.lines);
  assert.deepEqual(ok(confirmResults(historical, checkpoint.confirmation)), checkpoint.confirmed,
    'A new process reads the complete accepted producer history, including its original result keys');
  const store = cloneStore(seed.database, 'cold-acceptance');
  const accepted = measured('writeWorksAcceptance', () => ok(writeWorksAcceptance(store, f.request))).result;
  assert.equal(accepted.state, 'accepted'); assert.ok(accepted.acceptance);
  const freshAcceptance = ok(readAcceptedFrame(store, accepted.acceptance));
  const { contract, binding, layer, ...originalAcceptance } = freshAcceptance.frame.value.acceptance;
  assert.equal(contract, 'om-frame-acceptance/v1'); assert.equal(binding, null);
  assert.deepEqual(layer, { id: freshAcceptance.layer.id, revision: freshAcceptance.layer.revision });
  // FJ1: a new independent C4 belongs to its new assembly era; the exact saved history above remains unchanged.
  const { hashJson } = await imports('canonical');
  const oldAcceptance = checkpoint.frame.frame.value.acceptance;
  const oldCandidate = historical.get(oldAcceptance.candidate.id, oldAcceptance.candidate.revision);
  const newCandidate = store.get(originalAcceptance.candidate.id, originalAcceptance.candidate.revision);
  assert.ok(oldCandidate && newCandidate);
  assert.deepEqual(reference(newCandidate), originalAcceptance.candidate);
  const { joinAssembly, request: candidateRequest, ...candidateBody } = newCandidate.value;
  const { joinAssembly: requestedEra, ...oldRequest } = candidateRequest;
  assert.equal(joinAssembly, 'identity-joins/v1'); assert.equal(requestedEra, joinAssembly);
  const oldEra = !Object.hasOwn(oldCandidate.value, 'joinAssembly');
  if (!oldEra) {
    // The checkpoint is produced by the current code: the new C4 names the same saved candidate and era.
    assert.deepEqual(newCandidate, oldCandidate);
    assert.deepEqual(reference(newCandidate), oldAcceptance.candidate);
  } else {
    assert.deepEqual({ ...candidateBody, request: oldRequest }, oldCandidate.value,
      'Only the explicit C4 era changes this fixture candidate; the complete graph, sources and works stay equal');
    assert.notDeepEqual(reference(newCandidate), oldAcceptance.candidate);
  }
  assert.equal(newCandidate.id, 'om-candidate:' + f.project + ':' + hashJson([candidateBody.level, joinAssembly,
    candidateBody.graphHash, candidateBody.base, candidateBody.proposals, candidateBody.works]));
  assert.equal(newCandidate.hash, hashJson(newCandidate.value));
  const newGate = store.get(originalAcceptance.gate.basis.id, originalAcceptance.gate.basis.revision);
  assert.ok(newGate);
  assert.deepEqual(reference(newGate), originalAcceptance.gate.basis);
  assert.equal(newGate.hash, hashJson(newGate.value));
  assert.deepEqual(newGate.value.request.candidate, reference(newCandidate));
  assert.deepEqual(newGate.value.result.candidate, reference(newCandidate));
  assert.equal(newGate.value.result.graphHash, candidateBody.graphHash);
  assert.deepEqual(originalAcceptance.gate.candidate, reference(newCandidate));
  // Old era: reconstruct the saved acceptance from the fresh one — its era dropped contract, binding and layer, and the
  // C4 named another candidate. Same era: the fresh acceptance is the saved one as written.
  const sameEraAcceptance = oldEra
    ? { ...originalAcceptance, candidate: oldAcceptance.candidate,
      gate: { ...originalAcceptance.gate, candidate: oldAcceptance.gate.candidate, basis: oldAcceptance.gate.basis } }
    : { contract, binding, layer, ...originalAcceptance };
  assert.deepEqual(sameEraAcceptance, oldAcceptance);
  assert.deepEqual(freshAcceptance.graph, checkpoint.frame.graph);
  const sameEraProposals = freshAcceptance.proposals.map(row => {
    assert.equal(row.hash, hashJson(row.value));
    assert.deepEqual(row.value.verdict.candidate, reference(newCandidate));
    const value = { ...row.value, verdict: { ...row.value.verdict, candidate: oldAcceptance.candidate } };
    return { ...row, value, hash: hashJson(value) };
  });
  assert.deepEqual(sameEraProposals, checkpoint.frame.proposals,
    'Accepted proposal verdicts name the proved new candidate; their hashes and every other field stay exact');
  assert.deepEqual({ ...freshAcceptance.frame.value, acceptance: sameEraAcceptance }, checkpoint.frame.frame.value,
    'The fresh C4 and G5 references follow their proved new era; every other accepting-frame field stays equal');
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
  assert.deepEqual(current.collection, checkpoint.current.collection); assert.deepEqual(current.gate, checkpoint.current.gate);
  assert.deepEqual(current.sources, source);
  assert.deepEqual(current.records.map(row => row.value.gap), checkpoint.current.records.map(row => row.value.gap),
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
      const oldFrame = checkpoint.accepted.acceptance.frame;
      const expectedLines = checkpoint.prepared.record.lines.map(line => line.basis && canonical(line.basis) === canonical(oldFrame)
        ? { ...line, basis: acceptance.frame } : line);
      assert.deepEqual(cold.result.record.lines, expectedLines);
      const byCanonical = (a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0;
      assert.deepEqual(cold.result.record.request, { ...request,
        gaps: { ...request.gaps, records: [...request.gaps.records].sort(byCanonical) },
        closures: [...request.closures].sort(byCanonical) });
      for (const ref of [acceptance.graph, acceptance.layer, acceptance.frame, declared.series])
        assert.ok(cold.result.guards.some(guard => canonical(guard) === canonical(ref)), 'Fresh preparation guards ' + ref.id);
      // The newly closed lines retain the exact current acceptance — never a different old producer hash.
      if (canonical(oldFrame) === canonical(acceptance.frame))
        assert.ok(cold.result.references.some(ref => canonical(ref) === canonical(oldFrame)),
          'The newly closed lines retain the exact current acceptance');
      else assert.ok(!cold.result.references.some(ref => canonical(ref) === canonical(oldFrame)),
        'The newly closed lines retain the exact current acceptance rather than the old producer hash');
    }
    if (preparationFamilies === null) preparationFamilies = cold.families;
    else assert.deepEqual(cold.families, preparationFamilies, 'More closures of the same frame do not create additional historical foundations');
    const next = measured('prepareGapLines.external.' + size, () => ok(prepareGapLines(copy, request)));
    assert.deepEqual(next.result, cold.result);
    // PF3.3 (№3587): no residual reread inside a traced read leaves the derivation unaccounted any more — the history it
    // proved is complete and kept at the Store, so the next operation reuses it by the Store's events.
    // NR1 (№3600): the basis of the saved layer (C5) is read as written — by its exact references, nothing unfolded — and the
    // preparation of a new operation may read it again; every other history is reused from the Store.
    assert.deepEqual([...next.sample.proofs.keys()].map(key => JSON.parse(key)[0]).filter(family => family !== 'C5'), [],
      'The next external preparation reuses the complete histories kept at the Store');
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
      assert.deepEqual(confirmed.result.achieved.map(item => item.key), checkpoint.confirmed.achieved.map(item => item.key));
      assert.deepEqual(confirmed.result.cancelled, checkpoint.confirmed.cancelled);
      assert.ok(confirmed.result.achieved.every(item => canonical(item.basis) === canonical(reference(saved))),
        'Stable result keys use the exact fresh D2 acceptance as their basis');
    }
    if (confirmationFamilies === null) confirmationFamilies = confirmed.families;
    else assert.deepEqual(confirmed.families, confirmationFamilies, 'Distinct result keys share the same exact accepted frame and prior D2 history');
    assert.equal(confirmed.result.achieved.length, size);
    const repeated = measured('confirmResults.external.' + size, () => ok(confirmResults(copy, confirmation)));
    assert.deepEqual(repeated.result, confirmed.result);
    assert.equal(repeated.sample.proofs.size, 0, 'PF3.3: the kept complete histories serve the next confirmation');
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
        // NR1: a distinct Store keeps no proof of another in memory; it may take what that one saved in the database (PF4
        // §5.2) — now that saved histories are read as written, all of them are — so it proves at most what the first did.
        assert.deepEqual(separate.result, confirmed.result);
        assert.ok(separate.sample.proofs.size <= confirmed.sample.proofs.size, 'The same database does not merge distinct Stores beyond their saved proofs');
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
    // NR1 (№3591/№3646): the accepted frame is read as written — the gate it names is not read again on the way, so a view
    // hiding it reads the same frame; a revision missing from the database is found by om-fsck at the start (reference_missing).
    hidden = witness;
    assert.deepEqual(ok(readAcceptedFrame(pending, acceptance)), original);
    hidden = null;
    assert.deepEqual(ok(readAcceptedFrame(pending, acceptance)), original);
  });
  const currentStore = cloneStore(seed.database, 'current-admission');
  ok(prepareWorksAcceptance(currentStore, f.request));
  const environment = currentStore.get(f.environment.id);
  currentStore.write({ id: environment.id, kind: environment.kind, expected: environment.revision, value: environment.value });
  const stale = prepareWorksAcceptance(currentStore, f.request);
  assert.equal(stale.ok, false, 'The next public preparation observes a moved current prerequisite');
  assert.equal(stale.refusal.code, 'input_stale');
  for (const family of ['C5', 'C2.basis', 'C2.derive', 'D1.records', 'D2'])
    assert.ok(reports.some(report => report[family] > 0), 'The genuine scenario reached ' + family);
  // NR1 (№3591): the historical D1 materialization and G5 derivation never run — saved gaps and gates are read as written.
  for (const family of ['D1', 'G5'])
    assert.ok(reports.every(report => !(report[family] > 0)), 'A saved record is read as written, ' + family + ' is not derived again');
  assert.equal(readFileSync(seed.trace, 'utf8'), seed.traceBytes, 'Proof operations do not send another adapter request');
  console.log(JSON.stringify({ reports }));
} finally {
  active = null;
  for (const store of stores) store.close();
}
`;

test('S1 real F5 proof operations scale by exact histories and preserve references across warm, fresh and pending views', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'omg-operation-cost-'));
  const checkpoint = join(directory, 'prepared.json');
  t.after(() => {
    if (existsSync(checkpoint)) {
      const saved = JSON.parse(readFileSync(checkpoint, 'utf8')) as { seed: { root: string } };
      rmSync(saved.seed.root, { recursive: true, force: true });
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const loaderFile = join(directory, 'proof-loader.mjs'), script = join(directory, 'scenario.mjs'), preparedScript = join(directory, 'prepared.mjs');
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const dist = pathToFileURL(fileURLToPath(new URL('../', import.meta.url))).href;
  const configuration = JSON.stringify({ directory, checkpoint, dist, loader: pathToFileURL(loaderFile).href });
  writeFileSync(loaderFile, loader.replace('TYPESCRIPT', JSON.stringify(typescript)));
  writeFileSync(preparedScript, checkpointScenario.replace('CONFIG', configuration));
  writeFileSync(script, scenario.replace('CONFIG', configuration));
  await promisify(execFile)(process.execPath, [preparedScript], { maxBuffer: 16 * 1024 * 1024 });
  const result = await promisify(execFile)(process.execPath, [script], { maxBuffer: 16 * 1024 * 1024 });
  const output = result.stdout.trim().split('\n').at(-1);
  assert.ok(output); const report = JSON.parse(output) as { reports: { label: string }[] };
  assert.ok(report.reports.length >= 20);
  for (const row of report.reports) t.diagnostic(JSON.stringify(row));
});

// S1.1 (№1759 rows 3, 5, 6, 9; №1773 §4, §7, §8): a real block ladder on the accepted G4b fixture. Attempts 1/2/3 of one
// MC1 goal end with a genuine negative E5 and a linked G4b evaluation (deliver 'all') that closes each attempt; the
// third stops the series (A3); the owner's decision resumes it (A6) and attempt 4 succeeds. Every operation is measured
// by the proof bodies it executes (after the cache decision), the distinct keys and repeats per region, the regions it
// touches and where they were born, and the physical reads of the real Store — unfolding and footprint apart.
// The shared measurement of every S1.1 scenario: regions by sourceView with their birth, proof bodies after the cache
// decision with the ACTIVE CHAIN of keys at each entry, real cycles, refinements and moved footprints apart, physical reads.
const scenarioHeader = String.raw`
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from 'node:module';
import { types } from 'node:util';
const config = CONFIG;
`;
const monitorHead = String.raw`
let active = null, ordinal = 0, footprintDepth = 0, scopeId = 0;
if (process.env.S11_OBSERVE) Error.stackTraceLimit = 60;
const views = new WeakMap(), regions = new Map(), actionStack = [];
// A region is one sourceView identity: the real Store or a separate view. Where it first appears and under which
// proofs is kept, so a view born inside a historical proof body is told apart from a staged view of the current producer.
function regionOf(store, first) {
  if (!views.has(store)) {
    views.set(store, ++ordinal);
    regions.set(ordinal, { view: ordinal, proxy: types.isProxy(store), frozen: Object.isFrozen(store), first,
      under: actionStack.map(attempt => attempt.reader),
      // In a diagnostic run the birth of a region names the code that first read through it (the frames outside input.js).
      at: process.env.S11_OBSERVE ? (new Error().stack ?? '').split('\n').slice(1).filter(line => !/input\.js|proof-loader|node:internal/.test(line))
        .slice(0, 10).map(line => line.trim().replace(/^at /, '').replace(/file:\/\/\S*\/dist\//, '')) : undefined });
  }
  return views.get(store);
}
const invalidations = new Set(), refinements = new Set();
// S1.3: executed proof bodies across ALL measured operations, by exact key and region; reuses of kept proofs and kept
// proofs found moved, by the same identity.
const crossExecutions = new Map(), keptServes = new Map(), keptMoves = new Map();
function crossOperation(readers) {
  const rows = {};
  for (const [identity, count] of crossExecutions) {
    const [key] = JSON.parse(identity);
    if (!readers.includes(key.reader)) continue;
    const row = rows[key.reader] ??= { executions: 0, identities: 0, served: 0, moved: 0, repeated: 0 };
    const moved = keptMoves.get(identity) ?? 0;
    row.executions += count; row.identities++; row.served += keptServes.get(identity) ?? 0; row.moved += moved;
    row.repeated += Math.max(0, count - 1 - moved);
  }
  return rows;
}
const monitor = globalThis.__operationCost = {
  sourceView: store => store,
  kept(key, store, current) {
    if (active) { const identity = canonical([key, regionOf(store, key.reader)]), tally = current ? keptServes : keptMoves; tally.set(identity, (tally.get(identity) ?? 0) + 1); }
    return current;
  },
  footprint(delta) { footprintDepth += delta; },
  // The common mechanism found the footprint of a kept proof moved and dropped the proofs of that region: the next
  // derivation of that key there is a re-derivation over changed dependencies, not a repeat over unchanged ones.
  invalidated(key, store) { if (active) invalidations.add(canonical([key, regionOf(store, key.reader)])); },
  // A kept proof was derived without a trace and a traced caller now needs its complete dependency journal.
  refining(key, store, refined) { if (active && refined) refinements.add(canonical([key, regionOf(store, key.reader)])); },
  // A real cycle: the same exact key entered again while still active — with the chain of active keys leading to it.
  cycle(key, store) { if (active) active.cycles.push({ key, view: regionOf(store, key.reader), chain: actionStack.map(attempt => attempt.key) }); },
  // One outer operation of the common mechanism began: proofs are shared inside it and proved again outside it.
  scope() { scopeId++; if (active) active.scopes.add(scopeId); },
  hit(family, store, key) {
    if (!active) return;
    const view = regionOf(this.sourceView(store), family);
    const identity = JSON.stringify([family, view, canonical(key), scopeId]);
    active.proofs.set(identity, (active.proofs.get(identity) ?? 0) + 1);
    if (!active.bodyAttempts.has(identity)) active.bodyAttempts.set(identity, []);
    active.bodyAttempts.get(identity).push(actionStack.at(-1) ?? null);
    active.regions.add(view);
  },
  miss(key, store, traced, root = store) {
    if (!active) return null;
    const view = regionOf(store, key.reader);
    const identity = canonical([key, view, traced, scopeId]);
    active.misses.set(identity, (active.misses.get(identity) ?? 0) + 1);
    // Across operations a proof is one per exact key and SOURCE IDENTITY (S1.3, №2194-3), not per short-lived view.
    const across = canonical([key, regionOf(root, key.reader)]);
    crossExecutions.set(across, (crossExecutions.get(across) ?? 0) + 1);
    const attempt = { identity: canonical([key, view, scopeId]), key, view, scope: scopeId, reader: key.reader, replayable: null,
      invalidated: invalidations.delete(canonical([key, view])), refined: refinements.delete(canonical([key, view])),
      chain: actionStack.map(active => active.key) };
    active.attempts.push(attempt); active.regions.add(view);
    // A long operation reports its progress while it runs, so a run that dies inside one still shows what grew there.
    if (active.progress && active.attempts.length % 2000 === 0) active.progress(attempt);
    return attempt;
  },
  action(attempt, operation) {
    actionStack.push(attempt);
    try { const value = operation(); if (attempt) attempt.refused = value !== null && typeof value === 'object' && value.ok === false; return value; }
    finally { assert.equal(actionStack.pop(), attempt); }
  },
  replayability(attempt, replayable) { if (attempt) attempt.replayable = replayable; },
};
`;
const monitorTail = String.raw`
const originalGet = Store.prototype.get, originalList = Store.prototype.list, originalHistory = Store.prototype.history;
const phase = () => footprintDepth ? 'footprint' : 'unfold';
Store.prototype.get = function (...args) { if (active) active.reads[phase()][args[1] === undefined ? 'head' : 'exact']++; return originalGet.apply(this, args); };
Store.prototype.list = function (...args) { if (active) active.reads[phase()].list++; return originalList.apply(this, args); };
Store.prototype.history = function (...args) { if (active) active.reads[phase()].history++; return originalHistory.apply(this, args); };
const HISTORICAL = ['E2.question-packet', 'A2.readJournalAt', 'G4b.refusal', 'G4b.finding', 'G4b.evaluation', 'G4b.answers', 'G7.completion-work', 'E4.model-call-state'];
const TEMPORARY = ['E2.works-proposal-content'];
const stores = [], reports = [], samples = new Map(), cleanups = [], paths = new WeakMap();
function ok(result) { if (!result.ok) assert.fail(result.refusal.code + ': ' + result.refusal.message + ' @ ' + JSON.stringify(result.refusal.at)); return result.value; }
function begin(label) {
  assert.equal(active, null); assert.ok(!samples.has(label), label);
  const sample = { proofs: new Map(), bodyAttempts: new Map(), attempts: [], misses: new Map(), regions: new Set(), cycles: [], scopes: new Set(), started: performance.now(),
    reads: { unfold: { exact: 0, head: 0, list: 0, history: 0 }, footprint: { exact: 0, head: 0, list: 0, history: 0 } } };
  active = sample; return sample;
}
// NR1 (№3600): the producer's check of a new combination (reader X.fresh) and the trusted read of the same saved request
// (reader X) are two proofs by design, each expanding once per view.
const freshAndTrusted = (attempts, count, view) => count === 2 && attempts.length === 2 && attempts.every(attempt => attempt && attempt.view === view)
  && new Set(attempts.map(attempt => attempt.reader)).size === 2 && new Set(attempts.map(attempt => attempt.reader.replace(/\.fresh$/, ''))).size === 1;
function measured(label, operation) {
  const sample = begin(label); let result;
  try { result = operation(); } finally { active = null; }
  return finish(label, sample, result);
}
async function measuredAsync(label, operation) {
  const sample = begin(label); let result;
  try { result = await operation(); } finally { active = null; }
  return finish(label, sample, result);
}
function finish(label, sample, result) {
  const ms = Math.round(performance.now() - sample.started);
  // Strict by default. S11_OBSERVE=1 is a diagnostic run only: every violation is collected into the report instead of thrown,
  // so one run shows every edge of a remaining class at once (№1773-5: the exact edge is named before any change).
  const violations = [], check = (condition, message) => { if (condition) return; if (process.env.S11_OBSERVE) violations.push(message); else assert.fail(message); };
  // The F5 rule: a cacheable exact successful proof body expands once per semantic Store view; only the common
  // mechanism's explicit refusal to cache that attempt, or its finding that the kept proof's footprint moved
  // (a write of this same operation changed a head the proof depends on), permits a repeated expansion.
  const excused = attempt => attempt.replayable === false || attempt.refused || attempt.invalidated || attempt.refined;
  const repeated = [...sample.proofs].filter(([identity, count]) => {
    if (count <= 1) return false;
    const attempts = sample.bodyAttempts.get(identity), view = JSON.parse(identity)[1];
    if (freshAndTrusted(attempts, count, view)) return false;
    return !(attempts.length === count && new Set(attempts).size === count
      && attempts.every(attempt => attempt && attempt.view === view) && attempts.slice(1).every(excused)
      && new Set(attempts.map(attempt => attempt.identity)).size === 1);
  });
  const describe = identity => ({ identity, region: regions.get(JSON.parse(identity)[1]), attempts: sample.bodyAttempts.get(identity)
    .map(attempt => attempt && { reader: attempt.reader, view: attempt.view, replayable: attempt.replayable, refused: attempt.refused,
      invalidated: attempt.invalidated, refined: attempt.refined, ref: attempt.key.ref }) });
  check(repeated.length === 0, label + ': each cacheable exact successful proof expands once per semantic Store view; '
    + JSON.stringify(repeated.slice(0, 3).map(([identity]) => describe(identity))));
  // Proof bodies by reader (entered after the cache decision), distinct keys per reader, repeats of one key in one
  // region. A refused body runs again by design and is counted apart; a successful one may not repeat unless the
  // common mechanism refused to keep it (an opaque view answering for foreign sources).
  const executions = {}, keys = {}, seen = new Map(), repeats = [], refusedRepeats = [], movedRepeats = [], refinedRepeats = [];
  for (const attempt of sample.attempts) {
    executions[attempt.reader] = (executions[attempt.reader] ?? 0) + 1;
    const earlier = seen.get(attempt.identity);
    seen.set(attempt.identity, earlier ? { count: earlier.count + 1, first: earlier.first } : { count: 1, first: attempt });
    if (earlier && attempt.replayable !== false)
      (attempt.refused ? refusedRepeats : attempt.invalidated ? movedRepeats : attempt.refined ? refinedRepeats : repeats)
        .push({ key: attempt.key, view: attempt.view, chains: [earlier.first.chain, attempt.chain] });
  }
  for (const [identity] of seen) { const reader = JSON.parse(identity)[0].reader; keys[reader] = (keys[reader] ?? 0) + 1; }
  // A repeat of one key in one region shows BOTH active chains that led to it: repeated work over unchanged dependencies
  // is the defect of this task; a key entered again while still active is a real cycle and is counted apart (№1773-5).
  check(repeats.length === 0, label + ': one successful exact proof per key and region; ' + JSON.stringify(repeats.slice(0, 2)));
  check(sample.cycles.length === 0, label + ': no exact key is entered again while it is active; ' + JSON.stringify(sample.cycles.slice(0, 2)));
  const families = {};
  for (const [key, count] of sample.proofs) { const family = JSON.parse(key)[0]; families[family] = (families[family] ?? 0) + count; }
  const born = [...sample.regions].map(view => regions.get(view));
  const nested = born.filter(region => region.under.length).map(region => ({ view: region.view, first: region.first, under: region.under, proxy: region.proxy, frozen: region.frozen }));
  // No region may be born under a historical reader: that is a view created only to unfold the same old history again.
  // The one allowed exception (№1887-6): the temporary view of synthetic answer content, bound to that content, which
  // exists in no Store — counted and shown apart, never hidden inside the same number.
  const temporary = nested.filter(region => TEMPORARY.includes(region.under.at(-1)));
  const unfolding = nested.filter(region => region.under.some(reader => HISTORICAL.includes(reader)) && !TEMPORARY.includes(region.under.at(-1)));
  check(unfolding.length === 0, label + ': no view is born inside a historical proof; ' + JSON.stringify(unfolding));
  // №1915-5: the temporary views are explained by distinct temporary contents, never by re-unfolding one history —
  // each executed body of the content proof makes at most one view (its own overlay), and the executed bodies are
  // distinct (key, region, operation) identities by the repeat check above. The count is shown, never hidden.
  const contentBodies = TEMPORARY.reduce((sum, reader) => sum + (executions[reader] ?? 0), 0);
  // №1942-5: bodies the common mechanism refused to keep (an opaque view answering for foreign sources) and bodies derived
  // again after a changed answer (moved) are counted apart by reader — never hidden, never called repeats.
  const unreplayable = {};
  for (const attempt of sample.attempts) if (attempt.replayable === false) unreplayable[attempt.reader] = (unreplayable[attempt.reader] ?? 0) + 1;
  check(temporary.length <= contentBodies, label + ': every temporary view belongs to one executed content proof; views ' + temporary.length + ', bodies ' + contentBodies);
  const report = { label, ms, families, executions, keys, repeats: repeats.length, refusedRepeats: refusedRepeats.length, movedRepeats: movedRepeats.length,
    refinedRepeats: refinedRepeats.length, cycles: sample.cycles.length, scopes: sample.scopes.size, regions: born.length, nested, temporary: temporary.length,
    contentBodies, unreplayable, origins: born, violations, reads: sample.reads, misses: [...sample.misses.values()].reduce((sum, count) => sum + count, 0) };
  reports.push(report); samples.set(label, sample);
  return { result, sample, report };
}
function cloneStore(database, label) {
  const copy = join(config.directory, label + '.sqlite'); copyFileSync(database, copy);
  const store = new Store(copy); stores.push(store); paths.set(store, copy); return store;
}
const same = (a, b) => canonical(a) === canonical(b);
const t = { after: action => cleanups.push(action) };
`;
const ladderScenario = scenarioHeader + monitorHead + String.raw`
register(config.loader, { data: { root: config.dist, repository: config.repository } });
const imports = name => import(config.dist + 'src/' + name + '.js');
const { canonical, hashJson } = await imports('canonical');
const { Store } = await imports('storage/store');
const { reference } = await imports('pipeline/contracts');
const { withHistoricalReads } = await imports('om/input');
const { journalId, readJournalAt } = await imports('om/refusal-journal');
const { writeAnswersRegistration, writeAnswersEvaluation } = await imports('om/answers-gate');
const { writeQuestionPacket, readQuestionPacket } = await imports('om/question-packet');
const { runModelCall, readCompletionWorkAt } = await imports('om/model-call');
const { assessFact, readAssessmentRefusalAt } = await imports('om/assessment');
const { writeRoutes } = await imports('om/routes');
const { openAttempt, closeAttempt } = await imports('om/repeat-gate');
const { completionWorkId, readCompletionBinding, resumeSeries, ownerDecisionNamespace, OWNER_DECISION_KIND } = await imports('om/series');
const g4b = await import(config.dist + 'test/om-answers-gate.test.js');
` + monitorTail + String.raw`
try {
  const f = g4b.fixture(t, 'repository-fact'), project = f.project;
  const m = g4b.registered(f, 's11'), fact = g4b.factGap(f), batch = m.batch, seriesId = m.series.id;
  const goal = m.series.value.attempts[0].goal;
  const addresses = new Set(batch.items.flatMap(item => [item.target, item.gap]));
  const steps = [], trace = join(f.root, 's11-trace.jsonl');
  const assessor = verdict => ({ research: { verdict, reasons: verdict === 'supported' ? [] : ['source not decisive'] }, usage: g4b.traceUsage });
  // The adapter fixture answers request k with step k: the scenario grows with every paid call of every attempt.
  async function pay(packet, verdict) {
    steps.push(m.answer, assessor(verdict)); writeFileSync(m.scenario, JSON.stringify({ database: f.store.path, steps }));
    const original = ok(await runModelCall(f.store, { project, packet: reference(packet), dispatch: m.dispatch, role: 'implementer' }));
    assert.equal(original.outcome?.kind, 'fact-candidates');
    const terminal = ok(await assessFact(f.store, { project, modelCall: reference(original.record), questionId: batch.items[0].gap, dispatch: m.dispatch }));
    assert.equal(terminal.value.verdict, verdict);
    return terminal;
  }
  const bindingOf = (series, attempt) => { const binding = ok(readCompletionBinding(f.store, project, reference(series), attempt)); assert.ok(binding); return binding; };
  const headOf = binding => f.store.get(completionWorkId(project, binding.id));
  const journalHead = () => reference(f.store.get(journalId(project)));
  const seriesValue = () => f.store.get(seriesId).value;
  const completion = { routes: reference(f.route), batches: [batch.id] };
  function openNext(attempt) {
    const series = ok(openAttempt(f.store, { project, block: f.block, line: 1, attempt, goal, completion }));
    const binding = bindingOf(series, attempt);
    ok(writeAnswersRegistration(f.store, { project, binding: reference(binding) }));
    const request = { project, routes: reference(f.route), batch: batch.id, environment: reference(m.config), attempt: { series: reference(series), ordinal: attempt }, previous: [] };
    const packet = measured('writeQuestionPacket.' + attempt, () => ok(writeQuestionPacket(f.store, request)).record).result;
    return { series, binding, packet };
  }
  // E2.2 (№1801, row 2): the packet stands on the journal holding every refusal the latest preceding attempt of the same
  // goal claimed, and delivers the genuine E5 causes among them at the exact question address the common E5 reader
  // proves — the row, its code, the question's target and field, and the E5 remedy — never the G4b rows beside them
  // (row 9) and never a row matched by its goal text alone (№1792). The expectation is derived here from the E5 records
  // themselves, not from E2: the two must agree.
  function expectedRefusals(attempt, packet) {
    const series = seriesValue();
    const prior = [...series.inherited, ...series.attempts].filter(item => item.ordinal < attempt && same(item.goal, goal)).at(-1);
    assert.ok(prior && prior.outcome && prior.outcome.refusals.length, 'The preceding attempt ended with real refusals');
    assert.ok(packet.value.journal, 'The packet names the journal its preceding refusals stand in');
    const rows = f.store.get(packet.value.journal.id, packet.value.journal.revision).value.rows;
    const named = prior.outcome.refusals.map(link => rows.find(row => row.id === link.row));
    assert.ok(named.every(Boolean) && named.every(row => row.gate === 'E5'), 'The named journal holds every claimed refusal of the preceding attempt, all genuine E5');
    assert.ok(rows.some(row => row.gate === 'G4b'), 'The named journal holds the delivered G4b rows');
    const expected = named.map(row => {
      const proof = ok(readAssessmentRefusalAt(f.store, project, row.source));
      assert.equal(proof.intent.attempt, prior.ordinal, 'The E5 verdict belongs to the preceding attempt');
      assert.ok(row.remedy.includes(proof.intent.question.target + '/' + proof.intent.question.field) && row.remedy.includes('source not decisive'),
        'The remedy is the E5 reader\'s own text with its reasons');
      assert.ok(addresses.has(proof.intent.question.target), 'The question of the verdict is one of this batch');
      return { row: row.id, code: row.code, target: proof.intent.question.target, field: proof.intent.question.field, remedy: row.remedy };
    });
    return expected.sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
  }
  const attempts = [];
  let current = { series: m.series, binding: m.binding, packet: m.packet };
  for (const attempt of [1, 2, 3]) {
    if (attempt > 1) {
      current = openNext(attempt);
      assert.deepEqual(current.packet.value.packet.refusals, expectedRefusals(attempt, current.packet),
        'Attempt ' + attempt + ' carries exactly the refusals of the preceding attempt of its goal');
      measured('readQuestionPacket.' + attempt, () => assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(current.packet) })), current.packet));
    }
    const terminal = await pay(current.packet, 'insufficient');
    const work = ok(readCompletionWorkAt(f.store, project, reference(headOf(current.binding))));
    assert.equal(work.refusals.length, 1, 'The genuine negative E5 is the one claimed refusal of the open work');
    const close = { project, block: f.block, line: 1, attempt, outcome: { reason: 'refused', accepting: [], cancelling: [], refusals: [...work.refusals] } };
    const request = { project, binding: reference(current.binding),
      request: { ...f.request, results: [{ gap: reference(fact), result: reference(terminal), candidate: null }] }, close };
    const written = measured('writeAnswersEvaluation.' + attempt, () => ok(writeAnswersEvaluation(f.store, request))).result;
    assert.equal(written.repeated, false); assert.ok(written.closed, 'The linked close closes the attempt');
    assert.equal(seriesValue().attempts.find(item => item.ordinal === attempt).outcome.reason, 'refused');
    const journal = journalHead();
    assert.ok(f.store.get(journal.id, journal.revision).value.rows.some(row => row.gate === 'G4b'), 'G4b rows are delivered to the journal');
    attempts.push({ attempt, packet: current.packet, binding: reference(current.binding), evaluation: reference(written.evaluation), journal, work: reference(headOf(current.binding)) });
  }
  // A3: the third attempt without progress stops the series; no attempt opens past the standing stop.
  const stopped = seriesValue();
  assert.deepEqual([stopped.stop?.attempt, stopped.stop?.attempts], [3, [1, 2, 3]]);
  const held = openAttempt(f.store, { project, block: f.block, line: 1, attempt: 4, goal, completion });
  assert.equal(held.ok ? 'opened' : held.refusal.code, 'series_stopped');
  // Fixed real history: 1, 2 and 4 exact reads inside one operation, then a new operation and a new Store.
  f.restart();
  const third = attempts[2], fixed = cloneStore(f.path, 'fixed-history');
  const readPacket = store => ok(readQuestionPacket(store, { project, record: reference(third.packet) }));
  const readJournal = store => ok(readJournalAt(store, project, third.journal));
  const repeats = (label, size, read) => measured(label + '.' + size, () => { let value = null; for (let index = 1; index < size; index += 1) value = read(); return value; });
  const cold = withHistoricalReads(() => {
    const first = measured('fixed.readQuestionPacket.1', () => readPacket(fixed));
    assert.deepEqual(first.result, third.packet);
    // NR1 (№3591): a saved packet is read as written — its history (E2 derivation, preceding refusals) is not derived again.
    for (const family of ['E2.derive', 'E2.refusals']) assert.equal(first.report.families[family] ?? 0, 0, 'The cold packet read does not derive ' + family);
    // One exact read, or none when the read saved with the database (PF4) serves it.
    assert.ok((first.report.executions['E2.question-packet'] ?? 0) <= 1, 'The cold packet read is one exact read: ' + JSON.stringify(first.report.executions));
    assert.deepEqual(Object.keys(first.report.executions).filter(reader => reader !== 'E2.question-packet'), [], 'The cold packet read proves nothing else');
    // NR1: at most the one region of the real Store — none when the read saved with the database (PF4) serves it.
    assert.ok(first.report.regions - first.report.temporary <= 1, 'A read on the real Store proves in at most one region: ' + JSON.stringify(first.report.origins));
    for (const size of [2, 4]) {
      const again = repeats('fixed.readQuestionPacket', size, () => readPacket(fixed));
      assert.deepEqual(again.result, third.packet);
      assert.equal(again.report.misses, 0, size + ' reads: no proof body runs again inside the operation');
      assert.deepEqual(again.report.families, {}, size + ' reads: no derivation body runs again');
      assert.deepEqual(again.report.reads.unfold, { exact: 0, head: 0, list: 0, history: 0 }, size + ' reads: the added reads only check the footprint');
    }
    return first;
  });
  withHistoricalReads(() => {
    const first = measured('fixed.readJournalAt.1', () => readJournal(fixed));
    assert.deepEqual(reference(first.result), third.journal);
    // NR1 (№3591): the exact revision is read as written; its earlier revisions are not proved again (each key at most once).
    assert.equal(first.report.executions['A2.readJournalAt'] ?? 0, first.report.keys['A2.readJournalAt'] ?? 0,
      'Every exact journal key is read at most once: ' + JSON.stringify([first.report.executions, first.report.keys]));
    assert.ok((first.report.keys['A2.readJournalAt'] ?? 0) <= 1, 'Only the exact journal revision is read: ' + JSON.stringify(first.report.keys));
    for (const size of [2, 4]) {
      const again = repeats('fixed.readJournalAt', size, () => readJournal(fixed));
      assert.deepEqual(again.result, first.result);
      assert.equal(again.report.misses, 0); assert.deepEqual(again.report.families, {});
      assert.deepEqual(again.report.reads.unfold, { exact: 0, head: 0, list: 0, history: 0 });
    }
  });
  const external = measured('fixed.readQuestionPacket.external', () => readPacket(fixed));
  // S1.3 (№2185-4): a new operation of the same Store reuses the kept complete proofs instead of proving history again.
  assert.deepEqual(external.result, cold.result);
  // NR1: the saved packet is one exact read, kept with the Store and saved with the database (PF4) — a new operation and a
  // reopened Store run at most that one read again and never its history.
  assert.ok(external.report.misses <= cold.report.misses, 'A new operation of the same Store reuses its kept proofs: ' + external.report.misses + ' of ' + cold.report.misses);
  const reopened = new Store(paths.get(fixed)); stores.push(reopened);
  const restarted = measured('fixed.readQuestionPacket.restart', () => readPacket(reopened));
  assert.deepEqual(restarted.result, cold.result);
  for (const family of ['E2.derive', 'E2.refusals']) assert.equal(restarted.report.families[family] ?? 0, 0, 'A reopened Store does not derive ' + family);
  assert.equal(hashJson(restarted.result.value), third.packet.hash);
  // A6: the owner's decision continues the series; attempt 4 carries the refusals of attempt 3, pays its own calls and ends with a result.
  const decision = f.store.write({ id: ownerDecisionNamespace(project) + 's11-go-on', kind: OWNER_DECISION_KIND, expected: 0,
    value: { projectId: project, block: f.block, stop: 3, goals: [...stopped.stop.goals], decided: 'go on: one more window after the three refused attempts',
      taken: { by: 'the owner', through: 'the command API', approved: true } } });
  ok(resumeSeries(f.store, { project, block: f.block, line: 1, stop: 3, ground: 'owner-decision', text: 'the owner decided to go on', decision: { ref: reference(decision) } }));
  const fourth = openNext(4);
  assert.deepEqual(fourth.packet.value.packet.refusals, expectedRefusals(4, fourth.packet));
  measured('readQuestionPacket.4', () => assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(fourth.packet) })), fourth.packet));
  const supported = await pay(fourth.packet, 'supported');
  assert.ok(supported.value.accepted, 'The supported E5 accepts the answer (D5)');
  // The accepted answer moves M6: the evaluation names the successor route, as the accepted producers require.
  const later = ok(writeRoutes(f.store, { project, gaps: f.request.gaps, tasks: f.route.value.routes.filter(row => row.task).map(row => ({ record: row.task })),
    catalog: { paths: [], records: [] }, previous: reference(f.route) }));
  measured('writeAnswersEvaluation.4', () => ok(writeAnswersEvaluation(f.store, { project, binding: reference(fourth.binding),
    request: { ...f.request, routes: reference(later), results: [{ gap: reference(fact), result: supported.value.accepted, candidate: null }] } })));
  ok(closeAttempt(f.store, { project, block: f.block, line: 1, attempt: 4, outcome: { reason: 'result', accepting: [supported.value.accepted], cancelling: [], refusals: [] } }));
  assert.equal(seriesValue().attempts.find(item => item.ordinal === 4).outcome.reason, 'result');
  assert.equal(f.store.list('model-call').length, 8, 'Four attempts paid two calls each: nothing already executed was paid again');
  assert.equal(readFileSync(trace, 'utf8').split('\n').filter(Boolean).length, 8);
  // Growth: the regions of one evaluation do not multiply with the attempt, and an early key unfolds at most once per region.
  const evaluation = attempt => reports.find(report => report.label === 'writeAnswersEvaluation.' + attempt);
  assert.equal(evaluation(3).regions, evaluation(2).regions, 'The same evaluation on a longer history touches the same number of regions');
  // The early foundations — the journal, evaluation and work of attempt 1 and the journal of attempt 2 — are reached
  // by later attempts through several paths; each unfolds at most once per region, and the total is shown.
  const earlyKeys = [attempts[0].journal, attempts[0].evaluation, attempts[0].work, attempts[1].journal].map(ref => canonical(ref));
  const unfoldings = [];
  for (const report of reports) if (/^(writeAnswersEvaluation|writeQuestionPacket|readQuestionPacket)\.[234]$/.test(report.label)) {
    const sample = samples.get(report.label);
    unfoldings.push({ label: report.label, early: earlyKeys.map(key => {
      const found = sample.attempts.filter(attempt => canonical(attempt.key.ref) === key);
      const why = attempt => attempt.refused ? 'refused' : attempt.invalidated ? 'moved' : attempt.refined ? 'refined' : attempt.replayable === false ? 'unreplayable' : 'plain';
      const reasons = {};
      for (const attempt of found) reasons[why(attempt)] = (reasons[why(attempt)] ?? 0) + 1;
      return { key: JSON.parse(key).id + '@' + JSON.parse(key).revision, unfoldings: found.length, regions: new Set(found.map(attempt => attempt.view)).size,
        plain: reasons.plain ?? 0, reasons };
    }) });
  }
  // Unfoldings over unchanged dependencies: at most one per region; a refinement to a complete trace, a moved footprint,
  // a refusal or an unreplayable view are shown beside it, never hidden inside the same number.
  for (const row of unfoldings) for (const item of row.early)
    assert.ok(item.plain <= Math.max(item.regions, 1), row.label + ': an early key unfolds at most once per region over unchanged dependencies; ' + JSON.stringify(item));
  f.restart();
  const database = join(config.directory, 'ladder.sqlite'); copyFileSync(f.path, database);
  console.log(JSON.stringify({ reports, unfoldings, database, journal: third.journal, project,
    cross: crossOperation(['D1.materialize', 'D1.readGaps', 'B1.readOmInput', 'C2.frameBasis', 'C2.frameDerive', 'C5.layerBasis', 'M6.route-result', 'A3.series-history', 'G7.completion-work', 'E2.question-packet']) }));
} finally {
  active = null;
  for (const store of stores) store.close();
  for (const action of cleanups.reverse()) action();
}
`;

// S1.1 (№1773 §1): a process that imports the journal alone stays closed — no input, packet, gate or engine module is
// loaded, no executor and no reader are registered, and a G4b source is refused by its reader's absence. The optional
// executor changes cost only: the same derivation gives the same refusal with and without one, once registered it is a
// repeat, and another one or a non-function is a typed defect.
const graphHooks = String.raw`
import { appendFileSync } from 'node:fs';
let log;
export function initialize(data) { log = data.log; }
export async function resolve(specifier, context, next) { const resolved = await next(specifier, context); appendFileSync(log, resolved.url + '\n'); return resolved; }
`;
const aloneScript = String.raw`
const [dist, database, project, journalRef] = process.argv.slice(2);
const journal = await import(dist + 'src/om/refusal-journal.js');
const { Store } = await import(dist + 'src/storage/store.js');
const store = new Store(database);
try {
  const ref = JSON.parse(journalRef);
  const alone = journal.readJournalAt(store, project, ref);
  let executed = 0;
  const passthrough = (source, key, action) => { executed++; return action(source); };
  journal.registerJournalProofExecutor(passthrough);
  const registered = journal.readJournalAt(store, project, ref);
  journal.registerJournalProofExecutor(passthrough);
  const code = attempt => { try { attempt(); return null; } catch (error) { return error.code ?? String(error); } };
  console.log(JSON.stringify({ exported: typeof journal.registerJournalProofExecutor, alone, registered, executed,
    conflict: code(() => journal.registerJournalProofExecutor(() => null)), malformed: code(() => journal.registerJournalProofExecutor('executor')) }));
} finally { store.close(); }
`;

test('S1.1 a real block ladder 1/2/3 with G4b deliver all reaches A3 and resumes; historical proofs cost by exact keys, not by paths', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'omg-s11-ladder-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const loaderFile = join(directory, 'proof-loader.mjs'), script = join(directory, 'ladder.mjs');
  const hooks = join(directory, 'graph-hooks.mjs'), alone = join(directory, 'alone.mjs'), graph = join(directory, 'graph.log');
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const dist = pathToFileURL(fileURLToPath(new URL('../', import.meta.url))).href;
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const configuration = JSON.stringify({ directory, repository, dist, loader: pathToFileURL(loaderFile).href });
  writeFileSync(loaderFile, loader.replace('TYPESCRIPT', JSON.stringify(typescript)));
  writeFileSync(script, ladderScenario.replace('CONFIG', configuration));
  writeFileSync(hooks, graphHooks); writeFileSync(alone, aloneScript);
  const result = await promisify(execFile)(process.execPath, [script], { maxBuffer: 64 * 1024 * 1024 });
  const output = result.stdout.trim().split('\n').at(-1);
  assert.ok(output);
  const ladder = JSON.parse(output) as { reports: { label: string; executions: Record<string, number>; families: Record<string, number>; regions: number;
    nested: unknown[]; repeats: number }[]; unfoldings: unknown[]; database: string; journal: { id: string; revision: number; hash: string }; project: string };
  const labels = ladder.reports.map(report => report.label);
  for (const attempt of [2, 3, 4]) for (const kind of ['writeQuestionPacket', 'readQuestionPacket', 'writeAnswersEvaluation'])
    assert.ok(labels.includes(kind + '.' + attempt), 'The ladder measured ' + kind + '.' + attempt);
  const evaluated = [...new Set(ladder.reports.filter(report => report.label.startsWith('writeAnswersEvaluation.')).flatMap(report => Object.keys(report.executions)))].sort();
  // NR1: the saved packet of the attempt is read as written once, before its evaluation (kept since), not inside it.
  for (const reader of ['A2.readJournalAt', 'G4b.refusal', 'G4b.finding', 'G4b.evaluation', 'G7.completion-work'])
    assert.ok(ladder.reports.some(report => report.label.startsWith('writeAnswersEvaluation.') && (report.executions[reader] ?? 0) > 0), 'The real evaluation reached ' + reader + ': ' + JSON.stringify(evaluated));
  for (const family of ['G4b.groups', 'G7.snapshot'])
    assert.ok(ladder.reports.some(report => (report.families[family] ?? 0) > 0), 'The ladder reached ' + family);
  // NR1 (№3591): a saved packet is read as written — the historical E2 derivation and its preceding refusals never run.
  for (const family of ['E2.derive', 'E2.refusals']) assert.ok(ladder.reports.every(report => !((report.families[family] ?? 0) > 0)), 'No saved packet is derived again: ' + family);
  assert.ok(ladder.reports.every(report => report.repeats === 0));
  for (const row of ladder.reports) t.diagnostic(JSON.stringify(row));
  for (const row of ladder.unfoldings) t.diagnostic(JSON.stringify(row));
  const cross = (ladder as unknown as { cross: Record<string, { executions: number; identities: number; served: number; moved: number; repeated: number }> }).cross;
  t.diagnostic('cross ' + JSON.stringify(cross));
  // S1.3 (№2185-4, №2201): across all operations of the ladder a complete exact proof of D1/B1/C2 is derived once per
  // Store — never again in a later operation while its footprint is current. On the base (a0957fa) the same ladder derives
  // them again: D1.materialize 45 bodies for 35 identities, B1.readOmInput 90 for 70, C2.frame* 45 for 35.
  // NR1: D1 is not materialized from saved records any more; what is still read is read once per exact key and Store.
  assert.ok(cross['B1.readOmInput'] && cross['B1.readOmInput'].executions > 0, 'The ladder read B1');
  for (const reader of ['D1.materialize', 'D1.readGaps', 'B1.readOmInput', 'C2.frameDerive', 'C2.frameBasis']) {
    if (!cross[reader]) continue;
    assert.equal(cross[reader].repeated, 0, reader + ': one derivation per exact key and Store across operations: ' + JSON.stringify(cross[reader]));
  }
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hooks).href)}, { data: { log: ${JSON.stringify(graph)} } });`;
  const isolated = await promisify(execFile)(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, alone,
    dist, ladder.database, ladder.project, JSON.stringify(ladder.journal)], { maxBuffer: 16 * 1024 * 1024 });
  const loaded = readFileSync(graph, 'utf8').split('\n').filter(Boolean);
  assert.ok(loaded.some(url => url.endsWith('/src/om/refusal-journal.js')));
  for (const module of ['src/om/input.js', 'src/om/question-packet.js', 'src/om/answers-gate.js', 'src/om/model-call.js', 'src/product/engine.js'])
    assert.ok(!loaded.some(url => url.endsWith('/' + module)), 'The journal alone does not load ' + module);
  const closed = JSON.parse(isolated.stdout.trim().split('\n').at(-1)!) as { exported: string; alone: { ok: boolean; refusal?: { code: string; message: string; at: { field?: string } } };
    registered: unknown; executed: number; conflict: string | null; malformed: string | null };
  assert.equal(closed.exported, 'function');
  // NR1 (№3591): a saved journal is read as written — its G4b rows are not derived again, so the journal module alone reads
  // it without their typed reader (C36 guarded that derivation on reading).
  assert.equal(closed.alone.ok, true, 'A saved journal holding G4b rows reads as written without their typed reader');
  assert.deepEqual(closed.registered, closed.alone, 'The executor changes the cost of a repeat, never the derivation, its value or its refusal');
  assert.deepEqual([closed.executed, closed.conflict, closed.malformed], [1, 'journal_proof_conflict', 'journal_request_invalid']);
});

// S1.1 (№1787-3/4, №1817, №1831): the mixed scenarios on the accepted H1 pass. Every transition of the pass is one measured
// operation named after the producer the pass chose; the substantive outcomes of R4/R5 are asserted, and the history saved
// by the earlier attempts is read again after the journal head moved — in a new operation and after a restart.
const passDriver = String.raw`
const project = h1.project;
/** A negative reply of the model for the exact saved packet of a node expansion: nothing is invented for its questions. */
const cannotExpand = (f, step) => {
  const saved = step.request.packet, packet = f.store.get(saved.id, saved.revision);
  return { research: { protocol: '$answerProtocol', requestId: '$requestId', questionIds: packet.value.packet.questions.map(item => item.id),
    action: 'cannot_answer', reason: 'The requested expansion is unavailable' }, usage: h1.usage };
};
function pass(f, request, prefix) {
  let n = 0;
  const performed = [], transitions = [];
  async function advance() {
    const label = prefix + '#' + String(++n).padStart(2, '0');
    const progress = attempt => {
      const readers = {}, refused = {}, unreplayable = {}, viewsOf = {};
      for (const item of active.attempts) {
        readers[item.reader] = (readers[item.reader] ?? 0) + 1;
        if (item.refused) refused[item.reader] = (refused[item.reader] ?? 0) + 1;
        if (item.replayable === false) unreplayable[item.reader] = (unreplayable[item.reader] ?? 0) + 1;
        viewsOf[item.reader] = viewsOf[item.reader] ?? {}; viewsOf[item.reader][item.view] = (viewsOf[item.reader][item.view] ?? 0) + 1;
      }
      const top = Object.entries(readers).sort((a, b) => b[1] - a[1])[0]?.[0];
      // Where the unreplayable proofs live: their regions and the birth of each (the edge that made the region opaque).
      const opaque = {};
      for (const item of active.attempts) if (item.replayable === false) opaque[item.view] = (opaque[item.view] ?? 0) + 1;
      const opaqueRegions = Object.entries(opaque).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([view, count]) => {
        const region = regions.get(Number(view)); return { view: Number(view), count, proxy: region?.proxy, first: region?.first, under: region?.under, at: region?.at }; });
      const nested = [...active.regions].map(view => regions.get(view)).filter(region => region.under.length);
      appendFileSync(process.env.S11_LOG || join(config.directory, 'transitions.ndjson'), JSON.stringify({ progress: label, misses: active.attempts.length,
        scopes: active.scopes.size, regions: active.regions.size, nested: nested.length, born: nested.slice(0, 12).map(region => region.first + ' < ' + region.under.join(' < ')),
        readers: Object.entries(readers).sort((a, b) => b[1] - a[1]).slice(0, 12), refused: Object.entries(refused).sort((a, b) => b[1] - a[1]).slice(0, 6),
        unreplayable: Object.entries(unreplayable).sort((a, b) => b[1] - a[1]).slice(0, 6), topViews: top ? viewsOf[top] : {}, opaqueRegions,
        last: attempt.reader + ' < ' + attempt.chain.map(key => key.reader).join(' < '),
        heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) }) + '\n');
    };
    const { result, report } = await measuredAsync(label, () => { active.progress = progress; return advanceRun(f.store, request); });
    const advanced = ok(result), state = advanced.record.value.state;
    report.action = advanced.performed ? advanced.performed.action + (advanced.performed.attempt === null ? '' : '@' + advanced.performed.attempt) : null;
    report.series = advanced.performed ? advanced.performed.series : null;
    report.phase = state.phase === 'step' ? 'step:' + state.step.action : state.phase === 'waiting' ? 'waiting:' + state.wait.code : state.phase;
    if (advanced.performed) performed.push(advanced.performed.action);
    transitions.push(report);
    // Every transition is written as it happens: a long run shows its cost while it runs, and a stopped one keeps its part.
    appendFileSync(process.env.S11_LOG || join(config.directory, 'transitions.ndjson'), JSON.stringify({ label: report.label, action: report.action, series: report.series,
      phase: report.phase, ms: report.ms, misses: report.misses, scopes: report.scopes, regions: report.regions, nested: report.nested.length,
      cycles: report.cycles, repeats: report.repeats, refined: report.refinedRepeats, violations: report.violations.length,
      keys: Object.values(report.keys).reduce((sum, count) => sum + count, 0), reads: report.reads,
      temporary: report.temporary, contentBodies: report.contentBodies, moved: report.movedRepeats,
      unreplayable: Object.entries(report.unreplayable).sort((a, b) => b[1] - a[1]).slice(0, 8),
      topRegions: report.origins.filter(region => !region.under.length).map(region => ({ view: region.view, first: region.first, proxy: region.proxy })),
      bodies: Object.entries(report.executions).sort((a, b) => b[1] - a[1]).slice(0, 14),
      distinctKeys: Object.entries(report.keys).sort((a, b) => b[1] - a[1]).slice(0, 14),
      born: report.nested.slice(0, 24).map(region => region.first + ' < ' + region.under.join(' < ')) }) + '\n');
    // A diagnostic run may stop after a named transition to inspect its cost without paying for the rest.
    if (process.env.S11_STOP_AFTER === label) throw new Error('stopped after ' + label + ' by S11_STOP_AFTER');
    return { advanced, state };
  }
  /** Advances until the pass has SAVED the given action (chosen, not yet performed), returning the saved step. */
  async function until(action, bound = 30) {
    for (let index = 0; index < bound; index++) {
      const { state } = await advance();
      if (state.phase === 'step' && state.step.action === action) return state.step;
      if (state.phase === 'waiting') assert.fail('The pass waited before choosing ' + action + ': ' + state.wait.code);
    }
    assert.fail('The pass did not choose ' + action + ' within ' + bound + ' transitions: ' + performed.join(','));
  }
  /** Advances until the pass waits. */
  async function drive(bound = 30) {
    for (let index = 0; index < bound; index++) {
      const { advanced, state } = await advance();
      if (state.phase === 'waiting') return { wait: state.wait, record: advanced.record };
    }
    assert.fail('The pass did not reach a wait within ' + bound + ' transitions: ' + performed.join(','));
  }
  /** Advances until the given number of closes, restarting after each D2 event (the window H1 proves). */
  async function closes(count, bound = 40) {
    const after = [];
    for (let index = 0; index < bound && after.filter(action => action === 'close').length < count; index++) {
      const { advanced, state } = await advance();
      if (advanced.performed) { after.push(advanced.performed.action); if (advanced.performed.action === 'confirm') f.restart(); }
      if (state.phase === 'waiting') assert.fail('The pass waited before ' + count + ' closes: ' + state.wait.code + ' after ' + after.join(','));
    }
    return after;
  }
  return { advance, until, drive, closes, performed, transitions, retarget(next) { request = next; } };
}
/** The saved history of an attempt read again: cold in a new Store, hot inside one operation, kept by the next one, and
 * cold again after a restart. The Store that wrote it keeps its complete proofs (S1.3, S1.4 №2302), so cold is a new Store. */
function rereadPacket(f, prefix, ref) {
  const read = store => ok(readQuestionPacket(store, { project, record: ref }));
  const saved = f.store.get(ref.id, ref.revision);
  f.restart();
  const cold = measured(prefix + '.packet.cold', () => read(f.store));
  assert.equal(cold.result.hash, saved.hash);
  // NR1 (№3591): the saved packet is read as written, and its read is kept with the Store (PF4 saved proofs) — a reopened
  // Store may take it without running a proof body, so the cold read has at most the one region of the real Store.
  assert.ok(cold.report.regions - cold.report.temporary <= 1, 'A read on the real Store proves in at most one region: ' + JSON.stringify(cold.report.origins));
  const hot = withHistoricalReads(() => { read(f.store); return measured(prefix + '.packet.hot', () => read(f.store)); });
  assert.deepEqual(hot.result, cold.result); assert.equal(hot.report.misses, 0);
  assert.deepEqual(hot.report.reads.unfold, { exact: 0, head: 0, list: 0, history: 0 });
  if (saved.value.journal) {
    const journal = measured(prefix + '.journal.cold', () => ok(readJournalAt(f.store, project, saved.value.journal)));
    assert.deepEqual(reference(journal.result), saved.value.journal);
    assert.equal(journal.report.executions['A2.readJournalAt'], journal.report.keys['A2.readJournalAt'], 'every exact journal key proves once');
  }
  const kept = measured(prefix + '.packet.kept', () => read(f.store));
  assert.deepEqual(kept.result, cold.result);
  assert.ok(kept.report.misses <= cold.report.misses, 'The next operation of the unchanged Store is served by its kept proofs: ' + kept.report.misses);
  f.restart();
  const restarted = measured(prefix + '.packet.restart', () => read(f.store));
  assert.deepEqual(restarted.result, cold.result);
  return cold;
}
`;

const mixedN2Scenario = scenarioHeader + monitorHead + String.raw`
register(config.loader, { data: { root: config.dist, repository: config.repository } });
const imports = name => import(config.dist + 'src/' + name + '.js');
const { canonical, hashJson } = await imports('canonical');
const { Store } = await imports('storage/store');
const { reference } = await imports('pipeline/contracts');
const { withHistoricalReads } = await imports('om/input');
const { journalId, readJournalAt } = await imports('om/refusal-journal');
const { readQuestionPacket } = await imports('om/question-packet');
const { startRun, advanceRun } = await imports('om/run');
const h1 = await import(config.dist + 'test/om-run-fixture.js');
` + monitorTail + passDriver + String.raw`
const outcomes = {};
try {
  // ---- R4: one N2 frame of two blocks — A positive, B1 negative, B2 positive. ----
  const f = h1.runFixture(t, [], false);
  const bases = f.bases('s11-n2'), p = pass(f, f.request(bases), 'n2');
  ok(startRun(f.store, { project }));
  const answers = [];
  const first = await p.until('cycle');
  answers.push(h1.nodeAnswer(f, first)); f.steps(answers);
  const second = await p.until('cycle', 30);
  assert.notEqual(second.series, first.series, 'The pass moved on to the other block');
  const aSeries = first.series, bSeries = second.series;
  answers.push(cannotExpand(f, second)); f.steps(answers);
  const third = await p.until('cycle', 30);
  assert.deepEqual([third.series, third.attempt], [bSeries, 2], 'B is worked again in its second attempt');
  const b1 = f.store.get(bSeries).value.attempts[0];
  assert.equal(b1.outcome.reason, 'refused'); assert.ok(b1.outcome.refusals.length, 'B1 closed negatively with its refusal journalled');
  assert.equal(f.store.get(aSeries).value.attempts.length, 1, 'A keeps its one open attempt');
  assert.equal(f.sent().length, 2, 'A and B1 paid one call each');
  const b2Packet = f.store.get(third.request.packet.id, third.request.packet.revision);
  assert.ok(b2Packet.value.journal, 'B2 stands on the journal holding the refusal of B1');
  answers.push(h1.nodeAnswer(f, third)); f.steps(answers);
  await p.until('accept', 40);
  assert.equal((await p.advance()).advanced.performed.action, 'accept');
  f.restart();
  // H1.1: after the common acceptance the pass builds its own bases (B3) instead of waiting for d2_bases, then closes.
  await p.until('bases', 5);
  assert.deepEqual(await p.closes(2), ['bases', 'confirm', 'close', 'confirm', 'close']);
  const aFinal = f.store.get(aSeries).value, bFinal = f.store.get(bSeries).value;
  assert.deepEqual(aFinal.attempts.map(item => item.outcome.reason), ['result'], 'A: one attempt, never paid again');
  assert.deepEqual(bFinal.attempts.map(item => item.outcome.reason), ['refused', 'result'], 'B1 stays closed negatively; B2 succeeded');
  assert.equal(f.store.history('om-frame:' + project + ':2').length, 1, 'One common acceptance (C5)');
  assert.equal(f.store.history('om-gap-lines:' + project + ':history').filter(row => row.value.request.closures.length).length, 2, 'A D2 event per original goal');
  const closes = p.transitions.filter(report => report.action && report.action.startsWith('close'));
  assert.equal(new Set(closes.map(report => report.series)).size, 2, 'Separate G7 closes of the two original attempts');
  assert.equal(f.sent().length, 3, 'A once, B1 once, B2 once — nothing was paid twice');
  outcomes.r4 = { a: aFinal.attempts.map(item => item.outcome.reason), b: bFinal.attempts.map(item => item.outcome.reason), calls: f.sent().length, performed: p.performed };
  // The earlier history read again after the journal head moved: B2's packet with the refusal of B1, cold, hot and restarted.
  rereadPacket(f, 'n2.b2', reference(b2Packet));
  // ---- R4, the branch "B stopped": three refusals of B stop it (A3), A6 reviews and decides; the pass continues B itself, A stays
  // open unpaid; B's fourth attempt succeeds and the common C5, D2 and separate G7 follow. (H1.2: an undecided review ends the pass on
  // the second rung, and a decision of the owner is no way to continue an autonomous pass — №1908.) ----
  const g = h1.runFixture(t, [], false);
  const stopBases = g.bases('s11-n2-stop'), q = pass(g, g.request(stopBases), 'n2s');
  ok(startRun(g.store, { project }));
  const replies = [];
  const ga = await q.until('cycle');
  replies.push(h1.nodeAnswer(g, ga)); g.steps(replies);
  const gb = await q.until('cycle', 30);
  assert.notEqual(gb.series, ga.series);
  replies.push(cannotExpand(g, gb)); g.steps(replies);
  const gb2 = await q.until('cycle', 30); assert.deepEqual([gb2.series, gb2.attempt], [gb.series, 2]);
  replies.push(cannotExpand(g, gb2)); g.steps(replies);
  const gb3 = await q.until('cycle', 30); assert.deepEqual([gb3.series, gb3.attempt], [gb.series, 3]);
  replies.push(cannotExpand(g, gb3), h1.stopAnswer(g, true)); g.steps(replies);
  // R4 (H1.2): B stands stopped after three refusals and the independent review of that exact stop DECIDED, so the pass itself
  // continues B (resumeSeries on the review record — no decision of the owner is made or needed, and an undecided review would
  // end the pass, which the om-run suite covers); the fourth attempt of B follows while A stays open and is not paid again.
  const gb4 = await q.until('cycle', 30); assert.deepEqual([gb4.series, gb4.attempt], [gb.series, 4]);
  const stopped = g.store.get(gb.series).value;
  assert.equal(stopped.stop, null, 'The decided review continued B after the stop of A3');
  assert.equal(stopped.continuations.length, 1); assert.equal(stopped.escalations.length, 0, 'A decided review escalates nothing');
  assert.deepEqual(stopped.attempts.slice(0, 3).map(item => item.outcome.reason), ['refused', 'refused', 'refused']);
  const aOpen = g.store.get(ga.series).value;
  assert.equal(aOpen.attempts.length, 1); assert.equal(aOpen.attempts[0].outcome, null, 'A stays open and is not paid again while B works');
  assert.equal(g.sent().length, 5, 'A once, B three times, one stop analysis');
  const b4Packet = g.store.get(gb4.request.packet.id, gb4.request.packet.revision);
  assert.ok(b4Packet.value.journal, 'B4 stands on the journal of the refused attempts');
  replies.push(h1.nodeAnswer(g, gb4)); g.steps(replies);
  await q.until('accept', 40);
  assert.equal((await q.advance()).advanced.performed.action, 'accept');
  g.restart();
  await q.until('bases', 5);
  assert.deepEqual(await q.closes(2), ['bases', 'confirm', 'close', 'confirm', 'close']);
  const aEnd = g.store.get(ga.series).value, bEnd = g.store.get(gb.series).value;
  assert.deepEqual(aEnd.attempts.map(item => item.outcome.reason), ['result']);
  assert.deepEqual(bEnd.attempts.map(item => item.outcome.reason), ['refused', 'refused', 'refused', 'result']);
  assert.equal(bEnd.continuations.length, 1);
  assert.equal(g.store.history('om-frame:' + project + ':2').length, 1, 'One common acceptance');
  assert.equal(g.sent().length, 6, 'A once, B four times, one stop analysis — nothing repaid');
  outcomes.r4stop = { a: aEnd.attempts.map(item => item.outcome.reason), b: bEnd.attempts.map(item => item.outcome.reason), calls: g.sent().length, performed: q.performed };
  rereadPacket(g, 'n2s.b4', reference(b4Packet));
  // Growth across the attempts of B: the packet of every later attempt costs by its keys, not by the number of earlier attempts.
  const packets = q.transitions.filter(report => report.action && report.action.startsWith('packet@') && report.series === gb.series);
  assert.ok(packets.length >= 4, 'B prepared four packets');
  for (const report of packets) assert.equal(report.cycles, 0);
  console.log(JSON.stringify({ reports, outcomes, packets: packets.map(report => ({ label: report.label, action: report.action, ms: report.ms, misses: report.misses,
    keys: Object.values(report.keys).reduce((sum, count) => sum + count, 0), regions: report.regions, refined: report.refinedRepeats })) }));
} finally {
  active = null;
  for (const store of stores) store.close();
  for (const action of cleanups.reverse()) action();
}
`;

const mixedWorksScenario = scenarioHeader + monitorHead + String.raw`
register(config.loader, { data: { root: config.dist, repository: config.repository } });
const imports = name => import(config.dist + 'src/' + name + '.js');
const { canonical, hashJson } = await imports('canonical');
const { Store } = await imports('storage/store');
const { reference } = await imports('pipeline/contracts');
const { withHistoricalReads } = await imports('om/input');
const { journalId, readJournalAt } = await imports('om/refusal-journal');
const { readQuestionPacket } = await imports('om/question-packet');
const { startRun, advanceRun } = await imports('om/run');
const h1 = await import(config.dist + 'test/om-run-fixture.js');
` + monitorTail + passDriver + String.raw`
try {
  // ---- R5: L3 produce → consume of the atomic seed with mixed outcomes: the consuming block's first work is refused,
  // nothing is invented for its goal, the producing block's positive result is kept, and its lawful second work completes the frame. ----
  const f = h1.worksFixture(t);
  const works = f.routes.value.batches.filter(row => row.level === 3 && row.task === 'node-expansion');
  const blocks = [...new Set(works.flatMap(row => row.items[0].consumers))];
  assert.ok(blocks.includes('garden-consume-block') && blocks.length > 1, 'Several blocks own works: ' + blocks.join(','));
  const p = pass(f, f.request, 'l3');
  ok(startRun(f.store, { project }));
  const answered = new Set();
  let refused = null, invented = null;
  const scenario = join(f.root, 'scenario.json');
  for (let index = 0; index < 200; index++) {
    const { advanced, state } = await p.advance();
    if (state.phase === 'step' && state.step.action === 'cycle' && !answered.has(state.step.request.packet.id)) {
      const saved = state.step.request.packet, packet = f.store.get(saved.id, saved.revision);
      const routed = f.store.get(packet.value.request.routes.id, packet.value.request.routes.revision).value;
      const batch = routed.batches.find(row => row.id === packet.value.request.batch), block = batch.items[0].consumers[0];
      answered.add(saved.id);
      f.answer(saved);
      if (block === 'garden-consume-block' && refused === null) {
        // The fixture wrote the lawful answer at this index; the model refuses instead.
        const steps = JSON.parse(readFileSync(scenario, 'utf8'));
        steps.steps[steps.steps.length - 1] = cannotExpand(f, state.step);
        writeFileSync(scenario, JSON.stringify(steps));
        refused = { packet: reference(packet), series: state.step.series, attempt: state.step.attempt };
      } else if (block === 'garden-consume-block' && invented === null) {
        // Before the consuming block's second work: nothing was filled in for its refused goal, the produce result stands.
        invented = { frames: f.store.history('om-frame:' + project + ':3').length, works: p.performed.filter(action => action === 'works').length,
          refusedOutcome: f.store.get(refused.series).value.attempts[0].outcome, packet: reference(packet), attempt: state.step.attempt };
        assert.deepEqual([invented.frames, invented.works, invented.refusedOutcome.reason, invented.attempt], [0, 0, 'refused', 2],
          'No works acceptance was invented for the refused goal; the consuming block is worked again in its second attempt');
        assert.ok(packet.value.journal, 'The second work stands on the journal of the refused first');
      }
    }
    if (advanced.performed && (advanced.performed.action === 'works' || advanced.performed.action === 'confirm')) f.restart();
    if (state.phase === 'waiting' || state.phase === 'complete') break;
    // Every block closes positively once; the consuming block's refused first work closed negatively before that.
    if (p.performed.filter(action => action === 'close').length === blocks.length + 1) break;
  }
  const count = action => p.performed.filter(item => item === action).length;
  assert.equal(count('works'), 1, 'One common works acceptance: ' + p.performed.join(','));
  assert.equal(count('cycle'), works.length + 1, 'Every works root paid once, plus the one refused work of the consuming block');
  assert.equal(count('confirm'), blocks.length, 'A D2 event per original goal: ' + p.performed.join(','));
  assert.equal(count('close'), blocks.length + 1, 'A G7 close per block, plus the negative close of the refused first work: ' + p.performed.join(','));
  const consume = h1.blockSeries(f, 'garden-consume-block').value, produce = h1.blockSeries(f, 'garden-produce-block').value;
  assert.deepEqual(consume.attempts.map(item => item.outcome.reason), ['refused', 'result'], 'The refused work stays closed negatively; the second succeeded');
  assert.deepEqual(produce.attempts.map(item => item.outcome.reason), ['result'], 'The producing block kept its one positive attempt');
  assert.equal(f.sent().length, works.length + 1, 'Nothing was paid twice');
  assert.equal(f.store.history('om-frame:' + project + ':3').length, 1);
  const outcomes = { consume: consume.attempts.map(item => item.outcome.reason), produce: produce.attempts.map(item => item.outcome.reason), calls: f.sent().length, performed: p.performed };
  rereadPacket(f, 'l3.consume2', invented.packet);
  console.log(JSON.stringify({ reports, outcomes, cross: crossOperation(['E2.works-proposal-content', 'E2.part-result', 'E4.part-assembly']) }));
} finally {
  active = null;
  for (const store of stores) store.close();
  for (const action of cleanups.reverse()) action();
}
`;

async function runScenario(t: import('node:test').TestContext, name: string, script: string) {
  const directory = mkdtempSync(join(tmpdir(), 'omg-s11-' + name + '-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const loaderFile = join(directory, 'proof-loader.mjs'), file = join(directory, name + '.mjs');
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const dist = pathToFileURL(fileURLToPath(new URL('../', import.meta.url))).href;
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  writeFileSync(loaderFile, loader.replace('TYPESCRIPT', JSON.stringify(typescript)));
  writeFileSync(file, script.replace('CONFIG', JSON.stringify({ directory, repository, dist, loader: pathToFileURL(loaderFile).href })));
  const result = await promisify(execFile)(process.execPath, [file], { maxBuffer: 64 * 1024 * 1024 });
  const output = result.stdout.trim().split('\n').at(-1);
  assert.ok(output);
  return JSON.parse(output) as { reports: { label: string; action?: string; ms: number; executions: Record<string, number>; families: Record<string, number>;
    regions: number; nested: unknown[]; repeats: number; cycles: number; misses: number }[]; outcomes: Record<string, unknown> };
}
function checkScenario(t: import('node:test').TestContext, run: Awaited<ReturnType<typeof runScenario>>) {
  assert.ok(run.reports.length > 10);
  assert.ok(run.reports.every(report => report.repeats === 0 && report.cycles === 0));
  for (const reader of ['E2.question-packet', 'A2.readJournalAt', 'G4b.answers', 'G7.completion-work'])
    assert.ok(run.reports.some(report => (report.executions[reader] ?? 0) > 0), 'The real pass reached ' + reader);
  assert.ok(run.reports.some(report => (report.families['G7.snapshot'] ?? 0) > 0), 'The real pass reached G7.snapshot');
  // NR1 (№3591): a saved packet is read as written — the historical E2 derivation and its preceding refusals never run.
  for (const family of ['E2.derive', 'E2.refusals']) assert.ok(run.reports.every(report => !((report.families[family] ?? 0) > 0)), 'No saved packet is derived again: ' + family);
  t.diagnostic(JSON.stringify(run.outcomes));
  for (const row of run.reports) t.diagnostic(JSON.stringify({ label: row.label, action: row.action, ms: row.ms, misses: row.misses, regions: row.regions, nested: row.nested,
    refined: (row as { refinedRepeats?: number }).refinedRepeats, executions: row.executions, families: row.families }));
}

test('S1.1 mixed N2 on the accepted H1 pass: A positive, B1 negative, B2 positive — and B stopped, reviewed (decided) and continued by the pass; history costs by exact keys', async t => {
  checkScenario(t, await runScenario(t, 'mixed-n2', mixedN2Scenario));
});

test('S1.1 L3 produce → consume on the accepted H1 pass with mixed outcomes: no invented filling for the refused goal, the positive result kept, the frame completed lawfully', async t => {
  const run = await runScenario(t, 'mixed-works', mixedWorksScenario);
  checkScenario(t, run);
  // PF4 (№3499 rows 21, 28): the work-part content reads its preview through an internal layer of its own key — over the
  // Store or a traced caller's trace of it — so the composite result is kept at its Store and later operations take it.
  // What is still derived again is derived over the pending writes of a current preparation (a layer over a layer) or an
  // opaque view, which §4 leaves outside: before PF4 this pass derived it 394 times for 51 keys (343 repeats).
  const cross = (run as unknown as { cross: Record<string, { executions: number; identities: number; served: number; moved: number; repeated: number }> }).cross;
  t.diagnostic(JSON.stringify(cross));
  const content = cross['E2.works-proposal-content'];
  assert.ok(content && content.executions > 0, 'The real pass reached the work-part content');
  // NR1 (№3591): the work-part content is the parse of a new answer — once per answer; a saved packet carrying it is read
  // as written, so later operations neither derive nor take it again.
  assert.equal(content.executions, content.identities, 'Each work-part content is parsed once: ' + JSON.stringify(content));
  assert.equal(content.repeated, 0, 'The work-part content is not derived again: ' + JSON.stringify(content));
});

// E2.2 (№1801, №1792): the causes of the preceding attempt reach the repeated packet by the exact chain attempt → claimed
// journal row → proved E5/E4 source → question address of this batch, never by the text of a goal. Both scenarios pay the
// real producers of the accepted fixture (MC1 with its E5 assessor, the MC2 node root with its cycle) and derive the
// expectation from the sources themselves, so E2 and its readers must agree with them.
const e22FactScenario = scenarioHeader + monitorHead + String.raw`
register(config.loader, { data: { root: config.dist, repository: config.repository } });
const imports = name => import(config.dist + 'src/' + name + '.js');
const { canonical } = await imports('canonical');
const { Store } = await imports('storage/store');
const { reference } = await imports('pipeline/contracts');
const { withHistoricalReads } = await imports('om/input');
const { journalId } = await imports('om/refusal-journal');
const { writeAnswersRegistration, writeAnswersEvaluation } = await imports('om/answers-gate');
const { writeQuestionPacket, readQuestionPacket, prepareQuestionPacket } = await imports('om/question-packet');
const { runModelCall, readCompletionWorkAt } = await imports('om/model-call');
const { assessFact, readAssessmentRefusalAt } = await imports('om/assessment');
const { openAttempt } = await imports('om/repeat-gate');
const { completionWorkId, readCompletionBinding } = await imports('om/series');
const g4b = await import(config.dist + 'test/om-answers-gate.test.js');
` + monitorTail + String.raw`
try {
  const f = g4b.fixture(t, 'repository-fact', true, true), project = f.project;
  const m = g4b.registered(f, 'e22'), batch = m.batch, seriesId = m.series.id;
  const goal = m.series.value.attempts[0].goal;
  assert.equal(batch.items.length, 2, 'One MC1 batch carries both fact questions of the block');
  const a = batch.items.find(item => item.target === f.target), b = batch.items.find(item => item.target !== f.target);
  assert.ok(a && b && b.target === 'discovery:other-choice');
  const steps = [];
  const assessor = verdict => verdict === 'off-form' ? { research: { answer: 'untyped reviewer reply' }, usage: g4b.traceUsage }
    : { research: { verdict, reasons: ['source not decisive'] }, usage: g4b.traceUsage };
  // The adapter answers request k with step k: one MC1 answer to both questions, then the assessor's verdict on A and
  // its untyped reply on B — a negative E5 beside a technical E5 of the same attempt.
  async function pay(packet, verdictA) {
    steps.push(m.answer, assessor(verdictA), assessor('off-form')); writeFileSync(m.scenario, JSON.stringify({ database: f.store.path, steps }));
    const original = ok(await runModelCall(f.store, { project, packet: reference(packet), dispatch: m.dispatch, role: 'implementer' }));
    assert.equal(original.outcome?.kind, 'fact-candidates');
    const terminalA = ok(await assessFact(f.store, { project, modelCall: reference(original.record), questionId: a.gap, dispatch: m.dispatch }));
    assert.equal(terminalA.value.verdict, verdictA);
    const terminalB = ok(await assessFact(f.store, { project, modelCall: reference(original.record), questionId: b.gap, dispatch: m.dispatch }));
    assert.equal(terminalB.value.verdict, 'off-form');
    return { terminalA, terminalB };
  }
  const bindingOf = (series, attempt) => { const binding = ok(readCompletionBinding(f.store, project, reference(series), attempt)); assert.ok(binding); return binding; };
  const headOf = binding => f.store.get(completionWorkId(project, binding.id));
  const seriesValue = () => f.store.get(seriesId).value;
  const completion = { routes: reference(f.route), batches: [batch.id] };
  function openNext(attempt) {
    const series = ok(openAttempt(f.store, { project, block: f.block, line: 1, attempt, goal, completion }));
    const binding = bindingOf(series, attempt);
    ok(writeAnswersRegistration(f.store, { project, binding: reference(binding) }));
    const request = { project, routes: reference(f.route), batch: batch.id, environment: reference(m.config), attempt: { series: reference(series), ordinal: attempt }, previous: [] };
    const packet = measured('writeQuestionPacket.' + attempt, () => ok(writeQuestionPacket(f.store, request)).record).result;
    return { series, binding, packet, request };
  }
  // Rows 2, 3, 5, 9: the expectation is derived from the E5 records the preceding attempt claimed, never from E2 — one
  // element per genuine negative E5 at the exact question address its own reader proves; the G4b rows beside them and
  // the rows of an older attempt in the same journal give nothing.
  function expectedRefusals(attempt, packet) {
    const series = seriesValue();
    const prior = [...series.inherited, ...series.attempts].filter(item => item.ordinal < attempt && same(item.goal, goal)).at(-1);
    assert.ok(prior && prior.outcome && prior.outcome.refusals.length === 1, 'The preceding attempt claimed exactly one refusal: the negative E5 of A');
    assert.ok(packet.value.journal, 'The packet names the journal its preceding refusals stand in');
    const rows = f.store.get(packet.value.journal.id, packet.value.journal.revision).value.rows;
    const named = prior.outcome.refusals.map(link => rows.find(row => row.id === link.row));
    assert.ok(named.every(row => row && row.gate === 'E5'));
    assert.ok(rows.some(row => row.gate === 'G4b'), 'The named journal holds G4b rows beside the claimed cause (row 9)');
    if (attempt > 2) assert.ok(rows.some(row => row.gate === 'E5' && !named.includes(row)), 'The named journal holds the E5 row of the older attempt too (row 5)');
    return named.map(row => {
      const proof = ok(readAssessmentRefusalAt(f.store, project, row.source));
      assert.equal(proof.intent.attempt, prior.ordinal, 'The E5 verdict belongs to the preceding attempt');
      assert.equal(proof.intent.question.target, a.target, 'The claimed cause is the negative E5 of question A');
      assert.ok(row.remedy.includes(a.target + '/' + proof.intent.question.field) && row.remedy.includes('source not decisive'));
      return { row: row.id, code: row.code, target: proof.intent.question.target, field: proof.intent.question.field, remedy: row.remedy };
    });
  }
  const attempts = [];
  let current = { series: m.series, binding: m.binding, packet: m.packet, request: null };
  for (const [attempt, verdict] of [[1, 'conflicting'], [2, 'insufficient']]) {
    if (attempt > 1) {
      current = openNext(attempt);
      const expected = expectedRefusals(attempt, current.packet);
      assert.deepEqual(current.packet.value.packet.refusals, expected, 'Attempt ' + attempt + ' carries exactly the one genuine cause of the preceding attempt');
      assert.equal(expected[0].code, 'fact_assessment_' + attempts[attempt - 2].verdict, 'The code is the E5 verdict\'s own (row 2: conflicting as well as insufficient)');
      assert.equal(canonical(current.packet.value.packet.refusals).includes(b.target), false, 'Question B, untyped at E5, is no task for the model (rows 3, 8)');
      measured('readQuestionPacket.' + attempt, () => assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(current.packet) })), current.packet));
    } else {
      assert.deepEqual([current.packet.value.packet.refusals, current.packet.value.journal], [[], null], 'The first attempt has no preceding attempt (row 1)');
      measured('readQuestionPacket.1', () => assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(current.packet) })), current.packet));
    }
    const { terminalA, terminalB } = await pay(current.packet, verdict);
    const work = ok(readCompletionWorkAt(f.store, project, reference(headOf(current.binding))));
    assert.equal(work.refusals.length, 1, 'The genuine negative E5 of A is the one claimed refusal of the open work');
    const results = [{ gap: a.record, result: reference(terminalA), candidate: null }, { gap: b.record, result: reference(terminalB), candidate: null }];
    const close = { project, block: f.block, line: 1, attempt, outcome: { reason: 'refused', accepting: [], cancelling: [], refusals: [...work.refusals] } };
    const written = measured('writeAnswersEvaluation.' + attempt, () => ok(writeAnswersEvaluation(f.store, { project, binding: reference(current.binding),
      request: { ...f.request, results }, close }))).result;
    assert.equal(written.repeated, false); assert.ok(written.closed, 'The linked close closes the attempt');
    const after = ok(readCompletionWorkAt(f.store, project, reference(headOf(current.binding))));
    assert.deepEqual([after.refusals.length, after.technical.map(row => row.reason), after.negative.length], [1, ['off-form'], 1], 'One counted N (A) and one T (B): T is never a refusal row');
    assert.equal(seriesValue().attempts.find(item => item.ordinal === attempt).outcome.reason, 'refused');
    attempts.push({ attempt, verdict, packet: current.packet, binding: current.binding, rows: work.refusals.map(link => link.row) });
  }
  const third = openNext(3);
  const expected3 = expectedRefusals(3, third.packet);
  assert.deepEqual(third.packet.value.packet.refusals, expected3);
  assert.deepEqual(expected3.map(item => item.row), attempts[1].rows, 'Attempt 3 carries the cause of attempt 2 alone');
  assert.ok(!attempts[0].rows.some(row => expected3.some(item => item.row === row)), 'The older attempt\'s cause is not substituted (row 5)');
  measured('readQuestionPacket.3', () => assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(third.packet) })), third.packet));
  // Row 10: the packet of attempt 2 was saved before the journal moved on (its own evaluation, the rows of attempt 3):
  // it reads the same in a new operation, cold on a copy and after a restart, by the journal revision it names.
  const second = attempts[1];
  assert.ok(f.store.get(journalId(project)).revision > second.packet.value.journal.revision, 'The journal head moved after the packet was saved');
  const readSecond = store => ok(readQuestionPacket(store, { project, record: reference(second.packet) }));
  assert.deepEqual(measured('readQuestionPacket.2.moved', () => readSecond(f.store)).result, second.packet);
  // Row 6 (return №1, P2-3): the E5 result behind the delivered cause becomes unreadable (a view, no record changed): the
  // common E5 reader refuses, and E2 carries that refusal as it is — code, address and route — never a packet refusal.
  {
    const rows3 = f.store.get(third.packet.value.journal.id, third.packet.value.journal.revision).value.rows;
    const cause = rows3.find(row => row.id === expected3[0].row);
    const resultRef = cause.origin.sources.find(item => item.role === 'assessment').ref;
    const view = new Proxy(f.store, { get(target, property) {
      if (property === 'get') return (id, revision) => id === resultRef.id ? undefined : target.get(id, revision);
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    // On a managed attempt the registry of the preceding attempt (every product exact) or the E5 reader refuses first;
    // whichever it is, E2 carries that common reader's refusal unchanged and never turns it into a packet refusal.
    const direct = [readCompletionWorkAt(view, project, reference(headOf(attempts[1].binding))), readAssessmentRefusalAt(view, project, cause.source)]
      .filter(result => !result.ok).map(result => [result.refusal.code, result.refusal.at, result.refusal.route]);
    assert.ok(direct.length >= 1, 'A common reader refuses the hidden result');
    const prepared = prepareQuestionPacket(view, third.request);
    assert.equal(prepared.ok, false);
    assert.notEqual(prepared.refusal.code, 'packet_record_invalid');
    const carried = [prepared.refusal.code, prepared.refusal.at, prepared.refusal.route];
    assert.ok(direct.some(item => canonical(item) === canonical(carried)), 'The reader\'s own refusal reaches the caller unchanged: ' + JSON.stringify([carried, direct]));
  }
  // Row 12: the delivered remedies are part of the packet the common capacity mechanism bounds — nothing is truncated
  // or dropped: at a capacity the packet of this batch fits without its refusals, the packet with them is blocked with
  // the typed refusal and its full size. (Before the restart: the engine that configures environments holds the first Store.)
  const chars = packet => packet.value.fingerprint.chars;
  assert.ok(chars(third.packet) > chars(attempts[0].packet), 'The refusals grew the packet');
  const capacity = chars(third.packet) - 1;
  assert.ok(chars(attempts[0].packet) <= capacity, 'Without refusals the packet of this batch fits the chosen capacity');
  const command = { executable: process.execPath, args: [join(config.repository, 'test/om-adapter-fixture.mjs'), '--scenario', m.scenario, '--trace', join(f.root, 'e22-capacity-trace.jsonl')] };
  const small = f.engine.environments.configure(project, { workspace: f.root,
    implementer: { actor: 'answers-original', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'answers-independent', model: 'fixture', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: capacity },
  f.store.get('environment:' + project).revision);
  // Not measured (not E2.2's subject): a second packet of one managed attempt is prepared under the historical proof of the
  // saved one, so the S1.1 monitor sees the E2.refusals key of this attempt derived twice in one operation.
  const blocked = ok(prepareQuestionPacket(f.store, { ...third.request, environment: reference(small) })).record;
  assert.deepEqual([blocked.value.state, blocked.value.refusal?.code, blocked.value.packet, blocked.value.fullChars > capacity], ['blocked', 'packet_too_large', null, true]);
  f.restart();
  assert.deepEqual(measured('readQuestionPacket.2.restart', () => readSecond(f.store)).result, second.packet);
  assert.deepEqual(measured('readQuestionPacket.3.restart', () => ok(readQuestionPacket(f.store, { project, record: reference(third.packet) }))).result, third.packet);
  const fixed = cloneStore(f.path, 'e22-fixed');
  withHistoricalReads(() => {
    const cold = measured('fixed.readQuestionPacket.2', () => readSecond(fixed));
    assert.deepEqual(cold.result, second.packet);
    // NR1 (№3591): the saved packet is read as written — its E2 derivation and the E5 cause of its refusals were proved
    // when it was written (the producer path above) and are not derived again on reading.
    for (const family of ['E2.derive', 'E2.refusals']) assert.equal(cold.report.families[family] ?? 0, 0, 'The cold read does not derive ' + family);
  });
  console.log(JSON.stringify({ reports, outcomes: { questions: batch.items.map(item => item.target + '/' + item.field), delivered: third.packet.value.packet.refusals, capacity, fullChars: blocked.value.fullChars } }));
} finally {
  active = null;
  for (const store of stores) store.close();
  for (const action of cleanups.reverse()) action();
}
`;

const e22NodeScenario = scenarioHeader + monitorHead + String.raw`
register(config.loader, { data: { root: config.dist, repository: config.repository } });
const imports = name => import(config.dist + 'src/' + name + '.js');
const { canonical } = await imports('canonical');
const { Store } = await imports('storage/store');
const { reference } = await imports('pipeline/contracts');
const { writeAnswersRegistration } = await imports('om/answers-gate');
const { writeQuestionPacket, readQuestionPacket } = await imports('om/question-packet');
const { runModelCycle, readManagedModelDiagnostic } = await imports('om/model-call');
const { readCall } = await imports('om/call-record');
const { openAttempt, closeAttempt, prepareManagedClaim } = await imports('om/repeat-gate');
const { readCompletionBinding } = await imports('om/series');
const g4b = await import(config.dist + 'test/om-answers-gate.test.js');
` + monitorTail + String.raw`
try {
  const f = g4b.fixture(t), project = f.project;
  const source = f.store.get('source:' + project + ':brief');
  const seriesOf = id => f.store.get(id).value;
  const bindingOf = (series, attempt) => { const binding = ok(readCompletionBinding(f.store, project, reference(series), attempt)); assert.ok(binding); return binding; };
  /** Closes the managed attempt by the claim G7 derives from its complete registry: the reason is the diagnostic's own, never the caller's. */
  function close(block, attempt) {
    const address = { project, block, line: 1, attempt };
    const claim = ok(prepareManagedClaim(f.store, { ...address, outcome: { reason: 'result', accepting: [], cancelling: [], refusals: [] } }));
    ok(closeAttempt(f.store, { ...address, outcome: claim.outcome }));
    return claim.outcome;
  }
  // A packet after an attempt that ended in a cycle with need_source continuations is asserted but not measured: proving
  // its E4 causes reads the continuation packets of that attempt, whose historical derivation re-derives the root packet
  // once per packet — the S1.1 cost class of continuations noted for the registry, not E2.2's subject.
  function openNext(n, attempt, measure = true) {
    const series = ok(openAttempt(f.store, { project, block: n.block, line: 1, attempt, goal: n.m.goal, completion: { routes: reference(f.route), batches: [n.batch.id] } }));
    const binding = bindingOf(series, attempt);
    ok(writeAnswersRegistration(f.store, { project, binding: reference(binding) }));
    const request = { ...n.packet.value.request, attempt: { series: reference(series), ordinal: attempt }, previous: [] };
    const write = () => ok(writeQuestionPacket(f.store, request)).record;
    const packet = measure ? measured('writeQuestionPacket.' + n.block + '.' + attempt, write).result : write();
    const read = () => assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(packet) })), packet);
    if (measure) measured('readQuestionPacket.' + n.block + '.' + attempt, read); else read();
    return { series, binding, packet, request };
  }
  // Rows 7 and 8: for every E4 row the preceding attempt claimed whose diagnostic the managed reader proves a refusal of
  // the model, one element per exact (target, field) of the admitted call it names, in this batch; a technical or
  // control end of the model gives none, whatever rows it claimed.
  let lastTrace = '';
  function expectedRefusals(n, attempt, packet, priorBinding) {
    const series = seriesOf(n.m.series.id);
    const prior = [...series.inherited, ...series.attempts].filter(item => item.ordinal < attempt && same(item.goal, n.m.goal)).at(-1);
    assert.ok(prior && prior.outcome);
    if (!prior.outcome.refusals.length) { assert.equal(packet.value.journal, null); return []; }
    assert.ok(packet.value.journal);
    const rows = f.store.get(packet.value.journal.id, packet.value.journal.revision).value.rows;
    const named = prior.outcome.refusals.map(link => rows.find(row => row.id === link.row));
    assert.ok(named.every(row => row && row.gate === 'E4'), 'Every claimed cause is an E4 diagnostic row');
    const expected = [], trace = [];
    for (const row of named) {
      const diagnostic = ok(readManagedModelDiagnostic(f.store, priorBinding, row.source));
      assert.equal(diagnostic.request.code, row.code);
      const call = ok(readCall(f.store, project, row.origin.sources.find(item => item.role === 'call').ref));
      trace.push({ row: row.id, code: row.code, goal: row.goal, reason: diagnostic.reason, attempt: call.value.attempt, gaps: call.value.gaps });
      if (diagnostic.reason !== 'refused') continue;
      assert.equal(call.value.attempt, prior.ordinal, 'The admitted call belongs to the preceding attempt');
      for (const gap of call.value.gaps) if (gap.goal === row.goal && n.batch.items.some(item => item.target === gap.goal && item.field === gap.field))
        expected.push({ row: row.id, code: row.code, target: gap.goal, field: gap.field, remedy: row.remedy });
    }
    lastTrace = JSON.stringify({ trace, batch: n.batch.items.map(item => [item.target, item.field, item.consumers]) });
    return [...new Map(expected.map(item => [canonical(item), item])).values()].sort((x, y) => canonical(x) < canonical(y) ? -1 : canonical(x) > canonical(y) ? 1 : 0);
  }
  const grow = (slice, ...added) => {
    const file = join(f.root, slice + '-scenario.json'), script = JSON.parse(readFileSync(file, 'utf8'));
    script.steps.push(...added); writeFileSync(file, JSON.stringify(script));
  };
  // The consume block first: an interrupted transport, then an untyped reply — technical ends are kept in the history and
  // are no task for the model (row 8). (First, because every later G4b evaluation reads all packets of the project, and the
  // continuation packets of the produce block below carry the S1.1 cost class noted above.)
  const c = await g4b.nodeTerminal(f, 'garden-consume-block', 'interrupted', 'e22-consume');
  c.block = 'garden-consume-block';
  measured('writeAnswersEvaluation.consume.1', () => ok(g4b.evaluate(f, c.m, c.offers(reference(c.cycle.record)))));
  const closedC1 = close(c.block, 1);
  assert.equal(closedC1.reason, 'interrupted');
  const c2 = openNext(c, 2);
  assert.deepEqual(c2.packet.value.packet.refusals, expectedRefusals(c, 2, c2.packet, c.m.binding));
  assert.deepEqual(c2.packet.value.packet.refusals, []);
  assert.equal(c2.packet.value.journal !== null, closedC1.refusals.length > 0, 'The journal is named exactly when the end claimed rows');
  grow('e22-consume', { research: { invalid: true }, usage: g4b.traceUsage });
  const cycleC2 = ok(await runModelCycle(f.store, { project, packet: reference(c2.packet), dispatch: c.cycle.record.value.request.dispatch, role: 'implementer' }));
  assert.ok(cycleC2.diagnostic);
  measured('writeAnswersEvaluation.consume.2', () => ok(g4b.evaluate(f, { binding: c2.binding }, c.offers(reference(cycleC2.record)))));
  const closedC2 = close(c.block, 2);
  assert.equal(closedC2.reason, 'off-form');
  const c3 = openNext(c, 3);
  assert.deepEqual(c3.packet.value.packet.refusals, expectedRefusals(c, 3, c3.packet, c2.binding));
  assert.deepEqual(c3.packet.value.packet.refusals, []);
  // The produce block: attempt 1 refused by the model (cannot_answer), attempt 2 a cycle without progress after a source read.
  const p = await g4b.nodeTerminal(f, 'garden-produce-block', 'cannot_answer', 'e22-produce');
  p.block = 'garden-produce-block';
  assert.deepEqual([p.packet.value.packet.refusals, p.packet.value.journal], [[], null], 'The first attempt has no preceding attempt (row 1)');
  assert.equal(p.cycle.record.value.terminal, 'outcome'); assert.ok(p.cycle.diagnostic);
  measured('writeAnswersEvaluation.produce.1', () => ok(g4b.evaluate(f, p.m, p.offers(reference(p.cycle.record)))));
  const closed1 = close(p.block, 1);
  assert.equal(closed1.reason, 'refused'); assert.ok(closed1.refusals.length >= 1, 'The refused close claims the E4 rows');
  const p2 = openNext(p, 2);
  const expected2 = expectedRefusals(p, 2, p2.packet, p.m.binding);
  assert.ok(expected2.length >= 1 && expected2.every(item => item.code === 'model_cannot_answer'), 'A refusal of the model is delivered with its own code (row 7): ' + lastTrace);
  assert.ok(expected2.every(item => p.batch.items.some(question => question.target === item.target && question.field === item.field)), 'Every delivered address is a question of this packet');
  assert.deepEqual(p2.packet.value.packet.refusals, expected2);
  assert.ok(canonical(p2.packet.value.packet.refusals).includes('The requested design is not available'), 'The remedy of the E4 source reaches the model, not a code alone');
  // The saved packets read the same after a restart, before the cycle below (measured on the real Store, cold).
  f.restart();
  for (const [label, saved] of [['consume.2', c2.packet], ['consume.3', c3.packet], ['produce.2', p2.packet]])
    measured('readQuestionPacket.' + label + '.restart', () => assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(saved) })), saved));
  // Row 11: the model asks twice for the same source; the continuation packet after the read derives its previous
  // refusals from the same root basis — attempt 1's causes — never from anything paid later in attempt 2.
  const questions = p2.packet.value.packet.questions.map(row => row.id);
  const need = { research: { protocol: '$answerProtocol', requestId: '$requestId', action: 'need_source', questionIds: questions, missing: 'Need the addressed source data',
    reads: [{ action: 'read_source', source: reference(source), selector: { kind: 'text-range', start: 0, end: source.value.content.length } }] }, usage: g4b.traceUsage };
  grow('e22-produce', need, need);
  const cycle2 = ok(await runModelCycle(f.store, { project, packet: reference(p2.packet), dispatch: p.cycle.record.value.request.dispatch, role: 'implementer' }));
  assert.equal(cycle2.record.value.terminal, 'research-no-progress'); assert.equal(cycle2.record.value.steps.length, 2, 'Both source requests were paid before the root ended');
  const continuation = ok(readQuestionPacket(f.store, { project, record: cycle2.record.value.steps[1].packet }));
  assert.ok(continuation.value.request.continuation && continuation.id !== p2.packet.id, 'The second step is the continuation packet of the root');
  for (const [index, step] of cycle2.record.value.steps.entries()) {
    const stepPacket = ok(readQuestionPacket(f.store, { project, record: step.packet }));
    assert.deepEqual([stepPacket.value.packet.refusals, stepPacket.value.journal], [expected2, p2.packet.value.journal], 'step ' + index + ' keeps the root basis');
  }
  // From here on nothing is measured: the packets of this cycle carry the S1.1 cost class of continuations (see above).
  ok(g4b.evaluate(f, { binding: p2.binding }, p.offers(reference(cycle2.record))));
  const closed2 = close(p.block, 2);
  assert.equal(closed2.reason, 'refused', 'A cycle ended without progress is a refusal of the model');
  const p3 = openNext(p, 3, false);
  const expected3 = expectedRefusals(p, 3, p3.packet, p2.binding);
  assert.ok(expected3.length >= 1 && expected3.every(item => item.code === 'research_no_progress'), 'Delivered with its own code, at the addresses of the admitted call: ' + lastTrace);
  assert.deepEqual(p3.packet.value.packet.refusals, expected3);
  assert.ok(!expected3.some(item => closed1.refusals.some(link => link.row === item.row)), 'The causes of attempt 1 are not substituted for attempt 2\'s (row 5)');
  f.restart();
  assert.deepEqual(ok(readQuestionPacket(f.store, { project, record: reference(p3.packet) })), p3.packet);
  console.log(JSON.stringify({ reports, outcomes: { produce: p3.packet.value.packet.refusals, consume: c3.packet.value.packet.refusals, first: expected2,
    ends: [closed1.reason, closed2.reason, closedC1.reason, closedC2.reason] } }));
} finally {
  active = null;
  for (const store of stores) store.close();
  for (const action of cleanups.reverse()) action();
}
`;

test('E2.2 №1801 rows 1/2/3/5/9/10/12 on the real MC1 producers: two fact questions of one block, the negative E5 of one beside the untyped E5 of the other — the repeated packet carries the one genuine cause at its exact address, never the older attempt\'s, never a G4b row; the saved packet reads the same after the journal moved; the remedies are bounded by the common capacity', async t => {
  checkScenario(t, await runScenario(t, 'e22-fact', e22FactScenario));
});

test('E2.2 №1801 rows 5/7/8/11 on the real MC2 producers: cannot_answer and a cycle without progress are delivered at the exact addresses of the admitted call with their own codes, a continuation packet keeps the root basis, and interrupted or off-form ends are no task for the model', async t => {
  checkScenario(t, await runScenario(t, 'e22-node', e22NodeScenario));
});

test('PF1 (№2797-8) one overlay for a batch of N sources: the history they share is derived once and, under an unchanged stamp, never checked again per source — body reads, identities and stamps do not grow with N, while N opaque views of the former shape read it N times', t => {
  const counts = { gets: 0, identities: 0, stamps: 0 };
  const original = { get: Store.prototype.get, identities: Store.prototype.identities, changeStamp: Store.prototype.changeStamp };
  Store.prototype.get = function (this: Store, ...args: Parameters<typeof original.get>) { counts.gets++; return original.get.apply(this, args); } as typeof original.get;
  Store.prototype.identities = function (this: Store, ...args: Parameters<typeof original.identities>) { counts.identities++; return original.identities.apply(this, args); } as typeof original.identities;
  Store.prototype.changeStamp = function (this: Store) { counts.stamps++; return original.changeStamp.apply(this); };
  const root = mkdtempSync(join(tmpdir(), 'omg-pf1-cost-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { Object.assign(Store.prototype, original); store.close(); rmSync(root, { recursive: true, force: true }); });
  const chain: Revision<unknown>[] = [];
  for (let i = 0; i < 30; i++) chain.push(store.write({ id: `pf1c:h:${i}`, kind: 'k', expected: 0, value: { i, previous: i ? reference(chain[i - 1]!) : null } }));
  const last = chain.at(-1)!;
  const row = (i: number): Revision<Json> => ({ id: `pf1c:source:${i}`, kind: 'k', revision: 1, hash: hashJson({ source: i }), value: { source: i } });
  const binding = (base: Store) => new Proxy(base, { get: (target, key) => { const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member; } });
  const noCycle = (): never => { throw new Error('Unexpected cycle'); };
  // The shared history: its head, then every exact revision back to the first — the shape of a series or a work registry.
  const history = (view: Store) => historicalProof(view, { reader: 'PF1.shared', project: 'garden', ref: reference(last) }, source => {
    const head = source.get(last.id)!; let cursor: Revision<unknown> | null = head, length = 0;
    while (cursor) {
      length++;
      const previous: { id: string; revision: number } | null = (cursor.value as { previous: { id: string; revision: number } | null }).previous;
      cursor = previous ? source.get(previous.id, previous.revision) : null;
    }
    return length;
  }, noCycle);
  const batch = (n: number, shape: 'shared' | 'opaque') => {
    const rows = Array.from({ length: n }, (_, i) => row(i));
    const shared = pendingOverlay(store, rows);
    const views = rows.map(item => shape === 'shared' ? shared : pendingOverlay(binding(store), [item]));
    const before = { ...counts };
    const lengths = withHistoricalReads(() => rows.map((item, i) => historicalProof(views[i]!, { reader: 'PF1.source', project: 'garden', ref: reference(item) },
      source => { source.get(item.id, 1); return history(source); }, noCycle)));
    assert.deepEqual(lengths, rows.map(() => 30), 'Every source is checked and sees the whole history');
    return { gets: counts.gets - before.gets, identities: counts.identities - before.identities, stamps: counts.stamps - before.stamps };
  };
  const one = batch(1, 'shared'), four = batch(4, 'shared');
  // PF2 (№2905, changed expectation): the history proved for the base through the first operation's overlay serves the
  // next operation's overlay — it is no longer read once per operation but not at all; an unchanged stamp needs no identities.
  assert.ok(one.gets >= 30, `The first operation reads the whole history: ${one.gets}`);
  assert.deepEqual([four.gets, four.identities], [0, 0], 'Through one overlay of the next operation the shared history is not read again whatever N is');
  assert.ok(four.stamps - one.stamps <= 3, `A stamp per further source at most, never per event of the history: ${one.stamps} → ${four.stamps}`);
  const opaqueOne = batch(1, 'opaque'), opaqueFour = batch(4, 'opaque');
  assert.ok(opaqueFour.gets >= 4 * 30 && opaqueFour.gets >= 4 * opaqueOne.gets - 4,
    `The former shape — one opaque view per source — derives the history N times: ${opaqueOne.gets} → ${opaqueFour.gets}`);
});

test('PF2 (№2905) one registered layer per source — the shape of one call store per call — proves the shared history once for their base: body reads do not grow with N; a layer that answers a row of that history derives its own', t => {
  const counts = { gets: 0, runs: 0 };
  const original = Store.prototype.get;
  Store.prototype.get = function (this: Store, ...args: Parameters<typeof original>) { counts.gets++; return original.apply(this, args); } as typeof original;
  const root = mkdtempSync(join(tmpdir(), 'omg-pf2-cost-')), store = new Store(join(root, 'state.sqlite'));
  t.after(() => { Store.prototype.get = original; store.close(); rmSync(root, { recursive: true, force: true }); });
  const chain: Revision<unknown>[] = [];
  for (let i = 0; i < 30; i++) chain.push(store.write({ id: `pf2c:h:${i}`, kind: 'k', expected: 0, value: { i, previous: i ? reference(chain[i - 1]!) : null } }));
  const last = chain.at(-1)!;
  const row = (id: string, body: Json, revision = 1): Revision<Json> => ({ id, kind: 'k', revision, hash: hashJson(body), value: body });
  const noCycle = (): never => { throw new Error('Unexpected cycle'); };
  const history = (view: Store) => historicalProof(view, { reader: 'PF2.shared', project: 'garden', ref: reference(last) }, source => {
    counts.runs++;
    let cursor: Revision<unknown> | null = source.get(last.id)!, length = 0;
    while (cursor) {
      length++;
      const previous: { id: string; revision: number } | null = (cursor.value as { previous: { id: string; revision: number } | null }).previous;
      cursor = previous ? source.get(previous.id, previous.revision) : null;
    }
    return length;
  }, noCycle);
  const batch = (n: number) => {
    const before = { ...counts };
    const lengths = withHistoricalReads(() => Array.from({ length: n }, (_, i) => history(pendingOverlay(store, [row(`pf2c:source:${n}:${i}`, { i })]))));
    assert.deepEqual(lengths, lengths.map(() => 30));
    return { gets: counts.gets - before.gets, runs: counts.runs - before.runs };
  };
  const one = batch(1), four = batch(4);
  assert.deepEqual([one.runs, four.runs], [1, 0], 'The history proved for the base by one layer serves the next ones, here and in the next operation');
  assert.ok(four.gets < one.gets, `Body reads do not grow with N: ${one.gets} → ${four.gets}`);
  const runs = counts.runs;
  withHistoricalReads(() => assert.equal(history(pendingOverlay(store, [row(last.id, { i: 29, previous: null }, 2)])), 1));
  assert.equal(counts.runs, runs + 1, 'A layer whose own row answers the head derives its own history');
});
