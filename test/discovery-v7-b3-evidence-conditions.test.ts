import { deliveredContract } from './discovery-response-contract-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import type { Store } from '../src/storage/store.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { FinalAcceptanceSessions, acceptDiscoveryFinal, issueFinalAcceptanceInvitation,
  resolveDiscoveryCondition } from '../src/product/owner-authority.js';
import { CONDITION_RESOLUTION_EVIDENCE_CONTRACT, CONDITION_RESOLUTION_KIND, MANIFEST_SUCCESSOR_KIND,
  readAcceptedDiscoveryManifestAt, type AcceptedDiscovery } from '../src/discovery/discovery-acceptance.js';
import { proveClaimAddress, type ClaimAddress } from '../src/discovery/claim-address.js';
import { CONDITION_EVIDENCE_PURPOSE, CONDITION_EVIDENCE_RESULT,
  prepareConditionEvidenceSubject } from '../src/discovery/discovery-condition-evidence-subject.js';
import { prepareConditionEvidenceSession } from '../src/discovery/discovery-condition-evidence-session.js';
import { CONDITION_EVIDENCE_PAID_RESULT_KIND, readConditionEvidencePaidResultAt,
  runConditionEvidenceExecution } from '../src/discovery/discovery-condition-evidence-execution.js';
import type { OmResult } from '../src/om/refusal.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

// OMG-V7-B3 (codex-omg2 №16508): material closes an evidence condition of an exact accepted bundle only through an
// independent paid evidence assessment. Supported, the producer saves the evidence resolution with the next manifest
// edition; returned, the condition stays open with the assessor's explanation. All over a real paid conditional D7 with
// [evidence-1, evidence-2, owner-1], its real supported final assessment and the owner's acceptance.
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
const wire = (f: World) => canonical(f.wires() as never);
async function quiet<T>(f: World, store: Store, action: () => Promise<T>): Promise<T> {
  const calls = money(store), sent = wire(f);
  const value = await storeUnchanged(store, action);
  assert.equal(money(store), calls); assert.equal(wire(f), sent);
  return value;
}
async function refused(f: World, store: Store, action: () => Promise<unknown>, code?: string) {
  const calls = money(store), sent = wire(f);
  await storeRefused(store, action, error => error instanceof EngineError && (!code || error.code === code));
  assert.equal(money(store), calls); assert.equal(wire(f), sent);
}
/** The real conditional world accepted by the owner, with a really accepted claim of its dossier. */
async function world(t: test.TestContext, calibrate = true): Promise<{ f: World; first: AcceptedDiscovery; material: ClaimAddress }> {
  const f = await finalAssessmentPaid(t, { outcome: 'conditional', conditions: CONDITIONS });
  const mode = readProjectMode(f.store, 'p').ref, reason = 'The owner accepts the exact assessed bundle';
  const scope = { projectId: 'p', draft: f.packet.final.subject.basis.draft, paid: f.paidD7, assessment: f.paidResult,
    mode: { id: mode.id, revision: mode.revision, hash: mode.hash }, decision: 'accept', reason };
  const sessions = new FinalAcceptanceSessions(f.store);
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueFinalAcceptanceInvitation(f.store, scope)).invitation }));
  const outcome = await acceptDiscoveryFinal(f.store, { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason },
    sessions.authority(login.bearer));
  // The planted copy runs its own adapter: one real measurement of the independent reviewer precedes the paid assessment.
  if (calibrate) f.reply({ action: 'answer', question: 'reader', value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'Calibration' }, citations: [] });
  if (calibrate) await researchCall(f.environment.value.reviewer, f.environment.value, 'Measure the independent evidence reviewer', {}, undefined,
    { store: f.store, draftId: f.data.calibration.draft.id, questionId: f.data.calibration.question.id, purpose: 'assessor' });
  const material = f.packet.final.dossier.materials.map(item => item.address).find(address => {
    try { proveClaimAddress(f.store, address); return true; } catch { return false; }
  });
  assert.ok(material, 'the dossier keeps a really accepted claim');
  return { f, first: outcome.accepted!, material };
}
function answer(subject: unknown, verdict: 'supported' | 'return', claim: ClaimAddress) {
  return { contract: CONDITION_EVIDENCE_RESULT, subject, verdict, reasons: ['The material was read against the criterion'],
    bases: [{ claim }, { criterion: true }],
    return: verdict === 'supported' ? null : { reason: 'The material names no signed agreement', needed: ['A signed agreement'] } };
}
/** One real paid evidence assessment of one condition of one exact edition by the independent reviewer. */
async function assess(f: World, edition: AcceptedDiscovery, claim: ClaimAddress, verdict: 'supported' | 'return',
  prompt: string, conditionId = 'evidence-1') {
  const packet = prepareConditionEvidenceSubject(f.store, 'p', { manifest: reference(edition.manifest), conditionId, claims: [claim] });
  const prepared = prepareConditionEvidenceSession(f.store, 'p', packet.subject, { prompt, packetChars: 8_000_000,
    limitChars: 9_000_000, resultLimitChars: 10_000_000, environment: reference(f.environment), role: f.environment.value.reviewer });
  f.reply(answer(packet.subject, verdict, claim));
  const paid = await runConditionEvidenceExecution(f.store, 'p', reference(edition.manifest), reference(prepared), { profile: f.profile });
  assert.ok(paid.output && paid.result); assert.equal(paid.result.verdict, verdict);
  deliveredContract(f.store, f.wires().at(-1), 'discovery-condition-evidence');
  return { packet, prepared: reference(prepared), paid, output: reference(paid.output) };
}
const request = (edition: AcceptedDiscovery, evidence: Ref, conditionId = 'evidence-1') =>
  ({ projectId: 'p', manifest: reference(edition.manifest), conditionId, evidence, reason: 'The assessed material meets the criterion' });
