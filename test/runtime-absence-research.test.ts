import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, type Revision, type Write, type TransactionGuard } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, isRef } from '../src/pipeline/contracts.js';
import type { Json } from '../src/canonical.js';
import { configureResearchScope } from '../src/graph/research-scope.js';
import { technicalResearchFindings } from '../src/graph/research-evidence.js';
import { collectRuntimeEvidence } from '../src/graph/runtime-evidence.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import { assessmentSession } from '../src/discovery/assessment-session.js';
import { modelUsage, type ModelCall } from '../src/runtime/model-usage.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { Environments, git, uniqueTransactionGuards, transactionGuardsCurrent } from '../src/runtime/environment.js';
import { runtimeContext, type RuntimeObservationResult } from '../src/runtime/runtime-observation.js';
import { ensureWorktree } from '../src/execution/worktree.js';
import type { ObligationPolicy, RuntimeCheck } from '../src/graph/obligation-policy.js';
import type { Question } from '../src/discovery/discovery.js';
import type { Graph } from '../src/graph/model.js';
import type { TechnicalReport } from '../src/graph/research-contracts.js';
import type { ResearchAction } from '../src/discovery/research-model.js';
import type { MachinePlan } from '../src/compiler/model.js';
import { preparedFeatures } from './product-fixture.js';
import { answerTechnicalFixture } from './technical-research-fixture.js';
import { deriveLayerFixture } from './layer-design-fixture.js';

