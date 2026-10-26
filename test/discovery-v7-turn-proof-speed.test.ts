import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashJson } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import { Store, storeReads } from '../src/storage/store.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent, readResearchConsumerExecution, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { prepareVariantSession, applyVariantSession, readVariantGeneration } from '../src/discovery/variant-session.js';
import { projectPaidVariantSession } from '../src/discovery/research-consumer-transition.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, variantRecordId, type VariantSubject, type VariantSet,
  type DiscoveryVariant, type VariantExecutionSession } from '../src/discovery/discovery-variants.js';
import { variantPublicationWrites, type VariantState } from '../src/discovery/variant-decision.js';
import { historicalTrace, pendingSnapshotView, withHistoricalReads } from '../src/history/proofs.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';

/**
 * OMG-V7-TURN-PROOF-SPEED. A turn of the managed flows meets the same published generation again and again: its set (or
 * no_variants), the execution receipt, the running intent and the paid answer it projects. On the genuine Store the exact
 * (project, Ref) generation is one historical proof — derived once, kept while everything it read is current, handed out as a
 * copy of its own; through any other source (a trace, an overlay, an evaluation view) it is derived in place as before.
 * The world is the real one of 4B.1: a real paid generation over a real saved snapshot, published by the common lifecycle.
 */

const history = (store: Store) => store.list().flatMap(row => store.history(row.id));
const judgement = { conclusion: 'Bounded by the actual sweep', grounds: [], assumptions: [], unknowns: ['No evidence beyond the saved sweep'], quantity: null };
const criteria = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, judgement]));
const scale = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, 'One shared scale from low to high']));
function generation(count: number) {
  const variants = Array.from({ length: count }, (_, i) => ({ key: `v${i + 1}`, title: `Variant ${i + 1}`, proposal: { scope: `scope-${i + 1}` }, criteria }));
  return { action: 'variants', variants, scale, comparison: `${count} bounded variants on one scale`,
    recommendation: { key: `v${count}`, reason: 'Fits the snapshot best' }, searchLimits: ['Only the saved sweep'], unknowns: [] };
}
const none = (grounds: Ref[]) => ({ action: 'no_variants', reasons: [{ code: 'snapshot_insufficient', message: 'The sweep supports no bounded variant', grounds }],
  searchLimits: ['Only the saved sweep'], unknowns: ['Demand stays unknown'] });

type Outcome = { proven: unknown } | { code: string; message: string } | { other: string };
const outcome = (read: () => unknown): Outcome => {
  try { return { proven: read() }; }
  catch (error) { return error instanceof EngineError ? { code: error.code, message: error.message } : { other: String(error) }; }
};
const refusalCode = (value: Outcome): string => {
  assert.ok('code' in value, `expected a typed refusal, got ${JSON.stringify(value).slice(0, 200)}`);
  return value.code;
};

