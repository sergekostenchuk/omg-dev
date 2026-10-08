import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { StatementSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { types } from 'node:util';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, isRef, type Ref } from '../src/pipeline/contracts.js';
import { observeStore, Store, storeBodyCache, storeReads, type Revision, type StoreBodyCache, type StoreObserver, type TransactionGuard, type Write } from '../src/storage/store.js';
import { captureView, genuineStore, observePendingReads, pendingOverlay, pendingSelections, provenReads, provenStore, observeTraceReads, readServer, storeView, tracedChain, transparentTrace, type StoreViewPolicy } from '../src/storage/store-view.js';
import { transactionForTests } from '../src/om/atomic-gate.js';
import type { OmResult } from '../src/om/refusal.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { Discovery, type Question } from '../src/discovery/discovery.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import type { Selector } from '../src/evidence/evidence.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { historicalProof, historicalTrace, withHistoricalReads, writeOmInput } from '../src/om/input.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { gapLineKey, gapLineExpectedResult } from '../src/om/gap-lines.js';
import { openSeries, beginAttempt, type AttemptGoal } from '../src/om/series.js';
import { openAttempt as managedOpenAttempt } from '../src/om/repeat-gate.js';
import { recordCall } from '../src/om/call-record.js';
import { writeGuarded } from '../src/om/refs.js';
import { writeRoutes } from '../src/om/routes.js';
import { mc1FieldSpec, writeMc1Question, writeAcceptedAnswer, prepareAnswerInvalidation, readAnswerInvalidation,
  type AnswerQuestionContract, type Mc1QuestionRequest, type AnswerRequest } from '../src/om/accepted-answer.js';
import { prepareQuestionTasks, prepareQuestionPacket, writeQuestionPacket, readQuestionPacket,
  type QuestionTaskRequest, type QuestionPacketRequest } from '../src/om/question-packet.js';
import { pendingCallStore, runModelCall, type ModelCallRequest } from '../src/om/model-call.js';
import { readLegacyOperation, recoverLegacyOperation } from '../src/product/preparation-run.js';
import { acquire, release } from '../src/execution/lock.js';
import type { ExecutionLock } from '../src/execution/model.js';
import type { ParkedCandidate } from '../src/execution/park.js';
import { ProductEngine } from '../src/product/engine.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { executionFixture } from './execution-fixture.js';

const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;
const isProxyObject = (value: unknown): boolean => types.isProxy(value);

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-store-view-'));
  const store = new Store(join(root, 'live.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store };
}

/** A guard-mode view whose policy adds one view guard and records every pass. */
function guardView(store: Store, viewGuards: TransactionGuard[], hits?: { inputs: Write[]; guards: TransactionGuard[] }[]) {
  const passes = hits ?? [];
  const policy: StoreViewPolicy = { write: (inputs, guards) => {
    passes.push({ inputs, guards });
    return store.writeMany(inputs, [...guards, ...viewGuards]);
  } };
  return { view: storeView(store, policy), passes };
}

const w = (id: string, expected = 0, kind = 'concept'): Write => ({ id, kind, expected, value: { id } });

test('1 write(w) and writeMany([w], []) are one identical policy pass in both modes; target.write is never reached', t => {
  const { store } = fixture(t);
  // Guard mode: exactly one policy pass per public call, same Revision, same error.
  const { view, passes } = guardView(store, []);
  const viaWrite = view.write(w('a'));
  assert.equal(passes.length, 1); assert.deepEqual(passes[0]!.inputs, [w('a')]); assert.deepEqual(passes[0]!.guards, []);
  const viaMany = view.writeMany([w('b')], []);
  assert.equal(passes.length, 2); assert.deepEqual(passes[1]!.inputs, [w('b')]); assert.deepEqual(passes[1]!.guards, []);
  assert.equal(viaWrite.revision, 1); assert.equal(viaMany[0]!.revision, 1);
  assert.equal(viaWrite.hash, store.get('a')!.hash);
  // Same refusal from both forms: a stale view guard refuses write and writeMany alike.
  const stale: TransactionGuard = { id: 'a', revision: 1, hash: '0'.repeat(64) };
  const refusing = guardView(store, [stale]);
  assert.throws(() => refusing.view.write(w('c')), code('input_stale'));
  assert.throws(() => refusing.view.writeMany([w('d')], []), code('input_stale'));
  assert.throws(() => refusing.view.write(w('d2')), code('input_stale'));
  assert.equal(store.get('c'), null); assert.equal(store.get('d'), null); assert.equal(store.get('d2'), null);
  // Capture mode: one pass, synthetic Revision, nothing durable.
  const captured = captureView(store, {});
  const synthetic = captured.view.write(w('cap'));
  assert.equal(synthetic.revision, 1); assert.equal(store.get('cap'), null);
  assert.equal(captured.writes.length, 1);
  const syntheticMany = captured.view.writeMany([w('cap2')], []);
  assert.equal(syntheticMany[0]!.revision, 1); assert.equal(store.get('cap2'), null);
  assert.equal(captured.writes.length, 2);
});

test('2 capture validates the whole batch before publishing any element; success keeps order and count', t => {
  const { store } = fixture(t);
  const rows = new Map<string, Revision>();
  const captured = captureView(store, { rows });
  // Second element invalid (expected != 0 on a fresh id): nothing accumulated.
  assert.throws(() => captured.view.writeMany([w('x'), w('y', 3)], []), code('revision_conflict'));
  assert.equal(captured.writes.length, 0); assert.equal(rows.size, 0); assert.equal(captured.guards.length, 0);
  assert.equal(store.get('x'), null);
  // Duplicate id inside one batch.
  assert.throws(() => captured.view.writeMany([w('x'), w('x')], []), code('duplicate_write'));
  assert.equal(captured.writes.length, 0);
  // Success: order and count preserved.
  const result = captured.view.writeMany([w('x'), w('y')], []);
  assert.equal(result.length, 2); assert.deepEqual(result.map(r => r.id), ['x', 'y']);
  assert.equal(captured.writes.length, 2); assert.equal(rows.size, 2);
});

test('3 capture keeps every caller guard with the batch for the final commit', t => {
  const { store } = fixture(t);
  const head = store.write(w('watched'));
  const captured = captureView(store, {});
  const refGuard: TransactionGuard = reference(head);
  const absentGuard: TransactionGuard = { id: 'never', absent: true };
  captured.view.writeMany([w('kept')], [refGuard, absentGuard]);
  assert.deepEqual(captured.guards, [refGuard, absentGuard]);
  // A plain write has no caller guards; the consumer's own carried set is untouched.
  captured.view.write(w('plain'));
  assert.deepEqual(captured.guards, [refGuard, absentGuard]);
  // The final commit replays writes AND the captured guards through Store.writeMany.
  store.writeMany(captured.writes, captured.guards);
  assert.ok(store.get('kept'));
  // And a moved guarded head refuses the whole captured pack then.
  const second = captureView(store, {});
  second.view.writeMany([w('late')], [refGuard]);
  store.write({ id: 'watched', kind: 'concept', expected: 1, value: { id: 'watched', moved: true } });
  assert.throws(() => store.writeMany(second.writes, second.guards), code('input_stale'));
  assert.equal(store.get('late'), null);
});

test('4 the returned Revision, the accumulated write and the caller input share no mutable cell', t => {
  const { store } = fixture(t);
  const captured = captureView(store, {});
  const input: Write = { id: 'm', kind: 'concept', expected: 0, value: { mutable: 'before' } };
  const revision = captured.view.write(input);
  assert.equal(revision.hash, hashJson(input.value));
  (input.value as Record<string, unknown>).mutable = 'after';
  assert.equal((captured.writes[0]!.value as Record<string, unknown>).mutable, 'before');
  assert.equal((revision.value as Record<string, unknown>).mutable, 'before');
  assert.equal(revision.hash, hashJson(captured.writes[0]!.value));
  (revision.value as Record<string, unknown>).mutable = 'mutated-after';
  assert.equal((captured.writes[0]!.value as Record<string, unknown>).mutable, 'before');
});

test('5 the capture overlay reads pending rows first and exact older revisions from the target', t => {
  const { store } = fixture(t);
  const old = store.write(w('base'));
  store.write({ id: 'base', kind: 'concept', expected: 1, value: { id: 'base', v: 2 } });
  const rows = new Map<string, Revision>();
  const captured = captureView(store, { rows });
  captured.view.write(w('pending-row'));
  assert.equal(captured.view.get('pending-row')!.revision, 1, 'pending row visible at its synthetic revision');
  assert.deepEqual(captured.view.get('base', 1), old, 'exact older revision reads the target');
  assert.equal(captured.view.get('base')!.revision, 2, 'current head reads through');
  // Native issuance constraints are the producer's admit rule and run before Store-level checks.
  const issuance = captureView(store, { rows: new Map<string, Revision>(), admit: write => {
    if (write.expected !== 0) throw new EngineError('packet_record_invalid', 'native issuance writes new records only');
  } });
  assert.throws(() => issuance.view.write({ id: 'base', kind: 'concept', expected: 2, value: {} }), code('packet_record_invalid'),
    'the producer rule fires before revision checks and is not displaced by them');
  assert.throws(() => issuance.view.write({ id: 'base', kind: 'concept', expected: 1, value: {} }), code('packet_record_invalid'),
    'a double violation (stale expected AND non-zero expected) still yields the producer rule first');
  assert.throws(() => issuance.view.writeMany([{ id: 'base', kind: 'other', expected: 0, value: {} }]), code('kind_mismatch'));
  assert.throws(() => captured.view.writeMany([w('pending-row')]), code('duplicate_write'));
});

test('6 a producer failure after a captured write leaves nothing durable and flushes nothing', t => {
  const { store } = fixture(t);
  const captured = captureView(store, {});
  assert.throws(() => {
    captured.view.write(w('half'));
    throw new EngineError('producer_failed', 'the producer stops mid-pack');
  }, code('producer_failed'));
  assert.equal(store.get('half'), null, 'no durable record before the final commit');
  assert.equal(captured.writes.length, 1, 'the buffer is local to the abandoned preparation');
  // The next capture starts with its own empty set (no leak between captures).
  const fresh = captureView(store, {});
  assert.equal(fresh.writes.length, 0);
});

test('7 the final commit re-decides guards and conflicts after preparation; a stale pack is refused whole', t => {
  const { store, root } = fixture(t);
  const watched = store.write(w('watched'));
  const captured = captureView(store, {});
  captured.view.writeMany([w('packed')], [reference(watched)]);
  // A second Store moves the guarded head between preparation and commit.
  const second = new Store(join(root, 'live.sqlite'));
  try {
    second.write({ id: 'watched', kind: 'concept', expected: 1, value: { id: 'watched', moved: true } });
    assert.throws(() => store.writeMany(captured.writes, captured.guards), code('input_stale'));
    assert.equal(store.get('packed'), null);
  } finally { second.close(); }
  // The synthetic Revision never meant committed.
  assert.equal(store.history('packed').length, 0);
});

test('8 guard mode sends caller guards plus view guards to one writeMany of the nearest target, unsplit', t => {
  const { store } = fixture(t);
  const watched = store.write(w('watched'));
  const absent: TransactionGuard = { id: 'absent-lock', absent: true };
  const calls: { inputs: Write[]; guards: TransactionGuard[] }[] = [];
  const original = store.writeMany.bind(store);
  (store as { writeMany: Store['writeMany'] }).writeMany = (inputs, guards = []) => { calls.push({ inputs, guards }); return original(inputs, guards); };
  const { view } = guardView(store, [reference(watched), absent]);
  const callerGuard = reference(store.get('watched')!);
  view.writeMany([w('g1'), w('g2')], [callerGuard]);
  assert.equal(calls.length, 1, 'the batch is never split into separate writes');
  assert.deepEqual(calls[0]!.inputs.map(write => write.id), ['g1', 'g2']);
  assert.ok(calls[0]!.guards.some(guard => canonical(guard) === canonical(callerGuard)));
  assert.ok(calls[0]!.guards.some(guard => 'absent' in guard && guard.id === 'absent-lock'), 'the absent guard is kept, never dropped as not-a-Ref');
  assert.ok(calls[0]!.guards.some(guard => isRef(guard) && guard.id === 'watched'));
});

test('9 a violated guard refuses the whole pack with zero writes and no retry through the raw Store', t => {
  const { store } = fixture(t);
  const watched = store.write(w('watched'));
  store.write({ id: 'watched', kind: 'concept', expected: 1, value: { id: 'watched', moved: true } });
  const { view } = guardView(store, [{ id: 'watched', revision: 1, hash: watched.hash }]);
  assert.throws(() => view.writeMany([w('n1'), w('n2')], []), code('input_stale'));
  assert.equal(store.get('n1'), null); assert.equal(store.get('n2'), null);
  assert.throws(() => view.write(w('n3')), code('input_stale'));
  assert.equal(store.get('n3'), null);
});

test('10 only Refs exactly equal to a pending writeRef drop out; absent and same-id-other-hash stay', t => {
  const { store } = fixture(t);
  const pendingWrite: Write = w('pending-target');
  const pendingRef: TransactionGuard = { id: pendingWrite.id, revision: 1, hash: hashJson(pendingWrite.value) };
  const absent: TransactionGuard = { id: 'never-present', absent: true };
  const kept = reference(store.write(w('other')));
  const seen: TransactionGuard[][] = [];
  // The consumer's remap rule (model-call): drop only Refs exactly equal to a pending writeRef.
  const view = storeView(store, { write: (inputs, guards) => {
    const keptGuards = guards.filter(guard => !isRef(guard) || !inputs.some(write =>
      canonical({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) }) === canonical(guard)));
    seen.push(keptGuards);
    return store.writeMany(inputs, keptGuards);
  } });
  view.writeMany([pendingWrite], [pendingRef, absent, kept]);
  const delivered = seen[0]!;
  assert.ok(!delivered.some(guard => isRef(guard) && canonical(guard) === canonical(pendingRef)), 'the exact pending writeRef drops out');
  assert.ok(delivered.some(guard => 'absent' in guard && guard.id === 'never-present'), 'absent is never dropped as not-a-Ref');
  assert.ok(delivered.some(guard => canonical(guard) === canonical(kept)));
  // A same-id different-hash Ref is not dropped by id alone: it reaches the target and refuses there.
  const pending2 = w('pending-2');
  const exact2: TransactionGuard = { id: 'pending-2', revision: 1, hash: hashJson(pending2.value) };
  const otherHash: TransactionGuard = { id: 'pending-2', revision: 1, hash: '0'.repeat(64) };
  assert.throws(() => view.writeMany([pending2], [exact2, otherHash]), code('input_stale'),
    'the surviving contradictory Ref refuses the commit at the target');
  assert.ok(seen[1]!.some(guard => isRef(guard) && guard.id === 'pending-2' && guard.hash === '0'.repeat(64)),
    'same-id different-hash Ref survived the filter');
  assert.ok(!seen[1]!.some(guard => isRef(guard) && guard.hash === exact2.hash), 'the exact writeRef of pending-2 dropped out');
  assert.equal(store.get('pending-2'), null);
});

