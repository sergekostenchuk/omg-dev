import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import { readProjectMode } from '../src/product/project-mode.js';
import { ConditionChoiceSessions, FinalAcceptanceSessions, acceptDiscoveryFinal, issueConditionChoiceInvitation,
  issueFinalAcceptanceInvitation, requireConditionChoiceAuthority, resolveDiscoveryCondition } from '../src/product/owner-authority.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { discoveryConditionOutput } from '../src/product/engine.js';
import { CONDITION_CHOICE_ACTION, CONDITION_RESOLUTION_KIND, MANIFEST_SUCCESSOR_KIND, conditionResolutionId, conditionResolutionWrites,
  manifestSuccessorId,
  readAcceptedDiscoveryManifestAt, type AcceptedDiscovery } from '../src/discovery/discovery-acceptance.js';
import { DISCOVERY_MANIFEST_KIND, discoveryManifestId } from '../src/discovery/discovery-manifest.js';
import { V8_FINAL_CONTRACT } from '../src/discovery/v7-final-contracts.js';
import type { OmResult } from '../src/om/refusal.js';
import { modeOf } from './discovery-v7-dossier-seed.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

// DR7 7b.3 (codex-omg2 №16299): an accepting owner choice of a condition proven to be of class choice resolves it in a
// new immutable edition of the accepted manifest; boundary, risk, legacy and declining acts resolve nothing. All over a
// real paid v8 conditional D7 with two choice conditions, a boundary, a risk and an open evidence condition, its real
// supported assessment and the owner's acceptance.
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
async function quiet<T>(f: World, store: Store, action: () => Promise<T>): Promise<T> {
  const calls = money(store), sent = canonical(f.wires() as never);
  const value = await storeUnchanged(store, action);
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
  return value;
}
async function refused(f: World, store: Store, action: () => Promise<unknown>, code?: string) {
  const calls = money(store), sent = canonical(f.wires() as never);
  await storeRefused(store, action, error => error instanceof EngineError && (!code || error.code === code));
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), sent);
}
/** Exact revisions of the genuine Store answered differently while the action runs; its proof cache stays in use. */
async function masked<T>(store: Store, rows: { id: string; revision: number; value: unknown }[], action: () => Promise<T>): Promise<T> {
  const get = Store.prototype.get;
  Store.prototype.get = function (this: Store, id: string, revision?: number) {
    const found = this === store ? rows.find(row => row.id === id && (revision === undefined || row.revision === revision)) : undefined;
    return found ? found.value : get.call(this, id, revision);
  } as typeof get;
  try { return await action(); } finally { Store.prototype.get = get; }
}
/** The owner accepts the exact assessed bundle in the current mode: by the owner act in questions, by the machine in bypass. */
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
const choice = (edition: AcceptedDiscovery, conditionId: string, optionId: string) =>
  ({ projectId: 'p', manifest: reference(edition.manifest), conditionId, optionId, reason: 'The owner chooses' });
/** The owner's scoped authority for exactly this choice on this edition. */
async function chooser(store: Store, edition: AcceptedDiscovery, conditionId: string, optionId: string) {
  const request = choice(edition, conditionId, optionId);
  const sessions = new ConditionChoiceSessions(store);
  const scope = { projectId: 'p', predecessor: request.manifest, bundle: edition.manifest.value.bundle, conditionId, optionId, reason: request.reason };
  const login = ok(sessions.exchange({ projectId: 'p', invitation: ok(await issueConditionChoiceInvitation(store, scope)).invitation }));
  return { request, authority: sessions.authority(login.bearer)! };
}
async function resolve(store: Store, edition: AcceptedDiscovery, conditionId: string, optionId: string) {
  const o = await chooser(store, edition, conditionId, optionId);
  return { ...o, outcome: await resolveDiscoveryCondition(store, o.request, o.authority) };
}

// The first test pays the first real construction of the classed seed; its own body stays small.
test('7b.3 choice editions: the accepted classed bundle starts with every condition open; evidence is still refused', async t => {
  const f = await world(t), first = await accepted(f);
  assert.deepEqual(first.conditions, { resolved: [], open: IDS }); assert.deepEqual(first.resolutions, []);
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, choice(first, 'evidence-1', 'pick1-yes')), 'discovery_condition_evidence_unproven');
});

