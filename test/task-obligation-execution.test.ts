import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { executionFixture } from './execution-fixture.js';
import { answerTechnicalFixture } from './technical-research-fixture.js';
import { deriveLayerFixture } from './layer-design-fixture.js';
import { reference } from '../src/pipeline/contracts.js';
import { configureResearchScope } from '../src/graph/research-scope.js';
import { carriedObligations, type ObligationPolicy } from '../src/graph/obligation-policy.js';
import { taskBindingId } from '../src/graph/task-obligations.js';
import { type Graph } from '../src/graph/model.js';
import { type TaskRun } from '../src/execution/model.js';
import { type ExecutionRoot, git } from '../src/runtime/environment.js';
import { type RuntimeObservationResult } from '../src/runtime/runtime-observation.js';
import { requireTaskObligationProofs, requirePlanTaskObligations } from '../src/execution/task-obligations.js';
import { resultGate } from '../src/execution/result.js';
import { Executor } from '../src/execution/runner.js';
import { receiptId } from '../src/compiler/model.js';
import { Owners } from '../src/ownership/owners.js';

function fixture(t: test.TestContext) {
  let condition = '';
  const f = executionFixture(t, 'normal', engine => {
    const store = engine.store;
    condition = join(dirname(store.path), 'condition.txt'); writeFileSync(condition, 'ready');
    const r0 = engine.refinement.begin('p', 'R0'); engine.refinement.finishResearch('p', 'R0', reference(r0), 0); engine.refinement.sealLayer('p', 1, 0);
    const gaps = ['start', 'result', 'implementation'].map(id => ({ id, target: 'p-produce-block', consumer: 'compilation', field: 'tests',
      requiredFor: 'next' as const, question: `Check the actual ${id} of the producer task at its declared moment` }));
    const r1 = engine.refinement.begin('p', 'R1'); answerTechnicalFixture(engine, 'p', r1, (field, report) => field === 'runtime' ? { ...report, gaps } : report);
    const phase = engine.refinement.finishResearch('p', 'R1', reference(store.get(r1.id)!), 0);
    deriveLayerFixture(engine, 'p', 2); engine.refinement.sealLayer('p', 2, 0);
    const original = configureResearchScope(store, { projectId: 'p', r1: reference(phase), layer: reference(store.get('graph-layer:p:2')!),
      outcome: 'Produce and consume numeric results with exact late obligations', nodes: ['p-produce-block'], boundaries: [], expansions: [], changedPaths: [], uiRequired: false,
      obligations: gaps.map(gap => ({ gap, state: 'active', reason: 'Approved local fixture', wake: null })) }, 0);
    const script = engine.discovery.evidence.document('p', 'task-check',
      "import{readFileSync}from'node:fs';process.exitCode=readFileSync(process.argv.at(-1),'utf8')==='ready'?0:7;", 'text/plain', 0);
    const policy: ObligationPolicy = { version: 1, sourceScope: reference(original), assignments: gaps.map((gap, index) => ({
      obligation: gap.id, original: { record: reference(original), pointer: `/obligations/${index}/gap` },
      kind: gap.id === 'implementation' ? 'post-implementation-proof' : 'environment-confirmation',
      moment: gap.id === 'start' ? 'task-start' : 'task-result', responsibleNode: gap.target, responsibleConsumer: gap.consumer,
      neededForR2: false, reason: 'The future runtime and implementation do not decide the R2 design', returnCondition: `Verify actual ${gap.id} for this producer task`,
      ...(gap.id === 'implementation' ? {} : { runtimeCheck: { script: reference(script), dependencies: [], subjects: [condition], executables: [], args: [condition], timeoutMs: 3000,
        purpose: 'A controlled local execution fixture', satisfies: `Verify actual ${gap.id} for this producer task` } }) })) };
    const scope = configureResearchScope(store, { ...original.value, policy }, 1);
    const r2 = engine.refinement.begin('p', 'R2'); answerTechnicalFixture(engine, 'p', r2);
    engine.refinement.finishResearch('p', 'R2', reference(store.get(r2.id)!), 0);
    const graph = store.get<Graph>('graph:p')!;
    engine.graphs.save('p', { ...graph.value, researchObligations: carriedObligations(scope).map(item => ({ id: taskBindingId(item), scope: item.scope,
      obligation: item.obligation, consumers: [{ node: 'p-produce-work', tests: item.kind === 'post-implementation-proof' ? ['p-produce-work-test'] : [] }] })) }, graph.revision, 'fixture');
    deriveLayerFixture(engine, 'p', 3); engine.refinement.sealLayer('p', 3, 0);
  });
  const observe = (obligation: string, key = obligation) => f.engine.execute({ type: 'observe-runtime', project: 'p',
    scope: reference(f.store.get('research-scope:p:R2')!), obligation, key }) as Promise<RuntimeObservationResult>;
  const run = (retry = false) => f.engine.executor.run('p', reference(f.plan), { ...f.options, retry });
  const prepare = async () => {
    await assert.rejects(run(), { code: 'task_obligation_start_required' });
    const observation = await observe('start'); assert.equal(observation.observation.value.status, 'observed');
  };
  return { ...f, condition, observe, run, prepare };
}