test('11 an empty writeMany keeps guard behavior and captures dependencies without a synthetic commit', t => {
  const { store } = fixture(t);
  const watched = store.write(w('watched'));
  const { view } = guardView(store, []);
  assert.deepEqual(view.writeMany([], [reference(watched)]), []);
  assert.throws(() => view.writeMany([], [{ id: 'watched', revision: 1, hash: '0'.repeat(64) }]), code('input_stale'),
    'an empty batch still checks its conditions');
  const captured = captureView(store, {});
  assert.deepEqual(captured.view.writeMany([], [reference(watched)]), [], 'no synthetic Revision for an empty pack');
  assert.deepEqual(captured.guards, [reference(watched)], 'the dependencies are kept for the final pack');
  assert.equal(captured.writes.length, 0);
});

test('12 a new or side method is refused before it runs in either mode, with zero writes and no accumulator change', t => {
  const { store } = fixture(t);
  const { view } = guardView(store, []);
  const captured = captureView(store, {});
  for (const candidate of [view, captured.view]) {
    assert.equal(typeof candidate.close, 'function');
    assert.throws(() => candidate.close(), code('store_view_method_unsupported'));
    assert.equal(typeof candidate.snapshot, 'function');
    assert.throws(() => void candidate.snapshot('anywhere'), code('store_view_method_unsupported'));
    assert.throws(() => new (candidate.constructor as new (p: string) => Store)('x'), code('store_view_method_unsupported'),
      'the real constructor is neither handed out nor callable through the view');
  }
  // A method added to Store.prototype later is not auto-resolved either.
  (Store.prototype as unknown as Record<string, unknown>)['writesViaThis'] = function (this: Store) { return this.write(w('smuggled')); };
  try {
    assert.equal(typeof (view as unknown as Record<string, unknown>)['writesViaThis'], 'function');
    assert.throws(() => (view as unknown as { writesViaThis: () => void }).writesViaThis(), code('store_view_method_unsupported'));
    assert.equal(store.get('smuggled'), null, 'no durable write through a side method');
  } finally { delete (Store.prototype as unknown as Record<string, unknown>)['writesViaThis']; }
  // Capture accumulator untouched by refused calls.
  captured.view.write(w('kept'));
  assert.throws(() => captured.view.close(), code('store_view_method_unsupported'));
  assert.equal(captured.writes.length, 1);
  assert.equal(captured.guards.length, 0);
  // The Store itself is not closed by view.close().
  store.write(w('alive'));
  assert.ok(store.get('alive'));
});

test('13 a read projection over a guarded inner view keeps interception: neither bind nor const write = view.write reaches the raw Store', t => {
  const { store } = fixture(t);
  const inner = guardView(store, []);
  const overlay = new Map<string, Revision>();
  const projection = storeView(inner.view, {
    write: (inputs, guards) => inner.view.writeMany(inputs, guards),
    get: (id, revision) => {
      const own = overlay.get(id);
      return own && (revision === undefined || revision === own.revision) ? own : undefined;
    },
  });
  // Extracted write references still pass the inner interception.
  const detachedWrite = projection.write;
  const detachedMany = projection.writeMany;
  detachedWrite(w('via-write'));
  detachedMany([w('via-many')], []);
  assert.deepEqual(inner.passes.map(pass => pass.inputs.map(write => write.id)), [['via-write'], ['via-many']],
    'both extracted forms passed the inner policy exactly once each');
  assert.equal(inner.passes[0]!.guards.length, 0);
  // Read overlay first, then the nearest target's own get (bound, private fields reachable).
  overlay.set('shadow', { id: 'shadow', kind: 'concept', revision: 9, hash: '9'.repeat(64), value: { id: 'shadow' } });
  assert.equal(projection.get('shadow')!.revision, 9);
  assert.equal(projection.get('via-write')!.revision, 1, 'non-overlay reads fall through to the inner view');
  assert.equal(inner.view.get('via-write')!.revision, 1);
  assert.ok(projection.list().some(row => row.id === 'via-many'));
  assert.equal(projection.history('via-write').length, 1);
  assert.ok(projection instanceof Store);
  // An explicit null from the overlay is the projection's own answer "no record in this view":
  // only undefined delegates to the nearest target, and the lower get is not consulted (№1760-2).
  const getCalls: string[] = [];
  const rawGet = store.get.bind(store);
  (store as { get: Store['get'] }).get = (id, revision?) => { getCalls.push(id); return rawGet(id, revision); };
  try {
    const hidden = storeView(store, { write: (inputs, guards) => store.writeMany(inputs, guards),
      get: id => id === 'via-write' ? null : undefined });
    assert.equal(hidden.get('via-write'), null, 'an explicit null is not replaced by the stored revision');
    assert.deepEqual(getCalls, [], 'the lower get is never consulted for an explicit null');
    assert.equal(hidden.get('via-many')!.revision, 1, 'undefined still delegates to the nearest target');
    assert.deepEqual(getCalls, ['via-many']);
  } finally { (store as { get: Store['get'] }).get = rawGet; }
});

test('14 guard over guard: one final pack carries caller guards plus both view guards, each policy once, in nesting order; a refusal of either layer forbids the write', t => {
  const { store } = fixture(t);
  const innerHead = store.write(w('inner-watched'));
  const outerHead = store.write(w('outer-watched'));
  const innerGuard = reference(innerHead);
  const outerGuard = reference(outerHead);
  const calls: { inputs: Write[]; guards: TransactionGuard[] }[] = [];
  const original = store.writeMany.bind(store);
  (store as { writeMany: Store['writeMany'] }).writeMany = (inputs, guards = []) => { calls.push({ inputs, guards }); return original(inputs, guards); };
  const inner = guardView(store, [innerGuard]);
  const outerPasses: { inputs: Write[]; guards: TransactionGuard[] }[] = [];
  const outer = storeView(inner.view, { write: (inputs, guards) => {
    outerPasses.push({ inputs, guards });
    return inner.view.writeMany(inputs, [...guards, outerGuard]);
  } });
  const callerGuard = reference(store.get('inner-watched')!);
  outer.writeMany([w('gg')], [callerGuard]);
  assert.equal(outerPasses.length, 1, 'the outer policy ran exactly once');
  assert.equal(inner.passes.length, 1, 'the inner policy ran exactly once');
  assert.equal(calls.length, 1, 'one final Store.writeMany pack');
  const finalGuards = calls[0]!.guards;
  assert.deepEqual(finalGuards.map(guard => canonical(guard)),
    [callerGuard, outerGuard, innerGuard].map(guard => canonical(guard)),
    'caller, outer, inner — the nesting order of the subject remap is preserved');
  // A stale guard at either layer refuses the whole pack with zero writes.
  const staleInner = guardView(store, [{ id: 'inner-watched', revision: 1, hash: '0'.repeat(64) }]);
  const overStaleInner = storeView(staleInner.view, { write: (inputs, guards) => staleInner.view.writeMany(inputs, [...guards, outerGuard]) });
  assert.throws(() => overStaleInner.writeMany([w('r1')], []), code('input_stale'));
  assert.equal(store.get('r1'), null);
  const staleOuter = storeView(inner.view, { write: (inputs, guards) =>
    inner.view.writeMany(inputs, [...guards, { id: 'outer-watched', revision: 1, hash: '0'.repeat(64) }]) });
  assert.throws(() => staleOuter.write(w('r2')), code('input_stale'));
  assert.equal(store.get('r2'), null);
});

test('15 capture with guard in either order: the base stays untouched until the final commit, both layers of guards reach it, and no flush bypassing them exists', t => {
  const { store } = fixture(t);
  const watched = store.write(w('watched'));
  const layerGuard = reference(watched);
  // Capture over guard.
  const guarded = guardView(store, [layerGuard]);
  const overGuard = captureView(guarded.view, {});
  const callerGuard = reference(store.write(w('caller-watched')));
  overGuard.view.writeMany([w('cg')], [callerGuard]);
  assert.equal(store.get('cg'), null, 'nothing durable before the final commit');
  assert.equal(guarded.passes.length, 0, 'accumulation never invokes the lower write path');
  // The consumer's final commit explicitly carries both layers of conditions.
  store.writeMany(overGuard.writes, [...overGuard.guards, layerGuard]);
  assert.ok(store.get('cg'));
  // Guard over capture: the guard layer's condition lands in the captured set.
  const capture = captureView(store, {});
  const layer2 = reference(store.write(w('second-watched')));
  const guardOver = storeView(capture.view, { write: (inputs, guards) => capture.view.writeMany(inputs, [...guards, layer2]) });
  guardOver.writeMany([w('gc')], [callerGuard]);
  assert.equal(store.get('gc'), null);
  assert.deepEqual(capture.guards.map(guard => canonical(guard)), [callerGuard, layer2].map(guard => canonical(guard)),
    'caller guards plus the guard layer condition are kept for the final transaction');
  // A moved guarded head refuses the whole flush; there is no condition-less flush to the raw Store.
  store.write({ id: 'second-watched', kind: 'concept', expected: 1, value: { moved: true } });
  assert.throws(() => store.writeMany(capture.writes, capture.guards), code('input_stale'));
  assert.equal(store.get('gc'), null);
  const asRecord = capture.view as unknown as Record<string, unknown>;
  assert.equal(asRecord['flush'], undefined); assert.equal(asRecord['commit'], undefined);
});

test('16 capture over capture is refused before any accumulation; sequential captures stay lawful', t => {
  const { store } = fixture(t);
  const first = captureView(store, {});
  first.view.write(w('held'));
  assert.throws(() => captureView(first.view, {}), code('store_view_composition_unsupported'));
  assert.equal(first.writes.length, 1, 'the existing accumulator is unchanged by the refused composition');
  assert.equal(store.get('held'), null);
  // A capture over a guard/read projection is not a composition of two captures.
  const projected = guardView(store, []);
  const lawful = captureView(projected.view, {});
  lawful.view.write(w('fine'));
  assert.equal(lawful.writes.length, 1);
  // A sequential independent capture over the same Store keeps its own empty set.
  const second = captureView(store, {});
  assert.equal(second.writes.length, 0);
  second.view.write(w('own'));
  assert.deepEqual(second.writes.map(write => write.id), ['own']);
  assert.deepEqual(first.writes.map(write => write.id), ['held']);
  // The ban survives helper-built guard/read projections (№1760-3, reviewer probe capture-guard-capture):
  // a projection does not launder an existing capture owner.
  const firstCapture = captureView(store, { rows: new Map<string, Revision>() });
  const middle = storeView(firstCapture.view, { write: (inputs, guards) => firstCapture.view.writeMany(inputs, guards) });
  assert.throws(() => captureView(middle, { rows: new Map<string, Revision>() }), code('store_view_composition_unsupported'));
  assert.equal(firstCapture.writes.length, 0, 'nothing accumulated before the refusal');
  firstCapture.view.write(w('still-fine'));
  assert.equal(firstCapture.writes.length, 1, 'the existing capture keeps working after the refused nesting');
});

test('17 lower-layer errors keep their identity: closed Store, read failure and unsupported method are not masked as input_stale', t => {
  const { store } = fixture(t);
  store.write(w('before-close'));
  const { view } = guardView(store, []);
  const captured = captureView(store, {});
  store.close();
  assert.throws(() => view.write(w('late')), code('store_busy'), 'the original store refusal keeps its code');
  assert.throws(() => view.writeMany([w('late2')], []), code('store_busy'));
  // Capture preparation does not peek at a private closed flag: the read it needs fails as-is.
  assert.throws(() => captured.view.write(w('late3')), (error: unknown) =>
    !(error instanceof EngineError) || (error.code !== 'input_stale' && error.code !== 'store_view_method_unsupported'));
  assert.throws(() => view.list(), (error: unknown) => !(error instanceof EngineError),
    'a real read surfaces the original error, not an EngineError disguise');
  // The unsupported-method error is exactly itself.
  assert.throws(() => view.snapshot('x'), code('store_view_method_unsupported'));
  assert.throws(() => store.get('before-close'), (error: unknown) => !(error instanceof EngineError),
    'a closed store read fails with the original error rather than a disguised code');
});

test('X4 refusal timing: a forbidden function throws at call, a forbidden accessor at property-get before its getter runs, instanceof Store preserved', t => {
  const { store } = fixture(t);
  const { view } = guardView(store, []);
  assert.ok(view instanceof Store);
  assert.ok(captureView(store, {}).view instanceof Store);
  // Function-valued member: get returns a function; the refusal fires at call time.
  const closeMember: unknown = view.close;
  assert.equal(typeof closeMember, 'function');
  assert.throws(() => view.close(), code('store_view_method_unsupported'));
  store.write(w('still-open'));
  // Undeclared accessor: refused at property-get; the getter never runs.
  let getterRan = false;
  Object.defineProperty(Store.prototype, 'rogueAccessor', { configurable: true, get() { getterRan = true; return 1; } });
  try {
    assert.throws(() => (view as unknown as Record<string, unknown>)['rogueAccessor'], code('store_view_method_unsupported'));
    assert.equal(getterRan, false, 'the refusal fires before the getter runs');
  } finally { delete (Store.prototype as unknown as Record<string, unknown>)['rogueAccessor']; }
  // Declared members stay readable; an absent property reads as undefined.
  assert.equal(view.path, store.path);
  assert.equal(view.databaseId, store.databaseId);
  assert.equal((view as unknown as Record<string, unknown>)['neverDeclared'], undefined);
});