async function build(t: TestContext) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-tps-' }), project = 'p';
  const runs = new Map<string, string>();
  const prepare = (selected = f.subject()) => {
    const context = { history: [], readings: [] };
    const draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!, question = f.store.get<Question>(f.v.plan.id)!;
    const runId = runs.get(selected.planAnswer.hash);
    const run = runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({ id: `research-run:${rand()}`, kind: 'research-run', expected: 0,
      value: { projectId: project, draftId: draft.id, environment: reference(f.environment), turns: 0, limit: 100, requestChars: 0,
        owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null, status: 'running', inputs: draft.value.inputs } });
    runs.set(selected.planAnswer.hash, run.id); const number = run.value.turns + 1;
    const input = { projectId: project, kind: 'analyst' as const, key: hashJson([run.id, number, 'analyst']), owner: reference(run), draft: reference(draft),
      question: reference(question), role: f.environment.value.implementer, dispatch: f.environment.value, profile: null,
      cursor: { run: run.id, turn: number, instruction: f.prompt, context, subject: selected }, basis: draft.value.inputs,
      guards: uniqueTransactionGuards([reference(run), reference(draft), reference(question), reference(f.environment)]) };
    const intent = prepareResearchConsumerIntent(f.store, input);
    const invoke = () => researchCall(f.environment.value.implementer, f.environment.value, f.prompt, context, undefined,
      { store: f.store, draftId: draft.id, questionId: question.id, purpose: 'analyst', consumerIntent: reference(intent), requestContract: REQUEST_MANIFEST_CONTRACT });
    return { run, number, intent, input, invoke, question, draft, selected, context };
  };
  const g = { ...f, prepare };
  for (const question of ['q-industry', 'q-market']) {
    const entry = await produce(g, undefined, question), packet = projectAttemptPacket(f.store, { project, planAnswer: f.v.planAnswer, planQuestionId: question, entries: [entry] });
    const reply = { verdict: 'supported', reasons: ['Real paid assessment'], return: null, novelty: { attempts: [{ attempt: entry.attempt, reason: 'Exact result' }],
      accepted: [], rejected: [], newContent: [], duplicates: [], noProgress: [{ attempt: entry.attempt, reason: 'No source' }], transition: null },
      methodology: { contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v1', facts: [] } };
    writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply }));
    const paid = await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
    applyDiscoveryAssessment(f.store, project, reference(paid));
  }
  const saved = produceVariantSnapshot(f.store, project).record;
  const modeRow = (n: number) => f.store.write({ id: `mode-fixture:${n}`, kind: 'mode-fixture', expected: 0, value: { projectId: project, mode: 'questions' } });
  const mode = modeRow(1);
  const cal = f.store.write({ id: 'transport-fixture:calibration', kind: 'transport-fixture', expected: 0, value: { projectId: project } });
  const calibration: VariantSubject = { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal', snapshot: reference(cal), mode: reference(mode), expectedSelection: null };
  writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: generation(1) }));
  await researchCall(f.environment.value.implementer, f.environment.value, 'Calibrate variants', { variantSubject: calibration, history: [] }, undefined,
    { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-proposal' });
  const modes = new Map<number, Ref>([[1, reference(mode)]]);
  /** The first generation expects no current selection; every later one regenerates over the current one, under its own mode row. */
  const subjectOf = (n: number): VariantSubject => {
    if (!modes.has(n)) modes.set(n, reference(modeRow(n)));
    const state = f.store.list<VariantState>('discovery-variant-state').find(row => row.value.projectId === project);
    return { ...calibration, snapshot: reference(saved), mode: modes.get(n)!, expectedSelection: n === 1 ? null : reference(state!) };
  };
  const input = (variantSubject: VariantSubject) => ({ projectId: project, variantSubject, environment: f.environment,
    role: f.environment.value.implementer, prompt: 'Propose variants from this exact saved sweep' });
  const reply = (answer: unknown) => writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: answer }));
  /** The real managed paid call, without its application: the paid answer is saved before anything is published. */
  async function pay(variantSubject: VariantSubject) {
    const prepared = prepareVariantSession(f.store, input(variantSubject)), v = prepared.intent.value;
    await researchCall(v.role, v.dispatch, v.cursor.prompt, v.cursor.context, undefined,
      { store: f.store, draftId: v.draft.id, questionId: v.question.id, purpose: v.kind, consumerIntent: reference(prepared.intent), session: v.owner });
    return f.store.get<ResearchConsumerIntent>(prepared.intent.id)!;
  }
  /** The Ref the paid answer of a running intent will publish — computed the way the historical reader recomputes it. */
  function publishes(running: { id: string; revision: number; kind: string; hash: string; value: ResearchConsumerIntent }): Ref {
    const paid = readResearchConsumerExecution(f.store, project, reference(running));
    assert.equal(paid.kind, 'response');
    if (paid.kind !== 'response') throw new Error('unreachable');
    const owner = f.store.get<VariantExecutionSession>(running.value.owner.id, running.value.owner.revision)!;
    const receiptValue = projectPaidVariantSession(owner, running, { call: reference(paid.call), response: paid.response, payload: paid.payload });
    return variantPublicationWrites(f.store, receiptValue, paid.payload, true).publication.result.ref;
  }
  /** A paid generation whose application is written around the door (as 4B1-02 does), damaged in one named way. */
  async function damaged(n: number, damage: 'a missing state' | 'a substituted state' | 'outputs without the result' | 'outputs without the receipt') {
    reply(generation(2));
    const running = await pay(subjectOf(n));
    const paid = readResearchConsumerExecution(f.store, project, reference(running));
    assert.equal(paid.kind, 'response');
    if (paid.kind !== 'response') throw new Error('unreachable');
    const owner = f.store.get<VariantExecutionSession>(running.value.owner.id, running.value.owner.revision)!;
    const receiptValue = projectPaidVariantSession(owner, running, { call: reference(paid.call), response: paid.response, payload: paid.payload });
    const product = variantPublicationWrites(f.store, receiptValue, paid.payload, true);
    const refOf = (write: { id: string; expected: number; value: unknown }) => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value as never) });
    const receiptWrite = { id: owner.id, kind: owner.kind, expected: owner.revision, value: receiptValue };
    const kept = damage === 'a missing state' ? product.writes.slice(0, -1)
      : damage === 'a substituted state' ? [...product.writes.slice(0, -1), { ...product.state, value: { ...(product.state.value as object), mode: reference(saved) } }]
      : product.writes;
    const outputs = damage === 'outputs without the result' ? [refOf(receiptWrite), ...product.writes.filter(write => write.kind !== product.publication.result.kind).map(refOf)]
      : damage === 'outputs without the receipt' ? product.writes.map(refOf)
      : [refOf(receiptWrite), ...product.writes.map(refOf)];
    f.store.writeMany([receiptWrite, ...kept, { id: running.id, kind: running.kind, expected: running.revision,
      value: { ...running.value, state: 'applied', outputs } }] as never, []);
    return product.publication.result.ref;
  }
  return { ...g, project, saved, mode, subjectOf, reply, pay, publishes, damaged };
}
type World = Awaited<ReturnType<typeof build>>;

