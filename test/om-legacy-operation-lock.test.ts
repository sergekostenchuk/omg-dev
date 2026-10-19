import { runIntegrityCheck, integrityGate } from "../src/om/integrity.js";
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { physicalClaim, readModelCallRecovery, recoverModelCall } from '../src/discovery/model-call-recovery.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import { EngineError } from '../src/errors.js';
import type { ParkedCandidate } from '../src/execution/park.js';
import { prepareOmInput, readOmInput, writeOmInput, type InputRequest } from '../src/om/input.js';
import { runModelTransport, type ModelTransportRequest } from '../src/om/model-call.js';
import { recordCall } from '../src/om/call-record.js';
import { openSeries, beginAttempt, completeAttempt, type RepairSeries } from '../src/om/series.js';
import { recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND } from '../src/om/refusal-journal.js';
import { closeAttempt } from '../src/om/repeat-gate.js';
import type { OmResult } from '../src/om/refusal.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { beginLegacyOperation, continuePreparation, finishLegacyOperation, readLegacyOperation, recoverLegacyOperation,
  type LegacyOperation } from '../src/product/preparation-run.js';
import { git, type ExecutionRoot } from '../src/runtime/environment.js';
import { modelUsage, type ModelCall, type ProcessIdentity } from '../src/runtime/model-usage.js';
import { processStart } from '../src/runtime/process-identity.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../src/storage/store.js';
import { executionFixture } from './execution-fixture.js';
import { deriveLayerFixture } from './layer-design-fixture.js';
import { preparedFeatures, refinedLayers } from './product-fixture.js';
import { answerTechnicalFixture } from './technical-research-fixture.js';

const BASE = 'f8136c12848747a99121d3e242f9ac9e2fc29603';
const markerId = 'legacy-operation:p';
const history = (store: Store) => canonical(store.list().flatMap(record => store.history(record.id)));
const request = (store: Store): InputRequest => ({ project: 'p', expected: 0,
  stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:p:${stage}`)!)])) as Record<UpstreamStage, Ref> });
function firstInput(store: Store) {
  const result = writeOmInput(store, request(store));
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function busyInput(store: Store) {
  const before = history(store), result = writeOmInput(store, request(store));
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.refusal.code, 'legacy_operation_active'); assert.equal(result.refusal.at.target, markerId); }
  assert.equal(history(store), before);
}
function addressed(codes: string[]) {
  return (error: unknown) => {
    assert.ok(error instanceof EngineError); assert.ok(codes.includes(error.code), error.code);
    assert.equal((error.details as { target?: unknown } | null)?.target, markerId); return true;
  };
}

function fixture(t: TestContext, research = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'omg-g14-'))), workspace = join(directory, 'repo');
  mkdirSync(workspace); git(workspace, ['init', '-b', 'main']);
  writeFileSync(join(workspace, 'README.md'), 'A local stateless transformation runtime is planned.\n');
  git(workspace, ['add', 'README.md']);
  git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial']);
  const database = join(directory, 'state.sqlite'), adapter = join(directory, 'adapter.mjs');
  const wire = join(directory, 'wire.ndjson'), received = join(directory, 'received.json'), resume = join(directory, 'resume');
  writeFileSync(adapter, `import{readFileSync,appendFileSync,writeFileSync,existsSync,watch}from'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),c=request.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify({pid:process.pid,requestId:request.requestId,role:c.role})+'\\n');
const gate=readFileSync(${JSON.stringify(join(directory, 'gate'))},'utf8');
if(c.role===gate){writeFileSync(${JSON.stringify(received)},JSON.stringify({pid:process.pid,requestId:request.requestId}));
 if(!existsSync(${JSON.stringify(resume)}))await new Promise(resolve=>{const w=watch(${JSON.stringify(directory)},()=>{if(existsSync(${JSON.stringify(resume)})){w.close();resolve();}});if(existsSync(${JSON.stringify(resume)})){w.close();resolve();}});}
let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else{const q=c.questions.find(q=>!['runtime','contractsAndConsumers'].includes(q.field))??c.questions[0];
 const source=(c.inventory?.sources??c.originals?.sources??[]).find(s=>s.kind==='file');
 research={action:'answer',question:q.id,value:{applicability:'applicable',reason:'The fixture has a local runtime',facts:[],
 designs:[{id:q.field+'-design',decision:'Keep the transformation stateless and scoped to its output',benefit:'The consumer receives one validated result',consumer:'compilation'}],gaps:[],...(q.basisContract==='typed-v1'?{documents:[]}:{})},
 citations:[{source:source.ref,selector:{kind:'text-range',start:0,end:source.length}}]};}
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research,
usage:{inputTokens:11,outputTokens:3,cachedInputTokens:2,reasoningOutputTokens:1}}));`);
  writeFileSync(join(directory, 'gate'), 'research');
  let store = new Store(database), engine = new ProductEngine(store);
  const drivers: Driver[] = [];
  t.after(async () => {
    for (const driver of drivers) await stopOwner(driver);
    for (const call of store.list<ModelCall>('model-call')) if (call.value.providerProcess) await stopProvider(call.value.providerProcess);
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  preparedFeatures(engine, 'p');
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure('p', { workspace, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 120_000 }, 0);
  if (research) {
    engine.discovery.evidence.file('p', 'runtime', workspace, 'README.md', 'text/plain', 0);
    for (const level of ['R0', 'R1'] as const) {
      const draft = engine.refinement.begin('p', level);
      if (level === 'R1') answerTechnicalFixture(engine, 'p', draft);
      engine.refinement.finishResearch('p', level, reference(store.get(draft.id)!), 0);
      if (level === 'R1') deriveLayerFixture(engine, 'p', 2);
      engine.refinement.sealLayer('p', level === 'R0' ? 1 : 2, 0);
    }
  } else refinedLayers(engine, 'p');
  return { directory, workspace, database, wire, received, resume, drivers, get store() { return store; }, get engine() { return engine; },
    reopen() { store.close(); store = new Store(database); engine = new ProductEngine(store); },
    sent: () => existsSync(wire) ? readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { requestId: string; role: string }) : [] };
}

function pendingPreparation(store: Store) {
  const prior = store.get('preparation-run:p'), value = { projectId: 'p', status: 'running', phase: 'R2', draft: null, plan: null,
    owner: { pid: process.pid, started: processStart(process.pid) }, error: null, code: null, findings: [], calls: 0 };
  const write: Write = { id: 'preparation-run:p', kind: 'preparation-run', expected: prior?.revision ?? 0, value };
  const basis: Ref = { id: write.id, revision: write.expected + 1, hash: hashJson(value) };
  return { write, basis };
}
function acquirePreparation(store: Store) {
  const pending = pendingPreparation(store);
  return beginLegacyOperation(store, 'p', 'prepare', pending.basis, [pending.write]);
}
function pauseAndRelease(store: Store, lease: Revision<LegacyOperation>) {
  const run = store.get<Record<string, unknown>>('preparation-run:p')!;
  const paused = store.write({ id: run.id, kind: run.kind, expected: run.revision,
    value: { ...run.value, status: 'paused', error: 'Local fixture pause', code: 'fixture_pause' } });
  return finishLegacyOperation(store, lease, reference(paused));
}

test('G1.4 first B1 and initial preparation acquisition exclude each other in both atomic orders', t => {
  for (const winner of ['B1', 'prepare'] as const) {
    const f = fixture(t), other = new Store(f.database); t.after(() => other.close());
    if (winner === 'B1') {
      const pending = pendingPreparation(f.store), original = f.store.writeMany.bind(f.store); let raced = false;
      f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
        if (!raced && writes.some(write => write.id === markerId)) { raced = true; firstInput(other); }
        return original(writes, guards);
      }) as Store['writeMany'];
      try { assert.throws(() => beginLegacyOperation(f.store, 'p', 'prepare', pending.basis, [pending.write]), { code: 'input_stale' }); }
      finally { f.store.writeMany = original; }
      assert.ok(raced); assert.equal(f.store.get(markerId), null); assert.equal(f.store.get(pending.write.id), null);
    } else {
      const prepared = prepareOmInput(f.store, request(f.store)); assert.ok(prepared.ok);
      assert.ok(prepared.value.guards.some(guard => guard.id === markerId && 'absent' in guard));
      const lease = acquirePreparation(other);
      assert.throws(() => f.store.writeMany([...prepared.value.writes, { id: 'neighbor', kind: 'fixture', expected: 0, value: {} }], [...prepared.value.guards]), { code: 'input_stale' });
      assert.equal(f.store.get('neighbor'), null); assert.equal(f.store.get('om-input:p'), null); busyInput(f.store);
      pauseAndRelease(other, lease); firstInput(f.store);
    }
  }
});

test('G1.4 concurrent acquisition, released-head guards and delayed token release survive restart', t => {
  const f = fixture(t), other = new Store(f.database); t.after(() => other.close());
  const pending = pendingPreparation(f.store), original = f.store.writeMany.bind(f.store); let first: Revision<LegacyOperation> | null = null;
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    if (!first && writes.some(write => write.id === markerId)) first = beginLegacyOperation(other, 'p', 'prepare', pending.basis, [pending.write]);
    return original(writes, guards);
  }) as Store['writeMany'];
  try { assert.throws(() => beginLegacyOperation(f.store, 'p', 'prepare', pending.basis, [pending.write]), error => error instanceof EngineError && ['revision_conflict', 'input_stale'].includes(error.code)); }
  finally { f.store.writeMany = original; }
  assert.ok(first); const initialLease = first as Revision<LegacyOperation>; assert.equal(f.store.history(markerId).length, 1);
  assert.throws(() => acquirePreparation(f.store), addressed(['legacy_operation_active']));
  const released = pauseAndRelease(f.store, initialLease);
  const prepared = prepareOmInput(f.store, request(f.store)); assert.ok(prepared.ok);
  assert.ok(prepared.value.guards.some(guard => canonical(guard) === canonical(reference(released))));
  const second = acquirePreparation(f.store); assert.notEqual(second.value.token, initialLease.value.token);
  assert.throws(() => f.store.writeMany([...prepared.value.writes], [...prepared.value.guards]), { code: 'input_stale' });
  f.reopen();
  const before = history(f.store);
  assert.throws(() => finishLegacyOperation(f.store, initialLease, null, new Error('Delayed fixture completion')), addressed(['legacy_operation_stale']));
  assert.equal(history(f.store), before); assert.deepEqual(readLegacyOperation(f.store, 'p'), second);
  assert.throws(() => finishLegacyOperation(f.store, { ...second, value: { ...second.value, token: 'foreign-token' } }, null, new Error('Fixture completion')), addressed(['legacy_operation_stale']));
  pauseAndRelease(f.store, second); firstInput(f.store);
});

test('G1.4 malformed markers and recovery commands cannot manufacture authority', async t => {
  const f = fixture(t), lease = acquirePreparation(f.store);
  for (const command of [
    { type: 'recover-legacy-operation', project: 'p' },
    { type: 'recover-legacy-operation', project: 'p', operation: reference(lease) },
    { type: 'recover-legacy-operation', project: 'p', operation: reference(lease), token: null },
  ]) assert.throws(() => f.engine.execute(command), { code: 'command_invalid' });
  const before = history(f.store);
  assert.throws(() => beginLegacyOperation(f.store, 'p', 'prepare', lease.value.basis, [null] as unknown as Write[]), addressed(['legacy_operation_invalid']));
  await assert.rejects(recoverLegacyOperation(f.engine, { project: 'p', operation: reference(lease), token: 'foreign' }), addressed(['legacy_operation_stale']));
  await assert.rejects(recoverLegacyOperation(f.engine, { project: 'p', operation: reference(lease), token: lease.value.token }), addressed(['model_call_still_running']));
  assert.equal(history(f.store), before);
  const original = f.store.get.bind(f.store);
  for (const value of [null, {}, { ...lease.value, state: 'released', release: null }, { ...lease.value, projectId: 'other' }, { ...lease.value, contract: 'invented' }]) {
    f.store.get = ((id: string, revision?: number) => id === markerId ? { ...lease, hash: hashJson(value), value } : original(id, revision)) as Store['get'];
    try {
      assert.throws(() => readLegacyOperation(f.store, 'p'), addressed(['legacy_operation_invalid']));
      assert.throws(() => prepareOmInput(f.store, request(f.store)), addressed(['legacy_operation_invalid']));
    } finally { f.store.get = original; }
  }
  for (const value of [null, { ...lease.value, state: 'released', release: null }]) {
    f.store.get = ((id: string, revision?: number) => id === markerId && revision === lease.revision + 1
      ? { id, kind: 'legacy-operation', revision, hash: hashJson(value), value } : original(id, revision)) as Store['get'];
    try { await assert.rejects(recoverLegacyOperation(f.engine, { project: 'p', operation: reference(lease), token: lease.value.token }), addressed(['legacy_operation_invalid'])); }
    finally { f.store.get = original; }
  }
  assert.equal(history(f.store), before);
});

type Driver = { child: ChildProcess; exit: Promise<number | null>; stderr: () => string; checkpoint: string };
async function stopOwner(driver: Driver) {
  if (driver.child.exitCode === null && driver.child.signalCode === null) driver.child.kill('SIGKILL');
  await driver.exit;
}
async function stopProvider(identity: ProcessIdentity) {
  if (processStart(identity.pid) !== identity.started) return;
  try { process.kill(process.platform === 'win32' ? identity.pid : -identity.pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 10_000;
  while (processStart(identity.pid) === identity.started) {
    assert.ok(Date.now() < deadline, 'The fixture provider must terminate');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function checkpoint(path: string, driver: Driver) {
  if (!existsSync(path)) await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => { clearTimeout(timer); watcher.close(); driver.child.off('exit', ended); if (error) reject(error); else resolve(); };
    const ended = () => finish(existsSync(path) ? undefined : new Error(`Driver exited before checkpoint: ${driver.stderr()}`));
    const watcher = watch(dirname(path), () => { if (existsSync(path)) finish(); });
    timer = setTimeout(() => finish(new Error(`Checkpoint timeout: ${driver.stderr()}`)), 20_000);
    driver.child.once('exit', ended);
    if (existsSync(path)) finish(); else if (driver.child.exitCode !== null || driver.child.signalCode !== null) ended();
  });
  return JSON.parse(readFileSync(path, 'utf8')) as { pid: number; requestId?: string };
}
function startDriver(directory: string, database: string, mode: string, run: Ref | null = null) {
  const path = join(directory, `driver-${mode}.mjs`), mark = join(directory, `driver-${mode}.json`);
  writeFileSync(path, `import{writeFileSync}from'node:fs';
