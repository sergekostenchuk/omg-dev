import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as d83Delay } from 'node:timers/promises';
import { Store, type Write } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { assessmentSession, assessmentPacket, assessmentRefusalDoor } from '../src/discovery/assessment-session.js';
import { readResearchExecution, readResearchResponse } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import { DIRECT_ASSESSMENT_ORIGIN } from '../src/discovery/research-model.js';
import { reference } from '../src/pipeline/contracts.js';
import { processStart } from '../src/runtime/process-identity.js';
import { modelUsage, type ModelCall, type ProcessIdentity } from '../src/runtime/model-usage.js';
import { prepareLateModelReceipt, readLateModelReceipt, readModelCallRecovery, type LateModelReceipt } from '../src/discovery/model-call-recovery.js';
import type { Question } from '../src/discovery/discovery.js';
import { Environments, git, uniqueTransactionGuards } from '../src/runtime/environment.js';
import { configureReaderPilot, pilotEnvironment } from '../src/discovery/reader-pilot.js';
import { readBundle } from '../src/discovery/reader.js';
import { ensureWorktree } from '../src/execution/worktree.js';
import { EngineError } from '../src/errors.js';
import { hashJson } from '../src/canonical.js';

const verdict = { verdict: 'supported', reasons: [] };
function resumeFixture(t: test.TestContext, mode: 'verdict' | 'checkpoint' | 'read_context' = 'verdict') {
  const root = mkdtempSync(join(tmpdir(), 'omg-assessment-resume-')), workspace = join(root, 'repo'), database = join(root, 'db.sqlite');
  mkdirSync(workspace); git(workspace, ['init', '-b', 'main']); writeFileSync(join(workspace, 'README.md'), 'AB\n');
  git(workspace, ['add', '.']); git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base']);
  const opened: Store[] = [], fresh = () => { const store = new Store(database); opened.push(store); return store; };
  t.after(() => { for (const store of opened) store.close(); rmSync(root, { recursive: true, force: true }); });
  const store = fresh(), engine = new ProductEngine(store), wire = join(root, 'wire.ndjson'), adapter = join(root, 'adapter.mjs');
  engine.execute({ type: 'create-project', project: 'p', title: 'Assessment continuation' });
  writeFileSync(adapter, `import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
const research=${JSON.stringify(mode)}==='checkpoint'&&s.assessmentState.offset===0?{action:'assessment_checkpoint',notes:['Compare both original operands']}:
${JSON.stringify(mode)}==='read_context'&&!s.contextWorkspace.length?{action:'read_context',record:s.working.archive,pointer:'/body/resources/a'}:{verdict:'supported',reasons:[]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const source = engine.discovery.evidence.document('p', 'basis', 'AB', 'text/plain', 0);
  const observation = engine.discovery.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: 2 });
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation', [{ field: 'combine', kind: 'design',
    prompt: 'Combine both operands', risk: 'Omitting one operand', schema: { type: 'object', required: ['result'],
      properties: { result: { type: 'string' } }, additionalProperties: false } }]);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const context = { role: 'assess-answer', question: { id: question.id, ...question.value.spec }, resources: { a: 'A', b: 'B' },
    workingSelections: [], readings: [], value: { result: 'AB' }, observations: [observation] };
  const invoke = (db = store, q = question) => assessmentSession(db, draft, q, environment, environment.value, undefined, context, 'Assess both operands');
  const ordinary = (db = store, q = question) => assessAnswer(db, q, { action: 'answer', question: q.id, value: context.value,
    citations: [{ source: reference(source), selector: observation.selector }] }, environment, workspace);
  const createPilot = (db: Store) => configureReaderPilot(db, new Environments(db), 'p', { experimental: true, active: false, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxRequestChars: 100000, maxReadChars: 60000, maxReplyChars: 10000, maxCalls: 10, maxReportedTokens: 100000 }, 0);
  const createRoot = (db: Store) => ensureWorktree(db, new Environments(db), { projectId: 'p', base: { root: workspace, head: git(workspace, ['rev-parse', 'HEAD']) } } as Parameters<typeof ensureWorktree>[2]);
  const sent = () => existsSync(wire) ? readFileSync(wire, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { root, store, database, fresh, engine, workspace, environment, source, observation, question, draft, context, invoke, ordinary, createPilot, createRoot, sent };
}
function callsOnce(f: ReturnType<typeof resumeFixture>, count: number, db = f.store) {
  assert.equal(f.sent().length, count); assert.equal(db.list('model-call').length, count); assert.equal(db.list('model-response').length, count);
  const usage = modelUsage(db, 'p', 0);
  assert.equal(usage.cumulative.attempts, count); assert.equal(usage.cumulative.measuredCalls, count);
  assert.deepEqual(usage.cumulative.reportedTokens, { input: count * 10, output: count * 2, cachedInput: 0, reasoningOutput: 0 });
}
function interruptAt(store: Store, match: (writes: Write[]) => boolean, after: boolean) {
  const original = store.writeMany.bind(store); let hit = false;
  store.writeMany = ((writes: Write[], guards = []) => {
    if (!hit && match(writes)) {
      hit = true; if (after) original(writes, guards);
      throw new EngineError('fixture_application_crash', 'Stop at the selected persistent boundary');
    }
    return original(writes, guards);
  }) as typeof store.writeMany;
  return () => { store.writeMany = original; assert.ok(hit, 'The selected persistence window was reached'); };
}

for (const boundary of ['prepared', 'archive', 'receipt', 'before-apply', 'after-apply'] as const) {
  test(`assessment ${boundary} boundary resumes one exact verdict and one measured call after restart`, async t => {
    const f = resumeFixture(t);
    const restore = interruptAt(f.store, writes => writes.some(write => boundary === 'prepared' ? write.kind === 'assessment-session' && write.expected === 0
      : boundary === 'archive' ? write.kind === 'research-context'
      : boundary === 'receipt' ? write.kind === 'model-response' : write.kind === 'assessment-session' && Boolean((write.value as any).result)), boundary !== 'before-apply');
    await assert.rejects(f.invoke(), { code: 'fixture_application_crash' }); restore();
    assert.equal(f.sent().length, ['prepared', 'archive'].includes(boundary) ? 0 : 1);
    const restarted = f.fresh(); assert.deepEqual(await f.invoke(restarted), verdict); callsOnce(f, 1, restarted);
    const heads = restarted.list(); assert.deepEqual(await f.invoke(f.fresh()), verdict); assert.deepEqual(restarted.list(), heads);
    const session = restarted.list<any>('assessment-session')[0]!, app = restarted.list<any>('assessment-application')[0]!;
    assert.equal(session.value.contract, 'assessment-application/v1'); assert.equal(app.value.state, 'applied');
    assert.deepEqual(app.value.after, reference(session)); assert.deepEqual(app.value.received, reference(restarted.list('model-call')[0]!));
    assert.deepEqual(app.value.call, reference(restarted.get(app.value.call.id, 1)!));
    assert.ok(app.value.guards.some((g: any) => g.id === 'reader-pilot:p' && g.absent === true));
    assert.ok(app.value.guards.some((g: any) => g.id.startsWith('execution-root:') && g.absent === true));
  });
}
for (const mode of ['checkpoint', 'read_context'] as const) for (const afterApply of [false, true]) {
  test(`assessment ${mode} resumes ${afterApply ? 'applied cursor' : 'receipt'} then sends only its next cursor`, async t => {
    const f = resumeFixture(t, mode);
    const restore = interruptAt(f.store, writes => writes.some(write => afterApply
      ? write.kind === 'assessment-session' && write.expected === 1 : write.kind === 'model-response'), true);
    await assert.rejects(f.invoke(), { code: 'fixture_application_crash' }); restore();
    callsOnce(f, 1);
    const db = f.fresh(); assert.deepEqual(await f.invoke(db), verdict); callsOnce(f, 2, db);
    const apps = db.list<any>('assessment-application'), session = db.list<any>('assessment-session')[0]!;
    assert.equal(apps.length, 2); assert.ok(apps.every(app => app.value.state === 'applied'));
    assert.equal(session.revision, 3); assert.equal(session.value.workspace.entries.length, mode === 'read_context' ? 1 : 0);
    assert.equal(session.value.notes.length, mode === 'checkpoint' ? 1 : 0);
    assert.notEqual(apps[0]!.value.call.id, apps[1]!.value.call.id);
    const heads = db.list(); assert.deepEqual(await f.invoke(f.fresh()), verdict); assert.deepEqual(db.list(), heads);
  });
}

test('two assessment resumers race the same receipt and the losing CAS returns the one applied result', async t => {
  const f = resumeFixture(t), restore = interruptAt(f.store, writes => writes.some(write => write.kind === 'model-response'), true);
  await assert.rejects(f.invoke(), { code: 'fixture_application_crash' }); restore();
  const first = f.fresh(), second = f.fresh(), original = first.writeMany.bind(first); let competing: Promise<unknown> | undefined;
  first.writeMany = ((writes: Write[], guards = []) => {
    if (!competing && writes.some(write => write.kind === 'assessment-session' && Boolean((write.value as any).result))) competing = f.invoke(second);
    return original(writes, guards);
  }) as typeof first.writeMany;
  assert.deepEqual(await f.invoke(first), verdict); assert.ok(competing); assert.deepEqual(await competing, verdict);
  callsOnce(f, 1); assert.equal(first.list<any>('assessment-session')[0]!.revision, 2);
  assert.equal(first.list<any>('assessment-application')[0]!.revision, 3);
});

for (const dependency of ['reader-pilot', 'execution-root', 'environment', 'question', 'draft', 'source'] as const) {
  test(`changed ${dependency} after receipt persists the original refusal and never spends on a repeat`, async t => {
    const f = resumeFixture(t), original = f.store.writeMany.bind(f.store); let injected = false;
    f.store.writeMany = ((writes: Write[], guards = []) => {
      if (!injected && writes.some(write => write.kind === 'assessment-session' && Boolean((write.value as any).result))) {
        injected = true; const other = f.fresh();
        if (dependency === 'reader-pilot') f.createPilot(other);
        else if (dependency === 'execution-root') f.createRoot(other);
        else {
          const row = dependency === 'environment' ? f.environment : dependency === 'question' ? f.question : dependency === 'draft' ? f.draft : f.source;
          other.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
        }
        return original([...writes, { id: 'neighbor-a', kind: 'fixture', expected: 0, value: {} }, { id: 'neighbor-b', kind: 'fixture', expected: 0, value: {} }], guards);
      }
      return original(writes, guards);
    }) as typeof f.store.writeMany;
    await assert.rejects(f.invoke(), { code: 'research_context_application_refused' }); f.store.writeMany = original;
    assert.ok(injected); assert.equal(f.store.get('neighbor-a'), null); assert.equal(f.store.get('neighbor-b'), null);
    const app = f.store.list<any>('assessment-application')[0]!;
    assert.equal(app.value.state, 'refused'); assert.equal(app.value.refusal.kind, 'dependency');
    assert.deepEqual(app.value.guards, f.store.get<any>(app.id, 1)!.value.guards);
    assert.deepEqual(app.value.refusal.actual, reference(f.store.get(app.value.refusal.expected.id)!));
    const heads = f.store.list(); await assert.rejects(f.invoke(f.fresh()), { code: 'research_context_application_refused' });
    assert.deepEqual(f.store.list(), heads); callsOnce(f, 1);
  });
}

test('completed assessment is historical after new environment, pilot, root and question heads', async t => {
  const f = resumeFixture(t); assert.deepEqual(await f.invoke(), verdict); const other = f.fresh();
  f.createPilot(other); f.createRoot(other);
  for (const row of [f.environment, f.question, f.draft, f.source]) other.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
  const heads = other.list(), db = f.fresh(), get = db.get.bind(db);
  db.get = ((id: string, revision?: number) => {
    if (revision === undefined && [f.environment.id, 'reader-pilot:p', 'execution-root:p'].includes(id)) throw Error('Historical result consulted current admission');
    return get(id, revision);
  }) as typeof db.get;
  assert.deepEqual(await f.invoke(db), verdict); callsOnce(f, 1); assert.deepEqual(other.list(), heads);
});

test('native reopen-question creates the only new revision needed by the ordinary assessment consumer', async t => {
  const f = resumeFixture(t), original = f.store.writeMany.bind(f.store); let injected = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    const saved = original(writes, guards);
    if (!injected && writes.some(write => write.kind === 'model-response')) { injected = true; f.createPilot(f.fresh()); }
    return saved;
  }) as typeof f.store.writeMany;
  await assert.rejects(f.ordinary(), { code: 'research_context_application_refused' }); f.store.writeMany = original;
  callsOnce(f, 1); const refused = f.store.list<any>('assessment-application')[0]!;
  await assert.rejects(f.ordinary(f.fresh()), { code: 'research_context_application_refused' }); callsOnce(f, 1);
  const engine = new ProductEngine(f.fresh());
  await assert.rejects(Promise.resolve().then(() => engine.execute({ type: 'reopen-question', question: f.question.id, expected: 0 })), { code: 'question_stale' });
  await engine.execute({ type: 'reopen-question', question: f.question.id, expected: f.question.revision });
  const q = f.store.get<Question>(f.question.id)!; assert.equal(q.revision, f.question.revision + 1);
  const assessment = await f.ordinary(f.fresh(), q); assert.equal(assessment.value.verdict, 'supported'); callsOnce(f, 2);
  const heads = f.store.list(); assert.deepEqual(await f.ordinary(f.fresh(), q), assessment); assert.deepEqual(f.store.list(), heads);
  assert.deepEqual(f.store.get(refused.id), refused); assert.equal(f.store.list('assessment-session').length, 2);
});

test('new assessment era rejects missing application, changed original guards and forged terminal result', async t => {
  for (const defect of ['missing', 'marker', 'guards', 'result', 'call'] as const) {
    const f = resumeFixture(t); assert.deepEqual(await f.invoke(), verdict);
    const app = f.store.list<any>('assessment-application')[0]!, session = f.store.list<any>('assessment-session')[0]!;
    if (defect === 'missing' || defect === 'marker' || defect === 'result') {
      const changed = f.store.write({ id: session.id, kind: session.kind, expected: session.revision, value: { ...session.value,
        ...(defect === 'missing' ? { application: 'missing-state' } : defect === 'marker' ? { contract: null } : { result: { verdict: 'conflicting', reasons: ['Invented'] } }) } });
      if (defect === 'result') f.store.write({ id: app.id, kind: app.kind, expected: app.revision, value: { ...app.value, after: reference(changed) } });
    } else f.store.write({ id: app.id, kind: app.kind, expected: app.revision, value: { ...app.value,
      ...(defect === 'guards' ? { guards: [] } : { call: { ...app.value.call, hash: '0'.repeat(64) } }) } });
    await assert.rejects(f.invoke(f.fresh()), { code: 'research_context_application_invalid' }); callsOnce(f, 1);
  }
});

type D83Driver = { child: ChildProcess; exit: Promise<void>; stderr: () => string };
type D83Checkpoint = { pid: number; call?: string; requestId?: string };

async function d83StopOwner(driver: D83Driver): Promise<void> {
  if (driver.child.exitCode === null && driver.child.signalCode === null) driver.child.kill('SIGKILL');
  await driver.exit;
}

async function d83StopProvider(identity: ProcessIdentity): Promise<void> {
  // Test cleanup only; production loss is proved by prepareModelCallRecovery.
  // EOF after owner death can already have stopped this exact provider.
  if (processStart(identity.pid) !== identity.started) return;
  try { process.kill(identity.pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 10_000;
  while (processStart(identity.pid) === identity.started) {
    assert.ok(Date.now() < deadline, 'The local provider must terminate before recovery');
    await d83Delay(10);
  }
}

async function d83Checkpoint(path: string, driver: D83Driver): Promise<D83Checkpoint> {
  if (!existsSync(path)) await new Promise<void>((resolve, reject) => {
    let deadline: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      clearTimeout(deadline); watcher.close(); driver.child.off('exit', ended);
      if (error) reject(error); else resolve();
    };
    const ended = () => {
      if (existsSync(path)) finish();
      else finish(new Error(`Assessment driver exited before ${path}: ${driver.stderr()}`));
    };
    const watcher = watch(dirname(path), () => { if (existsSync(path)) finish(); });
    deadline = setTimeout(() => finish(new Error(`Assessment checkpoint timeout: ${driver.stderr()}`)), 15_000);
    driver.child.once('exit', ended);
    if (existsSync(path)) finish();
    else if (driver.child.exitCode !== null || driver.child.signalCode !== null) ended();
  });
  return JSON.parse(readFileSync(path, 'utf8')) as D83Checkpoint;
}

async function d83PhysicalFixture(t: test.TestContext, providerMode: 'block' | 'answer' = 'block') {
  const root = mkdtempSync(join(tmpdir(), 'omg-assessment-loss-')), workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'README.md'), 'Local assessment process fixture\n');
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  execFileSync('git', ['add', 'README.md'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=OM fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Local fixture'], { cwd: workspace });
  const database = join(root, 'store.sqlite'), store = new Store(database), engine = new ProductEngine(store);
  const drivers: D83Driver[] = [], providers: ProcessIdentity[] = [];
  t.after(async () => {
    for (const driver of drivers) await d83StopOwner(driver);
    // An assertion might fail after spawn but before the test registered the provider.
    for (const call of store.list<ModelCall>('model-call')) {
      const identity = call.value.providerProcess;
      if (identity && !providers.some(item => item.pid === identity.pid && item.started === identity.started)) providers.push(identity);
    }
    for (const provider of providers) await d83StopProvider(provider);
    store.close(); rmSync(root, { recursive: true, force: true });
  });
  await engine.execute({ type: 'create-project', project: 'p', title: 'Local assessment loss' });
  const wire = join(root, 'wire.ndjson'), received = join(root, 'provider-received.json'), late = join(root, 'late-result.json'), adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, `import{appendFileSync,readFileSync,writeFileSync}from'node:fs';
const request=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify(request)+'\\n');
writeFileSync(${JSON.stringify(received)},JSON.stringify({pid:process.pid,requestId:request.requestId}));
if(${JSON.stringify(providerMode)}==='answer')console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,
 research:{verdict:'supported',reasons:[]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));