const callsFor = (store: Store, prepared: Ref) => store.list<ModelCall>('model-call').filter(row => row.value.purpose === CONDITION_EVIDENCE_PURPOSE
  && canonical((row.value as unknown as Record<string, any>).finalContinuation?.prepared) === canonical(prepared));

// The first test pays the first real construction of the conditional seed; its own body stays small.
test('B3 preparation: foreign conditions, claims, editions and fields refuse before any payment or write', async t => {
  const { f, first, material } = await world(t, false);
  const manifest = reference(first.manifest);
  const subject = (input: unknown) => async () => prepareConditionEvidenceSubject(f.store, 'p', input);
  for (const [bad, why] of [
    [{ manifest, conditionId: 'owner-1', claims: [material] }, 'an owner_choice condition'],
    [{ manifest, conditionId: 'missing', claims: [material] }, 'an unknown condition'],
    [{ manifest, conditionId: 'evidence-1', claims: [] }, 'no material'],
    [{ manifest, conditionId: 'evidence-1', claims: [{ ...material, project: 'other' }] }, 'a foreign claim'],
    [{ manifest: { ...manifest, hash: '0'.repeat(64) }, conditionId: 'evidence-1', claims: [material] }, 'an imitated edition'],
    [{ manifest, conditionId: 'evidence-1', claims: [material], extra: 1 }, 'an unknown field'],
  ] as const) await refused(f, f.store, subject(bad), undefined).catch(error => { throw new Error(`${why}: ${error}`); });
});