test('X10 a well-formed absent guard at a refusing capture boundary is a typed refusal before publication; a malformed guard is invalid_guard', t => {
  const { store } = fixture(t);
  const head = store.write(w('carried'));
  const captured = captureView(store, { absentGuards: 'refuse' });
  const absent: TransactionGuard = { id: 'ghost', absent: true };
  let refusal: unknown;
  try { captured.view.writeMany([w('x')], [absent]); } catch (error) { refusal = error; }
  assert.ok(refusal instanceof EngineError && refusal.code === 'store_view_guard_unsupported');
  assert.deepEqual((refusal as EngineError).details, { id: 'ghost' });
  assert.equal(captured.writes.length, 0, 'nothing was published into the accumulator');
  assert.equal(captured.guards.length, 0, 'no guard was carried by the refused pack');
  assert.equal(store.get('x'), null, 'no durable record');
  // Malformed guards keep their own code.
  assert.throws(() => captured.view.writeMany([w('y')], [{ id: '', absent: true } as unknown as TransactionGuard]), code('invalid_guard'));
  assert.throws(() => captured.view.writeMany([w('y')], [{ id: 'g', revision: 0, hash: 'not-a-hash' } as unknown as TransactionGuard]), code('invalid_guard'));
  assert.throws(() => captured.view.writeMany([w('y')], [{ id: 'g', absent: true, revision: 1 } as unknown as TransactionGuard]), code('invalid_guard'));
  assert.equal(captured.writes.length, 0);
  // A well-formed Ref guard is fully carried by the same boundary.
  captured.view.writeMany([w('z')], [reference(head)]);
  assert.equal(captured.writes.length, 1);
  assert.deepEqual(captured.guards, [reference(head)]);
});

test('X43 every helper call builds a new Proxy with its own state; two views over one Store with different pending sets never share a read proof', t => {
  const { store } = fixture(t);
  const a = captureView(store, { rows: new Map<string, Revision>() });
  const b = captureView(store, { rows: new Map<string, Revision>() });
  assert.notEqual(a.view, b.view);
  assert.notEqual(a.view, store as Store);
  assert.ok(a.view instanceof Store && b.view instanceof Store);
  a.view.write(w('only-a'));
  assert.equal(a.view.get('only-a')!.revision, 1, 'the first view reads its own pending row');
  assert.equal(b.view.get('only-a'), null, 'the second view has its own pending set — no shared proof through the common Store');
  assert.equal(store.get('only-a'), null, 'nothing durable');
  b.view.write(w('only-b'));
  assert.equal(a.view.get('only-b'), null);
  assert.equal(b.view.get('only-b')!.revision, 1);
  // Guard views likewise: independent passes, no per-target cache.
  const g1 = guardView(store, []);
  const g2 = guardView(store, []);
  assert.notEqual(g1.view, g2.view);
  g1.view.write(w('g1-write'));
  assert.equal(g1.passes.length, 1);
  assert.equal(g2.passes.length, 0);
});

// ── Real producer connections (№1734-8: helper checks alone are not enough) ──

function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`Unexpected refusal: ${result.refusal.code}: ${result.refusal.message} ${JSON.stringify(result.refusal.at)}`);
  return result.value;
}
const storeSnapshot = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
const cloneJson = structuredClone;

/** The D5 fact fixture reduced to the invalidation path: one accepted repository-fact answer grounded on a file source. */
function factQ(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-q1-fact-'));
  const store = new Store(join(root, 'state.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = 'garden', block = 'garden-produce-block', target = 'discovery:output-format';
  const { level: _level, ...l1 } = projectGraph(gardenGraph(), 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'output-format',
      question: 'Which output format does the repository support?', consumer: block,
      moment: 'om-pass', blocksCurrentStage: false, resolution: 'Read repository facts during OM' }];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph), decisions: [{ pending:
    cloneJson(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target, field: 'address', value: { consumer: block, kind: 'repository-fact' } } })) as Write }] }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: 'q1-fact', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const gapSources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(store, gapSources)), gap = gaps.records.find(row => row.value.gap.target === target)!;
  const sources = structuredClone(gaps.sources) as GapRequest, records = gaps.records.map(reference);
  const command = { executable: process.execPath, args: ['-e',
    `const req=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{verdict:'supported',reasons:[]}}));`] };
  const environment = engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'fact-researcher', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'fact-assessor', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000 }, 0);
  writeFileSync(join(root, 'answer.json'), JSON.stringify({ answer: 'JSON' }));
  const source = engine.discovery.evidence.file(project, 'answer-source', root, 'answer.json', 'application/json', 0);
  function issue() {
    const requestContract: AnswerQuestionContract = { establishes: input.value.input.questions[0]!.question,
      consumer: { blocks: [...gap.value.gap.consumers] }, requirements: [cloneJson(input.value.input.contracts[0]) as unknown as Json],
      resultForm: { type: 'string' } };
    const draft = engine.discovery.create(project, 'om-g2', 'R1', block,
      [mc1FieldSpec({ input: sources.input, gap: reference(gap), contract: requestContract })], [sources.input, reference(gap)]);
    const issued = store.get<Question>(draft.value.questions[0]!)!;
    const request: Mc1QuestionRequest = { project, input: sources.input, gaps: { sources, records },
      gap: reference(gap), contract: requestContract, requirements: [{ pointer: '/contracts/0' }],
      engineQuestion: reference(issued), draft: reference(draft) };
    const question = ok(writeMc1Question(store, request));
    return { request, question, issued };
  }
  async function answer(q = issue()) {
    const citation: { source: Ref; selector: Selector } = { source: reference(store.get(source.id)!), selector: { kind: 'json-pointer', pointer: '/answer' } };
    const assessment = await assessAnswer(store, q.issued, { action: 'answer', question: q.issued.id, value: 'JSON', citations: [citation] }, environment, root);
    const draft = engine.discovery.researched(q.issued.id, q.issued.revision, reference(assessment)), answered = store.get<Question>(q.issued.id)!;
    const request: AnswerRequest = { project, question: reference(q.question), answer: answered.value.answer!,
      answeredQuestion: reference(answered), draft: reference(draft), attempt: null };
    return { ...q, request };
  }
  return { root, project, target, input, graph, gaps: { sources, records, gap }, source, environment, store, engine, issue, answer };
}

test('18 evidence.file capture inside prepareAnswerInvalidation writes nothing before the consumer B1 commit and delivers the exact successor write with its guards', async t => {
  const f = factQ(t), a = await f.answer(), accepted = ok(writeAcceptedAnswer(f.store, a.request));
  const request = { project: f.project, record: reference(accepted) };
  const unchanged = ok(prepareAnswerInvalidation(f.store, request));
  assert.equal(unchanged.invalidation, null); assert.deepEqual(unchanged.writes, []);
  writeFileSync(join(f.root, 'answer.json'), JSON.stringify({ answer: 'XML' }));
  const writeMany = f.store.writeMany.bind(f.store); let lowerWrites = 0;
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => { lowerWrites++; return writeMany(writes, guards); }) as Store['writeMany'];
  const before = storeSnapshot(f.store);
  const prepared = ok(prepareAnswerInvalidation(f.store, request));
  f.store.writeMany = writeMany;
  assert.equal(lowerWrites, 0, 'the capture never invokes the lower write path, not even for validation');
  assert.deepEqual(storeSnapshot(f.store), before, 'nothing durable before B1');
  assert.equal(f.store.get(f.source.id)!.revision, f.source.revision, 'the source head is untouched');
  assert.equal(prepared.writes.length, 1);
  assert.equal(prepared.writes[0]!.id, f.source.id);
  assert.equal(prepared.writes[0]!.kind, 'source');
  assert.equal(prepared.writes[0]!.expected, f.source.revision, 'the captured write is the exact successor of the changed file source');
  assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(reference(f.source))), 'the evidence condition reaches B1');
  const written = ok(writeGuarded(f.store, { unit: 'Q1-test', target: f.target, guards: prepared.guards, writes: prepared.writes }));
  assert.deepEqual(reference(written[0]!), prepared.invalidation!.sources[0]!.after);
  const history = ok(readAnswerInvalidation(f.store, { project: f.project, invalidation: prepared.invalidation! }));
  assert.ok(history.references.some(ref => ref.id === f.source.id));
});

test('X37 two independent captures of the same successor Source produce the canonically identical Write; a late second commit meets the plain conflict, never last-write-wins', async t => {
  const f = factQ(t), a = await f.answer(), accepted = ok(writeAcceptedAnswer(f.store, a.request));
  const request = { project: f.project, record: reference(accepted) };
  writeFileSync(join(f.root, 'answer.json'), JSON.stringify({ answer: 'XML' }));
  const first = ok(prepareAnswerInvalidation(f.store, request));
  const second = ok(prepareAnswerInvalidation(f.store, request));
  assert.equal(first.writes.length, 1); assert.equal(second.writes.length, 1);
  assert.equal(canonical(first.writes[0]!), canonical(second.writes[0]!),
    'no helper instance label, capture time or buffer number inside the successor write');
  ok(writeGuarded(f.store, { unit: 'Q1-test', target: f.target, guards: first.guards, writes: first.writes }));
  const late = writeGuarded(f.store, { unit: 'Q1-test', target: f.target, guards: second.guards, writes: second.writes });
  assert.equal(late.ok, false);
  if (!late.ok) assert.ok(['input_stale', 'revision_conflict'].includes(late.refusal.code), late.refusal.code);
  assert.equal(f.store.get(f.source.id)!.revision, f.source.revision + 1, 'one successor revision, written once');
});

/** The E2 packet fixture: two active fact gaps routed to one MC1 batch with a configured environment. */
function packetQ(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-q1-packet-'));
  const store = new Store(join(root, 'state.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = 'garden';
  const descriptors = [
    { id: 'output-format', consumer: 'garden-produce-block', kind: 'repository-fact' },
    { id: 'encoding', consumer: 'garden-consume-block', kind: 'repository-fact' },
  ] as const;
  const { level: _level, ...l1 } = projectGraph(gardenGraph(), 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = descriptors.map(item => ({
      id: item.id, question: `What is the supported ${item.id}?`, consumer: item.consumer,
      moment: 'om-pass', blocksCurrentStage: false, resolution: 'Resolve the addressed question during OM' }));
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: descriptors.map(item => ({ pending: cloneJson(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: `discovery:${item.id}`, field: 'address', value: { consumer: item.consumer, kind: item.kind } } })) as Write })) }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: 'q1-packet', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const gapSources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(store, gapSources));
  const active = gaps.records.filter(row => row.value.gap.kind === 'repository-fact' && row.value.gap.code !== 'inventory_missing' && !row.value.gap.deferral);
  const taskRequest: QuestionTaskRequest = { project, gaps: { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) },
    questions: active.map(gap => ({ gap: reference(gap), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) };
  const tasks = ok(prepareQuestionTasks(store, taskRequest));
  const routes = ok(writeRoutes(store, { project, gaps: taskRequest.gaps,
    tasks: tasks.tasks.map(task => ({ pending: cloneJson(task.writes[0]!) as Write })), catalog: { paths: ['src/format.ts'], records: [] }, previous: null }));
  const batch = routes.value.batches.find(batch => batch.model === 'MC1' && batch.items.some(item => item.target === 'discovery:encoding'))!;
  assert.ok(batch);
  const command = { executable: process.execPath, args: ['--version'] };
  function environment(amount: number) {
    return engine.environments.configure(project, { workspace: root,
      implementer: { actor: 'packet-researcher', model: 'fixture', effort: 'high', command },
      reviewer: { actor: 'packet-assessor', model: 'fixture', effort: 'high', command },
      fullCheck: command, timeoutMs: 5000, requestCapacityChars: amount },
    store.get(`environment:${project}`)?.revision ?? 0);
  }
  const configured = environment(100_000), block = 'garden-consume-block';
  const goal: AttemptGoal = { key: 'packet:repository-facts',
    questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  ok(openSeries(store, { project, block, line: 1, slice: 'packet-facts', predecessor: null, basis: null }));
  const series = ok(beginAttempt(store, { project, block, line: 1, attempt: 1, goal }));
  const request: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id,
    environment: reference(configured), attempt: { series: reference(series), ordinal: 1 }, previous: [] };
  return { root, project, store, engine, tasks, routes, batch, configured, goal, series, request, environment };
}