else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 120_000 }, 0);
  const source = engine.discovery.evidence.document('p', 'assessment-evidence', 'AB', 'text/plain', 0);
  const observation = engine.discovery.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: 2 });
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation', [{ field: 'combine', kind: 'design',
    prompt: 'Combine the two documented operands', risk: 'Omitting one operand', schema: { type: 'object', required: ['result'],
      properties: { result: { type: 'string' } }, additionalProperties: false } }]);
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const context = { role: 'assess-answer', question: { id: question.id, ...question.value.spec },
    resources: { a: 'A', b: 'B' }, workingSelections: [], readings: [], value: { result: 'AB' }, observations: [observation] };
  const prompt = 'Judge whether the candidate uses both original operands';
  const input = join(root, 'input.json'), driverPath = join(root, 'driver.mjs'), claimed = join(root, 'claimed.json');
  writeFileSync(input, JSON.stringify({ database, draft, question, environment, dispatch: environment.value, context, prompt, claimed, late }));
  writeFileSync(driverPath, `import{readFileSync,writeFileSync}from'node:fs';
import{Store}from${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import{assessmentSession}from${JSON.stringify(new URL('../src/discovery/assessment-session.js', import.meta.url).href)};
const spec=JSON.parse(readFileSync(process.argv[2],'utf8')),mode=process.argv[3],store=new Store(spec.database);
const original=store.writeMany.bind(store);let stopped=false;
store.writeMany=(writes,guards=[])=>{
 const receipt=writes.find(write=>write.kind==='model-response'&&write.value.assessmentExecution);
 if(!stopped&&mode==='receipt-before-persist'&&receipt){
  stopped=true;writeFileSync(spec.late,JSON.stringify({process:{...receipt.value.assessmentExecution.process,stdout:receipt.value.text},launchError:null}));
  process.exit(73);
 }
 const saved=original(writes,guards);
 const claim=writes.find(write=>write.kind==='model-call'&&write.expected===0&&write.value.execution?.phase==='claimed');
 if(!stopped&&claim&&(mode==='claimed-exit'||mode==='claimed-hold')){
  if(!writes.some(write=>write.kind==='assessment-application'&&write.value.state==='running'))throw Error('Admission lost its atomic application binding');
  stopped=true;writeFileSync(spec.claimed,JSON.stringify({pid:process.pid,call:claim.id}));
  if(mode==='claimed-exit')process.exit(71);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 }
 return saved;
};
try{await assessmentSession(store,spec.draft,spec.question,spec.environment,spec.dispatch,undefined,spec.context,spec.prompt);throw Error('Unexpected completed driver');}
catch(error){console.error(error?.stack??String(error));process.exitCode=72;}
finally{store.close();}
`);
  const start = (mode: 'claimed-exit' | 'claimed-hold' | 'delivered' | 'receipt-before-persist'): D83Driver => {
    const child = spawn(process.execPath, [driverPath, input, mode], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr!.on('data', buffer => { stderr += buffer.toString(); }); child.stdout!.resume();
    const exit = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
    const driver = { child, exit, stderr: () => stderr }; drivers.push(driver); return driver;
  };
  const invoke = (db: Store) => assessmentSession(db, draft, question, environment, environment.value, undefined, context, prompt);
  const sent = () => existsSync(wire) ? readFileSync(wire, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { root, database, store, draft, question, environment, context, claimed, received, late, providers, start, invoke, sent };
}

function d83BoundCall(f: Awaited<ReturnType<typeof d83PhysicalFixture>>, db = f.store) {
  assert.equal(db.list('model-call').length, 1);
  const call = db.list<ModelCall>('model-call')[0]!, admission = db.get<ModelCall>(call.id, 1)!;
  const session = db.list<any>('assessment-session')[0]!, application = db.list<any>('assessment-application')[0]!;
  assert.ok(session.id.startsWith('assessment-session:v1:'));
  assert.equal(application.value.state, 'running');
  assert.deepEqual(application.value.call, reference(admission));
  assert.equal(admission.revision, 1); assert.equal(admission.value.execution?.phase, 'claimed');
  assert.deepEqual((admission.value as ModelCall & { assessmentApplication: unknown }).assessmentApplication,
    reference(db.get(application.id, 1)!));
  assert.equal(session.value.result, null); assert.equal(session.value.offset, 0);
  return { call, admission, session, application };
}

async function d83ExpectRecovered(f: Awaited<ReturnType<typeof d83PhysicalFixture>>, sentCount: number, physical: 'unknown' | 'group-terminated') {
  const restarted = new Store(f.database);
  try {
    await assert.rejects(f.invoke(restarted), { code: 'research_context_application_refused' });
    const call = restarted.list<ModelCall>('model-call')[0]!, application = restarted.list<any>('assessment-application')[0]!;
    assert.equal(call.value.status, 'failed'); assert.equal(call.value.error, 'process_lost');
    assert.equal(call.value.response, null); assert.equal(call.value.usage, null); assert.equal(call.value.usageSource, 'unavailable');
    const proof = readModelCallRecovery(restarted, 'p', reference(call));
    assert.equal(proof.proof.physical, physical);
    assert.equal(application.value.state, 'refused');
    assert.deepEqual(application.value.refusal, { kind: 'call', call: reference(call), code: 'process_lost' });
    assert.deepEqual(application.value.call, reference(restarted.get(call.id, 1)!));
    assert.equal(restarted.list<any>('assessment-session')[0]!.value.result, null);
    assert.equal(restarted.get<Question>(f.question.id)!.value.status, 'open');
    assert.equal(restarted.list('model-call-recovery').length, 1); assert.equal(restarted.list('model-response').length, 0);
    const usage = modelUsage(restarted, 'p', 0);
    assert.equal(usage.active.length, 0); assert.equal(usage.cumulative.attempts, 1);
    assert.equal(usage.cumulative.unmeasuredCalls, 1); assert.equal(usage.cumulative.measuredCalls, 0);
    assert.equal(usage.cumulative.reportedTokens, null); assert.equal(f.sent().length, sentCount);
    const heads = restarted.list(), lengths = heads.map(row => [row.id, restarted.history(row.id).length]);
    await assert.rejects(f.invoke(restarted), { code: 'research_context_application_refused' });
    assert.deepEqual(restarted.list(), heads);
    assert.deepEqual(heads.map(row => [row.id, restarted.history(row.id).length]), lengths);
  } finally { restarted.close(); }
  const again = new Store(f.database);
  try {
    const heads = again.list();
    await assert.rejects(f.invoke(again), { code: 'research_context_application_refused' });
    assert.deepEqual(again.list(), heads); assert.equal(f.sent().length, sentCount);
  } finally { again.close(); }
}

test('assessment application recovers a real owner exit after atomic claim before provider spawn', async t => {
  const f = await d83PhysicalFixture(t), driver = f.start('claimed-exit');
  const checkpoint = await d83Checkpoint(f.claimed, driver); await driver.exit;
  assert.equal(driver.child.exitCode, 71, driver.stderr()); assert.equal(checkpoint.pid, driver.child.pid);
  const { call } = d83BoundCall(f);
  assert.equal(call.value.execution?.phase, 'claimed'); assert.equal(call.value.providerProcess, undefined);
  assert.equal(call.value.execution?.owner.pid, driver.child.pid); assert.equal(f.sent().length, 0);
  await d83ExpectRecovered(f, 0, 'unknown');
});

test('assessment application refuses a new call while the real claimed owner remains alive', async t => {
  const f = await d83PhysicalFixture(t), driver = f.start('claimed-hold');
  await d83Checkpoint(f.claimed, driver);
  const { call } = d83BoundCall(f); assert.equal(call.value.execution?.owner.pid, driver.child.pid);
  const restarted = new Store(f.database);
  try {
    const before = restarted.list();
    await assert.rejects(f.invoke(restarted), { code: 'research_context_application_running' });
    assert.deepEqual(restarted.list(), before); assert.equal(restarted.list('model-call').length, 1);
    assert.equal(f.sent().length, 0); assert.equal(restarted.list('model-call-recovery').length, 0);
    assert.equal(modelUsage(restarted, 'p', 0).active.length, 1);
  } finally { restarted.close(); }
  await d83StopOwner(driver);
  await d83ExpectRecovered(f, 0, 'unknown');
});

test('assessment application recovers real authorized owner and provider loss without receipt or a second send',
  { skip: process.platform === 'win32' }, async t => {
    const f = await d83PhysicalFixture(t), driver = f.start('delivered');
    const checkpoint = await d83Checkpoint(f.received, driver), { call } = d83BoundCall(f);
    assert.equal(call.value.execution?.phase, 'authorized'); assert.equal(call.value.execution?.owner.pid, driver.child.pid);
    const provider = call.value.providerProcess!; f.providers.push(provider);
    assert.equal(provider.pid, checkpoint.pid); assert.equal(call.value.requestId, checkpoint.requestId);
    assert.equal(f.sent().length, 1); assert.equal(call.value.response, null);
    await d83StopOwner(driver);
    // The independently living supplier still forbids recovery after owner death.
    const live = new Store(f.database);
    try {
      const before = live.list();
      await assert.rejects(f.invoke(live), { code: 'research_context_application_running' });
      assert.deepEqual(live.list(), before); assert.equal(f.sent().length, 1);
    } finally { live.close(); }
    await d83StopProvider(provider);
    await d83ExpectRecovered(f, 1, 'group-terminated');
  });

test('new assessment era retains a late physical answer after process loss without applying or resending it',
  { skip: process.platform === 'win32' }, async t => {
    const f = await d83PhysicalFixture(t, 'answer'), driver = f.start('receipt-before-persist');
    await driver.exit;
    assert.equal(driver.child.exitCode, 73, driver.stderr());
    assert.equal(f.sent().length, 1);
    const evidence = JSON.parse(readFileSync(f.late, 'utf8')) as Parameters<typeof prepareLateModelReceipt>[3];
    assert.ok(evidence.process);
    assert.equal(evidence.process.exitCode, 0);
    assert.deepEqual(JSON.parse(evidence.process.stdout), { protocol: 'omg-agent/v1', requestId: f.sent()[0]!.requestId,
      research: verdict, usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0 } });
    const { call: dispatched, admission } = d83BoundCall(f);
    assert.equal(dispatched.value.execution?.phase, 'authorized');
    assert.equal(f.store.list('model-response').length, 0);
    const recoveredStore = new Store(f.database);
    try {
      await assert.rejects(f.invoke(recoveredStore), { code: 'research_context_application_refused' });
      const recovered = recoveredStore.get<ModelCall>(dispatched.id)!, app = recoveredStore.list<any>('assessment-application')[0]!;
      assert.equal(recovered.value.status, 'failed');
      assert.equal(recovered.value.error, 'process_lost');
      assert.deepEqual(app.value.call, reference(admission));
      assert.deepEqual(app.value.refusal, { kind: 'call', call: reference(recovered), code: 'process_lost' });
      const recovery = readModelCallRecovery(recoveredStore, 'p', reference(recovered));
      assert.deepEqual(reference(recovery.original), reference(dispatched));
      const prepared = prepareLateModelReceipt(recoveredStore, 'p', reference(dispatched), evidence);
      assert.equal(prepared.writes.length, 1);
      const receipt = recoveredStore.writeMany<LateModelReceipt>(prepared.writes, prepared.guards)[0]!;
      assert.deepEqual(reference(receipt), reference(prepared.record));
      assert.deepEqual(readLateModelReceipt(recoveredStore, 'p', reference(recovered)), receipt);
      assert.equal(receipt.value.evidence.process?.stdout, evidence.process.stdout);
      assert.equal(prepareLateModelReceipt(recoveredStore, 'p', reference(dispatched), evidence).writes.length, 0);
      const saved = recoveredStore.list(), histories = saved.map(row => [row.id, recoveredStore.history(row.id).length]);
      for (let reopen = 0; reopen < 2; reopen++) {
        const again = new Store(f.database);
        try {
          await assert.rejects(f.invoke(again), { code: 'research_context_application_refused' });
          assert.deepEqual(again.list(), saved);
          assert.deepEqual(saved.map(row => [row.id, again.history(row.id).length]), histories);
          assert.deepEqual(again.get<ModelCall>(dispatched.id), recovered);
          assert.deepEqual(readModelCallRecovery(again, 'p', reference(recovered)), recovery);
          assert.deepEqual(readLateModelReceipt(again, 'p', reference(recovered)), receipt);
          assert.equal(again.list('model-response').length, 0);
          assert.equal(again.list<any>('assessment-application')[0]!.value.state, 'refused');
          assert.ok(again.history<any>(app.id).every(row => row.value.state !== 'applied' && row.value.state !== 'retryable'));
          const usage = modelUsage(again, 'p', 0);
          assert.equal(usage.cumulative.attempts, 1);
          assert.equal(usage.cumulative.unmeasuredCalls, 1);
          assert.equal(usage.cumulative.measuredCalls, 0);
          assert.equal(usage.cumulative.reportedTokens, null);
          assert.equal(f.sent().length, 1);
        } finally { again.close(); }
      }
    } finally { recoveredStore.close(); }
  });

// Required existing imports: test from node:test; assert from node:assert/strict.
// All other imports are local to this regression, so it can be appended to the main test file.
test('D8.3 reads byte-identical assessment history from the whole b603c2b producer after two restarts without dispatch', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { createRequire } = await import('node:module');
  const { execFileSync } = await import('node:child_process');
  const { Store } = await import('../src/storage/store.js');
  const { assessmentSession } = await import('../src/discovery/assessment-session.js');
  const { canonical } = await import('../src/canonical.js');
  const directory = mkdtempSync(join(tmpdir(), 'omg-d83-history-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const loader = join(directory, 'base-loader.mjs'), producer = join(directory, 'base-producer.mjs');
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from ${JSON.stringify(typescript)};
let root;
export function initialize(data) { root = data.root; }
export async function load(url, context, next) {
  const prefix = new URL('dist/', root).href;
  if (url.startsWith(prefix) && /\\.js$/.test(url)) {
    const relative = url.slice(prefix.length).replace(/\\.js$/, '.ts');
    const source = execFileSync('git', ['show', 'b603c2b422f83f64fd7ca9bf80fa412dde5b9370:' + relative],
      { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return next(url, context);
}
`);
  writeFileSync(producer, `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository, directory] = process.argv.slice(2);
const src = path => pathToFileURL(join(repository, 'dist/src', path)).href;
const { Store } = await import(src('storage/store.js'));
const { Discovery } = await import(src('discovery/discovery.js'));
const { Environments } = await import(src('runtime/environment.js'));
const { assessmentSession } = await import(src('discovery/assessment-session.js'));
const { canonical, hashJson } = await import(src('canonical.js'));
const { reference } = await import(src('pipeline/contracts.js'));
const database = join(directory, 'history.sqlite'), adapter = join(directory, 'adapter.mjs');
writeFileSync(adapter, "import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{verdict:'supported',reasons:[]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));");
const store = new Store(database);
try {
  const discovery = new Discovery(store), command = { executable: process.execPath, args: [adapter] };
  const environment = new Environments(store).configure('p', { workspace: directory,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 3000 }, 0);
  const draft = discovery.create('p', 'features', 'R0', 'features', [{ field: 'proposal', kind: 'design',
    prompt: 'Assess the local proposal', risk: 'Its result must preserve the exact evidence',
    schema: { type: 'object', required: ['design'], properties: { design: { type: 'string' } }, additionalProperties: false } }]);
  const question = store.get(draft.value.questions[0]);
  const source = discovery.evidence.document('p', 'basis', 'The local result is a concrete design.', 'text/plain', 0);
  const context = { role: 'assess-answer', value: { design: 'A local result' },
    observations: [discovery.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: source.value.content.length })] };
  const prompt = 'Assess the actual local proposal against its evidence';
  const result = await assessmentSession(store, draft, question, environment, environment.value, undefined, context, prompt);
  const session = store.list('assessment-session')[0];
  assert.deepEqual(result, { verdict: 'supported', reasons: [] });
  assert.equal(session.id, 'assessment-session:' + hashJson([reference(question), reference(environment), draft.value.inputs, context]));
  assert.equal(Object.hasOwn(session.value, 'contract'), false);
  assert.equal(Object.hasOwn(session.value, 'application'), false);
  assert.equal(store.list('assessment-application').length, 0);
  assert.equal(store.list('model-call').length, 1);
  assert.equal(store.list('model-response').length, 1);
  assert.equal(Object.hasOwn(store.list('model-response')[0].value, 'assessmentExecution'), false);
  const rows = store.list().flatMap(head => store.history(head.id));
  for (const row of rows) assert.equal(hashJson(row.value), row.hash);
  process.stdout.write(JSON.stringify({ database, adapter, draft, question, environment, context, prompt, result, session,
    rows, historyBytes: canonical(rows) }));
} finally { store.close(); }
`);
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},
  { data: { root: ${JSON.stringify(pathToFileURL(repository).href)} } });`;
  const environmentVariables = { ...process.env };
  delete environmentVariables.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, producer, repository, directory],
    { cwd: repository, env: environmentVariables, encoding: 'utf8', timeout: 60_000, maxBuffer: 20_000_000 });
  const old = JSON.parse(output);
  // A mistaken current-era dispatch must fail rather than quietly produce a matching verdict.
  writeFileSync(old.adapter, "throw new Error('Historical completed assessments must not dispatch');\n");
  assert.equal(old.session.value.contract, undefined);
  assert.equal(old.session.value.application, undefined);
  assert.ok(old.rows.some((row: { kind: string }) => row.kind === 'model-response'));
  for (const row of old.rows.filter((row: { kind: string }) => row.kind === 'model-response'))
    assert.equal(Object.hasOwn(row.value, 'assessmentExecution'), false, 'The whole old producer predates the physical receipt contract');
  for (let restart = 0; restart < 2; restart++) {
    const store = new Store(old.database);
    try {
      const history = () => canonical(store.list().flatMap(head => store.history(head.id)));
      assert.equal(history(), old.historyBytes, 'All original values, record hashes, revisions and ordering survive reopen');
      for (const row of old.rows) assert.deepEqual(store.get(row.id, row.revision), row);
      for (let repeat = 0; repeat < 2; repeat++) {
        const before = store.get<any>(old.session.id, 1)!, call = store.list<ModelCall>('model-call')[0]!;
        const execution = readResearchExecution(store, 'p', reference(call), before, old.draft, old.question, old.environment.value.reviewer, null);
        assert.equal(execution.kind, 'response');
        if (execution.kind === 'response') assert.deepEqual(execution.payload, old.result);
        assert.deepEqual(readResearchResponse(store, 'p', reference(call), before, old.draft, old.question,
          old.environment.value.reviewer, null).payload, old.result);
        assert.deepEqual(await assessmentSession(store, old.draft, old.question, old.environment, old.environment.value,
          undefined, old.context, old.prompt), old.result);
        assert.deepEqual(store.get(old.session.id, old.session.revision), old.session);
        assert.equal(history(), old.historyBytes, 'Reading the previous producer must not add application records or rewrite any old bytes');
        assert.equal(store.list('model-call').length, 1);
        assert.equal(store.list('model-response').length, 1);
        assert.equal(store.list('assessment-application').length, 0);
      }
    } finally { store.close(); }
  }
  await t.test('an explicit null contract on the genuine old session cannot select legacy execution', async () => {
    const writer = new Store(old.database);
    const changed = writer.write<any>({ id: old.session.id, kind: old.session.kind, expected: old.session.revision,
      value: { ...old.session.value, contract: null } });
    writer.close();
    const store = new Store(old.database);
    try {
      const heads = store.list(), call = store.list<ModelCall>('model-call')[0]!;
      for (const read of [readResearchExecution, readResearchResponse])
        assert.throws(() => read(store, 'p', reference(call), changed, old.draft, old.question, old.environment.value.reviewer, null),
          { code: 'response_recovery_session_stale' });
      await assert.rejects(assessmentSession(store, old.draft, old.question, old.environment, old.environment.value,
        undefined, old.context, old.prompt), { code: 'response_recovery_session_stale' });
      assert.deepEqual(store.list(), heads);
      for (const row of old.rows) assert.deepEqual(store.get(row.id, row.revision), row);
      assert.equal(store.list('model-call').length, 1); assert.equal(store.list('model-response').length, 1);
      assert.equal(store.list('assessment-application').length, 0);
    } finally { store.close(); }
  });
});

test('new assessment-era response without assessmentExecution is rejected by both exact readers and ordinary application after restart', async t => {
  const f = resumeFixture(t), original = f.store.writeMany.bind(f.store);
  let stripped = false, originalResponse: any, preserved: any[] = [];
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!stripped && writes.some(write => write.kind === 'model-response')) {
      stripped = true;
      const changed = structuredClone(writes), response = changed.find(write => write.kind === 'model-response')!;
      const call = changed.find(write => write.kind === 'model-call')!;
      originalResponse = structuredClone(response.value);
      assert.ok(Object.hasOwn(originalResponse, 'assessmentExecution'));
      Reflect.deleteProperty(response.value as Record<string, unknown>, 'assessmentExecution');
      (call.value as ModelCall).response!.record!.hash = hashJson(response.value);
      const current = call.value as ModelCall;
      preserved = [f.store.list<any>('assessment-session')[0]!, f.store.list<any>('assessment-application')[0]!,
        f.store.get(current.request.record!.id, current.request.record!.revision)!,
        f.store.get(current.packet!.archive.id, current.packet!.archive.revision)!].map(row => structuredClone(row));
      assert.equal(preserved[0].value.contract, 'assessment-application/v1');
      return original(changed, guards);
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  try { await assert.rejects(f.invoke(), { code: 'research_context_application_invalid' }); }
  finally { f.store.writeMany = original; }
  assert.ok(stripped); callsOnce(f, 1);
  const call = f.store.list<ModelCall>('model-call')[0]!, ref = call.value.response!.record!;
  const response = f.store.get<any>(ref.id, ref.revision)!;
  const expected = structuredClone(originalResponse); Reflect.deleteProperty(expected, 'assessmentExecution');
  assert.equal(response.hash, ref.hash); assert.deepEqual(response.value, expected);
  assert.equal(call.value.status, 'succeeded'); assert.equal(call.value.error, null);
  const heads = f.store.list(), usage = modelUsage(f.store, 'p', 0);
  for (const db of [f.store, f.fresh()]) {
    for (const row of preserved) assert.deepEqual(db.get(row.id, row.revision), row);
    const app = db.list<any>('assessment-application')[0]!, session = db.get<any>(app.value.session.id, app.value.session.revision)!;
    assert.equal(session.value.contract, 'assessment-application/v1'); assert.equal(session.value.result, null);
    assert.equal(app.value.state, 'running');
    for (const read of [readResearchExecution, readResearchResponse])
      assert.throws(() => read(db, 'p', reference(call), session, f.draft, f.question, app.value.role, app.value.profile),
        { code: 'response_recovery_execution_invalid' });
    await assert.rejects(f.invoke(db), { code: 'research_context_application_invalid' });
    assert.equal(db.list<any>('assessment-application').some(row => row.value.state === 'applied'), false);
    assert.deepEqual(db.list(), heads); assert.deepEqual(modelUsage(db, 'p', 0), usage); callsOnce(f, 1, db);
  }
});

for (const defect of ['missing-contract', 'null-contract', 'unknown-contract', 'missing-application'] as const) {
  test(`both exact response readers reject a saved new-era session with ${defect} after restart`, async t => {
    const f = resumeFixture(t), restore = interruptAt(f.store, writes => writes.some(write => write.kind === 'model-response'), true);
    try { await assert.rejects(f.invoke(), { code: 'fixture_application_crash' }); } finally { restore(); }
    const original = f.store.list<any>('assessment-session')[0]!, value = structuredClone(original.value);
    assert.ok(original.id.startsWith('assessment-session:v1:')); assert.equal(value.contract, 'assessment-application/v1');
    if (defect === 'missing-contract') Reflect.deleteProperty(value, 'contract');
    else if (defect === 'missing-application') Reflect.deleteProperty(value, 'application');
    else value.contract = defect === 'null-contract' ? null : 'assessment-application/unknown';
    const changed = f.store.write<any>({ id: original.id, kind: original.kind, expected: original.revision, value });
    const call = f.store.list<ModelCall>('model-call')[0]!, heads = f.store.list();
    for (const db of [f.store, f.fresh()]) {
      for (const read of [readResearchExecution, readResearchResponse])
        assert.throws(() => read(db, 'p', reference(call), changed, f.draft, f.question, f.environment.value.reviewer, null),
          { code: 'response_recovery_session_stale' });
      await assert.rejects(f.invoke(db), { code: 'research_context_application_invalid' });
      assert.deepEqual(db.list(), heads); callsOnce(f, 1, db);
      assert.equal(db.list<any>('assessment-application').some(row => row.value.state === 'applied'), false);
    }
  });
}

for (const defect of ['missing-received', 'missing-resolution', 'null-received'] as const) {
  test(`received-response refusal with ${defect} fails both direct history and its exact barrier witness`, async t => {
    const f = resumeFixture(t), candidate = d83BarrierCandidate(f, `incomplete-refusal-${defect}`);
    const parked = await d83ParkBarrierReceipt(f, candidate); candidate.invalidate();
    const original = f.store.writeMany.bind(f.store); let changed = false;
    f.store.writeMany = ((writes: Write[], guards = []) => {
      if (!changed && writes.some(write => write.kind === 'assessment-barrier')) {
        changed = true;
        const altered = structuredClone(writes), app = altered.find(write => write.kind === 'assessment-application')!;
        const barrier = altered.find(write => write.kind === 'assessment-barrier')!;
        const value = app.value as any;
        assert.equal(value.state, 'refused'); assert.deepEqual(value.received, reference(parked.call));
        assert.ok(Object.hasOwn(value, 'resolution'));
        if (defect === 'null-received') value.received = null;
        else Reflect.deleteProperty(value, defect === 'missing-received' ? 'received' : 'resolution');
        (barrier.value as any).refusal.hash = hashJson(value);
        return original(altered, guards);
      }
      return original(writes, guards);
    }) as typeof f.store.writeMany;
    try { await assert.rejects(candidate.invoke(), (error: unknown) => {
      assert.ok(error instanceof EngineError); assert.ok(['research_context_application_refused', 'research_context_application_invalid'].includes(error.code)); return true;
    }); } finally { f.store.writeMany = original; }
    assert.ok(changed);
    const barrier = f.store.list<any>('assessment-barrier')[0]!, app = f.store.get<any>(parked.application.id)!;
    assert.equal(barrier.revision, 1); assert.deepEqual(barrier.value.refusal, reference(app));
    const heads = f.store.list(), usage = modelUsage(f.store, 'p', 0);
    for (const db of [f.store, f.fresh()]) {
      await assert.rejects(candidate.invoke(db), { code: 'research_context_application_invalid' });
      await assert.rejects(assessmentSession(db, f.draft, f.question, f.environment, f.environment.value, undefined,
        { ...candidate.context, consumerFeedback: [`Read the exact malformed ${defect} barrier`] }, 'Read refusal integrity'),
      { code: 'research_context_application_invalid' });
      assert.deepEqual(db.list(), heads); assert.deepEqual(modelUsage(db, 'p', 0), usage); callsOnce(f, 1, db);
      assert.deepEqual(db.get(parked.call.id), parked.call);
    }
  });
}

