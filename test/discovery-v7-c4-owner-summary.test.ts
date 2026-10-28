import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import type { Store } from '../src/storage/store.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { ConditionChoiceSessions, FinalAcceptanceSessions, acceptDiscoveryFinal, issueConditionChoiceInvitation,
  issueFinalAcceptanceInvitation, resolveDiscoveryCondition } from '../src/product/owner-authority.js';
import type { AcceptedDiscovery } from '../src/discovery/discovery-acceptance.js';
import { proveClaimAddress } from '../src/discovery/claim-address.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { CONDITION_EVIDENCE_RESULT, prepareConditionEvidenceSubject } from '../src/discovery/discovery-condition-evidence-subject.js';
import { prepareConditionEvidenceSession } from '../src/discovery/discovery-condition-evidence-session.js';
import { runConditionEvidenceExecution } from '../src/discovery/discovery-condition-evidence-execution.js';
import { readDiscoveryFinalSummaryAt, type DiscoveryFinalSummary } from '../src/discovery/discovery-final-summary.js';
import { renderStageSummary, stageSummary } from '../src/product/stage-summary.js';
import { V8_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import type { OmResult } from '../src/om/refusal.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

// OMG-V7-C4 (codex-omg2 №16923, ndisc.d8.n1): the owner's summary of a saved D7 outcome selects only what the shared
// readers prove from one exact Ref. All over the real paid v8 conditional D7 of the choice-editions seed — an evidence
// condition, two choice conditions, a boundary and a risk — its real supported assessment, the owner's decision, an
// accepting choice (choice/v2) and a paid evidence assessment (evidence/v3).
const option = (optionId: string, choice: 'accept' | 'decline') =>
  ({ optionId, label: `Option ${optionId}`, consequences: [`${optionId} follows`], choice });
const owner = (id: string, cls: string) => ({ id, kind: 'owner_choice', condition: `The owner decides ${id}`,
  criterion: `An option of ${id} is picked`, class: cls, classReason: `The options of ${id} are a ${cls}`,
  options: [option(`${id}-yes`, 'accept'), option(`${id}-no`, 'decline')] });
const CONDITIONS = [{ id: 'evidence-1', kind: 'evidence', condition: 'A source is available', criterion: 'A signed agreement' },
  owner('pick1', 'choice'), owner('pick2', 'choice'), owner('scope', 'boundary'), owner('debt', 'risk')];
const IDS = CONDITIONS.map(condition => condition.id);
type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
const world = (t: test.TestContext) => finalAssessmentPaid(t, { outcome: 'conditional', conditions: CONDITIONS, form: V8_FINAL_CONTRACT });
function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.refusal.code}: ${result.refusal.message}`);
  return (result as { ok: true; value: T }).value;
}
const money = (store: Store) => canonical(store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind))
  .flatMap(row => store.history(row.id)) as never);
/** A read that writes nothing, buys nothing and sends nothing. */
async function quiet<T>(f: World, store: Store, action: () => Promise<T>): Promise<T> {
  const calls = money(store), sent = canonical(f.wires() as never);
  const value = await storeUnchanged(store, action);
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
  return value;
}
const summarize = (f: World, request: Record<string, Ref>, store: Store = f.store) => quiet(f, store, () => readDiscoveryFinalSummaryAt(store, 'p', request));
async function decide(f: World, decision: 'accept' | 'decline', reason: string) {
  const mode = readProjectMode(f.store, 'p');
  const request = { projectId: 'p', assessment: f.paidResult, decision, reason };
  if (mode.mode === 'bypass') return acceptDiscoveryFinal(f.store, request);
  const scope = { projectId: 'p', draft: f.packet.final.subject.basis.draft, paid: f.paidD7, assessment: f.paidResult,
    mode: { id: mode.ref.id, revision: mode.ref.revision, hash: mode.ref.hash }, decision, reason };
  const sessions = new FinalAcceptanceSessions(f.store);
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueFinalAcceptanceInvitation(f.store, scope)).invitation }));
  return acceptDiscoveryFinal(f.store, request, sessions.authority(login.bearer));
}
async function choose(f: World, edition: AcceptedDiscovery, conditionId: string, optionId: string) {
  const request = { projectId: 'p', manifest: reference(edition.manifest), conditionId, optionId, reason: 'The owner bounds it this way' };
  const sessions = new ConditionChoiceSessions(f.store);
  const scope = { projectId: 'p', predecessor: request.manifest, bundle: edition.manifest.value.bundle, conditionId, optionId, reason: request.reason };
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueConditionChoiceInvitation(f.store, scope)).invitation }));
  return resolveDiscoveryCondition(f.store, request, sessions.authority(login.bearer)!);
}
/** One real paid evidence assessment of evidence-1 on this exact edition (B3), then its evidence resolution. */
async function evidence(f: World, edition: AcceptedDiscovery) {
  f.reply({ action: 'answer', question: 'reader', value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'Calibration' }, citations: [] });
  await researchCall(f.environment.value.reviewer, f.environment.value, 'Measure the independent evidence reviewer', {}, undefined,
    { store: f.store, draftId: f.data.calibration.draft.id, questionId: f.data.calibration.question.id, purpose: 'assessor' });
  const claim = f.packet.final.dossier.materials.map(item => item.address).find(address => {
    try { proveClaimAddress(f.store, address); return true; } catch { return false; }
  })!;
  const packet = prepareConditionEvidenceSubject(f.store, 'p', { manifest: reference(edition.manifest), conditionId: 'evidence-1', claims: [claim] });
  const prepared = prepareConditionEvidenceSession(f.store, 'p', packet.subject, { prompt: 'Assess the material', packetChars: 8_000_000,
    limitChars: 9_000_000, resultLimitChars: 10_000_000, environment: reference(f.environment), role: f.environment.value.reviewer });
  f.reply({ contract: CONDITION_EVIDENCE_RESULT, subject: packet.subject, verdict: 'supported', reasons: ['The agreement is in the material'],
    bases: [{ claim }], return: null });
  const paid = await runConditionEvidenceExecution(f.store, 'p', reference(edition.manifest), reference(prepared), { profile: f.profile });
  return resolveDiscoveryCondition(f.store, { projectId: 'p', manifest: reference(edition.manifest), conditionId: 'evidence-1',
    evidence: reference(paid.output!), reason: 'The paid assessment confirms the material' });
}
const status = (summary: DiscoveryFinalSummary) => Object.fromEntries(summary.conditions.map(condition => [condition.id, condition.status]));

// The first test pays the first real construction of the classed seed; its own body stays small.
test('C4 before acceptance: the paid D7 alone is unassessed, its supported assessment awaits the owner; neither permits a stage', async t => {
  const f = await world(t);
  const paid = await summarize(f, { paid: f.paidD7 });
  assert.equal(paid.outcome, 'conditional'); assert.equal(paid.form, V8_FINAL_CONTRACT); assert.deepEqual(paid.acceptance, { state: 'unassessed' });
  assert.equal(paid.assessment, null); assert.equal(paid.next, null); assert.equal(paid.permitsNextStage, false);
  assert.deepEqual(paid.conditions.map(condition => condition.id), IDS);
  assert.ok(paid.conditions.every(condition => condition.status === 'pending' && condition.resolution === null));
  assert.deepEqual(paid.reason.address, { record: f.paidD7, pointer: '/projection/result/bundle/verdict/reason' });
  assert.equal(paid.reason.value, f.final.result.value.projection.result.bundle.verdict.reason);
  const awaiting = await summarize(f, { assessment: f.paidResult });
  assert.deepEqual(awaiting.acceptance, { state: 'awaiting_decision', assessment: f.paidResult });
  assert.deepEqual(awaiting.next, { action: 'owner_decision', assessment: f.paidResult });
  assert.equal(awaiting.assessment!.verdict, 'supported'); assert.equal(awaiting.permitsNextStage, false);
  assert.deepEqual({ ...awaiting, basis: null, acceptance: null, assessment: null, next: null },
    { ...paid, basis: null, acceptance: null, assessment: null, next: null }, 'the saved outcome is the same with or without its assessment');
  const text = renderStageSummary(await quiet(f, f.store, () => stageSummary(f.store, 'p', 'discovery', { section: 'discovery-final', assessment: f.paidResult })));
  assert.match(text, /ожидает решения владельца — не принят; принятого манифеста нет/);
  assert.match(text, /Следующая стадия: не разрешена/);
  assert.ok(text.includes(paid.reason.value) && text.includes(`${f.paidD7.id}@${f.paidD7.revision}/projection/result/bundle/verdict/reason`));
  // Malformed requests and foreign Refs refuse without any write.
  for (const bad of [{}, { paid: f.paidD7, assessment: f.paidResult }, { paid: { ...f.paidD7, extra: 1 } }, { draft: f.paidD7 }])
    await storeRefused(f.store, () => readDiscoveryFinalSummaryAt(f.store, 'p', bad), error => error instanceof EngineError && error.code === 'discovery_final_summary_invalid');
  for (const bad of [{ paid: f.paidResult }, { assessment: f.paidD7 }, { manifest: f.paidD7 }, { paid: { ...f.paidD7, hash: '0'.repeat(64) } }])
    await storeRefused(f.store, () => readDiscoveryFinalSummaryAt(f.store, 'p', bad));
});

test('C4 editions: the accepted edition shows its open conditions; choice/v2 and evidence/v3 editions show their grounds, earlier ones stay', async t => {
  const f = await world(t);
  const first = (await decide(f, 'accept', 'The owner accepts the assessed bundle')).accepted!;
  const e0 = await summarize(f, { manifest: reference(first.manifest) });
  assert.equal(e0.acceptance.state, 'accepted'); assert.equal(e0.permitsNextStage, false);
  assert.deepEqual(status(e0), Object.fromEntries(IDS.map(id => [id, 'open'])));
  assert.equal(e0.next?.action, 'resolve_conditions');
  assert.deepEqual(e0.next && e0.next.action === 'resolve_conditions' ? e0.next.open.map(item => item.conditionId) : null, IDS);
  // The assessment names the first edition of its own acceptance, not a later head.
  assert.deepEqual((await summarize(f, { assessment: f.paidResult })).acceptance, e0.acceptance);
  const e1 = (await choose(f, first, 'pick1', 'pick1-yes')).edition!;
  const e2 = (await evidence(f, e1)).edition!;
  const s2 = await summarize(f, { manifest: reference(e2.manifest) });
  assert.deepEqual(status(s2), { 'evidence-1': 'resolved', pick1: 'resolved', pick2: 'open', scope: 'open', debt: 'open' });
  const pick = s2.conditions.find(condition => condition.id === 'pick1')!.resolution!;
  assert.equal(pick.kind, 'owner_choice'); assert.equal(pick.reason, 'The owner bounds it this way');
  assert.equal((pick.option as { optionId: string }).optionId, 'pick1-yes');
  const proof = s2.conditions.find(condition => condition.id === 'evidence-1')!.resolution!;
  assert.equal(proof.kind, 'evidence'); assert.deepEqual(proof.reasons, ['The agreement is in the material']); assert.ok(proof.evidence);
  assert.equal(s2.acceptance.state === 'accepted' && s2.acceptance.previous?.id, e1.manifest.id);
  assert.equal(s2.permitsNextStage, false);
  // The earlier editions keep their own history; a cold Store reads the same and nothing is written or bought.
  const cold = f.open();
  for (const store of [f.store, cold]) {
    assert.deepEqual(status(await summarize(f, { manifest: reference(first.manifest) }, store)), status(e0));
    assert.deepEqual(status(await summarize(f, { manifest: reference(e1.manifest) }, store)),
      { 'evidence-1': 'open', pick1: 'resolved', pick2: 'open', scope: 'open', debt: 'open' });
    assert.deepEqual(await summarize(f, { manifest: reference(e2.manifest) }, store), s2);
  }
  const engine = f.engine;
  const out = await quiet(f, f.store, async () => await engine.execute({ type: 'discovery-final-summary', project: 'p',
    manifest: reference(e2.manifest) }) as { summary: DiscoveryFinalSummary; text: string });
  assert.deepEqual(out.summary, s2);
  assert.ok(out.text.includes('основание: выбор владельца') && out.text.includes('The owner bounds it this way'));
  assert.ok(out.text.includes('основание: оплаченная оценка материала') && out.text.includes('The agreement is in the material'));
  assert.ok(out.text.includes('Разрешить открытые условия редакции'));
});

test('C4 decline: a declining owner act is shown with its reason; no manifest, no next stage', async t => {
  const f = await world(t);
  const declined = await decide(f, 'decline', 'The owner does not take this bundle');
  if (declined.decision !== 'decline') { t.skip('the seed project runs in bypass: a decline is an owner act in questions mode'); return; }
  const summary = await summarize(f, { assessment: f.paidResult });
  assert.deepEqual(summary.acceptance, { state: 'declined', assessment: f.paidResult, act: reference(declined.act!),
    reason: 'The owner does not take this bundle' });
  assert.equal(summary.next, null); assert.equal(summary.permitsNextStage, false);
  assert.ok(summary.conditions.every(condition => condition.status === 'pending'));
  const text = renderStageSummary({ contract: 'stage-summary/discovery-final/v1', project: 'p', stage: 'discovery', final: summary });
  assert.match(text, /отклонён владельцем/); assert.match(text, /The owner does not take this bundle/);
});