import{Store}from${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import{ProductEngine}from${JSON.stringify(new URL('../src/product/engine.js', import.meta.url).href)};
const store=new Store(${JSON.stringify(database)}),engine=new ProductEngine(store),mode=${JSON.stringify(mode)};
const mark=()=>writeFileSync(${JSON.stringify(mark)},JSON.stringify({pid:process.pid}));
const original=store.writeMany.bind(store);let stopped=false;
store.writeMany=(writes,guards=[])=>{
 if(!stopped&&mode==='park-final-exit'&&writes.some(w=>w.kind==='parked-candidate'&&w.value.state==='parked')){mark();process.exit(71);}
 const saved=original(writes,guards);
 const hit=mode==='owner-exit'?writes.some(w=>w.id==='legacy-operation:p'&&w.value.state==='active'):
 mode==='claimed-exit'||mode==='claimed-hold'?writes.some(w=>w.kind==='model-call'&&w.expected===0):
 mode==='response-exit'?writes.some(w=>w.kind==='model-response'):
 mode==='park-intent-exit'||mode==='park-intent-throw'?writes.some(w=>w.kind==='parked-candidate'&&w.value.state==='preparing'):false;
 if(!stopped&&hit){stopped=true;mark();if(mode==='park-intent-throw')throw Error('Local interruption after parking intent');if(mode==='claimed-hold')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);else process.exit(71);}
 return saved;
};
try{const result=${run ? `await engine.repairs.prepare('p',${JSON.stringify(run)})` : "mode==='independent'?await engine.refinementResearch.run('p','R2',engine.refinement.begin('p','R2').id,2):await engine.execute({type:'continue-preparation',project:'p',maxCalls:2})"};
 writeFileSync(${JSON.stringify(mark)},JSON.stringify({pid:process.pid,result}));}