/** A Store over a copy of the world's database with the proof cache emptied: no kept proof, in memory or saved. */
function emptyCache(f: { path: string }, t: TestContext): Store {
  const root = mkdtempSync(join(tmpdir(), 'omg-turn-proof-copy-')), path = join(root, 'state.sqlite');
  const source = new DatabaseSync(f.path, { readOnly: true });
  try { source.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`); } finally { source.close(); }
  const db = new DatabaseSync(path);
  try { db.exec('DELETE FROM proof_links; DELETE FROM proof_cache; DELETE FROM proof_nodes'); } finally { db.close(); }
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}
/** How often the records `ids` are read, by get and by history, while the action runs. */
function countReads(ids: ReadonlySet<string>, action: () => unknown): number {
  const { get, history: all } = Store.prototype;
  let reads = 0;
  Store.prototype.get = function (this: Store, id: string, revision?: number) { if (ids.has(id)) reads++; return get.call(this, id, revision); } as typeof Store.prototype.get;
  Store.prototype.history = function (this: Store, id: string) { if (ids.has(id)) reads++; return all.call(this, id); } as typeof Store.prototype.history;
  try { action(); } finally { Store.prototype.get = get; Store.prototype.history = all; }
  return reads;
}
const physical = (action: () => unknown): number => { const before = storeReads(); action(); return storeReads() - before; };
/** The reads a view receives while it is read: how many, and which ones in which order — what an opaque view must keep answering itself. */
function counting(store: Store) {
  const counts = { get: 0, list: 0, history: 0 }, log: string[] = [];
  const view = new Proxy(store, { get(target, key) {
    if (key === 'get' || key === 'list' || key === 'history') return (...args: (string | number | undefined)[]) => {
      counts[key]++; log.push(`${key}:${args.join('@')}`);
      return (target[key] as (...rest: (string | number | undefined)[]) => unknown)(...args);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { view: view as Store, counts, log };
}

/** One world serves the tests in file order: the first that needs it builds it, inside its own time, and names the time; a test
 * run alone builds it itself. Two generations are published in it — a set and no_variants. The world lives until the file ends. */
const cleanups: (() => void)[] = [];
after(() => { for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch { /* the file is ending */ } } });
type Shared = World & { set: Ref; absent: Ref; members: Ref[]; receipt: Ref; running: Ref; applied: Ref };
let shared: Promise<Shared> | undefined;
const sharedWorld = (t: TestContext): Promise<Shared> => (shared ??= (async () => {
  const started = Date.now();
  const f = await build({ after: (cleanup: () => void) => { cleanups.push(cleanup); } } as unknown as TestContext);
  f.reply(generation(2));
  const running = await f.pay(f.subjectOf(1)), receipt = applyVariantSession(f.store, f.project, reference(running));
  const set = f.store.list<VariantSet>('discovery-variant-set').find(row => row.value.projectId === f.project)!;
  f.reply(none([reference(f.saved)]));
  const second = await f.pay(f.subjectOf(2));
  applyVariantSession(f.store, f.project, reference(second));
  const [absent] = f.store.list<{ projectId: string }>('discovery-variant-none').filter(row => row.value.projectId === f.project);
  assert.ok(absent, 'the second generation published no_variants');
  t.diagnostic(`generation world built in ${Date.now() - started} ms, inside the first test that needed it`);
  return Object.assign(f, { set: reference(set), absent: reference(absent!), members: set.value.members, receipt: reference(receipt),
    running: reference(running), applied: reference(f.store.get<ResearchConsumerIntent>(running.id)!) });
})());
/** The records one generation is proven from: its running intent (read at its head), the receipt's session and the paid call. */
function chain(f: Shared, ref: Ref): ReadonlySet<string> {
  const record = f.store.get<{ origin: { intent: Ref } }>(ref.id, ref.revision)!;
  const running = f.store.get<ResearchConsumerIntent>(record.value.origin.intent.id)!;
  return new Set([running.id, running.value.owner.id, ...(running.value.call ? [running.value.call.id] : [])]);
}
const generations = (f: Shared): [string, Ref][] => [['a set', f.set], ['no_variants', f.absent]];

test('turn proof speed: a published generation is proven once — the repeat reads none of its records, and it equals the in-place derivation', async t => {
  const f = await sharedWorld(t);
  for (const [label, ref] of generations(f)) {
    const ids = chain(f, ref);
    // The in-place derivation (a transparent trace is not the genuine Store) on a Store without any kept proof.
    const inPlaceStore = emptyCache(f, t), inPlace = readVariantGeneration(historicalTrace(inPlaceStore), f.project, ref);
    assert.equal(inPlace.verification, 'proven', label);
    const perCall = physical(() => readVariantGeneration(historicalTrace(inPlaceStore), f.project, ref));
    const evidence = countReads(ids, () => readVariantGeneration(historicalTrace(inPlaceStore), f.project, ref));
    assert.ok(perCall > 100 && evidence > 0, `${label}: the in-place derivation reads its records on every call (${perCall} reads, ${evidence} records)`);
    // The genuine Store: the first read derives, the repeats read none of those records, in or out of one operation.
    const cold = emptyCache(f, t);
    let first!: ReturnType<typeof readVariantGeneration>;
    const firstReads = physical(() => { first = readVariantGeneration(cold, f.project, ref); });
    assert.deepEqual(first, inPlace, `${label}: equal to the in-place derivation`);
    assert.ok(firstReads > 100, `${label}: the first read derives (${firstReads} reads)`);
    const repeats = countReads(ids, () => {
      readVariantGeneration(cold, f.project, ref);
      withHistoricalReads(() => { readVariantGeneration(cold, f.project, ref); readVariantGeneration(cold, f.project, ref); });
    });
    assert.equal(repeats, 0, `${label}: three repeats read no record of the chain`);
    const repeatReads = physical(() => {
      for (let i = 0; i < 5; i++) assert.deepEqual(readVariantGeneration(cold, f.project, ref), inPlace);
    });
    assert.ok(repeatReads <= Math.ceil(perCall / 20), `${label}: five repeats cost ${repeatReads} reads against ${perCall} for each in-place call`);
    // The proof lives in the Store: the live Store of the world, which derived it already, repeats it for nothing too.
    readVariantGeneration(f.store, f.project, ref);
    assert.equal(countReads(ids, () => readVariantGeneration(f.store, f.project, ref)), 0, `${label}: the world's own Store`);
    t.diagnostic(`${label}: in place ${perCall} reads per call, first ${firstReads}, five repeats ${repeatReads}`);
  }
  assert.deepEqual(readVariantGeneration(f.store, f.project, f.set).publication.members.map(member => member.ref), f.members,
    'the set names the members its paid answer projects');
  assert.equal(readVariantGeneration(f.store, f.project, f.absent).publication.members.length, 0, 'no_variants has no member');
});

