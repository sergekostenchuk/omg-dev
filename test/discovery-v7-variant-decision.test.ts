import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { referenceSites } from '../src/storage/reference-sites.js';
import { checkStoreIntegrity } from '../src/storage/fsck.js';
import { VARIANT_CRITERIA, VARIANT_CONTRACT, VARIANT_SET_CONTRACT, VARIANT_NONE_CONTRACT,
  VARIANT_SNAPSHOT_CONTRACT, VARIANT_SCOPE_CONTRACT, variantRecordId, type DiscoveryVariant,
  type VariantSnapshot, type VariantSet, type VariantNone, type VariantScale, type VariantJudgements } from '../src/discovery/discovery-variants.js';
import { VARIANT_OWNER_DECISION_CONTRACT, VARIANT_MODEL_DECISION_CONTRACT, VARIANT_STATE_CONTRACT,
  VARIANT_HANDOFF_CONTRACT, VARIANT_OWNER_ACTION, VARIANT_OWNER_GRANT_CONTRACT, VARIANT_OWNER_SESSION_CONTRACT,
  decodeVariantOwnerDecision, decodeVariantModelDecision, decodeVariantChoiceScope, decodeVariantState,
  decodeVariantScope, decodeVariantHandoff, readVariantDecisionStructural, readVariantStateStructural,
  readVariantScopeStructural, readVariantHandoffStructural, variantStateId,
  type VariantModelDecision, type VariantOwnerDecision, type VariantState, type VariantScope, type VariantHandoff } from '../src/discovery/variant-decision.js';

// Form/Ref fixtures only. No live authority, paid provenance or accepted claim is asserted here.
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-variant-decisions-')), path = join(root, 'state.sqlite'), store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const base = (name: string) => reference(store.write({ id: `basis:${name}`, kind: 'structural-test-basis', expected: 0, value: { name } }));
  const draft = base('draft'), frame = base('frame'), plan = base('plan'), mode = base('mode'), ground = base('ground');
  const origin = { intent: base('intent'), call: base('call'), response: base('response') };
  const authority = { grant: base('grant'), session: base('session') };
  const save = <T extends { projectId: string }>(kind: string, value: T): Ref => reference(store.write({ id: variantRecordId(kind, value), kind, expected: 0, value }));
  const snapshotValue: VariantSnapshot = { contract: VARIANT_SNAPSHOT_CONTRACT, projectId: 'p', draft, frame, plan,
    questions: [{ planQuestionId: 'q', question: base('question'), blocking: true, progress: ground,
      applications: [ground], reason: null }] };
  const snapshot = save('discovery-variant-snapshot', snapshotValue);
  const scale = Object.fromEntries(VARIANT_CRITERIA.map(k => [k, 'Qualitative conclusion with explicit uncertainty'])) as VariantScale;
  const memberValue: DiscoveryVariant = { contract: VARIANT_CONTRACT, projectId: 'p', draft, snapshot, origin, key: 'v', title: 'Variant',
    proposal: { product: 'Product' }, scale, criteria: Object.fromEntries(VARIANT_CRITERIA.map(k => [k,
      { conclusion: k, grounds: [ground], assumptions: [], unknowns: [], quantity: null }])) as unknown as VariantJudgements };
  const member = save('discovery-variant', memberValue);
  const setValue: VariantSet = { contract: VARIANT_SET_CONTRACT, projectId: 'p', draft, snapshot, origin, members: [member], scale,
    comparison: 'Only one supported proposal within these limits', recommendation: { member, reason: 'Narrow scope' }, searchLimits: ['Single sweep'], unknowns: [] };
  const set = save('discovery-variant-set', setValue);
  const noneValue: VariantNone = { contract: VARIANT_NONE_CONTRACT, projectId: 'p', draft, snapshot, origin,
    reasons: [{ code: 'no_proposal', message: 'No proposal within this search', grounds: [ground] }], searchLimits: ['Single sweep'], unknowns: [] };
  const none = save('discovery-variant-none', noneValue);
  const common = { projectId: 'p', draft, set, mode, expectedSelection: null, previous: null,
    outcome: { kind: 'choose' as const, member, reason: 'Small scope' } };
  const modelValue: VariantModelDecision = { ...common, contract: VARIANT_MODEL_DECISION_CONTRACT, origin };
  const ownerValue: VariantOwnerDecision = { ...common, contract: VARIANT_OWNER_DECISION_CONTRACT, operation: 'initial', authority };
  const model = save('discovery-variant-model-decision', modelValue), owner = save('discovery-variant-owner-decision', ownerValue);
  const scopeValue: VariantScope = { contract: VARIANT_SCOPE_CONTRACT, projectId: 'p', draft, set, member, decision: owner, mode };
  const scope = save('discovery-variant-scope', scopeValue);
  const handoffValue: VariantHandoff = { contract: VARIANT_HANDOFF_CONTRACT, projectId: 'p', draft, frame, plan, snapshot,
    result: set, set, decision: owner, scope, choice: member, reason: 'choose', next: 'deep', stop: null };
  return { store, path, save, draft, frame, plan, mode, ground, authority, origin, snapshot, member, set, setValue, none,
    modelValue, ownerValue, model, owner, scopeValue, scope, handoffValue };
}
const invalid = (run: () => unknown, code?: string) => assert.throws(run,
  (error: unknown) => error instanceof EngineError && (code ? error.code === code : error.code.startsWith('discovery_variant_')));
