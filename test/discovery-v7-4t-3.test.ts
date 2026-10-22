import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, type Json } from '../src/canonical.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { VARIANT_CRITERIA, VARIANT_SUBJECT_CONTRACT, decodeVariantGeneration, type VariantSubject } from '../src/discovery/discovery-variants.js';
import { stageBudgetSegmentId } from '../src/discovery/stage-token-budget.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { EngineError } from '../src/errors.js';

// 4T.3 (codex-omg №11060 п.1): the real common researchCall carries a variant generation or decision. The snapshot,
// set and mode rows below are TRANSPORT FIXTURES ONLY: their producers (4T.1 snapshot, 4B set, 4O mode) prove them;
// the transport keeps their exact identity and never treats them as proved.
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'omg-4t3-'));
  const path = join(root, 'state.sqlite'), stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, engine, discovery, open };
}
type Fixture = ReturnType<typeof fixture>;
const allAxes = (depth: string) => Object.fromEntries(V7_AXES.map(axis => [axis, { depth }]));
function questionOf(store: Store, draft: Revision<DiscoveryDraft>, field: string): Revision<Question> {
  const question = draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field);
  assert.ok(question, `question for ${field}`);
  return question;
}
function acceptPlan(f: Fixture) {
  const base = createPartialV7Draft(f.discovery, 'p', 'concept');
  const src = f.discovery.evidence.document('p', 'basis', 'Exact source for p', 'text/plain', 0);
  const frame = questionOf(f.store, base, 'frame');
  answerDiscoveryFixture(f.engine, 'p', base, frame, { productType: 'internal', scale: '30 users', industries: ['construction'],
    domains: ['materials supply'], axes: allAxes('deep'),
    budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 } } as Json, src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, 'plan');
  answerDiscoveryFixture(f.engine, 'p', base, planQ, { edition: 1, frame: frameRef, previous: null, questions: [{ id: 'q-industry',
    axis: 'industry', domain: 'construction', text: 'What covers the industry?', class: 'blocking', criterion: 'Named basis',
    requiredDepth: 'deep', roles: ['domain expert'], searchPlaces: ['domain documents'] }] } as unknown as Json, src);
  return { draft: f.store.get<DiscoveryDraft>(base.id)!, plan: f.store.get<Question>(planQ.id)! };
}
const judgement = { conclusion: 'Bounded by the snapshot', grounds: [], assumptions: ['The saved snapshot is complete'], unknowns: [], quantity: null };
/** A lawful closed generation answer: unique local keys on one shared scale, a recommendation by an existing key. */
function generation(label: string): Json {
  const criteria = Object.fromEntries(VARIANT_CRITERIA.map(criterion => [criterion, judgement]));
  return { action: 'variants', variants: [
    { key: `${label}-a`, title: `Variant ${label} A`, proposal: { scope: 'narrow' }, criteria },
    { key: `${label}-b`, title: `Variant ${label} B`, proposal: { scope: 'wide' }, criteria }],
  scale: Object.fromEntries(VARIANT_CRITERIA.map(criterion => [criterion, `${criterion} from low to high`])),
  comparison: `A against B for ${label}`, recommendation: { key: `${label}-a`, reason: 'Fits the mandate' },
  searchLimits: ['Only the saved snapshot was read'], unknowns: [] } as Json;
}
async function setup(t: test.TestContext) {
  const f = fixture(t); f.engine.execute({ type: 'create-project', project: 'p', title: 'P' });
  const wire = join(f.root, 'wire.ndjson'), settings = join(f.root, 'reply.json'), adapter = join(f.root, 'adapter.mjs');
  const configure = (reply: unknown, tokens = 10) => writeFileSync(settings, JSON.stringify({ reply, tokens }));
  configure(generation('calibration'));
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:s.reply,usage:{inputTokens:s.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  let serial = 0;
  const transport = (label: string) => reference(f.store.write({ id: `transport-fixture:${label}:${serial++}`, kind: 'transport-fixture',
    expected: 0, value: { label } }));
  const subject = (kind: 'proposal' | 'decision', basis: Ref, mode: Ref): VariantSubject => kind === 'proposal'
    ? { contract: VARIANT_SUBJECT_CONTRACT, kind, snapshot: basis, mode, expectedSelection: null }
    : { contract: VARIANT_SUBJECT_CONTRACT, kind, set: basis, mode, expectedSelection: null };
  const body = (v: VariantSubject, question: Revision<Question>) => ({ variantSubject: v, question: { id: question.id, ...question.value.spec },
    core: { objective: 'Generate the variants of the saved snapshot' }, map: { nodes: [] }, history: [], readings: [] });
  const call = (v: VariantSubject, draftId: string, question: Revision<Question>, role = environment.value.implementer, store = f.store) =>
    researchCall(role, environment.value, 'Propose the variants of the saved snapshot', body(v, question), undefined,
      { store, draftId, questionId: question.id, purpose: `variant-${v.kind}` });
  // The ordinary estimate needs comparable measured calls of each variant purpose: calibrate once on a legacy draft.
  const old = f.discovery.create('p', 'discovery', 'R0', 'concept', [
    { field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  const probe = f.store.get<Question>(old.value.questions[0]!)!, calibration = transport('calibration');
  for (const kind of ['proposal', 'decision'] as const) for (const role of [environment.value.implementer, environment.value.reviewer])
    await call(subject(kind, calibration, transport(`calibration-mode-${kind}-${role.actor}`)), old.id, probe, role);
  writeFileSync(wire, '');
  const v = acceptPlan(f);
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const snapshot = (store: Store) => store.list().map(row => [row.id, row.revision, row.hash]);
  return { ...f, v, environment, configure, transport, subject, call, wires, snapshot };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const variantCalls = (f: Setup, store = f.store) => store.list<ModelCall>('model-call').filter(row => row.value.draftId === f.v.draft.id);
const errorCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;

test('4T.3: the real researchCall saves the complete exact variantSubject and wire under the ordinary stage budget, with no K, N or assessor', async t => {
  const f = await setup(t), v = f.subject('proposal', f.transport('snapshot'), f.transport('mode'));
  f.configure(generation('first'));
  const answer = await f.call(v, f.v.draft.id, f.v.plan);
  assert.deepEqual(answer, generation('first'));
  assert.equal(decodeVariantGeneration(answer).action, 'variants');
  const [call] = variantCalls(f);
  assert.ok(call);
  assert.deepEqual(call.value.variantSubject, v);
  assert.equal(call.value.purpose, 'variant-proposal');
  assert.equal(call.value.status, 'succeeded');
  // The exact wire: the request record is the byte-identical envelope the adapter received, carrying the identity.
  const [sent] = f.wires();
  const request = f.store.get<{ text: string }>(call.value.request.record!.id, call.value.request.record!.revision)!;
  assert.equal(request.value.text.length, call.value.request.chars);
  assert.deepEqual(JSON.parse(request.value.text), sent);
  assert.deepEqual(sent.subject.variantSubject, v);
  assert.deepEqual([sent.subject.projectId, sent.subject.purpose, sent.subject.actor], ['p', 'variant-proposal', 'author']);
  assert.deepEqual([sent.subject.draftRef, sent.subject.questionRef], [reference(f.v.draft), reference(f.v.plan)]);
  // The ordinary admission: the call is reserved in the stage segment's ledger like any other v7 send.
  assert.equal(call.value.budget?.segment.id, stageBudgetSegmentId('p'));
  const ledger = f.store.list<any>('research-budget-ledger').find(row => row.value.assignments.some((a: any) => a.call === call.id));
  assert.ok(ledger, 'the variant send is assigned in the stage ledger');
  // A transport, not research: no attempt, progress, account or assessor exists.
  for (const kind of ['research-attempt', 'v7-progress-state', 'v7-progress-application', 'v7-attempt-account', 'discovery-assessment'])
    assert.deepEqual(f.store.list(kind), [], kind);
  assert.equal(f.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'assessor').length, 0);
});

test('4T.3: the paid answer replays free for its saved identity — after a moved mode head and in a cold Store — and never for another', async t => {
  const f = await setup(t), snapshotRef = f.transport('snapshot'), mode = f.transport('mode');
  const v = f.subject('proposal', snapshotRef, mode);
  f.configure(generation('first'));
  const first = await f.call(v, f.v.draft.id, f.v.plan);
  const paid = f.snapshot(f.store), sent = f.wires().length;
  f.configure(generation('never-sent'));
  assert.deepEqual(await f.call(v, f.v.draft.id, f.v.plan), first, 'the same identity returns its paid answer');
  assert.deepEqual(f.snapshot(f.store), paid);
  assert.equal(f.wires().length, sent);
  // The same saved subject of another actor is another identity: its own new paid send, never this answer.
  f.configure(generation('reviewer'));
  const reviewer = await f.call(v, f.v.draft.id, f.v.plan, f.environment.value.reviewer);
  assert.deepEqual(reviewer, generation('reviewer'));
  assert.equal(f.wires().length, sent + 1);
  // Today's mode head moves; each saved identity still names its exact old mode and is answered from its own call.
  const moved = f.store.write({ id: mode.id, kind: 'transport-fixture', expected: mode.revision, value: { label: 'mode', revised: true } });
  const afterMove = f.snapshot(f.store);
  f.configure(generation('never-sent'));
  assert.deepEqual(await f.call(v, f.v.draft.id, f.v.plan), first);
  assert.deepEqual(await f.call(v, f.v.draft.id, f.v.plan, f.environment.value.reviewer), reviewer);
  const cold = f.open();
  assert.deepEqual(await f.call(v, f.v.draft.id, f.v.plan, f.environment.value.implementer, cold), first);
  assert.deepEqual(f.snapshot(f.store), afterMove);
  assert.equal(f.wires().length, sent + 1);
  // Today's mode is another identity: a new paid send with its own answer; the saved identity keeps its own.
  f.configure(generation('current-mode'));
  assert.deepEqual(await f.call(f.subject('proposal', snapshotRef, reference(moved)), f.v.draft.id, f.v.plan), generation('current-mode'));
  assert.equal(f.wires().length, sent + 2);
  assert.deepEqual(await f.call(v, f.v.draft.id, f.v.plan), first, 'the original identity keeps its own answer');
});

test('4T.3: a new send needs its exact current subject — a stale mode is refused before any payment', async t => {
  const f = await setup(t), mode = f.transport('mode');
  f.store.write({ id: mode.id, kind: 'transport-fixture', expected: mode.revision, value: { label: 'mode', revised: true } });
  const stale = f.subject('proposal', f.transport('snapshot'), mode), before = f.snapshot(f.store), sent = f.wires().length;
  await assert.rejects(() => f.call(stale, f.v.draft.id, f.v.plan), errorCode('input_stale'));
  assert.deepEqual(f.snapshot(f.store), before);
  assert.equal(f.wires().length, sent);
});

test('4T.3: the stage budget refuses a new variant send after an overrun, while the paid answer still replays free', async t => {
  const f = await setup(t), v = f.subject('proposal', f.transport('snapshot'), f.transport('mode'));
  f.configure(generation('expensive'), V7_STAGE_TOKEN_CEILING);
  const paid = await f.call(v, f.v.draft.id, f.v.plan);
  const sent = f.wires().length;
  f.configure(generation('refused'));
  await assert.rejects(() => f.call(f.subject('proposal', f.transport('snapshot-2'), f.transport('mode-2')), f.v.draft.id, f.v.plan),
    errorCode('discovery_budget_overrun'));
  assert.equal(f.wires().length, sent);
  assert.deepEqual(await f.call(v, f.v.draft.id, f.v.plan), paid);
  assert.equal(f.wires().length, sent);
});

test('4T.3: a decision travels the same way and keeps its own identity apart from a proposal on the same basis', async t => {
  const f = await setup(t), basis = f.transport('basis'), mode = f.transport('mode');
  f.configure(generation('proposal'));
  const proposal = await f.call(f.subject('proposal', basis, mode), f.v.draft.id, f.v.plan);
  f.configure({ choice: 'decline-all', reason: 'Transport only' });
  const decision = await f.call(f.subject('decision', basis, mode), f.v.draft.id, f.v.plan);
  assert.deepEqual(decision, { choice: 'decline-all', reason: 'Transport only' });
  assert.notDeepEqual(decision, proposal);
  assert.deepEqual(variantCalls(f).map(row => [row.value.purpose, (row.value.variantSubject as VariantSubject).kind]).sort(),
    [['variant-decision', 'decision'], ['variant-proposal', 'proposal']]);
  for (const kind of ['research-attempt', 'v7-progress-state', 'discovery-assessment']) assert.deepEqual(f.store.list(kind), [], kind);
});

test('4T.3: a mismatched purpose or a forged variant subject is refused before any payment', async t => {
  const f = await setup(t), v = f.subject('proposal', f.transport('snapshot'), f.transport('mode'));
  const context = { variantSubject: v, question: { id: f.v.plan.id, ...f.v.plan.value.spec }, core: { objective: 'x' }, map: { nodes: [] }, history: [], readings: [] };
  const before = f.snapshot(f.store), sent = f.wires().length;
  await assert.rejects(() => researchCall(f.environment.value.implementer, f.environment.value, 'x', context, undefined,
    { store: f.store, draftId: f.v.draft.id, questionId: f.v.plan.id, purpose: 'variant-decision' }), errorCode('discovery_variant_subject_invalid'));
  await assert.rejects(() => researchCall(f.environment.value.implementer, f.environment.value, 'x', { ...context, variantSubject: { ...v, ready: true } },
    undefined, { store: f.store, draftId: f.v.draft.id, questionId: f.v.plan.id, purpose: 'variant-proposal' }), errorCode('discovery_variant_subject_invalid'));
  assert.deepEqual(f.snapshot(f.store), before);
  assert.equal(f.wires().length, sent);
});

test('4T.3: a forged second paid call of the same identity is a typed refusal, never a silent pick; a running call recovers first', async t => {
  const f = await setup(t), v = f.subject('proposal', f.transport('snapshot'), f.transport('mode'));
  await f.call(v, f.v.draft.id, f.v.plan);
  const [call] = variantCalls(f);
  // Negative mutation: a copy of the paid call under another id claims the same first packet.
  f.store.write({ id: `${call!.id}-copy`, kind: 'model-call', expected: 0, value: call!.value as unknown as Json });
  await assert.rejects(() => f.call(v, f.v.draft.id, f.v.plan), errorCode('research_replay_invalid'));
  const g = await setup(t), w = g.subject('proposal', g.transport('snapshot'), g.transport('mode'));
  await g.call(w, g.v.draft.id, g.v.plan);
  const [saved] = variantCalls(g);
  // Negative mutation: the saved call is marked unfinished again.
  g.store.write({ id: saved!.id, kind: 'model-call', expected: saved!.revision, value: { ...saved!.value, status: 'running' } as unknown as Json });
  const sent = g.wires().length;
  await assert.rejects(() => g.call(w, g.v.draft.id, g.v.plan), errorCode('continuation_call_active'));
  assert.equal(g.wires().length, sent);
  assert.equal(canonical(variantCalls(g).map(row => row.id)), canonical([saved!.id]));
});

test('4T.3: the closed generation answer — one to three unique keys on one scale, a recommendation by an existing key, no_variants apart', () => {
  const good = generation('g') as Record<string, any>;
  assert.equal(decodeVariantGeneration(good).action, 'variants');
  const none = { action: 'no_variants', reasons: [{ code: 'snapshot_incomplete', message: 'Two questions stay open',
    grounds: [{ id: 'transport-fixture:snapshot:0', revision: 1, hash: 'a'.repeat(64) }] }], searchLimits: ['One edition read'], unknowns: [] };
  assert.equal(decodeVariantGeneration(none).action, 'no_variants');
  const variant = good.variants[0];
  const bad: [string, unknown][] = [
    ['no variant', { ...good, variants: [] }],
    ['four variants', { ...good, variants: [0, 1, 2, 3].map(i => ({ ...variant, key: `k${i}` })) }],
    ['a repeated key', { ...good, variants: [variant, { ...variant, title: 'Other' }], recommendation: { key: variant.key, reason: 'r' } }],
    ['a recommendation of no key', { ...good, recommendation: { key: 'missing', reason: 'r' } }],
    ['a member scale beside the shared one', { ...good, variants: [{ ...variant, scale: good.scale }] }],
    ['a missing criterion of the scale', { ...good, scale: { ...good.scale, risk: undefined } }],
    ['an unexplained judgement', { ...good, variants: [{ ...variant, criteria: { ...variant.criteria,
      risk: { conclusion: 'c', grounds: [], assumptions: [], unknowns: [], quantity: null } } }] }],
    ['no search limits', { ...good, searchLimits: [] }],
    ['an unknown action', { ...good, action: 'ranked' }],
    ['an extra field', { ...good, ready: true }],
    ['no_variants without reasons', { ...none, reasons: [] }],
    ['no_variants with members', { ...none, variants: good.variants }],
    ['a reason without grounds', { ...none, reasons: [{ code: 'c', message: 'm', grounds: [] }] }],
  ];
  for (const [label, value] of bad)
    assert.throws(() => decodeVariantGeneration(JSON.parse(JSON.stringify(value))), errorCode('discovery_variant_answer_invalid'), label);
});

test('4T.3: an off-form paid generation answer is kept as paid and refused on every reading, without a second payment', async t => {
  const f = await setup(t), v = f.subject('proposal', f.transport('snapshot'), f.transport('mode'));
  f.configure({ action: 'variants', variants: [], note: 'untyped' });
  await assert.rejects(() => f.call(v, f.v.draft.id, f.v.plan), errorCode('discovery_variant_answer_invalid'));
  const [call] = variantCalls(f);
  assert.equal(call!.value.status, 'succeeded', 'the paid off-form answer is retained');
  const saved = f.snapshot(f.store), sent = f.wires().length;
  f.configure(generation('never-sent'));
  await assert.rejects(() => f.call(v, f.v.draft.id, f.v.plan), errorCode('discovery_variant_answer_invalid'));
  await assert.rejects(() => f.call(v, f.v.draft.id, f.v.plan, f.environment.value.implementer, f.open()), errorCode('discovery_variant_answer_invalid'));
  assert.deepEqual(f.snapshot(f.store), saved);
  assert.equal(f.wires().length, sent);
});