test('B3 supported: the paid evidence assessment saves the evidence resolution with the next edition; repeats and the command are free', async t => {
  const { f, first, material } = await world(t);
  assert.deepEqual(first.conditions, { resolved: [], open: ['evidence-1', 'evidence-2', 'owner-1'] });
  const start = f.wires().length;
  const { packet, prepared, paid, output } = await assess(f, first, material, 'supported', 'Assess the material against the criterion');
  assert.deepEqual(paid.result!.subject.condition, { id: 'evidence-1', kind: 'evidence', condition: 'A source is available', criterion: 'A signed agreement' });
  assert.deepEqual(packet.material.map(item => item.address), [material]);
  assert.ok(packet.material[0]!.claim !== undefined, 'the assessor receives the full text of the material');
  assert.ok(f.wires().length > start, 'the assessment is a real physical call');
  const calls = callsFor(f.store, prepared);
  assert.ok(calls.length >= 1);
  assert.equal(calls.at(-1)!.value.requested.actor, f.environment.value.reviewer.actor);
  assert.notEqual(calls.at(-1)!.value.requested.actor, f.environment.value.implementer.actor);
  // No owner authority stands for or against it: the paid assessment is the whole ground.
  const outcome = await resolveDiscoveryCondition(f.store, request(first, output));
  assert.equal(outcome.choice, 'evidence'); assert.equal(outcome.resolved, true); assert.equal(outcome.repeated, false);
  assert.equal(outcome.unproven, null); assert.equal(outcome.route, null); assert.deepEqual(outcome.evidence, output);
  assert.equal(outcome.resolution!.value.contract, CONDITION_RESOLUTION_EVIDENCE_CONTRACT);
  assert.deepEqual((outcome.resolution!.value as { evidence: Ref }).evidence, output);
  const edition = outcome.edition!;
  assert.deepEqual(edition.manifest.value.previous, reference(first.manifest));
  assert.deepEqual(edition.conditions, { resolved: ['evidence-1'], open: ['evidence-2', 'owner-1'] });
  assert.deepEqual(outcome.conditions, edition.conditions);
  assert.equal(f.store.list(CONDITION_RESOLUTION_KIND).length, 1); assert.equal(f.store.list(MANIFEST_SUCCESSOR_KIND).length, 1);
  const cold = f.open(), engine = f.engine;
  await quiet(f, f.store, async () => {
    // The historical reader proves the new edition and its evidence ground again, hot and cold.
    for (const store of [f.store, cold]) {
      const read = await readAcceptedDiscoveryManifestAt(store, 'p', reference(edition.manifest));
      assert.deepEqual(read.conditions, edition.conditions); assert.deepEqual(read.resolutions, edition.resolutions);
      assert.deepEqual((await readAcceptedDiscoveryManifestAt(store, 'p', reference(first.manifest))).conditions, first.conditions);
      assert.deepEqual((await readConditionEvidencePaidResultAt(store, 'p', output)).result, paid.result);
    }
    const again = await resolveDiscoveryCondition(cold, request(first, output));
    assert.equal(again.repeated, true); assert.deepEqual(reference(again.resolution!), reference(outcome.resolution!));
    assert.deepEqual(reference(again.edition!.manifest), reference(edition.manifest));
    const command = await engine.execute({ type: 'discovery-final-condition', project: 'p', manifest: reference(first.manifest),
      conditionId: 'evidence-1', evidence: output, reason: 'The assessed material meets the criterion' }) as Record<string, any>;
    assert.equal(command.choice, 'evidence'); assert.equal(command.resolved, true); assert.equal(command.repeated, true);
    assert.deepEqual(command.act, reference(outcome.resolution!)); assert.deepEqual(command.evidence, output);
    assert.deepEqual(command.conditionStatus, edition.conditions);
    // Restoring the paid assessment buys nothing again.
    assert.deepEqual((await runConditionEvidenceExecution(f.store, 'p', reference(first.manifest), prepared,
      { restoreOnly: true, allowance: 0 })).result, paid.result);
  });
});

test('B3 return: a returned assessment keeps the condition open with its explanation; a later supported one wins, the return conflicts', async t => {
  const { f, first, material } = await world(t);
  const back = await assess(f, first, material, 'return', 'Assess the material once');
  assert.deepEqual(back.paid.result!.result.return, { reason: 'The material names no signed agreement', needed: ['A signed agreement'] });
  const open = await quiet(f, f.store, () => resolveDiscoveryCondition(f.store, request(first, back.output)));
  assert.equal(open.choice, 'evidence'); assert.equal(open.resolved, false); assert.equal(open.unproven, 'condition_evidence_unsupported');
  assert.equal(open.resolution, null); assert.equal(open.edition, null); assert.deepEqual(open.evidence, back.output);
  assert.deepEqual(open.conditions, first.conditions);
  const command = await quiet(f, f.store, async () => await f.engine.execute({ type: 'discovery-final-condition', project: 'p',
    manifest: reference(first.manifest), conditionId: 'evidence-1', evidence: back.output, reason: 'Assessed' }) as Record<string, any>);
  assert.equal(command.act, null); assert.equal(command.unresolved, true); assert.equal(command.reason, 'condition_evidence_unsupported');
  const supported = await assess(f, first, material, 'supported', 'Assess the material again');
  const closed = await resolveDiscoveryCondition(f.store, request(first, supported.output));
  assert.equal(closed.resolved, true);
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, request(first, back.output)), 'discovery_condition_resolution_conflict');
});

