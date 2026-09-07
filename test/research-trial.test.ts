import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashJson } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { Store, type Write, type ReadGuard } from '../src/storage/store.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { configureBudgetSegment, reserveResearchCall, budgetUsage, segmentId, type BudgetSegment } from '../src/runtime/research-budget.js';
import { configurePhasePolicy, phasePolicy, type PhasePolicy } from '../src/discovery/phase-policy.js';
import { allocateResearchTrial, type ResearchTrialRequest } from '../src/discovery/research-trial.js';
import { ProductEngine } from '../src/product/engine.js';
import type { ReaderPilot } from '../src/discovery/reader-pilot.js';
import { modelUsage } from '../src/runtime/model-usage.js';

const role = { actor: 'reader', model: 'fixture', effort: 'high', speed: 'fast', command: { executable: process.execPath, args: [] } } as const;
function modelCall(id: string, projectId = 'p'): ModelCall {
  return { projectId, draftId: 'd', purpose: 'analyst', requestId: id, startedAt: 1, finishedAt: null, status: 'running',
    requested: { ...role, command: { ...role.command, args: [] } }, confirmed: { model: null, effort: null, speed: null },
    request: { chars: 1, bytes: 1, hash: hashJson(id) }, response: null, usage: null, usageSource: 'unavailable', error: null };
}
function fixture(t: test.TestContext, stopAfter: PhasePolicy['stopAfter'] = 'L3') {
  const root = mkdtempSync(join(tmpdir(), 'omg-trial-'));
  const store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const pilot = store.write<ReaderPilot>({ id: 'reader-pilot:p', kind: 'reader-pilot', expected: 0,
    value: { projectId: 'p', experimental: true, active: true, stopAfter: 'L2', reader: {...role,command:{...role.command,args:[]}}, agentCommand: {...role.command,args:[]},
      maxRequestChars: 300_000, maxReadChars: 60_000, maxReplyChars: 100_000, maxCalls: 100, maxReportedTokens: 10_000_000 } });
  const oldSegment = configureBudgetSegment(store, 'p', 'old');
  const policy = configurePhasePolicy(store, 'p', stopAfter, 'old', 0);
  const request: ResearchTrialRequest = { key: 'new-trial', previousPolicy: reference(policy), limit: 20_000_000, blockLimit: 800_000 };
  return { store, pilot, policy, oldSegment, request };
}
function beforeCommit(store: Store, injection: () => void) {
  const original = store.writeMany.bind(store);
  store.writeMany = function<T>(writes: Write[], guards: ReadGuard[] = []) {
    store.writeMany = original;
    injection();
    return original<T>(writes, guards);
  };
}
function spend(store: Store, segment: ReturnType<typeof configureBudgetSegment>, id: string, tokens: number) {
  const reservation = reserveResearchCall(store, segment, id, ['block'],
    { kind: 'estimated', tokens, basis: [reference(segment)], explanation: 'fixture' });
  store.writeMany([{ id, kind: 'model-call', expected: 0, value: { ...modelCall(id), status: 'failed', finishedAt: 2,
    usage: { inputTokens: tokens, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } } },
  ...reservation.writes], reservation.guards);
}

test('public allocation command binds the new budget and an exact retry cannot allocate twice',t=>{
  const {store,request}=fixture(t);
  const engine=new ProductEngine(store);
  engine.execute({type:'create-project',project:'p',title:'Trial fixture'});
  const command={type:'allocate-research-trial',project:'p',...request};
  const first=engine.execute(command);
  assert.deepEqual(engine.execute(command),first);
  assert.equal(store.list('research-trial').length,1);
  assert.equal(store.list('research-budget').length,2);
  assert.throws(()=>engine.execute({...command,previousPolicy:null}));
});

test('usage reports prospective trial and block totals automatically, retaining unknown reserves separately',t=>{
  const {store,request}=fixture(t);
  const trial=allocateResearchTrial(store,'p',request);
  const segment=store.get<BudgetSegment>(trial.value.segment.id)!;
  spend(store,segment,'measured-call',200_000);
  const reservation=reserveResearchCall(store,segment,'unknown-call',['block'],
    {kind:'estimated',tokens:150_000,basis:[reference(segment)],explanation:'Unknown usage keeps this reserve'});
  store.writeMany([{id:'unknown-call',kind:'model-call',expected:0,value:{...modelCall('unknown-call'),status:'failed',finishedAt:3}},...reservation.writes],reservation.guards);
  const report=modelUsage(store,'p',0).budgets.find(item=>item.key===request.key)!;
  assert.equal(report.measured,200_000);assert.equal(report.reserved,150_000);
  assert.equal(report.remaining,19_650_000);assert.equal(report.unmeasuredCalls,1);
  assert.deepEqual(report.groups,[{group:'block',limit:800_000,measured:200_000,reserved:150_000,remaining:450_000,calls:2,unmeasuredCalls:1}]);
  assert.equal(store.list('research-trial').length,1);
});

