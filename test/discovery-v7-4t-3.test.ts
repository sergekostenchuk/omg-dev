import { fixturePlanAxes, fixturePlanCoverage } from "./discovery-v7-fixture.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest, type Json } from '../src/canonical.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { VARIANT_CRITERIA, VARIANT_SUBJECT_CONTRACT, VARIANT_SESSION_CONTRACT, VARIANT_SESSION_KIND, decodeVariantGeneration,
  decodeVariantExecutionSession, type VariantSubject } from '../src/discovery/discovery-variants.js';
import { stageBudgetSegmentId } from '../src/discovery/stage-token-budget.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { EngineError } from '../src/errors.js';
import { readArchiveBody, REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { V7_PLAN_SUBJECT_CONTRACT } from '../src/discovery/v7-managed-attempt.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';

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
    domains: ['materials supply'], axes: fixturePlanAxes([{axis:'industry'}]),
    budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 } } as Json, src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, 'plan');
  answerDiscoveryFixture(f.engine, 'p', base, planQ, { edition: 1, frame: frameRef, previous: null, coverage: fixturePlanCoverage([{id:'q-industry',axis:'industry'}]), questions: [{ id: 'q-industry',
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
  const call = (v: VariantSubject, draftId: string, question: Revision<Question>, role = environment.value.implementer, store = f.store,
    onContext?: (context: Record<string, any>) => void) =>
    researchCall(role, environment.value, 'Propose the variants of the saved snapshot', body(v, question), undefined,
      { store, draftId, questionId: question.id, purpose: `variant-${v.kind}`, ...(onContext ? { onContext } : {}) });
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
  return { ...f, v, environment, configure, transport, subject, body, call, wires, snapshot };
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

test('4T.3: a new direct v7 decision refuses without inheriting the paid proposal on the same basis', async t => {
  const f = await setup(t), basis = f.transport('basis'), mode = f.transport('mode');
  f.configure(generation('proposal'));
  const subject = f.subject('proposal', basis, mode), proposal = await f.call(subject, f.v.draft.id, f.v.plan);
  assert.deepEqual(variantCalls(f).map(row => [row.value.purpose, row.value.variantSubject]), [['variant-proposal', subject]]);
  const snapshot = () => ({ store: f.store.list().flatMap(row => f.store.history(row.id)),
    calls: f.store.list('model-call'), ledger: f.store.list('research-budget-ledger') });
  const before = snapshot(), sent = f.wires().length;
  f.configure({ choice: 'decline-all', reason: 'Transport only' });
  await assert.rejects(() => f.call(f.subject('decision', basis, mode), f.v.draft.id, f.v.plan), errorCode('discovery_variant_managed'));
  assert.deepEqual(snapshot(), before); assert.equal(f.wires().length, sent);
  assert.deepEqual(await f.call(subject, f.v.draft.id, f.v.plan), proposal, 'only the proposal identity returns its own saved answer');
  assert.deepEqual(snapshot(), before); assert.equal(f.wires().length, sent);
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

test('4T3-01: the first send and both replays hand onContext the subject of the saved model-request, never the archive body', async t => {
  const f = await setup(t), v = f.subject('proposal', f.transport('snapshot'), f.transport('mode'));
  const seen: Record<string, any>[] = [], see = (context: Record<string, any>) => { seen.push(JSON.parse(JSON.stringify(context))); };
  f.configure(generation('first'));
  await f.call(v, f.v.draft.id, f.v.plan, f.environment.value.implementer, f.store, see);
  const [call] = variantCalls(f);
  const request = f.store.get<{ text: string }>(call!.value.request.record!.id, call!.value.request.record!.revision)!;
  const sent = JSON.parse(request.value.text).subject;
  f.configure(generation('never-sent'));
  const before = f.snapshot(f.store), wires = f.wires().length;
  await f.call(v, f.v.draft.id, f.v.plan, f.environment.value.implementer, f.store, see);
  await f.call(v, f.v.draft.id, f.v.plan, f.environment.value.implementer, f.open(), see);
  assert.equal(seen.length, 3);
  for (const context of seen) assert.deepEqual(context, sent);
  // The archive stays the ground of the call: its body is not what was sent.
  const archive = f.store.get<Record<string, any>>(call!.value.packet!.archive.id, call!.value.packet!.archive.revision)!;
  assert.notDeepEqual(readArchiveBody(f.store, archive).body, sent);
  assert.deepEqual(f.snapshot(f.store), before);
  assert.equal(f.wires().length, wires);
});

test('4T3-01: a lost or forged request record of a paid variant call is a typed refusal with no record and no send', async t => {
  const f = await setup(t), v = f.subject('proposal', f.transport('snapshot'), f.transport('mode'));
  await f.call(v, f.v.draft.id, f.v.plan);
  const [call] = variantCalls(f);
  const ref = call!.value.request.record!, original = f.store.get<{ projectId: string; draftId: string; text: string }>(ref.id, ref.revision)!;
  const envelope = JSON.parse(original.value.text);
  const forged = (label: string, text: string) => reference(f.store.write({ id: `model-request:forged-${label}`, kind: 'model-request',
    expected: 0, value: { ...original.value, text } }));
  const audited = (label: string, text: string) => ({ chars: text.length, bytes: Buffer.byteLength(text), hash: digest(text), record: forged(label, text) });
  const { record: _record, ...bare } = call!.value.request;
  const otherEnvelope = JSON.stringify({ ...envelope, requestId: 'another-request' });
  const otherIdentity = JSON.stringify({ ...envelope, subject: { ...envelope.subject, actor: 'reviewer' } });
  const otherArchive = JSON.stringify({ ...envelope, subject: { ...envelope.subject, working: { ...envelope.subject.working,
    archive: f.transport('archive') } } });
  // №11197: the same requestId, actor, variantSubject and archive, another body, and a new audit consistent with it.
  assert.equal(typeof envelope.subject.core?.objective, 'string', 'the sent body carries the objective this forgery changes');
  const otherBody = JSON.stringify({ ...envelope, subject: { ...envelope.subject, core: { ...envelope.subject.core, objective: 'Another objective' } } });
  const cases: [string, Record<string, unknown>][] = [
    ['no saved request record', bare],
    ['other bytes under the audit of the original', { ...call!.value.request, record: forged('bytes', `${original.value.text} `) }],
    ['bytes of another envelope with their own matching audit', audited('envelope', otherEnvelope)],
    ['consistent bytes of another transport identity', audited('identity', otherIdentity)],
    ['consistent bytes naming another archive', audited('archive', otherArchive)],
    ['consistent bytes of the same identity with another body', audited('body', otherBody)],
  ];
  const firstRevision = f.store.get(call!.id, 1);
  let head: Revision<unknown> = call!;
  for (const [note, request] of cases) {
    head = f.store.write({ id: call!.id, kind: 'model-call', expected: head.revision, value: { ...call!.value, request } as unknown as Json });
    const before = f.snapshot(f.store), sent = f.wires().length;
    await assert.rejects(() => f.call(v, f.v.draft.id, f.v.plan), errorCode('research_replay_invalid'), note);
    await assert.rejects(() => f.call(v, f.v.draft.id, f.v.plan, f.environment.value.implementer, f.open()), errorCode('research_replay_invalid'), `${note} (cold)`);
    assert.deepEqual(f.snapshot(f.store), before, note);
    assert.equal(f.wires().length, sent, note);
  }
  assert.deepEqual(f.store.get(call!.id, 1), firstRevision, 'the first revision of the call is never touched');
});

test('4T3-02: no early paid return crosses branches — a paid analyst intent never answers a variant, a paid variant never a mixed context', async t => {
  const f = await setup(t), v = f.subject('proposal', f.transport('snapshot'), f.transport('mode'));
  await f.call(v, f.v.draft.id, f.v.plan);
  // A lawfully paid managed analyst intent on the accepted plan (the ordinary estimate needs a measured analyst call).
  const old = f.discovery.create('p', 'discovery', 'R0', 'concept', [
    { field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  await researchCall(f.environment.value.implementer, f.environment.value, 'Calibrate', {}, undefined,
    { store: f.store, draftId: old.id, questionId: old.value.questions[0]!, purpose: 'analyst' });
  const environment = f.store.get(`environment:p`)!, draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!, plan = f.store.get<Question>(f.v.plan.id)!;
  const run = f.store.write<ResearchRun>({ id: 'research-run:4t3-02', kind: 'research-run', expected: 0,
    value: { projectId: 'p', draftId: draft.id, environment: reference(environment), turns: 0, limit: 1, requestChars: 0,
      owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null, status: 'running', inputs: draft.value.inputs } });
  const prompt = 'Research the selected plan question', context = { history: [], readings: [] };
  const intent = prepareResearchConsumerIntent(f.store, { projectId: 'p', kind: 'analyst', key: run.id, owner: reference(run),
    draft: reference(draft), question: reference(plan), role: f.environment.value.implementer, dispatch: f.environment.value, profile: null,
    cursor: { run: run.id, turn: 1, instruction: prompt, context,
      subject: { contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: plan.value.answer!, planQuestionId: 'q-industry' } },
    basis: draft.value.inputs, guards: uniqueTransactionGuards([reference(run), reference(draft), reference(plan), reference(environment)]) });
  const analyst = { action: 'answer', question: 'q-industry', value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'None' }, citations: [] };
  f.configure(analyst);
  const managed = (purpose: string, given: Record<string, unknown>) => researchCall(f.environment.value.implementer, f.environment.value,
    prompt, given, undefined, { store: f.store, draftId: draft.id, questionId: plan.id, purpose, consumerIntent: reference(intent),
      requestContract: REQUEST_MANIFEST_CONTRACT });
  const paid = await managed('analyst', context);
  f.configure(generation('never-sent'));
  const before = f.snapshot(f.store), sent = f.wires().length;
  const mixed: [string, () => Promise<unknown>][] = [
    ['the paid analyst intent asked again with a variant subject in its context', () => managed('analyst', { ...context, variantSubject: v })],
    ['the paid analyst intent asked again under a variant purpose', () => managed('variant-proposal', context)],
    ['the paid variant asked again with a plan subject beside it', () => researchCall(f.environment.value.implementer, f.environment.value,
      'Propose the variants of the saved snapshot', { ...f.body(v, f.v.plan), subject: intent.value.cursor.subject }, undefined,
      { store: f.store, draftId: f.v.draft.id, questionId: f.v.plan.id, purpose: 'variant-proposal' })],
  ];
  for (const [note, attempt] of mixed) {
    await assert.rejects(attempt, errorCode('discovery_variant_subject_invalid'), note);
    assert.deepEqual(f.snapshot(f.store), before, note);
    assert.equal(f.wires().length, sent, note);
  }
  // Each branch keeps its own free replay by its historical identity.
  assert.deepEqual(await managed('analyst', context), paid);
  assert.deepEqual(decodeVariantGeneration(await f.call(v, f.v.draft.id, f.v.plan)).action, 'variants');
  assert.deepEqual(f.snapshot(f.store), before);
  assert.equal(f.wires().length, sent);
});


// ---- 4T.3 × 4T.4 junction (codex-worker №11290): the leaf form of the variant execution session and the narrow trusted
// admission of a managed variant intent. The session and intent rows below are FORGED INPUTS for refusals only: their
// producer and the managed lifecycle are 4T.4 (variant-session.ts, response-recovery.ts), checked there jointly.
test('4T.3×4T.4: the variant execution session is one closed form — cursor 0 without a result, cursor 1 with its receipt', () => {
  const ref = (label: string) => ({ id: `transport-fixture:${label}`, revision: 1, hash: 'a'.repeat(64) });
  const subject: VariantSubject = { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal', snapshot: ref('snapshot'), mode: ref('mode'), expectedSelection: null };
  const start = { contract: VARIANT_SESSION_CONTRACT, projectId: 'p', draft: ref('draft'), question: ref('question'), variantSubject: subject,
    purpose: 'variant-proposal', actor: 'author', cursor: 0, result: null };
  const applied = { ...start, cursor: 1, result: { intent: ref('intent'), call: ref('call'), response: ref('response') } };
  assert.deepEqual(decodeVariantExecutionSession(start), start);
  assert.deepEqual(decodeVariantExecutionSession(applied), applied);
  const { actor: _actor, ...missing } = start;
  const bad: [string, unknown][] = [
    ['no actor', missing], ['an extra ready flag', { ...start, ready: true }], ['another contract', { ...start, contract: 'unknown' }],
    ['a purpose of the other kind', { ...start, purpose: 'variant-decision' }], ['an empty project', { ...start, projectId: ' ' }],
    ['an inexact draft', { ...start, draft: { id: 'd' } }], ['a forged subject', { ...start, variantSubject: { ...subject, ready: true } }],
    ['cursor 0 with a result', { ...applied, cursor: 0 }], ['cursor 1 without a result', { ...start, cursor: 1 }],
    ['another cursor', { ...start, cursor: 2 }], ['a partial receipt', { ...applied, result: { intent: ref('intent') } }],
    ['an empty actor', { ...start, actor: '' }], ['not an object', [start]],
  ];
  for (const [note, value] of bad) assert.throws(() => decodeVariantExecutionSession(value), errorCode('discovery_variant_session_invalid'), note);
});

test('4T.3×4T.4: only an intent of its own kind, owned by the exact session of this very identity, passes the variant admission — before payment', async t => {
  const f = await setup(t), v = f.subject('proposal', f.transport('snapshot'), f.transport('mode'));
  const draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!, plan = f.store.get<Question>(f.v.plan.id)!;
  let serial = 0;
  const session = (value: Record<string, unknown>) => reference(f.store.write({ id: `discovery-variant-session:forged:${serial++}`,
    kind: VARIANT_SESSION_KIND, expected: 0, value: value as Json }));
  const sessionValue = { contract: VARIANT_SESSION_CONTRACT, projectId: 'p', draft: reference(draft), question: reference(plan), variantSubject: v,
    purpose: 'variant-proposal', actor: 'author', cursor: 0, result: null };
  const intent = (owner: Ref, overrides: Record<string, unknown> = {}, cursor: Record<string, unknown> = {}) =>
    reference(f.store.write({ id: `research-consumer-intent:forged:${serial++}`, kind: 'research-consumer-intent', expected: 0,
      value: { projectId: 'p', kind: 'variant-proposal', owner, draft: reference(draft), question: reference(plan),
        cursor: { variantSubject: v, sessionId: owner.id, offset: 0, ...cursor }, ...overrides } as unknown as Json }));
  const good = session(sessionValue);
  const managed = (ref: Ref, purpose = 'variant-proposal', subject: VariantSubject = v) => researchCall(f.environment.value.implementer,
    f.environment.value, 'Propose the variants of the saved snapshot', f.body(subject, f.v.plan), undefined,
    { store: f.store, draftId: f.v.draft.id, questionId: f.v.plan.id, purpose, consumerIntent: ref });
  const refused: [string, Ref, string][] = [
    ['an intent of another kind', intent(good, { kind: 'variant-decision' }), 'discovery_variant_subject_invalid'],
    ['an analyst intent carrying the subject', intent(good, { kind: 'analyst' }), 'discovery_variant_subject_invalid'],
    ['an intent of another subject', intent(good, {}, { variantSubject: { ...v, mode: f.transport('other-mode') } }), 'discovery_variant_subject_invalid'],
    ['an intent beside its session step', intent(good, {}, { offset: 1 }), 'discovery_variant_subject_invalid'],
    ['an intent naming another session', intent(good, {}, { sessionId: 'discovery-variant-session:other' }), 'discovery_variant_subject_invalid'],
    ['an intent owned by no session', intent(f.transport('owner')), 'discovery_variant_subject_invalid'],
    ['a session of another actor', intent(session({ ...sessionValue, actor: 'reviewer' })), 'discovery_variant_subject_invalid'],
    ['a session of another subject', intent(session({ ...sessionValue, variantSubject: { ...v, snapshot: f.transport('other-snapshot') } })), 'discovery_variant_subject_invalid'],
    ['a session of another draft edition', intent(session({ ...sessionValue, draft: { ...reference(draft), revision: draft.revision + 1 } })), 'discovery_variant_subject_invalid'],
    ['a damaged session', intent(session({ ...sessionValue, cursor: 1 })), 'discovery_variant_session_invalid'],
    ['an inexact intent reference', { ...intent(good), hash: 'f'.repeat(64) }, 'discovery_variant_subject_invalid'],
  ];
  const before = f.snapshot(f.store), sent = f.wires().length;
  for (const [note, ref, code] of refused) await assert.rejects(() => managed(ref), errorCode(code), note);
  // A complete forged pair passes this narrow admission only: the ordinary reader of the intent refuses it next, since the
  // managed variant kinds and their lifecycle are 4T.4's.
  const complete = intent(good), afterForgery = f.snapshot(f.store);
  await assert.rejects(() => managed(complete), (error: unknown) => error instanceof EngineError && error.code !== 'discovery_variant_subject_invalid'
    && error.code !== 'discovery_variant_session_invalid');
  assert.deepEqual(f.snapshot(f.store), afterForgery);
  assert.equal(f.wires().length, sent);
  assert.ok(before.length < afterForgery.length, 'only the forged inputs were written');
});

test('4T.3×4T.4: the direct replay never returns or pays beside a managed call of the same identity', async t => {
  const f = await setup(t), v = f.subject('proposal', f.transport('snapshot'), f.transport('mode'));
  await f.call(v, f.v.draft.id, f.v.plan);
  const [direct] = variantCalls(f);
  const intent = f.transport('intent');
  // Negative inputs: managed calls of the very same identity (consumerIntent saved in their first revision) beside the
  // direct one. Their producer is 4T.4; here they only stand for an origin the direct path must respect.
  const managedId = `model-call:consumer:v1:${direct!.value.requestId}-managed`;
  let managed = f.store.write({ id: managedId, kind: 'model-call', expected: 0, value: { ...direct!.value, consumerIntent: intent } as unknown as Json });
  const head = (id: string, value: Record<string, unknown>) => f.store.write({ id, kind: 'model-call', expected: f.store.get(id)!.revision, value: value as Json });
  const { consumerIntent: _dropped, ...withoutIntent } = managed.value as unknown as Record<string, unknown>;
  const refusedEverywhere = async (code: string, note: string) => {
    const before = f.snapshot(f.store), sent = f.wires().length;
    for (const store of [f.store, f.open()])
      await assert.rejects(() => f.call(v, f.v.draft.id, f.v.plan, f.environment.value.implementer, store), errorCode(code), note);
    assert.deepEqual(f.snapshot(f.store), before, note);
    assert.equal(f.wires().length, sent, note);
  };
  const firstRevisions = () => [direct!.id, managedId].map(id => f.store.get(id, 1));
  const origins = firstRevisions();
  await refusedEverywhere('discovery_variant_managed', 'an intact managed call beside the direct one');
  managed = head(managedId, withoutIntent);
  await refusedEverywhere('discovery_variant_origin_invalid', 'the managed binding removed from the head only (№11354)');
  managed = head(managedId, { ...withoutIntent, consumerIntent: f.transport('other-intent') });
  await refusedEverywhere('discovery_variant_origin_invalid', 'the managed binding replaced in the head');
  managed = head(managedId, { ...withoutIntent, consumerIntent: intent });
  await refusedEverywhere('discovery_variant_managed', 'the exact original binding restored');
  head(direct!.id, { ...(f.store.get(direct!.id)!.value as Record<string, unknown>), consumerIntent: intent });
  await refusedEverywhere('discovery_variant_origin_invalid', 'a managed binding added to the head of a direct call');
  assert.deepEqual(firstRevisions(), origins, 'no first revision is touched');
  // A malformed binding saved from the start is no absence either.
  const g = await setup(t), w = g.subject('proposal', g.transport('snapshot'), g.transport('mode'));
  await g.call(w, g.v.draft.id, g.v.plan);
  const [own] = variantCalls(g);
  g.store.write({ id: `${own!.id}-malformed`, kind: 'model-call', expected: 0, value: { ...own!.value, consumerIntent: { id: 'research-consumer-intent:x' } } as unknown as Json });
  const before = g.snapshot(g.store), sent = g.wires().length;
  for (const store of [g.store, g.open()])
    await assert.rejects(() => g.call(w, g.v.draft.id, g.v.plan, g.environment.value.implementer, store), errorCode('discovery_variant_origin_invalid'));
  assert.deepEqual(g.snapshot(g.store), before);
  assert.equal(g.wires().length, sent);
});
