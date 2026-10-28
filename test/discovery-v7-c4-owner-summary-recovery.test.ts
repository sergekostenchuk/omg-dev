import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import type { Store } from '../src/storage/store.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { FinalAcceptanceSessions, acceptDiscoveryFinal, issueFinalAcceptanceInvitation } from '../src/product/owner-authority.js';
import { readDiscoveryFinalSummaryAt, type DiscoveryFinalSummary } from '../src/discovery/discovery-final-summary.js';
import { V9_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import type { OmResult } from '../src/om/refusal.js';
import { finalAssessmentPaid, type FinalAssessmentSeedOptions } from './discovery-v7-final-assessment-seed.js';
import { storeUnchanged } from './store-unchanged.js';

// OMG-V7-C4 (codex-omg2 №16923): the go, returned and negative D7 outcomes are summarized for the owner without a false
// admission, hot and cold, through the public read-only command. Each test plants a copy of an existing paid seed.
type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.refusal.code}: ${result.refusal.message}`);
  return (result as { ok: true; value: T }).value;
}
const money = (store: Store) => canonical(store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind))
  .flatMap(row => store.history(row.id)) as never);
async function quiet<T>(f: World, store: Store, action: () => Promise<T>): Promise<T> {
  const calls = money(store), sent = canonical(f.wires() as never);
  const value = await storeUnchanged(store, action);
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
  return value;
}
/** The summary through the public command, equal hot and cold; it writes, buys and sends nothing. */
async function command(f: World, request: Record<string, Ref>): Promise<{ summary: DiscoveryFinalSummary; text: string }> {
  const engine = f.engine;
  const hot = await quiet(f, f.store, async () => await engine.execute({ type: 'discovery-final-summary', project: 'p', ...request }) as
    { summary: DiscoveryFinalSummary; text: string });
  const cold = f.open();
  assert.deepEqual(await quiet(f, cold, () => readDiscoveryFinalSummaryAt(cold, 'p', request)), hot.summary);
  return hot;
}
async function accept(f: World) {
  const mode = readProjectMode(f.store, 'p'), reason = 'The owner accepts the assessed bundle';
  const request = { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason };
  if (mode.mode === 'bypass') return (await acceptDiscoveryFinal(f.store, request)).accepted!;
  const scope = { projectId: 'p', draft: f.packet.final.subject.basis.draft, paid: f.paidD7, assessment: f.paidResult,
    mode: { id: mode.ref.id, revision: mode.ref.revision, hash: mode.ref.hash }, decision: 'accept', reason };
  const sessions = new FinalAcceptanceSessions(f.store);
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueFinalAcceptanceInvitation(f.store, scope)).invitation }));
  return (await acceptDiscoveryFinal(f.store, request, sessions.authority(login.bearer))).accepted!;
}
const plant = (t: test.TestContext, options?: FinalAssessmentSeedOptions) => finalAssessmentPaid(t, options);

test('C4 go: only an accepted go edition without open conditions permits the next stage, and only by its exact manifest', async t => {
  const f = await plant(t);
  const before = await command(f, { paid: f.paidD7 });
  assert.equal(before.summary.outcome, 'go'); assert.equal(before.summary.permitsNextStage, false);
  assert.deepEqual(before.summary.conditions, []); assert.deepEqual(before.summary.acceptance, { state: 'unassessed' });
  const accepted = await accept(f);
  const after = await command(f, { manifest: reference(accepted.manifest) });
  assert.equal(after.summary.permitsNextStage, true);
  assert.deepEqual(after.summary.next, { action: 'consume_accepted', manifest: reference(accepted.manifest) });
  assert.ok(after.summary.material.length === 3, 'the projection lists of the saved bundle are shown');
  assert.match(after.text, /Следующая стадия: разрешена принятой редакцией без открытых условий/);
  assert.match(after.text, /основа следующей стадии/);
});

test('C4 return: a returned assessment shows its reason and exact targets; nothing is accepted or permitted', async t => {
  const f = await plant(t, { outcome: 'no_go', route: 'model', verdict: 'return' });
  const { summary, text } = await command(f, { assessment: f.paidResult });
  assert.equal(summary.outcome, 'no_go'); assert.equal(summary.assessment!.verdict, 'return');
  assert.deepEqual(summary.acceptance, { state: 'returned', assessment: f.paidResult });
  assert.ok(summary.next && summary.next.action === 'return');
  assert.deepEqual(summary.next.targets, summary.assessment!.return!.targets);
  assert.equal(summary.permitsNextStage, false); assert.deepEqual(summary.material, []);
  assert.match(text, /Возврат: /); assert.match(text, /возврат независимой оценки/);
  assert.ok(text.includes(`${f.paidD7.id}@${f.paidD7.revision}/projection/result/bundle/verdict`), 'a candidate target is an exact address');
});

test('C4 negative: an accepted no_go keeps its reasons and needs; a negative outcome has no route and permits nothing', async t => {
  const f = await plant(t, { outcome: 'no_go', form: V9_FINAL_CONTRACT });
  const accepted = await accept(f);
  const { summary, text } = await command(f, { manifest: reference(accepted.manifest) });
  assert.equal(summary.outcome, 'no_go'); assert.equal(summary.acceptance.state, 'accepted');
  assert.equal(summary.next, null); assert.equal(summary.permitsNextStage, false);
  assert.equal(summary.projection, null); assert.equal(summary.constitution, null);
  const saved = f.final.result.value.projection.result.bundle.summary as { reasons: string[]; needed: string[] };
  assert.deepEqual((summary.summary.value as { reasons: string[] }).reasons, saved.reasons);
  for (const reason of saved.reasons) assert.ok(text.includes(reason));
  assert.match(text, /отрицательный исход не разрешает следующую стадию/);
});

test('C4 negative: insufficient_evidence awaiting the owner is its own outcome, never read as a permission', async t => {
  const f = await plant(t, { outcome: 'insufficient_evidence', form: V9_FINAL_CONTRACT });
  const { summary, text } = await command(f, { assessment: f.paidResult });
  assert.equal(summary.outcome, 'insufficient_evidence'); assert.equal(summary.acceptance.state, 'awaiting_decision');
  assert.equal(summary.permitsNextStage, false); assert.deepEqual(summary.next, { action: 'owner_decision', assessment: f.paidResult });
  assert.match(text, /insufficient_evidence — недостаточно оснований/);
});