test('7b.3 choice editions: two accepting choices publish two proven editions; the accepted bodies and earlier editions stay', async t => {
  const f = await world(t), first = await accepted(f), from = f.store.lastEvent();
  const one = (await resolve(f.store, first, 'pick1', 'pick1-yes')).outcome, e1 = one.edition!;
  assert.equal(one.resolved, true); assert.equal(one.unproven, null); assert.equal(one.route, null);
  assert.equal(one.resolution.value.contract, 'discovery-condition-resolution/v2');
  assert.deepEqual(f.store.eventsPage(from, f.store.lastEvent(), 1000).map(event => event.id).filter(id => !id.startsWith('owner-')).sort(),
    [conditionResolutionId('p', first.manifest.value.bundle, 'pick1'), e1.manifest.id, manifestSuccessorId(reference(first.manifest))].sort(),
    'the resolution, the edition and the successor are one write');
  assert.deepEqual(e1.manifest.value.previous, reference(first.manifest));
  assert.deepEqual(e1.manifest.value.resolutions, [reference(one.resolution)]);
  for (const key of ['draft', 'bundle', 'assessment', 'admission'] as const) assert.deepEqual(e1.manifest.value[key], first.manifest.value[key]);
  assert.deepEqual(e1.bundle, first.bundle); assert.equal(e1.bundle.value.bundle.verdict.outcome, 'conditional');
  assert.deepEqual(e1.conditions, { resolved: ['pick1'], open: IDS.filter(id => id !== 'pick1') });
  const output = discoveryConditionOutput(one);
  assert.deepEqual(output.conditionStatus, e1.conditions); assert.equal(output.resolved, true);
  assert.deepEqual(output.edition!.manifest, reference(e1.manifest));
  // A repeat is the proven winner, free; the next choice is made on the new exact edition.
  const again = await quiet(f, f.store, () => resolveDiscoveryCondition(f.store, choice(first, 'pick1', 'pick1-yes')));
  assert.equal(again.repeated, true); assert.deepEqual(again.edition, e1);
  const e2 = (await resolve(f.store, e1, 'pick2', 'pick2-yes')).outcome.edition!;
  assert.deepEqual(e2.manifest.value.previous, reference(e1.manifest)); assert.equal(e2.resolutions.length, 2);
  assert.deepEqual(e2.conditions, { resolved: ['pick1', 'pick2'], open: ['evidence-1', 'scope', 'debt'] });
  // Late heads never move the history; a cold Store reads the same; an answer is a copy.
  const cold = f.open();
  for (const edition of [first, e1, e2])
    assert.deepEqual(await quiet(f, cold, () => readAcceptedDiscoveryManifestAt(cold, 'p', reference(edition.manifest))), edition);
  const read = await readAcceptedDiscoveryManifestAt(f.store, 'p', reference(e2.manifest));
  read.conditions.open.length = 0; (read.resolutions[0]!.value as any).conditionId = 'mutated';
  assert.deepEqual(await readAcceptedDiscoveryManifestAt(f.store, 'p', reference(e2.manifest)), e2);
});

test('7b.3 choice editions: a decline, a boundary and a risk are saved acts that resolve nothing and publish no edition', async t => {
  const f = await world(t), first = await accepted(f);
  const decline = (await resolve(f.store, first, 'pick1', 'pick1-no')).outcome;
  assert.equal(decline.choice, 'decline'); assert.equal(decline.resolved, false); assert.equal(decline.unproven, null); assert.equal(decline.route, null);
  for (const [id, reason] of [['scope', 'condition_class_boundary'], ['debt', 'condition_class_risk']] as const) {
    const act = (await resolve(f.store, first, id, `${id}-yes`)).outcome;
    assert.equal(act.resolution.value.contract, 'discovery-condition-resolution/v1'); assert.equal(act.edition, null);
    assert.equal(act.resolved, false); assert.equal(act.unproven, reason);
    assert.deepEqual(act.route, { target: 'D7', predecessor: reference(first.manifest), bundle: first.manifest.value.bundle,
      paid: f.paidD7, assessment: f.paidResult, conditionId: id, optionId: `${id}-yes` });
    assert.deepEqual(act.conditions, { resolved: [], open: IDS });
  }
  assert.equal(f.store.list(MANIFEST_SUCCESSOR_KIND).length, 0); assert.equal(f.store.list(DISCOVERY_MANIFEST_KIND).length, 1);
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, choice(first, 'pick1', 'pick1-yes')), 'discovery_condition_resolution_conflict');
  // The other choice still resolves on the same edition: none of these acts was its successor.
  assert.equal((await resolve(f.store, first, 'pick2', 'pick2-yes')).outcome.resolved, true);
});

