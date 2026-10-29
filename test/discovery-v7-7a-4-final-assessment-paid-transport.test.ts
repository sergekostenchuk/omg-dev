import { retryDiscoveryResponse } from '../src/discovery/discovery-response-retry.js';
import { answerBeforeContext } from './discovery-response-correction-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { researchCall, resumeDiscoveryFinalAssessmentResearchCall, withResearchRunControl } from '../src/discovery/research-protocol.js';
import { readArchiveBody } from '../src/discovery/request-parts.js';
import type { Question } from '../src/discovery/discovery.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { acquireRunExecution, releaseRunExecution, stopRun } from '../src/om/run-control.js';
import { prepareDiscoveryFinalAssessmentSubject } from '../src/discovery/discovery-final-assessment-subject.js';
import { DISCOVERY_FINAL_ASSESSMENT_RESULT } from '../src/discovery/discovery-final-assessment-result.js';
import { prepareDiscoveryFinalAssessmentSession } from '../src/discovery/discovery-final-assessment-session.js';
import { discoveryFinalAssessmentExecutionId, readDiscoveryFinalAssessmentDispatchAdmission, readDiscoveryFinalAssessmentExecutionAt,
  readDiscoveryFinalAssessmentPaidResultAt, runDiscoveryFinalAssessmentExecution } from '../src/discovery/discovery-final-assessment-execution.js';
import { finalCandidate, finalPaid } from './discovery-v7-final-paid-seed.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';
import { whileHidden } from './hidden-record.js';

type World = Awaited<ReturnType<typeof finalPaid>>;
type Route = 'owner' | 'model' | 'partial';
type Outcome = 'go' | 'conditional' | 'no_go' | 'insufficient_evidence';

// Compare the whole product history at each fixed-point boundary, alongside
// the individual no-write windows and the external physical wire.
function history(store: Store): string {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    const digest = createHash('sha256');
    for (const query of ['SELECT * FROM heads ORDER BY entity_id',
      'SELECT * FROM revisions ORDER BY entity_id,revision', 'SELECT * FROM events ORDER BY sequence']) {
      digest.update(query);
      for (const row of db.prepare(query).iterate()) for (const [key, value] of Object.entries(row)) {
        const text = String(value);
        digest.update(key).update(typeof value).update(`${Buffer.byteLength(text)}:`).update(text);
      }
    }
    return digest.digest('hex');
  } finally { db.close(); }
}
const money = (store: Store) => ({ calls: store.list('model-call').flatMap(row => store.history(row.id)),
  ledger: store.list('research-budget-ledger').flatMap(row => store.history(row.id)) });
async function fixed<T>(f: World, store: Store, action: () => Promise<T>): Promise<T> {
  const before = history(store), finances = money(store), wire = f.wires();
  const result = await storeUnchanged(store, action);
  assert.equal(history(store), before); assert.deepEqual(money(store), finances); assert.deepEqual(f.wires(), wire);
  return result;
}
async function refused(f: World, store: Store, action: () => Promise<unknown>) {
  const finances = money(store), wire = f.wires();
  await storeRefused(store, action);
  assert.deepEqual(money(store), finances); assert.deepEqual(f.wires(), wire);
}
async function interceptWrites<T>(store: Store, hook: (writes: any[], guards: any[], invoke: () => any) => any,
  action: () => Promise<T>): Promise<T> {
  const original = Store.prototype.writeMany;
  Store.prototype.writeMany = function (this: Store, ...args: Parameters<Store['writeMany']>) {
    const invoke = () => original.apply(this, args);
    return this === store ? hook(args[0], args[1] ?? [], invoke) : invoke();
  } as Store['writeMany'];
  try { return await action(); } finally { Store.prototype.writeMany = original; }
}

async function calibrateReviewer(f: World) {
  const before = new Set(f.store.list<ModelCall>('model-call').map(row => row.id));
  f.reply({ action: 'answer', question: 'reader',
    value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'Calibration' }, citations: [] });
  await researchCall(f.environment.value.reviewer, f.environment.value, 'Measure the independent reviewer', {}, undefined,
    { store: f.store, draftId: f.data.calibration.draft.id, questionId: f.data.calibration.question.id, purpose: 'assessor' });
  const measured = f.store.list<ModelCall>('model-call').find(row => !before.has(row.id) && row.value.usage);
  assert.ok(measured); return measured;
}

