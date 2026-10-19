import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, STAGE_CLOSURE_CONTRACT, type Ref, type Stage, type GateContext, type GateResult } from '../src/pipeline/contracts.js';
import { Store, storeReads, type Revision, type Write } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { StageChecks } from '../src/product/stage-checks.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { Question } from '../src/discovery/discovery.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import { gardenGraph } from './om-fixture.js';
import { preparedFeatures } from './product-fixture.js';
import { preparedField } from './preparation-fixture.js';
import { assessAnswer } from '../src/discovery/research-assessment.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { mc1FieldSpec, writeMc1Question, writeAcceptedAnswer, type AnswerQuestionContract, type Mc1QuestionRequest, type AnswerRequest } from '../src/om/accepted-answer.js';
import { writeOmInput, prepareOmInput, prepareExistingOmInput, type InputRequest } from '../src/om/input.js';
import { inputDecisionWrite, writeAddressing, writeApplyAnswer, prepareApplyAnswer } from '../src/om/addressing.js';
import { writeGuarded } from '../src/om/refs.js';
import type { OmResult } from '../src/om/refusal.js';

function delivered<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}

async function setupCommitReadsFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-commit-reads-')), path = join(root, 'state.sqlite');
  let store = new Store(path), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  const project = 'garden', block = 'garden-produce-block', target = 'discovery:output-format';

  // Provide G1 stage closures for accepted upstream stages (which in production will be declared by G2 stage checks)
  const originalValidate = engine.checks.validateStage.bind(engine.checks);
  engine.checks.validateStage = (stage: Stage, context: GateContext): GateResult => {
    const res = originalValidate(stage, context);
    if (res.findings.length === 0) {
      res.closure = {
        contract: STAGE_CLOSURE_CONTRACT,
        external: stage === 'discovery' ? [{ kind: 'source', ref: reference(store.get(`source:${project}:brief`)!) }] : [],
      };
    }
    return res;
  };

  const { level: _level, ...l1 } = projectGraph(gardenGraph(), 1);
  preparedFeatures(engine, project, l1 as Graph, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{
      id: 'output-format',
      question: 'Which output format does the repository support?',
      consumer: block,
      moment: 'om-pass',
      blocksCurrentStage: false,
      resolution: 'Read repository facts during OM',
    }];
    return value;
  });

  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
  const base = delivered(writeOmInput(store, { project, expected: 0, stages }));
  const graph = store.get<Graph>(`graph:${project}`)!;

  const input = delivered(writeAddressing(store, {
    project,
    input: reference(base),
    graph: reference(graph),
    decisions: [{
      pending: structuredClone(inputDecisionWrite({
        project,
        input: reference(base),
        graph: reference(graph),
        layers: [],
        decision: { target, field: 'address', value: { consumer: block, kind: 'repository-fact' } },
      })) as Write,
    }],
  }));

  const horizon = delivered(writeHorizon(store, {
    project,
    input: reference(input),
    graph: reference(graph),
    refinement: null,
    available: {},
    choice: { choiceVersion: `commit-reads-${input.revision}`, features: [{ outcome: 'garden-result' }], excluded: [] },
  }));

  const sources: GapRequest = {
    project,
    input: reference(input),
    graph: reference(graph),
    horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) },
  };

  const gaps = delivered(writeGaps(store, sources));
  const gap = gaps.records.find(row => row.value.gap.target === target)!;

  const command = { executable: process.execPath, args: ['-e',
    `const req=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research:{verdict:'supported',reasons:[]}}));`] };
  const environment = engine.environments.configure(project, {
    workspace: root,
    implementer: { actor: 'fact-researcher', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'fact-assessor', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] },
    timeoutMs: 5000,
  }, 0);

  writeFileSync(join(root, 'answer.json'), JSON.stringify({ answer: 'JSON' }));
  const source = engine.discovery.evidence.file(project, 'answer-source', root, 'answer.json', 'application/json', 0);

  const requestContract: AnswerQuestionContract = {
    establishes: input.value.input.questions[0]!.question,
    consumer: { blocks: [...gap.value.gap.consumers] },
    requirements: [structuredClone(input.value.input.contracts[0]!) as unknown as Json],
    resultForm: { type: 'string' },
  };

  const draft = engine.discovery.create(project, 'om-g2', 'R1', block,
    [mc1FieldSpec({ input: reference(input), gap: reference(gap), contract: requestContract })],
    [reference(input), reference(gap)]);
  const issued = store.get<Question>(draft.value.questions[0]!)!;

  const mc1Request: Mc1QuestionRequest = {
    project,
    input: reference(input),
    gaps: { sources, records: gaps.records.map(reference) },
    gap: reference(gap),
    contract: requestContract,
    requirements: [{ pointer: '/contracts/0' }],
    engineQuestion: reference(issued),
    draft: reference(draft),
  };
  const question = delivered(writeMc1Question(store, mc1Request));

  const assessment = await assessAnswer(store, issued, {
    action: 'answer',
    question: issued.id,
    value: 'JSON',
    citations: [{ source: reference(store.get(source.id)!), selector: { kind: 'json-pointer', pointer: '/answer' } }],
  }, environment, root);

  const answeredDraft = engine.discovery.researched(issued.id, issued.revision, reference(assessment));
  const answered = store.get<Question>(issued.id)!;

  const answerRequest: AnswerRequest = {
    project,
    question: reference(question),
    answer: answered.value.answer!,
    answeredQuestion: reference(answered),
    draft: reference(answeredDraft),
    attempt: null,
  };
  const accepted = delivered(writeAcceptedAnswer(store, answerRequest));

  const applied = delivered(writeApplyAnswer(store, {
    project,
    input: reference(input),
    answer: reference(accepted),
    question: reference(question),
  }));

  return { root, project, store, engine, stages, input: applied, graph, accepted, question };
}