// All stages/scopes are genuine producers; only unrelated technical assessments
// use the standard explicit downstream seed. The runtime answer is assessed by
// the local stdio adapter and records real machine-derived runtimeProofs.
async function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-d82-milestone-'))), workspace = join(root, 'repo');
  mkdirSync(workspace);
  git(workspace, ['init', '-b', 'main']);
  writeFileSync(join(workspace, 'README.md'), 'Fixture baseline\n');
  git(workspace, ['add', '.']);
  git(workspace, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline']);
  const store = new Store(join(root, 'state.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const wire = join(root, 'assessor-wire.json'), adapter = join(root, 'assessor.mjs');
  writeFileSync(adapter, `import{readFileSync,writeFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));writeFileSync(${JSON.stringify(wire)},JSON.stringify(r));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{verdict:'supported',reasons:[]},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  preparedFeatures(engine, 'p');
  const environment = engine.environments.configure('p', { workspace,
    implementer: { actor: 'worker', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000 }, 0);
  const r0 = engine.refinement.begin('p', 'R0');
  engine.refinement.finishResearch('p', 'R0', reference(r0), 0);
  engine.refinement.sealLayer('p', 1, 0);
  const gap = { id: 'runtime-ready', target: 'p-produce-block', consumer: 'compilation', field: 'tests',
    requiredFor: 'next' as const, question: 'Observe the local fixture invocation before accepting this R2 design' };
  const r1 = engine.refinement.begin('p', 'R1');
  answerTechnicalFixture(engine, 'p', r1, (field, report) => field === 'runtime' ? { ...report, gaps: [gap] } : report);
  const r1Phase = engine.refinement.finishResearch('p', 'R1', reference(store.get(r1.id)!), 0);
  deriveLayerFixture(engine, 'p', 2);
  engine.refinement.sealLayer('p', 2, 0);
  const original = configureResearchScope(store, { projectId: 'p', layer: reference(store.get('graph-layer:p:2')!), r1: reference(r1Phase),
    outcome: 'A bounded local fixture', nodes: [gap.target], boundaries: [], expansions: [], changedPaths: [], uiRequired: false,
    obligations: [{ gap, state: 'active', reason: 'Approved fixture scope', wake: null }] }, 0);
  const code = engine.discovery.evidence.document('p', 'milestone-check',
    "import{readFileSync}from'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({fixture:true,obligation:input.obligation,root:input.runtime.root}));", 'text/plain', 0);
  const check: RuntimeCheck = { script: reference(code), dependencies: [], subjects: [], executables: [], args: [], timeoutMs: 3000,
    purpose: 'Observe one local fixture invocation, without claiming a production runtime capability' };
  const policy: ObligationPolicy = { version: 1, sourceScope: reference(original), assignments: [{ obligation: gap.id,
    original: { record: reference(original), pointer: '/obligations/0/gap' }, kind: 'environment-confirmation', moment: 'R2',
    responsibleNode: gap.target, responsibleConsumer: gap.consumer, neededForR2: true,
    reason: 'The R2 decision depends on the actual declared fixture invocation', returnCondition: null, runtimeCheck: check }] };
  const scope = configureResearchScope(store, { ...original.value, policy }, original.revision);
  const draft = engine.refinement.begin('p', 'R2');
  const matches = draft.value.questions.map(id => store.get<Question>(id)!)
    .filter(question => question.value.spec.obligations?.some(obligation => obligation.id === gap.id));
  assert.equal(matches.length, 1);
  const question = matches[0]!;
  const observe = () => engine.execute({ type: 'observe-runtime', project: 'p', scope: reference(scope), obligation: gap.id,
    key: 'milestone-runtime' }) as Promise<RuntimeObservationResult>;
  const observed = await observe();
  assert.equal(observed.observation.value.status, 'observed');
  assert.equal(observed.observation.value.result?.exitCode, 0);
  assert.ok(observed.source);
  const citation = engine.discovery.evidence.observe('p', reference(observed.source), { kind: 'json-pointer', pointer: '/result/stdout' });
  const report: TechnicalReport = { applicability: 'applicable', reason: 'An actual declared fixture invocation was observed', facts: [],
    designs: [{ id: 'runtime-design', decision: 'Use only the quoted local invocation result to resolve this scoped R2 question',
      benefit: 'The design does not invent runtime behavior', consumer: 'compilation' }], gaps: [],
    documents: [{ id: 'runtime-result', kind: 'document-observation', citation: 0, quote: String(citation.value).trim(),
      claim: 'The fixture emitted this exact output; this is not a statement about other runtime capabilities', designs: ['runtime-design'], gaps: [] }],
    coverage: [{ obligation: gap.id, facts: [], designs: ['runtime-design'], gaps: [] }] };
  const action: Extract<ResearchAction, { action: 'answer' }> = { action: 'answer', question: question.id, value: report as unknown as Json,
    citations: [{ source: citation.source, selector: citation.selector }] };
  return { root, workspace, store, engine, adapter, wire, graph: store.get<Graph>('graph:p')!.value, code, environment, spec: question.value.spec,
    draft, question, observe, observed, proposed: { observation: citation, report, action } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Dependency = 'reader-pilot' | 'execution-root';
function createDependency(f: Pick<Fixture, 'store' | 'workspace'>, dependency: Dependency) {
  const second = new Store(f.store.path), environments = new Environments(second);
  try {
    if (dependency === 'reader-pilot') {
      const before = runtimeContext(f.store, 'p').binding, command = { executable: process.execPath, args: ['--version'] };
      configureReaderPilot(second, environments, 'p', { experimental: true, active: false, stopAfter: 'L2',
        reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command }, agentCommand: command,
        maxRequestChars: 300000, maxReadChars: 60000, maxReplyChars: 100000, maxCalls: 100, maxReportedTokens: 20000000 }, 0);
      assert.deepEqual(runtimeContext(f.store, 'p').binding, before);
    } else ensureWorktree(second, environments, { projectId: 'p', base: { root: f.workspace, head: git(f.workspace, ['rev-parse', 'HEAD']) } } as MachinePlan);
    assert.ok(second.get(`${dependency}:p`));
  } finally { second.close(); }
}

function transactionRace(f: Pick<Fixture, 'store' | 'workspace'>, dependency: Dependency, kind: string) {
  const original = f.store.writeMany.bind(f.store); let raced = false, attempted: Write[] = [];
  const neighbors: Write[] = ['one', 'two'].map(part => ({ id: `d82-neighbor:${part}`, kind: 'd82-neighbor', expected: 0, value: { part } }));
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    if (!raced && writes.some(write => write.kind === kind)) {
      raced = true; attempted = writes;
      assert.ok(guards.some(guard => guard.id === `${dependency}:p` && 'absent' in guard), 'The original absence reaches the actual consumer transaction');
      createDependency(f, dependency);
      return original([...writes, ...neighbors], guards);
    }
    return original(writes, guards);
  }) as Store['writeMany'];
  return { restore() { f.store.writeMany = original; }, check() {
    assert.equal(raced, true);
    for (const write of [...attempted, ...neighbors]) {
      assert.equal(f.store.get(write.id)?.revision ?? 0, write.expected, `No partial write of ${write.id}`);
      assert.equal(f.store.history(write.id).length, write.expected);
    }
  } };
}

test('D8.2 technical findings preserve the complete admission channel and conflicting variants', async t => {
  const f = await fixture(t), p = f.proposed;
  const runtime = collectRuntimeEvidence(f.store, 'p', f.spec, p.report, [p.observation]);
  assert.equal(runtime.proofs.length, 1);
  assert.deepEqual(runtime.admissionGuards, [{ id: 'execution-root:p', absent: true }, { id: 'reader-pilot:p', absent: true }]);
  const assessment = await assessAnswer(f.store, f.question, p.action, f.environment, f.workspace);
  f.engine.discovery.researched(f.question.id, f.question.revision, reference(assessment));
  answerTechnicalFixture(f.engine, 'p', f.draft);
  const answered = f.store.get<import('../src/discovery/discovery.js').DiscoveryDraft>(f.draft.id)!;
  const guards: TransactionGuard[] = [];
  assert.deepEqual(technicalResearchFindings(f.store, f.engine.discovery, answered.value, f.graph, f.workspace, guards), []);
  assert.deepEqual(guards, uniqueTransactionGuards([...runtime.guards, ...runtime.admissionGuards]));
  createDependency(f, 'reader-pilot');
  const contradiction = uniqueTransactionGuards([...guards, reference(f.store.get('reader-pilot:p')!)]);
  assert.equal(contradiction.filter(guard => guard.id === 'reader-pilot:p').length, 2);
  assert.equal(transactionGuardsCurrent(f.store, contradiction), false);
  const id = 'd82-no-partial-contradiction';
  assert.throws(() => f.store.writeMany([{ id, kind: 'd82-neighbor', expected: 0, value: {} }], contradiction), { code: 'input_stale' });
  assert.equal(f.store.get(id), null);
  assert.ok(assessment.value.runtimeProofs?.length);
  assert.ok(answered.value.inputs.every(isRef));
  const gate = f.engine.discovery.gate('p', reference(answered));
  assert.deepEqual(gate.findings, []);
  assert.ok((gate.admissionGuards ?? []).every(isRef), 'Historical features/research gate does not expose live runtime absence');
});

test('D8.2 final assessment and research answer reject native creation at their transactions without partial writes', async t => {
  for (const dependency of ['reader-pilot', 'execution-root'] as const) for (const kind of ['research-assessment', 'research-answer'] as const) {
    const f = await fixture(t);
    const assessment = kind === 'research-answer' ? await assessAnswer(f.store, f.question, f.proposed.action, f.environment, f.workspace) : null;
    const race = transactionRace(f, dependency, kind);
    try {
      if (kind === 'research-assessment') await assert.rejects(assessAnswer(f.store, f.question, f.proposed.action, f.environment, f.workspace), { code: 'input_stale' });
      else assert.throws(() => f.engine.discovery.researched(f.question.id, f.question.revision, reference(assessment!)), { code: 'input_stale' });
    } finally { race.restore(); }
    race.check();
  }
});

// This opens a real internal window after runtimeContext captured its guards,
// at the first checker-source read. The model-session mechanism is not changed.
test('D8.2 technical findings keep the original absence when a dependency appears inside runtime proof checking', async t => {
  for (const dependency of ['reader-pilot', 'execution-root'] as const) {
    const f = await fixture(t), assessment = await assessAnswer(f.store, f.question, f.proposed.action, f.environment, f.workspace);
    f.engine.discovery.researched(f.question.id, f.question.revision, reference(assessment));
  answerTechnicalFixture(f.engine, 'p', f.draft);
  const answered = f.store.get<import('../src/discovery/discovery.js').DiscoveryDraft>(f.draft.id)!;
    const original = f.store.get.bind(f.store); let raced = false;
    f.store.get = <T>(id: string, revision?: number): Revision<T> | null => {
      const result = original<T>(id, revision);
      if (!raced && id === f.code.id) { raced = true; createDependency(f, dependency); }
      return result;
    };
    const guards: TransactionGuard[] = [];
    try { assert.deepEqual(technicalResearchFindings(f.store, f.engine.discovery, answered.value, f.graph, f.workspace, guards), []); }
    finally { f.store.get = original; }
    assert.equal(raced, true);
    assert.ok(guards.some(guard => guard.id === `${dependency}:p` && 'absent' in guard));
    assert.equal(transactionGuardsCurrent(f.store, guards), false);
    const writes = ['one', 'two'].map(part => ({ id: `d82-findings:${part}`, kind: 'd82-neighbor', expected: 0, value: { part } }));
    assert.throws(() => f.store.writeMany(writes, guards), { code: 'input_stale' });
    for (const write of writes) assert.equal(f.store.get(write.id), null);
  }
});

async function d82MilestoneFixture(t: test.TestContext) {
  const f = await fixture(t), assessment = await assessAnswer(f.store, f.question, f.proposed.action, f.environment, f.workspace);
  assert.equal(assessment.value.runtimeProofs?.length, 1);
  f.engine.discovery.researched(f.question.id, f.question.revision, reference(assessment));
  answerTechnicalFixture(f.engine, 'p', f.draft);
  const answered = reference(f.store.get(f.draft.id)!);
  assert.deepEqual(f.engine.discovery.gate('p', answered).findings, []);
  return { ...f, assessment, finish: (expected: number) => f.engine.refinement.finishResearch('p', 'R2', answered, expected) };
}

test('D8.2 real R2 runtime proofs retain both absent dependencies through the milestone transaction', async t => {
  for (const dependency of ['reader-pilot', 'execution-root'] as const) {
    const f = await d82MilestoneFixture(t), original = f.store.writeMany.bind(f.store);
    const neighbors: Write[] = ['one', 'two'].map(part => ({ id: `d82-milestone-neighbor:${part}`,
      kind: 'd82-milestone-neighbor', expected: 0, value: { part } }));
    const assessmentBefore = JSON.stringify(f.assessment), calls = f.store.list('model-call').length;
    let raced = false;
    f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
      if (!raced && writes.some(write => write.id === 'phase:p:R2')) {
        raced = true;
        const phase = writes.find(write => write.id === 'phase:p:R2')!;
        assert.ok((phase.value as { inputs: unknown[] }).inputs.every(isRef));
        assert.ok(guards.some(guard => guard.id === `${dependency}:p` && 'absent' in guard), dependency);
        createDependency(f, dependency);
        return original([...writes, ...neighbors], guards);
      }
      return original(writes, guards);
    }) as Store['writeMany'];
    try { assert.throws(() => f.finish(0), { code: 'input_stale' }, dependency); }
    finally { f.store.writeMany = original; }
    assert.equal(raced, true);
    assert.ok(f.store.get(`${dependency}:p`));
    for (const id of ['phase:p:R2', ...neighbors.map(write => write.id)]) {
      assert.equal(f.store.get(id), null); assert.deepEqual(f.store.history(id), []);
    }
    assert.equal(JSON.stringify(f.store.get(f.assessment.id)), assessmentBefore);
    assert.equal(f.store.list('model-call').length, calls, 'Completion never sends another model request');
    assert.deepEqual(await f.observe(), f.observed, 'Exact observation replay keeps the received result after the dependency appears');
  }
});

test('D8.2 exact R2 milestone replay checks admission but preserves real observation and assessment history', async t => {
  for (const dependency of ['reader-pilot', 'execution-root'] as const) {
    const f = await d82MilestoneFixture(t), phase = f.finish(0), before = JSON.stringify(phase), history = f.store.history(phase.id);
    const calls = f.store.list('model-call').length;
    assert.deepEqual(f.finish(phase.revision), phase, 'An unchanged accepted R2 replays without another phase revision');
    const originalGet = f.store.get.bind(f.store), originalEffective = f.engine.environments.effective.bind(f.engine.environments);
    let armed = false, raced = false, effectiveCalls = 0;
    f.engine.environments.effective = project => {
      const value = originalEffective(project); effectiveCalls++; armed = true; return value;
    };
    f.store.get = <T>(id: string, revision?: number): Revision<T> | null => {
      const value = originalGet<T>(id, revision);
      if (armed && !raced && id === phase.id && revision === undefined) {
        raced = true;
        createDependency(f, dependency);
      }
      return value;
    };
    try { assert.throws(() => f.finish(phase.revision), { code: 'input_stale' }, dependency); }
    finally { f.store.get = originalGet; f.engine.environments.effective = originalEffective; }
    assert.equal(effectiveCalls, 1); assert.equal(raced, true);
    assert.equal(JSON.stringify(f.store.get(phase.id)), before);
    assert.deepEqual(f.store.history(phase.id), history);
    const reopened = new Store(f.store.path);
    try {
      assert.equal(JSON.stringify(reopened.get(phase.id, phase.revision)), before);
      assert.deepEqual(reopened.get(f.assessment.id, f.assessment.revision), f.assessment);
      assert.deepEqual(reopened.get(f.observed.observation.id, f.observed.observation.revision), f.observed.observation);
    } finally { reopened.close(); }
    assert.equal(f.store.list('model-call').length, calls);
    assert.deepEqual(await f.observe(), f.observed);
  }
});

test('D8.2 researched protects its first effective root even when the typed answer has no runtime proofs', async t => {
  const f = await fixture(t), runtimeAssessment = await assessAnswer(f.store, f.question, f.proposed.action, f.environment, f.workspace);
  f.engine.discovery.researched(f.question.id, f.question.revision, reference(runtimeAssessment));
  const originalResearched = f.engine.discovery.researched.bind(f.engine.discovery), stop = new Error('Capture the next explicit downstream fixture assessment');
  let captured: Parameters<typeof originalResearched> | undefined;
  f.engine.discovery.researched = (...args) => { captured = args; throw stop; };
  try { assert.throws(() => answerTechnicalFixture(f.engine, 'p', f.draft), error => error === stop); }
  finally { f.engine.discovery.researched = originalResearched; }
  assert.ok(captured);
  assert.equal(f.store.get<import('../src/discovery/research-model.js').ResearchAssessment>(captured[2].id)!.value.runtimeProofs, undefined);
  const questionBefore = f.store.get(captured[0]), draftBefore = f.store.get(f.draft.id);
  const effective = Environments.prototype.effective, writeMany = f.store.writeMany.bind(f.store);
  const neighbors: Write[] = ['one', 'two'].map(part => ({ id: `d82-first-root:${part}`, kind: 'd82-neighbor', expected: 0, value: {} }));
  let raced = false, writesSeen = false;
  t.mock.method(Environments.prototype, 'effective', function (this: Environments, project: string) {
    const result = effective.call(this, project);
    if (!raced) { raced = true; createDependency(f, 'execution-root'); }
    return result;
  });
  f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
    if (writes.some(write => write.kind === 'research-answer')) {
      writesSeen = true;
      assert.ok(guards.some(guard => guard.id === 'execution-root:p' && 'absent' in guard));
      return writeMany([...writes, ...neighbors], guards);
    }
    return writeMany(writes, guards);
  }) as Store['writeMany'];
  try { assert.throws(() => originalResearched(...captured!), { code: 'input_stale' }); }
  finally { f.store.writeMany = writeMany; t.mock.restoreAll(); }
  assert.equal(raced, true); assert.equal(writesSeen, true);
  assert.deepEqual(f.store.get(captured[0]), questionBefore);
  assert.deepEqual(f.store.get(f.draft.id), draftBefore);
  for (const write of neighbors) assert.equal(f.store.get(write.id), null);
});

test('D8.2 research answer preserves the guard captured before an internal runtime proof race', async t => {
  for (const dependency of ['reader-pilot', 'execution-root'] as const) {
    const f = await fixture(t), assessment = await assessAnswer(f.store, f.question, f.proposed.action, f.environment, f.workspace);
    const get = f.store.get.bind(f.store), beforeDraft = get(f.draft.id); let raced = false;
    f.store.get = <T>(id: string, revision?: number): Revision<T> | null => {
      const result = get<T>(id, revision);
      if (!raced && id === f.code.id) { raced = true; createDependency(f, dependency); }
      return result;
    };
    try { assert.throws(() => f.engine.discovery.researched(f.question.id, f.question.revision, reference(assessment)), { code: 'input_stale' }); }
    finally { f.store.get = get; }
    assert.equal(raced, true);
    assert.deepEqual(f.store.get(f.question.id), f.question);
    assert.deepEqual(f.store.get(f.draft.id), beforeDraft);
    assert.deepEqual(f.store.list('research-answer').filter(answer => (answer.value as { question: { id: string } }).question?.id === f.question.id), []);
  }
});

function d82Application(f: Fixture, db = f.store) {
  const applications = db.list<any>('assessment-application').filter(app => {
    const session = db.get<any>(app.value.session.id, app.value.session.revision);
    return session?.value.binding?.question.id === f.question.id;
  });
  assert.equal(applications.length, 1);
  return applications[0]!;
}
function d82RepeatApplication(f: Fixture, db: Store, application: Revision<any>) {
  const app = application.value, session = db.get<any>(app.session.id, app.session.revision)!, binding = session.value.binding;
  assert.equal(binding.question.id, f.question.id);
  return assessmentSession(db, db.get<any>(binding.draft.id, binding.draft.revision)!,
    db.get<any>(binding.question.id, binding.question.revision)!, db.get<any>(binding.environment.id, binding.environment.revision)!,
    app.dispatch, undefined, app.context, app.prompt);
}
function d82TargetAssessments(f: Fixture) {
  return f.store.list<any>('research-assessment').filter(assessment => assessment.value.question.id === f.question.id);
}
function d82RefusedReceipt(f: Fixture, dependency: Dependency, expectedCalls: number) {
  const app = d82Application(f), original = f.store.get<any>(app.id, 1)!;
  assert.equal(app.value.state, 'refused'); assert.equal(app.value.refusal.kind, 'dependency');
  assert.deepEqual(app.value.refusal.expected, { id: `${dependency}:p`, absent: true });
  assert.deepEqual(app.value.refusal.actual, reference(f.store.get(`${dependency}:p`)!));
  assert.deepEqual(app.value.guards, original.value.guards);
  for (const id of ['reader-pilot:p', 'execution-root:p']) assert.ok(app.value.guards.some((guard: TransactionGuard) => guard.id === id && 'absent' in guard));
  assert.equal(app.value.context.runtimeProofs.length, 1, 'The paid application contains genuinely checked runtime evidence');
  const call = f.store.get<ModelCall>(app.value.received.id, app.value.received.revision)!;
  assert.equal(call.value.purpose, 'assessor'); assert.equal(call.value.status, 'succeeded');
  assert.equal(call.value.error, null); assert.equal(call.value.usageSource, 'adapter');
  const response = f.store.get<any>(call.value.response!.record!.id, call.value.response!.record!.revision)!;
  assert.equal(response.hash, call.value.response!.record!.hash);
  const envelope = JSON.parse(response.value.text);
  assert.equal(envelope.requestId, call.value.requestId); assert.deepEqual(envelope.research, { verdict: 'supported', reasons: [] });
  assert.deepEqual(envelope.usage, call.value.usage);
  const barrier = f.store.list<any>('assessment-barrier').find(row => row.value.question.id === f.question.id)!;
  assert.ok(barrier); assert.equal(barrier.revision, 1); assert.deepEqual(barrier.value.refusal, reference(app));
  assert.deepEqual(barrier.value.question, reference(f.question));
  assert.equal(d82TargetAssessments(f).length, 0); assert.equal(f.store.get<Question>(f.question.id)!.value.status, 'open');
  const usage = modelUsage(f.store, 'p', 0).cumulative;
  assert.equal(usage.attempts, expectedCalls); assert.equal(usage.measuredCalls, expectedCalls);
  assert.deepEqual(usage.reportedTokens, { input: expectedCalls * 10, output: expectedCalls * 2, cachedInput: 0, reasoningOutput: 0 });
  return { app, call, response, barrier, usage };
}

for (const dependency of ['reader-pilot', 'execution-root'] as const) {
  test(`D8.2 ${dependency} created at the assessor receipt preserves the original runtime absence and one paid refusal`, async t => {
    const f = await fixture(t), original = f.store.writeMany.bind(f.store); let raced = false;
    f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
      const saved = original(writes, guards);
      if (!raced && writes.some(write => write.kind === 'model-response')
        && writes.some(write => write.kind === 'model-call' && (write.value as ModelCall).purpose === 'assessor')) {
        raced = true;
        const app = d82Application(f);
        assert.equal(app.value.state, 'running'); assert.equal(app.value.received, null);
        assert.ok(app.value.guards.some((guard: TransactionGuard) => guard.id === `${dependency}:p` && 'absent' in guard));
        createDependency(f, dependency);
      }
      return saved;
    }) as Store['writeMany'];
    try { await assert.rejects(assessAnswer(f.store, f.question, f.proposed.action, f.environment, f.workspace),
      { code: 'research_context_application_refused' }); }
    finally { f.store.writeMany = original; }
    assert.ok(raced); const paid = d82RefusedReceipt(f, dependency, 1);
    const heads = f.store.list(), wire = readFileSync(f.wire, 'utf8');
    for (const restart of [false, true]) {
      const db = restart ? new Store(f.store.path) : f.store;
      try {
        await assert.rejects(d82RepeatApplication(f, db, paid.app), { code: 'research_context_application_refused' });
        assert.deepEqual(db.list(), heads); assert.deepEqual(db.get(paid.call.id), paid.call);
        assert.deepEqual(db.get(paid.response.id), paid.response); assert.deepEqual(db.get(paid.barrier.id), paid.barrier);
        assert.equal(db.list('model-call').length, 1); assert.equal(db.list('model-response').length, 1);
        assert.deepEqual(modelUsage(db, 'p', 0).cumulative, paid.usage); assert.equal(readFileSync(f.wire, 'utf8'), wire);
      } finally { if (restart) db.close(); }
    }
  });
}

for (const dependency of ['reader-pilot', 'execution-root'] as const) for (const window of ['session-write', 'reservation', 'proof-before-session'] as const) {
  test(`D8.2 ${dependency} created in ${window} refuses assessor admission without partial neighboring records`, async t => {
    const f = await fixture(t), get = f.store.get.bind(f.store), write = f.store.writeMany.bind(f.store);
    const neighbors: Write[] = ['one', 'two'].map(part => ({ id: `d82-session-neighbor:${part}`, kind: 'd82-neighbor', expected: 0, value: { part } }));
    let raced = false, attempted = false;
    if (window === 'proof-before-session') f.store.get = <T>(id: string, revision?: number): Revision<T> | null => {
      const found = get<T>(id, revision);
      if (!raced && id === f.code.id) { raced = true; createDependency(f, dependency); }
      return found;
    };
    f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
      const target = writes.some(item => window === 'reservation'
        ? item.kind === 'model-call' && (item.value as ModelCall).purpose === 'assessor'
        : item.kind === 'assessment-session' && item.expected === 0);
      if (!attempted && target) {
        attempted = true;
        assert.ok(guards.some(guard => guard.id === `${dependency}:p` && 'absent' in guard), 'The original runtime proof absence must reach the transaction');
        if (window === 'proof-before-session') {
          assert.ok(raced); assert.ok(guards.some(guard => guard.id === `${dependency}:p` && isRef(guard)),
            'The newer context cannot erase the earlier negative dependency');
        } else { raced = true; createDependency(f, dependency); }
        return write([...writes, ...neighbors], guards);
      }
      return write(writes, guards);
    }) as Store['writeMany'];
    try { await assert.rejects(assessAnswer(f.store, f.question, f.proposed.action, f.environment, f.workspace),
      { code: window === 'reservation' ? 'research_context_application_refused' : 'input_stale' }); }
    finally { f.store.get = get; f.store.writeMany = write; }
    assert.ok(raced); assert.ok(attempted); assert.ok(f.store.get(`${dependency}:p`));
    for (const neighbor of neighbors) { assert.equal(f.store.get(neighbor.id), null); assert.deepEqual(f.store.history(neighbor.id), []); }
    assert.equal(f.store.list('model-call').length, 0); assert.equal(f.store.list('model-response').length, 0);
    assert.equal(existsSync(f.wire), false); assert.equal(modelUsage(f.store, 'p', 0).cumulative.attempts, 0);
    assert.equal(d82TargetAssessments(f).length, 0); assert.equal(f.store.list('assessment-barrier').length, 0);
    if (window === 'reservation') {
      const app = d82Application(f); assert.equal(app.value.state, 'refused'); assert.equal(app.value.call, null); assert.equal(app.value.received, null);
    } else {
      assert.equal(f.store.list('assessment-session').length, 0); assert.equal(f.store.list('assessment-application').length, 0);
    }
  });
}

for (const dependency of ['reader-pilot', 'execution-root'] as const) {
  test(`D8.2 ordinary research runner pauses on the saved assessor refusal after native ${dependency} creation`, async t => {
    const f = await fixture(t);
    answerTechnicalFixture(f.engine, 'p', { ...f.draft, value: { ...f.draft.value,
      questions: f.draft.value.questions.filter(id => id !== f.question.id) } });
    assert.equal(f.store.get<Question>(f.question.id)!.value.status, 'open');
    const wire = join(f.root, 'runner-wire.ndjson');
    writeFileSync(f.adapter, `import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
const research=r.subject.assessmentState?{verdict:'supported',reasons:[]}:${JSON.stringify(f.proposed.action)};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
    const original = f.store.writeMany.bind(f.store); let raced = false;
    f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
      const saved = original(writes, guards);
      if (!raced && writes.some(write => write.kind === 'model-response')
        && writes.some(write => write.kind === 'model-call' && (write.value as ModelCall).purpose === 'assessor')) {
        raced = true; createDependency(f, dependency);
      }
      return saved;
    }) as Store['writeMany'];
    let run: Revision<import('../src/discovery/research-model.js').ResearchRun>;
    try { run = await f.engine.execute({ type: 'research-draft', project: 'p', draftId: f.draft.id, maxTurns: 1 }) as typeof run; }
    finally { f.store.writeMany = original; }
    assert.ok(raced); assert.equal(run.value.status, 'paused'); assert.equal(run.value.pauseCode, 'research_context_application_refused');
    const paid = d82RefusedReceipt(f, dependency, 2), turns = f.store.list<any>('research-turn').filter(turn => turn.value.run === run.id);
    assert.equal(turns.length, 1); assert.equal(turns[0]!.value.status, 'pending');
    assert.equal(turns[0]!.value.action.question, f.question.id); assert.equal(turns[0]!.value.assessment, null);
    const rawWire = readFileSync(wire, 'utf8'); assert.equal(rawWire.trim().split('\n').length, 2);
    assert.equal(f.store.list<ModelCall>('model-call').filter(call => call.value.purpose === 'assessor').length, 1);
    const db = new Store(f.store.path);
    try {
      const heads = db.list(); await assert.rejects(d82RepeatApplication(f, db, paid.app), { code: 'research_context_application_refused' });
      assert.deepEqual(db.list(), heads); assert.deepEqual(db.get(run.id), run); assert.equal(readFileSync(wire, 'utf8'), rawWire);
      assert.deepEqual(modelUsage(db, 'p', 0).cumulative, paid.usage);
    } finally { db.close(); }
  });
}