catch(error){console.error(error?.stack??String(error));process.exitCode=72;}finally{store.close();}`);
  const child = spawn(process.execPath, [path], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr!.on('data', data => { stderr += String(data); }); child.stdout!.resume();
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  return { child, exit, stderr: () => stderr, checkpoint: mark };
}
const recover = (engine: ProductEngine, lease: Revision<LegacyOperation>) => engine.execute({ type: 'recover-legacy-operation',
  project: 'p', operation: reference(lease), token: lease.value.token }) as Promise<Revision<LegacyOperation>>;
const applicationHistory = (store: Store) => canonical(store.list().filter(record => ['discovery-draft', 'question', 'research-turn',
  'research-assessment', 'research-answer', 'research-feedback', 'phase', 'graph', 'plan', 'plan-defect', 'plan-reissue'].includes(record.kind))
  .flatMap(record => store.history(record.id)));

test('G1.4 an admitted local answer and usage survive busy B1, normal pause and cold restart', async t => {
  const f = fixture(t, true), driver = startDriver(f.directory, f.database, 'answer'); f.drivers.push(driver);
  await checkpoint(f.received, driver);
  const lease = readLegacyOperation(f.store, 'p')!; assert.equal(lease.value.state, 'active');
  const other = new Store(f.database); try { busyInput(other); } finally { other.close(); }
  writeFileSync(f.resume, 'continue');
  assert.equal(await driver.exit, 0, driver.stderr());
  const calls = f.store.list<ModelCall>('model-call'), responses = f.store.list('model-response');
  assert.ok(calls.length >= 1); assert.equal(calls.length, f.sent().length); assert.equal(responses.length, calls.length);
  for (const call of calls) {
    assert.equal(call.value.status, 'succeeded'); assert.equal(call.value.usageSource, 'adapter');
    assert.deepEqual(call.value.usage, { inputTokens: 11, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 });
    const raw = call.value.response!.record!;
    assert.equal(JSON.parse(f.store.get<{ text: string }>(raw.id, raw.revision)!.value.text).requestId, call.value.requestId);
  }
  assert.equal(readLegacyOperation(f.store, 'p')!.value.state, 'released');
  const usage = modelUsage(f.store, 'p', 0).cumulative;
  assert.equal(usage.attempts, calls.length); assert.equal(usage.measuredCalls, calls.length);
  assert.deepEqual(usage.reportedTokens, { input: calls.length * 11, output: calls.length * 3,
    cachedInput: calls.length * 2, reasoningOutput: calls.length });
  firstInput(f.store); f.reopen(); const before = history(f.store);
  await assert.rejects(continuePreparation(f.engine, 'p', 2), { code: 'legacy_route_closed' });
  assert.equal(history(f.store), before); assert.deepEqual(f.store.list('model-call'), calls);
  assert.deepEqual(f.store.list('model-response'), responses); assert.equal(f.sent().length, calls.length);
});

for (const mode of ['owner-exit', 'claimed-exit', 'response-exit'] as const) {
  test(`G1.4 cold recovery of a real ${mode} releases only after saved physical proof`, async t => {
    const f = fixture(t, true);
    if (mode === 'response-exit') writeFileSync(join(f.directory, 'gate'), 'no-wait');
    const driver = startDriver(f.directory, f.database, mode); f.drivers.push(driver);
    await checkpoint(driver.checkpoint, driver); assert.equal(await driver.exit, 71, driver.stderr());
    const lease = readLegacyOperation(f.store, 'p')!;
    assert.equal(lease.value.owner.pid, driver.child.pid); busyInput(f.store);
    const application = applicationHistory(f.store); f.reopen();
    const released = await recover(f.engine, lease); assert.equal(released.value.state, 'released');
    assert.equal(applicationHistory(f.store), application, 'Physical recovery does not continue research or graph application');
    assert.equal(f.sent().length, mode === 'response-exit' ? 1 : 0);
    if (mode === 'response-exit') {
      const call = f.store.list<ModelCall>('model-call')[0]!;
      assert.equal(call.value.status, 'succeeded'); assert.ok(call.value.response?.record);
      assert.deepEqual(call.value.usage, { inputTokens: 11, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 });
      assert.equal(f.store.list('model-response').length, 1); assert.equal(f.store.list('model-call-recovery').length, 0);
    }
    if (mode === 'claimed-exit') {
      const call = f.store.list<ModelCall>('model-call')[0]!;
      assert.equal(readModelCallRecovery(f.store, 'p', reference(call)).proof.physical, 'unknown');
      assert.equal(call.value.usage, null); assert.equal(call.value.response, null);
      assert.equal(f.store.list('model-call-recovery').length, 1);
    }
    const before = history(f.store); f.reopen();
    assert.deepEqual(await recover(f.engine, lease), released); assert.equal(history(f.store), before);
    firstInput(f.store);
  });
}

test('G1.4 a dead operation owner cannot release a living provider, then recovery never resends', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t, true), driver = startDriver(f.directory, f.database, 'delivered'); f.drivers.push(driver);
  await checkpoint(f.received, driver); const lease = readLegacyOperation(f.store, 'p')!;
  const call = f.store.list<ModelCall>('model-call')[0]!, provider = call.value.providerProcess!;
  assert.equal(call.value.execution!.phase, 'authorized'); assert.equal(f.sent().length, 1);
  await stopOwner(driver); f.reopen(); const before = history(f.store);
  await assert.rejects(recover(f.engine, lease), addressed(['model_call_still_running', 'legacy_operation_pending']));
  assert.equal(history(f.store), before); busyInput(f.store);
  await stopProvider(provider);
  const application = applicationHistory(f.store), released = await recover(f.engine, lease);
  assert.equal(released.value.state, 'released'); assert.equal(applicationHistory(f.store), application);
  const recovered = f.store.get<ModelCall>(call.id)!;
  assert.equal(readModelCallRecovery(f.store, 'p', reference(recovered)).proof.physical, 'group-terminated');
  assert.equal(recovered.value.usage, null); assert.equal(modelUsage(f.store, 'p', 0).cumulative.unmeasuredCalls, 1);
  f.reopen(); const after = history(f.store);
  assert.deepEqual(await recover(f.engine, lease), released); assert.equal(history(f.store), after); assert.equal(f.sent().length, 1);
  firstInput(f.store);
});

test('G1.4 failed process observation retains the active marker instead of declaring its owner dead', async t => {
  const f = fixture(t), driver = startDriver(f.directory, f.database, 'owner-exit'); f.drivers.push(driver);
  await checkpoint(driver.checkpoint, driver); await driver.exit; const lease = readLegacyOperation(f.store, 'p')!;
  const bin = join(f.directory, 'bin'); mkdirSync(bin); const ps = join(bin, 'ps');
  for (const body of ["process.stderr.write('local observation failure');process.exit(2)", 'process.exit(0)']) {
    writeFileSync(ps, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    const script = `import{Store}from${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import{ProductEngine}from${JSON.stringify(new URL('../src/product/engine.js', import.meta.url).href)};
const store=new Store(${JSON.stringify(f.database)});try{await new ProductEngine(store).execute(${JSON.stringify({ type: 'recover-legacy-operation', project: 'p', operation: reference(lease), token: lease.value.token })});throw Error('Unexpected release');}
catch(error){if(!error.code)throw error;process.stdout.write(JSON.stringify({code:error.code,details:error.details}));}finally{store.close();}`;
    const before = history(f.store), env: NodeJS.ProcessEnv = { ...process.env, PATH: bin }; delete env.NODE_TEST_CONTEXT;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 20_000 }));
    assert.equal(result.code, 'model_call_process_uncertain'); assert.equal(result.details.target, markerId);
    assert.equal(history(f.store), before); busyInput(f.store);
  }
  assert.equal((await recover(f.engine, lease)).value.state, 'released'); firstInput(f.store);
});

test('G1.4 normal completion retains ownership while an independent project call remains physically active', async t => {
  const f = fixture(t, true), lease = acquirePreparation(f.store), driver = startDriver(f.directory, f.database, 'independent');
  f.drivers.push(driver); await checkpoint(f.received, driver);
  const call = f.store.list<ModelCall>('model-call')[0]!, provider = call.value.providerProcess!;
  assert.notEqual(call.value.ownerProcess!.pid, lease.value.owner.pid, 'The independent caller is not falsely attributed to the operation owner');
  const before = history(f.store);
  assert.throws(() => finishLegacyOperation(f.store, lease, null, new Error('Fixture operation failed')), addressed(['legacy_operation_pending']));
  assert.equal(history(f.store), before); busyInput(f.store);
  await stopOwner(driver); await stopProvider(provider);
  const recovered = recoverModelCall(f.store, 'p', reference(f.store.get<ModelCall>(call.id)!));
  assert.equal(readModelCallRecovery(f.store, 'p', reference(recovered)).proof.physical, 'group-terminated');
  pauseAndRelease(f.store, lease); firstInput(f.store);
});

for (const existing of [false, true]) {
  test(`G1.4 release guards the ${existing ? 'existing' : 'absent'} project dispatch boundary captured before listing calls`, t => {
    const f = fixture(t), lease = acquirePreparation(f.store), other = new Store(f.database); t.after(() => other.close());
    const id = `project-dispatch:${hashJson('p')}`;
    if (existing) f.store.write({ id, kind: 'project-dispatch', expected: 0, value: { projectId: 'p', serial: 1 } });
    const original = f.store.list.bind(f.store); let raced = false;
    f.store.list = ((kind?: string) => {
      const rows = original(kind);
      if (!raced && kind === 'model-call') {
        raced = true;
        const counter = other.get<{ serial: number }>(id);
        const call: ModelCall = { projectId: 'p', draftId: 'independent', purpose: 'analyst', requestId: 'concurrent-claim',
          startedAt: 1, finishedAt: null, status: 'running', requested: { actor: 'local', model: 'fixture', effort: 'low',
            command: { executable: process.execPath, args: [] } }, confirmed: { model: null, effort: null, speed: null },
          request: { chars: 2, bytes: 2, hash: hashJson({}) }, response: null, usage: null, usageSource: 'unavailable', error: null, ...physicalClaim() };
        other.writeMany([{ id, kind: 'project-dispatch', expected: counter?.revision ?? 0,
          value: { projectId: 'p', serial: (counter?.value.serial ?? 0) + 1 } },
        { id: 'model-call:concurrent-claim', kind: 'model-call', expected: 0, value: call }]);
      }
      return rows;
    }) as Store['list'];
    try { assert.throws(() => finishLegacyOperation(f.store, lease, null, new Error('Fixture operation failed')), { code: 'input_stale' }); }
    finally { f.store.list = original; }
    assert.ok(raced); assert.deepEqual(readLegacyOperation(f.store, 'p'), lease); assert.equal(f.store.history(markerId).length, 1);
    assert.throws(() => finishLegacyOperation(f.store, lease, null, new Error('Fixture operation failed')), addressed(['legacy_operation_pending']));
    busyInput(f.store);
  });
}

for (const mode of ['park-intent-exit', 'park-final-exit', 'park-intent-throw'] as const) {
  test(`G1.4 cold repair recovery completes its exact ${mode} without beginning repair research`, async t => {
    const f = executionFixture(t, 'plan-defect'), failed = (await f.engine.executor.run('p', reference(f.plan), f.options))[0]!;
    assert.equal(failed.value.state, 'needs_plan');
    const oldRoot = f.store.get<ExecutionRoot>('execution-root:p')!;
    const candidate = git(oldRoot.value.path, ['diff', '--binary', failed.value.parent]);
    const driver = startDriver(f.directory, f.store.path, mode, reference(failed));
    t.after(async () => stopOwner(driver));
    await checkpoint(driver.checkpoint, driver);
    assert.equal(await driver.exit, mode === 'park-intent-throw' ? 72 : 71, driver.stderr());
    const lease = readLegacyOperation(f.store, 'p')!;
    assert.equal(lease.value.operation, 'repair'); assert.deepEqual(lease.value.basis, reference(failed));
    assert.equal(lease.value.state, 'active', 'An exception after a preparing intent is not completion proof');
    const intent = f.store.list<ParkedCandidate>('parked-candidate')[0]!;
    assert.equal(intent.value.state, 'preparing'); busyInput(f.store);
    const application = applicationHistory(f.store), calls = f.calls(), rootBefore = f.store.get<ExecutionRoot>('execution-root:p')!;
    assert.deepEqual(rootBefore, oldRoot); f.reopen();
    const lock = f.store.get<Record<string, unknown>>('execution-lock:p');
    if (lock?.value.active) {
      const get = f.store.get.bind(f.store), value = { ...lock.value }; delete value.processStart;
      f.store.get = ((id: string, revision?: number) => id === lock.id && revision === undefined
        ? { ...lock, hash: hashJson(value), value } : get(id, revision)) as Store['get'];
      try { await assert.rejects(recover(f.engine, lease), addressed(['legacy_operation_invalid'])); }
      finally { f.store.get = get; }
      assert.deepEqual(readLegacyOperation(f.store, 'p'), lease); assert.equal(f.store.get<ParkedCandidate>(intent.id)!.value.state, 'preparing');
    }
    const released = await recover(f.engine, lease), parked = f.store.get<ParkedCandidate>(intent.id)!;
    assert.equal(released.value.state, 'released'); assert.equal(parked.value.state, 'parked');
    assert.equal(parked.revision, intent.revision + 1); assert.equal(f.store.history(markerId).length, 2);
    assert.equal(git(oldRoot.value.path, ['rev-parse', parked.value.archiveRef]), failed.value.tree);
    assert.equal(git(oldRoot.value.path, ['diff', '--binary', failed.value.parent]), candidate);
    assert.equal(git(parked.value.next.path, ['status', '--porcelain']), '');
    assert.deepEqual(f.store.get<ExecutionRoot>('execution-root:p')!.value, parked.value.next);
    assert.equal(applicationHistory(f.store), application); assert.deepEqual(f.calls(), calls);
    assert.equal(f.store.list('plan-repair').length, 0); assert.equal(f.store.list('plan-defect').length, 0);
    f.reopen(); const before = history(f.store);
    assert.deepEqual(await recover(f.engine, lease), released); assert.equal(history(f.store), before);
    firstInput(f.store);
  });
}

test('G1.4 missing terminal-call fields and malformed release provenance cannot justify releasing ownership', t => {
  const f = fixture(t), lease = acquirePreparation(f.store);
  f.store.write({ id: 'model-call:incomplete', kind: 'model-call', expected: 0,
    value: { projectId: 'p', status: 'succeeded', requestId: 'incomplete' } });
  const before = history(f.store);
  assert.throws(() => finishLegacyOperation(f.store, lease, null, new Error('Fixture operation failed')), addressed(['legacy_operation_pending']));
  assert.equal(history(f.store), before); busyInput(f.store);
  const g = fixture(t), cleanLease = acquirePreparation(g.store), released = pauseAndRelease(g.store, cleanLease);
  const originalGet = g.store.get.bind(g.store);
  for (const defect of ['missing-dispatch', 'null-predecessor'] as const) {
    g.store.get = ((id: string, revision?: number) => {
      const row = originalGet(id, revision);
      if (defect === 'null-predecessor' && id === markerId && revision === cleanLease.revision) return { ...cleanLease, value: null };
      if (defect === 'missing-dispatch' && id === markerId && revision === undefined) {
        const proof = { ...released.value.release } as Record<string, unknown>; delete proof.dispatch;
        const value = { ...released.value, release: proof }; return { ...released, hash: hashJson(value), value };
      }
      return row;
    }) as Store['get'];
    try { assert.throws(() => readLegacyOperation(g.store, 'p'), addressed(['legacy_operation_invalid'])); }
    finally { g.store.get = originalGet; }
  }
});

const HISTORY_LOADER = String.raw`import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';
let root,ts,base;export async function initialize(data){root=data.root;base=data.base;ts=(await import(data.typescript)).default;}
export async function load(url,context,next){const prefix=new URL('dist/',root).href;
 if(url.startsWith(prefix)&&/\.js$/.test(url)){const relative=url.slice(prefix.length).replace(/\.js$/,'.ts');
 if(relative.startsWith('src/')||relative.startsWith('test/')){const source=execFileSync('git',['show',base+':'+relative],{cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:10000000});
 return{format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText};}}
 return next(url,context);}`;

test('G1.4 whole f8136c1 history stays exact while new production uses the new plan envelope', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'omg-g14-history-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url)), loader = join(directory, 'loader.mjs'), producer = join(directory, 'producer.mjs');
  writeFileSync(loader, HISTORY_LOADER);
  writeFileSync(producer, `import{copyFileSync,mkdirSync,writeFileSync}from'node:fs';import{join}from'node:path';import{pathToFileURL}from'node:url';
const [repository,directory]=process.argv.slice(2),src=path=>pathToFileURL(join(repository,'dist/src',path)).href;
const{Store}=await import(src('storage/store.js'));const{ProductEngine}=await import(src('product/engine.js'));
const{canonical}=await import(src('canonical.js'));const{reference}=await import(src('pipeline/contracts.js'));
const{git}=await import(src('runtime/environment.js'));const{writeOmInput}=await import(src('om/input.js'));
const{UPSTREAM_STAGES}=await import(src('discovery/requirements.js'));
const{preparedFeatures,refinedLayers}=await import(pathToFileURL(join(repository,'dist/test/product-fixture.js')).href);
const workspace=join(directory,'repo'),database=join(directory,'old.sqlite'),comparison=join(directory,'new.sqlite');
mkdirSync(workspace);git(workspace,['init','-b','main']);writeFileSync(join(workspace,'README.md'),'Stable native producer fixture.\\n');
git(workspace,['add','README.md']);git(workspace,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','initial']);
let store=new Store(database),engine=new ProductEngine(store);try{preparedFeatures(engine,'p');
const command={executable:process.execPath,args:['--version']};engine.environments.configure('p',{workspace,
implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'assessor',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:1000},0);
refinedLayers(engine,'p');store.close();copyFileSync(database,comparison);store=new Store(database);engine=new ProductEngine(store);
const run=await engine.execute({type:'continue-preparation',project:'p',maxCalls:1});if(run.value.status!=='accepted')throw Error(JSON.stringify(run));
const plan=engine.compiler.read(run.value.plan.id);
const input=writeOmInput(store,{project:'p',expected:0,stages:Object.fromEntries(UPSTREAM_STAGES.map(stage=>[stage,reference(store.get('stage:p:'+stage))]))});
if(!input.ok)throw Error(JSON.stringify(input));
const core=canonical(store.list().filter(r=>!['preparation-run','legacy-operation'].includes(r.kind)).flatMap(r=>store.history(r.id)));
process.stdout.write(JSON.stringify({database,comparison,run,plan,input:input.value,core,history:canonical(store.list().flatMap(r=>store.history(r.id)))}));
}finally{store.close();}`);
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const bootstrap = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},
{data:{root:${JSON.stringify(pathToFileURL(repository).href)},typescript:${JSON.stringify(typescript)},base:${JSON.stringify(BASE)}}});`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const old = JSON.parse(execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, directory],
    { cwd: repository, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 40_000_000 })) as {
      database: string; comparison: string; run: Revision<any>; plan: Revision<any>; input: Revision<any>; core: string; history: string };
  let store = new Store(old.comparison);
  try {
    const current = await continuePreparation(new ProductEngine(store), 'p', 1);
    const { hash: oldHash, ...oldBody } = old.plan.value;
    const newBody = { ...oldBody, derivation: 'external-inputs/v1' };
    const newValue = { ...newBody, hash: hashJson(newBody) };
    const expectedPlan = { ...old.plan, id: `plan:p:external-inputs-v1:${newValue.hash}`, value: newValue, hash: hashJson(newValue) };
    assert.equal(current.value.status, 'accepted'); assert.deepEqual(current.value.plan, reference(expectedPlan));
    assert.deepEqual(new ProductEngine(store).compiler.read(expectedPlan.id), expectedPlan);
    assert.deepEqual(firstInput(store), old.input, 'The marker must not enter B1 sources or its historical formula');
    const expectedCore = (JSON.parse(old.core) as Revision<any>[]).map(row => {
      if (row.id === old.plan.id) return expectedPlan;
      if (row.id === 'current-plan:p') {
        assert.deepEqual(row.value, reference(old.plan));
        const value = reference(expectedPlan); return { ...row, value, hash: hashJson(value) };
      }
      if (row.id === 'stage:p:compilation') {
        assert.deepEqual(row.value.content, { plan: reference(old.plan) });
        const value = { ...row.value, content: { plan: reference(expectedPlan) },
          proofs: row.value.proofs.map((ref: Ref) => canonical(ref) === canonical(reference(old.plan)) ? reference(expectedPlan) : ref) };
        return { ...row, value, hash: hashJson(value) };
      }
      return row;
    }).sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
    assert.equal(canonical(store.list().filter(row => !['preparation-run', 'legacy-operation'].includes(row.kind))
      .flatMap(row => store.history(row.id)).sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision)), canonical(expectedCore),
      'All core bytes remain exact except the new plan envelope and its declared dependent references');
    store.close(); store = new Store(old.comparison);
    assert.deepEqual(new ProductEngine(store).compiler.read(expectedPlan.id), expectedPlan);
    assert.equal(canonical(store.list().filter(row => !['preparation-run', 'legacy-operation'].includes(row.kind))
      .flatMap(row => store.history(row.id)).sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision)), canonical(expectedCore));
    assert.equal(readLegacyOperation(store, 'p')!.value.state, 'released'); assert.equal(store.history(markerId).length, 2);
    store.close(); store = new Store(old.database);
    assert.equal(readLegacyOperation(store, 'p'), null);
    for (let restart = 0; restart < 2; restart++) {
      const engine = new ProductEngine(store);
      assert.deepEqual(await continuePreparation(engine, 'p', 1), old.run);
      assert.deepEqual(engine.compiler.read(old.plan.id), old.plan);
      const input = readOmInput(store, 'p', reference(old.input)); assert.ok(input.ok); assert.deepEqual(input.value, old.input);
      assert.equal(history(store), old.history); assert.equal(store.list('model-call').length, 0);
      if (restart === 0) { store.close(); store = new Store(old.database); }
    }
  } finally { store.close(); }
});

