import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Revision, type Write } from '../src/storage/store.js';
import { Evidence, type Source } from '../src/evidence/evidence.js';
import { executeWebTurn } from '../src/discovery/web-research.js';
import type { ResearchTurn } from '../src/discovery/research-model.js';
import type { Environment } from '../src/runtime/environment.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { canonical, type Json } from '../src/canonical.js';
import { ProductEngine } from '../src/product/engine.js';
import { UPSTREAM_STAGES, type UpstreamStage } from '../src/discovery/requirements.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { writeOmInput, readOmInput } from '../src/om/input.js';
import { readAnswerCitations, prepareAnswerCitations } from '../src/om/accepted-answer.js';
import { briefMaterial, deriveBrief, BRIEF_VERSION, type BriefBasis } from '../src/om/packet-brief.js';
import { packetAnswerSchema, prepareQuestionTasks, writeQuestionPacket } from '../src/om/question-packet.js';
import { checkAnswerForm } from '../src/om/answer-form.js';
import { runModelCall, deliverModelSources, readContinuationEvidence, type ModelCallRequest } from '../src/om/model-call.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { gapLineKey, gapLineExpectedResult } from '../src/om/gap-lines.js';
import { writeRoutes } from '../src/om/routes.js';
import { openSeries, beginAttempt } from '../src/om/series.js';
import { resolveExternalSource } from '../src/compiler/inputs.js';
import { resolveResearchBasis } from '../src/graph/research-basis.js';
import { configureResearchScope, scopedQuestions } from '../src/graph/research-scope.js';
import { validateObligationPolicy, type ObligationAssignment } from '../src/graph/obligation-policy.js';
import { requireDocumentarySources, withObligationEvidence, obligationEvidenceFindings } from '../src/graph/obligation-evidence.js';
import type { TechnicalReport } from '../src/graph/research-contracts.js';
import type { Graph } from '../src/graph/model.js';
import { designOf } from '../src/graph/builder.js';
import { enrichedGraph } from './enriched-graph-fixture.js';
import { exampleGraph } from './graph-fixture.js';
import { projectGraph } from '../src/graph/project.js';
import { gardenGraph } from './om-fixture.js';
import { preparedField } from './preparation-fixture.js';
import type { OmResult } from '../src/om/refusal.js';

function ok<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-web-consumers-'))), database = join(root, 'state.sqlite');
  const stores: Store[] = [], open = () => { const store = new Store(database); stores.push(store); return store; };
  const store = open(), engine = new ProductEngine(store), project = 'garden';
  engine.execute({ type: 'create-project', project, title: 'Documentary web evidence' });
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  // The genuine WB1 path (№4552): a pending web_fetch turn executed by executeWebTurn through a local gateway yields
  // the saved capture and the immutable snapshot that later stages consume. No Source is constructed by hand.
  const pages = new Map<string, string>();
  let server: Server | null = null, gatewayUrl = '', fetched = 0;
  async function gateway() {
    if (server) return gatewayUrl;
    server = createServer((request, response) => {
      let raw = ''; request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const url = JSON.parse(raw).url as string, text = pages.get(url) ?? '';
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ requested_url: url, resolved_url: url, redirects: [], final_url: url,
          fetched_at: new Date(Date.UTC(2026, 9, 14, 4, 0, ++fetched)).toISOString(), status: 200, success: true, failure: null, text,
          truncated: false, chars_total: text.length, chars: text.length, sha256: '', extraction: 'crawl4ai/raw_markdown', completeness: 'unknown' }));
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    gatewayUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    t.after(() => new Promise<void>(resolve => server!.close(() => resolve())));
    return gatewayUrl;
  }
  async function web(content = 'The service reports JSON output.', owner = project) {
    const url = `https://example.invalid/report/${pages.size + 1}`; pages.set(url, content);
    const command = { executable: process.execPath, args: ['--version'] };
    const environment = store.get<Environment>(`fixture-web-environment:${owner}`) ?? store.write<Environment>({ id: `fixture-web-environment:${owner}`,
      kind: 'environment', expected: 0, value: { projectId: owner, workspace: root, implementer: { actor: 'web-reader', model: 'fixture', effort: 'medium', command },
        reviewer: { actor: 'web-assessor', model: 'fixture', effort: 'medium', command }, fullCheck: command, timeoutMs: 10000,
        webResearch: { enabled: true, gatewayUrl: await gateway(), timeoutMs: 5000, limits: { httpAttempts: 100, pages: 100, receivedChars: 1_000_000, responseBytes: 2_000_000 } } } });
    const run = store.get(`research-run:web-fixture:${owner}`) ?? store.write({ id: `research-run:web-fixture:${owner}`, kind: 'research-run', expected: 0,
      value: { projectId: owner, draftId: 'discovery:web-fixture' } });
    const turn = store.write<ResearchTurn>({ id: `research-turn:web-fixture:${owner}:${pages.size}`, kind: 'research-turn', expected: 0,
      value: { run: run.id, number: pages.size, action: { action: 'web_fetch', url, purpose: 'Read the reported output format' },
        assessment: null, observation: null, error: null, status: 'pending', question: null } });
    const outcome = await executeWebTurn({ store, projectId: owner, stage: 'discovery', environment, turn });
    assert.ok(outcome.source && outcome.capture, 'the genuine fetch saved a capture and a snapshot');
    return outcome.source;
  }
  return { root, database, store, engine, project, open, web };
}
const citation = (source: Revision<Source>) => ({ source: reference(source), selector: { kind: 'text-range' as const, start: 0, end: source.value.content.length } });