test('X44 environment change: the discarded historical capture leaks nothing into a later one (A), and the managed replay reads through the Environment projection with remapped guards (B)', async t => {
  // A: unmanaged MC1, no committed packet, stale environment. The historical derivation runs and is
  // discarded; on 90daf6b this path then refuses in the managed-environment proof (record_missing) —
  // Q1 keeps that boundary byte-identical and leaves zero durable effect, and the next capture is clean.
  {
    const p = packetQ(t), { store } = p;
    p.environment(100_000); // equivalent change: identical settings, new revision — the request ref is stale
    const writeMany = store.writeMany.bind(store); let lowerWrites = 0;
    store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => { lowerWrites++; return writeMany(writes, guards); }) as Store['writeMany'];
    const before = storeSnapshot(store);
    const refused = prepareQuestionPacket(store, p.request);
    assert.equal(lowerWrites, 0, 'the historical capture never calls the lower write path, not even for validation');
    assert.deepEqual(storeSnapshot(store), before, 'a discarded capture leaves nothing durable and no leaked guards');
    store.writeMany = writeMany;
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.refusal.code, 'record_missing', 'the pre-existing managed-proof boundary is unchanged');
    // The next, independent capture starts from its own empty accumulator: one issuance set, one commit.
    const currentEnvironment = reference(store.get(`environment:${p.project}`)!);
    const prepared = ok(prepareQuestionPacket(store, { ...p.request, environment: currentEnvironment }));
    assert.equal(prepared.existing, false);
    assert.equal(prepared.writes.filter(write => write.kind === 'question').length, p.batch.items.length,
      'no write leaked from the discarded capture duplicates the issuance');
    assert.equal(prepared.writes.filter(write => write.kind === 'discovery-draft').length, p.batch.items.length);
    assert.equal(prepared.writes.filter(write => write.kind === 'mc1-question').length, p.batch.items.length);
    assert.equal(new Set(prepared.writes.map(write => write.id)).size, prepared.writes.length);
    // Only exact Refs backed by this pack's own writes drop out; the observed conditions stay.
    const pending = new Set(prepared.writes.map(write => canonical({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) })));
    assert.ok(!prepared.guards.some(guard => isRef(guard) && pending.has(canonical(guard))));
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(currentEnvironment)));
    ok(writeGuarded(store, { unit: 'E2-test', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
    assert.equal(store.get(prepared.record.id)!.revision, 1);
    assert.deepEqual(ok(readQuestionPacket(store, { project: p.project, record: reference(prepared.record) })), prepared.record);
  }
  // B: managed attempt, packet committed, E1 selected, then an equivalent environment change. The replay
  // prepares through the Environment projection over the pending facade: the stale ref is remapped to the
  // current head, no write runs, and the saved packet decides the result.
  {
    const f = e4q(t, true);
    const payload = f.packet.value.packet as Record<string, Json> & { requestId: string; purpose: 'model-research' };
    const e1 = { call: payload.requestId, purpose: payload.purpose, basis: null, block: 'garden-consume-block',
      series: reference(f.series), attempt: 1, goal: f.series.value.attempts[0]!.goal,
      dispatch: { adapter: reference(f.adapter), config: reference(f.configured) }, packet: payload as Json,
      gaps: f.batch.items.flatMap(item => item.consumers.map(consumer => ({ id: item.target, goal: item.target, field: item.field, consumer }))) };
    const selected = ok(recordCall(f.store, f.project, e1));
    assert.equal(selected.repeated, false);
    const current = f.reconfigure();
    assert.ok(current.revision > f.configured.revision);
    const writeMany = f.store.writeMany.bind(f.store); let lowerWrites = 0;
    f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => { lowerWrites++; return writeMany(writes, guards); }) as Store['writeMany'];
    const before = storeSnapshot(f.store);
    const prepared = ok(prepareQuestionPacket(f.store, f.packetRequest));
    f.store.writeMany = writeMany;
    assert.equal(lowerWrites, 0, 'the replay preparation writes nothing');
    assert.deepEqual(storeSnapshot(f.store), before);
    assert.equal(prepared.existing, true);
    assert.deepEqual(prepared.writes, []);
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(reference(current))),
      'the projection remapped the stale environment condition to the current head');
    assert.ok(!prepared.guards.some(guard => isRef(guard) && guard.id === f.configured.id && guard.revision === f.configured.revision),
      'the stale environment ref does not survive the remap');
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(reference(f.packet))));
    const replay = ok(writeQuestionPacket(f.store, f.packetRequest));
    assert.equal(replay.existing, true);
    assert.deepEqual(replay.record, f.packet);
    assert.deepEqual(replay.writes, []);
  }
});

test('X14 every guard the native producer attaches during the capture rides to the final E2; a moved dependency refuses the whole pack (№1760-1, reviewer probe native-dependency)', t => {
  const p = packetQ(t), { store } = p;
  const watched = store.write(w('q1-native-dependency'));
  const required = reference(watched);
  // Attach an extra well-formed Ref guard at the producer's own writeMany point (test-side, restored).
  const create = Discovery.prototype.create;
  Discovery.prototype.create = function (this: Discovery, ...args: Parameters<Discovery['create']>) {
    const bound: Store = (this as unknown as { store: Store }).store;
    (this as unknown as { store: Store }).store = new Proxy(bound, { get(target, key) {
      if (key === 'writeMany') return (writes: Write[], guards: TransactionGuard[] = []) => target.writeMany(writes, [...guards, required]);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as (...a: never[]) => unknown).bind(target) : value;
    } });
    try { return create.apply(this, args) as ReturnType<Discovery['create']>; }
    finally { (this as unknown as { store: Store }).store = bound; }
  } as Discovery['create'];
  let result: ReturnType<typeof prepareQuestionPacket>;
  try { result = prepareQuestionPacket(store, p.request); }
  finally { Discovery.prototype.create = create; }
  const prepared = ok(result);
  assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(required)),
    'the producer-attached condition is carried in the final E2 set, not dropped by the connection');
  // A second Store moves that dependency between preparation and commit: the whole pack refuses.
  const nativeBefore = store.list('question').length;
  const second = new Store(store.path); t.after(() => second.close());
  second.write({ id: watched.id, kind: watched.kind, expected: watched.revision, value: { id: watched.id, moved: true } });
  const commit = writeGuarded(store, { unit: 'E2-test', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards });
  assert.equal(commit.ok, false);
  if (!commit.ok) assert.equal(commit.refusal.code, 'input_stale');
  assert.equal(store.get(prepared.record.id), null, 'no packet prefix survives the refused commit');
  assert.equal(store.list('question').length, nativeBefore, 'no native question became durable');
});

/** The E4 dispatch fixture reduced to one MC1 fact batch with a scenario-driven adapter. */
const q1Adapter = fileURLToPath(new URL('../../test/om-adapter-fixture.mjs', import.meta.url));
const q1Usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, reasoningOutputTokens: 10 };
const q1Confirmed = { model: 'fixture-confirmed', effort: 'high', speed: 'fast' };
function e4q(t: TestContext, managed = false) {
  const root = mkdtempSync(join(tmpdir(), 'omg-q1-e4-')), database = join(root, 'state.sqlite');
  const store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = 'garden';
  const { level: _level, ...l1 } = projectGraph(gardenGraph('cross'), 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'encoding', question: 'What encoding is supported?',
      consumer: 'garden-consume-block', moment: 'om-pass', blocksCurrentStage: false, resolution: 'Resolve the addressed question during OM' }];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = ok(writeOmInput(store, { project, expected: 0, stages })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph),
    decisions: [{ pending: cloneJson(inputDecisionWrite({ project, input: reference(base), graph: reference(graph), layers: [],
      decision: { target: 'discovery:encoding', field: 'address', value: { consumer: 'garden-consume-block', kind: 'repository-fact' } } })) as Write }] }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: 'q1-e4', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const gapSources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(store, gapSources));
  const gapRequest = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = ok(prepareQuestionTasks(store, { project, gaps: gapRequest,
    questions: gaps.records.filter(row => row.value.gap.kind === 'repository-fact' && row.value.gap.code !== 'inventory_missing' && !row.value.gap.deferral)
      .map(gap => ({ gap: reference(gap), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) }));
  const source = store.get<{ content: string }>(`source:${project}:brief`)!;
  const routes = ok(writeRoutes(store, { project, gaps: gapRequest,
    tasks: tasks.tasks.map(task => ({ pending: cloneJson(task.writes[0]!) as Write })),
    catalog: { paths: ['e4-source.txt'], records: [] }, previous: null }));
  writeFileSync(join(root, 'e4-source.txt'), 'UTF-8 is the supported encoding.');
  const batch = routes.value.batches.find(batch => batch.model === 'MC1' && batch.items.some(item => item.target === 'discovery:encoding'))!;
  assert.ok(batch);
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [q1Adapter, '--scenario', scenario, '--trace', trace] };
  const configured = engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'e4-implementer', model: 'fixture', effort: 'high', speed: 'fast', command },
    reviewer: { actor: 'e4-reviewer', model: 'fixture-reviewer', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 1000, requestCapacityChars: 100_000 }, 0);
  /** Equivalent reconfigure: identical settings, new revision — the lawful Environment change of №1734-10. */
  const reconfigure = () => engine.environments.configure(project, { workspace: root,
    implementer: { actor: 'e4-implementer', model: 'fixture', effort: 'high', speed: 'fast', command },
    reviewer: { actor: 'e4-reviewer', model: 'fixture-reviewer', effort: 'medium', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 1000, requestCapacityChars: 100_000 },
  store.get(`environment:${project}`)?.revision ?? 0);
  const adapter = store.write({ id: `adapter:${project}:e4`, kind: 'dispatch-adapter', expected: 0,
    value: { projectId: project, protocol: 'codex-stdio' } });
  const goal: AttemptGoal = { key: 'e4:fact', questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  const address = { project, block: 'garden-consume-block', line: 1 };
  ok(openSeries(store, { ...address, slice: 'e4-fixture', predecessor: null, basis: null } as never));
  const series = managed
    ? ok(managedOpenAttempt(store, { ...address, attempt: 1, goal, completion: { routes: reference(routes), batches: [batch.id] } } as never))
    : ok(beginAttempt(store, { ...address, attempt: 1, goal } as never));
  const packetRequest: QuestionPacketRequest = { project, routes: reference(routes), batch: batch.id, environment: reference(configured),
    attempt: { series: reference(series), ordinal: 1 }, previous: [] };
  const packet = ok(writeQuestionPacket(store, packetRequest)).record;
  const request: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(configured) }, role: 'implementer' };
  return { root, database, project, source, batch, packet, request, scenario, trace, store, engine,
    adapter, configured, series, packetRequest, reconfigure,
    steps(steps: Record<string, unknown>[]) { writeFileSync(scenario, JSON.stringify({ database: store.path, steps })); },
    sent() { return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; } };
}
function e4qFact(f: ReturnType<typeof e4q>) {
  return { protocol: '$answerProtocol', requestId: '$requestId', action: 'answer',
    results: [{ questionId: f.batch.items[0]!.gap, value: 'UTF-8',
      citations: [{ source: reference(f.source), selector: { kind: 'text-range', start: 0, end: f.source.value.content.length } }] }] };
}

test('X41 recordCall over the intercepted view writes E1 as exactly one guarded pack; a guard race refuses it whole with zero sends', async t => {
  for (const race of [false, true]) {
    const f = e4q(t);
    f.steps([{ research: e4qFact(f), usage: q1Usage, confirmed: q1Confirmed }]);
    const other = new Store(f.database); t.after(() => other.close());
    const writeMany = f.store.writeMany.bind(f.store);
    const packs: { writes: Write[]; guards: TransactionGuard[] }[] = [];
    let raced = false;
    f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
      packs.push({ writes, guards });
      if (race && !raced && writes.some(write => write.kind === 'call-record' && write.expected === 0)) {
        raced = true;
        // A concurrent admission moves the packet head between preparation and this commit.
        const current = other.get(f.packet.id)!;
        other.write({ id: current.id, kind: current.kind, expected: current.revision, value: current.value });
      }
      return writeMany(writes, guards);
    }) as Store['writeMany'];
    try {
      const actual = await runModelCall(f.store, f.request);
      if (!race) {
        const outcome = ok(actual);
        assert.equal(outcome.outcome?.kind, 'fact-candidates');
        assert.equal(outcome.record.value.status, 'succeeded');
        assert.deepEqual(outcome.record.value.usage, q1Usage);
        assert.equal(f.sent().length, 1);
      } else {
        assert.ok(raced, 'the racing run reached the E1 commit');
        assert.equal(actual.ok, false);
        if (!actual.ok) assert.equal(actual.refusal.code, 'input_stale');
        assert.equal(f.store.list('call-record').length, 0, 'the refused pack left no E1 prefix');
        assert.equal(f.sent().length, 0, 'a refused E1 never spawns the adapter');
      }
    } finally { f.store.writeMany = writeMany; }
    const e1 = packs.filter(pack => pack.writes.some(write => write.kind === 'call-record' && write.expected === 0));
    if (!race) {
      assert.equal(e1.length, 1, 'E1 registration is one pack, never split into separate writes');
      assert.ok(e1[0]!.writes.some(write => write.kind === 'om-call-ledger'), 'the call and its ledger commit atomically');
      assert.ok(e1[0]!.guards.some(guard => canonical(guard) === canonical(reference(f.packet))),
        'the exact E2 packet condition rides the E1 pack through the interception');
      const e1Index = packs.findIndex(pack => pack.writes.some(write => write.kind === 'call-record' && write.expected === 0));
      const claimIndex = packs.findIndex(pack => pack.writes.some(write => write.kind === 'model-call'));
      assert.ok(claimIndex > e1Index, 'E1 alone precedes the durable running claim');
    }
  }
});

/** Minimal park-intent driver: a real owner process that dies right after its preparing intent is durable. */
function startParkDriver(directory: string, database: string, run: Ref) {
  const path = join(directory, 'driver-park.mjs'), mark = join(directory, 'driver-park.json');
  writeFileSync(path, `import{writeFileSync}from'node:fs';
import{Store}from${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import{ProductEngine}from${JSON.stringify(new URL('../src/product/engine.js', import.meta.url).href)};
const store=new Store(${JSON.stringify(database)}),engine=new ProductEngine(store);
const original=store.writeMany.bind(store);let stopped=false;
store.writeMany=(writes,guards=[])=>{
 const saved=original(writes,guards);
 if(!stopped&&writes.some(w=>w.kind==='parked-candidate'&&w.value.state==='preparing')){stopped=true;
  writeFileSync(${JSON.stringify(mark)},JSON.stringify({pid:process.pid}));process.exit(71);}
 return saved;};
try{await engine.repairs.prepare('p',${JSON.stringify(run)});}catch(error){console.error(error?.stack??String(error));process.exitCode=72;}finally{store.close();}`);
  const child = spawn(process.execPath, [path], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr!.on('data', data => { stderr += String(data); }); child.stdout!.resume();
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  return { child, exit, stderr: () => stderr, checkpoint: mark };
}
async function parkCheckpoint(path: string, driver: { child: ChildProcess; exit: Promise<number | null>; stderr: () => string }) {
  if (!existsSync(path)) await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => { clearTimeout(timer); watcher.close(); driver.child.off('exit', ended); if (error) reject(error); else resolve(); };
    const ended = () => finish(existsSync(path) ? undefined : new Error(`Driver exited before checkpoint: ${driver.stderr()}`));
    const watcher = watch(dirname(path), () => { if (existsSync(path)) finish(); });
    timer = setTimeout(() => finish(new Error(`Checkpoint timeout: ${driver.stderr()}`)), 20_000);
    driver.child.once('exit', ended);
    if (existsSync(path)) finish(); else if (driver.child.exitCode !== null && driver.child.signalCode !== null) ended();
  });
}