function deliveredValue<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function analysisAdmission(store: Store, purpose: 'stop-analysis' | 'origin-analysis'): ModelTransportRequest {
  const project = 'p', block = `g14-${purpose}`, address = { project, block, line: 1 };
  const goal = { key: 'diagnose-the-contract', questions: ['Address the contract'], result: 'A supported contract' };
  deliveredValue(openSeries(store, { ...address, slice: `${purpose}-slice`, predecessor: null, basis: null }));
  let series = deliveredValue(beginAttempt(store, { ...address, attempt: 1, goal })) as Revision<RepairSeries>;
  let basis: { kind: 'series-stop'; series: Ref; attempt: number } | { kind: 'origin-hold'; hold: Ref };
  if (purpose === 'stop-analysis') {
    for (const attempt of [1, 2, 3]) {
      if (attempt > 1) deliveredValue(beginAttempt(store, { ...address, attempt, goal }));
      series = deliveredValue(completeAttempt(store, { ...address, attempt,
        outcome: { reason: 'result', achieved: [], cancelled: [], refusals: [] } })) as Revision<RepairSeries>;
    }
    basis = { kind: 'series-stop', series: reference(series), attempt: 3 };
  } else {
    const refusal = store.write({ id: `${unitRefusalNamespace(project)}g14-analysis-source`, kind: UNIT_REFUSAL_KIND, expected: 0,
      value: { gate: 'G3', refusals: [{ code: 'unrecognized_fixture_refusal', goal: goal.key, remedy: 'Identify the exact origin',
        origin: { name: 'artifact_missing', stage: 'layer-check', subject: 'artifact:fixture', sources: [] } }] } });
    const journal = deliveredValue(recordRefusal(store, { project, source: reference(refusal) })), row = journal.value.rows[0]!;
    const closed = deliveredValue(closeAttempt(store, { ...address, attempt: 1,
      outcome: { reason: 'refused', accepting: [], cancelling: [], refusals: [{ row: row.id, name: row.code, goal: row.goal }] } }));
    assert.equal(closed.holds.length, 1);
    series = store.get<RepairSeries>(series.id)!; basis = { kind: 'origin-hold', hold: closed.holds[0]! };
  }
  const adapter = store.write({ id: `adapter:p:${purpose}`, kind: 'dispatch-adapter', expected: 0, value: { protocol: 'codex-stdio' } });
  const packet = { task: 'Diagnose the named ground', note: 'The saved analysis body stays opaque', basis } as unknown as Json;
  const admitted = deliveredValue(recordCall(store, project, { call: `g14:${purpose}`, purpose, basis, block,
    gaps: [{ id: purpose, goal: purpose, field: 'cause-and-change', consumer: 'A6:stop-analysis' }], series: reference(series),
    attempt: purpose === 'stop-analysis' ? 3 : 1,
    goal: { key: purpose, questions: ['What caused this ground?'], result: 'A cause or explicit hypothesis with an addressed change' },
    dispatch: { adapter: reference(adapter), config: reference(store.get('environment:p')!) }, packet }));
  return { project, call: reference(admitted.call), packet, role: 'reviewer' };
}