for (const state of ['prepared', 'running', 'retryable'] as const) {
  test(`new-era ${state} application cannot omit its explicit nullable resolution`, async t => {
    const f = resumeFixture(t);
    if (state === 'retryable') {
      d83EmptyProviderThenSuccess(f); await assert.rejects(f.invoke(), { code: 'research_provider_failed' });
    } else {
      const restore = interruptAt(f.store, writes => writes.some(write => state === 'prepared'
        ? write.kind === 'assessment-application' && (write.value as any).state === 'prepared' : write.kind === 'model-response'), true);
      try { await assert.rejects(f.invoke(), { code: 'fixture_application_crash' }); } finally { restore(); }
    }
    const app = f.store.list<any>('assessment-application')[0]!;
    assert.equal(app.value.state, state); assert.equal(app.value.resolution, null);
    const value = structuredClone(app.value); Reflect.deleteProperty(value, 'resolution');
    f.store.write({ id: app.id, kind: app.kind, expected: app.revision, value });
    const heads = f.store.list(), calls = f.sent().length, usage = modelUsage(f.store, 'p', 0);
    await assert.rejects(f.invoke(), { code: 'research_context_application_invalid' });
    await assert.rejects(f.invoke(f.fresh()), { code: 'research_context_application_invalid' });
    assert.deepEqual(f.store.list(), heads); assert.equal(f.sent().length, calls); assert.deepEqual(modelUsage(f.store, 'p', 0), usage);
  });
}

async function d83PreparedTransport(t: test.TestContext) {
  const f = resumeFixture(t), restore = interruptAt(f.store, writes => writes.some(write =>
    write.kind === 'assessment-application' && (write.value as any).state === 'prepared'), true);
  try { await assert.rejects(f.invoke(), { code: 'fixture_application_crash' }); } finally { restore(); }
  const application = f.store.list<any>('assessment-application')[0]!, app = application.value;
  const session = f.store.get<any>(app.session.id, app.session.revision)!;
  const context = { ...app.context, assessmentSession: session.id, assessmentState: { offset: session.value.offset,
    candidateOffset: session.value.candidateOffset ?? 0, total: JSON.stringify(app.context.observations).length },
    assessmentNotes: session.value.notes, contextWorkspace: [], focus: null };
  const audit = (db: Store): any => ({ store: db, draftId: f.draft.id, questionId: f.question.id, purpose: 'assessor',
    session: reference(session), application: reference(application), prepareCall: (call: Write) => ({
      writes: [{ id: application.id, kind: application.kind, expected: application.revision,
        value: { ...app, state: 'running', call: { id: call.id, revision: call.expected + 1, hash: hashJson(call.value) } } }],
      guards: uniqueTransactionGuards([reference(application), reference(session), ...app.guards]),
    }) });
  return { f, application, app, session, context, audit };
}

test('direct researchCall preserves a complete new-era audit and ordinary application consumes its single receipt', async t => {
  const { f, application, app, session, context, audit } = await d83PreparedTransport(t);
  assert.deepEqual(await researchCall(app.role, app.dispatch, app.prompt, context, undefined, audit(f.store)), verdict);
  callsOnce(f, 1); assert.equal(f.store.get<any>(application.id)!.value.state, 'running');
  assert.deepEqual(f.store.get(session.id), session);
  assert.deepEqual(await f.invoke(f.fresh()), verdict); callsOnce(f, 1);
});

test('a saved prepared application without dispatch fails before reservation in the same and fresh Store', async t => {
  const f = resumeFixture(t), original = f.store.writeMany.bind(f.store); let omitted = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!omitted && writes.some(write => write.kind === 'assessment-application' && write.expected === 0)) {
      omitted = true;
      const changed = structuredClone(writes), application = changed.find(write => write.kind === 'assessment-application')!;
      assert.ok(Object.hasOwn(application.value as object, 'dispatch'));
      Reflect.deleteProperty(application.value as Record<string, unknown>, 'dispatch');
      return original(changed, guards);
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  try { await assert.rejects(f.invoke(), { code: 'research_context_application_invalid' }); }
  finally { f.store.writeMany = original; }
  assert.ok(omitted);
  const application = f.store.list<any>('assessment-application')[0]!;
  assert.equal(application.revision, 1); assert.equal(application.value.state, 'prepared');
  assert.equal(Object.hasOwn(application.value, 'dispatch'), false);
  const heads = f.store.list();
  for (const db of [f.store, f.fresh()]) {
    await assert.rejects(f.invoke(db), { code: 'research_context_application_invalid' });
    assert.deepEqual(db.list(), heads); assert.equal(db.list('model-call').length, 0); assert.equal(db.list('model-response').length, 0);
    assert.equal(f.sent().length, 0); assert.equal(modelUsage(db, 'p', 0).cumulative.attempts, 0);
  }
});

for (const defect of ['audit-application', 'audit-prepareCall', 'audit-session', 'audit-draftId', 'audit-questionId', 'audit-pair', 'audit-all',
  'callback-result', 'callback-writes', 'callback-guards', 'callback-running-write',
  'guard-source', 'guard-absence', 'guard-session', 'guard-application'] as const) {
  test(`new-era researchCall rejects missing ${defect} before reservation and provider dispatch`, async t => {
    const { f, application, app, session, context, audit } = await d83PreparedTransport(t);
    const invoke = (db: Store) => {
      const damaged = audit(db);
      if (defect === 'audit-all') return researchCall(app.role, app.dispatch, app.prompt, context, undefined, undefined);
      if (defect === 'audit-pair') { Reflect.deleteProperty(damaged, 'application'); Reflect.deleteProperty(damaged, 'prepareCall'); }
      else if (defect.startsWith('audit-')) Reflect.deleteProperty(damaged, defect.slice('audit-'.length));
      else {
        const prepare = damaged.prepareCall;
        damaged.prepareCall = (call: Write) => {
          const prepared = prepare(call);
          if (defect === 'callback-result') return undefined;
          if (defect === 'callback-writes' || defect === 'callback-guards') Reflect.deleteProperty(prepared, defect.slice('callback-'.length));
          else if (defect === 'callback-running-write') prepared.writes = [];
          else {
            const id = defect === 'guard-source' ? f.source.id : defect === 'guard-session' ? session.id
              : defect === 'guard-application' ? application.id : prepared.guards.find((guard: any) => guard.absent === true)?.id;
            assert.ok(id); assert.ok(prepared.guards.some((guard: any) => guard.id === id));
            prepared.guards = prepared.guards.filter((guard: any) => guard.id !== id);
          }
          return prepared;
        };
      }
      return researchCall(app.role, app.dispatch, app.prompt, context, undefined, damaged);
    };
    for (const db of [f.store, f.fresh()]) {
      await assert.rejects(invoke(db), { code: 'research_context_application_invalid' });
      assert.deepEqual(db.get(application.id), application); assert.deepEqual(db.get(session.id), session);
      assert.equal(db.list('model-call').length, 0); assert.equal(db.list('model-response').length, 0); assert.equal(f.sent().length, 0);
      assert.equal(modelUsage(db, 'p', 0).cumulative.attempts, 0);
    }
  });
}

test('application refusal pauses ordinary research until explicit question reopen, without replaying paid calls', async t => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../src/storage/store.js');
  const { ProductEngine } = await import('../src/product/engine.js');
  const { Environments } = await import('../src/runtime/environment.js');
  const { modelUsage } = await import('../src/runtime/model-usage.js');
  const { reference } = await import('../src/pipeline/contracts.js');
  const root = mkdtempSync(join(tmpdir(), 'omg-d83-runner-reopen-'));
  const dbPath = join(root, 'state.sqlite'), wirePath = join(root, 'wire.ndjson'), adapterPath = join(root, 'adapter.mjs');
  let store = new Store(dbPath), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  engine.execute({ type: 'create-project', project: 'p', title: 'Local application-refusal fixture' });
  const source = engine.discovery.evidence.document('p', 'proof', JSON.stringify({ answer: 'result' }), 'application/json', 0);
  const sourceRef = reference(source);
  writeFileSync(adapterPath, `import { readFileSync, appendFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8')), context = request.subject;
appendFileSync(${JSON.stringify(wirePath)}, JSON.stringify({ requestId: request.requestId, role: context.role }) + '\\n');
if (!['research', 'assess-answer'].includes(context.role)) throw new Error('Unexpected role: ' + context.role);
const assessment = context.role === 'assess-answer';
const research = assessment ? { verdict: 'supported', reasons: [] } : {
  action: 'answer', question: context.questions[0].id, value: 'result',
  citations: [{ source: ${JSON.stringify(sourceRef)}, selector: { kind: 'json-pointer', pointer: '/answer' } }]
};
const usage = assessment
  ? { inputTokens: 17, outputTokens: 5, cachedInputTokens: 4, reasoningOutputTokens: 2 }
  : { inputTokens: 11, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 };
console.log(JSON.stringify({ protocol: request.protocol, requestId: request.requestId, research, usage }));`);
  const command = { executable: process.execPath, args: [adapterPath] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000,
  }, 0);
  const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation', [{
    field: 'answer', kind: 'design', prompt: 'Return the declared result', risk: 'Missing result', schema: { type: 'string' },
  }]);
  const question = store.get<any>(draft.value.questions[0]!)!;
  const initialQuestion = structuredClone(question);
  const calls = () => store.list<any>('model-call');
  const wire = (): { requestId: string; role: string }[] => readFileSync(wirePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const run = async () => await engine.execute({ type: 'research-draft', project: 'p', draftId: draft.id, maxTurns: 1 }) as any;
  const restart = () => { store.close(); store = new Store(dbPath); engine = new ProductEngine(store); };
  const originalWrite = store.writeMany.bind(store);
  let changed = false;
  store.writeMany = ((writes: any[], guards: any[] = []) => {
    const saved = originalWrite(writes, guards);
    // The physical response and succeeded call are already committed. A native
    // environment revision now invalidates only application of that paid result.
    if (!changed && writes.some(write => write.kind === 'model-call'
      && write.value.purpose === 'assessor' && write.value.status === 'succeeded')) {
      changed = true;
      const other = new Store(dbPath);
      try { new Environments(other).configure('p', environment.value, environment.revision); }
      finally { other.close(); }
    }
    return saved;
  }) as typeof store.writeMany;
  const first = await run();
  store.writeMany = originalWrite;
  assert.equal(changed, true, 'The injection must occur after actual assessor receipt');
  assert.equal(first.value.status, 'paused');
  assert.equal(first.value.pauseCode, 'research_context_application_refused');
  assert.equal(first.value.ownerQuestion, null);
  assert.deepEqual(store.get(question.id), initialQuestion, 'Application refusal must not reopen or answer the question');
  const pending = store.list<any>('research-turn').find(turn => turn.value.status === 'pending')!;
  assert.ok(pending);
  assert.deepEqual(pending.value.question, reference(question));
  assert.equal(pending.value.action.action, 'answer');
  assert.equal(pending.value.assessment, null);
  const refused = store.list<any>('assessment-application').find(application => application.value.state === 'refused')!;
  assert.ok(refused);
  const oldCalls = structuredClone(calls()), oldReceipt = oldCalls.find(call => call.value.purpose === 'assessor')!;
  const rawRef = oldReceipt.value.response.record;
  const raw = structuredClone(store.get<any>(rawRef.id, rawRef.revision)!);
  assert.deepEqual(wire().map(entry => entry.role), ['research', 'assess-answer']);
  assert.equal(oldCalls.length, 2);
  assert.equal(store.list('research-assessment').length, 0);
  assert.equal(store.list('research-answer').length, 0);

  restart();
  const unchanged = await run();
  assert.equal(unchanged.value.status, 'paused');
  assert.equal(unchanged.value.pauseCode, 'research_context_application_refused');
  assert.deepEqual(calls(), oldCalls, 'Restart/retry must not send analyst or assessor again');
  assert.deepEqual(wire().map(entry => entry.role), ['research', 'assess-answer']);
  assert.deepEqual(store.get(question.id), initialQuestion, 'Ordinary retry must not manufacture a new question revision');
  assert.deepEqual(store.get(pending.id), pending, 'The paid candidate remains pending');
  assert.deepEqual(store.get(refused.id), refused);
  assert.deepEqual(store.get(raw.id, raw.revision), raw);

  const current = store.get<any>(question.id)!;
  const reopened = engine.execute({ type: 'reopen-question', question: current.id, expected: current.revision }) as any;
  assert.equal(reopened.revision, current.revision + 1);
  assert.equal(reopened.value.status, 'open');
  assert.equal(reopened.id, current.id, 'Explicit reopen keeps the question identity');
  assert.throws(() => engine.execute({ type: 'reopen-question', question: current.id, expected: current.revision }), { code: 'question_stale' });
  restart();
  const completed = await run();
  assert.equal(completed.value.status, 'completed', completed.value.error ?? 'Expected supported answer');
  assert.equal(store.get<any>(question.id)!.value.status, 'answered');
  assert.deepEqual(wire().map(entry => entry.role), ['research', 'assess-answer', 'research', 'assess-answer']);
  assert.equal(calls().filter(call => call.value.purpose === 'assessor').length, 2, 'Reopen permits exactly one new assessor call');
  assert.equal(store.list('research-assessment').length, 1);
  assert.equal(store.list('research-answer').length, 1);
  assert.deepEqual(store.get(refused.id), refused, 'New work cannot rewrite the old refusal');
  assert.deepEqual(store.get(raw.id, raw.revision), raw);
  for (const previous of oldCalls) assert.deepEqual(store.get(previous.id), previous);

  // The adapter wire, immutable response and usage ledger agree one-to-one.
  const physical = calls();
  assert.equal(physical.length, wire().length);
  assert.equal(new Set(wire().map(entry => entry.requestId)).size, physical.length);
  assert.equal(store.list('model-response').length, physical.length);
  for (const call of physical) {
    const expected = call.value.purpose === 'assessor'
      ? { inputTokens: 17, outputTokens: 5, cachedInputTokens: 4, reasoningOutputTokens: 2 }
      : { inputTokens: 11, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 };
    assert.equal(call.value.status, 'succeeded');
    assert.equal(call.value.usageSource, 'adapter');
    assert.deepEqual(call.value.usage, expected);
    const receipt = call.value.response.record, saved = store.get<any>(receipt.id, receipt.revision)!;
    assert.equal(saved.hash, receipt.hash);
    const envelope = JSON.parse(saved.value.text);
    assert.equal(envelope.requestId, call.value.requestId);
    assert.deepEqual(envelope.usage, expected);
    assert.equal(wire().filter(entry => entry.requestId === call.value.requestId).length, 1);
  }
  const measured = modelUsage(store, 'p', 0).cumulative;
  assert.equal(measured.attempts, 4);
  assert.equal(measured.measuredCalls, 4);
  assert.equal(measured.unmeasuredCalls, 0);
  assert.deepEqual(measured.reportedTokens, { input: 56, output: 16, cachedInput: 12, reasoningOutput: 6 });
  const terminalCalls = structuredClone(calls()), terminalWire = readFileSync(wirePath, 'utf8');
  restart();
  assert.equal((await run()).value.status, 'completed');
  assert.deepEqual(calls(), terminalCalls);
  assert.equal(readFileSync(wirePath, 'utf8'), terminalWire);
});

function d83BarrierCandidate(f: ReturnType<typeof resumeFixture>, label: string, draft = f.draft, question = f.question) {
  const source = f.engine.discovery.evidence.document('p', label, 'AB', 'text/plain', 0);
  const observation = f.engine.discovery.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: 2 });
  const context = { ...f.context, question: { id: question.id, ...question.value.spec },
    consumerFeedback: [{ message: label }], observations: [observation] };
  const invoke = (db = f.store) => assessmentSession(db, draft, question, f.environment, f.environment.value, undefined,
    context, 'Assess the candidate with its exact private observation');
  const invalidate = (db = f.fresh()) => new ProductEngine(db).discovery.evidence.document('p', label, 'AB', 'text/plain', source.revision);
  return { context, invoke, invalidate, question, draft };
}
async function d83ParkBarrierReceipt(f: ReturnType<typeof resumeFixture>, candidate: ReturnType<typeof d83BarrierCandidate>, db = f.store) {
  const before = new Set(db.list('assessment-application').map(record => record.id));
  const restore = interruptAt(db, writes => writes.some(write => write.kind === 'model-response'), true);
  try { await assert.rejects(candidate.invoke(db), { code: 'fixture_application_crash' }); }
  finally { restore(); }
  const application = db.list<any>('assessment-application').find(record => !before.has(record.id))!;
  assert.ok(application); assert.equal(application.value.state, 'running');
  const call = db.get<any>(application.value.call.id)!;
  assert.equal(call.value.status, 'succeeded'); assert.ok(call.value.response.record);
  return { application, call, session: db.get<any>(application.value.session.id)! };
}
function d83QuestionBarrier(f: ReturnType<typeof resumeFixture>, db = f.store, question = f.question) {
  const id = `assessment-barrier:${hashJson(['p', reference(question)])}`, barrier = db.get<any>(id)!;
  assert.ok(barrier, 'The refused application must publish the question-revision barrier');
  assert.equal(barrier.kind, 'assessment-barrier'); assert.equal(barrier.value.contract, 'assessment-barrier/v1');
  assert.equal(barrier.value.projectId, 'p'); assert.deepEqual(barrier.value.question, reference(question));
  assert.equal(barrier.hash, hashJson(barrier.value));
  const witness = db.get<any>(barrier.value.refusal.id, barrier.value.refusal.revision)!;
  assert.ok(witness); assert.equal(witness.hash, barrier.value.refusal.hash); assert.equal(witness.value.state, 'refused');
  return barrier;
}

test('application refusal bars new feedback and candidate contexts for the same exact question after restart', async t => {
  const f = resumeFixture(t), candidate = d83BarrierCandidate(f, 'original-refusal');
  const parked = await d83ParkBarrierReceipt(f, candidate); candidate.invalidate();
  await assert.rejects(candidate.invoke(f.fresh()), { code: 'research_context_application_refused' });
  const barrier = d83QuestionBarrier(f), refusal = f.store.get<any>(parked.application.id)!;
  assert.deepEqual(barrier.value.refusal, reference(refusal)); assert.equal(barrier.revision, 1);
  const heads = f.store.list();
  for (const context of [
    { ...candidate.context, consumerFeedback: [{ message: 'Fresh feedback is not authority to restart' }] },
    { ...candidate.context, value: { result: 'A corrected candidate is not an explicit reopen' } },
    { ...f.context, value: { result: 'AB' }, consumerFeedback: [{ message: 'Entirely rebuilt context' }] },
  ]) {
    await assert.rejects(assessmentSession(f.fresh(), f.draft, f.question, f.environment, f.environment.value,
      undefined, context, 'Try a new context for the same question revision'), { code: 'research_context_application_refused' });
    assert.deepEqual(f.store.list(), heads, 'Blocked contexts must not create sessions or rewrite the barrier'); callsOnce(f, 1);
  }
  assert.deepEqual(f.store.get(f.question.id), f.question, 'A blocked call must not automatically reopen the question');
  assert.equal(f.store.history(barrier.id).length, 1);
});

test('a prepared assessment loses call reservation to a concurrent question barrier without partial writes or dispatch', async t => {
  const f = resumeFixture(t), witness = d83BarrierCandidate(f, 'reservation-witness');
  const parked = await d83ParkBarrierReceipt(f, witness);
  const restore = interruptAt(f.store, writes => writes.some(write => write.kind === 'assessment-session' && write.expected === 0), true);
  try { await assert.rejects(f.invoke(), { code: 'fixture_application_crash' }); } finally { restore(); }
  witness.invalidate();
  const competingStore = f.fresh(), current = f.fresh(), original = current.writeMany.bind(current);
  let competed = false, competing: Promise<void> | undefined;
  current.writeMany = ((writes: Write[], guards = []) => {
    if (!competed && writes.some(write => write.kind === 'model-call' && write.expected === 0)) {
      competed = true;
      competing = assert.rejects(witness.invoke(competingStore), { code: 'research_context_application_refused' });
      assert.ok(competingStore.get(`assessment-barrier:${hashJson(['p', reference(f.question)])}`), 'Competing refusal precedes the reserved-call transaction');
      return original([...writes, { id: 'reservation-neighbor-a', kind: 'fixture', expected: 0, value: {} },
        { id: 'reservation-neighbor-b', kind: 'fixture', expected: 0, value: {} }], guards);
    }
    return original(writes, guards);
  }) as typeof current.writeMany;
  try { await assert.rejects(f.invoke(current), { code: 'research_context_application_refused' }); }
  finally { current.writeMany = original; }
  assert.ok(competed); await competing;
  assert.equal(current.get('reservation-neighbor-a'), null); assert.equal(current.get('reservation-neighbor-b'), null);
  callsOnce(f, 1); assert.equal(current.list('model-request').length, 1);
  const barrier = d83QuestionBarrier(f, current);
  assert.deepEqual(barrier.value.refusal, reference(current.get(parked.application.id)!));
  assert.ok(current.list<any>('assessment-session').every(session => session.value.result === null));
  const heads = current.list(); await assert.rejects(f.invoke(f.fresh()), { code: 'research_context_application_refused' });
  assert.deepEqual(current.list(), heads); callsOnce(f, 1);
});

test('a concurrent barrier after another assessor receipt preserves response and usage but atomically refuses application', async t => {
  const f = resumeFixture(t), witness = d83BarrierCandidate(f, 'application-witness');
  const parked = await d83ParkBarrierReceipt(f, witness); witness.invalidate();
  const competingStore = f.fresh(), original = f.store.writeMany.bind(f.store);
  let competed = false, competing: Promise<void> | undefined;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!competed && writes.some(write => write.kind === 'assessment-session' && Boolean((write.value as any).result))) {
      competed = true;
      assert.equal(f.store.list('model-response').length, 2, 'Both actual receipts precede the application window');
      competing = assert.rejects(witness.invoke(competingStore), { code: 'research_context_application_refused' });
      assert.ok(competingStore.get(`assessment-barrier:${hashJson(['p', reference(f.question)])}`));
      return original([...writes, { id: 'application-neighbor-a', kind: 'fixture', expected: 0, value: {} },
        { id: 'application-neighbor-b', kind: 'fixture', expected: 0, value: {} }], guards);
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  try { await assert.rejects(f.invoke(), { code: 'research_context_application_refused' }); }
  finally { f.store.writeMany = original; }
  assert.ok(competed); await competing;
  callsOnce(f, 2); assert.equal(f.store.get('application-neighbor-a'), null); assert.equal(f.store.get('application-neighbor-b'), null);
  assert.ok(f.store.list<any>('assessment-session').every(session => session.value.result === null));
  assert.ok(f.store.list<any>('assessment-application').every(application => application.value.state !== 'applied'));
  const barrier = d83QuestionBarrier(f);
  assert.deepEqual(barrier.value.refusal, reference(f.store.get(parked.application.id)!));
  const calls = f.store.list('model-call'), responses = f.store.list('model-response');
  const db = f.fresh(); await assert.rejects(f.invoke(db), { code: 'research_context_application_refused' });
  assert.deepEqual(db.list('model-call'), calls); assert.deepEqual(db.list('model-response'), responses); callsOnce(f, 2, db);
  for (const call of db.list<ModelCall>('model-call')) {
    assert.equal(call.value.status, 'succeeded'); assert.equal(call.value.usageSource, 'adapter');
    const receipt = call.value.response!.record!, raw = db.get<any>(receipt.id, receipt.revision)!;
    assert.equal(raw.hash, receipt.hash); assert.equal(JSON.parse(raw.value.text).requestId, call.value.requestId);
  }
});