test('X19 two recoveries that read one basis before acquire cannot both acquire: one commits, the other is refused whole without a prefix', async t => {
  const f = executionFixture(t, 'plan-defect');
  const failed = (await f.engine.executor.run('p', reference(f.plan), f.options))[0]!;
  assert.equal(failed.value.state, 'needs_plan');
  const driver = startParkDriver(f.directory, f.store.path, reference(failed));
  t.after(async () => { if (driver.child.exitCode === null && driver.child.signalCode === null) driver.child.kill('SIGKILL'); await driver.exit; });
  await parkCheckpoint(driver.checkpoint, driver);
  assert.equal(await driver.exit, 71, driver.stderr());
  const lease = readLegacyOperation(f.store, 'p')!;
  assert.equal(lease.value.operation, 'repair');
  assert.equal(f.store.list<ParkedCandidate>('parked-candidate')[0]!.value.state, 'preparing');
  f.reopen();
  const other = new Store(f.store.path); t.after(() => other.close());
  const markerHistory = f.store.history('legacy-operation:p').length;
  const lockHistory = f.store.history('execution-lock:p').length;
  // The raced recovery computed its basis (operation head and absent-or-exact lock) before this commit.
  const writeMany = f.store.writeMany.bind(f.store); let raced = false; let competing: Revision<ExecutionLock> | undefined;
  const acquirePacks: { writes: Write[]; guards: TransactionGuard[] }[] = [];
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    if (writes.some(write => write.id === 'execution-lock:p')) acquirePacks.push({ writes, guards });
    if (!raced && writes.some(write => write.id === 'execution-lock:p')) { raced = true; competing = acquire(other, 'p'); }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  await assert.rejects(
    recoverLegacyOperation(f.engine, { project: 'p', operation: reference(lease), token: lease.value.token }),
    (error: unknown) => error instanceof EngineError && ['input_stale', 'revision_conflict'].includes(error.code));
  f.store.writeMany = writeMany;
  assert.ok(raced, 'the recovery reached the guarded acquire');
  // The acquire pack carried the operation head and the lock condition — a bypassed view would drop them.
  assert.equal(acquirePacks.length, 1);
  const operationHead = f.store.get('legacy-operation:p')!;
  assert.ok(acquirePacks[0]!.guards.some(guard => canonical(guard) === canonical(reference(operationHead))),
    'the acquire commit is guarded by the exact operation head observed at basis read');
  assert.ok(acquirePacks[0]!.guards.some(guard => guard.id === 'execution-lock:p'),
    'the acquire commit is guarded by the lock condition observed at basis read');
  assert.equal(f.store.list<ParkedCandidate>('parked-candidate')[0]!.value.state, 'preparing', 'no separate prefix of the refused recovery');
  assert.equal(f.store.history('legacy-operation:p').length, markerHistory, 'no second acquire or release record');
  assert.equal(f.store.history('execution-lock:p').length, lockHistory + 1, 'only the competing acquire landed');
  release(other, competing!);
  // After the refused racer the lawful recovery completes the exact parking once.
  const released = await recoverLegacyOperation(f.engine, { project: 'p', operation: reference(lease), token: lease.value.token });
  assert.equal(released.value.state, 'released');
  assert.equal(f.store.list<ParkedCandidate>('parked-candidate')[0]!.value.state, 'parked');
});

// ── S1.1 (№1887): the write-only view over a plain Store is a frozen facade, not a Proxy ──

test('S1.1 a write-only view over a plain Store is no Proxy: one history proves once per operation through it, other views keep their own proofs, a record that appears re-proves, a collector sees the same references cold, hot and warmed, a view over a lower collector stays correct uncached, both write forms from pendingCallStore reach the policy, and the refusals of 12/X4 hold', t => {
  const { store } = fixture(t);
  const { view, passes } = guardView(store, []);
  assert.equal(isProxyObject(view), false); assert.ok(view instanceof Store); assert.ok(Object.isFrozen(view));
  const other = guardView(store, []).view, capture = captureView(store, {}).view, nested = guardView(view as Store, []).view;
  assert.equal(isProxyObject(other), false); assert.equal(isProxyObject(nested), false, 'a write-only view over a write-only view of this module stays a facade');
  assert.equal(isProxyObject(capture), true, 'a capture keeps its opaque Proxy');
  store.write(w('base'));
  let runs = 0;
  const key = { reader: 'S1.1.store-view', project: 'garden', ref: reference(store.get('base')!) };
  const prove = (source: Store) => historicalProof(source, key, s => { runs++; return { base: reference(s.get('base')!), absent: s.get('absent') === null }; },
    () => { throw new Error('cyclic'); });
  withHistoricalReads(() => {
    const first = prove(view); assert.equal(runs, 1); assert.deepEqual(first, { base: key.ref, absent: true });
    assert.deepEqual(prove(view), first); assert.equal(runs, 1, 'one full derivation per key inside the operation through the write-only view');
    // S1.3 (№2194-1): the write-only views this module built over one Store read exactly that Store and share its proofs.
    assert.deepEqual(prove(other), first); assert.equal(runs, 1, 'another write-only view over the same Store shares its proof');
    assert.deepEqual(prove(nested), first); assert.equal(runs, 1, 'a view over a view of this module shares it too');
    prove(capture); assert.equal(runs, 2, 'a capture keeps its own proof');
    // The absent record appears: the kept proof's footprint moved, so the next read through the view derives again.
    store.write(w('absent'));
    assert.deepEqual(prove(view), { base: key.ref, absent: false }); assert.equal(runs, 3);
    assert.equal(prove(other).absent, false); assert.equal(runs, 3);
  });
  // S1.3 (№2185-4): the kept complete proof of this Store serves the next operation while its footprint stays current.
  withHistoricalReads(() => { assert.equal(prove(view).absent, false); assert.equal(runs, 3, 'a new operation reuses the kept proof'); });
  // The collector attached above the view: the same references cold, hot, and when the proof was warmed before it attached.
  const cold: Ref[] = [], hot: Ref[] = [], warmed: Ref[] = [];
  withHistoricalReads(() => {
    prove(historicalTrace(view, ref => cold.push(ref)));
    prove(historicalTrace(view, ref => hot.push(ref)));
  });
  withHistoricalReads(() => { prove(view); prove(historicalTrace(view, ref => warmed.push(ref))); });
  assert.equal(cold.length, 2); assert.deepEqual(hot, cold); assert.deepEqual(warmed, cold);
  // A view over a lower collector keeps the opaque Proxy: the collector below sees every read, nothing is served hot past it.
  const below: Ref[] = [];
  const overCollector = guardView(historicalTrace(store, ref => below.push(ref)), []).view;
  assert.equal(isProxyObject(overCollector), true);
  withHistoricalReads(() => { const before = runs; prove(overCollector); prove(overCollector); assert.equal(runs, before + 2); });
  assert.equal(below.length, 4, 'the lower collector observed both derivations');
  // Both write forms from pendingCallStore over the facade reach the policy; the pending row reads through the overlay.
  const pending = pendingCallStore(view, [w('pending-row')]);
  assert.equal(isProxyObject(pending), false); assert.equal(pending.get('pending-row')!.revision, 1); assert.equal(store.get('pending-row'), null);
  const before = passes.length;
  pending.write(w('via-write')); pending.writeMany([w('via-many')], []);
  assert.equal(passes.length, before + 2); assert.ok(store.get('via-write') && store.get('via-many'));
  // The refusals of 12/X4 on the facade: refused members and later additions, declared members readable.
  assert.equal(typeof view.close, 'function'); assert.throws(() => view.close(), code('store_view_method_unsupported'));
  assert.throws(() => new (view.constructor as new (p: string) => Store)('x'), code('store_view_method_unsupported'));
  (Store.prototype as unknown as Record<string, unknown>)['laterMethod'] = function () { return 1; };
  Object.defineProperty(Store.prototype, 'laterAccessor', { configurable: true, get() { return 1; } });
  try {
    assert.equal(typeof (view as unknown as Record<string, unknown>)['laterMethod'], 'function');
    assert.throws(() => (view as unknown as { laterMethod: () => void }).laterMethod(), code('store_view_method_unsupported'));
    assert.throws(() => (view as unknown as Record<string, unknown>)['laterAccessor'], code('store_view_method_unsupported'));
  } finally {
    delete (Store.prototype as unknown as Record<string, unknown>)['laterMethod'];
    delete (Store.prototype as unknown as Record<string, unknown>)['laterAccessor'];
  }
  assert.equal(view.path, store.path); assert.equal(view.databaseId, store.databaseId);
  assert.equal((view as unknown as Record<string, unknown>)['neverDeclared'], undefined);
  store.write(w('still-open')); assert.ok(store.get('still-open'));
});

test('S1.1 (№2008) the fast branch needs proved reads and the facade resolves unknown members against the nearest target: a frozen shell on Store.prototype with own reading accessors over a traced Store keeps the opaque Proxy (two bodies, two observations), an own reading override forbids the facade, own and later members of the instance refuse before running', t => {
  const { store } = fixture(t);
  const row = store.write(w('base'));
  const shell = (target: Store): Store => {
    const view = Object.create(Store.prototype) as Record<string, unknown>;
    Object.defineProperties(view, { path: { value: target.path }, databaseId: { get: () => target.databaseId } });
    for (const name of ['get', 'list', 'history', 'write', 'writeMany'] as const)
      Object.defineProperty(view, name, { get: () => (target[name] as (...args: never[]) => unknown).bind(target) });
    return Object.freeze(view) as unknown as Store;
  };
  const policy = (target: Store): StoreViewPolicy => ({ write: (writes, guards) => target.writeMany(writes, guards) });
  const key = { reader: 'S1.1.shell', project: 'garden', ref: reference(row) };
  const probe = (view: Store) => withHistoricalReads(() => {
    let bodies = 0;
    const read = () => historicalProof(view, key, seen => { bodies++; return seen.get(row.id, 1); }, () => { throw new Error('cyclic'); });
    assert.deepEqual(read(), row); assert.deepEqual(read(), row);
    return bodies;
  });
  // The rule itself: a genuine instance (exactly its own `path`), never a shell — with or without own members.
  assert.equal(genuineStore(store), true); assert.equal(provenReads(store), true);
  assert.equal(genuineStore(Object.create(Store.prototype)), false, 'A bare object on Store.prototype is no Store');
  assert.equal(genuineStore(shell(store)), false); assert.equal(provenReads(shell(store)), false);
  assert.equal(genuineStore(historicalTrace(store)), false);
  const writeOnly = storeView(store, policy(store));
  assert.equal(isProxyObject(writeOnly), false); assert.equal(genuineStore(writeOnly), false); assert.equal(provenReads(writeOnly), true, 'A write-only view of this module is proved reads');
  assert.equal(provenReads(captureView(store, {}).view), false);
  // The reviewer's shell (№2008-1): not a Proxy, Store.prototype beneath, own reading accessors reaching a traced Store.
  let observed = 0;
  const lower = shell(historicalTrace(store, () => observed++));
  assert.equal(isProxyObject(lower), false); assert.equal(Object.getPrototypeOf(lower), Store.prototype);
  const opaque = storeView(lower, policy(lower));
  assert.equal(isProxyObject(opaque), true, 'A shell of unknown reads keeps the opaque Proxy');
  assert.equal(probe(opaque), 2); assert.equal(observed, 2, 'The lower collector sees both readings');
  // A genuine Store carrying an own reading override is not proved any more: the opaque Proxy again.
  const overridden = new Store(store.path); t.after(() => overridden.close());
  Object.defineProperty(overridden, 'get', { value: overridden.get.bind(overridden) });
  assert.equal(genuineStore(overridden), false); assert.equal(isProxyObject(storeView(overridden, policy(overridden))), true);
  // An own member added before the view: no facade; the Proxy refuses it as before.
  const early = new Store(store.path); t.after(() => early.close());
  (early as unknown as Record<string, unknown>)['earlyOwn'] = () => 'ran';
  const earlyView = storeView(early, policy(early)) as unknown as Record<string, () => unknown>;
  assert.equal(isProxyObject(earlyView), true); assert.equal(typeof earlyView['earlyOwn'], 'function');
  assert.throws(() => earlyView['earlyOwn']!(), (error: unknown) => error instanceof EngineError && error.code === 'store_view_method_unsupported');
  // №2008-2: own and later members of the instance beneath the facade — resolved against the nearest target at access,
  // the method is a refusing function (typeof stays 'function'), the accessor refuses before its getter runs.
  let touched = 0;
  const facade = writeOnly as unknown as Record<string, unknown>;
  (store as unknown as Record<string, unknown>)['laterOwn'] = () => { touched++; return 'ran'; };
  Object.defineProperty(store, 'ownAccessor', { get: () => { touched++; return 1; }, configurable: true });
  assert.equal(typeof facade['laterOwn'], 'function');
  assert.throws(() => (facade['laterOwn'] as () => unknown)(), (error: unknown) => error instanceof EngineError && error.code === 'store_view_method_unsupported');
  assert.throws(() => facade['ownAccessor'], (error: unknown) => error instanceof EngineError && error.code === 'store_view_method_unsupported');
  assert.equal(touched, 0, 'Neither the own method nor the own getter ran');
  assert.equal(facade['absentMember'], undefined);
  assert.equal(typeof facade['snapshot'], 'function'); assert.throws(() => (facade['snapshot'] as () => unknown)(), (error: unknown) => error instanceof EngineError && error.code === 'store_view_method_unsupported');
  assert.ok(writeOnly instanceof Store); assert.deepEqual(writeOnly.get('base'), row);
  // The proved fast branch is unchanged: one body per operation through the facade, and the same through a facade over it.
  assert.equal(probe(writeOnly), 1); assert.equal(probe(storeView(writeOnly, policy(writeOnly))), 1);
});