function upstream(f: ReturnType<typeof fixture>, source: Revision<Source>, valueFor = (field: string) => preparedField(f.project, field)) {
  const { level: _level, ...l1 } = projectGraph(gardenGraph('cross'), 1);
  const graph = enrichedGraph(l1 as Graph, f.project, valueFor('preparation'), valueFor('conceptSections'));
  f.engine.graphs.save(f.project, graph, 0, 'owner');
  for (const stage of UPSTREAM_STAGES) {
    const draft = f.engine.prepare(f.project, stage);
    for (const id of draft.value.questions) {
      const question = f.store.get<Question>(id)!;
      const field = question.value.spec.field;
      if (question.value.spec.kind === 'fact') f.engine.discovery.fact(id, 1, reference(source), citation(source).selector);
      else if (stage === 'discovery' && ['researchPlan', 'researchReport', 'verdict', 'preparation'].includes(field))
        // Discovery v5 (DS1): researched answers whose assessment cites the genuine web snapshot.
        answerDiscoveryFixture(f.engine, f.project, f.store.get<DiscoveryDraft>(draft.id)!, f.store.get<Question>(id)!, valueFor(field), source);
      else f.engine.discovery.decision(id, 1, 'owner', field === 'mapDesign' ? designOf(graph) as unknown as Json : valueFor(field));
    }
    const artifact = f.engine.draft(f.project, stage, draft.id, 0);
    f.engine.pipeline.accept(f.project, stage, artifact.revision);
  }
  return Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.store.get(`stage:${f.project}:${stage}`)!)])) as Record<UpstreamStage, Ref>;
}