test('D8.2 milestone rejects native creation inside its actual technical runtime check without partial writes', async t => {
  for (const dependency of ['reader-pilot', 'execution-root'] as const) {
    const f = await d82MilestoneFixture(t), get = f.store.get.bind(f.store), effective = f.engine.environments.effective.bind(f.engine.environments);
    const writeMany = f.store.writeMany.bind(f.store); let armed = false, raced = false, attempted = false;
    const neighbors: Write[] = ['one', 'two'].map(part => ({ id: `d82-internal-milestone:${part}`, kind: 'd82-neighbor', expected: 0, value: {} }));
    f.engine.environments.effective = project => { const value = effective(project); armed = true; return value; };
    f.store.get = <T>(id: string, revision?: number): Revision<T> | null => {
      const value = get<T>(id, revision);
      if (armed && !raced && id === f.code.id) { raced = true; createDependency(f, dependency); }
      return value;
    };
    f.store.writeMany = ((writes: Write[], guards: TransactionGuard[] = []) => {
      if (writes.some(write => write.id === 'phase:p:R2')) {
        attempted = true;
        assert.ok(guards.some(guard => guard.id === `${dependency}:p` && 'absent' in guard));
        return writeMany([...writes, ...neighbors], guards);
      }
      return writeMany(writes, guards);
    }) as Store['writeMany'];
    try { assert.throws(() => f.finish(0), { code: 'input_stale' }); }
    finally { f.store.get = get; f.engine.environments.effective = effective; f.store.writeMany = writeMany; }
    assert.equal(raced, true); assert.equal(attempted, true);
    for (const id of ['phase:p:R2', ...neighbors.map(write => write.id)]) assert.equal(f.store.get(id), null);
  }
});