test('S1.3 (№2194-1) provenStore names the genuine Store beneath the write-only views this module built, only while their bound reads are still its reads', t => {
  const { store } = fixture(t);
  const view = guardView(store, []).view, nested = guardView(view, []).view, other = guardView(store, []).view;
  assert.deepEqual([provenStore(store), provenStore(view), provenStore(nested), provenStore(other)], [store, store, store, store]);
  const policy: StoreViewPolicy = { write: (writes, guards) => store.writeMany(writes, guards) };
  assert.equal(provenStore(captureView(store, {}).view), null, 'a capture has its own reads');
  assert.equal(provenStore(storeView(store, { ...policy, get: () => undefined })), null, 'a read projection is not the Store');
  assert.equal(provenStore(historicalTrace(store)), null, 'a trace is its own view');
  assert.equal(provenStore(new Proxy(store, {})), null, 'an arbitrary Proxy proves nothing');
  assert.equal(provenStore(Object.freeze(Object.create(Object.getPrototypeOf(view)))), null, 'a copy of the facade shape was not built by this module');
  assert.equal(provenStore(null), null); assert.equal(provenStore({}), null);
  class Subclass extends Store {}
  const subclass = new Subclass(store.path);
  try {
    assert.equal(provenStore(subclass), null, 'a subclass may read differently');
    assert.equal(provenStore(storeView(subclass, policy)), null, 'a view over it has no genuine Store beneath');
  } finally { subclass.close(); }
  const original = Store.prototype.history;
  Store.prototype.history = function (this: Store, ...args: Parameters<typeof original>) { return original.apply(this, args); } as typeof original;
  try {
    assert.equal(provenStore(store), store, 'the Store itself reads through its prototype as it is now');
    assert.equal(provenStore(view), null, 'a view bound the replaced read: its reads are no longer the Store\'s');
    assert.equal(provenStore(nested), null);
    assert.equal(provenStore(guardView(store, []).view), store, 'a view built after the replacement binds the current read');
  } finally { Store.prototype.history = original; }
  assert.equal(provenStore(view), store, 'with the original read restored the kinship is proved again');
});

test('PF1 (№2797-2, -3) a pending overlay owns detached frozen copies of its rows: get answers a row at its head and own revision, every other read and both writes go to the base, later rows of one id replace earlier ones, layers stay layers, and readServer names the row, the genuine Store through proved layers, or nobody', t => {
  const { store } = fixture(t);
  const x1 = store.write({ id: 'pf1:x', kind: 'k', expected: 0, value: { v: 1 } });
  store.write({ id: 'pf1:x', kind: 'k', expected: 1, value: { v: 2 } });
  const y = store.write({ id: 'pf1:y', kind: 'k', expected: 0, value: { y: 1 } });
  const value = { v: 3, nested: { n: 1 } };
  const row = (id: string, revision: number, body: Json): Revision<Json> => ({ id, kind: 'k', revision, hash: hashJson(body), value: body });
  const rows = [row('pf1:x', 3, value as unknown as Json), row('pf1:z', 1, { z: 'first' }), row('pf1:z', 1, { z: 'last' })];
  const overlay = pendingOverlay(store, rows);
  value.nested.n = 2; (rows[1]!.value as { z: string }).z = 'changed';
  assert.ok(!types.isProxy(overlay) && overlay instanceof Store && Object.isFrozen(overlay), 'over a genuine Store the overlay is a frozen object');
  assert.deepEqual([overlay.get('pf1:x')!.value, overlay.get('pf1:x', 3)!.value], [{ v: 3, nested: { n: 1 } }, { v: 3, nested: { n: 1 } }],
    'the head and the own revision are the row as it was given, whatever the caller does with its objects later');
  assert.deepEqual(overlay.get('pf1:z')!.value, { z: 'last' }, 'a later row of one id replaces an earlier one');
  assert.ok(!Object.isFrozen(value) && !Object.isFrozen(value.nested), 'the caller\'s objects are not frozen in place');
  assert.throws(() => { (overlay.get('pf1:x')!.value as { nested: { n: number } }).nested.n = 9; }, TypeError, 'a returned row cannot change the snapshot');
  assert.deepEqual(overlay.get('pf1:x', 2)!.value, { v: 2 }, 'another revision of the same id is the base\'s');
  assert.deepEqual([overlay.get('pf1:x', 1), overlay.get(y.id), overlay.get('pf1:absent')], [store.get(x1.id, 1), store.get(y.id), null]);
  assert.deepEqual([overlay.list('k').map(item => item.id), overlay.history('pf1:x').map(item => item.revision), overlay.history('pf1:z')],
    [store.list('k').map(item => item.id), [1, 2], []], 'list and history show no pending row');
  assert.deepEqual(overlay.identities('get', 'pf1:z'), store.identities('get', 'pf1:z'), 'identities are the base\'s too');
  // Layers: an inner X@2 under an outer X@3 — the head and X@3 are the outer's, X@2 the inner's, X@1 the base's.
  const inner = pendingOverlay(store, [row('pf1:w', 2, { w: 2 })]);
  const outer = pendingOverlay(inner, [row('pf1:w', 3, { w: 3 })]);
  assert.deepEqual([outer.get('pf1:w')!.value, outer.get('pf1:w', 3)!.value, outer.get('pf1:w', 2)!.value, outer.get('pf1:w', 1)], [{ w: 3 }, { w: 3 }, { w: 2 }, null]);
  assert.deepEqual([readServer(outer, 'get', 'pf1:w', undefined), readServer(outer, 'get', 'pf1:w', 2), readServer(outer, 'get', 'pf1:w', 1),
    readServer(outer, 'get', 'pf1:y', undefined), readServer(outer, 'list', 'k', undefined), readServer(outer, 'history', 'pf1:w', undefined)],
    ['pending', 'pending', store, store, store, store], 'the row of a layer is answered by that layer; everything else by the Store beneath');
  assert.equal(readServer(overlay, 'list', 'pf1:x', undefined), store, 'a method other than get is never a pending row');
  // Writes go to the nearest view with its own restrictions; a write-only view of this module is a proved link.
  const written: string[] = [];
  const guard = storeView(store, { write: (inputs, guards) => { written.push(...inputs.map(input => input.id)); return store.writeMany(inputs, guards); } });
  const overGuard = pendingOverlay(guard, [row('pf1:g', 1, { g: 1 })]);
  overGuard.write({ id: 'pf1:written', kind: 'k', expected: 0, value: {} });
  overGuard.writeMany([{ id: 'pf1:written', kind: 'k', expected: 1, value: { again: true } }], []);
  assert.deepEqual(written, ['pf1:written', 'pf1:written'], 'both write forms reach the nearest view\'s policy');
  assert.equal(readServer(overGuard, 'get', 'pf1:y', undefined), store);
  // Unknown links break the chain: a caller's Proxy, a capture, a Transaction preview; an opaque base keeps the opaque overlay.
  const proxy = new Proxy(store, { get: (target, key) => { const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member; } });
  const overProxy = pendingOverlay(proxy, [row('pf1:p', 1, { p: 1 })]);
  assert.ok(types.isProxy(overProxy), 'over an unproved base the overlay stays an opaque Proxy');
  assert.deepEqual([overProxy.get('pf1:p')!.value, overProxy.get(y.id)], [{ p: 1 }, store.get(y.id)]);
  assert.equal(readServer(overProxy, 'get', 'pf1:p', undefined), null, 'an opaque overlay is no layer, not even for its own row');
  const capture = captureView(store, { rows: new Map() });
  assert.equal(readServer(pendingOverlay(capture.view, [row('pf1:c', 1, {})]), 'get', 'pf1:y', undefined), null, 'a capture is no proved link');
  const tx = transactionForTests(store);
  const overPreview = pendingOverlay(tx.view, [row('pf1:t', 1, {})]);
  assert.ok(!types.isProxy(overPreview), 'a Transaction preview is admitted beneath as before (№2012-2)');
  assert.deepEqual([readServer(overPreview, 'get', 'pf1:t', undefined), readServer(overPreview, 'get', 'pf1:y', undefined)], ['pending', null],
    'its own row is still constant, but a read the mutable preview answers has no witness');
  assert.equal(readServer(proxy, 'get', 'pf1:y', undefined), null);
  assert.equal(readServer(store, 'get', 'pf1:y', undefined), store, 'a genuine Store serves itself');
  // A base whose read members change after the overlay was built is no longer the overlay's proved base.
  const original = Store.prototype.history;
  Store.prototype.history = function (this: Store, ...args: Parameters<typeof original>) { return original.apply(this, args); } as typeof original;
  try {
    assert.equal(readServer(overlay, 'history', 'pf1:x', undefined), null, 'the overlay bound the replaced read: no witness');
    assert.equal(readServer(overlay, 'get', 'pf1:x', undefined), 'pending', 'its own frozen row does not depend on the base');
  } finally { Store.prototype.history = original; }
  assert.equal(readServer(overlay, 'history', 'pf1:x', undefined), store, 'with the original read restored the chain is proved again');
});

test('PF2 (№2905) the selections a chain of pending layers answers itself are handed out only as frozen id/revision pairs — none over a link of unknown origin or a base whose bound reads were replaced — and only a registered layer reports its own answers, as itself', t => {
  const { store } = fixture(t);
  const row = (id: string, revision: number, body: Json): Revision<Json> => ({ id, kind: 'k', revision, hash: hashJson(body), value: body });
  const inner = pendingOverlay(store, [row('pf2:a', 1, { a: 1 })]), outer = pendingOverlay(inner, [row('pf2:b', 2, { b: 2 }), row('pf2:a', 3, { a: 3 })]);
  const selections = pendingSelections(outer)!;
  assert.deepEqual(selections, [['pf2:b', 2], ['pf2:a', 3], ['pf2:a', 1]]);
  assert.ok(Object.isFrozen(selections) && selections.every(pair => Object.isFrozen(pair)) && pendingSelections(outer) !== selections, 'A new frozen list of pairs, no row');
  assert.deepEqual(pendingSelections(store), []);
  const proxy = new Proxy(store, { get: (target, key) => { const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member; } });
  const opaque = pendingOverlay(proxy, [row('pf2:p', 1, {})]);
  assert.deepEqual([pendingSelections(opaque), pendingSelections(pendingOverlay(captureView(store).view, [row('pf2:c', 1, {})]))], [null, null]);
  const seen: [string, string, number | undefined][] = [];
  const previous = observePendingReads((layer, id, revision) => { seen.push([layer === outer ? 'outer' : layer === inner ? 'inner' : 'other', id, revision]); });
  try {
    outer.get('pf2:b'); outer.get('pf2:a', 3); outer.get('pf2:a', 1); outer.get('pf2:none'); opaque.get('pf2:p');
  } finally { observePendingReads(previous); }
  assert.deepEqual(seen, [['outer', 'pf2:b', undefined], ['outer', 'pf2:a', 3], ['inner', 'pf2:a', 1]], 'Each answer by its own layer; the opaque Proxy stays silent');
  const list = Store.prototype.list;
  Store.prototype.list = function (this: Store, ...args: Parameters<typeof list>) { return list.apply(this, args); } as typeof list;
  try { assert.equal(pendingSelections(outer), null, 'A base read replaced after the layers were built ends the proved chain'); }
  finally { Store.prototype.list = list; }
});