test('WB1b web source crosses accepted upstream stages, OM input, documentary brief and exact citation after restart', async t => {
  const f = fixture(t), source = (await f.web()), stages = upstream(f, source);
  const origin = source.value.origin as Extract<Source['origin'], { kind: 'web' }>;
  assert.equal(f.store.get<{ contract: string }>(origin.capture.id, origin.capture.revision)!.value.contract, 'web-capture/v1',
    'the snapshot comes from a genuine WB1 capture');
  const discovery = f.store.get<DiscoveryDraft>(f.store.get<any>(stages.discovery.id, stages.discovery.revision)!.value.content.draft.id)!;
  const reportQuestion = discovery.value.questions.map(id => f.store.get<Question>(id)!).find(q => q.value.spec.field === 'researchReport')!;
  const answer = f.store.get<any>(reportQuestion.value.answer!.id, reportQuestion.value.answer!.revision)!;
  assert.deepEqual(f.store.get<any>(answer.value.assessment.id, answer.value.assessment.revision)!.value.observations[0].source, reference(source),
    'the accepted Discovery report cites the web snapshot');
  const input = ok(writeOmInput(f.store, { project: f.project, stages, expected: 0 }));
  const reopened = f.open(); assert.ok(readOmInput(reopened, f.project, reference(input)).ok);
  const material = briefMaterial(reopened, f.project, f.root, true);
  assert.equal(material.sources.find(row => row.reference.id === source.id)!.value.origin.kind, 'web');
  const basis: BriefBasis = { project: f.project, graph: gardenGraph('cross'), node: 'garden-consume-block',
    gaps: [{ question: 'q-web', target: 'service', field: 'format', ref: { id: 'gap:garden:web', revision: 1, hash: '1'.repeat(64) }, evidence: [{ ...reference(source) }] }], contexts: [reference(input)], accepted: [], input: { source: { ...reference(source) } }, material, materialBudget: 45000, codes: [] };
  const brief = deriveBrief({ version: BRIEF_VERSION, requestId: 'web-brief', task: 'fact', model: 'MC1', purpose: 'model-research',
    questions: [{ id: 'q-web', target: 'service', field: 'format', contract: { establishes: 'Reported output', resultForm: { type: 'string' } } }],
    responseForm: { protocol: 'omg-answer/v3', requestId: 'web-brief', schema: packetAnswerSchema('fact') }, refusals: [] }, basis);
  assert.ok(canonical(brief).includes(source.value.content), 'The documentary selection sends the referenced web material, not only its catalogue entry');
  const checked = ok(readAnswerCitations(reopened, { project: f.project, citations: [citation(source)] }));
  assert.equal(checked.grounds[0]!.proofLimit, 'reported-not-runtime-proof');
  assert.deepEqual(checked.grounds[0]!.observation.source, reference(source));
});

test('WB1b exact citations preserve file and owner-document limits and keep distinct web captures', async t => {
  const f = fixture(t), first = (await f.web()), second = (await f.web());
  const owner = new Evidence(f.store).document(f.project, 'owner', 'Owner requests JSON', 'text/plain', 0);
  writeFileSync(join(f.root, 'code.ts'), 'export const format = "json";');
  const file = new Evidence(f.store).file(f.project, 'code', f.root, 'code.ts', 'text/plain', 0);
  const result = ok(prepareAnswerCitations(f.store, { project: f.project, citations: [first, second, owner, file].map(citation) }));
  assert.equal(result.references.length, 4); assert.notEqual(first.id, second.id);
  for (const ground of result.grounds) assert.equal(ground.proofLimit,
    ground.observation.source.id === file.id ? 'repository-observation' : 'reported-not-runtime-proof');
  const foreign = (await f.web('Foreign page', 'other'));
  assert.equal(readAnswerCitations(f.store, { project: f.project, citations: [citation(foreign)] }).ok, false);
  for (const selector of [{ kind: 'text-range', start: 0, end: 99999 }, { kind: 'text-range', start: 0 }])
    assert.equal(readAnswerCitations(f.store, { project: f.project, citations: [{ source: reference(first), selector: selector as never }] }).ok, false);
});

test('WB1b compiler resolves a declared external web snapshot and historical bytes without treating it as a receipt', async t => {
  const f = fixture(t), source = (await f.web()), graph = exampleGraph(f.project), id = source.id.slice(`source:${f.project}:`.length);
  graph.contracts.push({ id: 'web-text', schema: { type: 'string' } });
  graph.artifacts.push({ id, contract: 'web-text', external: true, terminal: false });
  for (const current of [true, false]) assert.deepEqual(resolveExternalSource(f.open(), f.project, graph, id, reference(source), current),
    { receipt: null, source: reference(source) });
  const second = (await f.web('Different capture'));
  assert.throws(() => resolveExternalSource(f.store, f.project, graph, id, reference(second), true), { code: 'external_input_missing' });
  const incompatible = structuredClone(graph); incompatible.contracts.find(row => row.id === 'web-text')!.schema = { type: 'object' };
  assert.throws(() => resolveExternalSource(f.store, f.project, incompatible, id, reference(source), true), { code: 'artifact_contract_mismatch' });
});

