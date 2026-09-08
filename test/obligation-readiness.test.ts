import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { git } from '../src/runtime/environment.js';
import { reference } from '../src/pipeline/contracts.js';
import { preparedFeatures } from './product-fixture.js';
import { answerTechnicalFixture } from './technical-research-fixture.js';
import { deriveLayerFixture } from './layer-design-fixture.js';
import { configureResearchScope } from '../src/graph/research-scope.js';
import type { ObligationPolicy, RuntimeCheck } from '../src/graph/obligation-policy.js';
import type { RuntimeObservationResult } from '../src/runtime/runtime-observation.js';
import type { Feasibility } from '../src/graph/refinement.js';
import { readinessObligations } from '../src/graph/obligation-readiness.js';
import { obligationHandoff } from '../src/graph/obligation-handoff.js';

function fixture(t: test.TestContext, { exit = 0, certifies = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-readiness-'))), workspace = join(root, 'repo'); mkdirSync(workspace);
  git(workspace, ['init', '-b', 'main']); writeFileSync(join(workspace, 'README.md'), 'Fixture baseline\n');
  git(workspace, ['add', '.']); git(workspace, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline']);
  const store = new Store(join(root, 'db.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  preparedFeatures(engine, 'p');
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = engine.environments.configure('p', { workspace, implementer: { actor: 'worker', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 3000 }, 0);
  const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0); engine.refinement.sealLayer('p', 1, 0);
  const gaps = [{ id: 'runtime-ready', target: 'p-produce-block', consumer: 'compilation', field: 'tests', requiredFor: 'next' as const, question: 'Check the exact local fixture runtime before R3' },
    { id: 'future-result', target: 'p-consume-block', consumer: 'compilation', field: 'tests', requiredFor: 'next' as const, question: 'Accept the future implementation only with its actual result' }];
  const r1 = engine.refinement.begin('p', 'R1');
  answerTechnicalFixture(engine, 'p', r1, (field, report) => field === 'runtime' ? { ...report, gaps } : report);
  const r1Phase = engine.refinement.finishResearch('p', 'R1', reference(store.get(r1.id)!), 0);
  deriveLayerFixture(engine, 'p', 2); engine.refinement.sealLayer('p', 2, 0);
  const original = configureResearchScope(store, { projectId: 'p', layer: reference(store.get('graph-layer:p:2')!), r1: reference(r1Phase),
    outcome: 'A bounded local fixture', nodes: gaps.map(gap => gap.target), boundaries: [], expansions: [], changedPaths: [], uiRequired: false,
    obligations: gaps.map(gap => ({ gap, state: 'active', reason: 'Approved fixture scope', wake: null })) }, 0);
  const condition = 'Before R3, verify the declared local fixture invocation succeeds';
  const code = engine.discovery.evidence.document('p', 'readiness-check',
    `import{readFileSync}from'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({fixture:true,obligation:input.obligation,root:input.runtime.root}));process.exitCode=${exit};`, 'text/plain', 0);
  const check: RuntimeCheck = { script: reference(code), dependencies: [], subjects: [], executables: [], args: [], timeoutMs: 3000,
    purpose: 'Check a local fixture, not the actual Codex runtime', ...(certifies ? { satisfies: condition } : {}) };
  const policy: ObligationPolicy = { version: 1, sourceScope: reference(original), assignments: gaps.map((gap, index) => ({
    obligation: gap.id, original: { record: reference(original), pointer: `/obligations/${index}/gap` },
    kind: index === 0 ? 'environment-confirmation' : 'post-implementation-proof', moment: index === 0 ? 'R3' : 'task-result',
    responsibleNode: gap.target, responsibleConsumer: gap.consumer, neededForR2: false, reason: 'The R2 design does not depend on an executed result',
    returnCondition: index === 0 ? condition : 'When accepting the generated consumer task, check the real output', ...(index === 0 ? { runtimeCheck: check } : {}) })) };
  const scope = configureResearchScope(store, { ...original.value, policy }, 1);
  const r2 = engine.refinement.begin('p', 'R2'); answerTechnicalFixture(engine, 'p', r2);
  const r2Phase = engine.refinement.finishResearch('p', 'R2', reference(store.get(r2.id)!), 0);
  deriveLayerFixture(engine, 'p', 3); const l3 = engine.refinement.sealLayer('p', 3, 0);
  const observe = (key = 'ready') => engine.execute({ type: 'observe-runtime', project: 'p', scope: reference(scope), obligation: 'runtime-ready', key }) as Promise<RuntimeObservationResult>;
  const assess = () => engine.refinement.assess('p', store.get('feasibility:p')?.revision ?? 0);
  const gate = (record: Revision<Feasibility>) => engine.refinement.feasibilityGate('p', reference(record));
  return { root, workspace, store, engine, environment, scope, original, policy, code, check, r2Phase, l3, observe, assess, gate };
}

test('R3 requires actual declared confirmation and retains future result debt without demanding its implementation', async t => {
  const f = fixture(t), blocked = f.assess();
  assert.equal(blocked.value.ready, false);
  assert.deepEqual(blocked.value.findings.map(finding => finding.code), ['environment_confirmation_required']);
  assert.equal(blocked.value.obligations!.handoff.obligations.length, 2);
  assert.equal(f.store.list('model-call').length, 0);
  const observed = await f.observe(); assert.equal(observed.observation.value.status, 'observed');
  const ready = f.assess(); assert.equal(ready.value.ready, true); assert.deepEqual(f.gate(ready).findings, []);
  assert.equal(ready.value.obligations!.confirmations.length, 1);
  assert.equal(ready.value.obligations!.handoff.obligations.find(item => item.obligation === 'future-result')!.moment, 'task-result');
  assert.ok(ready.value.inputs.some(ref => ref.id === observed.observation.id));
  const stage = f.engine.refinement.publish('p', reference(ready), 0); f.engine.pipeline.accept('p', 'om-g2', stage.revision);
  const plan = f.engine.compiler.compile('p'); assert.deepEqual(f.engine.compiler.gate('p', reference(plan)).findings, []);
  assert.equal(f.store.list('task-run').length, 0, 'A plan assigning future work is accepted before its implementation');
  assert.equal(f.store.list('model-call').length, 0, 'R3 and compilation launch no new probe or model call');
});

test('exit zero without explicit certification and nonzero certified checks do not declare R3 ready', async t => {
  for (const options of [{ certifies: false }, { exit: 7 }]) {
    const f = fixture(t, options); await f.observe(); const result = f.assess();
    assert.equal(result.value.ready, false); assert.ok(result.value.findings.some(item => item.code === 'environment_confirmation_required'));
    assert.throws(() => f.engine.refinement.publish('p', reference(result), 0), { code: 'feasibility_not_ready' });
  }
});

test('missing or altered R3 handoff and forged confirmation references give typed refusals', async t => {
  const f = fixture(t); await f.observe(); const ready = f.assess();
  for (const mutate of [
    (value: any) => { delete value.obligations; },
    (value: any) => { value.obligations = null; },
    (value: any) => { value.obligations.handoff.obligations.pop(); },
    (value: any) => { value.obligations.handoff.obligations[0].moment = 'task-result'; },
    (value: any) => { value.obligations.confirmations = []; },
    (value: any) => { value.obligations.confirmations[0] = null; },
    (value: any) => { value.obligations.confirmations[0].source.hash = '0'.repeat(64); },
    (value: any) => { value.obligations.confirmations[0].observation.hash = '0'.repeat(64); },
    (value: any) => { value.inputs = value.inputs.filter((ref: any) => ref.id !== 'phase:p:R2'); },
  ]) {
    const value = structuredClone(ready.value); mutate(value);
    const changed = f.store.write<Feasibility>({ id: ready.id, kind: ready.kind, expected: f.store.get(ready.id)!.revision, value });
    assert.ok(f.gate(changed).findings.some(item => /obligation|confirmation/.test(item.code)));
    assert.throws(() => f.engine.refinement.publish('p', reference(changed), 0), { code: 'feasibility_not_ready' });
  }
});

test('a changed observation source invalidates publish, pipeline acceptance and direct plan admission', async t => {
  const f = fixture(t), observed = await f.observe(), ready = f.assess();
  const stage = f.engine.refinement.publish('p', reference(ready), 0); f.engine.pipeline.accept('p', 'om-g2', stage.revision);
  const plan = f.engine.compiler.compile('p');
  const source = observed.source!;
  f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: { ...source.value, content: '{"exitCode":0}' } });
  assert.ok(f.gate(ready).findings.some(item => item.code === 'environment_confirmation_required'));
  assert.ok(f.engine.compiler.gate('p', reference(plan)).findings.some(item => item.code === 'environment_confirmation_required'));
  assert.notEqual(f.engine.pipeline.inspect('p', 'om-g2').state, 'accepted');
  assert.throws(() => f.engine.compiler.compile('p'), { code: 'om_not_ready' });
});

test('another obligation with the same check cannot supply R3 confirmation and the owner must name the exact return condition', async t => {
  const f = fixture(t), observed = await f.observe(), inputs = [reference(f.r2Phase), reference(f.l3)];
  const handoff = obligationHandoff(f.store, 'p', inputs)!;
  const renamed = structuredClone(f.policy); renamed.assignments[0]!.runtimeCheck!.satisfies = 'A weaker condition';
  assert.throws(() => configureResearchScope(f.store, { ...f.scope.value, policy: renamed }, f.scope.revision), { code: 'obligation_runtime_condition_invalid' });
  const current = f.store.get<any>(f.r2Phase.id)!;
  f.store.write({ id: current.id, kind: current.kind, expected: current.revision,
    value: { ...current.value, carried: current.value.carried.map((item: any) => ({ ...item, responsibleConsumer: 'other' })) } });
  assert.throws(() => obligationHandoff(f.store, 'p', [reference(f.store.get(current.id)!)]), { code: 'research_obligation_handoff_invalid' });
  assert.deepEqual(obligationHandoff(f.store, 'p', inputs), handoff, 'Historical R2 is not reinterpreted by a later head');
  const record = observed.observation;
  f.store.write({ id: record.id, kind: record.kind, expected: record.revision, value: { ...record.value, requestedFor: 'another-obligation' } });
  assert.ok(readinessObligations(f.store, 'p', inputs).findings.some(item => item.code === 'environment_confirmation_required'));
});

test('an environment change in the write window prevents R3 from storing ready=true', async t => {
  const f = fixture(t); await f.observe();
  const original = f.store.writeMany.bind(f.store); let intercepted = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!intercepted && writes.some(write => write.kind === 'feasibility')) {
      intercepted = true;
      original([{ id: f.environment.id, kind: f.environment.kind, expected: f.environment.revision, value: f.environment.value }]);
    }
    return original(writes, guards);
  }) as Store['writeMany'];
  assert.throws(() => f.assess(), { code: 'input_stale' });
  assert.equal(f.store.get('feasibility:p'), null);
});