test('PF3.3 (№3568 rows 1-4, 7-10, 12) a pending overlay over a historical trace is a registered layer whose chain crosses the trace: its own rows are pending, every other read is witnessed by the Store beneath through each overlap — for the witness only, the plain chain still ends at the trace; a Proxy of any other making, a projection beneath and a replaced member keep the conservative path', t => {
  const { root, store } = fixture(t);
  const row = (id: string, revision: number, body: Json): Revision<Json> => ({ id, kind: 'k', revision, hash: hashJson(body), value: body });
  store.write({ id: 'pf33:x', kind: 'k', expected: 0, value: { v: 1 } });
  store.write({ id: 'pf33:x', kind: 'k', expected: 1, value: { v: 2 } });
  const y = store.write({ id: 'pf33:y', kind: 'k', expected: 0, value: { y: 1 } });
  store.write({ id: 'pf33:%_Ö', kind: 'k', expected: 0, value: { literal: true } });
  const trace = historicalTrace(store);
  assert.notEqual(trace.get, trace.get, 'Row 12: a trace makes a new wrapper of its read at every access');
  const value = { v: 3, nested: { n: 1 } };
  const rows = [row('pf33:x', 3, value as unknown as Json), row('pf33:z', 1, { z: 'first' }), row('pf33:z', 1, { z: 'last' })];
  const layer = pendingOverlay(trace, rows);
  value.nested.n = 2; (rows[1]!.value as { z: string }).z = 'changed';
  assert.ok(!types.isProxy(layer) && layer instanceof Store && Object.isFrozen(layer), 'Over a trace of a genuine Store the overlay is a registered layer');
  assert.deepEqual([layer.get('pf33:x')!.value, layer.get('pf33:x', 3)!.value, layer.get('pf33:z')!.value], [{ v: 3, nested: { n: 1 } }, { v: 3, nested: { n: 1 } }, { z: 'last' }],
    'Rows 2, 4: its own head and revision, the last row of an id, a snapshot the caller can no longer change');
  assert.deepEqual([layer.get('pf33:x', 2)!.value, layer.get('pf33:x', 1)!.value, layer.get(y.id)!.value, layer.get('pf33:absent'), layer.get('pf33:x', 9)],
    [{ v: 2 }, { v: 1 }, { y: 1 }, null, null], 'Row 3: another revision of its id, another id and an absence are the base\'s');
  assert.deepEqual([layer.list('k'), layer.list('none'), layer.list(), layer.history('pf33:x'), layer.history('pf33:z'), layer.identities('prefix', 'pf33:%_'), layer.identities('prefix', 'PF33:')],
    [store.list('k'), [], store.list(), store.history('pf33:x'), [], store.identities('prefix', 'pf33:%_'), []], 'Row 7: list, history and prefix are the base\'s, literal and case-sensitive, empty or not');
  assert.deepEqual([readServer(layer, 'get', 'pf33:x', undefined, true), readServer(layer, 'get', 'pf33:x', 3, true), readServer(layer, 'get', 'pf33:x', 2, true),
    readServer(layer, 'get', y.id, undefined, true), readServer(layer, 'get', 'pf33:absent', undefined, true), readServer(layer, 'list', 'k', undefined, true), readServer(layer, 'history', 'pf33:z', undefined, true)],
    ['pending', 'pending', store, store, store, store, store], 'Rows 1-3: the witness of a delegated read is the Store beneath the trace');
  assert.deepEqual([readServer(layer, 'get', y.id, undefined), readServer(layer, 'get', 'pf33:x', undefined), pendingSelections(layer), tracedChain(layer), tracedChain(pendingOverlay(store, rows))],
    [null, 'pending', null, true, false], 'Without traces the chain ends at the trace as before: no sharing or adoption rests on it');
  // Row 8: layer → trace → layer → trace → Store; every overlap is decided where it is.
  const inner = pendingOverlay(historicalTrace(store), [row('pf33:w', 2, { w: 2 }), row('pf33:v', 1, { v: 'inner' })]);
  const outer = pendingOverlay(historicalTrace(inner), [row('pf33:w', 3, { w: 3 })]);
  assert.ok(!types.isProxy(inner) && !types.isProxy(outer));
  assert.deepEqual([outer.get('pf33:w')!.value, outer.get('pf33:w', 2)!.value, outer.get('pf33:w', 1), outer.get('pf33:v')!.value, outer.get(y.id)!.value],
    [{ w: 3 }, { w: 2 }, null, { v: 'inner' }, { y: 1 }]);
  assert.deepEqual([readServer(outer, 'get', 'pf33:w', undefined, true), readServer(outer, 'get', 'pf33:w', 2, true), readServer(outer, 'get', 'pf33:w', 1, true),
    readServer(outer, 'get', 'pf33:v', undefined, true), readServer(outer, 'get', y.id, undefined, true), readServer(outer, 'list', 'k', undefined, true)],
    ['pending', 'pending', store, 'pending', store, store], 'Row 8: the outer row, the inner rows beneath it, and the Store for the rest');
  // Row 9: a Proxy of any other making, in any position, however alike, keeps the opaque overlay and no witness.
  const passThrough = <T extends object>(target: T): T => new Proxy(target, { get: (object, key) => {
    const member: unknown = Reflect.get(object, key, object); return typeof member === 'function' ? member.bind(object) : member; } });
  const lookalike = Object.freeze(Object.create(trace) as Store);
  for (const [name, base] of [['a trace over a caller\'s Proxy', historicalTrace(passThrough(store))], ['a caller\'s Proxy over a trace', passThrough(trace)],
    ['a frozen object inheriting from a trace', lookalike], ['a trace over an opaque overlay', historicalTrace(pendingOverlay(passThrough(store), [row('pf33:q', 1, {})]))],
    ['a trace over a frozen Proxy', historicalTrace(Object.freeze(passThrough(store)) as Store)]] as [string, Store][]) {
    const over = pendingOverlay(base, [row('pf33:o', 1, { o: 1 })]);
    assert.ok(types.isProxy(over), `Row 9: ${name} is no proved source`);
    assert.deepEqual([over.get('pf33:o')!.value, over.get(y.id)!.value, readServer(over, 'get', y.id, undefined, true), readServer(over, 'get', 'pf33:o', undefined, true)],
      [{ o: 1 }, { y: 1 }, null, null], `Row 9: ${name} answers as before and has no witness`);
  }
  // Row 9: the one observer of traces is the engine's; no caller puts another between a trace and its source.
  assert.throws(() => observeTraceReads((_view, _method, _id, _revision, read) => { const rows = read() as Revision<Json>; return rows; }), (error: unknown) =>
    error instanceof EngineError && error.code === 'store_view_composition_unsupported');
  assert.deepEqual([transparentTrace(store).get(y.id), transparentTrace(store).list('k'), transparentTrace(store).history('pf33:x')], [store.get(y.id), store.list('k'), store.history('pf33:x')],
    'A trace of the factory reads exactly what its source reads');
  // Row 10: a Transaction preview or a capture beneath a trace, and another database.
  const tx = transactionForTests(store);
  const overPreview = pendingOverlay(historicalTrace(tx.view), [row('pf33:t', 1, {})]);
  assert.ok(!types.isProxy(overPreview), 'A preview beneath a trace is admitted as it is beneath a layer (№2012-2)');
  assert.deepEqual([readServer(overPreview, 'get', 'pf33:t', undefined, true), readServer(overPreview, 'get', y.id, undefined, true)], ['pending', null], 'Row 10: what the preview answers has no witness');
  assert.ok(types.isProxy(pendingOverlay(historicalTrace(captureView(store).view), [row('pf33:c', 1, {})])), 'Row 10: a capture beneath a trace is no proved source');
  const other = new Store(join(root, 'other.sqlite'));
  t.after(() => other.close());
  const overOther = pendingOverlay(historicalTrace(other), [row('pf33:u', 1, {})]);
  assert.equal(readServer(overOther, 'get', y.id, undefined, true), other, 'Row 10: another database is its own witness, never this one');
  // Row 12: the member the trace finally invokes is the one bound; its replacement under the same sequence ends the chain.
  const sequence = store.lastEvent(), original = Store.prototype.get;
  Store.prototype.get = function (this: Store, ...args: Parameters<typeof original>) { return original.apply(this, args); } as typeof original;
  try {
    assert.deepEqual([readServer(layer, 'get', y.id, undefined, true), readServer(layer, 'get', 'pf33:x', undefined, true), readServer(outer, 'get', y.id, undefined, true)],
      [null, 'pending', null], 'A replaced read beneath the trace leaves no witness; the own frozen row stays');
  } finally { Store.prototype.get = original; }
  assert.deepEqual([store.lastEvent(), readServer(layer, 'get', y.id, undefined, true), readServer(layer, 'list', 'k', undefined, true)], [sequence, store, store],
    'Restored, the same chain is proved again at the same sequence');
});

// PF3 (№3424): the body cache of a Store. Each test names the rows of outcome table §5 it pins down.
function bodyDelta(before: StoreBodyCache): Omit<StoreBodyCache, 'limit'> {
  const now = storeBodyCache();
  return { hits: now.hits - before.hits, misses: now.misses - before.misses, loads: now.loads - before.loads,
    loadedChars: now.loadedChars - before.loadedChars, digests: now.digests - before.digests, parses: now.parses - before.parses,
    kept: now.kept - before.kept, evictions: now.evictions - before.evictions, oversized: now.oversized - before.oversized,
    resets: now.resets - before.resets, bytes: now.bytes - before.bytes, entries: now.entries - before.entries };
}
function recordingObserver(store: Store, events: unknown[]): StoreObserver {
  return { begin: () => ({}), write: () => {}, untraced: () => {},
    end: (_token, source, method, mode, id, revision, rows) => { events.push(canonical([source === store, method, mode, id ?? null, revision ?? null, rows as unknown as Json])); } };
}

test('PF3 rows 1-4, 14, 15: cold and warm reads give the same new Revisions; a warm exact body is neither loaded nor hashed again; identities read no body; every public read is one observed read', t => {
  const { store } = fixture(t);
  store.writeMany([{ id: 'pf3:a', kind: 'pf3-k', expected: 0, value: { n: 1, nested: { list: [1, 2] } } },
    { id: 'pf3:b', kind: 'pf3-other', expected: 0, value: { text: 'тело' } }]);
  store.write({ id: 'pf3:a', kind: 'pf3-k', expected: 1, value: { n: 2, nested: { list: [3] } } });
  const reads = () => [store.get('pf3:a'), store.get('pf3:a', 1), store.get('pf3:missing'), store.get('pf3:a', 9),
    store.list(), store.list('pf3-k'), store.list('pf3-none'), store.history('pf3:a'), store.history('pf3:missing')];
  const events: unknown[] = [], previous = observeStore(recordingObserver(store, events));
  let cold: unknown[], warm: unknown[], coldEvents: unknown[], warmEvents: unknown[];
  try {
    const before = storeBodyCache(), counted = storeReads();
    cold = reads(); coldEvents = events.splice(0);
    const first = bodyDelta(before);
    assert.equal(storeReads() - counted, 9, 'Every public read is counted once');
    assert.deepEqual([first.loads, first.digests], [3, 3], 'Three distinct exact bodies are loaded and checked once each');
    const again = storeBodyCache(), recounted = storeReads();
    warm = reads(); warmEvents = events.splice(0);
    const second = bodyDelta(again);
    assert.equal(storeReads() - recounted, 9);
    assert.deepEqual([second.loads, second.digests, second.loadedChars, second.hits, second.parses], [0, 0, 0, 7, 7],
      'A warm exact body is neither loaded nor hashed again, but every result is parsed anew');
    assert.equal(canonical(warm as Json), canonical(cold as Json));
    assert.deepEqual(warmEvents, coldEvents, 'A hit is the same logical read for the observer: method, request and rows');
    assert.equal(coldEvents.length, 9, 'No inner SQL is reported as a read');
    const plain = storeBodyCache();
    assert.deepEqual(store.identities('get', 'pf3:a').map(row => [row.id, row.revision, row.kind]), [['pf3:a', 2, 'pf3-k']]);
    assert.deepEqual(store.identities('list').map(row => row.id), ['pf3:a', 'pf3:b']);
    assert.deepEqual(store.identities('list', 'pf3-other').map(row => row.id), ['pf3:b']);
    assert.deepEqual(store.identities('history', 'pf3:a').map(row => row.revision), [1, 2]);
    assert.deepEqual(store.identities('prefix', 'pf3:').map(row => row.id), ['pf3:a', 'pf3:b']);
    const identities = bodyDelta(plain);
    assert.deepEqual([identities.loads, identities.hits, identities.parses], [0, 0, 0], 'identities neither read nor touch a body');
    assert.equal(events.length, 5);
  } finally { observeStore(previous); }
  // Row 4: a caller's change at any depth of a returned value reaches neither a later read nor a sibling result.
  const got = store.get<{ n: number; nested: { list: number[] } }>('pf3:a')!;
  got.value.nested.list.push(99); got.value.n = -1; (got as { hash: string }).hash = 'changed';
  const listed = store.list<{ nested: { list: number[] } }>('pf3-k'), twice = store.list<{ nested: { list: number[] } }>('pf3-k');
  listed[0]!.value.nested.list.length = 0;
  assert.deepEqual(twice[0]!.value.nested.list, [3]);
  store.history<{ nested: unknown }>('pf3:a')[0]!.value.nested = null;
  assert.equal(canonical(store.get('pf3:a') as unknown as Json), canonical(cold[0] as Json));
  assert.equal(canonical(store.history('pf3:a') as unknown as Json), canonical(cold[7] as Json));
  // Row 14: a read that throws reports no successful end. Row 15: the cache adds no own member of the instance.
  const { root } = fixture(t), closed = new Store(join(root, 'closed.sqlite'));
  closed.write({ id: 'pf3:c', kind: 'pf3-k', expected: 0, value: 1 }); closed.get('pf3:c'); closed.close();
  const failed: unknown[] = [], prior = observeStore(recordingObserver(closed, failed));
  try { assert.throws(() => closed.get('pf3:c')); assert.throws(() => closed.list()); assert.throws(() => closed.history('pf3:c')); }
  finally { observeStore(prior); }
  assert.deepEqual(failed, [], 'A closed connection answers nothing from memory and reports no read');
  assert.ok(genuineStore(store) && provenStore(store) === store, 'The private cache keeps the instance a genuine Store');
  assert.deepEqual(Object.getOwnPropertyNames(store), ['path']);
});