test('turn proof speed: every refusal of a damaged, foreign or padded input is the one it always was, and a refusal proves nothing for the next read', async t => {
  const f = await sharedWorld(t);
  const member = f.store.get<DiscoveryVariant>(f.members[0]!.id, f.members[0]!.revision)!;
  const set = f.store.get<VariantSet>(f.set.id, f.set.revision)!;
  const forge = <T extends { projectId: string }>(kind: string, value: T) =>
    reference(f.store.write({ id: variantRecordId(kind, value), kind, expected: 0, value: value as never }));
  const forgedMember = forge('discovery-variant', { ...member.value, title: 'Forged member' });
  const cases: [string, unknown, unknown][] = [
    ['another project', 'q', f.set], ['an empty project', '', f.set], ['a blank project', '   ', f.set], ['a project that is no string', 7, f.set],
    ['a Ref without hash', f.project, { id: f.set.id, revision: f.set.revision }], ['a padded Ref', f.project, { ...f.set, extra: 1 }],
    ['another hash', f.project, { ...f.set, hash: '0'.repeat(64) }], ['another revision', f.project, { ...f.set, revision: 2 }],
    ['a revision of zero', f.project, { ...f.set, revision: 0 }], ['a fractional revision', f.project, { ...f.set, revision: 1.5 }],
    ['a hash that is no hash', f.project, { ...f.set, hash: 'not-a-hash' }], ['an empty id', f.project, { ...f.set, id: '' }],
    ['an unknown id', f.project, { ...f.set, id: 'discovery-variant-set:unknown' }], ['a member, not a result', f.project, f.members[0]],
    ['the receipt', f.project, f.receipt], ['the running intent', f.project, f.running], ['nothing', f.project, null],
    ['another recommendation', f.project, forge('discovery-variant-set', { ...set.value, recommendation: { member: f.members[0], reason: 'Forged' } })],
    ['a forged member', f.project, forge('discovery-variant-set', { ...set.value, members: [forgedMember, f.members[1]!] })],
    ['another origin', f.project, forge('discovery-variant-set', { ...set.value, origin: { ...set.value.origin, call: f.receipt } })],
  ];
  const before = history(f.store);
  for (const [label, project, ref] of cases) {
    const genuine = outcome(() => readVariantGeneration(f.store, project as string, ref as Ref));
    const inPlace = outcome(() => readVariantGeneration(historicalTrace(f.store), project as string, ref as Ref));
    assert.deepEqual(genuine, inPlace, `${label}: the genuine Store refuses as the in-place derivation does`);
    const code = refusalCode(genuine);
    assert.notEqual(code, 'input_request_invalid', `${label}: no refusal of the common mechanism`);
    assert.match(code, /^discovery_variant_|^research_|^variant_/, `${label}: ${code}`);
    // Once more, hot: a refusal is never kept, and the next read of the same input refuses again the same way.
    assert.deepEqual(outcome(() => readVariantGeneration(f.store, project as string, ref as Ref)), genuine, `${label}: repeated`);
  }
  assert.deepEqual(history(f.store), before, 'reading writes nothing');
  // A Store that cannot see the session of the receipt proves nothing, while the Store that can still proves it.
  const hidden = emptyCache(f, t), realGet = hidden.get.bind(hidden);
  hidden.get = ((id: string, revision?: number) => id === f.receipt.id ? null : realGet(id, revision)) as typeof hidden.get;
  assert.ok('code' in outcome(() => readVariantGeneration(hidden, f.project, f.set)), 'the session of the receipt is hidden');
  for (const [label, ref] of generations(f)) assert.equal(readVariantGeneration(f.store, f.project, ref).verification, 'proven', label);
});

