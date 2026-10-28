import test from 'node:test';
import assert from 'node:assert/strict';
import { hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { acceptDiscoveryFinal } from '../src/product/owner-authority.js';
import { finalAssessmentPaid, type FinalAssessmentSeedOptions } from './discovery-v7-final-assessment-seed.js';
import { modeOf, money, all } from './discovery-v7-dossier-seed.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';

import { prepareKeeperSession, readKeeperSessionAt, type KeeperSessionInput } from '../src/product/keeper-session.js';
import { readKeeperArchive } from '../src/product/keeper-packing.js';
import { Store } from '../src/storage/store.js';
import { DatabaseSync } from 'node:sqlite';

type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
/** Normal era-six stage producers, evidence and acceptance; no fabricated accepted stage or no-op validator. The D7
 * and its supported assessment are the genuinely paid seed. Their exact historical manifest survives this new draft. */
function artifact(f: World) {
  const source = f.engine.discovery.evidence.document('p', 'keeper-stage-brief', 'Stage material for the accepted product', 'text/plain', 0);
  const draft = f.engine.prepare('p', 'discovery');
  for (const id of draft.value.questions) {
    const question = f.store.get<Question>(id)!;
    if (question.value.spec.kind === 'fact') f.engine.discovery.fact(id, question.revision, reference(source),
      { kind: 'text-range', start: 0, end: source.value.content.length });
    else if (['researchPlan', 'researchReport', 'verdict', 'preparation'].includes(question.value.spec.field))
      answerDiscoveryFixture(f.engine, 'p', f.store.get<DiscoveryDraft>(draft.id)!, question, preparedField('p', question.value.spec.field), source);
    else f.engine.discovery.decision(id, question.revision, 'owner', preparedField('p', question.value.spec.field));
  }
  const row = f.engine.draft('p', 'discovery', draft.id, 0);
  return f.engine.pipeline.accept('p', 'discovery', row.revision);
}
async function world(t: test.TestContext, options: FinalAssessmentSeedOptions = {}) {
  const f = await finalAssessmentPaid(t, options); modeOf(f.store, 'bypass');
  const accepted = await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult,
    decision: 'accept', reason: 'Accept exact assessed product' });
  assert.ok(accepted.accepted);
  return { f, stage: artifact(f), manifest: reference(accepted.accepted.manifest) };
}


function input(w: Awaited<ReturnType<typeof world>>): KeeperSessionInput {
  return { project: 'p', sourceKind: 'stage', source: reference(w.stage), manifest: w.manifest,
    checkVersion: 'keeper-session-test/v1', environment: reference(w.f.engine.environments.get('p')),
    prompt: 'Check the entire exact pair without assuming acceptance of the artifact by Keeper',
    packetChars: 8_000_000, limitChars: 9_000_000, resultLimitChars: 200_000 };
}
const state = (f: World) => ({ all: all(f.store), events: f.store.integrityLedger(), money: money(f.store), wire: f.wires() });
async function refusal(f: World, action: () => Promise<unknown>, code?: string) {
  const before = state(f);
  await assert.rejects(action, e => e instanceof EngineError && (!code || e.code === code));
  assert.deepEqual(state(f), before);
}

test('session: real paid constitution and accepted stage publish complete prepared material without payment', async t => {
  const w = await world(t), { f } = w, finances = money(f.store), wires = f.wires();
  const row = await prepareKeeperSession(f.store, input(w));
  assert.equal(row.value.state, 'prepared');
  assert.equal(row.kind, 'keeper-session'); assert.equal(row.revision, 1);
  assert.equal(row.hash, hashJson(row.value as unknown as Json));
  assert.equal(row.value.request.key.checkVersion, 'keeper-session-test/v1');
  assert.deepEqual(row.value.packing.role, f.engine.environments.get('p').value.reviewer);
  assert.deepEqual(row.value.limits, { request: 9_000_000, reply: 200_000 });
  assert.deepEqual(row.value.request.artifact.value, w.stage.value);
  const archive = readKeeperArchive(f.store, 'p', row.value.packing.archive, row.value.request);
  assert.deepEqual(archive.parts, row.value.packing.parts);
  assert.ok(row.value.packing.envelopes.every(x => x.input.length === x.measuredChars && x.measuredChars <= 9_000_000));
  assert.deepEqual(money(f.store), finances); assert.deepEqual(f.wires(), wires);
});