for (const purpose of ['stop-analysis', 'origin-analysis'] as const) for (const existing of [false, true]) {
  test(`G1.4 real E4 ${purpose} reservation fences release with an ${existing ? 'existing' : 'absent'} dispatch boundary`, async t => {
    const f = fixture(t), lease = acquirePreparation(f.store), transport = analysisAdmission(f.store, purpose);
    const other = new Store(f.database), dispatchId = `project-dispatch:${hashJson('p')}`;
    if (existing) other.write({ id: dispatchId, kind: 'project-dispatch', expected: 0, value: { projectId: 'p', serial: 1 } });
    const list = f.store.list.bind(f.store), write = other.writeMany.bind(other), interruption = new Error('Stop after the actual E4 claim, before supplier spawn');
    let raced = false, claimed: Revision<ModelCall> | undefined, pending: Promise<unknown> | undefined;
    other.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
      const rows = write(writes, guards);
      const call = writes.find(item => item.kind === 'model-call' && item.expected === 0);
      if (call) { claimed = other.get<ModelCall>(call.id)!; throw interruption; }
      return rows;
    }) as Store['writeMany'];
    f.store.list = ((kind?: string) => {
      const rows = list(kind);
      if (!raced && kind === 'model-call') {
        raced = true;
        pending = runModelTransport(other, transport).then(result => result, error => error);
        assert.ok(claimed, 'The actual E4 claim must commit synchronously inside the enumeration-to-release window');
      }
      return rows;
    }) as Store['list'];
    try {
      assert.throws(() => finishLegacyOperation(f.store, lease, null, new Error('Local legacy operation failed')), { code: 'input_stale' });
      assert.equal(await pending, interruption); assert.ok(raced);
      const physical = claimed as Revision<ModelCall> | undefined; assert.ok(physical);
      assert.equal(physical.value.purpose, purpose); assert.equal(physical.value.status, 'running');
      assert.equal(physical.value.execution!.phase, 'claimed'); assert.equal(physical.value.execution!.provider, null);
      assert.equal(physical.value.response, null); assert.equal(physical.value.usage, null);
      assert.equal(physical.hash, hashJson(physical.value));
      assert.deepEqual(f.store.get(physical.id), physical, 'The release conflict must not change the saved physical claim');
      assert.deepEqual(readLegacyOperation(f.store, 'p'), lease); assert.equal(f.store.history(markerId).length, 1);
      assert.equal(f.sent().length, 0); assert.equal(f.store.list('model-response').length, 0);
      assert.equal(other.get<{ serial: number }>(dispatchId)!.value.serial, existing ? 2 : 1);
    } finally { f.store.list = list; other.writeMany = write; other.close(); }
    f.reopen(); busyInput(f.store);
    const physical = claimed as Revision<ModelCall> | undefined; assert.ok(physical);
    assert.deepEqual(f.store.get(physical.id), physical);
    assert.throws(() => finishLegacyOperation(f.store, lease, null, new Error('The call is still admitted')), addressed(['legacy_operation_pending']));
    assert.deepEqual(f.store.get(physical.id), physical); assert.equal(f.sent().length, 0);
  });
}