test('turn proof speed: only the plain closed Ref keys a kept proof — every other form derives in place and meets the old answer, cold and warm', async t => {
  const f = await sharedWorld(t);
  // [form, whether the old closed-form check refuses it]: the two the review named first, then the other forms the gate must not admit.
  const forms = (ref: Ref): [string, unknown, boolean][] => [
    ['an array carrying the three fields', Object.assign([], ref), true],
    ['an inheritor with three foreign own keys', Object.assign(Object.create(ref), { a: 1, b: 2, c: 3 }), true],
    ['a field that is not enumerable', Object.defineProperty({ id: ref.id, revision: ref.revision }, 'hash', { value: ref.hash }), true],
    ['enumerable accessors', Object.defineProperties({}, { id: { get: () => ref.id, enumerable: true }, revision: { get: () => ref.revision, enumerable: true },
      hash: { get: () => ref.hash, enumerable: true } }), false],
    ['a Proxy over the Ref', new Proxy({ ...ref }, {}), false],
    ['a symbol beside the fields', Object.assign({ ...ref }, { [Symbol('beside')]: 1 }), false],
    ['no prototype', Object.assign(Object.create(null), ref), false],
    ['a class instance', Object.assign(new (class Pointer {})(), ref), false],
  ];
  for (const [label, legit] of generations(f)) {
    const ids = chain(f, legit), cold = emptyCache(f, t);
    const meetsOld = (phase: string) => {
      for (const [form, bad, refuses] of forms(legit)) {
        const genuine = outcome(() => readVariantGeneration(cold, f.project, bad as Ref));
        const inPlace = outcome(() => readVariantGeneration(historicalTrace(cold), f.project, bad as Ref));
        assert.deepEqual(genuine, inPlace, `${label}, ${form}, ${phase}: the genuine Store answers as the in-place derivation does`);
        if (refuses) assert.equal(refusalCode(genuine), 'discovery_variant_invalid', `${label}, ${form}, ${phase}: refused as the closed form always was`);
      }
    };
    meetsOld('cold');
    // None of them left a proof of the legitimate Ref behind: the genuine Store, asked with the plain Ref, still reads the chain.
    assert.ok(countReads(ids, () => assert.equal(readVariantGeneration(cold, f.project, legit).verification, 'proven')) > 0, `${label}: the forms kept no proof`);
    meetsOld('warm');
    assert.equal(countReads(ids, () => readVariantGeneration(cold, f.project, legit)), 0, `${label}: the plain Ref keeps repeating for nothing beside them`);
  }
});