test('D8.2 genuine gates preserve positive acceptance sources and new OM preparation guards exact frame absence', async t => {
  const { UPSTREAM_STAGES } = await import('../src/discovery/requirements.js');
  const { writeOmInput, prepareOmInput } = await import('../src/om/input.js');
  const { writeHorizon, prepareHorizon } = await import('../src/om/horizon.js');
  const { prepareFrame, prepareLayerAcceptance } = await import('../src/om/frame-obligations.js');
  const { readLayerAcceptance } = await import('../src/om/layer-basis.js');
  const { writeGuarded } = await import('../src/om/refs.js');
  const { obligationHandoff } = await import('../src/graph/obligation-handoff.js');
  const { canonical } = await import('../src/canonical.js');
  const f = await d82MilestoneFixture(t);
  const phase = f.finish(0);
  // The genuine R2 handoff is present but empty: its only obligation was due at
  // R2. The L3 field contract therefore still requires an explicit empty set.
  const handoff = obligationHandoff(f.store, 'p', [reference(phase)]);
  assert.ok(handoff);
  assert.deepEqual(handoff.obligations, []);
  const proposedGraph = f.store.get<Graph>('graph:p')!;
  f.engine.graphs.save('p', { ...proposedGraph.value, researchObligations: [] }, proposedGraph.revision, 'fixture');
  deriveLayerFixture(f.engine, 'p', 3);
  f.engine.refinement.sealLayer('p', 3, 0);
  assert.equal(f.store.get('reader-pilot:p'), null);
  assert.equal(f.store.get('execution-root:p'), null);
  const gates = [f.engine.pipeline.inspect('p', 'features'), f.engine.refinement.gate('p', 'L2'),
    f.engine.refinement.gate('p', 'R1'), f.engine.refinement.gate('p', 'R2'),
    f.engine.graphs.layerGate('p', 2), f.engine.graphs.layerGate('p', 3)];
  for (const gate of gates) {
    assert.deepEqual(gate.findings, []);
    assert.ok(gate.guards.every(isRef));
    assert.deepEqual((gate.admissionGuards ?? []).filter(guard => 'absent' in guard), []);
  }
  const value = <T>(result: import('../src/om/refusal.js').OmResult<T>): T => {
    if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
    return result.value;
  };
  const inputRequest: import('../src/om/input.js').InputRequest = { project: 'p', expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.store.get(`stage:p:${stage}`)!)])) as import('../src/om/input.js').InputRequest['stages'] };
  const input = value(writeOmInput(f.store, inputRequest));
  inputRequest.expected = input.revision;
  const graph = reference(f.store.get('graph:p')!);
  // The current route: before any real N2 acceptance the operations horizon names no refinement —
  // the stage-only window where both operations frames are honestly absent.
  const horizonRequest: import('../src/om/horizon.js').HorizonRequest = { project: 'p', graph, input: reference(input),
    refinement: null, choice: { choiceVersion: 'd82-historical-gates',
      features: [{ outcome: 'p-result' }], excluded: [] }, available: {} };
  value(writeHorizon(f.store, horizonRequest));
  // Before any real N2 the only honest frame request is the L2 one with layer/frame/upper null:
  // an L3 request needs an upper witness proving an accepted L2, which does not exist yet.
  const before = canonical(f.store.list().flatMap(head => f.store.history(head.id)));
  const preparedInput = value(prepareOmInput(f.store, inputRequest));
  const preparedHorizon = value(prepareHorizon(f.store, horizonRequest));
  for (const item of [preparedInput, preparedHorizon]) {
    assert.deepEqual(item.guards.filter(guard => !isRef(guard)), []);
    const positive = item.guards.filter(isRef);
    for (const guard of positive) assert.deepEqual(guard, reference(f.store.get(guard.id, guard.revision)!));
  }
  assert.deepEqual(f.store.get(phase.id, phase.revision), phase);
  assert.equal(canonical(f.store.list().flatMap(head => f.store.history(head.id))), before, 'Preparing both real OM entrances is read-only');
  assert.equal(f.store.get('reader-pilot:p'), null);
  assert.equal(f.store.get('execution-root:p'), null);
  // The honest first OM frame needs a store without any proved lower layer — this store already
  // carries a research-sealed L2 and pretending it absent would be false, so the frame window
  // moves to a separate stage-only fixture where om-frame:p:2 is genuinely missing.
  const { createOmFixture } = await import('./om-fixture.js');
  const s = await createOmFixture(t, 'standard', 'p', { mode: 'stages' });
  const sInputRequest: import('../src/om/input.js').InputRequest = { project: 'p', expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(s.stages[stage])])) as import('../src/om/input.js').InputRequest['stages'] };
  const sInput = value(writeOmInput(s.store, sInputRequest));
  const sGraph = reference(s.graphRevision);
  const sHorizonRequest: import('../src/om/horizon.js').HorizonRequest = { project: 'p', graph: sGraph, input: reference(sInput),
    refinement: null, choice: { choiceVersion: 'd82-first-frame', features: [{ outcome: 'p-result' }], excluded: [] }, available: {} };
  const sHorizon = value(writeHorizon(s.store, sHorizonRequest));
  const sFrameRequest: import('../src/om/frame-obligations.js').FrameRequest = { project: 'p', graph: sGraph, level: 2,
    layer: null, horizon: reference(sHorizon.gate), frame: null, upper: null };
  const sBefore = canonical(s.store.list().flatMap(head => s.store.history(head.id)));
  const preparedFrame = value(prepareFrame(s.store, sFrameRequest));
  const frameAbsence = [{ id: 'om-frame:p:2', absent: true }];
  assert.deepEqual(preparedFrame.guards.filter(guard => !isRef(guard)), frameAbsence,
    'The stage-only window still has no operations frame');
  for (const guard of preparedFrame.guards.filter(isRef))
    assert.deepEqual(guard, reference(s.store.get(guard.id, guard.revision)!));
  assert.equal(canonical(s.store.list().flatMap(head => s.store.history(head.id))), sBefore, 'The first OM frame preparation is read-only');
  for (const absent of frameAbsence) {
    const saved = await s.store.snapshot(join(s.root, `frame-absence-${absent.id.split(':').at(-1)}`));
    const competing = new Store(saved.path);
    try {
      competing.write({ id: absent.id, kind: 'connection-frame', expected: 0, value: {} });
      const beforeRace = canonical(competing.list().flatMap(head => competing.history(head.id)));
      const result = writeGuarded(competing, { unit: 'C4', target: 'p', guards: preparedFrame.guards,
        writes: [{ id: 'fix-c:frame-result', kind: 'frame-result', expected: 0, value: {} },
          { id: 'fix-c:neighbor', kind: 'neighbor', expected: 0, value: {} }] });
      assert.equal(result.ok, false);
      assert.equal(result.refusal.code, 'input_stale');
      assert.equal(result.refusal.at.target, absent.id);
      assert.equal(competing.get('fix-c:frame-result'), null);
      assert.equal(competing.get('fix-c:neighbor'), null);
      assert.equal(canonical(competing.list().flatMap(head => competing.history(head.id))), beforeRace);
    } finally { competing.close(); }
  }
  // The second honest window runs on a real post-N2 store: fixture mode 'n2' performs the actual
  // N2 producers, so om-frame:p:2 exists and om-frame:p:3 is the frame that does not exist yet.
  const n2 = await createOmFixture(t, 'standard', 'p', { mode: 'n2' });
  const graphN = reference(n2.graphRevision), layerN = reference(n2.layers[2]);
  const frameN = reference(n2.store.get('om-frame:p:2')!);
  // The accepted OM L2 is the same checked body through the preparing and the historical readers:
  // current admission adds guards but never changes content or source references.
  const layerRequestN = { project: 'p', graph: graphN, level: 2 as const, layer: layerN };
  const beforeN2 = canonical(n2.store.list().flatMap(head => n2.store.history(head.id)));
  const currentLayer = value(prepareLayerAcceptance(n2.store, layerRequestN));
  for (const guard of currentLayer.guards.filter(isRef))
    assert.deepEqual(guard, reference(n2.store.get(guard.id, guard.revision)!));
  const historicalLayer = value(readLayerAcceptance(n2.store, layerRequestN));
  const { guards: _guards, ...historicalBody } = currentLayer;
  assert.deepEqual(historicalBody, historicalLayer, 'Adding current admission never changes the checked accepted layer content or source references');
  assert.equal(canonical(n2.store.list().flatMap(head => n2.store.history(head.id))), beforeN2, 'Both layer readings are read-only');
  const worksRequest: import('../src/om/horizon.js').HorizonRequest = { project: 'p', graph: graphN,
    input: reference(n2.store.get('om-input:p')!), refinement: layerN, choice: { choiceVersion: 'd82-works',
      features: [{ outcome: 'p-result' }], excluded: [] }, available: {} };
  const works = value(writeHorizon(n2.store, worksRequest)), worksRef = reference(works.gate);
  const frame3Request: import('../src/om/frame-obligations.js').FrameRequest = { project: 'p', graph: graphN,
    level: 3, layer: null, horizon: worksRef, frame: null, upper: { horizon: worksRef, frame: frameN } };
  const admission3 = value(prepareFrame(n2.store, frame3Request)).guards;
  assert.deepEqual(admission3.filter(guard => !isRef(guard)), [{ id: 'om-frame:p:3', absent: true }],
    'After real N2 the still-absent frame is om-frame:p:3');
  const saved3 = await n2.store.snapshot(join(n2.root, 'frame-absence-3'));
  const competing3 = new Store(saved3.path);
  try {
    competing3.write({ id: 'om-frame:p:3', kind: 'connection-frame', expected: 0, value: {} });
    const beforeRace = canonical(competing3.list().flatMap(head => competing3.history(head.id)));
    const result = writeGuarded(competing3, { unit: 'C4', target: 'p', guards: [...admission3],
      writes: [{ id: 'fix-c:frame-result-3', kind: 'frame-result', expected: 0, value: {} },
        { id: 'fix-c:neighbor-3', kind: 'neighbor', expected: 0, value: {} }] });
    assert.equal(result.ok, false);
    assert.equal(result.refusal.code, 'input_stale');
    assert.equal(result.refusal.at.target, 'om-frame:p:3');
    assert.equal(competing3.get('fix-c:frame-result-3'), null);
    assert.equal(competing3.get('fix-c:neighbor-3'), null);
    assert.equal(canonical(competing3.list().flatMap(head => competing3.history(head.id))), beforeRace);
  } finally { competing3.close(); }
});