const without = (value: object, field: string) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));

test('DR4-M owner and model decisions, owner scope and v4 authority contracts stay distinct structural forms', t => {
  const f = fixture(t);
  assert.equal(VARIANT_OWNER_GRANT_CONTRACT, 'owner-session-grant/v4');
  assert.equal(VARIANT_OWNER_SESSION_CONTRACT, 'owner-session/v4');
  for (const ref of [f.owner, f.model]) assert.equal(readVariantDecisionStructural(f.store, 'p', ref).verification, 'structural');
  assert.deepEqual(decodeVariantOwnerDecision(f.ownerValue), f.ownerValue);
  assert.deepEqual(decodeVariantModelDecision(f.modelValue), f.modelValue);
  invalid(() => decodeVariantOwnerDecision(f.modelValue)); invalid(() => decodeVariantModelDecision(f.ownerValue));
  const { contract: _contract, authority: _authority, ...scope } = f.ownerValue;
  assert.deepEqual(decodeVariantChoiceScope({ ...scope, action: VARIANT_OWNER_ACTION }), { ...scope, action: VARIANT_OWNER_ACTION });
  invalid(() => decodeVariantChoiceScope({ ...scope, action: 'project-mode' }));
  for (const [value, decode] of [[f.ownerValue, decodeVariantOwnerDecision], [f.modelValue, decodeVariantModelDecision],
    [{ ...scope, action: VARIANT_OWNER_ACTION }, decodeVariantChoiceScope]] as const) {
    for (const field of Object.keys(value)) invalid(() => decode(without(value, field)));
    for (const flag of ['paid', 'owner', 'accepted', 'authorityProven']) invalid(() => decode({ ...value, [flag]: true }));
  }
  invalid(() => decodeVariantOwnerDecision({ ...f.ownerValue, authority: { ...f.authority, verified: true } }));
  invalid(() => decodeVariantOwnerDecision({ ...f.ownerValue, authority: { grant: f.authority.grant } }));
  invalid(() => decodeVariantOwnerDecision({ ...f.ownerValue, contract: 'discovery-variant-owner-decision/v9' }));
  invalid(() => decodeVariantModelDecision({ ...f.modelValue, previous: f.owner }));
});

test('DR4-M owner override names the exact model decision and same set; owner revision names an owner act', t => {
  const f = fixture(t);
  const overrideValue: VariantOwnerDecision = { ...f.ownerValue, operation: 'override', previous: f.model,
    outcome: { kind: 'reject_all', reason: 'Owner declines this set' } };
  const override = f.save('discovery-variant-owner-decision', overrideValue);
  assert.deepEqual(readVariantDecisionStructural(f.store, 'p', override).record.value, overrideValue);
  const revised = f.save('discovery-variant-owner-decision', { ...f.ownerValue, operation: 'revise', previous: override });
  assert.equal(readVariantDecisionStructural(f.store, 'p', revised).record.value.previous!.hash, override.hash);
  for (const changed of [{ ...overrideValue, previous: f.owner }, { ...f.ownerValue, operation: 'revise', previous: f.model },
    { ...f.ownerValue, outcome: { kind: 'choose', member: f.ground, reason: 'Foreign member' } },
    { ...f.ownerValue, draft: f.ground }, { ...f.ownerValue, projectId: 'foreign' }]) {
    const ref = f.save('discovery-variant-owner-decision', changed);
    invalid(() => readVariantDecisionStructural(f.store, 'p', ref));
  }
  const invalidPrior = f.save('discovery-variant-model-decision', { ...f.modelValue,
    outcome: { kind: 'choose', member: f.ground, reason: 'Not a member of this set' } });
  invalid(() => readVariantDecisionStructural(f.store, 'p', f.save('discovery-variant-owner-decision',
    { ...overrideValue, previous: invalidPrior })), 'discovery_variant_decision_invalid');
  const otherSet = f.save('discovery-variant-set', { ...f.setValue, comparison: 'New set with the same member' });
  const changedSet = f.save('discovery-variant-owner-decision', { ...overrideValue, set: otherSet });
  invalid(() => readVariantDecisionStructural(f.store, 'p', changedSet), 'discovery_variant_decision_invalid');
  for (const bad of [{ ...overrideValue, previous: null }, { ...f.ownerValue, previous: f.model },
    { ...f.ownerValue, operation: 'pretend' }]) invalid(() => decodeVariantOwnerDecision(bad));
  invalid(() => readVariantDecisionStructural(f.store, 'p', { ...f.model, hash: '0'.repeat(64) }));
  invalid(() => readVariantDecisionStructural(f.store, 'p', f.set));
  invalid(() => readVariantDecisionStructural(null as never, 'p', f.owner));
});

