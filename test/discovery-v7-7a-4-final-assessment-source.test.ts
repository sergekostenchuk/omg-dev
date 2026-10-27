import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { DISCOVERY_FINAL_ASSESSMENT_SOURCE, readDiscoveryFinalAssessmentSourceAt } from '../src/discovery/discovery-final-assessment-source.js';
import { prepareDiscoveryFinalSession } from '../src/discovery/discovery-final-session.js';
import { finalPaid, FINAL_SEED_BRIEF, type FinalOutcome } from './discovery-v7-final-paid-seed.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

// DR7 7a.4 (codex-omg2 №16021 п.1): the read-only source of the D7 assessment over real paid D7 results of the shared
// seed — owner, model and partial routes, all four outcomes. The source never writes, calls or pays.
const money = (store: Store) => canonical(store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind))
  .flatMap(row => store.history(row.id)) as never);
type Paid = Awaited<ReturnType<typeof finalPaid>>;
/** A no-write window on the genuine Store, with the model calls, the ledger and the wire compared as well. */
async function quiet<T>(f: Paid, store: Store, action: () => Promise<T>): Promise<T> {
  const calls = money(store), wires = canonical(f.wires() as never);
  const value = await storeUnchanged(store, action);
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), wires);
  return value;
}
async function refused(f: Paid, store: Store, action: () => Promise<unknown>, code = 'discovery_final_assessment_source_invalid') {
  const calls = money(store), wires = canonical(f.wires() as never);
  await storeRefused(store, action, error => error instanceof EngineError && (code === '*' || error.code === code));
  assert.equal(money(store), calls); assert.equal(canonical(f.wires() as never), wires);
}
/** A read overlay that answers one exact revision differently; the genuine Store stays the observed one. */
function mask(store: Store, ref: Ref, value: unknown = null): Store {
  const get = store.get.bind(store), bound = new Map<PropertyKey, unknown>();
  const masked = <T>(id: string, revision?: number) => id === ref.id && (revision === undefined || revision === ref.revision)
    ? value as Revision<T> | null : get<T>(id, revision);
  return new Proxy(store, { get(target, key) {
    if (key === 'get') return masked;
    if (!bound.has(key)) { const value = Reflect.get(target, key); bound.set(key, typeof value === 'function' ? value.bind(target) : value); }
    return bound.get(key);
  } });
}
function assertSource(f: Paid, source: Awaited<ReturnType<typeof readDiscoveryFinalAssessmentSourceAt>>, outcome: FinalOutcome) {
  const paid = f.result.value;
  assert.equal(source.contract, DISCOVERY_FINAL_ASSESSMENT_SOURCE); assert.equal(source.projectId, 'p');
  assert.deepEqual(source.paid, f.result, 'the exact paid D7 result');
  assert.deepEqual(reference(source.terminal), f.execution, 'the terminal execution is the proven applied after');
  assert.deepEqual(source.application.value.after, f.execution);
  assert.deepEqual(source.grounds, { session: paid.session, application: paid.application, call: paid.call,
    request: paid.request, response: paid.response });
  assert.notDeepEqual(source.grounds.session, f.execution, 'the paid session is the address of its application cursor, not the terminal');
  assert.deepEqual(reference(source.prepared), f.prepared);
  assert.deepEqual(source.bundle, paid.projection.result.bundle); assert.equal(source.bundle.verdict.outcome, outcome);
  if (outcome === 'no_go' || outcome === 'insufficient_evidence') {
    assert.equal(source.bundle.projection, null); assert.equal(source.bundle.constitution, null);
  } else assert.ok(source.bundle.projection && source.bundle.constitution);
  if (outcome === 'conditional') assert.ok(source.bundle.verdict.conditions.length > 0);
  assert.deepEqual(source.packet.candidate, source.bundle); assert.deepEqual(source.packet.subject.candidate, source.bundle);
  assert.deepEqual(source.packet.subject.subject, paid.subject, 'the whole D7 subject');
  assert.deepEqual(source.packet.final.dossier, paid.projection.packet.dossier, 'the whole paid D6 dossier, with both sides of every contradiction');
  assert.ok(source.packet.final.dossier.contradictions.every(row => row.sides.length === 2));
  assert.deepEqual(reference(source.packet.final.assessment), f.d6, 'the exact paid D6');
  assert.equal(source.packet.final.brief.text, FINAL_SEED_BRIEF, 'the verbatim assignment');
  for (const key of ['assessed', 'accepted', 'verdict', 'supported'])
    assert.equal(Object.hasOwn(source, key), false, `the source carries no ${key}`);
}

for (const outcome of ['go', 'conditional', 'no_go', 'insufficient_evidence'] as const)
test(`7a.4 source owner ${outcome}: the paid outcome is its own exact source, read without writes`, async t => {
  const f = await finalPaid(t, outcome);
  const source = await quiet(f, f.store, () => readDiscoveryFinalAssessmentSourceAt(f.store, 'p', f.paidResult));
  assertSource(f, source, outcome);
});

test('7a.4 source routes: model-selected and nonempty partial paid results keep their real origins', async t => {
  const model = await finalPaid(t, 'conditional', 'model');
  assertSource(model, await quiet(model, model.store, () => readDiscoveryFinalAssessmentSourceAt(model.store, 'p', model.paidResult)), 'conditional');
  const partial = await finalPaid(t, 'insufficient_evidence', 'partial');
  const source = await quiet(partial, partial.store, () => readDiscoveryFinalAssessmentSourceAt(partial.store, 'p', partial.paidResult));
  assertSource(partial, source, 'insufficient_evidence');
  assert.equal(source.packet.final.dossier.manifest.value.completeness, 'partial');
  assert.ok(source.packet.final.dossier.materials.length > 0 && source.packet.final.dossier.manifest.value.reasons.length > 0);
  assert.equal(source.packet.final.assessment.value.result.result.verdict, 'return', 'the paid D6 return is kept');
});