test('a later failed observation supersedes an old success even when no new source was published', async t => {
  const f = fixture(t), observed = await f.observe(), ready = f.assess();
  const record = observed.observation;
  const later = f.store.write({ id: 'runtime-observation:later-fixture', kind: record.kind, expected: 0,
    value: { ...record.value, key: 'later-fixture', startedAt: record.value.startedAt + 1, status: 'failed', result: null, error: 'runtime_observation_interrupted' } });
  assert.ok(f.gate(ready).findings.some(item => item.code === 'environment_confirmation_required'));
  assert.equal(f.assess().value.ready, false);
  assert.equal(f.store.list('source').some(source => source.id === later.id), false);
});

test('a concurrent observer start prevents sealing a previously successful observation as current', async t => {
  const f = fixture(t); await f.observe();
  const original = f.store.writeMany.bind(f.store); let intercepted = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!intercepted && writes.some(write => write.kind === 'feasibility')) {
      intercepted = true; const dispatch = f.store.list<any>('project-dispatch')[0]!;
      original([{ id: dispatch.id, kind: dispatch.kind, expected: dispatch.revision, value: { ...dispatch.value, serial: dispatch.value.serial + 1 } }]);
    }
    return original(writes, guards);
  }) as Store['writeMany'];
  assert.throws(() => f.assess(), { code: 'input_stale' }); assert.equal(f.store.get('feasibility:p'), null);
});