async function prepare(t: test.TestContext, outcome: Outcome = 'go', route: Route = 'owner',
  prompt = 'Assess this exact paid D7', packetChars = 8_000_000, limitChars = 9_000_000, calibrate = true) {
  const f = await finalPaid(t, outcome, route);
  // Only the expected packet for the fixture is prepared here. Execution
  // must independently re-read and prove the paid D7 source itself.
  const bundle = f.result.value.projection.result.bundle;
  const source = { paid: f.result, bundle,
    packet: await prepareDiscoveryFinalAssessmentSubject(f.store, 'p', f.d6, bundle) };
  // A forecast must be based on an actual measurement of this independent
  // reviewer and its current command, not on the D7 implementer's cost.
  const measured = calibrate ? await calibrateReviewer(f) : null;
  const cell = await prepareDiscoveryFinalAssessmentSession(f.store, 'p', source.packet.subject,
    { prompt, packetChars, limitChars, resultLimitChars: 10_000_000,
      environment: reference(f.environment), role: f.environment.value.reviewer });
  return { f, source, cell, measured, prepared: reference(cell) };
}
function answer(subject: unknown, verdict: 'supported' | 'return') {
  return { contract: DISCOVERY_FINAL_ASSESSMENT_RESULT, subject, verdict, reasons: ['The exact candidate was reviewed'],
    bases: [{ candidate: '/verdict' }], return: verdict === 'supported' ? null
      : { targets: [{ candidate: '/verdict' }], reason: 'The decision needs another basis', bases: [{ candidate: '/verdict' }] } };
}
const callsFor = (store: Store, prepared: Ref) => store.list<ModelCall>('model-call').filter(row =>
  row.value.purpose === 'discovery-final-assessment'
  && canonical((row.value as unknown as Record<string, any>).finalContinuation?.prepared) === canonical(prepared));

test('final assessment paid: owner conditional is supported by the independent physical reviewer and restored hot and cold', async t => {
  const { f, source, prepared, measured } = await prepare(t, 'conditional');
  f.reply(answer(source.packet.subject, 'supported'));
  const wire = f.wires().length;
  const result = await runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { profile: f.profile });
  assert.ok(result.output && result.result);
  assert.equal(result.result.verdict, 'supported');
  assert.equal(result.result.candidateOutcome, 'conditional');
  assert.deepEqual(result.result.candidate.verdict.conditions, source.bundle.verdict.conditions);
  assert.deepEqual(result.result.packet, source.packet);
  assert.ok(f.wires().length > wire);
  const calls = callsFor(f.store, prepared);
  assert.ok(calls.length >= 1);
  assert.equal(calls.at(-1)!.value.requested.actor, f.environment.value.reviewer.actor);
  assert.notEqual(calls.at(-1)!.value.requested.actor, f.environment.value.implementer.actor);
  assert.ok(measured && calls[0]!.value.budget?.estimate.basis.some(ref => ref.id === measured.id));
  // A later draft/brief and runtime head are not authority to rewrite the
  // already paid reviewer response or cause it to be bought again.
  const question = f.store.get<Question>(source.packet.final.subject.basis.brief.question.id)!;
  f.discovery.reopen(question.id, question.revision);
  const environment = f.engine.environments.get('p'), { projectId: _projectId, ...later } = environment.value;
  f.engine.environments.configure('p', later, environment.revision);
  const cold = f.open();
  await fixed(f, f.store, async () => {
    // Both Store handles share the database observed by fixed(). Exercise the
    // hot/cold recovery without returning to today's heads or allowance.
    for (const store of [f.store, cold]) assert.deepEqual((await runDiscoveryFinalAssessmentExecution(store, 'p',
      f.paidResult, prepared, { restoreOnly: true, allowance: 0 })).result, result.result);
  });
});