test('turn proof speed: a damaged application proves no generation — the same refusal as in place, hot and cold, and nothing is kept from it', async t => {
  const f = await sharedWorld(t);
  const before = history(f.store);
  let n = 10;
  for (const damage of ['a missing state', 'a substituted state', 'outputs without the result', 'outputs without the receipt'] as const) {
    const ref = await f.damaged(n++, damage), written = history(f.store);
    const inPlace = outcome(() => readVariantGeneration(historicalTrace(f.store), f.project, ref));
    refusalCode(inPlace);
    for (const store of [f.store, emptyCache(f, t)]) {
      const genuine = outcome(() => readVariantGeneration(store, f.project, ref));
      assert.deepEqual(genuine, inPlace, `${damage}: the genuine Store refuses as the in-place derivation does`);
      assert.deepEqual(outcome(() => readVariantGeneration(store, f.project, ref)), inPlace, `${damage}: and again`);
    }
    assert.deepEqual(history(f.store), written, `${damage}: reading writes nothing`);
  }
  assert.ok(history(f.store).length > before.length);
  for (const [label, ref] of generations(f)) assert.equal(readVariantGeneration(f.store, f.project, ref).verification, 'proven', label);
});

test('turn proof speed: a trace, an overlay and an opaque view keep reading through themselves — they neither use nor leave a kept proof', async t => {
  const f = await sharedWorld(t);
  for (const [label, ref] of generations(f)) {
    const expected = readVariantGeneration(f.store, f.project, ref);
    const cold = emptyCache(f, t);
    // An opaque view (a Proxy of any other making) answers every read itself, every time: the same reads in the same order
    // before any proof is kept, again while it is kept, and after the genuine Store has kept it.
    const first = counting(cold);
    assert.deepEqual(readVariantGeneration(first.view, f.project, ref), expected, label);
    assert.ok(first.counts.get > 100, `${label}: the opaque view answered ${first.counts.get} reads`);
    const again = counting(cold);
    assert.deepEqual(readVariantGeneration(again.view, f.project, ref), expected, label);
    assert.deepEqual(again.log, first.log, `${label}: the second read through an opaque view makes the same reads in the same order`);
    // The transparent trace is not the genuine Store either: each call reads the records of the chain itself.
    const trace = historicalTrace(cold), ids = chain(f, ref);
    for (const call of [1, 2]) {
      const reads = countReads(ids, () => assert.deepEqual(readVariantGeneration(trace, f.project, ref), expected, label));
      assert.ok(reads > 0, `${label}: the trace read the records of the chain at call ${call}`);
    }
    // The observer of a trace is shown the records of the chain at every call.
    const seen: string[] = [];
    readVariantGeneration(historicalTrace(cold, tracedRef => { seen.push(tracedRef.id); }), f.project, ref);
    for (const id of ids) assert.ok(seen.includes(id), `${label}: the trace observer saw ${id}`);
    // The reads through views left no generation proof behind: the genuine Store, asked now, still reads the chain.
    assert.ok(countReads(ids, () => readVariantGeneration(cold, f.project, ref)) > 0, `${label}: no proof was left by a view`);
    assert.equal(countReads(ids, () => readVariantGeneration(cold, f.project, ref)), 0, `${label}: and now it is kept`);
    // Now it is kept, and a view still does not use it: the same reads again, and the observer of a trace sees the chain again.
    const kept = counting(cold);
    assert.deepEqual(readVariantGeneration(kept.view, f.project, ref), expected, label);
    assert.deepEqual(kept.log, first.log, `${label}: the opaque view makes the same reads while the genuine Store keeps the proof`);
    const afterKept: string[] = [];
    readVariantGeneration(historicalTrace(cold, tracedRef => { afterKept.push(tracedRef.id); }), f.project, ref);
    for (const id of ids) assert.ok(afterKept.includes(id), `${label}: the trace observer saw ${id} beside a kept proof`);
  }
  // An overlay shows what its own rows say: an intent head that is not the paid one refuses there, while the genuine Store,
  // which holds the kept proof, answers as before and is not misled by the overlay's read.
  const intent = f.store.get<ResearchConsumerIntent>(f.applied.id)!;
  const moved = { ...intent.value, cursor: { ...intent.value.cursor, prompt: 'Another instruction' } };
  const row = { id: intent.id, kind: intent.kind, revision: intent.revision + 1, hash: hashJson(moved), value: moved };
  readVariantGeneration(f.store, f.project, f.set);
  assert.ok('code' in outcome(() => readVariantGeneration(pendingSnapshotView(f.store, [row]), f.project, f.set)), 'the overlay refuses');
  assert.equal(readVariantGeneration(f.store, f.project, f.set).verification, 'proven');
  assert.equal(countReads(new Set([intent.id]), () => readVariantGeneration(f.store, f.project, f.set)), 0, 'and still repeats for nothing');
});

