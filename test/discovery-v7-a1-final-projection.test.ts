import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import type { Store } from '../src/storage/store.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { ConditionChoiceSessions, FinalAcceptanceSessions, acceptDiscoveryFinal, issueConditionChoiceInvitation,
  issueFinalAcceptanceInvitation, resolveDiscoveryCondition } from '../src/product/owner-authority.js';
import { readAcceptedDiscoveryManifestAt, type AcceptedDiscovery } from '../src/discovery/discovery-acceptance.js';
import { projectDiscoveryFinal, DISCOVERY_FINAL_RESULT } from '../src/discovery/discovery-final-result.js';
import { prepareDiscoveryFinalAssessmentSubject } from '../src/discovery/discovery-final-assessment-subject.js';
import { V9_FINAL_CONTRACT, checkFinalBundle } from '../src/discovery/v7-final-contracts.js';
import { JOURNEY_VARIANTS } from '../src/discovery/preparation-contracts.js';
import type { OmResult } from '../src/om/refusal.js';
import { modeOf } from './discovery-v7-dossier-seed.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { finalProjection } from './discovery-v7-final-paid-seed.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

// OMG-V7-A1 (codex-omg2 №16384, ndisc.d7.n7): the full structural projection of the chosen product in the D7 form
// discovery-final/v9 — produced by the real paid D7, reviewed whole by the paid assessor, accepted with the bundle and
// read historically; a classed choice still resolves in an edition. Broken links and ungrounded content never pass.
const option = (optionId: string, choice: 'accept' | 'decline') => ({ optionId, label: optionId, consequences: [`${optionId} follows`], choice });
const CONDITIONS = [{ id: 'evidence-1', kind: 'evidence', condition: 'A source is available', criterion: 'A signed agreement' },
  { id: 'pick', kind: 'owner_choice', condition: 'The owner picks the first channel', criterion: 'A channel is picked', class: 'choice',
    classReason: 'Both channels stay inside the bundle', options: [option('pick-web', 'accept'), option('pick-none', 'decline')] }];
type World = Awaited<ReturnType<typeof finalAssessmentPaid>>;
const world = (t: test.TestContext) => finalAssessmentPaid(t, { outcome: 'conditional', conditions: CONDITIONS, form: V9_FINAL_CONTRACT });
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
async function accepted(f: World): Promise<AcceptedDiscovery> {
  const mode = readProjectMode(f.store, 'p'), reason = 'The owner accepts the exact assessed bundle';
  const request = { projectId: 'p', assessment: f.paidResult, decision: 'accept', reason };
  if (mode.mode === 'bypass') return (await acceptDiscoveryFinal(f.store, request)).accepted!;
  const scope = { projectId: 'p', draft: f.packet.final.subject.basis.draft, paid: f.paidD7, assessment: f.paidResult,
    mode: { id: mode.ref.id, revision: mode.ref.revision, hash: mode.ref.hash }, decision: 'accept', reason };
  const sessions = new FinalAcceptanceSessions(f.store);
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueFinalAcceptanceInvitation(f.store, scope)).invitation }));
  return (await acceptDiscoveryFinal(f.store, request, sessions.authority(login.bearer))).accepted!;
}

// The first test pays the first real construction of the v9 seed; its own body stays small.
test('A1 paid: the real paid D7 of discovery-final/v9 carries the full projection, grounded verbatim in its dossier', async t => {
  const f = await world(t), bundle = f.final.result.value.projection.result.bundle;
  assert.equal(bundle.contract, V9_FINAL_CONTRACT);
  assert.deepEqual(bundle.projection, finalProjection(f.packet.final, CONDITIONS), 'the model projection, verbatim');
  const projection = bundle.projection as any;
  assert.deepEqual(Object.keys(projection.journeys).sort(), [...JOURNEY_VARIANTS].sort());
  const material = f.packet.final.dossier.materials[0]!;
  assert.deepEqual(projection.constraints[0].basis[0], { claim: material.address, content: (material.value as { text: string }).text });
  assert.deepEqual(f.packet.candidate, bundle, 'the paid assessor reviewed the whole bundle with its projection');
});