test('two concurrent application refusals preserve exactly the first barrier provenance', async t => {
  const f = resumeFixture(t), first = d83BarrierCandidate(f, 'first-refusal'), second = d83BarrierCandidate(f, 'second-refusal');
  const firstParked = await d83ParkBarrierReceipt(f, first), secondParked = await d83ParkBarrierReceipt(f, second);
  first.invalidate(); second.invalidate();
  const current = f.fresh(), competingStore = f.fresh(), original = current.writeMany.bind(current);
  let competed = false, competing: Promise<void> | undefined, winner: ReturnType<typeof d83QuestionBarrier> | undefined;
  current.writeMany = ((writes: Write[], guards = []) => {
    if (!competed && writes.some(write => write.kind === 'assessment-application' && (write.value as any).state === 'refused')) {
      competed = true;
      competing = assert.rejects(second.invoke(competingStore), { code: 'research_context_application_refused' });
      winner = structuredClone(d83QuestionBarrier(f, competingStore));
    }
    return original(writes, guards);
  }) as typeof current.writeMany;
  try { await assert.rejects(first.invoke(current), { code: 'research_context_application_refused' }); }
  finally { current.writeMany = original; }
  assert.ok(competed); await competing; assert.ok(winner);
  const barrier = d83QuestionBarrier(f, current);
  assert.deepEqual(barrier, winner); assert.equal(current.history(barrier.id).length, 1);
  assert.deepEqual(barrier.value.refusal, reference(current.get(secondParked.application.id)!));
  assert.equal(current.get<any>(firstParked.application.id)!.value.state, 'refused');
  assert.equal(current.get<any>(secondParked.application.id)!.value.state, 'refused');
  assert.equal(current.list('assessment-barrier').length, 1); callsOnce(f, 2, current);
  await assert.rejects(first.invoke(f.fresh()), { code: 'research_context_application_refused' });
  await assert.rejects(second.invoke(f.fresh()), { code: 'research_context_application_refused' });
  assert.deepEqual(current.get(barrier.id), winner); callsOnce(f, 2);
});

