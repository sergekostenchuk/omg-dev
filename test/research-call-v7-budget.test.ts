import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Write, type TransactionGuard } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import type { Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { researchCall, type ResearchCallAudit } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution, readResearchConsumerTurn } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { stageBudgetSegmentId } from '../src/discovery/stage-token-budget.js';
import { budgetUsage, type BudgetSegment } from '../src/runtime/research-budget.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { reference } from '../src/pipeline/contracts.js';
import { hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { uniqueTransactionGuards, type RoleBinding } from '../src/runtime/environment.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-v7-call-budget-'));
  const stores: Store[] = [], open = () => { const s = new Store(join(root, 'state.sqlite')); stores.push(s); return s; };
  const store = open(), engine = new ProductEngine(store), counter = join(root, 'sends'), settings = join(root, 'reply.json');
  t.after(() => { for (const s of stores) s.close(); rmSync(root, { recursive: true, force: true }); });
  const adapter = join(root, 'provider.mjs');
  writeFileSync(settings, JSON.stringify({ tokens: 10 }));
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')), settings=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(counter)},'send\\n');
const research={action:'checkpoint',question:r.subject.question.id,value:{note:'Exact paid reply'},citations:[],unresolved:['next']};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,...(settings.tokens===null?{}:{usage:{inputTokens:settings.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}})}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const draft = createPartialV7Draft(engine.discovery, 'p', 'concept');
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const context = { question: { id: question.id, field: question.value.spec.field }, history: [], readings: [] };
  const sent = () => existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const reply = (tokens: number | null) => writeFileSync(settings, JSON.stringify({ tokens }));
  const invoke = (db = store, purpose = 'analyst', role = environment.value.implementer, extra: Partial<ResearchCallAudit> = {}) =>
    researchCall(role, environment.value, 'Research this question.', context, undefined,
      { store: db, draftId: draft.id, questionId: question.id, purpose, ...extra });
  // Real v6 transport calls provide the empirical calibration; v7 never creates
  // a free synthetic forecast or a separately committed empty budget segment.
  const calibrate = async (purpose = 'analyst', role = environment.value.implementer) => {
    const old = engine.discovery.create('p', 'discovery', 'R0', 'concept',
      [{ field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
    const q = store.get<Question>(old.value.questions[0]!)!;
    await researchCall(role, environment.value, 'Calibrate.', { question: { id: q.id }, history: [], readings: [] }, undefined,
      { store, draftId: old.id, questionId: q.id, purpose });
  };
  const paidCalls = (db = store) => db.list<ModelCall>('model-call').filter(c => c.value.draftId === draft.id);
  const segment = (db = store) => db.get<BudgetSegment>(stageBudgetSegmentId('p'));
  const ledger = (db = store) => db.get(`research-budget-ledger:${hashJson(stageBudgetSegmentId('p'))}`);
  const managed = () => {
    const run = store.write<ResearchRun>({ id: `research-run:${store.list('research-run').length}`, kind: 'research-run', expected: 0,
      value: { projectId: 'p', draftId: draft.id, environment: reference(environment), turns: 0, limit: 1, requestChars: 0,
        owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null,
        status: 'running', inputs: draft.value.inputs } });
    const intent = prepareResearchConsumerIntent(store, { projectId: 'p', kind: 'analyst', key: run.id,
      owner: reference(run), draft: reference(draft), question: reference(question), role: environment.value.implementer,
      dispatch: environment.value, profile: null, cursor: { run: run.id, turn: 1, instruction: 'Research this question.', context },
      basis: draft.value.inputs, guards: uniqueTransactionGuards([reference(run), reference(draft), reference(question), reference(environment)]) });
    return { run, intent, invoke: (db = store) => invoke(db, 'analyst', environment.value.implementer,
      { consumerIntent: reference(intent), requestContract: REQUEST_MANIFEST_CONTRACT }) };
  };
  return { root, store, open, engine, environment, draft, question, context, sent, reply, invoke, calibrate, paidCalls, segment, ledger, managed };
}

function inject(store: Store, action: (writes: Write[], guards: TransactionGuard[], original: typeof store.writeMany) => ReturnType<typeof store.writeMany>) {
  const original = store.writeMany.bind(store);
  store.writeMany = ((writes, guards = []) => action(writes, guards, original)) as typeof store.writeMany;
  return () => { store.writeMany = original; };
}

test('v7 first send without pilot commits segment ledger call intent and manifest together', async t => {
  const f = fixture(t); await f.calibrate(); const m = f.managed(); let batch = false;
  const restore = inject(f.store, (writes, guards, original) => {
    if (writes.some(w => w.kind === 'research-budget-ledger')) {
      assert.equal(f.segment(), null); assert.equal(f.ledger(), null);
      for (const kind of ['research-budget', 'model-call', 'research-consumer-intent', 'request-manifest', 'request-part'])
        assert.ok(writes.some(w => w.kind === kind), kind);
      assert.equal(guards.some(g => !('absent' in g) && g.id === stageBudgetSegmentId('p')), false);
      batch = true;
    }
    return original(writes, guards);
  });
  try { assert.equal((await m.invoke() as any).action, 'checkpoint'); } finally { restore(); }
  assert.ok(batch); assert.equal(f.sent(), 2); assert.equal(f.segment()!.revision, 1);
  assert.equal(f.paidCalls().length, 1); assert.deepEqual(f.paidCalls()[0]!.value.budget!.segment, reference(f.segment()!));
  assert.equal(budgetUsage(f.store, f.segment()!).measured, 11);
});

test('missing forecast rejects before first segment ledger call or adapter and carries budget details', async t => {
  const f = fixture(t);
  await assert.rejects(f.invoke(), (e: any) => e.code === 'budget_estimate_missing'
    && e.details.class === 'research' && e.details.remaining === 18_000_000 && e.details.estimate === null);
  assert.equal(f.sent(), 0); assert.equal(f.segment(), null); assert.equal(f.ledger(), null); assert.equal(f.paidCalls().length, 0);
});

test('all roles use one segment and purpose/finalization spoofing cannot spend completion reserve', async t => {
  const f = fixture(t);
  const roles: [string, RoleBinding][] = [['analyst', f.environment.value.implementer], ['assessor', f.environment.value.reviewer],
    ['reader', { ...f.environment.value.implementer, actor: 'reader' }], ['completion', f.environment.value.implementer]];
  for (const [purpose, role] of roles) { await f.calibrate(purpose, role); await f.invoke(f.store, purpose, role); }
  assert.equal(f.store.list('research-budget').length, 1);
  assert.equal(f.paidCalls().length, 4);
  for (const call of f.paidCalls()) assert.deepEqual(call.value.budget!.groups, ['discovery-v7']);
  f.reply(18_000_000); await f.invoke();
  const before = f.sent(), ledger = f.ledger();
  await assert.rejects(f.invoke(f.store, 'completion'), (e: any) => e.code === 'discovery_budget_reserve'
    && e.details.class === 'research' && e.details.remaining < 0);
  assert.equal(f.sent(), before); assert.deepEqual(f.ledger(), ledger);
});

test('paid overrun succeeds with atomic incident and cold replay does not reserve or send again', async t => {
  const f = fixture(t); await f.calibrate(); const m = f.managed(); f.reply(V7_STAGE_TOKEN_CEILING + 1);
  let atomic = false;
  const restore = inject(f.store, (writes, guards, original) => {
    if (writes.some(w => w.kind === 'model-response')) {
      assert.ok(writes.some(w => w.kind === 'budget-incident'));
      assert.ok(writes.some(w => w.kind === 'model-call' && (w.value as ModelCall).status === 'succeeded'));
      atomic = true;
    }
    return original(writes, guards);
  });
  let paid: unknown;
  try { paid = await m.invoke(); } finally { restore(); }
  assert.ok(atomic); assert.equal(f.paidCalls()[0]!.value.status, 'succeeded');
  assert.equal(f.store.list('budget-incident').length, 1);
  const ledger = f.ledger(), sends = f.sent(), fresh = f.open();
  assert.deepEqual(await m.invoke(fresh), paid); assert.deepEqual(await m.invoke(fresh), paid);
  assert.deepEqual(f.ledger(fresh), ledger); assert.equal(f.sent(), sends);
  await assert.rejects(f.invoke(fresh), { code: 'discovery_budget_overrun' }); assert.equal(f.sent(), sends);
  // Apply the paid response through the same projection and validator as the
  // runner, on a new Store after the budget is already exceeded.
  const execution = readResearchConsumerExecution(fresh, 'p', reference(m.intent));
  assert.equal(execution.kind, 'response');
  const projected = projectPaidTurnAdmission(m.run.value, { runId: m.run.id, intent: reference(m.intent),
    response: paid, question: reference(f.question), owner: m.run.value.owner, limit: 1, context: f.context });
  const turnId = managedTurnId(m.run.id, 1);
  const application = prepareResearchConsumerApplication(fresh, reference(m.intent), reference(execution.call), [
    { id: m.run.id, kind: m.run.kind, expected: m.run.revision, value: projected.run },
    { id: turnId, kind: 'research-turn', expected: 0, value: projected.turn }
  ], [reference(m.run), reference(f.environment), { id: turnId, absent: true }]);
  fresh.writeMany(application.writes, application.guards);
  for (let repeat = 0; repeat < 2; repeat++) {
    const reopened = f.open(), turn = reopened.get(turnId)!;
    assert.deepEqual(readResearchConsumerTurn(reopened, reference(turn)).value.action, paid);
    assert.deepEqual(f.ledger(reopened), ledger); assert.equal(f.paidCalls(reopened).length, 1); assert.equal(f.sent(), sends);
  }
});

test('unknown usage holds its reservation across a cold paid replay', async t => {
  const f = fixture(t); await f.calibrate(); const m = f.managed(); f.reply(null); const paid = await m.invoke();
  const usage = budgetUsage(f.store, f.segment()!); assert.equal(usage.measured, 0); assert.ok(usage.reserved > 0);
  const ledger = f.ledger(); assert.deepEqual(await m.invoke(f.open()), paid);
  assert.deepEqual(f.ledger(), ledger); assert.equal(f.sent(), 2);
});

test('a first-batch call conflict rolls back segment ledger intent and manifest and never sends', async t => {
  const f = fixture(t); await f.calibrate(); const m = f.managed(), other = f.open(); let raced = false;
  const restore = inject(f.store, (writes, guards, original) => {
    const call = writes.find(w => w.kind === 'model-call' && w.expected === 0);
    if (call && !raced) { raced = true; other.write(call); }
    return original(writes, guards);
  });
  try { await assert.rejects(m.invoke(), { code: 'revision_conflict' }); } finally { restore(); }
  assert.ok(raced); assert.equal(f.sent(), 1); assert.equal(f.segment(), null); assert.equal(f.ledger(), null);
  assert.equal(f.store.get<any>(m.intent.id)!.value.state, 'prepared'); assert.equal(f.store.list('request-manifest').length, 0);
});

test('fault after reservation before dispatch keeps one reserved claim and a repeat never pays twice', async t => {
  const f = fixture(t); await f.calibrate(); const m = f.managed(); let failed = false;
  const restore = inject(f.store, (writes, guards, original) => {
    const rows = original(writes, guards);
    if (!failed && writes.some(w => w.kind === 'research-budget-ledger')) { failed = true; throw new EngineError('fixture_crash', 'after reservation'); }
    return rows;
  });
  try { await assert.rejects(m.invoke(), { code: 'fixture_crash' }); } finally { restore(); }
  const ledger = f.ledger(); assert.equal(f.sent(), 1); assert.equal(f.paidCalls().length, 1);
  await assert.rejects(m.invoke(f.open())); assert.equal(f.sent(), 1); assert.deepEqual(f.ledger(), ledger);
  assert.ok(budgetUsage(f.store, f.segment()!).reserved > 0);
});

test('fault before terminal batch leaves neither reply nor incident and retains the reservation', async t => {
  const f = fixture(t); await f.calibrate(); const m = f.managed(); f.reply(V7_STAGE_TOKEN_CEILING + 1);
  const restore = inject(f.store, (writes, guards, original) => {
    if (writes.some(w => w.kind === 'budget-incident')) throw new EngineError('fixture_terminal_crash', 'before terminal batch');
    return original(writes, guards);
  });
  try { await assert.rejects(m.invoke(), { code: 'fixture_terminal_crash' }); } finally { restore(); }
  assert.equal(f.sent(), 2); assert.equal(f.store.list('budget-incident').length, 0);
  assert.equal(f.paidCalls()[0]!.value.status, 'running'); assert.equal(f.paidCalls()[0]!.value.response, null);
  const ledger = f.ledger(); await assert.rejects(m.invoke(f.open()));
  assert.equal(f.sent(), 2); assert.deepEqual(f.ledger(), ledger);
});

test('missing corrupt foreign and downgraded Discovery bindings cannot select an unbudgeted send', async t => {
  for (const defect of ['missing-draft', 'null-draft', 'foreign-project', 'era-removed', 'missing-question'] as const) {
    const f = fixture(t); await f.calibrate();
    if (defect === 'null-draft') f.store.write({ id: f.draft.id, kind: f.draft.kind, expected: f.draft.revision, value: null });
    if (defect === 'foreign-project') f.store.write({ id: f.draft.id, kind: f.draft.kind, expected: f.draft.revision,
      value: { ...f.draft.value, projectId: 'foreign' } });
    if (defect === 'era-removed') { const { contractVersion: _removed, ...body } = f.draft.value;
      f.store.write({ id: f.draft.id, kind: f.draft.kind, expected: f.draft.revision, value: body }); }
    const extra = defect === 'missing-draft' ? { draftId: 'discovery:p:missing' } : {};
    const result = defect === 'missing-question'
      ? researchCall(f.environment.value.implementer, f.environment.value, 'Research this question.', f.context, undefined,
        { store: f.store, draftId: f.draft.id, purpose: 'analyst' })
      : f.invoke(f.store, 'analyst', f.environment.value.implementer, extra);
    await assert.rejects(result,
      (e: any) => ['discovery_draft_invalid', 'discovery_budget_not_v7', 'continuation_question_missing'].includes(e.code));
    assert.equal(f.sent(), 1); assert.equal(f.segment(), null); assert.equal(f.paidCalls().length, 0);
  }
});


test('two Stores racing the first v7 reservation admit exactly one physical send', async t => {
  const f = fixture(t); await f.calibrate();
  const first = f.managed(), second = f.managed(), other = f.open();
  // LG62: the removed call-runtime capture await used to be the yield between the active-call check and the
  // reservation write. The window is now driven explicitly: inside the first Store's initial batch, before its
  // real write, the second Store reaches and commits its own reservation; the first batch then loses the CAS.
  let secondCall: Promise<unknown> | undefined, intercepted = false;
  const restore = inject(f.store, (writes, guards, original) => {
    if (!intercepted && writes.some(w => w.kind === 'model-call') && writes.some(w => w.kind === 'research-budget-ledger')) {
      intercepted = true;
      assert.equal(f.segment(), null); assert.equal(f.ledger(), null);
      assert.equal(f.store.list<any>('research-consumer-intent').filter(i => i.value.state === 'prepared').length, 2);
      secondCall = second.invoke(other); secondCall.catch(() => undefined);
      assert.equal(f.paidCalls(other).length, 1, 'the second Store committed its reservation inside the window');
      assert.ok(f.ledger(other), 'the winner published its ledger first');
    }
    return original(writes, guards);
  });
  let outcomes: PromiseSettledResult<unknown>[];
  try {
    const [firstOutcome] = await Promise.allSettled([first.invoke()]);
    outcomes = [firstOutcome!, ...(secondCall ? await Promise.allSettled([secondCall]) : [])];
  } finally { restore(); }
  assert.equal(intercepted, true, 'the first Store attempted its prepared batch after the winner');
  assert.equal(outcomes.length, 2); assert.equal(outcomes[1]!.status, 'fulfilled', 'the second call is the paid one');
  const failed = outcomes[0] as PromiseRejectedResult;
  assert.equal(failed.status, 'rejected');
  assert.ok(['revision_conflict', 'input_stale'].includes(failed.reason.code), String(failed.reason?.code));
  assert.equal(f.sent(), 2); assert.equal(f.paidCalls().length, 1);
  assert.equal(f.store.list('research-budget').length, 1);
  assert.equal(f.store.list('research-budget-ledger').length, 1);
  assert.equal(f.store.list('request-manifest').length, 1);
  assert.equal(f.store.list<any>('research-consumer-intent').filter(i => i.value.state === 'prepared').length, 1);
});

for (const conflictCount of [3, 9])
test(`paid success survives ${conflictCount} accounting conflicts and cold replay forbids another overrun send`, async t => {
  // DR3c-a3-01: the review probe moves only the ledger before each of the
  // first three terminal batches. A running dispatch is not a late receipt.
  const f = fixture(t); await f.calibrate(); const m = f.managed(), other = f.open();
  f.reply(V7_STAGE_TOKEN_CEILING + 1); let conflicts = 0;
  const restore = inject(f.store, (writes, guards, original) => {
    if (conflicts < conflictCount && writes.some(w => w.kind === 'budget-incident')) {
      conflicts++;
      assert.equal(f.paidCalls(other)[0]!.value.status, 'running');
      assert.equal(f.paidCalls(other)[0]!.value.response, null);
      assert.equal(other.list('budget-incident').length, 0);
      const ledger = f.ledger(other)!;
      other.write({ id: ledger.id, kind: ledger.kind, expected: ledger.revision, value: ledger.value });
    }
    return original(writes, guards);
  });
  let paid: unknown;
  try { paid = await m.invoke(); } finally { restore(); }
  assert.equal(conflicts, conflictCount); assert.equal((paid as any).action, 'checkpoint');
  assert.equal(f.sent(), 2); assert.equal(f.store.list('budget-incident').length, 1);
  const call = f.paidCalls()[0]!;
  assert.equal(call.value.status, 'succeeded'); assert.ok(call.value.response?.record);
  const incident = f.store.list<any>('budget-incident')[0]!;
  assert.deepEqual(incident.value.call, reference(call));
  const usage = budgetUsage(f.store, f.segment()!);
  assert.equal(usage.measured, V7_STAGE_TOKEN_CEILING + 2); assert.equal(usage.reserved, 0);
  assert.equal(f.store.list('model-late-receipt').length, 0);
  const ledger = f.ledger(), fresh = f.open();
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.deepEqual(await m.invoke(fresh), paid);
    assert.deepEqual(f.ledger(fresh), ledger); assert.equal(f.paidCalls(fresh).length, 1); assert.equal(f.sent(), 2);
  }
  await assert.rejects(f.invoke(fresh), { code: 'discovery_budget_overrun' });
  assert.deepEqual(f.ledger(fresh), ledger); assert.equal(f.sent(), 2);
});