test('session: getters snapshot once, exact historical Environment, late heads, hot/cold and isolated branches', async t => {
  const w = await world(t), { f } = w, initial = input(w), counts = new Map<string, number>();
  const getters = Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, value]));
  for (const [key, value] of Object.entries(initial)) Object.defineProperty(getters, key, { enumerable: true,
    get() { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n === 1 ? value : null; } });
  const row = await prepareKeeperSession(f.store, getters), expected = structuredClone(row);
  assert.ok([...counts.values()].every(n => n === 1));
  const environment = f.engine.environments.get('p');
  f.store.write({ id: environment.id, kind: environment.kind, expected: environment.revision, value: environment.value as unknown as Json });
  row.value.input.environment.hash = '0'.repeat(64);
  assert.deepEqual(row.value.packing.role, expected.value.packing.role);
  row.value.request.key.checkVersion = 'mutated';
  assert.deepEqual(row.value.packing.envelopes[0]!.packet.key, expected.value.packing.envelopes[0]!.packet.key);
  row.value.packing.parts[0]!.hash = '0'.repeat(64);
  assert.deepEqual(row.value.packing.archive, expected.value.packing.archive);
  const before = state(f);
  assert.deepEqual(await readKeeperSessionAt(f.store, 'p', reference(expected)), expected);
  f.reopen();
  assert.deepEqual(await readKeeperSessionAt(f.store, 'p', reference(expected)), expected);
  assert.deepEqual(state(f), before);
});

test('session: a second Store wins the initial CAS and commit-return cuts recover the same atomic preparation', async t => {
  const w = await world(t), { f } = w, request = input(w), cold = new Store(f.path); t.after(() => cold.close());
  const write = Store.prototype.writeMany;
  let raced = false;
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    if (this === f.store && !raced && writes.some(x => x.kind === 'keeper-session')) {
      raced = true; write.call(cold, writes, guards);
    }
    return write.call(this, writes, guards);
  } as typeof write;
  let winner;
  try { winner = await prepareKeeperSession(f.store, request); }
  finally { Store.prototype.writeMany = write; }
  assert.equal(raced, true); assert.equal(f.store.history(winner.id).length, 1);
  const racedState = state(f);
  assert.deepEqual(await readKeeperSessionAt(cold, 'p', reference(winner)), winner);
  assert.deepEqual(state(f), racedState);

  const next = { ...request, checkVersion: 'keeper-session-commit-cut/v1' };
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    const saved = write.call(this, writes, guards);
    if (this === f.store && writes.some(x => x.kind === 'keeper-session')) throw new Error('cut-after-commit');
    return saved;
  } as typeof write;
  try { await assert.rejects(prepareKeeperSession(f.store, next), /cut-after-commit/); }
  finally { Store.prototype.writeMany = write; }
  const before = state(f), recovered = await prepareKeeperSession(cold, next);
  assert.deepEqual(await prepareKeeperSession(f.store, next), recovered);
  assert.equal(f.store.history(recovered.id).length, 1);
  assert.deepEqual(state(f), before);
});