for (const semantic of ['insufficient', 'conflicting'] as const) {
  test(`applied ${semantic} is repeatable and permits correction without reopen; later barrier preserves both prior results`, async t => {
    const f = resumeFixture(t), responseFile = join(f.root, 'semantic.json'), negative = { verdict: semantic, reasons: ['The original proposal needs correction'] };
    writeFileSync(responseFile, JSON.stringify(negative));
    writeFileSync(f.environment.value.reviewer.command.args[0]!, `import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));appendFileSync(${JSON.stringify(join(f.root, 'wire.ndjson'))},JSON.stringify(r)+'\\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:JSON.parse(readFileSync(${JSON.stringify(responseFile)},'utf8')),usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
    assert.deepEqual(await f.invoke(), negative); callsOnce(f, 1); assert.equal(f.store.list('assessment-barrier').length, 0);
    writeFileSync(responseFile, JSON.stringify(verdict));
    const oldHeads = f.store.list(); assert.deepEqual(await f.invoke(f.fresh()), negative);
    assert.deepEqual(f.store.list(), oldHeads); callsOnce(f, 1);
    const corrected = { ...f.context, value: { result: 'AB with the requested correction' } };
    const correct = (db = f.store) => assessmentSession(db, f.draft, f.question, f.environment, f.environment.value,
      undefined, corrected, 'Assess the corrected candidate');
    assert.deepEqual(await correct(f.fresh()), verdict); callsOnce(f, 2);
    assert.deepEqual(f.store.get(f.question.id), f.question, 'Semantic correction does not require or manufacture reopen');
    assert.equal(f.store.list('assessment-barrier').length, 0);
    const refused = d83BarrierCandidate(f, `later-${semantic}`);
    await d83ParkBarrierReceipt(f, refused); refused.invalidate();
    await assert.rejects(refused.invoke(f.fresh()), { code: 'research_context_application_refused' });
    const barrier = d83QuestionBarrier(f), heads = f.store.list();
    assert.deepEqual(await f.invoke(f.fresh()), negative); assert.deepEqual(await correct(f.fresh()), verdict);
    assert.deepEqual(f.store.list(), heads); callsOnce(f, 3);
    await assert.rejects(assessmentSession(f.fresh(), f.draft, f.question, f.environment, f.environment.value, undefined,
      { ...corrected, consumerFeedback: ['Prior insufficient cannot erase a later technical refusal'] }, 'Try another correction'),
    { code: 'research_context_application_refused' });
    assert.deepEqual(f.store.get(barrier.id), barrier); callsOnce(f, 3);
  });
}

test('explicit reopen admits the new question revision and leaves the old barrier and its old-revision refusal intact', async t => {
  const f = resumeFixture(t), candidate = d83BarrierCandidate(f, 'reopen-witness');
  await d83ParkBarrierReceipt(f, candidate); candidate.invalidate();
  await assert.rejects(candidate.invoke(), { code: 'research_context_application_refused' });
  const barrier = d83QuestionBarrier(f), oldQuestion = f.store.get(f.question.id)!;
  const other = f.fresh(), engine = new ProductEngine(other);
  assert.throws(() => engine.execute({ type: 'reopen-question', question: f.question.id, expected: f.question.revision - 1 }), { code: 'question_stale' });
  const reopened = engine.execute({ type: 'reopen-question', question: f.question.id, expected: f.question.revision }) as typeof f.question;
  assert.equal(reopened.id, oldQuestion.id); assert.equal(reopened.revision, oldQuestion.revision + 1);
  assert.deepEqual(other.get(barrier.id), barrier);
  const db = f.fresh(); assert.deepEqual(await f.invoke(db, reopened), verdict); callsOnce(f, 2, db);
  assert.deepEqual(db.get(barrier.id), barrier); assert.equal(db.history(barrier.id).length, 1);
  assert.equal(db.get(`assessment-barrier:${hashJson(['p', reference(reopened)])}`), null);
  await assert.rejects(assessmentSession(f.fresh(), f.draft, f.question, f.environment, f.environment.value, undefined,
    { ...f.context, consumerFeedback: ['Even after reopening, the old exact revision stays blocked'] }, 'Old revision'),
  { code: 'research_context_application_refused' });
  assert.deepEqual(db.get(barrier.id), barrier); callsOnce(f, 2);
});

for (const forgery of ['missing-witness', 'foreign-witness'] as const) {
  test(`a rehashed question barrier with ${forgery} is an invalid proof, not authority to close admission`, async t => {
    const f = resumeFixture(t);
    let witness = { id: 'assessment-application:missing', revision: 1, hash: '0'.repeat(64) };
    if (forgery === 'foreign-witness') {
      const draft = f.engine.discovery.create('p', 'discovery', 'R0', 'compilation', [f.question.value.spec]);
      const question = f.store.get<Question>(draft.value.questions[0]!)!, other = d83BarrierCandidate(f, 'foreign-question', draft, question);
      const parked = await d83ParkBarrierReceipt(f, other); other.invalidate();
      await assert.rejects(other.invoke(), { code: 'research_context_application_refused' });
      witness = reference(f.store.get(parked.application.id)!);
      assert.notDeepEqual(d83QuestionBarrier(f, f.store, question).value.question, reference(f.question));
    }
    // Use revision 1, so rejecting a later rewrite cannot accidentally stand in
    // for proving the witness's existence and ownership of this exact question.
    const forged = f.store.write({ id: `assessment-barrier:${hashJson(['p', reference(f.question)])}`,
      kind: 'assessment-barrier', expected: 0, value: { contract: 'assessment-barrier/v1', projectId: 'p',
        question: reference(f.question), refusal: witness } });
    assert.equal(forged.hash, hashJson(forged.value)); assert.equal(forged.revision, 1);
    const heads = f.store.list(), count = f.sent().length;
    await assert.rejects(assessmentSession(f.fresh(), f.draft, f.question, f.environment, f.environment.value, undefined,
      { ...f.context, consumerFeedback: [`Read the ${forgery} through the normal admission path`] }, 'Read the saved barrier'),
    { code: 'research_context_application_invalid' });
    assert.deepEqual(f.store.list(), heads);
    if (count) callsOnce(f, count);
    else {
      assert.equal(f.sent().length, 0); assert.equal(f.store.list('model-call').length, 0);
      assert.equal(f.store.list('model-response').length, 0); assert.equal(modelUsage(f.store, 'p', 0).cumulative.reportedTokens, null);
    }
  });
}

function d83FileAssessment(f: ReturnType<typeof resumeFixture>) {
  const path = join(f.workspace, 'README.md'), bytes = readFileSync(path);
  const source = f.engine.discovery.evidence.file('p', 'file-assessment', f.workspace, 'README.md', 'text/plain', 0);
  const observation = f.engine.discovery.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: 2 });
  const context = { ...f.context, observations: [observation] };
  const invoke = (db = f.store, candidate = context) => assessmentSession(db, f.draft, f.question, f.environment,
    f.environment.value, undefined, candidate, 'Assess the exact original file observation');
  return { path, bytes, source, context, invoke };
}
function d83ProofInvalid(error: unknown): boolean {
  assert.ok(error instanceof EngineError);
  assert.ok(['research_context_application_invalid', 'research_context_read_proof_invalid'].includes(error.code), error.code);
  return true;
}

test('a supported paid result cannot be relabelled as a response refusal even with its genuine read proof and a rehashed barrier', async t => {
  const f = resumeFixture(t); assert.deepEqual(await f.invoke(), verdict); callsOnce(f, 1);
  const application = f.store.list<any>('assessment-application')[0]!, call = f.store.list<ModelCall>('model-call')[0]!;
  assert.equal(application.value.state, 'applied'); assert.equal(application.value.resolution.contract, 'assessment-read/v1');
  const response = f.store.get<any>(call.value.response!.record!.id)!;
  assert.deepEqual(JSON.parse(response.value.text).research, verdict);
  const falseRefusal = f.store.write({ id: application.id, kind: application.kind, expected: application.revision,
    value: { ...application.value, state: 'refused', after: null, received: null,
      refusal: { kind: 'response', call: reference(call), code: 'assessment_invalid' } } });
  const barrier = f.store.write({ id: `assessment-barrier:${hashJson(['p', reference(f.question)])}`, kind: 'assessment-barrier', expected: 0,
    value: { contract: 'assessment-barrier/v1', projectId: 'p', question: reference(f.question), refusal: reference(falseRefusal) } });
  assert.equal(falseRefusal.hash, hashJson(falseRefusal.value)); assert.equal(barrier.hash, hashJson(barrier.value));
  const heads = f.store.list();
  // The barrier reader follows app.session's original revision, rather than
  // failing merely because the completed session currently has another head.
  await assert.rejects(assessmentSession(f.fresh(), f.draft, f.question, f.environment, f.environment.value, undefined,
    { ...f.context, consumerFeedback: ['Read the purported refusal through a fresh candidate'] }, 'Read exact refusal proof'),
  { code: 'research_context_application_invalid' });
  assert.deepEqual(f.store.list(), heads); assert.deepEqual(f.store.get(call.id), call);
  assert.deepEqual(f.store.get(response.id), response); callsOnce(f, 1);
});

for (const field of ['notes', 'candidateOffset'] as const) {
  test(`a checkpoint continuation cannot forge ${field} by rehashing the session and both adjacent application references`, async t => {
    const f = resumeFixture(t, 'checkpoint'), original = f.store.writeMany.bind(f.store); let changed = false;
    f.store.writeMany = ((writes: Write[], guards = []) => {
      if (!changed && writes.some(write => write.kind === 'assessment-session' && write.expected === 1
        && (write.value as any).result === null)) {
        changed = true;
        const altered = structuredClone(writes), session = altered.find(write => write.kind === 'assessment-session')!;
        const applied = altered.find(write => write.kind === 'assessment-application' && (write.value as any).state === 'applied')!;
        const next = altered.find(write => write.kind === 'assessment-application' && write.expected === 0)!;
        assert.ok(applied); assert.ok(next);
        const value = session.value as any;
        if (field === 'notes') value.notes = [...value.notes, { response: { action: 'assessment_checkpoint', notes: ['Never returned by the provider'] } }];
        else value.candidateOffset += 1;
        const sessionRef = { id: session.id, revision: session.expected + 1, hash: hashJson(session.value) };
        (applied.value as any).after = sessionRef;
        (next.value as any).session = sessionRef;
        (next.value as any).previous = { id: applied.id, revision: applied.expected + 1, hash: hashJson(applied.value) };
        original(altered, guards);
        throw new EngineError('fixture_application_crash', 'Stop after the mutually consistent forged checkpoint transaction');
      }
      return original(writes, guards);
    }) as typeof f.store.writeMany;
    try { await assert.rejects(f.invoke(), { code: 'fixture_application_crash' }); }
    finally { f.store.writeMany = original; }
    assert.ok(changed); callsOnce(f, 1);
    const session = f.store.list<any>('assessment-session')[0]!;
    const applied = f.store.list<any>('assessment-application').find(app => app.value.state === 'applied')!;
    const next = f.store.get<any>(session.value.application)!;
    assert.equal(next.value.state, 'prepared'); assert.deepEqual(next.value.session, reference(session));
    assert.deepEqual(applied.value.after, reference(session)); assert.deepEqual(next.value.previous, reference(applied));
    assert.equal(applied.hash, hashJson(applied.value)); assert.equal(next.hash, hashJson(next.value));
    const heads = f.store.list();
    await assert.rejects(f.invoke(f.fresh()), { code: 'research_context_application_invalid' });
    assert.deepEqual(f.store.list(), heads); assert.equal(f.store.list('assessment-barrier').length, 0); callsOnce(f, 1);
  });
}

test('a precise file-change refusal survives restoring and deleting the file while retaining original Source bytes', async t => {
  const f = resumeFixture(t), file = d83FileAssessment(f), sourceRows = f.store.list('source');
  const changedBytes = Buffer.from('Changed after the paid response\n'), original = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    const saved = original(writes, guards);
    if (!changed && writes.some(write => write.kind === 'model-response')) {
      changed = true; writeFileSync(file.path, changedBytes);
    }
    return saved;
  }) as typeof f.store.writeMany;
  try { await assert.rejects(file.invoke(), { code: 'research_context_application_source_stale' }); }
  finally { f.store.writeMany = original; }
  assert.ok(changed); callsOnce(f, 1);
  const app = f.store.list<any>('assessment-application')[0]!, call = f.store.list<ModelCall>('model-call')[0]!;
  assert.equal(app.value.state, 'refused'); assert.deepEqual(app.value.refusal,
    { kind: 'response', call: reference(call), code: 'research_context_application_source_stale' });
  assert.equal(app.value.resolution.contract, 'assessment-read/v1');
  assert.deepEqual(app.value.resolution.files, [{ source: reference(file.source), observation: {
    kind: 'bytes', path: file.source.value.origin.location, bytes: changedBytes.toString('base64'),
  } }]);
  const captured = app.value.resolution.reads.find((entry: any) => entry.id === file.source.id && entry.revision === null);
  assert.ok(captured); assert.deepEqual(captured.ref, reference(file.source));
  const barrier = d83QuestionBarrier(f), heads = f.store.list();
  for (const state of ['restored', 'deleted'] as const) {
    if (state === 'restored') writeFileSync(file.path, file.bytes); else rmSync(file.path);
    const db = f.fresh(); await assert.rejects(file.invoke(db), { code: 'research_context_application_source_stale' });
    assert.deepEqual(db.list(), heads); assert.deepEqual(db.list('source'), sourceRows);
    assert.deepEqual(db.get(file.source.id), file.source); assert.equal(db.get<any>(file.source.id)!.value.origin.kind, 'file');
    assert.deepEqual(db.get(barrier.id), barrier); assert.deepEqual(db.get(app.id), app); callsOnce(f, 1, db);
  }
});

for (const mode of ['verdict', 'read_context'] as const) {
  test(`successful file assessment ${mode} retains historical reads after deletion without persisting a projected Source`, async t => {
    const f = resumeFixture(t, mode), file = d83FileAssessment(f), sourceRows = f.store.list('source');
    assert.deepEqual(await file.invoke(), verdict); const count = mode === 'verdict' ? 1 : 2; callsOnce(f, count);
    const apps = f.store.list<any>('assessment-application');
    assert.equal(apps.length, count); assert.ok(apps.every(app => app.value.state === 'applied'));
    for (const app of apps) assert.deepEqual(app.value.resolution.files, [{ source: reference(file.source), observation: {
      kind: 'bytes', path: file.source.value.origin.location, bytes: file.bytes.toString('base64'),
    } }]);
    assert.deepEqual(f.store.list('source'), sourceRows);
    rmSync(file.path); const heads = f.store.list();
    for (let restart = 0; restart < 2; restart++) {
      const db = f.fresh(); assert.deepEqual(await file.invoke(db), verdict);
      assert.deepEqual(db.list(), heads); assert.deepEqual(db.list('source'), sourceRows);
      assert.deepEqual(db.get(file.source.id), file.source); assert.equal(db.get<any>(file.source.id)!.value.origin.kind, 'file');
      assert.equal(db.history(file.source.id).length, 1); callsOnce(f, count, db);
    }
  });
}

for (const forgery of ['reads', 'files'] as const) {
  test(`a refusal with rehashed ${forgery} proof cannot invent a different read outcome for the real supported receipt`, async t => {
    const f = resumeFixture(t), file = d83FileAssessment(f), sourceRows = f.store.list('source');
    const original = f.store.writeMany.bind(f.store); let fileChanged = false, proofChanged = false;
    f.store.writeMany = ((writes: Write[], guards = []) => {
      if (!proofChanged && writes.some(write => write.kind === 'assessment-application' && (write.value as any).state === 'refused')) {
        proofChanged = true;
        const altered = structuredClone(writes), application = altered.find(write => write.kind === 'assessment-application')!;
        const barrier = altered.find(write => write.kind === 'assessment-barrier')!;
        assert.ok(barrier, 'Forge only the initial barrier, not a prohibited later revision');
        const proof = (application.value as any).resolution;
        assert.equal(proof.contract, 'assessment-read/v1'); assert.equal(proof.files.length, 1);
        if (forgery === 'files') proof.files[0].observation.bytes = file.bytes.toString('base64');
        else {
          const read = proof.reads.find((entry: any) => entry.id === file.source.id)!;
          assert.ok(read); read.id = f.source.id; read.ref = reference(f.source);
          proof.files = [];
        }
        (barrier.value as any).refusal = { id: application.id, revision: application.expected + 1, hash: hashJson(application.value) };
        return original(altered, guards);
      }
      const saved = original(writes, guards);
      if (!fileChanged && writes.some(write => write.kind === 'model-response')) {
        fileChanged = true; writeFileSync(file.path, 'The file changed before application\n');
      }
      return saved;
    }) as typeof f.store.writeMany;
    try { await assert.rejects(file.invoke(), { code: 'research_context_application_source_stale' }); }
    finally { f.store.writeMany = original; }
    assert.ok(fileChanged); assert.ok(proofChanged); callsOnce(f, 1);
    const app = f.store.list<any>('assessment-application')[0]!, barrier = f.store.list<any>('assessment-barrier')[0]!;
    assert.equal(app.hash, hashJson(app.value)); assert.equal(barrier.hash, hashJson(barrier.value));
    assert.equal(barrier.revision, 1); assert.deepEqual(barrier.value.refusal, reference(app));
    const call = f.store.list<ModelCall>('model-call')[0]!, response = f.store.get<any>(call.value.response!.record!.id)!;
    assert.deepEqual(JSON.parse(response.value.text).research, verdict);
    const heads = f.store.list();
    await assert.rejects(file.invoke(f.fresh(), { ...file.context, consumerFeedback: ['Read the altered proof through its barrier'] } as typeof file.context), d83ProofInvalid);
    assert.deepEqual(f.store.list(), heads); assert.deepEqual(f.store.list('source'), sourceRows);
    assert.deepEqual(f.store.get(response.id), response); assert.deepEqual(f.store.get(call.id), call); callsOnce(f, 1);
  });
}

test('a missing exact assessment read guards its prior head, while historical misses and existing revisions remain exact', async t => {
  const { assessmentReadView } = await import('../src/discovery/response-recovery.js');
  const f = resumeFixture(t), head = f.store.write({ id: 'exact-assessment-input', kind: 'fixture', expected: 0, value: { version: 1 } });
  const current = assessmentReadView(f.store);
  assert.equal(current.store.get(head.id, 2), null);
  const proof = current.finish();
  assert.deepEqual(proof, { contract: 'assessment-read/v1', reads: [{ id: head.id, revision: 2, ref: null,
    absence: { head: reference(head) } }], files: [] });
  assert.deepEqual(current.guards, [reference(head)]);
  const writer = f.fresh();
  const appended = writer.write({ id: head.id, kind: head.kind, expected: head.revision, value: { version: 2 } });
  assert.equal(appended.revision, 2);
  assert.throws(() => f.store.writeMany([
    { id: 'exact-miss-neighbor-a', kind: 'fixture', expected: 0, value: {} },
    { id: 'exact-miss-neighbor-b', kind: 'fixture', expected: 0, value: {} },
  ], current.guards), { code: 'input_stale' });
  assert.equal(f.store.get('exact-miss-neighbor-a'), null); assert.equal(f.store.get('exact-miss-neighbor-b'), null);

  const historicalStore = f.fresh(), exactGet = historicalStore.get.bind(historicalStore);
  historicalStore.get = ((id: string, revision?: number) => {
    if (id === head.id) assert.equal(revision, 1, 'Historical absence reads only its old exact head, never the current head or the now-existing revision');
    return exactGet(id, revision);
  }) as typeof historicalStore.get;
  const historical = assessmentReadView(historicalStore, proof);
  assert.equal(historical.store.get(head.id, 2), null);
  assert.deepEqual(historical.finish(), proof);
  assert.deepEqual(historical.guards, [reference(head)]);
  const malformed = structuredClone(proof);
  Reflect.deleteProperty(malformed.reads[0]!, 'absence');
  assert.throws(() => assessmentReadView(f.fresh(), malformed), { code: 'research_context_read_proof_invalid' });

  const absentId = 'initially-absent-assessment-input', missing = assessmentReadView(f.store);
  assert.equal(missing.store.get(absentId, 1), null);
  const missingProof = missing.finish();
  assert.deepEqual(missingProof, { contract: 'assessment-read/v1', reads: [{ id: absentId, revision: 1, ref: null,
    absence: { head: null } }], files: [] });
  assert.deepEqual(missing.guards, [{ id: absentId, absent: true }]);
  writer.write({ id: absentId, kind: 'fixture', expected: 0, value: { created: true } });
  assert.throws(() => f.store.writeMany([
    { id: 'absent-revision-neighbor-a', kind: 'fixture', expected: 0, value: {} },
    { id: 'absent-revision-neighbor-b', kind: 'fixture', expected: 0, value: {} },
  ], missing.guards), { code: 'input_stale' });
  assert.equal(f.store.get('absent-revision-neighbor-a'), null); assert.equal(f.store.get('absent-revision-neighbor-b'), null);
  const emptyHistoryStore = f.fresh(), emptyGet = emptyHistoryStore.get.bind(emptyHistoryStore);
  emptyHistoryStore.get = ((id: string, revision?: number) => {
    assert.notEqual(id, absentId, 'An initially absent historical revision needs no present-day lookup');
    return emptyGet(id, revision);
  }) as typeof emptyHistoryStore.get;
  const emptyHistory = assessmentReadView(emptyHistoryStore, missingProof);
  assert.equal(emptyHistory.store.get(absentId, 1), null); assert.deepEqual(emptyHistory.finish(), missingProof);

  const file = d83FileAssessment(f), sourceRows = f.store.list('source');
  rmSync(file.path);
  const immutable = assessmentReadView(f.fresh());
  const original = immutable.store.get(file.source.id, file.source.revision);
  assert.deepEqual(original, file.source, 'An exact archived Source retains all original fields, including its file origin');
  const immutableProof = immutable.finish();
  assert.deepEqual(immutable.guards, []);
  assert.deepEqual(immutableProof, { contract: 'assessment-read/v1', reads: [{ id: file.source.id,
    revision: file.source.revision, ref: reference(file.source) }], files: [] });
  const immutableHistory = assessmentReadView(f.fresh(), immutableProof);
  assert.deepEqual(immutableHistory.store.get(file.source.id, file.source.revision), file.source);
  assert.deepEqual(immutableHistory.finish(), immutableProof); assert.deepEqual(immutableHistory.guards, []);
  assert.deepEqual(f.store.list('source'), sourceRows); assert.deepEqual(f.store.get(file.source.id), file.source);
  assert.equal(f.store.history(file.source.id).length, 1); assert.equal(f.source.value.origin.kind, 'owner-document');
  assert.equal(file.source.value.origin.kind, 'file'); assert.equal(f.sent().length, 0); assert.equal(f.store.list('model-call').length, 0);
});

test('assessment session rejects incomplete public inputs before any Store lookup or dispatch', async t => {
  const f = resumeFixture(t); let reads = 0;
  const store = new Proxy(f.store, { get(target, key) {
    if (key === 'get') return () => { reads++; throw Error('Malformed arguments reached storage'); };
    return Reflect.get(target, key, target);
  } });
  for (const context of [null, {}, { value: {}, observations: null }, { value: {}, observations: [null] },
    { value: {}, observations: [{ ...f.observation, source: null }] }, { value: {}, observations: [{ ...f.observation, selector: null }] }]) {
    await assert.rejects(assessmentSession(store, f.draft, f.question, f.environment, f.environment.value, undefined,
      context as any, 'Malformed public context'), { code: 'research_context_application_invalid' });
  }
  assert.equal(reads, 0); assert.equal(f.sent().length, 0); assert.equal(f.store.list('assessment-application').length, 0);
});

function d83EmptyProviderThenSuccess(f: ReturnType<typeof resumeFixture>) {
  const marker = join(f.root, 'empty-provider-failed');
  writeFileSync(f.environment.value.reviewer.command.args[0]!, `import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';
const request=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(join(f.root, 'wire.ndjson'))},JSON.stringify(request)+'\\n');
if(!existsSync(${JSON.stringify(marker)})){writeFileSync(${JSON.stringify(marker)},'failed');process.stderr.write('Local provider exited without a research response');process.exit(1);}
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research:{verdict:'supported',reasons:[]},
usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
}
function d83ExactEmptyFailure(f: ReturnType<typeof resumeFixture>, db = f.store) {
  const call = db.list<ModelCall>('model-call').find(call => call.value.status === 'failed' && call.value.error === 'research_provider_failed')!;
  assert.ok(call); assert.equal(call.value.usage, null); assert.equal(call.value.usageSource, 'unavailable');
  const receipt = call.value.response?.record; assert.ok(receipt, 'Even the empty actual output must remain an exact record');
  const raw = db.get<any>(receipt.id, receipt.revision)!;
  assert.ok(raw); assert.equal(raw.hash, receipt.hash); assert.equal(raw.value.text, '');
  assert.equal(db.list('assessment-barrier').length, 0, 'A completed provider outage is not an application-refused barrier');
  const application = db.list<any>('assessment-application').find(app => app.value.call?.id === call.id)!;
  assert.ok(application); assert.equal(application.value.state, 'retryable'); assert.deepEqual(application.value.received, reference(call));
  const session = db.get<any>(application.value.session.id, application.value.session.revision)!;
  return { call: structuredClone(call), raw: structuredClone(raw), application: structuredClone(application), session: structuredClone(session) };
}
function d83RenewalLink(db: Store, before: { application: any; session: any }) {
  const renewed = db.get<any>(before.application.id)!;
  assert.equal(renewed.value.state, 'renewed'); assert.deepEqual(renewed.value.guards, before.application.value.guards);
  assert.deepEqual(renewed.value.call, before.application.value.call); assert.deepEqual(renewed.value.received, before.application.value.received);
  const cursor = db.get<any>(renewed.value.after.id, renewed.value.after.revision)!;
  assert.equal(cursor.hash, renewed.value.after.hash); assert.equal(cursor.revision, before.session.revision + 1);
  for (const key of ['offset', 'candidateOffset', 'notes', 'focus', 'workspace', 'result'])
    assert.deepEqual(cursor.value[key], before.session.value[key], `Renewal preserves the exact ${key} cursor component`);
  const next = db.get<any>(cursor.value.application, 1)!;
  assert.equal(next.value.state, 'prepared'); assert.deepEqual(next.value.previous, reference(renewed));
  assert.deepEqual(next.value.session, reference(cursor));
  assert.notEqual(next.id, before.application.id);
  return { renewed, cursor, next };
}
function d83NoResponseRetry(error: unknown): boolean {
  assert.ok(error instanceof EngineError);
  assert.match(error.code, /^(research_context_|response_recovery_)/, 'A linked response must produce a typed proof/application refusal, not a retryable provider outage');
  return true;
}

test('a proved empty provider failure permits one ordinary retry after restart and preserves the unknown first expense', async t => {
  const f = resumeFixture(t); d83EmptyProviderThenSuccess(f);
  await assert.rejects(f.invoke(), { code: 'research_provider_failed' });
  assert.equal(f.sent().length, 1); const first = d83ExactEmptyFailure(f);
  const before = modelUsage(f.store, 'p', 0).cumulative;
  assert.equal(before.attempts, 1); assert.equal(before.unmeasuredCalls, 1); assert.equal(before.reportedTokens, null);
  const question = f.store.get(f.question.id), db = f.fresh();
  assert.deepEqual(await f.invoke(db), verdict); assert.equal(f.sent().length, 2);
  assert.equal(db.list('model-call').length, 2); assert.equal(db.list('model-response').length, 2);
  assert.deepEqual(db.get(first.call.id), first.call); assert.deepEqual(db.get(first.raw.id), first.raw);
  assert.deepEqual(db.get(f.question.id), question, 'A provider retry does not require or manufacture reopen');
  assert.equal(db.list('assessment-barrier').length, 0);
  d83RenewalLink(db, first);
  const usage = modelUsage(db, 'p', 0).cumulative;
  assert.equal(usage.attempts, 2); assert.equal(usage.failed, 1); assert.equal(usage.succeeded, 1);
  assert.equal(usage.measuredCalls, 1); assert.equal(usage.unmeasuredCalls, 1);
  assert.deepEqual(usage.reportedTokens, { input: 10, output: 2, cachedInput: 0, reasoningOutput: 0 });
  const heads = db.list(); assert.deepEqual(await f.invoke(f.fresh()), verdict);
  assert.deepEqual(db.list(), heads); assert.equal(f.sent().length, 2);
});

for (const dependency of ['pilot', 'environment'] as const) {
  test(`native ${dependency} change before recording a proved provider failure preserves its retryable fact and fresh retry`, async t => {
    const f = resumeFixture(t); d83EmptyProviderThenSuccess(f);
    let environment = f.environment, pilot: ReturnType<typeof configureReaderPilot> | undefined;
    const command = environment.value.reviewer.command;
    const settings = { experimental: true, active: true, stopAfter: 'L2',
      reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
      maxRequestChars: 100000, maxReadChars: 60000, maxReplyChars: 10000, maxCalls: 1, maxReportedTokens: 100000 };
    if (dependency === 'pilot') pilot = configureReaderPilot(f.store, f.engine.environments, 'p', settings, 0);
    const invoke = (db = f.store) => assessmentSession(db, f.draft, f.question, environment,
      pilot ? pilotEnvironment(environment.value, pilot.value) : environment.value, pilot, f.context, 'Assess both operands');
    const original = f.store.writeMany.bind(f.store), other = f.fresh();
    let changed = false, physical: any, raw: any;
    f.store.writeMany = ((writes: Write[], guards = []) => {
      if (!changed && writes.some(write => write.kind === 'assessment-application' && (write.value as any).state === 'retryable')) {
        changed = true;
        physical = structuredClone(other.list<ModelCall>('model-call')[0]!);
        assert.equal(physical.value.status, 'failed'); assert.equal(physical.value.error, 'research_provider_failed');
        const ref = physical.value.response.record;
        raw = structuredClone(other.get<any>(ref.id, ref.revision)!);
        assert.equal(raw.hash, ref.hash); assert.equal(raw.value.text, '');
        if (dependency === 'pilot') {
          pilot = configureReaderPilot(other, new Environments(other), 'p', { ...settings, maxCalls: 2,
            unknownReserves: [{ call: reference(physical), tokens: 1 }] }, pilot!.revision);
        } else environment = new Environments(other).configure('p', environment.value, environment.revision);
      }
      return original(writes, guards);
    }) as typeof f.store.writeMany;
    try { await assert.rejects(invoke(), { code: 'research_provider_failed' }); }
    finally { f.store.writeMany = original; }
    assert.ok(changed); const first = d83ExactEmptyFailure(f);
    assert.deepEqual(first.call, physical); assert.deepEqual(first.raw, raw); assert.equal(f.sent().length, 1);
    const db = f.fresh(); assert.deepEqual(await invoke(db), verdict); d83RenewalLink(db, first);
    assert.equal(db.list('model-call').length, 2); assert.equal(db.list('model-response').length, 2); assert.equal(f.sent().length, 2);
    assert.deepEqual(db.get(physical.id), physical); assert.deepEqual(db.get(raw.id), raw);
    assert.equal(db.list('assessment-barrier').length, 0);
    for (const app of db.list<any>('assessment-application'))
      assert.equal(db.history<any>(app.id).some(revision => revision.value.state === 'refused'), false);
    const usage = modelUsage(db, 'p', 0).cumulative;
    assert.equal(usage.attempts, 2); assert.equal(usage.measuredCalls, 1); assert.equal(usage.unmeasuredCalls, 1);
    assert.deepEqual(usage.reportedTokens, { input: 10, output: 2, cachedInput: 0, reasoningOutput: 0 });
    assert.deepEqual(db.get(f.question.id), f.question);
    const heads = db.list(); assert.deepEqual(await invoke(f.fresh()), verdict);
    assert.deepEqual(db.list(), heads); assert.equal(f.sent().length, 2);
  });
}

test('two provider-failure resumers race one retry transition and reserve only one replacement call', async t => {
  const f = resumeFixture(t); d83EmptyProviderThenSuccess(f);
  await assert.rejects(f.invoke(), { code: 'research_provider_failed' }); const first = d83ExactEmptyFailure(f);
  const current = f.fresh(), other = f.fresh(), original = current.writeMany.bind(current);
  type Attempt = { status: 'ok'; value: unknown } | { status: 'error'; error: unknown };
  const outcome = (promise: Promise<unknown>): Promise<Attempt> => promise.then(value => ({ status: 'ok', value }), error => ({ status: 'error', error }));
  let raced = false, competing: Promise<Attempt> | undefined;
  current.writeMany = ((writes: Write[], guards = []) => {
    if (!raced && writes.some(write => write.kind === 'assessment-application' && write.expected === 0)) {
      raced = true; competing = outcome(f.invoke(other));
    }
    return original(writes, guards);
  }) as typeof current.writeMany;
  const result = await outcome(f.invoke(current)); current.writeMany = original;
  assert.ok(raced, 'Both resumers must compete before writing the replacement intent'); assert.ok(competing);
  const attempts = [result, await competing];
  assert.ok(attempts.some(attempt => attempt.status === 'ok'));
  for (const attempt of attempts) {
    if (attempt.status === 'ok') assert.deepEqual(attempt.value, verdict);
    else {
      assert.ok(attempt.error instanceof EngineError);
      assert.equal(attempt.error.code, 'research_context_application_running', 'Only an already-owned replacement call may defer the loser');
    }
  }
  assert.equal(f.sent().length, 2); assert.equal(current.list('model-call').length, 2);
  assert.equal(current.list('model-response').length, 2); assert.equal(current.list('assessment-barrier').length, 0);
  assert.deepEqual(current.get(first.call.id), first.call); assert.deepEqual(current.get(first.raw.id), first.raw);
  d83RenewalLink(current, first);
  assert.deepEqual(await f.invoke(f.fresh()), verdict); assert.equal(f.sent().length, 2);
  const usage = modelUsage(current, 'p', 0).cumulative;
  assert.equal(usage.measuredCalls, 1); assert.equal(usage.unmeasuredCalls, 1);
  assert.deepEqual(usage.reportedTokens, { input: 10, output: 2, cachedInput: 0, reasoningOutput: 0 });
});

for (const payload of ['supported', 'insufficient', 'conflicting', 'checkpoint', 'read_context', 'invalid-payload'] as const) {
  test(`a failed provider label over the genuine ${payload} research envelope never authorizes a new call`, async t => {
    const f = resumeFixture(t), wirePath = join(f.root, 'wire.ndjson');
    writeFileSync(f.environment.value.reviewer.command.args[0]!, `import{readFileSync,appendFileSync}from'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),subject=request.subject;
appendFileSync(${JSON.stringify(wirePath)},JSON.stringify(request)+'\\n');
const kind=${JSON.stringify(payload)};
const research=kind==='checkpoint'?{action:'assessment_checkpoint',notes:['A real paid checkpoint']}:
kind==='read_context'?{action:'read_context',record:subject.working.archive,pointer:'/body/resources/a'}:
kind==='invalid-payload'?{verdict:'supported',reasons:'This violates the payload contract'}:
{verdict:kind,reasons:kind==='supported'?[]:['A real negative assessment']};
console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research,
usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
    const original = f.store.writeMany.bind(f.store); let relabelled = false;
    f.store.writeMany = ((writes: Write[], guards = []) => {
      if (!relabelled && writes.some(write => write.kind === 'model-response')) {
        relabelled = true;
        const changed = structuredClone(writes), call = changed.find(write => write.kind === 'model-call')!;
        assert.ok(call); assert.equal((call.value as any).status, 'succeeded');
        (call.value as any).status = 'failed'; (call.value as any).error = 'research_provider_failed';
        return original(changed, guards);
      }
      return original(writes, guards);
    }) as typeof f.store.writeMany;
    try { await assert.rejects(f.invoke(), d83NoResponseRetry); } finally { f.store.writeMany = original; }
    assert.ok(relabelled); callsOnce(f, 1);
    const call = f.store.list<ModelCall>('model-call')[0]!, raw = f.store.get<any>(call.value.response!.record!.id)!;
    const envelope = JSON.parse(raw.value.text);
    assert.equal(envelope.protocol, 'omg-agent/v1'); assert.equal(envelope.requestId, call.value.requestId);
    assert.ok(Object.hasOwn(envelope, 'research')); assert.deepEqual(envelope.usage, call.value.usage);
    assert.equal(call.value.status, 'failed'); assert.equal(call.value.error, 'research_provider_failed');
    const heads = f.store.list();
    await assert.rejects(f.invoke(f.fresh()), d83NoResponseRetry);
    assert.deepEqual(f.store.list(), heads); assert.deepEqual(f.store.get(call.id), call); assert.deepEqual(f.store.get(raw.id), raw);
    callsOnce(f, 1);
  });
}

test('an empty-provider failure missing its mandatory raw response record is not a retry permission', async t => {
  const f = resumeFixture(t); d83EmptyProviderThenSuccess(f);
  const original = f.store.writeMany.bind(f.store); let removed = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!removed && writes.some(write => write.kind === 'model-response')) {
      removed = true;
      const changed = structuredClone(writes).filter(write => write.kind !== 'model-response');
      const call = changed.find(write => write.kind === 'model-call')!;
      assert.ok(call); assert.equal((call.value as any).error, 'research_provider_failed');
      // Retain the exact declared response Ref but omit its record. This must not
      // be confused with the proven empty output of a completed provider failure.
      return original(changed, guards);
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  try { await assert.rejects(f.invoke(), d83NoResponseRetry); } finally { f.store.writeMany = original; }
  assert.ok(removed); assert.equal(f.sent().length, 1); assert.equal(f.store.list('model-call').length, 1);
  assert.equal(f.store.list('model-response').length, 0);
  const heads = f.store.list(); await assert.rejects(f.invoke(f.fresh()), d83NoResponseRetry);
  assert.deepEqual(f.store.list(), heads); assert.equal(f.sent().length, 1);
  const usage = modelUsage(f.store, 'p', 0).cumulative;
  assert.equal(usage.measuredCalls, 0); assert.equal(usage.unmeasuredCalls, 1); assert.equal(usage.reportedTokens, null);
});

// RS3 (№4426): a bare envelope of its own request is a failure without a response only under the adapter's structured
// provider_failed / provider_empty line (below); without that line, or under adapter_failed, the model may have answered.
for (const defect of ['foreign-request', 'missing-research', 'missing-research-adapter-failed'] as const) {
  test(`a real failed provider with ${defect} envelope cannot disguise its output as an empty retryable failure`, async t => {
    const f = resumeFixture(t);
    writeFileSync(f.environment.value.reviewer.command.args[0]!, `import{readFileSync,appendFileSync}from'node:fs';
const request=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(join(f.root, 'wire.ndjson'))},JSON.stringify(request)+'\\n');
const envelope={protocol:request.protocol,requestId:${JSON.stringify(defect)}==='foreign-request'?'another-request':request.requestId,
...(${JSON.stringify(defect)}==='foreign-request'?{research:{verdict:'supported',reasons:[]}}:{})};
if(${JSON.stringify(defect)}==='missing-research-adapter-failed')process.stderr.write(JSON.stringify({error:'adapter_failed',message:'Unexpected token'})+'\\n');
process.stdout.write(JSON.stringify(envelope),()=>process.exit(1));`);
    await assert.rejects(f.invoke(), d83NoResponseRetry);
    const call = f.store.list<ModelCall>('model-call')[0]!;
    assert.equal(call.value.status, 'failed'); assert.equal(call.value.error, 'research_provider_failed');
    const ref = call.value.response?.record; assert.ok(ref);
    const raw = f.store.get<any>(ref.id, ref.revision)!;
    assert.equal(raw.hash, ref.hash); const envelope = JSON.parse(raw.value.text);
    assert.equal(envelope.protocol, 'omg-agent/v1');
    if (defect === 'foreign-request') assert.notEqual(envelope.requestId, call.value.requestId);
    else { assert.equal(envelope.requestId, call.value.requestId); assert.equal(Object.hasOwn(envelope, 'research'), false); }
    assert.equal(f.store.list<any>('assessment-application').some(app => app.value.state === 'retryable' || app.value.state === 'renewed'), false);
    const heads = f.store.list(); await assert.rejects(f.invoke(f.fresh()), d83NoResponseRetry);
    assert.deepEqual(f.store.list(), heads); assert.deepEqual(f.store.get(raw.id), raw); assert.deepEqual(f.store.get(call.id), call);
    assert.equal(f.sent().length, 1); assert.equal(f.store.list('model-call').length, 1); assert.equal(f.store.list('model-response').length, 1);
  });
}

// RS3 (№4414, №4426): the bare envelope codex-stdio and devin-stdio print when their CLI failed (provider_failed) or gave no
// final answer (provider_empty) is a provider failure without a response: the assessment is retryable and the next entry
// pays one new generation, the failed attempt kept as it was.
for (const code of ['provider_failed', 'provider_empty'] as const) {
  test(`RS3 a real adapter's bare envelope under ${code} is a retryable assessment failure; the next entry renews it once`, async t => {
    const f = resumeFixture(t), marker = join(f.root, 'rs3-failed');
    writeFileSync(f.environment.value.reviewer.command.args[0]!, `import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';
const request=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(join(f.root, 'wire.ndjson'))},JSON.stringify(request)+'\\n');
if(!existsSync(${JSON.stringify(marker)})){writeFileSync(${JSON.stringify(marker)},'failed');
process.stderr.write(JSON.stringify({error:${JSON.stringify(code)},message:'426 Upgrade Required'})+'\\n');
process.stdout.write(JSON.stringify({protocol:request.protocol,requestId:request.requestId,usage:null})+'\\n',()=>process.exit(1));}
else console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research:{verdict:'supported',reasons:[]},
usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
    await assert.rejects(f.invoke(), { code: 'research_provider_failed' });
    assert.equal(f.sent().length, 1);
    const call = f.store.list<ModelCall>('model-call')[0]!;
    assert.deepEqual([call.value.status, call.value.error], ['failed', 'research_provider_failed']);
    const received = call.value.response?.record; assert.ok(received);
    const raw = f.store.get<any>(received.id, received.revision)!;
    assert.deepEqual(Object.keys(JSON.parse(raw.value.text)), ['protocol', 'requestId', 'usage']);
    const application = f.store.list<any>('assessment-application').find(app => app.value.call?.id === call.id)!;
    assert.equal(application.value.state, 'retryable');
    const before = { application: structuredClone(application), session: structuredClone(f.store.get<any>(application.value.session.id, application.value.session.revision)!) };
    const db = f.fresh();
    assert.deepEqual(await f.invoke(db), verdict);
    assert.equal(f.sent().length, 2);
    assert.deepEqual(db.get(call.id), call); assert.deepEqual(db.get(raw.id), raw);
    d83RenewalLink(db, before);
  });
}

test('a real provider timeout stays nonretryable after restart with unknown output and expense', async t => {
  const f = resumeFixture(t), wirePath = join(f.root, 'wire.ndjson');
  writeFileSync(f.environment.value.reviewer.command.args[0]!, `import{readFileSync,appendFileSync}from'node:fs';
const request=JSON.parse(readFileSync(0,'utf8'));appendFileSync(${JSON.stringify(wirePath)},JSON.stringify(request)+'\\n');
setInterval(()=>{},1000);`);
  const environment = f.engine.environments.configure('p', { ...f.environment.value, timeoutMs: 1000 }, f.environment.revision);
  const invoke = (db = f.store) => assessmentSession(db, f.draft, f.question, environment, environment.value, undefined,
    f.context, 'Assess under the explicit local timeout');
  const refusesTimeout = (error: unknown) => {
    assert.ok(error instanceof EngineError); assert.ok(['process_timeout', 'research_context_application_refused'].includes(error.code), error.code); return true;
  };
  await assert.rejects(invoke(), refusesTimeout);
  const call = f.store.list<ModelCall>('model-call')[0]!;
  assert.equal(call.value.status, 'failed'); assert.equal(call.value.error, 'process_timeout');
  assert.equal(call.value.usage, null); assert.equal(call.value.usageSource, 'unavailable');
  assert.equal(f.sent().length, 1); const heads = f.store.list();
  await assert.rejects(invoke(f.fresh()), refusesTimeout);
  assert.deepEqual(f.store.list(), heads); assert.deepEqual(f.store.get(call.id), call); assert.equal(f.sent().length, 1);
  assert.equal(modelUsage(f.store, 'p', 0).cumulative.reportedTokens, null);
});

test('a question barrier from another response blocks an otherwise retryable empty-provider failure', async t => {
  const f = resumeFixture(t), witness = d83BarrierCandidate(f, 'retry-barrier-witness');
  const parked = await d83ParkBarrierReceipt(f, witness);
  d83EmptyProviderThenSuccess(f); await assert.rejects(f.invoke(), { code: 'research_provider_failed' });
  const failed = d83ExactEmptyFailure(f); assert.equal(f.sent().length, 2);
  witness.invalidate(); await assert.rejects(witness.invoke(f.fresh()), { code: 'research_context_application_refused' });
  const barrier = d83QuestionBarrier(f); assert.deepEqual(barrier.value.refusal, reference(f.store.get(parked.application.id)!));
  const heads = f.store.list(); await assert.rejects(f.invoke(f.fresh()), { code: 'research_context_application_refused' });
  assert.deepEqual(f.store.list(), heads); assert.equal(f.sent().length, 2);
  assert.deepEqual(f.store.get(failed.call.id), failed.call); assert.deepEqual(f.store.get(failed.raw.id), failed.raw);
  assert.deepEqual(f.store.get(barrier.id), barrier); assert.equal(f.store.history(barrier.id).length, 1);
  const usage = modelUsage(f.store, 'p', 0).cumulative;
  assert.equal(usage.measuredCalls, 1); assert.equal(usage.unmeasuredCalls, 1);
});

function d83LimitedAssessment(f: ReturnType<typeof resumeFixture>) {
  const command = f.environment.value.reviewer.command;
  const settings = { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxRequestChars: 100000, maxReadChars: 60000, maxReplyChars: 10000, maxCalls: 1, maxReportedTokens: 100000 };
  let pilot = configureReaderPilot(f.store, f.engine.environments, 'p', settings, 0);
  const invoke = (db = f.store) => assessmentSession(db, f.draft, f.question, f.environment,
    pilotEnvironment(f.environment.value, pilot.value), pilot, f.context, 'Assess the cursor within the native pilot allowance');
  const raise = (db = f.fresh()) => {
    pilot = configureReaderPilot(db, new Environments(db), 'p', { ...settings, maxCalls: 2 }, pilot.revision);
    return pilot;
  };
  return { invoke, raise, profile: () => pilot };
}
async function d83AtPreparedLimit(f: ReturnType<typeof resumeFixture>, limited: ReturnType<typeof d83LimitedAssessment>) {
  await assert.rejects(limited.invoke(), { code: 'pilot_call_limit' });
  const application = f.store.list<any>('assessment-application').find(app => app.value.state === 'prepared')!;
  assert.ok(application); assert.equal(application.value.call, null); assert.equal(application.value.received, null);
  const session = f.store.get<any>(application.value.session.id, application.value.session.revision)!;
  assert.equal(session.value.result, null); assert.ok(session.value.notes.length > 0);
  const applied = f.store.list<any>('assessment-application').find(app => app.value.state === 'applied')!;
  assert.ok(applied); assert.deepEqual(application.value.previous, reference(applied));
  assert.equal(f.store.list('assessment-barrier').length, 0);
  const call = f.store.list<ModelCall>('model-call').find(call => call.value.profile?.revision === limited.profile().revision)!;
  assert.ok(call); assert.equal(call.value.status, 'succeeded');
  const raw = f.store.get<any>(call.value.response!.record!.id)!;
  assert.equal(JSON.parse(raw.value.text).research.action, 'assessment_checkpoint');
  return { application: structuredClone(application), session: structuredClone(session), applied: structuredClone(applied),
    call: structuredClone(call), raw: structuredClone(raw) };
}

test('native maxCalls increase renews an unreserved prepared cursor without reopening or resending its applied checkpoint', async t => {
  const f = resumeFixture(t, 'checkpoint'), limited = d83LimitedAssessment(f);
  const before = await d83AtPreparedLimit(f, limited); callsOnce(f, 1);
  const profile = limited.raise(), db = f.fresh();
  assert.deepEqual(await limited.invoke(db), verdict); callsOnce(f, 2, db);
  const link = d83RenewalLink(db, before);
  assert.equal(link.renewed.value.call, null); assert.deepEqual(link.next.value.profile, reference(profile));
  assert.deepEqual(db.get(before.applied.id), before.applied, 'Raising a limit must not revise already applied proof');
  assert.deepEqual(db.get(before.call.id), before.call); assert.deepEqual(db.get(before.raw.id), before.raw);
  assert.deepEqual(db.get(f.question.id), f.question);
  assert.equal(db.list('assessment-barrier').length, 0);
  assert.equal(f.sent()[0].subject.assessmentState.offset, 0);
  assert.equal(f.sent()[1].subject.assessmentState.offset, before.session.value.offset);
  const archiveRef = f.sent()[1].subject.working.archive;
  const archive = db.get<any>(archiveRef.id, archiveRef.revision)!;
  assert.equal(archive.kind, 'research-context'); assert.equal(archive.hash, archiveRef.hash);
  assert.deepEqual(archive.value.body.assessmentNotes, before.session.value.notes);
  const heads = db.list(); assert.deepEqual(await limited.invoke(f.fresh()), verdict);
  assert.deepEqual(db.list(), heads); callsOnce(f, 2);
});

test('two limit-renewal resumers race the preserved prepared cursor and send its next page only once', async t => {
  const f = resumeFixture(t, 'checkpoint'), limited = d83LimitedAssessment(f), before = await d83AtPreparedLimit(f, limited);
  limited.raise();
  const current = f.fresh(), other = f.fresh(), original = current.writeMany.bind(current);
  type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
  const outcome = (promise: Promise<unknown>): Promise<Outcome> => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  let raced = false, competing: Promise<Outcome> | undefined;
  current.writeMany = ((writes: Write[], guards = []) => {
    if (!raced && writes.some(write => write.kind === 'assessment-application' && (write.value as any).state === 'renewed')) {
      raced = true; competing = outcome(limited.invoke(other));
    }
    return original(writes, guards);
  }) as typeof current.writeMany;
  const own = await outcome(limited.invoke(current)); current.writeMany = original;
  assert.ok(raced); assert.ok(competing); const results = [own, await competing];
  assert.ok(results.some(result => result.ok));
  for (const result of results) {
    if (result.ok) assert.deepEqual(result.value, verdict);
    else {
      assert.ok(result.error instanceof EngineError);
      assert.ok(['research_context_application_running', 'pilot_call_active'].includes(result.error.code), result.error.code);
    }
  }
  callsOnce(f, 2); d83RenewalLink(current, before);
  assert.deepEqual(current.get(before.applied.id), before.applied); assert.deepEqual(current.get(before.call.id), before.call);
  assert.deepEqual(current.get(before.raw.id), before.raw); assert.deepEqual(current.get(f.question.id), f.question);
  assert.equal(f.sent()[1].subject.assessmentState.offset, before.session.value.offset);
  assert.deepEqual(await limited.invoke(f.fresh()), verdict); callsOnce(f, 2);
});

test('a child reserves the renewed cursor before the competing renewal CAS without losing the running call', async t => {
  const f = resumeFixture(t, 'checkpoint'), limited = d83LimitedAssessment(f), before = await d83AtPreparedLimit(f, limited);
  const pilot = limited.raise(), current = f.fresh(), original = current.writeMany.bind(current);
  const input = join(f.root, 'renewal-claim-input.json'), driver = join(f.root, 'renewal-claim-driver.mjs');
  writeFileSync(input, JSON.stringify({ database: f.database, draft: f.draft, question: f.question,
    environment: f.environment, dispatch: pilotEnvironment(f.environment.value, pilot.value), pilot, context: f.context,
    prompt: 'Assess the cursor within the native pilot allowance' }));
  writeFileSync(driver, `import{readFileSync}from'node:fs';
import{Store}from${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
import{assessmentSession}from${JSON.stringify(new URL('../src/discovery/assessment-session.js', import.meta.url).href)};
const spec=JSON.parse(readFileSync(process.argv[2],'utf8')),store=new Store(spec.database),original=store.writeMany.bind(store);
store.writeMany=(writes,guards=[])=>{
 const saved=original(writes,guards);
 if(writes.some(write=>write.kind==='model-call'&&write.expected===0&&write.value.execution?.phase==='claimed')){
  if(!writes.some(write=>write.kind==='assessment-application'&&write.value.state==='running'))throw Error('Missing atomic running application');
  store.close();process.exit(0);
 }
 return saved;
};
await assessmentSession(store,spec.draft,spec.question,spec.environment,spec.dispatch,spec.pilot,spec.context,spec.prompt);
throw Error('The child must stop after reservation before provider spawn');`);
  let raced = false, conflicted = false, claimed: any, running: any;
  current.writeMany = ((writes: Write[], guards = []) => {
    if (!raced && writes.some(write => write.id === before.application.id && (write.value as any).state === 'renewed')) {
      raced = true; execFileSync(process.execPath, [driver, input], { cwd: f.workspace, stdio: 'pipe', timeout: 15000 });
      claimed = structuredClone(current.list<ModelCall>('model-call').find(call => call.id !== before.call.id)!);
      assert.ok(claimed); assert.equal(claimed.value.status, 'running'); assert.equal(claimed.value.execution.phase, 'claimed');
      assert.equal(claimed.value.providerProcess, undefined); assert.equal(claimed.value.response, null);
      const session = current.get<any>(before.session.id)!;
      running = structuredClone(current.get<any>(session.value.application)!);
      assert.equal(running.value.state, 'running'); assert.deepEqual(running.value.call, reference(claimed));
      assert.deepEqual(claimed.value.assessmentApplication, reference(current.get(running.id, 1)!));
      assert.equal(f.sent().length, 1, 'The child has reserved its call but has not transmitted another request');
      try { return original(writes, guards); }
      catch (error) {
        assert.ok(error instanceof EngineError); assert.ok(['revision_conflict', 'input_stale'].includes(error.code), error.code);
        conflicted = true; throw error;
      }
    }
    return original(writes, guards);
  }) as typeof current.writeMany;
  try { await assert.rejects(limited.invoke(current), { code: 'research_context_application_refused' }); }
  finally { current.writeMany = original; }
  assert.ok(raced); assert.ok(conflicted); d83RenewalLink(current, before);
  assert.deepEqual(current.get(claimed.id, claimed.revision), claimed);
  assert.deepEqual(current.get(running.id, running.revision), running);
  const recovered = current.get<ModelCall>(claimed.id)!;
  assert.equal(recovered.value.status, 'failed'); assert.equal(recovered.value.error, 'process_lost');
  const proof = readModelCallRecovery(current, 'p', reference(recovered));
  assert.equal(proof.proof.request, 'not-authorized'); assert.equal(proof.proof.provider, 'not-authorized');
  assert.equal(current.history(claimed.id).length, 2);
  assert.deepEqual(current.history<any>(running.id).map(row => row.value.state), ['prepared', 'running', 'refused']);
  assert.equal(current.list('model-call').length, 2); assert.equal(current.list('model-response').length, 1); assert.equal(f.sent().length, 1);
  assert.deepEqual(current.get(before.applied.id), before.applied); assert.deepEqual(current.get(before.call.id), before.call);
  assert.deepEqual(current.get(before.raw.id), before.raw); assert.deepEqual(current.get(f.question.id), f.question);
  const usage = modelUsage(current, 'p', 0);
  assert.equal(usage.active.length, 0); assert.equal(usage.cumulative.measuredCalls, 1); assert.equal(usage.cumulative.unmeasuredCalls, 1);
  assert.deepEqual(usage.cumulative.reportedTokens, { input: 10, output: 2, cachedInput: 0, reasoningOutput: 0 });
  const heads = current.list(); await assert.rejects(limited.invoke(f.fresh()), { code: 'research_context_application_refused' });
  assert.deepEqual(current.list(), heads); assert.equal(f.sent().length, 1);
});

test('another response barrier blocks prepared-limit renewal without discarding the already paid checkpoint', async t => {
  const f = resumeFixture(t, 'checkpoint'), witness = d83BarrierCandidate(f, 'renewal-barrier-witness');
  // The witness only needs a received response; its original absence-of-pilot
  // admission becomes stale when the native limited experiment is configured.
  const parked = await d83ParkBarrierReceipt(f, witness);
  const limited = d83LimitedAssessment(f), before = await d83AtPreparedLimit(f, limited);
  limited.raise();
  await assert.rejects(witness.invoke(f.fresh()), { code: 'research_context_application_refused' });
  const barrier = d83QuestionBarrier(f); assert.deepEqual(barrier.value.refusal, reference(f.store.get(parked.application.id)!));
  const heads = f.store.list();
  await assert.rejects(limited.invoke(f.fresh()), { code: 'research_context_application_refused' });
  assert.deepEqual(f.store.list(), heads); assert.deepEqual(f.store.get(before.application.id), before.application);
  assert.deepEqual(f.store.get(before.applied.id), before.applied); assert.deepEqual(f.store.get(before.call.id), before.call);
  assert.deepEqual(f.store.get(before.raw.id), before.raw); assert.deepEqual(f.store.get(barrier.id), barrier);
  callsOnce(f, 2); assert.deepEqual(f.store.get(f.question.id), f.question);
});

import { DatabaseSync as Rs3Database } from 'node:sqlite';
import { canonical as rs3Canonical } from '../src/canonical.js';
import type { Ref as Rs3Ref } from '../src/pipeline/contracts.js';
// RS3 (№4433): an assessment call's own envelope is read only through the receipt its era proves (assessmentExecution); an
// unproved sibling consumerExecution saying provider_failed under recomputed hashes changes no outcome.
for (const [code, retryable] of [['adapter_failed', false], ['provider_failed', true]] as const)
  test(`RS3 №4433: an assessment call's own envelope under ${code} is ${retryable ? '' : 'not '}a provider failure, and a forged sibling consumerExecution with provider_failed changes nothing`, async t => {
    const f = resumeFixture(t);
    writeFileSync(f.environment.value.reviewer.command.args[0]!, `import{readFileSync}from'node:fs';
const request=JSON.parse(readFileSync(0,'utf8'));
process.stderr.write(JSON.stringify({error:${JSON.stringify(code)},message:'x'})+'\\n');
process.stdout.write(JSON.stringify({protocol:request.protocol,requestId:request.requestId,usage:null})+'\\n',()=>process.exit(1));`);
    await assert.rejects(f.invoke(), retryable ? { code: 'research_provider_failed' } : d83NoResponseRetry);
    const call = f.store.list<ModelCall>('model-call')[0]!, received = call.value.response?.record; assert.ok(received);
    const raw = f.store.get<any>(received.id, received.revision)!;
    assert.ok(raw.value.assessmentExecution, 'The application era proves the assessment receipt');
    const application = f.store.list<any>('assessment-application').find(app => app.value.call?.id === call.id)!;
    const session = f.store.get<any>(application.value.session.id, application.value.session.revision)!;
    const read = (store: Store, ref: Rs3Ref) => { try { return readResearchExecution(store, 'p', ref, session, f.draft, f.question, application.value.role, application.value.profile).kind; }
      catch (error) { return (error as EngineError).code; } };
    const expected = retryable ? 'provider-failed' : 'response_recovery_wire_foreign';
    assert.equal(read(f.store, reference(call)), expected);
    const value = { ...structuredClone(raw.value), consumerExecution: { process: { exitCode: 1, signal: null,
      stderr: JSON.stringify({ error: 'provider_failed', message: 'counterfeit sibling' }) + '\n' } } };
    const callValue = structuredClone(call.value) as any; callValue.response.record = { id: raw.id, revision: raw.revision, hash: hashJson(value) };
    const db = new Rs3Database(f.database);
    const trigger = (db.prepare("SELECT sql FROM sqlite_master WHERE name='revisions_no_update'").get() as { sql: string }).sql;
    db.exec('DROP TRIGGER revisions_no_update');
    for (const [id, revision, body] of [[raw.id, raw.revision, value], [call.id, call.revision, callValue]] as const)
      db.prepare('UPDATE revisions SET body=?,sha256=? WHERE entity_id=? AND revision=?').run(rs3Canonical(body), hashJson(body as never), id, revision);
    db.exec(trigger); db.close();
    const reopened = f.fresh(), forged = reopened.get<ModelCall>(call.id, call.revision)!;
    assert.ok(reopened.get<any>(raw.id, raw.revision)!.value.consumerExecution, 'The forged sibling is in the store');
    assert.equal(read(reopened, reference(forged)), expected, 'The sibling receipt is never read');
  });

function dry5AssessmentAdapter(f: ReturnType<typeof resumeFixture>, payload: unknown, providerAfter = false, following: unknown[] = []) {
  writeFileSync(f.environment.value.reviewer.command.args[0]!, `import{readFileSync,appendFileSync,existsSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),wire=${JSON.stringify(join(f.root, 'wire.ndjson'))};
const prior=existsSync(wire)?readFileSync(wire,'utf8').trim().split('\\n').filter(Boolean).length:0;
appendFileSync(wire,JSON.stringify(r)+'\\n');
if(${providerAfter}&&prior===1){console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,usage:null}));console.error(JSON.stringify({error:'provider_failed'}));process.exit(1);}
const research=(${JSON.stringify([payload, ...following])})[prior]??{verdict:'supported',reasons:[]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
}
for (const [row, payload] of [
  ['M8', { action: 'answer' }], ['M9 absent reasons', { verdict: 'supported' }],
  ['M9 wrong reasons', { verdict: 'supported', reasons: 42 }], ['M9 checkpoint', { action: 'assessment_checkpoint' }]
] as const) test(`DRY5FIX B ${row}: direct public session retries only its exact assessment`, async t => {
  const f = resumeFixture(t); dry5AssessmentAdapter(f, payload);
  await assert.rejects(f.invoke(), { code: 'assessment_invalid' }); callsOnce(f, 1);
  const failed = f.store.list<any>('assessment-application')[0]!;
  assert.equal(failed.value.state, 'model-refused');
  assert.equal(f.store.list('assessment-barrier').length, 1, 'Only this exact candidate may correct its assessment');
  assert.deepEqual(await f.invoke(f.fresh()), verdict); callsOnce(f, 2);
  assert.equal(f.sent()[1].subject.failures[0].code, 'assessment_invalid');
  assert.ok(f.sent()[1].subject.failures[0].responseContract);
  const count = f.sent().length;
  assert.deepEqual(await f.invoke(f.fresh()), verdict); assert.equal(f.sent().length, count);
});
for (const boundary of ['receipt', 'before-outcome', 'after-outcome'] as const)
test(`DRY5FIX B crash ${boundary}: exact bytes close once before any permitted new call`, async t => {
  const f = resumeFixture(t); dry5AssessmentAdapter(f, { verdict: 'supported' });
  const restore = interruptAt(f.store, writes => writes.some(write => boundary === 'receipt'
    ? write.kind === 'model-response' : write.kind === 'assessment-application' && (write.value as any).state === 'model-refused'),
  boundary !== 'before-outcome');
  await assert.rejects(f.invoke(), { code: 'fixture_application_crash' }); restore(); callsOnce(f, 1);
  if (boundary !== 'after-outcome') {
    await assert.rejects(f.invoke(f.fresh()), { code: 'assessment_invalid' }); callsOnce(f, 1);
  }
  assert.deepEqual(await f.invoke(f.fresh()), verdict); callsOnce(f, 2);
});
test('DRY5FIX B two external resumers reserve one corrective assessment', async t => {
  const f = resumeFixture(t); dry5AssessmentAdapter(f, { verdict: 'supported' });
  await assert.rejects(f.invoke(), { code: 'assessment_invalid' });
  const results = await Promise.allSettled([f.invoke(f.fresh()), f.invoke(f.fresh())]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  callsOnce(f, 2);
  assert.deepEqual(await f.invoke(f.fresh()), verdict); callsOnce(f, 2);
});
test('DRY5FIX B changed source refuses fresh correction while preserving the malformed receipt', async t => {
  const f = resumeFixture(t); dry5AssessmentAdapter(f, { verdict: 'supported' });
  await assert.rejects(f.invoke(), { code: 'assessment_invalid' });
  f.engine.discovery.evidence.document('p', 'basis', 'Changed', 'text/plain', f.source.revision);
  await assert.rejects(f.invoke(f.fresh())); callsOnce(f, 1);
});

// DRY6-02 return 1 (№5070), the class beyond the stop path: whichever renewable state the attempt is in — a proved provider
// failure (retryable) or a refused model answer with its correction barrier (model-refused) — a changed cited Source is the
// proved dependency refusal of that exact application with its door, never a bare source_stale; restart reads the same.
for (const state of ['retryable', 'model-refused'] as const)
test(`DRY6-02 return 1: a ${state} assessment whose cited Source changed is refused by that Source with its door`, async t => {
  const f = resumeFixture(t);
  if (state === 'retryable') d83EmptyProviderThenSuccess(f); else dry5AssessmentAdapter(f, { verdict: 'supported' });
  await assert.rejects(f.invoke(), { code: state === 'retryable' ? 'research_provider_failed' : 'assessment_invalid' });
  const failed = f.store.list<any>('assessment-application')[0]!;
  assert.equal(failed.value.state, state); assert.equal(f.sent().length, 1);
  assert.equal(f.store.list('assessment-barrier').length, state === 'model-refused' ? 1 : 0);
  const changed = f.engine.discovery.evidence.document('p', 'basis', 'Changed', 'text/plain', f.source.revision);
  await assert.rejects(f.invoke(f.fresh()), { code: 'research_context_application_refused' });
  assert.equal(f.sent().length, 1, 'No call is paid on the old citation');
  const db = f.fresh(), refused = db.get<any>(failed.id)!;
  assert.equal(refused.revision, failed.revision + 1); assert.equal(refused.value.state, 'refused');
  assert.deepEqual(refused.value.refusal, { kind: 'dependency', expected: reference(f.source), actual: reference(changed) },
    'The moved Source is named, not the permitted barrier of the correction');
  const door = assessmentRefusalDoor(db, refused);
  assert.deepEqual([door.code, door.changed?.kind, door.question, door.command], ['research_context_application_refused', 'source',
    reference(f.question), { type: 'reopen-question', question: f.question.id, expected: f.question.revision }]);
  const heads = db.list();
  await assert.rejects(f.invoke(db), { code: 'research_context_application_refused' });
  assert.deepEqual(db.list(), heads); assert.equal(f.sent().length, 1);
});

// DRY6-02 return 2 (№5105, №5109): the basis of the failed check is transitive and actual. A prior reader-result is an
// immutable container; the workspace check reads, through the common readPilotContext, the Source of the SELECTED
// observation at its head. Its new revision refuses the retryable renewal by that Source with the door — never the bare
// research_evidence_stale; a changed Source of another observation of the same reading is no cause at all.
async function dry6PriorReaderAssessment(f: ReturnType<typeof resumeFixture>, documents: [string, string][]) {
  const wire = join(f.root, 'wire.ndjson'), refFile = join(f.root, 'reader-ref.json');
  writeFileSync(f.environment.value.reviewer.command.args[0]!, `import{readFileSync,appendFileSync,existsSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,log=${JSON.stringify(wire)};
const previous=existsSync(log)?readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse):[];
appendFileSync(log,JSON.stringify(r)+'\\n');let research;
if(s.role==='reader')research={selections:s.sources.map((v,i)=>({sourceIndex:i,firstLine:v.lines[0][0],lastLine:v.lines.at(-1)[0]})),unresolved:[]};
else if(!s.contextWorkspace.length)research={action:'read_context',record:JSON.parse(readFileSync(${JSON.stringify(refFile)},'utf8')),pointer:'/observations/0/value'};
else if(previous.filter(x=>x.subject.role==='assess-answer').length===1){process.stderr.write('Local provider failed without response');process.exit(1);}
else research={verdict:'supported',reasons:[]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = f.environment.value.reviewer.command;
  const settings = { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
    maxRequestChars: 100000, maxReadChars: 60000, maxReplyChars: 10000, maxCalls: 10, maxReportedTokens: 100000 };
  let pilot = configureReaderPilot(f.store, f.engine.environments, 'p', settings, 0);
  const sources = documents.map(([name, content]) => f.engine.discovery.evidence.document('p', name, content, 'text/plain', 0));
  const reader = await readBundle(f.store, f.environment.value, pilot, reference(f.question), 'Read the independent prior basis',
    sources.map(source => ({ source: reference(source) })));
  writeFileSync(refFile, JSON.stringify(reference(reader)));
  assert.equal((reader.value as any).observations[0].source.id, sources[0]!.id, 'The selected observation reads the first Source');
  const invoke = (db = f.store) => assessmentSession(db, f.draft, f.question, f.environment, pilotEnvironment(f.environment.value, pilot.value),
    pilot, f.context, 'Assess original and looked-up evidence');
  await assert.rejects(invoke(), { code: 'research_provider_failed' });
  const failed = f.store.list<any>('assessment-application').find(app => app.value.state === 'retryable')!;
  assert.ok(failed);
  assert.equal(f.store.get<any>(failed.value.session.id, failed.value.session.revision)!.value.workspace.entries[0].result.record.id, reader.id);
  // The pilot admits a retry after a failure of unknown usage only with an explicit reserve for that exact call.
  const reserve = (db: Store) => {
    const call = db.list<ModelCall>('model-call').find(call => call.value.status === 'failed' && call.value.error === 'research_provider_failed')!;
    pilot = configureReaderPilot(db, new Environments(db), 'p', { ...settings, unknownReserves: [{ call: reference(call), tokens: 1 }] }, pilot.revision);
  };
  return { invoke, reserve, reader, sources, failed };
}

test('DRY6-02 return 2: a prior reader-result whose selected observation Source changed refuses the retryable renewal by that Source with its door', async t => {
  const f = resumeFixture(t), { invoke, reader, sources: [source], failed } = await dry6PriorReaderAssessment(f, [['prior-basis', 'XY']]);
  assert.ok(failed.value.guards.some((guard: any) => guard.id === source!.id && guard.revision === source!.revision && guard.hash === source!.hash),
    'The Source behind the reader-result is an original guard');
  const moved = f.engine.discovery.evidence.document('p', 'prior-basis', 'Changed XY', 'text/plain', source!.revision);
  assert.deepEqual(f.store.get(reader.id), reader, 'The reader-result itself is unchanged');
  const count = f.sent().length, db = f.fresh();
  await assert.rejects(invoke(db), { code: 'research_context_application_refused' });
  assert.equal(f.sent().length, count, 'No call is paid on the old prior reading');
  const refused = db.get<any>(failed.id)!;
  assert.equal(refused.value.state, 'refused');
  assert.deepEqual(refused.value.refusal, { kind: 'dependency', expected: reference(source!), actual: reference(moved) });
  const door = assessmentRefusalDoor(db, refused);
  assert.deepEqual([door.changed?.kind, door.question, door.command], ['source', reference(f.question),
    { type: 'reopen-question', question: f.question.id, expected: f.question.revision }]);
  const heads = db.list();
  await assert.rejects(invoke(f.fresh()), { code: 'research_context_application_refused' });
  assert.deepEqual(db.list(), heads); assert.equal(f.sent().length, count, 'A restart repeats the refusal without a call');
  // The door is the ordinary reopen of the same assessed question in the same draft; it opens nothing automatically.
  const drafts = db.list('discovery-draft');
  new ProductEngine(db).execute(door.command);
  const reopened = db.get<Question>(f.question.id)!;
  assert.deepEqual([reopened.revision, reopened.value.draftId], [f.question.revision + 1, f.draft.id]);
  assert.deepEqual(db.list('discovery-draft'), drafts, 'The same draft continues'); assert.equal(f.sent().length, count);
});

test('DRY6-02 return 2: a changed Source of another observation of the same prior reading, or the reserve raised for the retry, is no cause — the renewal pays its one retry', async t => {
  const f = resumeFixture(t), { invoke, reserve, sources: [selected, other], failed } = await dry6PriorReaderAssessment(f, [['prior-basis', 'XY'], ['unrelated', 'UV']]);
  assert.ok(!failed.value.guards.some((guard: any) => guard.id === other!.id), 'The unselected observation is not a dependency of the check');
  f.engine.discovery.evidence.document('p', 'unrelated', 'Changed UV', 'text/plain', other!.revision);
  const count = f.sent().length, db = f.fresh();
  reserve(db);
  assert.deepEqual(await invoke(db), verdict);
  assert.equal(f.sent().length, count + 1, 'Exactly the one permitted retry is sent');
  assert.equal(db.get<any>(failed.id)!.value.state, 'renewed');
  assert.equal(db.list<any>('assessment-application').some(app => app.value.state === 'refused'), false);
  assert.deepEqual(db.get(selected!.id), selected);
});

// DRY6-02 return 2: an unsent prepared intent renewed by an explicit limit increase after its cited Source changed is
// refused by that Source — the raised profile it is renewed with is not the named cause.
test('DRY6-02 return 2: a prepared intent renewed by a raised limit after its cited Source changed is refused by that Source with its door', async t => {
  const f = resumeFixture(t, 'checkpoint'), limited = d83LimitedAssessment(f), before = await d83AtPreparedLimit(f, limited);
  const moved = f.engine.discovery.evidence.document('p', 'basis', 'Changed', 'text/plain', f.source.revision);
  limited.raise(); const db = f.fresh();
  await assert.rejects(limited.invoke(db), { code: 'research_context_application_refused' });
  assert.equal(f.sent().length, 1, 'The unsent intent is never sent on the old citation');
  const refused = db.get<any>(before.application.id)!;
  assert.equal(refused.value.state, 'refused');
  assert.deepEqual(refused.value.refusal, { kind: 'dependency', expected: reference(f.source), actual: reference(moved) });
  assert.equal(assessmentRefusalDoor(db, refused).changed?.kind, 'source');
});

// DRY6-02 return 2, the negative control: bytes changed on disk under the same Source record are no moved basis record —
// the renewal keeps its own source_stale, writes no refusal and invents no dependency witness.
test('DRY6-02 return 2: changed file bytes under the same Source record keep the bare source_stale without a refusal or witness', async t => {
  const f = resumeFixture(t), file = d83FileAssessment(f); d83EmptyProviderThenSuccess(f);
  await assert.rejects(file.invoke(), { code: 'research_provider_failed' });
  const failed = f.store.list<any>('assessment-application')[0]!;
  assert.equal(failed.value.state, 'retryable');
  writeFileSync(file.path, 'Changed on disk only\n');
  const db = f.fresh(), heads = db.list();
  await assert.rejects(file.invoke(db), { code: 'research_context_application_source_stale' });
  assert.deepEqual(db.list(), heads, 'Nothing is written'); assert.deepEqual(db.get(file.source.id), file.source);
  assert.equal(db.get<any>(failed.id)!.value.state, 'retryable'); assert.equal(f.sent().length, 1);
});

test('DRY5FIX B a new candidate cannot bypass the failed assessment under the same question', async t => {
  const f = resumeFixture(t); dry5AssessmentAdapter(f, { verdict: 'supported' });
  await assert.rejects(f.invoke(), { code: 'assessment_invalid' });
  await assert.rejects(assessmentSession(f.fresh(), f.draft, f.question, f.environment, f.environment.value,
    undefined, { ...f.context, value: { result: 'different candidate' } }, 'Assess a different candidate'),
  { code: 'research_context_application_refused' }); callsOnce(f, 1);
  assert.deepEqual(await f.invoke(f.fresh()), verdict); callsOnce(f, 2);
});
test('DRY5FIX B invalid packet/cursor is an engine error before the reply classifier', () => {
  const current = { projectId: 'p', offset: 1, notes: [], focus: null, result: null }, context = { value: 'candidate' };
  for (const sent of [undefined, { evidencePage: { offset: 0 } },
    { evidencePage: { offset: 1, end: 2 }, candidatePage: { total: 999, offset: 0, complete: true } }])
    assert.throws(() => assessmentPacket(current, context, sent), { code: 'assessment_invalid' });
});

test('DRY5FIX B correction reason survives an intervening provider refusal on the same candidate', async t => {
  const f = resumeFixture(t); dry5AssessmentAdapter(f, { verdict: 'supported' }, true);
  await assert.rejects(f.invoke(), { code: 'assessment_invalid' });
  await assert.rejects(f.invoke(f.fresh()), { code: 'research_provider_failed' }); assert.equal(f.sent().length, 2);
  assert.deepEqual(await f.invoke(f.fresh()), verdict); assert.equal(f.sent().length, 3);
  assert.equal(f.sent()[2].subject.failures[0].code, 'assessment_invalid');
});


test('DRY5FIX B each subsequent malformed candidate retains its own barrier until its correction completes', async t => {
  const f = resumeFixture(t), negative = { verdict: 'insufficient', reasons: ['Revise'] };
  dry5AssessmentAdapter(f, { verdict: 'supported' }, false, [negative, { verdict: 'supported' }, negative]);
  const candidate = (name: string, db = f.fresh()) => assessmentSession(db, f.draft, f.question, f.environment,
    f.environment.value, undefined, { ...f.context, value: { result: name } }, 'Assess next proposal');
  await assert.rejects(f.invoke(), { code: 'assessment_invalid' });
  const first = f.store.list<any>('assessment-barrier')[0]!;
  assert.deepEqual(await f.invoke(f.fresh()), negative); callsOnce(f, 2);
  const completed = f.store.get(first.id)!;
  await assert.rejects(candidate('B'), { code: 'assessment_invalid' }); callsOnce(f, 3);
  const second = f.store.get<any>(first.id)!;
  assert.equal(second.revision, 3); assert.equal(second.value.completion, undefined);
  assert.notDeepEqual(second.value.refusal, first.value.refusal);
  await assert.rejects(candidate('C'), { code: 'research_context_application_refused' }); callsOnce(f, 3);
  assert.deepEqual(await candidate('B'), negative); callsOnce(f, 4);
  assert.equal(f.store.get(first.id)!.revision, 4);
  assert.deepEqual(await candidate('C'), verdict); callsOnce(f, 5);
  assert.deepEqual(await f.invoke(f.fresh()), negative);
  assert.deepEqual(await candidate('B'), negative);
  assert.deepEqual(await candidate('C'), verdict); callsOnce(f, 5);
  assert.deepEqual(f.store.get(first.id, first.revision), first);
  assert.deepEqual(f.store.get(first.id, completed.revision), completed);
});

for (const after of [false, true])
test(`DRY5FIX B negative correction and barrier completion are atomic at ${after ? 'after' : 'before'} write`, async t => {
  const f = resumeFixture(t), negative = { verdict: 'conflicting', reasons: ['Revise'] };
  dry5AssessmentAdapter(f, { verdict: 'supported' }, false, [negative]);
  await assert.rejects(f.invoke(), { code: 'assessment_invalid' });
  const candidate = () => assessmentSession(f.fresh(), f.draft, f.question, f.environment, f.environment.value,
    undefined, { ...f.context, value: { result: 'B' } }, 'Assess next proposal');
  const restore = interruptAt(f.store, writes => writes.some(write => write.kind === 'assessment-barrier'
    && Boolean((write.value as any).completion)), after);
  await assert.rejects(f.invoke(), { code: 'fixture_application_crash' }); restore(); callsOnce(f, 2);
  if (!after) { await assert.rejects(candidate(), { code: 'research_context_application_refused' }); callsOnce(f, 2); }
  assert.deepEqual(await f.invoke(f.fresh()), negative); callsOnce(f, 2);
  assert.deepEqual(await candidate(), verdict); callsOnce(f, 3);
});

test('DRY5FIX B an earlier completed model correction cannot release a later technical barrier', async t => {
  const f = resumeFixture(t), negative = { verdict: 'insufficient', reasons: ['Revise'] };
  dry5AssessmentAdapter(f, { verdict: 'supported' }, false, [negative]);
  await assert.rejects(f.invoke(), { code: 'assessment_invalid' });
  assert.deepEqual(await f.invoke(f.fresh()), negative); callsOnce(f, 2);
  const candidate = (name: string, db = f.fresh()) => assessmentSession(db, f.draft, f.question, f.environment,
    f.environment.value, undefined, { ...f.context, value: { result: name } }, 'Assess next proposal');
  const original = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    const saved = original(writes, guards);
    if (!changed && writes.some(write => write.kind === 'model-response')) { changed = true; f.createPilot(f.fresh()); }
    return saved;
  }) as typeof f.store.writeMany;
  await assert.rejects(candidate('B', f.store), { code: 'research_context_application_refused' });
  f.store.writeMany = original; assert.ok(changed); callsOnce(f, 3);
  const barrier = f.store.list<any>('assessment-barrier')[0]!;
  assert.equal(barrier.revision, 3); assert.equal(barrier.value.completion, undefined);
  assert.equal(f.store.get<any>(barrier.value.refusal.id, barrier.value.refusal.revision)!.value.state, 'refused');
  await assert.rejects(candidate('B'), { code: 'research_context_application_refused' });
  await assert.rejects(candidate('C'), { code: 'research_context_application_refused' }); callsOnce(f, 3);
  assert.deepEqual(await f.invoke(f.fresh()), negative); callsOnce(f, 3);
});

test('DRY5FIX B a changed admission at the negative-result CAS cannot complete the model barrier', async t => {
  const f = resumeFixture(t), negative = { verdict: 'insufficient', reasons: ['Revise'] };
  dry5AssessmentAdapter(f, { verdict: 'supported' }, false, [negative]);
  await assert.rejects(f.invoke(), { code: 'assessment_invalid' });
  const original = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!changed && writes.some(write => write.kind === 'assessment-barrier' && Boolean((write.value as any).completion))) {
      changed = true; f.createPilot(f.fresh());
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.invoke(), { code: 'research_context_application_refused' });
  f.store.writeMany = original; assert.ok(changed); callsOnce(f, 2);
  assert.equal(f.store.list<any>('assessment-barrier')[0]!.value.completion, undefined);
  await assert.rejects(assessmentSession(f.fresh(), f.draft, f.question, f.environment, f.environment.value,
    undefined, { ...f.context, value: { result: 'B' } }, 'Assess next proposal'), { code: 'research_context_application_refused' });
  await assert.rejects(f.invoke(f.fresh()), { code: 'research_context_application_refused' }); callsOnce(f, 2);
});


import { preparedField as asm1Field } from './preparation-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import type { DiscoveryDraft as Asm1Draft } from '../src/discovery/discovery.js';
import { stageNeighbors, STAGE_NEIGHBOR_CONTEXT } from '../src/discovery/stage-neighbors.js';
import { readResearchAssessmentAt as asm1ReadAssessment } from '../src/discovery/research-assessment.js';
import { workingContext as asm1Working } from '../src/discovery/working-context.js';

async function asm1Fixture(t: test.TestContext, stage: 'concept' | 'operation-map' | 'specification' | 'features' = 'concept',
  continuation = false) {
  const f = resumeFixture(t);
  if (stage === 'operation-map') {
    // L1A map packets bind the accepted Discovery/concept chain, including its catalogue.
    for (const prior of ['discovery', 'concept'] as const) {
      const upstream = f.engine.prepare('p', prior);
      for (const id of upstream.value.questions) {
        const question = f.store.get<Question>(id)!;
        if (question.value.spec.kind === 'fact')
          f.engine.discovery.fact(id, question.revision, reference(f.source), f.observation.selector);
        else if (prior === 'discovery' && ['researchPlan', 'researchReport', 'verdict', 'preparation'].includes(question.value.spec.field))
          answerDiscoveryFixture(f.engine, 'p', f.store.get<Asm1Draft>(upstream.id)!, question,
            asm1Field('p', question.value.spec.field), f.source);
        else f.engine.discovery.decision(id, question.revision, 'owner', asm1Field('p', question.value.spec.field));
      }
      const artifact = f.engine.draft('p', prior, upstream.id, 0);
      f.engine.pipeline.accept('p', prior, artifact.revision);
    }
  }
  const draft = stage === 'operation-map' ? f.engine.prepare('p', stage) : f.engine.discovery.forStage('p', stage, stage);
  const questions = draft.value.questions.map(id => f.store.get<Question>(id)!);
  for (const q of questions.slice(0, -1)) f.engine.discovery.decision(q.id, q.revision, 'owner', asm1Field('p', q.value.spec.field));
  const selected = questions.at(-1)!;
  let value = asm1Field('p', selected.value.spec.field);
  if (stage === 'operation-map') {
    const { designOf } = await import('../src/graph/builder.js');
    const { exampleGraph } = await import('./graph-fixture.js');
    const { enrichedGraph } = await import('./enriched-graph-fixture.js');
    value = designOf(enrichedGraph(exampleGraph('p'), 'p')) as any;
  }
  const candidate = { action: 'answer' as const, question: selected.id, value,
    citations: [{ source: reference(f.source), selector: f.observation.selector }] };
  writeFileSync(join(f.root, 'adapter.mjs'), String.raw`import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
appendFileSync(${JSON.stringify(join(f.root, 'wire.ndjson'))},JSON.stringify(r)+'\n');
const research=s.role==='assess-answer'?${continuation ? "(!s.contextWorkspace.length?{action:'read_context',record:s.working.archive,pointer:'/body/stageNeighbors/fields/0/value'}:{verdict:'supported',reasons:[]})" : "{verdict:'supported',reasons:[]}"}:${JSON.stringify(candidate)};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const current = f.store.get<Asm1Draft>(draft.id)!;
  return { ...f, selected, current, candidate, neighbors: stageNeighbors(f.store, current, selected).context!,
    run: (db = f.store) => new ProductEngine(db).researcher.run('p', draft.id, 1),
    direct: (db = f.store) => assessAnswer(db, selected, candidate, f.environment, f.workspace) };
}

for (const stage of ['concept', 'operation-map', 'specification', 'features'] as const)
test(`ASM1 B ${stage}: the paid assessor receives exact accepted neighbors and the new origin era`, async t => {
  const f = await asm1Fixture(t, stage);
  const result = await f.run();
  assert.equal(f.store.get<Question>(f.selected.id)!.value.status, 'answered', result.value.error ?? 'answer must be applied');
  const paid = f.sent().filter(row => row.subject.role === 'assess-answer');
  assert.equal(paid.length, 1);
  assert.equal(paid[0].subject.assessmentContextContract, STAGE_NEIGHBOR_CONTEXT);
  assert.deepEqual(paid[0].subject.stageNeighbors, f.neighbors);
  assert.match(paid[0].prompt, /kind=design/);
  assert.match(paid[0].prompt, /stageNeighbors/);
  const origin = f.store.list<any>('assessment-paid-origin').at(-1)!;
  assert.equal(origin.value.contract, 'assessment-paid-origin/v2');
  const binding = f.store.list<any>('research-assessment-binding').at(-1)!;
  assert.equal(asm1ReadAssessment(f.fresh(), 'p', binding.value.turn.id, binding.value.assessment).value.verdict, 'supported');
  callsOnce(f, 2);
});

test('ASM1 B continuation retains the full prefix and assessor instructions after foundation replacement', async t => {
  const f = await asm1Fixture(t, 'concept', true);
  await f.run();
  const calls = f.sent().filter(row => row.subject.role === 'assess-answer');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.subject.stageNeighbors, f.neighbors);
    assert.equal(call.subject.assessmentContextContract, STAGE_NEIGHBOR_CONTEXT);
    assert.match(call.prompt, /kind=design/);
    assert.match(call.prompt, /stageNeighbors/);
  }
  assert.ok(calls[1].subject.continuation);
  callsOnce(f, 3);
});

test('ASM1 B paid receipt resumes after restart without another call; later reopen does not rewrite historical meaning', async t => {
  const f = await asm1Fixture(t);
  const restore = interruptAt(f.store, writes => writes.some(write => write.kind === 'model-response')
    && f.store.list('model-call').length === 2, true);
  const interrupted = await f.run(); restore();
  assert.equal(interrupted.value.status, 'paused');
  assert.match(interrupted.value.error ?? '', /selected persistent boundary/);
  callsOnce(f, 2);
  const restarted = f.fresh(); await f.run(restarted); callsOnce(f, 2, restarted);
  const binding = restarted.list<any>('research-assessment-binding').at(-1)!;
  const expected = asm1ReadAssessment(restarted, 'p', binding.value.turn.id, binding.value.assessment);
  const q = restarted.get<Question>(f.neighbors.fields[0]!.question.id)!;
  new ProductEngine(restarted).discovery.reopen(q.id, q.revision);
  assert.deepEqual(asm1ReadAssessment(f.fresh(), 'p', binding.value.turn.id, binding.value.assessment), expected);
  assert.deepEqual(f.sent()[1].subject.stageNeighbors, f.neighbors);
  callsOnce(f, 2, restarted);
});

test('ASM1 B a native neighbor reopen in the publication window refuses a mixed assessment', async t => {
  const f = await asm1Fixture(t), other = new ProductEngine(f.fresh());
  const original = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!changed && writes.some(write => write.kind === 'assessment-session' && (write.value as any).result)) {
      changed = true;
      const q = other.store.get<Question>(f.neighbors.fields[0]!.question.id)!;
      other.discovery.reopen(q.id, q.revision);
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  const result = await f.run();
  assert.ok(changed); assert.equal(result.value.status, 'paused');
  assert.equal(f.store.get<Question>(f.selected.id)!.value.status, 'open');
  assert.equal(f.store.list('research-assessment-binding').length, 0);
  assert.equal(f.store.list('research-assessment').length, 0);
  const app = f.store.list<any>('assessment-application').at(-1)!;
  assert.equal(app.value.state, 'refused');
  assert.equal(app.value.refusal.kind, 'dependency');
  assert.equal(app.value.refusal.expected.id, f.neighbors.fields[0]!.question.id);
  callsOnce(f, 2);
});

test('ASM1 B oversized required prefix stops before a physical call', async t => {
  const f = await asm1Fixture(t);
  const first = f.store.get<Question>(f.neighbors.fields[0]!.question.id)!;
  const reopened = f.engine.discovery.reopen(first.id, first.revision);
  f.engine.discovery.decision(reopened.id, reopened.revision, 'owner', 'audience'.repeat(60000));
  await assert.rejects(f.direct(), { code: 'pilot_core_limit' });
  assert.equal(f.sent().length, 0);
  assert.equal(f.store.list('model-call').length, 0);
  assert.equal(f.store.list('model-response').length, 0);
  assert.equal(modelUsage(f.store, 'p', 0).cumulative.reportedTokens, null);
});

test('ASM1 B/C packing preserves mandatory neighbors for initial and continuation, with an addressed absent-material refusal', async t => {
  const f = await asm1Fixture(t);
  for (const role of ['assess-answer', 'assess-escalation']) {
    const body = { role, question: f.selected.value.spec, assessmentContextContract: STAGE_NEIGHBOR_CONTEXT,
      stageNeighbors: f.neighbors, request: { reason: 'Choose a private account' }, history: [] };
    const initial = asm1Working(f.store, 'p', f.current.id, f.selected.id, body, 100000, { common: true });
    const continued = asm1Working(f.store, 'p', f.current.id, f.selected.id, body, 100000,
      { common: true, continuation: true, previous: initial.working.archive });
    for (const packet of [initial, continued]) {
      assert.deepEqual(packet.stageNeighbors, f.neighbors);
      assert.deepEqual(packet.request, body.request);
      assert.equal(packet.role, role);
    }
    assert.throws(() => asm1Working(f.store, 'p', f.current.id, f.selected.id, body, 1000,
      { common: true, continuation: true, previous: initial.working.archive }), { code: 'pilot_core_limit' });
    const { stageNeighbors: _omitted, ...missing } = body;
    assert.throws(() => asm1Working(f.store, 'p', f.current.id, f.selected.id, missing, 100000, { common: true }),
      { code: 'context_stage_neighbors_incomplete' });
  }
  assert.equal(f.sent().length, 0);
  assert.equal(f.store.list('model-call').length, 0);
  assert.equal(f.store.list('model-response').length, 0);
  assert.equal(modelUsage(f.store, 'p', 0).cumulative.reportedTokens, null);
});


test('ASM1 B direct assessment receives pending instead of the retained old value of a reopened neighbor', async t => {
  const f = await asm1Fixture(t);
  const q = f.store.get<Question>(f.neighbors.fields[0]!.question.id)!;
  const reopened = f.engine.discovery.reopen(q.id, q.revision);
  await f.direct();
  const material = f.sent()[0].subject.stageNeighbors;
  assert.deepEqual(material.fields, []);
  assert.deepEqual(material.pending, { field: q.value.spec.field, question: reference(reopened) });
  callsOnce(f, 1);
});


async function asm1DirectV1(f: Awaited<ReturnType<typeof asm1Fixture>>) {
  const { researchPrerequisites, researchGraphContext } = await import('../src/discovery/research-context.js');
  const { consumerFeedback } = await import('../src/discovery/consumer-feedback.js');
  const context = { role: 'assess-answer', question: f.selected.value.spec, value: f.candidate.value, observations: [f.observation],
    prerequisites: researchPrerequisites(f.store, f.current.value), operationMap: researchGraphContext(f.store, f.current.value),
    consumerFeedback: consumerFeedback(f.store, f.current.value) };
  // The still-supported direct session producer takes this explicit unmarked material; no saved record is rewritten.
  return assessmentSession(f.store, f.current, f.selected, f.environment, f.environment.value, undefined, context,
    'Assess the saved candidate against its exact observations. Return {verdict: supported|insufficient|conflicting, reasons: string[]}.');
}

for (const era of ['unmarked', 'neighbors'] as const)
test(`ASM1 return direct B ${era}: a paid receipt keeps its original application, context and prompt across a fresh Store`, async t => {
  const f = await asm1Fixture(t);
  const restore = interruptAt(f.store, writes => writes.some(write => write.kind === 'model-response'), true);
  await assert.rejects(era === 'unmarked' ? asm1DirectV1(f) : f.direct(), { code: 'fixture_application_crash' }); restore();
  const application = f.store.list<any>('assessment-application')[0]!;
  const response = f.store.list('model-response')[0]!;
  const sessions = f.store.list('assessment-session').map(row => row.id);
  assert.equal(application.value.state, 'running'); assert.equal(f.store.list('assessment-paid-origin').length, 0);
  assert.equal(application.value.context.assessmentContextContract, era === 'unmarked' ? undefined : STAGE_NEIGHBOR_CONTEXT);
  const restarted = f.fresh(), result = await f.direct(restarted);
  assert.equal(result.value.verdict, 'supported'); callsOnce(f, 1, restarted);
  assert.deepEqual(restarted.get(response.id, response.revision), response);
  assert.deepEqual(restarted.list('assessment-session').map(row => row.id), sessions);
  const applied = restarted.get<any>(application.id)!;
  assert.equal(applied.value.state, 'applied'); assert.deepEqual(applied.value.context, application.value.context);
  assert.equal(applied.value.prompt, application.value.prompt);
  const later = await f.direct(f.fresh());
  if (era === 'unmarked') {
    // ASM1.1 (№4791 §3 п.2, п.5): the recovered unmarked attempt keeps its earlier contract — no origin. The later current
    // call is a new material on today's prefix, so it is a different, bound assessment, never the recovered one.
    assert.equal(result.value.origin, undefined, 'The recovered attempt is not marked with a material it never saw');
    assert.equal(later.value.origin?.contract, DIRECT_ASSESSMENT_ORIGIN);
    assert.notEqual(later.id, result.id);
  } else assert.deepEqual(later, result);
  // Recovery above paid nothing. A later current call from an unmarked completed
  // producer is a new material era; a completed v2 call is an exact repeat.
  callsOnce(f, era === 'unmarked' ? 2 : 1);
  if (era === 'unmarked') assert.equal(f.store.list<any>('assessment-application').filter(row =>
    row.value.context.assessmentContextContract === STAGE_NEIGHBOR_CONTEXT && row.value.state === 'applied').length, 1);
});

test('ASM1 return direct B does not take a neighboring session for a different candidate', async t => {
  const f = await asm1Fixture(t);
  const restore = interruptAt(f.store, writes => writes.some(write => write.kind === 'model-response'), true);
  await assert.rejects(asm1DirectV1(f), { code: 'fixture_application_crash' }); restore();
  const old = f.store.list<any>('assessment-application')[0]!;
  const candidate = structuredClone(f.candidate);
  assert.ok(Array.isArray(candidate.value));
  (candidate.value[0] as Record<string, unknown>)['title'] = 'A different bounded concept';
  const result = await assessAnswer(f.fresh(), f.selected, candidate, f.environment, f.workspace);
  assert.deepEqual(result.value.value, candidate.value); callsOnce(f, 2);
  assert.equal(f.store.get<any>(old.id)!.value.state, 'running');
  const fresh = f.store.list<any>('assessment-application').find(row => row.id !== old.id)!;
  assert.equal(fresh.value.state, 'applied'); assert.equal(fresh.value.context.assessmentContextContract, STAGE_NEIGHBOR_CONTEXT);
});

test('ASM1 return direct B keeps a paid neighbor context after native reopen and refuses its old admission without paying again', async t => {
  const f = await asm1Fixture(t);
  const restore = interruptAt(f.store, writes => writes.some(write => write.kind === 'model-response'), true);
  await assert.rejects(f.direct(), { code: 'fixture_application_crash' }); restore();
  const app = f.store.list<any>('assessment-application')[0]!, other = new ProductEngine(f.fresh());
  const question = other.store.get<Question>(f.neighbors.fields[0]!.question.id)!;
  other.discovery.reopen(question.id, question.revision);
  await assert.rejects(f.direct(f.fresh()), { code: 'research_context_application_refused' });
  const refused = f.store.get<any>(app.id)!;
  assert.equal(refused.value.state, 'refused'); assert.equal(refused.value.refusal.kind, 'dependency');
  assert.deepEqual(refused.value.context, app.value.context); assert.equal(f.store.list('assessment-session').length, 1);
  assert.equal(f.store.list('research-assessment').length, 0); callsOnce(f, 1);
});


function asm1AudienceAdapter(f: Awaited<ReturnType<typeof asm1Fixture>>) {
  writeFileSync(join(f.root, 'adapter.mjs'), String.raw`import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
appendFileSync(${JSON.stringify(join(f.root, 'wire.ndjson'))},JSON.stringify(r)+'\n');
const changed=s.stageNeighbors?.fields.some(row=>row.field==='audience'&&row.value==='Changed audience');
const research=s.role==='assess-answer'?(s.stageNeighbors?.pending?{verdict:'insufficient',reasons:['A prior premise is pending']}:changed?{verdict:'conflicting',reasons:['The candidate addresses the prior audience']}:{verdict:'supported',reasons:[]}):${JSON.stringify(f.candidate)};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
}
function asm1ChangeAudience(engine: ProductEngine, f: Awaited<ReturnType<typeof asm1Fixture>>) {
  const q = engine.store.get<Question>(f.neighbors.fields[0]!.question.id)!;
  const opened = engine.discovery.reopen(q.id, q.revision);
  engine.discovery.decision(opened.id, opened.revision, 'owner', 'Changed audience');
}

test('ASM1 round3 current direct B after an applied assessment uses the changed exact prefix and refuses an unsupported answer', async t => {
  const f = await asm1Fixture(t); asm1AudienceAdapter(f);
  const first = await f.direct(); assert.equal(first.value.verdict, 'supported');
  const firstApp = f.store.list<any>('assessment-application')[0]!;
  asm1ChangeAudience(new ProductEngine(f.fresh()), f);
  const second = await f.direct(f.fresh());
  assert.equal(second.value.verdict, 'conflicting'); assert.notEqual(second.id, first.id);
  assert.deepEqual(f.sent().map(row => row.subject.stageNeighbors.fields.find((item: any) => item.field === 'audience').value),
    [f.neighbors.fields[0]!.value, 'Changed audience']);
  assert.throws(() => new ProductEngine(f.fresh()).discovery.researched(f.selected.id, f.selected.revision, reference(second)),
    { code: 'research_not_supported' });
  assert.equal(f.store.get<Question>(f.selected.id)!.value.status, 'open');
  assert.deepEqual(f.store.get(first.id, first.revision), first); assert.deepEqual(f.store.get(firstApp.id), firstApp);
  assert.deepEqual(await f.direct(f.fresh()), second); callsOnce(f, 2);
  assert.ok(f.store.list<any>('assessment-application').every(row => row.value.state === 'applied'));
});

test('ASM1 round3 a native neighbor change before creating a new direct session refuses before dispatch and the next entry sees the new prefix', async t => {
  const f = await asm1Fixture(t); asm1AudienceAdapter(f);
  const other = new ProductEngine(f.fresh()), write = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!changed && writes.some(row => row.kind === 'assessment-session' && row.expected === 0)) {
      changed = true; asm1ChangeAudience(other, f);
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.direct(), { code: 'input_stale' }); f.store.writeMany = write;
  assert.ok(changed); assert.equal(f.sent().length, 0); assert.equal(f.store.list('model-call').length, 0);
  assert.equal(f.store.list('model-response').length, 0); assert.equal(f.store.list('assessment-session').length, 0);
  const corrected = await f.direct(f.fresh()); assert.equal(corrected.value.verdict, 'conflicting'); callsOnce(f, 1);
  assert.ok(f.store.list<any>('assessment-application').every(row => row.value.state === 'applied'));
});

test('ASM1 round3 a native neighbor change before returning an already applied direct assessment is guarded with no extra call', async t => {
  const f = await asm1Fixture(t); await f.direct();
  const other = new ProductEngine(f.fresh()), write = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!changed && writes.length === 0 && guards.some(row => row.id === f.neighbors.fields[0]!.question.id)) {
      changed = true; asm1ChangeAudience(other, f);
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.direct(), { code: 'input_stale' }); f.store.writeMany = write;
  assert.ok(changed); callsOnce(f, 1);
  assert.equal(f.store.list('research-assessment').length, 1);
  assert.ok(f.store.list<any>('assessment-application').every(row => row.value.state === 'applied'));
});

test('ASM1 round3 managed B after native reopens delivers a new prefix while its completed old assessment stays historical', async t => {
  const f = await asm1Fixture(t); asm1AudienceAdapter(f);
  await f.run();
  const binding = f.store.list<any>('research-assessment-binding')[0]!;
  const before = asm1ReadAssessment(f.fresh(), 'p', binding.value.turn.id, binding.value.assessment);
  const other = new ProductEngine(f.fresh()); asm1ChangeAudience(other, f);
  const q = other.store.get<Question>(f.selected.id)!; other.discovery.reopen(q.id, q.revision);
  await f.run(f.fresh());
  const assessments = f.sent().filter(row => row.subject.role === 'assess-answer');
  assert.equal(assessments.length, 2);
  assert.equal(assessments[1].subject.stageNeighbors.fields[0].value, 'Changed audience');
  assert.equal(f.store.get<Question>(f.selected.id)!.value.status, 'open');
  assert.deepEqual(asm1ReadAssessment(f.fresh(), 'p', binding.value.turn.id, binding.value.assessment), before);
  callsOnce(f, 4);
  assert.ok(f.store.list<any>('assessment-application').every(row => row.value.state === 'applied'));
});


for (const era of ['unmarked', 'neighbors'] as const)
test(`ASM1 round3 ${era}: a pure reopen after completed B changes the prefix even when the draft revision stays the same`, async t => {
  const f = await asm1Fixture(t); asm1AudienceAdapter(f);
  if (era === 'unmarked') await asm1DirectV1(f); else await f.direct();
  const prior = f.store.list<any>('assessment-application')[0]!, draft = f.store.get(f.current.id)!;
  const other = new ProductEngine(f.fresh()), q = other.store.get<Question>(f.neighbors.fields[0]!.question.id)!;
  const opened = other.discovery.reopen(q.id, q.revision);
  assert.deepEqual(f.store.get(f.current.id), draft, 'Native reopen changes only the question');
  const result = await f.direct(f.fresh()); assert.equal(result.value.verdict, 'insufficient'); callsOnce(f, 2);
  const context = f.sent()[1].subject.stageNeighbors;
  assert.deepEqual(context.fields, []); assert.deepEqual(context.pending.question, reference(opened));
  assert.deepEqual(f.store.get(prior.id), prior);
  assert.throws(() => new ProductEngine(f.fresh()).discovery.researched(f.selected.id, f.selected.revision, reference(result)),
    { code: 'research_not_supported' });
});


test('ASM1 round3 concurrent direct entries select one current session and never duplicate its paid call', async t => {
  const f = await asm1Fixture(t);
  const results = await Promise.allSettled([f.direct(f.fresh()), f.direct(f.fresh())]);
  assert.ok(results.some(result => result.status === 'fulfilled' && result.value.value.verdict === 'supported'),
    results.map(result => result.status === 'rejected' ? String(result.reason) : result.value.value.verdict).join('; '));
  const repeated = await f.direct(f.fresh()); assert.equal(repeated.value.verdict, 'supported');
  callsOnce(f, 1); assert.equal(f.store.list('assessment-session').length, 1);
  assert.ok(f.store.list<any>('assessment-application').every(row => row.value.state === 'applied'));
});


test('ASM1 round3 a native reopen during direct paid publication preserves the receipt and refuses without a second call', async t => {
  const f = await asm1Fixture(t), other = new ProductEngine(f.fresh());
  const write = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!changed && writes.some(row => row.kind === 'assessment-session' && (row.value as any).result)) {
      changed = true; asm1ChangeAudience(other, f);
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(f.direct(), { code: 'research_context_application_refused' }); f.store.writeMany = write;
  assert.ok(changed); callsOnce(f, 1);
  const app = f.store.list<any>('assessment-application')[0]!;
  assert.equal(app.value.state, 'refused'); assert.equal(app.value.refusal.kind, 'dependency');
  assert.equal(f.store.list('research-assessment').length, 0);
  assert.equal(f.store.list('model-response').length, 1);
});

// DRY6-01 (contract №4961 (b)): the refused original assessment names the assessed question and its exact machine door.
const DRY601_KIND = { 'reader-pilot': 'reader-pilot', 'execution-root': 'execution-root', environment: 'environment', question: 'question',
  draft: 'discovery-draft', source: 'source' } as const;
function dry601Refuse(f: ReturnType<typeof resumeFixture>, dependency: keyof typeof DRY601_KIND) {
  const original = f.store.writeMany.bind(f.store); let injected = false;
  f.store.writeMany = ((writes: Write[], guards = []) => {
    if (!injected && writes.some(write => write.kind === 'assessment-session' && Boolean((write.value as any).result))) {
      injected = true; const other = f.fresh();
      if (dependency === 'reader-pilot') f.createPilot(other);
      else if (dependency === 'execution-root') f.createRoot(other);
      else {
        const row = dependency === 'environment' ? f.environment : dependency === 'question' ? f.question : dependency === 'draft' ? f.draft : f.source;
        other.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
      }
    }
    return original(writes, guards);
  }) as typeof f.store.writeMany;
  return () => { f.store.writeMany = original; assert.ok(injected, 'The dependency moved during the assessment'); };
}
const refusalOf = (promise: Promise<unknown>) => promise.then(() => assert.fail('The assessment must refuse'), (error: unknown) => {
  assert.ok(error instanceof EngineError); return error; });

for (const dependency of Object.keys(DRY601_KIND) as (keyof typeof DRY601_KIND)[])
test(`DRY6-01 a ${dependency} changed during the assessment: the refusal names the assessed question and its exact reopen door, the change by its own kind; a restart repeats the same door without a call`, async t => {
  const f = resumeFixture(t), restore = dry601Refuse(f, dependency);
  const refused = await refusalOf(f.invoke()); restore();
  assert.equal(refused.code, 'research_context_application_refused');
  const app = f.store.list<any>('assessment-application')[0]!, head = f.store.get<Question>(f.question.id)!;
  assert.deepEqual((refused.details as { application: unknown }).application, reference(app), 'The refusal itself is unchanged');
  const door = assessmentRefusalDoor(f.store, app);
  assert.deepEqual(door, { contract: 'assessment-refusal-door/v1', code: 'research_context_application_refused', application: reference(app),
    question: reference(f.question), current: reference(head),
    changed: { expected: app.value.refusal.expected, actual: app.value.refusal.actual, kind: DRY601_KIND[dependency] },
    command: { type: 'reopen-question', question: f.question.id, expected: head.revision } });
  const again = await refusalOf(f.invoke(f.fresh()));
  assert.deepEqual((again.details as { application: unknown }).application, reference(app));
  assert.deepEqual(assessmentRefusalDoor(f.fresh(), app), door, 'A restart derives the same door from the same saved application'); callsOnce(f, 1);
});

test('DRY6-01 the named command reopens the assessed question without reading any text and the next assessment is new; a concurrent reopen first is a CAS refusal that changes nothing', async t => {
  const f = resumeFixture(t), restore = dry601Refuse(f, 'reader-pilot');
  await refusalOf(f.ordinary()); restore();
  const refused = f.store.list<any>('assessment-application')[0]!, door = assessmentRefusalDoor(f.store, refused);
  const other = new ProductEngine(f.fresh());
  other.execute({ type: 'reopen-question', question: f.question.id, expected: f.store.get<Question>(f.question.id)!.revision });
  const moved = f.store.get<Question>(f.question.id)!;
  assert.throws(() => new ProductEngine(f.fresh()).execute(door.command), (error: unknown) => error instanceof EngineError && error.code === 'question_stale');
  assert.deepEqual(reference(f.store.get<Question>(f.question.id)!), reference(moved), 'The refused command changed nothing');
  await refusalOf(f.ordinary(f.fresh()));
  const current = assessmentRefusalDoor(f.fresh(), f.store.get<any>(refused.id)!);
  assert.deepEqual(current.command, { type: 'reopen-question', question: f.question.id, expected: moved.revision }, 'The door follows the head');
  new ProductEngine(f.fresh()).execute(current.command);
  const q = f.store.get<Question>(f.question.id)!;
  const assessment = await f.ordinary(f.fresh(), q); assert.equal(assessment.value.verdict, 'supported'); callsOnce(f, 2);
});

test('DRY6-01 an applied assessment has no recovery door: an addressed refusal', async t => {
  const f = resumeFixture(t); assert.deepEqual(await f.invoke(), verdict);
  const applied = f.store.list<any>('assessment-application')[0]!; assert.equal(applied.value.state, 'applied');
  assert.throws(() => assessmentRefusalDoor(f.store, applied), (error: unknown) => error instanceof EngineError
    && error.code === 'assessment_refusal_door_invalid' && JSON.stringify(error.details).includes(applied.id));
});