test('final assessment paid: a paid answer for another subject never becomes supported or triggers a new payment', async t => {
  const { f, source, prepared } = await prepare(t, 'conditional', 'owner', 'Refuse an imitated answer');
  const wrong = structuredClone(source.packet.subject);
  wrong.candidate.verdict.reason = 'This is another candidate';
  const { identity: _identity, ...wrongBasis } = wrong;
  wrong.identity = `discovery-final-assessment:${hashJson(wrongBasis as never)}`;
  f.reply(answer(wrong, 'supported'));
  await assert.rejects(() => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared,
    { profile: f.profile }), error => error instanceof EngineError);
  assert.equal(f.store.list('discovery-final-assessment-paid-result').length, 0);
  const finances = money(f.store), wire = f.wires();
  f.reply(answer(source.packet.subject, 'supported'));
  await fixed(f, f.store, async () => {
    for (const store of [f.store, f.open()]) await refused(f, store,
      () => runDiscoveryFinalAssessmentExecution(store, 'p', f.paidResult, prepared, { allowance: 0 }));
  });
  assert.deepEqual(money(f.store), finances); assert.deepEqual(f.wires(), wire);
});

test('final assessment paid: model-selected no_go may return without changing the candidate outcome', async t => {
  const { f, source, prepared } = await prepare(t, 'no_go', 'model');
  f.reply(answer(source.packet.subject, 'return'));
  const result = await runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { profile: f.profile });
  assert.ok(result.output && result.result);
  assert.equal(result.result.verdict, 'return'); assert.equal(result.result.candidateOutcome, 'no_go');
  assert.equal(result.result.candidate.projection, null); assert.equal(result.result.candidate.constitution, null);
  assert.deepEqual(result.result.result.return?.targets, [{ candidate: '/verdict' }]);
  await fixed(f, f.store, async () => {
    assert.deepEqual((await runDiscoveryFinalAssessmentExecution(f.open(), 'p', f.paidResult, prepared,
      { restoreOnly: true, allowance: 0 })).result, result.result);
  });
});

test('final assessment paid: a real nonempty partial remains partial and insufficient_evidence remains its own D7 outcome', async t => {
  const { f, source, prepared, cell } = await prepare(t, 'insufficient_evidence', 'partial');
  const manifest = source.packet.final.dossier.manifest.value as Record<string, any>;
  assert.equal(manifest.completeness, 'partial');
  assert.ok(source.packet.final.dossier.materials.length > 0);
  f.reply(answer(source.packet.subject, 'supported'));
  const result = await runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { profile: f.profile });
  assert.ok(result.output && result.result);
  assert.equal(result.result.verdict, 'supported'); assert.equal(result.result.candidateOutcome, 'insufficient_evidence');
  assert.deepEqual(result.result.packet, source.packet);
  assert.equal((result.result.packet.final.dossier.manifest.value as Record<string, any>).completeness, 'partial');
  const imitation = f.store.write({ id: 'fake-final-assessment-paid-result:test',
    kind: 'discovery-final-assessment-paid-result', expected: 0, value: structuredClone(result.output.value) });
  const malformedApplication = f.store.write({ id: 'fake-final-assessment-application:null',
    kind: 'discovery-final-assessment-application', expected: 0, value: null });
  const malformedPaid = f.store.write({ id: 'fake-final-assessment-paid-result:null-application',
    kind: 'discovery-final-assessment-paid-result', expected: 0,
    value: { ...structuredClone(result.output.value), application: reference(malformedApplication) } });
  const stopped = await prepareDiscoveryFinalAssessmentSession(f.store, 'p', source.packet.subject,
    { ...cell.value.input, prompt: 'Do not start another assessment after stop' });
  assert.ok(stopRun(f.store, { project: 'p' }).ok);
  const cold = f.open();
  await fixed(f, f.store, async () => {
    await refused(f, f.store, () => readDiscoveryFinalAssessmentPaidResultAt(f.store, 'p', reference(imitation)));
    await storeRefused(f.store, () => readDiscoveryFinalAssessmentPaidResultAt(f.store, 'p', reference(malformedPaid)),
      error => error instanceof EngineError && error.code === 'discovery_final_assessment_execution_invalid');
    await storeRefused(f.store, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult,
      reference(stopped), { profile: f.profile }), error => error instanceof EngineError && error.code === 'run_stopped');
    assert.equal(f.store.get(discoveryFinalAssessmentExecutionId(f.paidResult, reference(stopped))), null);
    assert.deepEqual((await readDiscoveryFinalAssessmentExecutionAt(f.store, 'p', reference(result.session))).result, result.result);
    assert.deepEqual((await readDiscoveryFinalAssessmentPaidResultAt(cold, 'p', reference(result.output!))).result, result.result);
    assert.deepEqual((await runDiscoveryFinalAssessmentExecution(cold, 'p', f.paidResult, prepared,
      { restoreOnly: true, allowance: 0 })).result, result.result);
  });
});