test('transient dispatch guards protect stage acceptance without becoming permanent plan dependencies', async t => {
  const f = fixture(t); await f.observe(); const ready = f.assess();
  const draft = f.engine.refinement.publish('p', reference(ready), 0);
  const original = f.store.writeMany.bind(f.store); let intercepted = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!intercepted && writes.some(write => write.kind === 'stage' && write.value.status === 'accepted')) {
      intercepted = true; const dispatch = f.store.list<any>('project-dispatch')[0]!;
      original([{ id: dispatch.id, kind: dispatch.kind, expected: dispatch.revision, value: { ...dispatch.value, serial: dispatch.value.serial + 1 } }]);
    }
    return original(writes, guards);
  }) as Store['writeMany'];
  assert.throws(() => f.engine.pipeline.accept('p', 'om-g2', draft.revision), { code: 'input_stale' });
  const accepted = f.engine.pipeline.accept('p', 'om-g2', draft.revision), plan = f.engine.compiler.compile('p');
  assert.ok(!accepted.value.proofs.some(ref => ref.id.startsWith('project-dispatch:')));
  assert.ok(!plan.value.guards.some(ref => ref.id.startsWith('project-dispatch:')));
  const dispatch = f.store.list<any>('project-dispatch')[0]!;
  f.store.write({ id: dispatch.id, kind: dispatch.kind, expected: dispatch.revision, value: { ...dispatch.value, serial: dispatch.value.serial + 1 } });
  assert.deepEqual(f.engine.compiler.gate('p', reference(plan)).findings, []);
  assert.equal(f.engine.pipeline.inspect('p', 'om-g2').state, 'accepted');
});