test('session: missing/null/foreign/extra caller fields never substitute proof or create partial writes', async t => {
  const w = await world(t), { f } = w, request = input(w), before = state(f);
  for (const field of Object.keys(request)) {
    const missing = { ...request } as Record<string, unknown>;
    delete missing[field];
    await assert.rejects(prepareKeeperSession(f.store, missing), e => e instanceof EngineError && e.code === 'keeper_session_invalid');
  }
  assert.deepEqual(state(f), before);
  for (const bad of [null, {}, { ...request, paid: true }, { ...request, source: null },
    { ...request, manifest: { ...request.manifest, extra: true } }, { ...request, sourceKind: 'node' },
    { ...request, resultLimitChars: 0 }, { ...request, source: { ...request.source, id: 'stage:foreign:discovery' } }])
    await refusal(f, () => prepareKeeperSession(f.store, bad));
  for (const bad of [null, {}, { ...request.source, extra: true }])
    await refusal(f, () => readKeeperSessionAt(f.store, 'p', bad));
});

test('session: exact rows reject rehashed imitation and missing archive parts without writes', async t => {
  const w = await world(t), { f } = w, row = await prepareKeeperSession(f.store, input(w));
  const forged = structuredClone(row.value); forged.limits.reply += 1;
  const id = `keeper-session:p:${hashJson(forged as unknown as Json)}`;
  const fake = f.store.write({ id, kind: 'keeper-session', expected: 0, value: forged as unknown as Json });
  await refusal(f, () => readKeeperSessionAt(f.store, 'p', reference(fake)), 'keeper_session_invalid');
  // The opening-brace part is shared with paid source archives. Remove the Keeper request body itself so the
  // source proof remains valid and this refusal specifically tests the new session's archived material.
  const part = row.value.packing.parts.find(ref =>
    f.store.get<{ text: string }>(ref.id, ref.revision)!.value.text.includes('keeper-request/v1'))!;
  assert.ok(part);
  const db = new DatabaseSync(f.path);
  try { db.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER revisions_no_delete'); db.prepare('DELETE FROM revisions WHERE entity_id=? AND revision=?').run(part.id, part.revision); }
  finally { db.close(); }
  f.reopen();
  await refusal(f, () => readKeeperSessionAt(f.store, 'p', reference(row)));
});

for (const outcome of ['no_go', 'insufficient_evidence'] as const) test(`session: genuinely paid ${outcome} retains constitution-absent refusal`, async t => {
  const w = await world(t, { outcome });
  await refusal(w.f, () => prepareKeeperSession(w.f.store, input(w)), 'keeper_constitution_absent');
});

test('session: loss of the exact accepted source refuses despite an intact session hash', async t => {
  const w = await world(t), { f } = w, row = await prepareKeeperSession(f.store, input(w));
  const db = new DatabaseSync(f.path);
  try {
    db.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER revisions_no_delete');
    db.prepare('DELETE FROM revisions WHERE entity_id=? AND revision=?').run(w.stage.id, w.stage.revision);
  } finally { db.close(); }
  f.reopen();
  await refusal(f, () => readKeeperSessionAt(f.store, 'p', reference(row)));
});

test('session: competing incompatible deterministic address refuses and atomically leaves archive parts unpublished', async t => {
  const w = await world(t), { f } = w, request = input(w), cold = new Store(f.path); t.after(() => cold.close());
  const write = Store.prototype.writeMany, beforeArchives = f.store.list('keeper-archive'), beforeParts = f.store.list('request-part');
  let address: string | null = null;
  Store.prototype.writeMany = function (this: Store, writes, guards) {
    const session = writes.find(x => x.kind === 'keeper-session');
    if (this === f.store && !address && session) {
      address = session.id;
      write.call(cold, [{ id: address, kind: 'keeper-session', expected: 0, value: { contract: 'imitation' } }]);
    }
    return write.call(this, writes, guards);
  } as typeof write;
  try { await assert.rejects(prepareKeeperSession(f.store, request), e => e instanceof EngineError && e.code === 'keeper_session_invalid'); }
  finally { Store.prototype.writeMany = write; }
  assert.ok(address); assert.equal(f.store.history(address).length, 1);
  assert.deepEqual(f.store.get(address)!.value, { contract: 'imitation' });
  assert.deepEqual(f.store.list('keeper-archive'), beforeArchives); assert.deepEqual(f.store.list('request-part'), beforeParts);
});