test('final assessment paid: bounded pages deliver the full saved subject, packet and schema before the terminal answer', async t => {
  // The compact material projection fits the former 300k packet. Keep this
  // case genuinely paged while retaining its original physical envelope.
  const { f, source, prepared, cell } = await prepare(t, 'insufficient_evidence', 'partial', 'Review every bounded page', 64_000, 400_000);
  const archive = f.store.get(cell.value.archive.id, cell.value.archive.revision)!;
  assert.ok(canonical(readArchiveBody(f.store, archive).body.request).length > 300_000);
  f.reply(answer(source.packet.subject, 'supported'));
  const start = f.wires().length;
  const result = await runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { profile: f.profile });
  assert.ok(result.output && result.result); assert.deepEqual(result.result.packet, source.packet);
  const wires = f.wires().slice(start) as Record<string, any>[];
  assert.ok(wires.length > 1);
  assert.ok(wires[0]!.subject.working.materialAddresses.length > 0);
  assert.ok(wires.some(wire => wire.subject.contextWorkspace?.length > 0));
  assert.ok(wires.every(wire => JSON.stringify(wire).length <= 400_000));
  await fixed(f, f.store, async () => {
    assert.deepEqual((await readDiscoveryFinalAssessmentPaidResultAt(f.store, 'p', reference(result.output!))).result, result.result);
  });
});

test('final assessment paid: a small wire continues the unread context tail before requesting another original fragment', async t => {
  const { f, source, prepared } = await prepare(t, 'insufficient_evidence', 'partial', 'Small bounded pages', 32_000, 400_000);
  f.reply(answer(source.packet.subject, 'supported'));
  const start = f.wires().length;
  let claims = 0;
  await assert.rejects(() => interceptWrites(f.store, (writes, _guards, invoke) => {
    const cut = writes.some(row => row.kind === 'model-call' && row.expected === 0) && ++claims === 3;
    const value = invoke();
    if (cut) throw new Error('cut-after-third-reservation');
    return value;
  }, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { profile: f.profile })),
  /cut-after-third-reservation/);
  const wires = f.wires().slice(start) as Record<string, any>[];
  const calls = callsFor(f.store, prepared);
  assert.equal(claims, 3); assert.equal(wires.length, 2); assert.equal(calls.length, 3);
  assert.ok(wires[1]!.subject.contextDelivery?.length > 0);
  assert.equal(wires[1]!.subject.materialDelivery?.length ?? 0, 0);
  assert.equal(wires[1]!.subject.contextDelivery[0].served.offset,
    wires[0]!.subject.materialDelivery[0].served.end);
  assert.ok(wires.every(wire => {
    const packet = { ...wire.subject }; delete packet.continuation; delete packet.responseOutputLimit;
    return JSON.stringify(packet).length <= 32_000 && JSON.stringify(wire).length <= 400_000;
  }));
  assert.equal(f.store.list('discovery-final-assessment-paid-result').length, 0);
  const active = calls.find(row => row.value.status === 'running');
  const prior = calls.filter(row => row.value.status === 'succeeded').sort((a, b) => a.value.startedAt - b.value.startedAt)[0];
  assert.ok(active && prior && active.value.execution?.phase === 'claimed');
  const missing = f.store.get(`model-response:${prior.value.requestId}`);
  const cursor = f.store.get(discoveryFinalAssessmentExecutionId(f.paidResult, prepared));
  const application = (active.value as unknown as Record<string, any>).finalAssessmentApplication as Ref;
  assert.ok(missing && cursor && application);
  // Hide a real previous receipt; the paid records themselves remain untouched. A direct resume is its own door. The
  // genuine Store answers without that record, so its proofs are derived once and kept across the three doors, as in
  // production.
  const missingResponse = (error: unknown) => error instanceof EngineError && error.code === 'response_recovery_wire_invalid';
  await whileHidden(f.store, { id: missing.id, revision: missing.revision }, null, () => fixed(f, f.store, async () => {
    await assert.rejects(() => readDiscoveryFinalAssessmentExecutionAt(f.store, 'p', reference(cursor)), missingResponse);
    await assert.rejects(() => readDiscoveryFinalAssessmentDispatchAdmission(f.store, application), missingResponse);
    await assert.rejects(() => resumeDiscoveryFinalAssessmentResearchCall(f.store, application), missingResponse);
    assert.deepEqual(f.store.get(active.id), active);
  }));
  // The same history door through an opaque read-only view: no proof is kept across its reads, the whole history of the
  // paid run is derived again (about ten seconds), so one door stands for that path.
  const view = new Proxy(f.store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) =>
      id === missing.id && (revision === undefined || revision === missing.revision) ? null : f.store.get(id, revision);
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await fixed(f, f.store, async () => {
    await assert.rejects(() => readDiscoveryFinalAssessmentExecutionAt(view, 'p', reference(cursor)), missingResponse);
    assert.deepEqual(f.store.get(active.id), active);
  });
  // The same claim is usable when the real history is present. Applying its
  // paid response and all subsequent restore-only reads remain free.
  await resumeDiscoveryFinalAssessmentResearchCall(f.store, application);
  assert.equal(f.wires().length, start + 3);
  const paid = money(f.store), afterWire = f.wires();
  const restored = await runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared,
    { restoreOnly: true, allowance: 0 });
  assert.equal(restored.result, null);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), afterWire);
  await fixed(f, f.store, async () => {
    assert.equal((await runDiscoveryFinalAssessmentExecution(f.open(), 'p', f.paidResult, prepared,
      { restoreOnly: true, allowance: 0 })).result, null);
  });
});