test('B3 refusals: a paid assessment of one condition and edition is no ground for another; imitated paid results neither pay nor write', async t => {
  const { f, first, material } = await world(t);
  const manifest = reference(first.manifest);
  const { output } = await assess(f, first, material, 'supported', 'Assess for the refusals');
  // The exact paid assessment of evidence-1 is no ground for another condition, and only an exact paid result is one.
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, request(first, output, 'evidence-2')), 'discovery_condition_resolution_invalid');
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, request(first, output, 'owner-1')), 'discovery_condition_resolution_invalid');
  for (const evidence of [manifest, f.paidResult, f.paidD7, { ...output, hash: '0'.repeat(64) }])
    await refused(f, f.store, () => resolveDiscoveryCondition(f.store, request(first, evidence)));
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, { ...request(first, output), evidence: { ...output, extra: 1 } }),
    'discovery_condition_resolution_invalid');
  // МАСКАРАД: a byte-identical copy of the paid result under another id is not applied by any terminal execution.
  const paid = f.store.get(output.id, output.revision)!;
  const [copy] = f.store.writeMany([{ id: `${CONDITION_EVIDENCE_PAID_RESULT_KIND}:p:imitated`, kind: CONDITION_EVIDENCE_PAID_RESULT_KIND,
    expected: 0, value: paid.value }]);
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, request(first, reference(copy!))));
  assert.equal(f.store.list(CONDITION_RESOLUTION_KIND).length, 0);
  // ОКНА: an assessment of evidence-2 prepared on the first edition cannot write once the first edition has a successor.
  const late = await assess(f, first, material, 'supported', 'Assess the second condition on the first edition', 'evidence-2');
  const second = (await resolveDiscoveryCondition(f.store, request(first, output))).edition!;
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, request(first, late.output, 'evidence-2')),
    'discovery_condition_resolution_stale');
  // On the current edition the second condition closes by its own assessment and the third edition chains both.
  const current = await assess(f, second, material, 'supported', 'Assess the second condition on the second edition', 'evidence-2');
  const third = await resolveDiscoveryCondition(f.store, request(second, current.output, 'evidence-2'));
  assert.equal(third.resolved, true);
  assert.deepEqual(third.edition!.conditions, { resolved: ['evidence-1', 'evidence-2'], open: ['owner-1'] });
  assert.deepEqual(third.edition!.manifest.value.previous, reference(second.manifest));
});

test('B3 race: two Stores resolving with the same paid assessment publish one resolution and one edition', async t => {
  const { f, first, material } = await world(t);
  const { output } = await assess(f, first, material, 'supported', 'Assess for the race');
  const cold = f.open(), calls = money(f.store);
  const results = await Promise.all([resolveDiscoveryCondition(f.store, request(first, output)),
    resolveDiscoveryCondition(cold, request(first, output))]);
  assert.deepEqual(results.map(row => row.resolved), [true, true]);
  assert.deepEqual(reference(results[0]!.resolution!), reference(results[1]!.resolution!));
  assert.deepEqual(reference(results[0]!.edition!.manifest), reference(results[1]!.edition!.manifest));
  assert.equal(results.filter(row => !row.repeated).length <= 1, true);
  assert.equal(f.store.list(CONDITION_RESOLUTION_KIND).length, 1); assert.equal(f.store.list(MANIFEST_SUCCESSOR_KIND).length, 1);
  assert.equal(money(f.store), calls, 'resolving pays nothing');
});