test('A1 accepted: the full projection survives acceptance and the historical read, hot and cold, and a classed choice resolves', async t => {
  const f = await world(t), first = await accepted(f);
  const paid = f.final.result.value.projection.result.bundle;
  assert.deepEqual(first.bundle.value.bundle.projection, paid.projection);
  const cold = f.open();
  assert.deepEqual(await quiet(f, cold, () => readAcceptedDiscoveryManifestAt(cold, 'p', reference(first.manifest))), first);
  // The class of v9 is proven like v8: the owner's choice publishes an edition that keeps the whole projection.
  const sessions = new ConditionChoiceSessions(f.store), request = { projectId: 'p', manifest: reference(first.manifest), conditionId: 'pick',
    optionId: 'pick-web', reason: 'The owner picks the web channel' };
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueConditionChoiceInvitation(f.store, { projectId: 'p',
    predecessor: request.manifest, bundle: first.manifest.value.bundle, conditionId: 'pick', optionId: 'pick-web', reason: request.reason })).invitation }));
  const outcome = await resolveDiscoveryCondition(f.store, request, sessions.authority(login.bearer));
  assert.equal(outcome.resolved, true);
  const edition = await readAcceptedDiscoveryManifestAt(f.store, 'p', reference(outcome.edition!.manifest));
  assert.deepEqual(edition.bundle.value.bundle.projection, paid.projection);
  assert.deepEqual(edition.conditions, { resolved: ['pick'], open: ['evidence-1'] });
});

test('A1 negative: a supported no_go of discovery-final/v9 keeps its lawful null projection and constitution', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'no_go', form: V9_FINAL_CONTRACT });
  modeOf(f.store, 'bypass');
  const first = await accepted(f), bundle = first.bundle.value.bundle;
  assert.equal(bundle.contract, V9_FINAL_CONTRACT); assert.equal(bundle.verdict.outcome, 'no_go');
  assert.equal(bundle.projection, null); assert.equal(bundle.constitution, null);
});

test('A1 refused: a missing part, a broken link or an ungrounded content is no v9 bundle and no assessment subject', async t => {
  const f = await world(t), packet = f.packet.final, paid = f.final.result.value.projection.result.bundle;
  const variant = (change: (projection: any, bundle: any) => void) => { const bundle = structuredClone(paid) as any; change(bundle.projection, bundle); return bundle; };
  const formRefusals: [string, (projection: any, bundle: any) => void][] = [
    ['a missing journey', projection => { delete projection.journeys.success; }],
    ['a missing projection part', projection => { delete projection.risks; }],
    ['the five legacy lists', (_projection, bundle) => { bundle.projection = { users: ['Operator'], payers: [], rules: [], externalSystems: [], unresolved: [] }; }],
    ['an unknown actor of an outcome', projection => { projection.outcomes[0].beneficiary = 'nobody'; }],
    ['an unknown outcome of a scenario', projection => { projection.journeys.success.scenarios[0].outcome = 'nothing'; }],
    ['an unknown actor of a system', projection => { projection.externalSystems[0].actor = 'nobody'; }],
    ['an unknown outcome of a risk', projection => { projection.risks[0].affectedOutcome = { outcome: 'nothing' }; }],
    ['an unknown mitigation', projection => { projection.risks[0].mitigation = { unknown: 'missing' }; }],
    ['a duplicate actor id', projection => { projection.actors[1].id = projection.actors[0].id; }],
    ['an address without content', projection => { delete projection.constraints[0].basis[0].content; }],
    ['an unknown without its close criterion', projection => { delete projection.unknowns[0].closeCriterion; }],
  ];
  for (const [label, change] of formRefusals)
    assert.throws(() => checkFinalBundle(variant(change), V9_FINAL_CONTRACT), (error: unknown) => error instanceof EngineError && error.code === 'answer_invalid', label);
  // Ground checks against the exact proven dossier: on the paid reply check and on the assessment subject alike.
  const groundRefusals: [string, (projection: any) => void][] = [
    ['a ground that is no dossier claim', projection => { projection.constraints[0].basis[0].claim = { ...projection.constraints[0].basis[0].claim, claimId: 'other' }; }],
    ['a ground quoted otherwise', projection => { projection.risks[0].basis[0].content = 'A rewritten fact'; }],
    ['a document quoted otherwise', projection => { projection.externalSystems[0].documents[0].content = 'Another document'; }],
    ['an origin that is no dossier unknown', projection => { projection.unknowns[0].origin = { claim: projection.constraints[0].basis[0].claim }; }],
    ['an origin that is no evidence condition', projection => { projection.unknowns[0].origin = { condition: 'pick' }; }],
  ];
  for (const [label, change] of groundRefusals) {
    const bundle = variant(change);
    assert.equal(checkFinalBundle(bundle, V9_FINAL_CONTRACT).contract, V9_FINAL_CONTRACT, `${label}: the form alone holds`);
    assert.throws(() => projectDiscoveryFinal(packet, { contract: DISCOVERY_FINAL_RESULT, subject: packet.subject, bundle }, V9_FINAL_CONTRACT),
      (error: unknown) => error instanceof EngineError && error.code === 'answer_invalid', label);
    await storeRefused(f.store, () => prepareDiscoveryFinalAssessmentSubject(f.store, 'p', f.final.d6, bundle),
      error => error instanceof EngineError && error.code === 'answer_invalid');
  }
});