test('final assessment paid: an unmeasured reviewer cannot buy before a real same-role forecast', async t => {
  const { f, source, prepared } = await prepare(t, 'insufficient_evidence', 'partial', 'Forecast before payment',
    8_000_000, 9_000_000, false);
  await fixed(f, f.store, async () => {
    await storeRefused(f.store, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared,
      { profile: f.profile }), error => error instanceof EngineError && error.code === 'budget_estimate_missing');
    assert.equal(f.store.get(discoveryFinalAssessmentExecutionId(f.paidResult, prepared)), null);
  });
  const measured = await calibrateReviewer(f);
  f.reply(answer(source.packet.subject, 'supported'));
  const result = await runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { profile: f.profile });
  assert.equal(result.result?.verdict, 'supported');
  const call = callsFor(f.store, prepared)[0]!;
  assert.ok(call.value.budget?.estimate.basis.some(ref => ref.id === measured.id));
});

test('final assessment paid: missing, foreign and structurally imitated paid sources cannot authorize a prepared candidate', async t => {
  const { f, source, prepared } = await prepare(t);
  const foreignPacket = await prepareDiscoveryFinalAssessmentSubject(f.store, 'p', f.d6, finalCandidate(f.packet, 'no_go').bundle);
  const foreignCell = await prepareDiscoveryFinalAssessmentSession(f.store, 'p', foreignPacket.subject,
    { ...f.store.get<any>(prepared.id, prepared.revision)!.value.input, prompt: 'Another candidate' });
  const fake = f.store.write({ id: 'fake-final-paid-result:assessment-test', kind: 'discovery-final-paid-result',
    expected: 0, value: structuredClone(source.paid.value) });
  await fixed(f, f.store, async () => {
    for (const ref of [null, { ...f.paidResult, hash: '0'.repeat(64) }, reference(fake)] as unknown as Ref[]) {
      await refused(f, f.store, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', ref, prepared));
    }
    await refused(f, f.store, () => runDiscoveryFinalAssessmentExecution(f.store, 'other', f.paidResult, prepared));
    await refused(f, f.store, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, reference(foreignCell)));
    await refused(f, f.store, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { allowance: 0 }));
    const audit = { store: f.store, draftId: f.data.calibration.draft.id, questionId: f.data.calibration.question.id };
    await refused(f, f.store, () => researchCall(f.environment.value.reviewer, f.environment.value,
      'Bypass the assessment application', {}, undefined, { ...audit, purpose: 'discovery-final-assessment' }));
    await refused(f, f.store, () => researchCall(f.environment.value.reviewer, f.environment.value,
      'Smuggle the assessment marker', { finalContinuation: {} }, undefined, { ...audit, purpose: 'assessor' }));
    let sourceReads = 0, preparedReads = 0;
    const unstableSource = { ...f.paidResult,
      get hash() { return ++sourceReads === 1 ? f.paidResult.hash : '0'.repeat(64); } };
    const unstablePrepared = { ...prepared,
      get hash() { return ++preparedReads === 1 ? prepared.hash : '0'.repeat(64); } };
    await storeRefused(f.store, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', unstableSource,
      unstablePrepared, { allowance: 0 }),
    error => error instanceof EngineError && error.code === 'research_call_allowance');
    assert.equal(sourceReads, 1); assert.equal(preparedReads, 1);
  });
  assert.equal(f.store.get(discoveryFinalAssessmentExecutionId(f.paidResult, prepared)), null);
});