type CapturedRelease = { active: Revision<LegacyOperation>; value: LegacyOperation; result: Revision<Record<string, unknown>> };
async function captureReturnedRelease(store: Store, snapshot: string, invoke: () => Promise<unknown>): Promise<CapturedRelease> {
  const original = store.writeMany.bind(store), stop = new Error('Capture the actual first terminal result before persistence');
  let pending: Write | undefined, blocked = false;
  store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    if (blocked) throw stop;
    const terminal = writes.find(write => write.kind === 'plan-repair' || write.kind === 'preparation-run'
      && ['paused', 'accepted'].includes((write.value as { status: string }).status));
    if (terminal) { pending = terminal; blocked = true; throw stop; }
    return original(writes, guards);
  }) as Store['writeMany'];
  try { await assert.rejects(invoke()); } finally { store.writeMany = original; }
  const resultWrite = pending as Write | undefined; assert.ok(resultWrite);
  const active = readLegacyOperation(store, 'p')!;
  const prefix = await store.snapshot(join(dirname(snapshot), 'release-prefix-snapshots')); copyFileSync(prefix.path, snapshot);
  const result = store.write<Record<string, unknown>>(resultWrite);
  const released = finishLegacyOperation(store, active, reference(result));
  return { active, value: released.value, result };
}
function invalidPersistedRelease(store: Store) {
  const before = history(store);
  for (const read of [() => readLegacyOperation(store, 'p'), () => prepareOmInput(store, request(store)), () => writeOmInput(store, request(store))]) {
    assert.throws(read, addressed(['legacy_operation_invalid'])); assert.equal(history(store), before);
  }
  assert.equal(store.get('om-input:p'), null);
}
interface ReleaseForgery {
  name: string;
  proof?: (proof: Record<string, unknown>) => void;
  result?: (value: Record<string, unknown>, store: Store) => void;
  afterResult?: (store: Store, result: Revision<Record<string, unknown>>, proof: Record<string, unknown>) => void;
  resultId?: string;
  resultKind?: string;
  resultRef?: Ref;
}
function checkReleaseForgeries(snapshot: string, directory: string, captured: CapturedRelease, cases: ReleaseForgery[]) {
  for (const [index, defect] of cases.entries()) {
    const database = join(directory, `release-forgery-${index}.sqlite`); copyFileSync(snapshot, database);
    let store = new Store(database);
    try {
      const proof = structuredClone(captured.value.release) as unknown as Record<string, unknown>;
      const value = structuredClone(captured.result.value); defect.result?.(value, store);
      const id = defect.resultId ?? (defect.resultKind ? 'foreign-kind-result:p' : captured.result.id), prior = store.get(id);
      const result = store.write<Record<string, unknown>>({ id, kind: defect.resultKind ?? captured.result.kind, expected: prior?.revision ?? 0, value });
      proof.result = reference(result);
      defect.afterResult?.(store, result, proof);
      if (defect.resultRef) proof.result = defect.resultRef;
      defect.proof?.(proof);
      const forged = store.write({ id: markerId, kind: 'legacy-operation', expected: captured.active.revision,
        value: { ...captured.value, release: proof } });
      assert.equal(forged.hash, hashJson(forged.value), defect.name);
      try { invalidPersistedRelease(store); }
      catch (error) { throw new Error(`Persisted release forgery: ${defect.name}`, { cause: error }); }
      store.close(); store = new Store(database);
      try { invalidPersistedRelease(store); }
      catch (error) { throw new Error(`Restarted release forgery: ${defect.name}`, { cause: error }); }
    } finally { store.close(); rmSync(database, { force: true }); }
  }
}