test('turn proof speed: every entry receives a copy of its own — also the repeat inside one synchronous operation', async t => {
  const f = await sharedWorld(t);
  for (const [label, ref] of generations(f)) {
    const expected = readVariantGeneration(historicalTrace(f.store), f.project, ref);
    const damage = (proven: ReturnType<typeof readVariantGeneration>) => {
      (proven.session.value as { projectId: string }).projectId = 'changed';
      proven.publication.result.value = null as never;
      proven.publication.members.length = 0;
      proven.state = { id: 'x', revision: 1, hash: '0'.repeat(64) };
    };
    const store = emptyCache(f, t);
    withHistoricalReads(() => {
      const derived = readVariantGeneration(store, f.project, ref);
      assert.deepEqual(derived, expected, `${label}: the deriving entry`);
      damage(derived);
      const second = readVariantGeneration(store, f.project, ref);
      assert.notEqual(second, derived, `${label}: another object`);
      assert.notEqual(second.session, derived.session);
      assert.notEqual(second.publication, derived.publication);
      assert.deepEqual(second, expected, `${label}: what the first caller did to its copy never reaches the second`);
      damage(second);
      assert.deepEqual(readVariantGeneration(store, f.project, ref), expected, `${label}: nor the third`);
    });
    assert.deepEqual(readVariantGeneration(store, f.project, ref), expected, `${label}: nor the next operation`);
    // The live Store of the world, with a proof kept long before: the same.
    const live = readVariantGeneration(f.store, f.project, ref);
    damage(live);
    assert.deepEqual(readVariantGeneration(f.store, f.project, ref), expected, `${label}: the live Store`);
  }
});