test('final assessment paid: a foreign exact profile cannot occupy the origin; the correct profile remains usable', async t => {
  const { f, source, prepared } = await prepare(t, 'insufficient_evidence', 'partial', 'Exact profile');
  const { projectId: _projectId, ...settings } = f.profile.value;
  await f.engine.execute({ type: 'create-project', project: 'other', title: 'Other assessment profile' });
  f.engine.environments.configure('other', f.environment.value, 0);
  const foreign = configureReaderPilot(f.store, f.engine.environments, 'other', settings, 0);
  const malformed = f.store.write({ id: 'fake-reader-pilot:null', kind: 'reader-pilot', expected: 0, value: null });
  await fixed(f, f.store, async () => {
    await storeRefused(f.store, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared,
      { profile: malformed as unknown as typeof f.profile }),
    error => error instanceof EngineError && error.code === 'discovery_final_assessment_execution_invalid');
    for (const [store, profile] of [[f.store, foreign], [f.open(),
      { ...foreign, value: { ...foreign.value, projectId: 'p' } }]] as const) {
      await refused(f, store, () => runDiscoveryFinalAssessmentExecution(store, 'p', f.paidResult, prepared, { profile }));
      assert.equal(store.get(discoveryFinalAssessmentExecutionId(f.paidResult, prepared)), null);
    }
  });
  f.reply(answer(source.packet.subject, 'supported'));
  const result = await runDiscoveryFinalAssessmentExecution(f.open(), 'p', f.paidResult, prepared, { profile: f.profile });
  assert.equal(result.result?.verdict, 'supported');
});

test('final assessment paid: cuts before and after the atomic reservation recover one claim across two Stores', async t => {
  const { f, source, prepared } = await prepare(t, 'insufficient_evidence', 'partial', 'Reservation cut');
  f.reply(answer(source.packet.subject, 'supported'));
  let before = false;
  await fixed(f, f.store, async () => {
    await assert.rejects(() => interceptWrites(f.store, (writes, _guards, invoke) => {
      if (!before && writes.some(row => row.kind === 'model-call')) { before = true; throw new Error('before-reservation'); }
      return invoke();
    }, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { profile: f.profile })), /before-reservation/);
  });
  assert.ok(before); assert.equal(f.store.get(discoveryFinalAssessmentExecutionId(f.paidResult, prepared)), null);
  let after = false;
  await assert.rejects(() => interceptWrites(f.store, (writes, _guards, invoke) => {
    const cut = !after && writes.some(row => row.kind === 'model-call');
    const value = invoke(); if (cut) { after = true; throw new Error('after-reservation'); } return value;
  }, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { profile: f.profile })), /after-reservation/);
  assert.ok(after); assert.equal(callsFor(f.store, prepared).length, 1);
  const cold = f.open(), finances = money(f.store), wire = f.wires().length;
  await fixed(f, f.store, async () => {
    for (const store of [f.store, cold]) assert.equal((await storeUnchanged(store, () =>
      runDiscoveryFinalAssessmentExecution(store, 'p', f.paidResult, prepared, { restoreOnly: true }))).result, null);
  });
  const results = await Promise.allSettled([runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared),
    runDiscoveryFinalAssessmentExecution(cold, 'p', f.paidResult, prepared)]);
  const winner = results.find(row => row.status === 'fulfilled');
  assert.ok(winner && winner.status === 'fulfilled' && winner.value.result);
  assert.equal(callsFor(f.store, prepared).length, 1); assert.equal(f.wires().length, wire + 1);
  assert.deepEqual(money(f.store).ledger, finances.ledger);
  await fixed(f, f.store, async () => {
    for (const store of [f.store, cold]) assert.deepEqual((await storeUnchanged(store, () =>
      runDiscoveryFinalAssessmentExecution(store, 'p', f.paidResult, prepared, { restoreOnly: true, allowance: 0 }))).result, winner.value.result);
  });
});