test('7b.3 choice editions in bypass: the machine admission does not replace the owner choice, which still resolves', async t => {
  const f = await world(t);
  modeOf(f.store, 'bypass');
  const first = await accepted(f);
  assert.equal(first.admission.kind, 'machine');
  await refused(f, f.store, () => resolveDiscoveryCondition(f.store, choice(first, 'pick1', 'pick1-yes')), 'owner_authority_invalid');
  const edition = (await resolve(f.store, first, 'pick1', 'pick1-yes')).outcome.edition!;
  assert.equal(edition.admission.kind, 'machine'); assert.deepEqual(edition.conditions.resolved, ['pick1']);
});

/** An edition over a predecessor naming one more resolution Ref, with its successor record, under recomputed identities. */
function planted(predecessor: AcceptedDiscovery, resolution: Ref) {
  const value = structuredClone(predecessor.manifest.value) as any;
  value.previous = reference(predecessor.manifest); value.resolutions = [...value.resolutions, resolution];
  const ref = { id: discoveryManifestId(value), revision: 1, hash: hashJson(value as Json) };
  const successor = { contract: 'discovery-manifest-successor/v1', projectId: 'p', predecessor: value.previous, successor: ref, resolution };
  const row = (id: string, kind: string, body: unknown) => ({ id, revision: 1, value: { id, revision: 1, kind, hash: hashJson(body as Json), value: body } });
  return { ref, rows: [row(ref.id, DISCOVERY_MANIFEST_KIND, value), row(manifestSuccessorId(value.previous), MANIFEST_SUCCESSOR_KIND, successor)] };
}

test('7b.3 choice editions refused: an act as resolution, a moved or malformed resolution or successor, a lost ground', async t => {
  const f = await world(t), first = await accepted(f);
  const declined = (await resolve(f.store, first, 'pick2', 'pick2-no')).outcome.resolution;
  const one = (await resolve(f.store, first, 'pick1', 'pick1-yes')).outcome, e1 = one.edition!, resolution = one.resolution;
  const read = (rows: { id: string; revision: number; value: unknown }[], ref: Ref) =>
    () => masked(f.store, rows, () => readAcceptedDiscoveryManifestAt(f.store, 'p', ref));
  // A planted edition naming a real owner act (the decline) as its resolution, with a consistent successor.
  const act = planted(e1, reference(declined));
  await refused(f, f.store, read(act.rows, act.ref));
  // ACCEPTANCE-EXACT-REF-01: the edition names revision 2 of its resolution, answered with the saved row.
  const moved = { ...reference(resolution), revision: 2 }, shifted = planted(first, moved);
  await refused(f, f.store, read([...shifted.rows, { id: moved.id, revision: 2, value: resolution }], shifted.ref), 'discovery_acceptance_invalid');
  // CONDITION-SAVED-SHAPE-01: the resolution or the successor of the real edition with a value that is no record.
  for (const id of [resolution.id, manifestSuccessorId(reference(first.manifest))])
    for (const value of [null, 'x', []])
      await refused(f, f.store, read([{ id, revision: 1, value: { id, revision: 1, kind: f.store.get(id, 1)!.kind,
        hash: hashJson(value as Json), value } }], reference(e1.manifest)), 'discovery_acceptance_invalid');
  // The successor naming another edition; the class rewritten in the resolution; lost resolution, successor, predecessor.
  const successor = f.store.get<any>(manifestSuccessorId(reference(first.manifest)), 1)!;
  const other = structuredClone(successor.value); other.successor = reference(first.manifest);
  await refused(f, f.store, read([{ id: successor.id, revision: 1, value: { ...successor, value: other, hash: hashJson(other as Json) } }],
    reference(e1.manifest)), 'discovery_acceptance_invalid');
  const rewritten = structuredClone(resolution) as any; rewritten.value.class = 'boundary'; rewritten.hash = hashJson(rewritten.value as Json);
  await refused(f, f.store, read([{ id: resolution.id, revision: 1, value: rewritten }], reference(e1.manifest)), 'discovery_acceptance_invalid');
  for (const lost of [reference(resolution), { id: successor.id, revision: 1 }, reference(first.manifest)])
    await refused(f, f.store, read([{ id: lost.id, revision: lost.revision, value: null }], reference(e1.manifest)));
  // The lost paid answer of the class basis: the paid assessment of the grounds is gone.
  await refused(f, f.store, read([{ id: f.paidResult.id, revision: f.paidResult.revision, value: null }], reference(e1.manifest)));
  assert.equal(f.store.list(CONDITION_RESOLUTION_KIND).length, 2);
});