test('7a.4 source cold: late heads never move the historical source, a cold Store reads the same, and the answer is a copy', async t => {
  const f = await finalPaid(t, 'go');
  const source = await readDiscoveryFinalAssessmentSourceAt(f.store, 'p', f.paidResult), kept = structuredClone(source);
  // Later heads over the same subject: another prepared final session with its own archive.
  const input = structuredClone((await f.read()).prepared.value.input);
  await prepareDiscoveryFinalSession(f.store, 'p', f.packet.subject, { ...input, prompt: `${input.prompt} — a later preparation` });
  assert.deepEqual(await quiet(f, f.store, () => readDiscoveryFinalAssessmentSourceAt(f.store, 'p', f.paidResult)), kept);
  const cold = f.open();
  assert.deepEqual(await quiet(f, cold, () => readDiscoveryFinalAssessmentSourceAt(cold, 'p', f.paidResult)), kept);
  source.bundle.verdict.reason = 'mutated'; (source.packet.final.brief as any).text = 'mutated'; (source.paid.value as any).projectId = 'x';
  assert.deepEqual(await readDiscoveryFinalAssessmentSourceAt(f.store, 'p', f.paidResult), kept, 'a mutated answer never reaches a later read');
});

test('7a.4 source refusals: foreign, absent, rehashed or reshaped grounds and another bundle of the same D6 refuse without writes', async t => {
  const f = await finalPaid(t, 'go'), other = await finalPaid(t, 'no_go');
  const ref = f.paidResult, row = f.result;
  // Caller forms: one snapshot of an exact Ref, nothing else.
  for (const at of [null, {}, { ...ref, extra: 1 }, { ...ref, hash: '0'.repeat(64) }, { ...ref, revision: 2 }, { ...ref, id: `${ref.id}x` }, other.paidResult])
    await refused(f, f.store, () => readDiscoveryFinalAssessmentSourceAt(f.store, 'p', at));
  await refused(f, f.store, () => readDiscoveryFinalAssessmentSourceAt(f.store, 'other', ref));
  let reads = 0;
  const shifting = { id: ref.id, revision: ref.revision, get hash() { reads++; return reads === 1 ? ref.hash : '0'.repeat(64); } };
  await quiet(f, f.store, () => readDiscoveryFinalAssessmentSourceAt(f.store, 'p', shifting));
  assert.equal(reads, 1, 'the caller Ref is read once');
  // Another bundle of the same paid D6 under a rehashed paid result, and a recomputed identity, are never this result.
  const otherBundle = structuredClone(row.value) as any;
  otherBundle.projection.result.bundle = structuredClone(other.result.value.projection.result.bundle);
  otherBundle.projection.result.bundle.dossier = row.value.projection.result.bundle.dossier;
  const rehashed = { ...ref, hash: hashJson(otherBundle as Json) };
  await refused(f, f.store, () => readDiscoveryFinalAssessmentSourceAt(mask(f.store, rehashed, { ...row, value: otherBundle, hash: rehashed.hash }), 'p', rehashed), '*');
  // The terminal cursor in place of the application cursor, with the identity recomputed over it.
  const terminalAsSession = structuredClone(row.value) as any; terminalAsSession.session = f.execution;
  const recomputed = { ...ref, hash: hashJson(terminalAsSession as Json) };
  await refused(f, f.store, () => readDiscoveryFinalAssessmentSourceAt(mask(f.store, recomputed, { ...row, value: terminalAsSession, hash: recomputed.hash }), 'p', recomputed), '*');
  // Absent grounds: the application, its applied revision, the terminal cursor, the paid D6 and the brief source.
  const application = row.value.application, applied = { ...application, revision: 2 } as Ref;
  for (const absent of [ref, application, applied, f.execution, f.d6, f.packet.subject.basis.brief.source])
    await refused(f, f.store, () => readDiscoveryFinalAssessmentSourceAt(mask(f.store, absent), 'p', ref), '*');
  // PAID-SOURCE-SHAPE-01: an application or its applied revision whose value is no record, under a consistent hash (the
  // paid result re-pointed and rehashed for the first), is the source's own typed refusal — never a TypeError.
  const first = f.store.get<any>(application.id, 1)!, second = f.store.get<any>(application.id, 2)!;
  for (const variant of ['application', 'applied'] as const) {
    const broken = { ...(variant === 'application' ? first : second), value: null, hash: hashJson(null) };
    const paid = structuredClone(row) as any;
    if (variant === 'application') { paid.value.application = reference(broken); paid.hash = hashJson(paid.value as Json); }
    await refused(f, f.store, () => readDiscoveryFinalAssessmentSourceAt(overlay(f.store, [broken, paid]), 'p', reference(paid)));
  }
});
/** A read overlay over several exact revisions at once. */
function overlay(store: Store, rows: { id: string; revision: number }[]): Store {
  const get = store.get.bind(store), bound = new Map<PropertyKey, unknown>();
  return new Proxy(store, { get(target, key) {
    if (key === 'get') return <T>(id: string, revision?: number) =>
      (rows.find(row => row.id === id && (revision === undefined || row.revision === revision)) as Revision<T> | undefined) ?? get<T>(id, revision);
    if (!bound.has(key)) { const value = Reflect.get(target, key); bound.set(key, typeof value === 'function' ? value.bind(target) : value); }
    return bound.get(key);
  } });
}
