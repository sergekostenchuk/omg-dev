import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { FinalAcceptanceSessions, acceptDiscoveryFinal, issueFinalAcceptanceInvitation,
  resolveDiscoveryCondition } from '../src/product/owner-authority.js';
import type { AcceptedDiscovery } from '../src/discovery/discovery-acceptance.js';
import { proveClaimAddress, type ClaimAddress } from '../src/discovery/claim-address.js';
import { readArchiveBody } from '../src/discovery/request-parts.js';
import { researchResultFailure } from '../src/discovery/early-research-outcome.js';
import { researchCall, resumeConditionEvidenceResearchCall, resumeDiscoveryFinalAssessmentResearchCall } from '../src/discovery/research-protocol.js';
import { CONDITION_EVIDENCE_PURPOSE, CONDITION_EVIDENCE_RESULT,
  prepareConditionEvidenceSubject } from '../src/discovery/discovery-condition-evidence-subject.js';
import { prepareConditionEvidenceSession } from '../src/discovery/discovery-condition-evidence-session.js';
import { conditionEvidenceExecutionId, readConditionEvidenceDispatchAdmission, readConditionEvidenceExecutionAt,
  readConditionEvidencePaidResultAt, runConditionEvidenceExecution } from '../src/discovery/discovery-condition-evidence-execution.js';
import type { OmResult } from '../src/om/refusal.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