function policyFixture(f: ReturnType<typeof fixture>, source: Revision<Source>) {
  const graph = { nodes: [{ id: 'runtime', code: [] }], horizon: [], connectors: [], tests: [], anchors: [] } as unknown as Graph;
  f.store.write({ id: `graph:${f.project}`, kind: 'graph', expected: 0, value: graph });
  const layer = f.store.write({ id: `graph-layer:${f.project}:2`, kind: 'graph-layer', expected: 0, value: { projection: graph } });
  const gap = { id: 'environment', target: 'runtime', field: 'tests', consumer: 'compilation', question: 'Reported service metadata', requiredFor: 'next' as const };
  const r1 = f.store.write({ id: 'r1', kind: 'discovery-draft', expected: 0, value: { projectId: f.project, fields: { technical: { gaps: [gap] } } } });
  const phase = f.store.write({ id: `phase:${f.project}:R1`, kind: 'phase', expected: 0, value: { draft: reference(r1) } });
  const original = configureResearchScope(f.store, { projectId: f.project, layer: reference(layer), r1: reference(phase), outcome: 'Bound metadata',
    nodes: ['runtime'], boundaries: [], expansions: [], changedPaths: [], uiRequired: false, obligations: [{ gap, state: 'active', reason: 'original', wake: null }] }, 0);
  const assignment: ObligationAssignment = { obligation: gap.id, original: { record: reference(original), pointer: '/obligations/0/gap' },
    kind: 'environment-confirmation', moment: 'R2', responsibleNode: gap.target, responsibleConsumer: gap.consumer, neededForR2: true,
    reason: 'Use the reported metadata only', returnCondition: null,
    documentaryAllowance: { sources: [reference(source)], claimLimit: 'Reported JSON format, not runtime operation' } };
  const policy = { version: 1 as const, sourceScope: reference(original), assignments: [assignment] };
  const scope = configureResearchScope(f.store, { ...original.value, policy }, 1);
  const spec = withObligationEvidence(scopedQuestions(scope.value).find(row => row.obligations)!);
  const observations = [new Evidence(f.store).observe(f.project, reference(source), citation(source).selector)];
  const report: TechnicalReport = { applicability: 'applicable', reason: 'Reported metadata', facts: [],
    designs: [{ id: 'design', decision: 'Use JSON', benefit: 'Compatible output', consumer: 'compilation' }], gaps: [],
    documents: [{ id: 'doc', claim: 'Reports JSON', kind: 'document-observation', citation: 0, quote: source.value.content, designs: ['design'], gaps: [] }],
    coverage: [{ obligation: gap.id, facts: [], designs: ['design'], gaps: [] }] };
  return { original, scope, spec, assignment, policy, observations, report };
}

test('WB1b documentary allowance preserves exact web Ref and claimLimit; unapproved web cannot confirm environment', async t => {
  const f = fixture(t), source = (await f.web()), p = policyFixture(f, source);
  assert.doesNotThrow(() => requireDocumentarySources(f.open(), f.project, p.spec));
  assert.deepEqual(obligationEvidenceFindings(p.spec, p.report, p.observations), []);
  assert.deepEqual(p.scope.value.policy!.assignments[0]!.documentaryAllowance, p.assignment.documentaryAllowance);
  const absent = structuredClone(p.spec); delete absent.obligations![0]!.assignment!.documentaryAllowance;
  assert.ok(obligationEvidenceFindings(absent, p.report, p.observations).some(row => row.code === 'environment_confirmation_required'));
  const other = (await f.web('Another actual capture')), otherObservation = new Evidence(f.store).observe(f.project, reference(other), citation(other).selector);
  assert.ok(obligationEvidenceFindings(p.spec, p.report, [otherObservation]).some(row => row.code === 'obligation_document_evidence_required'));
  const missing = structuredClone(p.scope.value); delete (missing.policy!.assignments[0]!.documentaryAllowance as any).claimLimit;
  assert.throws(() => validateObligationPolicy(f.store, missing), { code: 'obligation_policy_invalid' });
  const foreign = (await f.web('Foreign actual capture', 'other')), wrong = structuredClone(p.scope.value);
  wrong.policy!.assignments[0]!.documentaryAllowance!.sources = [reference(foreign)];
  assert.throws(() => validateObligationPolicy(f.store, wrong), { code: 'obligation_document_allowance_invalid' });
});