test('explicit allocation creates a prospective capped segment, preserving old spending and the existing phase permission', t => {
  for (const boundary of ['L2', 'L3', 'compilation'] as const) {
    const { store, pilot, policy, oldSegment, request } = fixture(t, boundary);
    spend(store, oldSegment, 'old-call', 100_000);
    const oldUsage = budgetUsage(store, oldSegment);
    const oldCall = store.get('old-call');
    const trial = allocateResearchTrial(store, 'p', request);
    const segment = store.get<BudgetSegment>(trial.value.segment.id)!;
    assert.deepEqual(segment.value, { projectId: 'p', key: request.key, limit: 20_000_000,
      initialGroupLimit: 800_000, ownerGroupCeiling: 800_000 });
    assert.deepEqual(reference(segment), trial.value.segment);
    assert.deepEqual(trial.value.previousPolicy, reference(policy));
    assert.deepEqual(trial.value.previousSegment, reference(oldSegment));
    assert.deepEqual(trial.value.pilot, reference(pilot));
    assert.deepEqual(reference(phasePolicy(store, 'p')!), trial.value.policy);
    assert.equal(phasePolicy(store, 'p')!.value.stopAfter, boundary);
    assert.equal(budgetUsage(store, segment).remaining, 20_000_000);
    assert.deepEqual(budgetUsage(store, oldSegment), oldUsage);
    assert.deepEqual(store.get('old-call'), oldCall);
    assert.deepEqual(store.get(policy.id, policy.revision), policy);
    assert.throws(() => configurePhasePolicy(store, 'p', boundary, 'ordinary-reset', trial.value.policy.revision),
      { code: 'budget_segment_changed' });
  }
});

test('identical retries after spending or a later trial return the original allocation without granting tokens', t => {
  const { store, request } = fixture(t);
  const first = allocateResearchTrial(store, 'p', request);
  const segment = store.get<BudgetSegment>(first.value.segment.id)!;
  spend(store, segment, 'spent', 800_000);
  const afterSpend = store.list().map(reference);
  assert.deepEqual(allocateResearchTrial(store, 'p', request), first);
  assert.deepEqual(store.list().map(reference), afterSpend);
  assert.equal(budgetUsage(store, segment).remaining, 19_200_000);
  assert.throws(() => allocateResearchTrial(store, 'p', { ...request, limit: 21_000_000 }), { code: 'budget_trial_conflict' });
  assert.throws(() => allocateResearchTrial(store, 'p', { ...request, previousPolicy: first.value.policy }), { code: 'budget_trial_conflict' });
  const next = allocateResearchTrial(store, 'p', { ...request, key: 'later-trial', previousPolicy: first.value.policy });
  const afterNext = store.list().map(reference);
  assert.deepEqual(allocateResearchTrial(store, 'p', request), first);
  assert.deepEqual(store.list().map(reference), afterNext);
  assert.deepEqual(reference(phasePolicy(store, 'p')!), next.value.policy);
});

test('missing, stale and forged bindings or invalid limits cannot allocate a segment', t => {
  const { store, request, pilot, policy } = fixture(t);
  for (const change of [{ previousPolicy: null }, { key: '' }, { key: ' new-trial' }, { limit: 0 }, { blockLimit: 0 },
    { blockLimit: 20_000_001 }, { limit: 1.5 }]) {
    assert.throws(() => allocateResearchTrial(store, 'p', { ...request, ...change } as ResearchTrialRequest), { code: 'budget_trial_invalid' });
  }
  assert.throws(() => allocateResearchTrial(store, 'p', { ...request, previousPolicy: { ...request.previousPolicy, hash: '0'.repeat(64) } }),
    { code: 'budget_trial_policy_stale' });
  assert.throws(() => allocateResearchTrial(store, 'foreign', request), { code: 'budget_trial_policy_stale' });
  configurePhasePolicy(store, 'p', 'compilation', 'old', policy.revision);
  assert.throws(() => allocateResearchTrial(store, 'p', request), { code: 'budget_trial_policy_stale' });
  store.write({ id: pilot.id, kind: pilot.kind, expected: pilot.revision, value: { ...pilot.value, active: false } });
  assert.throws(() => allocateResearchTrial(store, 'p', { ...request, previousPolicy: reference(phasePolicy(store, 'p')!) }),
    { code: 'budget_trial_pilot_missing' });
  assert.equal(store.get(segmentId('p', request.key)), null);
  assert.equal(store.list('research-trial').length, 0);
});