test('task start refuses missing evidence; late result waits and resumes without rerunning implementation, tests or review', async t => {
  const f = fixture(t); await f.prepare();
  assert.equal(f.calls().length, 0); assert.equal(f.store.list('task-run').length, 0);
  const waiting = (await f.run())[0]!;
  assert.equal(waiting.value.state, 'awaiting_obligation'); assert.match(waiting.value.error!, /task_obligation_result_required/);
  assert.equal(f.calls().length, 2); assert.equal(waiting.value.attempt, 1); assert.ok(waiting.value.tree);
  assert.equal(f.store.get(receiptId('p', 'p-data')), null);
  const again = (await f.run(true))[0]!; assert.equal(again.value.state, 'awaiting_obligation'); assert.equal(f.calls().length, 2);
  assert.deepEqual(again.value.checks, waiting.value.checks);
  await f.observe('result'); const completed = await f.run(true);
  assert.deepEqual(completed.map(item => item.value.state), ['committed', 'committed']);
  assert.equal(completed[0]!.value.attempt, 1); assert.deepEqual(completed[0]!.value.checks, waiting.value.checks); assert.equal(f.calls().length, 4);
  assert.equal(completed[0]!.value.obligationStartProofs!.length, 1);
  assert.equal(completed[0]!.value.obligationResultProofs!.length, 2);
  assert.deepEqual(resultGate(f.store, 'p', reference(f.store.list('execution-result')[0]!)).findings, []);
});

test('a changed runtime subject after storing start admission pauses before any agent dispatch', async t => {
  const f = fixture(t); await f.prepare();
  const original = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    const result = original(writes, guards);
    if (!changed && writes.some(write => write.kind === 'task-run' && write.value.obligationStartProofs?.length)) {
      changed = true; writeFileSync(f.condition, 'changed after admission');
    }
    return result;
  }) as typeof f.store.writeMany;
  const result = (await f.run())[0]!;
  assert.equal(result.value.state, 'awaiting_obligation'); assert.match(result.value.error!, /task_obligation_start_stale/);
  assert.equal(f.calls().length, 0); assert.equal(result.value.tree, null);
  writeFileSync(f.condition, 'ready'); await f.observe('start', 'restored-start');
  const resumed = (await f.run(true))[0]!; assert.equal(resumed.value.state, 'awaiting_obligation'); assert.ok(resumed.value.tree); assert.equal(f.calls().length, 2);
});

test('accepted task proofs reject missing, altered and foreign test/consumer/candidate evidence and survive later environment changes', async t => {
  const f = fixture(t); await f.prepare(); await f.observe('result');
  const runs = await f.run(), run = runs[0]!.value, task = f.plan.value.tasks[0]!;
  assert.equal(run.state, 'committed');
  requireTaskObligationProofs(f.store, run, task);
  for (const mutate of [
    (value: any) => { delete value.obligationStartProofs; },
    (value: any) => { value.obligationStartProofs = []; },
    (value: any) => { value.obligationStartProofs = [null]; },
    (value: any) => { value.obligationStartProofs[0].confirmation.source.hash = '0'.repeat(64); },
    (value: any) => { value.obligationResultProofs = []; },
    (value: any) => { value.obligationResultProofs[0].subject = 'foreign candidate'; },
    (value: any) => { value.obligationResultProofs.find((proof: any) => proof.kind === 'implementation').tests[0].checks[0].result = 'invented'; },
    (value: any) => { value.taskId = f.plan.value.tasks[1]!.id; },
  ]) {
    const value = structuredClone(run); mutate(value);
    assert.throws(() => requireTaskObligationProofs(f.store, value, task), error => error instanceof Error && /task_obligation_/.test((error as any).code));
  }
  const omitted = structuredClone(task); delete omitted.researchObligations;
  assert.throws(() => requirePlanTaskObligations(f.store, f.plan.value, omitted), { code: 'task_obligation_plan_foreign' });
  const root = f.store.get<ExecutionRoot>('execution-root:p')!.value;
  assert.ok(new Owners(f.store, 'p', { root: root.path, head: root.head }).latest('produce.mjs'));
  writeFileSync(f.condition, 'runtime changed after acceptance');
  requireTaskObligationProofs(f.store, run, task);
  assert.deepEqual(resultGate(f.store, 'p', reference(f.store.list('execution-result')[0]!)).findings, []);
  const forged = f.store.write({ id: runs[0]!.id, kind: runs[0]!.kind, expected: runs[0]!.revision, value: { ...run, obligationStartProofs: [] } });
  assert.throws(() => new Owners(f.store, 'p', { root: root.path, head: root.head }).latest('produce.mjs'), { code: 'task_obligation_proof_missing' });
  const result = f.store.list<any>('execution-result')[0]!;
  const changed = f.store.write({ id: result.id, kind: result.kind, expected: result.revision,
    value: { ...result.value, runs: result.value.runs.map((ref: any) => ref.id === forged.id ? reference(forged) : ref) } });
  assert.ok(resultGate(f.store, 'p', reference(changed)).findings.some(item => item.code === 'execution_proof_invalid'));
});