test('DR4-M one project/logical-draft state may hold a set before choice and preserves exact previous revisions', t => {
  const f = fixture(t), id = variantStateId('p', f.draft.id);
  const value: VariantState = { contract: VARIANT_STATE_CONTRACT, projectId: 'p', draft: f.draft, mode: f.mode,
    result: f.set, set: f.set, decision: null, previous: null };
  const first = reference(f.store.write({ id, kind: 'discovery-variant-state', expected: 0, value }));
  assert.deepEqual(readVariantStateStructural(f.store, 'p', f.draft.id, first).record.value, value);
  const secondValue = { ...value, decision: f.owner, previous: first };
  const second = reference(f.store.write({ id, kind: 'discovery-variant-state', expected: 1, value: secondValue }));
  assert.deepEqual(readVariantStateStructural(f.store, 'p', f.draft.id, second).record.value, secondValue);
  assert.equal(readVariantStateStructural(f.store, 'p', f.draft.id, first).record.value.decision, null);
  const cold = new Store(f.path);
  try { assert.deepEqual(readVariantStateStructural(cold, 'p', f.draft.id, second).record.value, secondValue); } finally { cold.close(); }
  assert.equal(f.store.history(id).length, 2);
  invalid(() => readVariantStateStructural(f.store, 'p', 'other-draft', second));
  invalid(() => decodeVariantState({ ...value, set: null, decision: f.owner }));
  invalid(() => decodeVariantState({ ...value, result: f.none }));
  for (const field of Object.keys(value)) invalid(() => decodeVariantState(without(value, field)));
  const broken = reference(f.store.write({ id, kind: 'discovery-variant-state', expected: 2, value: { ...secondValue, previous: first } }));
  invalid(() => readVariantStateStructural(f.store, 'p', f.draft.id, broken));
});

test('DR4-M no_variants state has no decision; a mismatched decision mode is refused', t => {
  const f = fixture(t), id = variantStateId('p', f.draft.id);
  const state: VariantState = { contract: VARIANT_STATE_CONTRACT, projectId: 'p', draft: f.draft, mode: f.mode,
    result: f.none, set: null, decision: null, previous: null };
  const first = reference(f.store.write({ id, kind: 'discovery-variant-state', expected: 0, value: state }));
  assert.deepEqual(readVariantStateStructural(f.store, 'p', f.draft.id, first).record.value, state);
  const bad = reference(f.store.write({ id, kind: 'discovery-variant-state', expected: 1,
    value: { ...state, result: f.set, set: f.set, decision: f.owner, mode: f.ground, previous: first } }));
  invalid(() => readVariantStateStructural(f.store, 'p', f.draft.id, bad));
});