test('turn proof speed: what is current is seen at once — a moved head refuses, nothing is served stale, and the history of an earlier result is kept', async t => {
  const f = await sharedWorld(t);
  const published = generations(f).map(([label, ref]) => [label, ref, readVariantGeneration(f.store, f.project, ref)] as const);
  // A third generation, paid and still unpublished: its result does not exist yet, and the refusal is not remembered.
  f.reply(generation(3));
  const running = await f.pay(f.subjectOf(3)), target = f.publishes(running);
  const unpublished = outcome(() => readVariantGeneration(f.store, f.project, target));
  refusalCode(unpublished);
  assert.deepEqual(outcome(() => readVariantGeneration(historicalTrace(f.store), f.project, target)), unpublished, 'as the in-place derivation');
  const sent = f.wires().length;
  applyVariantSession(f.store, f.project, reference(running));
  assert.equal(f.wires().length, sent, 'publication pays nothing');
  const proven = readVariantGeneration(f.store, f.project, target);
  assert.deepEqual(proven, readVariantGeneration(historicalTrace(f.store), f.project, target), 'the running intent became terminal: the proof is the new one');
  assert.equal(countReads(new Set([running.id]), () => readVariantGeneration(f.store, f.project, target)), 0, 'and it is kept');
  // A later runtime-only revision of the paid call changes nothing of what the application consumed: its terminal is the exact one.
  const applied = f.store.get<ResearchConsumerIntent>(running.id)!;
  const call = f.store.get<{ runtime?: object }>(applied.value.call!.id)!;
  f.store.write({ id: call.id, kind: call.kind, expected: call.revision, value: { ...call.value, runtime: { ...call.value.runtime, note: 'a later runtime-only revision' } } as never });
  assert.deepEqual(readVariantGeneration(f.store, f.project, target), proven, 'the kept proof after a later revision of the paid call');
  assert.deepEqual(readVariantGeneration(historicalTrace(f.store), f.project, target), proven, 'and in place');
  assert.deepEqual(readVariantGeneration(emptyCache(f, t), f.project, target), proven, 'and on a Store opened later');
  // The head of the applied intent moves: a proof that read it is no longer current, whatever was kept.
  const edited = { ...applied.value, cursor: { ...applied.value.cursor, prompt: 'An instruction edited later' } };
  f.store.write({ id: applied.id, kind: applied.kind, expected: applied.revision, value: edited });
  const moved = outcome(() => readVariantGeneration(f.store, f.project, target));
  assert.equal(refusalCode(moved), refusalCode(outcome(() => readVariantGeneration(historicalTrace(f.store), f.project, target))), 'refused as the in-place derivation');
  assert.deepEqual(moved, outcome(() => readVariantGeneration(historicalTrace(f.store), f.project, target)), 'the same refusal');
  // Later heads — the mode moves, another process publishes a record — change nothing of an earlier result.
  const other = f.open(), mode = other.get(f.mode.id)!;
  other.write({ id: mode.id, kind: mode.kind, expected: mode.revision, value: { projectId: f.project, mode: 'bypass' } });
  for (const [label, ref, before] of published) {
    assert.deepEqual(readVariantGeneration(f.store, f.project, ref), before, `${label}: unchanged after later heads`);
    assert.deepEqual(readVariantGeneration(f.store, f.project, ref), readVariantGeneration(historicalTrace(f.store), f.project, ref), `${label}: as the in-place derivation`);
    const cold = emptyCache(f, t);
    assert.deepEqual(readVariantGeneration(cold, f.project, ref), before, `${label}: a Store opened later proves the same`);
  }
  // Another project is another proof: the kept one of this project serves no other.
  for (const [label, ref] of generations(f)) {
    const foreign = outcome(() => readVariantGeneration(f.store, 'q', ref));
    refusalCode(foreign);
    assert.deepEqual(foreign, outcome(() => readVariantGeneration(historicalTrace(f.store), 'q', ref)), label);
  }
});