test('an existing spent or unspent segment and an orphan ledger cannot be adopted as a new trial', t => {
  const { store, request, oldSegment } = fixture(t);
  spend(store, oldSegment, 'old-spent', 500_000);
  assert.throws(() => allocateResearchTrial(store, 'p', { ...request, key: 'old' }), { code: 'budget_trial_segment_reused' });
  configureBudgetSegment(store, 'p', 'unused');
  assert.throws(() => allocateResearchTrial(store, 'p', { ...request, key: 'unused' }), { code: 'budget_trial_segment_reused' });
  const orphanId = segmentId('p', 'orphan');
  store.write({ id: `research-budget-ledger:${hashJson(orphanId)}`, kind: 'research-budget-ledger', expected: 0,
    value: { projectId: 'p', segment: orphanId, assignments: [] } });
  assert.throws(() => allocateResearchTrial(store, 'p', { ...request, key: 'orphan' }), { code: 'budget_trial_segment_reused' });
  assert.equal(phasePolicy(store, 'p')!.value.budgetSegment, 'old');
});

test('any running project model call blocks the switch, while another project and completed unknown calls do not', t => {
  const { store, request } = fixture(t);
  const active = store.write<ModelCall>({ id: 'active', kind: 'model-call', expected: 0,
    value: { ...modelCall('active'), purpose: 'non-research-review' } });
  assert.throws(() => allocateResearchTrial(store, 'p', request), { code: 'budget_trial_call_running' });
  store.write({ id: active.id, kind: active.kind, expected: active.revision, value: { ...active.value, status: 'failed', finishedAt: 2 } });
  store.write({ id: 'foreign-active', kind: 'model-call', expected: 0, value: modelCall('foreign-active', 'foreign') });
  assert.doesNotThrow(() => allocateResearchTrial(store, 'p', request));
  assert.equal(store.get<ModelCall>(active.id)!.value.usage, null);
});

test('dispatch racing the no-running scan wins the shared counter and rolls back the entire allocation', t => {
  for (const existingCounter of [false, true]) {
    const { store, request, policy } = fixture(t);
    const other = new Store(store.path); t.after(() => other.close());
    const id = `project-dispatch:${hashJson('p')}`;
    if (existingCounter) other.write({ id, kind: 'project-dispatch', expected: 0, value: { projectId: 'p', serial: 4 } });
    beforeCommit(store, () => {
      const current = other.get<{ projectId: string; serial: number }>(id);
      other.writeMany([{ id: 'racing-call', kind: 'model-call', expected: 0, value: modelCall('racing-call') },
        { id, kind: 'project-dispatch', expected: current?.revision ?? 0, value: { projectId: 'p', serial: (current?.value.serial ?? 0) + 1 } }]);
    });
    assert.throws(() => allocateResearchTrial(store, 'p', request), { code: 'revision_conflict' });
    assert.equal(store.get(segmentId('p', request.key)), null);
    assert.equal(store.list('research-trial').length, 0);
    assert.deepEqual(phasePolicy(store, 'p'), policy);
    assert.equal(store.get<ModelCall>('racing-call')!.value.status, 'running');
  }
});

test('an allocation winning the race prevents an earlier dispatch from writing against its old project counter', t => {
  const { store, request } = fixture(t);
  const id = `project-dispatch:${hashJson('p')}`;
  const counter = store.get(id);
  allocateResearchTrial(store, 'p', request);
  assert.throws(() => store.writeMany([{ id: 'stale-call', kind: 'model-call', expected: 0, value: modelCall('stale-call') },
    { id, kind: 'project-dispatch', expected: counter?.revision ?? 0, value: { projectId: 'p', serial: 1 } }]), { code: 'revision_conflict' });
  assert.equal(store.get('stale-call'), null);
});

test('pilot and policy races are rejected atomically with no partial segment or allocation', t => {
  for (const changed of ['pilot', 'policy'] as const) {
    const { store, request, pilot, policy } = fixture(t);
    const other = new Store(store.path); t.after(() => other.close());
    beforeCommit(store, () => {
      if (changed === 'pilot') other.write({ id: pilot.id, kind: pilot.kind, expected: pilot.revision,
        value: { ...pilot.value, maxReadChars: 50_000 } });
      else configurePhasePolicy(other, 'p', 'compilation', 'old', policy.revision);
    });
    assert.throws(() => allocateResearchTrial(store, 'p', request), { code: 'input_stale' });
    assert.equal(store.get(segmentId('p', request.key)), null);
    assert.equal(store.list('research-trial').length, 0);
  }
});

test('concurrent identical allocation requests converge to one segment and one policy transition', t => {
  const { store, request } = fixture(t);
  const other = new Store(store.path); t.after(() => other.close());
  beforeCommit(store, () => { allocateResearchTrial(other, 'p', request); });
  const result = allocateResearchTrial(store, 'p', request);
  assert.equal(store.list('research-trial').length, 1);
  assert.equal(store.get(result.value.segment.id)!.revision, 1);
  assert.equal(phasePolicy(store, 'p')!.revision, request.previousPolicy.revision + 1);
  assert.equal(store.get<{ serial: number }>(`project-dispatch:${hashJson('p')}`)!.value.serial, 1);
});