test('prepareExistingOmInput storeReads budget <= 3 * N_stages + 5', async t => {
  const f = await setupCommitReadsFixture(t);
  const nStages = UPSTREAM_STAGES.length; // 5
  const budget = 3 * nStages + 5; // 20

  const beforeReads = storeReads();
  const admitted = delivered(prepareExistingOmInput(f.store, f.project, reference(f.input)));
  const reads = storeReads() - beforeReads;

  assert.ok(admitted.existing !== null);
  assert.equal(admitted.writes.length, 0);
  assert.ok(reads <= budget, `storeReads (${reads}) exceeded budget 3*N_stages + 5 (${budget})`);
});

test('0 decodes of old bodies (answers, questions, drafts) when om-answer-closure is present', async t => {
  const f = await setupCommitReadsFixture(t);

  const closure = f.store.get(`om-answer-closure:${f.accepted.id}`);
  assert.ok(closure !== null, 'om-answer-closure must exist for accepted answer');

  const oldBodyReads: string[] = [];
  let closureReadCount = 0;
  const originalGet = Store.prototype.get;
  Store.prototype.get = function<T = Json>(this: Store, id: string, revision?: number): Revision<T> | null {
    if (this === f.store) {
      if (id === f.accepted.id || id === f.question.id) {
        oldBodyReads.push(id);
      }
      if (id === `om-answer-closure:${f.accepted.id}`) {
        closureReadCount++;
      }
    }
    return originalGet.call(this, id, revision) as Revision<T> | null;
  };

  try {
    const admitted = delivered(prepareExistingOmInput(f.store, f.project, reference(f.input)));
    assert.ok(admitted.existing !== null);
    assert.deepEqual(oldBodyReads, [], 'prepareExistingOmInput must not read old answer bodies or questions');
    assert.ok(closureReadCount >= 1, 'prepareExistingOmInput must read om-answer-closure');
  } finally {
    Store.prototype.get = originalGet;
  }
});

test('10x historical noise records invariant: delta reads == 0', async t => {
  const f = await setupCommitReadsFixture(t);

  // Warm up once so initial caches settle
  delivered(prepareExistingOmInput(f.store, f.project, reference(f.input)));

  // Baseline reads count for prepareExistingOmInput
  const before1 = storeReads();
  const res1 = delivered(prepareExistingOmInput(f.store, f.project, reference(f.input)));
  const baselineReads = storeReads() - before1;
  assert.ok(res1.existing !== null);

  // Write 10 historical noise records into the store
  for (let i = 1; i <= 10; i++) {
    f.store.write({
      id: `noise-record:${f.project}:${i}`,
      kind: 'historical-noise',
      expected: 0,
      value: { index: i, timestamp: Date.now(), noise: 'a'.repeat(100) },
    });
  }

  // Measure reads count after adding 10 historical noise records
  const before2 = storeReads();
  const res2 = delivered(prepareExistingOmInput(f.store, f.project, reference(f.input)));
  const afterNoiseReads = storeReads() - before2;
  assert.ok(res2.existing !== null);

  const delta = afterNoiseReads - baselineReads;
  assert.equal(delta, 0, `Store reads must not increase with historical noise; delta was ${delta}`);
});