test('DR4-M scope and handoff distinguish choose, reject_all, no_variants and early_limit without final acceptance', t => {
  const f = fixture(t);
  assert.deepEqual(readVariantScopeStructural(f.store, 'p', f.scope).record.value, f.scopeValue);
  const rejection = f.save('discovery-variant-model-decision', { ...f.modelValue, outcome: { kind: 'reject_all', reason: 'No fit' } });
  const variants: VariantHandoff[] = [f.handoffValue,
    { ...f.handoffValue, reason: 'reject_all', next: 'dossier', decision: rejection, scope: null, choice: null },
    { ...f.handoffValue, reason: 'no_variants', next: 'dossier', result: f.none, set: null, decision: null, scope: null, choice: null },
    { ...f.handoffValue, reason: 'early_limit', next: 'dossier', snapshot: null, result: null, set: null, decision: null,
      scope: null, choice: null, stop: { code: 'discovery_budget_reserve', message: 'Budget before sweep completion', grounds: [f.ground] } }];
  for (const value of variants) {
    const ref = f.save('discovery-variant-handoff', value);
    assert.deepEqual(readVariantHandoffStructural(f.store, 'p', ref).record.value, value);
    assert.equal(Object.hasOwn(value, 'accepted'), false);
    for (const field of Object.keys(value)) invalid(() => decodeVariantHandoff(without(value, field)));
    invalid(() => decodeVariantHandoff({ ...value, accepted: true }));
  }
  for (const changed of [{ ...f.scopeValue, member: f.ground }, { ...f.scopeValue, mode: f.ground },
    { ...f.scopeValue, set: f.ground }, { ...f.scopeValue, draft: f.ground }, { ...f.scopeValue, decision: rejection }])
    invalid(() => readVariantScopeStructural(f.store, 'p', f.save('discovery-variant-scope', changed)));
  for (const field of Object.keys(f.scopeValue)) invalid(() => decodeVariantScope(without(f.scopeValue, field)));
  for (const changed of [{ ...f.handoffValue, choice: f.ground }, { ...f.handoffValue, frame: f.ground },
    { ...f.handoffValue, plan: f.ground }, { ...f.handoffValue, result: f.none }, { ...f.handoffValue, decision: f.model }])
    invalid(() => readVariantHandoffStructural(f.store, 'p', f.save('discovery-variant-handoff', changed)));
  for (const changed of [{ ...f.handoffValue, next: 'dossier' }, { ...f.handoffValue, scope: null },
    { ...variants[2], decision: rejection }, { ...variants[3], stop: null }, { ...variants[3], reason: 'no_go' },
    { ...f.handoffValue, contract: 'discovery-variant-handoff/v2' }]) invalid(() => decodeVariantHandoff(changed));
});

test('DR4-M decision/state/scope/handoff service refs are all enumerated and fsck reports missing authority structurally', t => {
  const f = fixture(t), previous = f.owner, expectedSelection = f.ground;
  const owner = { ...f.ownerValue, operation: 'revise' as const, previous, expectedSelection };
  const model = { ...f.modelValue, expectedSelection };
  const state: VariantState = { contract: VARIANT_STATE_CONTRACT, projectId: 'p', draft: f.draft, mode: f.mode,
    result: f.set, set: f.set, decision: f.owner, previous: f.ground };
  const fields = (kind: string, value: unknown) => referenceSites(kind, value).map(x => x.field).sort();
  assert.deepEqual(fields('discovery-variant-owner-decision', owner),
    ['draft', 'set', 'mode', 'expectedSelection', 'previous', 'outcome.member', 'authority.grant', 'authority.session'].sort());
  assert.deepEqual(fields('discovery-variant-model-decision', model),
    ['draft', 'set', 'mode', 'expectedSelection', 'outcome.member', 'origin.intent', 'origin.call', 'origin.response'].sort());
  assert.deepEqual(fields('discovery-variant-state', state), ['draft', 'mode', 'result', 'set', 'decision', 'previous'].sort());
  assert.deepEqual(fields('discovery-variant-scope', f.scopeValue), ['draft', 'set', 'member', 'decision', 'mode'].sort());
  assert.deepEqual(fields('discovery-variant-handoff', f.handoffValue),
    ['draft', 'frame', 'plan', 'snapshot', 'result', 'set', 'decision', 'scope', 'choice'].sort());
  assert.deepEqual(fields('discovery-variant-handoff', { ...f.handoffValue, stop: { code: 'limit', message: 'Limit', grounds: [f.ground] } }),
    ['draft', 'frame', 'plan', 'snapshot', 'result', 'set', 'decision', 'scope', 'choice', 'stop.grounds[0]'].sort());
  f.save('discovery-variant-handoff', f.handoffValue);
  assert.deepEqual(checkStoreIntegrity(f.store).findings, []);
  const missing = { id: 'not-an-owner-session', revision: 1, hash: 'a'.repeat(64) };
  const broken = f.save('discovery-variant-owner-decision', { ...owner, authority: { ...f.authority, session: missing } });
  assert.deepEqual(checkStoreIntegrity(f.store).findings.map(x => [x.code, x.id, x.field]),
    [['reference_missing', broken.id, 'authority.session']]);
  // Even a well-shaped record is returned only as structural; O will prove real saved authority.
  assert.equal(readVariantDecisionStructural(f.store, 'p', broken).verification, 'structural');
});