test('G1.4 persisted release reasons and preparation results require their own complete completion basis after restart', async t => {
  const f = fixture(t), pending = pendingPreparation(f.store);
  const oldPause = f.store.write({ ...pending.write, value: { ...pending.write.value as Record<string, unknown>, status: 'paused',
    error: 'An earlier completed invocation', code: 'fixture_pause' } });
  const snapshot = join(f.directory, 'release-basis.sqlite');
  const captured = await captureReturnedRelease(f.store, snapshot, () => continuePreparation(f.engine, 'p', 1));
  assert.equal(captured.result.value.status, 'accepted'); assert.ok(oldPause.revision < captured.active.value.basis.revision);
  const error = { code: 'fixture_failure', message: 'The operation failed after its physical calls ended' };
  const cases: ReleaseForgery[] = [
    { name: 'returned without result', proof: proof => { proof.result = null; } },
    { name: 'returned with failure', proof: proof => { proof.error = error; } },
    { name: 'failed without error or result', proof: proof => { proof.reason = 'failed'; proof.result = null; proof.error = null; } },
    { name: 'failed result does not replace error', proof: proof => { proof.reason = 'failed'; proof.error = null; } },
    { name: 'failed empty code', proof: proof => { proof.reason = 'failed'; proof.error = { ...error, code: '' }; } },
    { name: 'failed empty message', proof: proof => { proof.reason = 'failed'; proof.error = { ...error, message: '' }; } },
    { name: 'failed missing code', proof: proof => { proof.reason = 'failed'; proof.error = { message: error.message }; } },
    { name: 'failed missing message', proof: proof => { proof.reason = 'failed'; proof.error = { code: error.code }; } },
    { name: 'recovered cannot carry a result', proof: proof => { proof.reason = 'recovered'; } },
    { name: 'recovered cannot carry failure', proof: proof => { proof.reason = 'recovered'; proof.result = null; proof.error = error; } },
    ...['reason', 'result', 'error'].map(field => ({ name: `missing release ${field}`, proof: (proof: Record<string, unknown>) => { delete proof[field]; } })),
    ...['projectId', 'status', 'phase', 'draft', 'plan', 'owner', 'error', 'code', 'findings', 'calls'].map(field => ({
      name: `missing preparation result ${field}`, result: (value: Record<string, unknown>) => { delete value[field]; } })),
    { name: 'foreign preparation project', result: value => { value.projectId = 'other'; } },
    { name: 'foreign preparation ID', resultId: 'preparation-run:other' },
    { name: 'foreign preparation kind', resultKind: 'plan-repair' },
    { name: 'result from before this invocation', resultRef: reference(oldPause) },
    { name: 'original running basis is not a result', resultRef: captured.active.value.basis },
    { name: 'running result', result: value => { value.status = 'running'; } },
    { name: 'unknown result status', result: value => { value.status = 'invented'; } },
    { name: 'foreign result owner', result: value => { value.owner = { ...captured.active.value.owner, started: 'different process incarnation' }; } },
    { name: 'missing result owner identity', result: value => { value.owner = { pid: process.pid }; } },
    { name: 'accepted result without exact plan', result: value => { value.plan = null; } },
    { name: 'invalid result draft', result: value => { value.draft = {}; } },
    { name: 'invalid result phase', result: value => { value.phase = ''; } },
    { name: 'invalid result findings', result: value => { value.findings = null; } },
    { name: 'invalid result call count', result: value => { value.calls = -1; } },
    { name: 'failed release cannot hide foreign result', resultId: 'preparation-run:foreign-failure', proof: proof => { proof.reason = 'failed'; proof.error = error; } },
    { name: 'the next invocation by the same owner cannot finish the earlier invocation', afterResult: (store, result, proof) => {
      const next = store.write<Record<string, unknown>>({ id: result.id, kind: result.kind, expected: result.revision,
        value: { ...result.value, status: 'running', phase: 'R2', draft: null, plan: null, error: null, code: null, findings: [], calls: 0 } });
      const later = store.write({ id: result.id, kind: result.kind, expected: next.revision,
        value: { ...next.value, status: 'paused', error: 'A later invocation', code: 'fixture_pause' } });
      proof.result = reference(later);
    } },
    { name: 'accepted result with missing plan source', result: value => { value.plan = { id: 'plan:missing', revision: 1, hash: 'f'.repeat(64) }; } },
    { name: 'accepted result with foreign plan', result: (value, store) => {
      const source = store.get<Record<string, unknown>>((value.plan as Ref).id)!;
      value.plan = reference(store.write({ id: 'plan:foreign', kind: 'plan', expected: 0, value: { ...source.value, projectId: 'other' } }));
    } },
    { name: 'paused result with foreign draft', result: (value, store) => {
      value.status = 'paused'; value.plan = null;
      value.draft = reference(store.write({ id: 'discovery-draft:foreign', kind: 'discovery-draft', expected: 0, value: { projectId: 'other' } }));
    } },
  ];
  checkReleaseForgeries(snapshot, f.directory, captured, cases);
  for (const [index, variant] of ['returned-accepted', 'returned-paused', 'failed-none', 'failed-own-result'].entries()) {
    const database = join(f.directory, `valid-release-${index}.sqlite`); copyFileSync(snapshot, database); let store = new Store(database);
    try {
      const proof = structuredClone(captured.value.release)!;
      const body = variant === 'returned-paused'
        ? { ...captured.result.value, status: 'paused', plan: null, error: 'Saved pause', code: 'fixture_pause' }
        : captured.result.value;
      const result = store.write({ id: captured.result.id, kind: captured.result.kind, expected: captured.result.revision - 1, value: body });
      proof.result = reference(result);
      if (variant.startsWith('failed')) { proof.reason = 'failed'; proof.error = error; if (variant === 'failed-none') proof.result = null; }
      const saved = store.write<LegacyOperation>({ id: markerId, kind: 'legacy-operation', expected: captured.active.revision,
        value: { ...captured.value, release: proof } });
      assert.deepEqual(readLegacyOperation(store, 'p'), saved, variant); store.close(); store = new Store(database);
      assert.deepEqual(readLegacyOperation(store, 'p'), saved, variant); firstInput(store);
    } finally { store.close(); rmSync(database, { force: true }); }
  }
});

for (const existing of [false, true]) {
  test(`G1.4 actual researchCall reservation fences release with an ${existing ? 'existing' : 'absent'} dispatch boundary`, t => {
    const f = fixture(t, true), lease = acquirePreparation(f.store), draft = f.engine.refinement.begin('p', 'R2');
    const dispatchId = `project-dispatch:${hashJson('p')}`;
    if (existing) f.store.write({ id: dispatchId, kind: 'project-dispatch', expected: 0, value: { projectId: 'p', serial: 1 } });
    const script = join(f.directory, 'research-reservation.mjs');
    writeFileSync(script, `import{Store}from${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import{ProductEngine}from${JSON.stringify(new URL('../src/product/engine.js', import.meta.url).href)};
const store=new Store(${JSON.stringify(f.database)}),write=store.writeMany.bind(store);
store.writeMany=(writes,guards=[])=>{const result=write(writes,guards);
 if(writes.some(w=>w.kind==='model-call'&&w.expected===0))process.exit(71);return result;};
try{await new ProductEngine(store).researcher.run('p',${JSON.stringify(draft.id)},1);throw Error('The real research reservation was not reached');}
finally{store.close();}`);
    const original = f.store.list.bind(f.store), env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    let raced = false;
    f.store.list = ((kind?: string) => {
      const rows = original(kind);
      if (!raced && kind === 'model-call') {
        raced = true;
        assert.throws(() => execFileSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 30_000 }),
          error => (error as { status?: number }).status === 71);
        assert.equal(original('model-call').length, 1);
      }
      return rows;
    }) as Store['list'];
    try { assert.throws(() => finishLegacyOperation(f.store, lease, null, new Error('Legacy preparation finished its work')), { code: 'input_stale' }); }
    finally { f.store.list = original; }
    assert.ok(raced); assert.deepEqual(readLegacyOperation(f.store, 'p'), lease);
    const physical = f.store.list<ModelCall>('model-call')[0]!;
    assert.equal(physical.value.purpose, 'analyst'); assert.equal(physical.value.status, 'running');
    assert.equal(physical.value.execution!.phase, 'claimed'); assert.equal(physical.value.execution!.provider, null);
    assert.notEqual(physical.value.ownerProcess!.pid, lease.value.owner.pid);
    assert.equal(physical.value.response, null); assert.equal(physical.value.usage, null);
    assert.equal(f.store.get<{ serial: number }>(dispatchId)!.value.serial, existing ? 2 : 1);
    assert.equal(f.sent().length, 0); f.reopen(); busyInput(f.store);
    assert.throws(() => finishLegacyOperation(f.store, lease, null, new Error('The admitted research still needs recovery')), addressed(['legacy_operation_pending']));
    assert.deepEqual(f.store.get(physical.id), physical); assert.equal(f.sent().length, 0);
  });
}