test('graph CAS guard retains read head and invalidates prepared transaction upon bump (:705/:724)', async t => {
  const f = await setupCommitReadsFixture(t);
  const req: InputRequest = { project: f.project, stages: f.stages, expected: f.input.revision };

  const prepared = delivered(prepareOmInput(f.store, req));
  const graphHead = f.store.get(`graph:${f.project}`)!;
  const graphRef = reference(graphHead);

  // Assert graph head is retained in transaction guards
  assert.ok(prepared.guards.some(g => canonical(g) === canonical(graphRef)),
    'Prepared OM input transaction must retain CAS guard on graph head');

  // Bump graph with identical value
  const bumped = f.store.write({
    id: graphHead.id,
    kind: graphHead.kind,
    expected: graphHead.revision,
    value: structuredClone(graphHead.value),
  });
  assert.equal(bumped.revision, graphHead.revision + 1);

  // Pipeline inspect remains accepted
  assert.equal(new ProductEngine(f.store).pipeline.inspect(f.project, 'features').state, 'accepted');

  // Attempting to commit with stale graph guard in neighbor transaction must fail with input_stale
  const result = writeGuarded(f.store, {
    unit: 'test-cas',
    target: `neighbor:${f.project}`,
    writes: [
      ...prepared.writes,
      { id: `neighbor:${f.project}`, kind: 'neighbor', expected: 0, value: { inputHash: prepared.record.hash } },
    ],
    guards: prepared.guards,
  });
  assert.equal(result.ok, false);
  assert.equal(result.refusal.code, 'input_stale');
  assert.equal(result.refusal.at.target, graphHead.id);
});

test('exception passthrough: engine and type errors propagate directly without swallowing (:741)', async t => {
  const f = await setupCommitReadsFixture(t);
  const graphId = `graph:${f.project}`;
  const originalGet = f.store.get;

  const corruptError = new EngineError('record_corrupt', 'simulated damaged record', { target: graphId });
  const typeError = new TypeError('simulated type failure');

  for (const failure of [corruptError, typeError]) {
    f.store.get = function<T = Json>(id: string, revision?: number): Revision<T> | null {
      if (id === graphId && revision === undefined) throw failure;
      return originalGet.call(f.store, id, revision) as Revision<T> | null;
    };

    try {
      assert.throws(() => prepareExistingOmInput(f.store, f.project, reference(f.input)), (err: unknown) => err === failure,
        'prepareExistingOmInput must pass engine and type exceptions through directly');
      assert.throws(() => prepareOmInput(f.store, { project: f.project, stages: f.stages, expected: f.input.revision }), (err: unknown) => err === failure,
        'prepareOmInput must pass engine and type exceptions through directly');
    } finally {
      f.store.get = originalGet;
    }
  }
});

test('G3a fact application and its exact repeat retain native closure absence until the write transaction', async t => {
  const absent = { id: 'stage-prerequisite:fact', absent: true as const };
  const validate = StageChecks.prototype.validateStage;
  let f: Awaited<ReturnType<typeof setupCommitReadsFixture>>;
  try {
    StageChecks.prototype.validateStage = function (stage, context) {
      const result = validate.call(this, stage, context);
      if (stage === 'features' && result.findings.length === 0)
        result.admissionGuards = [...(result.admissionGuards ?? []), absent];
      return result;
    };
    f = await setupCommitReadsFixture(t);
  } finally { StageChecks.prototype.validateStage = validate; }
  // The fixture produced, accepted and applied the fact through the real writers while absence held.
  const derivation = f.input.value.derivation;
  assert.ok(derivation && 'kind' in derivation && derivation.kind === 'fact');
  const replay = delivered(prepareApplyAnswer(f.store, { project: f.project,
    input: derivation.previous, answer: reference(f.accepted), question: reference(f.question) }));
  assert.equal(replay.writes.length, 0);
  assert.deepEqual(replay.record, f.input);
  assert.ok(replay.guards.some(guard => canonical(guard) === canonical(absent)));
  const second = new Store(join(f.root, 'state.sqlite'));
  try { second.write({ id: absent.id, kind: 'prerequisite', expected: 0, value: {} }); }
  finally { second.close(); }
  const before = f.store.list().map(reference);
  const result = writeGuarded(f.store, { unit: 'G1', target: f.project, guards: replay.guards,
    writes: [{ id: 'fact-neighbor:one', kind: 'neighbor', expected: 0, value: {} },
      { id: 'fact-neighbor:two', kind: 'neighbor', expected: 0, value: {} }] });
  assert.equal(result.ok, false);
  assert.equal(result.refusal.code, 'input_stale');
  assert.equal(result.refusal.at.target, absent.id);
  assert.deepEqual(f.store.list().map(reference), before);
});