test('final assessment paid: a cut after the response and competing publication preserve one paid result', async t => {
  const { f, source, prepared } = await prepare(t, 'insufficient_evidence', 'partial', 'Response and publication race');
  f.reply(answer(source.packet.subject, 'return'));
  const acquired = acquireRunExecution(f.store, { project: 'p' }); assert.ok(acquired.ok);
  await assert.rejects(() => interceptWrites(f.store, (writes, _guards, invoke) => {
    if (writes.some(row => row.kind === 'discovery-final-assessment-paid-result')) throw new Error('after-response');
    return invoke();
  }, () => withResearchRunControl(f.store, 'p', acquired.value.hold,
    () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { profile: f.profile }))), /after-response/);
  const finances = money(f.store), wire = f.wires(), cold = f.open();
  releaseRunExecution(cold, acquired.value);
  const replacement = acquireRunExecution(cold, { project: 'p' }); assert.ok(replacement.ok);
  let won = false, conflict = false;
  const result = await interceptWrites(f.store, (writes, guards, invoke) => {
    if (!won && writes.some(row => row.kind === 'discovery-final-assessment-paid-result')) {
      won = true; cold.writeMany(writes, guards);
      try { return invoke(); } catch (error) {
        assert.ok(error instanceof EngineError && ['revision_conflict', 'input_stale'].includes(error.code));
        conflict = true; throw error;
      }
    }
    return invoke();
  }, () => withResearchRunControl(f.store, 'p', acquired.value.hold,
    () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { allowance: 0 })))
    .finally(() => releaseRunExecution(cold, replacement.value));
  assert.ok(won && conflict && result.output && result.result); assert.equal(result.result.verdict, 'return');
  assert.deepEqual(money(f.store), finances); assert.deepEqual(f.wires(), wire);
  await fixed(f, f.store, async () => {
    for (const store of [f.store, cold]) assert.deepEqual((await storeUnchanged(store, () =>
      readDiscoveryFinalAssessmentPaidResultAt(store, 'p', reference(result.output!)))).result, result.result);
  });
});

test('final assessment paid: a changed selection wins the authorization CAS before any provider send', async t => {
  const { f, source, prepared } = await prepare(t, 'go', 'owner', 'Authorization guard race');
  f.reply(answer(source.packet.subject, 'supported'));
  let cut = false;
  await assert.rejects(() => interceptWrites(f.store, (writes, _guards, invoke) => {
    const hit = !cut && writes.some(row => row.kind === 'model-call');
    const value = invoke(); if (hit) { cut = true; throw new Error('claimed'); } return value;
  }, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { profile: f.profile })), /claimed/);
  assert.ok(cut);
  const scope = source.packet.final.dossier.route.scope; assert.ok(scope);
  const current = f.store.get(scope.ref.id)!, cold = f.open();
  const finances = money(f.store), wire = f.wires(), event = f.store.lastEvent();
  let contested = false;
  await assert.rejects(() => interceptWrites(f.store, (writes, guards, invoke) => {
    if (!contested && writes.some(row => row.kind === 'model-call' && row.value.execution?.phase === 'authorized')) {
      contested = true;
      assert.ok(guards.some(guard => canonical(guard) === canonical(reference(current))));
      cold.writeMany([{ id: current.id, kind: current.kind, expected: current.revision, value: current.value }]);
    }
    return invoke();
  }, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared)),
  error => error instanceof EngineError && ['input_stale', 'revision_conflict'].includes(error.code));
  assert.ok(contested); assert.equal(callsFor(f.store, prepared)[0]!.value.execution?.phase, 'claimed');
  assert.deepEqual(money(f.store), finances); assert.deepEqual(f.wires(), wire);
  const events = f.store.eventsPage(event, f.store.lastEvent(), 100);
  assert.ok(events.some(row => row.id === current.id));
  assert.ok(events.every(row => row.id === current.id || row.kind === 'process-stop'));
});