test('PF3 rows 5-7, 11, 12: a second Store\'s writes are seen — absence is never kept, a new head appears, a head moved during a read never mixes into the selected version; close and a new database start a fresh area; two databases never share', t => {
  const { root, store } = fixture(t);
  const second = new Store(join(root, 'live.sqlite'));
  t.after(() => second.close());
  // Row 5.
  assert.equal(store.get('pf3:late'), null);
  assert.deepEqual(store.list('pf3-late'), []);
  second.write({ id: 'pf3:late', kind: 'pf3-late', expected: 0, value: { v: 1 } });
  assert.deepEqual(store.get('pf3:late')?.value, { v: 1 });
  assert.equal(store.list('pf3-late').length, 1);
  // Row 6: the external stamp drops the area; the earlier exact version still reads on its own.
  const warmed = store.get('pf3:late')!, before = storeBodyCache();
  second.write({ id: 'pf3:late', kind: 'pf3-late', expected: 1, value: { v: 2 } });
  assert.deepEqual([store.get('pf3:late')?.revision, store.get('pf3:late')?.value], [2, { v: 2 }]);
  assert.equal(bodyDelta(before).resets, 1, 'Another connection\'s commit drops the area before it answers');
  assert.equal(canonical(store.get('pf3:late', 1) as unknown as Json), canonical(warmed as unknown as Json));
  // Row 7: the head moves between the selection of a version and the load of its body.
  second.writeMany([{ id: 'pf3:race:1', kind: 'pf3-race', expected: 0, value: { v: 'first' } },
    { id: 'pf3:race:2', kind: 'pf3-race', expected: 0, value: { v: 'first' } }]);
  const original = StatementSync.prototype.get, bodySql = 'SELECT body FROM revisions WHERE entity_id=? AND revision=?';
  const raced = (id: string, read: () => unknown, move: string) => {
    let armed = true;
    StatementSync.prototype.get = function (this: StatementSync, ...args: Parameters<typeof original>) {
      if (armed && this.sourceSQL === bodySql && (args as unknown[])[0] === id) {
        armed = false;
        const head = second.get(move)!;
        second.write({ id: move, kind: 'pf3-race', expected: head.revision, value: { v: `moved ${head.revision}` } });
      }
      return original.apply(this, args);
    } as typeof original;
    try { return read(); } finally { StatementSync.prototype.get = original; assert.equal(armed, false, 'The second writer moved the head inside the read'); }
  };
  const single = raced('pf3:race:1', () => store.get('pf3:race:1'), 'pf3:race:1') as Revision;
  assert.deepEqual([single.revision, single.value, single.hash], [1, { v: 'first' }, hashJson({ v: 'first' })]);
  assert.deepEqual([store.get('pf3:race:1')?.revision, store.get('pf3:race:1')?.value], [2, { v: 'moved 1' }]);
  const listed = raced('pf3:race:2', () => store.list('pf3-race'), 'pf3:race:1') as Revision[];
  assert.deepEqual(listed.map(row => [row.id, row.revision, row.value, row.hash === hashJson(row.value)]),
    [['pf3:race:1', 2, { v: 'moved 1' }, true], ['pf3:race:2', 1, { v: 'first' }, true]], 'One list is the selection it made, not re-read heads');
  assert.deepEqual(store.list('pf3-race').map(row => row.revision), [3, 1]);
  // Row 11: close frees the share; a closed connection answers nothing; a new database at the same path starts cold.
  const path = join(root, 'scratch.sqlite'), scratch = new Store(path);
  scratch.write({ id: 'pf3:s', kind: 'pf3-s', expected: 0, value: { v: 'old' } });
  scratch.get('pf3:s');
  const held = storeBodyCache();
  scratch.close();
  assert.ok(storeBodyCache().bytes < held.bytes && storeBodyCache().entries < held.entries, 'close releases its own entries');
  assert.throws(() => scratch.get('pf3:s'));
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  const replaced = new Store(path);
  replaced.write({ id: 'pf3:s', kind: 'pf3-s', expected: 0, value: { v: 'new' } });
  const cold = storeBodyCache();
  assert.deepEqual(replaced.get('pf3:s')?.value, { v: 'new' });
  assert.equal(bodyDelta(cold).loads, 1);
  replaced.close();
  const reopened = new Store(path), opened = storeBodyCache();
  assert.deepEqual(reopened.get('pf3:s')?.value, { v: 'new' });
  assert.equal(bodyDelta(opened).loads, 1, 'A reopened Store reads with the first check again');
  reopened.close();
  // Row 12: equal ids, numbers and bodies in two databases, and equal bodies under two ids, never mix.
  const left = new Store(join(root, 'left.sqlite')), right = new Store(join(root, 'right.sqlite'));
  t.after(() => { left.close(); right.close(); });
  left.writeMany([{ id: 'pf3:same', kind: 'pf3-left', expected: 0, value: { v: 1 } }, { id: 'pf3:twin', kind: 'pf3-twin', expected: 0, value: { v: 1 } }]);
  right.write({ id: 'pf3:same', kind: 'pf3-right', expected: 0, value: { v: 1 } });
  for (let round = 0; round < 2; round++) {
    assert.deepEqual([left.get('pf3:same')?.kind, right.get('pf3:same')?.kind, left.get('pf3:twin')?.id, left.get('pf3:twin')?.kind],
      ['pf3-left', 'pf3-right', 'pf3:twin', 'pf3-twin']);
  }
  const mine = left.get<{ v: number }>('pf3:same')!;
  mine.value.v = 9;
  assert.deepEqual(right.get('pf3:same')?.value, { v: 1 });
});

test('PF3 rows 8-10: own writes show new heads beside kept versions; a refused writeMany rolls back whole and keeps nothing; guards inside the transaction keep their own checked read', t => {
  const { root, store } = fixture(t);
  const second = new Store(join(root, 'live.sqlite'));
  t.after(() => second.close());
  const first = store.write({ id: 'pf3:w', kind: 'pf3-w', expected: 0, value: { v: 1 } });
  store.get('pf3:w');
  const next = store.write({ id: 'pf3:w', kind: 'pf3-w', expected: 1, value: { v: 2 } });
  assert.equal(canonical(store.get('pf3:w') as unknown as Json), canonical(next as unknown as Json));
  assert.equal(canonical(store.get('pf3:w', 1) as unknown as Json), canonical(first as unknown as Json));
  // Row 9: the first element is written inside the transaction, the second conflicts.
  const refused = storeBodyCache();
  assert.throws(() => store.writeMany([{ id: 'pf3:new', kind: 'pf3-w', expected: 0, value: { v: 'n' } },
    { id: 'pf3:w', kind: 'pf3-w', expected: 1, value: { v: 3 } }]), code('revision_conflict'));
  assert.deepEqual([bodyDelta(refused).kept, bodyDelta(refused).hits], [0, 0], 'Nothing read inside the transaction is kept or answered from memory');
  assert.equal(store.get('pf3:new'), null);
  assert.deepEqual(store.history('pf3:new'), []);
  assert.equal(store.get('pf3:w')?.revision, 2);
  // A successful guarded writeMany over warm records reads them inside the transaction without the cache.
  const warm = store.get('pf3:w')!, guarded = storeBodyCache();
  store.writeMany([{ id: 'pf3:w', kind: 'pf3-w', expected: 2, value: { v: 3 } }], [reference(warm)]);
  assert.deepEqual([bodyDelta(guarded).hits, bodyDelta(guarded).kept, bodyDelta(guarded).loads], [0, 0, 0]);
  // Row 10: a positive guard moved by a second Store after warming, and an absence that appeared.
  const held = store.get('pf3:w')!;
  second.write({ id: 'pf3:w', kind: 'pf3-w', expected: 3, value: { v: 'second' } });
  assert.throws(() => store.writeMany([{ id: 'pf3:other', kind: 'pf3-w', expected: 0, value: 1 }], [reference(held)]), code('input_stale'));
  assert.equal(store.get('pf3:gone'), null);
  second.write({ id: 'pf3:gone', kind: 'pf3-w', expected: 0, value: 1 });
  assert.throws(() => store.writeMany([{ id: 'pf3:other', kind: 'pf3-w', expected: 0, value: 1 }], [{ id: 'pf3:gone', absent: true }]), code('input_stale'));
  assert.equal(store.get('pf3:other'), null);
});

/** Rows 12-13 need a small budget: a copy of the compiled Store module with only its limit changed, loaded beside the
 * real one — no setting of the engine and no hundreds of megabytes in a test. */
async function limitedStoreModule(t: TestContext, limit: number) {
  const dist = fileURLToPath(new URL('../src/storage/', import.meta.url)), anchor = 'const BODY_CACHE_LIMIT = 256 * 1024 * 1024;';
  const source = readFileSync(join(dist, 'store.js'), 'utf8');
  assert.equal(source.split(anchor).length, 2, 'The budget of the body cache was not identified');
  const patched = source.replace(anchor, `const BODY_CACHE_LIMIT = ${limit};`)
    .replace(/from "(\.\.?\/[^"]+)"/g, (_whole, path: string) => `from ${JSON.stringify(pathToFileURL(join(dist, path)).href)}`);
  const root = mkdtempSync(join(tmpdir(), 'omg-store-limit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'store-limited.mjs'), patched);
  return { root, module: await import(pathToFileURL(join(root, 'store-limited.mjs')).href) as typeof import('../src/storage/store.js') };
}

test('PF3 rows 12, 13: one bounded budget for every Store of the process — eviction and an entry above the limit are ordinary reads; close frees its share', async t => {
  const limit = 4096, { root, module } = await limitedStoreModule(t, limit), cache = module.storeBodyCache;
  const one = new module.Store(join(root, 'one.sqlite')), two = new module.Store(join(root, 'two.sqlite'));
  t.after(() => { one.close(); two.close(); });
  const body = (size: number) => ({ text: 'x'.repeat(size) });
  one.writeMany(['pf3:1', 'pf3:2', 'pf3:3'].map(id => ({ id, kind: 'pf3-limit', expected: 0, value: body(600) }))
    .concat([{ id: 'pf3:big', kind: 'pf3-limit', expected: 0, value: body(3000) }]));
  two.write({ id: 'pf3:1', kind: 'pf3-limit', expected: 0, value: body(600) });
  for (const id of ['pf3:1', 'pf3:2', 'pf3:3']) assert.deepEqual(one.get(id)?.value, body(600));
  let state = cache();
  assert.deepEqual([state.kept, state.evictions, state.entries], [3, 1, 2], 'The third body evicts the least recently used one');
  assert.ok(state.bytes <= limit, `Held ${state.bytes} of ${limit}`);
  assert.deepEqual(one.get('pf3:big')?.value, body(3000));
  state = cache();
  assert.deepEqual([state.oversized, state.kept, state.entries], [1, 3, 2], 'A body above the budget is read the ordinary way and not kept');
  const loads = state.loads;
  assert.deepEqual(one.get('pf3:1')?.value, body(600), 'An evicted body is an ordinary read, not a refusal');
  assert.equal(cache().loads - loads, 1);
  assert.deepEqual(two.get('pf3:1')?.value, body(600));
  state = cache();
  assert.ok(state.bytes <= limit && state.entries === 2, 'Two Stores share one budget');
  const held = state.bytes;
  one.close();
  assert.ok(cache().bytes < held, 'close frees the entries of its own area');
  two.close();
  assert.deepEqual([cache().bytes, cache().entries], [0, 0]);
});

const PF3_BASE = '5929ea25cb7d54d2d5c5a87859b64481e2d1f038';
/** Row 16: the Store of the base commit, loaded from Git whole in its own process, writes and reads its database. */
function atBase(root: string, database: string, body: string): unknown {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const loader = join(root, 'pf3-base-loader.mjs'), producer = join(root, 'pf3-base-producer.mjs'), served = join(root, 'pf3-base-served.log');
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  writeFileSync(served, '');
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from ${JSON.stringify(typescript)};
let root, log, prefixes;
export function initialize(data) {
  root = data.root; log = data.log;
  prefixes = [root, pathToFileURL(realpathSync(fileURLToPath(root)) + '/').href].map(base => new URL('dist/src/', base).href);
}
export async function load(url, context, next) {
  const prefix = prefixes.find(item => url.startsWith(item));
  if (prefix && /\\.js$/.test(url)) {
    const relative = 'src/' + url.slice(prefix.length).replace(/\\.js$/, '.ts');
    appendFileSync(log, relative + '\\n');
    const source = execFileSync('git', ['show', ${JSON.stringify(PF3_BASE)} + ':' + relative], { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  if (url.startsWith('file:') && url.includes('/dist/src/') && !url.includes('/node_modules/'))
    throw new Error('An engine module outside the era checkout: ' + url);
  return next(url, context);
}`);
  writeFileSync(producer, `import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository, database] = process.argv.slice(2);
const src = path => pathToFileURL(join(repository, 'dist/src', path)).href;
const { Store } = await import(src('storage/store.js'));
const store = new Store(database);
const out = value => process.stdout.write(JSON.stringify(value));
try {
${body}
} finally { store.close(); }`);
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},
    { data: { root: ${JSON.stringify(pathToFileURL(repository).href)}, log: ${JSON.stringify(served)} } });`;
  const output: unknown = JSON.parse(execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, database],
    { cwd: repository, encoding: 'utf8', timeout: 180_000, maxBuffer: 50_000_000 }));
  assert.ok(readFileSync(served, 'utf8').split('\n').includes('src/storage/store.ts'), 'The producer ran on the Store of the base commit');
  return output;
}

test('PF3 row 16: the versions the base code 5929ea25 wrote read cold, warm and after reopen exactly as that code reads them', t => {
  const { root } = fixture(t), database = join(root, 'era.sqlite');
  const reads = `({ get: store.get('pf3:e:a'), exact: store.get('pf3:e:a', 1), absent: store.get('pf3:e:none'), list: store.list(),
    kind: store.list('pf3-era'), history: store.history('pf3:e:a'), identities: store.identities('prefix', 'pf3:e:') })`;
  const old = atBase(root, database, `store.writeMany([{ id: 'pf3:e:a', kind: 'pf3-era', expected: 0, value: { text: 'тело ✓', nested: [1, { k: null }] } },
  { id: 'pf3:e:b', kind: 'pf3-other', expected: 0, value: [] }]);
store.write({ id: 'pf3:e:a', kind: 'pf3-era', expected: 1, value: { text: 'вторая', 'üñí': '\\u2028' } });
out(${reads});`) as Json;
  const read = (store: Store) => ({ get: store.get('pf3:e:a'), exact: store.get('pf3:e:a', 1), absent: store.get('pf3:e:none'), list: store.list(),
    kind: store.list('pf3-era'), history: store.history('pf3:e:a'), identities: store.identities('prefix', 'pf3:e:') });
  const current = new Store(database), before = storeBodyCache();
  const cold = read(current), warm = read(current);
  current.close();
  assert.ok(bodyDelta(before).hits > 0, 'The second read was answered warm');
  const reopened = new Store(database), after = read(reopened);
  reopened.close();
  for (const result of [cold, warm, after]) assert.equal(canonical(result as unknown as Json), canonical(old));
  assert.equal(canonical(atBase(root, database, `out(${reads});`) as Json), canonical(old), 'The base code still reads the database the new code opened');
});