test('WB1b a web citation cannot become repository fact, owner intent, runtime script or runtime dependency', async t => {
  const f = fixture(t), source = (await f.web()), p = policyFixture(f, source);
  for (const kind of ['owner-document', 'repository-file'] as const) {
    const report = structuredClone(p.report);
    if (kind === 'owner-document') report.documents![0]!.kind = kind;
    else report.facts = [{ id: 'fact', claim: 'Pretend repository code', evidence: { kind, citation: 0 } }];
    const result = resolveResearchBasis(f.store, f.project, report, p.observations, f.root, 'technical');
    assert.ok(result.findings.some(row => row.code === (kind === 'owner-document' ? 'document_evidence_required' : 'repository_evidence_required')));
  }
  const ownerScript = new Evidence(f.store).document(f.project, 'script', 'console.log("observed")', 'text/plain', 0);
  for (const script of [true, false]) {
    const scope = structuredClone(p.scope.value), a = scope.policy!.assignments[0]!; delete a.documentaryAllowance;
    a.runtimeCheck = { script: reference(script ? source : ownerScript), dependencies: script ? [] : [reference(source)],
      subjects: [], executables: [], args: [], timeoutMs: 1000, purpose: 'Declared runtime check' };
    assert.throws(() => validateObligationPolicy(f.store, scope), { code: 'obligation_runtime_check_invalid' });
  }
});

test('WB1b source guards reject a native replacement without partial writes; historical citations remain exact', async t => {
  const f = fixture(t), source = (await f.web()), p = policyFixture(f, source);
  const request = { project: f.project, citations: [citation(source)] }, prepared = ok(prepareAnswerCitations(f.store, request));
  const catalogue = briefMaterial(f.store, f.project, f.root, true);
  const second = f.open(); new Evidence(second).document(f.project, source.id.slice(`source:${f.project}:`.length), 'New owner-supplied material', 'text/plain', source.revision);
  assert.throws(() => f.store.writeMany([{ id: 'consumer-result', kind: 'consumer-result', expected: 0, value: { sources: prepared.references } }], [...prepared.guards]), { code: 'input_stale' });
  assert.equal(f.store.get('consumer-result'), null);
  assert.equal(prepareAnswerCitations(f.store, request).ok, false);
  assert.throws(() => briefMaterial(f.store, f.project, f.root, true, catalogue.references), { code: 'input_stale' });
  assert.throws(() => requireDocumentarySources(f.store, f.project, p.spec), { code: 'obligation_document_source_unavailable' });
  const historical = ok(readAnswerCitations(f.open(), request));
  assert.equal(historical.grounds[0]!.proofLimit, 'reported-not-runtime-proof');
  assert.equal(historical.grounds[0]!.observation.value, source.value.content);
  assert.equal(briefMaterial(f.open(), f.project, f.root, false, catalogue.references).sources[0]!.value.origin.kind, 'web');
});