/** The whole product history — heads, revisions, events — unchanged by an action, with the calls, the ledger and the wire. */
function history(store: Store): string {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    const digest = createHash('sha256');
    for (const query of ['SELECT * FROM heads ORDER BY entity_id', 'SELECT * FROM revisions ORDER BY entity_id,revision',
      'SELECT * FROM events ORDER BY sequence']) {
      digest.update(query);
      for (const row of db.prepare(query).iterate()) for (const [key, value] of Object.entries(row)) {
        const text = String(value);
        digest.update(key).update(typeof value).update(`${Buffer.byteLength(text)}:`).update(text);
      }
    }
    return digest.digest('hex');
  } finally { db.close(); }
}

test('7b.3 choice editions history: an accepting v1 act of a proven choice saved before editions repeats as that act, hot and cold', async t => {
  const f = await world(t), first = await accepted(f);
  // CHOICE-EDITIONS-HISTORY-01: the act exactly as the accepted CONDITION-CLASS producer (bdb0e864) saved it on this
  // paid v8 bundle — the real scoped owner authority exercised twice, the v1 form, its one write under the same guards.
  const o = await chooser(f.store, first, 'pick1', 'pick1-yes');
  const scope = { projectId: 'p', predecessor: reference(first.manifest), bundle: first.manifest.value.bundle, conditionId: 'pick1',
    optionId: 'pick1-yes', reason: o.request.reason };
  ok(requireConditionChoiceAuthority(o.authority, { store: f.store, action: CONDITION_CHOICE_ACTION, scope }));
  const applied = ok(requireConditionChoiceAuthority(o.authority, { store: f.store, action: CONDITION_CHOICE_ACTION, scope }));
  const option = (CONDITIONS[1] as ReturnType<typeof owner>).options[0]!;
  const act = { contract: 'discovery-condition-resolution/v1' as const, database: f.store.databaseId, projectId: 'p', predecessor: scope.predecessor,
    bundle: scope.bundle, conditionId: 'pick1', kind: 'owner_choice' as const, option, scope,
    authority: { grant: applied.grant, session: applied.session }, at: applied.at };
  f.store.writeMany(conditionResolutionWrites('p', first, act).writes, uniqueTransactionGuards([reference(f.store.get('project:p')!),
    applied.session, { id: manifestSuccessorId(scope.predecessor), absent: true }]));
  // The repeat through the producer is that historical act: it resolves nothing, publishes nothing and pays nothing.
  for (const store of [f.store, f.open()]) {
    const before = history(store);
    const repeated = await quiet(f, store, () => resolveDiscoveryCondition(store, o.request));
    assert.equal(history(store), before);
    assert.equal(repeated.repeated, true); assert.equal(repeated.choice, 'accept'); assert.equal(repeated.resolved, false);
    assert.equal(repeated.edition, null); assert.equal(repeated.unproven, 'condition_class_unproven');
    assert.equal(repeated.resolution.value.contract, 'discovery-condition-resolution/v1');
    assert.deepEqual(repeated.route, { target: 'D7', predecessor: reference(first.manifest), bundle: first.manifest.value.bundle,
      paid: f.paidD7, assessment: f.paidResult, conditionId: 'pick1', optionId: 'pick1-yes' });
    assert.deepEqual(repeated.conditions, { resolved: [], open: IDS });
  }
  assert.equal(f.store.list(MANIFEST_SUCCESSOR_KIND).length, 0); assert.equal(f.store.list(DISCOVERY_MANIFEST_KIND).length, 1);
});

test('7b.3 choice editions legacy: an accepting choice of a discovery-final/v7 owner condition is an act with condition_class_unproven', async t => {
  const legacy = CONDITIONS.map(({ class: _class, classReason: _reason, ...condition }: any) => condition);
  // The machine admission of bypass keeps this test inside its time; the owner still chooses on the edition.
  const f = await finalAssessmentPaid(t, { outcome: 'conditional', conditions: legacy });
  modeOf(f.store, 'bypass');
  const first = await accepted(f);
  const act = (await resolve(f.store, first, 'pick1', 'pick1-yes')).outcome;
  assert.equal(act.resolution.value.contract, 'discovery-condition-resolution/v1'); assert.equal(act.resolved, false);
  assert.equal(act.unproven, 'condition_class_unproven'); assert.equal(act.edition, null);
  assert.equal(f.store.list(MANIFEST_SUCCESSOR_KIND).length, 0);
  // A planted edition declaring this legacy act a resolution is refused.
  const plant = planted(first, reference(act.resolution));
  await refused(f, f.store, () => masked(f.store, plant.rows, () => readAcceptedDiscoveryManifestAt(f.store, 'p', plant.ref)));
});