test('G1.4 persisted repair release requires complete own result, defect and parked-candidate grounds after restart', async t => {
  const f = executionFixture(t, 'plan-defect'), failed = (await f.engine.executor.run('p', reference(f.plan), f.options))[0]!;
  assert.equal(failed.value.state, 'needs_plan');
  const snapshot = join(f.directory, 'repair-release-basis.sqlite');
  const captured = await captureReturnedRelease(f.store, snapshot, () => f.engine.repairs.prepare('p', reference(failed)));
  const defectChange = (field: string, replacement: unknown): ReleaseForgery => ({ name: `repair defect ${field}`,
    result: (value, store) => {
      const source = store.get<Record<string, unknown>>((value.defect as Ref).id)!;
      const body = { ...source.value, [field]: replacement };
      value.defect = reference(store.write({ id: source.id, kind: source.kind, expected: source.revision, value: body }));
    } });
  const parkingChange = (field: string, replacement: unknown): ReleaseForgery => ({ name: `repair parked candidate ${field}`,
    result: (value, store) => {
      const source = store.get<Record<string, unknown>>((value.parked as Ref).id)!;
      const parked = store.write({ id: source.id, kind: source.kind, expected: source.revision, value: { ...source.value, [field]: replacement } });
      const oldDefect = store.get<Record<string, unknown>>((value.defect as Ref).id)!;
      const defect = store.write({ id: oldDefect.id, kind: oldDefect.kind, expected: oldDefect.revision,
        value: { ...oldDefect.value, parked: reference(parked) } });
      value.parked = reference(parked); value.defect = reference(defect);
    }, afterResult: (_store, result, proof) => { proof.parking = result.value.parked; } });
  const foreign = { ...reference(failed), id: 'task-run:foreign' };
  const cases: ReleaseForgery[] = [
    ...['projectId', 'run', 'defect', 'parked', 'level', 'phase', 'draftId', 'plan', 'error'].map(field => ({
      name: `missing repair result ${field}`, result: (value: Record<string, unknown>) => { delete value[field]; } })),
    { name: 'foreign repair result project', result: value => { value.projectId = 'other'; } },
    { name: 'foreign repair result identity', resultId: 'plan-repair:foreign' },
    { name: 'foreign repair result kind', resultKind: 'preparation-run' },
    { name: 'foreign repair run', result: value => { value.run = foreign; } },
    { name: 'invalid repair phase', result: value => { value.phase = 'invented'; } },
    { name: 'invalid repair level', result: value => { value.level = 3; } },
    { name: 'empty repair draft identity', result: value => { value.draftId = ''; } },
    { name: 'unfinished repair cannot declare a plan', result: value => { value.plan = reference(f.plan); } },
    { name: 'reissued repair needs a plan', result: value => { value.phase = 'reissued'; value.level = 2; } },
    { name: 'reissued repair needs level two', result: value => { value.phase = 'reissued'; value.level = 1; value.plan = reference(f.plan); } },
    { name: 'reissued repair cannot retain an error', result: value => { value.phase = 'reissued'; value.level = 2; value.plan = reference(f.plan); value.error = 'Still unresolved'; } },
    { name: 'repair parking must match the release', proof: proof => { proof.parking = null; } },
    { name: 'repair defect identity is deterministic', result: (value, store) => {
      const source = store.get((value.defect as Ref).id)!;
      value.defect = reference(store.write({ id: 'plan-defect:foreign', kind: source.kind, expected: 0, value: source.value }));
    } },
    defectChange('projectId', 'other'), defectChange('run', foreign), defectChange('plan', { ...reference(f.plan), hash: '0'.repeat(64) }),
    defectChange('parked', { ...(captured.result.value.parked as Ref), id: 'parked:foreign' }),
    parkingChange('projectId', 'other'), parkingChange('run', foreign), parkingChange('state', 'preparing'),
  ];
  checkReleaseForgeries(snapshot, f.directory, captured, cases);
  const database = join(f.directory, 'valid-repair-release.sqlite'); copyFileSync(snapshot, database); let store = new Store(database);
  try {
    const result = store.write<Record<string, unknown>>({ id: captured.result.id, kind: captured.result.kind, expected: captured.result.revision - 1, value: captured.result.value });
    assert.deepEqual(reference(result), reference(captured.result));
    const saved = store.write<LegacyOperation>({ id: markerId, kind: 'legacy-operation', expected: captured.active.revision, value: captured.value });
    assert.deepEqual(readLegacyOperation(store, 'p'), saved);
    const next = beginLegacyOperation(store, 'p', 'repair', reference(failed));
    assert.notEqual(next.value.token, captured.active.value.token);
    const repeated = finishLegacyOperation(store, next, reference(result));
    assert.deepEqual(repeated.value.release!.result, reference(result), 'A completed repair result can be returned by the next exact repair invocation');
    // Later heads do not invalidate the release's exact historical result or grounds.
    store.write({ id: result.id, kind: result.kind, expected: result.revision, value: { ...result.value, error: 'A later continuation' } });
    store.close(); store = new Store(database); assert.deepEqual(readLegacyOperation(store, 'p'), repeated); firstInput(store);
  } finally { store.close(); rmSync(database, { force: true }); }
});

// ---- S1.5 (№2363): the search for saved OM provenance follows the Store it is given ----

const legacyRoute = (engine: ProductEngine) => engine.legacyRoute('p');
const provenanceRefusal = (store: Store) => {
  const report = runIntegrityCheck(store, { project: 'p' }); assert.ok(report.ok);
  assert.ok(report.value.value.findings.some(f => f.code === 'record_missing' && f.id === 'om-input:p' && f.revision === 1));
  assert.equal(integrityGate(store, 'p')?.ok, false);
};
const bareLegacy = { om: false, guards: [{ id: 'om-input:p', absent: true }] };

test('S1.5 №2363 a provenance record written by a second Store refuses fsck and the integrity gate before and after reopening', t => {
  const directory = mkdtempSync(join(tmpdir(), 'omg-s15-second-')), database = join(directory, 'state.sqlite');
  let store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project: 'p', title: 'p' });
  assert.deepEqual(legacyRoute(engine), bareLegacy);
  const other = new Store(database);
  try { other.write({ id: 'om-horizon:p:h1', kind: 'om-horizon', expected: 0, value: {} }); } finally { other.close(); }
  assert.deepEqual(legacyRoute(engine), bareLegacy); provenanceRefusal(store);
  store.close(); store = new Store(database); engine = new ProductEngine(store);
  assert.deepEqual(legacyRoute(engine), bareLegacy); provenanceRefusal(store);
});

test('S1.5 №2363 G7 views read only exact first B1; fsck examines committed records, not a virtual provenance record absent from the file', t => {
  const directory = mkdtempSync(join(tmpdir(), 'omg-s15-view-')), database = join(directory, 'state.sqlite');
  const store = new Store(database);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  new ProductEngine(store).execute({ type: 'create-project', project: 'p', title: 'p' });
  const ghost: Revision = { id: 'om-horizon:p:ghost', kind: 'om-horizon', revision: 1, hash: '0'.repeat(64), value: {} };
  class Overlay extends Store {
    override get<T = Json>(id: string, revision?: number): Revision<T> | null { return id === ghost.id ? ghost as Revision<T> : super.get<T>(id, revision); }
    override list<T = Json>(kind?: string): Revision<T>[] {
      const rows = super.list<T>(kind); return kind === undefined || kind === ghost.kind ? [...rows, ghost as Revision<T>] : rows;
    }
    override history<T = Json>(id: string): Revision<T>[] { return id === ghost.id ? [ghost as Revision<T>] : super.history<T>(id); }
  }
  const overlay = new Overlay(database);
  try {
    assert.deepEqual(legacyRoute(new ProductEngine(overlay)), bareLegacy);
    assert.equal(integrityGate(overlay, 'p'), null, 'No committed provenance exists in this database');
  } finally { overlay.close(); }
  assert.deepEqual(legacyRoute(new ProductEngine(store)), bareLegacy, 'The genuine Store holds no provenance');
  // A transparent Proxy, bound to its target the way the engine's own trace views are: no proven Store, the same records.
  const proxied = new Proxy(store, { get(target, key) { const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
  assert.deepEqual(legacyRoute(new ProductEngine(proxied)), bareLegacy, 'A Proxy reads the same exact first B1 and agrees');
});