test('a waiting candidate changed by an operator cannot borrow prior test results or review', async t => {
  const f = fixture(t); await f.prepare(); const waiting = (await f.run())[0]!;
  const root = f.store.get<ExecutionRoot>('execution-root:p')!;
  writeFileSync(join(root.value.path, 'produce.mjs'), 'export const produce=n=>n+999;\n');
  await f.observe('result'); const rejected = (await f.run(true))[0]!;
  assert.equal(rejected.value.state, 'interrupted'); assert.match(rejected.value.error!, /task_obligation_candidate_changed/);
  assert.equal(rejected.value.tree, waiting.value.tree); assert.equal(f.calls().length, 2);
  assert.equal(git(root.value.path, ['rev-parse', 'HEAD']), f.initial);
});

test('a crash after Git publication recovers frozen task admission without repeating already paid work', async t => {
  const f = fixture(t); await f.prepare(); await f.observe('result');
  const executor = new Executor(f.store, f.engine.compiler, f.engine.environments, () => { throw new Error('fixture crash after publication'); });
  await assert.rejects(executor.run('p', reference(f.plan), f.options), /fixture crash/);
  const pending = f.store.list<TaskRun>('task-run')[0]!;
  assert.equal(pending.value.state, 'commit_pending'); assert.equal(f.calls().length, 2);
  writeFileSync(f.condition, 'changed after publication');
  const recovered = await f.engine.executor.recover('p');
  assert.equal(recovered[0]!.value.state, 'committed'); assert.equal(recovered[0]!.value.commit, pending.value.commit); assert.equal(f.calls().length, 2);
});

test('changing environment records in the intent write window pauses without automatic code correction', async t => {
  const f = fixture(t); await f.prepare(); await f.observe('result');
  const original = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!changed && writes.some(write => write.kind === 'task-run' && write.value.state === 'commit_pending')) {
      changed = true; const environment = f.store.get('environment:p')!;
      original([{ id: environment.id, kind: environment.kind, expected: environment.revision, value: environment.value }]);
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  const runs = await f.engine.executor.run('p', reference(f.plan), { ...f.options, maxCorrections: 3 });
  assert.equal(runs[0]!.value.state, 'awaiting_obligation'); assert.equal(f.calls().length, 2); assert.equal(runs[0]!.value.attempt, 1);
});

test('a physical change after intent storage blocks publication and renews only the late proof on recovery', async t => {
  const f = fixture(t); await f.prepare(); await f.observe('result');
  const original = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    const result = original(writes, guards);
    if (!changed && writes.some(write => write.kind === 'task-run' && write.value.state === 'commit_pending')) {
      changed = true; writeFileSync(f.condition, 'changed before Git publication');
    }
    return result;
  }) as typeof f.store.writeMany;
  await assert.rejects(f.run(), { code: 'task_obligation_result_required' });
  const pending = f.store.list<TaskRun>('task-run')[0]!, root = f.store.get<ExecutionRoot>('execution-root:p')!;
  assert.equal(pending.value.state, 'commit_pending'); assert.equal(git(root.value.path, ['rev-parse', 'HEAD']), f.initial);
  await assert.rejects(f.engine.executor.recover('p'), { code: 'task_obligation_result_required' }); assert.equal(f.calls().length, 2);
  writeFileSync(f.condition, 'ready'); await f.observe('result', 'restored-result');
  const recovered = await f.engine.executor.recover('p');
  assert.equal(recovered[0]!.value.state, 'committed'); assert.equal(recovered[0]!.value.commit, pending.value.commit);
  assert.deepEqual(recovered[0]!.value.checks, pending.value.checks); assert.equal(f.calls().length, 2);
  assert.notDeepEqual(recovered[0]!.value.obligationResultProofs, pending.value.obligationResultProofs);
});