// OMG-V7-B3 (codex-omg2 №16508): the evidence assessment goes through the common paid transport — bounded pages, a lost
// early response, a resume door of its own, cuts around the reservation — and never pays twice. Its continuation and
// terminal measurement are its own: no D7 or final-assessment door accepts them. Same real accepted world as the
// evidence-conditions file.
const CONDITIONS = [
  { id: 'evidence-1', kind: 'evidence', condition: 'A source is available', criterion: 'A signed agreement' },
  { id: 'evidence-2', kind: 'evidence', condition: 'The ledger is reachable', criterion: 'A reachable ledger endpoint' },
  { id: 'owner-1', kind: 'owner_choice', condition: 'The owner bounds the first release', criterion: 'The owner picks a bound',
    options: [{ optionId: 'narrow', label: 'Narrow', consequences: ['Only the ledger ships first'], choice: 'accept' },
      { optionId: 'refuse', label: 'Refuse', consequences: ['The bundle is not released'], choice: 'decline' }] },
];
type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.refusal.code}: ${result.refusal.message}`);
  return (result as { ok: true; value: T }).value;
}
const money = (store: Store) => canonical(store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind))
  .flatMap(row => store.history(row.id)) as never);
async function fixed<T>(f: World, store: Store, action: () => Promise<T>): Promise<T> {
  const calls = money(store), sent = canonical(f.wires() as never);
  const value = await storeUnchanged(store, action);
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
  return value;
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
async function world(t: test.TestContext): Promise<{ f: World; first: AcceptedDiscovery; material: ClaimAddress }> {
  const f = await finalAssessmentPaid(t, { outcome: 'conditional', conditions: CONDITIONS });
  const mode = readProjectMode(f.store, 'p').ref, reason = 'The owner accepts the exact assessed bundle';
  const scope = { projectId: 'p', draft: f.packet.final.subject.basis.draft, paid: f.paidD7, assessment: f.paidResult,
    mode: { id: mode.id, revision: mode.revision, hash: mode.hash }, decision: 'accept', reason };
  const sessions = new FinalAcceptanceSessions(f.store);
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueFinalAcceptanceInvitation(f.store, scope)).invitation }));
  const outcome = await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason },
    sessions.authority(login.bearer));
  // The planted copy runs its own adapter: one real measurement of the independent reviewer precedes the paid assessment.
  f.reply({ action: 'answer', question: 'reader', value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'Calibration' }, citations: [] });
  await researchCall(f.environment.value.reviewer, f.environment.value, 'Measure the independent evidence reviewer', {}, undefined,
    { store: f.store, draftId: f.data.calibration.draft.id, questionId: f.data.calibration.question.id, purpose: 'assessor' });
  const material = f.packet.final.dossier.materials.map(item => item.address).find(address => {
    try { proveClaimAddress(f.store, address); return true; } catch { return false; }
  });
  assert.ok(material);
  return { f, first: outcome.accepted!, material };
}
const answer = (subject: unknown, claim: ClaimAddress, reasons = ['The material was read against the criterion']) =>
  ({ contract: CONDITION_EVIDENCE_RESULT, subject, verdict: 'supported', reasons, bases: [{ claim }], return: null });
function prepare(f: World, first: AcceptedDiscovery, material: ClaimAddress | ClaimAddress[], prompt: string,
  packetChars = 8_000_000, limitChars = 9_000_000, resultLimitChars = 10_000_000, conditionId = 'evidence-1') {
  const claims = Array.isArray(material) ? material : [material];
  const packet = prepareConditionEvidenceSubject(f.store, 'p', { manifest: reference(first.manifest), conditionId, claims });
  const cell = prepareConditionEvidenceSession(f.store, 'p', packet.subject, { prompt, packetChars, limitChars, resultLimitChars,
    environment: reference(f.environment), role: f.environment.value.reviewer });
  return { packet, cell, prepared: reference(cell) };
}
const callsFor = (store: Store, prepared: Ref) => store.list<ModelCall>('model-call').filter(row => row.value.purpose === CONDITION_EVIDENCE_PURPOSE
  && canonical((row.value as unknown as Record<string, any>).finalContinuation?.prepared) === canonical(prepared));
const request = (edition: AcceptedDiscovery, evidence: Ref) =>
  ({ projectId: 'p', manifest: reference(edition.manifest), conditionId: 'evidence-1', evidence, reason: 'The assessed material meets the criterion' });

// The first test pays the first real construction of the conditional seed; its own body stays small.
test('B3 recovery: a prepared assessment serves only its own edition and condition; the terminal answer is measured in its own mode', async t => {
  const { f, first, material } = await world(t);
  const one = prepare(f, first, material, 'Own edition only');
  const two = prepare(f, first, material, 'Own condition only', 8_000_000, 9_000_000, 10_000_000, 'evidence-2');
  // ПОДМЕНА: the D7 paid result or another prepared condition is no source of this preparation.
  for (const [source, cell] of [[f.paidD7, one.prepared], [f.paidResult, one.prepared], [{ ...reference(first.manifest), hash: '0'.repeat(64) }, two.prepared]] as const)
    await storeRefused(f.store, () => runConditionEvidenceExecution(f.store, 'p', source, cell, { profile: f.profile }));
  await storeRefused(f.store, () => runConditionEvidenceExecution(f.store, 'p', reference(first.manifest), one.prepared,
    { restoreOnly: true, allowance: 0 }));
  // The saved capacity classifies the evidence answer by its own contract and measures it against its own allowance.
  const small = prepare(f, first, material, 'A small reply allowance', 8_000_000, 9_000_000, 120_000);
  const capacity = small.cell.value.envelope.capacity;
  assert.equal(capacity.actionMode, 'condition-evidence-preflight');
  assert.equal(researchResultFailure(capacity, answer(small.packet.subject, material)), null);
  const oversized = researchResultFailure(capacity, answer(small.packet.subject, material, ['x'.repeat(200_000)]));
  assert.ok(oversized instanceof EngineError, 'an oversized evidence answer is a capacity refusal of its own form');
  assert.equal(researchResultFailure(capacity, { contract: 'discovery-final-assessment-result/v1', reasons: ['x'.repeat(200_000)] }), null,
    'a final-assessment answer is not measured as an evidence answer');
});

test('B3 recovery: bounded pages deliver the whole request; a lost early response refuses, its own resume applies and nothing is bought twice', async t => {
  const { f, first, material } = await world(t);
  // Really accepted claims of the dossier make the original large beside a fixed core.
  const all = [...new Map(f.packet.final.dossier.materials.map(item => item.address).filter(address => {
    try { proveClaimAddress(f.store, address); return true; } catch { return false; }
  }).map(address => [canonical(address as never), address])).values()];
  // Only as many of them as make the original exceed 30000 characters (a read-only measurement): two or three pages.
  let count = 1;
  while (count < all.length && canonical(prepareConditionEvidenceSubject(f.store, 'p', { manifest: reference(first.manifest),
    conditionId: 'evidence-1', claims: all.slice(0, count) }) as never).length <= 30_000) count++;
  const chosen = all.slice(0, count);
  // One unbounded probe assessment of the same material measures the real dispatch packet D (one cheap call); the page
  // then holds its core, the 8192 kept for a fragment and about half of the original, never all of it.
  const probe = prepare(f, first, chosen, 'Measure the dispatch packet');
  const archive = f.store.get(probe.cell.value.archive.id, probe.cell.value.archive.revision)!;
  const requestChars = canonical(readArchiveBody(f.store, archive).body.request).length;
  f.reply(answer(probe.packet.subject, material));
  const sent = f.wires().length;
  await runConditionEvidenceExecution(f.store, 'p', reference(first.manifest), probe.prepared, { profile: f.profile });
  const { continuation: _continuation, responseOutputLimit: _limit, ...measured } = (f.wires()[sent] as Record<string, any>).subject;
  const dispatchChars = JSON.stringify(measured).length;
  const page = dispatchChars - Math.floor((requestChars - 8192 - 1500) / 2);
  assert.ok(requestChars > 15_000 && page < dispatchChars, `the original is too small to need pages (${requestChars}, ${dispatchChars})`);
  const { packet, prepared } = prepare(f, first, chosen, 'Read every bounded page', page, 400_000);
  f.reply(answer(packet.subject, material));
  const start = f.wires().length;
  let claims = 0;
  await assert.rejects(() => interceptWrites(f.store, (writes, _guards, invoke) => {
    const cut = writes.some(row => row.kind === 'model-call' && row.expected === 0) && ++claims === 2;
    const value = invoke();
    if (cut) throw new Error('cut-after-second-reservation');
    return value;
  }, () => runConditionEvidenceExecution(f.store, 'p', reference(first.manifest), prepared, { profile: f.profile })),
  /cut-after-second-reservation/);
  const wires = f.wires().slice(start) as Record<string, any>[];
  assert.equal(wires.length, 1); assert.ok(wires[0]!.subject.working.materialAddresses.length > 0);
  assert.ok(wires.every(row => JSON.stringify(row).length <= 400_000));
  const calls = callsFor(f.store, prepared);
  const active = calls.find(row => row.value.status === 'running'), prior = calls.find(row => row.value.status === 'succeeded');
  assert.ok(active && prior && active.value.execution?.phase === 'claimed');
  const application = (active.value as unknown as Record<string, any>).conditionEvidenceApplication as Ref;
  const missing = f.store.get(`model-response:${prior.value.requestId}`)!;
  const cursor = f.store.get(conditionEvidenceExecutionId(reference(first.manifest), prepared))!;
  assert.ok(application && missing && cursor);
  // Hide the real earlier response on the genuine Store itself (its proof cache stays in use): every reader and the
  // resume door refuse, nothing is written.
  const lost = (error: unknown) => error instanceof EngineError && error.code === 'response_recovery_wire_invalid';
  const hidden = async (action: () => Promise<unknown>) => {
    const get = Store.prototype.get, store = f.store;
    Store.prototype.get = function (this: Store, id: string, revision?: number) {
      return this === store && id === missing.id && (revision === undefined || revision === missing.revision) ? null : get.call(this, id, revision);
    } as typeof get;
    try { await assert.rejects(action, lost); } finally { Store.prototype.get = get; }
  };
  await fixed(f, f.store, async () => {
    await hidden(() => readConditionEvidenceExecutionAt(f.store, 'p', reference(cursor)));
    await hidden(() => readConditionEvidenceDispatchAdmission(f.store, application));
    await hidden(() => resumeConditionEvidenceResearchCall(f.store, application));
    // ПОДМЕНА: the continuation is the evidence assessment's own; the final-assessment door does not take it.
    await assert.rejects(() => resumeDiscoveryFinalAssessmentResearchCall(f.store, application));
    assert.deepEqual(f.store.get(active.id), active);
  });
  // With the real history the same claim resumes once; the terminal answer is then applied for free.
  await resumeConditionEvidenceResearchCall(f.store, application);
  assert.equal(f.wires().length, start + 2);
  // The remaining pages continue from the cursor; every paid call is sent exactly once.
  const paid = await runConditionEvidenceExecution(f.store, 'p', reference(first.manifest), prepared, { profile: f.profile });
  assert.ok(paid.output && paid.result); assert.equal(paid.result.verdict, 'supported');
  assert.equal(f.wires().length - start, callsFor(f.store, prepared).length, 'no call is bought twice');
  assert.deepEqual(paid.result.packet, packet);
  await fixed(f, f.store, async () => {
    for (const store of [f.store, f.open()]) {
      assert.deepEqual((await readConditionEvidencePaidResultAt(store, 'p', reference(paid.output!))).result, paid.result);
      assert.deepEqual((await runConditionEvidenceExecution(store, 'p', reference(first.manifest), prepared,
        { restoreOnly: true, allowance: 0 })).result, paid.result);
    }
  });
  assert.equal((await resolveDiscoveryCondition(f.store, request(first, reference(paid.output)))).resolved, true);
});

test('B3 recovery: cuts before and after the atomic reservation recover one claim across two Stores', async t => {
  const { f, first, material } = await world(t);
  const { packet, prepared } = prepare(f, first, material, 'Reservation cut');
  f.reply(answer(packet.subject, material));
  const manifest = reference(first.manifest);
  let before = false;
  await fixed(f, f.store, async () => {
    await assert.rejects(() => interceptWrites(f.store, (writes, _guards, invoke) => {
      if (!before && writes.some(row => row.kind === 'model-call')) { before = true; throw new Error('before-reservation'); }
      return invoke();
    }, () => runConditionEvidenceExecution(f.store, 'p', manifest, prepared, { profile: f.profile })), /before-reservation/);
  });
  assert.ok(before); assert.equal(f.store.get(conditionEvidenceExecutionId(manifest, prepared)), null);
  let after = false;
  await assert.rejects(() => interceptWrites(f.store, (writes, _guards, invoke) => {
    const cut = !after && writes.some(row => row.kind === 'model-call');
    const value = invoke(); if (cut) { after = true; throw new Error('after-reservation'); } return value;
  }, () => runConditionEvidenceExecution(f.store, 'p', manifest, prepared, { profile: f.profile })), /after-reservation/);
  assert.ok(after); assert.equal(callsFor(f.store, prepared).length, 1);
  const cold = f.open(), wire = f.wires().length;
  await fixed(f, f.store, async () => {
    for (const store of [f.store, cold]) assert.equal((await storeUnchanged(store, () =>
      runConditionEvidenceExecution(store, 'p', manifest, prepared, { restoreOnly: true }))).result, null);
  });
  const results = await Promise.allSettled([runConditionEvidenceExecution(f.store, 'p', manifest, prepared),
    runConditionEvidenceExecution(cold, 'p', manifest, prepared)]);
  const winner = results.find(row => row.status === 'fulfilled');
  assert.ok(winner && winner.status === 'fulfilled' && winner.value.result);
  assert.equal(callsFor(f.store, prepared).length, 1); assert.equal(f.wires().length, wire + 1);
  await fixed(f, f.store, async () => {
    for (const store of [f.store, cold]) assert.deepEqual((await runConditionEvidenceExecution(store, 'p', manifest, prepared,
      { restoreOnly: true, allowance: 0 })).result, winner.value.result);
  });
});