function packetFixture(f: ReturnType<typeof fixture>, source: Revision<Source>) {
  const { store, project, root, engine } = f;
  const stages = upstream(f, source, field => {
    const value = preparedField(project, field);
    if (field === 'preparation') (value as Record<string, Json>).unknowns = [{ id: 'web-format', question: 'What format is reported?',
      consumer: 'garden-consume-block', moment: 'om-pass', blocksCurrentStage: false, resolution: 'Read the saved report during OM' }];
    return value;
  });
  const base = ok(writeOmInput(store, { project, stages, expected: 0 })), graph = store.get<Graph>(`graph:${project}`)!;
  const input = ok(writeAddressing(store, { project, input: reference(base), graph: reference(graph), decisions: [{ pending: structuredClone(inputDecisionWrite({
    project, input: reference(base), graph: reference(graph), layers: [], decision: { target: 'discovery:web-format', field: 'address',
      value: { consumer: 'garden-consume-block', kind: 'repository-fact' } } })) as Write }] }));
  const horizon = ok(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null, available: {},
    choice: { choiceVersion: 'web-source-test', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const sources: GapRequest = { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate), layer: null, frame: null, upper: null } },
    works: { state: 'upper-not-accepted', layer: reference(store.get(`graph-layer:${project}:2`)!) } };
  const gaps = ok(writeGaps(store, sources)), gapSet = { sources: structuredClone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const tasks = ok(prepareQuestionTasks(store, { project, gaps: gapSet, questions: gaps.records.filter(row => row.value.gap.code === 'predecessor_question' && row.value.gap.kind === 'repository-fact')
    .map(row => ({ gap: reference(row), requirements: [{ pointer: '/contracts/0' }], resultForm: { type: 'string' } })) }));
  const routes = ok(writeRoutes(store, { project, gaps: gapSet, tasks: tasks.tasks.map(task => ({ pending: structuredClone(task.writes[0]!) as Write })),
    catalog: { paths: [], records: [] }, previous: null }));
  const batch = routes.value.batches.find(row => row.model === 'MC1')!;
  const scenario = join(root, 'scenario.json'), trace = join(root, 'trace.jsonl');
  const command = { executable: process.execPath, args: [fileURLToPath(new URL('../../test/om-adapter-fixture.mjs', import.meta.url)), '--scenario', scenario, '--trace', trace] };
  const environment = engine.environments.configure(project, { workspace: root, implementer: { actor: 'web-author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'web-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000, requestCapacityChars: 100000 }, 0);
  const adapter = store.write({ id: `adapter:${project}:web`, kind: 'dispatch-adapter', expected: 0, value: { projectId: project, protocol: 'codex-stdio' } });
  const block = 'garden-consume-block', goal = { key: 'web-source', questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  ok(openSeries(store, { project, block, line: 1, slice: 'web-source', predecessor: null, basis: null }));
  const series = ok(beginAttempt(store, { project, block, line: 1, attempt: 1, goal }));
  const packet = ok(writeQuestionPacket(store, { project, routes: reference(routes), batch: batch.id,
    environment: reference(environment), attempt: { series: reference(series), ordinal: 1 }, previous: [] })).record;
  const request: ModelCallRequest = { project, packet: reference(packet), dispatch: { adapter: reference(adapter), config: reference(environment) }, role: 'implementer' };
  const need = (selected: Revision<Source>) => ({ protocol: '$answerProtocol', requestId: '$requestId', action: 'need_source',
    questionIds: batch.items.map(item => item.gap), missing: 'Read the saved page',
    reads: [{ action: 'read_source', source: reference(selected), selector: { kind: 'text-range', start: 0, end: Math.max(1, selected.value.content.length) } }] });
  return { packet, request, scenario, trace, need };
}
// WB1 never saves an empty page as a snapshot (isWebPage), so only a nonempty web snapshot reaches E3/E4.
test('WB1b E3/E4 a genuine web snapshot is delivered once and replayed after restart', async t => {
  const f = fixture(t), source = await f.web(), p = packetFixture(f, source);
  const { fixtureAnswer } = await import(new URL('../../test/om-adapter-fixture.mjs', import.meta.url).href) as { fixtureAnswer: (packet: unknown, answer: unknown) => unknown };
  const actual = p.need(source), payload = p.packet.value.packet as Record<string, any>;
  const raw = JSON.stringify(fixtureAnswer(payload, { ...actual, protocol: payload.responseForm.protocol, requestId: payload.requestId }));
  assert.equal(ok(checkAnswerForm(f.store, { project: f.project, packet: reference(p.packet), raw })).kind, 'need-source');
  writeFileSync(p.scenario, JSON.stringify({ database: f.database, steps: [{ research: actual, usage: null }] }));
  const result = ok(await runModelCall(f.store, p.request));
  assert.ok(result.response);
  const request = { project: f.project, packet: reference(p.packet), call: result.call, response: result.response! };
  const delivered = ok(deliverModelSources(f.store, request));
  assert.equal(delivered.deliveries.length, 1);
  const read = ok(readContinuationEvidence(f.open(), { ...request, deliveries: [...delivered.deliveries] }));
  assert.ok(canonical(read).includes(source.id));
  assert.deepEqual(ok(deliverModelSources(f.open(), request)).deliveries, delivered.deliveries);
  const calls = f.store.list('model-call').length;
  assert.equal(ok(await runModelCall(f.open(), p.request)).repeated, true);
  assert.equal(f.store.list('model-call').length, calls);
  assert.equal(readFileSync(p.trace, 'utf8').trim().split('\n').length, 1);
});