test('final assessment paid: an authorized uncertain provider cannot be sent a second time', async t => {
  const { f, source, prepared } = await prepare(t, 'insufficient_evidence', 'partial', 'Authorized cut');
  f.reply(answer(source.packet.subject, 'supported'));
  let hit = false;
  await assert.rejects(() => interceptWrites(f.store, (writes, _guards, invoke) => {
    const cut = !hit && writes.some(row => row.kind === 'model-call' && row.value.execution?.phase === 'authorized');
    const value = invoke(); if (cut) { hit = true; throw new Error('after-authorization'); } return value;
  }, () => runDiscoveryFinalAssessmentExecution(f.store, 'p', f.paidResult, prepared, { profile: f.profile })),
  error => error instanceof EngineError && error.code === 'process_record_failed');
  assert.ok(hit); assert.equal(callsFor(f.store, prepared)[0]!.value.execution?.phase, 'authorized');
  await fixed(f, f.store, async () => {
    for (const store of [f.store, f.open()]) await refused(f, store,
      () => runDiscoveryFinalAssessmentExecution(store, 'p', f.paidResult, prepared));
  });
});

for (const incomplete of [false,true]) test(`L30 final assessment: ${incomplete?'early context answer':'malformed answer'} permits one addressed call, repeat and cold cannot buy another`,async t=>{
  const {f,source,prepared}=await prepare(t,'insufficient_evidence','partial','Address one paid reviewer refusal',
    incomplete?64_000:8_000_000,incomplete?400_000:9_000_000);
  assert.equal((f.store.get<any>(prepared.id,prepared.revision)!).value.input.materialContract,'discovery-final-material/v1');
  f.reply(incomplete?answer(source.packet.subject,'supported'):{});
  const restore=incomplete?answerBeforeContext(f.root):()=>{};
  await assert.rejects(()=>runDiscoveryFinalAssessmentExecution(f.store,'p',f.paidResult,prepared,{profile:f.profile}),
    error=>error instanceof EngineError && error.code===(incomplete?'research_context_incomplete':'discovery_final_assessment_result_invalid'));
  if(incomplete) assert.ok((f.wires().at(-1) as any).subject.working.materialAddresses.some((a:any)=>a.field==='finalMaterial'));
  restore();
  const application=f.store.list<any>('discovery-final-assessment-application').find(row=>row.value.state==='prepared')!;
  assert.ok(application);const root=reference(f.store.get(application.id,1)!),old=f.store.history(application.id),before=f.wires().length;
  assert.equal((await retryDiscoveryResponse(f.open(),'p',root,1,true)).kind,'pending');
  assert.equal(f.wires().length,before);
  f.reply(answer(source.packet.subject,'supported'));
  const result=await retryDiscoveryResponse(f.open(),'p',root,1);
  assert.equal(result.kind,incomplete?'pending':'applied');assert.equal(f.wires().length,before+1);
  assert.ok(JSON.stringify(f.wires().at(-1)).includes('discovery-response-correction/v1'));
  await fixed(f,f.store,async()=>{
    assert.deepEqual(await retryDiscoveryResponse(f.open(),'p',root,1),result);
    assert.deepEqual(await retryDiscoveryResponse(f.open(),'p',root,1,true),result);
  });
  assert.deepEqual(f.store.history(application.id),old);
});
